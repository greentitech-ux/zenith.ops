'use strict';

// Confere o endereço externo que o cliente receberá, sem cookie ou sessão.
async function validarLinkPreenchimento(base, formulario) {
  if (!formulario.tokenPreenchimento) throw new Error('Formulário sem token de preenchimento.');
  const raiz = String(base).replace(/\/+$/, '');
  const token = encodeURIComponent(formulario.tokenPreenchimento);
  const link = `${raiz}/preencher?token=${token}`;
  try {
    const opcoes = { redirect: 'error', signal: AbortSignal.timeout(10000), headers: { 'Cache-Control': 'no-cache' } };
    const pagina = await fetch(link, opcoes);
    if (!pagina.ok || !/text\/html/i.test(pagina.headers.get('content-type') || '')
      || !(await pagina.text()).includes('/api/formularios-publico/preencher/')) throw new Error('Página indisponível');
    const resposta = await fetch(`${raiz}/api/formularios-publico/preencher/${token}`, opcoes);
    if (!resposta.ok) throw new Error('Token indisponível');
    const vista = await resposta.json();
    if (vista.id !== formulario.id) throw new Error('Formulário divergente');
    return link;
  } catch (_) {
    // Não incluir o token (nem o erro de fetch com a URL) nos logs de auditoria.
    throw new Error(`Formulário #${formulario.numeroTicket} salvo, mas o link público não passou na validação. Verifique o deploy e APP_BASE_URL e tente novamente com outra idempotencyKey; o formulário pendente será reaproveitado.`);
  }
}

module.exports = { validarLinkPreenchimento };
