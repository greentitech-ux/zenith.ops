// nav-gate.js
// Fonte UNICA da verdade de visibilidade dos links de secao no menu
// hamburguer (tudo que esta em REGRAS abaixo) - tanto pra MOSTRAR quanto
// pra ESCONDER, pra Master/Admin (veem tudo) e pra todo mundo (secoes da
// tela de Usuarios). Antes disso o script so ESCONDIA (assumia que cada
// pagina ja tinha "mostrado" tudo no proprio boot(), e pulava de vez pra
// Master/Admin) - um item novo esquecido em algum boot() ficava invisivel
// pra sempre naquela pagina, mesmo pra quem tinha acesso (bug real: link
// do RH so aparecia depois de passar pelo Painel, a unica pagina que
// lembrou de mostra-lo). Agora todo id de REGRAS e decidido só por aqui,
// nas duas direcoes, entao nenhuma pagina precisa mais tratar isso no
// proprio boot() - so os links MASTER-ONLY (Usuarios, Grupos...), que nao
// dependem de secao e continuam geridos por cada pagina.
// Links fora de REGRAS (Painel, Ajuda, Sair, master-only) nao sao tocados.
// Os cabecalhos de grupo do menu somem sozinhos quando todos os itens
// ficam escondidos (ver initNavDrawerAccordion nas paginas).
(function () {
  const token = localStorage.getItem('authToken');
  if (!token) return;

  // id do link -> secoes que liberam (basta UMA). null = sempre visivel.
  const REGRAS = {
    'nav-monitor': ['monitor'],
    'nav-lancamento': ['lancamento'],
    'nav-fechamentos': ['fechamentos'],
    'nav-entregas': ['entregas'],
    'nav-entrega-lancamento': ['entregas-lancamento'],
    'nav-ifood': ['ifood'],
    'nav-relatorios': ['disputas'],
    'nav-cofre': ['cofre'],
    'nav-solicitacoes': ['solicitacoes'],
    // o Historico tambem serve pra quem recebe cards atribuidos
    // (tecnico/manutencao) - mesmo criterio do card no Painel
    'nav-historico': ['solicitacoes', 'manutencao', 'tecnico'],
    'nav-tecnico': ['tecnico', 'suporte'],
    'nav-tecnico-self': ['tecnico', 'suporte'],
    'nav-ativos-ti': ['ativos-ti'],
    'nav-manutencao': ['manutencao'],
    'nav-inventario': ['inventario'],
    'nav-abastecimento': ['abastecimento-carrinho', 'abastecimento-loja'],
    'nav-parque': ['parque'],
    'nav-parque-checkin': ['parque-checkin'],
    'nav-mensalistas': ['parque'],
    'nav-festas': ['festas'],
    'nav-saltiverso-vendas': ['parque-loja'],
    'nav-saltiverso-fechamento': ['parque-loja'],
    'nav-central-solucoes': ['central-solucoes'],
    'nav-rh': ['rh'],
    // mesmo criterio de acesso do atendimento do widget (ehTimeSuporte no
    // index.js): time de Suporte, alem de Master/Admin (que ja veem tudo)
    'nav-beniboy': ['suporte'],
    // conectividade das lojas (heartbeat do quiosque atendimento.html) -
    // mesmo publico do Beniboy, ja que e quem cuida da infra das lojas
    'nav-loja-status': ['suporte'],
  };

  function aplicar(me) {
    if (!me) return;
    const isGestao = me.role === 'master' || !!me.isAdmin; // gestao ve tudo que esta em REGRAS
    const secoes = (me.permissions && me.permissions.sections) || [];
    for (const [id, exigidas] of Object.entries(REGRAS)) {
      const el = document.getElementById(id);
      if (!el) continue;
      const liberado = isGestao || !exigidas || exigidas.some((s) => secoes.includes(s));
      el.classList.toggle('hidden', !liberado);
    }
  }

  // marca o link da pagina atual como ativo comparando o pathname do href de
  // cada item com a URL aberta - antes cada pagina marcava na mao (class
  // "active" fixa no HTML), o que dava furo/inconsistencia (pagina que
  // esquecia de marcar nao destacava nada). Aqui fica sempre certo e igual
  // em todas as telas, sem depender de cada pagina lembrar.
  function marcarAtivo() {
    const atual = location.pathname;
    const itens = document.querySelectorAll('#nav-drawer a.back[href]');
    // limpa qualquer "active" fixo no HTML antes de marcar - assim sobra
    // exatamente UM item destacado (o da URL atual), mesmo em pagina que
    // tenha marcado o link errado por copia de template
    itens.forEach((a) => a.classList.remove('active'));
    itens.forEach((a) => {
      let p;
      try { p = new URL(a.getAttribute('href'), location.origin).pathname; } catch (e) { return; }
      if (p === atual) a.classList.add('active');
    });
  }

  // visual do menu injetado de um lugar so (vale pra todas as paginas):
  // realce da aba atual com barrinha lateral, hover nos itens e nos titulos
  // de grupo. So estetica - nao muda estrutura nem comportamento.
  function injetarEstilo() {
    if (document.getElementById('nav-drawer-estilo')) return;
    const st = document.createElement('style');
    st.id = 'nav-drawer-estilo';
    st.textContent =
      '#nav-drawer a.back{position:relative;transition:background .12s ease,color .12s ease;}'
      + '#nav-drawer a.back:hover{background:var(--panel2,#181d24);color:var(--text,#e7ecf1);}'
      + '#nav-drawer a.back.active{background:rgba(92,200,255,.12);color:var(--accent,#5cc8ff);border-color:transparent;font-weight:600;}'
      + '#nav-drawer a.back.active::before{content:"";position:absolute;left:0;top:5px;bottom:5px;width:3px;border-radius:0 3px 3px 0;background:var(--accent,#5cc8ff);}'
      + '#nav-drawer .nav-drawer-grupo{transition:color .12s ease;}'
      + '#nav-drawer .nav-drawer-grupo:hover{color:var(--text,#e7ecf1);}';
    document.head.appendChild(st);
  }

  function quandoPronto(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  }

  // visual e realce da aba nao dependem da API - aplica na hora
  quandoPronto(() => { injetarEstilo(); marcarAtivo(); });

  fetch('/api/me', { headers: { Authorization: 'Bearer ' + token } })
    .then((r) => (r.ok ? r.json() : null))
    .then((me) => {
      if (!me) return;
      aplicar(me);
      marcarAtivo();
      // reaplica depois do boot da pagina (alguns boots dao remove('hidden')
      // em links do menu sem olhar permissao)
      setTimeout(() => { aplicar(me); marcarAtivo(); }, 800);
      setTimeout(() => { aplicar(me); marcarAtivo(); }, 2500);
    })
    .catch(() => { /* API fora do ar - menu fica como esta */ });
})();
