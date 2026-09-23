// tarefas.js
// Fila pessoal de execução. Tarefas ligadas a ticket são criadas pelo servidor
// e têm vínculo idempotente: atribuir o mesmo ticket duas vezes não duplica a
// pendência. A tarefa nunca substitui as regras próprias do ticket.
const crypto = require('crypto');
const db = require('./firestore');
const reuniaoGoogle = require('./reuniaoGoogle');
const ticketCounter = require('./ticketCounter');
const prioridades = require('./prioridades');
const auth = require('./auth');

// ---------- reunião: a MESMA tarefa, com hora e link ----------
// Segue o padrão de ehOcorrencia: uma marca que muda o que o cartão mostra e
// deixa filtrar, sem mexer em permissão nem em fluxo. Entidade separada
// duplicaria responsável, participantes, anexos, comentários, vínculo com
// ticket, PDF, filtros e busca - e um dia as duas divergiriam.
const HORA_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DURACAO_MIN = 5;
const DURACAO_MAX = 600;
function limparLinkColado(valor) {
  const url = String(valor || '').trim().slice(0, 400);
  if (!url) throw new Error('Cole um link do Google Meet, ou escolha "Criar no Google Meet".');
  let meet;
  try { meet = new URL(url); } catch (_) { throw new Error('O link da reunião precisa ser um endereço válido do Google Meet.'); }
  if (meet.protocol !== 'https:' || meet.hostname !== 'meet.google.com') {
    throw new Error('As reuniões do NoPulso usam somente links https://meet.google.com/.');
  }
  return meet.href;
}
// devolve os campos da reunião já validados, ou os nulos de uma tarefa comum
function camposDaReuniao({ ehReuniao, horaInicio, duracaoMin, linkReuniao, linkOrigem }) {
  if (!ehReuniao) return { ehReuniao: false, horaInicio: null, duracaoMin: null, linkReuniao: null, linkOrigem: null };
  const hora = String(horaInicio || '').trim();
  if (!HORA_RE.test(hora)) throw new Error('Informe a hora da reunião no formato HH:MM.');
  const bruta = parseInt(duracaoMin, 10);
  const duracao = Math.min(DURACAO_MAX, Math.max(DURACAO_MIN, Number.isFinite(bruta) ? bruta : 60));
  const colado = String(linkOrigem || '') === 'colado';
  return {
    ehReuniao: true, horaInicio: hora, duracaoMin: duracao,
    // Link automático é exclusivamente Google Meet. Não se cria uma reunião
    // com sala alternativa: se o Workspace não estiver pronto, a pessoa vê o
    // erro e corrige a integração antes de avisar participantes.
    linkReuniao: colado ? limparLinkColado(linkReuniao) : null,
    linkOrigem: colado ? 'colado' : 'google-pendente',
  };
}

// Gera a sala no Google Meet e o evento no Calendar. Não há fallback: a regra
// do NoPulso é que toda sala gerada venha da agenda corporativa.
async function salaDoWorkspace(reuniao, { titulo, descricao, dia, pessoas }) {
  if (!reuniao.ehReuniao || reuniao.linkOrigem !== 'google-pendente') return {};
  if (!reuniaoGoogle.configurado()) {
    throw new Error('Google Meet ainda não está conectado. Configure GOOGLE_MEET_USUARIO e a delegação do Google Calendar antes de criar a reunião.');
  }
  const sala = await reuniaoGoogle.criarSala({
    titulo,
    descricao,
    dia,
    hora: reuniao.horaInicio,
    duracaoMin: reuniao.duracaoMin,
    convidados: (pessoas || []).map((p) => p && p.email).filter(Boolean),
  });
  return { linkReuniao: sala.link, linkOrigem: 'google', eventoGoogleId: sala.eventoId };
}

const COLLECTION = db.collection('tarefas');
const CONTROLE = db.collection('tarefasControle');
const STATUS_ABERTO = new Set(['PENDENTE', 'A_FAZER', 'HOJE', 'EM_ANDAMENTO']);
const STATUS_EDITAVEIS = new Set(['PENDENTE', 'A_FAZER', 'HOJE', 'EM_ANDAMENTO']);
const STATUS_TAREFA = [...STATUS_EDITAVEIS, 'CONCLUIDA', 'CANCELADA', 'ARQUIVADA'];

function nomeUsuario(usuario) {
  return String(usuario?.nome || usuario?.name || usuario?.username || 'Usuário').trim().slice(0, 80);
}

function podeGerir(tarefa, acesso) {
  if (acesso.isMaster) return true;
  if (tarefa.responsavelId === acesso.usuario.id || tarefa.criadoPorId === acesso.usuario.id) return true;
  return !!acesso.isAdmin && !!tarefa.unidade && (acesso.unidades || []).includes(tarefa.unidade);
}

// Modelo do Asana: UM responsável (assignee, dono da entrega) e N participantes
// (collaborators). Participante faz a tarefa ANDAR - comenta, anexa e mexe no
// status. O que muda o combinado (prazo, quem participa) e o que destrói
// (remover a tarefa) fica com o dono; anexo, cada um tira o seu. Sem essa
// separação, "quem participa" viraria um segundo dono e o prazo mudaria sem
// quem cobra ficar sabendo.
function podeParticipar(tarefa, acesso) {
  return podeGerir(tarefa, acesso) || (tarefa.colaboradoresIds || []).includes(acesso.usuario.id);
}

function podeMoverStatus(tarefa, acesso) {
  if (podeGerir(tarefa, acesso)) return true;
  return !tarefa.participantesApenasAcompanham && (tarefa.colaboradoresIds || []).includes(acesso.usuario.id);
}

function podeArquivar(tarefa, acesso) {
  return !!acesso.isMaster || (!!acesso.isAdmin && tarefa.status === 'CONCLUIDA'
    && !!tarefa.unidade && (acesso.unidades || []).includes(tarefa.unidade));
}

// Ticket automatico de "Login bloqueado" (ver auth.criarChamadoBloqueio):
// APROVAR ja destrava a conta na mesma hora - e a conclusao, nao ha execucao
// depois. Sem isto a tarefa ficava em "A fazer" pra sempre com o ticket
// encerrado (pedido do Master, 12/09: "todos que tiverem com status
// encerrado precisa estar em Concluidos").
function ehTicketDeBloqueio(ticket) {
  return !!ticket && ticket.tipo === 'suporte-ti' && ticket.criadoPorEmail === auth.ROBO_BLOQUEIO_EMAIL;
}
function statusDoTicket(ticket) {
  if (ticket.status === 'APROVADO') return (ticket.execucaoStatus === 'FINALIZADO' || ehTicketDeBloqueio(ticket)) ? 'CONCLUIDA' : 'A_FAZER';
  if (ticket.status === 'PENDENTE') return 'PENDENTE';
  return 'CANCELADA';
}

function chaveTicket(ticketId, usuarioId, email) {
  const alvo = String(usuarioId || email || '').trim().toLowerCase();
  return `ticket-${ticketId}-${crypto.createHash('sha256').update(alvo).digest('hex').slice(0, 16)}`;
}

function podeReceberTicket(usuario) {
  if (!usuario) return false;
  if (usuario.role === 'master') return true;
  const secoes = usuario.permissions?.sections || [];
  const cargo = String(usuario.cargo || '').toLowerCase();
  return ['suporte', 'tecnico', 'manutencao'].some((tag) => secoes.includes(tag) || cargo === tag);
}

// Ticket sem responsável (ou direcionado a quem não tem perfil operacional)
// vai pra fila do Master - UM Master, não todos. Master enxerga toda tarefa
// (podeGerir), então uma cópia por Master era triplicata pura: o mesmo
// #11800 aparecia três vezes (manu, solutions, david) pra quem abrisse o
// Meu Dia. Master, 13/09: "o ticket sempre fica repetido - não pode
// acontecer". Fica com o Master principal (MASTER_EMAIL); sem ele entre os
// usuários, o primeiro Master em ordem de e-mail - determinístico, pra não
// trocar de dono a cada sincronização.
function masterDaFila(usuarios) {
  const masters = usuarios.filter((u) => u.role === 'master');
  if (!masters.length) return [];
  const principal = String(process.env.MASTER_EMAIL || '').trim().toLowerCase();
  const eleito = masters.find((u) => String(u.email || '').trim().toLowerCase() === principal)
    || [...masters].sort((a, b) => String(a.email || '').localeCompare(String(b.email || '')))[0];
  return [eleito];
}

