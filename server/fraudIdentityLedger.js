// fraudIdentityLedger.js
// Base persistente de identidades de fraude CONFIRMADA. Ela não guarda PAN,
// CVV, e-mail, telefone, endereço ou IP em texto claro: cada valor entra
// normalizado e protegido com HMAC. Assim uma confirmação em AMEX continua
// encontrável se a próxima tentativa usar Visa, Mastercard ou outra bandeira.
//
// Importante: uma coincidência de nome, BIN+final ou IP nunca é suficiente
// para bloquear um pedido. Esses dados são apenas sinais de revisão humana.
const crypto = require('crypto');
const db = require('./firestore');

const COLLECTION = db.collection('fraudIdentityLedger');
const META = db.collection('fraudIdentityLedgerMeta').doc('importacao-confirmacoes-v1');
const SEGREDO = process.env.FRAUD_IDENTITY_HMAC_KEY || process.env.ENCRYPTION_KEY || process.env.JWT_SECRET || '';

if (!SEGREDO) throw new Error('Configure FRAUD_IDENTITY_HMAC_KEY, ENCRYPTION_KEY ou JWT_SECRET para a base antifraude.');

const FORTE = new Set(['alias-cartao', 'shopper-reference', 'email', 'telefone', 'endereco']);
const REVISAO = new Set(['ip', 'bin-last4', 'nome-cliente', 'titular-cartao']);
const CACHE_MS = 5 * 60 * 1000;
let indice = { valor: null, expiraEm: 0, carregando: null };

function invalidarCache() { indice = { valor: null, expiraEm: 0, carregando: null }; }
async function carregarIndice() {
  if (indice.valor && Date.now() < indice.expiraEm) return indice.valor;
  if (indice.carregando) return indice.carregando;
  const promessa = COLLECTION.get().then((snap) => {
    const valor = new Map(snap.docs.map((doc) => [doc.id, doc.data()]));
    indice = { valor, expiraEm: Date.now() + CACHE_MS, carregando: null };
    return valor;
  }).catch((err) => { indice.carregando = null; throw err; });
  indice.carregando = promessa;
  return promessa;
}

