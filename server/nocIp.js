// Um endereço confirmado por unidade/MAC, não um alarme por observador.
// ARP Stale/Permanent e agentes antigos não comprovam presença recente.
const { createKeyedCache } = require('./liveCache');
const crypto = require('crypto');
const FRESCOR_MS = 30 * 60 * 1000;
const CONFIRMACAO_MS = 30 * 1000;
const CANDIDATO_TTL_MS = 2 * 60 * 60 * 1000;

function avaliarUnidade(anterior, docs, configuracoes, agora) {
  const estado = { ...(anterior || {}) };
  for (const [mac, cfg] of Object.entries(configuracoes)) {
    if (!cfg.tipo) continue;
    const antes = estado[mac] || {};
    const observacoes = docs.flatMap((doc) => {
      const heartbeat = Number(doc.ultimoHeartbeatEm);
      if (!(heartbeat > 0 && heartbeat <= agora && agora - heartbeat <= 5 * 60 * 1000)) return [];
      return (doc.dispositivos || []).filter((d) => d.mac === mac && d.ativo
        && d.estadoVizinho === 'Reachable' && d.ip && d.visto > 0
        && d.visto <= agora && agora - d.visto <= FRESCOR_MS);
    });
    const ips = new Set(observacoes.map((d) => d.ip));
    // Observadores discordantes (ou múltiplos IPs no mesmo adaptador): não
    // escolher pela ordem de chegada. Esperar evidência sem conflito.
    if (ips.size !== 1 || observacoes.some((d) => d.ipConflitante)) {
      if (antes.candidato) estado[mac] = { ...antes, candidato: null };
      continue;
    }
    const ip = [...ips][0];
    const visto = Math.max(...observacoes.map((d) => d.visto));
    if (!antes.ip) {
      // Primeira leitura após implantação é linha de base silenciosa.
      estado[mac] = { ip, confirmadoEm: visto, sequencia: 0, candidato: null };
    } else if (ip === antes.ip) {
      if (antes.candidato) estado[mac] = { ...antes, candidato: null };
    } else if (!antes.eventoPendente && visto > antes.confirmadoEm) {
      const candidato = antes.candidato;
      if (!candidato || candidato.ip !== ip || agora - candidato.em > CANDIDATO_TTL_MS) {
        estado[mac] = { ...antes, candidato: { ip, em: visto } };
      } else if (visto - candidato.em >= CONFIRMACAO_MS) {
        // Outra coleta, não uma segunda execução do timer sobre a mesma foto.
        const sequencia = (antes.sequencia || 0) + 1;
        estado[mac] = {
          ip, confirmadoEm: visto, sequencia, candidato: null,
          eventoPendente: { mac, de: antes.ip, para: ip, sequencia, confirmadoEm: visto },
        };
      }
    }
  }
  return estado;
}

function criarMonitor(db) {
  const ref = (codigo) => db.collection('nocIpUnidades').doc(crypto.createHash('sha256').update(codigo).digest('hex'));
  // Uma leitura por unidade a cada 10 min, não uma consulta por MAC/timer.
  const cache = createKeyedCache(async (codigo) => (await ref(codigo).get()).data()?.estado || {}, 10 * 60 * 1000);
  async function varrer(docs, configuracoes, agora = Date.now()) {
    const eventos = [];
    for (const [codigo, configs] of Object.entries(configuracoes)) {
      if (!Object.values(configs).some((c) => c.tipo)) continue;
      const daUnidade = docs.filter((d) => d.codigo === codigo);
      if (!daUnidade.length) continue;
      let estado = await cache.cached(codigo);
      const proximo = avaliarUnidade(estado, daUnidade, configs, agora);
      if (JSON.stringify(proximo) !== JSON.stringify(estado)) {
        // Transação evita duas instâncias/timers confirmarem a mesma troca.
        estado = await db.runTransaction(async (tx) => {
          const r = ref(codigo);
          const atual = (await tx.get(r)).data()?.estado || {};
          const novo = avaliarUnidade(atual, daUnidade, configs, agora);
          if (JSON.stringify(atual) !== JSON.stringify(novo)) tx.set(r, { codigo, estado: novo });
          return novo;
        });
        cache.invalidar(codigo);
      }
      for (const [mac, s] of Object.entries(estado)) {
        if (!s.eventoPendente || !configs[mac]?.tipo) continue;
        const cfg = configs[mac];
        eventos.push({ ...s.eventoPendente, codigo, tipo: 'dispositivo-ip-mudou',
          apelido: cfg.apelido, tipoDispositivo: cfg.tipo, tipoRotulo: cfg.tipoRotulo,
          eventoId: `noc-ip:${codigo}:${mac}:${s.eventoPendente.sequencia}` });
      }
    }
    return eventos;
  }
  async function confirmar(evento) {
    await db.runTransaction(async (tx) => {
      const r = ref(evento.codigo);
      const dados = (await tx.get(r)).data();
      const s = dados?.estado?.[evento.mac];
      if (s?.eventoPendente?.sequencia !== evento.sequencia) return;
      tx.set(r, { ...dados, estado: { ...dados.estado, [evento.mac]: { ...s, eventoPendente: null } } });
    });
    cache.invalidar(evento.codigo);
  }
  return { varrer, confirmar };
}

module.exports = { avaliarUnidade, criarMonitor };
