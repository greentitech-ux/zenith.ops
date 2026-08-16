// suporteChat.js
// Chat de suporte do site: o widget flutuante (💬, canto inferior direito de
// TODAS as telas - inclusive o login) deixa qualquer pessoa, logada ou nao,
// abrir uma conversa com o time de Suporte pedindo ajuda (computador,
// sistema, acesso...). O visitante recebe um token proprio na criacao e usa
// ele pra ler/escrever na conversa (sem login); o atendimento e feito pelo
// time de Suporte/Master na tela de Chamados TI, que pode responder,
// transformar a conversa num chamado remoto (banco de evidencias) e
// finalizar. Nada de dado sensivel do atendente vaza pro lado publico:
// a visao do visitante rotula mensagens do time apenas como "Suporte".
const crypto = require('crypto');
const db = require('./firestore');
const { createCache } = require('./liveCache');
const ticketCounter = require('./ticketCounter');

const COLLECTION = db.collection('suporteChats');

const MAX_TEXTO = 1000;
const MAX_MENSAGENS = 300;

// funil de triagem do time (Central do Beniboy, ver beniboy.html) - campo
// PROPRIO, independente de `status` (ABERTO/FINALIZADO, que so controla se o
// visitante ainda pode escrever). PENDENTE e o ponto de partida de toda
// conversa nova; RESOLVIDO/SEM_SOLUCAO sao terminais e finalizam a conversa
// pro visitante tambem (ver atualizarStatusAtendimento).
const STATUS_ATENDIMENTO = ['PENDENTE', 'EM_ATENDIMENTO', 'TRANSFERIDO', 'TICKET_CRIADO', 'RESOLVIDO', 'SEM_SOLUCAO'];
const STATUS_TERMINAL = new Set(['RESOLVIDO', 'SEM_SOLUCAO']);
// nivel do atendimento: 1 = Beniboy sozinho (bot), 2 = agente humano (secao
// suporte), 3 = Master. Sobe conforme o card anda no funil; volta pra 1 so
// quando o card volta pra PENDENTE (ninguem assumiu de novo)
function nivelValido(n) { return [1, 2, 3].includes(Number(n)); }

function limpar(texto, max) {
  return String(texto || '').trim().slice(0, max);
}

// lista curta e fixa (sem IA) so pra agrupar as conversas na Central de
// Soluções - o visitante escolhe ao abrir o chat, sem custo de token
const ASSUNTOS = ['Computador/Sistema', 'Acesso/Senha', 'Financeiro/Estorno', 'Outro'];