function destinatarios(ticket, usuarios) {
  const ids = Array.isArray(ticket.atribuidosIds) && ticket.atribuidosIds.length
    ? ticket.atribuidosIds : [ticket.direcionadoParaId].filter(Boolean);
  const emails = Array.isArray(ticket.atribuidosEmails) && ticket.atribuidosEmails.length
    ? ticket.atribuidosEmails : [ticket.direcionadoParaEmail].filter(Boolean);
  if (!ids.length && !emails.length) return masterDaFila(usuarios);
  const elegiveis = usuarios.filter((u) => podeReceberTicket(u)
    && (ids.includes(u.id) || emails.map((x) => String(x).toLowerCase()).includes(String(u.email || '').toLowerCase())));
  // Um ticket direcionado a alguém sem perfil operacional não desaparece da
  // fila: o Master recebe a pendência para decidir se a delega.
  return elegiveis.length ? elegiveis : masterDaFila(usuarios);
}

async function sincronizarTicket(ticket, usuarios, tipo = 'solicitacao') {
  if (!ticket?.id) return [];
  // Quebra de caixa é um alerta financeiro, não uma ordem de execução. Ela
  // só entra no Meu Dia quando alguém usar a ação explícita “Criar tarefa”.
  if (ticket.tipo === 'quebra-caixa') return [];
  const chaveBase = `${tipo}:${ticket.id}`;
  const alvos = destinatarios(ticket, usuarios);
  const alvoIds = new Set(alvos.map((u) => u.id));
  const existentes = await COLLECTION.where('vinculo.chave', '==', chaveBase).get();
  const agora = new Date().toISOString();
  // a tarefa existe desde que o TICKET foi aberto, nao desde a sincronizacao
  const nasceEm = /^\d{4}-\d{2}-\d{2}T/.test(String(ticket.criadoEm || '')) ? String(ticket.criadoEm) : agora;
  const alteradas = [];

  // Se o ticket nasceu ao converter uma tarefa manual, aquela tarefa É a
  // execução original. Atualizá-la aqui evita duas cópias do mesmo trabalho e
  // garante que Central e Meu Dia cheguem ao mesmo estado.
  // Uma tarefa de triagem pode virar tanto solicitação comum quanto estorno.
  // Em ambos os casos ela é o trabalho original; criar a cópia automática do
  // ticket faria o mesmo pedido aparecer duas vezes no Meu Dia.
  const origemId = String(ticket.origemTarefa?.id || '').trim();
  if (origemId) {
    const origemRef = COLLECTION.doc(origemId);
    const origemSnap = await origemRef.get();
    if (origemSnap.exists) {
      const atual = origemSnap.data();
      const concluida = statusDoTicket(ticket) === 'CONCLUIDA';
      const reaberta = !concluida && atual.status === 'CONCLUIDA';
      const patch = {
        ...(tipo === 'estorno' ? { estornoId: ticket.id } : { solicitacaoId: ticket.id }),
        numeroTicket: ticket.numeroTicket || atual.numeroTicket || null,
        status: statusDoTicket(ticket), atualizadoEm: agora,
        ...(concluida && !atual.concluidaEm ? {
          concluidaEm: ticket.execucaoFinalizadaEm || agora,
          concluidaPorId: ticket.execucaoPorId || null,
          concluidaPorNome: ticket.execucaoPorNome || 'Responsável pela tarefa',
          observacaoConclusao: ticket.finalizadaPorTarefaObservacao || atual.observacaoConclusao || '',
        } : {}),
        ...(reaberta ? { concluidaEm: null, concluidaPorId: null, concluidaPorNome: null, observacaoConclusao: null, reabertaEm: agora, reabertaPorNome: 'Central de Solicitações' } : {}),
      };
      await origemRef.update(patch);
      alteradas.push({ ...atual, ...patch });
    }
    return alteradas;
  }

  // Quem deixou de ser responsável não carrega um ticket antigo na fila.
  const masterIds = new Set(usuarios.filter((u) => u.role === 'master').map((u) => u.id));
  for (const doc of existentes.docs) {
    const tarefa = doc.data();
    if (alvoIds.has(tarefa.responsavelId)) continue;
    if (STATUS_ABERTO.has(tarefa.status)) {
      await doc.ref.update({ status: 'CANCELADA', canceladaEm: agora, motivoCancelamento: 'Ticket redirecionado.' });
    } else if (tarefa.status === 'CONCLUIDA' && masterIds.has(tarefa.responsavelId)) {
      // cópia CONCLUÍDA de um Master que não é o da fila: é a triplicata
      // antiga (uma por Master). Some da lista sem apagar o histórico - o
      // ticket continua com a tarefa do Master da fila.
      await doc.ref.update({ status: 'ARQUIVADA', arquivadaEm: agora, arquivadaPorNome: 'Sincronização (cópia repetida do ticket)', atualizadoEm: agora });
    }
  }

  for (const usuario of alvos) {
    const id = chaveTicket(ticket.id, usuario.id, usuario.email);
    const ref = COLLECTION.doc(id);
    const snap = await ref.get();
    if (snap.exists) {
      const atual = snap.data();
      // conserta a data das tarefas que ja existem com a data da sincronizacao
      // no lugar da data do ticket. NAO mexe em atualizadoEm nesse caso: a
      // lista e ordenada por ele, e corrigir data nao e "movimento" da tarefa
      const corrigeData = nasceEm !== atual.criadaEm || nasceEm.slice(0, 10) !== atual.dataInicio
        ? { criadaEm: nasceEm, dataInicio: nasceEm.slice(0, 10) } : null;
      const concluida = statusDoTicket(ticket) === 'CONCLUIDA';
      const reaberta = !concluida && atual.status === 'CONCLUIDA';
      await ref.update({ titulo: ticket.titulo || atual.titulo || ('Ticket #' + (ticket.numeroTicket || '')), numeroTicket: ticket.numeroTicket || atual.numeroTicket || null, prioridade: ticket.prioridade || 'normal', status: statusDoTicket(ticket), atualizadoEm: agora,
        ...(corrigeData || {}),
        ...(concluida && !atual.concluidaEm ? {
          concluidaEm: ticket.execucaoFinalizadaEm || agora,
          concluidaPorId: ticket.execucaoPorId || null,
          concluidaPorNome: ticket.execucaoPorNome || 'Suporte',
          observacaoConclusao: ticket.finalizadaPorTarefaObservacao || atual.observacaoConclusao || '',
        } : {}),
        ...(reaberta ? { concluidaEm: null, concluidaPorId: null, concluidaPorNome: null, observacaoConclusao: null, reabertaEm: agora, reabertaPorNome: 'Central de Solicitações' } : {}) });
      if (corrigeData) alteradas.push({ ...atual, ...corrigeData });
      continue;
    }
    const tarefa = {
      id,
      origem: 'ticket',
      titulo: ticket.titulo || `Ticket #${ticket.numeroTicket || ''}`,
      // A tarefa é a execução deste mesmo ticket; ela nunca consome outro
      // número da sequência global.
      numeroTicket: ticket.numeroTicket || null,
      prioridade: ticket.prioridade || 'normal',
      status: statusDoTicket(ticket),
      responsavelId: usuario.id,
       responsavelEmail: usuario.email || null,
       responsavelNome: nomeUsuario(usuario),
       criadoPorId: usuario.id, criadoPorNome: nomeUsuario(usuario),
      criadaEm: nasceEm,
      atualizadoEm: agora,
      vinculo: { chave: chaveBase, tipo, ticketTipo: ticket.tipo || tipo, id: ticket.id, numeroTicket: ticket.numeroTicket || null },
      unidade: ticket.unidade || null,
      unidadeNome: ticket.unidadeNome || null,
      comentarios: [],
      dataInicio: nasceEm.slice(0, 10), dataEntrega: null, anexos: [], colaboradores: [], colaboradoresIds: [],
    };
    await ref.set(tarefa);
    alteradas.push(tarefa);
  }
  return alteradas;
}

