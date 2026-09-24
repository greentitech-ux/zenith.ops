// adyenDisputas.js
// DEFESA DE CHARGEBACK PELA API DA ADYEN (Disputes API v30, 24/09/2026).
//
// Até aqui a defesa era anexada na Customer Area por gente, no navegador
// (decisão anterior do Master, ver defesaChargeback.js: "a API fica para
// depois, se houver credencial"). Com a credencial, o Claude envia pelo
// servidor - mas SEMPRE depois da digital do Master (coworkApi, autorizar).
//
// Configuração no Render (nunca no código, nunca no chat):
//   ADYEN_DISPUTES_API_KEY   chave de uma credencial com o papel
//                            "API dispute management" (só esse papel)
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
// Sem chave ou sem URL, nada é chamado: a ferramenta responde o que falta.
const VERSAO = 'v30';
const URL_LIVE = `https://ca-live.adyen.com/ca/services/DisputeService/${VERSAO}`;

function urlBase(env = process.env) {
  if (env.ADYEN_DISPUTES_URL) return String(env.ADYEN_DISPUTES_URL).replace(/\/$/, '');
  return URL_LIVE;
}
function configurada(env = process.env) {
  const falta = [];
  if (!env.ADYEN_DISPUTES_API_KEY) falta.push('ADYEN_DISPUTES_API_KEY');
  return { ok: !falta.length, falta };
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

async function chamar(metodo, corpo, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const cfg = configurada(env);
  if (!cfg.ok) throw new Error(`API de disputas da Adyen não configurada no servidor. Falta: ${cfg.falta.join(', ')}.`);
  const resp = await fetchImpl(`${urlBase(env)}/${metodo}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': env.ADYEN_DISPUTES_API_KEY },
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

// motivos de defesa que a bandeira aceita PARA ESTA disputa, com os
// documentos que cada um pede - é daqui que sai o que enviar
async function motivosDeDefesa({ pspDisputa, conta }, opcoes) {
  const d = await chamar('retrieveApplicableDefenseReasons', { disputePspReference: pspDisputa, merchantAccountCode: conta }, opcoes);
  return (d.defenseReasons || []).map((m) => ({
    codigo: m.defenseReasonCode, satisfeito: !!m.satisfied,
    documentos: (m.defenseDocumentTypes || []).map((t) => ({ codigo: t.defenseDocumentTypeCode, exigencia: t.requirementLevel || null, jaEnviado: !!t.available })),
  }));
}

// envia os documentos e defende. `documentos` = [{ buffer, contentType, tipo }]
async function defender({ pspDisputa, conta, motivo, documentos }, opcoes) {
  if (!documentos || !documentos.length) throw new Error('Nenhum documento para enviar.');
  await chamar('supplyDefenseDocument', {
    disputePspReference: pspDisputa, merchantAccountCode: conta,
    defenseDocuments: documentos.map((x) => ({ content: Buffer.from(x.buffer).toString('base64'), contentType: x.contentType, defenseDocumentTypeCode: x.tipo })),
  }, opcoes);
  await chamar('defendDispute', { disputePspReference: pspDisputa, merchantAccountCode: conta, defenseReasonCode: motivo }, opcoes);
  return { ok: true };
}

async function aceitar({ pspDisputa, conta }, opcoes) {
  await chamar('acceptDispute', { disputePspReference: pspDisputa, merchantAccountCode: conta }, opcoes);
  return { ok: true };
}

module.exports = { URL_LIVE, urlBase, configurada, contaDoCaso, chamar, motivosDeDefesa, defender, aceitar, VERSAO };
