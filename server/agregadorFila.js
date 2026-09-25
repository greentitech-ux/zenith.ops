// agregadorFila.js
//
// PAUSAR ITEM / FECHAR LOJA no iFood e no 99food, pedido de dentro do
// NoPulso e executado pelo COWORK AGREGADOR (o robô do Master que opera os
// painéis dos agregadores).
//
// Pedido do Master (14/09/2026): "agregador é um Cowork que criei, precisamos
// fazer essa integração com o NoPulso". O caminho antes parava numa pessoa:
// o Beniboy avisava o coordenador e alguém abria o painel na mão.
//
// O desenho é o MESMO que já roda com os outros Coworks (ver conciliacao.js e
// /api/bot/* em index.js) e com o agente das lojas (ver enfileirarComando em
// lojaStatus.js): o NoPulso não executa nada fora dele: ele ENFILEIRA o
// pedido, o Cowork PUXA a fila com o token dele, faz o bloqueio no painel e
// CONFIRMA de volta. Quem decide o que entra na fila é o servidor; o Cowork
// faz UMA coisa, e nunca decide sozinho o que bloquear.
//
//   Beniboy (chat) ──criar()──▶ [fila] ──GET /api/bot/agregador/fila──▶ Cowork
//                                  ▲                                     │
//                                  └──POST /api/bot/agregador/retorno ◀───┘
//
// Por que fila e não chamada direta na API do iFood: pausar item e fechar
// loja são rotas OPERACIONAIS do agregador. O ifoodClient.js deste repo é, de
// propósito, só leitura financeira - o aviso no topo dele ("NUNCA trocar isso
// pela Order/Events API") vale igual aqui: quem mexe no que está no ar é o
// Cowork, pelo painel, como uma pessoa faria.
//
// O que NUNCA pode acontecer: o pedido sumir. Se o Cowork não puxar, não
// confirmar ou devolver erro, o pedido ATRASA (ver varrerAtrasados()) e aí o
// coordenador agregador é chamado - o caminho humano continua inteiro
// embaixo, como rede de segurança (ver push.notifyAgregador).
//
// Custo no Firestore (CLAUDE.md §3): um pedido é um documento. A fila que o
// Cowork puxa é uma consulta filtrada em `aberto` (índice de 1 campo, poucos
// documentos), nunca a coleção inteira, e a lista para telas passa por cache.
const db = require('./firestore');
const { createCache } = require('./liveCache');

const PEDIDOS = db.collection('agregadorPedidos');

// Vocabulário: as ações e os canais são os MESMOS da ferramenta do Beniboy
// (chamar_coordenador_agregador, suporteBot.js) - um nome novo aqui viraria
// um pedido que o Cowork não sabe ler.
const ACOES = ['pausar-item', 'fechar-loja'];
const CANAIS = ['ifood', '99food', 'ambos'];
// e o status é o da fila que já existe no app (lojaStatus.js: pendente ->
// entregue -> executado/erro). "cancelado" é o time desistindo antes.
const STATUS = ['pendente', 'entregue', 'executado', 'erro', 'cancelado'];

// quanto tempo o Cowork tem pra concluir antes do pedido virar atraso (e o
// coordenador humano ser chamado). Loja parada é prejuízo por minuto: 10min
// é o que o Master aceita esperar um robô antes de acordar gente.
const MINUTOS_ATE_ATRASO = 10;
// teto do que a fila entrega de uma vez - o Cowork trabalha em lote, e um
// lote gigante só atrasaria o primeiro pedido da lista
const LIMITE_FILA = 20;

const texto = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

// chave do pedido: é o que impede a MESMA coca ser pausada 3 vezes porque
// três pessoas avisaram. Item entra normalizado (caixa e espaço não fazem
// dois pedidos diferentes).
function chaveDo({ acao, canal, unidade, item }) {
  return [acao, canal, unidade, texto(item, 120).toLowerCase()].join('|');
}

function validar({ acao, canal, unidade, item }) {
  if (!ACOES.includes(acao)) throw new Error(`Ação inválida. Use ${ACOES.join(' ou ')}.`);
  if (!CANAIS.includes(canal)) throw new Error(`Canal inválido. Use ${CANAIS.join(', ')}.`);
  if (!texto(unidade, 80)) throw new Error('Diga de qual unidade é o pedido.');
  // pausar sem dizer o quê é um pedido que o Cowork não consegue executar -
  // ele voltaria a perguntar numa conversa que já seguiu adiante
  if (acao === 'pausar-item' && !texto(item, 120)) throw new Error('Pausar item exige qual item.');
}

