// local.js
// ZENITH OPS NA SUA MÁQUINA - sem Firebase, sem credencial, sem custo.
//
// Sobe o index.js DE VERDADE (as mesmas rotas, o mesmo login, as mesmas
// telas) contra um Firestore de mentira que vive só na memória do processo.
// Nada aqui toca a produção: não há credencial configurada, então não há
// como falar com o banco real nem por acidente.
//
//   cd server && npm run local
//   abre http://localhost:3000
//   entra com  master@local  /  local123
//
// Fechou o terminal, os dados somem. Rodou de novo, volta o cenário de
// exemplo abaixo. É de propósito: você testa sempre do mesmo ponto de
// partida, e pode quebrar o que quiser sem medo.
//
// Quando precisar de um Firestore que se comporta EXATAMENTE como o de
// produção (índices compostos, transações, regras), use o emulador oficial
// em vez deste arquivo - ver server/DESENVOLVIMENTO.md.
'use strict';
const Module = require('module');
const origLoad = Module._load;

// ---- o Firestore de mentira (mesmo motor do testeRotas.js) ----
const DOCS = new Map();
function snapDoc(caminho) {
  const dados = DOCS.get(caminho);
  return { exists: dados !== undefined, id: caminho.split('/').pop(), data: () => dados, ref: { path: caminho } };
}
function fakeQuery(caminho, filtros = [], ordem = null, lim = null) {
  const q = {
    where: (campo, op, valor) => fakeQuery(caminho, [...filtros, { campo, op, valor }], ordem, lim),
    orderBy: (campo, dir) => fakeQuery(caminho, filtros, { campo, dir }, lim),
    limit: (n) => fakeQuery(caminho, filtros, ordem, n),
    offset: () => q, startAfter: () => q, select: () => q,
    get: async () => {
      let docs = [...DOCS.entries()].filter(([k]) => k.startsWith(caminho + '/')).map(([k]) => snapDoc(k));
      for (const f of filtros) {
        docs = docs.filter((d) => {
          const v = (d.data() || {})[f.campo];
          if (f.op === '==') return v === f.valor;
          if (f.op === '!=') return v !== f.valor;
          if (f.op === '<') return v < f.valor;
          if (f.op === '<=') return v <= f.valor;
          if (f.op === '>') return v > f.valor;
          if (f.op === '>=') return v >= f.valor;
          if (f.op === 'in') return Array.isArray(f.valor) && f.valor.includes(v);
          if (f.op === 'array-contains') return Array.isArray(v) && v.includes(f.valor);
          return true;
        });
      }
      if (ordem) docs.sort((a, b) => {
        const x = (a.data() || {})[ordem.campo]; const y = (b.data() || {})[ordem.campo];
        const c = x < y ? -1 : x > y ? 1 : 0;
        return ordem.dir === 'desc' ? -c : c;
      });
      if (lim != null) docs = docs.slice(0, lim);
      return { empty: !docs.length, size: docs.length, docs, forEach: (fn) => docs.forEach(fn) };
    },
    doc: (id) => fakeDoc(`${caminho}/${id || 'auto' + Math.random().toString(36).slice(2)}`),
    add: async (d) => { const p = `${caminho}/auto${DOCS.size}`; DOCS.set(p, d); return fakeDoc(p); },
    onSnapshot: () => () => {},
  };
  return q;
}
function fakeDoc(caminho) {
  return {
    id: caminho.split('/').pop(), path: caminho,
    get: async () => snapDoc(caminho),
    set: async (d, o) => { DOCS.set(caminho, o && o.merge ? { ...(DOCS.get(caminho) || {}), ...d } : d); },
    update: async (d) => { DOCS.set(caminho, { ...(DOCS.get(caminho) || {}), ...d }); },
    delete: async () => { DOCS.delete(caminho); },
    collection: (n) => fakeQuery(`${caminho}/${n}`),
  };
}
const fakeDb = {
  collection: (n) => fakeQuery(n),
  batch: () => {
    const ops = [];
    const b = {
      set: (r, d, o) => { ops.push(() => { const c = r.path || ''; DOCS.set(c, o && o.merge ? { ...(DOCS.get(c) || {}), ...d } : d); }); return b; },
      update: (r, d) => { ops.push(() => { const c = r.path || ''; DOCS.set(c, { ...(DOCS.get(c) || {}), ...d }); }); return b; },
      delete: (r) => { ops.push(() => DOCS.delete(r.path || '')); return b; },
      commit: async () => { ops.forEach((f) => f()); ops.length = 0; },
    };
    return b;
  },
  runTransaction: async (fn) => fn({
    get: async (r) => snapDoc(r.path || ''),
    set: (r, d, o) => { const c = r.path || ''; DOCS.set(c, o && o.merge ? { ...(DOCS.get(c) || {}), ...d } : d); },
    update: (r, d) => { const c = r.path || ''; DOCS.set(c, { ...(DOCS.get(c) || {}), ...d }); },
    delete: (r) => { DOCS.delete(r.path || ''); },
  }),
};

