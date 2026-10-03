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
const { createHash } = require('crypto');
const storage = require('./storage');
const { createCache } = require('./liveCache');
const entregasRegras = require('./entregasRegras');
const entregadoresEntregas = require('./entregadoresEntregas');

const COLLECTION = db.collection('entregasLive');
const EDITS = db.collection('entregaEdicoes');
const DIAS = db.collection('entregaDias');

function nomeEntregadorNormalizado(nome) {
  return String(nome || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR');
}
async function prepararIdentidadeCorrecao(atual, mudancas) {
  if ('data' in mudancas) {
    const data = String(mudancas.data || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || !Number.isFinite(Date.parse(data)) || new Date(data).toISOString().slice(0, 10) !== data) throw new Error('Data inválida.');
    mudancas.data = data;
  }
  if ('entregador' in mudancas) {
    const nome = String(mudancas.entregador || '').trim();
    if (!nome) throw new Error('Nome do entregador é obrigatório.');
    const regra = await entregasRegras.getPara(atual.unidade);
    const cadastrados = atual.tipoRecebedor === 'empresa'
      ? (regra.empresas || [])
      : await entregadoresEntregas.listarTodos(atual.unidade);
    const encontrado = cadastrados.find(item => item.ativo !== false && nomeEntregadorNormalizado(item.nome) === nomeEntregadorNormalizado(nome));
    if (cadastrados.length && !encontrado) throw new Error('Selecione um entregador ou empresa ativo cadastrado nessa unidade.');
    mudancas.entregador = encontrado?.nome || nome;
    if (encontrado?.tipo && atual.tipoRecebedor !== 'empresa') mudancas.tipoEntregador = encontrado.tipo;
  }
}
async function validarIdentidadeNaTransacao(tx, atual, mudancas) {
  if (!('data' in mudancas) && !('entregador' in mudancas)) return;
  const novo = { ...atual, ...mudancas };
  if (novo.tipoRecebedor === 'empresa') return;
  const chaveDia = createHash('sha256').update(JSON.stringify([novo.unidade, novo.data])).digest('hex');
  const diaRef = DIAS.doc(chaveDia);
  await tx.get(diaRef);
  const existentes = await tx.get(COLLECTION.where('unidade', '==', novo.unidade).where('data', '==', novo.data));
  if (existentes.docs.some(doc => {
    const outro = doc.data();
    return outro.id !== atual.id && estaAtivo(outro) && outro.tipoRecebedor !== 'empresa'
      && nomeEntregadorNormalizado(outro.entregador) === nomeEntregadorNormalizado(novo.entregador);
  })) throw new Error('Já existe um lançamento desse entregador na unidade e data escolhidas.');
  tx.set(diaRef, { unidade: novo.unidade, data: novo.data, ultimoLancamentoId: atual.id, atualizadoEm: new Date().toISOString() });
}


const CAMPOS_NUMERICOS = [
  'entrega', 'retorno', 'extra', 'bonus', 'pos00hs', 'foraDeArea',
  'ajudaCusto', 'valor', 'valorEntregas', 'garantido', 'coopRecebe', 'quantTotal',
];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function moedaManual(v) {
  const texto = String(v ?? '').trim().replace(',', '.');
  if (!/^\d+(?:\.\d{1,2})?$/.test(texto) || !Number.isFinite(Number(texto))) throw new Error('Informe um valor monetário válido, maior ou igual a zero.');
  return Number(texto);
}
function validarObservacoes(registro, alteracoes = null) {
  for (const [campo, obs, nome] of [['extra', 'obsExtra', 'Extra'], ['retorno', 'obsRetorno', 'Retorno']]) {
    if (alteracoes && !(campo in alteracoes) && !(obs in alteracoes)) continue;
    if (num(registro[campo]) > 0 && !String(registro[obs] || '').trim()) {
      throw new Error(`Informe a observação de ${nome} quando a quantidade for maior que zero.`);
    }
  }
}

function numeroInteiroPositivo(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}
function valorPositivo(v) {
  const texto = String(v ?? '').trim().replace(',', '.');
  if (!/^\d+(?:\.\d{1,2})?$/.test(texto)) return null;
  const n = Number(texto);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function completarDerivados(atual,mudancas){
  if (atual.valorEntregas != null) {
    delete mudancas.valor; // total sempre deriva dos dois valores manuais
    const novo = { ...atual, ...mudancas };
    for (const campo of ['valorEntregas', 'garantido']) {
      if (!Number.isFinite(Number(novo[campo] ?? 0)) || Number(novo[campo] ?? 0) < 0) throw new Error('Valores de entregas e garantido não podem ser negativos.');
    }
    mudancas.valor = +(num(novo.valorEntregas) + num(novo.garantido)).toFixed(2);
    mudancas.detalhesValor = [
      { campo: 'valorEntregas', label: 'Valor Entregas', valor: num(novo.valorEntregas) },
      { campo: 'garantido', label: 'Garantido', valor: num(novo.garantido) },
    ];
  } else {
    delete mudancas.valorEntregas;
    delete mudancas.garantido;
  }
  if(!atual.regraCoop)return; // registros antigos permanecem intactos
  delete mudancas.coopRecebe;delete mudancas.quantTotal;
  if(['entrega','extra','retorno'].some(c=>c in mudancas)){
    const novo={...atual,...mudancas};
    mudancas.quantTotal=['entrega','extra','retorno'].reduce((s,c)=>s+Math.max(0,num(novo[c])),0);
    mudancas.coopRecebe=entregasRegras.calcularCoop({regraCoop:atual.regraCoop},novo.entrega);
  }
}

async function create({ unidade, unidadeNome, data, entregador, tipoEntregador, tipoRecebedor, campos, obsRetorno, obsExtra, observacao, camposRemovidos, motivoRemocaoCampos, etiquetaFile, criadoPorId, criadoPorEmail }) {
  if (!unidade) throw new Error('Unidade é obrigatória.');
  if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(data)) throw new Error('Data inválida.');
  if (!entregador || !String(entregador).trim()) throw new Error('Nome do entregador é obrigatório.');

  const ref = COLLECTION.doc();
  const registro = { id: ref.id, unidade, unidadeNome: unidadeNome || unidade, data, entregador: String(entregador).trim(), tipoEntregador: String(tipoEntregador || '').trim() || null };
  CAMPOS_NUMERICOS.forEach((c) => { registro[c] = num(campos?.[c]); });
  delete registro.valorEntregas;
  delete registro.garantido;

  // unidade com regra "fixo": o servidor calcula ajudaCusto/valor/coopRecebe
  // a partir das contagens + da lista de campos de valor da unidade (ver
  // entregasRegras.js) - nunca confia no que o cliente mandou pra esses
  // campos (evita loja "ajustar" o próprio pagamento). Unidade "plataforma"
  // (sem valor fixo, ex: paga o que a GAMI/NEXT informar) mantém os valores
  // digitados normalmente.
  const regra = await entregasRegras.getPara(unidade);
  const entregadoresFixos = Array.isArray(regra.entregadoresFixos) ? regra.entregadoresFixos : [];
  const empresas = Array.isArray(regra.empresas) ? regra.empresas : [];
  const empresa = empresas.find((item) => item.nome.toLocaleLowerCase('pt-BR') === registro.entregador.toLocaleLowerCase('pt-BR'));
  const ehEmpresa = tipoRecebedor === 'empresa' || !!empresa;
  let entregadorCadastrado = null;
  let temCadastroDeEntregadores = false;
  if (!ehEmpresa && regra.modeloLancamento !== 'total') {
    const cadastrados = await entregadoresEntregas.listarTodos(unidade);
    temCadastroDeEntregadores = cadastrados.length > 0;
    entregadorCadastrado = cadastrados.find((item) => item.ativo !== false
      && item.nome.toLocaleLowerCase('pt-BR') === registro.entregador.toLocaleLowerCase('pt-BR')) || null;
    if (temCadastroDeEntregadores && !entregadorCadastrado) {
      throw new Error('Selecione um entregador ativo cadastrado para essa unidade.');
    }
    if (entregadorCadastrado) registro.entregador = entregadorCadastrado.nome;
  }
  const pagamentoManual = !!entregadorCadastrado && entregadoresEntregas.pagamentoConfigurado(entregadorCadastrado, regra) === 'manual';
  if (entregadorCadastrado) {
    registro.tipoRecebedor = 'entregador';
    registro.tipoEntregador = entregadorCadastrado.tipo || 'OUTRO';
    registro.categoriaEntregador = entregadoresEntregas.categoriaNome(entregadorCadastrado);
    registro.modoPagamento = entregadoresEntregas.pagamentoConfigurado(entregadorCadastrado, regra);
  }
  if (ehEmpresa) {
    if (!empresa) throw new Error('Selecione uma empresa/plataforma cadastrada para essa unidade.');
    const quantidade = numeroInteiroPositivo(campos?.entrega);
    if (quantidade == null) throw new Error('Informe uma quantidade inteira de entregas maior que zero.');
    const valorTotal = empresa.modo === 'fixo'
      ? +(quantidade * empresa.valorEntrega).toFixed(2)
      : valorPositivo(campos?.valor);
    if (valorTotal == null) throw new Error('Informe o valor total maior que zero.');
    Object.assign(registro, {
      entregador: empresa.nome, tipoRecebedor: 'empresa', empresaModo: empresa.modo,
      entrega: quantidade, retorno: 0, extra: 0, bonus: 0, pos00hs: 0, foraDeArea: 0,
      ajudaCusto: 0, valor: valorTotal, coopRecebe: 0, quantTotal: quantidade,
      detalhesValor: [{
        campo: 'entrega', label: empresa.nome, base: 'entrega', quantidade,
        taxa: empresa.modo === 'fixo' ? empresa.valorEntrega : null, valor: valorTotal,
      }],
    });
  } else if (pagamentoManual || regra.modeloLancamento === 'total') {
    const quantidade = numeroInteiroPositivo(campos?.entrega);
    const valorTotal = valorPositivo(campos?.valor);
    if (quantidade == null) throw new Error('Informe uma quantidade inteira de entregas maior que zero.');
    if (valorTotal == null) throw new Error('Informe o valor total maior que zero.');
    Object.assign(registro, {
      entrega: quantidade, retorno: 0, extra: 0, bonus: 0, pos00hs: 0, foraDeArea: 0,
      ajudaCusto: 0, valor: valorTotal, coopRecebe: 0, quantTotal: quantidade,
      modeloLancamento: 'total', detalhesValor: [{ campo: 'valorTotal', label: 'Valor total informado', valor: valorTotal }],
      camposRemovidos: [], motivoRemocaoCampos: null,
    });
    if (pagamentoManual) {
      const garantidoTexto = String(campos?.garantido ?? 0).trim().replace(',', '.');
      if (!/^\d+(?:\.\d{1,2})?$/.test(garantidoTexto)) throw new Error('Informe um garantido válido, maior ou igual a zero.');
      registro.valorEntregas = valorTotal;
      registro.garantido = Number(garantidoTexto);
      if (!Number.isFinite(registro.garantido)) throw new Error('Garantido inválido.');
      completarDerivados(registro, registro);
    }
  } else if (regra.modo === 'fixo') {
    // Mantém compatibilidade com regras antigas até que os nomes digitados
    // manualmente sejam cadastrados na nova tela de entregadores.
    const nomeLegado = !temCadastroDeEntregadores && entregadoresFixos.find((nome) => nome.toLocaleLowerCase('pt-BR') === registro.entregador.toLocaleLowerCase('pt-BR'));
    if (!entregadorCadastrado && !nomeLegado) throw new Error('Selecione um entregador ativo cadastrado para essa unidade.');
    registro.entregador = entregadorCadastrado?.nome || nomeLegado;
    registro.tipoRecebedor = 'entregador';
  }
  const camposValidosRemovidos = (ehEmpresa || pagamentoManual || regra.modeloLancamento === 'total') ? [] : (Array.isArray(camposRemovidos)
    ? camposRemovidos.filter((c) => (regra.camposValor || []).some((r) => r.campo === c && r.removivelPelaLoja))
    : []);
  registro.camposRemovidos = camposValidosRemovidos;
  registro.motivoRemocaoCampos = camposValidosRemovidos.length
    ? (entregasRegras.MOTIVOS_REMOCAO_CAMPO.includes(motivoRemocaoCampos) ? motivoRemocaoCampos : 'outro')
    : null;
  if (!ehEmpresa && !pagamentoManual && regra.modeloLancamento !== 'total') registro.detalhesValor = [];
  if (!ehEmpresa && !pagamentoManual && regra.modo === 'fixo' && regra.modeloLancamento !== 'total') {
    const calculado = entregasRegras.calcular(regra, {
      data: registro.data, entrega: registro.entrega, retorno: registro.retorno, extra: registro.extra, pos00hs: registro.pos00hs, foraDeArea: registro.foraDeArea,
      camposRemovidos: camposValidosRemovidos,
    });
    registro.ajudaCusto = calculado.ajudaCusto;
    registro.valor = calculado.valor;
    registro.coopRecebe = calculado.coopRecebe;
    registro.quantTotal = calculado.quantTotal;
    registro.detalhesValor = calculado.detalhesValor;
    registro.bonus = 0; // Bônus (Gami/NEXT) só existe em unidade "plataforma" - ver abaixo
  }

  // O servidor sempre sobrescreve o repasse, inclusive no modo manual.
  // Nunca confiar em COOP recebe/Quantidade total enviados pelo navegador.
  registro.coopRecebe=entregasRegras.calcularCoop(regra,registro.entrega);
  registro.quantTotal=Math.max(0,num(registro.entrega))+Math.max(0,num(registro.extra))+Math.max(0,num(registro.retorno));
  registro.regraCoop=entregasRegras.configuracaoCoop(regra);
  registro.obsRetorno = obsRetorno || null;
  registro.obsExtra = obsExtra || null;
  validarObservacoes(registro);
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

  if (ehEmpresa) {
    await ref.set(registro);
  } else {
    // A trava por unidade/data serializa lançamentos concorrentes. A consulta
    // também encontra registros antigos, criados antes desta validação.
    const chaveDia = createHash('sha256').update(JSON.stringify([unidade, data])).digest('hex');
    const diaRef = DIAS.doc(chaveDia);
    await db.runTransaction(async (tx) => {
      await tx.get(diaRef);
      const existentes = await tx.get(COLLECTION.where('unidade', '==', unidade).where('data', '==', data));
      const nome = nomeEntregadorNormalizado(registro.entregador);
      const duplicado = existentes.docs.some((doc) => {
        const anterior = doc.data();
        return estaAtivo(anterior) && anterior.tipoRecebedor !== 'empresa'
          && nomeEntregadorNormalizado(anterior.entregador) === nome;
      });
      if (duplicado) {
        throw new Error(`Já existe um lançamento de ${registro.entregador} nesta unidade em ${data.split('-').reverse().join('/')}. Para corrigir, solicite a edição do lançamento existente.`);
      }
      tx.set(diaRef, { unidade, data, ultimoLancamentoId: ref.id, atualizadoEm: agora });
      tx.set(ref, registro);
    });
  }
  entregasCache.invalidar();
  return registro;
}

async function listAllUncached() {
  const snap = await COLLECTION.orderBy('data', 'desc').get();
  return snap.docs.map((d) => d.data());
}
const entregasCache = createCache(listAllUncached, 5 * 60 * 1000);
const listarComHistorico = entregasCache.cached;
const estaAtivo = (registro) => !['CANCELADO', 'EXCLUIDO'].includes(registro.situacao);
async function listAll() { return (await listarComHistorico()).filter(estaAtivo); }


// filtra EM MEMORIA sobre o cache compartilhado - a query direta por
// unidade (where in) nao passava pelo cache e virava uma leitura completa
// no Firestore a cada chamada (ver o estouro de leituras de 2026-08-09)
async function listByUnidades(unidades, incluirInativos = false) {
  if (!unidades || !unidades.length) return [];
  const alvo = new Set(unidades);
  return (await (incluirInativos ? listarComHistorico() : listAll())).filter((r) => alvo.has(r.unidade));
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
  valor: 'Valor', valorEntregas: 'Valor Entregas', garantido: 'Garantido', coopRecebe: 'Coop recebe', quantTotal: 'Quant. total',
};
const CAMPOS_MOEDA_ENTREGA = ['ajudaCusto', 'valor', 'valorEntregas', 'garantido', 'coopRecebe'];
function fmtValorEntrega(campo, valor) {
  const n = num(valor);
  if (!CAMPOS_MOEDA_ENTREGA.includes(campo)) return String(n);
  return `${n < 0 ? '-' : ''}R$ ${Math.abs(n).toFixed(2).replace('.', ',')}`;
}
function montarResumoMudancasEntrega(pedido, atual) {
  return Object.entries(pedido.mudancas || {}).map(([campo, valor]) => {
    if (['data', 'entregador', 'tipoEntregador'].includes(campo)) return `${campo === 'data' ? 'Data' : campo === 'entregador' ? 'Entregador' : 'Tipo do entregador'}: ${atual[campo] || 'não tinha'} → ${valor}`;
    if (['obsExtra', 'obsRetorno'].includes(campo)) return `${campo === 'obsExtra' ? 'Obs. Extra' : 'Obs. Retorno'}: ${atual[campo] || 'não tinha'} → ${valor || 'vazio'}`;
    const anterior = atual[campo] != null ? fmtValorEntrega(campo, atual[campo]) : 'não tinha';
    return `${NOMES_CAMPOS_ENTREGA[campo] || campo}: ${anterior} → ${fmtValorEntrega(campo, valor)}`;
  });
}

async function solicitarEdicao({ entregaId, mudancas, motivo, solicitadoPorId, solicitadoPorEmail }) {
  const atual = await getOne(entregaId);
  if (!atual) throw new Error('Lançamento não encontrado.');
  if (!estaAtivo(atual)) throw new Error('Lançamento cancelado ou excluído não pode ser corrigido.');
  if (!motivo || !String(motivo).trim()) throw new Error('Descreva o motivo da correção.');

  // 1 correcao pendente por lançamento - mesmo racional do guard de
  // fechamentos: toque duplo no celular criava pedidos identicos na fila
  const pendenteSnap = await EDITS.where('entregaId', '==', entregaId).where('status', '==', 'PENDENTE').get();
  if (!pendenteSnap.empty) throw new Error('Já existe uma correção pendente pra esse lançamento. Aguarde a decisão do Master antes de pedir outra.');
  const camposValidos = {};
  Object.entries(mudancas || {}).forEach(([campo, valor]) => {
    if (CAMPOS_NUMERICOS.includes(campo)) camposValidos[campo] = ['valorEntregas', 'garantido'].includes(campo) ? moedaManual(valor) : num(valor);
    else if (['data', 'entregador', 'obsExtra', 'obsRetorno'].includes(campo)) camposValidos[campo] = String(valor || '').trim().slice(0, 500);
  });
  if (atual.modeloLancamento === 'total') {
    const permitidos = new Set(['entrega', ...(atual.valorEntregas != null ? ['valorEntregas', 'garantido'] : ['valor']), 'data', 'entregador']);
    Object.keys(camposValidos).forEach((campo) => { if (!permitidos.has(campo)) delete camposValidos[campo]; });
    if ('entrega' in camposValidos && numeroInteiroPositivo(camposValidos.entrega) == null) throw new Error('Quantidade de entregas precisa ser um inteiro maior que zero.');
    if ('valor' in camposValidos && valorPositivo(camposValidos.valor) == null) throw new Error('Valor total precisa ser maior que zero.');
    if ('entrega' in camposValidos) camposValidos.quantTotal = camposValidos.entrega;
  }
  await prepararIdentidadeCorrecao(atual, camposValidos);
  completarDerivados(atual,camposValidos);
  validarObservacoes({ ...atual, ...camposValidos }, camposValidos);
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
const CAMPOS_TEXTO = ['data', 'entregador', 'obsRetorno', 'obsExtra', 'observacao'];

// edicao direta: so o Master usa isso (o resto passa por solicitarEdicao +
// decidirEdicao) - aplicada na hora, mas fica registrada no historico
async function editarDireto({ entregaId, mudancas, motivo, editadoPorEmail }) {
  const atual = await getOne(entregaId);
  if (!atual) throw new Error('Lançamento não encontrado.');
  if (!estaAtivo(atual)) throw new Error('Lançamento cancelado ou excluído não pode ser editado.');
  const camposValidos = {};
  Object.entries(mudancas || {}).forEach(([campo, valor]) => {
    if (CAMPOS_NUMERICOS.includes(campo)) camposValidos[campo] = ['valorEntregas', 'garantido'].includes(campo) ? moedaManual(valor) : num(valor);
    else if (CAMPOS_TEXTO.includes(campo)) camposValidos[campo] = String(valor ?? '').slice(0, 500);
  });
  if (atual.modeloLancamento === 'total') {
    const permitidos = new Set(['entrega', ...(atual.valorEntregas != null ? ['valorEntregas', 'garantido'] : ['valor']), 'data', 'entregador']);
    Object.keys(camposValidos).forEach((campo) => { if (!permitidos.has(campo)) delete camposValidos[campo]; });
    if ('entrega' in camposValidos && numeroInteiroPositivo(camposValidos.entrega) == null) throw new Error('Quantidade de entregas precisa ser um inteiro maior que zero.');
    if ('valor' in camposValidos && valorPositivo(camposValidos.valor) == null) throw new Error('Valor total precisa ser maior que zero.');
    if ('entrega' in camposValidos) camposValidos.quantTotal = camposValidos.entrega;
  }
  await prepararIdentidadeCorrecao(atual, camposValidos);
  completarDerivados(atual,camposValidos);
  if (!Object.keys(camposValidos).length) throw new Error('Nenhum campo válido para alterar.');

  const ref = COLLECTION.doc(entregaId);
  const registro = await db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    if (!doc.exists) throw new Error('Lançamento não encontrado.');
    const recente = doc.data();
    if (!estaAtivo(recente)) throw new Error('Lançamento cancelado ou excluído não pode ser editado.');
    await validarIdentidadeNaTransacao(tx, recente, camposValidos);
    completarDerivados(recente, camposValidos);
    validarObservacoes({ ...recente, ...camposValidos }, camposValidos);
    const valoresAnteriores = {};
    Object.keys(camposValidos).forEach(c => { valoresAnteriores[c] = recente[c]; });
    const agora = new Date().toISOString();
    const historico = [...(recente.historico || []), { em: agora, por: editadoPorEmail,
      motivo: (motivo && String(motivo).trim()) || '(edição direta do Master)',
      valoresAnteriores, valoresNovos: camposValidos }];
    tx.update(ref, { ...camposValidos, historico, atualizadoEm: agora });
    return { ...recente, ...camposValidos, historico };
  });
  entregasCache.invalidar();
  return registro;
}


