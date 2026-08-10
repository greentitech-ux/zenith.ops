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
  const registro = {
    id: doc.id,
    // chave do visitante - quem tem o token le/escreve nessa conversa
    token: crypto.randomBytes(24).toString('hex'),
    nome: nomeLimpo,
    contato: contatoLimpo,
    assunto: assuntoLimpo,
    lojaContexto: lojaContextoLimpa || null,
    status: 'ABERTO',
    mensagens: [{ de: 'visitante', texto: textoLimpo, em: agora }],
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
    nome: chat.nome,
    status: chat.status,
    mensagens: (chat.mensagens || []).map((m) => ({ de: m.de, texto: m.texto, em: m.em, ...(m.bot ? { bot: true } : {}) })),
    criadoEm: chat.criadoEm,
  };
}

// `bot: true` = mensagem do Beniboy (suporteBot.js): entra como 'suporte' na
// conversa, mas NAO marca atendidoPorEmail - esse campo continua significando
// "um humano assumiu" (e e o que faz o bot se calar)
async function adicionarMensagem(id, { de, texto, autorEmail, token, bot }) {
  const chat = await getOne(id);
  if (!chat) throw new Error('Conversa não encontrada.');
  if (de === 'visitante' && chat.token !== token) throw new Error('Conversa não encontrada.');
  if (chat.status !== 'ABERTO') throw new Error('Essa conversa já foi finalizada. Inicie uma nova.');
  const textoLimpo = limpar(texto, MAX_TEXTO);
  if (!textoLimpo) throw new Error('Escreva a mensagem.');
  if ((chat.mensagens || []).length >= MAX_MENSAGENS) throw new Error('Essa conversa ficou muito longa. Inicie uma nova.');
  const agora = new Date().toISOString();
  const mensagens = [...(chat.mensagens || []), { de, texto: textoLimpo, em: agora, ...(de === 'suporte' ? { autorEmail: autorEmail || null } : {}), ...(bot ? { bot: true } : {}) }];
  const patch = { mensagens, atualizadoEm: agora };
  if (de === 'suporte' && !bot && !chat.atendidoPorEmail) patch.atendidoPorEmail = autorEmail || null;
  await COLLECTION.doc(id).update(patch);
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

const OCIOSO_MS = 15 * 60 * 1000;

// varredura periodica (ver index.js): encerra sozinha qualquer conversa
// ABERTA sem nenhuma mensagem nova (de nenhum dos dois lados) ha mais de
// OCIOSO_MS - evita conversa "morta" ficando pendurada pra sempre no funil.
// Usa o mesmo caminho de encerramento com motivo (SEM_SOLUCAO) que o time
// usa na mao, so que com autor null (evento automatico, aparece no
// historicoStatus como tal).
async function finalizarOciosos() {
  const chats = await listAllUncached();
  const agora = Date.now();
  const finalizados = [];
  for (const chat of chats) {
    if (chat.status !== 'ABERTO') continue;
    const mensagens = chat.mensagens || [];
    const ultimaEm = mensagens.length ? mensagens[mensagens.length - 1].em : chat.criadoEm;
    if (!ultimaEm || agora - new Date(ultimaEm).getTime() < OCIOSO_MS) continue;
    const atualizado = await atualizarStatusAtendimento(chat.id, {
      statusAtendimento: 'SEM_SOLUCAO',
      motivoSemSolucao: 'Encerrado automaticamente por inatividade (sem novas mensagens por 15 minutos).',
      autor: null,
    });
    finalizados.push(atualizado);
  }
  return finalizados;
}

module.exports = {
  criar, getOne, getPublico, adicionarMensagem, finalizar, desativarBot, vincularChamado, listAll, ASSUNTOS,
  atualizarStatusAtendimento, marcarDesbloqueio, adicionarTicketVinculado, STATUS_ATENDIMENTO, finalizarOciosos,
};
