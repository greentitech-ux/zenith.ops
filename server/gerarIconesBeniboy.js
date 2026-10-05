'use strict';
// Renderiza a identidade existente: não mantém outra cópia do desenho.
const fs=require('fs'),path=require('path'),vm=require('vm');
const {chromium}=require('playwright');
(async()=>{
  const pasta=path.join(__dirname,'public');
  const fonte=fs.readFileSync(path.join(pasta,'tema.js'),'utf8');
  const desenho=fonte.match(/window\.beniboySVG = function[\s\S]*?\n  };/);
  if(!desenho) throw new Error('Desenho original do Beniboy não encontrado.');
  const contexto={window:{}};
  vm.runInNewContext(desenho[0],contexto);
  const navegador=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH});
  try {
    for(const tamanho of [192,512]){
      const pagina=await navegador.newPage({viewport:{width:tamanho,height:tamanho},deviceScaleFactor:1});
      await pagina.setContent('<style>body{margin:0;background:#ffd43b;display:grid;place-items:center;height:100vh}.bb-fundo,.bb-nucleo{fill:#ffd43b}.bb-anel,.bb-traco{stroke:#0b0d10}.bb-brilho{display:none}</style>'+contexto.window.beniboySVG(Math.round(tamanho*.78)));
      await pagina.screenshot({path:path.join(pasta,'beniboy-app-'+tamanho+'.png')});
      await pagina.close();
    }
  } finally {await navegador.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
