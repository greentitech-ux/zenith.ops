// Mesmas contas no navegador e nas exportações. Não reescreve o histórico.
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.EntregasAnalise=api;})(typeof globalThis==='object'?globalThis:this,function(){
  const num=v=>Number.isFinite(Number(v))?Number(v):0;
  const texto=v=>String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  const iso=d=>d.toISOString().slice(0,10);
  const data=s=>new Date(s+'T12:00:00Z');
  function deslocar(s,dias){const d=data(s);d.setUTCDate(d.getUTCDate()+dias);return iso(d);}
  function mes(s,n){const d=data(s),dia=d.getUTCDate();d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+n);d.setUTCDate(Math.min(dia,new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate()));return iso(d);}
  function periodo(tipo,hoje){
    const d=data(hoje),y=d.getUTCFullYear(),m=d.getUTCMonth();
    if(tipo==='hoje')return {inicio:hoje,fim:hoje};
    if(tipo==='ontem'){const s=deslocar(hoje,-1);return {inicio:s,fim:s};}
    if(tipo==='30dias')return {inicio:deslocar(hoje,-29),fim:hoje};
    if(tipo==='semana')return {inicio:deslocar(hoje,-d.getUTCDay()),fim:hoje};
    if(tipo==='mes')return {inicio:iso(new Date(Date.UTC(y,m,1))),fim:hoje};
    if(tipo==='trimestre')return {inicio:iso(new Date(Date.UTC(y,Math.floor(m/3)*3,1))),fim:hoje};
    return {inicio:y+'-01-01',fim:hoje};
  }
  function comparar(f,tipo){
    if(!f.inicio||!f.fim||f.inicio>f.fim)return null;
    if(tipo==='mes'||tipo==='ano'){const n=tipo==='mes'?-1:-12;return {...f,inicio:mes(f.inicio,n),fim:mes(f.fim,n)};}
    const dias=tipo==='semana'?7:Math.round((data(f.fim)-data(f.inicio))/86400000)+1;
    return {...f,inicio:deslocar(f.inicio,-dias),fim:deslocar(f.fim,-dias)};
  }
  function normalizar(r){
    const manual=r.valorEntregas!=null;
    const itens=r.itensManuais||[];
    const adicional=chave=>itens.filter(c=>texto(c.campo||c.label).replace(/[^a-z]/g,'')===chave).reduce((s,c)=>s+num(c.quantidade),0);
    const entrega=manual?num(r.entrega):(num(r.quantTotal)||num(r.entrega)+num(r.retorno)+num(r.extra));
    return {...r,entrega,quantTotal:entrega,retorno:manual?adicional('retorno'):num(r.retorno),extra:manual?adicional('extra'):num(r.extra),
      valor:num(r.valor),ajudaCusto:num(r.ajudaCusto)+num(r.garantido),foraDeArea:num(r.foraDeArea),pos00hs:num(r.pos00hs),bonus:num(r.bonus),coopRecebe:num(r.coopRecebe)};
  }
  function filtrar(rows,f){return rows.filter(r=>(!f.inicio||r.data>=f.inicio)&&(!f.fim||r.data<=f.fim)&&(!f.unidades?.length||f.unidades.includes(r.unidade))&&(!f.nome||texto(r.entregador).includes(texto(f.nome)))&&(f.dia===''||f.dia==null||String(data(r.data).getUTCDay())===String(f.dia)));}
  function somar(rows){const soma=c=>+rows.reduce((s,r)=>s+num(r[c]),0).toFixed(2);const entrega=soma('entrega'),valor=soma('valor');return {entrega,valor,tm:entrega?valor/entrega:null,retorno:soma('retorno'),extra:soma('extra'),garantido:soma('ajudaCusto'),foraDeArea:soma('foraDeArea'),ativos:new Set(rows.filter(r=>r.tipoRecebedor!=='empresa').map(r=>texto(r.entregador))).size,registros:rows.length};}
  function serie(rows,f){
    if(!f.inicio||!f.fim||f.inicio>f.fim)return [];
    const grupos=new Map();for(const r of filtrar(rows,f)){if(!grupos.has(r.data))grupos.set(r.data,[]);grupos.get(r.data).push(r);}
    const pontos=[];for(let s=f.inicio;s<=f.fim&&pontos.length<3660;s=deslocar(s,1)){if(f.dia!==''&&f.dia!=null&&String(data(s).getUTCDay())!==String(f.dia))continue;const rs=grupos.get(s)||[];pontos.push({data:s,...somar(rs),temDados:rs.length>0});}return pontos;
  }
  function variacao(atual,anterior){return anterior>0?(atual-anterior)/anterior*100:null;}
  function copiar(f){return {...f,unidades:[...(f.unidades||[])]};}
  function sincronizar(f,estados){for(const chave of Object.keys(estados))estados[chave]=copiar(f);}
  return {num,texto,periodo,comparar,normalizar,filtrar,somar,serie,variacao,copiar,sincronizar,deslocar};
});
