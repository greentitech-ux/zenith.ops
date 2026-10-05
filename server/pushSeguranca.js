'use strict';
const crypto=require('crypto');
// Lista de provedores, não lista de IPs: impede destinos internos e DNS de terceiros.
function endpointSeguro(endpoint){
  if(typeof endpoint!=='string'||endpoint.length>2048) throw new Error('Inscrição push inválida.');
  let u;try{u=new URL(endpoint);}catch(e){throw new Error('Inscrição push inválida.');}
  const host=u.hostname.toLowerCase();
  const permitido=['fcm.googleapis.com','updates.push.services.mozilla.com','web.push.apple.com'].includes(host)
    || /^[a-z0-9-]+\.notify\.windows\.com$/.test(host);
  if(u.protocol!=='https:'||u.username||u.password||u.hash||u.port||!permitido) throw new Error('Provedor de notificações não permitido.');
  return u.href;
}
function chaveBytes(chave,tamanho){
  if(typeof chave!=='string'||! /^[A-Za-z0-9_-]+={0,2}$/.test(chave)) return null;
  const bytes=Buffer.from(chave,'base64url');
  return bytes.length===tamanho?bytes:null;
}
function validarSubscricao(sub){
  if(!sub || typeof sub!=='object') throw new Error('Inscrição push inválida.');
  const endpoint=endpointSeguro(sub.endpoint),publica=chaveBytes(sub.keys?.p256dh,65),segredo=chaveBytes(sub.keys?.auth,16);
  if(!publica||publica[0]!==4||!segredo) throw new Error('Chaves de notificações inválidas.');
  return {endpoint,keys:{p256dh:publica.toString('base64url'),auth:segredo.toString('base64url')}};
}
function provaDePosse(esperada,enviada){
  const a=chaveBytes(esperada,16),b=chaveBytes(enviada,16);
  return !!a && !!b && crypto.timingSafeEqual(a,b);
}
function idSubscricao(endpoint){return 'p_'+crypto.createHash('sha256').update(endpoint).digest('hex');}
module.exports={endpointSeguro,validarSubscricao,provaDePosse,idSubscricao};
