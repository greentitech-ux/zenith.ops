const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

async function main() {
  const fonte = fs.readFileSync(path.join(__dirname, 'lojaStatus.js'), 'utf8');
  const inicio = fonte.indexOf('async function carregarEspelho()');
  const fim = fonte.indexOf('// ---------------------------------------------------------------------', inicio);
  let bloco = fonte.slice(inicio, fim);
  if (process.argv.includes('--sabotagem')) bloco = bloco.replace('if (!cargaEspelhoEmCurso)', 'if (true)');
  let consultas = 0;
  const pendentes = [];
  const c = vm.createContext({
    espelho: null, espelhoEm: 0, cargaEspelhoEmCurso: null, geracaoEspelho: 0,
    ESPELHO_TTL_MS: 600000, CAMPOS_DO_HEARTBEAT: ['ultimoHeartbeatEm', 'ip'],
    migrarLegado: async () => false,
    COLLECTION: { get: () => { consultas++; return new Promise((resolve, reject) => pendentes.push({ resolve, reject })); } },
  });
  vm.runInContext(bloco, c);
  const snapshot = () => ({ docs: [{ id: 'pdv', data: () => ({ ultimoHeartbeatEm: 1, ip: 'antigo' }) }] });
  const chamadas = Array.from({ length: 30 }, () => c.garantirEspelho());
  assert.equal(consultas, 1, '30 chamadas precisam compartilhar a consulta');
  pendentes.shift().resolve(snapshot());
  const resultados = await Promise.all(chamadas);
  assert.ok(resultados.every(r => r === resultados[0]));
  await c.garantirEspelho();
  assert.equal(consultas, 1, 'cache válido não consulta');

  c.invalidarEspelho();
  const recarga = c.garantirEspelho();
  c.espelho.set('pdv', { ultimoHeartbeatEm: 10, ip: 'novo' });
  c.invalidarEspelho();
  pendentes.shift().resolve(snapshot());
  await recarga;
  assert.equal(c.espelho.get('pdv').ultimoHeartbeatEm, 10, 'heartbeat recente preservado');
  assert.equal(c.espelho.get('pdv').ip, 'novo');
  assert.equal(c.espelhoEm, 0, 'invalidação durante consulta não pode desaparecer');
  const falha = c.garantirEspelho();
  const erro = assert.rejects(falha, /indisponivel/);
  pendentes.shift().reject(new Error('indisponivel'));
  await erro;
  const tentativa = c.garantirEspelho();
  assert.equal(consultas, 4, 'falha permite nova tentativa');
  pendentes.shift().resolve(snapshot());
  await tentativa;
  assert.ok(fonte.includes('if (transicoes.length) cacheBase.invalidar();'));
  console.log('OK: concorrência, cache, heartbeat durante carga, invalidação durante carga e recuperação de falha.');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
