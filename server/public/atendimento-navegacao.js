'use strict';
(function () {
  // Links não são autorização: a origem de destino exige a própria sessão.
  // Nenhum dado do usuário entra no endereço ou é transmitido entre abas.
  const seletores = '[data-area-destino]';
  const estilo = document.createElement('style');
  estilo.textContent = `${seletores}[hidden]{display:none!important}`;
  document.head.appendChild(estilo);
  function ocultar(a) { a.hidden = true; a.removeAttribute('href'); }
  function enderecoSeguro(valor, tipo) {
    try {
      const u = new URL(valor);
      const caminho = tipo === 'nopulso' ? '/' : '/atendimento/central';
      if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.pathname !== caminho) return null;
      return u.href;
    } catch (_) { return null; }
  }
  async function preparar() {
    const links = [...document.querySelectorAll(seletores)];
    links.forEach(ocultar);
    const token = localStorage.getItem('authToken');
    if (!token || !links.length) return;
    try {
      const r = await fetch('/api/beniboy/acesso', { headers: { Authorization: 'Bearer ' + token }, cache: 'no-store' });
      if (!r.ok) return;
      const d = await r.json();
      if (localStorage.getItem('authToken') !== token) return;
      for (const a of links) {
        const tipo = a.dataset.areaDestino;
        if (!['nopulso', 'atendimento'].includes(tipo)) continue;
        const href = enderecoSeguro(d.enderecos?.[tipo], tipo);
        if (!href) continue;
        a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.title = 'Abre em outra aba. Seu atendimento permanece aberto; o destino valida seu acesso.';
        a.hidden = false;
      }
    } catch (_) { /* Sem validação, nenhum atalho é liberado. */ }
  }
  window.prepararNavegacaoAtendimento = preparar;
  window.addEventListener('storage', e => { if (e.key === 'authToken' || e.key === null) preparar(); });
  // Voltar à aba após sair/expirar em outra área revalida sem polling.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) preparar(); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', preparar, { once: true });
  else preparar();
})();
