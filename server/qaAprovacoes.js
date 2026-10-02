// qaAprovacoes.js
// Fila de aprovação das ações "sensíveis" tentadas por um acesso QA Master
// (ver users.js/auth.js: req.isQaMaster). QA Master tem 100% do acesso de
// um Master de verdade - as rotas continuam sendo as mesmas de sempre, só
// que index.js (ver interceptarQaMaster) desvia um conjunto específico de
// rotas (exclusões + configuração global: Usuários, Grupos, Unidades,
// estrutura do Cofre) pra cá em vez de executar na hora. A ação fica
// PARADA aqui até um Master de verdade (não QA Master) aprovar ou
// rejeitar - só assim o executor de verdade roda (ver EXECUTORES_QA em
// index.js). Isso é proteção real: como o próprio QA Master não pode
// decidir sobre a própria solicitação (ver rota de aprovar/rejeitar,
// exige requireMaster e barra quem é QA Master), ele não consegue
// contornar sozinho.
const db = require('./firestore');
const { createCache } = require('./liveCache');
const users = require('./users');
const tarefas = require('./tarefas');

const COLLECTION = db.collection('qaAprovacoes');

function hojeBrasil() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

async function masterDaAprovacao() {
  const configurado = String(process.env.NOPULSO_AGENT_MASTER || '').trim();
  if (configurado) {
    const achado = await users.findByIdentifier(configurado);
    if (achado && achado.active !== false && achado.role === 'master') return achado;
  }
  return (await users.list()).find((u) => u && u.active !== false && u.role === 'master') || null;
}

function descricaoDaTarefa(registro) {
  const detalhes = (registro.detalhes || []).map((d) => `- ${d.rotulo}: ${d.valor}`).join('\n');
  return [
    `Autorização #${registro.id}. Origem: ${registro.origem || 'qa'}.`,
    `Solicitado por: ${registro.criadoPorEmail || 'não informado'}.`,
    registro.expiraEm ? `Vence em: ${registro.expiraEm}.` : '',
    detalhes ? `Prévia da ação:\n${detalhes}` : '',
    'Aprove ou recuse dentro desta tarefa. A confirmação forte (digital ou senha) continua obrigatória.',
  ].filter(Boolean).join('\n\n');
}

function unidadeDaAutorizacao(registro) {
  const detalhe = (registro.detalhes || []).find((d) => /unidade|loja/i.test(String(d.rotulo || '')));
  return detalhe && String(detalhe.valor || '').trim() ? String(detalhe.valor).trim() : null;
}

// O push é só um atalho. A fonte persistente de toda aprovação é a tarefa de
// Hoje do Master, criada junto com o pedido e recuperada para pendências antigas.
async function garantirTarefa(registro) {
  if (!registro || registro.status !== 'pendente') return registro;
  if (registro.tarefaId) return registro;
  const master = await masterDaAprovacao();
  if (!master) return registro;
  const tarefa = await tarefas.criar({
    titulo: `Aprovar: ${registro.resumo}`.slice(0, 200),
    descricao: descricaoDaTarefa(registro), dataInicio: hojeBrasil(), dataEntrega: hojeBrasil(),
    unidade: unidadeDaAutorizacao(registro), unidadeNome: unidadeDaAutorizacao(registro), usuario: master, responsavel: master,
    prioridade: 'alta', origem: 'autorizacao-master',
    autorizacao: { id: registro.id, resumo: registro.resumo, origem: registro.origem },
  });
  await COLLECTION.doc(registro.id).update({ tarefaId: tarefa.id, tarefaNumero: tarefa.numeroTicket, tarefaCriadaEm: new Date().toISOString() });
  cache.invalidar();
  return { ...registro, tarefaId: tarefa.id, tarefaNumero: tarefa.numeroTicket };
}

async function garantirTarefasPendentes() {
  const pendentes = await buscarPendentesNoBanco();
  const resultado = [];
  for (const pendente of pendentes) resultado.push(await garantirTarefa(pendente));
  return resultado;
}