// logado: snapshot de quem estava com sessao valida no momento em que ABRIU
// a conversa (ver /api/suporte-chat/iniciar em index.js) - null pra visitante
// anonimo. So guarda o minimo que o Beniboy precisa pra decidir se pode
// oferecer a ferramenta de consulta de pedido (suporteBot.js): id/username
// pra contexto, isMaster+unidades pra filtrar o que ele pode ver no Monitor,
// e temMonitor (secao 'monitor' liberada) - sem isso guardado achatado aqui,
// o bot teria que reconsultar o usuario a cada resposta
// lojaContexto: nome da loja, quando a conversa comeca por um link/QR code
// JA marcado com a unidade (ver atendimento.html, ?unidade=) - assim o
// Beniboy ja sabe de qual loja e o cliente sem precisar perguntar. Fica so
// no registro (nunca na mensagem visivel do visitante, ver montarMensagens
// em suporteBot.js).
async function criar({ nome, contato, texto, assunto, logado, lojaContexto }) {
  const nomeLimpo = limpar(nome, 120);
  const contatoLimpo = limpar(contato, 120);
  const textoLimpo = limpar(texto, MAX_TEXTO);
  const assuntoLimpo = ASSUNTOS.includes(assunto) ? assunto : null;
  const lojaContextoLimpa = limpar(lojaContexto, 80);
  if (!nomeLimpo) throw new Error('Informe seu nome.');
  if (!contatoLimpo) throw new Error('Informe um contato (e-mail ou telefone).');
  if (!textoLimpo) throw new Error('Escreva sua mensagem.');

  const doc = COLLECTION.doc();
  const agora = new Date().toISOString();
  // toda conversa ja nasce com um protocolo (mesma sequencia global #10000+
  // de refunds.js/solicitacoes.js/chamadosTI.js) - pedido explicito do
  // usuario: "cada chat ja tera seu proprio ticket que sera informado a
  // quem entrar em contato", ja que a conversa pode virar um chamado de
  // verdade depois (ver gerar-chamado em index.js), mas precisa de um
  // numero pra referenciar desde o primeiro contato, nao so quando/se virar
  const numeroTicket = await ticketCounter.proximoTicket();
  const registro = {
    id: doc.id,
    numeroTicket,
    // chave do visitante - quem tem o token le/escreve nessa conversa
    token: crypto.randomBytes(24).toString('hex'),
    nome: nomeLimpo,
    contato: contatoLimpo,
    assunto: assuntoLimpo,
    lojaContexto: lojaContextoLimpa || null,
    status: 'ABERTO',
    mensagens: [{ de: 'visitante', texto: textoLimpo, em: agora }],
    // registro interno de tentativas suspeitas nessa conversa (texto tipo
    // comando/script, ou arquivo bloqueado no upload - ver segurancaChat.js)
    // - nunca sai na visao publica (getPublico), so no atendimento
    alertasSeguranca: [],
    // true = o Beniboy (bot, ver suporteBot.js) saiu dessa conversa - ou
    // porque ele mesmo chamou um atendente humano, ou por decisao do time
    botDesativado: false,
    logado: logado || null,
    chamadoId: null,
    atendidoPorEmail: null,
    // triagem da Central do Beniboy (ver beniboy.html/atualizarStatusAtendimento) -
    // toda conversa nasce PENDENTE, nivel 1 (so o bot), sem responsavel
    statusAtendimento: 'PENDENTE',
    nivel: 1,
    responsavel: null,
    desbloqueio: false,
    ticketsVinculados: [],
    motivoSemSolucao: null,
    historicoStatus: [{ statusAtendimento: 'PENDENTE', nivel: 1, por: null, em: agora }],
    criadoEm: agora,
    atualizadoEm: agora,
    finalizadoEm: null,
  };
  await doc.set(registro);
  chatsCache.invalidar();
  return registro;
}

async function getOne(id) {
  const doc = await COLLECTION.doc(id).get();
  return doc.exists ? doc.data() : null;
}

// visao do visitante: exige o token certo e omite o que e interno (token de
// outros, e-mail de quem atendeu) - mensagens do time viram so "Suporte"
async function getPublico(id, token) {
  const chat = await getOne(id);
  if (!chat || !token || chat.token !== token) return null;
  return {
    id: chat.id,
    numeroTicket: chat.numeroTicket,
    nome: chat.nome,
    contato: chat.contato,
    assunto: chat.assunto,
    status: chat.status,
    mensagens: (chat.mensagens || []).map((m) => ({ de: m.de, texto: m.texto, em: m.em, ...(m.bot ? { bot: true } : {}), ...(m.anexo ? { anexo: m.anexo } : {}) })),
    criadoEm: chat.criadoEm,
  };
}

// mesma checagem de token da visao publica (getPublico), mas devolvendo o
// registro cru - usado só pra montar o PDF (server/suporteChatPDF.js), que
// precisa do texto puro (mensagens ja vem sem o "de" trocado por rotulo)
async function getComToken(id, token) {
  const chat = await getOne(id);
  if (!chat || !token || chat.token !== token) return null;
  return chat;
}

