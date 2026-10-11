// Atalhos do fluxo de balcão do Saltiverso. O menu lateral continua sendo a
// navegação geral; este painel evita que quem está atendendo precise abrir o
// menu para alternar entre Check-in, Quiosque e Pulseiras.
(function () {
  if (window.__saltiversoNavegacao) return;
  window.__saltiversoNavegacao = true;

  const DESTINOS = [
    { href: '/parque-checkin', icone: '🤸', titulo: 'Check-in do Parque', detalhe: 'Registrar entrada', secoes: ['parque-checkin'] },
    { href: '/saltiverso-vendas', icone: '🥤', titulo: 'Quiosque', detalhe: 'Bebidas e meias', secoes: ['parque-loja'] },
    { href: '/parque-pulseiras', icone: '🎨', titulo: 'Central de Pulseiras', detalhe: 'Cores e saídas', secoes: ['parque', 'parque-checkin'] },
  ];

  function esc(valor) {
    return String(valor == null ? '' : valor).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function podeVer(destino, me) {
    if (me && me.role === 'master') return true;
    const secoes = (me && me.permissions && me.permissions.sections) || [];
    return destino.secoes.some((secao) => secoes.includes(secao));
  }
  function inserir(me) {
    if (document.getElementById('saltiverso-fluxo')) return;
    const destinos = DESTINOS.filter((destino) => podeVer(destino, me));
    if (destinos.length < 2) return;
    const atual = location.pathname.replace(/\/$/, '') || '/';
    const painel = document.createElement('nav');
    painel.id = 'saltiverso-fluxo';
    painel.setAttribute('aria-label', 'Atalhos do fluxo Saltiverso');
    painel.innerHTML = `<div class="sf-titulo"><span>Fluxo Saltiverso</span><small>troque de etapa sem abrir o menu</small></div><div class="sf-links">${destinos.map((destino) => {
      const ativo = atual === destino.href;
      return `<a href="${esc(destino.href)}" class="sf-link${ativo ? ' ativo' : ''}"${ativo ? ' aria-current="page"' : ''}><span class="sf-icone">${destino.icone}</span><span><b>${esc(destino.titulo)}</b><small>${esc(destino.detalhe)}</small></span></a>`;
    }).join('')}</div>`;
    const header = document.querySelector('header');
    if (header) header.insertAdjacentElement('afterend', painel);
    else document.body.insertBefore(painel, document.body.firstChild);
  }
  function estilo() {
    if (document.getElementById('saltiverso-fluxo-estilo')) return;
    const css = document.createElement('style');
    css.id = 'saltiverso-fluxo-estilo';
    css.textContent = `
      #saltiverso-fluxo{margin:0 0 16px;padding:10px 11px;border:1px solid var(--line,#232a33);border-radius:12px;background:linear-gradient(105deg,rgba(184,255,60,.10),transparent 68%),var(--panel,#12161b)}
      #saltiverso-fluxo .sf-titulo{display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin:1px 2px 9px;color:var(--accent,#b8ff3c);font:700 10px var(--mono,monospace);letter-spacing:.09em;text-transform:uppercase}
      #saltiverso-fluxo .sf-titulo small{color:var(--muted,#7d8896);font:10px var(--sans,sans-serif);letter-spacing:0;text-transform:none}
      #saltiverso-fluxo .sf-links{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px}
      #saltiverso-fluxo .sf-link{display:flex;align-items:center;gap:8px;min-height:54px;padding:8px 9px;border:1px solid var(--line,#232a33);border-radius:9px;background:var(--panel2,#181d24);color:var(--text,#e7ecf1);text-decoration:none;transition:border-color .15s,background .15s,transform .15s}
      #saltiverso-fluxo .sf-link:hover{border-color:var(--accent,#b8ff3c);transform:translateY(-1px)}
      #saltiverso-fluxo .sf-link.ativo{border-color:var(--accent,#b8ff3c);background:rgba(184,255,60,.13);color:var(--accent,#b8ff3c)}
      #saltiverso-fluxo .sf-icone{font-size:20px;line-height:1;flex:none}#saltiverso-fluxo b{display:block;font-size:11.5px;line-height:1.2}#saltiverso-fluxo .sf-link small{display:block;margin-top:3px;color:var(--muted,#7d8896);font:10px var(--sans,sans-serif);line-height:1.15}
      @media(max-width:520px){#saltiverso-fluxo{margin-bottom:13px}#saltiverso-fluxo .sf-titulo small{display:none}#saltiverso-fluxo .sf-links{grid-template-columns:1fr}#saltiverso-fluxo .sf-link{min-height:48px}#saltiverso-fluxo .sf-link small{display:inline;margin:0 0 0 5px}#saltiverso-fluxo b{display:inline}}
      @media(min-width:521px) and (max-width:680px){#saltiverso-fluxo .sf-link{padding:8px 6px;gap:6px}#saltiverso-fluxo .sf-icone{font-size:17px}#saltiverso-fluxo b{font-size:10.5px}}
    `;
    document.head.appendChild(css);
  }
  async function iniciar() {
    try {
      const token = localStorage.getItem('authToken');
      if (!token) return;
      const resposta = await fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } });
      if (!resposta.ok) return;
      estilo(); inserir(await resposta.json());
    } catch (_) { /* a tela principal continua operando sem os atalhos */ }
  }
  iniciar();
}());