async function registrarEntregaPush(id, entrega) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const resumo = {
    configurado: !!entrega?.configurado,
    destinatarios: Array.isArray(entrega?.destinatarios) ? entrega.destinatarios.slice(0, 20) : [],
    entregues: Number(entrega?.entregues || 0), falhas: Number(entrega?.falhas || 0),
    em: new Date().toISOString(),
  };
  await ref.update({ pushEntrega: resumo });
  cache.invalidar();
  return { ...snap.data(), pushEntrega: resumo };
}

async function listUncached() {
  const snap = await COLLECTION.orderBy('criadoEm', 'desc').limit(300).get();
  return snap.docs.map((d) => d.data());
}
const cache = createCache(listUncached, 5 * 1000);
const listarRecentes = cache.cached;

// Pendentes não podem desaparecer simplesmente porque surgiram mais de 300
// decisões recentes. A lista histórica continua curta e barata, mas a fila
// operacional é consultada diretamente e mesclada pelo id.
async function buscarPendentesNoBanco() {
  // A fila de aprovação é pequena por natureza e precisa ser completa. Não
  // usamos cursor sem ordenação explícita: em alguns SDKs isso pode pular ou
  // repetir documentos quando a coleção muda entre páginas.
  const snap = await COLLECTION.where('status', '==', 'pendente').get();
  return snap.docs.map((d) => d.data());
}

async function listar() {
  const [recentes, pendentes] = await Promise.all([listarRecentes(), buscarPendentesNoBanco()]);
  const porId = new Map(recentes.map((a) => [a.id, a]));
  pendentes.forEach((a) => porId.set(a.id, a));
  return [...porId.values()].sort((a, b) => String(b.criadoEm || '').localeCompare(String(a.criadoEm || '')));
}

async function listarPendentes() {
  return buscarPendentesNoBanco();
}

// Expiração é uma decisão de servidor, não um efeito visual da tela. Assim
// nenhuma aprovação vencida continua alertando ou volta a aparecer depois.
async function expirarPendentes() {
  const agora = Date.now();
  const pendentes = await buscarPendentesNoBanco();
  const vencidas = pendentes.filter((a) => a.expiraEm && Date.parse(a.expiraEm) <= agora);
  for (const a of vencidas) {
    await marcarDecidido(a.id, { status: 'expirado', decididoPorEmail: null });
  }
  return vencidas.length;
}

async function obter(id) {
  const snap = await COLLECTION.doc(id).get();
  return snap.exists ? snap.data() : null;
}

// registra a ação parada - "payload" é o que o executor vai precisar pra
// rodar de verdade quando aprovado (ver EXECUTORES_QA em index.js), nunca
// exposto fora de rotas de Master (pode conter dado sensível, ex: nova
// senha de reset)
//
// `origem` (qa | cowork | beniboy) e `detalhes` (linhas rótulo/valor) são o
// que a tela de autorização mostra: o Master aprova vendo EXATAMENTE o que vai
// rodar, montado aqui a partir do payload - nunca um texto livre do modelo.
// `expiraEm`: pedido de agente vence (reiniciar uma máquina aprovado dois
// dias depois já não é o que se pediu).
async function criar({
  tipo, resumo, payload, criadoPorId, criadoPorEmail, origem = 'qa', detalhes = [], expiraEm = null,
}) {
  const ref = COLLECTION.doc();
  const registro = {
    id: ref.id,
    tipo,
    resumo: String(resumo || '').slice(0, 300),
    origem: ['qa', 'cowork', 'beniboy'].includes(origem) ? origem : 'qa',
    detalhes: (Array.isArray(detalhes) ? detalhes : []).slice(0, 20)
      .map((d) => ({ rotulo: String(d.rotulo || '').slice(0, 60), valor: String(d.valor == null ? '' : d.valor).slice(0, 600) })),
    expiraEm: expiraEm || null,
    payload: payload || {},
    status: 'pendente',
    criadoPorId: criadoPorId || null,
    criadoPorEmail: criadoPorEmail || null,
    criadoEm: new Date().toISOString(),
    decididoPorEmail: null,
    decididoEm: null,
    motivoRejeicao: null,
    erroExecucao: null,
    erroDefinitivo: false,
    // Rastro enxuto e legível para o Master. O payload continua protegido;
    // o histórico registra somente o ciclo da decisão, nunca senha ou segredo.
    historico: [{ evento: 'PEDIDO_CRIADO', em: new Date().toISOString(), porEmail: criadoPorEmail || null }],
  };
  await ref.set(registro);
  cache.invalidar();
  return garantirTarefa(registro);
}

