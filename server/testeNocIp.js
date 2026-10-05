'use strict';
const assert = require('node:assert/strict');
const { avaliarUnidade, criarMonitor } = require('./nocIp');
const { sanitizarDispositivos, mesclarDispositivos } = require('./nocMaquina');

async function testar(avaliar = avaliarUnidade) {
  const mac = 'a4:2b:b0:99:88:11', outro = 'a4:2b:b0:99:88:22';
  const cfg = { [mac]: { tipo: 'totem', apelido: 'Totem' } };
  let agora = 1800000000000;
  const obs = (ip, extras = {}, posto = 'A') => ({ codigo: 'RECIFE', posto, ultimoHeartbeatEm: agora,
    dispositivos: [{ mac, ip, ativo: true, visto: agora, estadoVizinho: 'Reachable', ...extras }] });
  let s = avaliar({}, [obs('192.168.18.217')], cfg, agora);
  assert.equal(s[mac].ip, '192.168.18.217');
  assert.equal(s[mac].eventoPendente, undefined);
  agora += 60000;
  const foto = [obs('192.168.18.226'), obs('192.168.18.226', {}, 'B')];
  s = avaliar(s, foto, cfg, agora);
  assert.equal(s[mac].ip, '192.168.18.217', 'dois computadores na mesma rodada não são duas coletas');
  agora += 60000;
  s = avaliar(s, foto, cfg, agora);
  assert.equal(s[mac].eventoPendente, undefined, 'reprocessar a mesma coleta não confirma');
  s = avaliar(s, [obs('192.168.18.226')], cfg, agora);
  assert.equal(s[mac].eventoPendente.para, '192.168.18.226');
  assert.equal(s[mac].sequencia, 1);
  const confirmado = JSON.parse(JSON.stringify(s));
  assert.deepEqual(avaliar(s, [obs('192.168.18.226')], cfg, agora), s);
  s = { [mac]: { ...s[mac], eventoPendente: null } };
  for (const estadoVizinho of ['Stale', 'Permanent', null]) {
    assert.deepEqual(avaliar(s, [obs('192.168.18.217', { estadoVizinho })], cfg, agora), s);
  }
  assert.deepEqual(avaliar(s, [obs('192.168.18.217', { visto: agora - 31 * 60000 })], cfg, agora), s);
  assert.deepEqual(avaliar(s, [{ ...obs('192.168.18.217'), ultimoHeartbeatEm: agora - 6 * 60000 }], cfg, agora), s);
  assert.deepEqual(avaliar(s, [obs('192.168.18.217', { ipConflitante: true })], cfg, agora), s);
  assert.deepEqual(avaliar(s, [obs('192.168.18.217'), obs('192.168.18.226', {}, 'B')], cfg, agora), s);
  // Ida, volta e nova ida são três eventos diferentes, mesmo após reinício.
  for (const [ip, sequencia] of [['192.168.18.217', 2], ['192.168.18.226', 3]]) {
    agora += 60000; s = avaliar(s, [obs(ip)], cfg, agora);
    agora += 60000; s = avaliar(s, [obs(ip)], cfg, agora);
    assert.equal(s[mac].sequencia, sequencia);
    assert.equal(s[mac].eventoPendente.para, ip);
    s[mac].eventoPendente = null;
  }
  assert.deepEqual(avaliar({}, [obs('192.168.18.217')], {}, agora), {}, 'sem categoria não alarma');

  const linhas = [{ mac, ip: '192.168.18.217', estadoVizinho: 'Stale' }, { mac, ip: '192.168.18.226', estadoVizinho: 'Reachable' }];
  for (const lista of [linhas, [...linhas].reverse()]) {
    const d = sanitizarDispositivos(lista)[0];
    assert.equal(d.ip, '192.168.18.226');
    assert.equal(d.estadoVizinho, 'Reachable');
  }
  const conflito = sanitizarDispositivos(linhas.map(d => ({ ...d, estadoVizinho: 'Reachable' })))[0];
  assert.equal(conflito.ipConflitante, true);
  const merge = mesclarDispositivos([], sanitizarDispositivos(linhas), agora);
  assert.equal(merge.dispositivos[0].estadoVizinho, 'Reachable');
  assert.equal(mesclarDispositivos(merge.dispositivos, sanitizarDispositivos([linhas[0]]), agora + 1).mudaramIp.length, 0);
  const antigo = mesclarDispositivos(merge.dispositivos, sanitizarDispositivos([linhas[0]]), agora + 1);
  assert.equal(mesclarDispositivos(antigo.dispositivos, sanitizarDispositivos(linhas), agora + 2).mudaramIp.length, 0, 'cache velho não inventa outra troca no histórico');

  const banco = new Map(); let escritas = 0;
  const db = { collection: () => ({ doc: id => ({ id, get: async () => ({ data: () => banco.get(id) }) }) }),
    runTransaction: async fn => fn({ get: r => r.get(), set: (r, dados) => { escritas++; banco.set(r.id, structuredClone(dados)); } }) };
  let monitor = criarMonitor(db);
  const configs = { RECIFE: cfg };
  assert.equal((await monitor.varrer([obs('192.168.18.217')], configs, agora)).length, 0);
  const n = escritas;
  await monitor.varrer([obs('192.168.18.217')], configs, agora);
  assert.equal(escritas, n, 'sem alteração não escreve');
  agora += 60000;
  await monitor.varrer([obs('192.168.18.226'), obs('192.168.18.226', {}, 'B')], configs, agora);
  agora += 60000;
  const evento = (await monitor.varrer([obs('192.168.18.226')], configs, agora))[0];
  assert.ok(evento.eventoId.includes(mac));
  monitor = criarMonitor(db); // deploy/restart antes de entregar o alerta
  const reenvio = (await monitor.varrer([obs('192.168.18.226')], configs, agora))[0];
  assert.equal(reenvio.eventoId, evento.eventoId, 'pendência persistida e chave idempotente');
  await monitor.confirmar(reenvio);
  assert.equal((await monitor.varrer([obs('192.168.18.226')], configs, agora)).length, 0);
  // Mesmo nome, outro MAC e outra unidade não compartilham estado.
  assert.equal(Object.keys(avaliar({}, [obs('192.168.18.9', { mac: outro })], { ...cfg, [outro]: cfg[mac] }, agora)).length, 1);
  assert.equal((await monitor.varrer([{ ...obs('192.168.18.90'), codigo: 'OUTRA' }], { OUTRA: cfg }, agora)).length, 0);
  assert.equal(confirmado[mac].eventoPendente.de, '192.168.18.217');
  await testarPush();
}

