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
function validarPolitica(politica, criar) {
  assert.equal(politica.length, 1);
  const app = politica[0];
  assert.equal(new URL(app.url).pathname, '/atendimento/central', 'Preserva a URL instalada');
  assert.equal(app.custom_name, manifesto.name);
  assert.equal(app.custom_icon.hash, hash, 'Hash corresponde à logo publicada');
  assert.equal(new URL(app.custom_icon.url).pathname, '/beniboy-app-192.png');
  assert.equal(new URL(app.custom_icon.url).origin, new URL(app.url).origin);
  assert.equal(app.create_desktop_shortcut, criar);
  assert.equal(app.default_launch_container, 'window');
  assert.notEqual(app.install_as_shortcut, true, 'Permite atualizações do manifesto');
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
$linha = ($func.Extent.Text -split "\n" | Where-Object { $_ -match '^  \\$politica = ' }) -join "\n"
if (-not $url -or -not $linha) { throw 'Política não encontrada' }
. ([scriptblock]::Create($url))
$criarAtalho = $true
. ([scriptblock]::Create($linha))
Write-Output $politica
$criarAtalho = $false
. ([scriptblock]::Create($linha))
Write-Output $politica
`;
  const resultado = execFileSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', programa], { input: src, encoding: 'utf8', timeout: 15000 });
  const [nova, existente] = resultado.trim().split(/\r?\n/).map(JSON.parse);
  validarPolitica(nova, true);
  validarPolitica(existente, false);
  const quebrada = JSON.parse(JSON.stringify(nova));
  quebrada[0].custom_icon.hash = 'icone-errado';
  assert.throws(() => validarPolitica(quebrada, true), /Hash corresponde/);
  assert.match(src, /function Instalar-SuporteNoPulso \{\n  if \(\$Servico -or \$NaoInstalarAppNoPulso\) \{ return \}/);
  assert(src.includes('Atendimento NoPulso*.lnk') && src.includes('Suporte NoPulso*.lnk'), 'Reconhece o atalho novo e o antigo antes de criar outro');
  if (windowsAntigo) assert.match(src, /\$NaoInstalarAppNoPulso = \$true/);
  console.log('✓ Nome e logo amarela: política real, SHA256, identidade estável, atalho existente, sabotagem e parse ' + (windowsAntigo ? 'Windows antigo' : 'padrão'));
}
const bloqueado = montarScriptVigia({ codigo: 'TESTE', posto: 'HOST', tipo: 'interno', agentToken: 'teste', bloquearAppNoPulso: true });
assert.match(bloqueado, /\$NaoInstalarAppNoPulso = \$true/, 'VM/Host continuam sem instalação automática');
