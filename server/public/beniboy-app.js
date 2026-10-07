'use strict';
// App web separado do NoPulso principal. Não contém token nem muda permissões.
(function(){
  let convite=null;
  window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();convite=e;});
  window.addEventListener('appinstalled',()=>{convite=null;aviso('Central Beniboy instalada. Abra pelo novo ícone do aparelho.');});
  function aviso(texto){
    const el=document.getElementById('beniboy-app-aviso');
    if(el) el.textContent=texto;
  }
  window.abrirAppBeniboy=function(){
    document.getElementById('overlay-app-beniboy').classList.remove('hidden');
    const instalada=window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    aviso(instalada?'Este é o atalho da Central, separado do NoPulso.':'Adicione o atalho da Central: abre em janela própria, junto do NoPulso. Não usa Play Store, APK ou EXE.');
    // No www o app instalado do NoPulso pode capturar a rota da Central. O
    // endereço próprio dá ao navegador uma origem e um ícone independentes.
    fetch('/api/meta/endereco').then(r=>r.ok?r.json():null).then(d=>{
      let proprio; try { proprio=new URL(d && d.atendimento); } catch(_) { return; }
      if(proprio.origin===location.origin) return;
      const el=document.getElementById('beniboy-app-aviso'); if(!el) return;
      el.textContent='Para o ícone abrir só a Central, instale pelo endereço próprio: ';
      const a=document.createElement('a');
      a.href=proprio.origin+'/';a.textContent=proprio.host;a.target='_blank';a.rel='noopener';a.style.color='var(--accent)';
      el.appendChild(a);
      el.appendChild(document.createTextNode(' (entre de novo com seu usuário lá).'));
    }).catch(()=>{});
  };
  window.fecharAppBeniboy=function(){document.getElementById('overlay-app-beniboy').classList.add('hidden');};
  window.instalarAppBeniboy=async function(){
    if(convite){
      const evento=convite;convite=null;
      try{
        await evento.prompt();
        const escolha=await evento.userChoice;
        aviso(escolha.outcome==='accepted'?'Instalação confirmada. Procure o ícone Central Beniboy no aparelho.':'Instalação cancelada. Você pode continuar usando a Central no navegador.');
      }catch(e){aviso('Use o menu do navegador para instalar a Central Beniboy.');}
      return;
    }
    if(/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform==='MacIntel' && navigator.maxTouchPoints>1)){
      aviso('No Safari: Compartilhar → Adicionar à Tela de Início → Adicionar. Abra depois pelo ícone Central Beniboy.');return;
    }
    aviso('No Chrome ou Edge: abra o menu ⋮/… e procure “Instalar Central Beniboy”, “Instalar página como app” ou “Adicionar à tela inicial”. A opção depende do navegador.');
  };
  window.baixarAtalhoBeniboy=function(){
    const url=new URL('/atendimento/central',location.origin);
    if(!['https:','http:'].includes(url.protocol)) return;
    // ZIP evita que navegadores renomeiem .url para .download por segurança.
    const nome=new TextEncoder().encode('Central Beniboy.url');
    const dados=new TextEncoder().encode('[InternetShortcut]\r\nURL='+url.href+'\r\n');
    let crc=0xffffffff;
    for(const byte of dados){crc^=byte;for(let bit=0;bit<8;bit++) crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
    crc=(crc^0xffffffff)>>>0;
    const local=new Uint8Array(30+nome.length+dados.length),lv=new DataView(local.buffer);
    lv.setUint32(0,0x04034b50,true);lv.setUint16(4,20,true);lv.setUint16(12,33,true);
    lv.setUint32(14,crc,true);lv.setUint32(18,dados.length,true);lv.setUint32(22,dados.length,true);lv.setUint16(26,nome.length,true);
    local.set(nome,30);local.set(dados,30+nome.length);
    const central=new Uint8Array(46+nome.length),cv=new DataView(central.buffer);
    cv.setUint32(0,0x02014b50,true);cv.setUint16(4,20,true);cv.setUint16(6,20,true);cv.setUint16(14,33,true);
    cv.setUint32(16,crc,true);cv.setUint32(20,dados.length,true);cv.setUint32(24,dados.length,true);cv.setUint16(28,nome.length,true);central.set(nome,46);
    const fim=new Uint8Array(22),fv=new DataView(fim.buffer);
    fv.setUint32(0,0x06054b50,true);fv.setUint16(8,1,true);fv.setUint16(10,1,true);fv.setUint32(12,central.length,true);fv.setUint32(16,local.length,true);
    const arquivo=new Blob([local,central,fim],{type:'application/zip'});
    const link=document.createElement('a');
    const objeto=URL.createObjectURL(arquivo);
    link.href=objeto;link.download='Central Beniboy.zip';document.body.appendChild(link);link.click();link.remove();
    setTimeout(()=>URL.revokeObjectURL(objeto),60000);
    aviso('No Windows: abra “Central Beniboy.zip”, use Extrair tudo e mova “Central Beniboy.url” para a Área de Trabalho. Ele abre no navegador padrão; para janela própria, use Instalar app.');
  };
})();
