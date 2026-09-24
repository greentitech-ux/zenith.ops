// pagamentosArquivo.js
//
// O ARQUIVO DE PAGAMENTOS APROVADOS (Master, 24/09/2026).
//
// POR QUE ISTO EXISTE. A tarefa #12084 (Dom Bessa, R$ 86,90) nasceu com a
// data errada: gravou a compra em 06/09 e o PSP da disputa como se fosse o do
// pagamento. O pagamento de verdade foi 01/09 18:08:45, PSP VH68ZV96SS76L7Q9.
//
// A causa não é um bug de cálculo, é de RETENÇÃO. O Monitor apaga transação
// com 2 dias (`RETENCAO_TRANSACOES_DIAS`, store.js). Um pedido só fica
// protegido da limpeza DEPOIS que um evento de disputa chega nele - e o
// chargeback chega dias ou semanas depois. Quando chegou, a autorização de
// 01/09 já tinha ido embora, e o `defesaChargeback.js` caiu no fallback
// `ordenados[0]`, que era o próprio chargeback.
//
// A SAÍDA: antes de apagar, guardar uma FICHA do pagamento aprovado. Assim o
// evento morre no Firestore (que é o que custa) e o fato sobrevive.
//
// CUSTO (CLAUDE.md §3): ZERO leitura e ZERO escrita no Firestore. Tudo vive
// no Storage, mesmo lugar e mesmo motivo do snapshot de transações do
// store.js - upload é muito mais barato que leitura de documento. Um arquivo
// por DIA de pagamento, então um `pruneOld` escreve poucos arquivos, não um
// por transação.
//
// NUNCA O NÚMERO DO CARTÃO. A ficha leva `last4` e `bin` (que é o que a Adyen
// manda e o que a defesa usa); o PAN completo não existe nem no dado de
// origem, e não passa a existir aqui.
const { comBucket } = require('./storageBucket');

const PASTA = 'pagamentos-arquivo';
// 180 dias cobre com folga o prazo da bandeira (120 dias pra contestar, mais
// o tempo de a disputa chegar e a loja responder).
const DIAS_GUARDADOS = 180;
const DIA_MS = 24 * 60 * 60 * 1000;

// os campos que `dadosDoPagamento()` (defesaChargeback.js) lê. A lista é
// explícita de propósito: copiar a transação inteira jogaria campo novo do
// Monitor aqui dentro sem ninguém decidir.
const CAMPOS = [
  'pspReference', 'merchantReference', 'merchantAccountCode', 'unidade', 'valor', 'dataHora',
  'metodo', 'last4', 'bin', 'aliasCartao', 'nomeCliente', 'cardHolder',
  'emailCliente', 'telefoneCliente', 'enderecoCliente', 'enderecoTipo',
  'shopperIp', 'paisCliente', 'paisEmissor', 'bancoEmissor', 'fonteCartao',
  'threeDOferecido', 'threeDAutenticado', 'resultadoAvs', 'resultadoCvc',
  'scoreRiscoAdyen', 'resultadoRiscoAdyen', 'shopperReference',
];

// o dia do pagamento no fuso de São Paulo - é por ele que o arquivo é
// nomeado, pra "o pagamento de 01/09" cair em 2026-09-01 e não no dia UTC
// seguinte, que é o que aconteceria com um pagamento das 22h.
function diaSP(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return null;
  return new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}
function chaveDoPedido(tx) {
  return tx.merchantReference || tx.originalReference || tx.pspReference || null;
}
function ficha(tx) {
  const f = {};
  for (const c of CAMPOS) if (tx[c] !== undefined) f[c] = tx[c];
  return f;
}

// CACHE POR ARQUIVO. Uma varredura de chargebacks pode procurar vários
// pedidos seguidos; sem cache, cada um baixaria os mesmos arquivos de novo.
// Guarda o conteúdo (ou `null`, pro arquivo que não existe - senão o dia
// vazio é rebaixado toda vez).
const cache = new Map();
function invalidar() { cache.clear(); }

async function lerDia(dia) {
  if (cache.has(dia)) return cache.get(dia);
  let conteudo = null;
  try {
    const [buf] = await comBucket((b) => b.file(`${PASTA}/${dia}.json`).download());
    const dados = JSON.parse(buf.toString('utf8'));
    conteudo = dados && typeof dados === 'object' ? dados : null;
  } catch (err) {
    conteudo = null; // não existe, ou Storage fora do ar
  }
  cache.set(dia, conteudo);
  return conteudo;
}

async function gravarDia(dia, mapa) {
  await comBucket((b) => b.file(`${PASTA}/${dia}.json`).save(JSON.stringify(mapa), { contentType: 'application/json' }));
  cache.set(dia, mapa);
}

// ARQUIVAR: chamado pelo `pruneOld` ANTES de apagar. Recebe as transações que
// estão saindo e guarda só as aprovadas.
//
// MERGE com o que já está no dia: o `pruneOld` roda várias vezes, e a segunda
// não pode apagar o que a primeira guardou. A ficha mais nova ganha - é a que
// passou por mais eventos e costuma ter mais campo preenchido.
async function arquivar(transacoes) {
  const porDia = new Map();
  for (const t of transacoes || []) {
    if (!t || t.status !== 'APROVADO') continue;
    const chave = chaveDoPedido(t);
    const dia = diaSP(t.dataHora);
    if (!chave || !dia) continue;
    if (!porDia.has(dia)) porDia.set(dia, new Map());
    porDia.get(dia).set(chave, ficha(t));
  }
  let guardados = 0;
  for (const [dia, novos] of porDia) {
    const atual = (await lerDia(dia)) || {};
    for (const [chave, f] of novos) { atual[chave] = f; guardados++; }
    await gravarDia(dia, atual);
  }
  return { arquivos: porDia.size, pagamentos: guardados };
}

// BUSCAR a ficha de um pedido.
//
// `dicaDeData` é a data que se sabe do pedido (a do evento de disputa, por
// exemplo). O pagamento é ANTES dela, então a busca anda pra trás dia a dia -
// achar na primeira semana é o caso comum. Sem dica, varre os 180 dias.
async function buscar(pedidoId, dicaDeData) {
  const chave = String(pedidoId || '');
  if (!chave) return null;
  const base = Date.parse(dicaDeData || '') || Date.now();
  for (let i = 0; i <= DIAS_GUARDADOS; i++) {
    const dia = diaSP(new Date(base - i * DIA_MS).toISOString());
    if (!dia) continue;
    const mapa = await lerDia(dia);
    if (mapa && mapa[chave]) return mapa[chave];
  }
  return null;
}

// LIMPEZA: some com o que passou de 180 dias. Roda 1x por dia (index.js).
async function limpar(agora = Date.now()) {
  const corte = agora - DIAS_GUARDADOS * DIA_MS;
  let apagados = 0;
  try {
    const [arquivos] = await comBucket((b) => b.getFiles({ prefix: `${PASTA}/` }));
    for (const f of arquivos || []) {
      const m = /(\d{4}-\d{2}-\d{2})\.json$/.exec(f.name || '');
      if (!m) continue;
      if (Date.parse(`${m[1]}T00:00:00Z`) >= corte) continue;
      await f.delete();
      cache.delete(m[1]);
      apagados++;
    }
  } catch (err) {
    console.error('[pagamentos-arquivo] limpeza falhou (tenta de novo amanhã):', err.message);
  }
  return { apagados };
}

module.exports = { PASTA, DIAS_GUARDADOS, CAMPOS, diaSP, chaveDoPedido, ficha, arquivar, buscar, limpar, invalidar, _cache: cache };
