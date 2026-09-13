// conciliacao.js
//
// FONTE DE VERDADE EXTERNA x O QUE O GERENTE DECLAROU.
//
// Pedido do Master (13/09/2026): os chats do Cowork captam venda REAL do PWR
// (o PDV da Domino's) e do iFood; "se o gerente colocar que vendeu 10 mil mas
// vendeu 12, essa conciliação vai mostrar". E o briefing passa a ser DENTRO
// do NoPulso, não fora.
//
// O desenho, e por que ele é o mais barato:
//
//   PWR / iFood ─(1 número por loja/dia)─▶ POST /api/bot/vendas-registro
//   gerente ─(fechamento: faturamento, ifood)─▶ fechamentosLive
//                                 │
//                                 ▼
//                        conciliar() — função PURA, aqui
//                                 │
//            briefing (e-mail + /api/bot/indicadores) · alerta na Central
//            · tarefa pro gerente da loja (cobrar(), no relógio das 8:45)
//
// Quem compara é o SERVIDOR, não um chat: não depende da rede do Cowork, não
// depende de alguém lembrar de rodar, e o resultado fica gravado na loja/dia.
// O Cowork faz UMA coisa: entrega o número. Nunca lê N rotas, nunca cruza,
// nunca decide.
//
// Custo no Firestore: ~14 lojas x 2 fontes = ~28 escritas por dia, e UMA
// leitura cacheada por briefing. Uma consulta em laço "por unidade" custaria
// mais numa manhã do que isto num mês.
//
// O que compara com o quê (regra do Master, guardada em conciliacaoConfig):
//   - `faturamento` declarado x total do PWR (com `pwrIncluiIfood` desligado,
//     o esperado vira PWR + iFood registrado);
//   - `ifood` declarado x total do iFood registrado.
// Diferença acima do MAIOR entre `toleranciaReais` e `toleranciaPct` do
// registro vira "divergente" - e só divergente vira cobrança.
const cron = require('node-cron');
const db = require('./firestore');
const { createCache } = require('./liveCache');
const users = require('./users');
const tarefas = require('./tarefas');
const alertasCentral = require('./alertasCentral');

const REGISTROS = db.collection('vendasRegistro');
const CONFIG_DOC = db.collection('conciliacaoConfig').doc('config');
const FUSO_BR = 'America/Sao_Paulo';

const FONTES = ['pwr', 'ifood'];
// janela que a conciliação olha: ontem e os 2 dias antes. Cobre o registro
// que chega atrasado (portal fora do ar, Cowork que não rodou) sem ficar
// reabrindo o mês inteiro a cada manhã.
const DIAS_JANELA = 3;
// quantos registros a lista cacheada puxa: 1500 docs = ~50 dias de 28
// registros/dia. Ordenado por data desc, o que passar disso é histórico que
// a conciliação não olha mais.
const LIMITE_LISTA = 1500;

const CONFIG_PADRAO = {
  toleranciaReais: 50,
  toleranciaPct: 1,
  pwrIncluiIfood: true,
  horaCobranca: '08:45',
  cobrarAutomatico: true,
};

