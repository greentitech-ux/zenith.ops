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
assert(VERSAO_VIGIA >= 152);
assert.equal(manifesto.name, 'Atendimento NoPulso');
assert.equal(manifesto.id, '/central-beniboy-app', 'Trocar o nome não cria outro app');
assert.equal(manifesto.start_url, '/atendimento/central');
assert.match(fs.readFileSync(path.join(__dirname, 'public/atendimento.html'), 'utf8'), /<h1>Atendimento NoPulso<\/h1>/);
// atalho: pedido ao navegador SÓ quando ainda não existe nenhum. Com "true
// sempre", cada regravação da política (uma por versão do vigia) ganhava mais
// um "Atendimento NoPulso (n)" na Área de Trabalho - caso real da STT-SERVIDOR.
function validarPolitica(politica, atalhoAtendimento, atalhoNoPulso) {
  assert.equal(politica.length, 2, 'Dois apps distintos no mesmo navegador');
  const app = politica[0];
  assert.equal(new URL(app.url).pathname, '/atendimento/central', 'Preserva a URL instalada');
  assert.equal(app.custom_name, manifesto.name);
  assert.equal(app.custom_icon.hash, hash, 'Hash corresponde à logo publicada');
  assert.equal(new URL(app.custom_icon.url).pathname, '/beniboy-app-192.png');
  assert.equal(new URL(app.custom_icon.url).origin, new URL(app.url).origin);
  assert.equal(app.create_desktop_shortcut, atalhoAtendimento, 'Atendimento: atalho pedido só quando não há nenhum');
  assert.equal(app.default_launch_container, 'window');
  assert.notEqual(app.install_as_shortcut, true, 'Permite atualizações do manifesto');
  const principal = politica[1];
  assert.equal(principal.custom_name, 'NoPulso');
  assert.equal(new URL(principal.url).pathname, '/');
  assert.equal(new URL(principal.custom_icon.url).pathname, '/icon-192.png');
  assert.equal(principal.custom_icon.hash, crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'public/icon-192.png'))).digest('hex'));
  assert.equal(principal.create_desktop_shortcut, atalhoNoPulso, 'NoPulso: atalho pedido só quando não há nenhum');
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
$criarAtalhoAtendimento = $true; $criarAtalhoNoPulso = $true
. ([scriptblock]::Create($linha))
ConvertTo-Json -InputObject @($appsNoPulso) -Depth 8 -Compress
$criarAtalhoAtendimento = $false; $criarAtalhoNoPulso = $false
. ([scriptblock]::Create($linha))
ConvertTo-Json -InputObject @($appsNoPulso) -Depth 8 -Compress
`;
  const resultado = execFileSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', programa], { input: src, encoding: 'utf8', timeout: 15000 });
  const [nova, existente] = resultado.trim().split(/\r?\n/).map(JSON.parse);
  validarPolitica(nova, true, true);
  validarPolitica(existente, false, false);
  // Executa as funções reais contra registro/arquivos simulados. Não toca HKCU,
  // atalhos, perfis ou processos do computador que executa o teste.
  const simular = `
