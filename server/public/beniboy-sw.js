'use strict';
// Registro próprio: não substitui o service worker do NoPulso nem guarda chats.
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('push',e=>{
  let d;try{d=e.data.json();}catch(_){return;}
  if(!d.beniboy) return; // Este atalho recebe apenas alertas de atendimento.
  const url='/atendimento/central'+(d.chatId?'?chat='+encodeURIComponent(d.chatId):'');
  e.waitUntil(self.registration.showNotification(d.title || 'Central Beniboy',{body:d.body || '',icon:'/beniboy-app-192.png',badge:'/beniboy-app-192.png',tag:d.tag || 'beniboy',renotify:true,requireInteraction:!!d.critical,data:{url}}));
});
self.addEventListener('notificationclick',e=>{
  e.notification.close();
  const url=new URL(e.notification.data?.url || '/atendimento/central',self.location.origin);
  if(url.origin!==self.location.origin || !url.pathname.startsWith('/atendimento')) return;
  e.waitUntil((async()=>{
    for(const c of await self.clients.matchAll({type:'window',includeUncontrolled:true})){
      if(new URL(c.url).pathname==='/atendimento/central'){await c.navigate(url.href);return c.focus();}
    }
    return self.clients.openWindow(url.href);
  })());
});
