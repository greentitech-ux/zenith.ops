'use strict';
const assert = require('assert/strict');
const { spawnSync } = require('child_process');
const { montarScriptVigia, montarComandoInstalacao, VERSAO_VIGIA } = require('./vigiaScript');
const pwsh = process.env.HYPERV_TEST_PWSH;
assert.ok(pwsh, 'Defina HYPERV_TEST_PWSH');
assert.ok(VERSAO_VIGIA >= 139);
for (const tipo of ['interno','atendimento','abastecimento']) {
  const config = {codigo:'TESTE',posto:'PC',tipo,agentToken:'abcdef',windowsAntigo:true,noPulsoPrint:true,acessoChatUnidade:true};
  const ps = montarScriptVigia(config);
  assert.match(ps,/\$WindowsAntigo = \$true/);
  assert.match(ps,/\$NaoInstalarAppNoPulso = \$true/);
  assert.doesNotMatch(ps,/function Reabrir-Monitor/, 'Windows antigo não depende de navegador para heartbeat');
  assert.match(ps,/Iniciar-VigiaDeTravamento \$UrlHeartbeat/);
  const nomes = ['Iniciar-ValidadorLocalNoc','Iniciar-NoPulsoPrint','Vigiar-TelaVazia','Forcar-PapelDeParedeDaConfig','Aplicar-PapelDeParede','Sincronizar-Politica','Iniciar-JanelaChat'];
  const prefixos = nomes.map(nome => {
    const inicio = ps.indexOf('function '+nome);
    assert.ok(inicio >= 0,nome);
    const linhas = ps.slice(inicio).split('\n');
    assert.match(linhas[1], /if \(\$WindowsAntigo\) \{ return/, nome+' deve parar antes de qualquer interface');
    return `${linhas[0]}\n${linhas[1]}\nthrow 'Interface exposta: ${nome}'\n}`;
  });
  function executar(defs) {
    const codigo = `$ErrorActionPreference='Stop';$WindowsAntigo=$true\n${defs.join('\n')}\n${nomes.map(n=>n+' | Out-Null').join('\n')}\nWrite-Output 'SILENCIOSO OK'`;
    return spawnSync(pwsh,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(codigo,'utf16le').toString('base64')],{encoding:'utf8',timeout:15000});
  }
  const resultado = executar(prefixos);
  assert.equal(resultado.status,0,resultado.stderr);assert.match(resultado.stdout,/SILENCIOSO OK/);
  const sabotagem = executar(prefixos.map(p=>p.replace('if ($WindowsAntigo)', 'if ($false)')));
  assert.notEqual(sabotagem.status,0,'Remover as guardas deve reprovar');
  assert.match(ps,/function Aplicar-NoPulsoPrint[^\n]+\n\s+if \(\$WindowsAntigo\) \{ \$habilitado = \$false; \$capturar = \$false \}/);
  assert.match(ps,/\$WindowsAntigo -or \$NaoInstalarAppNoPulso -or \$EhServidor/);
  assert.doesNotMatch(ps,/launcher da unidade|atalho configurado sem senha/);
  assert.match(montarComandoInstalacao({...config,ehServidor:true}), /-WindowStyle Hidden/);
  console.log(`✓ Windows antigo ${tipo}: sem interface automática, heartbeat próprio, instalador oculto e sabotagem detectada.`);
}