async function listarMinhas(acesso) {
  const snap = await COLLECTION.orderBy('atualizadoEm', 'desc').get();
  return snap.docs.map((d) => d.data())
    .filter((tarefa) => tarefa.status !== 'ARQUIVADA' && (tarefa.status !== 'CANCELADA' || acesso.isMaster) && podeParticipar(tarefa, acesso))
    // podeGerir vai junto pra tela saber o que desabilitar (prazo, participantes,
    // remover) sem ter que reimplementar a regra no navegador
    .map((tarefa) => ({ ...tarefa, podeGerir: podeGerir(tarefa, acesso) }))
    .sort((a, b) => String(b.atualizadoEm).localeCompare(String(a.atualizadoEm)));
}

// A tela decide o que desabilitar (prazo, participantes, remover, marcar passo)
// por `podeGerir` - e esse campo NÃO existe no documento: listarMinhas calcula
// e pendura. Quem responde com o documento cru devolve `podeGerir: undefined`,
// e a tela que guardar essa resposta trava tudo como se o usuário não pudesse
// nada. Foi exatamente o que aconteceu: depois de marcar uma subtarefa, as
// datas da tarefa ficavam bloqueadas.
//
// Então getOne passa a aceitar o acesso e devolver a tarefa do MESMO formato
// que a lista. Sem acesso, continua devolvendo o documento cru - é o que os
// chamadores internos (relatório, PDF, sincronização) querem.
async function getOne(id, acesso) {
  const snap = await COLLECTION.doc(id).get();
  if (!snap.exists) return null;
  const tarefa = snap.data();
  return acesso ? { ...tarefa, podeGerir: podeGerir(tarefa, acesso) } : tarefa;
}

function pessoasParaColaboradores(pessoas, responsavelId) {
  const vistos = new Set([responsavelId]);
  return (pessoas || []).filter((p) => p && p.id && !vistos.has(p.id) && vistos.add(p.id))
    .map((p) => ({ id: p.id, nome: nomeUsuario(p) })).slice(0, 20);
}

async function criar({ titulo, descricao, dataInicio, dataEntrega, unidade, unidadeNome, usuario, responsavel, colaboradores = [], vinculo = null, ehOcorrencia = false, ehReuniao = false, horaInicio = null, duracaoMin = null, linkReuniao = null, linkOrigem = null, numeroTicket: numeroTicketInformado = null, origem = null, origemChatId = null, prioridade, participantesApenasAcompanham = false, subtarefas = [], serie = null, anexosIniciais = [], triagem = null }) {
  const texto = String(titulo || '').trim().slice(0, 200);
  if (!texto) throw new Error('Informe o título da tarefa.');
  const ref = COLLECTION.doc();
  const agora = new Date().toISOString();
  const inicio = /^\d{4}-\d{2}-\d{2}$/.test(dataInicio || '') ? dataInicio : agora.slice(0, 10);
  const entrega = /^\d{4}-\d{2}-\d{2}$/.test(dataEntrega || '') ? dataEntrega : null;
  const hoje = agora.slice(0, 10);
  const statusInicial = entrega && entrega < hoje ? 'PENDENTE' : (entrega === hoje ? 'HOJE' : 'A_FAZER');
  const equipe = pessoasParaColaboradores(colaboradores, (responsavel || usuario).id);
  // Uma tarefa avulsa já nasce como um protocolo rastreável. Se ela veio de
  // um ticket existente, herda esse mesmo número — não cria uma segunda
  // numeração para o mesmo assunto.
  const numeroTicket = numeroTicketInformado != null ? numeroTicketInformado : (vinculo?.numeroTicket != null ? vinculo.numeroTicket : await ticketCounter.proximoTicket());
  const prioridadeFinal = prioridades.sanitizarPrioridade(prioridade);
  // valida ANTES de gravar: reunião sem hora não é reunião, e link colado
  // sem https não é link. Falhar aqui é melhor que gravar pela metade.
  const reuniao = camposDaReuniao({ ehReuniao, horaInicio, duracaoMin, linkReuniao, linkOrigem });
  // Sala corporativa obrigatória: a tarefa só é gravada depois que o Google
  // devolve o link do Meet e o id do evento. Isso impede salas fora da agenda.
  Object.assign(reuniao, await salaDoWorkspace(reuniao, {
    titulo: texto, descricao, dia: entrega,
    pessoas: [responsavel || usuario, ...(colaboradores || [])],
  }));
  const tarefa = {
    id: ref.id, origem: origem || (vinculo ? 'ticket-manual' : 'manual'), titulo: texto,
    numeroTicket,
    origemChatId: origemChatId || null,
    descricao: String(descricao || '').trim().slice(0, 2000),
    prioridade: prioridadeFinal, slaPrazo: prioridades.slaPrazo(prioridadeFinal, agora), status: statusInicial, dataInicio: inicio, dataEntrega: entrega,
    // marca de REGISTRO: a situação já aconteceu e o que se quer é o
    // documento, não um pedido. Não muda permissão nem fluxo - muda o que o
    // PDF diz que ele é, e deixa filtrar "só ocorrências" na lista.
    ehOcorrencia: !!ehOcorrencia,
    ehReuniao: reuniao.ehReuniao, horaInicio: reuniao.horaInicio, duracaoMin: reuniao.duracaoMin,
    linkReuniao: reuniao.linkReuniao, linkOrigem: reuniao.linkOrigem,
    // guardado pra poder APAGAR o compromisso na agenda quando a reunião for
    // cancelada aqui - senão fica de pé no calendário de todo mundo
    eventoGoogleId: reuniao.eventoGoogleId || null,
    responsavelId: (responsavel || usuario).id, responsavelEmail: (responsavel || usuario).email || null, responsavelNome: nomeUsuario(responsavel || usuario),
    criadoPorId: usuario.id, criadoPorNome: nomeUsuario(usuario),
    criadaEm: agora, atualizadoEm: agora, comentarios: [], vinculo,
    anexos: (Array.isArray(anexosIniciais) ? anexosIniciais : []).slice(0, 5)
      .map((a) => ({ nome: String(a?.nome || 'Anexo').slice(0, 200), path: String(a?.path || ''), tipo: String(a?.tipo || 'application/octet-stream') }))
      .filter((a) => a.path),
    // Dados de triagem não são exibidos na descrição. Servem apenas para que
    // Master/Suporte decidam, depois, se o pedido merece virar uma solicitação.
    triagem: triagem && typeof triagem === 'object' ? triagem : null,
    colaboradores: equipe, colaboradoresIds: equipe.map((p) => p.id), participantesApenasAcompanham: !!participantesApenasAcompanham,
    unidade: unidade || null, unidadeNome: unidadeNome || unidade || null,
    // passos ja nascem desmarcados: a serie recorrente repete a CHECKLIST, nao
    // o que a ocorrencia passada conseguiu fazer
    subtarefas: (Array.isArray(subtarefas) ? subtarefas : []).slice(0, SUBTAREFA_MAX)
      .map((x) => String((x && x.titulo) || x || '').trim().slice(0, 200)).filter(Boolean)
      .map((t) => ({
        id: crypto.randomBytes(8).toString('hex'), titulo: t, feita: false,
        feitaEm: null, feitaPorId: null, feitaPorNome: null,
        criadaEm: agora, criadaPorId: usuario.id, criadaPorNome: nomeUsuario(usuario),
      })),
    // de qual serie recorrente esta ocorrencia saiu (null = tarefa avulsa)
    serieId: (serie && serie.id) || null, serieData: (serie && serie.data) || null,
  };
  await ref.set(tarefa);
  return tarefa;
}