// `bot: true` = mensagem do Beniboy (suporteBot.js): entra como 'suporte' na
// conversa, mas NAO marca atendidoPorEmail - esse campo continua significando
// "um humano assumiu" (e e o que faz o bot se calar)
// `anexo`: { nome, path, tipo, tamanho } (ver storage.js/segurancaChat.js em
// index.js) - pedido explicito do usuario: "precisa permitir enviar foto e
// anexos no chat". Mensagem com anexo pode ir sem texto (so a foto)
async function adicionarMensagem(id, { de, texto, autorEmail, token, bot, anexo }) {
  const chat = await getOne(id);
  if (!chat) throw new Error('Conversa não encontrada.');
  if (de === 'visitante' && chat.token !== token) throw new Error('Conversa não encontrada.');
  if (chat.status !== 'ABERTO') throw new Error('Essa conversa já foi finalizada. Inicie uma nova.');
  const textoLimpo = limpar(texto, MAX_TEXTO);
  if (!textoLimpo && !anexo) throw new Error('Escreva a mensagem ou anexe um arquivo.');
  if ((chat.mensagens || []).length >= MAX_MENSAGENS) throw new Error('Essa conversa ficou muito longa. Inicie uma nova.');
  const agora = new Date().toISOString();
  const mensagens = [...(chat.mensagens || []), { de, texto: textoLimpo, em: agora, ...(de === 'suporte' ? { autorEmail: autorEmail || null } : {}), ...(bot ? { bot: true } : {}), ...(anexo ? { anexo } : {}) }];
  const patch = { mensagens, atualizadoEm: agora };
  if (de === 'suporte' && !bot && !chat.atendidoPorEmail) patch.atendidoPorEmail = autorEmail || null;
  await COLLECTION.doc(id).update(patch);
  chatsCache.invalidar();
  return getOne(id);
}

// registra uma tentativa suspeita (texto tipo comando/script, ou arquivo
// bloqueado - ver segurancaChat.js em index.js) - fica so no lado do
// atendimento, nunca aparece pro visitante. Capado (mesmo espirito de
// historicoStatus) pra nunca crescer sem limite numa conversa hostil
// mandando varias tentativas seguidas
const MAX_ALERTAS_SEGURANCA = 30;
async function registrarAlertaSeguranca(id, alerta) {
  const chat = await getOne(id);
  if (!chat) throw new Error('Conversa não encontrada.');
  const alertasSeguranca = [...(chat.alertasSeguranca || []), alerta].slice(-MAX_ALERTAS_SEGURANCA);
  await COLLECTION.doc(id).update({ alertasSeguranca });
  chatsCache.invalidar();
  return getOne(id);
}

async function finalizar(id, { autorEmail }) {
  const chat = await getOne(id);
  if (!chat) throw new Error('Conversa não encontrada.');
  if (chat.status !== 'ABERTO') return chat;
  await COLLECTION.doc(id).update({
    status: 'FINALIZADO',
    finalizadoEm: new Date().toISOString(),
    atendidoPorEmail: chat.atendidoPorEmail || autorEmail || null,
    atualizadoEm: new Date().toISOString(),
  });
  chatsCache.invalidar();
  return getOne(id);
}

// tira o bot da conversa em definitivo (chamado pela tool chamar_atendente
// do proprio bot) - dali em diante so humano responde
async function desativarBot(id) {
  await COLLECTION.doc(id).update({ botDesativado: true, atualizadoEm: new Date().toISOString() });
  chatsCache.invalidar();
  return getOne(id);
}

async function vincularChamado(id, chamadoId) {
  await COLLECTION.doc(id).update({ chamadoId, atualizadoEm: new Date().toISOString() });
  chatsCache.invalidar();
  return getOne(id);
}

