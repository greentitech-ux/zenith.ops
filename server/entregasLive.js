// entregasLive.js
// Lançamento de entregas pelas próprias lojas (substitui o AppSheet de
// entregas dos motoboys): cada lançamento é uma corrida/turno de um
// entregador numa unidade, num dia. Diferente do fechamento (1 por
// unidade+data), aqui é normal ter vários lançamentos no mesmo dia/unidade -
// um por entregador. Depois de lançado o registro NÃO pode ser editado
// direto - qualquer correção passa por um pedido de edição (entregaEdicoes)
// que só é aplicado quando o Master aprova; o valor anterior sempre fica
// guardado no histórico do próprio lançamento.
const db = require('./firestore');
const storage = require('./storage');
const { createCache } = require('./liveCache');
const entregasRegras = require('./entregasRegras');

const COLLECTION = db.collection('entregasLive');
const EDITS = db.collection('entregaEdicoes');


const CAMPOS_NUMERICOS = [
  'entrega', 'retorno', 'extra', 'bonus', 'pos00hs', 'foraDeArea',
  'ajudaCusto', 'valor', 'coopRecebe', 'quantTotal',
];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function create({ unidade, unidadeNome, data, entregador, campos, obsRetorno, obsExtra, observacao, camposRemovidos, motivoRemocaoCampos, etiquetaFile, criadoPorId, criadoPorEmail }) {
  if (!unidade) throw new Error('Unidade é obrigatória.');
  if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(data)) throw new Error('Data inválida.');
  if (!entregador || !String(entregador).trim()) throw new Error('Nome do entregador é obrigatório.');

  const ref = COLLECTION.doc();
  const registro = { id: ref.id, unidade, unidadeNome: unidadeNome || unidade, data, entregador: String(entregador).trim() };
  CAMPOS_NUMERICOS.forEach((c) => { registro[c] = num(campos?.[c]); });

  // unidade com regra "fixo": o servidor calcula ajudaCusto/valor/coopRecebe
  // a partir das contagens + da lista de campos de valor da unidade (ver
  // entregasRegras.js) - nunca confia no que o cliente mandou pra esses
  // campos (evita loja "ajustar" o próprio pagamento). Unidade "plataforma"
  // (sem valor fixo, ex: paga o que a GAMI/NEXT informar) mantém os valores
  // digitados normalmente.
  const regra = await entregasRegras.getPara(unidade);
  const camposValidosRemovidos = Array.isArray(camposRemovidos)
    ? camposRemovidos.filter((c) => (regra.camposValor || []).some((r) => r.campo === c && r.removivelPelaLoja))
    : [];
  registro.camposRemovidos = camposValidosRemovidos;
  registro.motivoRemocaoCampos = camposValidosRemovidos.length
    ? (entregasRegras.MOTIVOS_REMOCAO_CAMPO.includes(motivoRemocaoCampos) ? motivoRemocaoCampos : 'outro')
    : null;
  registro.detalhesValor = [];
  if (regra.modo === 'fixo') {
    const calculado = entregasRegras.calcular(regra, {
      data: registro.data, entrega: registro.entrega, retorno: registro.retorno, extra: registro.extra, foraDeArea: registro.foraDeArea,
      camposRemovidos: camposValidosRemovidos,
    });
    registro.ajudaCusto = calculado.ajudaCusto;
    registro.valor = calculado.valor;
    registro.coopRecebe = calculado.coopRecebe;
    registro.quantTotal = calculado.quantTotal;
    registro.detalhesValor = calculado.detalhesValor;
    registro.bonus = 0; // Bônus (Gami/NEXT) só existe em unidade "plataforma" - ver abaixo
  }

  registro.obsRetorno = obsRetorno || null;
  registro.obsExtra = obsExtra || null;
  registro.observacao = observacao || null;
  registro.etiquetaPath = null;

  if (etiquetaFile) {
    registro.etiquetaPath = await storage.salvarArquivo(ref.id, etiquetaFile, 'entregas');
  }

  const agora = new Date().toISOString();
  registro.criadoPorId = criadoPorId;
  registro.criadoPorEmail = criadoPorEmail;
  registro.criadoEm = agora;
  registro.atualizadoEm = agora;
  registro.historico = [];

  await ref.set(registro);
  entregasCache.invalidar();
  return registro;
}