// ---------- SUBTAREFAS: a lista de passos DENTRO da tarefa ----------
//
// Checklist, nao tarefa-filha. A diferenca importa: subtarefa nao tem
// responsavel proprio, nem prazo, nem SLA, nem PDF - se tivesse, seria uma
// tarefa, e ai o certo e' criar uma tarefa e vincular. O que ela resolve e'
// "essa entrega tem 3 passos e eu quero ver quais ja sairam", que hoje so
// cabia no texto da descricao e ninguem conseguia marcar.
//
// Mora DENTRO do documento da tarefa (como anexos e comentarios), nao em
// colecao propria: abrir a ficha ja traz tudo em 1 leitura. Colecao separada
// custaria uma consulta por tarefa em toda lista (§3).
//
// NAO conclui a tarefa sozinha quando o ultimo item e' marcado, e e' de
// proposito - e o que Asana, Todoist e ClickUp fazem. Terminar os passos que
// alguem escreveu nao e' a mesma coisa que entregar; quem entrega diz que
// entregou.
const SUBTAREFA_MAX = 50;
function progressoSubtarefas(tarefa) {
  const lista = (tarefa && tarefa.subtarefas) || [];
  return { total: lista.length, feitas: lista.filter((x) => x && x.feita).length };
}
async function adicionarSubtarefa(id, acesso, titulo) {
  const texto = String(titulo || '').trim().slice(0, 200);
  if (!texto) throw new Error('Escreva o que é a subtarefa.');
  const ref = COLLECTION.doc(id); const snap = await ref.get();
  if (!snap.exists) throw new Error('Tarefa não encontrada.');
  const tarefa = snap.data();
  // mesma regua do comentario e do anexo: quem participa faz a tarefa ANDAR
  if (!podeParticipar(tarefa, acesso)) throw new Error('Você não pode criar subtarefa nesta tarefa.');
  const lista = tarefa.subtarefas || [];
  if (lista.length >= SUBTAREFA_MAX) throw new Error(`Uma tarefa aceita no máximo ${SUBTAREFA_MAX} subtarefas. Se precisa de mais, provavelmente são duas tarefas.`);
  const agora = new Date().toISOString();
  const item = {
    id: crypto.randomBytes(8).toString('hex'), titulo: texto, feita: false,
    feitaEm: null, feitaPorId: null, feitaPorNome: null,
    // passo tem data e dono PRÓPRIOS (pedido do Master): "identificar" vence
    // amanhã com o técnico, "solução" na sexta com outra pessoa. Continua sem
    // SLA, sem PDF e sem número de ticket - isso é o que separa passo de tarefa.
    dataInicio: null, dataEntrega: null, responsavelId: null, responsavelNome: null,
    criadaEm: agora, criadaPorId: acesso.usuario.id, criadaPorNome: nomeUsuario(acesso.usuario),
  };
  await ref.update({ subtarefas: [...lista, item], atualizadoEm: agora });
  return getOne(id, acesso);
}
const DATA_ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
// Quem pode ser dono de um passo: SÓ quem já está na tarefa (o responsável e
// os participantes). Não é rigor à toa - é a mesma regra que impede alguém de
// se auto-adicionar numa tarefa de outra unidade (ver definirColaboradores).
// Um passo atribuído a quem não participa seria trabalho distribuído por uma
// porta lateral.
function gentePermitida(tarefa) {
  const mapa = new Map();
  if (tarefa.responsavelId) mapa.set(tarefa.responsavelId, tarefa.responsavelNome || 'Usuário');
  (tarefa.colaboradores || []).forEach((p) => { if (p && p.id) mapa.set(p.id, p.nome || 'Usuário'); });
  return mapa;
}
// UM patch para tudo que se muda num passo (marcar, datar, atribuir, renomear).
// Rotas separadas por campo dariam quatro caminhos com quatro checagens de
// permissão para escrever no MESMO array - e um dia uma delas ficaria para trás.
async function atualizarSubtarefa(id, acesso, subId, patch) {
  const ref = COLLECTION.doc(id); const snap = await ref.get();
  if (!snap.exists) throw new Error('Tarefa não encontrada.');
  const tarefa = snap.data();
  // mexer no passo e' andamento, mesma regua do status: quem so acompanha nao
  // move a tarefa, e mexer em subtarefa e' mover
  if (!podeMoverStatus(tarefa, acesso)) throw new Error('Você acompanha esta tarefa: pode comentar e anexar, mas não mexer nas subtarefas.');
  const lista = tarefa.subtarefas || [];
  // pelo ID, nunca pelo indice: entre desenhar a tela e o clique alguem pode
  // ter criado outra subtarefa, e por posicao o clique mexeria na errada
  const alvo = lista.find((x) => x && x.id === String(subId));
  if (!alvo) throw new Error('Subtarefa não encontrada.');
  const agora = new Date().toISOString();
  const mudanca = {};

  if (patch.titulo !== undefined) {
    const t = String(patch.titulo || '').trim().slice(0, 200);
    if (!t) throw new Error('A subtarefa precisa de um nome.');
    mudanca.titulo = t;
  }
  if (patch.feita !== undefined) {
    const feita = !!patch.feita;
    Object.assign(mudanca, {
      feita,
      feitaEm: feita ? agora : null,
      feitaPorId: feita ? acesso.usuario.id : null,
      feitaPorNome: feita ? nomeUsuario(acesso.usuario) : null,
    });
  }
  // string vazia = LIMPAR o campo; undefined = nao mexer. Sem essa diferenca
  // nao haveria como tirar uma data que foi posta por engano.
  if (patch.dataInicio !== undefined) {
    const v = String(patch.dataInicio || '');
    if (v && !DATA_ISO_RE.test(v)) throw new Error('Data de início da subtarefa inválida.');
    mudanca.dataInicio = v || null;
  }
  if (patch.dataEntrega !== undefined) {
    const v = String(patch.dataEntrega || '');
    if (v && !DATA_ISO_RE.test(v)) throw new Error('Previsão da subtarefa inválida.');
    mudanca.dataEntrega = v || null;
  }
  const inicioFinal = mudanca.dataInicio !== undefined ? mudanca.dataInicio : alvo.dataInicio;
  const entregaFinal = mudanca.dataEntrega !== undefined ? mudanca.dataEntrega : alvo.dataEntrega;
  if (inicioFinal && entregaFinal && entregaFinal < inicioFinal) throw new Error('A previsão da subtarefa é anterior ao início dela.');
  if (patch.responsavelId !== undefined) {
    const quem = String(patch.responsavelId || '');
    if (!quem) { mudanca.responsavelId = null; mudanca.responsavelNome = null; } else {
      const permitidos = gentePermitida(tarefa);
      if (!permitidos.has(quem)) throw new Error('Só quem já está na tarefa (responsável ou participante) pode ficar com uma subtarefa.');
      mudanca.responsavelId = quem;
      mudanca.responsavelNome = permitidos.get(quem);
    }
  }
  if (!Object.keys(mudanca).length) return getOne(id, acesso);
  const nova = lista.map((x) => (x && x.id === String(subId) ? { ...x, ...mudanca } : x));
  await ref.update({ subtarefas: nova, atualizadoEm: agora });
  return getOne(id, acesso);
}
// nome antigo mantido: era o que a rota chamava quando so existia marcar
const alternarSubtarefa = (id, acesso, subId, feita) => atualizarSubtarefa(id, acesso, subId, { feita });
async function removerSubtarefa(id, acesso, subId) {
  const ref = COLLECTION.doc(id); const snap = await ref.get();
  if (!snap.exists) throw new Error('Tarefa não encontrada.');
  const tarefa = snap.data();
  const lista = tarefa.subtarefas || [];
  const alvo = lista.find((x) => x && x.id === String(subId));
  if (!alvo) throw new Error('Subtarefa não encontrada.');
  // mesma regra do anexo: cada um tira o que pos, e o dono tira qualquer um.
  // Apagar passo alheio e' apagar combinado de outra pessoa.
  if (!podeGerir(tarefa, acesso) && alvo.criadaPorId !== acesso.usuario.id) throw new Error('Só quem criou a subtarefa (ou o dono da tarefa) pode removê-la.');
  const agora = new Date().toISOString();
  await ref.update({ subtarefas: lista.filter((x) => x && x.id !== String(subId)), atualizadoEm: agora });
  return getOne(id, acesso);
}

async function adicionarAnexo(id, acesso, anexo) {
  const ref = COLLECTION.doc(id); const snap = await ref.get();
  if (!snap.exists) throw new Error('Tarefa não encontrada.');
  const tarefa = snap.data();
  if (!podeParticipar(tarefa, acesso)) throw new Error('Você não pode anexar nesta tarefa.');
  const item = {
    id: crypto.randomBytes(8).toString('hex'), nome: String(anexo.nome || 'print').slice(0, 160),
    path: anexo.path, tipo: anexo.tipo || 'application/octet-stream', tamanho: Number(anexo.tamanho || 0),
    enviadoEm: new Date().toISOString(), enviadoPorId: acesso.usuario.id, enviadoPorNome: nomeUsuario(acesso.usuario),
  };
  await ref.update({ anexos: [...(tarefa.anexos || []), item].slice(-20), atualizadoEm: item.enviadoEm });
  return getOne(id);
}

