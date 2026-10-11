/* Contrato compartilhado do fechamento. Nunca redistribui valores históricos. */
(function(root, factory){
  if(typeof module === 'object' && module.exports) module.exports = factory();
  else root.SaltiversoCaixaFormas = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  const novos = ['credito','debito','voucher','pix','linkCredito','linkDebito','linkPix','dinheiro','outros'];
  const anteriores = ['credito','debito','voucher','pix','dinheiro','pixcnpj','outros'];
  const antigos = ['maquininha','dinheiro','pix','outros'];
  const todos = ['maquininha',...novos,'pixcnpj'];
  const labels = {maquininha:'Maquininha (legado)',credito:'Crédito',debito:'Débito',voucher:'Voucher',pix:'Pix',linkCredito:'Link Crédito',linkDebito:'Link Débito',linkPix:'Link Pix',dinheiro:'Dinheiro',pixcnpj:'PIX CNPJ (legado)',outros:'Outros'};
  const grupos = [{id:'maquininha',label:'Maquininha',campos:['credito','debito','voucher','pix']},{id:'online',label:'Online',campos:['linkCredito','linkDebito','linkPix']},{id:'dinheiro',label:'Dinheiro',campos:['dinheiro']},{id:'outros',label:'Outros',campos:['outros']}];
  const tem = (obj,k) => Object.prototype.hasOwnProperty.call(obj||{},k);
  function modelo(valores){
    if(!valores || ['linkCredito','linkDebito','linkPix'].some(k=>tem(valores,k))) return 3;
    return ['credito','debito','voucher','pixcnpj'].some(k=>tem(valores,k)) ? 2 : 1;
  }
  function campos(valores){
    if(!valores || !Object.keys(valores).length) return novos;
    if(modelo(valores)===1) return antigos;
    if(modelo(valores)===2 && !tem(valores,'maquininha')) return anteriores;
    return todos.filter(k=>tem(valores,k)); // dia de transição mantém todas as chaves
  }
  function uniao(valores){return todos.filter(k=>valores.some(v=>tem(v,k)));}
  const centavos = valor => Math.round((Number(valor)||0)*100);
  function somar(valores){return todos.reduce((s,k)=>s+centavos(valores?.[k]),0)/100;}
  function consolidar(lista, total){
    const resultado={maquininha:0,online:0,dinheiro:0,outros:0,legado:0};
    lista.forEach(v=>{
      const m=modelo(v);
      resultado.maquininha+=centavos(v.maquininha)+['credito','debito','voucher'].reduce((s,k)=>s+centavos(v[k]),0)+(m>=2?centavos(v.pix):0);
      resultado.online+=['linkCredito','linkDebito','linkPix'].reduce((s,k)=>s+centavos(v[k]),0);
      resultado.dinheiro+=centavos(v.dinheiro);resultado.outros+=centavos(v.outros);
      resultado.legado+=(m===1?centavos(v.pix):0)+centavos(v.pixcnpj);
    });
    const soma=Object.values(resultado).reduce((a,b)=>a+b,0);
    Object.keys(resultado).forEach(k=>resultado[k]/=100);
    // Ajustes do consolidado antigo não são distribuídos arbitrariamente.
    resultado.ajustes=total==null?0:(centavos(total)-soma)/100;
    resultado.total=total==null?soma/100:Number(total);
    return resultado;
  }
  return {novos,anteriores,antigos,todos,labels,grupos,modelo,campos,uniao,somar,consolidar};
});
