// entregasRegras.js
// Regra de pagamento por unidade do app de Entregas (motoboys) - definida
// pelo Master em /entregas-regras.html, no mesmo espírito do construtor de
// campos extras do Fechamento (ver grupos.js): em vez de 5 campos fixos,
// cada unidade monta sua PRÓPRIA lista de campos de valor (camposValor) -
// Entrega, Retorno, Extra, Fora de Área, Encosta, Ajuda de Custo,
// Cooperativa, ou qualquer nome que a franquia usar.
//
// Cada campo pode:
//   - aplicar sobre uma contagem do lançamento (Entrega/Retorno/Extra/Fora de
//     Área) -> valor = contagem × taxa; ou ser "valor fixo por lançamento"
//     (ex: Ajuda de Custo/Encosta, que não multiplicam por contagem nenhuma);
//   - somar no "Valor a pagar" ao entregador. O repasse da Cooperativa usa
//     uma configuração separada por unidade e multiplica somente Entregas;
//   - ter uma taxa diferente por dia da semana (ex: R$20 seg-sex, R$30
//     sáb/dom);
//   - ter uma meta mínima numa contagem do lançamento - se não bater, usa um
//     valor parcial (ou zero) no lugar da taxa cheia;
//   - ser removível pela loja no lançamento (ex: entregador atrasou/saiu
//     antes/gerou prejuízo - perde aquele campo específico naquela corrida).
//
// modo "plataforma" continua igual: unidade sem valor fixo (paga o que uma
// plataforma externa tipo GAMI/NEXT informar) - a loja digita os valores à
// mão, sem usar camposValor nenhum.
const db = require('./firestore');
const { createCache } = require('./liveCache');

const COLLECTION = db.collection('entregasRegras');

const DIAS_SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
const BASES_VALIDAS = new Set(['entrega', 'retorno', 'extra', 'pos00hs', 'foraDeArea', 'flat']);
const DESTINOS_VALIDOS = new Set(['valor', 'coopRecebe']);
const MOTIVOS_REMOCAO_CAMPO = ['atraso', 'saiu_antes', 'prejuizo', 'outro'];
const MODELOS_LANCAMENTO_VALIDOS = new Set(['detalhado', 'total']);
const FAIXAS_KM = [
  { id: 'ate49', label: 'Até 4,9 km', limiteKm: 4.9 },
  { id: 'ate59', label: 'Até 5,9 km', limiteKm: 5.9 },
  { id: 'ate69', label: 'Até 6,9 km', limiteKm: 6.9 },
  { id: 'ate79', label: 'Até 7,9 km', limiteKm: 7.9 },
  { id: 'ate89', label: 'Até 8,9 km', limiteKm: 8.9 },
  { id: 'ate99', label: 'Até 9,9 km', limiteKm: 9.9 },
];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Repasse independente: somente Entregas, nunca adicionais ou valor fixo.
function configuracaoCoop(regra){
  if(regra?.regraCoop!=null)return {ativo:regra.regraCoop.ativo===true,valorEntrega:Math.max(0,num(regra.regraCoop.valorEntrega))};
  // Compatibilidade com o campo antigo explicitamente configurado por entrega.
  const antigos=(regra?.camposValor||[]).filter(c=>c.destino==='coopRecebe'&&c.base==='entrega');
  return {ativo:antigos.length>0,valorEntrega:antigos.reduce((s,c)=>s+Math.max(0,num(c.valorPadrao)),0)};
}
function calcularCoop(regra,entrega){
  const c=configuracaoCoop(regra);
  return c.ativo?+(Math.max(0,num(entrega))*c.valorEntrega).toFixed(2):0;
}

// mesmo slugify de grupos.js - vira um identificador estavel (campo) a
// partir do nome digitado (label), ex "Ajuda de Custo" -> "ajudaDeCusto"
function slugify(s) {
  const limpo = String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim();
  if (!limpo) return '';
  return limpo
    .split(' ')
    .map((palavra, i) => (i === 0 ? palavra.toLowerCase() : palavra.charAt(0).toUpperCase() + palavra.slice(1).toLowerCase()))
    .join('');
}

