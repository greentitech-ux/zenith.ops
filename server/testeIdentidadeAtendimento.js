'use strict';
// Não instala app, não grava registro e não modifica atalhos do Windows.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { montarScriptVigia, VERSAO_VIGIA } = require('./vigiaScript');
const manifesto = require('./public/manifest-beniboy.json');
const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'public/beniboy-app-192.png'))).digest('hex');
const pwsh = process.env.HYPERV_TEST_PWSH;
assert(pwsh, 'Defina HYPERV_TEST_PWSH para validar o script sem instalar o agente.');
assert(VERSAO_VIGIA >= 148);
assert.equal(manifesto.name, 'Atendimento NoPulso');
assert.equal(manifesto.id, '/central-beniboy-app', 'Trocar o nome não cria outro app');
assert.equal(manifesto.start_url, '/atendimento/central');
assert.match(fs.readFileSync(path.join(__dirname, 'public/atendimento.html'), 'utf8'), /<h1>Atendimento NoPulso<\/h1>/);
function validarPolitica(politica) {
  assert.equal(politica.length, 2, 'Dois apps distintos no mesmo navegador');
  const app = politica[0];
  assert.equal(new URL(app.url).pathname, '/atendimento/central', 'Preserva a URL instalada');
  assert.equal(app.custom_name, manifesto.name);
  assert.equal(app.custom_icon.hash, hash, 'Hash corresponde à logo publicada');
  assert.equal(new URL(app.custom_icon.url).pathname, '/beniboy-app-192.png');
  assert.equal(new URL(app.custom_icon.url).origin, new URL(app.url).origin);
  assert.equal(app.create_desktop_shortcut, true, 'Atendimento deve ter atalho por padrão, inclusive se já havia um legado');
  assert.equal(app.default_launch_container, 'window');
  assert.notEqual(app.install_as_shortcut, true, 'Permite atualizações do manifesto');
  const principal = politica[1];
  assert.equal(principal.custom_name, 'NoPulso');
  assert.equal(new URL(principal.url).pathname, '/');
  assert.equal(new URL(principal.custom_icon.url).pathname, '/icon-192.png');
  assert.equal(principal.custom_icon.hash, crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'public/icon-192.png'))).digest('hex'));
  assert.equal(principal.create_desktop_shortcut, true);
  assert.equal(principal.default_launch_container, 'window');
}
for (const windowsAntigo of [false, true]) {
  const src = montarScriptVigia({ codigo: 'TESTE', posto: 'TESTE', tipo: 'interno', agentToken: 'teste', windowsAntigo });
  const programa = `
$src = [Console]::In.ReadToEnd()
$erros = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($src, [ref]$null, [ref]$erros)
if ($erros.Count) { throw ($erros.Message -join '; ') }
$func = $ast.Find({param($a) $a -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -eq 'Instalar-SuporteNoPulso'}, $true)
# Avalia apenas os literais da política: nenhum comando de instalação é executado.
$url = ($func.Extent.Text -split "\n" | Where-Object { $_ -match '^  \\$urlApp = ' }) -join "\n"
$linha = ($func.Extent.Text -split "\n" | Where-Object { $_ -match '^  \\$appsNoPulso = ' }) -join "\n"
if (-not $url -or -not $linha) { throw 'Política não encontrada' }
. ([scriptblock]::Create($url))
$criarAtalho = $true
. ([scriptblock]::Create($linha))
ConvertTo-Json -InputObject @($appsNoPulso) -Depth 8 -Compress
$criarAtalho = $false
. ([scriptblock]::Create($linha))
ConvertTo-Json -InputObject @($appsNoPulso) -Depth 8 -Compress
`;
  const resultado = execFileSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', programa], { input: src, encoding: 'utf8', timeout: 15000 });
  const [nova, existente] = resultado.trim().split(/\r?\n/).map(JSON.parse);
  validarPolitica(nova);
  validarPolitica(existente);
  // Executa a função real contra registro/arquivos simulados. Não toca HKCU,
  // atalhos, perfis ou processos do computador que executa o teste.
  const simular = `
$ErrorActionPreference='Stop'
$src=[Console]::In.ReadToEnd(); $erros=$null
$ast=[System.Management.Automation.Language.Parser]::ParseInput($src,[ref]$null,[ref]$erros)
$func=$ast.Find({param($a) $a -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -eq 'Instalar-SuporteNoPulso'},$true)
function Get-Item { return @() }
function Get-ItemProperty { param($Path,$Name) if($Name -eq 'WebAppInstallForceList'){return @{WebAppInstallForceList=$global:politicaTeste}}; return @() }
function Test-Path { return $true }
function New-ItemProperty { param($Path,$Name,$Value) $global:destinosTeste+=@($Path);$global:politicaTeste=$Value }
function Set-Content {}
function Escrever-Log {}
function Remove-Item { throw 'Remocao inesperada' }
function Start-Process { throw 'Processo inesperado' }
$global:politicaTeste='[{"url":"https://app-terceiro.test/","custom_name":"Outro app"}]'
$global:destinosTeste=@()
$Servico=$false; $NaoInstalarAppNoPulso=$false
. ([scriptblock]::Create($func.Extent.Text))
Instalar-SuporteNoPulso
Instalar-SuporteNoPulso
$Servico=$true
Instalar-SuporteNoPulso
$Servico=$false; $NaoInstalarAppNoPulso=$true
Instalar-SuporteNoPulso
$NaoInstalarAppNoPulso=$false
function New-ItemProperty { throw 'Politica bloqueada no teste' }
$falhou=$false
try { Instalar-SuporteNoPulso } catch { $falhou=$true }
if(-not $falhou){throw 'Falha de instalacao nao pode marcar a versao como concluida'}
ConvertTo-Json -InputObject @{politica=($global:politicaTeste | ConvertFrom-Json);destinos=$global:destinosTeste} -Depth 10 -Compress
`;
  const resultadoSimulado = JSON.parse(execFileSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', simular], { input: src, encoding: 'utf8', timeout: 15000 }).trim());
  assert.equal(resultadoSimulado.politica.length, 3, 'Reaplicar não duplica apps e preserva terceiros');
  assert.equal(resultadoSimulado.politica[0].url, 'https://app-terceiro.test/');
  validarPolitica(resultadoSimulado.politica.slice(1));
  assert.equal(resultadoSimulado.destinos.length, 2, 'Só um navegador por execução; SYSTEM e máquinas excluídas não instalam');
  assert.equal(new Set(resultadoSimulado.destinos).size, 1);
  const quebrada = JSON.parse(JSON.stringify(nova));
  quebrada[0].custom_icon.hash = 'icone-errado';
  assert.throws(() => validarPolitica(quebrada), /Hash corresponde/);
  for (const indice of [0, 1]) {
    const semAtalho = JSON.parse(JSON.stringify(nova));
    semAtalho[indice].create_desktop_shortcut = false;
    assert.throws(() => validarPolitica(semAtalho), 'Sabotagem: desligar qualquer atalho precisa reprovar');
  }
  assert.match(src, /function Instalar-SuporteNoPulso \{\n  if \(\$Servico -or \$NaoInstalarAppNoPulso\) \{ return \}/);
  assert(src.includes('Atendimento NoPulso*.lnk') && src.includes('Suporte NoPulso*.lnk'), 'Reconhece o atalho novo e o antigo antes de criar outro');
  if (windowsAntigo) assert.match(src, /\$NaoInstalarAppNoPulso = \$true/);
  console.log('✓ Nome e logo amarela: política real, SHA256, identidade estável, atalho existente, sabotagem e parse ' + (windowsAntigo ? 'Windows antigo' : 'padrão'));
}
const bloqueado = montarScriptVigia({ codigo: 'TESTE', posto: 'HOST', tipo: 'interno', agentToken: 'teste', bloquearAppNoPulso: true });
assert.match(bloqueado, /\$NaoInstalarAppNoPulso = \$true/, 'VM/Host continuam sem instalação automática');
