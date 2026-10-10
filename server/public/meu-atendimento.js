'use strict';
(function () {
  const app = document.querySelector('#app'), erro = document.querySelector('#erro');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const auth = localStorage.getItem('authToken');
  const hash = new URLSearchParams(location.hash.slice(1));
  const legado = !!(hash.get('id') && hash.get('token'));
  let atual = null;
  function avisar(e) { erro.textContent = e.message; erro.hidden = false; }
  function status(c) { return c.status === 'FINALIZADO' ? (c.statusAtendimento === 'RESOLVIDO' ? 'Resolvido' : 'Sem solução') : (c.statusAtendimento || 'Em andamento').replaceAll('_', ' '); }
  async function requisicao(url, opt = {}) {
    const headers = { ...opt.headers };
    // Um link antigo autoriza só aquela conversa, não usa a sessão de outra pessoa.
    if (auth && !legado) {
      if (localStorage.getItem('authToken') !== auth) throw new Error('Sua sessão mudou. Entre novamente para continuar.');
      headers.Authorization = 'Bearer ' + auth;
    }
    const r = await fetch(url, { ...opt, headers, cache: 'no-store' });
    if (!r.ok) {
      if (r.status === 401) {
        document.querySelector('#entrar').hidden = false;
        document.querySelectorAll('[data-area-destino]').forEach(a => { a.hidden = true; a.removeAttribute('href'); });
      }
      const d = await r.json().catch(() => ({}));
      throw new Error(d.error || (r.status === 401 ? 'Sua sessão venceu. Entre novamente; sua mensagem não foi enviada.' : 'Não foi possível acessar este atendimento. Tente novamente.'));
    }
    return r;
  }
  async function json(url, opt) {
    const d = await (await requisicao(url, opt)).json();
    if (!legado && localStorage.getItem('authToken') !== auth) throw new Error('Sua sessão mudou. Entre novamente para continuar.');
    return d;
  }
  function anexo(m, i) {
    if (!m.anexo) return '';
    const nome = esc(m.anexo.nome);
    if (legado) return `<a href="/api/suporte-chat/${encodeURIComponent(atual.id)}/anexo/${i}?token=${encodeURIComponent(hash.get('token'))}">📎 ${nome}</a>`;
    return `<button class="arquivo" type="button" data-anexo="${i}" data-nome="${nome}">📎 ${nome}</button>`;
  }
  function renderChat(c) {
    atual = c;
    document.querySelector('#voltar').hidden = legado;
    app.innerHTML = `<div class="card"><b>Protocolo #${esc(c.numeroTicket)}</b><div class="meta">${esc(c.assunto || 'Atendimento')} · ${esc(status(c))}</div></div>
      <section aria-label="Mensagens">${(c.mensagens || []).map((m, i) => `<div class="msg ${m.de === 'visitante' ? 'eu' : 'suporte'}"><b>${m.de === 'visitante' ? 'Você' : 'Suporte'}</b><div class="texto">${esc(m.texto)}</div>${anexo(m, i)}<div class="meta">${esc(new Date(m.em).toLocaleString('pt-BR'))}</div></div>`).join('')}</section>
      ${c.status === 'ABERTO' ? '<form id="resposta"><label for="mensagem">Sua mensagem</label><textarea id="mensagem" name="texto" placeholder="Escreva sua resposta"></textarea><label for="anexo">Anexo (opcional)</label><input id="anexo" name="anexo" type="file" accept="image/*,application/pdf"><button type="submit">Enviar mensagem</button></form>' : '<div class="card">Este atendimento foi encerrado.</div>'}`;
    app.querySelectorAll('[data-anexo]').forEach(b => b.onclick = async () => {
      try {
        const r = await requisicao(`/api/meus-atendimentos/${encodeURIComponent(c.id)}/anexo/${b.dataset.anexo}`);
        const url = URL.createObjectURL(await r.blob()), a = document.createElement('a');
        a.href = url; a.download = b.dataset.nome || 'anexo'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (e) { avisar(e); }
    });
    const f = document.querySelector('#resposta');
    if (f) f.onsubmit = async e => {
      e.preventDefault();
      const botao = f.querySelector('button[type=submit]');
      if (botao.disabled) return;
      if (!f.elements.texto.value.trim() && !f.elements.anexo.files.length) return;
      botao.disabled = true; erro.hidden = true;
      try {
        const fd = new FormData(f);
        if (legado) fd.append('token', hash.get('token'));
        await json(`/api/${legado ? 'suporte-chat' : 'meus-atendimentos'}/${encodeURIComponent(c.id)}/mensagem`, { method: 'POST', body: fd });
        f.reset(); await carregarChat(c.id);
      } catch (x) { avisar(x); } finally { botao.disabled = false; }
    };
  }
  async function carregarChat(id) {
    erro.hidden = true;
    try { renderChat(await json(legado ? `/api/meu-atendimento/${encodeURIComponent(id)}?token=${encodeURIComponent(hash.get('token'))}` : `/api/meus-atendimentos/${encodeURIComponent(id)}`)); }
    catch (e) { avisar(e); if (!atual) app.textContent = ''; }
  }
  async function listar() {
    erro.hidden = true;
    try {
      const d = await json('/api/meus-atendimentos');
      const todos = [...d.abertos, ...(d.ultimoEncerrado ? [d.ultimoEncerrado] : [])];
      document.querySelector('#sair').hidden = false;
      document.querySelector('#voltar').hidden = true;
      atual = null;
      app.innerHTML = todos.length ? todos.map(c => `<button class="protocolo" data-id="${esc(c.id)}"><span>#${esc(c.numeroTicket)} · ${esc(c.assunto || 'Atendimento')}</span><span class="meta">${esc(status(c))}</span></button>`).join('') : '<div class="card">Nenhum atendimento encontrado para este usuário.</div>';
      app.querySelectorAll('[data-id]').forEach(b => b.onclick = () => carregarChat(b.dataset.id));
    } catch (e) { avisar(e); if (!atual) app.textContent = ''; }
  }
  function podeSairDaConversa() {
    const f = document.querySelector('#resposta');
    return !f || (!f.elements.texto.value.trim() && !f.elements.anexo.files.length) || confirm('Há uma mensagem não enviada. Deseja sair desta conversa?');
  }
  document.querySelector('#voltar').onclick = () => { if (podeSairDaConversa()) listar(); };
  document.querySelector('#sair').onclick = () => {
    if (!podeSairDaConversa()) return;
    localStorage.removeItem('authToken'); location.replace('/atendimento/entrar');
  };
  window.addEventListener('storage', e => {
    if (!legado && (e.key === 'authToken' || e.key === null) && localStorage.getItem('authToken') !== auth) {
      app.textContent = ''; atual = null; document.querySelector('#entrar').hidden = false;
      avisar(new Error('Sua sessão mudou. Entre novamente para ver seus atendimentos.'));
    }
  });
  if (legado) carregarChat(hash.get('id'));
  else if (auth) listar();
  else { app.textContent = 'Entre para acompanhar seus atendimentos.'; document.querySelector('#entrar').hidden = false; }
})();
