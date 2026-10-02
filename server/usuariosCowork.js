// Campainha opcional para o Cowork de Usuários. A solicitação na Central é a
// fonte de verdade; falha no webhook nunca pode perder o encaminhamento.
const TIMEOUT_MS = 8000;

async function avisar({ protocolo, solicitacaoId }) {
  const url = process.env.COWORK_USUARIOS_WEBHOOK_URL;
  if (!url) return { avisado: false, motivo: 'COWORK_USUARIOS_WEBHOOK_URL não configurado (o Cowork encontra pela varredura)' };
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(process.env.COWORK_USUARIOS_WEBHOOK_TOKEN ? { 'x-bot-token': process.env.COWORK_USUARIOS_WEBHOOK_TOKEN } : {}) }, body: JSON.stringify({ protocolo, solicitacaoId }), signal: ctrl.signal });
    return resp.ok ? { avisado: true, motivo: null } : { avisado: false, motivo: `Cowork respondeu ${resp.status}` };
  } catch (err) {
    return { avisado: false, motivo: err.name === 'AbortError' ? 'sem resposta em 8s' : err.message };
  } finally { clearTimeout(timer); }
}

module.exports = { avisar, TIMEOUT_MS };