// O X do anexo remove pelo ID do próprio anexo, não pela posição na lista:
// entre desenhar a tela e o clique alguém pode ter anexado outra coisa, e por
// índice o clique apagaria o arquivo errado.
async function removerAnexo(id, acesso, anexoId) {
  const ref = COLLECTION.doc(id); const snap = await ref.get();
  if (!snap.exists) throw new Error('Tarefa não encontrada.');
  const tarefa = snap.data();
  if (!podeParticipar(tarefa, acesso)) throw new Error('Você não pode remover anexo desta tarefa.');
  const lista = tarefa.anexos || [];
  const alvo = lista.find((a) => a && a.id === String(anexoId));
  if (!alvo) throw new Error('Anexo não encontrado.');
  if (!podeGerir(tarefa, acesso) && alvo.enviadoPorId !== acesso.usuario.id) throw new Error('Quem participa remove só o anexo que enviou.');
  const agora = new Date().toISOString();
  await ref.update({ anexos: lista.filter((a) => a !== alvo), atualizadoEm: agora });
  return { tarefa: await getOne(id), path: alvo.path || null };
}

// Data de início e previsão de conclusão são editáveis enquanto a tarefa está
// aberta. Previsão vazia é válida (tarefa sem prazo); previsão antes do início
// não é - viraria "previsão vencida" no mesmo instante em que foi salva.
async function atualizarDatas(id, acesso, { dataInicio, dataEntrega } = {}) {
  const ref = COLLECTION.doc(id); const snap = await ref.get();
  if (!snap.exists) throw new Error('Tarefa não encontrada.');
  const tarefa = snap.data();
  if (!podeGerir(tarefa, acesso)) throw new Error('Você não pode alterar esta tarefa.');
  if (!STATUS_ABERTO.has(tarefa.status)) throw new Error('Essa tarefa já foi encerrada.');
  const dia = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
  const inicio = dataInicio === undefined ? (tarefa.dataInicio || null) : dia(dataInicio);
  const entrega = dataEntrega === undefined ? (tarefa.dataEntrega || null) : dia(dataEntrega);
  if (dataInicio !== undefined && String(dataInicio || '').trim() && !inicio) throw new Error('Data de início inválida.');
  if (dataEntrega !== undefined && String(dataEntrega || '').trim() && !entrega) throw new Error('Previsão de conclusão inválida.');
  if (inicio && entrega && entrega < inicio) throw new Error('A previsão de conclusão não pode ser anterior à data de início.');
  await ref.update({ dataInicio: inicio, dataEntrega: entrega, atualizadoEm: new Date().toISOString() });
  return getOne(id);
}

async function arquivarQuebrasAutomaticas() {
  const snap = await COLLECTION.get();
  const agora = new Date().toISOString();
  const alvos = snap.docs.filter((d) => {
    const tarefa = d.data();
    return tarefa.status !== 'ARQUIVADA' && tarefa.vinculo?.ticketTipo === 'quebra-caixa' && tarefa.origem === 'ticket';
  });
  await Promise.all(alvos.map((doc) => doc.ref.update({ status: 'ARQUIVADA', arquivadaEm: agora, arquivadaPorNome: 'Sistema', motivoArquivamento: 'Quebra de caixa não gera tarefa automaticamente.', atualizadoEm: agora })));
  return alvos.length;
}

async function atualizarStatus(id, acesso, status) {
  if (!STATUS_EDITAVEIS.has(status)) throw new Error('Use a ação de concluir para finalizar uma tarefa.');
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Tarefa não encontrada.');
  const tarefa = snap.data();
  if (!podeMoverStatus(tarefa, acesso)) throw new Error('Você acompanha esta tarefa: pode comentar e anexar, mas não alterar o status.');
  if (!STATUS_ABERTO.has(tarefa.status) && tarefa.status !== 'CONCLUIDA') throw new Error('Essa tarefa já foi encerrada.');
  const reaberta = tarefa.status === 'CONCLUIDA';
  await ref.update({ status, atualizadoEm: new Date().toISOString(), ...(reaberta ? { concluidaEm: null, concluidaPorId: null, concluidaPorNome: null, reabertaEm: new Date().toISOString(), reabertaPorNome: nomeUsuario(acesso.usuario) } : {}) });
  return getOne(id);
}

async function adicionarComentario(id, { usuario, isMaster, isAdmin, unidades, texto }) {
  const corpo = String(texto || '').trim().slice(0, 2000);
  if (!corpo) throw new Error('Escreva um comentário.');
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Tarefa não encontrada.');
  const tarefa = snap.data();
  if (!podeParticipar(tarefa, { usuario, isMaster, isAdmin, unidades })) throw new Error('Você não pode comentar nesta tarefa.');
  const agora = new Date().toISOString();
  const comentario = { id: crypto.randomBytes(8).toString('hex'), texto: corpo, porId: usuario.id, porNome: nomeUsuario(usuario), em: agora };
  await ref.update({ comentarios: [...(tarefa.comentarios || []), comentario].slice(-100), atualizadoEm: agora });
  return getOne(id);
}

async function atualizarDescricao(id, acesso, descricao) {
  if (!acesso.isMaster) throw new Error('Somente o Master pode editar a descrição.');
  const ref = COLLECTION.doc(id); const snap = await ref.get();
  if (!snap.exists) throw new Error('Tarefa não encontrada.');
  const tarefa = snap.data();
  const nova = String(descricao || '').trim().slice(0, 2000);
  const agora = new Date().toISOString();
  const comentario = { id: crypto.randomBytes(8).toString('hex'), texto: 'Descrição editada pelo Master.', porId: acesso.usuario.id, porNome: nomeUsuario(acesso.usuario), em: agora, sistema: true };
  await ref.update({ descricao: nova, comentarios: [...(tarefa.comentarios || []), comentario].slice(-100), atualizadoEm: agora });
  return getOne(id);
}

function hashLinkExterno(segredo) {
  return crypto.createHash('sha256').update(String(segredo || '')).digest('hex');
}

async function criarLinkExterno(id, acesso) {
  const ref = COLLECTION.doc(id); const snap = await ref.get();
  if (!snap.exists) throw new Error('Reunião não encontrada.');
  const tarefa = snap.data();
  if (!tarefa.ehReuniao) throw new Error('O link externo só pode ser criado para reuniões.');
  if (!podeGerir(tarefa, acesso)) throw new Error('Só o responsável, quem criou ou o Admin pode compartilhar esta reunião.');
  const segredo = crypto.randomBytes(32).toString('base64url');
  const agora = new Date().toISOString();
  await ref.update({ linkExterno: { hash: hashLinkExterno(segredo), ativo: true, criadoEm: agora, criadoPorNome: nomeUsuario(acesso.usuario) }, atualizadoEm: agora });
  return { token: `${id}.${segredo}` };
}

async function encerrarLinkExterno(id, acesso) {
  const ref = COLLECTION.doc(id); const snap = await ref.get();
  if (!snap.exists) throw new Error('Reunião não encontrada.');
  const tarefa = snap.data();
  if (!podeGerir(tarefa, acesso)) throw new Error('Você não pode encerrar este link.');
  const agora = new Date().toISOString();
  await ref.update({ 'linkExterno.ativo': false, 'linkExterno.encerradoEm': agora, 'linkExterno.encerradoPorNome': nomeUsuario(acesso.usuario), atualizadoEm: agora });
  return getOne(id);
}

async function reuniaoPorLinkExterno(token) {
  const [id, segredo, sobra] = String(token || '').split('.');
  if (!id || !segredo || sobra) return null;
  const snap = await COLLECTION.doc(id).get();
  if (!snap.exists) return null;
  const tarefa = snap.data(); const link = tarefa.linkExterno || {};
  const recebido = Buffer.from(hashLinkExterno(segredo));
  const esperado = Buffer.from(String(link.hash || ''));
  if (!tarefa.ehReuniao || !link.ativo || recebido.length !== esperado.length || !crypto.timingSafeEqual(recebido, esperado)) return null;
  return tarefa;
}

function reuniaoPublica(tarefa) {
  return { id: tarefa.id, titulo: tarefa.titulo, descricao: tarefa.descricao || '', data: tarefa.dataEntrega, hora: tarefa.horaInicio, duracaoMin: tarefa.duracaoMin, linkReuniao: tarefa.linkReuniao, comentarios: (tarefa.comentarios || []).map((c) => ({ id: c.id, texto: c.texto, porNome: c.porNome, em: c.em })) };
}

