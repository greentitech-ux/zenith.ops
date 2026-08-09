// sw.js - service worker: recebe push do servidor e mostra a notificacao
// (com som padrao do sistema) mesmo com a aba fechada.

self.addEventListener('push', (event) => {
  let data = { title: 'Zenith Ops', body: 'Novo evento' };
  try {
    data = event.data.json();
  } catch (e) {
    /* usa o padrao acima */
  }
  // alerta critico do Beniboy (bot nao conseguiu resolver sozinho): vibracao
  // bem mais insistente que o padrao, pra chamar atencao mesmo com o celular
  // no bolso - o som alto/continuo de verdade acontece na pagina de alerta,
  // que abre sozinha se tiver uma aba do app em primeiro plano
  const vibrate = data.critical ? [400, 200, 400, 200, 400, 200, 400, 200, 400] : [200, 100, 200];
  event.waitUntil(
    (async () => {
      await self.registration.showNotification(data.title, {
        body: data.body,
        icon: '/icon-192.png',
        badge: '/favicon-32.png',
        tag: data.tag,
        vibrate,
        silent: false,
        renotify: true,
        requireInteraction: true, // fica na tela ate a pessoa interagir, em vez de sumir sozinha em poucos segundos
        // pra onde o clique leva (o servidor manda a tela certa de cada
        // evento: ticket -> Historico da Central, abastecimento -> tela do
        // carrinho, chat -> chats do tecnico, monitor -> Monitor..., alerta
        // critico do Beniboy -> pagina de alarme em tela cheia)
        data: { url: data.url || '/', critical: !!data.critical },
      });
      if (data.critical) {
        // app ja aberto em alguma aba: dispara o alarme sonoro na hora, sem
        // esperar a pessoa clicar na notificacao
        const list = await clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const c of list) c.postMessage({ type: 'beniboy-alerta-critico', url: data.url });
      }
    })()
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  // so caminho relativo dentro do proprio app - nada de URL externa
  let url = (event.notification.data && event.notification.data.url) || '/';
  if (!url.startsWith('/')) url = '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      // 1) ja tem uma aba na tela certa? foca nela
      for (const c of list) {
        const caminho = new URL(c.url).pathname;
        if (caminho === url.split('?')[0] && 'focus' in c) return c.focus();
      }
      // 2) tem alguma aba do app aberta? foca e navega pro conteudo
      for (const c of list) {
        if ('focus' in c && 'navigate' in c) return c.focus().then(() => c.navigate(url));
      }
      // 3) nada aberto: abre uma janela nova direto no conteudo
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
