'use strict';
// Consulta apenas nomes/versões de pacotes públicos. Não envia código ou credenciais.
const fs=require('fs'),path=require('path');
(async()=>{
  const lock=JSON.parse(fs.readFileSync(path.join(__dirname,'package-lock.json'),'utf8')),pacotes={};
  for(const [local,p] of Object.entries(lock.packages||{})){
    if(!local || !p.version || p.dev)continue;
    const nome=p.name||local.split('node_modules/').at(-1);
    (pacotes[nome] ||= []).push(p.version);
  }
  for(const nome of Object.keys(pacotes))pacotes[nome]=[...new Set(pacotes[nome])];
  const r=await fetch('https://registry.npmjs.org/-/npm/v1/security/advisories/bulk',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(pacotes),signal:AbortSignal.timeout(30000)});
  if(!r.ok)throw new Error('Registro npm respondeu '+r.status);
  const d=await r.json();
  for(const [nome,avisos] of Object.entries(d))for(const a of avisos)console.log(JSON.stringify({pacote:nome,instaladas:pacotes[nome],gravidade:a.severity,titulo:a.title,faixa:a.vulnerable_versions,url:a.url}));
  console.log('Pacotes consultados: '+Object.keys(pacotes).length+'; pacotes com avisos: '+Object.keys(d).length);
})().catch(e=>{console.error(e.message);process.exitCode=1;});
