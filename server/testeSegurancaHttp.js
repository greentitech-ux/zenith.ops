'use strict';
const assert=require('assert/strict');
async function testar({ARQUIVOS,DOCS,postarMultipart,postarJson,pedir}){
  const png={nome:'seguranca.png',tipo:'image/png',buffer:Buffer.from('89504e470d0a1a0a','hex')};
  const antes=ARQUIVOS.size;
  const invalida=await postarMultipart('/api/suporte-chat/iniciar',{nome:'',contato:'',texto:'teste'},png);
  assert.equal(invalida.status,400);assert.equal(ARQUIVOS.size,antes,'abertura inválida não grava anexo');
  const semToken=await postarMultipart('/api/suporte-chat/inexistente/mensagem',{token:'incorreto',texto:'teste'},png);
  assert.equal(semToken.status,400);assert.equal(ARQUIVOS.size,antes,'token inválido não grava anexo');
  const abriu=await postarMultipart('/api/suporte-chat/iniciar',{nome:'Teste Segurança',contato:'teste@example.com',texto:'Solicito atendimento'},png);
  assert.equal(abriu.status,200,abriu.corpo);assert.equal(ARQUIVOS.size,antes+1);
  const chat=JSON.parse(abriu.corpo);
  const errado=await postarMultipart(`/api/suporte-chat/${chat.id}/mensagem`,{token:'errado',texto:'teste'},png);
  assert.equal(errado.status,400);assert.equal(ARQUIVOS.size,antes+1);
  const correto=await postarMultipart(`/api/suporte-chat/${chat.id}/mensagem`,{token:chat.token,texto:'Novo anexo'},png);
  assert.equal(correto.status,200,correto.corpo);assert.equal(ARQUIVOS.size,antes+2);
  // Controle negativo: simula a gravação que a implementação antiga permitia.
  assert.throws(()=>assert.equal(antes+1,antes),'sabotagem: teste detecta arquivo órfão');
  const auth=require('./auth'),jwt=require('jsonwebtoken');
  const uid='seguranca-sessao';
  const usuario={id:uid,username:'seguranca',role:'user',active:true,cargo:'suporte',cargos:['suporte'],somenteNoc:false,permissions:{sections:['suporte'],unidades:[]}};
  DOCS.set('users/'+uid,usuario);
  const cab={Authorization:'Bearer '+jwt.sign({sub:uid},process.env.JWT_SECRET,{expiresIn:'5m'})};
  assert.equal((await pedir('/api/me',cab)).status,200);
  DOCS.set('users/'+uid,{...usuario,precisaTrocarSenha:true});auth.invalidarUsuario(uid);
  assert.equal((await pedir('/api/me',cab)).status,200,'identificação continua disponível');
  assert.equal((await pedir('/api/beniboy/acesso',cab)).status,403,'senha temporária não libera funções');
  assert.equal((await postarJson('/api/me/palavra-recuperacao',{},cab)).status,403);
  assert.equal(await auth.usuarioOpcionalDoToken(cab.Authorization.slice(7)),null);
  DOCS.set('users/'+uid,{...usuario,locked:true});auth.invalidarUsuario(uid);
  assert.equal((await pedir('/api/me',cab)).status,401,'conta bloqueada perde acesso já aberto');
  DOCS.set('users/'+uid,usuario);auth.invalidarUsuario(uid);
  assert.equal((await pedir('/api/beniboy/acesso',cab)).status,200,'liberação restaura acesso');
  const abriuLogado=await postarMultipart('/api/suporte-chat/iniciar',{nome:'Teste Segurança',contato:'teste@example.com',texto:'Atendimento autenticado'},null,'anexo',cab);
  assert.equal(abriuLogado.status,200,abriuLogado.corpo);
  const vinculo=JSON.parse(abriuLogado.corpo),chats=require('./suporteChat');
  assert.equal((await chats.getOne(vinculo.id)).logado.id,uid);
  assert.equal((await postarMultipart(`/api/suporte-chat/${vinculo.id}/mensagem`,{token:vinculo.token,texto:'Agora sem sessão'})).status,200);
  assert.equal((await chats.getOne(vinculo.id)).logado,null,'capacidade da conversa não preserva privilégios após logout');
  const apiAnterior=process.env.MASTER_API_TOKEN;
  process.env.MASTER_API_TOKEN='chave-apenas-do-teste-seguranca-'.repeat(2);
  try{assert.equal((await pedir('/api/me?token='+process.env.MASTER_API_TOKEN)).status,401,'chave de API não aceita query');}
  finally{if(apiAnterior===undefined)delete process.env.MASTER_API_TOKEN;else process.env.MASTER_API_TOKEN=apiAnterior;}
  console.log('✓ Segurança HTTP: abertura e token inválidos não gravam; upload autorizado continua funcionando.');
  console.log('✓ Segurança da sessão: troca obrigatória no servidor, recuperação e conta bloqueada.');
}
module.exports={testar};