$ErrorActionPreference='Stop'
# fora do Windows nao ha LOCALAPPDATA; o Set-Content e falso, nada e gravado
if (-not $env:LOCALAPPDATA) { $env:LOCALAPPDATA = '/tmp/nopulso-teste-localappdata' }
$src=[Console]::In.ReadToEnd(); $erros=$null
$ast=[System.Management.Automation.Language.Parser]::ParseInput($src,[ref]$null,[ref]$erros)
foreach ($nome in @('Limpar-AtalhosDuplicadosNoPulso','Instalar-SuporteNoPulso')) {
  $f=$ast.Find({param($a) $a -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -eq $nome},$true)
  if (-not $f) { throw "Funcao $nome nao encontrada" }
  . ([scriptblock]::Create($f.Extent.Text))
}
# Get-Item de mentira: devolve os atalhos "do desktop" so pros padroes de Atendimento
function Get-Item { if ((@($args | ForEach-Object { $_ }) -join ' ') -match 'Atendimento NoPulso') { return $global:atalhosFalsos }; return @() }
function Get-ItemProperty { param($Path,$Name) if($Name -eq 'WebAppInstallForceList'){return @{WebAppInstallForceList=$global:politicaTeste}}; return @() }
function Test-Path { return $true }
function New-ItemProperty { param($Path,$Name,$Value) $global:destinosTeste+=@($Path);$global:politicaTeste=$Value }
function Set-Content {}
function Escrever-Log {}
function Remove-Item { param($LiteralPath) if (-not $LiteralPath) { throw 'Remocao inesperada' }; $global:removidosTeste+=@($LiteralPath) }
function Start-Process { throw 'Processo inesperado' }
function atalho($nome, $min) { [pscustomobject]@{ BaseName=$nome; Name="$nome.lnk"; FullName="C:\\fake\\$nome.lnk"; LastWriteTime=(Get-Date).AddMinutes($min) } }
$global:politicaTeste='[{"url":"https://app-terceiro.test/","custom_name":"Outro app"}]'
$global:destinosTeste=@(); $global:removidosTeste=@(); $global:atalhosFalsos=@()
$Servico=$false; $NaoInstalarAppNoPulso=$false
Instalar-SuporteNoPulso
Instalar-SuporteNoPulso
$semAtalho = $global:politicaTeste
$Servico=$true
Instalar-SuporteNoPulso
$Servico=$false; $NaoInstalarAppNoPulso=$true
Instalar-SuporteNoPulso
$NaoInstalarAppNoPulso=$false
# a STT-SERVIDOR: o original e tres copias numeradas (a (2) e a mais antiga de todas)
$global:atalhosFalsos=@((atalho 'Atendimento NoPulso (1)' -20), (atalho 'Atendimento NoPulso' -10), (atalho 'Atendimento NoPulso (2)' -30), (atalho 'Atendimento NoPulso (3)' -5))
Instalar-SuporteNoPulso
$comAtalho = $global:politicaTeste
$removidos = @($global:removidosTeste)
function New-ItemProperty { throw 'Politica bloqueada no teste' }
$falhou=$false
try { Instalar-SuporteNoPulso } catch { $falhou=$true }
if(-not $falhou){throw 'Falha de instalacao nao pode marcar a versao como concluida'}
ConvertTo-Json -InputObject @{semAtalho=($semAtalho | ConvertFrom-Json);comAtalho=($comAtalho | ConvertFrom-Json);destinos=$global:destinosTeste;removidos=$removidos} -Depth 10 -Compress
`;
  const sim = JSON.parse(execFileSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', simular], { input: src, encoding: 'utf8', timeout: 15000 }).trim());
  assert.equal(sim.semAtalho.length, 3, 'Reaplicar não duplica apps e preserva terceiros');
  assert.equal(sim.semAtalho[0].url, 'https://app-terceiro.test/');
  validarPolitica(sim.semAtalho.slice(1), true, true);
  // com 4 atalhos de Atendimento no desktop: ficam só com o de nome limpo, as
  // cópias "(n)" saem, e a política NÃO pede outro atalho de Atendimento
  // (o de NoPulso, que não existe, continua sendo pedido)
  assert.deepEqual([...sim.removidos].sort(), ['C:\\fake\\Atendimento NoPulso (1).lnk', 'C:\\fake\\Atendimento NoPulso (2).lnk', 'C:\\fake\\Atendimento NoPulso (3).lnk'], 'Sobra um atalho só, o de nome limpo - mesmo não sendo o mais antigo');
  validarPolitica(sim.comAtalho.slice(1), false, true);
  assert.equal(sim.destinos.length, 3, 'Só um navegador por execução; SYSTEM e máquinas excluídas não instalam');
  assert.equal(new Set(sim.destinos).size, 1);
  const quebrada = JSON.parse(JSON.stringify(nova));
  quebrada[0].custom_icon.hash = 'icone-errado';
  assert.throws(() => validarPolitica(quebrada, true, true), /Hash corresponde/);
  for (const indice of [0, 1]) {
    const semAtalho = JSON.parse(JSON.stringify(nova));
    semAtalho[indice].create_desktop_shortcut = false;
    assert.throws(() => validarPolitica(semAtalho, true, true), 'Sabotagem: sem nenhum atalho, a política tem de pedir');
    const comAtalho = JSON.parse(JSON.stringify(existente));
    comAtalho[indice].create_desktop_shortcut = true;
    assert.throws(() => validarPolitica(comAtalho, false, false), 'Sabotagem: já havendo atalho, pedir outro multiplica os ícones');
  }
  assert.match(src, /function Instalar-SuporteNoPulso \{\n  if \(\$Servico -or \$NaoInstalarAppNoPulso\) \{ return \}/);
  assert(src.includes('Atendimento NoPulso*.lnk') && src.includes('Suporte NoPulso*.lnk'), 'Reconhece o atalho novo e o antigo antes de criar outro');
  // o Chrome cria o atalho DEPOIS, ao ler a política: a limpeza precisa rodar
  // de tempos em tempos no laço (os dois laços: interno e atendimento), não só na instalação
  assert.match(src, /\[void\]\(Limpar-AtalhosDuplicadosNoPulso\)/, 'Limpeza periódica das cópias no laço do tipo interno');
  const srcAtendimento = montarScriptVigia({ codigo: 'TESTE', posto: 'TESTE', tipo: 'atendimento', agentToken: 'teste', windowsAntigo });
  assert.match(srcAtendimento, /\[void\]\(Limpar-AtalhosDuplicadosNoPulso\)/, 'Limpeza periódica das cópias no laço do tipo atendimento');
  if (windowsAntigo) assert.match(src, /\$NaoInstalarAppNoPulso = \$true/);
  console.log('✓ Nome e logo amarela: política real, SHA256, identidade estável, atalho só quando falta, cópias numeradas limpas, sabotagem e parse ' + (windowsAntigo ? 'Windows antigo' : 'padrão'));
}
const bloqueado = montarScriptVigia({ codigo: 'TESTE', posto: 'HOST', tipo: 'interno', agentToken: 'teste', bloquearAppNoPulso: true });
assert.match(bloqueado, /\$NaoInstalarAppNoPulso = \$true/, 'VM/Host continuam sem instalação automática');
