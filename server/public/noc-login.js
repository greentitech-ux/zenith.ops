// O vínculo de uso único vem do agente, nunca contém sua chave permanente.
(async () => {
  const vinculo = new URLSearchParams(location.hash.slice(1)).get('vinculo');
  history.replaceState(null, '', '/noc-login');
  const estado = document.getElementById('estado');
  if (!vinculo) { estado.textContent = 'Abra o atalho "NoPulso - acesso NOC" no computador com o agente instalado.'; return; }
  try {
    const r = await fetch('/api/noc-login/registrar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vinculo }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Não foi possível validar o computador.');
    estado.textContent = 'Navegador validado neste computador por 24 horas. Suas permissões pessoais permanecem iguais. Reabra o atalho após esse prazo ou se mudar a conexão.';
    document.getElementById('entrar').hidden = false;
  } catch (e) { estado.textContent = e.message; }
})();