// Cria o pedido. Devolve { pedido, repetido } - `repetido` quando já havia um
// pedido ABERTO igual (mesma ação, canal, unidade e item): nesse caso nada é
// gravado e o pedido que já está na fila volta, pro chamador dizer à pessoa
// que aquilo já está a caminho em vez de empilhar duplicata.
async function criar({ acao, canal, unidade, unidadeNome, item, motivo, origem, chatId, pedidoPorNome, pedidoPorEmail } = {}) {
  validar({ acao, canal, unidade, item });
  const chave = chaveDo({ acao, canal, unidade, item });
  const jaAberto = await PEDIDOS.where('chave', '==', chave).where('aberto', '==', true).limit(1).get();
  if (!jaAberto.empty) return { pedido: jaAberto.docs[0].data(), repetido: true };

  const ref = PEDIDOS.doc();
  const pedido = {
    id: ref.id,
    acao,
    canal,
    unidade: texto(unidade, 80),
    unidadeNome: texto(unidadeNome, 120) || texto(unidade, 80),
    item: texto(item, 120) || null,
    motivo: texto(motivo, 300) || null,
    origem: texto(origem, 40) || 'beniboy',
    chatId: chatId || null,
    pedidoPorNome: texto(pedidoPorNome, 80) || null,
    pedidoPorEmail: texto(pedidoPorEmail, 120) || null,
    chave,
    status: 'pendente',
    // `aberto` só existe pra consulta ficar barata: é true enquanto o pedido
    // está na fila e vira null (não false) quando fecha, pra sair do índice
    aberto: true,
    criadoEm: new Date().toISOString(),
    entregueEm: null,
    concluidoEm: null,
    resultado: null,
    erro: null,
    avisadoCoordenadorEm: null,
    tentativas: 0,
    // confirmação para quem abriu o chat. É outra entrega, independente do
    // Cowork ter executado o painel; se falhar, fica rastreável e reenviável.
    avisoChatPendente: false,
    avisoChatTentativas: 0,
    avisoChatEntregueEm: null,
    avisoChatErro: null,
  };
  await ref.set(pedido);
  listaCache.invalidar();
  return { pedido, repetido: false };
}

// O Cowork puxando a fila. Marca 'entregue' (com transação por documento, que
// é o que impede duas sessões do Cowork pegarem o mesmo pedido e pausarem o
// item duas vezes) e devolve só o que ele precisa pra agir.
async function puxar({ limite } = {}) {
  const max = Math.min(Number(limite) || LIMITE_FILA, LIMITE_FILA);
  const snap = await PEDIDOS.where('aberto', '==', true).where('status', '==', 'pendente').limit(max).get();
  const saindo = [];
  for (const d of snap.docs) {
    const pego = await db.runTransaction(async (tx) => {
      const atual = await tx.get(PEDIDOS.doc(d.id));
      if (!atual.exists) return null;
      const p = atual.data();
      if (p.status !== 'pendente') return null; // outra sessão do Cowork chegou antes
      const patch = { status: 'entregue', entregueEm: new Date().toISOString(), tentativas: (p.tentativas || 0) + 1 };
      tx.update(PEDIDOS.doc(d.id), patch);
      return { ...p, ...patch };
    });
    if (pego) saindo.push(pego);
  }
  if (saindo.length) listaCache.invalidar();
  return saindo.map((p) => ({
    id: p.id,
    acao: p.acao,
    canal: p.canal,
    unidade: p.unidade,
    unidadeNome: p.unidadeNome,
    item: p.item,
    motivo: p.motivo,
    criadoEm: p.criadoEm,
  }));
}

// O Cowork confirmando. ok=false grava o erro e DEVOLVE o pedido pra fila só
// se ainda couber outra tentativa - senão fecha como 'erro' e quem cobra é a
// varredura de atraso (o coordenador é chamado).
const MAX_TENTATIVAS = 3;
async function concluir(id, { ok, resultado, erro } = {}) {
  const ref = PEDIDOS.doc(String(id || ''));
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Pedido não encontrado.');
  const p = snap.data();
  if (!p.aberto) return { pedido: p, repetido: true }; // confirmação duplicada do Cowork
  const agora = new Date().toISOString();
  let patch;
  if (ok) {
    patch = {
      status: 'executado', aberto: null, concluidoEm: agora, resultado: texto(resultado, 300) || null, erro: null,
      ...(p.chatId ? { avisoChatPendente: true, avisoChatTentativas: 0, avisoChatEntregueEm: null, avisoChatErro: null } : {}),
    };
  } else if ((p.tentativas || 0) < MAX_TENTATIVAS) {
    // erro que ainda pode dar certo (painel fora do ar, sessão caída): volta
    // pra fila em vez de morrer - o Cowork pega de novo no próximo ciclo
    patch = { status: 'pendente', entregueEm: null, erro: texto(erro, 300) || 'falha sem detalhe' };
  } else {
    patch = {
      status: 'erro', aberto: null, concluidoEm: agora, erro: texto(erro, 300) || 'falha sem detalhe',
      ...(p.chatId ? { avisoChatPendente: true, avisoChatTentativas: 0, avisoChatEntregueEm: null, avisoChatErro: null } : {}),
    };
  }
  await ref.update(patch);
  listaCache.invalidar();
  return { pedido: { ...p, ...patch }, repetido: false };
}

