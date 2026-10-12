'use strict';
const assert = require('node:assert/strict');
async function testar({http, DOCS, port, fakeDb}) {
  const RealDate = Date; let agora = RealDate.parse('2026-10-11T15:00:00Z');
  global.Date = class extends RealDate { constructor(...args){super(...(args.length?args:[agora]));} static now(){return agora;} };
  // Emula commit atômico, proíbe leitura após escrita e permite testar a corrida do caixa.
  fakeDb.runTransaction = async fn => {const ops=[];const r=await fn({get:async ref=>{assert.equal(ops.length,0);return ref.get();},set:(ref,d)=>ops.push(()=>ref.set(d)),update:(ref,d)=>ops.push(()=>ref.update(d))});for(const op of ops)await op();return r;};
  const jwt=require('jsonwebtoken'), vf=require('./parqueVendasFuturas'), parque=require('./parque'), fc=require('./saltiversoFechamento');
  const unidade='Saltiverso Patteo', master='a'.repeat(64);
  function usuario(id,cargo,unidades=[unidade],isAdmin=false){DOCS.set('users/'+id,{id,username:id,email:id+'@teste.local',role:'user',active:true,cargo,isAdmin,permissions:{sections:['parque','parque-checkin','parque-loja'],unidades}});return jwt.sign({sub:id,role:'user'},process.env.JWT_SECRET,{expiresIn:'20y'});}
  const gerente=usuario('gerente-vf','gerente'), operador=usuario('operador-vf',null), assistente=usuario('assistente-vf','assistente-gerente'), admin=usuario('admin-vf',null,[unidade],true), externo=usuario('externo-vf','gerente',['OUTRA']);
  async function pedir(path,method='GET',body,auth=gerente){return new Promise((resolve,reject)=>{const raw=body===undefined?'':JSON.stringify(body);const r=http.request({hostname:'127.0.0.1',port,path,method,headers:{Host:'www.nopulso.com.br',Authorization:'Bearer '+auth,'Content-Type':'application/json','Content-Length':Buffer.byteLength(raw)}},res=>{let texto='';res.on('data',c=>texto+=c);res.on('end',()=>{try{resolve({status:res.statusCode,data:JSON.parse(texto)});}catch{resolve({status:res.statusCode,data:texto});}});});r.on('error',reject);r.setTimeout(10000,()=>r.destroy(Error('Timeout')));r.end(raw);});}
  const ok=r=>{assert.equal(r.status,200,JSON.stringify(r));return r.data;};
  const dados={unidade,dataUtilizacao:'2026-10-17',responsavel:{nome:'Responsável teste',contato:'81900000000'},criancas:[{nome:'Criança teste',plano:'normal:60',meia:false}],observacao:'Venda já paga'};
  for(const auth of [operador,assistente,admin]){assert.equal((await pedir('/api/parque/vendas-futuras','GET',undefined,auth)).status,403);assert.equal((await pedir('/api/parque/vendas-futuras/previa','POST',dados,auth)).status,403);}
  assert.equal((await pedir('/api/parque/vendas-futuras/previa','POST',dados,externo)).status,403);
  const p=ok(await pedir('/api/parque/vendas-futuras/previa','POST',dados));assert(p.valor>0);
  assert.equal([...DOCS.keys()].filter(k=>k.startsWith('parqueCheckins/vf_')).length,0,'prévia não grava check-in');
  const body={...dados,forma:'linkPix',valorConfirmado:p.valor,referenciaPagamento:'PROVEDOR PIX 1234',pagamentoConfirmado:true,chaveRequisicao:'teste-chave-00000001'};
  assert.equal((await pedir('/api/parque/vendas-futuras','POST',{...body,pagamentoConfirmado:false})).status,400);
  assert.equal((await pedir('/api/parque/vendas-futuras','POST',{...body,valorConfirmado:p.valor-1})).status,400);
  assert.equal((await pedir('/api/parque/vendas-futuras','POST',{...body,forma:'dinheiro'})).status,400);
  assert.equal((await pedir('/api/parque/checkins','POST',{...dados,pagamentos:[{forma:'pix',valor:p.valor}]} ,operador)).status,400,'rota comum não contorna o gerente');
  const venda=ok(await pedir('/api/parque/vendas-futuras','POST',{...body,dataVenda:'2000-01-01',criadoPorId:'operador-vf',valor:1}));
  assert.equal(venda.dataVenda,'2026-10-11');assert.equal(venda.dataUtilizacao,'2026-10-17');assert.equal(venda.criadoPorId,'gerente-vf');
  assert.equal(venda.impressao,undefined);
  assert.equal(ok(await pedir('/api/parque/vendas-futuras','POST',body)).id,venda.id,'reenvio idempotente');
  assert.equal((await pedir('/api/parque/vendas-futuras','POST',{...body,chaveRequisicao:'outro-envio-0000001'})).status,400,'mesmo comprovante não cria segunda venda');
  assert.equal((await pedir('/api/parque/vendas-futuras','GET',undefined,externo)).data.length,0);
  const resumo=await parque.resumoDoDia(unidade,'2026-10-11');assert.equal(resumo.total,p.valor);assert.equal(resumo.porForma.linkPix,p.valor);
  // Uma segunda instância não invalida nosso cache de agenda; o financeiro lê o dia atual.
  await vf.listar([unidade]);
  DOCS.set('parqueVendasFuturas/externa',{...DOCS.get('parqueVendasFuturas/'+venda.id),id:'externa',valor:7});
  assert.equal((await parque.resumoDoDia(unidade,'2026-10-11')).total,p.valor+7);
  DOCS.delete('parqueVendasFuturas/externa');
  assert.equal((await parque.resumoDoDia(unidade,'2026-10-17')).total,0,'uso não fatura novamente');
  const porOperador=await fc.faturadoPorOperador(unidade,'2026-10-11');assert.equal(porOperador.find(o=>o.operadorId==='gerente-vf').faturado,p.valor);
  assert.equal((await fc.faturadoPorOperador(unidade,'2026-10-17')).length,0,'atendente da visita não recebe receita duplicada');
  const url='/api/parque/checkins/'+venda.id;
  assert.equal((await pedir(url+'/checkin','POST',{},operador)).status,400,'data errada não entra');
  assert.equal((await pedir(url,'PATCH',{dataUtilizacao:'2026-10-11'},operador)).status,400);
  assert.equal((await pedir(url,'DELETE',undefined,master)).status,400,'não apagar recebimento');
  const antes=(await parque.getOne(venda.id));assert.equal(antes.iniciado,false);assert.equal(antes.termoAssinado,false);
  const reagendada=ok(await pedir('/api/parque/vendas-futuras/'+venda.id,'PATCH',{acao:'reagendar',dataUtilizacao:'2026-10-18',motivo:'Cliente pediu nova data',versaoEsperada:venda.atualizadoEm}));
  assert.equal(reagendada.dataVenda,venda.dataVenda);assert.equal(reagendada.valor,venda.valor);assert.equal(reagendada.historico.length,1);
  assert.equal((await pedir('/api/parque/vendas-futuras/'+venda.id,'PATCH',{acao:'reagendar',dataUtilizacao:'2026-10-19',motivo:'Tela antiga',versaoEsperada:venda.atualizadoEm})).status,400);
  const caixaBody={unidade,data:'2026-10-11',declarado:{credito:0,debito:0,voucher:0,pix:0,linkCredito:0,linkDebito:0,linkPix:p.valor,dinheiro:0,outros:0}};
  const originalMovimentos=vf.movimentosDoDia;
  vf.movimentosDoDia=async(...args)=>{const r=await originalMovimentos(...args);const rev=DOCS.get('saltiversoMovimentosDia/'+vf.chaveDia(unidade,'2026-10-11'));rev.versao++;return r;};
  const corrida=await pedir('/api/saltiverso/fechamento/caixa','POST',caixaBody);
  assert.equal(corrida.status,400);assert.match(corrida.data.error,/durante o fechamento/);
  assert.equal([...DOCS.keys()].some(k=>k.startsWith('saltiversoCaixas/')),false,'conflito não grava caixa parcial');
  vf.movimentosDoDia=originalMovimentos;
  const caixa=ok(await pedir('/api/saltiverso/fechamento/caixa','POST',caixaBody));assert.equal(caixa.faturadoOperador,p.valor);
  assert.equal((await pedir('/api/parque/vendas-futuras','POST',{...body,referenciaPagamento:'OUTRO PAGAMENTO 5678',chaveRequisicao:'teste-chave-00000002'})).status,400,'caixa fechado bloqueia nova venda');
  assert.equal([...DOCS.keys()].filter(k=>k.startsWith('parqueCheckins/vf_')).length,1,'falha no caixa não deixa check-in órfão');
  ok(await pedir('/api/saltiverso/fechamento','POST',{unidade,data:'2026-10-11'}));
  assert.equal(ok(await pedir('/api/parque/vendas-futuras','POST',body)).id,venda.id,'reenvio após fechamento recupera original');
  agora=RealDate.parse('2026-10-18T15:00:00Z');
  // Mesmo que um cliente antigo tenha preenchido previsão, não iniciar automaticamente.
  DOCS.get('parqueCheckins/'+venda.id).horarioPrevisto='09:00';
  await parque.rodarAutoCheckins();assert.equal((await parque.getOne(venda.id)).iniciado,false);
  assert.equal((await pedir(url+'/checkin','POST',{},operador)).status,400,'termo necessário');
  ok(await pedir(url,'PATCH',{termoAssinado:true},operador));
  const entrou=ok(await pedir(url+'/checkin','POST',{},operador));assert.equal(entrou.iniciado,true);assert.equal(entrou.autoCheckin,false);assert.equal(entrou.timeInicial,'12:00');assert.equal(entrou.timeFinal,'13:00');
  agora+=5*60000;
  assert.equal(ok(await pedir(url+'/checkin','POST',{},operador)).timeInicial,'12:00','repetição não reinicia relógio');
  assert.equal((await parque.resumoDoDia(unidade,'2026-10-18')).total,0);
  assert.equal((await parque.resumoDoDia(unidade,'2026-10-11')).total,p.valor);
  // Cancelar só impede utilização; não desfaz receita de forma oculta.
  const b2={...body,dataUtilizacao:'2026-10-25',referenciaPagamento:'PIX 9999',chaveRequisicao:'teste-chave-00000009'};
  const v2=ok(await pedir('/api/parque/vendas-futuras','POST',b2));
  assert.equal((await pedir('/api/parque/vendas-futuras/'+v2.id,'PATCH',{acao:'cancelar',motivo:'Pedido do cliente',versaoEsperada:v2.atualizadoEm})).status,400);
  ok(await pedir('/api/parque/vendas-futuras/'+v2.id,'PATCH',{acao:'cancelar',motivo:'Pedido do cliente, devolução separada',versaoEsperada:v2.atualizadoEm},master));
  assert.equal((await parque.resumoDoDia(unidade,'2026-10-18')).total,p.valor);
  assert.equal((await pedir('/api/parque/checkins/'+v2.id+'/checkin','POST',{},operador)).status,400);
  global.Date=RealDate;
  console.log('✓ Vendas futuras: autorização, valor, idempotência, caixa do dia da venda, uso sem duplicar, prazo/termo, reagendamento, cancelamento e relógio único.');
}
module.exports={testar};
if(require.main===module){
  process.env.JWT_SECRET='teste-vendas-futuras';process.env.ENCRYPTION_KEY='11'.repeat(32);
  const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),Module=require('node:module');
  if(process.argv.includes('--sabotagem-financeiro')){const original=Module._extensions['.js'];Module._extensions['.js']=(m,file)=>{if(file!==path.join(__dirname,'parqueVendasFuturas.js'))return original(m,file);const src=fs.readFileSync(file,'utf8');assert(src.includes('v.dataVenda === data'));m._compile(src.replace('v.dataVenda === data','v.dataUtilizacao === data'),file);};}
  const probe=net.createServer();probe.listen(0,'127.0.0.1',()=>{const port=probe.address().port;probe.close(()=>{const file=path.join(__dirname,'testeRotas.js'),src=fs.readFileSync(file,'utf8').split('setTimeout(async () => {')[0].replace(/\b8899\b/g,String(port));const m=new Module(file,module);m.filename=file;m.paths=module.paths;m._compile(src+`\nsetTimeout(()=>require('./testeParqueVendasFuturasHttp').testar({http,DOCS,port:${port},fakeDb}).then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)}),2500);`,file);});});
}