function docId(unidade, data, fonte) {
  return `${unidade}__${data}__${fonte}`.replace(/[^A-Za-z0-9_.-]/g, '_');
}
function somarDiasISO(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function arredondar(v) { return Math.round((Number(v) || 0) * 100) / 100; }
function brl(v) {
  return 'R$ ' + (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function dataBR(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? `${m[3]}/${m[2]}` : String(iso || '');
}
const ehISO = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

// ---- configuração (regra do Master) ----
function sanitizarConfig(entrada) {
  const d = entrada && typeof entrada === 'object' ? entrada : {};
  const reais = Number(d.toleranciaReais);
  const pct = Number(d.toleranciaPct);
  return {
    toleranciaReais: Number.isFinite(reais) && reais >= 0 ? arredondar(reais) : CONFIG_PADRAO.toleranciaReais,
    toleranciaPct: Number.isFinite(pct) && pct >= 0 && pct <= 100 ? arredondar(pct) : CONFIG_PADRAO.toleranciaPct,
    pwrIncluiIfood: d.pwrIncluiIfood == null ? CONFIG_PADRAO.pwrIncluiIfood : !!d.pwrIncluiIfood,
    horaCobranca: /^([01]\d|2[0-3]):([0-5]\d)$/.test(d.horaCobranca) ? d.horaCobranca : CONFIG_PADRAO.horaCobranca,
    cobrarAutomatico: d.cobrarAutomatico == null ? CONFIG_PADRAO.cobrarAutomatico : !!d.cobrarAutomatico,
  };
}
const configCache = createCache(async () => {
  const snap = await CONFIG_DOC.get();
  const data = snap.exists ? snap.data() : {};
  return { ...sanitizarConfig(data), atualizadoEm: data.atualizadoEm || null };
}, 5 * 60 * 1000);
const getConfig = configCache.cached;

async function salvarConfig(entrada, porEmail) {
  const cfg = { ...sanitizarConfig(entrada), atualizadoEm: new Date().toISOString(), atualizadoPorEmail: porEmail || null };
  await CONFIG_DOC.set(cfg);
  configCache.invalidar();
  reagendar(cfg);
  return cfg;
}

// ---- registros (o número que veio de fora) ----
async function listarUncached() {
  const snap = await REGISTROS.orderBy('data', 'desc').limit(LIMITE_LISTA).get();
  return snap.docs.map((d) => d.data());
}
const registrosCache = createCache(listarUncached, 5 * 60 * 1000);
const listarRegistros = registrosCache.cached;

// Valida e grava. Um registro por (unidade, data, fonte): mandar de novo o
// mesmo dia SOBRESCREVE o total (o portal corrige D+1, o Cowork reenvia) e
// preserva o que a cobrança já marcou (cobradoEm/tarefaId), pra não cobrar
// duas vezes a mesma divergência.
//
// `unidadesConhecidas` é o mapa código -> nome das lojas que fecham caixa.
// Código que não está nele é RECUSADO, não criado: registro de loja
// inexistente nunca vira loja (o mesmo cuidado de nomeCanonicoUnidade).
async function registrar({ registros, unidadesConhecidas, hoje, origem }) {
  const lista = Array.isArray(registros) ? registros : [];
  if (!lista.length) throw new Error('Mande pelo menos um registro em `registros`.');
  if (lista.length > 200) throw new Error('Muitos registros de uma vez (máximo 200).');
  const conhecidas = unidadesConhecidas || {};
  const agora = new Date().toISOString();
  const gravados = [];
  const recusados = [];
  for (const r of lista) {
    const unidade = String((r && r.unidade) || '').trim();
    const data = String((r && r.data) || '').trim();
    const fonte = String((r && r.fonte) || '').trim().toLowerCase();
    const total = Number(r && r.total);
    const motivo = !unidade ? 'sem unidade'
      : !conhecidas[unidade] ? `unidade desconhecida: ${unidade}`
        : !ehISO(data) ? 'data inválida (use AAAA-MM-DD)'
          : (hoje && data > hoje) ? 'data no futuro'
            : !FONTES.includes(fonte) ? `fonte inválida (use ${FONTES.join(' ou ')})`
              : !(Number.isFinite(total) && total >= 0) ? 'total inválido' : null;
    if (motivo) { recusados.push({ unidade, data, fonte, motivo }); continue; }
    const pedidos = Number(r.pedidos);
    const registro = {
      id: docId(unidade, data, fonte),
      unidade, unidadeNome: conhecidas[unidade], data, fonte,
      total: arredondar(total),
      pedidos: Number.isInteger(pedidos) && pedidos >= 0 ? pedidos : null,
      detalhe: String((r && r.detalhe) || '').trim().slice(0, 300) || null,
      origem: String(origem || 'bot').slice(0, 60),
      recebidoEm: agora,
    };
    await REGISTROS.doc(registro.id).set(registro, { merge: true });
    gravados.push(registro);
  }
  if (gravados.length) registrosCache.invalidar();
  return { gravados, recusados };
}

async function marcarCobranca(ids, patch) {
  for (const id of ids) await REGISTROS.doc(id).set({ ...patch }, { merge: true });
  registrosCache.invalidar();
}

// ---- a comparação (pura) ----
//
// Devolve um item por (unidade, data, fonte) dentro da janela:
//   status 'ok' | 'divergente' | 'sem-registro' | 'sem-fechamento'
// 'sem-fechamento' (o portal tem venda e ninguém lançou) não é cobrado por
// aqui: o briefing já lista quem não lançou, e a cobrança dobrada só faz
// ruído. Fica no item pra quem lê ver que a venda existiu.
function conciliar({ fechamentos = [], registros = [], unidadesLoja = {}, config, inicio, fim }) {
  const cfg = sanitizarConfig(config);
  const dentro = (d) => ehISO(d) && (!inicio || d >= inicio) && (!fim || d <= fim);
  const fech = new Map();
  fechamentos.forEach((f) => {
    if (!f || !unidadesLoja[f.unidade] || !dentro(f.data)) return;
    fech.set(`${f.unidade}__${f.data}`, f);
  });
  const reg = new Map();
  registros.forEach((r) => {
    if (!r || !unidadesLoja[r.unidade] || !dentro(r.data) || !FONTES.includes(r.fonte)) return;
    const chave = `${r.unidade}__${r.data}`;
    if (!reg.has(chave)) reg.set(chave, {});
    reg.get(chave)[r.fonte] = r;
  });
  const chaves = new Set([...fech.keys(), ...reg.keys()]);
  const limite = (base) => Math.max(cfg.toleranciaReais, arredondar((Number(base) || 0) * cfg.toleranciaPct / 100));
  const itens = [];
  chaves.forEach((chave) => {
    const f = fech.get(chave) || null;
    const r = reg.get(chave) || {};
    const [unidade, data] = chave.split('__');
    const base = { unidade, unidadeNome: unidadesLoja[unidade], data, gerente: f ? (f.gerente || null) : null };
    // PWR x faturamento declarado
    if (r.pwr || f) {
      const item = { ...base, fonte: 'pwr', declarado: f ? arredondar(f.faturamento) : null, registro: null, diferenca: null, diferencaPct: null, status: null, registroId: r.pwr ? r.pwr.id : null, cobradoEm: r.pwr ? (r.pwr.cobradoEm || null) : null, tarefaNumero: r.pwr ? (r.pwr.tarefaNumero || null) : null };
      if (!r.pwr) item.status = 'sem-registro';
      else if (!f) { item.registro = arredondar(r.pwr.total); item.status = 'sem-fechamento'; }
      else {
        let esperado = arredondar(r.pwr.total);
        if (!cfg.pwrIncluiIfood) {
          if (!r.ifood) { item.status = 'sem-registro'; item.motivo = 'PWR não inclui iFood e o iFood não foi registrado'; itens.push(item); return; }
          esperado = arredondar(esperado + (Number(r.ifood.total) || 0));
        }
        item.registro = esperado;
        item.diferenca = arredondar(item.declarado - esperado);
        item.diferencaPct = esperado ? arredondar(Math.abs(item.diferenca) / esperado * 100) : null;
        item.status = Math.abs(item.diferenca) > limite(esperado) ? 'divergente' : 'ok';
      }
      itens.push(item);
    }
    // iFood x iFood declarado
    if (r.ifood && f) {
      const declarado = arredondar(f.ifood);
      const registro = arredondar(r.ifood.total);
      const diferenca = arredondar(declarado - registro);
      itens.push({
        ...base, fonte: 'ifood', declarado, registro, diferenca,
        diferencaPct: registro ? arredondar(Math.abs(diferenca) / registro * 100) : null,
        status: Math.abs(diferenca) > limite(registro) ? 'divergente' : 'ok',
        registroId: r.ifood.id, cobradoEm: r.ifood.cobradoEm || null, tarefaNumero: r.ifood.tarefaNumero || null,
      });
    }
  });
  const peso = { divergente: 0, 'sem-registro': 1, 'sem-fechamento': 2, ok: 3 };
  itens.sort((a, b) => (peso[a.status] - peso[b.status]) || (Math.abs(b.diferenca || 0) - Math.abs(a.diferenca || 0)) || b.data.localeCompare(a.data));
  const conta = (s) => itens.filter((i) => i.status === s).length;
  return {
    janela: { inicio: inicio || null, fim: fim || null, dias: DIAS_JANELA },
    regra: { toleranciaReais: cfg.toleranciaReais, toleranciaPct: cfg.toleranciaPct, pwrIncluiIfood: cfg.pwrIncluiIfood },
    resumo: { comparados: conta('ok') + conta('divergente'), divergentes: conta('divergente'), semRegistro: conta('sem-registro'), semFechamento: conta('sem-fechamento') },
    itens,
  };
}

// ---- a cobrança: divergência vira alerta + tarefa pro gerente ----
function textoDivergencia(item) {
  const sinal = item.diferenca > 0 ? 'a mais' : 'a menos';
  const fonte = item.fonte === 'pwr' ? 'PWR' : 'iFood';
  return `declarou ${brl(item.declarado)}, ${fonte} ${brl(item.registro)} (${brl(Math.abs(item.diferenca))} ${sinal})`;
}

// o gerente da loja é quem tem a tag de gerente E a unidade no acesso. Sem
// gerente cadastrado assim, a tarefa fica com o Master - com o nome que o
// fechamento gravou no campo `gerente`, pra ele saber a quem perguntar.
function gerenteDaUnidade(lista, unidade) {
  const ativos = (lista || []).filter((u) => u && u.active !== false && u.role !== 'master' && users.ehCargoGerente(u.cargo)
    && Array.isArray(u.permissions && u.permissions.unidades) && u.permissions.unidades.includes(unidade));
  return ativos.find((u) => u.cargo === 'gerente') || ativos[0] || null;
}
function masterDaLista(lista) {
  const email = String(process.env.MASTER_EMAIL || '').trim().toLowerCase();
  const masters = (lista || []).filter((u) => u && u.role === 'master' && u.active !== false);
  return masters.find((u) => String(u.email || '').toLowerCase() === email) || masters[0] || null;
}

async function cobrar({ conciliacao, hoje }) {
  const pendentes = (conciliacao && conciliacao.itens || []).filter((i) => i.status === 'divergente' && !i.cobradoEm && i.registroId);
  if (!pendentes.length) return [];
  const lista = await users.list();
  const master = masterDaLista(lista);
  if (!master) throw new Error('Sem acesso Master ativo pra assinar a cobrança.');
  const feitas = [];
  for (const item of pendentes) {
    const gerente = gerenteDaUnidade(lista, item.unidade);
    const titulo = `Conciliação ${dataBR(item.data)} · ${item.unidadeNome}: ${textoDivergencia(item)}`.slice(0, 200);
    const descricao = [
      `Fechamento de ${dataBR(item.data)} da ${item.unidadeNome}${item.gerente ? ` (lançado por ${item.gerente})` : ''}.`,
      `Declarado: ${brl(item.declarado)} · ${item.fonte === 'pwr' ? 'PWR' : 'iFood'}: ${brl(item.registro)} · Diferença: ${brl(item.diferenca)}${item.diferencaPct != null ? ` (${item.diferencaPct}%)` : ''}.`,
      `Tolerância: ${brl(conciliacao.regra.toleranciaReais)} ou ${conciliacao.regra.toleranciaPct}%.`,
      gerente ? 'Explique a diferença nesta tarefa e corrija o fechamento pela Central → Histórico → Fechamentos → Pedir correção.' : `Sem gerente com a tag e a unidade no acesso - perguntar a ${item.gerente || 'quem lançou'}.`,
    ].join('\n');
    const alerta = await alertasCentral.registrar({ tipo: 'conciliacao-divergente', titulo, resumo: descricao.split('\n')[1], url: '/tarefas.html', critico: true });
    const tarefa = await tarefas.criar({
      titulo, descricao, dataInicio: hoje, dataEntrega: hoje,
      unidade: item.unidade, unidadeNome: item.unidadeNome,
      usuario: master, responsavel: gerente || master, prioridade: 'alta', origem: 'conciliacao',
    });
    await marcarCobranca([item.registroId], { cobradoEm: new Date().toISOString(), tarefaId: tarefa.id, tarefaNumero: tarefa.numeroTicket, alertaId: alerta.id });
    feitas.push({ unidade: item.unidade, data: item.data, fonte: item.fonte, tarefaNumero: tarefa.numeroTicket, responsavelEmail: (gerente || master).email });
  }
  return feitas;
}

// ---- o relógio ----
// montar() vem do index.js (é o mesmo montarIndicadoresBot do briefing - a
// conciliação viaja dentro dele, então o e-mail, a rota do bot e a cobrança
// enxergam EXATAMENTE o mesmo número). hojeISO() idem.
let montarIndicadores = null;
let hojeISO = null;
let tarefaCron = null;

async function rodarCobranca(origem = 'agendado') {
  if (!montarIndicadores) throw new Error('conciliacao.iniciar ainda não rodou.');
  const ind = await montarIndicadores({ compacto: true, incluirTodos: true });
  const feitas = await cobrar({ conciliacao: ind.conciliacao, hoje: hojeISO() });
  console.log(`[conciliacao] cobrança ${origem}: ${feitas.length} divergência(s) viraram tarefa${feitas.length ? ' - ' + feitas.map((f) => `#${f.tarefaNumero} ${f.unidade} ${f.data} ${f.fonte}`).join(' · ') : ''}`);
  return feitas;
}

function reagendar(cfg) {
  if (tarefaCron) { tarefaCron.stop(); tarefaCron = null; }
  if (!cfg.cobrarAutomatico) { console.log('[conciliacao] cobrança automática DESLIGADA (ligue em /api/conciliacao-config).'); return; }
  const [hora, minuto] = cfg.horaCobranca.split(':');
  const expressao = `${Number(minuto)} ${Number(hora)} * * *`;
  if (!cron.validate(expressao)) { console.error(`[conciliacao] horário inválido (${cfg.horaCobranca}).`); return; }
  tarefaCron = cron.schedule(expressao, () => {
    rodarCobranca('agendado').catch((err) => console.error('[conciliacao] falha na cobrança:', err.message));
  }, { timezone: FUSO_BR });
  console.log(`[conciliacao] cobrança automática às ${cfg.horaCobranca} (${FUSO_BR}).`);
}

async function iniciar({ montar, hoje }) {
  if (typeof montar !== 'function' || typeof hoje !== 'function') throw new Error('conciliacao.iniciar precisa de { montar, hoje }.');
  montarIndicadores = montar;
  hojeISO = hoje;
  reagendar(await getConfig());
}

module.exports = {
  FONTES, DIAS_JANELA, CONFIG_PADRAO,
  getConfig, salvarConfig, sanitizarConfig,
  listarRegistros, registrar, invalidar: registrosCache.invalidar,
  conciliar, cobrar, rodarCobranca, iniciar,
  somarDiasISO, gerenteDaUnidade, textoDivergencia,
};