async function listAllUncached() {
  const snap = await COLLECTION.orderBy('data', 'desc').get();
  return snap.docs.map((d) => d.data());
}
const entregasCache = createCache(listAllUncached, 5 * 60 * 1000);
const listAll = entregasCache.cached;


// filtra EM MEMORIA sobre o cache compartilhado - a query direta por
// unidade (where in) nao passava pelo cache e virava uma leitura completa
// no Firestore a cada chamada (ver o estouro de leituras de 2026-08-09)
async function listByUnidades(unidades) {
  if (!unidades || !unidades.length) return [];
  const alvo = new Set(unidades);
  return (await listAll()).filter((r) => alvo.has(r.unidade));
}

async function getOne(id) {
  const doc = await COLLECTION.doc(id).get();
  return doc.exists ? doc.data() : null;
}

// nomes amigaveis + formatacao do resumo "de -> para" que acompanha o pedido
// de correcao: quem aprova ve o que tinha e o que passara a ter, em vez do
// nome cru do campo (contagens sem R$, valores em R$)
const NOMES_CAMPOS_ENTREGA = {
  entrega: 'Entregas', retorno: 'Retornos', extra: 'Extras', bonus: 'Bônus',
  pos00hs: 'Pós 00hs', foraDeArea: 'Fora de área', ajudaCusto: 'Ajuda de custo',
  valor: 'Valor', coopRecebe: 'Coop recebe', quantTotal: 'Quant. total',
};
const CAMPOS_MOEDA_ENTREGA = ['ajudaCusto', 'valor', 'coopRecebe'];
function fmtValorEntrega(campo, valor) {
  const n = num(valor);
  if (!CAMPOS_MOEDA_ENTREGA.includes(campo)) return String(n);
  return `${n < 0 ? '-' : ''}R$ ${Math.abs(n).toFixed(2).replace('.', ',')}`;
}
function montarResumoMudancasEntrega(pedido, atual) {
  return Object.entries(pedido.mudancas || {}).map(([campo, valor]) => {
    const anterior = atual[campo] != null ? fmtValorEntrega(campo, atual[campo]) : 'não tinha';
    return `${NOMES_CAMPOS_ENTREGA[campo] || campo}: ${anterior} → ${fmtValorEntrega(campo, valor)}`;
  });
}

async function solicitarEdicao({ entregaId, mudancas, motivo, solicitadoPorId, solicitadoPorEmail }) {
  const atual = await getOne(entregaId);
  if (!atual) throw new Error('Lançamento não encontrado.');
  if (!motivo || !String(motivo).trim()) throw new Error('Descreva o motivo da correção.');

  // 1 correcao pendente por lançamento - mesmo racional do guard de
  // fechamentos: toque duplo no celular criava pedidos identicos na fila
  const pendenteSnap = await EDITS.where('entregaId', '==', entregaId).where('status', '==', 'PENDENTE').get();
  if (!pendenteSnap.empty) throw new Error('Já existe uma correção pendente pra esse lançamento. Aguarde a decisão do Master antes de pedir outra.');
  const camposValidos = {};
  Object.entries(mudancas || {}).forEach(([campo, valor]) => {
    if (CAMPOS_NUMERICOS.includes(campo)) camposValidos[campo] = num(valor);
  });
  if (!Object.keys(camposValidos).length) throw new Error('Nenhum campo válido para corrigir.');

  const ref = EDITS.doc();
  const agora = new Date().toISOString();
  const pedido = {
    id: ref.id,
    entregaId,
    unidade: atual.unidade,
    unidadeNome: atual.unidadeNome,
    data: atual.data,
    entregador: atual.entregador,
    mudancas: camposValidos,
    resumoMudancas: [],
    motivo: String(motivo).trim(),
    status: 'PENDENTE',
    solicitadoPorId,
    solicitadoPorEmail,
    criadoEm: agora,
    decididoPorEmail: null,
    decididoEm: null,
    motivoDecisao: null,
  };
  pedido.resumoMudancas = montarResumoMudancasEntrega(pedido, atual);
  await ref.set(pedido);
  edicoesEntregaCache.invalidar();
  return pedido;
}

// campos de texto (alem dos numericos) que o Master tambem pode corrigir direto
const CAMPOS_TEXTO = ['entregador', 'obsRetorno', 'obsExtra', 'observacao'];

