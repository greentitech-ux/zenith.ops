// Nenhuma VM real é acessada: valida código gerado e fila contra banco falso.
const assert = require('assert/strict');
const fs = require('fs');
const vm = require('vm');
const { preparar } = require('./hypervControle');
const agora = Date.now();
const host = { tipo:'interno', agentToken:'teste', ultimoHeartbeatEm:agora,
  nome:'HOST', codigo:'loja', posto:'host', vms:[{nome:"PULSE ' [*] $()",estado:'Executando'}] };
const nome = host.vms[0].nome;
for (const acao of ['ligar','desligar','reiniciar']) {
  const p = preparar(host,nome,acao,agora);
  assert.equal(p.requerAdmin,true);
  assert.ok(p.comando.includes(Buffer.from(nome).toString('base64')));
  assert.ok(!p.comando.includes(nome), 'Nome não pode virar código PowerShell');
  assert.match(p.comando,/StringComparison\]::Ordinal/);
  assert.match(p.comando,/Pedido vencido/);
  assert.doesNotMatch(p.comando,/\b(?:Restart-VM|Stop-Computer|Restart-Computer|shutdown\.exe)\b(?!:)/);
  assert.doesNotMatch(p.comando,/(?:Stop-VM|Start-VM)[^\n]*-(?:Force|TurnOff|ComputerName)/);
  if (acao==='reiniciar') {
    assert.ok(p.comando.indexOf("$vm.State -ne 'Off'") < p.comando.indexOf('Start-VM'));
    assert.match(p.comando,/Wait-Job -Job \$job -Timeout 120/);
  }
}
for (const [h,n,a] of [[host,nome,'reset'],[host,'outra','ligar'],[{...host,agentToken:null},nome,'ligar'],
  [{...host,tipo:'atendimento'},nome,'ligar'],[{...host,ultimoHeartbeatEm:agora-301000},nome,'ligar']]) {
  assert.throws(()=>preparar(h,n,a,agora));
}
const fonte = fs.readFileSync(require.resolve('./lojaStatus'),'utf8');
const trecho = fonte.slice(fonte.indexOf('async function enfileirarVm('),fonte.indexOf('async function enfileirarComando('));
async function filaTeste(sabotar=false) {
  let doc={...host}, seq=0, serial=Promise.resolve(); const comandos=new Map();
  const ref={};
  const ctx = { require:id=>{assert.equal(id,'./hypervControle');return {preparar}},
    Date, COLLECTION:{doc:()=>ref},COMANDOS_COLLECTION:{doc:()=>({id:String(++seq)})},
    docIdFor:()=>'',filaDeComandos:h=>h.comandosFilaIds||[],cache:{invalidar(){}},
    db:{runTransaction: fn=>{const p=serial.then(()=>fn({
      get:async()=>({exists:true,data:()=>structuredClone(doc)}),
      set:(r,item)=>comandos.set(r.id,item),update:(_r,patch)=>{doc={...doc,...patch}}
    })); serial=p.catch(()=>{});return p}}
  };
  vm.createContext(ctx);
  vm.runInContext(sabotar ? trecho.replace('if (filaDeComandos(host).length)', 'if (false)') : trecho,ctx);
  const resultados=await Promise.allSettled([ctx.enfileirarVm('loja','host',nome,'reiniciar','master'),ctx.enfileirarVm('loja','host',nome,'reiniciar','master')]);
  assert.equal(resultados.filter(r=>r.status==='fulfilled').length,1,'Dois cliques não podem reservar duas ações');
  assert.equal(comandos.size,1,'Não deixar comando órfão');
  const item=[...comandos.values()][0];
  assert.equal(item.solicitadoPor,'master'); assert.equal(item.requerAdmin,true);assert.equal(item.vmNome,nome);
}
(async()=>{
  if(process.env.HYPERV_TEST_PWSH){
    // Cmdlets substituídos por funções locais: NÃO importa Hyper-V de verdade.
    const {spawnSync}=require('child_process');
    for(const [acao,estado,falhar] of [['ligar','Off',false],['desligar','Running',false],['reiniciar','Running',false],['reiniciar','Running',true],['reiniciar','Off',false]]){
      const mock = `$global:alvo=[pscustomobject]@{Name="VM";State='${estado}';Id='teste'}; $global:partidas=0; $global:paradas=0
function Import-Module {}
function Get-VM { param($Id) return $global:alvo }
function Start-VM { param($VM,$Confirm,$ErrorAction) $global:partidas++; $global:alvo.State='Running' }
function Stop-VM { param($VM,[switch]$AsJob,$Confirm,$ErrorAction) $global:paradas++; ${falhar ? '' : "$global:alvo.State='Off'"}; return [pscustomobject]@{State='${falhar?'Running':'Completed'}'} }
function Wait-Job { param($Job,$Timeout) ${falhar?'return $null':'return $Job'} }
function Receive-Job { param($Job,$ErrorAction) }
function Stop-Job { param($Job,$ErrorAction) }
function Remove-Job { param($Job,$ErrorAction) }
$ok=$true;$erro='';try { & { ${preparar({...host,vms:[{nome:'VM'}]},'VM',acao).comando} } | Out-Null } catch { $ok=$false;$erro=$_.Exception.Message }
@{ok=$ok;erro=$erro;partidas=$global:partidas;paradas=$global:paradas;estado=$global:alvo.State} | ConvertTo-Json -Compress`;
      const p=spawnSync(process.env.HYPERV_TEST_PWSH,['-NoProfile','-EncodedCommand',Buffer.from(mock,'utf16le').toString('base64')],{encoding:'utf8',timeout:15000});
      assert.equal(p.status,0,p.stderr);
      const resultado=JSON.parse(p.stdout.trim());
      assert.equal(resultado.ok,!falhar && !(acao==='reiniciar'&&estado==='Off'),resultado.erro);
      assert.equal(resultado.partidas,acao!=='desligar' && resultado.ok ? 1 : 0,'Só partir após desligamento confirmado');
    }
  }
  await filaTeste();
  await assert.rejects(filaTeste(true),'Sabotagem da reserva deve ser detectada');
  const index=fs.readFileSync(require.resolve('./index'),'utf8');
  assert.match(index,/vms\/acao', requireMasterDeVerdade/);
  const inicio=index.indexOf("app.post('/api/loja-status/:codigo/computadores/:posto/vms/acao'");
  const rota=index.slice(inicio,index.indexOf('// ---------- PROGRAMAS REMOTOS',inicio));
  assert.ok(rota.indexOf('exigirSenhaDoMaster') < rota.indexOf('enfileirarVm'));
  console.log('Hyper-V: validação, escape, expiração, reinício sem força, auditoria e reserva concorrente aprovados; sabotagem detectada.');
})().catch(e=>{console.error(e);process.exitCode=1});