function texto(valor) {
  return String(valor || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .trim().toLowerCase().replace(/\s+/g, ' ');
}
function digitos(valor) { return String(valor || '').replace(/\D/g, ''); }
function hmac(tipo, valor) {
  return crypto.createHmac('sha256', SEGREDO).update(`${tipo}:${valor}`, 'utf8').digest('base64url');
}
function chave(tipo, valor) { return `${tipo}_${hmac(tipo, valor)}`; }
function normalizar(tipo, valor) {
  if (tipo === 'telefone') {
    const numero = digitos(valor);
    return numero.length >= 8 ? numero : null;
  }
  if (tipo === 'bin-last4') {
    const numero = digitos(valor);
    return numero.length >= 10 ? numero : null;
  }
  const limpo = texto(valor);
  return limpo.length >= 3 ? limpo : null;
}

// Só identifica dados que realmente vieram da transação. `bin-last4` é
// deliberadamente classificado como revisão: não é identificador exclusivo.
function identificadores(tx) {
  const candidatos = [
    ['alias-cartao', tx.aliasCartao],
    ['shopper-reference', tx.shopperReference],
    ['email', tx.emailCliente],
    ['telefone', tx.telefoneCliente],
    ['endereco', tx.enderecoCliente],
    ['ip', tx.shopperIp],
    ['bin-last4', tx.bin && tx.last4 ? `${tx.bin}${tx.last4}` : null],
    ['nome-cliente', tx.nomeCliente],
    ['titular-cartao', tx.cardHolder],
  ];
  const vistos = new Set();
  return candidatos.flatMap(([tipo, cru]) => {
    const valor = normalizar(tipo, cru);
    if (!valor) return [];
    const id = chave(tipo, valor);
    if (vistos.has(id)) return [];
    vistos.add(id);
    return [{ tipo, id, hash: hmac(tipo, valor), forca: FORTE.has(tipo) ? 'forte' : 'revisao' }];
  });
}

function resumoTx(tx) {
  return {
    pedidoId: tx.merchantReference || tx.originalReference || tx.pspReference || null,
    pspReference: tx.pspReference || null,
    unidade: tx.unidade || null,
    bandeira: tx.metodo || null,
    em: new Date().toISOString(),
  };
}

// Grava só hashes e metadados de auditoria mínimos. É chamado exclusivamente
// depois de confirmação humana: uma marca "FRAUDE?" ou uma recusa não entra.
async function registrarConfirmada(transacoes, { pedidoId, confirmadoPorEmail, origem = 'confirmacao-master' } = {}) {
  const lista = Array.isArray(transacoes) ? transacoes : [];
  const porId = new Map();
  lista.forEach((tx) => identificadores(tx).forEach((item) => porId.set(item.id, { ...item, tx })));
  const agora = new Date().toISOString();
  const jobs = [...porId.values()].map(async ({ tipo, id, hash, forca, tx }) => {
    const referencia = COLLECTION.doc(id);
    const anterior = await referencia.get();
    const dadosAnteriores = anterior.exists ? anterior.data() : {};
    const pedidos = [...new Set([...(dadosAnteriores.pedidos || []), pedidoId || resumoTx(tx).pedidoId].filter(Boolean))].slice(-20);
    const bandeiras = [...new Set([...(dadosAnteriores.bandeiras || []), tx.metodo].filter(Boolean))].slice(-12);
    await referencia.set({
      id, tipo, hash, forca,
      primeiroRegistroEm: dadosAnteriores.primeiroRegistroEm || agora,
      ultimoRegistroEm: agora,
      confirmacoes: Number(dadosAnteriores.confirmacoes || 0) + 1,
      pedidos, bandeiras,
      origem: dadosAnteriores.origem || origem,
      ultimoConfirmadoPorEmail: confirmadoPorEmail || null,
      ultimaTransacao: resumoTx(tx),
    }, { merge: true });
  });
  await Promise.all(jobs);
  invalidarCache();
  return { identificadores: porId.size };
}

async function consultar(tx) {
  const itens = identificadores(tx);
  const registros = await carregarIndice();
  const achados = itens.map((item) => {
    const registro = registros.get(item.id);
    return registro ? { ...item, registro } : null;
  });
  const matches = achados.filter(Boolean);
  const fortes = matches.filter((m) => FORTE.has(m.tipo));
  const revisao = matches.filter((m) => REVISAO.has(m.tipo));
  // Alias/token de cartão é a referência de pagamento mais específica; dois
  // dados fortes independentes também formam vínculo suficiente. Um único
  // e-mail/endereço pode ter sido reaproveitado legitimamente e só revisa.
  const bloquear = fortes.some((m) => m.tipo === 'alias-cartao') || new Set(fortes.map((m) => m.tipo)).size >= 2;
  return {
    bloquear,
    revisar: matches.length > 0,
    fortes: fortes.map((m) => m.tipo),
    revisao: revisao.map((m) => m.tipo),
    matches: matches.map((m) => ({ tipo: m.tipo, forca: m.forca, bandeiras: m.registro.bandeiras || [], ultimoRegistroEm: m.registro.ultimoRegistroEm || null })),
  };
}

// Importação única dos registros antigos que JÁ foram confirmados por uma
// pessoa. Marcas automáticas e simples "FRAUDE?" ficam deliberadamente fora:
// importá-las perpetuaria falsos positivos na nova base.
async function importarConfirmacoesHistoricas(marcas, buscarTransacoes) {
  const meta = await META.get();
  if (meta.exists && meta.data().concluidaEm) return { jaImportada: true, pedidos: 0, identificadores: 0 };
  let pedidos = 0;
  let identificadores = 0;
  for (const marca of (marcas || [])) {
    if (!marca || marca.removido || !marca.fraudeConfirmadaEm || !marca.pedidoId) continue;
    const resultado = await registrarConfirmada(buscarTransacoes(marca.pedidoId), {
      pedidoId: marca.pedidoId,
      confirmadoPorEmail: marca.fraudeConfirmadaPorEmail || null,
      origem: 'importacao-confirmacao-historica',
    });
    pedidos += 1;
    identificadores += resultado.identificadores;
  }
  await META.set({ concluidaEm: new Date().toISOString(), pedidos, identificadores, versao: 1 });
  invalidarCache();
  return { jaImportada: false, pedidos, identificadores };
}

module.exports = { registrarConfirmada, consultar, identificadores, importarConfirmacoesHistoricas };
