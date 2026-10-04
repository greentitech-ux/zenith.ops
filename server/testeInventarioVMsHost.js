// Executa somente funções extraídas, com Hyper-V e HTTP substituídos por mocks.
const assert = require('assert/strict');
const { spawnSync } = require('child_process');
const { montarScriptVigia, VERSAO_VIGIA } = require('./vigiaScript');
const pwsh = process.env.HYPERV_TEST_PWSH;
assert.ok(pwsh, 'Defina HYPERV_TEST_PWSH para executar os testes PowerShell');
assert.ok(VERSAO_VIGIA >= 135);
function validarCedencia(ps) {
  const inicio = ps.indexOf('    elseif (UiEstaAtiva) {');
  const trecho = ps.slice(inicio, ps.indexOf('    elseif ($EmEsperaServico)', inicio));
  assert.match(trecho, /if \(\$Servico\) \{ Sondar-ComandoAdmin; Sondar-VMsHost \}/);
  assert.ok(trecho.indexOf('Sondar-VMsHost') < trecho.indexOf('Start-Sleep'));
  assert.ok(trecho.indexOf('Start-Sleep') < trecho.indexOf('continue'));
  return trecho;
}
for (const tipo of ['interno', 'atendimento']) {
  for (const windowsAntigo of [false, true]) {
    const ps = montarScriptVigia({ codigo: 'TESTE', posto: 'HOST', tipo, agentToken: 'teste', windowsAntigo });
    const cedencia = validarCedencia(ps);
    assert.throws(() => validarCedencia(ps.replaceAll('; Sondar-VMsHost', '')), 'Sabotagem deve ser detectada');
    if (windowsAntigo) assert.doesNotMatch(ps, /ToUnixTimeMilliseconds|::new\(/);
    const funcoes = ps.slice(ps.indexOf('function Medir-VMs {'), ps.indexOf('function Enviar-Telemetria('));
    assert.ok(funcoes.includes('function Sondar-VMsHost'));
    const codigo = `
$texto = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(ps).toString('base64')}'))
$tokens=$null; $erros=$null
[Management.Automation.Language.Parser]::ParseInput($texto,[ref]$tokens,[ref]$erros) | Out-Null
if ($erros.Count) { throw ($erros | Out-String) }
$global:Servico=$true; $global:admin=$true; $global:modo='normal'
$global:leituras=0; $global:envios=0; $global:adminSondas=0
$UrlTelemetria='https://invalid.example/teste'; $CabecalhosAgente=@{'X-NOC-Token'='teste'}
function Sou-Admin { return $global:admin }
function Escrever-Log { param($texto) }
function Get-Command { param($Name,$ErrorAction) if ($global:modo -ne 'ausente') { return 'mock' } }
function Get-VM { param($ErrorAction)
  $global:leituras++
  if ($global:modo -eq 'erro') { throw 'Hyper-V indisponivel' }
  if ($global:modo -eq 'vazio') { return }
  [pscustomobject]@{Name='GCOM19940';State='Running'}
  [pscustomobject]@{Name='PULSEBOS19940';State='Off'}
}
function Invoke-RestMethod { param($Uri,$Method,$ContentType,$Headers,$Body,$TimeoutSec,$ErrorAction)
  if ($Headers['X-NOC-Token'] -ne 'teste' -or $Method -ne 'Post' -or $TimeoutSec -ne 15) { throw 'Transporte incorreto' }
  $global:envios++; $global:corpo=$Body | ConvertFrom-Json
  if (@($global:corpo.PSObject.Properties).Count -ne 1) { throw 'Payload deve conter somente VMs' }
}
${funcoes}
function Checar($cond,$msg) { if (-not $cond) { throw $msg } }
Sondar-VMsHost; Sondar-VMsHost
Checar ($global:leituras -eq 1 -and $global:envios -eq 1) 'Limite de cinco minutos'
Checar (@($global:corpo.vms).Count -eq 2 -and $global:corpo.vms[1].estado -eq 'Off') 'Estados das VMs'
$script:UltimaSondagemVMsHost=[DateTime]::UtcNow.AddSeconds(-301)
Sondar-VMsHost
Checar ($global:envios -eq 2) 'Nova consulta apos cinco minutos'
foreach ($cenario in @('login','semAdmin','ausente','erro','vazio')) {
  $script:UltimaSondagemVMsHost=$null; $global:leituras=0; $global:envios=0
  $global:Servico=$cenario -ne 'login'; $global:admin=$cenario -ne 'semAdmin'; $global:modo=$cenario
  Sondar-VMsHost
  if ($cenario -eq 'vazio') {
    Checar ($global:envios -eq 1 -and @($global:corpo.vms).Count -eq 0) 'Inventario vazio deve ser enviado'
  } else { Checar ($global:envios -eq 0) "Nao enviar inventario no cenario $cenario" }
}
$global:Servico=$true; $global:admin=$true; $global:modo='normal'; $global:envios=0
$script:UltimaSondagemVMsHost=$null; $EmEsperaServico=$false; $IntervaloSegundos=25
function UiEstaAtiva { return $true }
function Marcar-UiAtiva { throw 'Nao e login' }
function Sondar-ComandoAdmin { $global:adminSondas++ }
function Start-Sleep { param($Seconds) Checar ($global:envios -eq 1) 'Sondagem antes da espera' }
foreach ($volta in @(1)) {
  if (-not $Servico) { Marcar-UiAtiva }
${cedencia}
  throw 'Nao respeitou continue'
}
Checar ($global:envios -eq 1 -and $global:adminSondas -eq 1) 'SYSTEM coleta com login ativo'
Write-Output 'OK'
`;
    const entrada = '& ([scriptblock]::Create([Console]::In.ReadToEnd()))';
    const r = spawnSync(pwsh, ['-NoProfile', '-EncodedCommand', Buffer.from(entrada, 'utf16le').toString('base64')], { input: codigo, encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 0, r.stderr || r.error?.message);
    assert.match(r.stdout, /OK/);
    console.log(`Inventário SYSTEM: ${tipo}, Windows antigo=${windowsAntigo}: OK`);
  }
}
console.log('Parser, coleta com login, limites, ausência/erro/vazio e sabotagem aprovados. Nenhuma VM ou rede real acessada.');
