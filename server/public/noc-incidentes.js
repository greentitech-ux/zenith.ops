// A Central NOC não mantém uma segunda fila local. Tudo vem de
// /api/loja-status/incidentes, que por sua vez lê a Central de Alertas: é o
// mesmo estado que o push, a auditoria e o botão "Atender" usam.
(() => {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const tempo = (iso) => {
    const ms = Math.max(0, Date.now() - Date.parse(iso || Date.now()));
    if (ms < 60000) return 'agora';
    if (ms < 3600000) return `há ${Math.round(ms / 60000)} min`;
    return `há ${Math.round(ms / 3600000)} h`;
  };
  const tipo = (a) => {
    if (/impressora/.test(a.tipo)) return '🖨️ Impressora';
    if (/ip/.test(a.tipo)) return '📍 IP / rede';
    if (/offline|online|internet|rede/.test(a.tipo)) return '📡 Conectividade';
    if (/disco/.test(a.tipo)) return '💽 Disco';
    if (/comando|reinicio/.test(a.tipo)) return '⚙️ Agente / comando';
    if (/vm/.test(a.tipo)) return '🖥️ Máquina virtual';
    return '🔔 NOC';
  };
  const ciclo = (a) => {
    const p = [];
    if (a.caiuEm) p.push('caiu ' + new Date(a.caiuEm).toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' }));
    if (a.voltouEm) p.push('voltou ' + new Date(a.voltouEm).toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' }));
    if (a.foraMs != null) p.push(`ficou fora ${Math.max(1, Math.round(a.foraMs / 60000))} min`);
    return p.join(' · ');
  };
  async function atender(id) {
    const r = await fetch(`/api/alertas-central/${encodeURIComponent(id)}/atender`, { method: 'POST' });
    if (!r.ok) return alert('Não foi possível registrar o atendimento.');
    window.carregar();
  }
  function renderIncidentes(dados) {
    const all = Array.isArray(dados.incidentes) ? dados.incidentes : [];
    const abertos = all.filter((a) => !a.atendidoEm);
    const criticos = abertos.filter((a) => a.critico).length;
    const normalizados = abertos.filter((a) => a.estado === 'voltou').length;
    const kpis = document.getElementById('kpis');
    kpis.innerHTML = `<div class="kpi"><b class="r">${criticos}</b><span>críticos</span></div><div class="kpi"><b class="y">${Math.max(0, abertos.length - criticos)}</b><span>em atenção</span></div><div class="kpi"><b class="g">${normalizados}</b><span>normalizados</span></div>`;
    const lista = document.getElementById('lista');
    if (!abertos.length) { lista.innerHTML = '<div class="vazio">✓ Nenhum incidente pendente no NOC.</div>'; return; }
    lista.innerHTML = abertos.map((a) => {
      const nivel = a.critico ? 'critico' : 'atencao';
      const estado = a.estado === 'voltou' ? 'normalizado' : nivel;
      return `<article class="i ${nivel}"><div class="it"><i class="dot"></i><div><h2>${esc(a.titulo || tipo(a))}</h2><div class="u">${esc(tipo(a))}${a.atendidoPorEmail ? ` · ${esc(a.atendidoPorEmail)}` : ''}</div></div><span class="nivel">${estado}</span></div>${a.resumo ? `<p class="motivo">${esc(a.resumo)}</p>` : ''}${ciclo(a) ? `<p class="tempo">${esc(ciclo(a))}</p>` : ''}<div class="foot"><span class="tempo">registrado ${esc(tempo(a.criadoEm))}</span><span>${a.url ? `<a class="abrir" href="${esc(a.url)}">Abrir →</a>` : ''}${dados.podeAtender ? `<button class="abrir" type="button" style="background:#181d24;color:#b8ff3c;cursor:pointer;font-weight:700" onclick="window.nocAtender('${esc(a.id)}')">✓ Atender</button>` : ''}</span></div></article>`;
    }).join('');
  }
  window.nocAtender = atender;
  window.carregar = async function carregarIncidentes() {
    try {
      const dados = await fetch('/api/loja-status/incidentes').then((r) => r.json());
      if (dados.error) throw new Error(dados.error);
      renderIncidentes(dados);
      const alvo = document.getElementById('atualizado'); if (alvo) alvo.textContent = 'atualizado agora';
    } catch (e) {
      document.getElementById('lista').innerHTML = '<div class="vazio">Não foi possível carregar os incidentes.</div>';
    }
  };
  // O script HTML chama a versão antiga durante a montagem; esta chamada a
  // substitui logo em seguida pela fonte persistente e auditável.
  window.carregar();
})();
