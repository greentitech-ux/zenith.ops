'use strict';
const assert=require('assert/strict'),Module=require('module'),{Readable,Writable}=require('stream');
const original=Module._load;
Module._load=function(nome,pai,...args){
  if(pai?.filename===require.resolve('./storage')){
    if(nome==='./firestore')return {};
    if(nome==='./storageBucket')return {resolverBucket:async()=>({file:()=>({createReadStream:()=>Readable.from(['teste'])})})};
  }
  return original.call(this,nome,pai,...args);
};
(async()=>{try{
  const storage=require('./storage');
  async function servir(tipo){
    const res=new Writable({write(c,e,cb){cb();}});res.cab={};res.set=(k,v)=>res.cab[k.toLowerCase()]=v;
    const fim=new Promise((resolve,reject)=>{res.on('finish',resolve);res.on('error',reject);});
    await storage.streamArquivo('teste',tipo,res);await fim;return res.cab;
  }
  for(const tipo of ['text/html','image/svg+xml','application/xhtml+xml']){
    const h=await servir(tipo);assert.equal(h['content-type'],'application/octet-stream');assert.equal(h['content-disposition'],'attachment');assert.match(h['content-security-policy'],/sandbox/);
  }
  for(const tipo of ['image/png','audio/webm','application/pdf']){
    const h=await servir(tipo);assert.equal(h['content-type'],tipo);assert.equal(h['content-disposition'],undefined);assert.equal(h['x-content-type-options'],'nosniff');
  }
  const fs=require('fs'),vm=require('vm');
  const fonte=fs.readFileSync(require.resolve('./pushSeguranca'),'utf8').replace('||!permitido','');
  const sabotado={exports:{}};vm.runInNewContext(fonte,{require,module:sabotado,Buffer,URL});
  const conferir=s=>assert.throws(()=>s.endpointSeguro('https://evil.example/x'));
  conferir(require('./pushSeguranca'));assert.throws(()=>conferir(sabotado.exports),assert.AssertionError,'teste falha quando allowlist é removida');
  console.log('✓ Anexos: HTML/SVG isolados, PNG/PDF/áudio preservados; sabotagem real da allowlist detectada.');
}finally{Module._load=original;}})().catch(e=>{console.error(e);process.exitCode=1;});
