// NOC Mobile: a tela continua sendo web (e segura), mas quando instalada vira
// um app independente que abre direto no NOC. Nunca reporta "online/offline"
// de uma loja: celulares entram em repouso e não podem ser agente de rede.
(() => {
  let installEvent = null;
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const aviso = texto => window.alert(texto);

  // Uma assinatura existir no Chrome não prova que ela ainda está cadastrada
  // no servidor com o usuário/permissões atuais. O caso típico é o app ficar
  // semanas instalado, o endpoint mudar ou a permissão de Suporte ser dada
  // depois: o botão dizia "ativo", mas o push do Beniboy não tinha destino.
  // Sempre que o NOC abre ou volta ao primeiro plano, regravamos a MESMA
  // assinatura no servidor. Não pede permissão, não cria outra assinatura e
  // não altera o aparelho; apenas restaura a rota de entrega.
  async function sincronizarAssinatura(reg, sub) {
    const resposta = await fetch('/api/push/subscribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub),
    });
    if (!resposta.ok) throw new Error('o servidor não confirmou este aparelho');
  }

  async function testarPush() {
    const resposta = await fetch('/api/push/testar', { method: 'POST' });
    const resultado = await resposta.json().catch(() => ({}));
    if (!resposta.ok) throw new Error(resultado.error || 'não foi possível testar o alerta');
    if (resultado.configurado === false) throw new Error('as chaves de alerta do servidor ainda não foram configuradas');
    if (!resultado.dispositivos) throw new Error('este aparelho não ficou registrado no servidor');
    return resultado;
  }

  async function atualizarPush({ sincronizar = true } = {}) {
    const btn = document.getElementById('noc-push');
    if (!btn || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      const sub = await reg.pushManager.getSubscription();
      if (sub && Notification.permission === 'granted' && sincronizar) await sincronizarAssinatura(reg, sub);
      const ativo = !!sub && Notification.permission === 'granted';
      btn.textContent = ativo ? '🔔 Alertas ativos · testar' : '🔔 Ativar alertas';
      btn.classList.toggle('ativo', ativo);
    } catch (_) { btn.textContent = '⚠️ Reativar alertas'; btn.classList.remove('ativo'); }
  }

  async function ativarPush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      aviso('Este navegador não oferece alertas push. Abra pelo Chrome, Edge ou pelo app NOC instalado.'); return;
    }
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      const atual = await reg.pushManager.getSubscription();
      // "Alertas ativos" não desliga ao tocar. Esse era um botão perigoso no
      // celular: quem queria conferir/ativar podia cancelar a inscrição sem
      // perceber. Quando já há inscrição, reconfirma no servidor e dispara
      // uma prova real, inclusive com a tela bloqueada.
      if (atual && Notification.permission === 'granted') {
        await sincronizarAssinatura(reg, atual);
        const teste = await testarPush();
        await atualizarPush({ sincronizar: false });
        aviso(`Alerta de teste enviado para ${teste.dispositivos} aparelho(s). Bloqueie a tela agora: ele deve aparecer na notificação do sistema.`);
        return;
      }
      const permissao = await Notification.requestPermission();
      if (permissao !== 'granted') throw new Error('a permissão de notificações não foi concedida');
      const chave = await fetch('/api/push/vapid-public-key').then(r => r.json()).then(d => d.publicKey);
      if (!chave) throw new Error('chave de alerta indisponível');
      const base64 = chave + '='.repeat((4 - chave.length % 4) % 4);
      const bytes = Uint8Array.from(atob(base64.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
      await sincronizarAssinatura(reg, sub);
      const teste = await testarPush();
      await atualizarPush({ sincronizar: false });
      aviso(`Alertas ativados e teste enviado para ${teste.dispositivos} aparelho(s). Se não aparecer com a tela bloqueada, libere as notificações e a bateria do Chrome/NoPulso nas configurações do Android.`);
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
  // O Android pode renovar o endpoint enquanto o app está em segundo plano.
  // Ao destravar e voltar ao NOC, confirma-o antes de qualquer novo alerta.
  window.addEventListener('pageshow', () => atualizarPush());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) atualizarPush(); });
  window.addEventListener('online', () => atualizarPush());
})();
