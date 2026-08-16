// festas.js
// Reservas de festa (Saltiverso Patteo) - agenda de eventos com sinal/
// restante e status de pagamento. Mesmo padrao de sangrias.js/parque.js:
// colecao Firestore propria, cache curto via liveCache.js.
const crypto = require('crypto');
const db = require('./firestore');
const { createCache } = require('./liveCache');
const users = require('./users');
const auth = require('./auth');

const COLLECTION = db.collection('festas');

const STATUS_VALIDOS = ['pendente', 'pagamento-parcial', 'pago', 'cancelado'];

// tabela oficial de venda de festas (trampolins + espaço festa), por
// Missão x horas x saltonautas (quantidade de pulantes) - PADRAO usado so
// como seed do 1o boot (nunca mais lido depois disso, ver getTabela). As
// promocoes mudam com frequencia, entao a tabela de verdade vive no
// Firestore e e editavel pelo Master direto em festas.html - ver
// salvarTabela() e a rota PUT /api/festas/tabela em index.js
//  - Missão Lunar:    seg a qui, 13h às 16h
//  - Missão Órbita:   seg a qui 18h às 21h · sex 13h às 21h
//  - Missão Nebulosa: sáb, dom e feriados
const TABELA_FESTAS_PADRAO = {
  lunar: {
    label: 'Missão Lunar', janela: 'seg a qui · 13h às 16h', ativa: true,
    precos: { 1: { 10: 599, 20: 999, 30: 1299, 40: 1699 }, 2: { 10: 999, 20: 1499, 30: 2099, 40: 2599 }, 3: { 10: 1299, 20: 2299, 30: 3099, 40: 3999 } },
  },
  orbita: {
    label: 'Missão Órbita', janela: 'seg a qui 18h às 21h · sex 13h às 21h', ativa: true,
    precos: { 1: { 10: 699, 20: 1099, 30: 1499, 40: 1799 }, 2: { 10: 1099, 20: 1699, 30: 2299, 40: 2999 }, 3: { 10: 1399, 20: 2399, 30: 3399, 40: 4299 } },
  },
  nebulosa: {
    label: 'Missão Nebulosa', janela: 'sáb, dom e feriados', ativa: true,
    precos: { 1: { 10: 799, 20: 1199, 30: 1599, 40: 1999 }, 2: { 10: 1399, 20: 2299, 30: 3099, 40: 3999 }, 3: { 10: 1799, 20: 3099, 30: 4399, 40: 5699 } },
  },
};
const HORAS_VALIDAS = [1, 2, 3];
// colunas de saltonautas (quantidade de pulantes) da tabela de precos -
// PADRAO usado so no seed do 1o boot; depois disso quem manda e o array
// gravado em Firestore (saltonautasColunas), editavel pelo Master em
// "Editar tabela de precos" - tanto os VALORES quanto a QUANTIDADE de
// colunas podem mudar (ex: 10/15/25/30/40), nao so os precos
const SALTONAUTAS_PADRAO = [10, 20, 30, 40];

const TABELA_DOC = db.collection('festasConfig').doc('tabela');
const tabelaCache = createCache(async () => {
  const snap = await TABELA_DOC.get();
  const data = snap.exists ? snap.data() : {};
  return {
    missoes: data.missoes || TABELA_FESTAS_PADRAO,
    saltonautasColunas: Array.isArray(data.saltonautasColunas) && data.saltonautasColunas.length ? data.saltonautasColunas : SALTONAUTAS_PADRAO,
  };
}, 5 * 60 * 1000);
const getTabela = tabelaCache.cached;

