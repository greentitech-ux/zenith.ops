'use strict';
const assert = require('node:assert/strict');

async function testar() {
  const { resolverIdentidade } = require('./identidadeNoc');
  const empresas = require('./empresas'), unidades = require('./unidades'), noc = require('./lojaStatus');
  const stt = { id: 'prestadora', nome: 'Solutions Ti Tech', unidades: ['Administrativa'] };
  const gbe = { id: 'cliente-gbe', nome: 'GBE', unidades: ['Bessa'] };
  const outro = { id: 'outro', nome: 'Outro cliente', unidades: ['Outra'] };
  let lista = [gbe, stt, outro];
  assert.equal(resolverIdentidade('Nova', lista).empresa, null);
  assert.equal(resolverIdentidade('Bessa', lista).empresa.id, gbe.id);
  assert.equal(resolverIdentidade('Administrativa', lista).empresa.id, stt.id);
  assert.equal(resolverIdentidade('Bessa', [...lista, {...outro, unidades:['Bessa']}]).empresa, null);
  assert.equal(resolverIdentidade('Administrativa', [{...gbe, unidades:['Administrativa']}, stt]).empresa, null);
  assert.equal(resolverIdentidade('Bessa', [{...gbe, arquivada:true}, stt]).empresa, null);
  const fs = require('node:fs'), vm = require('node:vm');
  const html = fs.readFileSync(require('node:path').join(__dirname, 'public/grupos.html'), 'utf8');
  const abrir = html.match(/function abrirEdicaoEmpresa\(id\)\{[\s\S]*?\n\}/)[0];
  const elementos = {'emp-nome':{scrollIntoView(){}},'emp-tipo':{},'emp-unidades':{
    querySelectorAll:()=>[{value:'Bessa'}], insertAdjacentHTML(pos,conteudo){this.adicionais=conteudo;}
  }};
  vm.runInNewContext(abrir+'; abrirEdicaoEmpresa("gbe");',{
    EMPRESAS:[{id:'gbe',nome:'GBE',tipoNegocio:'alimentacao',unidades:['Bessa','DOM_19706']}],
    document:{getElementById:id=>elementos[id]},unidadesChecksHtml:()=>'',escapeHtml:s=>s,
  });
  assert.match(elementos['emp-unidades'].adicionais,/value="DOM_19706" checked/,'edição preserva código adicional');
  const origList = empresas.listAtivas, origPerfil = unidades.perfil;
  empresas.listAtivas = async()=>lista;
  unidades.perfil = async()=>({marca:'dominos'});
  try {
    await noc.setConfig({logosCarimbo:{
      'grupo:prestadora': {caminho:'logos/solutions.png',versao:1},
      'grupo:outro': {caminho:'logos/outro.png',versao:1},
    }});
    const propria = await noc.logosDaUnidade('Administrativa');
    assert.equal(propria.logoGrupo.caminho, 'logos/solutions.png');
    const nova = await noc.logosDaUnidade('Nova');
    assert.equal(nova.logoGrupo.caminho, 'logos/solutions.png');
    assert.equal(nova.logoMarca, null);
    assert.equal(nova.rede, null, 'padrão visual não cria vínculo/permissão');
    const bessa = await noc.logosDaUnidade('Bessa');
    assert.equal(bessa.logoGrupo.arquivoPublico, 'grupo-bravo.png');
    assert(bessa.logoMarca);
    lista = [{...gbe, unidades:[]},stt,{...outro,unidades:['Bessa']}];
    const trocada = await noc.logosDaUnidade('Bessa');
    assert.equal(trocada.logoGrupo.caminho,'logos/outro.png');
    assert.notEqual(trocada.logoGrupo.versao,bessa.logoGrupo.versao);
    assert.notEqual(trocada.versao,bessa.versao);
    lista = [{...gbe, unidades:['Bessa']},...lista];
    assert.equal((await noc.logosDaUnidade('Bessa')).logoGrupo.caminho,'logos/solutions.png');
    lista = [stt,{...outro,id:'sem-logo',unidades:['Outra']}];
    assert.equal((await noc.logosDaUnidade('Outra')).logoGrupo.caminho,'logos/solutions.png');
    lista = [{...stt,arquivada:true}];
    assert.equal((await noc.logosDaUnidade('Nova')).logoGrupo,null);
    assert(!empresas.UNIDADES_GBE.includes('Administrativa'));
  } finally { empresas.listAtivas=origList; unidades.perfil=origPerfil; }
  console.log('✓ Identidade NOC: vínculo explícito, fallback Solutions, conflito/arquivamento, ausência de logo e troca com versão igual.');
}
module.exports={testar};
if(require.main===module){
  process.env.JWT_SECRET='teste-identidade';process.env.ENCRYPTION_KEY='11'.repeat(32);
  const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),Module=require('node:module');
  if(process.argv.includes('--sabotagem')){const orig=Module._extensions['.js'];Module._extensions['.js']=(m,file)=>{
    if(file!==path.join(__dirname,'identidadeNoc.js'))return orig(m,file);
    m._compile(fs.readFileSync(file,'utf8').replace('return { empresa, prestadora };','return { empresa: ativas[0], prestadora };'),file);
  };}
  const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>{
    const file=path.join(__dirname,'testeRotas.js'),src=fs.readFileSync(file,'utf8').split('setTimeout(async () => {')[0].replace(/\b8899\b/g,String(port));
    const m=new Module(file,module);m.filename=file;m.paths=module.paths;
    m._compile(src+`\nsetTimeout(()=>require('./testeIdentidadeNoc').testar().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)}),2500);`,file);
  });});
}