async function comentarPorLinkExterno(token, { nome, texto }) {
  const tarefa = await reuniaoPorLinkExterno(token);
  if (!tarefa) throw new Error('Este link foi encerrado ou não é válido.');
  const autor = String(nome || '').trim().slice(0, 80);
  const corpo = String(texto || '').trim().slice(0, 1000);
  if (autor.length < 2) throw new Error('Informe seu nome.');
  if (!corpo) throw new Error('Escreva um comentário.');
  const agora = new Date().toISOString();
  const comentario = { id: crypto.randomBytes(8).toString('hex'), texto: corpo, porId: null, porNome: `${autor} · convidado externo`, externo: true, em: agora };
  await COLLECTION.doc(tarefa.id).update({ comentarios: [...(tarefa.comentarios || []), comentario].slice(-100), atualizadoEm: agora });
  return comentario;
}

async function concluir(id, { usuario, isMaster, isAdmin, unidades, observacao }) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Tarefa não encontrada.');
  const tarefa = snap.data();
  if (!podeMoverStatus(tarefa, { usuario, isMaster, isAdmin, unidades })) throw new Error('Você acompanha esta tarefa: pode comentar e anexar, mas não concluir.');
  if (!STATUS_ABERTO.has(tarefa.status)) throw new Error('Essa tarefa já foi encerrada.');
  const agora = new Date().toISOString();
  await ref.update({ status: 'CONCLUIDA', concluidaEm: agora, concluidaPorId: usuario.id, concluidaPorNome: nomeUsuario(usuario), observacaoConclusao: String(observacao || '').trim().slice(0, 1000), ...(tarefa.ehReuniao ? { 'linkExterno.ativo': false, 'linkExterno.encerradoEm': agora, 'linkExterno.encerradoPorNome': nomeUsuario(usuario) } : {}), atualizadoEm: agora });
  return getOne(id);
}

// Trocar quem participa muda o combinado da tarefa - fica com o dono, igual
// ao prazo. Participante que se auto-adicionasse entraria em tarefa de outra
// unidade sem ninguém aprovar.
async function definirColaboradores(id, acesso, pessoas) {
  const ref = COLLECTION.doc(id); const snap = await ref.get();
  if (!snap.exists) throw new Error('Tarefa não encontrada.');
  const tarefa = snap.data();
  if (!podeGerir(tarefa, acesso)) throw new Error('Só o responsável, quem criou ou o Admin muda quem participa.');
  const equipe = pessoasParaColaboradores(pessoas, tarefa.responsavelId);
  await ref.update({ colaboradores: equipe, colaboradoresIds: equipe.map((p) => p.id), atualizadoEm: new Date().toISOString() });
  return getOne(id);
}

// Trocar o responsável é redistribuir o serviço, não executar - fica com quem
// distribui (Master, Admin, gerente) e com o próprio responsável, que pode
// passar adiante o que não é dele. A validação de QUEM pode receber é a mesma
// da criação, e roda na rota (index.js).
async function definirResponsavel(id, acesso, pessoa) {
  const ref = COLLECTION.doc(id); const snap = await ref.get();
  if (!snap.exists) throw new Error('Tarefa não encontrada.');
  const tarefa = snap.data();
  if (!podeGerir(tarefa, acesso)) throw new Error('Só o responsável, quem criou ou o Admin troca o responsável.');
  if (!STATUS_ABERTO.has(tarefa.status)) throw new Error('Essa tarefa já foi encerrada.');
  if (!pessoa || !pessoa.id) throw new Error('Escolha quem fica responsável.');
  // quem vira responsável sai da lista de participantes: acumular os dois
  // papéis faria a mesma pessoa aparecer duas vezes na tela
  const equipe = (tarefa.colaboradores || []).filter((p) => p.id !== pessoa.id);
  await ref.update({
    responsavelId: pessoa.id, responsavelEmail: pessoa.email || null, responsavelNome: nomeUsuario(pessoa),
    colaboradores: equipe, colaboradoresIds: equipe.map((p) => p.id),
    atualizadoEm: new Date().toISOString(),
  });
  return getOne(id);
}

// Uma tarefa iniciada pode virar um ticket ou um formulário. O documento em
// si NÃO nasce aqui: nasce na tela que já sabe validar cada tipo (Central e
// Formulários), e o que fica guardado na tarefa é só o RASTRO - o que ela
// gerou, pra quem abrir a tarefa depois achar o documento.
//
// De propósito não mexe em `vinculo`: aquele campo é a chave de idempotência
// da sincronização de ticket (vinculo.chave). Escrever nele aqui faria uma
// sincronização futura adotar - e poder cancelar - uma tarefa que não nasceu
// daquele ticket.
async function registrarGerado(id, acesso, item) {
  const ref = COLLECTION.doc(id); const snap = await ref.get();
  if (!snap.exists) throw new Error('Tarefa não encontrada.');
  const tarefa = snap.data();
  if (!podeParticipar(tarefa, acesso)) throw new Error('Você não pode alterar esta tarefa.');
  const tipo = ['solicitacao', 'estorno', 'formulario'].includes(item && item.tipo) ? item.tipo : null;
  if (!tipo || !item.id) throw new Error('Documento gerado inválido.');
  const registro = {
    tipo, id: String(item.id).slice(0, 120),
    numeroTicket: item.numeroTicket != null ? Number(item.numeroTicket) || null : null,
    rotulo: String(item.rotulo || '').slice(0, 80) || null,
    em: new Date().toISOString(), porNome: nomeUsuario(acesso.usuario),
  };
  const lista = (tarefa.gerou || []).filter((g) => !(g.tipo === registro.tipo && g.id === registro.id));
  await ref.update({
    gerou: [...lista, registro].slice(-10),
    // Uma conversão de tarefa avulsa usa o seu protocolo de nascimento. A
    // referência direta torna a operação idempotente e deixa claro que agora
    // há uma solicitação na Central para o mesmo Ticket #.
    ...(registro.tipo === 'solicitacao' ? { solicitacaoId: registro.id } : {}),
    atualizadoEm: registro.em,
  });
  return getOne(id);
}

// A unidade de uma tarefa de chat pode ter sido inferida (ou não ter sido
// informada pelo cliente). Só Master corrige esse dado, e a alteração vira um
// comentário automático para a trilha de auditoria ficar visível na tarefa.
async function atualizarUnidade(id, acesso, { unidade, unidadeNome } = {}) {
  if (!acesso?.isMaster) throw new Error('Somente Master pode corrigir a unidade da tarefa.');
  const ref = COLLECTION.doc(id); const snap = await ref.get();
  if (!snap.exists) throw new Error('Tarefa não encontrada.');
  const tarefa = snap.data(), agora = new Date().toISOString();
  const anterior = tarefa.unidadeNome || tarefa.unidade || 'Sem unidade';
  const proxima = unidadeNome || unidade || 'Sem unidade';
  if ((tarefa.unidade || null) === (unidade || null)) return tarefa;
  const comentarios = [...(tarefa.comentarios || []), {
    id: crypto.randomBytes(10).toString('hex'),
    texto: `Auditoria: unidade alterada de “${anterior}” para “${proxima}”.`,
    porId: acesso.usuario?.id || null, porNome: nomeUsuario(acesso.usuario), em: agora, sistema: true,
  }];
  await ref.update({ unidade: unidade || null, unidadeNome: unidadeNome || unidade || null, comentarios, atualizadoEm: agora });
  return { ...tarefa, unidade: unidade || null, unidadeNome: unidadeNome || unidade || null, comentarios, atualizadoEm: agora };
}

