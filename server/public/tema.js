// tema.js
// Aparência do Zenith por navegador (cada pessoa no seu aparelho): tema
// Escuro/Claro e tamanho da fonte. Carregado no <head> de TODAS as paginas
// (antes do body renderizar, pra nao "piscar" o tema errado). Os controles
// ficam numa secao "Aparência" no fim do menu ☰; a escolha e salva em
// localStorage e vale pra todas as telas.
//
// O tema claro funciona porque as 28 paginas usam o MESMO conjunto de
// variaveis CSS (--bg/--panel/--panel2/--line/--text/--muted/--ok/--warn/
// --bad/--accent + *-dim) - aqui a gente so sobrescreve as variaveis com
// uma paleta clara via :root[data-tema="claro"], sem tocar pagina a pagina.
// O tamanho da fonte usa zoom no <html> (as paginas medem tudo em px, entao
// mexer so no font-size nao escalaria nada).
(function () {
  if (window.__zenithTema) return;
  window.__zenithTema = true;

  var LS_TEMA = 'zenithTema';   // 'escuro' (padrao) | 'claro'
  var LS_FONTE = 'zenithFonte'; // percentual: 80..150 (padrao 100)
  var FONTE_MIN = 80, FONTE_MAX = 150, FONTE_PASSO = 10;

  function temaAtual() {
    return localStorage.getItem(LS_TEMA) === 'claro' ? 'claro' : 'escuro';
  }
  function fonteAtual() {
    var v = parseInt(localStorage.getItem(LS_FONTE), 10);
    return Number.isFinite(v) ? Math.min(FONTE_MAX, Math.max(FONTE_MIN, v)) : 100;
  }

  // paleta clara: mesmas variaveis, valores pro fundo branco. O accent fica
  // mais escuro que o azul do tema escuro pra continuar legivel como TEXTO
  // sobre branco (e ainda funcionar como fundo de botao)
  var style = document.createElement('style');
  style.id = 'zenith-tema-claro';
  style.textContent = [
    ':root[data-tema="claro"]{',
    '  --bg:#eef1f5; --panel:#ffffff; --panel2:#f2f5f8; --line:#d3dae2;',
    '  --text:#1d2733; --muted:#5d6a78;',
    '  --ok:#0e8a5f; --ok-dim:#dcf3e9;',
    '  --warn:#8f6400; --warn-dim:#faeccb;',
    '  --bad:#c62f2f; --bad-dim:#fbe3e3;',
    '  --accent:#0d7ac2;',
    '}',
    // paginas pintam o body com a var --bg, mas garante mesmo se alguma
    // tiver a cor no proprio body
    ':root[data-tema="claro"] body{background:var(--bg);color:var(--text);}',
  ].join('\n');
  document.head.appendChild(style);

  function aplicar() {
    document.documentElement.setAttribute('data-tema', temaAtual());
    // zoom escala texto E espacamentos (tudo em px nas paginas) - e o
    // comportamento esperado de "aumentar a fonte" nessas telas
    document.documentElement.style.zoom = fonteAtual() === 100 ? '' : (fonteAtual() / 100);
    var painel = document.getElementById('zenith-aparencia');
    if (painel) {
      painel.querySelector('[data-tema-btn="escuro"]').classList.toggle('ztema-ativo', temaAtual() === 'escuro');
      painel.querySelector('[data-tema-btn="claro"]').classList.toggle('ztema-ativo', temaAtual() === 'claro');
      painel.querySelector('#ztema-fonte-pct').textContent = fonteAtual() + '%';
    }
  }

  function definirTema(t) { localStorage.setItem(LS_TEMA, t); aplicar(); }
  function mudarFonte(delta) {
    var novo = Math.min(FONTE_MAX, Math.max(FONTE_MIN, fonteAtual() + delta));
    localStorage.setItem(LS_FONTE, String(novo));
    aplicar();
  }

  aplicar(); // roda ja no <head>: o body nasce com o tema/fonte certos

  // ---- controles no menu ☰ (secao "Aparência", no fim do drawer) ----
  function montarControles() {
    var drawer = document.querySelector('.nav-drawer');
    if (!drawer || document.getElementById('zenith-aparencia')) return;
    var css = document.createElement('style');
    css.textContent = [
      '#zenith-aparencia{padding:2px 10px 10px;display:flex;flex-direction:column;gap:6px;}',
      '#zenith-aparencia .ztema-linha{display:flex;gap:6px;align-items:center;}',
      '#zenith-aparencia button{background:var(--panel2,#181d24);border:1px solid var(--line,#232a33);color:var(--text,#e7ecf1);',
      '  border-radius:8px;padding:7px 10px;font-size:12px;cursor:pointer;flex:1;font-family:inherit;}',
      '#zenith-aparencia button.ztema-ativo{border-color:var(--accent,#5cc8ff);color:var(--accent,#5cc8ff);font-weight:700;}',
      '#zenith-aparencia .ztema-passo{flex:none;width:40px;font-weight:700;}',
      '#zenith-aparencia #ztema-fonte-pct{flex:1;text-align:center;font-family:var(--mono,monospace);font-size:11.5px;color:var(--muted,#7d8896);}',
    ].join('\n');
    document.head.appendChild(css);

    var grupo = document.createElement('div');
    grupo.className = 'nav-drawer-grupo';
    grupo.textContent = 'Aparência';
    var painel = document.createElement('div');
    painel.id = 'zenith-aparencia';
    painel.innerHTML =
      '<div class="ztema-linha">' +
        '<button type="button" data-tema-btn="escuro">🌙 Escuro</button>' +
        '<button type="button" data-tema-btn="claro">☀️ Claro</button>' +
      '</div>' +
      '<div class="ztema-linha">' +
        '<button type="button" class="ztema-passo" id="ztema-fonte-menos" title="Diminuir a fonte">A−</button>' +
        '<span id="ztema-fonte-pct">100%</span>' +
        '<button type="button" class="ztema-passo" id="ztema-fonte-mais" title="Aumentar a fonte">A+</button>' +
      '</div>';
    drawer.appendChild(grupo);
    drawer.appendChild(painel);
    painel.querySelector('[data-tema-btn="escuro"]').addEventListener('click', function () { definirTema('escuro'); });
    painel.querySelector('[data-tema-btn="claro"]').addEventListener('click', function () { definirTema('claro'); });
    painel.querySelector('#ztema-fonte-menos').addEventListener('click', function () { mudarFonte(-FONTE_PASSO); });
    painel.querySelector('#ztema-fonte-mais').addEventListener('click', function () { mudarFonte(FONTE_PASSO); });
    aplicar();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', montarControles);
  else montarControles();
})();
