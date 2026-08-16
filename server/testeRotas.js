// testeRotas.js
// Sobe o index.js DE VERDADE contra um Firestore falso, faz login como
// Master e bate nas rotas. Rodar assim (nao precisa de credencial nenhuma):
//
//   cd server && JWT_SECRET=teste1234567890abcdefghijklmnopqrstuv \
//     ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
//     node testeRotas.js
//
// POR QUE EXISTE: `node --check` so pega erro de SINTAXE. Uma funcao que
// nao existe (ex: chamar podeVerAbastecimento() sem ter definido) passa
// batido e so quebra em producao - e, se a chamada estiver fora do
// try/catch de uma rota async, o Express 4 nem devolve 500: a requisicao
// fica PENDURADA e a tela some sem erro nenhum no console do navegador.
// Foi exatamente isso que derrubou o pre-envio em 16/08.
//
// Testar a rota por um servidor mock (respondendo o JSON na mao) nao
// resolve: prova tudo, menos o codigo do index.js que e quem quebra.
// Aqui a requisicao passa pelo registro de rota, pelo middleware de auth e
// pelo corpo do handler reais.
const Module = require('module');
const origLoad = Module._load;

// ---- Firestore falso: qualquer método encadeia, toda leitura vem vazia ----
const DOCS = new Map(); // caminho -> dados (o que o teste semear fica aqui)
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
  batch: () => ({ set() {}, update() {}, delete() {}, commit: async () => {} }),
  runTransaction: async (fn) => fn({ get: async (r) => snapDoc(r.path || ''), set() {}, update() {}, delete() {} }),
};

process.env.PORT = '8899';
process.env.DASHBOARD_USER = 'x';
process.env.DASHBOARD_PASS = 'x';
process.env.MASTER_EMAIL = 'master@teste.local';
process.env.MASTER_PASSWORD = 'SenhaDeTeste!2026';

Module._load = function (req, parent, isMain) {
  if (req === './firestore') return fakeDb;
  if (req === './storageBucket') return { resolverBucket: async () => { throw new Error('sem storage no teste'); } };
  return origLoad.apply(this, arguments);
};

// silencia o barulho do boot (jobs periódicos, relatórios) sem esconder erro
const errOrig = console.error;
console.error = (...a) => { if (/Falha ao|Erro ao|AVISO/.test(String(a[0]))) return; errOrig(...a); };

require('/home/user/adyen-monitor/server/index.js');

// ---- exercita as rotas novas com um Master de mentira ----
const http = require('http');
const auth = require('/home/user/adyen-monitor/server/auth.js');

function pedir(caminho, headers = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: 8899, path: caminho, headers }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, corpo: b }));
    });
    req.on('error', (e) => resolve({ status: 0, corpo: e.message }));
    req.setTimeout(4000, () => { req.destroy(); resolve({ status: -1, corpo: 'TIMEOUT (requisição pendurada)' }); });
    req.end();
  });
}

// POST multipart de verdade (o widget do chat passou a mandar assim SEMPRE,
// com ou sem arquivo - o risco a cobrir e a abertura sem anexo ter quebrado)
function postarMultipart(caminho, campos, arquivo) {
  const B = '----zenithteste' + Math.random().toString(36).slice(2);
  const partes = [];
  Object.entries(campos).forEach(([k, v]) => {
    partes.push(Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  });
  if (arquivo) {
    partes.push(Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="anexo"; filename="${arquivo.nome}"\r\nContent-Type: ${arquivo.tipo}\r\n\r\n`));
    partes.push(arquivo.buffer);
    partes.push(Buffer.from('\r\n'));
  }
  partes.push(Buffer.from(`--${B}--\r\n`));
  const corpo = Buffer.concat(partes);
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: 8899, path: caminho, method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${B}`, 'Content-Length': corpo.length },
    }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, corpo: b })); });
    req.on('error', (e) => resolve({ status: 0, corpo: e.message }));
    req.setTimeout(5000, () => { req.destroy(); resolve({ status: -1, corpo: 'TIMEOUT' }); });
    req.end(corpo);
  });
}

function postarJson(caminho, corpoObj, headers = {}) {
  const corpo = Buffer.from(JSON.stringify(corpoObj));
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: 8899, path: caminho, method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': corpo.length },
    }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, corpo: b })); });
    req.on('error', (e) => resolve({ status: 0, corpo: e.message }));
    req.setTimeout(5000, () => { req.destroy(); resolve({ status: -1, corpo: 'TIMEOUT (requisição pendurada)' }); });
    req.end(corpo);
  });
}

