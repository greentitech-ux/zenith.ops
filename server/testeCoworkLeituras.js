'use strict';
const assert=require('node:assert/strict');
async function testar({DOCS,port}) {
  const api=require('./coworkApi'),l=require('./coworkLeituras'),catalogo=require('./coworkCatalogo');
  const originalEnv={master:process.env.NOPULSO_AGENT_MASTER,token:process.env.NOPULSO_AGENT_API_TOKEN};
  const master=(await require('./users').list()).find(u=>u.role==='master');
  process.env.NOPULSO_AGENT_MASTER=master.email;process.env.NOPULSO_AGENT_API_TOKEN='leitura-test-local';
  const nomes={'Dominos Bessa':'DOMINOS BESSA','Saltiverso Patteo':'SALTIVERSO PATTEO',Outra:'Outra'};
  catalogo.configurar({nomes:async()=>nomes,apelidos:{Bessa:'DOMINOS BESSA',Saltiverso:'SALTIVERSO PATTEO'}});
  const call=async(nome,entrada={},token='leitura-test-local')=>{
    const r=await fetch(`http://127.0.0.1:${port}/api/agent/execute`,{method:'POST',headers:{'Content-Type':'application/json','x-agent-token':token},body:JSON.stringify({action:nome,input:entrada})});
    return {status:r.status,body:await r.json()};
  };
  const ok=async(n,p)=>{const r=await call(n,p);assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.body.tempoReal,false);return r.body.resultado;};
  try {
    for(const t of api.ferramentasMcp().filter(t=>l.ferramentas[t.name])){
      assert.equal(t.annotations.readOnlyHint,true);assert.equal(t.inputSchema.additionalProperties,false);
      assert(!t.inputSchema.required.includes('idempotencyKey'));
    }
    assert.equal((await call('listar_fechamentos',{},'errado')).status,401);
    assert.equal((await call('listar_fechamentos',{limite:101})).status,400);
    assert.equal((await call('listar_fechamentos',{pagina:0})).status,400);
    assert.equal((await call('listar_fechamentos',{desde:'2030-02-30'})).status,400);
    assert.equal((await call('listar_fechamentos',{desde:'2030-01-01',ate:'2029-01-01'})).status,400);
    assert.equal((await call('listar_fechamentos',{comando:'qualquer'})).status,400);
    assert.equal((await call('obter_fechamento',{unidade:'Bessa',desde:'2030-01-08'})).status,400,'consulta diária exige data, não ignora período');
    assert.equal(l.janela({},new Date()).inicio.length,10);
    DOCS.set('fechamentosLive/leitura-1',{id:'leitura-1',unidade:'Dominos Bessa',unidadeNome:'DOMINOS BESSA',data:'2030-01-08',faturamento:100,totalDeclarado:99,diferenca:-1,pix:20,adyen:30,ifood:40,criadoPorEmail:'privado@example.com',observacao:'CPF 123.456.789-00 contato privado@example.com',segredo:'NAO_VAZAR'});
    DOCS.set('fechamentosLive/leitura-2',{id:'leitura-2',unidade:'Outra',data:'2030-01-08',faturamento:123});
    require('./fechamentosLive').invalidarCache?.();
    const f=await ok('obter_fechamento',{unidade:'Bessa',data:'2030-01-08'});
    assert.equal(f.total,1);assert.equal(f.itens[0].totais.faturamento,100);assert.equal(f.itens[0].totais.liquido,null);
    assert.equal(f.itens[0].formasPagamento.find(x=>x.nome==='Adyen').valor,20);
    assert.equal(f.itens[0].formasPagamento.find(x=>x.nome==='Maquininhas (total)').valor,30);
    assert(!JSON.stringify(f).includes('NAO_VAZAR'));assert(!JSON.stringify(f).includes('privado@example.com'));assert(!JSON.stringify(f).includes('123.456.789-00'));
    const pagina=await ok('listar_fechamentos',{desde:'2030-01-08',ate:'2030-01-08',limite:1,pagina:1});
    assert.equal(pagina.total,2);assert.equal(pagina.itens.length,1);assert.equal(pagina.proximaPagina,2);
    assert.equal((await ok('obter_fechamento',{unidade:'Bessa',data:'2030-01-09'})).encontrado,false);
    const resp={nome:'Responsavel Completo',cpf:'12345678900',contato:'11999999999',endereco:'SEGREDO_ENDERECO'};
    const crianca={nome:'Ana Teste',dataNascimento:'2020-01-01',tempoMinutos:30};
    const base={unidade:'Saltiverso Patteo',responsavel:resp,criancas:[crianca],tempoMinutos:30,iniciado:true,usou:true,timeInicial:'10:00',valor:0,pagamentos:[]};
    for(const v of [
      {...base,id:'p-antigo',dataUtilizacao:'2030-01-01'},
      {...base,id:'p-hoje',dataUtilizacao:'2030-01-08',valor:40,pagamentos:[{forma:'pix',valor:40}]},
      {...base,id:'p-novo',dataUtilizacao:'2030-01-08',criancas:[{...crianca,nome:'Nova Pessoa'}],vendaFuturaId:'vf-ontem',pagamentos:[{forma:'linkPix',valor:50}]},
      {...base,id:'p-semidentidade',dataUtilizacao:'2030-01-08',criancas:[{nome:'Sem nascimento'}]},
      {...base,id:'p-agendado',dataUtilizacao:'2030-01-08',iniciado:false,valor:50},
      {...base,id:'p-outra',unidade:'Outra',dataUtilizacao:'2030-01-08'},
    ]) DOCS.set('parqueCheckins/'+v.id,v);
    DOCS.set('parqueVendasFuturas/vf-hoje',{id:'vf-hoje',unidade:'Saltiverso Patteo',dataVenda:'2030-01-08',dataUtilizacao:'2030-01-20',forma:'linkCredito',valor:70});
    DOCS.set('parqueVendasFuturas/vf-ontem',{id:'vf-ontem',unidade:'Saltiverso Patteo',dataVenda:'2030-01-07',dataUtilizacao:'2030-01-08',forma:'linkPix',valor:50});
    require('./parque').invalidar();
    const a=await ok('consultar_acessos_parque',{unidade:'Saltiverso',desde:'2030-01-08',limite:1});
    assert.equal(a.acessos,3);assert.equal(a.primeiraNaBase,1);assert.equal(a.recorrentesNaBase,1);assert.equal(a.identidadeInsuficiente,1);
    assert.equal(a.semanaAnterior.acessos,1);assert.equal(a.financeiro.total,160);assert.equal(a.financeiro.totalDiscriminado,110);assert.equal(a.financeiro.diferencaDiscriminacao,50);assert.equal(a.itens.length,1);assert.equal(a.proximaPagina,2);
    assert.equal(a.cobertura.historicoExternoCompleto,false);
    assert(!JSON.stringify(a).includes(resp.cpf));assert(!JSON.stringify(a).includes(crianca.nome));assert(!JSON.stringify(a).includes('SEGREDO_ENDERECO'));
    const cliente=await ok('obter_cliente_parque',{unidade:'Saltiverso',documento:resp.cpf,limite:2});
    assert.equal(cliente.total,5);assert.equal(cliente.itens.length,2);assert(!JSON.stringify(cliente).includes(resp.cpf));
    assert.equal((await call('obter_cliente_parque',{unidade:'Saltiverso',nome:'Ana',telefone:resp.contato})).status,400);
    const agregador=require('./pedidosAgregadorCowork');
    const dados=[{id:'a',numeroPedido:'0001',unidade:'pizza',unidadeCodigo:'Dominos Bessa',unidadeNome:'Pizza',dataHora:'2030-01-08T03:00:00Z',valorBruto:10,valorLiquido:8,status:'CANCELLED'},
      {id:'b',numeroPedido:'0002',unidade:'sanduiche',unidadeCodigo:'Dominos Bessa',unidadeNome:'Sanduiche',dataHora:'2030-01-08T04:00:00Z',valorBruto:20}];
    const agg=await agregador.buscar({canal:'IFOOD',unidade:'Bessa',desde:'2030-01-08',limite:1,pagina:2},{listAllCached:async()=>dados});
    assert.equal(agg.total,2);assert.equal(agg.resumo.valorBrutoConhecido,30);assert.equal(agg.resumo.cancelados,1);assert.equal(agg.pedidos.length,1);assert.equal(agg.resumo.porMerchant.length,2);
    assert.equal((await agregador.buscar({canal:'IFOOD',unidade:'Bessa'},{listAllCached:async()=>[]})).disponivel,false);
    const diagnostico=require('./diagnosticoCompleto'),noc=require('./lojaStatus');
    assert(diagnostico.comando.includes('-Timeout 120'));assert(!diagnostico.comando.includes('notepad'));
    const bruto={versaoScript:'1.0-nopulso',geradoEm:'2030-01-08T12:00:00Z',admin:true,resumo:{cpu:'CPU Teste',ramGB:8,segredo:'NAO_VAZAR'},alertas:['email privado@example.com']};
    assert.equal(diagnostico.extrair('invalido'),null);assert(!JSON.stringify(diagnostico.extrair('NOC_DIAGNOSTICO_JSON:'+JSON.stringify(bruto))).includes('NAO_VAZAR'));
    const pc=await noc.cadastrarComputador('Dominos Bessa','PC TESTE','interno');
    const registro=DOCS.get('lojaStatus/Dominos Bessa__'+pc.posto);
    const antes=[...DOCS.keys()].filter(k=>k.startsWith('lojaStatusComandos/')).length;
    const pedido=await api.executar({nome:'executar_noc',entrada:{tarefa:'diagnostico-completo',alvos:[{codigo:pc.codigo,posto:pc.posto}]},idempotencyKey:'diagnostico-teste-1'});
    assert.equal(pedido.pendente,true);assert.equal([...DOCS.keys()].filter(k=>k.startsWith('lojaStatusComandos/')).length,antes,'não enfileira antes da aprovação');
    // Exercita retorno autenticado usando fila local simulada, sem executar PowerShell.
    const cmd=await noc.enfileirarComando(pc.codigo,pc.posto,diagnostico.comando,{origem:'manutencao-diagnostico-completo',requerAdmin:true});
    DOCS.get('lojaStatusComandos/'+cmd.id).status='entregue';
    await assert.rejects(noc.marcarComandoExecutado(cmd.id,{resultado:'NOC_DIAGNOSTICO_JSON:'+JSON.stringify(bruto)},{codigo:pc.codigo,posto:pc.posto,token:'errado'}),/Token/);
    await noc.marcarComandoExecutado(cmd.id,{resultado:'NOC_DIAGNOSTICO_JSON:'+JSON.stringify(bruto)},{codigo:pc.codigo,posto:pc.posto,token:registro.agentToken});
    assert(!DOCS.get('lojaStatusComandos/'+cmd.id).resultado.includes('CPU Teste'),'histórico não duplica relatório');
    const d=await ok('obter_diagnostico',{codigo:'Bessa',posto:pc.posto});
    assert.equal(d.diagnosticoCompleto.resumo.ramGB,8);assert(!JSON.stringify(d).includes(registro.agentToken));
    assert(!JSON.stringify(d).includes('privado@example.com'));
    const tardio=await noc.enfileirarComando(pc.codigo,pc.posto,diagnostico.comando,{origem:'manutencao-diagnostico-completo',requerAdmin:true});
    Object.assign(DOCS.get('lojaStatusComandos/'+tardio.id),{status:'cancelado',desistidoSemRetorno:true});
    await assert.rejects(noc.marcarComandoExecutado(tardio.id,{resultado:'NAO_VAZAR'},{codigo:pc.codigo,posto:pc.posto,token:'errado'}),/Token/);
    await noc.marcarComandoExecutado(tardio.id,{resultado:'NAO_VAZAR'},{codigo:pc.codigo,posto:pc.posto,token:registro.agentToken});
    assert(!DOCS.get('lojaStatusComandos/'+tardio.id).resultado.includes('NAO_VAZAR'));
    const listarNoc=noc.listar;
    try {
      noc.listar=async()=>[{codigo:pc.codigo,posto:pc.posto,diagnostico:{...bruto,segredo:'NAO_VAZAR'}}];
      assert(!JSON.stringify(await ok('obter_diagnostico',{codigo:'Bessa',posto:pc.posto})).includes('NAO_VAZAR'),'leitura também filtra campos persistidos');
    } finally {noc.listar=listarNoc;}
    const resumo=await ok('resumo_unidade',{unidade:'Bessa',data:'2030-01-08'});
    assert.equal(resumo.fechamento.total,1);assert.equal(resumo.anyfood.disponivel,false);assert.equal(resumo.pulse.disponivel,false);
    DOCS.get('users/'+master.id).active=false;
    assert.equal((await call('listar_fechamentos',{})).status,400,'Master inativo não lê');
    console.log('✓ Cowork leituras HTTP: autenticação, schemas, aliases, períodos, paginação, dinheiro/visita, privacidade, iFood retido e diagnóstico autenticado com aprovação.');
  } finally {
    DOCS.get('users/'+master.id).active=true;
    if(originalEnv.master==null)delete process.env.NOPULSO_AGENT_MASTER;else process.env.NOPULSO_AGENT_MASTER=originalEnv.master;
    if(originalEnv.token==null)delete process.env.NOPULSO_AGENT_API_TOKEN;else process.env.NOPULSO_AGENT_API_TOKEN=originalEnv.token;
  }
}
module.exports={testar};
if(require.main===module){
  process.env.JWT_SECRET='teste-leituras';process.env.ENCRYPTION_KEY='11'.repeat(32);
  const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),Module=require('node:module');
  if(process.argv.includes('--sabotagem')){const orig=Module._extensions['.js'];Module._extensions['.js']=(m,file)=>{
    if(file!==path.join(__dirname,'coworkLeituras.js'))return orig(m,file);
    m._compile(fs.readFileSync(file,'utf8').replace("pix:'Adyen',ifood:","adyen:'Adyen',ifood:"),file);
  };}
  const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>{
    const file=path.join(__dirname,'testeRotas.js'),src=fs.readFileSync(file,'utf8').split('setTimeout(async () => {')[0].replace(/\b8899\b/g,String(port));
    const m=new Module(file,module);m.filename=file;m.paths=module.paths;
    m._compile(src+`\nsetTimeout(()=>require('./testeCoworkLeituras').testar({DOCS,port:${port}}).then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)}),2500);`,file);
  });});
}