// move o card no funil da Central do Beniboy (beniboy.html) - chamada tanto
// pelo drag-and-drop quanto pelos botoes de acao rapida. `autor` = snapshot
// de quem esta mexendo ({id, nome, email}) ou null (evento automatico, ex:
// bot vinculando ticket). RESOLVIDO/SEM_SOLUCAO finalizam a conversa pro
// visitante tambem (mesmo efeito de finalizar()); sair de um estado terminal
// de volta pra um estado aberto REABRE a conversa (visitante pode escrever
// de novo) - card "esfriou" mas o time decidiu voltar a mexer nele.
async function atualizarStatusAtendimento(id, { statusAtendimento, nivelDestino, motivoSemSolucao, autor } = {}) {
  if (!STATUS_ATENDIMENTO.includes(statusAtendimento)) throw new Error('Status de atendimento inválido.');
  const chat = await getOne(id);
  if (!chat) throw new Error('Conversa não encontrada.');
  if (statusAtendimento === 'SEM_SOLUCAO' && !String(motivoSemSolucao || '').trim()) {
    throw new Error('Explique por que essa conversa vai ser encerrada sem solução.');
  }
  if (statusAtendimento === 'TRANSFERIDO' && !nivelValido(nivelDestino)) {
    throw new Error('Informe pra qual nível (N2 - agente ou N3 - Master) essa conversa vai ser transferida.');
  }

  let nivel = chat.nivel || 1;
  let responsavel = chat.responsavel || null;
  if (statusAtendimento === 'PENDENTE') {
    nivel = 1;
    responsavel = null;
  } else {
    nivel = nivelValido(nivelDestino) ? Number(nivelDestino) : Math.max(nivel, 2);
    responsavel = autor || responsavel;
  }

  const agora = new Date().toISOString();
  const patch = {
    statusAtendimento,
    nivel,
    responsavel,
    motivoSemSolucao: statusAtendimento === 'SEM_SOLUCAO' ? String(motivoSemSolucao).trim() : (statusAtendimento === chat.statusAtendimento ? chat.motivoSemSolucao : null),
    atualizadoEm: agora,
    historicoStatus: [...(chat.historicoStatus || []), { statusAtendimento, nivel, por: autor ? (autor.nome || autor.email || autor.id) : null, em: agora }].slice(-50),
  };
  // voltar pro PENDENTE = devolver pro Beniboy de verdade (não só cosmético
  // no kanban) - reativa o bot mesmo que ele tenha se calado antes (chamou
  // atendente, ver desativarBot acima). Reverte só esse "desligamento
  // manual"; se atendidoPorEmail já tiver sido gravado (algum humano
  // respondeu antes), o bot continua fora dali por segurança - ver o gate
  // em suporteBot.js (botDesativado || atendidoPorEmail)
  if (statusAtendimento === 'PENDENTE') patch.botDesativado = false;
  if (STATUS_TERMINAL.has(statusAtendimento) && chat.status === 'ABERTO') {
    patch.status = 'FINALIZADO';
    patch.finalizadoEm = agora;
    patch.atendidoPorEmail = chat.atendidoPorEmail || (autor && autor.email) || null;
  } else if (!STATUS_TERMINAL.has(statusAtendimento) && chat.status === 'FINALIZADO') {
    patch.status = 'ABERTO';
    patch.finalizadoEm = null;
  }
  await COLLECTION.doc(id).update(patch);
  chatsCache.invalidar();
  return getOne(id);
}

// nota/relatorio interno do Beniboy sobre o atendimento (Fluxo 4 do prompt:
// "registre um resumo detalhado usando a acao de registrar nota interna") -
// fica SO no lado do atendimento (Central do Beniboy/beniboy.html), NUNCA
// aparece pro visitante (getPublico nao projeta esse campo). Capado como os
// alertasSeguranca, pra nunca crescer sem limite numa conversa longa.
const MAX_NOTAS_INTERNAS = 20;
async function registrarNotaInterna(id, { resumo, situacao, pendencia } = {}) {
  const chat = await getOne(id);
  if (!chat) throw new Error('Conversa não encontrada.');
  const resumoLimpo = limpar(resumo, 1200);
  if (!resumoLimpo) throw new Error('Escreva o resumo da nota interna.');
  const nota = {
    resumo: resumoLimpo,
    situacao: ['RESOLVIDO', 'PENDENTE'].includes(situacao) ? situacao : null,
    pendencia: limpar(pendencia, 600) || null,
    por: 'Beniboy (bot)',
    em: new Date().toISOString(),
  };
  const notasInternas = [...(chat.notasInternas || []), nota].slice(-MAX_NOTAS_INTERNAS);
  await COLLECTION.doc(id).update({ notasInternas, atualizadoEm: new Date().toISOString() });
  chatsCache.invalidar();
  return getOne(id);
}

