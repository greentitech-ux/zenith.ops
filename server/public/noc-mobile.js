// NOC Mobile: a tela continua sendo web (e segura), mas quando instalada vira
// um app independente que abre direto no NOC. Nunca reporta "online/offline"
// de uma loja: celulares entram em repouso e não podem ser agente de rede.
(() => {
  let installEvent = null;
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const aviso = texto => window.alert(texto);

  async function atualizarPush() {
    const btn = document.getElementById('noc-push');
    if (!btn || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      const sub = await reg.pushManager.getSubscription();
      btn.textContent = sub ? '🔔 Alertas ativos' : '🔔 Ativar alertas';
      btn.classList.toggle('ativo', !!sub);
    } catch (_) { btn.textContent = '🔔 Alertas indisponíveis'; }
  }

  async function ativarPush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      aviso('Este navegador não oferece alertas push. Abra pelo Chrome, Edge ou pelo app NOC instalado.'); return;
    }
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      const atual = await reg.pushManager.getSubscription();
      if (atual) { await atual.unsubscribe(); await atualizarPush(); return; }
      const chave = await fetch('/api/push/vapid-public-key').then(r => r.json()).then(d => d.publicKey);
      if (!chave) throw new Error('chave de alerta indisponível');
      const base64 = chave + '='.repeat((4 - chave.length % 4) % 4);
      const bytes = Uint8Array.from(atob(base64.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
      const resposta = await fetch('/api/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub) });
      if (!resposta.ok) throw new Error('não foi possível registrar este aparelho');
      await atualizarPush();
      aviso('Alertas do NOC ativados neste aparelho. Toque novamente para desativar.');
    } catch (e) { aviso('Não foi possível ativar os alertas: ' + (e.message || 'verifique a permissão de notificações.')); }
  }

  async function instalar() {
    if (installEvent) {
      installEvent.prompt(); await installEvent.userChoice; installEvent = null; atualizarInstalacao(); return;
    }
    if (isIOS) { aviso('No iPhone/iPad: abra esta tela no Safari, toque em Compartilhar e escolha “Adicionar à Tela de Início”. Depois abra o ícone NOC e ative os alertas.'); return; }
    aviso('No Chrome ou Edge, abra o menu ⋮ e escolha “Instalar app” ou “Adicionar à tela inicial”.');
  }

  function atualizarInstalacao() {
    const btn = document.getElementById('noc-instalar');
    if (!btn) return;
    if (window.matchMedia('(display-mode: standalone)').matches || navigator.standalone) {
      btn.textContent = '📲 NOC instalado'; btn.disabled = true; return;
    }
    btn.textContent = installEvent ? '📲 Instalar NOC' : '📲 Como instalar';
  }

  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvent = e; atualizarInstalacao(); });
  window.addEventListener('appinstalled', atualizarInstalacao);
  window.nocMobileInstalar = instalar;
  window.nocMobilePush = ativarPush;
  document.addEventListener('DOMContentLoaded', () => { atualizarInstalacao(); atualizarPush(); });
})();