async function prepararConversaoEmSolicitacao(id, acesso, tipoDestino = 'solicitacao') {
  const ref = COLLECTION.doc(id); const snap = await ref.get();
  if (!snap.exists) throw new Error('Tarefa não encontrada.');
  const tarefa = snap.data();
  if (!podeParticipar(tarefa, acesso)) throw new Error('Você não pode converter esta tarefa.');
  // Uma tarefa que já nasceu de ticket JÁ É parte daquele protocolo. Abrir
  // outra solicitação a partir dela geraria um segundo número para o mesmo
  // assunto; a tela deve abrir o ticket original, onde status/tipo evoluem
  // mantendo o Ticket #.
  if (tarefa.vinculo?.id) throw new Error('Esta tarefa já pertence ao Ticket #' + (tarefa.numeroTicket || tarefa.vinculo.numeroTicket) + '. Abra o ticket vinculado para mudar o tipo ou o andamento.');
  // Triagem tem UMA decisão de destino. Não é permitido promover primeiro a
  // estorno e depois abrir uma solicitação comum (ou o inverso), porque isso
  // criaria dois cards independentes para o mesmo pedido e mesmo protocolo.
  const tipoExistente = tarefa.estornoId ? 'estorno' : (tarefa.solicitacaoId ? 'solicitacao' : null);
  const ticketExistente = tarefa.estornoId || tarefa.solicitacaoId || null;
  if (ticketExistente) return { tarefa, numeroTicket: tarefa.numeroTicket || null, jaTemSolicitacao: true, ticketId: ticketExistente, tipoExistente };
  if (tarefa.numeroTicket != null) return { tarefa, numeroTicket: tarefa.numeroTicket, jaTemSolicitacao: false };
  // Compatibilidade para tarefas antigas: a primeira conversão reserva o
  // número que elas não receberam antes desta regra existir.
  const numeroTicket = await ticketCounter.proximoTicket();
  await ref.update({ numeroTicket, atualizadoEm: new Date().toISOString() });
  return { tarefa: { ...tarefa, numeroTicket }, numeroTicket, jaTemSolicitacao: false };
}

// CANCELAR: qualquer um que mexe no status da tarefa pode cancelar (Asana
// deixa quem participa arquivar/cancelar). Vira status CANCELADA - some do
// quadro de todo mundo e só o Master vê na coluna Cancelados (ver listarMinhas
// e a tela). Diferente de EXCLUIR (arquivar), que apaga do fluxo de vez.
async function cancelar(id, acesso, motivo) {
  const ref = COLLECTION.doc(id); const snap = await ref.get();
  if (!snap.exists) throw new Error('Tarefa não encontrada.');
  const tarefa = snap.data();
  if (!podeMoverStatus(tarefa, acesso)) throw new Error('Você acompanha esta tarefa: não pode cancelá-la.');
  if (!STATUS_ABERTO.has(tarefa.status)) throw new Error('Só dá pra cancelar tarefa em aberto.');
  const agora = new Date().toISOString();
  await ref.update({ status: 'CANCELADA', canceladaEm: agora, canceladaPorId: acesso.usuario.id, canceladaPorNome: nomeUsuario(acesso.usuario), motivoCancelamento: String(motivo || '').trim().slice(0, 300) || null, ...(tarefa.ehReuniao ? { 'linkExterno.ativo': false, 'linkExterno.encerradoEm': agora, 'linkExterno.encerradoPorNome': nomeUsuario(acesso.usuario) } : {}), atualizadoEm: agora });
  // reunião cancelada aqui tem que sumir da agenda de quem foi convidado -
  // senão o compromisso continua de pé e alguém entra numa sala vazia. Não
  // trava o cancelamento: já está gravado, isto é limpeza.
  if (tarefa.eventoGoogleId) await reuniaoGoogle.cancelarSala(tarefa.eventoGoogleId);
  return getOne(id);
}

// ---- REUNIÃO VIRA TAREFA ----
// Reunião e tarefa moram na mesma ficha, mas a reunião não se comporta como
// trabalho: ela tem hora e sala, e o que sobra dela é o que foi combinado.
// Quando o combinado é "alguém faz isso", a reunião precisa virar tarefa sem
// perder o rastro - mesmo protocolo, mesma gente, mesmo contexto.
//
// A reunião não é apagada NEM duplicada: ela deixa de ser reunião e passa a
// ser a tarefa. Duplicar criaria dois protocolos pro mesmo assunto, e o
// histórico da reunião (comentários, anexos) ficaria no lado errado.
async function virarTarefa(id, acesso, { dataEntrega, prioridade } = {}) {
  const ref = COLLECTION.doc(id); const snap = await ref.get();
  if (!snap.exists) throw new Error('Tarefa não encontrada.');
  const tarefa = snap.data();
  if (!podeGerir(tarefa, acesso)) throw new Error('Só quem gerencia esta reunião pode transformá-la em tarefa.');
  if (!tarefa.ehReuniao) throw new Error('Isto já é uma tarefa.');
  const agora = new Date().toISOString();
  const entrega = /^\d{4}-\d{2}-\d{2}$/.test(String(dataEntrega || '')) ? dataEntrega : (tarefa.dataEntrega || null);
  const prio = prioridades.sanitizarPrioridade(prioridade || tarefa.prioridade);
  // O SLA é recontado a partir de AGORA. Herdar o SLA da reunião faria a
  // tarefa nascer atrasada pelo tempo que a reunião esperou pra acontecer.
  const patch = {
    ehReuniao: false, horaInicio: null, duracaoMin: null,
    // a sala fica gravada no histórico da ficha (virouTarefaDe), mas sai da
    // ficha viva: tarefa não tem sala, e um link de reunião velho no meio de
    // uma tarefa é convite pra alguém entrar numa sala que já acabou
    linkReuniao: null, linkOrigem: null, eventoGoogleId: null,
    'linkExterno.ativo': false, 'linkExterno.encerradoEm': agora, 'linkExterno.encerradoPorNome': nomeUsuario(acesso.usuario),
    prioridade: prio, slaPrazo: prioridades.slaPrazo(prio, agora),
    dataEntrega: entrega,
    veioDeReuniao: {
      em: agora, porId: acesso.usuario.id, porNome: nomeUsuario(acesso.usuario),
      quando: tarefa.dataEntrega || null, hora: tarefa.horaInicio || null,
    },
    atualizadoEm: agora,
  };
  await ref.update(patch);
  // o compromisso sai da agenda junto: a reunião não vai mais acontecer como
  // reunião, e quem foi convidado não precisa do horário bloqueado
  if (tarefa.eventoGoogleId) await reuniaoGoogle.cancelarSala(tarefa.eventoGoogleId);
  return getOne(id);
}

// ---- DECISÕES DA REUNIÃO VIRAM TRABALHO ----
// Reunião que não vira tarefa vira esquecimento: o que foi combinado fica no
// comentário e ninguém é dono de nada. Aqui o que foi decidido sai da reunião
// já com responsável e prazo, de um jeito ou de outro:
//
//   'uma'    - UMA tarefa com as decisões como subtarefas. É o caso de um
//              assunto só que se desdobra em passos ("virada da Bessa":
//              trocar o roteador, refazer o cabo, testar a Zebra).
//   'varias' - UMA TAREFA POR DECISÃO. É o caso de assuntos independentes,
//              que vão ter donos e prazos diferentes.
//
// As duas nascem da MESMA lista - quem está na reunião escreve o que foi
// decidido e só então escolhe a forma. Escolher antes obrigaria a redigitar.
const DECISOES_MAX = 20;

function decisoesLimpas(itens) {
  return (Array.isArray(itens) ? itens : [])
    .map((x) => String((x && x.texto) || x || '').trim().slice(0, 200))
    .filter(Boolean)
    .slice(0, DECISOES_MAX);
}