// flag pra filtrar/etiquetar no kanban - setada quando o Beniboy usa a tool
// desbloquear_login nessa conversa (ver suporteBot.js). So grava 1x.
async function marcarDesbloqueio(id) {
  const chat = await getOne(id);
  if (!chat || chat.desbloqueio) return chat;
  await COLLECTION.doc(id).update({ desbloqueio: true, atualizadoEm: new Date().toISOString() });
  chatsCache.invalidar();
  return getOne(id);
}

// registra um ticket (solicitacao da Central OU chamado tecnico) aberto a
// partir dessa conversa - pode acontecer mais de uma vez na mesma conversa.
// Avanca o card pro estagio TICKET_CRIADO automaticamente, a menos que ele ja
// esteja num estagio terminal (RESOLVIDO/SEM_SOLUCAO) - nesse caso so registra
// o ticket sem mexer no funil, pra nao reabrir um card que o time ja fechou.
async function adicionarTicketVinculado(id, { tipo, ticketId, numero }) {
  const chat = await getOne(id);
  if (!chat) throw new Error('Conversa não encontrada.');
  const ticketsVinculados = [...(chat.ticketsVinculados || []), { tipo, ticketId, numero, em: new Date().toISOString() }];
  await COLLECTION.doc(id).update({ ticketsVinculados, atualizadoEm: new Date().toISOString() });
  chatsCache.invalidar();
  if (!STATUS_TERMINAL.has(chat.statusAtendimento)) {
    return atualizarStatusAtendimento(id, { statusAtendimento: 'TICKET_CRIADO', nivelDestino: chat.nivel > 1 ? chat.nivel : 2, autor: null });
  }
  return getOne(id);
}

async function listAllUncached() {
  const snap = await COLLECTION.orderBy('criadoEm', 'desc').get();
  return snap.docs.map((d) => d.data());
}
const chatsCache = createCache(listAllUncached, 5 * 60 * 1000);
const listAll = chatsCache.cached;

// Brasilia e sempre UTC-3 (sem horario de verao desde 2019) - monta o limite
// do dia local direto, sem depender de Intl/timeZone pra cada comparacao
function limiteDiaBrasilia(dataYMD, fimDoDia) {
  const hora = fimDoDia ? '23:59:59.999' : '00:00:00.000';
  return new Date(`${dataYMD}T${hora}-03:00`).getTime();
}

function mediaMs(valores) {
  const validos = valores.filter((v) => v != null && v >= 0);
  if (!validos.length) return null;
  return Math.round(validos.reduce((a, b) => a + b, 0) / validos.length);
}

// 1a mensagem de verdade de um humano do time (bot:true e o Beniboy, nao
// conta) - usado pra "tempo medio ate a 1a resposta humana", metrica que nao
// existe pronta em nenhum campo (ver comentario dos campos no topo do arquivo)
function primeiraRespostaHumanaMs(chat) {
  const m = (chat.mensagens || []).find((x) => x.de === 'suporte' && !x.bot);
  if (!m) return null;
  return new Date(m.em).getTime() - new Date(chat.criadoEm).getTime();
}
// so os chats que ja finalizaram tem finalizadoEm - os ainda ABERTOS ficam
// de fora da media de resolucao (nao daria pra saber quanto tempo vao levar)
function resolucaoMs(chat) {
  if (!chat.finalizadoEm) return null;
  return new Date(chat.finalizadoEm).getTime() - new Date(chat.criadoEm).getTime();
}

