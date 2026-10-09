'use strict';
const assert=require('assert/strict'),http=require('http'),zlib=require('zlib');
const dependencia=nome=>require(process.env.DEPENDENCIAS_CONTROLE ? require('path').join(process.env.DEPENDENCIAS_CONTROLE,nome) : nome);
const proxyaddr=dependencia('proxy-addr');
function conferirProxy(proxy){
  const trust=proxy.compile('::ffff:10.0.0.0/8');
  assert.equal(trust('203.0.113.42'),false,'Subnet IPv6 curta não pode confiar em qualquer IPv4');
  const correto=proxy.compile('::ffff:10.0.0.0/104');
  assert.equal(correto('10.2.3.4'),true);assert.equal(correto('203.0.113.42'),false);
  const req={socket:{remoteAddress:'203.0.113.42'},headers:{'x-forwarded-for':'192.0.2.1'}};
  assert.equal(proxy(req,trust),'203.0.113.42','Cabeçalho não pode substituir origem não confiável');
}
if(!process.env.TESTAR_SO_COMPRESSAO)conferirProxy(proxyaddr);
// Sabotagem: a comparação IPv4/IPv6 vulnerável volta a confiar em tudo.
assert.throws(()=>conferirProxy(Object.assign(()=> '192.0.2.1',{compile:()=>()=>true})));
const descriptor=Object.getOwnPropertyDescriptor(zlib,'createGzip');
let ultimoStream;
Object.defineProperty(zlib,'createGzip',{...descriptor,value:(...args)=>(ultimoStream=descriptor.value(...args))});
const compression=dependencia('compression');
async function conferirCompressao(){
  let fechouResposta;
  const fechou=new Promise(resolve=>{fechouResposta=resolve});
  const middleware=compression({threshold:0});
  const server=http.createServer((req,res)=>{
    middleware(req,res,()=>{
      res.setHeader('Content-Type','text/plain');
      if(req.url==='/normal')return res.end('Teste de compressão '.repeat(200));
      res.on('close',()=>fechouResposta());
      res.write('Resposta interrompida '.repeat(300));res.flush();
    });
  });
  const timeout=setTimeout(()=>server.closeAllConnections(),5000);
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const port=server.address().port;
    const normal=await new Promise((resolve,reject)=>{
      http.get({host:'127.0.0.1',port,path:'/normal',headers:{'Accept-Encoding':'gzip'}},res=>{
        const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({headers:res.headers,body:Buffer.concat(chunks)}));res.on('error',reject);
      }).on('error',reject);
    });
    assert.equal(normal.headers['content-encoding'],'gzip');
    assert.equal(zlib.gunzipSync(normal.body).toString(),'Teste de compressão '.repeat(200));
    await new Promise((resolve,reject)=>{
      const req=http.get({host:'127.0.0.1',port,path:'/abortar',headers:{'Accept-Encoding':'gzip'}},res=>res.once('data',()=>{res.destroy();resolve()}));
      req.on('error',reject);
    });
    await fechou;
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(ultimoStream.destroyed,true,'Resposta interrompida precisa liberar o stream zlib');
    const streamSabotado={destroyed:false};assert.throws(()=>assert.equal(streamSabotado.destroyed,true));
  }finally{
    clearTimeout(timeout);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    Object.defineProperty(zlib,'createGzip',descriptor);
  }
}
conferirCompressao().then(()=>console.log('OK: proxy IPv4/IPv6, IP não confiável, gzip normal, liberação após interrupção e sabotagens.')).catch(e=>{console.error(e);process.exitCode=1});