// cache de 20s, mesmo racional da fila de edicoes de fechamento
// (fechamentosLive.js): evita reler a colecao inteira a cada visita da tela
async function listarEdicoesUncached() {
  const snap = await EDITS.orderBy('criadoEm', 'desc').get();
  const pedidos = snap.docs.map((d) => d.data());
  // pedidos criados antes do resumo "de -> para" existir ganham o resumo na
  // leitura, enquanto PENDENTES (o lançamento ainda tem os valores antigos)
  const precisamResumo = pedidos.filter((p) => p.status === 'PENDENTE' && !(p.resumoMudancas || []).length);
  if (!precisamResumo.length) return pedidos;
  // uma leitura (do cache) no lugar de um getOne por pedido - mesmo N+1 que
  // foi corrigido na fila de edicoes de fechamento (fechamentosLive.js)
  const porId = new Map((await listAll()).map((e) => [e.id, e]));
  for (const p of precisamResumo) {
    try {
      const atual = porId.get(p.entregaId);
      if (atual) p.resumoMudancas = montarResumoMudancasEntrega(p, atual);
    } catch (e) { /* sem resumo, o pedido segue mostrando so as mudancas cruas */ }
  }
  return pedidos;
}
const edicoesEntregaCache = createCache(listarEdicoesUncached, 5 * 60 * 1000);
const listarEdicoes = edicoesEntregaCache.cached;