// codigo (chave no objeto missoes) e a identidade da Missao - reservas ja
// lancadas gravam esse codigo direto (nao o label), entao precisa ser
// estavel: so letras minusculas/numeros/hifen, sem acento/espaco
function sanitizarCodigoMissao(codigo) {
  const limpo = String(codigo || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (limpo.length < 2 || limpo.length > 30) throw new Error(`Código de Missão inválido: "${codigo}" (use só letras minúsculas, números ou hífen - 2 a 30 caracteres).`);
  return limpo;
}

// colunas de saltonautas: numeros inteiros positivos, unicos, 2 a 8
// colunas (menos de 2 nao faz sentido de tabela; mais de 8 vira ilegivel
// no grid). Ordenado crescente pra ficar previsivel na UI
function sanitizarSaltonautasColunas(lista) {
  const nums = (Array.isArray(lista) ? lista : []).map((v) => Math.round(num(v))).filter((v) => v > 0);
  const unicos = [...new Set(nums)].sort((a, b) => a - b);
  if (unicos.length < 2) throw new Error('Informe pelo menos 2 colunas de saltonautas.');
  if (unicos.length > 8) throw new Error('No máximo 8 colunas de saltonautas.');
  return unicos;
}

function sanitizarMissaoConfig(m, saltonautasColunas) {
  const label = String(m?.label || '').trim().slice(0, 60);
  const janela = String(m?.janela || '').trim().slice(0, 80);
  if (!label) throw new Error('Cada Missão precisa de um nome.');
  const precos = {};
  for (const h of HORAS_VALIDAS) {
    precos[h] = {};
    for (const s of saltonautasColunas) {
      const v = num(m?.precos?.[h]?.[s]);
      if (v <= 0) throw new Error(`Preço inválido em "${label}" (${h}H · ${s} saltonautas).`);
      precos[h][s] = v;
    }
  }
  // "ativa" controla so a visibilidade no seletor de NOVAS reservas
  // (ver /api/festas/tabela + ocultarMissao em festas.html) - nunca apaga
  // de verdade, entao reserva antiga que ja usou esse codigo nunca fica
  // orfa e o Master pode reativar a qualquer momento
  return { label, janela, precos, ativa: m?.ativa !== false };
}

// salva a tabela inteira de uma vez (Master, ver rota PUT /api/festas/tabela)
// - Missoes sao identificadas pelo codigo (chave do objeto); o Master pode
// criar quantas quiser (ver adicionarNovaMissao em festas.html) e ocultar
// (nunca apagar de verdade) uma existente - merge:true no Firestore
// preserva qualquer chave antiga que por acaso nao vier no payload. As
// colunas de saltonautas tambem sao editaveis (valores E quantidade) -
// trocar a lista aqui muda o "cardapio" de precos de TODAS as Missoes
async function salvarTabela({ missoes, saltonautasColunas } = {}) {
  const colunas = sanitizarSaltonautasColunas(saltonautasColunas);
  const entradas = Object.entries(missoes || {});
  if (!entradas.length) throw new Error('Informe pelo menos uma Missão.');
  const nova = {};
  for (const [codigoBruto, m] of entradas) {
    const codigo = sanitizarCodigoMissao(codigoBruto);
    if (nova[codigo]) throw new Error(`Código de Missão duplicado: "${codigo}".`);
    nova[codigo] = sanitizarMissaoConfig(m, colunas);
  }
  await TABELA_DOC.set({ missoes: nova, saltonautasColunas: colunas, atualizadoEm: new Date().toISOString() }, { merge: true });
  tabelaCache.invalidar();
  return getTabela();
}

function valorFesta(missao, horas, saltonautas, tabela) {
  const m = tabela?.[missao];
  if (!m) return null;
  const porHora = m.precos[Number(horas)];
  if (!porHora) return null;
  return porHora[Number(saltonautas)] ?? null;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// codigo curto tipo "SVPA3F9K" (iniciais SVP - Saltiverso Patteo - + 5
// caracteres aleatorios numeros/letras) - nao precisa ser criptografico,
// so legivel e facil de citar por telefone. Sem O/0 e I/1 (ambiguos de
// ouvir/ler em voz alta)
const CODIGO_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function gerarCodigo() {
  const bytes = crypto.randomBytes(5);
  let sufixo = '';
  for (let i = 0; i < 5; i += 1) sufixo += CODIGO_CHARSET[bytes[i] % CODIGO_CHARSET.length];
  return `SVP${sufixo}`;
}

function sanitizarPagamento(p) {
  if (!p) return null;
  const valor = num(p.valor);
  if (!valor) return null;
  return {
    valor,
    forma: String(p.forma || '').trim().slice(0, 40),
    data: p.data || null,
  };
}

// quanto ja entrou de verdade nessa reserva: o sinal registrado na venda +
// os recebimentos lancados depois (livro-razao imutavel - ver
// registrarRecebimento). O campo "restante" e so o COMBINADO de como o
// resto vai ser pago, nao conta como dinheiro recebido
function totalRecebido(f) {
  const sinal = num(f.sinal && f.sinal.valor);
  const recebs = (f.recebimentos || []).reduce((s, r) => s + num(r.valor), 0);
  return sinal + recebs;
}
function restanteDevido(f) {
  return Math.max(0, num(f.valorTotal) - totalRecebido(f));
}

// desconto simples: percentual sobre o valor total, mas NUNCA sem alcada -
// exige login+senha de alguem com autoridade pra aprovar na hora (gerente/
// assistente-gerente da loja, ou Admin/Master), igual um "PIN de gerente"
// de PDV. Nunca guarda a senha, so quem autorizou e quando (ver criar())
function podeAutorizarDesconto(user) {
  if (!user || user.active === false || user.locked) return false;
  return user.role === 'master' || !!user.isAdmin || user.cargo === 'gerente' || user.cargo === 'assistente-gerente';
}

async function autorizarDesconto(percentual, gerenteUsername, gerenteSenha) {
  const pct = num(percentual);
  if (pct <= 0 || pct > 90) throw new Error('Desconto deve ser um percentual entre 1 e 90.');
  const usuarioAlvo = String(gerenteUsername || '').trim();
  if (!usuarioAlvo || !String(gerenteSenha || '')) {
    throw new Error('Desconto exige usuário e senha de quem autorizou (Gerente/Admin/Master).');
  }
  const alvo = await users.findByIdentifier(usuarioAlvo);
  if (!alvo || !podeAutorizarDesconto(alvo)) {
    throw new Error('Esse usuário não tem autorização pra liberar desconto.');
  }
  const senhaOk = await auth.verifyPassword(alvo.id, gerenteSenha);
  if (!senhaOk) throw new Error('Senha incorreta.');
  return { pct, autorizadoPorId: alvo.id, autorizadoPorUsername: alvo.username || usuarioAlvo, autorizadoPorEmail: alvo.email || null };
}

// status financeiro derivado do que realmente entrou - nunca digitado:
// tudo recebido = pago; parte recebida = pagamento-parcial; nada = pendente
function statusPorPagamento(f) {
  const total = num(f.valorTotal);
  const recebido = totalRecebido(f);
  if (total > 0 && recebido >= total) return 'pago';
  if (recebido > 0) return 'pagamento-parcial';
  return 'pendente';
}

async function criar({
  unidade, cliente, dataVenda, dataDeUso, horaInicio, horaFim,
  missao, horas, saltonautas,
  valorTotal, desconto, sinal, restante, observacao, referenciaVendaOriginal,
  criadoPorId, criadoPorEmail,
}) {
  if (!unidade) throw new Error('Unidade é obrigatória.');
  if (!cliente || !String(cliente.nome || '').trim()) throw new Error('Informe o nome do cliente.');
  if (!dataDeUso || !/^\d{4}-\d{2}-\d{2}$/.test(dataDeUso)) throw new Error('Informe a data do evento.');
  // pacote da tabela oficial: quando Missão + horas + saltonautas vierem
  // preenchidos, o valor total sai da tabela (fonte da verdade), ignorando
  // o que tiver sido digitado. Sem pacote (venda antiga/avulsa), o valor
  // digitado continua valendo
  const tabela = await getTabela();
  const missaoOk = tabela.missoes[missao] ? missao : null;
  const valorTabela = missaoOk ? valorFesta(missaoOk, horas, saltonautas, tabela.missoes) : null;
  if (missaoOk && valorTabela == null) throw new Error(`Escolha horas (1 a 3) e saltonautas (${tabela.saltonautasColunas.join('/')}) válidos pra Missão.`);
  const valorBase = valorTabela != null ? valorTabela : num(valorTotal);
  if (valorBase < 0) throw new Error('Valor total inválido.');

  // desconto simples (%) - sempre passa pela alcada (ver autorizarDesconto);
  // o servidor recalcula o valor final, nunca confia no que o front mandou
  let descontoOk = null;
  let total = valorBase;
  if (desconto && num(desconto.percentual) > 0) {
    const { pct, autorizadoPorId, autorizadoPorUsername, autorizadoPorEmail } = await autorizarDesconto(desconto.percentual, desconto.gerenteUsername, desconto.gerenteSenha);
    const valorDesconto = Math.round(valorBase * (pct / 100) * 100) / 100;
    total = Math.max(0, valorBase - valorDesconto);
    descontoOk = {
      percentual: pct, valorBase, valorDesconto,
      autorizadoPorId, autorizadoPorUsername, autorizadoPorEmail,
      autorizadoEm: new Date().toISOString(),
    };
  }

  const ref = COLLECTION.doc();
  const registro = {
    id: ref.id,
    codigo: gerarCodigo(),
    unidade,
    missao: missaoOk,
    horas: missaoOk ? Number(horas) : null,
    saltonautas: missaoOk ? Number(saltonautas) : null,
    cliente: {
      nome: String(cliente.nome).trim().slice(0, 150),
      contato: String(cliente.contato || '').trim().slice(0, 30),
      email: String(cliente.email || '').trim().slice(0, 150),
    },
    dataVenda: dataVenda || new Date().toISOString().slice(0, 10),
    dataDeUso,
    horaInicio: horaInicio || null,
    horaFim: horaFim || null,
    valorTotal: total,
    desconto: descontoOk,
    sinal: sanitizarPagamento(sinal),
    restante: sanitizarPagamento(restante),
    // livro-razao dos pagamentos recebidos DEPOIS do fechamento inicial da
    // venda - append-only: nada aqui pode ser editado nem removido (ver
    // reabrirPagamento/registrarRecebimento)
    recebimentos: [],
    pagamentoAberto: false,
    reaberturas: [],
    // ja nasce refletindo o que entrou na venda: sinal cobrindo tudo =
    // pago; sinal parcial = pagamento-parcial; sem sinal = pendente
    status: statusPorPagamento({ valorTotal: total, sinal: sanitizarPagamento(sinal), recebimentos: [] }),
    utilizado: false,
    dataUtilizacao: null,
    observacao: String(observacao || '').slice(0, 500),
    referenciaVendaOriginal: referenciaVendaOriginal ? String(referenciaVendaOriginal).trim().slice(0, 20) : null,
    termoAssinado: false,
    criadoPorId,
    criadoPorEmail,
    criadoEm: new Date().toISOString(),
  };
  await ref.set(registro);
  festasCache.invalidar();
  return registro;
}

async function listAllUncached() {
  const snap = await COLLECTION.orderBy('dataDeUso', 'desc').get();
  return snap.docs.map((d) => d.data());
}
const festasCache = createCache(listAllUncached, 5 * 60 * 1000);
const listAll = festasCache.cached;

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

async function atualizar(id, patch) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Reserva não encontrada.');
  const atual = snap.data();
  const merge = {};

  if (patch.cliente) merge.cliente = { ...atual.cliente, ...patch.cliente };
  if (patch.dataDeUso !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(patch.dataDeUso)) throw new Error('Data do evento inválida.');
    merge.dataDeUso = patch.dataDeUso;
  }
  if (patch.horaInicio !== undefined) merge.horaInicio = patch.horaInicio || null;
  if (patch.horaFim !== undefined) merge.horaFim = patch.horaFim || null;
  // trocar o pacote (Missão/horas/saltonautas) recalcula o valor pela tabela
  if (patch.missao !== undefined || patch.horas !== undefined || patch.saltonautas !== undefined) {
    const tabela = await getTabela();
    const missaoNova = patch.missao !== undefined ? (tabela.missoes[patch.missao] ? patch.missao : null) : atual.missao;
    const horasNovas = patch.horas !== undefined ? patch.horas : atual.horas;
    const saltoNovos = patch.saltonautas !== undefined ? patch.saltonautas : atual.saltonautas;
    if (missaoNova) {
      const v = valorFesta(missaoNova, horasNovas, saltoNovos, tabela.missoes);
      if (v == null) throw new Error(`Escolha horas (1 a 3) e saltonautas (${tabela.saltonautasColunas.join('/')}) válidos pra Missão.`);
      merge.missao = missaoNova;
      merge.horas = Number(horasNovas);
      merge.saltonautas = Number(saltoNovos);
      merge.valorTotal = v;
    } else {
      merge.missao = null; merge.horas = null; merge.saltonautas = null;
    }
  }
  // antifraude: depois que existe recebimento lancado, o financeiro da
  // reserva (valor total, sinal, restante) fica travado - nada do que ja
  // foi lancado pode ser mexido. Ajuste de valor a mais e um novo
  // recebimento (reabrir + lancar), nunca edicao do historico
  const temRecebimentos = (atual.recebimentos || []).length > 0;
  if (temRecebimentos && (patch.valorTotal !== undefined || patch.sinal !== undefined || patch.restante !== undefined || merge.valorTotal !== undefined)) {
    throw new Error('Essa reserva já tem recebimento lançado - os valores ficam travados. Use "Reabrir" pra lançar o restante.');
  }
  if (patch.valorTotal !== undefined && merge.valorTotal === undefined) merge.valorTotal = num(patch.valorTotal);
  if (patch.sinal !== undefined) merge.sinal = sanitizarPagamento(patch.sinal);
  if (patch.restante !== undefined) merge.restante = sanitizarPagamento(patch.restante);
  if (patch.status !== undefined) {
    if (!STATUS_VALIDOS.includes(patch.status)) throw new Error('Status inválido.');
    // antifraude: "pago" nao se marca na mao quando ainda falta dinheiro
    // entrar - o status vira pago sozinho quando o ultimo recebimento cobre
    // o total (cancelado/pendente continuam manuais)
    if (patch.status === 'pago' && restanteDevido(atual) > 0 && (temRecebimentos || atual.pagamentoAberto)) {
      throw new Error(`Ainda faltam R$ ${restanteDevido(atual).toFixed(2)} - lance o recebimento do restante pra fechar como pago.`);
    }
    merge.status = patch.status;
  }
  if (patch.utilizado !== undefined) {
    merge.utilizado = patch.utilizado === true;
    merge.dataUtilizacao = merge.utilizado ? (patch.dataUtilizacao || new Date().toISOString().slice(0, 10)) : null;
  }
  if (patch.observacao !== undefined) merge.observacao = String(patch.observacao).slice(0, 500);
  if (patch.termoAssinado !== undefined) merge.termoAssinado = patch.termoAssinado === true;

  merge.atualizadoEm = new Date().toISOString();
  await ref.update(merge);
  festasCache.invalidar();
  return getOne(id);
}

