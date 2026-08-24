// nav-menu.js
// FONTE UNICA do menu lateral (hamburguer) de todo o NoPulso: a
// definicao dos itens, a montagem do HTML, a regra de quem ve o que, o
// acordeao dos grupos, o realce da pagina atual e o visual.
//
// POR QUE ISSO EXISTE: antes cada pagina carregava a PROPRIA copia do
// <nav> no HTML. Com ~35 paginas, o menu virou 35 menus diferentes -
// auditoria de 16/08 encontrou link faltando em 8 a 13 paginas (quem abria
// o Beniboy ou o Dashboard de Atendimentos simplesmente nao via metade do
// sistema), dois ids pro MESMO link (nav-entrega-lancamento e
// nav-entregas-lancamento - o segundo escapava do filtro de permissao) e
// rotulo divergente ("Email" x "E-mail"). Toda pagina nova tambem nascia
// com o menu desatualizado, e todo link novo exigia editar 35 arquivos.
//
// Agora: a pagina so precisa ter <nav id="nav-drawer"> vazio (e, se
// quiser, o overlay) - este script preenche. Adicionar um item ao menu =
// uma linha em MENU aqui, e ele aparece em TODAS as telas de uma vez.
//
// Substitui o antigo nav-gate.js (que so escondia/mostrava links que a
// pagina ja tinha declarado).
(function () {
  const token = localStorage.getItem('authToken');

  // ---------------------------------------------------------------
  // 1) A DEFINICAO DO MENU - unica coisa que se mexe no dia a dia.
  //
  // Regras de visibilidade por item (a primeira que existir vale):
  //   master:true  -> so role 'master'
  //   admin:true   -> master OU isAdmin
  //   secoes:[...] -> master/admin OU quem tem QUALQUER uma das secoes
  //   (nada)       -> todo mundo logado
  // ---------------------------------------------------------------
  const MENU = [
    { itens: [
      { id: 'nav-painel', href: '/painel.html', icone: '🏠', rotulo: 'Painel' },
    ] },
    { grupo: 'Operação diária', itens: [
      // /lancamento.html serve DUAS coisas: quem tem 'lancamento' cai no
      // painel de fechamento, quem so tem 'sangria' cai no de sangria/
      // deposito. Antes a propria pagina reescrevia o texto do link
      // (getElementById('nav-self')) - o que so funcionava DENTRO dela.
      // Aqui o rotulo certo aparece no menu de qualquer tela.
      { id: 'nav-lancamento', href: '/lancamento.html', icone: '🧾', rotulo: 'Fechamento', secoes: ['lancamento', 'sangria'],
        alt: { quando: (me) => !temSecao(me, 'lancamento') && temSecao(me, 'sangria'), icone: '💰', rotulo: 'Sangria/Depósito' } },
      { id: 'nav-saidas-painel', href: '/saidas.html', icone: '📤', rotulo: 'Painel de Saídas', secoes: ['lancamento', 'sangria'] },
      { id: 'nav-entrega-lancamento', href: '/entrega-lancamento.html', icone: '📦', rotulo: 'Lançar entrega', secoes: ['entregas-lancamento'] },
      // pagina de Fechamentos e uma so (fechamentos.html), mas cada franquia
      // so quer ver o proprio numero sem lembrar de trocar um filtro toda
      // vez - por isso 2 itens de menu, cada um mandando pra ca com
      // ?grupo=ARCFOOD/BRAVO ja fixado (a pagina trava o seletor sozinha
      // quando ve o parametro, ver GRUPO_FIXO em fechamentos.html)
      { id: 'nav-fechamentos-arcfood', href: '/fechamentos.html?grupo=ARCFOOD', icone: '💰', rotulo: 'Fechamentos Arcfood', secoes: ['fechamentos'], redes: ['ARCFOOD'] },
      { id: 'nav-fechamentos-gbe', href: '/fechamentos.html?grupo=BRAVO', icone: '💰', rotulo: 'Fechamentos GBE', secoes: ['fechamentos'], redes: ['GBE'] },
      { id: 'nav-kpis-operacionais', href: '/kpis-operacionais.html', icone: '⏱️', rotulo: "KPI's operacionais", secoes: ['fechamentos'] },
      { id: 'nav-vendas-recordes', href: '/vendas-recordes.html', icone: '🏆', rotulo: 'Recordes de Venda', secoes: ['fechamentos'] },
      { id: 'nav-entregas', href: '/entregas.html', icone: '🛵', rotulo: 'Entregas', secoes: ['entregas'] },
      { id: 'nav-inventario', href: '/estoque.html', icone: '📦', rotulo: 'Estoque', secoes: ['inventario'] },
      { id: 'nav-abastecimento', href: '/abastecimento.html', icone: '🛒', rotulo: 'Abastec. Carrinho', secoes: ['abastecimento-carrinho', 'abastecimento-loja'] },
      { id: 'nav-abastecimento-relatorios', href: '/abastecimento-relatorios.html', icone: '📊', rotulo: 'Relatórios do Carrinho', master: true },
    ] },
    { grupo: 'Monitoramento', itens: [
      { id: 'nav-monitor', href: '/monitor.html', icone: '📈', rotulo: 'Monitor', secoes: ['monitor'] },
      { id: 'nav-relatorios', href: '/relatorios.html', icone: '📊', rotulo: 'Relatórios', secoes: ['disputas'] },
      { id: 'nav-ifood', href: '/ifood.html', icone: '🍔', rotulo: 'iFood', secoes: ['ifood'] },
      // conectividade das lojas: e infra, encaixa melhor aqui do que em
      // Solicitacoes (onde estava) - mesmo publico do Beniboy
      { id: 'nav-loja-status', href: '/loja-status.html', icone: '📡', rotulo: 'NOC Zenith', secoes: ['suporte'] },
      { id: 'nav-noc-rede', href: '/noc-rede.html', icone: '📈', rotulo: 'Análise de Rede', secoes: ['suporte'] },
      { id: 'nav-noc-maquinas', href: '/noc-maquinas.html', icone: '💽', rotulo: 'Saúde das Máquinas', secoes: ['suporte'] },
    ] },
    { grupo: 'Atendimento', itens: [
      { id: 'nav-beniboy', href: '/beniboy.html', icone: (window.beniboySVG ? window.beniboySVG(20) : '🐝'), rotulo: 'Central do Beniboy', secoes: ['suporte'] },
      { id: 'nav-dashboard-atendimentos', href: '/dashboard-atendimentos.html', icone: '📊', rotulo: 'Dashboard de Atendimentos', secoes: ['suporte'] },
      { id: 'nav-central-solucoes', href: '/central-solucoes.html', icone: '💬', rotulo: 'Central de Soluções', secoes: ['central-solucoes'] },
    ] },
    { grupo: 'Solicitações', itens: [
      { id: 'nav-solicitacoes', href: '/central.html', icone: '📋', rotulo: 'Central', secoes: ['solicitacoes'] },
      { id: 'nav-compras', href: '/compras.html', icone: '🛍️', rotulo: 'Acompanhar Compras', secoes: ['solicitacoes'] },
      // resumo pessoal (por status/unidade + meus abertos/concluidos) que
      // antes vivia dentro do Historico - separado em pagina propria porque
      // misturado com o quadro do Historico ficava bagunçado
      { id: 'nav-inicio-solicitacoes', href: '/central-inicio.html', icone: '📊', rotulo: 'Início', secoes: ['solicitacoes', 'manutencao', 'tecnico'] },
      // o Historico tambem serve pra quem RECEBE card atribuido
      { id: 'nav-historico', href: '/central-historico.html', icone: '📜', rotulo: 'Histórico', secoes: ['solicitacoes', 'manutencao', 'tecnico'] },
      { id: 'nav-tecnico', href: '/tecnico.html', icone: '🔧', rotulo: 'Chamados TI', secoes: ['tecnico', 'suporte'] },
      { id: 'nav-manutencao', href: '/manutencao.html', icone: '🛠️', rotulo: 'Manutenção', secoes: ['manutencao'] },
      { id: 'nav-ativos-ti', href: '/ativos-ti.html', icone: '🖥️', rotulo: 'Ativos de TI', secoes: ['ativos-ti'] },
      { id: 'nav-formularios', href: '/formularios.html', icone: '🖊️', rotulo: 'Formulários', secoes: ['formularios'] },
    ] },
    { grupo: 'Saltiverso', itens: [
      { id: 'nav-parque-checkin', href: '/parque-checkin.html', icone: '🤸', rotulo: 'Check-in Parque', secoes: ['parque-checkin'] },
      { id: 'nav-parque', href: '/parque.html', icone: '🎡', rotulo: 'Parque (painel)', secoes: ['parque'] },
      { id: 'nav-festas', href: '/festas.html', icone: '🎉', rotulo: 'Festas', secoes: ['festas'] },
      { id: 'nav-mensalistas', href: '/mensalistas.html', icone: '📅', rotulo: 'Mensalistas', secoes: ['parque'] },
      { id: 'nav-saltiverso-vendas', href: '/saltiverso-vendas.html', icone: '🥤', rotulo: 'Bebidas & Meias', secoes: ['parque-loja'] },
      { id: 'nav-saltiverso-fechamento', href: '/saltiverso-fechamento.html', icone: '🧾', rotulo: 'Fechamento do balcão', secoes: ['parque-loja'] },
    ] },
    { grupo: 'BigBrother', itens: [
      { id: 'nav-rh', href: '/rh.html', icone: '🧑‍💼', rotulo: 'RH', secoes: ['rh'] },
    ] },
    { grupo: 'Bonificação', itens: [
      { id: 'nav-bonificacao', href: '/bonificacao.html', icone: '🏆', rotulo: 'Bonificação', secoes: ['bonificacao'] },
    ] },
    { grupo: 'Administração', itens: [
      { id: 'nav-usuarios', href: '/usuarios.html', icone: '👤', rotulo: 'Usuários', master: true },
      { id: 'nav-grupos', href: '/grupos.html', icone: '🏷️', rotulo: 'Grupos', master: true },
      { id: 'nav-cofre', href: '/cofre.html', icone: '🔐', rotulo: 'Cofre', secoes: ['cofre'] },
      { id: 'nav-central-alertas', href: '/central-alertas.html', icone: '🚨', rotulo: 'Central de Alertas', master: true },
      { id: 'nav-entregas-regras', href: '/entregas-regras.html', icone: '⚙️', rotulo: 'Regras de Entregas', master: true },
      { id: 'nav-email', href: '/email.html', icone: '✉️', rotulo: 'Email', master: true },
      { id: 'nav-login-custom', href: '/login-custom.html', icone: '🎨', rotulo: 'Tela de Login', master: true },
      { id: 'nav-reset-senha', href: '/painel.html?resetSenha=1', icone: '🔑', rotulo: 'Reset senha', admin: true },
    ] },
  ];

  // ---------------------------------------------------------------
  // 1b) VOLTAR - telas que sao um detalhe/relatorio/config de outra
  //     ganham uma seta "‹ Nome do pai" colada no hamburguer.
  //
  //     O pai e apontado pelo ID DO ITEM DE MENU, nao pela URL: assim o
  //     href, o rotulo e a REGRA DE PERMISSAO saem todos da definicao
  //     unica la de cima. Se a pessoa nao pode abrir o pai, a seta nem
  //     aparece - senao ela levaria direto pro "voce nao tem acesso a
  //     esta pagina", que e pior do que nao ter atalho nenhum.
  //
  //     Criterio pra entrar aqui: a tela filha so faz sentido DEPOIS de
  //     passar pela mae. Telas irmas (Central x Historico, por exemplo)
  //     ficam de fora de proposito - seta de voltar entre iguais so
  //     confunde quem esta lendo a hierarquia.
  // ---------------------------------------------------------------
  const VOLTAR = {
    '/noc-rede.html': 'nav-loja-status',
    '/noc-maquinas.html': 'nav-loja-status',
    '/vendas-recordes.html': 'nav-fechamentos-arcfood',
    '/abastecimento-relatorios.html': 'nav-abastecimento',
    '/entregas-regras.html': 'nav-entregas',
    '/dashboard-atendimentos.html': 'nav-beniboy',
    '/mensalistas.html': 'nav-parque',
  };

  function itemPorId(id) {
    for (const sec of MENU) {
      const it = sec.itens.find((i) => i.id === id);
      if (it) return it;
    }
    return null;
  }

  // ---------------------------------------------------------------
  // 2) VISUAL - injetado daqui pra nao depender do CSS de cada pagina
  //    (cada uma tem a sua copia, entao mudar visual "no CSS" exigiria
  //    editar 35 arquivos de novo - exatamente o problema que isso resolve)
  // ---------------------------------------------------------------
  function injetarEstilo() {
    if (document.getElementById('nav-menu-estilo')) return;
    const st = document.createElement('style');
    st.id = 'nav-menu-estilo';
    st.textContent = `
      #nav-drawer{
        position:fixed; top:0; left:0; bottom:0; width:270px; max-width:84vw;
        background:var(--panel,#12161b); border-right:1px solid var(--line,#232a33);
        z-index:999; padding:0; overflow:hidden;
        display:flex!important; flex-direction:column; gap:0;
        /* so o transform anima. Visibility fica FORA da transicao de
           proposito: como propriedade discreta, ela so vira 'visible' no
           meio/fim da animacao, e o menu piscava fora da tela no primeiro
           frame ao abrir. */
        transition:transform .22s cubic-bezier(.4,0,.2,1);
        box-shadow:6px 0 28px rgba(0,0,0,.45);
      }
      /* fechado = fora da tela (em vez de display:none) pra ter animacao.
         Se este CSS nao carregar, o display:none!important da pagina
         continua valendo como fallback seguro. */
      #nav-drawer.hidden{ transform:translateX(-102%); visibility:hidden; }
      #nav-drawer-overlay{
        position:fixed; inset:0; background:rgba(0,0,0,.5);
        backdrop-filter:blur(2px); -webkit-backdrop-filter:blur(2px);
        z-index:998; transition:opacity .22s;
      }
      #nav-drawer-overlay.hidden{ display:none!important; }

      .nmz-topo{
        padding:14px 14px 10px; border-bottom:1px solid var(--line,#232a33);
        flex:none; display:flex; align-items:center; gap:10px;
      }
      /* logotipo NoPulso: "No" no texto normal + "Pulso" no acento, com a
         marca grafica de sinal vital a esquerda (mesma polyline do login,
         so que em 30x20). Antes era o nome em mono/caixa-alta; virou
         wordmark em Archivo 800 pra bater com a identidade nova. */
      .nmz-marca{ display:flex; align-items:center; gap:7px; min-width:0;
        font-family:var(--sans,sans-serif); font-size:16px; font-weight:800;
        letter-spacing:-.02em; line-height:1.15; color:var(--text,#e7ecf1); }
      .nmz-marca svg{ flex:none; display:block; }
      .nmz-marca b{ color:var(--accent,#b8ff3c); font-weight:800; }
      .nmz-quem{ font-size:11px; color:var(--muted,#7d8896); margin-top:2px;
        overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:180px; }
      .nmz-fechar{
        margin-left:auto; flex:none; background:none; border:1px solid var(--line,#232a33);
        color:var(--muted,#7d8896); border-radius:8px; width:30px; height:30px;
        font-size:15px; line-height:1; cursor:pointer; transition:.15s;
      }
      .nmz-fechar:hover{ color:var(--text,#e7ecf1); border-color:var(--accent,#b8ff3c); }

      .nmz-corpo{ flex:1 1 auto; overflow-y:auto; padding:8px; }
      .nmz-corpo::-webkit-scrollbar{ width:8px; }
      .nmz-corpo::-webkit-scrollbar-thumb{ background:var(--line,#232a33); border-radius:8px; }

      .nmz-grupo{
        display:flex; align-items:center; justify-content:space-between;
        font-family:var(--mono,monospace); font-size:9.5px; color:var(--muted,#7d8896);
        text-transform:uppercase; letter-spacing:.1em; font-weight:700;
        padding:12px 10px 5px; cursor:pointer; user-select:none; transition:color .15s;
      }
      .nmz-grupo:hover{ color:var(--text,#e7ecf1); }
      .nmz-grupo .nmz-seta{ font-size:9px; transition:transform .18s ease; opacity:.7; }
      .nmz-grupo.fechado .nmz-seta{ transform:rotate(-90deg); }
      .nmz-wrap{ display:flex; flex-direction:column; gap:1px; overflow:hidden; }
      .nmz-wrap.hidden{ display:none!important; }

      #nav-drawer a.nmz-item, #nav-drawer button.nmz-item{
        display:flex; align-items:center; gap:10px; width:100%; box-sizing:border-box;
        padding:9px 10px; border-radius:9px; font-size:12.8px; line-height:1.25;
        color:var(--text,#e7ecf1); text-decoration:none; position:relative;
        border:1px solid transparent; transition:background .13s, color .13s, border-color .13s;
      }
      #nav-drawer .nmz-item .nmz-ico{
        flex:none; width:20px; text-align:center; font-size:14px; line-height:1;
        filter:grayscale(.25); transition:filter .13s;
      }
      #nav-drawer .nmz-item:hover{ background:var(--panel2,#181d24); }
      #nav-drawer .nmz-item:hover .nmz-ico{ filter:none; }
      #nav-drawer a.nmz-item.active{
        background:rgba(184, 255, 60,.13); color:var(--accent,#b8ff3c); font-weight:600;
      }
      #nav-drawer a.nmz-item.active .nmz-ico{ filter:none; }
      #nav-drawer a.nmz-item.active::before{
        content:""; position:absolute; left:0; top:6px; bottom:6px; width:3px;
        border-radius:0 3px 3px 0; background:var(--accent,#b8ff3c);
      }
      #nav-drawer a.nmz-item.hidden, #nav-drawer .nmz-grupo.hidden{ display:none!important; }

      .nmz-rodape{
        flex:none; border-top:1px solid var(--line,#232a33); padding:8px;
        display:flex; flex-direction:column; gap:1px;
      }
      #nav-drawer .nmz-rodape a.nmz-item, #nav-drawer .nmz-rodape button.nmz-item{
        font-size:12.3px; background:none; cursor:pointer; text-align:left; font-family:inherit;
      }
      #nav-drawer .nmz-rodape .nmz-sair{ color:var(--bad,#ff5c5c); }
      #nav-drawer .nmz-rodape .nmz-sair:hover{ background:rgba(255,92,92,.1); }
      #nav-drawer .nmz-rodape .nmz-suporte{ color:var(--accent,#b8ff3c); }

      @media (max-width:420px){ #nav-drawer{ width:86vw; } }

      /* seta de voltar pro "pai" da tela (ver VOLTAR la em cima).
         Nasce escondida: quem libera e aplicarRegras(), depois do
         /api/me - mesma logica dos itens do menu. */
      .nmz-voltar{
        display:inline-flex; align-items:center; gap:7px; flex:none; box-sizing:border-box;
        height:34px; padding:0 12px 0 9px; border-radius:8px;
        border:1px solid var(--line,#232a33); background:var(--panel2,#181d24);
        color:var(--text,#e7ecf1); text-decoration:none;
        font-size:12.5px; line-height:1; white-space:nowrap; transition:.15s;
      }
      .nmz-voltar:hover{ border-color:var(--accent,#b8ff3c); color:var(--accent,#b8ff3c); }
      .nmz-voltar.hidden{ display:none!important; }
      .nmz-voltar .nmz-vseta{ font-size:15px; line-height:1; opacity:.8; }
      /* no celular sobra so a seta - o titulo da tela e mais importante
         que o nome da tela anterior quando a largura aperta */
      @media (max-width:560px){
        .nmz-voltar{ width:34px; padding:0; justify-content:center; }
        .nmz-voltar .nmz-vrot{ display:none; }
      }
    `;
    document.head.appendChild(st);
  }

  // ---------------------------------------------------------------
  // 3) MONTAGEM
  // ---------------------------------------------------------------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function itemHtml(it) {
    // nasce escondido: quem libera e aplicarRegras(), depois do /api/me.
    // Assim ninguem ve por um instante um link que nao pode acessar.
    return `<a class="nmz-item hidden" id="${it.id}" href="${esc(it.href)}">`
      + `<span class="nmz-ico">${it.icone}</span><span class="nmz-rot">${esc(it.rotulo)}</span></a>`;
  }

  function montar(nav) {
    const corpo = MENU.map((sec) => {
      const itens = sec.itens.map(itemHtml).join('');
      if (!sec.grupo) return `<div class="nmz-wrap" data-grupo="">${itens}</div>`;
      return `<div class="nmz-grupo" data-grupo="${esc(sec.grupo)}"><span>${esc(sec.grupo)}</span><span class="nmz-seta">▾</span></div>`
        + `<div class="nmz-wrap" data-grupo="${esc(sec.grupo)}">${itens}</div>`;
    }).join('');

    nav.innerHTML = `
      <div class="nmz-topo">
        <div style="min-width:0;">
          <div class="nmz-marca"><svg width="30" height="20" viewBox="0 0 64 40" fill="none" aria-hidden="true"><polyline class="marca-base" points="2,26 14,26 21,10 29,32 36,20 62,20" stroke="var(--accent,#b8ff3c)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" fill="none"/><polyline class="marca-brilho" points="2,26 14,26 21,10 29,32 36,20 62,20" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg><span>No<b>Pulso</b></span></div>
          <div class="nmz-quem" id="nmz-quem"></div>
        </div>
        <button type="button" class="nmz-fechar" id="nmz-fechar" aria-label="Fechar menu" title="Fechar">✕</button>
      </div>
      <div class="nmz-corpo">${corpo}</div>
      <div class="nmz-rodape">
        <a class="nmz-item" id="nav-ajuda" href="/ajuda.html"><span class="nmz-ico">❓</span><span>Ajuda</span></a>
        <a class="nmz-item nmz-suporte" href="https://wa.me/5581995148654" target="_blank" rel="noopener"><span class="nmz-ico">💬</span><span>Suporte (81) 99514-8654</span></a>
        <button type="button" class="nmz-item nmz-sair" id="nmz-sair"><span class="nmz-ico">🚪</span><span>Sair</span></button>
      </div>`;

    nav.querySelector('#nmz-fechar').addEventListener('click', fechar);
    nav.querySelector('#nmz-sair').addEventListener('click', () => {
      if (typeof window.logout === 'function') return window.logout();
      localStorage.removeItem('authToken');
      location.href = '/';
    });
  }

  // Acha o botao hamburguer da pagina. Os nomes variam por motivo
  // historico (#btn-menu na maioria, #nav-toggle nas mais novas) - o que
  // todas tem em comum e a classe .hamburger-btn.
  function acharHamburguer() {
    return document.querySelector('.hamburger-btn, #btn-menu, #nav-toggle');
  }

  // Monta a seta de voltar ao lado do hamburguer, se esta tela tiver pai.
  let VOLTAR_EL = null;
  function montarVoltar() {
    const pai = itemPorId(VOLTAR[location.pathname]);
    if (!pai) return;
    const btn = acharHamburguer();
    if (!btn || !btn.parentNode) return;
    const a = document.createElement('a');
    a.className = 'nmz-voltar hidden';
    a.id = 'nmz-voltar';
    a.href = pai.href;
    a.title = 'Voltar para ' + pai.rotulo;
    a.setAttribute('aria-label', 'Voltar para ' + pai.rotulo);
    a.innerHTML = `<span class="nmz-vseta" aria-hidden="true">‹</span><span class="nmz-vrot">${esc(pai.rotulo)}</span>`;
    btn.parentNode.insertBefore(a, btn.nextSibling);
    VOLTAR_EL = a;
    VOLTAR_PAI = pai;
  }
  let VOLTAR_PAI = null;

  // ---------------------------------------------------------------
  // 4) PERMISSAO
  // ---------------------------------------------------------------
  function temSecao(me, s) {
    if (me.role === 'master' || me.isAdmin) return true;
    return (((me.permissions && me.permissions.sections) || []).includes(s));
  }

  // vertical de negocio do item (ex: 'alimentacao') bate com a(s) vertical(is)
  // do usuario - Master/suporte (verticaisDoUsuario null em GET /api/me)
  // atravessam tudo de proposito. Item sem `verticais` sempre aparece (nao
  // muda nada pra nenhum item existente hoje - so passa a valer quando um
  // item novo marcar `verticais: ['saude']` etc, ver users.SECTION_VERTICAIS)
  function temVertical(me, it) {
    if (!it.verticais) return true;
    if (!me.verticaisDoUsuario) return true;
    return it.verticais.some((v) => me.verticaisDoUsuario.includes(v));
  }

  // REDE do item (ARCFOOD / GBE, ver server/redes.js) bate com a(s) rede(s)
  // das lojas do usuario. Existe pra "Fechamentos Arcfood" e "Fechamentos
  // GBE": os dois apareciam pra qualquer um com a seção 'fechamentos', e
  // quem so tem loja do Grupo Bravo clicava em Arcfood pra cair numa tela
  // vazia da operacao do vizinho. redesDoUsuario vem do /api/me e sai das
  // MESMAS unidades que filtram os dados; null = Master, atravessa tudo.
  // Item sem `redes` continua aparecendo pra todo mundo (a esmagadora
  // maioria - isso nao e um filtro geral, e a regra desses dois itens).
  function temRede(me, it) {
    if (!it.redes) return true;
    if (!me.redesDoUsuario) return true;
    return it.redes.some((r) => me.redesDoUsuario.includes(r));
  }

  function podeVer(it, me) {
    const isMaster = me.role === 'master';
    const isAdmin = isMaster || !!me.isAdmin;
    if (it.master) return isMaster;
    if (it.admin) return isAdmin;
    if (!temVertical(me, it)) return false;
    if (!temRede(me, it)) return false;
    if (it.secoes) return it.secoes.some((s) => temSecao(me, s));
    return true;
  }

  let ME = null;
  function aplicarRegras() {
    if (!ME) return;
    MENU.forEach((sec) => {
      sec.itens.forEach((it) => {
        const el = document.getElementById(it.id);
        if (!el) return;
        el.classList.toggle('hidden', !podeVer(it, ME));
        if (it.alt) {
          const usaAlt = it.alt.quando(ME);
          const ico = el.querySelector('.nmz-ico');
          const rot = el.querySelector('.nmz-rot');
          if (ico) ico.textContent = usaAlt ? it.alt.icone : it.icone;
          if (rot) rot.textContent = usaAlt ? it.alt.rotulo : it.rotulo;
        }
      });
    });
    // grupo sem nenhum item visivel some junto (nao deixa titulo orfao).
    // A visibilidade do wrap em si fica por conta do sincronizarRecolhido,
    // que junta as duas condicoes (permissao + acordeao) num lugar so.
    document.querySelectorAll('#nav-drawer .nmz-grupo').forEach((g) => {
      const wrap = document.querySelector(`#nav-drawer .nmz-wrap[data-grupo="${CSS.escape(g.dataset.grupo)}"]`);
      const temVisivel = !!wrap && [...wrap.children].some((c) => !c.classList.contains('hidden'));
      g.classList.toggle('hidden', !temVisivel);
    });
    // a seta de voltar segue a MESMA regra do item no menu: sem acesso ao
    // pai, sem atalho pra ele
    if (VOLTAR_EL && VOLTAR_PAI) VOLTAR_EL.classList.toggle('hidden', !podeVer(VOLTAR_PAI, ME));
    const quem = document.getElementById('nmz-quem');
    if (quem) {
      const nome = ME.username || ME.nome || ME.email || '';
      const papel = ME.role === 'master' ? 'Master' : (ME.isAdmin ? 'Admin' : '');
      quem.textContent = papel ? `${nome} · ${papel}` : nome;
      quem.title = nome;
    }
  }

  // Quao bem o href de um item descreve a tela aberta agora:
  //   -1 = nao e essa tela
  //    0 = mesmo caminho, sem query
  //   >0 = mesmo caminho E a query do item bate (mais especifico)
  // Isso existe porque "Reset senha" aponta pra /painel.html?resetSenha=1:
  // comparando so o pathname, ele acendia junto com "Painel" em toda visita
  // ao painel, e ainda abria o acordeao de Administracao sem motivo.
  function grauDeMatch(a) {
    let u;
    try { u = new URL(a.getAttribute('href'), location.origin); } catch (e) { return -1; }
    if (u.pathname !== location.pathname) return -1;
    const atual = new URLSearchParams(location.search);
    let grau = 0;
    for (const [k, v] of u.searchParams) {
      if (atual.get(k) !== v) return -1;
      grau += 1;
    }
    return grau;
  }

  // marca UM item so: o de maior grau (empate -> o primeiro do menu)
  function marcarAtivo() {
    let melhor = null;
    let melhorGrau = -1;
    document.querySelectorAll('#nav-drawer a.nmz-item[href]').forEach((a) => {
      a.classList.remove('active');
      const g = grauDeMatch(a);
      if (g > melhorGrau) { melhorGrau = g; melhor = a; }
    });
    if (melhor) melhor.classList.add('active');
  }

  // acordeao: abre so o grupo da pagina atual (pra ver onde esta); os
  // outros comecam recolhidos, senao o menu fica longo demais no celular
  function acordeao() {
    document.querySelectorAll('#nav-drawer .nmz-grupo').forEach((g) => {
      const wrap = document.querySelector(`#nav-drawer .nmz-wrap[data-grupo="${CSS.escape(g.dataset.grupo)}"]`);
      if (!wrap) return;
      // usa o item ja marcado por marcarAtivo() (chamado antes), pra o grupo
      // que abre sozinho ser exatamente o do item aceso - nunca outro que
      // por acaso tenha um link pro mesmo caminho com outra query
      const temAtual = !!wrap.querySelector('a.nmz-item.active');
      if (!temAtual) { g.classList.add('fechado'); wrap.dataset.recolhido = '1'; }
      g.addEventListener('click', () => {
        const abrir = g.classList.contains('fechado');
        g.classList.toggle('fechado', !abrir);
        wrap.dataset.recolhido = abrir ? '' : '1';
        sincronizarRecolhido();
      });
    });
    sincronizarRecolhido();
  }
  // "recolhido" e separado de "hidden" (permissao) pra um nao apagar o
  // outro - permissao sempre ganha
  function sincronizarRecolhido() {
    document.querySelectorAll('#nav-drawer .nmz-wrap[data-grupo]').forEach((w) => {
      if (!w.dataset.grupo) return;
      const g = document.querySelector(`#nav-drawer .nmz-grupo[data-grupo="${CSS.escape(w.dataset.grupo)}"]`);
      const semPermissao = g && g.classList.contains('hidden');
      w.classList.toggle('hidden', semPermissao || w.dataset.recolhido === '1');
    });
  }

  // ---------------------------------------------------------------
  // 5) ABRIR / FECHAR - sobrescreve as funcoes locais das paginas (os
  //    botoes hamburguer chamam abrirMenu() no onclick inline)
  // ---------------------------------------------------------------
  function overlay() {
    let o = document.getElementById('nav-drawer-overlay');
    if (!o) {
      o = document.createElement('div');
      o.id = 'nav-drawer-overlay';
      o.className = 'nav-drawer-overlay hidden';
      document.body.appendChild(o);
    }
    return o;
  }
  function abrir() {
    const nav = document.getElementById('nav-drawer');
    if (!nav) return;
    nav.classList.remove('hidden');
    overlay().classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }
  function fechar() {
    const nav = document.getElementById('nav-drawer');
    if (nav) nav.classList.add('hidden');
    const o = document.getElementById('nav-drawer-overlay');
    if (o) o.classList.add('hidden');
    document.body.style.overflow = '';
  }
  window.abrirMenu = abrir;
  window.fecharMenu = fechar;

  // ---------------------------------------------------------------
  // 6) BOOT
  // ---------------------------------------------------------------
  function iniciar() {
    let nav = document.getElementById('nav-drawer');
    // Se a pagina esqueceu o <nav id="nav-drawer">, cria aqui em vez de
    // desistir em silencio. Era exatamente o que acontecia na Analise de
    // Rede: ela tinha o botao hamburguer e carregava este script, mas sem
    // o container o menu nunca abria - e sem erro nenhum no console, o
    // que torna o bug quase invisivel em revisao. Agora o unico requisito
    // pra ter menu e carregar o nav-menu.js.
    if (!nav) {
      nav = document.createElement('nav');
      nav.id = 'nav-drawer';
      nav.className = 'nav-drawer hidden';
      document.body.appendChild(nav);
    }
    injetarEstilo();
    nav.classList.add('nav-drawer');
    if (!nav.classList.contains('hidden')) nav.classList.add('hidden');
    montar(nav);
    montarVoltar();
    marcarAtivo();
    acordeao();

    // O botao hamburguer passa a ser ligado AQUI. Antes dependia de cada
    // pagina lembrar do onclick="abrirMenu()" no HTML - e a Analise de
    // Rede nao lembrou. abrir() e idempotente, entao nas paginas que ja
    // tem o onclick inline os dois caminhos convivem sem efeito duplo.
    const btnMenu = acharHamburguer();
    if (btnMenu) btnMenu.addEventListener('click', abrir);

    const o = overlay();
    o.addEventListener('click', fechar);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') fechar(); });
    // fechar ao clicar num item (no celular o menu cobre a tela)
    nav.addEventListener('click', (e) => { if (e.target.closest('a.nmz-item')) fechar(); });

    if (!token) return;
    fetch('/api/me', { headers: { Authorization: 'Bearer ' + token } })
      .then((r) => (r.ok ? r.json() : null))
      .then((me) => {
        if (!me) return;
        ME = me;
        aplicarRegras();
        sincronizarRecolhido();
        marcarAtivo();
        // trava de seguranca: varias paginas ainda tem no proprio boot()
        // linhas antigas do tipo getElementById('nav-x').classList.remove
        // ('hidden') - sem olhar permissao. O observer devolve a regra
        // certa na hora, em vez do antigo "reaplica depois de 800ms".
        const obs = new MutationObserver(() => {
          obs.disconnect();
          aplicarRegras();
          sincronizarRecolhido();
          marcarAtivo();
          obs.observe(nav, { attributes: true, attributeFilter: ['class'], subtree: true });
        });
        obs.observe(nav, { attributes: true, attributeFilter: ['class'], subtree: true });
      })
      .catch(() => { /* API fora do ar - menu fica so com o que nao exige permissao */ });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar, { once: true });
  else iniciar();
})();