function situacaoAcao(tipoAcao) {
  if (tipoAcao === 'cancelar') return 'CANCELADO';
  if (tipoAcao === 'excluir') return 'EXCLUIDO';
  throw new Error('Ação inválida.');
}
function patchAcao(atual, tipoAcao, motivo, por, pedidoId = null) {
  const situacao = situacaoAcao(tipoAcao);
  if (!estaAtivo(atual)) throw new Error('Lançamento já cancelado ou excluído.');
  const agora = new Date().toISOString();
  return { situacao, atualizadoEm: agora, historico: [...(atual.historico || []), {
    em: agora, por, motivo, tipoAcao, pedidoId,
    valoresAnteriores: { situacao: atual.situacao || 'ATIVO' }, valoresNovos: { situacao },
  }] };
}
async function solicitarAcao({ entregaId, tipoAcao, motivo, solicitadoPorId, solicitadoPorEmail }) {
  situacaoAcao(tipoAcao);
  motivo = String(motivo || '').trim();
  if (!motivo) throw new Error('Descreva o motivo da solicitação.');
  const entRef = COLLECTION.doc(entregaId), ref = EDITS.doc();
  const pedido = await db.runTransaction(async (tx) => {
    const doc = await tx.get(entRef);
    if (!doc.exists) throw new Error('Lançamento não encontrado.');
    const atual = doc.data();
    if (!estaAtivo(atual)) throw new Error('Lançamento já cancelado ou excluído.');
    const pendentes = await tx.get(EDITS.where('entregaId', '==', entregaId).where('status', '==', 'PENDENTE'));
    if (!pendentes.empty) throw new Error('Já existe uma solicitação pendente para esse lançamento.');
    const novo = { id: ref.id, entregaId, tipoAcao, unidade: atual.unidade, unidadeNome: atual.unidadeNome || atual.unidade,
      data: atual.data, entregador: atual.entregador, mudancas: {},
      resumoMudancas: [tipoAcao === 'cancelar' ? 'Cancelar lançamento e retirar dos totais.' : 'Excluir lançamento dos totais, preservando o histórico.'],
      motivo, status: 'PENDENTE', solicitadoPorId, solicitadoPorEmail, criadoEm: new Date().toISOString(),
      decididoPorEmail: null, decididoEm: null, motivoDecisao: null };
    tx.set(ref, novo);
    return novo;
  });
  edicoesEntregaCache.invalidar();
  return pedido;
}
async function acaoDireta({ entregaId, tipoAcao, motivo, editadoPorEmail }) {
  motivo = String(motivo || '').trim();
  if (!motivo) throw new Error('Descreva o motivo da ação.');
  const ref = COLLECTION.doc(entregaId);
  const registro = await db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    if (!doc.exists) throw new Error('Lançamento não encontrado.');
    const atual = doc.data(), patch = patchAcao(atual, tipoAcao, motivo, editadoPorEmail);
    tx.update(ref, patch);
    return { ...atual, ...patch };
  });
  entregasCache.invalidar(); edicoesEntregaCache.invalidar();
  return registro;
}
async function decidirEdicao(id, status, { decididoPorEmail, motivoDecisao }) {
  if (!['APROVADO', 'REJEITADO'].includes(status)) throw new Error('Status inválido.');
  const ref = EDITS.doc(id);
  const resultado = await db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    if (!doc.exists) throw new Error('Pedido não encontrado.');
    const pedido = doc.data();
    if (pedido.status !== 'PENDENTE') throw new Error('Esse pedido já foi decidido.');
    if (status === 'APROVADO') {
      const entRef = COLLECTION.doc(pedido.entregaId), entDoc = await tx.get(entRef);
      if (!entDoc.exists) throw new Error('Lançamento não encontrado.');
      const atual = entDoc.data();
      if (!estaAtivo(atual)) throw new Error('Lançamento já cancelado ou excluído. Rejeite a solicitação.');
      let patch;
      if (pedido.tipoAcao) patch = patchAcao(atual, pedido.tipoAcao, pedido.motivo, decididoPorEmail, id);
      else {
        const mudancas = { ...pedido.mudancas };
        await prepararIdentidadeCorrecao(atual, mudancas);
        await validarIdentidadeNaTransacao(tx, atual, mudancas);
        completarDerivados(atual, mudancas);
        validarObservacoes({ ...atual, ...mudancas }, mudancas);
        const valoresAnteriores = {};
        Object.keys(mudancas).forEach(c => { valoresAnteriores[c] = atual[c]; });
        patch = { ...mudancas, atualizadoEm: new Date().toISOString(), historico: [...(atual.historico || []), {
          em: new Date().toISOString(), por: decididoPorEmail, motivo: pedido.motivo, pedidoId: id,
          valoresAnteriores, valoresNovos: mudancas,
        }] };
      }
      tx.update(entRef, patch);
    }
    const decisao = { status, decididoPorEmail, motivoDecisao: motivoDecisao || null, decididoEm: new Date().toISOString() };
    tx.update(ref, decisao);
    return { ...pedido, ...decisao };
  });
  edicoesEntregaCache.invalidar(); entregasCache.invalidar();
  return resultado;
}


module.exports = {
  CAMPOS_NUMERICOS, create, listAll, listarComHistorico, listByUnidades, getOne, solicitarEdicao, solicitarAcao, acaoDireta, listarEdicoes, decidirEdicao, editarDireto,
  invalidar: () => { entregasCache.invalidar(); edicoesEntregaCache.invalidar(); },
};
