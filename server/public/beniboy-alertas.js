'use strict';
(function(){
  let registro;
  const aviso=t=>{const e=document.getElementById('beniboy-alertas-aviso');if(e)e.textContent=t;};
  async function preparar(){
    if(!('serviceWorker' in navigator)) throw new Error('Este navegador não oferece alertas em segundo plano.');
    registro=await navigator.serviceWorker.register('/atendimento/sw.js',{scope:'/atendimento/'});
    return registro;
  }
  async function registrar(sub){
    const r=await fetch('/api/push/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...sub.toJSON(),appBeniboy:true})});
    if(!r.ok) throw new Error('Não foi possível habilitar os alertas para seu acesso.');
  }
  window.ativarAlertasBeniboy=async function(){
    try {
      if(!('Notification' in window) || !('PushManager' in window)) throw new Error('Use um navegador com notificações web.');
      const permissao=await Notification.requestPermission();
      if(permissao!=='granted') throw new Error('Permita as notificações deste site nas configurações do navegador.');
      const reg=await preparar();
      const worker=reg.active || reg.installing || reg.waiting;
      if(!reg.active && worker?.state!=='activated') await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Reabra a Central e tente ativar os alertas novamente.')),10000);worker.addEventListener('statechange',()=>{if(worker.state==='activated'){clearTimeout(timer);resolve();}});});
      let sub=await reg.pushManager.getSubscription();
      if(!sub){
        const r=await fetch('/api/push/vapid-public-key'),d=await r.json();
        if(!r.ok || !d.publicKey) throw new Error('O servidor ainda não tem notificações push configuradas.');
        const chave=d.publicKey.replace(/-/g,'+').replace(/_/g,'/');
        sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:Uint8Array.from(atob(chave+'='.repeat((4-chave.length%4)%4)),c=>c.charCodeAt(0))});
      }
      await registrar(sub);aviso('Alertas da Central ativados neste aparelho.');
    }catch(e){aviso(e.message);}
  };
  window.prepararAlertasBeniboy=async function(){
    try {const reg=await preparar();if('Notification' in window && Notification.permission==='granted'){const sub=await reg.pushManager.getSubscription();if(sub) await registrar(sub);}}
    catch(e){/* Não impede atender quando push está indisponível. */}
  };
})();
