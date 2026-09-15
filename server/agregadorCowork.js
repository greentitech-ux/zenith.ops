// agregadorCowork.js
//
// O toque de campainha no Cowork Agregador. A fila (agregadorFila.js) é a
// fonte de verdade e funciona sozinha: o Cowork puxa, executa, confirma. Isto
// aqui só existe pra ele não precisar ESPERAR o próximo ciclo - loja parada é
// prejuízo por minuto, e um pedido de "pausar a coca" que fica 5 minutos numa
// fila silenciosa já nasceu atrasado.
//
// Por isso o aviso é, de propósito, descartável: se não houver URL
// configurada, se a rede cair ou se o Cowork responder erro, NADA se perde -
// o pedido continua na fila e ele pega no ciclo seguinte. Este arquivo nunca
// lança: uma falha de rede aqui não pode derrubar a resposta do Beniboy.
//
// Configuração (Render, e nada disso vai pro código):
//   AGREGADOR_WEBHOOK_URL    - endereço que acorda o Cowork (opcional)
//   AGREGADOR_WEBHOOK_TOKEN  - vai no header x-bot-token, mesmo padrão dos
//                              outros robôs do app (ver exigirTokenBot)
const TIMEOUT_MS = 8000;

function configurado() {
  return !!process.env.AGREGADOR_WEBHOOK_URL;
}

// Avisa o Cowork que há pedido novo. Devolve sempre um objeto, nunca lança:
// { avisado, motivo }. `motivo` é o que aparece no log quando não deu - a
// operação precisa conseguir distinguir "não configurei" de "o Cowork caiu".
async function avisarPedidoNovo(pedido) {
  const url = process.env.AGREGADOR_WEBHOOK_URL;
  if (!url) return { avisado: false, motivo: 'AGREGADOR_WEBHOOK_URL não configurado (o Cowork pega no próximo ciclo da fila)' };
  const corpo = {
    evento: 'agregador.pedido',
    // o payload leva o pedido inteiro pro Cowork poder agir direto, e o id
    // pra ele confirmar depois em /api/bot/agregador/retorno
    pedido: {
      id: pedido.id,
      acao: pedido.acao,
      canal: pedido.canal,
      unidade: pedido.unidade,
      unidadeNome: pedido.unidadeNome,
      item: pedido.item,
      motivo: pedido.motivo,
      criadoEm: pedido.criadoEm,
    },
  };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // mesmo cabeçalho que o NoPulso EXIGE de quem entra (exigirTokenBot):
        // o Cowork reconhece que a batida veio daqui, e não de qualquer um
        // que descubra a URL dele
        ...(process.env.AGREGADOR_WEBHOOK_TOKEN ? { 'x-bot-token': process.env.AGREGADOR_WEBHOOK_TOKEN } : {}),
      },
      body: JSON.stringify(corpo),
      signal: ctrl.signal,
    });
    if (!resp.ok) return { avisado: false, motivo: `o Cowork respondeu ${resp.status}` };
    return { avisado: true, motivo: null };
  } catch (err) {
    return { avisado: false, motivo: err.name === 'AbortError' ? `sem resposta em ${TIMEOUT_MS / 1000}s` : err.message };
  } finally {
    clearTimeout(t);
  }
}

module.exports = { configurado, avisarPedidoNovo, TIMEOUT_MS };