async function cancelar(id, { porEmail, motivo } = {}) {
  const ref = PEDIDOS.doc(String(id || ''));
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Pedido não encontrado.');
  const p = snap.data();
  if (!p.aberto) throw new Error('Esse pedido já foi fechado.');
  const patch = {
    status: 'cancelado', aberto: null, concluidoEm: new Date().toISOString(),
    resultado: texto(motivo, 300) || null, canceladoPorEmail: texto(porEmail, 120) || null,
  };
  await ref.update(patch);
  listaCache.invalidar();
  return { ...p, ...patch };
}

// Pedidos abertos há mais de MINUTOS_ATE_ATRASO que ainda não acordaram o
// coordenador. É a rede de segurança: o Cowork pode estar fora do ar, sem
// sessão ou simplesmente não ter puxado - a loja não pode ficar esperando um
// robô calado. Só devolve quem ainda NÃO foi avisado (avisadoCoordenadorEm
// nulo), então o coordenador é chamado uma vez por pedido, não a cada tick.
// Devolve tambem quantos pedidos estao ABERTOS: e com isso que a varredura
// decide se continua no ritmo rapido ou volta a dormir. Consulta que nao acha
// nada custa 1 leitura do mesmo jeito (CLAUDE.md §3), entao o ritmo lento
// importa - ver o agendamento em index.js.
async function varrerAtrasados({ minutos } = {}) {
  const corte = new Date(Date.now() - (Number(minutos) || MINUTOS_ATE_ATRASO) * 60 * 1000).toISOString();
  const snap = await PEDIDOS.where('aberto', '==', true).limit(50).get();
  const abertos = snap.docs.map((d) => d.data());
  return {
    abertos: abertos.length,
    atrasados: abertos.filter((p) => !p.avisadoCoordenadorEm && p.criadoEm < corte),
  };
}

async function marcarCoordenadorAvisado(id) {
  await PEDIDOS.doc(String(id || '')).update({ avisadoCoordenadorEm: new Date().toISOString() });
  listaCache.invalidar();
}

async function listarAvisosChatPendentes(limite = 20) {
  const snap = await PEDIDOS.where('avisoChatPendente', '==', true).limit(Math.min(Number(limite) || 20, 50)).get();
  return snap.docs.map((d) => d.data());
}

async function marcarAvisoChatEntregue(id) {
  await PEDIDOS.doc(String(id || '')).update({
    avisoChatPendente: false,
    avisoChatEntregueEm: new Date().toISOString(),
    avisoChatErro: null,
  });
  listaCache.invalidar();
}

// Depois de três tentativas o pedido não some: ele deixa de ser reenviado e
// fica marcado para o coordenador agir sem gerar ruído a cada ciclo.
async function registrarFalhaAvisoChat(id, erro) {
  const ref = PEDIDOS.doc(String(id || ''));
  const snap = await ref.get();
  if (!snap.exists) return null;
  const atual = snap.data();
  const tentativas = Number(atual.avisoChatTentativas || 0) + 1;
  const esgotado = tentativas >= 3;
  const patch = {
    avisoChatTentativas: tentativas,
    avisoChatErro: texto(erro, 300) || 'falha sem detalhe',
    ...(esgotado ? { avisoChatPendente: false, avisoChatFalhouDefinitivoEm: new Date().toISOString() } : {}),
  };
  await ref.update(patch);
  listaCache.invalidar();
  return { ...atual, ...patch, avisoChatEsgotado: esgotado };
}

async function getOne(id) {
  const snap = await PEDIDOS.doc(String(id || '')).get();
  return snap.exists ? snap.data() : null;
}

// lista pra tela: os mais recentes primeiro. Cacheada porque a tela recarrega
// sozinha e o Firestore cobra por documento devolvido (CLAUDE.md §3).
async function listarUncached() {
  const snap = await PEDIDOS.orderBy('criadoEm', 'desc').limit(200).get();
  return snap.docs.map((d) => d.data());
}
const listaCache = createCache(listarUncached, 30 * 1000);
const listar = (...a) => listaCache(...a);

// texto curto do pedido, usado no push, no alerta e na resposta ao visitante -
// um lugar só pra não existirem três jeitos de escrever a mesma coisa
function descrever(p) {
  if (!p) return '';
  const oQue = p.acao === 'fechar-loja' ? 'Fechar loja' : `Pausar item: ${p.item || ''}`.trim();
  const onde = p.canal === 'ambos' ? 'iFood e 99food' : p.canal;
  return `${oQue} · ${onde} · ${p.unidadeNome || p.unidade}`;
}

module.exports = {
  ACOES, CANAIS, STATUS, MINUTOS_ATE_ATRASO, LIMITE_FILA, MAX_TENTATIVAS,
  criar, puxar, concluir, cancelar, varrerAtrasados, marcarCoordenadorAvisado,
  listarAvisosChatPendentes, marcarAvisoChatEntregue, registrarFalhaAvisoChat,
  getOne, listar, descrever, chaveDo,
};