async function testarPush() {
  // Executa os corpos reais com serviços locais: não envia push nem acessa Firestore.
  const fs = require('node:fs');
  const extrair = (arquivo, nome) => {
    const src = fs.readFileSync(__dirname + '/' + arquivo, 'utf8');
    const ini = src.indexOf('async function ' + nome + '(');
    return src.slice(ini, src.indexOf('\nasync function ', ini + 10));
  };
  const registros = new Map(); const enviados = [];
  const collection = { doc: id => ({ id }) };
  const db = { runTransaction: async fn => fn({ get: async r => ({ exists: registros.has(r.id) }), set: (r, d) => registros.set(r.id, d) }) };
  const registrarUnico = new Function('COLLECTION', 'crypto', 'db', 'cache', 'invalidarIncremental',
    extrair('alertasCentral.js', 'registrarUnico') + '\nreturn registrarUnico;')
    (collection, require('node:crypto'), db, { invalidar() {} }, () => {});
  const notify = new Function('alertasCentral', 'PUBLIC_KEY', 'PRIVATE_KEY', 'loadSubs', 'podeReceberCritico', 'webpush', 'removeSubscription',
    extrair('push.js', 'notifyDispositivoIpMudou') + '\nreturn notifyDispositivoIpMudou;')
    ({ registrarUnico }, 'teste', 'teste', async () => [{}], () => true, { sendNotification: async (sub, payload) => enviados.push(JSON.parse(payload)) }, async () => {});
  const args = ['Recife', 'RECIFE', 'Totem', 'Totem', '.217', '.226', 'a4:2b:b0:99:88:11', 'evento1'];
  await notify(...args); await notify(...args);
  assert.equal(registros.size, 1); assert.equal(enviados.length, 1);
  await notify(...[...args.slice(0, 6), 'a4:2b:b0:99:88:22', 'evento2']);
  assert.equal(enviados.length, 2);
  assert.notEqual(enviados[0].tag, enviados[1].tag, 'Totens de mesmo nome não colidem');
  assert.doesNotMatch(enviados[0].body, /trabalho continua|Atualize no servidor/);
  // Callback repetido pelo Firestore: a tentativa abortada não pode dar push.
  db.runTransaction = async fn => {
    await fn({ get: async () => ({ exists: false }), set() {} });
    return fn({ get: async () => ({ exists: true }), set() { throw new Error('não deve sobrescrever'); } });
  };
  assert.equal((await registrarUnico({ chave: 'concorrente', tipo: 'noc-ip', titulo: 'teste' })).novo, false);
}

if (require.main === module) testar().then(() => console.log('✓ NOC IP: confirmação, cache antigo, conflitos, deduplicação e reinício')).catch(e => { console.error(e); process.exitCode = 1; });
module.exports = { testar };