// `responsavel` chega JÁ RESOLVIDO pela rota, que é quem sabe validar acesso
// a unidade (mesma regra dos participantes). O módulo não busca usuário.
async function decisoesEmTarefas(id, acesso, { modo, titulo, itens, responsavel, dataEntrega, prioridade } = {}) {
  const ref = COLLECTION.doc(id); const snap = await ref.get();
  if (!snap.exists) throw new Error('Reunião não encontrada.');
  const reuniao = snap.data();
  if (!podeGerir(reuniao, acesso)) throw new Error('Só quem gerencia esta reunião pode registrar as decisões como tarefa.');
  const lista = decisoesLimpas(itens);
  if (!lista.length) throw new Error('Escreva pelo menos uma decisão.');
  const forma = modo === 'varias' ? 'varias' : 'uma';
  if (forma === 'uma' && lista.length > SUBTAREFA_MAX) {
    throw new Error(`Uma tarefa aceita no máximo ${SUBTAREFA_MAX} subtarefas. Com ${lista.length} decisões, use "uma tarefa por decisão".`);
  }

  // quem estava na reunião continua vendo o que saiu dela. O responsável é
  // escolhido na hora; sem escolha, fica com quem já era dono da reunião.
  const dono = (responsavel && responsavel.id)
    ? responsavel
    : { id: reuniao.responsavelId, nome: reuniao.responsavelNome, email: reuniao.responsavelEmail };
  const equipe = (reuniao.colaboradores || []).filter((p) => p && p.id !== dono.id);
  const deOnde = `Decidido na reunião "${reuniao.titulo}"`
    + (reuniao.dataEntrega ? ` de ${reuniao.dataEntrega.split('-').reverse().join('/')}` : '');

  const base = {
    dataInicio: new Date().toISOString().slice(0, 10),
    dataEntrega: /^\d{4}-\d{2}-\d{2}$/.test(String(dataEntrega || '')) ? dataEntrega : null,
    unidade: reuniao.unidade || null, unidadeNome: reuniao.unidadeNome || null,
    usuario: acesso.usuario, responsavel: dono, colaboradores: equipe,
    prioridade, origem: 'reuniao',
  };

  const criadas = [];
  if (forma === 'uma') {
    criadas.push(await criar({
      ...base,
      titulo: String(titulo || reuniao.titulo || 'Decisões da reunião').trim().slice(0, 200),
      descricao: deOnde,
      subtarefas: lista,
    }));
  } else {
    // uma por vez, em ordem: cada uma tira o seu número de protocolo, e o
    // contador de ticket não é feito pra ser chamado em paralelo
    for (const texto of lista) {
      criadas.push(await criar({ ...base, titulo: texto, descricao: deOnde }));
    }
  }

  // o rastro fica nos DOIS lados: a reunião diz o que gerou (pra quem abrir
  // depois achar), e cada tarefa diz de onde veio (na descrição)
  const agora = new Date().toISOString();
  const resumo = forma === 'uma'
    ? `Decisões viraram 1 tarefa com ${lista.length} subtarefa${lista.length > 1 ? 's' : ''}: #${criadas[0].numeroTicket}.`
    : `Decisões viraram ${criadas.length} tarefa${criadas.length > 1 ? 's' : ''}: ${criadas.map((t) => '#' + t.numeroTicket).join(', ')}.`;
  const comentario = {
    id: crypto.randomBytes(8).toString('hex'), texto: resumo,
    porId: acesso.usuario.id, porNome: nomeUsuario(acesso.usuario), em: agora,
  };
  await ref.update({
    comentarios: [...(reuniao.comentarios || []), comentario].slice(-100),
    decisoes: [
      ...((reuniao.decisoes || []).slice(-40)),
      ...criadas.map((t) => ({ tarefaId: t.id, numeroTicket: t.numeroTicket, titulo: t.titulo, em: agora })),
    ].slice(-60),
    atualizadoEm: agora,
  });
  return { reuniao: await getOne(id), criadas };
}

// PEDIR EXCLUSÃO: quem não é Master não apaga direto - deixa um pedido pro
// Master aprovar ou recusar. Excluir apaga do fluxo (arquiva), então passa
// pelo dono do painel.
async function pedirDelecao(id, acesso, motivo) {
  const ref = COLLECTION.doc(id); const snap = await ref.get();
  if (!snap.exists) throw new Error('Tarefa não encontrada.');
  const tarefa = snap.data();
  if (!podeMoverStatus(tarefa, acesso)) throw new Error('Você acompanha esta tarefa: não pode pedir exclusão.');
  const agora = new Date().toISOString();
  await ref.update({ delecaoSolicitada: { porId: acesso.usuario.id, porNome: nomeUsuario(acesso.usuario), em: agora, motivo: String(motivo || '').trim().slice(0, 300) || null }, atualizadoEm: agora });
  return getOne(id);
}

// MASTER decide o pedido de exclusão: aprovar arquiva (some do fluxo);
// recusar limpa o pedido e a tarefa segue viva.
async function resolverDelecao(id, acesso, aprovar) {
  if (!acesso.isMaster) throw new Error('Somente o Master decide a exclusão.');
  const ref = COLLECTION.doc(id); const snap = await ref.get();
  if (!snap.exists) throw new Error('Tarefa não encontrada.');
  const tarefa = snap.data();
  if (!tarefa.delecaoSolicitada) throw new Error('Não há pedido de exclusão nesta tarefa.');
  const agora = new Date().toISOString();
  if (aprovar) {
    await ref.update({ status: 'ARQUIVADA', arquivadaEm: agora, arquivadaPorId: acesso.usuario.id, arquivadaPorNome: nomeUsuario(acesso.usuario), motivoArquivamento: 'Exclusão aprovada pelo Master (pedida por ' + (tarefa.delecaoSolicitada.porNome || 'usuário') + ').', delecaoSolicitada: null, atualizadoEm: agora });
  } else {
    await ref.update({ delecaoSolicitada: null, delecaoRecusadaEm: agora, delecaoRecusadaPorNome: nomeUsuario(acesso.usuario), atualizadoEm: agora });
  }
  return getOne(id);
}

async function arquivar(id, acesso) {
  const ref = COLLECTION.doc(id); const snap = await ref.get();
  if (!snap.exists) throw new Error('Tarefa não encontrada.');
  const tarefa = snap.data();
  if (!podeArquivar(tarefa, acesso)) throw new Error('Somente o Master pode remover tarefas; Admin remove apenas concluídas da sua unidade.');
  const agora = new Date().toISOString();
  await ref.update({ status: 'ARQUIVADA', arquivadaEm: agora, arquivadaPorId: acesso.usuario.id, arquivadaPorNome: nomeUsuario(acesso.usuario), atualizadoEm: agora });
  return getOne(id);
}

async function sincronizarRetroativo({ solicitacoes = [], estornos = [], usuarios = [], forcar = false } = {}) {
  // v3: passa a gravar a data REAL do ticket em criadaEm/dataInicio (antes era
  // a data da sincronização). Versão nova = o Master consegue rodar de novo
  // pra corrigir o que já está gravado, sem precisar de forcar.
  // v4 (12/09/2026): ticket de Login bloqueado aprovado passa a ser CONCLUIDA
  // (ver ehTicketDeBloqueio) - versao nova refaz o historico uma vez no boot
  // v5 (13/09/2026): ticket sem responsavel passa a ter UMA tarefa (Master da
  // fila) em vez de uma por Master - a versao nova refaz o historico uma vez
  // no boot e some com as copias repetidas (ver masterDaFila)
  const versao = 'tickets-v5';
  const ref = CONTROLE.doc(`retroativo-${versao}`);
  const anterior = await ref.get();
  if (anterior.exists && !forcar) return { executada: false, motivo: 'já sincronizado nesta versão', ...anterior.data() };

  const quebrasArquivadas = await arquivarQuebrasAutomaticas();
  let alteradas = 0;
  for (const ticket of solicitacoes) alteradas += (await sincronizarTicket(ticket, usuarios, 'solicitacao')).length;
  for (const ticket of estornos) alteradas += (await sincronizarTicket(ticket, usuarios, 'estorno')).length;
  const resultado = {
    executada: true, versao, alteradas, solicitacoes: solicitacoes.length, estornos: estornos.length,
    concluidaEm: new Date().toISOString(), quebrasArquivadas,
  };
  await ref.set(resultado);
  return resultado;
}

module.exports = {
  camposDaReuniao, virarTarefa, decisoesEmTarefas, decisoesLimpas, DECISOES_MAX, adicionarSubtarefa, alternarSubtarefa, atualizarSubtarefa, removerSubtarefa, gentePermitida, progressoSubtarefas, SUBTAREFA_MAX, sincronizarTicket, sincronizarRetroativo, listarMinhas, getOne, criar, atualizarStatus, adicionarComentario, atualizarDescricao, criarLinkExterno, encerrarLinkExterno, reuniaoPorLinkExterno, reuniaoPublica, comentarPorLinkExterno, adicionarAnexo, removerAnexo, atualizarDatas, cancelar, pedirDelecao, resolverDelecao, atualizarUnidade, definirColaboradores, definirResponsavel, registrarGerado, prepararConversaoEmSolicitacao, concluir, arquivar, podeReceberTicket, podeGerirTarefa: podeGerir, podeParticiparTarefa: podeParticipar, podeMoverStatusTarefa: podeMoverStatus };
