'use strict';
// Só analisa o script e executa Varrer-RedeLocal com cmdlets simulados.
// Nunca instala o agente, modifica a rede nem chama DNS/NetBIOS reais.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { montarScriptVigia } = require('./vigiaScript');
const ps = `
$src = [Console]::In.ReadToEnd()
$erros = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($src, [ref]$null, [ref]$erros)
if ($erros.Count) { throw ($erros.Message -join '; ') }
$func = $ast.Find({param($a) $a -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -eq 'Varrer-RedeLocal'}, $true)
function Get-NetNeighbor {
  foreach ($estado in @('Reachable','Stale','Permanent')) {
    [pscustomobject]@{IPAddress='192.168.18.226';LinkLayerAddress='A4-2B-B0-99-88-11';State=$estado}
  }
}
function Resolve-DnsName { throw 'simulado' }
function nbtstat { return '' }
function Escrever-Log { param($msg) }
. ([scriptblock]::Create($func.Extent.Text))
@(Varrer-RedeLocal) | ConvertTo-Json -Compress
`;
for (const windowsAntigo of [false, true]) {
  const src = montarScriptVigia({ codigo: 'TESTE', posto: 'TESTE', tipo: 'interno', agentToken: 'teste', windowsAntigo });
  assert.ok(src.startsWith('# NOCZenith'));
  const saida = execFileSync(process.env.PWSH_BIN || 'pwsh', ['-NoProfile', '-NonInteractive', '-Command', ps], { input: src, encoding: 'utf8', timeout: 30000 });
  assert.deepEqual(JSON.parse(saida).map(d => d.estadoVizinho), ['Reachable', 'Stale', 'Permanent']);
  console.log('✓ Coleta ARP + parse completo: ' + (windowsAntigo ? 'Windows antigo' : 'padrão'));
}
