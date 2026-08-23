// tema.js
// Aparência do NoPulso por navegador (cada pessoa no seu aparelho): tema
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

  // ---- fontes da marca (NoPulso) ----
  // Nao ha build no projeto: em vez de repetir o <link> nas 53 paginas, o
  // tema.js (que ja e carregado no <head> de todas) injeta o CSS das
  // fontes aqui. Archivo = titulos/corpo (--sans), JetBrains Mono =
  // numeros, rotulos e badges (--mono, que ja estava declarado mas caia no
  // fallback do sistema porque a fonte nunca era baixada).
  //
  // Servido pelo PROPRIO app (/fontes/), nao pelo CDN do Google: as lojas
  // tem piso de latencia alto e algumas ficam atras de rede restrita - uma
  // fonte que depende de fonts.gstatic.com e um ponto de falha externo num
  // app que roda o dia inteiro em maquina de balcao. Ver fontes/fontes.css.
  (function fontes() {
    if (document.getElementById('nopulso-fontes')) return;
    var css = document.createElement('link');
    css.id = 'nopulso-fontes';
    css.rel = 'stylesheet';
    css.href = '/fontes/fontes.css';
    document.head.appendChild(css);
  })();

  // ---- Beniboy: o avatar do assistente ----
  // Direcao aprovada no handoff de design (BENIBOY.md): circulo com o sinal
  // vital da marca - a MESMA polyline do logotipo NoPulso. Sem rosto, sem
  // olhos: o que "vive" e a linha de pulso. Substitui a cabeca de robo que
  // existia no widget e os emojis 🤖/🐝/🚨 espalhados pelas telas.
  //
  // Mora aqui pelo mesmo motivo das fontes: sao 6 lugares diferentes usando
  // o mesmo desenho (widget, atendimento, Central, menu, alarme) e o
  // tema.js ja e carregado por todas as paginas. Duplicar o SVG em 6
  // arquivos e o caminho mais curto pra eles divergirem na proxima mexida.
  //
  // A cor NUNCA e cravada: vem de var(--accent)/var(--accent2)/var(--bad)/
  // var(--ok), senao o tema Claro quebra (limao puro sobre branco e
  // ilegivel). A classe de estado troca so a cor e o ritmo.
  (function beniboy() {
    if (document.getElementById('nopulso-beniboy')) return;
    var st = document.createElement('style');
    st.id = 'nopulso-beniboy';
    st.textContent = [
      '.beniboy{flex:none;overflow:visible;color:var(--accent,#b8ff3c);}',
      '.beniboy .bb-nucleo,.beniboy .bb-anel,.beniboy .bb-eco,.beniboy .bb-traco{',
      '  stroke:currentColor;}',
      '.beniboy .bb-nucleo{fill:currentColor;stroke:none;}',
      '.beniboy .bb-fundo{fill:var(--panel,#12161b);}',
      /* A LINHA NUNCA DESAPARECE. A base fica solida na cor do estado e um
         brilho curto corre por cima. O "tracar e apagar" que existia aqui
         deixava o avatar vazio ~250ms por ciclo - em 40px no canto isso e
         batimento, em 112px numa tela de alarme parece defeito, e num PDF
         ou PPTX, que congela um frame, sai pela metade. Mesma mecanica do
         logotipo (ver marcaViva abaixo). */
      '.beniboy .bb-traco{filter:drop-shadow(0 0 5px currentColor);}',
      '.beniboy .bb-brilho{stroke:var(--pulso-brilho,#fff);stroke-dasharray:9 64;opacity:.9;',
      '  animation:bb-brilho var(--bb-ritmo,2.6s) linear infinite;}',
      '.beniboy .bb-nucleo{transform-box:fill-box;transform-origin:center;',
      '  animation:bb-nucleo var(--bb-ritmo,2.6s) ease-in-out infinite;}',
      '.beniboy .bb-anel{animation:bb-anel var(--bb-ritmo,2.6s) ease-in-out infinite;}',
      /* estados: so a cor e o ritmo mudam - o desenho e sempre o mesmo */
      '.beniboy.pensando{--bb-ritmo:1.7s;color:var(--accent2,#5cc8ff);}',
      '.beniboy.alarme{--bb-ritmo:1.1s;color:var(--bad,#ff5c5c);}',
      '.beniboy.resolvido{--bb-ritmo:3.6s;color:var(--ok,#3ddc97);}',
      /* no alarme em tela cheia o fundo ja e vermelho: o avatar vai em branco */
      '.beniboy.no-vermelho{color:#fff;}',
      '.beniboy.no-vermelho .bb-fundo{fill:rgba(255,255,255,.10);}',
      '.beniboy.no-vermelho .bb-brilho{stroke:#0b0d10;opacity:.5;}',
      '@keyframes bb-brilho{0%{stroke-dashoffset:73;}100%{stroke-dashoffset:-73;}}',
      '@keyframes bb-nucleo{0%,100%{transform:scale(.82);opacity:.16;}42%{transform:scale(1);opacity:.34;}}',
      '@keyframes bb-anel{0%,100%{opacity:.62;}42%{opacity:1;}}',
      '@media (prefers-reduced-motion:reduce){',
      '  .beniboy .bb-brilho{animation:none;opacity:0;}',
      '  .beniboy .bb-nucleo,.beniboy .bb-anel{animation:none;}}'
    ].join('\n');
    document.head.appendChild(st);
  })();

  // ---- a marca tambem bate ----
  // Decisao do usuario: onde tiver o sinal vital, ele se mexe - inclusive no
  // logotipo. Mas logotipo que SOME nao serve: a linha de base fica sempre
  // inteira e o que anda e um pulso claro por cima dela, como o cursor de um
  // monitor cardiaco. Assim a marca se move sem nunca ficar ilegivel.
  //
  // O ritmo e mais lento que o do Beniboy (3,6s x 2,6s) de proposito: as duas
  // coisas se mexem, mas quem chama atencao continua sendo o assistente.
  //
  // Comprimento real da polyline do logotipo: ~92,8 no viewBox 64x40 - o
  // dasharray de 96 cobre ela inteira com folga.
  (function marcaViva() {
    if (document.getElementById('nopulso-marca-viva')) return;
    var st = document.createElement('style');
    st.id = 'nopulso-marca-viva';
    st.textContent = [
      '.marca-brilho{stroke:var(--pulso-brilho,#fff);stroke-dasharray:12 82;opacity:.85;',
      '  animation:marca-brilho 3.2s linear infinite;}',
      '@keyframes marca-brilho{0%{stroke-dashoffset:94;}100%{stroke-dashoffset:-94;}}',
      '@media (prefers-reduced-motion:reduce){ .marca-brilho{animation:none;opacity:0;} }'
    ].join('\n');
    document.head.appendChild(st);
  })();

  // Devolve o SVG do Beniboy no tamanho pedido. `classes` aceita o estado
  // ('pensando', 'alarme', 'resolvido') e o 'no-vermelho' da tela de alarme.
  // Geometria fixa em viewBox 64x64 - so width/height mudam.
  window.beniboySVG = function (px, classes) {
    var t = px || 48;
    var pts = '14,34 22,34 27,21 33,45 38,32 50,32';
    return '<svg width="' + t + '" height="' + t + '" viewBox="0 0 64 64" fill="none"'
      + ' class="beniboy' + (classes ? ' ' + classes : '') + '" aria-hidden="true">'
      + '<circle class="bb-fundo" cx="32" cy="32" r="30"></circle>'
      + '<circle class="bb-nucleo" cx="32" cy="32" r="22"></circle>'
      + '<circle class="bb-anel" cx="32" cy="32" r="30" stroke-width="2.5" fill="none"></circle>'
      + '<polyline class="bb-traco" points="' + pts + '" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" fill="none"></polyline>'
      + '<polyline class="bb-brilho" points="' + pts + '" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" fill="none"></polyline>'
      + '</svg>';
  };

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
    // limao escurecido: o #b8ff3c da marca e ilegivel como TEXTO sobre
    // branco. Este tom mantem a familia da marca e da ~5:1 contra o branco
    // (texto) e ~5:1 contra o #0b0d10 (label de botao), no mesmo patamar do
    // azul que estava aqui antes.
    '  --accent:#5b8c00;',
    // --accent2 (dado tecnico) tambem precisa de versao clara: o ciano
    // #5cc8ff some no fundo branco. Reaproveita o azul que era o --accent.
    '  --accent2:#0d7ac2;',
    // O brilho que corre pelo traco (marca e Beniboy) e BRANCO no Escuro,
    // onde ele e mais claro que o limao. Sobre fundo branco, branco vira
    // buraco: o traco parece cortado em vez de aceso. No Claro ele vira um
    // verde bem mais escuro que o --accent, que e o que 'mais aceso'
    // significa nesse fundo. Mesma logica do --accent virar #5b8c00.
    '  --pulso-brilho:#1f3300;',
    // variaveis proprias do Abastecimento (balões/botões de PEDIDO x ENVIO
    // da "Conversa do pedido") - sem isso o balão ficava escuro com texto
    // escuro no tema claro (ilegivel, reportado em 2026-08-09)
    '  --pedido:#c62828; --pedido-dim:#fde7e5;',
    '  --envio:#175fb4; --envio-dim:#e4edfb;',
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
  // O drawer aparece como class OU id, dependendo da idade da pagina.
  function acharDrawer() { return document.querySelector('#nav-drawer, .nav-drawer'); }

  function montarControles() {
    var drawer = acharDrawer();
    if (!drawer || document.getElementById('zenith-aparencia')) return;
    var css = document.createElement('style');
    css.textContent = [
      '#zenith-aparencia{padding:2px 10px 10px;display:flex;flex-direction:column;gap:6px;}',
      '#zenith-aparencia .ztema-linha{display:flex;gap:6px;align-items:center;}',
      '#zenith-aparencia button{background:var(--panel2,#181d24);border:1px solid var(--line,#232a33);color:var(--text,#e7ecf1);',
      '  border-radius:8px;padding:7px 10px;font-size:12px;cursor:pointer;flex:1;font-family:inherit;}',
      '#zenith-aparencia button.ztema-ativo{border-color:var(--accent,#b8ff3c);color:var(--accent,#b8ff3c);font-weight:700;}',
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

  // O nav-menu.js monta o menu com `nav.innerHTML = ...`, o que APAGA tudo
  // que estiver dentro do drawer. Os dois esperam DOMContentLoaded e o
  // tema.js (que vive no <head>) registra o listener primeiro - entao a
  // ordem era: tema adiciona a "Aparência" -> nav-menu limpa o drawer e a
  // secao some. Era esse o motivo de o tema claro e o A+/A− terem
  // "desaparecido": o codigo estava aqui, mas o menu novo apagava a cada
  // carregamento.
  //
  // O observer resolve sem depender de ordem de carregamento: sempre que o
  // conteudo do drawer for trocado (por quem for), a Aparência volta. Nao
  // entra em laco porque montarControles sai na hora se a secao ja existe.
  // Em algumas paginas o drawer nem existe no HTML: o nav-menu.js cria e
  // pendura no body (ver nav-menu.js:484). Nesses casos, no momento em que
  // este arquivo roda ainda nao ha o que observar - por isso a espera pelo
  // body antes de vigiar o drawer.
  var obsCorpo = null;
  function vigiarDrawer() {
    var drawer = acharDrawer();
    if (!drawer) {
      if (!obsCorpo) {
        obsCorpo = new MutationObserver(vigiarDrawer);
        obsCorpo.observe(document.body, { childList: true });
      }
      return;
    }
    if (obsCorpo) { obsCorpo.disconnect(); obsCorpo = null; }
    montarControles();
    if (drawer.__zenithVigiado) return;
    drawer.__zenithVigiado = true;
    new MutationObserver(montarControles).observe(drawer, { childList: true });
  }

  function iniciar() { montarControles(); vigiarDrawer(); }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
  else iniciar();
})();