function sanitizarValoresPorDiaSemana(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const resultado = {};
  let algum = false;
  DIAS_SEMANA.forEach((d) => {
    if (obj[d] != null && obj[d] !== '') { resultado[d] = num(obj[d]); algum = true; }
  });
  return algum ? resultado : null;
}

function sanitizarMeta(m) {
  if (!m || !m.ativo) return null;
  const baseContagem = ['entrega', 'retorno', 'extra', 'pos00hs', 'foraDeArea', 'quantTotal'].includes(m.baseContagem) ? m.baseContagem : 'entrega';
  return { baseContagem, minimo: num(m.minimo), valorParcial: num(m.valorParcial) };
}

function sanitizarEntregadoresFixos(lista) {
  if (!Array.isArray(lista)) return [];
  const usados = new Set();
  return lista
    .map((nome) => String(nome || '').trim().replace(/\s+/g, ' ').slice(0, 80))
    .filter((nome) => {
      if (!nome) return false;
      const chave = nome.toLocaleLowerCase('pt-BR');
      if (usados.has(chave)) return false;
      usados.add(chave);
      return true;
    })
    .slice(0, 100);
}

function sanitizarEmpresas(lista) {
  if (!Array.isArray(lista)) return [];
  const usados = new Set();
  return lista.map((empresa) => {
    const nome = String(empresa?.nome || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    if (!nome) return null;
    const chave = nome.toLocaleLowerCase('pt-BR');
    if (usados.has(chave)) return null;
    usados.add(chave);
    const modo = empresa?.modo === 'fixo' ? 'fixo' : 'manual';
    const pagamentoEntregador = ['manual','unidade'].includes(empresa?.pagamentoEntregador) ? empresa.pagamentoEntregador : (modo === 'manual' ? 'manual' : 'unidade');
    return { nome, modo, pagamentoEntregador, valorEntrega: modo === 'fixo' ? Math.max(0, num(empresa?.valorEntrega)) : 0 };
  }).filter(Boolean).slice(0, 100);
}

function sanitizarRegraKm(regraKm) {
  const valoresRecebidos = new Map((Array.isArray(regraKm?.faixas) ? regraKm.faixas : [])
    .map((faixa) => [faixa?.id, Math.max(0, num(faixa?.valor))]));
  return {
    ativo: !!regraKm?.ativo,
    faixas: FAIXAS_KM.map((faixa) => ({ ...faixa, valor: valoresRecebidos.get(faixa.id) || 0 })),
  };
}

// As primeiras versões da tela deixavam "Valor fixo por lançamento" como
// padrão. Assim, regras já cadastradas com os nomes canônicos abaixo (como a
// de Garanhuns) podem ter sido salvas como flat mesmo sendo quantidades. A
// leitura corrige esses três casos inequívocos sem mexer em campos realmente
// fixos, como Ajuda de Custo/Encosta.
function baseCanonicaDoLabel(label) {
  const chave = String(label || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase();
  if (chave === 'entrega' || chave === 'entregas') return 'entrega';
  if (chave === 'pos00h' || chave === 'pos00hs') return 'pos00hs';
  if (chave === 'foradearea') return 'foraDeArea';
  return null;
}

function normalizarRegra(regra) {
  if (!regra || typeof regra !== 'object') return regra;
  let empresas = sanitizarEmpresas(regra.empresas);
  if (!empresas.length && regra.plataformaNome) {
    empresas = sanitizarEmpresas(String(regra.plataformaNome).split(/[,;]+/).map((nome) => ({ nome, modo: 'manual' })));
  }
  return {
    ...regra,
    // Campina usa a configuração comum a partir de agora; o modelo dos
    // lançamentos históricos permanece salvo no próprio lançamento.
    modeloLancamento: regra.unidade === 'Dominos Campina Grande' ? 'detalhado' : (regra.modeloLancamento || 'detalhado'),
    entregadoresFixos: sanitizarEntregadoresFixos(regra.entregadoresFixos),
    empresas,
    regraKm: sanitizarRegraKm(regra.regraKm),
    regraCoop: configuracaoCoop(regra),
    camposValor: (Array.isArray(regra.camposValor) ? regra.camposValor : []).map((campo) => ({
      ...campo,
      base: campo.base === 'flat' ? (baseCanonicaDoLabel(campo.label) || 'flat') : campo.base,
    })),
  };
}

function sanitizarCamposValor(lista) {
  if (!Array.isArray(lista)) return [];
  const usados = new Set();
  return lista
    .map((c) => {
      const label = String(c?.label || '').trim().slice(0, 40);
      if (!label) return null;
      let campo = slugify(c?.campo) || slugify(label);
      if (!campo) return null;
      let base = campo;
      let n = 2;
      while (usados.has(campo)) { campo = base + n; n += 1; }
      usados.add(campo);
      return {
        campo,
        label,
        base: (() => {
          const configurada = BASES_VALIDAS.has(c?.base) ? c.base : 'flat';
          return configurada === 'flat' ? (baseCanonicaDoLabel(label) || 'flat') : configurada;
        })(),
        destino: DESTINOS_VALIDOS.has(c?.destino) ? c.destino : 'valor',
        valorPadrao: num(c?.valorPadrao),
        valoresPorDiaSemana: sanitizarValoresPorDiaSemana(c?.valoresPorDiaSemana),
        meta: sanitizarMeta(c?.meta),
        removivelPelaLoja: !!c?.removivelPelaLoja,
      };
    })
    .filter(Boolean)
    .slice(0, 20);
}

function defaultRegra(unidade) {
  return {
    unidade,
    modo: 'plataforma',
    modeloLancamento: 'detalhado',
    plataformaNome: '',
    entregadoresFixos: [],
    empresas: [],
    regraKm: sanitizarRegraKm(null),
    regraCoop: {ativo:false,valorEntrega:0},
    camposValor: [],
    atualizadoEm: null,
    atualizadoPorEmail: null,
  };
}

async function listAllUncached() {
  const snap = await COLLECTION.get();
  return snap.docs.map((d) => normalizarRegra(d.data()));
}
const regrasCache = createCache(listAllUncached, 5 * 60 * 1000);
const listAll = regrasCache.cached;

async function getPara(unidade) {
  const doc = await COLLECTION.doc(unidade).get();
  // Mesclar com o padrão conserva os campos das configurações antigas.
  return doc.exists ? { ...defaultRegra(unidade), ...normalizarRegra(doc.data()) } : defaultRegra(unidade);
}

async function salvar(unidade, campos, atualizadoPorEmail) {
  if (!unidade) throw new Error('Unidade é obrigatória.');
  const modo = campos?.modo === 'fixo' ? 'fixo' : 'plataforma';
  const entregadoresFixos = sanitizarEntregadoresFixos(campos?.entregadoresFixos);
  const empresas = sanitizarEmpresas(campos?.empresas);
  const regraKm = sanitizarRegraKm(campos?.regraKm);
  const regraCoop=configuracaoCoop(campos?.regraCoop!=null||campos?.camposValor?.some(c=>c.destino==='coopRecebe')?campos:await getPara(unidade));
  if(regraCoop.ativo&&regraCoop.valorEntrega<=0)throw new Error('Informe um valor por entrega maior que zero para COOP recebe.');
  if (empresas.some((empresa) => empresa.modo === 'fixo' && empresa.valorEntrega <= 0)) {
    throw new Error('Informe um valor por entrega maior que zero para cada empresa de tarifa fixa.');
  }
  const nomesEntregadores = new Set(entregadoresFixos.map((nome) => nome.toLocaleLowerCase('pt-BR')));
  if (empresas.some((empresa) => nomesEntregadores.has(empresa.nome.toLocaleLowerCase('pt-BR')))) {
    throw new Error('O mesmo nome não pode ser cadastrado como entregador fixo e empresa/plataforma.');
  }
  if (regraKm.ativo && regraKm.faixas.some((faixa) => faixa.valor <= 0)) {
    throw new Error('Informe um valor maior que zero para todas as faixas de KM.');
  }
  const registro = {
    unidade,
    modo,
    modeloLancamento: unidade === 'Dominos Campina Grande' ? 'detalhado' : (MODELOS_LANCAMENTO_VALIDOS.has(campos?.modeloLancamento) ? campos.modeloLancamento : 'detalhado'),
    plataformaNome: String(campos?.plataformaNome || '').trim().slice(0, 40),
    entregadoresFixos,
    empresas,
    regraKm,
    regraCoop,
    camposValor: sanitizarCamposValor(campos?.camposValor),
    atualizadoEm: new Date().toISOString(),
    atualizadoPorEmail,
  };
  await COLLECTION.doc(unidade).set(registro);
  regrasCache.invalidar();
  return registro;
}

// "qua","sex","sab"... a partir de uma data ISO (yyyy-mm-dd), sem depender
// de fuso do servidor (new Date('yyyy-mm-dd') já vem em UTC 00:00, e
// getUTCDay bate certo com o dia civil da data informada)
function diaSemanaDe(dataIso) {
  const d = new Date(`${dataIso}T00:00:00Z`);
  return DIAS_SEMANA[d.getUTCDay()];
}

// calcula os valores de um lançamento a partir das contagens digitadas pela
// loja + a lista de camposValor da unidade. Só chamada quando regra.modo ===
// 'fixo' - no modo "plataforma" os valores continuam vindo direto do
// formulário. "camposRemovidos" é a lista de `campo` (slug) que a loja
// marcou pra não pagar naquela corrida (ex: Encosta removida por atraso).
function calcular(regra, { data, entrega, retorno, extra, pos00hs, foraDeArea, camposRemovidos }) {
  const contagens = {
    entrega: Math.max(0, num(entrega)), retorno: Math.max(0, num(retorno)), extra: Math.max(0, num(extra)),
    pos00hs: Math.max(0, num(pos00hs)), foraDeArea: Math.max(0, num(foraDeArea)),
  };
  contagens.quantTotal = contagens.entrega + contagens.retorno + contagens.extra;
  const dia = data ? diaSemanaDe(data) : null;
  const removidos = new Set(Array.isArray(camposRemovidos) ? camposRemovidos : []);

  let valor = 0;
  const coopRecebe = calcularCoop(regra,contagens.entrega);
  let ajudaCusto = 0; // soma dos campos "flat" que somam no Valor a pagar - alimenta a coluna legada
  const detalhes = [];

  (regra.camposValor || []).forEach((c) => {
    if(c.destino==='coopRecebe')return; // substituído pela configuração exclusiva acima
    if (removidos.has(c.campo)) {
      detalhes.push({ campo: c.campo, label: c.label, valor: 0, removido: true });
      return;
    }
    let taxa = (dia && c.valoresPorDiaSemana && c.valoresPorDiaSemana[dia] != null) ? c.valoresPorDiaSemana[dia] : c.valorPadrao;
    if (c.meta) {
      const contagemMeta = contagens[c.meta.baseContagem] ?? 0;
      if (contagemMeta < c.meta.minimo) taxa = c.meta.valorParcial;
    }
    const quantidade = c.base === 'flat' ? null : (contagens[c.base] || 0);
    const valorCampo = c.base === 'flat' ? taxa : quantidade * taxa;
    detalhes.push({ campo: c.campo, label: c.label, base: c.base, quantidade, taxa: +taxa.toFixed(2), valor: +valorCampo.toFixed(2) });
    valor += valorCampo;
    if (c.base === 'flat') ajudaCusto += valorCampo;
  });
  if(configuracaoCoop(regra).ativo)detalhes.push({campo:'coopRecebe',label:'COOP recebe',base:'entrega',quantidade:contagens.entrega,taxa:configuracaoCoop(regra).valorEntrega,valor:coopRecebe,destino:'coopRecebe'});

  return {
    valor: +valor.toFixed(2),
    coopRecebe: +coopRecebe.toFixed(2),
    ajudaCusto: +ajudaCusto.toFixed(2),
    quantTotal: contagens.quantTotal,
    detalhesValor: detalhes,
  };
}

module.exports = {
  listAll, getPara, salvar, calcular, defaultRegra, configuracaoCoop, calcularCoop,
  DIAS_SEMANA, BASES_VALIDAS, DESTINOS_VALIDOS, MOTIVOS_REMOCAO_CAMPO, MODELOS_LANCAMENTO_VALIDOS, FAIXAS_KM,
  invalidar: () => regrasCache.invalidar(),
};