// passo 1 do recebimento pos-venda (antifraude): a reserva fica fechada por
// padrao - um Gerente da unidade ou Master/Admin (checado na rota) precisa
// REABRIR pra liberar o lancamento do complemento. A reabertura fica
// auditada (quem e quando) e nao permite editar nada do que ja foi lancado
async function reabrirPagamento(id, { porEmail }) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Reserva não encontrada.');
  const atual = snap.data();
  if (atual.status === 'cancelado') throw new Error('Reserva cancelada não recebe pagamento.');
  if (restanteDevido(atual) <= 0) throw new Error('Essa reserva já está totalmente paga.');
  if (atual.pagamentoAberto) throw new Error('O recebimento já está aberto pra essa reserva.');
  await ref.update({
    pagamentoAberto: true,
    reaberturas: [...(atual.reaberturas || []), { porEmail, em: new Date().toISOString() }].slice(-30),
    atualizadoEm: new Date().toISOString(),
  });
  festasCache.invalidar();
  return getOne(id);
}

// passo 2: lanca o recebimento do complemento. Append-only: entra no
// livro-razao `recebimentos` e nunca mais pode ser editado ou removido.
// Nao deixa lancar mais do que o restante devido; fecha o pagamento de novo
// e o status vira 'pago' (cobriu tudo) ou 'pagamento-parcial' (ainda falta)
async function registrarRecebimento(id, { valor, forma, data, porId, porEmail }) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Reserva não encontrada.');
  const atual = snap.data();
  if (atual.status === 'cancelado') throw new Error('Reserva cancelada não recebe pagamento.');
  if (!atual.pagamentoAberto) throw new Error('Reabra o recebimento primeiro (botão Reabrir) - a reserva fica travada depois do fechamento inicial.');
  const v = num(valor);
  const devido = restanteDevido(atual);
  if (v <= 0) throw new Error('Informe o valor recebido.');
  if (v > devido + 0.009) throw new Error(`O valor recebido não pode passar do restante devido (R$ ${devido.toFixed(2)}).`);
  const recebimento = {
    id: crypto.randomBytes(6).toString('hex'),
    valor: v,
    forma: String(forma || '').trim().slice(0, 40),
    data: data || new Date().toISOString().slice(0, 10),
    // o ID (nao so o email) e o que amarra o recebimento ao caixa de quem
    // registrou no fechamento do dia - ver faturadoPorOperador em
    // saltiversoFechamento.js
    registradoPorId: porId || null,
    registradoPorEmail: porEmail,
    registradoEm: new Date().toISOString(),
  };
  const depois = { ...atual, recebimentos: [...(atual.recebimentos || []), recebimento] };
  await ref.update({
    recebimentos: depois.recebimentos,
    pagamentoAberto: false,
    status: statusPorPagamento(depois),
    atualizadoEm: new Date().toISOString(),
  });
  festasCache.invalidar();
  return getOne(id);
}