// edicao direta: so o Master usa isso (o resto passa por solicitarEdicao +
// decidirEdicao) - aplicada na hora, mas fica registrada no historico
async function editarDireto({ entregaId, mudancas, motivo, editadoPorEmail }) {
  const atual = await getOne(entregaId);
  if (!atual) throw new Error('Lançamento não encontrado.');
  const camposValidos = {};
  Object.entries(mudancas || {}).forEach(([campo, valor]) => {
    if (CAMPOS_NUMERICOS.includes(campo)) camposValidos[campo] = num(valor);
    else if (CAMPOS_TEXTO.includes(campo)) camposValidos[campo] = String(valor ?? '').slice(0, 500);
  });
  if (!Object.keys(camposValidos).length) throw new Error('Nenhum campo válido para alterar.');

  const valoresAnteriores = {};
  Object.keys(camposValidos).forEach((campo) => { valoresAnteriores[campo] = atual[campo]; });

  const historico = [...(atual.historico || []), {
    em: new Date().toISOString(),
    por: editadoPorEmail,
    motivo: (motivo && String(motivo).trim()) || '(edição direta do Master)',
    valoresAnteriores,
    valoresNovos: camposValidos,
  }];

  const ref = COLLECTION.doc(entregaId);
  await ref.update({ ...camposValidos, historico, atualizadoEm: new Date().toISOString() });
  entregasCache.invalidar();
  return { ...atual, ...camposValidos, historico };
}


// cache de 20s, mesmo racional da fila de edicoes de fechamento
// (fechamentosLive.js): evita reler a colecao inteira a cada visita da tela
async function listarEdicoesUncached() {
  const snap = await EDITS.orderBy('criadoEm', 'desc').get();
  const pedidos = snap.docs.map((d) => d.data());
  // pedidos criados antes do resumo "de -> para" existir ganham o resumo na
  // leitura, enquanto PENDENTES (o lançamento ainda tem os valores antigos)
  for (const p of pedidos) {
    if (p.status !== 'PENDENTE' || (p.resumoMudancas || []).length) continue;
    try {
      const atual = await getOne(p.entregaId);
      if (atual) p.resumoMudancas = montarResumoMudancasEntrega(p, atual);
    } catch (e) { /* sem resumo, o pedido segue mostrando so as mudancas cruas */ }
  }
  return pedidos;
}
const edicoesEntregaCache = createCache(listarEdicoesUncached, 5 * 60 * 1000);
const listarEdicoes = edicoesEntregaCache.cached;

async function decidirEdicao(id, status, { decididoPorEmail, motivoDecisao }) {
  if (!['APROVADO', 'REJEITADO'].includes(status)) throw new Error('Status inválido.');
  const ref = EDITS.doc(id);
  const doc = await ref.get();
  if (!doc.exists) throw new Error('Pedido não encontrado.');
  const pedido = doc.data();
  if (pedido.status !== 'PENDENTE') throw new Error('Esse pedido já foi decidido.');

  await ref.update({
    status,
    decididoPorEmail,
    motivoDecisao: motivoDecisao || null,
    decididoEm: new Date().toISOString(),
  });
  edicoesEntregaCache.invalidar();

  if (status === 'APROVADO') {
    const entRef = COLLECTION.doc(pedido.entregaId);
    const entDoc = await entRef.get();
    if (entDoc.exists) {
      const atual = entDoc.data();
      const valoresAnteriores = {};
      Object.keys(pedido.mudancas).forEach((campo) => { valoresAnteriores[campo] = atual[campo]; });
      const historico = [...(atual.historico || []), {
        em: new Date().toISOString(),
        por: decididoPorEmail,
        motivo: pedido.motivo,
        valoresAnteriores,
        valoresNovos: pedido.mudancas,
      }];
      await entRef.update({ ...pedido.mudancas, historico, atualizadoEm: new Date().toISOString() });
      entregasCache.invalidar();
    }
  }
  return { ...pedido, status };
}


module.exports = {
  CAMPOS_NUMERICOS, create, listAll, listByUnidades, getOne, solicitarEdicao, listarEdicoes, decidirEdicao, editarDireto,
  invalidar: () => { entregasCache.invalidar(); edicoesEntregaCache.invalidar(); },
};