// 'aprovado' (executor rodou com sucesso) | 'rejeitado' (Master recusou,
// nunca executa) | 'expirado' (passou do prazo, nunca executa) | 'erro' (Master aprovou mas o executor falhou - fica
// visível pro Master decidir se tenta aprovar de novo ou rejeita)
// `resultado`: o que a ação devolveu, SEM segredo - é o que o Claude lê de
// volta (consultar_autorizacao) pra seguir o atendimento
// `erroDefinitivo`: a ação falhou por uma regra que repetir não muda (cancelar
// uma tarefa já concluída, por exemplo). Sem isso, o pedido ficava preso na
// fila oferecendo "autorizar de novo" pra sempre - caso real de 24/09, em que
// o Master autorizou, falhou, e o cartão nunca tinha como sair da tela.
async function marcarDecidido(id, {
  status, decididoPorEmail, motivoRejeicao, erroExecucao, erroDefinitivo, resultado,
}) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Solicitação de aprovação não encontrada.');
  const patch = {
    status,
    ...(resultado !== undefined ? { resultado: String(resultado == null ? '' : resultado).slice(0, 1000) } : {}),
    decididoPorEmail: decididoPorEmail || null,
    decididoEm: new Date().toISOString(),
    motivoRejeicao: motivoRejeicao || null,
    erroExecucao: erroExecucao || null,
    erroDefinitivo: !!erroDefinitivo,
    historico: [...(snap.data().historico || [{ evento: 'PEDIDO_CRIADO', em: snap.data().criadoEm || null, porEmail: snap.data().criadoPorEmail || null }]), {
      evento: status === 'aprovado' ? 'AUTORIZADO_E_EXECUTADO' : status === 'rejeitado' ? 'RECUSADO' : status === 'erro' ? 'ERRO_NA_EXECUCAO' : 'VENCEU',
      em: new Date().toISOString(), porEmail: decididoPorEmail || null,
      ...(motivoRejeicao ? { motivo: String(motivoRejeicao).slice(0, 300) } : {}),
      ...(erroExecucao ? { erro: String(erroExecucao).slice(0, 300) } : {}),
    }].slice(-12),
  };
  await ref.update(patch);
  // A decisão fecha a pendência que nasceu no Meu Dia. Se ela já foi fechada
  // por uma tentativa anterior, a rotina de tarefas é idempotente e preserva
  // o histórico.
  if ((status === 'aprovado' || status === 'rejeitado') && snap.data().tarefaId) {
    const aprovador = decididoPorEmail ? await users.findByIdentifier(decididoPorEmail) : null;
    const tarefa = await tarefas.getOne(snap.data().tarefaId);
    if (aprovador && tarefa) {
      const acesso = { usuario: aprovador, isMaster: aprovador.role === 'master', isAdmin: !!aprovador.isAdmin, unidades: aprovador.permissions?.unidades || [] };
      if (status === 'aprovado') await tarefas.concluir(tarefa.id, { ...acesso, observacao: `Autorização ${id} aprovada.` }).catch(() => {});
      else await tarefas.cancelar(tarefa.id, acesso, `Autorização recusada: ${motivoRejeicao || 'sem motivo informado.'}`).catch(() => {});
    }
  }
  cache.invalidar();
  return { ...snap.data(), ...patch };
}

module.exports = {
  listar, listarPendentes, expirarPendentes, obter, criar, marcarDecidido, garantirTarefa, garantirTarefasPendentes, registrarEntregaPush,
};