async function remover(id) {
  const snap = await COLLECTION.doc(id).get();
  if (!snap.exists) throw new Error('Reserva não encontrada.');
  await COLLECTION.doc(id).delete();
  festasCache.invalidar();
}

// ---------------------------------------------------------------
// FESTA NO FECHAMENTO DO DIA
//
// Antes o fechamento do Saltiverso somava só entradas do parque + vendas
// de balcão. O dinheiro de festa entrava no caixa e não aparecia em lugar
// nenhum da conferência - quem fechava tinha sobra sem explicação.
//
// O que conta é o dinheiro que ENTROU no dia, não a data da festa (uma
// festa de dezembro pode ser paga em agosto). Duas origens:
//   - o SINAL, na data da venda (quem vendeu a reserva é o responsável)
//   - cada RECEBIMENTO, na data dele (quem registrou é o responsável)
// Reserva cancelada não entra.
// ---------------------------------------------------------------
const { FORMAS_PAGAMENTO_SPLIT } = require('./parque');

const soDia = (v) => String(v == null ? '' : v).slice(0, 10);

function movimentosDoDia(festa, data) {
  const movs = [];
  if (!festa || festa.status === 'cancelado') return movs;

  const s = festa.sinal;
  if (s && num(s.valor) > 0) {
    // a data do sinal pode não ter sido preenchida - cai pra data da venda
    // e, em último caso, pra criação; nunca pra data de USO da festa, que
    // é no futuro e jogaria a receita no dia errado
    const dia = soDia(s.data || festa.dataVenda || festa.criadoEm);
    if (dia === data) {
      movs.push({
        valor: num(s.valor), forma: s.forma, origem: 'sinal',
        porId: festa.criadoPorId || null, porEmail: festa.criadoPorEmail || null,
        cliente: (festa.cliente && festa.cliente.nome) || null, festaId: festa.id,
      });
    }
  }

  (festa.recebimentos || []).forEach((r) => {
    if (soDia(r.data) !== data) return;
    movs.push({
      valor: num(r.valor), forma: r.forma, origem: 'recebimento',
      // recebimentos antigos (lancados antes desse campo existir) vem sem
      // porId - o fechamento resolve pelo email, nao deixa o dinheiro
      // ficar sem dono
      porId: r.registradoPorId || null, porEmail: r.registradoPorEmail || null,
      cliente: (festa.cliente && festa.cliente.nome) || null, festaId: festa.id,
    });
  });
  return movs;
}

