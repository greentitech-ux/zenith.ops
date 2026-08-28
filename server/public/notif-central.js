// notif-central.js
// Notificacoes que precisam aparecer em QUALQUER pagina logada, nao so no
// Painel/Historico (que ja tinham a sua propria versao antes disso
// existir): solicitacao nova na Central (toast com som, mesmo padrao de
// painel.html) e fraude CONFIRMADA no Monitor (overlay em cima de tudo,
// mais chamativo que o toast de canto, porque e mais critico). Um arquivo
// so pra nao precisar copiar esse bloco em ~20 paginas toda vez que mudar
// algo (ex: duracao da notificacao) - unica pagina que ja carrega HTML/JS
// externo nessa base, o resto sempre foi tudo inline por pagina.
(function () {
  if (window.__ZENITH_NOTIF_CENTRAL__) return;
  window.__ZENITH_NOTIF_CENTRAL__ = true;

  // ---------------------------------------------------------------------
  // FECHAR ARRASTANDO PRO LADO (pedido do Master: "arrastar para o lado e
  // ela sair, porém sem marcar como visualizado, apenas fechar"). É o mesmo
  // gesto da gaveta de notificação do celular, então ninguém precisa
  // aprender nada.
  //
  // A DIFERENÇA QUE IMPORTA: arrastar NÃO marca como vista. O alerta some
  // da tela agora e volta na próxima visita, porque a solicitação continua
  // pendente de verdade - quem marca como vista é só o "Visualizar". Sem
  // isso, "tirar da frente pra ler depois" viraria "some pra sempre".
  //
  // Fica aqui (e não em cada página) porque o Painel e o Histórico têm a
  // própria cópia desse toast, de antes deste arquivo existir - as duas
  // chamam window.ZenithArrastarParaFechar. Definido ANTES da checagem de
  // token abaixo pra existir mesmo em página sem sessão.
  // ---------------------------------------------------------------------
  // [ARRASTAR-INICIO] (marcador: testeRotas.js recorta daqui até o FIM pra
  // rodar o gesto em Node, com um elemento de mentira - ver o teste)
  function arrastarParaFechar(el, aoFechar) {
    let x0 = 0; let y0 = 0; let dx = 0;
    let arrastando = false; let ehGesto = false; let saiu = false;
    const largura = () => el.offsetWidth || 320;

    function inicio(e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      x0 = e.clientX; y0 = e.clientY; dx = 0;
      arrastando = true; ehGesto = false;
      el.style.transition = 'none';
    }

    function mover(e) {
      if (!arrastando) return;
      const ex = e.clientX - x0;
      const ey = e.clientY - y0;
      if (!ehGesto) {
        // folga de 8px: sem ela, o tremor do dedo no toque do botão
        // "Visualizar" já contava como arrasto e engolia o clique
        if (Math.abs(ex) < 8 && Math.abs(ey) < 8) return;
        // gesto mais vertical que horizontal = a pessoa quer ROLAR a
        // página, não fechar o alerta - solta o controle e deixa rolar
        if (Math.abs(ey) > Math.abs(ex)) { arrastando = false; return; }
        ehGesto = true;
        // sem capturar o ponteiro, arrastar o mouse pra fora do card
        // interrompia o gesto no meio
        try { el.setPointerCapture(e.pointerId); } catch (err) { /* navegador sem captura: segue sem */ }
      }
      dx = ex;
      el.style.transform = 'translateX(' + dx + 'px)';
      el.style.opacity = String(Math.max(0.15, 1 - (Math.abs(dx) / largura())));
    }

    function fim() {
      if (!arrastando) return;
      arrastando = false;
      el.style.transition = 'transform .18s ease, opacity .18s ease';
      const limite = Math.max(56, largura() * 0.28);
      if (Math.abs(dx) < limite) {
        // não passou do limite: volta pro lugar, nada acontece
        el.style.transform = '';
        el.style.opacity = '';
        return;
      }
      el.style.transform = 'translateX(' + (dx > 0 ? largura() + 60 : -(largura() + 60)) + 'px)';
      el.style.opacity = '0';
      const sair = () => {
        if (saiu) return;
        saiu = true;
        el.remove();
        if (aoFechar) aoFechar();
      };
      // o timer é rede de segurança: se a aba estiver em segundo plano o
      // transitionend pode nunca chegar, e o card ficaria pendurado
      el.addEventListener('transitionend', sair, { once: true });
      setTimeout(sair, 320);
    }

    // pan-y: o navegador continua rolando a página na vertical, mas deixa o
    // gesto horizontal pra gente (sem isso, no celular o toque vira scroll e
    // o pointermove nunca chega)
    el.style.touchAction = 'pan-y';
    // sem isto o gesto morria no meio no computador: arrastar em cima do
    // texto do card começa uma SELEÇÃO/arraste nativo do navegador, que
    // dispara pointercancel e aborta o fechamento (visto no Chromium). Card
    // de notificação não é texto pra copiar, então desligar a seleção nele
    // não tira nada de ninguém.
    el.style.userSelect = 'none';
    el.style.webkitUserSelect = 'none';
    el.addEventListener('dragstart', (e) => e.preventDefault());
    el.addEventListener('pointerdown', inicio);
    el.addEventListener('pointermove', mover);
    el.addEventListener('pointerup', fim);
    el.addEventListener('pointercancel', fim);
  }
  // [ARRASTAR-FIM]
  window.ZenithArrastarParaFechar = arrastarParaFechar;

  const AUTH_TOKEN = localStorage.getItem('authToken');
  if (!AUTH_TOKEN) return;

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const style = document.createElement('style');
  style.textContent = `
    .zn-notif-wrap{position:fixed;top:14px;right:14px;z-index:100000;display:flex;flex-direction:column;gap:10px;max-width:min(360px,calc(100vw - 28px));}
    .zn-notif{background:var(--panel);border:2px solid var(--warn);border-radius:12px;padding:14px 16px;box-shadow:0 10px 30px rgba(0,0,0,.55);animation:zn-notif-in .18s ease,zn-notif-pulse 1.6s ease-in-out infinite;font-family:var(--sans);}
    .zn-notif .zn-titulo{font-size:13px;font-weight:700;color:var(--text);}
    .zn-notif .zn-corpo{font-size:12px;color:var(--muted);margin-top:6px;line-height:1.4;}
    .zn-notif .zn-direcionado{font-size:11px;color:var(--accent);margin-top:6px;font-family:var(--mono);}
    .zn-notif button.zn-ok{margin-top:10px;width:100%;background:var(--accent);color:#0b0d10;border:none;border-radius:8px;padding:9px;font-size:12.5px;font-weight:700;cursor:pointer;font-family:var(--sans);}
    @keyframes zn-notif-pulse{0%,100%{border-color:var(--warn);}50%{border-color:var(--accent);}}
    @keyframes zn-notif-in{from{opacity:0;transform:translateX(16px);}to{opacity:1;transform:translateX(0);}}

    .zn-fraude-bg{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:100001;display:flex;align-items:flex-start;justify-content:center;padding:24px 16px;overflow-y:auto;}
    .zn-fraude-banner{background:var(--panel);border:2px solid var(--bad);border-radius:14px;padding:20px 22px;max-width:480px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.6);animation:zn-notif-in .2s ease,zn-fraude-pulse 1.1s ease-in-out infinite;font-family:var(--sans);}
    .zn-fraude-banner .zn-f-titulo{font-size:16px;font-weight:800;color:var(--bad);}
    .zn-fraude-banner .zn-f-corpo{font-size:13px;color:var(--text);margin-top:10px;line-height:1.5;}
    .zn-fraude-banner .zn-f-motivo{font-size:12px;color:var(--muted);margin-top:8px;line-height:1.4;}
    .zn-fraude-banner button.zn-f-ok{margin-top:16px;width:100%;background:var(--bad);color:#fff;border:none;border-radius:8px;padding:11px;font-size:13px;font-weight:700;cursor:pointer;font-family:var(--sans);}
    @keyframes zn-fraude-pulse{0%,100%{border-color:var(--bad);}50%{border-color:#ff8080;}}
  `;
  document.head.appendChild(style);

  const wrap = document.createElement('div');
  wrap.className = 'zn-notif-wrap';
  document.body.appendChild(wrap);

  let audioCtx = null;
  function tocarBeep(padrao) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      padrao.forEach(([delay, freq]) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine'; osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, audioCtx.currentTime + delay);
        gain.gain.exponentialRampToValueAtTime(0.28, audioCtx.currentTime + delay + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + delay + 0.35);
        osc.connect(gain); gain.connect(audioCtx.destination);
        osc.start(audioCtx.currentTime + delay);
        osc.stop(audioCtx.currentTime + delay + 0.4);
      });
    } catch (e) { /* navegador pode bloquear audio antes de alguma interacao - so nao toca */ }
  }
  const tocarSomSolicitacao = () => tocarBeep([[0, 880], [0.18, 1160]]);
  const tocarSomFraude = () => tocarBeep([[0, 660], [0.16, 660], [0.32, 880]]);

  const ICONES_TIPO = { estorno: '💳', 'ajuste-fechamento': '🧾', compra: '🛒', manutencao: '🔧', 'suporte-ti': '💻', pagamento: '💸', nota: '📄', 'quebra-caixa': '⚠️', 'desvio-estoque': '📦⚠️' };
  const LABELS_TIPO = { estorno: 'Estorno', 'ajuste-fechamento': 'Ajuste de fechamento', compra: 'Compra', manutencao: 'Manutenção', 'suporte-ti': 'Suporte TI', pagamento: 'Pagamento', nota: 'Nota fiscal', 'quebra-caixa': 'Quebra de caixa', 'desvio-estoque': 'Desvio de estoque' };

  // ALERTA QUE INSISTE. Pedido do Master: "quebra de caixa e' um alerta que se
  // jogado para o lado nao volta a aparecer".
  //
  // Arrastar pro lado nunca marcou como visto - isso esta certo e continua. O
  // que apagava o alerta pra sempre era o "visto" ser GLOBAL: bastava UM
  // Master/Admin clicar em Visualizar (em qualquer aparelho) pra ele sumir da
  // tela de todos, mesmo com a quebra ainda pendente. Ver alguem ver != alguem
  // resolver, e num alerta de dinheiro essa diferenca custa caro.
  //
  // Estes dois tipos NASCEM SOZINHOS de uma diferenca apurada (quebra de caixa
  // no fechamento, desvio na contagem de estoque) - ninguem os abriu de
  // proposito, e ninguem some com eles sem decidir. Enquanto o ticket estiver
  // PENDENTE eles voltam a cada carregamento de pagina, com ou sem "visto".
  // Aprovar/rejeitar na Central e' o que cala o alerta.
  const TIPOS_ALERTA_INSISTENTE = ['quebra-caixa', 'desvio-estoque'];
  const alertaInsiste = (c) => TIPOS_ALERTA_INSISTENTE.indexOf(c && c.tipo) !== -1;

  function mostrarNotificacaoSolicitacao(card) {
    if (card.notificacaoVista && !alertaInsiste(card)) return;
    const elId = 'zn-notif-' + card.tipo + '-' + card.id;
    if (document.getElementById(elId)) return;
    const el = document.createElement('div');
    el.className = 'zn-notif';
    el.id = elId;
    el.innerHTML = `
      <div class="zn-titulo">🔔 Nova solicitação</div>
      <div class="zn-corpo">${ICONES_TIPO[card.tipo] || '📋'} ${escapeHtml(LABELS_TIPO[card.tipo] || card.tipo)} · ${escapeHtml(card.unidadeNome || card.unidade || '—')}<br>${escapeHtml(card.titulo || '')}</div>
      ${(card.atribuidosEmails && card.atribuidosEmails.length) ? `<div class="zn-direcionado">👤 atribuído a ${escapeHtml(card.atribuidosEmails.join(', '))}</div>` : (card.direcionadoParaEmail ? `<div class="zn-direcionado">👤 direcionado a ${escapeHtml(card.direcionadoParaEmail)}</div>` : '')}
      <button type="button" class="zn-ok">👁️ Visualizar</button>
    `;
    // "Visualizar" faz as duas coisas: marca como vista E leva pro conteúdo.
    // Antes era só "já vi" - a pessoa tirava o alerta da tela e depois tinha
    // que procurar a solicitação na mão pra saber do que se tratava.
    el.querySelector('.zn-ok').addEventListener('click', () => abrirSolicitacao(card.tipo, card.id));
    // arrastar pro lado só tira da tela (não marca como vista - ver
    // arrastarParaFechar lá em cima)
    arrastarParaFechar(el);
    wrap.appendChild(el);
    tocarSomSolicitacao();
  }

  // marca como vista e navega pro card aberto no Histórico da Central. O
  // marcar-visto é disparado sem esperar de propósito: se a gente aguardasse
  // a resposta pra navegar, uma rede lenta faria o botão parecer travado.
  // Perder essa marcação é barato - a notificação volta na próxima visita.
  function abrirSolicitacao(tipo, id) {
    marcarVistoNotificacao(tipo, id);
    location.href = `/central-historico.html?tipo=${encodeURIComponent(tipo)}&id=${encodeURIComponent(id)}`;
  }

  async function marcarVistoNotificacao(tipo, id) {
    removerNotificacaoSolicitacao(tipo, id);
    try { await fetch(`/api/central/${tipo}/${id}/marcar-visto`, { method: 'POST' }); } catch (e) { /* proxima visita tenta de novo */ }
  }
  function removerNotificacaoSolicitacao(tipo, id) {
    const el = document.getElementById('zn-notif-' + tipo + '-' + id);
    if (el) el.remove();
  }

  // paginas que ja tem a sua propria versao desse toast (painel.html e
  // central-historico.html, de antes desse arquivo existir) sinalizam com
  // essa flag pra nao duplicar toast/som - so o overlay de fraude roda nelas
  async function initSolicitacoes(es, isMaster, isAdmin) {
    if (window.__ZENITH_SOLICITACAO_NOTIF_OWN__) return;
    if (!isMaster && !isAdmin) return;
    try {
      const cards = await fetch('/api/central').then((r) => r.json());
      cards.filter((c) => c.status === 'PENDENTE' && (!c.notificacaoVista || alertaInsiste(c))).forEach(mostrarNotificacaoSolicitacao);
    } catch (e) { /* sem dados agora, o SSE ainda pega o que chegar dai pra frente */ }
    ['refund-requested', 'solicitacao-criada', 'fechamento-edicao-solicitada'].forEach((evento) => {
      es.addEventListener(evento, async (e) => {
        const registro = JSON.parse(e.data);
        const tipo = registro.tipo || (evento === 'fechamento-edicao-solicitada' ? 'ajuste-fechamento' : 'estorno');
        try {
          const cards = await fetch('/api/central').then((r) => r.json());
          const card = cards.find((c) => c.tipo === tipo && c.id === registro.id);
          if (card) mostrarNotificacaoSolicitacao(card);
        } catch (err) { /* ignora - proximo evento tenta de novo */ }
      });
    });
    es.addEventListener('central-notificacao-vista', (e) => {
      const info = JSON.parse(e.data);
      removerNotificacaoSolicitacao(info.tipo, info.id);
    });
  }

  // fraude CONFIRMADA (nivel FRAUDE) e critica o bastante pra sobrepor a
  // tela inteira, em qualquer pagina - SUSPEITO fica so no badge/lista do
  // Monitor mesmo, sem esse alarme (senao vira ruido demais no dia a dia)
  function mostrarFraude(registro) {
    if (registro.nivel !== 'FRAUDE') return;
    const bg = document.createElement('div');
    bg.className = 'zn-fraude-bg';
    bg.innerHTML = `
      <div class="zn-fraude-banner">
        <div class="zn-f-titulo">🚨 Fraude confirmada</div>
        <div class="zn-f-corpo">${escapeHtml(registro.unidade || '—')} · ${escapeHtml(registro.clienteNome || 'Cliente não identificado')}${registro.valor != null ? ` · R$ ${Number(registro.valor).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : ''}</div>
        ${registro.motivo ? `<div class="zn-f-motivo">${escapeHtml(registro.motivo)}</div>` : ''}
        <button type="button" class="zn-f-ok">✓ OK, entendi</button>
      </div>`;
    bg.querySelector('.zn-f-ok').addEventListener('click', () => bg.remove());
    document.body.appendChild(bg);
    tocarSomFraude();
  }

  function initFraude(es, isMaster, sections) {
    if (!isMaster && !sections.includes('monitor')) return;
    es.addEventListener('fraude-marcada', (e) => {
      try { mostrarFraude(JSON.parse(e.data)); } catch (err) { /* ignora evento malformado */ }
    });
  }

  // re-envia a inscricao de push (se ja existir uma) toda vez que uma pagina
  // carrega - silencioso, sem pedir permissao de novo. Existe pra dois casos
  // que senao falhavam quieto: (1) permissoes do usuario mudaram desde a
  // ultima vez que ele apertou o sino (o "meta" gravado no servidor, que
  // decide quem recebe o que, ficaria desatualizado pra sempre); (2) a
  // inscricao no servidor sumiu por algum motivo (endpoint expirado que ja
  // foi limpo, restauracao de backup etc) mas o navegador ainda acha que
  // esta inscrito - sem isso, os alertas parariam de chegar sem ninguem
  // perceber ate reclamar "sumiu a notificacao"
  async function reenviarSubscricaoPush() {
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
      if (Notification.permission !== 'granted') return;
      const reg = await navigator.serviceWorker.getRegistration('/sw.js');
      const sub = reg && await reg.pushManager.getSubscription();
      if (!sub) return;
      await fetch('/api/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub) });
    } catch (e) { /* proxima pagina tenta de novo */ }
  }

  fetch('/api/me').then((r) => r.json()).then((me) => {
    const isMaster = me.role === 'master';
    const isAdmin = !!me.isAdmin;
    const sections = isMaster ? [] : (me.permissions?.sections || []);
    const es = new EventSource('/api/stream?token=' + encodeURIComponent(AUTH_TOKEN));
    initSolicitacoes(es, isMaster, isAdmin);
    initFraude(es, isMaster, sections);
    reenviarSubscricaoPush();
  }).catch(() => { /* sem /api/me agora (sessao expirando?) - a propria pagina ja trata isso no fetch dela */ });
})();