// metricas agregadas pra tela de dashboard (dashboard-atendimentos.html) -
// tudo derivado dos campos que ja existem, sem nenhum campo pre-agregado no
// documento (ver comentario dos campos no topo do arquivo). de/ate no
// formato YYYY-MM-DD (calendario de Brasilia), ambos opcionais.
async function estatisticas({ de, ate } = {}) {
  const todos = await listAll();
  const desdeMs = de ? limiteDiaBrasilia(de, false) : null;
  const ateMs = ate ? limiteDiaBrasilia(ate, true) : null;
  const doPeriodo = todos.filter((c) => {
    const t = new Date(c.criadoEm).getTime();
    return (!desdeMs || t >= desdeMs) && (!ateMs || t <= ateMs);
  });

  const total = doPeriodo.length;
  const emAberto = doPeriodo.filter((c) => c.status === 'ABERTO').length;
  // "via bot" = ninguem do time chegou a responder (atendidoPorEmail so e
  // gravado na 1a resposta HUMANA, ver adicionarMensagem) - o resto e
  // considerado humanizado, mesmo que o Beniboy tenha respondido antes
  const viaBot = doPeriodo.filter((c) => !c.atendidoPorEmail).length;
  const humanizados = total - viaBot;

  const porDiaMapa = {};
  const porHoraMapa = {};
  const porAssuntoMapa = {};
  const porAgenteMapa = {};
  doPeriodo.forEach((c) => {
    const dia = c.criadoEm.slice(0, 10);
    porDiaMapa[dia] = (porDiaMapa[dia] || 0) + 1;
    const hora = new Date(c.criadoEm).getHours();
    porHoraMapa[hora] = (porHoraMapa[hora] || 0) + 1;

    const r = resolucaoMs(c);
    const assuntoChave = c.assunto || 'Outro';
    if (!porAssuntoMapa[assuntoChave]) porAssuntoMapa[assuntoChave] = { assunto: assuntoChave, total: 0, abertos: 0, resolvidos: 0, temposResolucao: [] };
    const ga = porAssuntoMapa[assuntoChave];
    ga.total++;
    if (c.status === 'ABERTO') ga.abertos++;
    if (c.statusAtendimento === 'RESOLVIDO') ga.resolvidos++;
    if (r != null) ga.temposResolucao.push(r);

    // agente: prioriza quem esta responsavel agora (tem nome pronto); sem
    // responsavel definido (conversa antiga/nunca atribuida formalmente),
    // cai pro email de quem respondeu primeiro, so sem nome pra mostrar
    const email = c.responsavel?.email || c.atendidoPorEmail;
    if (email) {
      if (!porAgenteMapa[email]) porAgenteMapa[email] = { email, nome: c.responsavel?.nome || email, total: 0, resolvidos: 0, temposResolucao: [] };
      const gg = porAgenteMapa[email];
      gg.total++;
      if (c.responsavel?.nome) gg.nome = c.responsavel.nome;
      if (c.statusAtendimento === 'RESOLVIDO') gg.resolvidos++;
      if (r != null) gg.temposResolucao.push(r);
    }
  });

  const porDia = Object.entries(porDiaMapa).sort(([a], [b]) => a.localeCompare(b)).map(([dia, total]) => ({ dia, total }));
  const porHora = Array.from({ length: 24 }, (_, h) => ({ hora: h, total: porHoraMapa[h] || 0 }));
  const porAssunto = Object.values(porAssuntoMapa)
    .map((g) => ({ assunto: g.assunto, total: g.total, abertos: g.abertos, resolvidos: g.resolvidos, tempoMedioResolucaoMs: mediaMs(g.temposResolucao) }))
    .sort((a, b) => b.total - a.total);
  const porAgente = Object.values(porAgenteMapa)
    .map((g) => ({ email: g.email, nome: g.nome, total: g.total, resolvidos: g.resolvidos, tempoMedioResolucaoMs: mediaMs(g.temposResolucao) }))
    .sort((a, b) => b.total - a.total);

  return {
    total, emAberto, humanizados, viaBot,
    tempoMedioRespostaMs: mediaMs(doPeriodo.map(primeiraRespostaHumanaMs)),
    tempoMedioResolucaoMs: mediaMs(doPeriodo.map(resolucaoMs)),
    porDia, porHora, porAssunto, porAgente,
  };
}

// tempo entre re-alertas do alarme critico enquanto ninguem assume a
// conversa (ver reforcarAlarmesBeniboy() em index.js) - pedido explicito do
// usuario: o alarme disparava 1x quando o Beniboy chamava um atendente e
// nunca mais, mesmo com a pessoa esperando sem resposta. Encurtado de 3min
// pra 30s (2o pedido do usuario: o reforco demorava demais pra insistir)
const REALERTA_MS = 30 * 1000;