setTimeout(async () => {
  // sessão de Master direto no módulo de auth (não passa pelo login)
  // login de verdade (ensureMaster criou o Master no Firestore falso no boot)
  let token = null;
  try {
    const r = await auth.login(process.env.MASTER_EMAIL, process.env.MASTER_PASSWORD);
    token = r && r.token;
  } catch (e) { console.log('login falhou: ' + e.message); }
  console.log(token ? 'token obtido ✓' : 'SEM TOKEN - as rotas vao devolver 401');

  // semeia uma CONTAGEM pra sugestao ter base (e o caso do usuario:
  // "tem uma contagem, por que nao tem pre-envio?")
  DOCS.set('abastecimentoCarrinho/ct1', {
    id: 'ct1', tipo: 'CONTAGEM', criadoEm: new Date().toISOString(),
    pizzas: { calabresa: 4, pepperoni: 2, mussarela: 0 }, insumos: [], operadorNome: 'Ana',
  });

  // um computador com medicao de link, pro diagnostico de rede ter o que
  // devolver (ver redeDiagnostico.js)
  const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
  DOCS.set('lojaStatus/AERO__ATM01', {
    codigo: 'AERO', posto: 'ATM01', nome: 'AEROCar-ATM01', tipo: 'interno',
    ultimoHeartbeatEm: Date.now(), eventos: [],
    redeDia: {
      dia: hoje, amostras: 40, somaLatencia: 40 * 900, maxLatencia: 4200, lentas: 12, falhas: 3,
      somaGateway: 40 * 120, amostrasGateway: 40, somaPerdaGateway: 40 * 9,
      somaWan: 40 * 45, amostrasWan: 40, somaPerdaWan: 0,
      somaSinal: 0, amostrasSinal: 0, minSinal: null, conexao: 'cabo',
    },
  });

  const casos = [
    ['/api/abastecimento/sugestao-envio', 'sugestão de pré-envio'],
    ['/api/abastecimento/fluxo?inicio=2026-08-10&fim=2026-08-16', 'fluxo dia a dia'],
    ['/api/abastecimento/capacidades', 'capacidades'],
    ['/api/loja-status/rede', 'diagnóstico de rede'],
    ['/api/users/sugerir-acesso?nomeCompleto=Priscila%20Pereira&dominio=grupobravoempresarial.com', 'sugerir acesso (email+usuário)'],
  ];
  let ruins = 0;
  for (const [rota, nome] of casos) {
    const r = await pedir(rota, token ? { Authorization: 'Bearer ' + token } : {});
    // 401/403 = rota EXISTE e o gate rodou (o que importa aqui é não estourar
    // ReferenceError nem pendurar). -1/500 = quebrou de verdade.
    const ok = r.status === 200;
    if (!ok) ruins += 1;
    console.log(`${ok ? '✓' : '✗'} ${nome}: HTTP ${r.status} ${r.corpo.slice(0, 120)}`);
  }
  // --- abertura do chat de suporte ---
  const semAnexo = await postarMultipart('/api/suporte-chat/iniciar',
    { nome: 'Well', contato: 'well@x.com', texto: 'não consigo entrar', assunto: 'Acesso/Senha' });
  const okSem = semAnexo.status === 200 && /"token"/.test(semAnexo.corpo);
  if (!okSem) ruins += 1;
  console.log(`${okSem ? '✓' : '✗'} abrir chat SEM anexo (multipart): HTTP ${semAnexo.status} ${semAnexo.corpo.slice(0, 90)}`);

  // arquivo de tipo proibido tem que ser RECUSADO na abertura, igual já é na
  // mensagem - o formulário é público, sem login
  const proibido = await postarMultipart('/api/suporte-chat/iniciar',
    { nome: 'Well', contato: 'well@x.com', texto: 'segue anexo', assunto: 'Acesso/Senha' },
    { nome: 'virus.exe', tipo: 'application/x-msdownload', buffer: Buffer.from('MZ') });
  const okProibido = proibido.status === 400;
  if (!okProibido) ruins += 1;
  console.log(`${okProibido ? '✓' : '✗'} anexo de tipo proibido é recusado: HTTP ${proibido.status} ${proibido.corpo.slice(0, 90)}`);

  // --- criar acesso copiando permissoes (botao do ticket de Suporte de TI) ---
  // sem modeloId tem que recusar com 400 e mensagem clara, NAO estourar 500
  // nem pendurar. E o caminho que mais me preocupa: essa rota chama
  // centralChat.addMessage, e um nome de funcao errado ali so aparece aqui.
  const semModelo = await postarJson('/api/users/criar-copiando',
    { email: 'x.y@teste.local', username: 'xytest', senha: 'SenhaProvisoria1' },
    token ? { Authorization: 'Bearer ' + token } : {});
  const okSemModelo = semModelo.status === 400 && /modelo/i.test(semModelo.corpo);
  if (!okSemModelo) ruins += 1;
  console.log(`${okSemModelo ? '✓' : '✗'} criar acesso sem modelo é recusado: HTTP ${semModelo.status} ${semModelo.corpo.slice(0, 90)}`);

  console.log(ruins ? `\n${ruins} rota(s) com problema` : '\nTodas as rotas responderam sem estourar.');
  process.exit(ruins ? 1 : 0);
}, 2500);