// mesmo formato que parque.resumoDoDia/saltiversoVendas.resumoDoDia, pro
// bucketsDoResumo do fechamento consumir sem tratamento especial
async function resumoDoDia(unidade, data) {
  const todas = await listAll();
  const porForma = {};
  FORMAS_PAGAMENTO_SPLIT.forEach((f) => { porForma[f] = 0; });
  let total = 0;
  let movimentos = 0;
  todas.filter((f) => f.unidade === unidade).forEach((f) => {
    movimentosDoDia(f, data).forEach((m) => {
      total += m.valor;
      movimentos += 1;
      // forma fora da lista conhecida vira 'outros' no balde do fechamento
      // em vez de sumir da soma - dinheiro nunca some por causa de rótulo
      if (FORMAS_PAGAMENTO_SPLIT.includes(m.forma)) porForma[m.forma] += m.valor;
      else porForma.voucher += m.valor;
    });
  });
  FORMAS_PAGAMENTO_SPLIT.forEach((f) => { porForma[f] = Math.round(porForma[f] * 100) / 100; });
  return { total: Math.round(total * 100) / 100, porForma, movimentos };
}

// quem vendeu/recebeu fica responsável no fechamento por operador
async function movimentosPorOperador(unidade, data) {
  const todas = await listAll();
  const out = [];
  todas.filter((f) => f.unidade === unidade).forEach((f) => {
    movimentosDoDia(f, data).forEach((m) => out.push(m));
  });
  return out;
}

module.exports = {
  STATUS_VALIDOS, valorFesta, totalRecebido, restanteDevido,
  resumoDoDia, movimentosPorOperador, movimentosDoDia,
  getTabela, salvarTabela,
  criar, listAll, listByUnidades, getOne, atualizar, remover,
  reabrirPagamento, registrarRecebimento,
  invalidar: () => festasCache.invalidar(),
};
