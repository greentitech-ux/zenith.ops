const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');

async function testar(sabotar = false) {
  const docs = new Map(); let id = 0;
  const ref = (n, k) => ({ id: k,
    get: async () => ({ exists: docs.has(n+'/'+k), data: () => structuredClone(docs.get(n+'/'+k)) }),
    set: async v => docs.set(n+'/'+k, structuredClone(v)),
    update: async v => docs.set(n+'/'+k, {...docs.get(n+'/'+k), ...structuredClone(v)}),
  });
  function consulta(n, filtros = []) {
    return { doc: k => ref(n,k || String(++id)), orderBy: () => consulta(n,filtros),
      where: (campo, _op, valor) => consulta(n,[...filtros,[campo,valor]]),
      get: async () => {
        const lista=[...docs].filter(([k,v])=>k.startsWith(n+'/') && filtros.every(([c,x])=>v[c]===x));
        return {empty:!lista.length,docs:lista.map(([,v])=>({data:()=>structuredClone(v)}))};
      },
    };
  }
  const db = { collection: consulta, runTransaction: fn => fn({get:r=>r.get(),set:(r,v)=>r.set(v),update:(r,v)=>r.update(v)}) };
  const arquivo=path.join(__dirname,'entregasLive.js'), m=new Module(arquivo,module);
  m.filename=arquivo; m.paths=module.paths;
  m.require=k=>k==='./firestore'?db:['./storage','./entregasRegras','./entregadoresEntregas'].includes(k)?{}:require(k);
  let fonte=fs.readFileSync(arquivo,'utf8');
  if(sabotar) fonte=fonte.replace("const situacao = situacaoAcao(tipoAcao);", "const situacao = 'ATIVO';");
  m._compile(fonte,arquivo); const live=m.exports;
  const novo=k=>docs.set('entregasLive/'+k,{id:k,unidade:'Teste',data:'2026-10-02',entregador:'Pedro Silva',entrega:2,valor:16});
  novo('a'); novo('b'); novo('c');
  const pedir=(k,tipo)=>live.solicitarAcao({entregaId:k,tipoAcao:tipo,motivo:'Duplicado',solicitadoPorId:'loja',solicitadoPorEmail:'loja@teste'});
  const decidir=(p,status)=>live.decidirEdicao(p.id,status,{decididoPorEmail:'master@teste'});
  const p=await pedir('a','cancelar');
  assert.equal((await live.getOne('a')).situacao,undefined,'Pedir não altera o lançamento');
  await assert.rejects(pedir('a','excluir'),/pendente/);
  await decidir(p,'REJEITADO'); assert.equal((await live.listAll()).length,3);
  const p2=await pedir('a','excluir'); await decidir(p2,'APROVADO');
  const a=await live.getOne('a'); assert.equal(a.situacao,'EXCLUIDO'); assert.equal(a.valor,16);
  assert.equal(a.historico[0].por,'master@teste'); assert.equal(a.historico[0].pedidoId,p2.id);
  assert.equal((await live.listAll()).length,2); assert.equal((await live.listarComHistorico()).length,3);
  assert.equal((await live.listByUnidades(['Teste'])).length,2);
  await assert.rejects(decidir(p2,'APROVADO'),/decidido/);
  await assert.rejects(live.editarDireto({entregaId:'a',mudancas:{entrega:3}}),/excluído/);
  await assert.rejects(live.solicitarEdicao({entregaId:'a',mudancas:{entrega:3},motivo:'Erro'}),/excluído/);
  await assert.rejects(pedir('b','forjada'),/inválida/);
  await assert.rejects(live.acaoDireta({entregaId:'b',tipoAcao:'cancelar'}),/motivo/);
  await live.acaoDireta({entregaId:'b',tipoAcao:'cancelar',motivo:'Erro',editadoPorEmail:'master@teste'});
  assert.equal((await live.getOne('b')).situacao,'CANCELADO'); assert.equal((await live.listAll()).length,1);
  const pendente=await pedir('c','cancelar');
  await live.acaoDireta({entregaId:'c',tipoAcao:'excluir',motivo:'Duplicado',editadoPorEmail:'master@teste'});
  await assert.rejects(decidir(pendente,'APROVADO'),/Rejeite/);
  assert.equal(docs.get('entregaEdicoes/'+pendente.id).status,'PENDENTE','Falha não deve aprovar o pedido');
  await decidir(pendente,'REJEITADO');
  const html=fs.readFileSync(path.join(__dirname,'public/entrega-lancamento.html'),'utf8');
  const render=html.match(/function renderLista\(\)\{[\s\S]*?\n\}/)[0];
  const el={};
  const rodar=new Function('document','MEUS','IS_MASTER','edicaoPendente','ultimaDecisao','escapeHtml','fmtData','fmtMoney','FUSO_BR','AUTH_TOKEN','MOTIVOS_REMOCAO_LABEL',render+';renderLista()');
  function tela(master,situacao,pedido=null){
    rodar({getElementById:()=>el},[{id:'a',entregador:'Pedro Silva',unidade:'Teste',data:'2026-10-02',criadoEm:'2026-10-02T12:00:00Z',situacao}],master,()=>pedido,()=>null,String,String,String,'America/Sao_Paulo','',{});
    return el.innerHTML;
  }
  const master=tela(true); assert(master.includes('Editar (Master)')); assert(master.includes('>Cancelar<')); assert(master.includes('>Excluir<')); assert(!master.includes('Pedir correção'));
  const loja=tela(false); assert(loja.includes('Pedir correção')); assert(loja.includes('Pedir cancelamento')); assert(loja.includes('Pedir exclusão')); assert(!loja.includes('Editar (Master)'));
  assert(!tela(false,undefined,{id:'p'}).includes('Pedir correção'));
  assert(!tela(true,'EXCLUIDO').includes('Editar (Master)'));
}

