// bonificacao.js
// Apuração mensal de bonificação (gerente + colaboradores) por unidade.
// A mecânica de cálculo (pool sobre o faturamento, dividido em metas/
// outras, repartido entre gerente e equipe, cada fatia multiplicada pela
// taxa de cumprimento de métricas com peso) veio de um simulador que o
// Master já usava fora do sistema - só a mecânica foi trazida pra cá, o
// layout nasceu do zero em bonificacao.html. Os percentuais NÃO são
// cravados aqui: vêm do perfil resolvido pra unidade (bonificacaoPerfis.js).
//
// Faturamento e funcionários NÃO ficam duplicados neste doc - são lidos ao
// vivo de fechamentosLive/rh a cada consulta, igual o resto do app faz com
// dado que já mora em outra coleção. Só o que é avaliação humana
// (completions) e o status (rascunho/fechado) ficam persistidos aqui.
'use strict';

const db = require('./firestore');
const { createCache } = require('./liveCache');
const bonificacaoPerfis = require('./bonificacaoPerfis');
const fechamentosLive = require('./fechamentosLive');
const rh = require('./rh');

const COLLECTION = db.collection('bonificacaoApuracoes');

function docId(unidade, mes) {
  return `${unidade}__${mes}`.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function mesValido(mes) {
  return /^\d{4}-\d{2}$/.test(String(mes || ''));
}

function limitesDoMes(mes) {
  const [ano, m] = mes.split('-').map(Number);
  const inicio = `${mes}-01`;
  const ultimoDia = new Date(ano, m, 0).getDate(); // dia 0 do mes seguinte = ultimo dia deste
  const fim = `${mes}-${String(ultimoDia).padStart(2, '0')}`;
  return { inicio, fim, dias: ultimoDia };
}

// quantos dias de [aInicio,aFim] caem dentro de [bInicio,bFim] - tudo em
// string ISO 'AAAA-MM-DD', comparavel lexicograficamente. Usado pra somar
// atestado (que pode comecar antes do mes ou terminar depois) só na fatia
// que realmente cai no período apurado.
function diasDeSobreposicao(aInicio, aFim, bInicio, bFim) {
  if (!aInicio) return 0;
  const inicio = aInicio > bInicio ? aInicio : bInicio;
  const fimReal = aFim || bFim; // atestado ainda aberto: conta ate o fim do mes
  const fim = fimReal < bFim ? fimReal : bFim;
  if (inicio > fim) return 0;
  const dIni = new Date(`${inicio}T00:00:00`);
  const dFim = new Date(`${fim}T00:00:00`);
  return Math.round((dFim - dIni) / 86400000) + 1;
}

// dias de atestado de UM funcionario que caem dentro do mes apurado -
// soma os fechados (atestados[]) e o em aberto (atestadoAtual), se houver
function diasAtestadoNoMes(funcionario, inicioMes, fimMes) {
  let dias = 0;
  (funcionario.atestados || []).forEach((a) => {
    dias += diasDeSobreposicao(a.inicio, a.retorno, inicioMes, fimMes);
  });
  if (funcionario.emAtestado && funcionario.atestadoAtual) {
    dias += diasDeSobreposicao(funcionario.atestadoAtual.inicio, null, inicioMes, fimMes);
  }
  return dias;
}

// soma faturamento das linhas do fechamento cuja data cai no mes - .data e
// 'AAAA-MM-DD', comparacao por string funciona igual ao resto do app
async function faturamentoDoMes(unidade, mes) {
  const linhas = await fechamentosLive.listByUnidades([unidade]);
  return linhas
    .filter((l) => String(l.data || '').startsWith(mes))
    .reduce((s, l) => s + (Number(l.faturamento) || 0), 0);
}

// exclui quem já é remunerado pela fatia de gerente (ver
// rh.atualizarExcluirBonificacao) - sem isso, gerente/assistente aparecia
// TAMBÉM na divisão de colaboradores, recebendo a bonificação 2x
async function funcionariosAtivosDaUnidade(unidade) {
  const todos = await rh.listByUnidades([unidade]);
  return todos.filter((f) => f.status === 'ativo' && !f.excluirBonificacao);
}

// lista de gestão (Master/Admin) - TODOS os ativos da unidade, incluindo os
// já marcados como excluídos, pra dar pra marcar/desmarcar quem é gerente/
// assistente. Ao contrário de funcionariosAtivosDaUnidade acima, não filtra
// ninguém - é essa lista que alimenta o toggle, não a apuração em si.
async function equipeDaUnidade(unidade) {
  const todos = await rh.listByUnidades([unidade]);
  return todos
    .filter((f) => f.status === 'ativo')
    .map((f) => ({ id: f.id, nome: f.nome, cargoFuncao: f.cargoFuncao || null, excluirBonificacao: !!f.excluirBonificacao }));
}

function taxaCumprimento(metricas, completions) {
  if (!metricas || !metricas.length) return 0;
  const mapa = new Map((completions || []).map((c) => [c.campo, c.percentual]));
  return metricas.reduce((s, m) => {
    const pct = Number(mapa.get(m.campo));
    const pctOk = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
    return s + (pctOk * m.peso) / 100;
  }, 0);
}

// a mecanica pura, portada do simulador - parametrizada pelo PERFIL
// resolvido em vez de constante cravada. Testavel isoladamente com numeros
// fixos (ver testeRotas.js).
function calcular(perfil, faturamento, funcionariosAtivos, completionsGerente, completionsColaboradores) {
  const pool = faturamento * (perfil.percentualPool / 100);
  const metas = pool * (perfil.splitMetasOutras / 100);
  const outras = pool * (1 - perfil.splitMetasOutras / 100);

  const temGerente = perfil.metricasGerente && perfil.metricasGerente.length > 0;
  const temColab = perfil.metricasColaboradores && perfil.metricasColaboradores.length > 0;

  const taxaGerente = temGerente ? taxaCumprimento(perfil.metricasGerente, completionsGerente) : 0;
  const taxaColab = temColab ? taxaCumprimento(perfil.metricasColaboradores, completionsColaboradores) : 0;

  const gerenteRecebe = temGerente
    ? metas * (perfil.splitGerente / 100) * (taxaGerente / 100) + outras * (perfil.splitGerenteOutras / 100) * (taxaGerente / 100)
    : 0;
  const colabTotal = temColab
    ? metas * (1 - perfil.splitGerente / 100) * (taxaColab / 100) + outras * (1 - perfil.splitGerenteOutras / 100) * (taxaColab / 100)
    : 0;
  const colabPorPessoa = funcionariosAtivos > 0 ? colabTotal / funcionariosAtivos : 0;

  return {
    pool: round2(pool), metas: round2(metas), outras: round2(outras),
    taxaGerente: round2(taxaGerente), taxaColab: round2(taxaColab),
    temGerente, temColab,
    gerenteRecebe: round2(gerenteRecebe),
    colabTotal: round2(colabTotal), colabPorPessoa: round2(colabPorPessoa),
  };
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

async function listUncached() {
  const snap = await COLLECTION.get();
  return snap.docs.map((d) => d.data());
}
const apuracoesCache = createCache(listUncached, 30 * 1000);
const listarTodas = apuracoesCache.cached;

// monta o estado atual da apuracao pra unidade+mes: resolve o perfil, puxa
// faturamento/funcionarios/atestados ao vivo, junta com o rascunho salvo
// (se houver) e calcula o resultado. Sem perfil pra unidade, devolve
// { semPerfil: true } - a apuracao NAO roda com um default generico.
async function obterOuCriarRascunho(unidade, mes) {
  if (!mesValido(mes)) throw new Error('Mês inválido - use o formato AAAA-MM.');
  const perfil = await bonificacaoPerfis.perfilDaUnidade(unidade);
  if (!perfil || perfil.ativa === false) {
    return { unidade, mes, semPerfil: true };
  }

  const { inicio, fim, dias } = limitesDoMes(mes);
  const [faturamento, funcionarios, salvo] = await Promise.all([
    faturamentoDoMes(unidade, mes),
    funcionariosAtivosDaUnidade(unidade),
    COLLECTION.doc(docId(unidade, mes)).get(),
  ]);
  const salvoData = salvo.exists ? salvo.data() : null;

  // sugestao de Assiduidade: dias sem atestado / dias do mes, so quando o
  // perfil de fato tem essa metrica cadastrada - senao nao faz sentido
  // calcular um numero que ninguem vai usar
  const temMetricaAssiduidade = [...(perfil.metricasGerente || []), ...(perfil.metricasColaboradores || [])]
    .some((m) => m.campo === 'assiduidade');
  let sugestaoAssiduidade = null;
  if (temMetricaAssiduidade && funcionarios.length) {
    const totalDiasAtestado = funcionarios.reduce((s, f) => s + diasAtestadoNoMes(f, inicio, fim), 0);
    const totalDiasPossiveis = dias * funcionarios.length;
    sugestaoAssiduidade = totalDiasPossiveis > 0
      ? round2(Math.max(0, Math.min(100, ((totalDiasPossiveis - totalDiasAtestado) / totalDiasPossiveis) * 100)))
      : 100;
  }

  const completionsGerente = salvoData?.completionsGerente || (perfil.metricasGerente || []).map((m) => ({
    campo: m.campo,
    percentual: m.campo === 'assiduidade' && sugestaoAssiduidade != null ? sugestaoAssiduidade : 0,
  }));
  const completionsColaboradores = salvoData?.completionsColaboradores || (perfil.metricasColaboradores || []).map((m) => ({
    campo: m.campo,
    percentual: m.campo === 'assiduidade' && sugestaoAssiduidade != null ? sugestaoAssiduidade : 0,
  }));

  const resultado = calcular(perfil, faturamento, funcionarios.length, completionsGerente, completionsColaboradores);

  return {
    unidade, mes, semPerfil: false,
    perfilId: perfil.id, perfilNome: perfil.nome,
    faturamento: round2(faturamento),
    funcionarios: funcionarios.map((f) => ({ id: f.id, nome: f.nome })),
    metricasGerente: perfil.metricasGerente || [],
    metricasColaboradores: perfil.metricasColaboradores || [],
    completionsGerente, completionsColaboradores,
    sugestaoAssiduidade,
    status: salvoData?.status || 'rascunho',
    fechadoPorEmail: salvoData?.fechadoPorEmail || null,
    fechadoEm: salvoData?.fechadoEm || null,
    ...resultado,
  };
}

async function salvarCompletions(unidade, mes, { completionsGerente, completionsColaboradores }, porEmail) {
  const atual = await obterOuCriarRascunho(unidade, mes);
  if (atual.semPerfil) throw new Error('Nenhum perfil de bonificação configurado pra esta unidade.');
  if (atual.status === 'fechado') throw new Error('Essa apuração já foi fechada - não pode mais ser editada.');

  const ref = COLLECTION.doc(docId(unidade, mes));
  const agora = new Date().toISOString();
  const snap = await ref.get();
  await ref.set({
    id: ref.id, unidade, mes,
    completionsGerente: Array.isArray(completionsGerente) ? completionsGerente : atual.completionsGerente,
    completionsColaboradores: Array.isArray(completionsColaboradores) ? completionsColaboradores : atual.completionsColaboradores,
    status: 'rascunho',
    fechadoPorEmail: null, fechadoEm: null,
    criadoPorEmail: snap.exists ? snap.data().criadoPorEmail : porEmail,
    criadoEm: snap.exists ? snap.data().criadoEm : agora,
    atualizadoPorEmail: porEmail, atualizadoEm: agora,
  });
  apuracoesCache.invalidar();
  return obterOuCriarRascunho(unidade, mes);
}

async function fechar(unidade, mes, porEmail) {
  const atual = await obterOuCriarRascunho(unidade, mes);
  if (atual.semPerfil) throw new Error('Nenhum perfil de bonificação configurado pra esta unidade.');
  if (atual.status === 'fechado') throw new Error('Essa apuração já está fechada.');

  const ref = COLLECTION.doc(docId(unidade, mes));
  const agora = new Date().toISOString();
  const snap = await ref.get();
  await ref.set({
    id: ref.id, unidade, mes,
    completionsGerente: atual.completionsGerente,
    completionsColaboradores: atual.completionsColaboradores,
    status: 'fechado',
    fechadoPorEmail: porEmail, fechadoEm: agora,
    criadoPorEmail: snap.exists ? snap.data().criadoPorEmail : porEmail,
    criadoEm: snap.exists ? snap.data().criadoEm : agora,
    atualizadoPorEmail: porEmail, atualizadoEm: agora,
  });
  apuracoesCache.invalidar();
  return obterOuCriarRascunho(unidade, mes);
}

// poda a resposta ANTES de sair da rota - a trava de "nunca mostra todos
// pra todo mundo" e aqui, no servidor, nao no CSS do navegador
function montarRespostaPorPermissao(apuracao, { podeVerTotal, podeVerColaboradores }) {
  if (apuracao.semPerfil) return apuracao;

  const base = {
    unidade: apuracao.unidade, mes: apuracao.mes, status: apuracao.status,
    perfilNome: apuracao.perfilNome,
    temGerente: apuracao.temGerente, temColab: apuracao.temColab,
    gerenteRecebe: apuracao.gerenteRecebe,
    fechadoPorEmail: apuracao.fechadoPorEmail, fechadoEm: apuracao.fechadoEm,
    metricasGerente: apuracao.metricasGerente,
    metricasColaboradores: apuracao.metricasColaboradores,
    completionsGerente: apuracao.completionsGerente,
    completionsColaboradores: apuracao.completionsColaboradores,
    sugestaoAssiduidade: apuracao.sugestaoAssiduidade,
  };

  base.colaboradoresResumo = {
    quantidade: apuracao.funcionarios.length,
    totalRecebem: apuracao.colabTotal,
    porPessoa: apuracao.colabPorPessoa,
  };

  if (podeVerTotal) {
    base.faturamento = apuracao.faturamento;
    base.pool = apuracao.pool;
    base.metas = apuracao.metas;
    base.outras = apuracao.outras;
    base.taxaGerente = apuracao.taxaGerente;
    base.taxaColab = apuracao.taxaColab;
  }

  if (podeVerColaboradores) {
    base.colaboradores = apuracao.funcionarios.map((f) => ({ id: f.id, nome: f.nome, valor: apuracao.colabPorPessoa }));
  }

  return base;
}

// agregado de todas as unidades que o chamador pode ver, pra aba
// Histórico/Comparar de quem tem podeBonifVerValorTotal
async function resumoMes(unidades, mes) {
  const apuracoes = await Promise.all(unidades.map((u) => obterOuCriarRascunho(u, mes)));
  const validas = apuracoes.filter((a) => !a.semPerfil);
  return {
    mes,
    totalUnidades: unidades.length,
    unidadesComPerfil: validas.length,
    faturamentoTotal: round2(validas.reduce((s, a) => s + a.faturamento, 0)),
    gerentesRecebem: round2(validas.reduce((s, a) => s + a.gerenteRecebe, 0)),
    colaboradoresRecebem: round2(validas.reduce((s, a) => s + a.colabTotal, 0)),
    fechadas: validas.filter((a) => a.status === 'fechado').length,
    porUnidade: validas.map((a) => ({
      unidade: a.unidade, perfilNome: a.perfilNome, status: a.status,
      gerenteRecebe: a.gerenteRecebe, colabTotal: a.colabTotal,
    })),
  };
}

module.exports = {
  calcular, obterOuCriarRascunho, salvarCompletions, fechar,
  montarRespostaPorPermissao, resumoMes, listarTodas, equipeDaUnidade,
  diasAtestadoNoMes, limitesDoMes, diasDeSobreposicao,
};
