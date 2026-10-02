'use strict';
// Executa as ferramentas e a resposta reais, com Monitor/chat/modelo locais.
// --sabotagem libera link sem consulta; --sabotagem-resposta permite URL inventada.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
async function testar(){
  let fonte=fs.readFileSync(path.join(__dirname,'suporteBot.js'),'utf8');
  if(process.argv.includes('--sabotagem')) fonte=fonte.replace("if (nome === 'gerar_link_estorno_cliente') {","if (nome === 'gerar_link_estorno_cliente') { return linkEstornoCliente('A');");
  if(process.argv.includes('--sabotagem-resposta')) fonte=fonte.replace("if(/estorno(?:-|%2d)cliente/i.test(texto) && !resultado.linkEstorno)","if(false)");
  const pedido={pedidoId:'123',unidade:'A',cliente:'Maria Silva',valor:80,statusAtual:'APROVADO',ultimaAtualizacao:'2026-10-02'};
  let pedidos=[pedido],links=0,chat,sequencia=0;
  const respostas=[];
  const suporte={
    getOne:async()=>structuredClone(chat),
    registrarPedidoVerificado:async(id,p)=>{chat.pedidoVerificado=structuredClone(p);},
    adicionarMensagem:async(id,m)=>{chat.mensagens.push({...m,em:'msg-'+(++sequencia)});return structuredClone(chat);},
    desativarBot:async()=>{chat.botDesativado=true;},
  };
  const mocks={'./suporteChat':suporte,'./store':{allOrders:()=>pedidos},'./pedidoWatch':{registrar:async()=>{}},'./users':{list:async()=>[],ehCargoGerente:()=>false},'./agenteAcoes':{obterContexto:async()=>({})},'@anthropic-ai/sdk':class {constructor(){this.messages={create:async()=>{assert(respostas.length,'Modelo local sem resposta preparada');return respostas.shift();}};}}};
  const mod=new Module(path.join(__dirname,'suporteBot.js'),module);mod.filename=path.join(__dirname,'suporteBot.js');mod.paths=module.paths;mod.require=id=>mocks[id]||{};
  mod._compile(fonte+'\nmodule.exports.executarTool=executarTool;',mod.filename);
  const bot=mod.exports;
  const contexto={unidades:['Loja A','Loja B'],unidadesPorCodigo:{A:'Loja A',B:'Loja B'},resolverUnidadesPorIdPulse:c=>[c],resolverUnidadePublica:async t=>({encontrada:{codigo:t==='Loja B'?'B':'A',nome:t},candidatas:[]}),linkEstornoCliente:c=>{links++;return 'https://teste.local/estorno-cliente?unidade='+c;}};
  const novo=texto=>{chat={id:'c',status:'ABERTO',logado:{id:'u',unidades:['A']},unidadeContexto:'A',mensagens:[{de:'visitante',texto,em:'inicio'}]};links=0;};
  const ferramenta=(nome,input={},resultado={})=>bot.executarTool(nome,input,chat,resultado,contexto.resolverUnidadesPorIdPulse,contexto.resolverUnidadePublica,contexto.linkEstornoCliente,contexto.unidadesPorCodigo);
  const chamar=(nome,input)=>({stop_reason:'tool_use',content:[{type:'tool_use',id:'t',name:nome,input}]});
  const texto=t=>({stop_reason:'end_turn',content:[{type:'text',text:t}]});
  const chaveAnterior=process.env.ANTHROPIC_API_KEY;process.env.ANTHROPIC_API_KEY='teste-local-sem-rede';
  try{
    novo('Loja A');await ferramenta('gerar_link_estorno_cliente',{unidade:'Loja A'});assert.equal(links,0,'Saber a loja não libera estorno');
    novo('Quero estorno');await ferramenta('gerar_link_estorno_cliente',{unidade:'Loja A'});assert.equal(links,0,'Pedido de estorno sem Monitor não libera link');
    novo('Status do pedido de Maria Silva, R$80');
    respostas.push(chamar('consultar_pedido',{nomeCliente:'Maria Silva',valor:'80'}),texto('Como posso ajudar com este resultado?'));
    assert(await bot.responderConversa('c',contexto));
    assert(chat.mensagens.at(-1).texto.includes('Status no Monitor: APROVADO'));assert(chat.mensagens.at(-1).texto.includes('Maria Silva'));
    assert(chat.pedidoVerificado?.statusEnviadoEm,'Consulta precisa ser gravada somente após mensagem enviada');
    await ferramenta('gerar_link_estorno_cliente',{unidade:'Loja A'});assert.equal(links,0,'Consulta de status não é pedido de estorno');
    chat.mensagens.push({de:'visitante',texto:'Quero solicitar estorno',em:'nova'});
    await ferramenta('gerar_link_estorno_cliente',{unidade:'Loja B'});assert.equal(links,0,'Não pode trocar a loja verificada');
    const resultado={};const link=await ferramenta('gerar_link_estorno_cliente',{unidade:'Loja A'},resultado);assert(link.includes('/estorno-cliente'));assert.equal(links,1);
    pedidos=[{...pedido,statusAtual:'ESTORNADO'}];await ferramenta('gerar_link_estorno_cliente',{unidade:'Loja A'});assert.equal(links,1,'Status alterado exige nova consulta');pedidos=[pedido];
    await ferramenta('consultar_pedido',{nomeCliente:'Outra pessoa',valor:'80'});assert.equal(chat.pedidoVerificado,null,'Busca sem resultado apaga verificação antiga');
    pedidos=[pedido,{...pedido,pedidoId:'124'}];novo('Quero estorno');
    respostas.push(chamar('consultar_pedido',{nomeCliente:'Maria',valor:'80'}),texto('Há mais de um pedido. Preciso identificar qual é.'));
    await bot.responderConversa('c',contexto);assert.equal(chat.pedidoVerificado,null,'Resultado ambíguo não libera estorno');pedidos=[pedido];
    novo('Quero estorno');chat.logado=null;
    await ferramenta('consultar_pedido',{nomeCliente:'Maria',valor:'80'});assert.equal(chat.pedidoVerificado,null,'Visitante não ganha acesso ao Monitor');
    novo('Quero estorno');const r={};await ferramenta('consultar_pedido',{nomeCliente:'Maria',valor:'80'},r);
    assert(r.consultaPedido);await ferramenta('gerar_link_estorno_cliente',{unidade:'Loja A'});assert.equal(links,0,'Consulta ainda não enviada no chat não libera link');
    pedidos=[{...pedido,valor:1280.80}];const moeda={};await ferramenta('consultar_pedido',{nomeCliente:'Maria',valor:'R$ 1.280,80'},moeda);
    assert.equal(moeda.consultaPedido.valor,1280.80,'Valor com milhar brasileiro precisa ser exato');pedidos=[pedido];
    novo('Loja A');respostas.push(texto('Preencha https://teste.local/estorno-cliente?unidade=A'));
    await bot.responderConversa('c',contexto);assert(!chat.mensagens.at(-1).texto.includes('/estorno-cliente'),'URL inventada precisa ser barrada');
    console.log('✓ Estorno: consulta real por nome/valor, status entregue, intenção explícita, mesma loja, ambiguidade, revogação e URL inventada');
  }finally{if(chaveAnterior===undefined)delete process.env.ANTHROPIC_API_KEY;else process.env.ANTHROPIC_API_KEY=chaveAnterior;}
}
if(require.main===module) testar().catch(e=>{console.error('✗ '+e.message);process.exitCode=1;});
module.exports={testar};
