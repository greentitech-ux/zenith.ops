'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const base = path.join(__dirname, 'public');
let fonte = fs.readFileSync(path.join(base, 'moeda-br.js'), 'utf8');
if (process.argv.includes('--sabotagem')) fonte = fonte.replace('useGrouping: true', 'useGrouping: false');
const navegador = vm.createContext({});
vm.runInContext(fonte, navegador);
const api = navegador.NoPulsoMoeda;
const casos = [[0,'R$ 0,00'],[50,'R$ 50,00'],[999.99,'R$ 999,99'],[1000,'R$ 1.000'],[1000.1,'R$ 1.000,10'],[13780,'R$ 13.780'],[4090,'R$ 4.090'],[1000000,'R$ 1.000.000'],[1000000.01,'R$ 1.000.000,01'],[-1000,'-R$ 1.000'],[-1000.1,'-R$ 1.000,10'],[999.999,'R$ 1.000'],[-0,'R$ 0,00'],[-0.001,'R$ 0,00'],['1000.10','R$ 1.000,10'],[null,'R$ 0,00'],[undefined,'R$ 0,00'],[NaN,'R$ 0,00'],[Infinity,'R$ 0,00']];
for (const [n, esperado] of casos) assert.equal(api.formatar(n), esperado, String(n));
const servidor = require('./public/moeda-br');
for (const [n] of casos) assert.equal(servidor.formatar(n), api.formatar(n), 'mesma apresentação no servidor e navegador');
assert.equal(api.formatar(1234.5678,4),'R$ 1.234,5678','precisão do custo unitário preservada');
assert.equal(api.numero(1000.1),'1.000,10');
const pagamento = { valor:1000.1, moeda:'BRL' }, original = JSON.stringify(pagamento);
api.formatar(pagamento.valor);assert.equal(JSON.stringify(pagamento),original);
let paginas = 0, formatadores = 0;
for(const arquivo of fs.readdirSync(base).filter(f=>f.endsWith('.html'))){
  const html=fs.readFileSync(path.join(base,arquivo),'utf8');
  if(!/<head\b/i.test(html))continue;
  assert.equal((html.match(/<script src="\/moeda-br.js"><\/script>/g)||[]).length,1,arquivo+' carrega o formatador uma vez');
  assert(html.indexOf('/moeda-br.js')<html.indexOf('</head>'),arquivo+' inicializa antes dos scripts da página');
  for(const b of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))new vm.Script(b[1],{filename:arquivo});
  // Executa as funções reais das telas, não cópias do teste.
  for(const m of html.matchAll(/function (fmtMoneyBR|fmtMoney|fmtReal)\((\w+)\)\{([^\n]+)\}/g)){
    if(!m[3].includes('NoPulsoMoeda.'))continue;
    const ctx=vm.createContext({NoPulsoMoeda:api});vm.runInContext(m[0],ctx);
    assert.equal(ctx[m[1]](1000.1),'R$ 1.000,10',arquivo);
    assert.equal(ctx[m[1]](13780),'R$ 13.780',arquivo);
    formatadores++;
  }
  paginas++;
}
assert(formatadores>=25,'cobertura das telas monetárias');
const index = fs.readFileSync(path.join(__dirname,'index.js'),'utf8');
assert(index.match(/const ROTAS_PUBLICAS_SEM_DASHBOARD = new Set\(\[([\s\S]*?)\]\);/)[1].includes("'/moeda-br.js'"),'telas públicas carregam o formatador sem autenticação');
assert(!/toFixed\(2\)/.test(fs.readFileSync(path.join(base,'parque.html'),'utf8').match(/function fmtReal[^\n]+/)[0]));
console.log(`✓ Moeda BR: ${casos.length} casos, paridade servidor/navegador, ${paginas} páginas e ${formatadores} formatadores reais; dados originais preservados.`);
