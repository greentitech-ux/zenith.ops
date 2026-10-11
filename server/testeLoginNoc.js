'use strict';
// Sem rede, Firestore real ou alterações no computador. Auth e JWT são reais.
const assert = require('assert/strict');
const fs = require('fs');
const vm = require('vm');
const Module = require('module');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
process.env.JWT_SECRET = 'segredo-apenas-do-teste-login-noc';
const fonteUsers = fs.readFileSync(require.resolve('./users'), 'utf8');
const tagsDe = vm.runInNewContext(`${fonteUsers.match(/const CARGOS_VALIDOS = .*;/)[0]}\n${fonteUsers.slice(fonteUsers.indexOf('function tagsDe('), fonteUsers.indexOf('function temTag('))}\ntagsDe`);
const usuarios = new Map();
let computador = { agentToken: 'segredo-agente-do-teste', agenteVersao: 137 };
const doc = id => ({ id, exists: usuarios.has(id), data: () => usuarios.get(id), ref: { update: async patch => Object.assign(usuarios.get(id), patch) } });
const colecao = { doc: id => ({ get: async () => doc(id) }), where: (campo, operador, valor) => ({ limit: () => ({ get: async () => {
  const docs = [...usuarios].filter(([, u]) => u[campo] === valor).map(([id]) => doc(id));
  return { docs, empty: !docs.length };
} }) }) };
const originalLoad = Module._load;
Module._load = function(nome, parent, ...resto) {
  if (parent?.filename.endsWith('auth.js') && nome === './firestore') return { collection: () => colecao };
  if (parent?.filename.endsWith('auth.js') && nome === './sessions') return { criar: async () => ({ id: 'sessao-teste' }), existeEValida: async () => true, tocar: () => {} };
  if (parent?.filename.endsWith('auth.js') && nome === './empresas') return {};
  if (['auth.js', 'nocLogin.js'].some(n => parent?.filename.endsWith(n)) && nome === './masterHierarquia') return { ehPrincipal: async u => u?.id === 'principal' && u.role === 'master' && !u.qaMaster };
  if (parent?.filename.endsWith('nocLogin.js') && nome === './users') return { tagsDe };
  if (parent?.filename.endsWith('nocLogin.js') && nome === './lojaStatus') return { computadorParaLoginNoc: async (codigo, posto) => codigo === 'LOJA' && posto === 'PC' ? computador : null };
  return originalLoad.call(this, nome, parent, ...resto);
};
const noc = require('./nocLogin');
const auth = require('./auth');
const req = (cookie = '', ip = '203.0.113.1', ua = 'navegador-teste') => ({ ip, headers: { cookie, 'user-agent': ua } });
const bloqueado = e => e.code === 'COMPUTADOR_NOC_OBRIGATORIO';
async function middleware(token, pedido) {
  return new Promise((resolve, reject) => {
    const r = { ...pedido, headers: { ...pedido.headers, authorization: `Bearer ${token}` }, query: {} };
    const res = { status: codigo => ({ json: corpo => resolve({ codigo, corpo }) }) };
    auth.requireAuth(r, res, e => e ? reject(e) : resolve({ codigo: 200 }));
  });
}
(async () => {
  const pwsh = process.env.HYPERV_TEST_PWSH;
  assert.ok(pwsh, 'Defina HYPERV_TEST_PWSH para testar também o launcher Windows');
  const { montarScriptVigia } = require('./vigiaScript');
  for (const tipo of ['interno','atendimento']) for (const windowsAntigo of [false,true]) {
    const ps = montarScriptVigia({ codigo:'LOJA',posto:'PC',tipo,agentToken:'abcdef123456',windowsAntigo });
    const funcao = ps.slice(ps.indexOf('function Configurar-AcessoNoc {'),ps.indexOf('function Configurar-ChatUnidade('));
    const loop = ps.slice(ps.indexOf('function Rodar-Loop {'),ps.indexOf('if ($Loop) {'));
    assert.match(loop,/try \{ Configurar-AcessoNoc \}/, 'Auto-update também deve criar o atalho, sem reinstalação manual');
    assert.ok(funcao.indexOf('icacls.exe') < funcao.indexOf('WriteAllText'), 'Proteger arquivo antes de gravar segredo');
    assert.match(funcao,/\$semIcone = \$true/);
    assert.doesNotMatch(funcao,/CreateShortcut/, 'Nenhuma unidade recebe ícone de validação');
    const funcaoSemDisco = funcao
      .replaceAll('[Environment]::GetFolderPath("Desktop")', "'C:\\NocTeste\\Desktop'")
      .replaceAll('[Environment]::GetFolderPath("CommonDesktopDirectory")', "'C:\\NocTeste\\PublicDesktop'")
      .replace('[IO.File]::WriteAllText($arquivo, $conteudo, (New-Object Text.UTF8Encoding($true)))', 'Escrever-ArquivoTeste');
    assert.ok(!funcaoSemDisco.includes('[IO.File]::WriteAllText'));
    const verificarHost = texto => {
      const codigo = `
$ErrorActionPreference='Stop'
$WindowsAntigo=$${windowsAntigo}
$env:LOCALAPPDATA='C:\\NocTeste\\Local'
function Test-Path {param($LiteralPath) if($LiteralPath.StartsWith('HKLM:')){return $global:hyperv}; return $true}
function Remove-Item {param($LiteralPath,[switch]$Force,$ErrorAction)
 if($LiteralPath -notin @('C:\\NocTeste\\Desktop\\NoPulso - acesso NOC.lnk','C:\\NocTeste\\PublicDesktop\\NoPulso - acesso NOC.lnk')){throw 'Remocao fora do escopo'}
 $global:removidos++
}
function Escrever-Log {param($Texto)}
function Escrever-ArquivoTeste {$global:gravacoes++}
function icacls.exe {$global:LASTEXITCODE=0}
${texto}
foreach($c in @(@($true,$false,$false,$false),@($false,$true,$false,$false),@($false,$false,$true,$false),@($true,$false,$false,$true),@($false,$false,$false,$true))){
 $EhServidor=$c[0];$NaoInstalarAppNoPulso=$c[1];$global:hyperv=$c[2];$Servico=$c[3];$global:removidos=0;$global:gravacoes=0
 Configurar-AcessoNoc
 $esperados=2
 if($global:removidos -ne $esperados){throw 'Nao removeu somente os icones esperados'}
 if(($Servico -or $WindowsAntigo) -and $global:gravacoes -ne 0){throw 'SYSTEM e Windows antigo nao criam launcher de usuario'}
}
Write-Output 'HOST OK'
`;
      return require('child_process').spawnSync(pwsh,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(codigo,'utf16le').toString('base64')],{encoding:'utf8',timeout:15000});
    };
    const host = verificarHost(funcaoSemDisco);
    assert.equal(host.status,0,host.stderr);assert.match(host.stdout,/HOST OK/);
    const sabotado = verificarHost(funcaoSemDisco.replace('if ($semIcone) {', 'if ($false) {'));
    assert.notEqual(sabotado.status,0,'Sabotagem deve detectar tentativa de criar ícone no HOST');
    const b64 = funcao.match(/FromBase64String\("([^"]+)"\)/)[1];
    const launcher = Buffer.from(b64,'base64').toString('utf8');
    const destino = launcher.match(/StartsWith\('([^']+)'\)/)[1];
    const script = `
$texto=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))
$tokens=$null;$erros=$null
[Management.Automation.Language.Parser]::ParseInput($texto,[ref]$tokens,[ref]$erros)|Out-Null
if($erros.Count){throw ($erros|Out-String)}
$global:modo='valido';$global:aberto=''
function Invoke-RestMethod {param($Uri,$Method,$Headers,$ContentType,$Body,$TimeoutSec)
 if($Headers['X-NOC-Token'] -ne 'abcdef123456'){throw 'Token errado'}
 if($global:modo -eq 'valido'){return @{url='${destino}uso-unico'}}
 return @{url='https://invalid.example/roubo'}
}
function Start-Process {param($FilePath,$ArgumentList) $global:aberto=$ArgumentList}
Invoke-Expression $texto
if($global:aberto -ne '${destino}uso-unico'){throw 'Nao abriu vinculo oficial'}
$global:modo='errado';Invoke-Expression $texto
if($global:aberto -ne '${destino.split('#')[0]}'){throw 'Abriu destino nao autorizado'}
Write-Output 'OK'
`;
    const r = require('child_process').spawnSync(pwsh,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',timeout:15000});
    assert.equal(r.status,0,r.stderr); assert.match(r.stdout,/OK/);
  }
  const passwordHash = await bcrypt.hash('SenhaTeste123', 4);
  for (const [id, dados] of [['sem-tag', {}], ['tag-restrito', { cargo: 'operador' }], ['liberado', { cargo: 'tecnico', somenteNoc: false }], ['sem-tag-desmarcado', { somenteNoc: false }], ['principal', { role: 'master' }], ['outro-master', { role: 'master' }]]) {
    usuarios.set(id, { username: id, passwordHash, role: 'user', active: true, permissions: { sections: [], unidades: ['LOJA'] }, ...dados });
  }
  const servico = noc.servico();
  await assert.rejects(() => servico.emitir('LOJA', 'PC', 'errado', req()));
  const vinculo = await servico.emitir('LOJA', 'PC', computador.agentToken, req());
  const tokenComputador = await servico.consumir(vinculo, req());
  const confiavel = req(`${noc.COOKIE}=${tokenComputador}`);
  await assert.rejects(() => servico.consumir(vinculo, req()), 'Uso único');
  assert.ok(await servico.validarPedido(confiavel));
  assert.equal(await servico.validarPedido(req(confiavel.headers.cookie, '203.0.113.2')), null);
  assert.equal(await servico.validarPedido(req(confiavel.headers.cookie, undefined, 'outro-navegador')), null);
  assert.equal(await servico.validarPedido(req(`${noc.COOKIE}=inventado`)), null);
  const expirado = jwt.sign({ ...jwt.decode(tokenComputador), exp: Math.floor(Date.now() / 1000) - 1 }, process.env.JWT_SECRET);
  assert.equal(await servico.validarPedido(req(`${noc.COOKIE}=${expirado}`)), null);
  for (const id of ['sem-tag', 'tag-restrito', 'sem-tag-desmarcado', 'outro-master']) {
    await assert.rejects(() => auth.login(id, 'SenhaTeste123', { pedido: req() }), bloqueado);
    await assert.rejects(() => auth.loginComPasskey(id, { pedido: req() }), bloqueado);
    const entrada = await auth.login(id, 'SenhaTeste123', { pedido: confiavel });
    assert.ok((await auth.loginComPasskey(id, { pedido: confiavel })).token);
    // A prova NOC é exigida ao ENTRAR. Depois de emitida a sessão, ela segue
    // válida mesmo se o cookie/agente NOC não estiver presente na requisição.
    assert.equal((await middleware(entrada.token, req())).codigo, 200);
    assert.equal((await middleware(entrada.token, confiavel)).codigo, 200);
    assert.equal((await auth.usuarioOpcionalDoToken(entrada.token, req())).id, id);
    assert.equal((await auth.usuarioOpcionalDoToken(entrada.token, confiavel)).id, id);
  }
  for (const id of ['liberado', 'principal']) assert.ok((await auth.login(id, 'SenhaTeste123', { pedido: req() })).token);
  const junius = usuarios.get('tag-restrito');
  junius.permissions.unidades = ['SALTIVERSO_PATTEO'];
  const unidadeErrada = e => e.code === 'UNIDADE_NOC_NAO_AUTORIZADA';
  await assert.rejects(() => auth.login('tag-restrito','SenhaTeste123',{pedido:confiavel}), unidadeErrada);
  await assert.rejects(() => auth.loginComPasskey('tag-restrito',{pedido:confiavel}), unidadeErrada);
  junius.permissions.unidades = ['LOJA'];
  assert.ok((await auth.login('tag-restrito','SenhaTeste123',{pedido:confiavel})).token);
  junius.isAdmin=true;junius.permissions.unidades=[];
  await assert.rejects(() => auth.login('tag-restrito','SenhaTeste123',{pedido:confiavel}), unidadeErrada);
  junius.permissions.unidades=['LOJA'];
  assert.equal(noc.somenteNoc({ somenteNoc: false, cargos: ['inventada'] }, tagsDe({ cargos: ['inventada'] })), true);
  computador.agentToken = 'revogado';
  assert.equal(await servico.validarPedido(confiavel), null);
  computador={agentToken:'segredo-agente-do-teste',agenteVersao:141,windowsAntigo:true};
  assert.equal(await servico.validarPedido(confiavel),null,'Windows antigo é só monitoramento, não libera acesso NoPulso');
  await assert.rejects(()=>servico.emitir('LOJA','PC',computador.agentToken,req()));
  computador = null;
  assert.equal(await servico.validarPedido(confiavel), null);
  let tempo = 0;
  const curto = noc.criarServico({ segredo: 'teste', agora: () => tempo, lerComputador: async () => ({ agentToken: 'a', agenteVersao: 137 }) });
  const velho = await curto.emitir('LOJA', 'PC', 'a', req()); tempo = 120001;
  await assert.rejects(() => curto.consumir(velho, req()));
  // Sabotagem: remover a trava deve obrigatoriamente reprovar a expectativa.
  const originalExigir = noc.exigir;
  noc.exigir = async () => {};
  let detectada = false;
  try { await assert.rejects(() => auth.login('sem-tag', 'SenhaTeste123', { pedido: req() }), bloqueado); }
  catch { detectada = true; }
  finally { noc.exigir = originalExigir; }
  assert.ok(detectada, 'Teste deve detectar a remoção da trava no login real');
  console.log('✓ NOC: senha, passkey, sessões, login opcional, tags, Master, vínculo único, expiração, IP/navegador e revogação; sabotagem detectada.');
})().catch(e => { console.error(e); process.exitCode = 1; });
