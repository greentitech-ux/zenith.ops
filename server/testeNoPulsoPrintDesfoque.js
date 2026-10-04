const assert = require('assert/strict');
const fs = require('fs');
const vm = require('vm');
const { spawnSync } = require('child_process');
const { montarScriptVigia, VERSAO_VIGIA } = require('./vigiaScript');
assert.ok(VERSAO_VIGIA >= 136);
const index = fs.readFileSync(require.resolve('./index'), 'utf8');
const inicio = index.indexOf("app.post('/api/loja-status/heartbeat'");
const fim = index.indexOf('res.json(', inicio);
const rota = index.slice(inicio, index.indexOf('\n', fim));
async function conferirAtalho(fonte, atalho) {
  const registrar = fonte.match(/const \{[^\n]+\} = await lojaStatus\.heartbeat\([\s\S]*?\}, token\);/)[0];
  const responder = fonte.match(/res\.json\([^\n]+/)[0];
  let resposta;
  const ctx = { req: { body: {} }, token: 'teste', ip: 'teste', lojaStatus: { heartbeat: async () => ({ noPulsoPrint: true, noPulsoPrintAtalho: atalho }) }, res: { json: v => resposta = v } };
  vm.createContext(ctx);
  await vm.runInContext(`(async()=>{${registrar}\n${responder}})()`, ctx);
  assert.equal(resposta.noPulsoPrintAtalho, atalho);
}
(async () => {
  for (const atalho of ['ctrl_q', 'ctrl_alt_q', 'ctrl_alt_p', 'ctrl_shift_p']) await conferirAtalho(rota, atalho);
  await assert.rejects(conferirAtalho(rota.replaceAll(', noPulsoPrintAtalho', ''), 'ctrl_alt_q'), 'Sabotagem do heartbeat');
  const pwsh = process.env.HYPERV_TEST_PWSH;
  assert.ok(pwsh, 'Defina HYPERV_TEST_PWSH');
  for (const tipo of ['interno', 'atendimento']) for (const windowsAntigo of [false, true]) {
    const ps = montarScriptVigia({ codigo: 'TESTE', posto: 'PRINT', tipo, windowsAntigo, agentToken: 'teste' });
    assert.match(ps, /\$btDesfoque\.Add_Click/);
    assert.match(ps, /Desenhar-Marcas \$e.Graphics \$s.Tag.marcas 0 0 \$s.Tag.captura/);
    assert.match(ps, /Desenhar-Marcas \$gMarcas[^\n]+\$imagem/);
    const funcoes = ps.slice(ps.indexOf('      function Desfocar-AreaPrint'), ps.indexOf('      function Normalizar-AreaPrint'));
    const codigo = `
$tokens=$null;$erros=$null
$texto=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(ps).toString('base64')}'))
[Management.Automation.Language.Parser]::ParseInput($texto,[ref]$tokens,[ref]$erros)|Out-Null
if($erros.Count){throw ($erros|Out-String)}
Add-Type -AssemblyName System.Drawing
${funcoes}
$original=New-Object System.Drawing.Bitmap(80,80)
for($y=0;$y -lt 80;$y++){for($x=0;$x -lt 80;$x++){ $cor=if(($x+$y)%2){[Drawing.Color]::Black}else{[Drawing.Color]::White};$original.SetPixel($x,$y,$cor)}}
$preview=$original.Clone();$gp=[Drawing.Graphics]::FromImage($preview)
$marca=@{tipo='desfoque';x1=60;y1=60;x2=20;y2=20}
Desenhar-Marcas $gp @($marca) 0 0 $original
$gp.Dispose()
if($preview.GetPixel(0,0).ToArgb() -ne $original.GetPixel(0,0).ToArgb()){throw 'Alterou fora da area'}
if($preview.GetPixel(32,32).ToArgb() -eq $original.GetPixel(32,32).ToArgb()){throw 'Nao aplicou mosaico'}
$area=New-Object Drawing.Rectangle(10,10,60,60)
$recorte=$original.Clone($area,$original.PixelFormat);$gr=[Drawing.Graphics]::FromImage($recorte)
Desenhar-Marcas $gr @($marca) -10 -10 $original
$gr.Dispose()
for($y=20;$y -lt 60;$y++){for($x=20;$x -lt 60;$x++){if($preview.GetPixel($x,$y).ToArgb() -ne $recorte.GetPixel(($x-10),($y-10)).ToArgb()){throw 'Previa difere da exportacao'}}}
if($original.GetPixel(32,32).ToArgb() -ne [Drawing.Color]::White.ToArgb()){throw 'Origem alterada; desfazer quebrado'}
$semMarcas=$original.Clone();$gs=[Drawing.Graphics]::FromImage($semMarcas)
Desenhar-Marcas $gs @() 0 0 $original
$gs.Dispose()
if($semMarcas.GetPixel(32,32).ToArgb() -ne $original.GetPixel(32,32).ToArgb()){throw 'Desfazer nao restaura'}
$original.Dispose();$preview.Dispose();$recorte.Dispose();$semMarcas.Dispose()
Write-Output 'OK'
`;
    const entrada = '& ([scriptblock]::Create([Console]::In.ReadToEnd()))';
    const executar = c => spawnSync(pwsh, ['-NoProfile', '-EncodedCommand', Buffer.from(entrada, 'utf16le').toString('base64')], { input: c, encoding: 'utf8', timeout: 30000 });
    const r = executar(codigo);
    assert.equal(r.status, 0, r.stderr || r.error?.message);
    assert.match(r.stdout, /OK/);
    if (tipo === 'interno' && !windowsAntigo) assert.notEqual(executar(codigo.replace('Desfocar-AreaPrint $g $origem $m $dx $dy; continue', 'continue')).status, 0, 'Sabotagem do mosaico');
    console.log(`NoPulsoPrint: ${tipo}, antigo=${windowsAntigo}: parser e mosaico OK`);
  }
  console.log('Heartbeat preserva os quatro atalhos; mosaico exportado corresponde à prévia; desfazer e sabotagens OK. Sem captura real.');
})().catch(e => { console.error(e); process.exitCode = 1; });