// candidatas a repetir o alarme critico: o Beniboy ja escalou (botDesativado)
// e NINGUEM do time mexeu no card ainda (statusAtendimento continua
// PENDENTE - sair do PENDENTE, mesmo sem mandar mensagem, ja conta como
// "alguem assumiu" e silencia o reforco). So entram as que passaram
// REALERTA_MS desde o ultimo alerta (ver marcarAlertaEnviado) - a varredura
// de ociosos (40min sem nenhuma mensagem nova) acaba encerrando sozinha
// quem ficou mesmo abandonada, entao o reforco nao roda pra sempre.
// consulta filtrada (nao listAllUncached()) de proposito: esse job roda a
// cada 15s o dia inteiro (ver reforcarAlarmesBeniboy em index.js) - baixar a
// colecao INTEIRA (todo o historico de chats ja finalizados) a cada 15s
// custava uma leitura por documento existente, a cada tick, pra sempre.
// Filtrando os 3 campos direto no Firestore (todos com "==", nao precisa de
// indice composto), so vem os poucos chats que realmente podem estar
// esperando reforco - normalmente 0 a poucos, nao o historico inteiro.
async function listarParaReforcarAlarme() {
  const snap = await COLLECTION
    .where('status', '==', 'ABERTO')
    .where('botDesativado', '==', true)
    .where('statusAtendimento', '==', 'PENDENTE')
    .get();
  const chats = snap.docs.map((d) => d.data());
  const agora = Date.now();
  return chats.filter((c) => {
    const desde = new Date(c.ultimoAlertaEm || c.atualizadoEm || c.criadoEm).getTime();
    return agora - desde >= REALERTA_MS;
  });
}

async function marcarAlertaEnviado(id) {
  await COLLECTION.doc(id).update({ ultimoAlertaEm: new Date().toISOString() });
  chatsCache.invalidar();
}

const OCIOSO_MS = 40 * 60 * 1000;

// varredura periodica (ver index.js): encerra sozinha qualquer conversa
// ABERTA sem nenhuma mensagem nova (de nenhum dos dois lados) ha mais de
// OCIOSO_MS - evita conversa "morta" ficando pendurada pra sempre no funil.
// Usa o mesmo caminho de encerramento com motivo (SEM_SOLUCAO) que o time
// usa na mao, so que com autor null (evento automatico, aparece no
// historicoStatus como tal).
// mesmo motivo do listarParaReforcarAlarme() acima: so os chats ABERTOS
// podem estar ociosos, entao filtrar isso direto no Firestore evita reler o
// historico inteiro (chats ja FINALIZADO) a cada 5min, pra sempre
async function finalizarOciosos() {
  const snap = await COLLECTION.where('status', '==', 'ABERTO').get();
  const chats = snap.docs.map((d) => d.data());
  const agora = Date.now();
  const finalizados = [];
  for (const chat of chats) {
    if (chat.status !== 'ABERTO') continue;
    const mensagens = chat.mensagens || [];
    const ultimaEm = mensagens.length ? mensagens[mensagens.length - 1].em : chat.criadoEm;
    if (!ultimaEm || agora - new Date(ultimaEm).getTime() < OCIOSO_MS) continue;
    const atualizado = await atualizarStatusAtendimento(chat.id, {
      statusAtendimento: 'SEM_SOLUCAO',
      motivoSemSolucao: 'Encerrado automaticamente por inatividade (sem novas mensagens por 40 minutos).',
      autor: null,
    });
    finalizados.push(atualizado);
  }
  return finalizados;
}

module.exports = {
  criar, getOne, getPublico, getComToken, adicionarMensagem, finalizar, desativarBot, vincularChamado, listAll, ASSUNTOS,
  atualizarStatusAtendimento, marcarDesbloqueio, adicionarTicketVinculado, STATUS_ATENDIMENTO, finalizarOciosos,
  listarParaReforcarAlarme, marcarAlertaEnviado, registrarAlertaSeguranca, registrarNotaInterna, estatisticas,
};