async function testarHttp({DOCS, enviarJson, postarJson}) {
  const hash=require('bcryptjs').hashSync('SenhaTeste!2026',4), headers={};
  for(const [perfil,role,qaMaster] of [['loja','user',false],['admin','user',false],['qa','master',true],['master','master',false]]){
    const email='acao-'+perfil+'@teste.local';
    DOCS.set('users/acao-'+perfil,{email,username:'acao-'+perfil,passwordHash:hash,active:true,role,qaMaster,
      permissions:{sections:['entregas-lancamento','entregas'],unidades:['Teste Acoes'],canAdmin:perfil==='admin'}});
    const login=await postarJson('/api/auth/login',{identifier:email,password:'SenhaTeste!2026'});
    assert.equal(login.status,200,perfil+' login');
    headers[perfil]={Authorization:'Bearer '+JSON.parse(login.corpo).token};
  }
  const live=require('./entregasLive');
  DOCS.set('entregasLive/teste-acoes-http',{id:'teste-acoes-http',unidade:'Teste Acoes',data:'2026-10-02',entregador:'Pedro Silva',entrega:2,valor:16});
  live.invalidar();
  for(const perfil of ['loja','admin','qa']){
    for(const [rota,body] of [['editar-direto',{mudancas:{valor:999}}],['acao-direta',{tipoAcao:'excluir',motivo:'Erro'}]]){
      const r=await enviarJson('PATCH','/api/entregas/teste-acoes-http/'+rota,body,headers[perfil]);
      assert.equal(r.status,403,perfil+' não pode '+rota);
    }
    assert.equal((await enviarJson('PATCH','/api/entregas/edicoes/forjado',{status:'APROVADO'},headers[perfil])).status,403);
  }
  DOCS.set('entregasLive/teste-outra-unidade',{id:'teste-outra-unidade',unidade:'Outra',entregador:'Pedro Silva',data:'2026-10-02'});
  assert.equal((await postarJson('/api/entregas/teste-outra-unidade/solicitar-acao',{tipoAcao:'cancelar',motivo:'Erro'},headers.loja)).status,403);
  const p=await postarJson('/api/entregas/teste-acoes-http/solicitar-acao',{tipoAcao:'cancelar',motivo:'Erro'},headers.loja);
  assert.equal(p.status,200,p.corpo); assert.equal(DOCS.get('entregasLive/teste-acoes-http').situacao,undefined);
  const r=await enviarJson('PATCH','/api/entregas/edicoes/'+JSON.parse(p.corpo).id,{status:'APROVADO'},headers.master);
  assert.equal(r.status,200,r.corpo); assert.equal(DOCS.get('entregasLive/teste-acoes-http').situacao,'CANCELADO');
  console.log('✓ Entregas por HTTP: apenas Master edita/cancela/exclui/decide; loja pede, unidade protegida e histórico preservado');
}
module.exports={testarHttp};
if(require.main===module) (async()=>{
  await testar(); console.log('✓ Cancelamento/exclusão: pedidos, rejeição/aprovação, histórico, totais, motivos e repetição');
  await assert.rejects(testar(true)); console.log('✓ Sabotagem detectada: não retirar o lançamento dos totais reprova');
})().catch(e=>{console.error(e);process.exitCode=1;});
