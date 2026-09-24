// adyenDisputas.js
// DEFESA DE CHARGEBACK PELA API DA ADYEN (Disputes API v30, 24/09/2026).
//
// Até aqui a defesa era anexada na Customer Area por gente, no navegador
// (decisão anterior do Master, ver defesaChargeback.js: "a API fica para
// depois, se houver credencial"). Com a credencial, o Claude envia pelo
// servidor - mas SEMPRE depois da digital do Master (coworkApi, autorizar).
//
// Configuração no Render (nunca no código, nunca no chat):
//   ADYEN_DISPUTES_API_KEY   chave de uma credencial com o papel de
//                            gestão de disputas (só esse papel)
//   ADYEN_DISPUTES_API_KEY_2 a da OUTRA empresa Adyen do grupo. Credencial
//                            de empresa só enxerga as contas daquela
//                            empresa: com duas empresas, são duas chaves.
//                            Não precisa dizer qual conta é de qual: o
//                            servidor descobre (chaveDaConta, abaixo)
//   ADYEN_DISPUTES_URL       opcional: a URL base inteira. Sem ela vale a de
//                            produção (URL_LIVE). Pra homologar, use a de
//                            teste: https://ca-test.adyen.com/ca/services/DisputeService/v30
//
// A Disputes API mora no host da Customer Area (ca-live), SEM o prefixo da
// conta: o prefixo "<xxx>-pal-live.adyenpayments.com" é da API de
// pagamentos. É o que a biblioteca oficial da Adyen faz (@adyen/api-library,
// disputesApi.js: ca-test -> ca-live). Com o host do pal, toda chamada
// daria 404 em produção.
//   ADYEN_MERCHANT_ACCOUNTS  opcional, JSON {"Dominos Bessa":"DOM_19706"}
//                            pra caso antigo, de antes de o Monitor guardar
//                            o merchantAccountCode cru em cada transação
//
// Sem chave, nada é chamado: a ferramenta responde o que falta.
const VERSAO = 'v30';
const URL_LIVE = `https://ca-live.adyen.com/ca/services/DisputeService/${VERSAO}`;

function urlBase(env = process.env) {
  if (env.ADYEN_DISPUTES_URL) return String(env.ADYEN_DISPUTES_URL).replace(/\/$/, '');
  return URL_LIVE;
}
// ADYEN_DISPUTES_API_KEY, ADYEN_DISPUTES_API_KEY_2, _3... nessa ordem
function chaves(env = process.env) {
  const ordem = (k) => Number((k.match(/_(\d+)$/) || [0, 1])[1]);
  return Object.keys(env).filter((k) => /^ADYEN_DISPUTES_API_KEY(_\d+)?$/.test(k) && env[k])
    .sort((a, b) => ordem(a) - ordem(b)).map((k) => String(env[k]));
}
function configurada(env = process.env) {
  const falta = [];
  if (!chaves(env).length) falta.push('ADYEN_DISPUTES_API_KEY');
  return { ok: !falta.length, falta, empresas: chaves(env).length };
}

// o merchantAccountCode cru: da transação (normalize.js grava desde
// 24/09/2026) ou do mapa configurado pra caso antigo
function contaDoCaso(caso, txs, env = process.env) {
  const daTx = (txs || []).map((t) => t && t.merchantAccountCode).find(Boolean);
  if (daTx) return daTx;
  try {
    const mapa = JSON.parse(env.ADYEN_MERCHANT_ACCOUNTS || '{}');
    if (mapa && caso && mapa[caso.unidade]) return String(mapa[caso.unidade]);
  } catch (e) { /* JSON quebrado cai no erro abaixo */ }
  return null;
}

