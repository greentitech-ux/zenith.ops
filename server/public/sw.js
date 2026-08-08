// sw.js - service worker: recebe push do servidor e mostra a notificacao
// (com som padrao do sistema) mesmo com a aba fechada.

self.addEventListener('push', (event) => {
  let data = { title: 'Zenith Ops', body: 'Novo evento' };
  try {
    data = event.data.json();
  } catch (e) {
    /* usa o padrao acima */
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
      badge: '/favicon-32.png',
      tag: data.tag,
      vibrate: [200, 100, 200],
      silent: false,
      renotify: true,
      requireInteraction: true, // fica na tela ate a pessoa interagir, em vez de sumir sozinha em poucos segundos
      // pra onde o clique leva (o servidor manda a tela certa de cada
      // evento: ticket -> Historico da Central, abastecimento -> tela do
      // carrinho, chat -> chats do tecnico, monitor -> Monitor...)
      data: { url: data.url || '/' },
    })
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
