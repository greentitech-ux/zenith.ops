'use strict';
// O conteúdo do campo nunca sai daqui. Somente { token, ativo } vai ao servidor.
(function () {
  if (window.nopulsoDigitando) return;
  const contextos = new Map(), enviarFetch = window.fetch.bind(window);
  function visivel(c) { return !document.hidden && c.input.isConnected && c.input.getClientRects().length > 0; }
  function aviso(c, ativo) {
    c.aviso.textContent = ativo ? (c.lado === 'suporte' ? 'Solicitante está digitando…' : 'Suporte está digitando…') : '';
    c.aviso.hidden = !ativo;
  }
  function sinal(c, ativo) {
    if (ativo && (Date.now() - c.ultimo < 4000 || !visivel(c))) return;
    if (!ativo && !c.ativo) return;
    c.ativo = ativo;
    if (ativo) c.ultimo = Date.now();
    enviarFetch(`/api/suporte-chat/${encodeURIComponent(c.id)}/digitando`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: c.token, ativo }), keepalive: !ativo,
    }).catch(() => {}); // Falha de presença nunca bloqueia mensagem.
  }
  function suspender(c) {
    clearTimeout(c.parada); clearTimeout(c.expiracao); sinal(c, false);
    if (c.es) c.es.close(); c.es = null; aviso(c, false);
  }
  function abrir(c) {
    if (c.es || c.falhou || !visivel(c)) return;
    const es = c.es = new EventSource(`/api/suporte-chat/${encodeURIComponent(c.id)}/digitando-stream?token=${encodeURIComponent(c.token)}`);
    es.addEventListener('digitando', e => {
      try {
        const v = JSON.parse(e.data), prazo = Math.min(8000, Math.max(0, Number(v.prazoMs) || 0));
        clearTimeout(c.expiracao); aviso(c, v.ativo === true && prazo > 0);
        if (v.ativo && prazo > 0) c.expiracao = setTimeout(() => aviso(c, false), prazo);
      } catch (_) { aviso(c, false); }
    });
    es.onerror = () => { es.close(); c.es = null; c.falhou = true; aviso(c, false); };
  }
  function parar(chave) {
    const c = contextos.get(chave); if (!c) return;
    suspender(c); c.input.removeEventListener('input', c.digitou); c.input.removeEventListener('blur', c.saiu);
    c.aviso.remove(); contextos.delete(chave);
  }
  function conectar({ chave, input, id, token, lado, antes }) {
    const anterior = contextos.get(chave);
    if (!input || !token) { parar(chave); return; }
    if (!input.isConnected) return;
    if (anterior && anterior.input === input && anterior.token === token) {
      anterior.falhou = false; abrir(anterior); return;
    }
    parar(chave);
    const el = document.createElement('div'); el.className = 'chat-digitando'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite'); el.hidden = true;
    el.style.cssText = 'flex:none;font-size:11px;color:var(--muted);padding:4px 8px;';
    if (antes) antes.before(el); else input.parentElement.before(el);
    const c = { input, id, token, lado, aviso: el, ultimo: -Infinity, ativo: false, es: null, falhou: false };
    c.digitou = () => {
      clearTimeout(c.parada);
      if (!input.value.trim()) { sinal(c, false); return; }
      sinal(c, true); c.parada = setTimeout(() => sinal(c, false), 3000);
    };
    c.saiu = () => { clearTimeout(c.parada); sinal(c, false); };
    input.addEventListener('input', c.digitou); input.addEventListener('blur', c.saiu);
    contextos.set(chave, c); abrir(c);
  }
  function enviado(chave) { const c = contextos.get(chave); if (c) c.saiu(); }
  const verificar = () => {
    for (const [chave, c] of contextos) {
      if (!c.input.isConnected) { parar(chave); continue; }
      if (!visivel(c)) suspender(c); else abrir(c);
    }
  };
  setInterval(verificar, 1000);
  document.addEventListener('visibilitychange', verificar);
  window.addEventListener('pagehide', () => { for (const c of contextos.values()) suspender(c); });
  window.nopulsoDigitando = { conectar, parar, enviado };
})();
