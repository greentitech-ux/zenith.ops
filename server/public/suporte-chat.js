// suporte-chat.js
// Widget flutuante de suporte (cabeça de robô - o Beniboy, canto inferior
// direito) presente em TODAS as telas do Zenith Ops - inclusive login e
// paginas publicas. Funciona SEM
// estar logado: qualquer pessoa inicia uma conversa com o time de Suporte
// (problema no computador, no sistema, de acesso...). A conversa fica salva
// no navegador (id + token proprios em localStorage), entao a pessoa pode
// fechar e voltar depois. Logado, nome/contato ja vem preenchidos do /api/me.
// O atendimento acontece na Central do Beniboy (Suporte/Master/Admin).
(function () {
  if (window.__zenithSuporteChat) return;
  window.__zenithSuporteChat = true;

  const LS_ID = 'suporteChatId';
  const LS_TOKEN = 'suporteChatToken';
  let aberto = false;
  let pollTimer = null;
  let ultimoTotalMensagens = 0;

  const css = `
  .szc-btn{position:fixed;right:16px;bottom:16px;z-index:9000;width:52px;height:52px;border-radius:50%;
    background:transparent;color:#06202b;border:none;font-size:24px;cursor:pointer;
    display:flex;align-items:center;justify-content:center;transition:transform .12s ease;}
  .szc-btn:hover{transform:scale(1.06);}
  .szc-panel{position:fixed;right:16px;bottom:78px;z-index:9001;width:320px;max-width:calc(100vw - 32px);
    max-height:min(480px, calc(100vh - 110px));display:flex;flex-direction:column;overflow:hidden;
    background:#12161b;color:#e7ecf1;border:1px solid #232a33;border-radius:14px;box-shadow:0 10px 34px rgba(0,0,0,.55);
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,Arial,sans-serif;}
  .szc-hidden{display:none!important;}
  .szc-head{padding:12px 14px;border-bottom:1px solid #232a33;display:flex;justify-content:space-between;align-items:center;gap:8px;}
  .szc-head b{font-size:13.5px;}
  .szc-head .szc-sub{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:10px;color:#7d8896;margin-top:2px;}
  .szc-x{background:none;border:none;color:#7d8896;font-size:16px;cursor:pointer;padding:2px 6px;}
  .szc-x:hover{color:#e7ecf1;}
  .szc-corpo{padding:12px 14px;overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:8px;}
  .szc-label{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:10.5px;color:#7d8896;margin:2px 0 -4px;}
  .szc-input,.szc-textarea{width:100%;box-sizing:border-box;background:#181d24;border:1px solid #232a33;color:#e7ecf1;
    border-radius:8px;padding:9px 10px;font-size:13px;font-family:inherit;}
  .szc-input:focus,.szc-textarea:focus{outline:none;border-color:#5cc8ff;}
  .szc-textarea{resize:vertical;min-height:56px;}
  .szc-enviar{background:#5cc8ff;color:#06202b;border:none;border-radius:8px;padding:10px;font-size:13px;font-weight:700;cursor:pointer;}
  .szc-enviar:disabled{opacity:.5;cursor:default;}
  .szc-msg{max-width:85%;padding:8px 10px;border-radius:10px;font-size:12.5px;line-height:1.45;white-space:pre-wrap;word-break:break-word;}
  .szc-msg.visitante{align-self:flex-end;background:#12303a;color:#cfeeff;border:1px solid rgba(92,200,255,.25);}
  .szc-msg.suporte{align-self:flex-start;background:#181d24;border:1px solid #232a33;}
  .szc-msg .szc-quem{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:9.5px;color:#7d8896;display:block;}
  .szc-msg .szc-quando{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:9px;color:#5a6472;display:block;margin-bottom:4px;}
  .szc-rodape{padding:10px 12px;border-top:1px solid #232a33;display:flex;gap:6px;}
  .szc-rodape .szc-input{flex:1;}
  .szc-aviso{font-size:11.5px;color:#7d8896;text-align:center;}
  .szc-erro{font-size:11.5px;color:#ff5c5c;}
  .szc-fim{background:#181d24;border:1px dashed #232a33;color:#7d8896;border-radius:8px;padding:8px;font-size:11.5px;text-align:center;}
  .szc-link{background:none;border:none;color:#5cc8ff;font-size:12px;cursor:pointer;padding:0;}
  /* cabeça de robo (Beniboy) dentro do botao - olhos brilham/piscam, bracos acenam */
  .szc-btn svg{overflow:visible;}
  .szc-bot-eyes{transform-box:fill-box;transform-origin:center;animation:szc-blink 4.6s ease-in-out infinite;}
  @keyframes szc-blink{0%,92%,100%{transform:scaleY(1);}95%{transform:scaleY(.15);}}
  .szc-bot-arm-l{transform-box:fill-box;transform-origin:50% 8%;animation:szc-bot-arm-l 3.6s ease-in-out infinite;}
  .szc-bot-arm-r{transform-box:fill-box;transform-origin:50% 8%;animation:szc-bot-arm-r 3.6s ease-in-out .3s infinite;}
  @keyframes szc-bot-arm-l{0%,100%{transform:rotate(0deg);}50%{transform:rotate(-14deg);}}
  @keyframes szc-bot-arm-r{0%,100%{transform:rotate(0deg);}50%{transform:rotate(14deg);}}
  /* nome do bot flutuando ao lado do botao - so aparece pro visitante (o
     atendimento usa o mesmo icone com outro sentido, ver atualizarNomeFlutuante) */
  .szc-bot-nome-wrap{position:fixed;right:74px;bottom:20px;z-index:8999;pointer-events:none;
    opacity:0;animation:szc-bn-in .35s ease .15s forwards;}
  .szc-bot-nome-wrap.szc-hidden{display:none!important;}
  .szc-bot-nome{display:inline-block;background:#181d24;color:#e7ecf1;border:1px solid #232a33;
    padding:6px 13px;border-radius:999px;font-size:12.5px;font-weight:600;white-space:nowrap;
    box-shadow:0 4px 14px rgba(0,0,0,.35);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,Arial,sans-serif;
    animation:szc-bn-float 3.2s ease-in-out infinite;}
  @keyframes szc-bn-in{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:translateY(0);}}
  @keyframes szc-bn-float{0%,100%{transform:translateY(0);}50%{transform:translateY(-5px);}}
  @media (prefers-reduced-motion:reduce){
    .szc-bot-eyes,.szc-bot-nome,.szc-bot-arm-l,.szc-bot-arm-r{animation:none;}
    .szc-bot-nome-wrap{animation:none;opacity:1;}
  }
  @media (max-width:480px){ .szc-panel{right:8px;bottom:72px;} .szc-btn{right:12px;bottom:12px;}
    .szc-bot-nome-wrap{right:70px;bottom:16px;} }
  /* alarme critico: Beniboy chamou um atendente (Master + tag Suporte)
     porque nao conseguiu resolver sozinho - tela cheia, vermelha,
     insistente ate silenciar */
  .szc-alarme{position:fixed;inset:0;z-index:99999;background:linear-gradient(160deg,#3a0a0a,#7a1414);
    color:#fff;display:none;flex-direction:column;align-items:center;justify-content:center;gap:14px;
    text-align:center;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,Arial,sans-serif;
    animation:szc-alarme-flash 1s ease-in-out infinite;}
  .szc-alarme.szc-alarme-on{display:flex;}
  .szc-alarme .szc-al-icone{font-size:56px;animation:szc-alarme-bounce .6s ease-in-out infinite;}
  .szc-alarme .szc-al-titulo{font-size:20px;font-weight:800;}
  .szc-alarme .szc-al-corpo{font-size:14px;color:#ffd9d9;max-width:320px;}
  .szc-alarme .szc-al-botoes{display:flex;gap:10px;margin-top:8px;flex-wrap:wrap;justify-content:center;}
  .szc-alarme button{border:none;border-radius:10px;padding:12px 20px;font-size:14px;font-weight:700;cursor:pointer;}
  .szc-al-atender{background:#fff;color:#7a1414;}
  .szc-al-silenciar{background:rgba(255,255,255,.15);color:#fff;border:1px solid rgba(255,255,255,.4)!important;}
  @keyframes szc-alarme-flash{0%,100%{background:linear-gradient(160deg,#3a0a0a,#7a1414);}50%{background:linear-gradient(160deg,#7a1414,#b81f1f);}}
  @keyframes szc-alarme-bounce{0%,100%{transform:scale(1);}50%{transform:scale(1.18);}}
  @media (prefers-reduced-motion:reduce){
    .szc-alarme,.szc-alarme .szc-al-icone{animation:none;}
  }
  /* popup de "pedido mudou de status" (Beniboy/pedidoWatch.js) - aparece em
     CIMA de qualquer tela do Zenith que a pessoa estiver, independente do
     chat estar aberto ou nao */
  .szc-pedido-popup{position:fixed;top:16px;right:16px;z-index:99998;display:flex;flex-direction:column;gap:8px;max-width:320px;}
  .szc-pp-card{background:#12161b;color:#e7ecf1;border:1px solid #5cc8ff;border-radius:12px;padding:12px 34px 12px 14px;
    position:relative;box-shadow:0 10px 30px rgba(0,0,0,.5);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,Arial,sans-serif;
    animation:szc-pp-in .25s ease;}
  .szc-pp-titulo{font-size:13px;font-weight:700;margin-bottom:4px;}
  .szc-pp-corpo{font-size:12px;color:#cfeeff;line-height:1.4;}
  .szc-pp-fechar{position:absolute;top:8px;right:8px;background:none;border:none;color:#7d8896;font-size:14px;cursor:pointer;}
  @keyframes szc-pp-in{from{opacity:0;transform:translateY(-8px);}to{opacity:1;transform:translateY(0);}}
  @media (prefers-reduced-motion:reduce){ .szc-pp-card{animation:none;} }
  `;

  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstChild;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtQuando(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Recife', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  // baixa o PDF da conversa (rota publica pro visitante, autenticada pro
  // atendimento - ver botoes "Baixar PDF" abaixo) - pedido explicito do
  // usuario: "preciso ter um botao de gerar pdf da conversa"
  async function baixarPdf(url, headers) {
    try {
      const r = await rawFetch(url, headers ? { headers } : undefined);
      if (!r.ok) { alert('Não foi possível gerar o PDF.'); return; }
      const blob = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'conversa-suporte.pdf';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
    } catch (e) { alert('Erro ao gerar o PDF.'); }
  }

  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // cabeça de robo (Beniboy) desenhada em SVG multi-cor (casco branco/prata,
  // orelhas e detalhes azuis, tela escura com olhos ciano brilhantes e
  // marcações de canto tipo mira) em vez do emoji 💬, com olhos piscando via
  // CSS acima
  const btn = el(`<button type="button" class="szc-btn" title="Falar com o Suporte" aria-label="Falar com o Suporte">
    <svg viewBox="0 0 48 48" width="40" height="40" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="szc-bot-shell" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#f8fbfd"/>
          <stop offset="100%" stop-color="#c7d7e2"/>
        </linearGradient>
        <radialGradient id="szc-bot-eye-glow" cx="35%" cy="30%" r="75%">
          <stop offset="0%" stop-color="#e9feff"/>
          <stop offset="45%" stop-color="#3ce0ff"/>
          <stop offset="100%" stop-color="#0a9fce"/>
        </radialGradient>
        <radialGradient id="szc-bot-chest" cx="35%" cy="30%" r="75%">
          <stop offset="0%" stop-color="#eafcff"/>
          <stop offset="100%" stop-color="#2bb9e8"/>
        </radialGradient>
        <filter id="szc-bot-shadow" x="-50%" y="-50%" width="200%" height="200%">
          <feDropShadow dx="0" dy="2" stdDeviation="2.4" flood-color="#000" flood-opacity=".5"/>
        </filter>
      </defs>
      <g filter="url(#szc-bot-shadow)">
        <rect class="szc-bot-arm-l" x="9" y="30" width="6" height="11" rx="3" fill="url(#szc-bot-shell)" stroke="#7d97a8" stroke-width="1.4"/>
        <rect class="szc-bot-arm-r" x="33" y="30" width="6" height="11" rx="3" fill="url(#szc-bot-shell)" stroke="#7d97a8" stroke-width="1.4"/>
        <path d="M14,29 C14,26 34,26 34,29 L36.5,43 C36.5,45.8 31,47 24,47 C17,47 11.5,45.8 11.5,43 Z"
          fill="url(#szc-bot-shell)" stroke="#7d97a8" stroke-width="1.4"/>
        <circle cx="24" cy="36.5" r="3.1" fill="url(#szc-bot-chest)" stroke="#0a7ea3" stroke-width=".8"/>
        <rect x="9.5" y="7" width="29" height="24" rx="11.5" fill="url(#szc-bot-shell)" stroke="#7d97a8" stroke-width="1.6"/>
        <circle cx="8" cy="19" r="2.3" fill="#3d99dd" stroke="#1c6ba8" stroke-width="1"/>
        <circle cx="40" cy="19" r="2.3" fill="#3d99dd" stroke="#1c6ba8" stroke-width="1"/>
        <rect x="14.5" y="12.5" width="19" height="14" rx="6" fill="#0c1e2c"/>
        <g class="szc-bot-eyes">
          <circle cx="20" cy="19.5" r="3.3" fill="url(#szc-bot-eye-glow)"/>
          <circle cx="28" cy="19.5" r="3.3" fill="url(#szc-bot-eye-glow)"/>
        </g>
        <g stroke="#8fe9ff" stroke-width="1.1" stroke-linecap="round" fill="none" opacity=".85">
          <path d="M16,14.5 v-1.5 h1.5"/>
          <path d="M32,14.5 v-1.5 h-1.5"/>
          <path d="M16,24.5 v1.5 h1.5"/>
          <path d="M32,24.5 v1.5 h-1.5"/>
        </g>
      </g>
    </svg>
  </button>`);
  const panel = el(`
    <div class="szc-panel szc-hidden" role="dialog" aria-label="Chat de suporte">
      <div class="szc-head">
        <div><b>💬 Suporte Zenith Ops</b><div class="szc-sub">computador · sistema · acesso</div></div>
        <button type="button" class="szc-x" title="Fechar">✕</button>
      </div>
      <div class="szc-corpo" id="szc-corpo"></div>
      <div class="szc-rodape szc-hidden" id="szc-rodape">
        <input type="text" class="szc-input" id="szc-nova-msg" placeholder="escreva sua mensagem..." maxlength="1000">
        <button type="button" class="szc-enviar" id="szc-enviar-msg">➤</button>
      </div>
    </div>`);
  document.body.appendChild(btn);
  document.body.appendChild(panel);

  const corpo = panel.querySelector('#szc-corpo');
  const rodape = panel.querySelector('#szc-rodape');

  // as rotas do chat sao publicas e nunca respondem 401, entao da pra usar o
  // fetch da pagina mesmo (nas telas logadas ele so acrescenta o Authorization,
  // que o backend ignora aqui)
  const rawFetch = (url, opts) => window.fetch(url, opts);

  function chatSalvo() {
    const id = localStorage.getItem(LS_ID);
    const token = localStorage.getItem(LS_TOKEN);
    return id && token ? { id, token } : null;
  }
  function limparChatSalvo() {
    localStorage.removeItem(LS_ID);
    localStorage.removeItem(LS_TOKEN);
  }

  async function dadosLogado() {
    const token = localStorage.getItem('authToken');
    if (!token) return null;
    try {
      const r = await rawFetch('/api/me', { headers: { Authorization: 'Bearer ' + token } });
      if (!r.ok) return null;
      const me = await r.json();
      return { nome: me.username || '', contato: me.email || '' };
    } catch (e) { return null; }
  }

  // mesma lista fixa do backend (suporteChat.js ASSUNTOS) - so pra agrupar
  // as conversas na Central de Soluções, escolhida pelo visitante (sem
  // custo de IA pra classificar)
  const ASSUNTOS = ['Computador/Sistema', 'Acesso/Senha', 'Financeiro/Estorno', 'Outro'];

  function renderFormInicial(prefill) {
    rodape.classList.add('szc-hidden');
    // window.__zenithLojaContexto: setado pela pagina de atendimento
    // (?unidade=) - so pra CONFIRMAR pro cliente que a loja certa foi
    // reconhecida (o dado em si ja vai junto no /iniciar, ver iniciarConversa)
    const lojaTag = window.__zenithLojaContexto
      ? `<div class="szc-aviso" style="color:#5cc8ff;">🏬 Loja: ${esc(window.__zenithLojaContexto)}</div>` : '';
    corpo.innerHTML = `
      <div class="szc-aviso">Conte pra gente o que está acontecendo — problema no computador, no sistema ou de acesso. Não precisa estar logado.</div>
      ${lojaTag}
      <div class="szc-label">Seu nome</div>
      <input type="text" class="szc-input" id="szc-nome" maxlength="120" value="${esc(prefill?.nome || '')}">
      <div class="szc-label">Contato (e-mail ou telefone)</div>
      <input type="text" class="szc-input" id="szc-contato" maxlength="120" value="${esc(prefill?.contato || '')}">
      <div class="szc-label">Assunto</div>
      <select class="szc-input" id="szc-assunto">${ASSUNTOS.map((a) => `<option value="${esc(a)}" ${a === 'Acesso/Senha' ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select>
      <div class="szc-label">Mensagem</div>
      <textarea class="szc-textarea" id="szc-texto" maxlength="1000" placeholder="ex: não consigo entrar no sistema"></textarea>
      <button type="button" class="szc-enviar" id="szc-iniciar">Iniciar conversa</button>
      <div class="szc-erro szc-hidden" id="szc-erro-inicial"></div>`;
    corpo.querySelector('#szc-iniciar').addEventListener('click', iniciarConversa);
  }

  async function iniciarConversa() {
    const nome = corpo.querySelector('#szc-nome').value;
    const contato = corpo.querySelector('#szc-contato').value;
    const assunto = corpo.querySelector('#szc-assunto').value;
    const texto = corpo.querySelector('#szc-texto').value;
    const erroEl = corpo.querySelector('#szc-erro-inicial');
    const b = corpo.querySelector('#szc-iniciar');
    erroEl.classList.add('szc-hidden');
    b.disabled = true; b.textContent = 'Enviando...';
    try {
      // manda o authToken de quem estiver logado (se estiver) - o backend
      // decide sozinho o que fazer com isso (ex: liberar consulta de pedido
      // pro Beniboy); rota publica, nunca exige esse header
      const authToken = localStorage.getItem('authToken');
      const headers = { 'Content-Type': 'application/json' };
      if (authToken) headers.Authorization = 'Bearer ' + authToken;
      const r = await rawFetch('/api/suporte-chat/iniciar', {
        method: 'POST', headers,
        // lojaContexto: setado pela pagina de atendimento (atendimento.html,
        // ?unidade=) ANTES de carregar esse script - o Beniboy ja sabe a
        // loja sem precisar perguntar (ver window.__zenithLojaContexto)
        body: JSON.stringify({ nome, contato, texto, assunto, lojaContexto: window.__zenithLojaContexto || null }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Não foi possível iniciar a conversa.');
      localStorage.setItem(LS_ID, data.id);
      localStorage.setItem(LS_TOKEN, data.token);
      await carregarConversa();
    } catch (err) {
      erroEl.textContent = err.message;
      erroEl.classList.remove('szc-hidden');
      b.disabled = false; b.textContent = 'Iniciar conversa';
    }
  }

  function renderConversa(chat) {
    const noFim = corpo.scrollTop + corpo.clientHeight >= corpo.scrollHeight - 30;
    // protocolo (mesma numeracao global dos tickets) - a pessoa ja recebe
    // um numero pra referenciar desde o 1o contato, viraz ou nao um chamado
    // de verdade depois (pedido explicito do usuario)
    const protocoloTag = chat.numeroTicket
      ? `<div class="szc-aviso" style="color:#5cc8ff;">🎫 Protocolo #${chat.numeroTicket} · <button type="button" class="szc-link" id="szc-pdf">📄 baixar PDF da conversa</button></div>`
      : '';
    // m.bot = resposta do Beniboy (assistente automático) - identificado
    // pra pessoa saber que ainda não é um humano falando
    corpo.innerHTML = protocoloTag + ((chat.mensagens || []).map((m) => `
      <div class="szc-msg ${m.de === 'visitante' ? 'visitante' : 'suporte'}">
        <span class="szc-quem">${m.de === 'visitante' ? esc(chat.nome || 'Você') : (m.bot ? '🤖 Beniboy · assistente virtual' : 'Suporte')}</span><span class="szc-quando">${fmtQuando(m.em)}</span>${esc(m.texto)}
      </div>`).join('') || '<div class="szc-aviso">Sem mensagens ainda.</div>');
    const pdfBtn = corpo.querySelector('#szc-pdf');
    if (pdfBtn) {
      pdfBtn.addEventListener('click', () => {
        const salvo = chatSalvo();
        if (salvo) baixarPdf(`/api/suporte-chat/${encodeURIComponent(salvo.id)}/pdf?token=${encodeURIComponent(salvo.token)}`);
      });
    }
    if (chat.status !== 'ABERTO') {
      corpo.insertAdjacentHTML('beforeend', `<div class="szc-fim">Conversa finalizada pelo Suporte. Precisa de mais ajuda?<br><button type="button" class="szc-link" id="szc-nova-conversa">Iniciar nova conversa</button></div>`);
      corpo.querySelector('#szc-nova-conversa').addEventListener('click', async () => {
        limparChatSalvo();
        pararPoll();
        renderFormInicial(await dadosLogado());
      });
      rodape.classList.add('szc-hidden');
    } else {
      rodape.classList.remove('szc-hidden');
    }
    const total = (chat.mensagens || []).length;
    if (noFim || total !== ultimoTotalMensagens) corpo.scrollTop = corpo.scrollHeight;
    ultimoTotalMensagens = total;
  }

  async function carregarConversa() {
    const salvo = chatSalvo();
    if (!salvo) { renderFormInicial(await dadosLogado()); return; }
    try {
      const r = await rawFetch(`/api/suporte-chat/${encodeURIComponent(salvo.id)}?token=${encodeURIComponent(salvo.token)}`);
      if (r.status === 404) { limparChatSalvo(); renderFormInicial(await dadosLogado()); return; }
      const chat = await r.json();
      renderConversa(chat);
      iniciarPoll();
    } catch (e) { /* rede fora - tenta no proximo poll */ }
  }

  async function enviarMensagem() {
    const salvo = chatSalvo();
    if (!salvo) return;
    const input = panel.querySelector('#szc-nova-msg');
    const texto = input.value.trim();
    if (!texto) return;
    const b = panel.querySelector('#szc-enviar-msg');
    b.disabled = true;
    try {
      const r = await rawFetch(`/api/suporte-chat/${encodeURIComponent(salvo.id)}/mensagem`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: salvo.token, texto }),
      });
      if (r.ok) { input.value = ''; await carregarConversa(); }
    } finally { b.disabled = false; }
  }

  function iniciarPoll() {
    if (pollTimer) return;
    pollTimer = setInterval(() => { if (aberto && chatSalvo()) carregarConversa(); }, 5000);
  }
  function pararPoll() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  btn.addEventListener('click', () => {
    aberto = !aberto;
    panel.classList.toggle('szc-hidden', !aberto);
    atualizarNomeFlutuante();
    if (!aberto) { pararPoll(); return; }
    // MASTER: o mesmo icone abre o ATENDIMENTO (lista de conversas) em
    // vez do formulario de visitante - so no Master
    if (ATEND.ehMaster) atendRenderLista();
    else carregarConversa();
  });
  panel.querySelector('.szc-x').addEventListener('click', () => { aberto = false; panel.classList.add('szc-hidden'); pararPoll(); atualizarNomeFlutuante(); });
  panel.querySelector('#szc-enviar-msg').addEventListener('click', enviarMensagem);
  panel.querySelector('#szc-nova-msg').addEventListener('keydown', (e) => { if (e.key === 'Enter') enviarMensagem(); });

  // ================= LADO DO ATENDIMENTO (Master/Admin/tag Suporte) =========
  // - Mensagem nova de visitante: a caixa de dialogo ABRE SOZINHA em
  //   qualquer aba, com resposta inline. Fechou? O marcador e salvo e a
  //   conversa continua na Central do Beniboy (💬 Chats de suporte).
  // - MASTER: o proprio icone 💬 vira a central de chats (lista + conversa).
  const ATEND = { ativo: false, ehMaster: false, podeAlarme: false, chats: [], chatAberto: null, timer: null };
  const LS_ATEND_VISTO = 'szcAtendVisto:'; // + chatId -> "em" da ultima msg de visitante ja vista

  const badge = el('<span style="position:absolute;top:-4px;right:-4px;background:#ff5c5c;color:#fff;font-size:10.5px;font-weight:700;border-radius:10px;padding:1px 6px;display:none;font-family:ui-monospace,monospace;">0</span>');
  btn.style.position = 'fixed';
  btn.appendChild(badge);

  // nome do Beniboy flutuando do lado do botao - so faz sentido pro
  // VISITANTE (quem vai falar com o bot); some quando a conversa esta
  // aberta (o painel ja ocupa aquele canto) e nunca aparece pro atendimento,
  // onde o mesmo icone vira "Chats de suporte" e o nome perderia o sentido
  const nomeBotWrap = el('<div class="szc-bot-nome-wrap"><span class="szc-bot-nome">Beniboy</span></div>');
  document.body.appendChild(nomeBotWrap);
  function atualizarNomeFlutuante() {
    nomeBotWrap.classList.toggle('szc-hidden', aberto || ATEND.ativo);
  }
  atualizarNomeFlutuante();

  function authHeaders() {
    const t = localStorage.getItem('authToken');
    return t ? { Authorization: 'Bearer ' + t } : {};
  }

  function ultimaMsgVisitante(chat) {
    const msgs = chat.mensagens || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].de === 'visitante') return msgs[i];
      // resposta do Beniboy conta como "respondida" ENQUANTO ele esta na
      // conversa; se ele chamou um atendente (botDesativado), a fala dele e
      // ignorada e a conversa volta pra fila vermelha do time
      if (msgs[i].de === 'suporte' && !(msgs[i].bot && chat.botDesativado)) return null; // ja respondida
    }
    return null;
  }

  function atendAguardando() {
    return ATEND.chats.filter((c) => c.status === 'ABERTO' && ultimaMsgVisitante(c));
  }

  async function atendCarregar() {
    try {
      const r = await rawFetch('/api/suporte-chats', { headers: authHeaders() });
      if (!r.ok) return;
      ATEND.chats = await r.json();
      const fila = atendAguardando();
      badge.textContent = fila.length;
      badge.style.display = fila.length ? 'block' : 'none';
      // conversa aberta no momento: atualiza ao vivo (so a thread de
      // mensagens - ver atendAtualizarThreadAoVivo - pra nao apagar o que
      // o atendente esteja digitando na caixa de resposta)
      if (aberto && ATEND.chatAberto) {
        const atual = ATEND.chats.find((c) => c.id === ATEND.chatAberto);
        if (atual) atendAtualizarThreadAoVivo(atual);
      }
      // popup automatico: mensagem de visitante mais nova que o marcador
      const nova = fila.find((c) => {
        const m = ultimaMsgVisitante(c);
        return m && m.em > (localStorage.getItem(LS_ATEND_VISTO + c.id) || '');
      });
      if (nova && !aberto) {
        aberto = true;
        panel.classList.remove('szc-hidden');
        atendRenderConversa(nova);
      }
    } catch (e) { /* rede fora - tenta no proximo ciclo */ }
  }

  function atendMarcarVisto(chat) {
    const m = ultimaMsgVisitante(chat) || (chat.mensagens || [])[(chat.mensagens || []).length - 1];
    if (m) localStorage.setItem(LS_ATEND_VISTO + chat.id, m.em || new Date().toISOString());
  }

  function atendRenderLista() {
    ATEND.chatAberto = null;
    rodape.classList.add('szc-hidden');
    const abertos = ATEND.chats.filter((c) => c.status === 'ABERTO');
    corpo.innerHTML = '<div class="szc-aviso">💬 Chats de suporte — toque pra atender. Histórico e finalização ficam na <b>Central do Beniboy</b>.</div>' + (abertos.map((c) => {
      const msgs = c.mensagens || [];
      const ultima = msgs[msgs.length - 1];
      const aguarda = !!ultimaMsgVisitante(c);
      return `<button type="button" class="szc-input" style="text-align:left;cursor:pointer;${aguarda ? 'border-color:#ff5c5c;' : ''}" data-atend-chat="${esc(c.id)}">
        <b style="font-size:12.5px;">${aguarda ? '🔴 ' : ''}${esc(c.nome)}${c.numeroTicket ? ' · #' + c.numeroTicket : ''}</b>
        <span style="display:block;font-size:11px;color:#7d8896;">${esc((ultima && ultima.texto || '').slice(0, 60))}</span>
      </button>`;
    }).join('') || '<div class="szc-fim">Nenhuma conversa aberta. 🎉</div>') +
    '<button type="button" class="szc-link" id="szc-ir-beniboy" style="margin-top:4px;">abrir histórico de conversas (Central do Beniboy) →</button>';
    corpo.querySelectorAll('[data-atend-chat]').forEach((b) => b.addEventListener('click', () => {
      const c = ATEND.chats.find((x) => x.id === b.dataset.atendChat);
      if (c) atendRenderConversa(c);
    }));
    corpo.querySelector('#szc-ir-beniboy').addEventListener('click', () => { location.href = '/beniboy.html'; });
  }

  function montarThreadHtml(chat) {
    return (chat.mensagens || []).map((m) => `
      <div class="szc-msg ${m.de === 'visitante' ? 'suporte' : 'visitante'}">
        <span class="szc-quem">${m.de === 'visitante' ? esc(chat.nome || 'Visitante') : (m.bot ? '🤖 Beniboy (bot)' : 'Suporte')}</span><span class="szc-quando">${fmtQuando(m.em)}</span>${esc(m.texto)}
      </div>`).join('');
  }

  // render COMPLETO - usado so ao ABRIR uma conversa (clique na lista, popup
  // automatico, ou depois de mandar uma resposta). Recria o input de resposta
  // do zero, o que e esperado nesses casos (nada estava sendo digitado ainda,
  // ou acabou de ser enviado)
  function atendRenderConversa(chat, manterScroll) {
    ATEND.chatAberto = chat.id;
    rodape.classList.add('szc-hidden');
    const noFim = !manterScroll || corpo.scrollTop + corpo.clientHeight >= corpo.scrollHeight - 30;
    corpo.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;">
        <button type="button" class="szc-link" id="szc-atend-voltar">← conversas</button>
        <span style="font-size:11px;color:#7d8896;">${esc(chat.nome)} · ${esc(chat.contato || '')}${chat.numeroTicket ? ' · Protocolo #' + chat.numeroTicket : ''}</span>
      </div>
      <div id="szc-atend-thread">${montarThreadHtml(chat)}</div>
      <div style="display:flex;gap:6px;">
        <input type="text" class="szc-input" id="szc-atend-msg" placeholder="responder..." maxlength="1000" style="flex:1;">
        <button type="button" class="szc-enviar" id="szc-atend-enviar">➤</button>
      </div>
      ${ATEND.ehMaster ? `<button type="button" class="szc-link" id="szc-atend-pdf" style="margin-top:4px;">📄 baixar PDF da conversa</button>` : ''}`;
    atendMarcarVisto(chat);
    atendAtualizarBadge();
    corpo.querySelector('#szc-atend-voltar').addEventListener('click', () => {
      if (ATEND.ehMaster) atendRenderLista();
      else { aberto = false; panel.classList.add('szc-hidden'); }
    });
    // botao de PDF so existe no DOM quando ATEND.ehMaster (rota tambem e
    // Master-only no backend - pedido explicito do usuario: "so o master
    // pode gerar o pdf")
    const btnPdf = corpo.querySelector('#szc-atend-pdf');
    if (btnPdf) {
      btnPdf.addEventListener('click', () => {
        baixarPdf(`/api/suporte-chats/${encodeURIComponent(chat.id)}/pdf`, authHeaders());
      });
    }
    const input = corpo.querySelector('#szc-atend-msg');
    const enviar = async () => {
      const texto = input.value.trim();
      if (!texto) return;
      const b = corpo.querySelector('#szc-atend-enviar');
      b.disabled = true;
      try {
        const r = await rawFetch(`/api/suporte-chats/${encodeURIComponent(chat.id)}/responder`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ texto }),
        });
        if (r.ok) {
          const atualizado = await r.json();
          const i = ATEND.chats.findIndex((c) => c.id === atualizado.id);
          if (i >= 0) ATEND.chats[i] = atualizado;
          atendMarcarVisto(atualizado);
          atendRenderConversa(atualizado);
        }
      } finally { b.disabled = false; }
    };
    corpo.querySelector('#szc-atend-enviar').addEventListener('click', enviar);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); enviar(); } });
    if (noFim) corpo.scrollTop = corpo.scrollHeight;
    input.focus();
  }

  // atualizacao AO VIVO da MESMA conversa ja aberta (poll/SSE trazendo
  // mensagem nova enquanto o atendente esta olhando) - troca SO a thread de
  // mensagens (#szc-atend-thread), nunca recria o input de resposta. Bug
  // reportado pelo usuario: antes disso, todo re-render (a cada mensagem
  // nova em QUALQUER conversa, nao so a aberta) recriava o input inteiro,
  // apagando o que a pessoa estava digitando no meio da resposta.
  function atendAtualizarThreadAoVivo(chat) {
    const threadEl = corpo.querySelector('#szc-atend-thread');
    if (!threadEl) { atendRenderConversa(chat, true); return; } // painel nao esta na estrutura esperada - refaz do zero
    const noFim = corpo.scrollTop + corpo.clientHeight >= corpo.scrollHeight - 30;
    threadEl.innerHTML = montarThreadHtml(chat);
    atendMarcarVisto(chat);
    atendAtualizarBadge();
    if (noFim) corpo.scrollTop = corpo.scrollHeight;
  }

  function atendAtualizarBadge() {
    const fila = atendAguardando();
    badge.textContent = fila.length;
    badge.style.display = fila.length ? 'block' : 'none';
  }

  // fechar no X tambem salva o "visto" da conversa aberta - o popup nao
  // volta pra mesma mensagem; mensagem NOVA reabre
  panel.querySelector('.szc-x').addEventListener('click', () => {
    if (ATEND.chatAberto) {
      const c = ATEND.chats.find((x) => x.id === ATEND.chatAberto);
      if (c) atendMarcarVisto(c);
      ATEND.chatAberto = null;
    }
  });

  // ---------- alarme critico: Beniboy chamou um atendente (Master + tag
  // Suporte) porque nao conseguiu resolver sozinho. Toca uma sirene alta em
  // loop + vibra o aparelho ate a pessoa silenciar - dispara tanto por SSE
  // (app aberto em alguma pagina, ver atendInit abaixo) quanto pela
  // notificacao push critica (celular fechado/outro app - ver sw.js), que
  // acorda essa mesma tela se a pagina ja estiver aberta em segundo
  // plano ----------
  let alarmeAtivo = false;
  let alarmeAudioCtx = null;
  let alarmeSirenTimer = null;
  let alarmeVibraTimer = null;
  const alarmeEl = el(`<div class="szc-alarme" role="alertdialog" aria-label="Alerta do Beniboy">
    <div class="szc-al-icone">🚨</div>
    <div class="szc-al-titulo">Beniboy precisa de você</div>
    <div class="szc-al-corpo" id="szc-al-corpo">O assistente não conseguiu resolver sozinho.</div>
    <div class="szc-al-botoes">
      <button type="button" class="szc-al-atender">🎧 Atender agora</button>
      <button type="button" class="szc-al-silenciar">🔕 Silenciar</button>
    </div>
  </div>`);
  document.body.appendChild(alarmeEl);

  function tocarSirene() {
    try {
      alarmeAudioCtx = alarmeAudioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const tocarTom = (delay, freq) => {
        const osc = alarmeAudioCtx.createOscillator();
        const gain = alarmeAudioCtx.createGain();
        osc.type = 'square'; osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, alarmeAudioCtx.currentTime + delay);
        gain.gain.exponentialRampToValueAtTime(0.35, alarmeAudioCtx.currentTime + delay + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, alarmeAudioCtx.currentTime + delay + 0.42);
        osc.connect(gain); gain.connect(alarmeAudioCtx.destination);
        osc.start(alarmeAudioCtx.currentTime + delay);
        osc.stop(alarmeAudioCtx.currentTime + delay + 0.45);
      };
      tocarTom(0, 1046);
      tocarTom(0.45, 784);
    } catch (e) { /* audio bloqueado antes de alguma interacao - a vibracao/tela seguem */ }
  }

  function dispararAlarmeBeniboy(info) {
    if (!ATEND.podeAlarme) return; // alarme e pro Master + tag Suporte (ver push.notifyBeniboyEscalonamento)
    const corpo = info && (info.nome || info.motivo)
      ? `${esc(info.nome || 'Visitante')}${info.motivo ? ' · ' + esc(info.motivo) : ''}`
      : 'O assistente não conseguiu resolver sozinho.';
    alarmeEl.querySelector('#szc-al-corpo').textContent = corpo;
    if (alarmeAtivo) return; // ja tocando - so atualiza o texto
    alarmeAtivo = true;
    alarmeEl.classList.add('szc-alarme-on');
    tocarSirene();
    alarmeSirenTimer = setInterval(tocarSirene, 900);
    if (navigator.vibrate) {
      navigator.vibrate([400, 200, 400, 200, 400]);
      alarmeVibraTimer = setInterval(() => navigator.vibrate([400, 200, 400, 200, 400]), 1600);
    }
  }
  function pararAlarmeBeniboy() {
    alarmeAtivo = false;
    alarmeEl.classList.remove('szc-alarme-on');
    if (alarmeSirenTimer) { clearInterval(alarmeSirenTimer); alarmeSirenTimer = null; }
    if (alarmeVibraTimer) { clearInterval(alarmeVibraTimer); alarmeVibraTimer = null; }
    if (navigator.vibrate) navigator.vibrate(0);
  }
  alarmeEl.querySelector('.szc-al-silenciar').addEventListener('click', pararAlarmeBeniboy);
  alarmeEl.querySelector('.szc-al-atender').addEventListener('click', () => {
    pararAlarmeBeniboy();
    location.href = '/beniboy.html';
  });
  // notificacao push critica chegou com a pagina ja aberta (em qualquer aba)
  // - o service worker avisa direto, sem esperar clique na notificacao
  if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'beniboy-alerta-critico') dispararAlarmeBeniboy(null);
    });
  }

  // ---------- popup "pedido mudou de status" (pedidoWatch.js) - quem
  // perguntou pro Beniboy o status de um pedido especifico e avisado sozinho
  // se esse status mudar depois, em CIMA de qualquer tela do Zenith que
  // estiver aberta (ver pedido-status-mudou no SSE em atendInit abaixo).
  // Com o app fechado, o mesmo alerta chega por push (ver push.notifyUsuario) ----------
  const pedidoPopupEl = el('<div class="szc-pedido-popup"></div>');
  document.body.appendChild(pedidoPopupEl);
  function mostrarPopupPedido(d) {
    const card = el(`<div class="szc-pp-card">
      <button type="button" class="szc-pp-fechar" title="Fechar">✕</button>
      <div class="szc-pp-titulo">📦 Pedido ${esc(d.pedidoId || '')} mudou de status</div>
      <div class="szc-pp-corpo">${esc(d.cliente || 'Cliente')} · R$ ${Number(d.valor || 0).toFixed(2)}<br>${esc(d.statusAnterior || '—')} → <b>${esc(d.statusAtual || '')}</b></div>
    </div>`);
    pedidoPopupEl.appendChild(card);
    const remover = () => { if (card.parentNode) card.parentNode.removeChild(card); };
    card.querySelector('.szc-pp-fechar').addEventListener('click', remover);
    setTimeout(remover, 15000);
  }

  // ---------- popup "mensagem direta" (Master/Suporte -> voce) - mesmo
  // container/estilo do popup de pedido acima, so pra avisos avulsos que o
  // Master/Suporte manda proativamente (ver POST /api/mensagens/enviar).
  // Fica em cima de QUALQUER tela do Zenith, igual ao de pedido; com o app
  // fechado o mesmo aviso chega por push (push.notifyUsuario) ----------
  function mostrarPopupMensagem(d) {
    const card = el(`<div class="szc-pp-card">
      <button type="button" class="szc-pp-fechar" title="Fechar">✕</button>
      <div class="szc-pp-titulo">💬 Mensagem de ${esc(d.deEmail || 'Suporte')}</div>
      <div class="szc-pp-corpo">${esc(d.texto || '')}</div>
    </div>`);
    pedidoPopupEl.appendChild(card);
    const remover = () => { if (card.parentNode) card.parentNode.removeChild(card); };
    card.querySelector('.szc-pp-fechar').addEventListener('click', remover);
    setTimeout(remover, 20000);
  }

  async function atendInit() {
    const token = localStorage.getItem('authToken');
    if (!token) return;
    try {
      const r = await rawFetch('/api/me', { headers: { Authorization: 'Bearer ' + token } });
      if (r.ok) {
        const me = await r.json();
        const secoes = (me.permissions && me.permissions.sections) || [];
        if (me.role === 'master' || me.isAdmin || secoes.includes('suporte')) {
          ATEND.ativo = true;
          ATEND.ehMaster = me.role === 'master';
          // alarme critico (Beniboy chamou humano): Master + tag Suporte -
          // Admin sem a tag fica de fora de proposito (ver push.js podeReceberCritico)
          ATEND.podeAlarme = me.role === 'master' || secoes.includes('suporte');
          btn.title = 'Chats de suporte';
          atualizarNomeFlutuante(); // atendimento nao mostra o nome do Beniboy
          await atendCarregar();
          // aba em segundo plano nao busca (ninguem esta olhando e a requisicao
          // so gastaria servidor/Firestore a toa) - ao voltar pra aba, atualiza
          // na hora. O SSE continua ligado, entao mensagem nova ainda chega.
          ATEND.timer = setInterval(() => { if (!document.hidden) atendCarregar(); }, 25 * 1000);
          document.addEventListener('visibilitychange', () => { if (!document.hidden && ATEND.ativo) atendCarregar(); });
        }
      }
    } catch (e) { /* segue como widget de visitante */ }
    // SSE: aberto pra QUALQUER pessoa logada (nao so time de suporte) - alem
    // da fila de atendimento (so quem atende), qualquer um que perguntou pro
    // Beniboy o status de um pedido recebe o popup ao vivo em cima de
    // qualquer tela, se o status mudar depois (pedidoWatch.js/index.js)
    try {
      const es = new EventSource('/api/stream?token=' + encodeURIComponent(token));
      if (ATEND.ativo) {
        es.addEventListener('suporte-chat', () => { atendCarregar(); });
        es.addEventListener('beniboy-escalonamento', (e) => { dispararAlarmeBeniboy(JSON.parse(e.data)); });
      }
      es.addEventListener('pedido-status-mudou', (e) => { mostrarPopupPedido(JSON.parse(e.data)); });
      es.addEventListener('mensagem-direta', (e) => { mostrarPopupMensagem(JSON.parse(e.data)); });
    } catch (e) { /* sem SSE, sem alerta ao vivo aqui - o push cobre com o app fechado */ }
  }
  atendInit();

  // pagina dedicada de atendimento (atendimento.html) marca esse flag ANTES
  // de carregar esse script - abre a conversa direto, sem a pessoa precisar
  // achar/clicar no balaozinho (a pagina toda existe so pra isso). ATEND.ehMaster
  // fica false aqui (visitante nunca tem token de time de atendimento), entao
  // sempre cai no fluxo normal de visitante (carregarConversa)
  if (window.__zenithAbrirChatAuto && !aberto) {
    aberto = true;
    panel.classList.remove('szc-hidden');
    atualizarNomeFlutuante();
    carregarConversa();
  }
})();
