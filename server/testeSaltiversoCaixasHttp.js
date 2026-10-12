'use strict';
// Servidor/middlewares reais, banco em memória. Nenhuma chamada à produção.
const assert = require('node:assert/strict');
async function testar({http,DOCS,port,fakeDb}) {
  // Escritas só entram no commit; também detecta leitura depois de escrita.
  fakeDb.runTransaction = async fn => {
    const ops=[];
    const out=await fn({get:async ref=>{assert.equal(ops.length,0,'Firestore exige leituras antes das escritas');return ref.get();},update:(ref,data)=>ops.push(()=>ref.update(data)),set:(ref,data)=>ops.push(()=>ref.set(data))});
    for(const op of ops) await op();
    return out;
  };
  const jwt=require('jsonwebtoken'), formas=require('./public/saltiverso-caixa-formas'), modulo=require('./saltiversoFechamento');
  const unidade='Saltiverso Patteo', master='a'.repeat(64);
  const token = (id,unidades=[unidade],cargo=null) => {
    DOCS.set('users/'+id,{id,email:id+'@teste.local',username:id,role:'user',active:true,cargo,permissions:{sections:['parque-loja'],unidades}});
    return jwt.sign({sub:id,role:'user'},process.env.JWT_SECRET,{expiresIn:'1h'});
  };
  const operador=token('operador-caixa'), outro=token('outro-caixa'), externo=token('outra-unidade',['OUTRA']), gerente=token('gerente-caixa',[unidade],'gerente');
  async function pedir(path,method='GET',body,auth=master){
    return new Promise((resolve,reject)=>{
      const dados=body===undefined?'':JSON.stringify(body);
      const req=http.request({hostname:'127.0.0.1',port,path,method,headers:{Host:'www.nopulso.com.br',Authorization:'Bearer '+auth,'Content-Type':'application/json','Content-Length':Buffer.byteLength(dados)}},res=>{
        let raw='';res.on('data',c=>raw+=c);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(raw)}));
      });req.on('error',reject);req.setTimeout(10000,()=>req.destroy(new Error('Timeout')));req.end(dados);
    });
  }
  const ok = r => {assert.equal(r.status,200,JSON.stringify(r));return r.data;};
  const novo={credito:100,debito:50,voucher:20,pix:30,dinheiro:40,pixcnpj:70,outros:0};
  DOCS.set('parqueCheckins/venda-caixa',{id:'venda-caixa',unidade,dataUtilizacao:'2026-10-11',criadoPorId:'operador-caixa',valor:310,pagamentos:[{forma:'credito',valor:100},{forma:'debito',valor:50},{forma:'voucher',valor:20},{forma:'pix',valor:100},{forma:'dinheiro',valor:40}]});
  const criado=ok(await pedir('/api/saltiverso/fechamento/caixa','POST',{unidade,data:'2026-10-11',declarado:novo},operador));
  assert.equal(criado.somaDeclarado,310);assert.deepEqual(criado.declarado,novo);
  assert.equal(criado.faturadoOperador,undefined,'operador não recebe faturado');
  const salvo=await modulo.getCaixa(criado.id);
  assert.equal(salvo.faturadoOperador,310);assert.equal(salvo.faturadoOperadorPorForma.credito,100);assert.equal(salvo.faturadoOperadorPorForma.voucher,20);
  assert.equal(salvo.faturadoOperadorPorForma.pix,100);assert.equal(salvo.faturadoOperadorPorForma.linkPix,0,'não inventar origem do Pix vendido');
  const url='/api/saltiverso/fechamento/caixa/'+criado.id;
  const correcao={declarado:{...novo,dinheiro:45},motivo:'Conferência do comprovante',versaoEsperada:salvo.atualizadoEm};
  assert.equal((await pedir(url,'PUT',correcao,operador)).status,403);
  assert.equal((await pedir(url,'PUT',correcao,gerente)).status,403);
  assert.equal((await pedir(url+'/solicitar-alteracao','POST',correcao,outro)).status,400);
  assert.equal((await pedir(url+'/solicitar-alteracao','POST',correcao,externo)).status,403);
  assert.equal((await pedir(url,'PUT',{...correcao,motivo:''})).status,400);
  assert.equal((await pedir(url,'PUT',{...correcao,declarado:{...novo,pixcnpj:-1}})).status,400);
  const pedido=ok(await pedir(url+'/solicitar-alteracao','POST',correcao,operador));
  assert.equal((await pedir(url+'/solicitar-alteracao','POST',correcao,operador)).status,400,'não duplicar pedido pendente');
  assert.equal((await modulo.getCaixa(criado.id)).somaDeclarado,310,'pedido não altera caixa');
  assert.equal((await pedir('/api/saltiverso/fechamento/alteracoes/'+pedido.id+'/decidir','POST',{aprovado:true},operador)).status,403);
  assert.equal(ok(await pedir('/api/saltiverso/fechamento/alteracoes/'+pedido.id+'/decidir','POST',{aprovado:true})).status,'APROVADO');
  assert.equal((await modulo.getCaixa(criado.id)).somaDeclarado,315);
  assert.equal((await pedir('/api/saltiverso/fechamento/alteracoes/'+pedido.id+'/decidir','POST',{aprovado:true})).status,400);
  assert.equal((await pedir(url,'PUT',correcao)).status,400,'tela desatualizada não sobrescreve correção');
  console.log('✓ Sete formas: totais, faturado, Pix sem origem inventada, permissões, pedido e aprovação.');

  const antigo={id:'caixa-antigo',unidade,data:'2026-10-10',operadorId:'operador-caixa',operadorNome:'Operador',origem:'balcao',declarado:{maquininha:500,dinheiro:20,pix:40,outros:0},somaDeclarado:560,faturadoOperador:1160,faturadoOperadorPorForma:{maquininha:1000,dinheiro:100,pix:60,outros:0},diferencaOperador:-600,resultado:'faltando',historico:[],lancadoEm:'2026-10-10T20:00:00.000Z',atualizadoEm:'2026-10-10T20:00:00.000Z'};
  const diaId='Saltiverso_Patteo__2026-10-10';
  const festa={operadorId:'operador-caixa',origem:'festa',declarado:{maquininha:0,dinheiro:0,pix:200,outros:0},somaDeclarado:200};
  DOCS.set('saltiversoCaixas/'+antigo.id,structuredClone(antigo));
  DOCS.set('saltiversoFechamentos/'+diaId,{id:diaId,unidade,data:antigo.data,totalDeclarado:{maquininha:500,dinheiro:25,pix:240,outros:0},somaTotalDeclarado:765,faturado:1360,diferenca:-595,caixas:[structuredClone(antigo),festa],historico:[]});
  DOCS.set('solicitacoes/quebra-ja-existe',{id:'quebra-ja-existe',tipo:'quebra-caixa',fechamentoId:diaId});
  // Invalida o cache por uma operação normal, depois verifica a leitura.
  await modulo.lancarCaixa({unidade,data:'2026-10-12',operadorId:'outro-caixa',declarado:novo});
  const antes=JSON.stringify(DOCS.get('saltiversoCaixas/'+antigo.id));
  const estado=ok(await pedir('/api/saltiverso/fechamento?unidade='+encodeURIComponent(unidade)+'&data=2026-10-10'));
  assert.equal(estado.caixas[0].declarado.maquininha,500);
  assert.equal(JSON.stringify(DOCS.get('saltiversoCaixas/'+antigo.id)),antes,'ler não migra histórico');
  const reduzido=ok(await pedir('/api/saltiverso/fechamento?unidade='+encodeURIComponent(unidade)+'&data=2026-10-10','GET',undefined,operador));
  assert.equal(reduzido.caixas,undefined);assert.equal(reduzido.faturado,undefined);assert.equal(reduzido.diaFechado,true);
  const urlAntigo='/api/saltiverso/fechamento/caixa/'+antigo.id;
  const pAntigo=ok(await pedir(urlAntigo+'/solicitar-alteracao','POST',{declarado:{...antigo.declarado,maquininha:560},motivo:'Recontagem após o dia fechado'},gerente));
  ok(await pedir('/api/saltiverso/fechamento/alteracoes/'+pAntigo.id+'/decidir','POST',{aprovado:true}));
  let dia=DOCS.get('saltiversoFechamentos/'+diaId), caixa=await modulo.getCaixa(antigo.id);
  assert.equal(caixa.somaDeclarado,620);assert.equal(dia.somaTotalDeclarado,825,'delta preserva ajuste independente de R$5');
  assert.equal(caixa.faturadoOperador,1160);assert.equal(dia.faturado,1360);assert.deepEqual(dia.caixas[1],festa);
  assert.deepEqual(caixa.historico[0].antes,antigo.declarado);assert.equal(caixa.historico[0].depois.maquininha,560);
  const pStale=ok(await pedir(urlAntigo+'/solicitar-alteracao','POST',{declarado:{...caixa.declarado,maquininha:570},motivo:'Pedido anterior'},gerente));
  const direto={declarado:{...caixa.declarado,maquininha:580},motivo:'Master conferiu recibos',versaoEsperada:caixa.atualizadoEm};
  ok(await pedir(urlAntigo,'PUT',direto));
  const diaCorrigido=JSON.stringify(DOCS.get('saltiversoFechamentos/'+diaId));
  assert.equal((await pedir('/api/saltiverso/fechamento/alteracoes/'+pStale.id+'/decidir','POST',{aprovado:true})).status,400);
  assert.equal(JSON.stringify(DOCS.get('saltiversoFechamentos/'+diaId)),diaCorrigido,'pedido obsoleto não altera consolidado');
  ok(await pedir('/api/saltiverso/fechamento/alteracoes/'+pStale.id+'/decidir','POST',{aprovado:false}));
  assert.equal(DOCS.get('saltiversoCaixaEdicoes/'+pStale.id).status,'REJEITADO');
  assert.equal((await pedir(urlAntigo,'PUT',{...direto,versaoEsperada:(await modulo.getCaixa(antigo.id)).atualizadoEm,declarado:novo})).status,400,'não converter caixa histórico silenciosamente');
  console.log('✓ Legado preservado: pedido após consolidar, Master corrige, auditoria, festa intacta e conflito bloqueado.');

  // Dia de transição: ambos os modelos entram na soma, sem perder Maquininha.
  const mistoLegado=await modulo.lancarCaixa({unidade,data:'2026-10-12',operadorId:'legado-cache',declarado:{maquininha:50,dinheiro:10,pix:20,outros:5}});
  const misto=await modulo.fecharDia({unidade,data:'2026-10-12',criadoPorId:'master',criadoPorEmail:'master@teste.local'});
  assert.equal(misto.somaTotalDeclarado,395);assert.equal(misto.totalDeclarado.maquininha,50);assert.equal(misto.totalDeclarado.credito,100);assert.equal(misto.totalDeclarado.pixcnpj,70);
  await modulo.corrigirCaixa(mistoLegado.id,{declarado:{...mistoLegado.declarado,maquininha:55},motivo:'Conferência legado',versaoEsperada:mistoLegado.atualizadoEm},{porId:'master'});
  const mistoAtual=await modulo.getOne(misto.id);
  assert.equal(mistoAtual.somaTotalDeclarado,400);assert.equal(mistoAtual.totalDeclarado.pixcnpj,70);assert.equal(mistoAtual.totalDeclarado.credito,100);
  assert.equal(formas.somar(mistoAtual.totalDeclarado),400);
  const caixaNovoMisto=(await modulo.listCaixasDoDia(unidade,'2026-10-12')).find(c=>c.operadorId==='outro-caixa');
  await modulo.corrigirCaixa(caixaNovoMisto.id,{declarado:{...novo,pixcnpj:80},motivo:'Comprovante CNPJ',versaoEsperada:caixaNovoMisto.atualizadoEm},{porId:'master'});
  const mistoFinal=await modulo.getOne(misto.id);
  assert.equal(mistoFinal.somaTotalDeclarado,410);assert.equal(mistoFinal.totalDeclarado.maquininha,55);assert.equal(mistoFinal.totalDeclarado.pixcnpj,80);
  assert.equal(modulo.comoFechamento(mistoFinal).formasPagamentoExtras.pixcnpj,80,'relatório geral conserva novo campo');
  const grupos=require('./grupos');
  DOCS.set('grupos/grupo-preservado',{id:'grupo-preservado',unidades:[unidade],nome:'Meu nome',formasPagamentoExtras:[{campo:'maquininha',label:'Maquininha histórica'},{campo:'especial',label:'Personalizado'}]});
  // Grupo criado no boot pode existir; exercita a migração no primeiro correspondente.
  for(const [key] of DOCS) if(key.startsWith('grupos/') && key!=='grupos/grupo-preservado') DOCS.delete(key);
  grupos.invalidarCache();await grupos.ensureGrupoSaltiverso();
  const grupo=DOCS.get('grupos/grupo-preservado');
  assert.equal(grupo.nome,'Meu nome');assert.equal(grupo.formasPagamentoExtras[0].label,'Maquininha histórica');
  for(const campo of formas.novos) assert(grupo.formasPagamentoExtras.some(c=>c.campo===campo));
  const gAntes=JSON.stringify(grupo);await grupos.ensureGrupoSaltiverso();assert.equal(JSON.stringify(DOCS.get('grupos/grupo-preservado')),gAntes);
  console.log('✓ Consolidação mista, correção sem perda de valores e configuração aditiva idempotente.');

  const nove={credito:90,debito:40,voucher:20,pix:30,linkCredito:10,linkDebito:10,linkPix:70,dinheiro:40,outros:0};
  const novoOnline=ok(await pedir('/api/saltiverso/fechamento/caixa','POST',{unidade,data:'2026-10-13',declarado:nove,consolidadoDeclarado:{maquininha:1,online:1}},operador));
  const salvoOnline=await modulo.getCaixa(novoOnline.id);
  assert.equal(salvoOnline.modeloFormas,3);
  assert.deepEqual(salvoOnline.declarado,nove);
  assert.deepEqual(salvoOnline.consolidadoDeclarado,{maquininha:180,online:90,dinheiro:40,outros:0,legado:0,ajustes:0,total:310},'consolidado calculado pelo servidor, sem confiar no cliente');
  const diaOnline=await modulo.fecharDia({unidade,data:'2026-10-13',criadoPorId:'master',criadoPorEmail:'master@teste.local'});
  assert.deepEqual(diaOnline.consolidadoDeclarado,salvoOnline.consolidadoDeclarado);
  const pOnline=ok(await pedir('/api/saltiverso/fechamento/caixa/'+novoOnline.id+'/solicitar-alteracao','POST',{declarado:{...nove,linkCredito:15},motivo:'Link conferido'},operador));
  ok(await pedir('/api/saltiverso/fechamento/alteracoes/'+pOnline.id+'/decidir','POST',{aprovado:true}));
  const finalOnline=await modulo.getOne(diaOnline.id);
  assert.equal(finalOnline.consolidadoDeclarado.online,95);assert.equal(finalOnline.consolidadoDeclarado.maquininha,180);assert.equal(finalOnline.somaTotalDeclarado,315);
  assert.equal(finalOnline.totalDeclarado.linkCredito,15);assert.equal(finalOnline.totalDeclarado.maquininha,undefined,'subtotal não duplica modalidades no declarado');
  const antigoConsolidado=formas.consolidar([antigo.declarado]);
  assert.equal(antigoConsolidado.legado,40,'Pix antigo não vira maquininha nem link por suposição');
  assert.equal(formas.consolidar([{...nove,credito:0.1,debito:0.2,voucher:0,pix:0,linkCredito:0,linkDebito:0,linkPix:0,dinheiro:0}]).total,0.3);
  console.log('✓ Maquininha/Online: nove modalidades, quatro subtotais, soma sem duplicar, correção após consolidar e centavos exatos.');
  // Limite exato, contado desde o lançamento, não desde a última edição.
  const agora=Date.now();
  assert.equal(modulo.passou24h({lancadoEm:new Date(agora-86400000+1).toISOString()},agora),false);
  assert.equal(modulo.passou24h({lancadoEm:new Date(agora-86400000).toISOString()},agora),true);
  assert.equal(modulo.passou24h({}),true);
  const antigo24=DOCS.get('saltiversoCaixas/'+antigo.id);antigo24.lancadoEm=new Date(agora-86400001).toISOString();antigo24.atualizadoEm=new Date(agora).toISOString();
  DOCS.set('saltiversoCaixas/'+antigo.id,antigo24);
  assert.equal((await pedir(urlAntigo+'/solicitar-alteracao','POST',{declarado:antigo24.declarado,motivo:'Fora do prazo'},operador)).status,400);
  const assistente=token('assistente-caixa',[unidade],'assistente-gerente');
  assert.equal((await pedir(urlAntigo+'/solicitar-alteracao','POST',{declarado:antigo24.declarado,motivo:'Não é gerente'},assistente)).status,400);
  const gerenteExterno=token('gerente-externo',['OUTRA'],'gerente');
  const detalheUrl='/api/saltiverso/fechamento/historico/'+diaOnline.id;
  const antesDetalhe=JSON.stringify(DOCS.get('saltiversoFechamentos/'+diaOnline.id));
  assert.equal((await pedir(detalheUrl,'GET',undefined,operador)).status,403);
  assert.equal((await pedir(detalheUrl,'GET',undefined,gerenteExterno)).status,403);
  const detalhe=ok(await pedir(detalheUrl,'GET',undefined,gerente));
  assert.deepEqual(detalhe.totalDeclarado,finalOnline.totalDeclarado);
  assert.equal(JSON.stringify(DOCS.get('saltiversoFechamentos/'+diaOnline.id)),antesDetalhe);
  const ajuste={totalDeclarado:{...detalhe.totalDeclarado,linkPix:75},motivo:'Conferência histórica',observacao:'Observação corrigida',versaoEsperada:detalhe.atualizadoEm};
  const editarUrl='/api/saltiverso/fechamento/'+diaOnline.id;
  assert.equal((await pedir(editarUrl,'PUT',ajuste,gerente)).status,403);
  for(const auth of [operador,assistente,gerenteExterno]) assert.equal((await pedir(detalheUrl+'/solicitar-alteracao','POST',ajuste,auth)).status,403);
  const pedHist=ok(await pedir(detalheUrl+'/solicitar-alteracao','POST',ajuste,gerente));
  assert.equal(JSON.stringify(DOCS.get('saltiversoFechamentos/'+diaOnline.id)),antesDetalhe,'solicitar não corrige');
  assert.equal((await pedir(detalheUrl+'/solicitar-alteracao','POST',ajuste,gerente)).status,400);
  const decidirUrl='/api/saltiverso/fechamento/alteracoes/'+pedHist.id+'/decidir';
  assert.equal((await pedir(decidirUrl,'POST',{aprovado:true},gerente)).status,403);
  token('admin-historico');DOCS.get('users/admin-historico').isAdmin=true;
  const admin=jwt.sign({sub:'admin-historico',role:'user'},process.env.JWT_SECRET,{expiresIn:'1h'});
  assert.equal((await pedir(decidirUrl,'POST',{aprovado:true},admin)).status,403);
  ok(await pedir(decidirUrl,'POST',{aprovado:true}));
  const corrigido=ok(await pedir(detalheUrl));
  assert.equal(corrigido.somaTotalDeclarado,320);assert.equal(corrigido.faturado,detalhe.faturado);assert.deepEqual(corrigido.caixas,detalhe.caixas);
  assert.equal(corrigido.historico.at(-1).motivo,ajuste.motivo);assert.equal(corrigido.historico.at(-1).depois.totalDeclarado.linkPix,75);
  assert.equal((await pedir(decidirUrl,'POST',{aprovado:true})).status,400);
  assert.equal((await pedir(editarUrl,'PUT',ajuste)).status,400);
  assert.equal((await pedir(editarUrl,'PUT',{...ajuste,versaoEsperada:corrigido.atualizadoEm,motivo:''})).status,400);
  const pConflito=ok(await pedir(detalheUrl+'/solicitar-alteracao','POST',{...ajuste,versaoEsperada:corrigido.atualizadoEm},gerente));
  ok(await pedir(editarUrl,'PUT',{...ajuste,totalDeclarado:{...corrigido.totalDeclarado,dinheiro:45},versaoEsperada:corrigido.atualizadoEm}));
  assert.equal((await pedir('/api/saltiverso/fechamento/alteracoes/'+pConflito.id+'/decidir','POST',{aprovado:true})).status,400);
  const legHist={id:'historico-sem-hora',unidade,data:'2026-09-10',totalDeclarado:{maquininha:100,dinheiro:20,pix:30,outros:0},somaTotalDeclarado:150,faturado:150,diferenca:0,historico:[]};
  DOCS.set('saltiversoFechamentos/'+legHist.id,structuredClone(legHist));
  const legBody={totalDeclarado:{...legHist.totalDeclarado,dinheiro:25},motivo:'Recibo antigo',versaoEsperada:null};
  const legPedido=ok(await pedir('/api/saltiverso/fechamento/historico/'+legHist.id+'/solicitar-alteracao','POST',legBody,gerente));
  ok(await pedir('/api/saltiverso/fechamento/alteracoes/'+legPedido.id+'/decidir','POST',{aprovado:true}));
  const legCorrigido=await modulo.getOne(legHist.id);
  assert.equal(legCorrigido.somaTotalDeclarado,155);assert.deepEqual(Object.keys(legCorrigido.totalDeclarado),Object.keys(legHist.totalDeclarado));
  assert.deepEqual(legCorrigido.historico[0].antes.totalDeclarado,legHist.totalDeclarado);assert.equal(legCorrigido.consolidadoDeclarado.legado,30);
  assert.equal((await pedir('/api/saltiverso/fechamento/'+legHist.id,'PUT',{...legBody,versaoEsperada:legCorrigido.atualizadoEm,totalDeclarado:nove})).status,400,'não migrar histórico na correção');
  console.log('✓ Histórico: consulta isolada, 24h exatas, gerente da unidade solicita, somente Master corrige/aprova, motivo, auditoria e conflitos.');
}
module.exports={testar};
if(require.main===module){
  process.env.JWT_SECRET='teste-caixas-saltiverso-nao-producao';process.env.ENCRYPTION_KEY='11'.repeat(32);
  const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),Module=require('node:module');
  if(process.argv.includes('--sabotagem-24h')){
    const alvo=path.join(__dirname,'saltiversoFechamento.js');
    const original=Module._extensions['.js'];
    Module._extensions['.js']=(m,file)=>{
      if(file!==alvo)return original(m,file);
      const fonte=fs.readFileSync(file,'utf8'),trecho='if (passou24h(caixa) && !gerenteDaUnidade)';
      assert(fonte.includes(trecho));m._compile(fonte.replace(trecho,'if (false)'),file);
    };
  }
  const probe=net.createServer();probe.listen(0,'127.0.0.1',()=>{const port=probe.address().port;probe.close(()=>{
    const arquivo=path.join(__dirname,'testeRotas.js');
    const fonte=fs.readFileSync(arquivo,'utf8').split('setTimeout(async () => {')[0].replace(/\b8899\b/g,String(port));
    const m=new Module(arquivo,module);m.filename=arquivo;m.paths=module.paths;
    m._compile(fonte+`\nsetTimeout(()=>require('./testeSaltiversoCaixasHttp').testar({http,DOCS,port:${port},fakeDb}).then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)}),2500);`,arquivo);
  });});
}
