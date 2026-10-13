'use strict';
const fs=require('node:fs'),path=require('node:path');
const {mascarar}=require('./pedidosMonitor');
const script=fs.readFileSync(path.join(__dirname,'diagnosticoCompleto.ps1'),'utf8');
// Job isolado, timeout real; não bloqueia indefinidamente a batida do agente.
const comando=`$jobNocDiagnostico = Start-Job -ScriptBlock {\n${script}\n}\ntry {\n  if (-not (Wait-Job $jobNocDiagnostico -Timeout 120)) { Stop-Job $jobNocDiagnostico; throw 'Diagnostico excedeu 120 segundos.' }\n  Receive-Job $jobNocDiagnostico -ErrorAction Stop\n} finally { Remove-Job $jobNocDiagnostico -Force -ErrorAction SilentlyContinue }`;
const chaves=new Set(['tipo','fabricante','modelo','cpu','nucleos','ramGB','ramPentes','ramMHz','discos','livreSistemaPct','gpu','planoEnergia','procMax','uptimeDias','startupCount','antivirus','firewallOff','remotos','topCpu','erros7dAmostra','desligamentosInesperadosAmostra']);
function limpar(v,prof=0) {
  if(prof>3)return null;
  if(v==null||typeof v==='boolean')return v;
  if(typeof v==='number')return Number.isFinite(v)?v:null;
  if(typeof v==='string')return mascarar(v).slice(0,400);
  if(Array.isArray(v))return v.slice(0,20).map(x=>limpar(x,prof+1));
  if(typeof v==='object')return Object.fromEntries(Object.entries(v).filter(([k])=>['modelo','tipo','saude','proc','pct'].includes(k)).map(([k,x])=>[k,limpar(x,prof+1)]));
  return null;
}
function extrair(saida) {
  const linha=String(saida||'').match(/(?:^|\r?\n)NOC_DIAGNOSTICO_JSON:([^\r\n]{1,30000})(?:\r?\n|$)/);
  if(!linha)return null;
  try {
    const d=JSON.parse(linha[1]);
    if(d.versaoScript!=='1.0-nopulso'||!Number.isFinite(Date.parse(d.geradoEm))||!d.resumo||typeof d.admin!=='boolean')return null;
    return {versaoScript:d.versaoScript,geradoEm:d.geradoEm,recebidoEm:new Date().toISOString(),admin:d.admin,
      resumo:Object.fromEntries(Object.entries(d.resumo).filter(([k])=>chaves.has(k)).map(([k,v])=>[k,limpar(v)])),
      alertas:Array.isArray(d.alertas)?d.alertas.slice(0,40).map(x=>mascarar(String(x)).slice(0,400)):[],
      fontesIndisponiveis:Array.isArray(d.fontesIndisponiveis)?d.fontesIndisponiveis.slice(0,20).map(x=>mascarar(String(x)).slice(0,200)):[],
      limiteEventos:200};
  } catch{return null;}
}
module.exports={comando,extrair};
