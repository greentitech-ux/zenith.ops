'use strict';
// Testa a configuração REAL e o desenho REAL do agente, sem rede/produção.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const { montarScriptVigia } = require('./vigiaScript');
async function main() {
  const fonte = fs.readFileSync(path.join(__dirname, 'lojaStatus.js'), 'utf8');
  const inicio = fonte.indexOf('async function configuracaoAgente(');
  let codigo = fonte.slice(inicio, fonte.indexOf('\nfunction sanitizarItensVisuais', inicio));
  if (process.argv.includes('--sabotagem')) codigo = codigo.replace('!arte || arte.preservarModelo === true', '!arte');
  let arte = null;
  const doc = { nome: 'SBRAZ-ILHA-PDV.01', politica: { papelDeParedeAtivo: true }, politicaVersao: 8 };
  const contexto = vm.createContext({
    COLLECTION: { doc: () => ({ get: async () => ({ exists: true, data: () => doc }) }) },
    docIdFor: () => 'teste', exigirTokenSeTiver: () => {}, capturaPendente: () => false,
    sanitizarPolitica: x => x, normalizarAtalhoNoPulsoPrint: () => null,
    papelDeParedeDe: async () => arte,
    logosDaUnidade: async () => ({ marca: 'saobraz', versao: 4, logoMarca: { versao: 3 }, logoGrupo: { versao: 2 } }),
    versaoAplicacao: (v, a) => `${v}.${a?.versao || 0}`,
    versaoModeloBasicoDe: (v, d) => `6.${v}|${d.nome}`,
    linhaDoCarimbo: () => 'SÃO BRAZ · ILHA DO LEITE', unidades: { MARCAS_LABEL: { saobraz: 'São Braz' } },
  });
  vm.runInContext(codigo, contexto);
  const cfg = () => contexto.configuracaoAgente('ilha', 'pdv', 'teste');
  assert.equal((await cfg()).modeloBasico.fundoVersao, null);
  arte = { caminho: 'storage/fundo', versao: 100, preservarModelo: true };
  const comFundo = await cfg();
  assert.equal(comFundo.papelDeParedeSemArte, true);
  assert.equal(comFundo.modeloBasico.fundoVersao, '100');
  assert.equal(comFundo.modeloBasico.logoMarca, true);
  assert.equal(comFundo.modeloBasico.logoGrupo, true);
  assert.equal(comFundo.modeloBasico.maquina, doc.nome);
  assert.match(comFundo.versaoModeloBasico, /\|fundo:100$/);
  arte.versao = 101;
  assert.notEqual((await cfg()).versaoModeloBasico, comFundo.versaoModeloBasico);
  arte.preservarModelo = false;
  assert.equal((await cfg()).modeloBasico, null, 'Arte completa continua compatível');
  doc.politica.papelDeParedeAtivo = false;
  assert.equal((await cfg()).modeloBasico.fundoVersao, null, 'Desligado não baixa campanha');
  const html = fs.readFileSync(path.join(__dirname, 'public/loja-status.html'), 'utf8');
  const envio = html.slice(html.indexOf('async function enviarPapelDeParede()'), html.indexOf('async function removerPapelDeParedeAtual()'));
  assert.match(envio, /fd\.append\('preservarModelo'/);
  for (const bloco of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(bloco[1]);
  const script = montarScriptVigia({ codigo: 'ilha', posto: 'pdv', tipo: 'interno', agentToken: 'teste', maquinaNome: doc.nome });
  const extrair = nome => {
    const a = script.indexOf(`function ${nome}`);
    assert.ok(a >= 0, nome);
    const b = script.indexOf('\nfunction ', a + 1);
    return script.slice(a, b < 0 ? undefined : b);
  };
  const desenho = extrair('Desenhar-ModeloBasico');
  assert.ok(desenho.indexOf('$imgFundo =') < desenho.indexOf('$img = Abrir-ImagemSemTravar $arqGrupo'), 'Fundo antes das logos');
  assert.match(desenho, /Desenhar-ContatoSuporte/);
  const pasta = path.resolve(__dirname, '../docs/varredura/papel-fundo-modelo');
  fs.mkdirSync(pasta, { recursive: true });
  const ps = path.join(pasta, 'teste.ps1');
  const lit = s => `'${s.replace(/'/g, "''")}'`;
  const fundo = process.env.FUNDO_MODELO_TESTE;
  const logo = process.env.LOGO_MODELO_TESTE;
  if (!fundo || !logo) throw new Error('Informe FUNDO_MODELO_TESTE e LOGO_MODELO_TESTE para validar o desenho.');
  const grupo = path.join(__dirname, 'public/grupo-bravo.png');
  const funcoes = ['Nova-FonteCarimbo', 'Retangulo-RedondoCarimbo', 'Abrir-ImagemSemTravar', 'Desenhar-ImagemNaCaixa', 'Cor-DeFundoDoLogo', 'Texto-Centralizado', 'Desenhar-ContatoSuporte', 'Desenhar-ModeloBasico'].map(extrair).join('\n');
  const antigo = montarScriptVigia({ codigo: 'ilha', posto: 'pdv', tipo: 'interno', agentToken: 'teste', windowsAntigo: true });
  fs.writeFileSync(path.join(pasta, 'normal.ps1'), script);
  fs.writeFileSync(path.join(pasta, 'antigo.ps1'), antigo);
  fs.writeFileSync(ps, `$ErrorActionPreference='Stop'\n${funcoes}\nfunction Tamanho-TelaPrincipal { return @(1920,1080) }\n$modelo=[pscustomobject]@{maquina='SBRAZ-ILHA-PDV.01';linha='SÃO BRAZ · ILHA DO LEITE';marcaRotulo='São Braz'}\nDesenhar-ModeloBasico ${lit(path.join(pasta, 'campanha-1920.png'))} $modelo ${lit(logo)} ${lit(grupo)} ${lit(fundo)}\nDesenhar-ModeloBasico ${lit(path.join(pasta, 'padrao-1920.png'))} $modelo ${lit(logo)} ${lit(grupo)}\nforeach($p in @(${lit(path.join(pasta, 'normal.ps1'))},${lit(path.join(pasta, 'antigo.ps1'))})) { $e=$null; $t=$null; [System.Management.Automation.Language.Parser]::ParseFile($p,[ref]$t,[ref]$e) | Out-Null; if($e.Count){ throw ($e | Out-String) } }\n`, 'utf8');
  const r = spawnSync(process.env.PWSH_TESTE || 'powershell', ['-NoProfile', '-File', ps], { encoding: 'utf8' });
  if (r.error) throw r.error;
  assert.equal(r.status, 0, r.stdout + r.stderr);
  console.log('OK: configuração real, legado, desligado, versões, upload, desenho real e sintaxe PowerShell normal/antigo.');
  console.log(path.join(pasta, 'campanha-1920.png'));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