async function chamar(metodo, corpo, { env = process.env, fetchImpl = globalThis.fetch, chave = chaves(env)[0] } = {}) {
  const cfg = configurada(env);
  if (!cfg.ok) throw new Error(`API de disputas da Adyen não configurada no servidor. Falta: ${cfg.falta.join(', ')}.`);
  const resp = await fetchImpl(`${urlBase(env)}/${metodo}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': chave },
    body: JSON.stringify(corpo),
  });
  const texto = await resp.text();
  let dados = null; try { dados = JSON.parse(texto); } catch (e) { dados = null; }
  if (!resp.ok) {
    const msg = (dados && (dados.message || dados.errorMessage)) || texto.slice(0, 200) || `HTTP ${resp.status}`;
    throw new Error(`Adyen recusou ${metodo} (HTTP ${resp.status}): ${msg}`);
  }
  // a Disputes API responde 200 com success=false quando a regra da bandeira não deixa
  const r = dados && dados.disputeServiceResult;
  if (r && r.success === false) throw new Error(`Adyen recusou ${metodo}: ${r.errorMessage || 'sem motivo informado'}`);
  return dados || {};
}

// QUAL CHAVE ABRE ESTA CONTA. Com uma chave só, é ela. Com duas empresas, o
// servidor pergunta os motivos de defesa (chamada de LEITURA, não muda nada
// na Adyen) com cada chave, na ordem, e guarda qual respondeu. Nunca tenta
// chave em chamada que escreve (defender/aceitar): elas só rodam com a
// chave que já abriu a conta.
const CHAVE_DA_CONTA = new Map();
async function chaveDaConta({ pspDisputa, conta }, opcoes = {}) {
  const env = opcoes.env || process.env;
  const lista = chaves(env);
  if (lista.length <= 1) return lista[0];
  const guardada = CHAVE_DA_CONTA.get(conta);
  if (guardada && lista.includes(guardada)) return guardada;
  const erros = [];
  for (let i = 0; i < lista.length; i++) {
    try {
      await chamar('retrieveApplicableDefenseReasons', { disputePspReference: pspDisputa, merchantAccountCode: conta }, { ...opcoes, chave: lista[i] });
      CHAVE_DA_CONTA.set(conta, lista[i]);
      return lista[i];
    } catch (e) { erros.push(`chave ${i + 1}: ${e.message}`); }
  }
  throw new Error(`Nenhuma das ${lista.length} chaves da Adyen abriu a conta ${conta} nesta disputa. ${erros.join(' | ')}`);
}

// motivos de defesa que a bandeira aceita PARA ESTA disputa, com os
// documentos que cada um pede - é daqui que sai o que enviar
async function motivosDeDefesa({ pspDisputa, conta }, opcoes = {}) {
  const chave = await chaveDaConta({ pspDisputa, conta }, opcoes);
  const d = await chamar('retrieveApplicableDefenseReasons', { disputePspReference: pspDisputa, merchantAccountCode: conta }, { ...opcoes, chave });
  return (d.defenseReasons || []).map((m) => ({
    codigo: m.defenseReasonCode, satisfeito: !!m.satisfied,
    documentos: (m.defenseDocumentTypes || []).map((t) => ({ codigo: t.defenseDocumentTypeCode, exigencia: t.requirementLevel || null, jaEnviado: !!t.available })),
  }));
}

// envia os documentos e defende. `documentos` = [{ buffer, contentType, tipo }]
async function defender({ pspDisputa, conta, motivo, documentos }, opcoes = {}) {
  if (!documentos || !documentos.length) throw new Error('Nenhum documento para enviar.');
  opcoes = { ...opcoes, chave: await chaveDaConta({ pspDisputa, conta }, opcoes) };
  await chamar('supplyDefenseDocument', {
    disputePspReference: pspDisputa, merchantAccountCode: conta,
    defenseDocuments: documentos.map((x) => ({ content: Buffer.from(x.buffer).toString('base64'), contentType: x.contentType, defenseDocumentTypeCode: x.tipo })),
  }, opcoes);
  await chamar('defendDispute', { disputePspReference: pspDisputa, merchantAccountCode: conta, defenseReasonCode: motivo }, opcoes);
  return { ok: true };
}

async function aceitar({ pspDisputa, conta }, opcoes = {}) {
  opcoes = { ...opcoes, chave: await chaveDaConta({ pspDisputa, conta }, opcoes) };
  await chamar('acceptDispute', { disputePspReference: pspDisputa, merchantAccountCode: conta }, opcoes);
  return { ok: true };
}

module.exports = { URL_LIVE, urlBase, chaves, chaveDaConta, configurada, contaDoCaso, chamar, motivosDeDefesa, defender, aceitar, VERSAO };