// arquivos (fotos, PDFs, anexos) tambem ficam so na memoria
const ARQUIVOS = new Map();
const bucketFake = {
  file: (caminho) => ({
    save: async (buffer) => { ARQUIVOS.set(caminho, Buffer.from(buffer)); },
    download: async () => {
      if (!ARQUIVOS.has(caminho)) throw new Error('arquivo não existe: ' + caminho);
      return [ARQUIVOS.get(caminho)];
    },
    createReadStream: () => require('stream').Readable.from([ARQUIVOS.get(caminho) || Buffer.alloc(0)]),
    delete: async () => { ARQUIVOS.delete(caminho); },
  }),
  getFiles: async () => [[]],
};

Module._load = function (req) {
  if (req === './firestore') return fakeDb;
  if (req === './storageBucket') return { resolverBucket: async () => bucketFake, comBucket: async (fn) => fn(bucketFake) };
  return origLoad.apply(this, arguments);
};

// ---- credenciais de brincadeira (nenhuma delas existe em produção) ----
process.env.PORT = process.env.PORT || '3000';
process.env.MASTER_EMAIL = 'master@local';
process.env.MASTER_PASSWORD = 'local123';
process.env.JWT_SECRET = 'local-nao-vale-nada-0123456789abcdef';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY
  || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DASHBOARD_USER = 'local';
process.env.DASHBOARD_PASS = 'local';
// jobs periodicos mais espacados aqui - no local eles so fazem barulho
process.env.NOC_VARREDURA_MS = process.env.NOC_VARREDURA_MS || '600000';

// ---- cenário de exemplo, pra tela não nascer vazia ----
const UNIDADES = ['Dominos Bessa', 'Dominos Tirol', 'Dominos Caruaru', 'Spoleto Shopping Recife', '19888', '19889'];
const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
UNIDADES.forEach((u, i) => {
  for (let p = 1; p <= 3; p++) {
    DOCS.set(`lojaStatus/${(u + '__pc' + p).replace(/[^\w]/g, '_')}`, {
      codigo: u, posto: 'pc' + p, nome: `PC ${p}`, tipo: p === 1 ? 'interno' : 'atendimento',
      // uma maquina de cada loja entra "caida", pra dar o que olhar no NOC
      ultimoHeartbeatEm: p === 3 ? Date.now() - 30 * 60000 : Date.now(),
      criadoEm: Date.now() - 864e5, eventos: [], ipHistorico: [], chatMensagens: [], dispositivos: [],
      ip: `189.0.0.${i * 3 + p}`, ipLocal: `172.20.17.${i * 3 + p}`,
    });
  }
  DOCS.set(`fechamentosLive/f-${i}`, {
    id: `f-${i}`, unidade: u, unidadeNome: u, data: hoje,
    faturamento: 3000 + i * 850, totalDeclarado: 3000 + i * 850, diferenca: i === 2 ? -37.5 : 0,
    gerente: 'Gerente ' + (i + 1), criadoEm: new Date().toISOString(),
  });
  DOCS.set(`solicitacoes/s-${i}`, {
    id: `s-${i}`, tipo: i % 2 ? 'compra' : 'manutencao', unidade: u, unidadeNome: u,
    descricao: 'Solicitação de exemplo ' + (i + 1), status: i % 3 ? 'PENDENTE' : 'APROVADO',
    criadoEm: new Date().toISOString(), criadoPorEmail: 'loja@local', ticket: 10000 + i,
  });
});

console.log('\n' + '='.repeat(64));
console.log('  ZENITH OPS - AMBIENTE LOCAL (não toca em produção)');
console.log('='.repeat(64));
console.log(`  http://localhost:${process.env.PORT}`);
console.log('  usuário: master@local     senha: local123');
console.log('');
console.log('  Firestore: em memória (0 leituras cobradas)');
console.log('  Dados: cenário de exemplo, recriado a cada start');
console.log('='.repeat(64) + '\n');

require('./index.js');
