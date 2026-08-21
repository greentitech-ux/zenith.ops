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
// contador de DOCUMENTOS lidos - e assim que o Firestore cobra (a conta do
// mes e por documento devolvido, nao por chamada). Permite testar consumo de
// leitura de verdade, e nao so "a rota respondeu": ver o teste do cache de
// sessao la embaixo, que sem isso passaria igual com ou sem o cache
const LEITURAS = { docs: 0 };
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
      // consulta que nao devolve nada ainda custa 1 leitura no Firestore real
      LEITURAS.docs += docs.length || 1;
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
    get: async () => { LEITURAS.docs += 1; return snapDoc(caminho); },
    set: async (d, o) => { DOCS.set(caminho, o && o.merge ? { ...(DOCS.get(caminho) || {}), ...d } : d); },
    update: async (d) => { DOCS.set(caminho, { ...(DOCS.get(caminho) || {}), ...d }); },
    delete: async () => { DOCS.delete(caminho); },
    collection: (n) => fakeQuery(`${caminho}/${n}`),
  };
}
const fakeDb = {
  collection: (n) => fakeQuery(n),
  batch: () => ({ set() {}, update() {}, delete() {}, commit: async () => {} }),
  // set/update GRAVAM de verdade - eram no-op, e isso fazia o fake mentir:
  // ticketCounter.proximoTicket() grava o próximo número DENTRO da
  // transação, então com set() vazio todo mundo lia 10000 e o teste não
  // conseguia enxergar número repetido nem sequência quebrada.
  runTransaction: async (fn) => fn({
    get: async (r) => snapDoc(r.path || ''),
    set: (r, d, o) => { const c = r.path || ''; DOCS.set(c, o && o.merge ? { ...(DOCS.get(c) || {}), ...d } : d); },
    update: (r, d) => { const c = r.path || ''; DOCS.set(c, { ...(DOCS.get(c) || {}), ...d }); },
    delete: (r) => { DOCS.delete(r.path || ''); },
  }),
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
const store = require('/home/user/adyen-monitor/server/store.js');
const parque = require('/home/user/adyen-monitor/server/parque.js');
const sheetsSync = require('/home/user/adyen-monitor/server/sheetsSync.js');

// PDF chega como binário e o pdfkit ainda comprime os streams - juntar
// chunks numa string (como o `pedir` faz) corrompe os bytes. Este aqui
// preserva o buffer, e textoDoPdf desinfla e remonta o texto pra dar pra
// conferir o que foi realmente IMPRESSO, não só que a rota respondeu 200.
function pedirBinario(caminho, headers = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: 8899, path: caminho, headers }, (res) => {
      const pedacos = [];
      res.on('data', (c) => pedacos.push(c));
      res.on('end', () => resolve({ status: res.statusCode, buffer: Buffer.concat(pedacos) }));
    });
    req.on('error', () => resolve({ status: 0, buffer: Buffer.alloc(0) }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ status: -1, buffer: Buffer.alloc(0) }); });
    req.end();
  });
}
function textoDoPdf(b) {
  const zlib = require('zlib');
  let bruto = ''; let i = 0;
  while ((i = b.indexOf('stream', i)) >= 0) {
    let ini = i + 6; if (b[ini] === 13) ini += 1; if (b[ini] === 10) ini += 1;
    const fim = b.indexOf('endstream', ini); if (fim < 0) break;
    try { bruto += zlib.inflateSync(b.subarray(ini, fim)).toString('latin1'); } catch (e) { /* stream não comprimido (imagem etc) */ }
    i = fim + 9;
  }
  // cada [<hex> num <hex> ...] TJ é UMA palavra fatiada pelo kerning: junta
  // só os pedaços hex e ignora os números de espaçamento entre eles
  return bruto.replace(/\[([^\]]*)\]\s*TJ/g, (_, dentro) =>
    (dentro.match(/<([0-9A-Fa-f]*)>/g) || [])
      .map((h) => Buffer.from(h.slice(1, -1), 'hex').toString('latin1')).join('') + ' ');
}

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
// nomeCampo/headers sao opcionais: o chat manda "anexo" sem auth, a leitura
// de Canais manda "imagem" com Bearer - mesma montagem de corpo
function postarMultipart(caminho, campos, arquivo, nomeCampo = 'anexo', headers = {}) {
  const B = '----zenithteste' + Math.random().toString(36).slice(2);
  const partes = [];
  Object.entries(campos).forEach(([k, v]) => {
    partes.push(Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  });
  // aceita 1 arquivo ou uma lista: a leitura do relatorio do PDV manda
  // varias fotos com o MESMO nome de campo (ver /api/fechamentos/ler-canais)
  (arquivo ? [].concat(arquivo) : []).forEach((a) => {
    partes.push(Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="${nomeCampo}"; filename="${a.nome}"\r\nContent-Type: ${a.tipo}\r\n\r\n`));
    partes.push(a.buffer);
    partes.push(Buffer.from('\r\n'));
  });
  partes.push(Buffer.from(`--${B}--\r\n`));
  const corpo = Buffer.concat(partes);
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: 8899, path: caminho, method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${B}`, 'Content-Length': corpo.length, ...headers },
    }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, corpo: b })); });
    req.on('error', (e) => resolve({ status: 0, corpo: e.message }));
    req.setTimeout(5000, () => { req.destroy(); resolve({ status: -1, corpo: 'TIMEOUT' }); });
    req.end(corpo);
  });
}

// mesmo postarJson, so que PUT (rota de apelido de dispositivo)
function putJson(caminho, corpoObj, headers = {}) {
  return enviarJson('PUT', caminho, corpoObj, headers);
}
function postarJson(caminho, corpoObj, headers = {}) {
  return enviarJson('POST', caminho, corpoObj, headers);
}
function enviarJson(metodo, caminho, corpoObj, headers = {}) {
  const corpo = Buffer.from(JSON.stringify(corpoObj));
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: 8899, path: caminho, method: metodo,
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
    ['/api/loja-status/maquinas', 'saúde das máquinas (HD + rede da loja)'],
    ['/api/users/sugerir-acesso?nomeCompleto=Priscila%20Pereira&dominio=grupobravoempresarial.com', 'sugerir acesso (email+usuário)'],
    // os 4 relatorios de Fechamento: sao gerados por codigo que so roda no
    // download (montagem de PDF/CSV com secao por rede e quebra de pagina),
    // entao um erro ali nao aparece em nenhuma outra tela - so como 500 na
    // mao de quem clicou em Exportar
    ['/api/fechamentos/relatorio.csv', 'relatório de fechamentos (CSV)'],
    ['/api/fechamentos/relatorio.pdf', 'relatório de fechamentos (PDF)'],
    ['/api/fechamentos/relatorio-unidades.csv', 'comparativo por unidade (CSV)'],
    ['/api/fechamentos/relatorio-unidades.pdf', 'comparativo por unidade (PDF)'],
    ['/api/compras/acompanhamento', 'acompanhamento de compras (gerente)'],
    ['/api/fechamentos/recordes', 'recordes de venda (maior/menor dia e semana)'],
    ['/api/inventario/recebimentos/relatorio.csv?unidade=19821', 'relatório de recebimentos - inventário (CSV)'],
    ['/api/inventario/recebimentos/relatorio.pdf?unidade=19821', 'relatório de recebimentos - inventário (PDF)'],
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

  // telemetria do NOCZenith: rota publica (a maquina nao tem sessao), com o
  // payload no formato que o PowerShell 5.1 realmente manda - um disco so vai
  // como objeto, nao como array (ver comoLista em nocMaquina.js)
  const tele = await postarJson('/api/loja-status/AERO/computadores/ATM01/telemetria', {
    disco: { discos: { modelo: 'ST500LM012', tipo: 'HDD', tamanhoGb: 465, saude: 'saudavel' }, volumes: { letra: 'C:', totalGb: 465, livreGb: 9 } },
    dispositivos: [{ ip: '192.168.18.1', mac: 'A4-2B-B0-11-22-33' }],
    uptimeHoras: 9 * 24,
  });
  const okTele = tele.status === 200 && /"disco":"critico"/.test(tele.corpo) && /"uptimeHoras":216/.test(tele.corpo);
  if (!okTele) ruins += 1;
  console.log(`${okTele ? '✓' : '✗'} telemetria de HD/rede do NOCZenith: HTTP ${tele.status} ${tele.corpo.slice(0, 90)}`);

  // apelido de aparelho da rede: MAC invalido tem que ser recusado, MAC bom
  // tem que gravar (o nome vale pra unidade inteira, ver definirApelidoDispositivo)
  const macRuim = await putJson('/api/loja-status/AERO/dispositivos/nao-e-mac/apelido', { apelido: 'x' },
    token ? { Authorization: 'Bearer ' + token } : {});
  const okMacRuim = macRuim.status === 400 && /MAC/i.test(macRuim.corpo);
  if (!okMacRuim) ruins += 1;
  console.log(`${okMacRuim ? '✓' : '✗'} apelido com MAC inválido é recusado: HTTP ${macRuim.status} ${macRuim.corpo.slice(0, 60)}`);

  const apelido = await putJson('/api/loja-status/AERO/dispositivos/a4:2b:b0:11:22:33/apelido', { apelido: 'Impressora da cozinha' },
    token ? { Authorization: 'Bearer ' + token } : {});
  const okApelido = apelido.status === 200 && /Impressora da cozinha/.test(apelido.corpo);
  if (!okApelido) ruins += 1;
  console.log(`${okApelido ? '✓' : '✗'} apelido de aparelho da rede: HTTP ${apelido.status} ${apelido.corpo.slice(0, 90)}`);

  // Leitura de Canais de venda por foto (ver canaisVendaOcr.js): a rota so
  // responde pra loja cujo GRUPO tem o recurso ligado. Sem grupo configurado
  // no teste, o esperado e a recusa explicando onde ativar - e isso que
  // garante que ninguem liga leitura por imagem sem passar por Grupos.
  const pngFalso = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const foto = (n) => ({ nome: `relatorio${n}.png`, tipo: 'image/png', buffer: pngFalso });
  const lerCanaisImg = (qtd = 1) => postarMultipart('/api/fechamentos/ler-canais', { unidade: 'AERO' },
    Array.from({ length: qtd }, (_, i) => foto(i + 1)), 'imagem',
    token ? { Authorization: 'Bearer ' + token } : {});

  // sem ANTHROPIC_API_KEY o servidor nao tem como ler nada - a tela cai no
  // preenchimento manual em vez de mostrar botao que nunca funciona
  const semChave = await lerCanaisImg();
  const okSemChave = semChave.status === 400 && /não está configurada/i.test(semChave.corpo);
  if (!okSemChave) ruins += 1;
  console.log(`${okSemChave ? '✓' : '✗'} ler Canais sem ANTHROPIC_API_KEY é recusado: HTTP ${semChave.status} ${semChave.corpo.slice(0, 80)}`);

  // com chave, mas grupo SEM o recurso ligado: e o gate que garante que
  // ninguem liga leitura por imagem sem passar pelo cadastro de Grupos.
  // A chave so existe durante esta requisicao (ativo() le a env na hora).
  DOCS.set('grupos/g-teste', { id: 'g-teste', nome: 'Teste', unidades: ['AERO'],
    canaisVendaExtras: [{ campo: 'salao', label: 'Salão' }], lerCanaisPorImagem: false });
  process.env.ANTHROPIC_API_KEY = 'chave-de-teste';
  const semRecurso = await lerCanaisImg();
  delete process.env.ANTHROPIC_API_KEY;
  DOCS.delete('grupos/g-teste');
  const okSemRecurso = semRecurso.status === 400 && /Grupos/.test(semRecurso.corpo);
  if (!okSemRecurso) ruins += 1;
  // varias fotos do mesmo relatorio no mesmo envio (a tela do PDV nem sempre
  // cabe num print so). Chegar no gate de Grupos - e nao num erro do multer -
  // e o que prova que o upload aceitou mais de um arquivo no campo "imagem".
  DOCS.set('grupos/g-teste', { id: 'g-teste', nome: 'Teste', unidades: ['AERO'],
    canaisVendaExtras: [{ campo: 'salao', label: 'Salão' }], lerCanaisPorImagem: false });
  process.env.ANTHROPIC_API_KEY = 'chave-de-teste';
  const multi = await lerCanaisImg(3);
  delete process.env.ANTHROPIC_API_KEY;
  DOCS.delete('grupos/g-teste');
  const okMulti = multi.status === 400 && /Grupos/.test(multi.corpo);
  if (!okMulti) ruins += 1;
  console.log(`${okMulti ? '✓' : '✗'} ler Canais aceita várias fotos no mesmo envio: HTTP ${multi.status} ${multi.corpo.slice(0, 90)}`);
  console.log(`${okSemRecurso ? '✓' : '✗'} ler Canais exige o recurso ligado no Grupo: HTTP ${semRecurso.status} ${semRecurso.corpo.slice(0, 90)}`);

  // Extra e Candidato so entram com o documento de identidade anexado (os
  // dados vem da leitura dele, ver documentoIdentidadeOcr.js). Sem o anexo,
  // a recusa tem que ser explicita - antes o cadastro passava com o nome
  // digitado e ninguem tinha como conferir a identidade depois.
  const semDoc = await postarMultipart('/api/rh/funcionarios',
    { unidade: 'AERO', nome: 'Fulano de Teste', tipoCadastro: 'extra' },
    { nome: 'cv.pdf', tipo: 'application/pdf', buffer: Buffer.from('%PDF-1.4 teste') }, 'curriculo',
    token ? { Authorization: 'Bearer ' + token } : {});
  const okSemDoc = semDoc.status === 400 && /documento de identidade/i.test(semDoc.corpo);
  if (!okSemDoc) ruins += 1;
  console.log(`${okSemDoc ? '✓' : '✗'} cadastro de Extra sem documento é recusado: HTTP ${semDoc.status} ${semDoc.corpo.slice(0, 90)}`);

  // sem ANTHROPIC_API_KEY nao ha como ler documento nenhum - a rota precisa
  // dizer isso, e nao estourar tentando chamar a API sem chave
  const lerDoc = await postarMultipart('/api/rh/ler-documento', {},
    { nome: 'rg.png', tipo: 'image/png', buffer: pngFalso }, 'documento',
    token ? { Authorization: 'Bearer ' + token } : {});
  const okLerDoc = lerDoc.status === 400 && /não está configurada/i.test(lerDoc.corpo);
  if (!okLerDoc) ruins += 1;
  console.log(`${okLerDoc ? '✓' : '✗'} ler documento sem ANTHROPIC_API_KEY é recusado: HTTP ${lerDoc.status} ${lerDoc.corpo.slice(0, 80)}`);

  // A config de campos digitados na mão é lida ANTES do login: as duas telas
  // de cadastro (a interna e o link público) montam o formulário com ela, e
  // o link público não tem sessão. Precisa responder sem token.
  const cfgCampos = await pedir("/api/rh/campos-config-publico");
  let okCfg = false;
  try {
    const c = JSON.parse(cfgCampos.corpo);
    okCfg = cfgCampos.status === 200 && Array.isArray(c.camposManuais) && Array.isArray(c.campos) && c.campos.includes('cpf');
  } catch (e) { okCfg = false; }
  if (!okCfg) ruins += 1;
  console.log(`${okCfg ? '✓' : '✗'} config de campos manuais é pública (link de auto-cadastro usa): HTTP ${cfgCampos.status} ${cfgCampos.corpo.slice(0, 80)}`);

  // ---- PEDIDO SEMANAL ----
  // Sem regra nenhuma (o padrão) a rota tem que responder 200 com ativo:false, não
  // 404/500: o Fechamento e o Painel chamam ela em TODO carregamento, e um
  // erro aqui apareceria como card quebrado numa tela que a loja usa o dia
  // inteiro pra outra coisa.
  const ps = await pedir('/api/pedido-semanal', { Authorization: 'Bearer ' + token });
  let okPs = false;
  try {
    const d = JSON.parse(ps.corpo);
    okPs = ps.status === 200 && d.ativo === false && Array.isArray(d.unidades);
  } catch (e) { okPs = false; }
  if (!okPs) ruins += 1;
  console.log(`${okPs ? '✓' : '✗'} pedido semanal desligado responde sem estourar: HTTP ${ps.status} ${ps.corpo.slice(0, 90)}`);

  // A tela de regras precisa das unidades E dos grupos pra montar os dois
  // seletores; "semRegra" é o que mostra ao Master quem ficou sem cobrança.
  // Sem nenhuma regra cadastrada, TODA loja tem que aparecer ali.
  const psCfg = await pedir('/api/pedido-semanal/regras', { Authorization: 'Bearer ' + token });
  let okPsCfg = false;
  try {
    const d = JSON.parse(psCfg.corpo);
    okPsCfg = psCfg.status === 200 && Array.isArray(d.regras) && Array.isArray(d.grupos)
      && Array.isArray(d.dias) && d.dias.length === 7
      && Array.isArray(d.unidades) && d.unidades.length > 0
      && d.semRegra.length === d.unidades.length;
  } catch (e) { okPsCfg = false; }
  if (!okPsCfg) ruins += 1;
  console.log(`${okPsCfg ? '✓' : '✗'} regras do pedido semanal trazem unidades, grupos e quem está sem regra: HTTP ${psCfg.status} ${psCfg.corpo.slice(0, 90)}`);

  // ---- PERFIL DE UNIDADE (areas/tiposSolicitacao) - caso MVPar: unidade
  // administrativa sem operação de loja, só aparece em RH/NOC/Solicitações,
  // nunca em Fechamento (ver server/unidades.js) ----
  const criouPerfil = await postarJson('/api/meta/unidades-extras', {
    nome: 'MVPar Teste', codigo: 'MVPAR_TESTE',
    areas: ['rh', 'noc', 'solicitacoes'],
    tiposSolicitacao: ['compra', 'manutencao', 'suporte-ti', 'pagamento', 'nota'],
  }, { Authorization: 'Bearer ' + token });
  let okPerfilCriar = false;
  try {
    const d = JSON.parse(criouPerfil.corpo);
    okPerfilCriar = criouPerfil.status === 200 && d.codigo === 'MVPAR_TESTE'
      && JSON.stringify(d.areas.slice().sort()) === JSON.stringify(['noc', 'rh', 'solicitacoes']);
  } catch (e) { okPerfilCriar = false; }
  if (!okPerfilCriar) ruins += 1;
  console.log(`${okPerfilCriar ? '✓' : '✗'} cadastrar unidade com perfil restrito (caso MVPar): HTTP ${criouPerfil.status} ${criouPerfil.corpo.slice(0, 90)}`);

  const mapaFech = await pedir('/api/meta/unidades-extras?area=fechamento', { Authorization: 'Bearer ' + token });
  let okMapaFech = false;
  try {
    const d = JSON.parse(mapaFech.corpo);
    okMapaFech = mapaFech.status === 200 && !('MVPAR_TESTE' in d);
  } catch (e) { okMapaFech = false; }
  if (!okMapaFech) ruins += 1;
  console.log(`${okMapaFech ? '✓' : '✗'} unidade sem área "fechamento" some do seletor filtrado: HTTP ${mapaFech.status} ${mapaFech.corpo.slice(0, 90)}`);

  const mapaRh = await pedir('/api/meta/unidades-extras?area=rh', { Authorization: 'Bearer ' + token });
  let okMapaRh = false;
  try {
    const d = JSON.parse(mapaRh.corpo);
    okMapaRh = mapaRh.status === 200 && d.MVPAR_TESTE === 'MVPar Teste';
  } catch (e) { okMapaRh = false; }
  if (!okMapaRh) ruins += 1;
  console.log(`${okMapaRh ? '✓' : '✗'} mesma unidade continua no seletor de RH: HTTP ${mapaRh.status} ${mapaRh.corpo.slice(0, 90)}`);

  const lancouFech = await postarJson('/api/fechamentos/lancar', {
    unidade: 'MVPAR_TESTE', unidadeNome: 'MVPar Teste', data: '2026-08-18', gerente: 'Teste', campos: {},
  }, { Authorization: 'Bearer ' + token });
  let okBloqueiaFech = false;
  try {
    const d = JSON.parse(lancouFech.corpo);
    okBloqueiaFech = lancouFech.status === 400 && /não tem fechamento/i.test(d.error || '');
  } catch (e) { okBloqueiaFech = false; }
  if (!okBloqueiaFech) ruins += 1;
  console.log(`${okBloqueiaFech ? '✓' : '✗'} lançar fechamento numa unidade sem essa área é recusado (até pro Master): HTTP ${lancouFech.status} ${lancouFech.corpo.slice(0, 90)}`);

  // ---- "Responsável" travado no usuario logado (decisao do Master): o
  // servidor IGNORA o "gerente" que o body manda e usa sempre
  // req.user.username||req.user.email - antes era texto livre, sem vinculo
  // nenhum com quem estava logado de verdade ----
  const lancouComGerenteForjado = await postarJson('/api/fechamentos/lancar', {
    unidade: '19855', unidadeNome: 'Dom Carrão', data: '2026-08-19', gerente: 'Nome Forjado Que Nao Deveria Valer', campos: {},
  }, { Authorization: 'Bearer ' + token });
  let okGerenteTravado = false;
  try {
    const d = JSON.parse(lancouComGerenteForjado.corpo);
    okGerenteTravado = lancouComGerenteForjado.status === 200
      && d.gerente === (process.env.MASTER_EMAIL || '').trim().toLowerCase()
      && d.gerente !== 'Nome Forjado Que Nao Deveria Valer';
  } catch (e) { okGerenteTravado = false; }
  if (!okGerenteTravado) ruins += 1;
  console.log(`${okGerenteTravado ? '✓' : '✗'} "Responsável" do fechamento ignora o texto do body e trava no usuário logado: HTTP ${lancouComGerenteForjado.status} ${lancouComGerenteForjado.corpo.slice(0, 90)}`);

  // ---- PERFIL POR CODIGO em unidade FIXA (loja Adyen/planilha, código que
  // nunca muda) - a mesma "unificação" pedida pelo usuário: toda unidade,
  // fixa ou cadastrada em runtime, pode ganhar o perfil que a MVPar tem ----
  const perfilFixa = await putJson('/api/meta/unidades/19821/perfil', {
    nome: 'Dom Sao Miguel', areas: ['rh'], tiposSolicitacao: [],
  }, { Authorization: 'Bearer ' + token });
  let okPerfilFixa = false;
  try {
    const d = JSON.parse(perfilFixa.corpo);
    okPerfilFixa = perfilFixa.status === 200 && d.codigo === '19821' && JSON.stringify(d.areas) === JSON.stringify(['rh']);
  } catch (e) { okPerfilFixa = false; }
  if (!okPerfilFixa) ruins += 1;
  console.log(`${okPerfilFixa ? '✓' : '✗'} unidade FIXA também ganha perfil restrito (não precisa recriar): HTTP ${perfilFixa.status} ${perfilFixa.corpo.slice(0, 90)}`);

  // ganhar perfil não pode fazer a unidade fixa "sumir" da seção de verdade
  // dela (Fechamento/ARCFOOD) pra cair genérica em "Cadastradas no sistema" -
  // bug real que apareceu na tela (lojas com perfil duplicando/mudando de
  // lugar no painel)
  const todasUnidades = await pedir('/api/meta/unidades', { Authorization: 'Bearer ' + token });
  let okClassificacao = false;
  try {
    const lista = JSON.parse(todasUnidades.corpo);
    const item = lista.find((u) => u.codigo === '19821');
    okClassificacao = todasUnidades.status === 200 && !!item && item.secao === 'Fechamento' && item.grupo === 'ARCFOOD';
  } catch (e) { okClassificacao = false; }
  if (!okClassificacao) ruins += 1;
  console.log(`${okClassificacao ? '✓' : '✗'} unidade fixa com perfil continua classificada na seção real dela (Fechamento/ARCFOOD): HTTP ${todasUnidades.status}`);

  const restritas = await pedir('/api/meta/unidades-restritas?area=fechamento', { Authorization: 'Bearer ' + token });
  let okRestritas = false;
  try {
    const d = JSON.parse(restritas.corpo);
    okRestritas = restritas.status === 200 && Array.isArray(d) && d.includes('19821');
  } catch (e) { okRestritas = false; }
  if (!okRestritas) ruins += 1;
  console.log(`${okRestritas ? '✓' : '✗'} unidade fixa restrita aparece em unidades-restritas?area=fechamento (pra telas com base pré-populada removerem): HTTP ${restritas.status} ${restritas.corpo.slice(0, 90)}`);

  const lancouFixaRestrita = await postarJson('/api/fechamentos/lancar', {
    unidade: '19821', unidadeNome: 'Dom Sao Miguel', data: '2026-08-18', gerente: 'Teste', campos: {},
  }, { Authorization: 'Bearer ' + token });
  let okBloqueiaFixa = false;
  try {
    const d = JSON.parse(lancouFixaRestrita.corpo);
    okBloqueiaFixa = lancouFixaRestrita.status === 400 && /não tem fechamento/i.test(d.error || '');
  } catch (e) { okBloqueiaFixa = false; }
  if (!okBloqueiaFixa) ruins += 1;
  console.log(`${okBloqueiaFixa ? '✓' : '✗'} servidor recusa fechamento na unidade fixa restrita, mesmo que a tela ainda mostrasse ela: HTTP ${lancouFixaRestrita.status} ${lancouFixaRestrita.corpo.slice(0, 90)}`);

  // ---- caso real que motivou a migração: mesmo SEM rodar a migração
  // ainda, um código antigo solto (ex: planilha do Google Sheets ainda não
  // resincronizada) não pode aparecer como cadastro separado no painel de
  // Unidades ao lado do código novo - construirUnidadesMapa funde os dois ----
  DOCS.set('entregasLive/fold1', { id: 'fold1', unidade: 'Garanhuns', unidadeNome: 'Dom Garanhuns', data: '2026-08-01', entregador: 'Ciclano' });
  const unidadesComCodigoSolto = await pedir('/api/meta/unidades', { Authorization: 'Bearer ' + token });
  let okFundeCodigoSolto = false;
  try {
    const lista = JSON.parse(unidadesComCodigoSolto.corpo);
    okFundeCodigoSolto = unidadesComCodigoSolto.status === 200
      && !lista.some((u) => u.codigo === 'Garanhuns')
      && lista.some((u) => u.codigo === 'Dominos Garanhuns');
  } catch (e) { okFundeCodigoSolto = false; }
  if (!okFundeCodigoSolto) ruins += 1;
  console.log(`${okFundeCodigoSolto ? '✓' : '✗'} código antigo solto (fonte não migrada) some sozinho, funde no código unificado: HTTP ${unidadesComCodigoSolto.status}`);

  // ---- fold do espaço Monitor/Adyen: mesma ideia do fold de Entregas acima,
  // mas pro merchantAccountCode que chega direto numa transacao (cache em
  // memoria do store.js), sem passar pela migracao ainda ----
  store.addOrUpdate({ pspReference: 'psp-fold-mon', eventCode: 'AUTHORISATION', unidade: 'Carrao', status: 'APROVADO', dataHora: new Date().toISOString(), valor: 42 });
  const unidadesComCodigoMonitorSolto = await pedir('/api/meta/unidades', { Authorization: 'Bearer ' + token });
  let okFundeMonitorSolto = false;
  try {
    const lista = JSON.parse(unidadesComCodigoMonitorSolto.corpo);
    okFundeMonitorSolto = unidadesComCodigoMonitorSolto.status === 200
      && !lista.some((u) => u.codigo === 'Carrao')
      && lista.some((u) => u.codigo === '19855');
  } catch (e) { okFundeMonitorSolto = false; }
  if (!okFundeMonitorSolto) ruins += 1;
  console.log(`${okFundeMonitorSolto ? '✓' : '✗'} código antigo solto do Monitor (transação em cache, sem migração) some sozinho, funde no código do Fechamento: HTTP ${unidadesComCodigoMonitorSolto.status}`);

  // ---- "MMTirol Natal"/"Tirol Natal": o Master olhou a tela de Unidades e
  // disse que essa loja NÃO EXISTE - excluir em definitivo. O teste que
  // existia aqui antes era o oposto (conferia que os dois códigos fundiam
  // num cadastro só); agora o certo é os DOIS sumirem.
  //
  // O que importa provar: não basta ter tirado da lista fixa. O código volta
  // sozinho pelo DADO - é isso que a transação abaixo simula (transação da
  // Adyen em cache, como acontece de verdade no boot). Sem CODIGOS_REMOVIDOS
  // ele reaparecia aqui, agora sem nome, como órfão em "Outras". ----
  store.addOrUpdate({ pspReference: 'psp-fold-tirol-natal', eventCode: 'AUTHORISATION', unidade: 'Tirol Natal', status: 'APROVADO', dataHora: new Date().toISOString(), valor: 15 });
  const unidadesTirolNatalRemovida = await pedir('/api/meta/unidades', { Authorization: 'Bearer ' + token });
  const criarUnidadeRemovida = await postarJson('/api/meta/unidades-extras', { codigo: 'MMTirol Natal', nome: 'Milky Moo Tirol Natal' }, { Authorization: 'Bearer ' + token });
  let okTirolNatalRemovida = false;
  try {
    const lista = JSON.parse(unidadesTirolNatalRemovida.corpo);
    okTirolNatalRemovida = unidadesTirolNatalRemovida.status === 200
      // nenhum dos dois códigos aparece, mesmo com transação viva no cache
      && !lista.some((u) => u.codigo === 'Tirol Natal')
      && !lista.some((u) => u.codigo === 'MMTirol Natal')
      // e não sobrou nada com o nome antigo por outro caminho
      && !lista.some((u) => String(u.nome || '').includes('Tirol Natal'))
      // a loja de verdade (Milky Moo Tirol, do Fechamento) continua lá
      && lista.some((u) => u.codigo === 'Milky Moo Tirol')
      // e recadastrar o código na mão é recusado com explicação
      && criarUnidadeRemovida.status === 400 && /excluído em definitivo/.test(criarUnidadeRemovida.corpo);
  } catch (e) { okTirolNatalRemovida = false; }
  if (!okTirolNatalRemovida) ruins += 1;
  console.log(`${okTirolNatalRemovida ? '✓' : '✗'} "MMTirol Natal"/"Tirol Natal" excluída em definitivo: não volta nem pelo dado em cache nem por cadastro manual: HTTP ${unidadesTirolNatalRemovida.status}`);

  // ---- colunas do Fechamento unificadas por NOME (ver colunasValores em
  // public/fechamentos.html e unificarPorNome em fechamentosReport.js): a
  // mesma "Ifood" existe como campo fixo do schema antigo (linha vinda de
  // planilha) E como canal de venda do grupo (linha lançada no sistema), e
  // saía como DUAS colunas de mesmo nome - uma preenchida e a outra zerada.
  // Cenário exato reportado pelo Master no painel da ARCFOOD. ----
  const relFech = require('/home/user/adyen-monitor/server/fechamentosReport.js');
  const gruposTeste = [{
    id: 'arcfood', nome: 'Dominos ARCFOOD', unidades: ['19855', '19888'],
    canaisVendaExtras: [{ campo: 'delivery', label: 'Delivery' }, { campo: 'loja', label: 'Loja' }],
    formasPagamentoExtras: [{ campo: 'ifood', label: 'Ifood' }, { campo: 'food99', label: '99Food' }],
  }];
  const fechTeste = [
    // lançado no sistema: usa os canais/formas que o grupo define
    { unidade: '19855', unidadeNome: 'Dom Carrão', data: '2026-08-17', criadoPorId: 'u1', faturamento: 2195.45,
      canaisVendaExtras: { delivery: 1850.48, loja: 255.12 }, formasPagamentoExtras: { ifood: 454.33, food99: 577.30 } },
    // importado de planilha: mesmos conceitos, no schema antigo
    { unidade: '19888', unidadeNome: 'Dom Mooca', data: '2026-08-17', faturamento: 1330.73,
      ifood: 382.96, food99: 251.50, loja: 76.90, delivery: 611.20, pixCnpj: 8.40, outros: 3.10 },
  ];
  let okColunasUnificadas = false;
  try {
    const { colunas, linhas } = relFech.prepararRelatorio(fechTeste, gruposTeste);
    const labels = colunas.map((c) => c.label);
    const repetidas = labels.filter((l, i) => labels.indexOf(l) !== i);
    const porNome = (nome) => colunas.find((c) => c.label === nome);
    const carrao = linhas.find((l) => l.unidadeNome === 'Dom Carrão');
    const mooca = linhas.find((l) => l.unidadeNome === 'Dom Mooca');
    okColunasUnificadas = !repetidas.length
      // as duas origens caem na MESMA coluna, cada linha lendo de onde gravou
      && carrao[porNome('Ifood').key] === 454.33 && mooca[porNome('Ifood').key] === 382.96
      && carrao[porNome('Loja').key] === 255.12 && mooca[porNome('Loja').key] === 76.90
      // Delivery da planilha (schema antigo) aparece na MESMA coluna do
      // Delivery lançado no sistema (canal do grupo)
      && carrao[porNome('Delivery').key] === 1850.48 && mooca[porNome('Delivery').key] === 611.20;
  } catch (e) { okColunasUnificadas = false; }
  if (!okColunasUnificadas) ruins += 1;
  console.log(`${okColunasUnificadas ? '✓' : '✗'} colunas do Fechamento não duplicam por origem (planilha e sistema na mesma coluna Ifood/Loja/Delivery)`);

  // ---- o dado da planilha não pode sumir da tela: sheetsSync importa DEZ
  // campos de valor, e por muito tempo só 5 tinham coluna (Delivery,
  // Carryout, Pick-up, Pix CNPJ e Outros eram gravados e nunca exibidos).
  // Sem grupo nenhum definido - é o caso que mais expõe o buraco, porque aí
  // não há canal/forma do grupo pra "cobrir" a coluna faltante ----
  let okPlanilhaCompleta = false;
  try {
    const soPlanilha = [{ unidade: 'X', unidadeNome: 'Loja Planilha', data: '2026-08-17', faturamento: 100,
      delivery: 611.20, carryout: 44.30, pickup: 12.90, loja: 76.90, adyen: 109.80,
      ifood: 382.96, food99: 251.50, pix: 5.50, pixCnpj: 8.40, outros: 3.10 }];
    const { colunas, linhas } = relFech.prepararRelatorio(soPlanilha, []);
    const valor = (nome) => linhas[0][(colunas.find((c) => c.label === nome) || {}).key];
    okPlanilhaCompleta = valor('Delivery') === 611.20 && valor('Carryout') === 44.30 && valor('Pick-up') === 12.90
      && valor('Pix CNPJ') === 8.40 && valor('Outros') === 3.10
      && valor('Loja') === 76.90 && valor('Maquininhas (cartão)') === 109.80 && valor('Pix') === 5.50
      && valor('Ifood') === 382.96 && valor('99Food') === 251.50;
  } catch (e) { okPlanilhaCompleta = false; }
  if (!okPlanilhaCompleta) ruins += 1;
  console.log(`${okPlanilhaCompleta ? '✓' : '✗'} os 10 campos de valor que a planilha importa aparecem todos na tabela`);

  // ---- a ordem de colunas confirmada tem que virar A PADRAO: gravada no
  // servidor, por usuario, ela sobrevive a atualizar a pagina, a fechar o
  // app e a limpar o cache do navegador (antes so existia em localStorage,
  // "salvo neste navegador"). O teste faz a ida-e-volta que a tela faz:
  // salva no Salvar do seletor 🧩 Colunas e le de volta no boot ----
  let okPrefColunas = false;
  try {
    const escolha = { ordem: ['ifood', 'loja', 'delivery'], ocultas: ['quebra'], foraRelatorio: ['observacao'] };
    const gravou = await putJson('/api/preferencias/fechamentoColunas', { valor: escolha }, token ? { Authorization: 'Bearer ' + token } : {});
    const leu = await pedir('/api/preferencias/fechamentoColunas', token ? { Authorization: 'Bearer ' + token } : {});
    const v = JSON.parse(leu.corpo).valor;
    okPrefColunas = gravou.status === 200 && leu.status === 200
      && JSON.stringify(v.ordem) === JSON.stringify(escolha.ordem)
      && JSON.stringify(v.ocultas) === JSON.stringify(escolha.ocultas)
      && JSON.stringify(v.foraRelatorio) === JSON.stringify(escolha.foraRelatorio);
  } catch (e) { okPrefColunas = false; }
  if (!okPrefColunas) ruins += 1;
  console.log(`${okPrefColunas ? '✓' : '✗'} ordem/visibilidade de colunas salva no servidor volta igual (vira a padrão em qualquer aparelho)`);

  // preferencia de uma tela nao pode apagar a de outra: sao chaves
  // independentes no MESMO documento do usuario (set com merge)
  let okPrefIsolada = false;
  try {
    await putJson('/api/preferencias/outraTela', { valor: { x: 1 } }, token ? { Authorization: 'Bearer ' + token } : {});
    const antiga = await pedir('/api/preferencias/fechamentoColunas', token ? { Authorization: 'Bearer ' + token } : {});
    okPrefIsolada = antiga.status === 200 && (JSON.parse(antiga.corpo).valor || {}).ordem.length === 3;
  } catch (e) { okPrefIsolada = false; }
  if (!okPrefIsolada) ruins += 1;
  console.log(`${okPrefIsolada ? '✓' : '✗'} salvar a preferência de uma tela não apaga a de outra`);

  // ---- envio pra planilha ficou SO pra ARCFOOD: o Grupo Bravo aposentou a
  // planilha dele (2026-08, aba "BD" apagada) e virou 100% nativo no
  // Firestore. Mandar fechamento do Bravo de volta pra planilha nao existe
  // mais e precisa falhar com mensagem clara, nao tentar escrever numa aba
  // que nao existe. Cobre so o roteamento (nao fala com o Google Sheets) ----
  let okEnvioGrupo = false;
  try {
    const cab = token ? { Authorization: 'Bearer ' + token } : {};
    const invalido = await postarJson('/api/fechamentos/xpto/enviar-planilha', { data: '2026-08-18' }, cab);
    const bravo = await postarJson('/api/fechamentos/bravo/enviar-planilha', { data: '2026-08-18' }, cab);
    const dataRuim = await postarJson('/api/fechamentos/arcfood/enviar-planilha', { data: '18/08/2026' }, cab);
    const arcfood = await postarJson('/api/fechamentos/arcfood/enviar-planilha', { data: '2026-08-18' }, cab);
    const corpoArcfood = JSON.parse(arcfood.corpo || '{}');
    okEnvioGrupo = invalido.status === 400 && /planilha de destino/.test(invalido.corpo)
      && bravo.status === 400 && /planilha de destino/.test(bravo.corpo)
      && dataRuim.status === 400 && /Data inválida/.test(dataRuim.corpo)
      // sem lançamento nenhum semeado, as 4 lojas da ARCFOOD caem em semLancamento
      && arcfood.status === 200 && corpoArcfood.grupo === 'ARCFOOD' && corpoArcfood.semLancamento.length === 4;
  } catch (e) { okEnvioGrupo = false; }
  if (!okEnvioGrupo) ruins += 1;
  console.log(`${okEnvioGrupo ? '✓' : '✗'} enviar-planilha vale só pra ARCFOOD - Grupo Bravo (planilha aposentada) é recusado`);

  // ---- leitura de Canais por foto: o modelo por vezes devolve numero em
  // formato BR (virgula decimal, ex: "3.636,40") ou uma frase antes/depois
  // do JSON, apesar da instrucao no prompt - os dois quebram JSON.parse cru
  // e a tela mostrava "Nao consegui entender essa imagem", que sugere foto
  // ruim quando na verdade a foto estava perfeita e o problema era so
  // formatacao da resposta do modelo (ver extrairJson em canaisVendaOcr.js) ----
  let okExtrairJson = false;
  try {
    const { extrairJson } = require('./canaisVendaOcr.js');
    const brComMilhar = extrairJson('{"campos":[{"chave":"canal.delivery","valor": 3.636,40}]}');
    const brSemMilhar = extrairJson('{"campos":[{"chave":"forma.elo","valor": 51,90}]}');
    const brNegativo = extrairJson('{"campos":[{"chave":"kpi.x","valor": -1,91}]}');
    const comProsa = extrairJson('Aqui está o relatório extraído:\n{"data":"2026-08-18","campos":[]}\nEspero ter ajudado!');
    const jaCorreto = extrairJson('{"campos":[{"chave":"canal.loja","valor": 1153.60},{"chave":"canal.pickup","valor": 0}]}');
    const virgulaDeArray = extrairJson('{"campos":[{"chave":"a","valor":100},{"chave":"b","valor":200}]}');
    okExtrairJson = brComMilhar.campos[0].valor === 3636.40
      && brSemMilhar.campos[0].valor === 51.90
      && brNegativo.campos[0].valor === -1.91
      && comProsa.data === '2026-08-18'
      && jaCorreto.campos[0].valor === 1153.60 && jaCorreto.campos[1].valor === 0
      && virgulaDeArray.campos.length === 2 && virgulaDeArray.campos[1].valor === 200;
  } catch (e) { okExtrairJson = false; }
  if (!okExtrairJson) ruins += 1;
  console.log(`${okExtrairJson ? '✓' : '✗'} leitura de Canais por foto: número BR/prosa antes do JSON não derruba mais o parser`);

  // ---- Termos emitidos sem venda (Parque): so Master/Gerente pode ver quem
  // emitiu (nome, email, horas em aberto) - a rota so tinha o gate de SECAO
  // (requireAnySection('parque','parque-checkin')), entao um atendente com
  // acesso ao Parque conseguia ler a lista inteira. Semeia um usuario
  // gerente e um atendente de mentira pra provar o 200/403 (ver
  // users.ehCargoGerente em index.js) ----
  let okGateTermos = false;
  try {
    const bcrypt = require('bcryptjs');
    const senhaHash = bcrypt.hashSync('SenhaDeTeste!2026', 4);
    const base = {
      passwordHash: senhaHash, role: 'user', active: true,
      permissions: { sections: ['parque'], unidades: [], vaultSubgroups: [], tiposSolicitacao: [] },
      createdAt: new Date().toISOString(),
    };
    DOCS.set('users/u-gerente-teste', { ...base, email: 'gerente-teste@teste.local', username: 'gerenteteste', cargo: 'gerente' });
    DOCS.set('users/u-atendente-teste', { ...base, email: 'atendente-teste@teste.local', username: 'atendenteteste', cargo: null });
    const tokenGerente = (await auth.login('gerente-teste@teste.local', 'SenhaDeTeste!2026')).token;
    const tokenAtendente = (await auth.login('atendente-teste@teste.local', 'SenhaDeTeste!2026')).token;
    const comoMaster = await pedir('/api/parque/termo-emissoes', token ? { Authorization: 'Bearer ' + token } : {});
    const comoGerente = await pedir('/api/parque/termo-emissoes', { Authorization: 'Bearer ' + tokenGerente });
    const comoAtendente = await pedir('/api/parque/termo-emissoes', { Authorization: 'Bearer ' + tokenAtendente });
    okGateTermos = comoMaster.status === 200 && comoGerente.status === 200 && comoAtendente.status === 403;
  } catch (e) { okGateTermos = false; }
  if (!okGateTermos) ruins += 1;
  console.log(`${okGateTermos ? '✓' : '✗'} termos emitidos sem venda: só Master/Gerente vê (atendente com a seção Parque toma 403)`);

  // ---- Parque: cortesia PCD (5%CP) e cortesia geral agora podem juntar
  // uma criança PAGANTE no MESMO check-in da criança que recebe a
  // gratuidade (checkbox "gratuita" desmarcado) - 1 termo só, em vez de 2
  // check-ins separados. A pagante entra pelo preço CHEIO da tabela (nunca
  // o preço fixo do PCD) e a cota de "2 crianças/hora" da 5%CP conta só
  // quem de fato recebe a cortesia (ver criar() em parque.js) ----
  let okGratuidadeMista = false;
  try {
    const base = {
      unidade: '19821', unidadeNome: 'Dom Sao Miguel',
      responsavel: { nome: 'Responsavel Teste', contato: '11999999999' },
      dataUtilizacao: '2026-08-19', categoriaTempo: 'pcd-cortesia',
      horarioPrevisto: '10:00', criadoPorId: 'x', criadoPorEmail: 'teste@x.com',
    };
    const misto = await parque.criar({
      ...base,
      criancas: [
        { nome: 'Beneficiaria', meia: false, gratuita: true },
        { nome: 'Pagante', meia: false, gratuita: false },
      ],
      metodoPagamento: 'pix', pagamentos: [{ forma: 'pix', valor: 50 }],
    });
    // preco cheio da tabela padrao pro tempo de 60min (pcdCortesiaMinutos
    // default) e' R$50 - nunca os R$32 fixos do PCD, que so valem pra quem
    // de fato usa a categoria
    const precoOk = misto.valor === 50 && misto.metodoPagamento === 'pix'
      && misto.criancas[0].gratuita === true && misto.criancas[1].gratuita === false;

    // cota de 2/hora: essa venda ja usou 1 vaga (a beneficiaria). Duas
    // vendas so-pagante (sem beneficiario nenhum) NAO devem consumir vaga -
    // tem que passar mesmo repetindo o mesmo horario varias vezes
    const soPagante1 = await parque.criar({
      ...base,
      criancas: [{ nome: 'Pagante2', meia: false, gratuita: false }],
      metodoPagamento: 'pix', pagamentos: [{ forma: 'pix', valor: 50 }],
    });
    const soPagante2 = await parque.criar({
      ...base,
      criancas: [{ nome: 'Pagante3', meia: false, gratuita: false }],
      metodoPagamento: 'pix', pagamentos: [{ forma: 'pix', valor: 50 }],
    });
    const naoContaNaCota = !!(soPagante1 && soPagante1.id) && !!(soPagante2 && soPagante2.id);

    // agora 1 beneficiaria a mais fecha a cota (1+1=2); a proxima tem que
    // recusar - prova que a cota conta certo mesmo com pagantes misturados
    // no meio
    await parque.criar({
      ...base,
      criancas: [{ nome: 'Beneficiaria2', meia: false, gratuita: true }],
    });
    let estourouCota = false;
    try {
      await parque.criar({ ...base, criancas: [{ nome: 'Beneficiaria3', meia: false, gratuita: true }] });
    } catch (e) { estourouCota = /vagas de cortesia/.test(e.message); }

    okGratuidadeMista = precoOk && naoContaNaCota && estourouCota;
  } catch (e) { okGratuidadeMista = false; console.log('  erro: ' + e.message); }
  if (!okGratuidadeMista) ruins += 1;
  console.log(`${okGratuidadeMista ? '✓' : '✗'} Parque: cortesia PCD/geral aceita 1 criança pagando junto com a beneficiária, sem furar a cota de 2/hora`);

  // ---- Fechamentos: a planilha do Grupo Bravo foi APOSENTADA (2026-08). O
  // historico dela virou lançamento nativo no Firestore e a aba viva "BD"
  // foi apagada, entao sincronizar() nao pode mais nem TENTAR ler aquela
  // planilha - se voltasse a tentar, cada sincronizacao gastaria chamada a
  // toa e o painel poderia ressuscitar dado velho por cima do migrado.
  // Conferir "nao deu erro" nao bastaria: sincronizar() engole falha por
  // fonte de proposito. Entao este teste OLHA AS URLS pedidas - com uma
  // chave RSA descartavel so pra assinatura do JWT passar e o fetch ser
  // realmente alcancado ----
  let okBravoForaDoSync = false;
  const fetchOriginal = global.fetch;
  const envEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const envKey = process.env.FIREBASE_PRIVATE_KEY;
  try {
    const { generateKeyPairSync } = require('crypto');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    process.env.FIREBASE_CLIENT_EMAIL = 'teste@teste.local';
    process.env.FIREBASE_PRIVATE_KEY = privateKey;
    const urlsPedidas = [];
    global.fetch = async (url) => {
      urlsPedidas.push(String(url));
      if (String(url).includes('oauth2.googleapis.com/token')) {
        return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
      }
      return { ok: true, json: async () => ({ values: [] }) };
    };
    await sheetsSync.sincronizar({ completa: true });
    const pediuBravo = urlsPedidas.some((u) => u.includes(sheetsSync.SHEET_ID_BRAVO));
    const pediuAlgumaPlanilha = urlsPedidas.some((u) => u.includes('sheets.googleapis.com'));
    okBravoForaDoSync = !pediuBravo && pediuAlgumaPlanilha
      // a funcao que descobria as abas do Bravo tambem tem que ter sumido
      && typeof sheetsSync.abasHistoricoBravo === 'undefined';
  } catch (e) { okBravoForaDoSync = false; } finally {
    global.fetch = fetchOriginal;
    if (envEmail === undefined) delete process.env.FIREBASE_CLIENT_EMAIL; else process.env.FIREBASE_CLIENT_EMAIL = envEmail;
    if (envKey === undefined) delete process.env.FIREBASE_PRIVATE_KEY; else process.env.FIREBASE_PRIVATE_KEY = envKey;
  }
  if (!okBravoForaDoSync) ruins += 1;
  console.log(`${okBravoForaDoSync ? '✓' : '✗'} Fechamentos: sincronização não toca mais na planilha do Grupo Bravo (só ARCFOOD)`);

  // ---- CUSTO DE LEITURA do caminho de autenticação (sessions.js).
  // existeEValida roda no requireAuth de TODA requisição autenticada (~90
  // rotas), e antes lia a coleção INTEIRA de sessões por um cache único
  // compartilhado - que ainda por cima era invalidado pelo tocar() de
  // qualquer outro usuário (1x/min por sessão ativa). Com vários acessos
  // simultâneos as invalidações se sobrepunham, o TTL nunca era aproveitado
  // e cada requisição de todo mundo custava N leituras. Este teste mede
  // DOCUMENTOS lidos (que é como o Firestore cobra) em vez de só conferir
  // que a função respondeu - sem isso, a regressão voltaria calada ----
  let okCustoSessao = false;
  try {
    const sessions = require('./sessions.js');
    const agoraMs = Date.now();
    const SESSOES = 40;
    for (let i = 0; i < SESSOES; i++) {
      DOCS.set(`sessions/sess-${i}`, {
        id: `sess-${i}`, userId: `user-${i}`, criadoEm: new Date(agoraMs).toISOString(),
        ultimaAtividadeEm: new Date(agoraMs).toISOString(), expiraEm: agoraMs + 60 * 60 * 1000,
      });
    }

    const antes = LEITURAS.docs;
    // 30 requisições da MESMA sessão: com o cache por sessão, isso é 1
    // leitura de 1 documento (as outras 29 saem do cache)
    for (let i = 0; i < 30; i++) await sessions.existeEValida('sess-0');
    const custoMesmaSessao = LEITURAS.docs - antes;

    // a parte que pega a regressão de verdade: outra sessão tem atividade
    // (tocar) e a nossa continua servida do cache. Antes, esse tocar()
    // invalidava o cache compartilhado e a próxima chamada relia as 40
    const antesDoToque = LEITURAS.docs;
    sessions.tocar('sess-7');
    sessions.tocar('sess-9');
    await new Promise((r) => setImmediate(r)); // deixa o update assíncrono correr
    for (let i = 0; i < 10; i++) await sessions.existeEValida('sess-0');
    const custoDepoisDoToqueAlheio = LEITURAS.docs - antesDoToque;

    // sessão encerrada tem que cair na hora, não esperar o TTL - é o que
    // "encerrar acesso" promete pro Master
    await sessions.encerrar('sess-0');
    const aindaValida = await sessions.existeEValida('sess-0');

    okCustoSessao = custoMesmaSessao === 1 && custoDepoisDoToqueAlheio === 0 && aindaValida === false;
    if (!okCustoSessao) {
      console.log(`  (mesma sessão: ${custoMesmaSessao} leitura(s), esperado 1 · após toque alheio: ${custoDepoisDoToqueAlheio}, esperado 0 · válida após encerrar: ${aindaValida}, esperado false)`);
    }
  } catch (e) { okCustoSessao = false; console.log('  erro: ' + e.message); }
  if (!okCustoSessao) ruins += 1;
  console.log(`${okCustoSessao ? '✓' : '✗'} autenticação: validar sessão custa 1 leitura de 1 documento e não é derrubada pela atividade de outro usuário`);

  // ------------------------------------------------------------------
  // Custo da Central de Alertas. A tela faz polling a cada 15s; ate
  // 18/08/2026 cada batida relia os 300 documentos da colecao inteira
  // (cache com TTL de 8s, MENOR que o intervalo do polling - nunca acertava),
  // o que da 72 mil leituras/hora com UMA aba aberta e foi o que disparou a
  // fatura do Firestore. Agora o polling manda ?desde=<criadoEm mais novo> e
  // paga ~1 leitura por batida. Este teste trava esse custo.
  let okCustoAlertas = false;
  try {
    const alertasCentral = require('/home/user/adyen-monitor/server/alertasCentral.js');
    const cabAlertas = token ? { Authorization: 'Bearer ' + token } : {};
    for (let i = 0; i < 300; i++) {
      const id = 'alerta-' + String(i).padStart(3, '0');
      // criadoEm crescente: o mais novo (i=299) e o que a tela usa como "desde"
      DOCS.set('alertasCentral/' + id, {
        id, tipo: 'teste', titulo: 'Alerta ' + i, resumo: null, url: '/', critico: false,
        criadoEm: new Date(Date.UTC(2026, 7, 1, 0, 0, i)).toISOString(),
        atendidoEm: null, atendidoPorEmail: null,
      });
    }
    const maisNovo = new Date(Date.UTC(2026, 7, 1, 0, 0, 299)).toISOString();

    // abertura da tela: paga a lista inteira uma vez, e so
    const antesCompleta = LEITURAS.docs;
    const completa = JSON.parse((await pedir('/api/alertas-central', cabAlertas)).corpo);
    const custoAbertura = LEITURAS.docs - antesCompleta;

    // 10 batidas do polling sem alerta novo. Com o cache incremental de 8s a
    // maioria nem chega no Firestore; o teto aceitavel e 1 leitura por batida
    const antesPolling = LEITURAS.docs;
    for (let i = 0; i < 10; i++) {
      await pedir('/api/alertas-central?desde=' + encodeURIComponent(maisNovo), cabAlertas);
    }
    const custoPolling = LEITURAS.docs - antesPolling;

    // e um alerta NOVO ainda tem que aparecer pra tela. Contagem relativa
    // porque os testes anteriores deste arquivo ja registraram alertas de
    // verdade (NOC, QA...) mais novos que os semeados aqui
    const antesDoNovo = JSON.parse((await pedir('/api/alertas-central?desde=' + encodeURIComponent(maisNovo), cabAlertas)).corpo);
    await alertasCentral.registrar({ tipo: 'teste', titulo: 'chegou agora' });
    const novos = JSON.parse((await pedir('/api/alertas-central?desde=' + encodeURIComponent(maisNovo), cabAlertas)).corpo);

    const apareceu = novos.length === antesDoNovo.length + 1 && novos.some((a) => a.titulo === 'chegou agora');
    okCustoAlertas = completa.length === 300 && custoPolling <= 10 && apareceu;
    if (!okCustoAlertas) {
      console.log(`  (lista completa: ${completa.length}, esperado 300 · 10 batidas do polling: ${custoPolling}, teto 10 · alertas novos: ${antesDoNovo.length} -> ${novos.length}, esperado +1 com "chegou agora")`);
    }
  } catch (e) { okCustoAlertas = false; console.log('  erro: ' + e.message); }
  if (!okCustoAlertas) ruins += 1;
  console.log(`${okCustoAlertas ? '✓' : '✗'} Central de Alertas: polling incremental custa ~1 leitura por batida (era 300) e ainda mostra alerta novo`);

  // ------------------------------------------------------------------
  // Importacao do Grupo Bravo: a planilha permite MAIS DE UMA LINHA no mesmo
  // dia pra mesma loja (sangria lançada à parte, turno partido). O
  // fechamentosLive.create() recusa a segunda ("Já existe um fechamento"),
  // entao sem juntar as linhas ANTES de gravar o dia entrava no sistema com
  // so um pedaço do faturamento - foi o que aconteceu na primeira importacao.
  // A ARCFOOD nunca sofreu disso porque a sincronizacao dela ja passa por
  // mesclarLancamentosDoMesmoDia. Este teste trava a mescla equivalente.
  let okMesclaBravo = false;
  try {
    const bravoImport = require('/home/user/adyen-monitor/server/bravoImport.js');
    const linha = (extra) => ({
      unidade: 'Dom Bessa', unidadeNome: 'Dom Bessa', grupo: 'BRAVO', data: '2026-03-10',
      gerente: '', campos: {}, canaisVendaExtras: {}, formasPagamentoExtras: {}, kpisExtras: {},
      observacao: null, detalhesMaquinas: [], detalhesSaidas: [],
      origemPlanilha: { sheetId: 'x', idLinha: 'l1' }, ...extra,
    });

    const entrada = [
      // fechamento de verdade
      linha({
        campos: { delivery: 1000, loja: 500, caixaInicial: 200, caixaFinal: 300, entradaDinheiro: 400, totalSaida: 50 },
        kpisExtras: { quantidadeDePedidos: 30 },
        detalhesSaidas: [{ descricao: 'gás', valor: 50 }],
        observacao: 'fechamento',
        origemPlanilha: { sheetId: 'x', idLinha: 'l1' },
      }),
      // sangria do mesmo dia: faturamento zerado, so a saida preenchida.
      // Caixa Inicial/Final vem preenchido errado de proposito - se a mescla
      // somar esses dois, inventa dinheiro que nunca existiu
      linha({
        campos: { delivery: 0, loja: 0, caixaInicial: 999, caixaFinal: 999, entradaDinheiro: 100, totalSaida: 70 },
        kpisExtras: { quantidadeDePedidos: 5 },
        detalhesSaidas: [{ descricao: 'sangria', valor: 70 }],
        observacao: 'sangria',
        origemPlanilha: { sheetId: 'x', idLinha: 'l2' },
      }),
      // outro dia, linha unica: tem que passar intacta
      linha({ data: '2026-03-11', campos: { delivery: 700, caixaInicial: 111 }, origemPlanilha: { sheetId: 'x', idLinha: 'l3' } }),
    ];

    const r = bravoImport.mesclarPorDia(entrada);
    const dia10 = r.lancamentos.find((l) => l.data === '2026-03-10');
    const dia11 = r.lancamentos.find((l) => l.data === '2026-03-11');

    const conferencias = {
      'juntou os 2 numa linha só': r.lancamentos.length === 2 && r.mesclados === 1 && r.linhasAbsorvidas === 1,
      'somou os movimentos': dia10.campos.delivery === 1000 && dia10.campos.entradaDinheiro === 500 && dia10.campos.totalSaida === 120,
      'NÃO somou saldo de caixa': dia10.campos.caixaInicial === 200 && dia10.campos.caixaFinal === 300,
      'somou os KPIs extras': dia10.kpisExtras.quantidadeDePedidos === 35,
      'concatenou os detalhes de saída': dia10.detalhesSaidas.length === 2,
      'juntou as observações': dia10.observacao === 'fechamento · sangria',
      'guardou o rastro das 2 linhas': (dia10.origemPlanilha.idsLinhas || []).join(',') === 'l1,l2',
      'dia de linha única passou intacto': dia11.campos.delivery === 700 && dia11.campos.caixaInicial === 111,
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([nome]) => nome);
    okMesclaBravo = !falhas.length;
    if (falhas.length) console.log('  falhou em: ' + falhas.join(' · '));
  } catch (e) { okMesclaBravo = false; console.log('  erro: ' + e.message); }
  if (!okMesclaBravo) ruins += 1;
  console.log(`${okMesclaBravo ? '✓' : '✗'} Grupo Bravo: linhas do mesmo dia+loja são somadas antes de gravar (saldo de caixa fica de fora)`);

  // ------------------------------------------------------------------
  // O importador do Bravo descartava linha em SILENCIO (return null): 8 lojas
  // ficaram sem historico e nao havia como saber por que. Agora toda linha
  // recusada devolve o motivo, e o nome da loja e reconhecido mesmo com
  // acento/caixa/espaco diferentes do cadastro.
  let okDiagBravo = false;
  try {
    const bravoImport = require('/home/user/adyen-monitor/server/bravoImport.js');
    const header = ['ID', 'Unidade', 'Data', 'Nome', 'Delivery'];
    const aval = (linha) => bravoImport.avaliarLinha(header, linha, 'Dominos Bessa');

    // "10-03-2026" DEIXOU de ser erro (o parser passou a aceitar tracinho);
    // o que continua sem leitura possivel e texto livre
    const dataRuim = aval(['abc123', 'Dominos Bessa', '10 de março', 'Ana', '100']);
    const dataVazia = aval(['abc123', 'Dominos Bessa', '', 'Ana', '100']);
    const excluido = aval(['7fcda565', 'Dominos Bessa', '10/03/2026', 'Ana', '100']);
    const boa = aval(['abc123', 'Dominos Bessa', '10/03/2026', 'Ana', '100']);

    const conferencias = {
      'data em formato errado diz o motivo': /formato que o importador não lê/.test(dataRuim.motivo || '') && (dataRuim.amostra || '').includes('10 de março'),
      'data vazia diz o motivo': /formato que o importador não lê/.test(dataVazia.motivo || ''),
      'ID excluído diz o motivo': /lista de exclusão/.test(excluido.motivo || ''),
      'linha boa vira lançamento': !!boa.lancamento && boa.lancamento.data === '2026-03-10',
      // reconhecimento tolerante do nome da loja
      'nome exato resolve': bravoImport.resolverUnidade('Dominos Bessa') === 'Dominos Bessa',
      'CAIXA ALTA resolve': bravoImport.resolverUnidade('DOMINOS BESSA') === 'Dominos Bessa',
      'espaço sobrando resolve': bravoImport.resolverUnidade('  Dominos  Bessa ') === 'Dominos Bessa',
      'sem acento resolve': bravoImport.resolverUnidade('Sao Braz IL') === 'São Braz IL',
      'loja de outro grupo NÃO resolve': bravoImport.resolverUnidade('Mooca') === null,
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([nome]) => nome);
    okDiagBravo = !falhas.length;
    if (falhas.length) console.log('  falhou em: ' + falhas.join(' · '));
  } catch (e) { okDiagBravo = false; console.log('  erro: ' + e.message); }
  if (!okDiagBravo) ruins += 1;
  console.log(`${okDiagBravo ? '✓' : '✗'} Grupo Bravo: nenhuma linha é descartada em silêncio (motivo + nome de loja tolerante)`);

  // ------------------------------------------------------------------
  // Data da planilha do Bravo: as abas foram reorganizadas em momentos
  // diferentes e nem todas ficaram no mesmo formato. O parser antigo so
  // entendia DD/MM/AAAA e descartava o resto EM SILENCIO - principal
  // suspeita do sumico do historico. Tambem: ID vazio nao pode mais derrubar
  // a linha (nas abas refeitas a mao ele quase nunca foi preenchido).
  let okDataBravo = false;
  try {
    const bravoImport = require('/home/user/adyen-monitor/server/bravoImport.js');
    const header = ['ID', 'Unidade', 'Data', 'Delivery'];
    const dataDe = (v) => {
      const r = bravoImport.avaliarLinha(header, ['x1', 'Dominos Bessa', v, '100'], 'Dominos Bessa');
      return r.lancamento ? r.lancamento.data : null;
    };
    const semId = bravoImport.avaliarLinha(header, ['', 'Dominos Bessa', '28/11/2025', '100'], 'Dominos Bessa');

    const conferencias = {
      'DD/MM/AAAA': dataDe('28/11/2025') === '2025-11-28',
      'ano de 2 digitos': dataDe('28/11/25') === '2025-11-28',
      'separador tracinho': dataDe('28-11-2025') === '2025-11-28',
      'separador ponto': dataDe('28.11.2025') === '2025-11-28',
      'ja no formato do banco': dataDe('2025-11-28') === '2025-11-28',
      'numero de serie do Sheets': dataDe('45989') === '2025-11-28',
      'data impossivel continua recusada': dataDe('13/13/2025') === null,
      'texto continua recusado': dataDe('sei la') === null,
      'numero pequeno nao vira data': dataDe('1234') === null,
      'ID vazio NAO derruba a linha': !!semId.lancamento && semId.lancamento.data === '2025-11-28',
      'ID vazio fica marcado na origem': !!semId.lancamento && semId.lancamento.origemPlanilha.semIdNaPlanilha === true,
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([n]) => n);
    okDataBravo = !falhas.length;
    if (falhas.length) console.log('  falhou em: ' + falhas.join(' · '));
  } catch (e) { okDataBravo = false; console.log('  erro: ' + e.message); }
  if (!okDataBravo) ruins += 1;
  console.log(`${okDataBravo ? '✓' : '✗'} Grupo Bravo: data lida em vários formatos e ID vazio não descarta o fechamento`);

  // Semelhanca entre nomes de coluna - e o que decide se o importador PERGUNTA
  // "quer unificar?" ou propoe campo novo. Precisa acertar os dois lados: nao
  // pode deixar passar sinonimo obvio nem sugerir unificar coisa sem relacao.
  let okSemelhanca = false;
  try {
    const bravoImport = require('/home/user/adyen-monitor/server/bravoImport.js');
    const sim = bravoImport.semelhanca;
    const conferencias = {
      'identicas dao 1': sim('tef credito', 'tef credito') === 1,
      'quase iguais pontuam alto': sim('tef credito', 'tef credit') > 0.7,
      'ordem trocada ainda pontua': sim('getnet pix', 'pix getnet') > 0.5,
      'sem relacao pontua baixo': sim('dinheiro', 'delivery') < 0.4,
      'vazio da zero': sim('', 'dinheiro') === 0,
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([n]) => n);
    okSemelhanca = !falhas.length;
    if (falhas.length) console.log('  falhou em: ' + falhas.join(' · '));
  } catch (e) { okSemelhanca = false; console.log('  erro: ' + e.message); }
  if (!okSemelhanca) ruins += 1;
  console.log(`${okSemelhanca ? '✓' : '✗'} Grupo Bravo: comparador de nomes de coluna separa sinônimo de coisa sem relação`);

  // ------------------------------------------------------------------
  // Cabecalho da aba: a leitura assumia que o cabecalho era a LINHA 1 e que a
  // coluna se chamava exatamente "Unidade". Aba reorganizada costuma ganhar
  // titulo/linha em branco em cima - e quando isso acontecia a aba INTEIRA era
  // pulada em silencio, sem entrar nem no relatorio de descartes. Era o ponto
  // cego que escondia o sumico das Domino's.
  let okCabecalhoBravo = false;
  try {
    const bravoImport = require('/home/user/adyen-monitor/server/bravoImport.js');
    const { acharCabecalho, indiceDaColuna } = bravoImport;

    const naLinha1 = acharCabecalho([['ID', 'Unidade', 'Data'], ['x', 'Dominos Bessa', '01/12/2025']]);
    const comTitulo = acharCabecalho([
      ['FECHAMENTO DE CAIXA - DOM BESSA'], [],
      ['ID', 'Unidade', 'Data'], ['x', 'Dominos Bessa', '01/12/2025'],
    ]);
    const caixaAlta = acharCabecalho([['ID', 'UNIDADE', 'DATA']]);
    const apelido = acharCabecalho([['ID', 'Loja', 'Data']]);
    const semNada = acharCabecalho([['a', 'b'], ['c', 'd']]);
    const fundo = acharCabecalho(Array.from({ length: 30 }, (_, i) => (i === 20 ? ['Unidade'] : ['x'])));

    const header = ['ID', 'Unidade ', 'Pick-Up', 'TEF Crédito'];
    const conferencias = {
      'cabecalho na linha 1': naLinha1 && naLinha1.linhaCabecalho === 0 && naLinha1.iUnidade === 1,
      'cabecalho abaixo de um titulo': comTitulo && comTitulo.linhaCabecalho === 2 && comTitulo.iUnidade === 1,
      'CAIXA ALTA no cabecalho': caixaAlta && caixaAlta.iUnidade === 1,
      'apelido "Loja" tambem vale': apelido && apelido.iUnidade === 1,
      'aba sem Unidade devolve null': semNada === null,
      'nao procura alem das 10 primeiras linhas': fundo === null,
      'coluna com espaco no fim': indiceDaColuna(header, 'Unidade') === 1,
      'coluna com caixa diferente': indiceDaColuna(header, 'Pick-UP') === 2,
      'coluna com acento diferente': indiceDaColuna(header, 'TEF Credito') === 3,
      'coluna inexistente da -1': indiceDaColuna(header, 'Delivery') === -1,
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([n]) => n);
    okCabecalhoBravo = !falhas.length;
    if (falhas.length) console.log('  falhou em: ' + falhas.join(' · '));
  } catch (e) { okCabecalhoBravo = false; console.log('  erro: ' + e.message); }
  if (!okCabecalhoBravo) ruins += 1;
  console.log(`${okCabecalhoBravo ? '✓' : '✗'} Grupo Bravo: acha o cabeçalho mesmo com título em cima e casa coluna sem depender de acento/caixa`);

  // ------------------------------------------------------------------
  // O parser do Bravo lendo uma linha REAL da planilha (Campina Grande
  // 07/04/26). Essa aba e a unica que ainda traz as colunas "Faturam." e
  // "Total Decla" calculadas pela propria planilha - ou seja, da pra conferir
  // o resultado do importador contra o numero que o Grupo Bravo ja usava.
  // Foi isso que provou que a leitura das Domino's NUNCA esteve errada: o que
  // faltava era a gravacao chegar ate elas (sao as 5 ultimas abas, e o request
  // morria no timeout antes). Se este teste quebrar, o parser regrediu.
  let okLinhaReal = false;
  try {
    const bravoImport = require('/home/user/adyen-monitor/server/bravoImport.js');
    const header = ['ID', 'Nome', 'Unidade', 'Data', 'Caixa Inicial', 'Caixa Final', 'Delivery', 'Carryout',
      'Pick-UP', 'Loja', 'AdyenV2', 'Pix CNPJ', 'Ifood', 'Outros', 'MaqBalcao', 'PosMaqBalcao', 'Maquina02',
      'Entrada Dinheiro', 'Deposito', 'Total Saida', 'Faturam.', 'Total Decla', 'Dif.'];
    const linha = ['76319b53', 'Maisa Lana', 'Dominos Campina Grande', '07/04/26', 'R$  -', 'R$  255,00',
      'R$  -', 'R$  858,13', 'R$  -', 'R$  331,40', 'R$  -', 'R$  -', 'R$  -', 'R$  55,90',
      'R$  650,00', '', 'R$  225,13', 'R$  255,00', 'R$  -', 'R$  -', 'R$  1.189,53', 'R$  1.186,03', 'R$  (3,50)'];

    const r = bravoImport.avaliarLinha(header, linha, 'Dominos Campina Grande');
    const t = r.lancamento ? bravoImport.totaisPrevistos(r.lancamento) : null;
    const conferencias = {
      'a linha vira lançamento': !!r.lancamento,
      'data 07/04/26 -> 2026-04-07': r.lancamento && r.lancamento.data === '2026-04-07',
      'faturamento bate com a coluna Faturam. da planilha': t && t.faturamento === 1189.53,
      'declarado bate com a coluna Total Decla da planilha': t && t.totalDeclarado === 1186.03,
      'maquininhas somadas no campo adyen': r.lancamento && r.lancamento.campos.adyen === 875.13,
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([n]) => n);
    okLinhaReal = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')} (faturamento=${t && t.faturamento}, declarado=${t && t.totalDeclarado})`);
  } catch (e) { okLinhaReal = false; console.log('  erro: ' + e.message); }
  if (!okLinhaReal) ruins += 1;
  console.log(`${okLinhaReal ? '✓' : '✗'} Grupo Bravo: linha real da Domino's bate centavo a centavo com o Faturam./Total Decla da planilha`);

  // ------------------------------------------------------------------
  // Chamada entre modulos com nome que NAO EXISTE. Foi assim que
  // "grupos.listar is not a function" chegou em producao: grupos.js exporta
  // list(), nao listar(). node --check nao pega (a sintaxe esta certa) e o
  // teste de rotas so pegaria se a rota fosse exercitada de verdade - e a
  // rota nova dependia da planilha, entao nunca rodava aqui. Esta varredura
  // e estatica: le o module.exports de cada modulo local e confere toda
  // chamada alias.metodo() contra ele.
  let okChamadas = false;
  try {
    const fs = require('fs'); const path = require('path');
    // metodos de Array/Object/String: se aparecem, o "alias" e uma variavel
    // local que por acaso tem o mesmo nome do modulo, nao o modulo
    const NATIVOS = new Set(['map', 'forEach', 'filter', 'find', 'findIndex', 'reduce', 'some', 'every',
      'slice', 'splice', 'sort', 'push', 'pop', 'shift', 'unshift', 'join', 'concat', 'includes',
      'indexOf', 'reverse', 'flat', 'flatMap', 'keys', 'values', 'entries', 'toString', 'trim',
      'split', 'replace', 'match', 'padStart', 'toFixed', 'then', 'catch', 'finally', 'js']);
    const semComentario = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const exportsDe = (arq) => {
      let src; try { src = semComentario(fs.readFileSync(path.join(__dirname, arq), 'utf8')); } catch (e) { return null; }
      const nomes = new Set();
      const m = src.match(/module\.exports\s*=\s*\{([\s\S]*?)\}\s*;/);
      if (m) m[1].split(',').forEach((x) => { const n = x.split(':')[0].trim(); if (/^[A-Za-z_$][\w$]*$/.test(n)) nomes.add(n); });
      [...src.matchAll(/(?:module\.)?exports\.(\w+)\s*=/g)].forEach((x) => nomes.add(x[1]));
      return nomes.size ? nomes : null;
    };
    const quebradas = [];
    for (const arq of fs.readdirSync(__dirname).filter((f) => f.endsWith('.js'))) {
      const src = semComentario(fs.readFileSync(path.join(__dirname, arq), 'utf8'));
      for (const [, alias, mod] of src.matchAll(/const (\w+) = require\('\.\/([\w-]+)'\)/g)) {
        const ex = exportsDe(mod + '.js');
        if (!ex) continue;
        // alias redeclarado como variavel local no mesmo arquivo? entao nao da
        // pra afirmar que a chamada e no modulo - fica de fora
        if (new RegExp(`(?:const|let|var)\\s+${alias}\\s*=(?!\\s*require)`).test(src)) continue;
        for (const [, nome] of src.matchAll(new RegExp(`\\b${alias}\\.(\\w+)\\s*\\(`, 'g'))) {
          if (!NATIVOS.has(nome) && !ex.has(nome)) quebradas.push(`${arq}: ${alias}.${nome}() não existe em ${mod}.js`);
        }
      }
    }
    const unicas = [...new Set(quebradas)];
    okChamadas = !unicas.length;
    if (unicas.length) unicas.slice(0, 8).forEach((q) => console.log('  ' + q));
  } catch (e) { okChamadas = false; console.log('  erro: ' + e.message); }
  if (!okChamadas) ruins += 1;
  console.log(`${okChamadas ? '✓' : '✗'} nenhum módulo chama função que o outro não exporta (pega "x.y is not a function" antes do deploy)`);

  // ------------------------------------------------------------------
  // Fatiamento da gravacao do Bravo. Gravar loja por loja resolveu a ordem
  // das abas, mas cada chamada continuava relendo as 12 abas pela API do
  // Sheets antes de filtrar - 144 leituras remotas no total - e uma loja com
  // ~250 dias ainda e ~250 escritas sequenciais no Firestore. As duas coisas
  // juntas estouravam o tempo do request e o navegador devolvia "Failed to
  // fetch" nas 12 lojas. A leitura virou cacheada e a gravacao virou fatiada
  // (pular/limite). Este teste trava a aritmetica das fatias.
  let okFatias = false;
  try {
    const bravoImport = require('/home/user/adyen-monitor/server/bravoImport.js');
    // simula o laco que a tela faz: pede blocos de LOTE ate restam=0
    const fatiar = (total, lote) => {
      const blocos = [];
      let pular = 0;
      for (let guarda = 0; guarda < 1000; guarda += 1) {
        const fim = lote > 0 ? pular + lote : total;
        const processados = Math.max(Math.min(fim, total) - pular, 0);
        const restam = Math.max(total - fim, 0);
        blocos.push({ pular, processados, restam });
        pular += lote;
        if (!restam) break;
      }
      return blocos;
    };
    const b250 = fatiar(250, 40);
    const b40 = fatiar(40, 40);
    const b0 = fatiar(0, 40);

    const conferencias = {
      '250 dias em blocos de 40 = 7 chamadas': b250.length === 7,
      'nenhum dia fica de fora': b250.reduce((s, x) => s + x.processados, 0) === 250,
      'nenhum dia e processado duas vezes': b250[b250.length - 1].pular + b250[b250.length - 1].processados === 250,
      'so o ultimo bloco tem restam=0': b250.filter((x) => x.restam === 0).length === 1,
      'total exatamente igual ao lote nao gera bloco vazio': b40.length === 1 && b40[0].restam === 0,
      'loja sem nenhum dia termina na primeira chamada': b0.length === 1 && b0[0].processados === 0 && b0[0].restam === 0,
      'invalidarLeitura existe (a rota chama depois de decidir colunas)': typeof bravoImport.invalidarLeitura === 'function',
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([n]) => n);
    okFatias = !falhas.length;
    if (falhas.length) console.log('  falhou em: ' + falhas.join(' · '));
  } catch (e) { okFatias = false; console.log('  erro: ' + e.message); }
  if (!okFatias) ruins += 1;
  console.log(`${okFatias ? '✓' : '✗'} Grupo Bravo: gravação fatiada cobre todos os dias sem repetir nem pular`);

  // ------------------------------------------------------------------
  // A conferencia de campos do Bravo era GLOBAL: um campo faltando no grupo
  // das Domino's derrubava a importacao do Spoleto, do Milky Moo e do Sao
  // Braz junto - 11 lojas recusadas pela mesma mensagem, sendo que so uma
  // familia de lojas tinha pendencia. Agora conferirCampos(unidade) olha so
  // o grupo daquela loja.
  let okEscopoCampos = false;
  try {
    const bravoImport = require('/home/user/adyen-monitor/server/bravoImport.js');
    const grupos = require('/home/user/adyen-monitor/server/grupos.js');

    const bravoMapa = require('/home/user/adyen-monitor/server/bravoMapa.js');
    // O modelo "dominos" nao pede campo extra nenhum (canais/formas vazios) -
    // a pendencia real vem de uma DECISAO DE COLUNA do Master (bravoMapa) com
    // acao "criar", que passa a valer pros dois grupos. Foi o que aconteceu em
    // producao: o Spoleto ja tinha o campo cadastrado de uma rodada anterior
    // do passo 3, o grupo das Domino's nao - e a checagem global barrava as 11
    // lojas por causa de um campo que so faltava num grupo.
    DOCS.set('bravoImportMapa/principal', {
      colunas: {
        'taxa entrega': { coluna: 'Taxa Entrega', acao: 'criar', destino: 'canal', label: 'Taxa Entrega' },
      },
    });
    bravoMapa.invalidarCache();

    const campoNovo = { campo: bravoImport.MODELOS ? 'taxaEntrega' : 'taxaEntrega', label: 'Taxa Entrega', operacao: 'soma', tambemNoOutroTotal: false };
    DOCS.set('grupos/g-spoleto', {
      id: 'g-spoleto', nome: 'Spoleto GBE', unidades: ['Spoleto Shopping Recife'],
      // ja tem tudo: o que o modelo pede + o campo criado pela decisao
      canaisVendaExtras: [...bravoImport.definicoesDeCampos('Spoleto Shopping Recife').canais],
      formasPagamentoExtras: bravoImport.definicoesDeCampos('Spoleto Shopping Recife').formas,
      kpisExtras: bravoImport.definicoesDeCampos('Spoleto Shopping Recife').kpis,
    });
    DOCS.set('grupos/g-dominos', {
      id: 'g-dominos', nome: "Domino's GBE", unidades: ['Dominos Bessa'],
      canaisVendaExtras: [], formasPagamentoExtras: [], kpisExtras: [], // falta o campo novo
    });
    grupos.invalidarCache();

    const doSpoleto = await bravoImport.conferirCampos('Spoleto Shopping Recife');
    const global = await bravoImport.conferirCampos();

    const pendenteDeOutroGrupo = (r) => (r.pendentes || []).some((p) => /Domino/.test(p.grupoNome || ''));
    const conferencias = {
      // esta primeira e a que prova que a fixture e real: sem ela, "nao
      // aparece no escopo do Spoleto" passaria mesmo se NUNCA aparecesse
      'a pendência das Domino\'s existe de verdade (conferência global vê)': pendenteDeOutroGrupo(global),
      'conferindo o Spoleto, a pendência das Domino\'s NÃO aparece': !pendenteDeOutroGrupo(doSpoleto),
      'conferirCampos aceita o filtro sem estourar': Array.isArray(doSpoleto.pendentes),
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([n]) => n);
    okEscopoCampos = !falhas.length;
    if (falhas.length) console.log('  falhou em: ' + falhas.join(' · '));
  } catch (e) { okEscopoCampos = false; console.log('  erro: ' + e.message); }
  if (!okEscopoCampos) ruins += 1;
  console.log(`${okEscopoCampos ? '✓' : '✗'} Grupo Bravo: campo faltando num grupo não bloqueia a importação das lojas dos outros grupos`);

  // ------------------------------------------------------------------
  // O painel de importacao do Bravo nao pode ter beco sem saida: os botoes 4
  // (Gravar) e 5 (Completar) ficavam DESABILITADOS quando o passo 1 achava
  // pendencia de campo, e so o passo 3 os reabilitava. Como o passo 4 passou
  // a rodar o passo 3 sozinho, essa trava so servia pra deixar o Master preso
  // olhando um botao apagado. Varredura no HTML pra nao voltar.
  let okBotoesImport = false;
  try {
    const html = require('fs').readFileSync(require('path').join(__dirname, 'public', 'fechamentos.html'), 'utf8');
    const botao = (id) => (html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`)) || [''])[0];
    const gravar = botao('imp-btn-3');
    const completar = botao('imp-btn-4');
    const conferir = botao('imp-btn-1');

    const conferencias = {
      'o botão Gravar existe': !!gravar,
      'o botão Completar existe': !!completar,
      'Gravar não nasce desabilitado': !!gravar && !/\bdisabled\b/.test(gravar),
      'Completar não nasce desabilitado': !!completar && !/\bdisabled\b/.test(completar),
      'Conferir também não': !!conferir && !/\bdisabled\b/.test(conferir),
      'a gravação prepara os grupos sozinha antes': /acao:'cadastrar-campos'/.test(html.replace(/\s/g, '')) ,
      'a gravação descobre as lojas se o passo 1 não rodou': /if\(!UNIDADES_IMPORT\.length\)/.test(html),
      'não sobrou trava condicional reabilitando 4 e 5': !/if\(!pend\.length\)\{\s*btns\[3\]/.test(html),
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([n]) => n);
    okBotoesImport = !falhas.length;
    if (falhas.length) console.log('  falhou em: ' + falhas.join(' · '));
  } catch (e) { okBotoesImport = false; console.log('  erro: ' + e.message); }
  if (!okBotoesImport) ruins += 1;
  console.log(`${okBotoesImport ? '✓' : '✗'} Importação do Bravo: passo 4 funciona sozinho (não depende de clicar no 3 antes)`);

  // ------------------------------------------------------------------
  // Leitura do relatorio por foto (lancamento.html): a leitura NAO pode
  // disparar no "change" do input. Antes disso, abrir a galeria e tocar numa
  // foto ja gastava a chamada - sem chance de conferir se escolheu a foto
  // certa, trocar uma delas ou desistir. Agora sao dois passos: escolher e
  // depois "Realizar leitura".
  let okDoisPassosFoto = false;
  try {
    const html = require('fs').readFileSync(require('path').join(__dirname, 'public', 'lancamento.html'), 'utf8');
    // o corpo do listener de change, pra garantir que ele NAO envia nada
    const listener = (html.match(/addEventListener\('change',[\s\S]*?\n\}\);/) || [''])[0];
    const conferencias = {
      'existe o botão de escolher': /id="btn-escolher-relatorio"/.test(html),
      'existe o botão de realizar leitura': /id="btn-ler-canais"[^>]*onclick="realizarLeituraRelatorio\(\)"/.test(html),
      'o botão de leitura nasce desabilitado': /id="btn-ler-canais"[^>]*\bdisabled\b/.test(html),
      'o listener de change NÃO chama fetch': !!listener && !/fetch\(/.test(listener),
      'o listener de change NÃO chama a leitura': !!listener && !/realizarLeituraRelatorio\(/.test(listener),
      'a leitura de verdade continua batendo na rota': /realizarLeituraRelatorio[\s\S]*?ler-canais/.test(html),
      'dá pra limpar a seleção': /limparSelecaoRelatorio/.test(html),
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([n]) => n);
    okDoisPassosFoto = !falhas.length;
    if (falhas.length) console.log('  falhou em: ' + falhas.join(' · '));
  } catch (e) { okDoisPassosFoto = false; console.log('  erro: ' + e.message); }
  if (!okDoisPassosFoto) ruins += 1;
  console.log(`${okDoisPassosFoto ? '✓' : '✗'} Foto do relatório: escolher e ler são dois passos (escolher não envia nada)`);

  // ------------------------------------------------------------------
  // Gravar do Bravo tem que RECONCILIAR, nao "inserir se nao existir". As
  // primeiras importacoes (antes das correcoes de ordem de aba, timeout e
  // mescla) deixaram dias gravados pela metade; numa segunda passada esses
  // dias caiam em "jaExistiam" e eram pulados, entao o valor errado ficava la
  // pra sempre - o buraco no meio do grafico de Bessa/Tirol/Garanhuns/MilkyMoo.
  let okReconciliar = false;
  try {
    const fs = require('fs');
    const src = fs.readFileSync(require('path').join(__dirname, 'bravoImport.js'), 'utf8');
    const assinatura = (src.match(/async function importar\(\{[^}]*\}/) || [''])[0];

    const bravoImport = require('/home/user/adyen-monitor/server/bravoImport.js');
    // chamada sem confirmar tem que ser recusada - a trava de seguranca segue
    let recusou = false;
    try { await bravoImport.importar({}); } catch (e) { recusou = /não confirmada/i.test(e.message); }

    const html = fs.readFileSync(require('path').join(__dirname, 'public', 'fechamentos.html'), 'utf8');
    const conferencias = {
      'importar() reconcilia por padrão (repor = true)': /repor\s*=\s*true/.test(assinatura),
      'sem confirmar continua recusando': recusou,
      'a tela devolve os meses vazios DA PLANILHA': /mesesVaziosNaPlanilha/.test(src) && /mesesVaziosNaPlanilha/.test(html),
      'a tela devolve o período coberto pela planilha': /primeiraData/.test(src) && /primeiraData/.test(html),
      'o botão 4 fala em atualizar, não só gravar': /4 · Gravar \/ atualizar tudo/.test(html),
      // no HTML o class vem ANTES do id nesse botao - pega a tag inteira
      'o passo 5 saiu da frente do usuário': /\bhidden\b/.test((html.match(/<button[^>]*id="imp-btn-4"[^>]*>/) || [''])[0]),
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([n]) => n);
    okReconciliar = !falhas.length;
    if (falhas.length) console.log('  falhou em: ' + falhas.join(' · '));
  } catch (e) { okReconciliar = false; console.log('  erro: ' + e.message); }
  if (!okReconciliar) ruins += 1;
  console.log(`${okReconciliar ? '✓' : '✗'} Grupo Bravo: gravar reconcilia todo dia contra a planilha (não pula o que já existe)`);

  // ------------------------------------------------------------------
  // Reordenar coluna arrastando o PROPRIO cabecalho da tabela. A
  // reordenacao ja existia, mas so dentro do modal 🧩 Colunas - lugar onde
  // ninguem procura. O arrasto no cabecalho tem que usar o MESMO estado e a
  // MESMA gravacao (nada de segunda fonte de verdade), e Data/Unid. nao
  // podem arrastar (sao as ancoras da tabela).
  let okArrastoColuna = false;
  try {
    const html = require('fs').readFileSync(require('path').join(__dirname, 'public', 'fechamentos.html'), 'utf8');
    const semEspaco = html.replace(/\s+/g, ' ');
    const conferencias = {
      'o cabeçalho vira arrastável': /class="th-move" draggable="true" data-col=/.test(semEspaco),
      'Data e Unid. seguem fora do arrasto': /const fixa = \(k\)=> k==='data' \|\| k==='unidadeNome'/.test(semEspaco),
      'soltar reordena e grava': /function soltarColunaTabela[\s\S]*?persistirColunas\(\)/.test(html),
      'a gravação é compartilhada com o seletor': (html.match(/persistirColunas\(\)/g) || []).length >= 2
        && /function persistirColunas\(\)/.test(html),
      'a ordem continua indo pro relatório': /params\.set\('ordem', ORDEM_COLUNAS\.join\(','\)\)/.test(html),
      'a ordem continua sendo salva no servidor': /\/api\/preferencias\/'\+PREF_COLUNAS/.test(html),
      'existe pista visual de que dá pra arrastar': /th\.th-move\{cursor:grab/.test(semEspaco),
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([n]) => n);
    okArrastoColuna = !falhas.length;
    if (falhas.length) console.log('  falhou em: ' + falhas.join(' · '));
  } catch (e) { okArrastoColuna = false; console.log('  erro: ' + e.message); }
  if (!okArrastoColuna) ruins += 1;
  console.log(`${okArrastoColuna ? '✓' : '✗'} Fechamentos: coluna se move arrastando o cabeçalho, com a mesma gravação do seletor`);

  // ------------------------------------------------------------------
  // gzip de verdade, ponta a ponta: o Render free tem 5 GB/mes de banda e o
  // servico foi suspenso por estourar isso - o app mandava tudo cru
  // (/api/fechamentos ~2,1 MB por chamada; com gzip, ~0,30 MB). Aqui uma
  // requisicao com Accept-Encoding: gzip a uma pagina grande tem que voltar
  // comprimida E o corpo descomprimido tem que bater com o original. O SSE
  // (/api/stream) fica de fora do gzip - comprimido, o event-stream so
  // chegaria quando o buffer enchesse, matando o tempo real.
  let okGzip = false;
  try {
    const zlib = require('zlib');
    const pedirGzip = (caminho) => new Promise((resolve) => {
      const req = require('http').request({
        host: '127.0.0.1', port: 8899, path: caminho,
        headers: { 'Accept-Encoding': 'gzip' },
      }, (res) => {
        const pedacos = [];
        res.on('data', (c) => pedacos.push(c));
        res.on('end', () => resolve({ status: res.statusCode, encoding: res.headers['content-encoding'] || null, corpo: Buffer.concat(pedacos) }));
      });
      req.on('error', () => resolve({ status: 0, encoding: null, corpo: Buffer.alloc(0) }));
      req.setTimeout(5000, () => { req.destroy(); resolve({ status: -1, encoding: null, corpo: Buffer.alloc(0) }); });
      req.end();
    });

    const comGzip = await pedirGzip('/fechamentos.html');
    const semGzip = await pedir('/fechamentos.html');
    const descomprimido = comGzip.encoding === 'gzip' ? zlib.gunzipSync(comGzip.corpo).toString('utf8') : comGzip.corpo.toString('utf8');

    const src = require('fs').readFileSync(require('path').join(__dirname, 'index.js'), 'utf8');
    const conferencias = {
      'resposta grande volta comprimida': comGzip.status === 200 && comGzip.encoding === 'gzip',
      'comprimida e de fato menor': comGzip.corpo.length < Buffer.byteLength(semGzip.corpo) / 2,
      'o corpo descomprimido bate com o original': descomprimido === semGzip.corpo,
      'o SSE fica fora do gzip (filtro no codigo)': /req\.path === '\/api\/stream'\) return false/.test(src),
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([n]) => n);
    okGzip = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')} (encoding=${comGzip.encoding}, ${comGzip.corpo.length} vs ${Buffer.byteLength(semGzip.corpo)} bytes)`);
  } catch (e) { okGzip = false; console.log('  erro: ' + e.message); }
  if (!okGzip) ruins += 1;
  console.log(`${okGzip ? '✓' : '✗'} gzip ligado: resposta grande sai ~7x menor e o SSE segue sem compressão`);

  // Toda pagina que chama /api/ PRECISA mandar o token do login no header.
  // Sem isso o servidor devolve 401 e a pagina mostra "Você não tem acesso a
  // esta página" pra todo mundo, Master inclusive - parece falta de
  // permissao, mas e requisicao sem credencial. Ja aconteceu duas vezes
  // (noc-maquinas.html); esta trava e pra nao acontecer uma terceira.
  // As publicas de verdade ficam de fora: usam token proprio na URL.
  const PAGINAS_PUBLICAS = [
    'atendimento.html', 'decidir.html', 'estorno-cliente.html', 'rh-cadastro.html',
    'rh-colaborador.html', 'solicitacao-publica.html', 'ticket-publico.html', 'assinar.html',
    // preencher.html: o solicitante preenche por um link, sem login - o
    // token de preenchimento na URL É a credencial (mesmo caso do assinar)
    'preencher.html',
  ];
  const dirPublico = require('path').join(__dirname, 'public');
  const semToken = require('fs').readdirSync(dirPublico)
    .filter((f) => f.endsWith('.html') && !PAGINAS_PUBLICAS.includes(f))
    .filter((f) => {
      const html = require('fs').readFileSync(require('path').join(dirPublico, f), 'utf8');
      return /fetch\(['"`]\/api\//.test(html) && !html.includes('authToken');
    });
  if (semToken.length) ruins += 1;
  console.log(`${semToken.length ? '✗' : '✓'} páginas autenticadas mandam o token do login: ${semToken.length ? semToken.join(', ') : 'todas ok'}`);

  // Tela que monta seletor/contagem de unidade a partir da lista FIXA
  // pre-populada no proprio HTML precisa do PAR de chamadas: filtrar o que
  // vem do cadastro em runtime (unidades-extras?area=) E apagar quem ja
  // estava na lista fixa e depois ganhou perfil restrito
  // (unidades-restritas?area=) - um Object.assign nunca REMOVE chave.
  // Faltando qualquer uma das duas, unidade administrativa (MVPar,
  // Administrativa...) entra na conta como se fosse loja: era isso que
  // fazia o KPI de Fechamentos dizer "12 de 25" em vez de "12 de 13".
  const PAGINAS_UNIDADE_FECHAMENTO = ['fechamentos.html', 'lancamento.html'];
  const semFiltroArea = PAGINAS_UNIDADE_FECHAMENTO.filter((f) => {
    const html = require('fs').readFileSync(require('path').join(dirPublico, f), 'utf8');
    return !html.includes('unidades-extras?area=fechamento') || !html.includes('unidades-restritas?area=fechamento');
  });
  if (semFiltroArea.length) ruins += 1;
  console.log(`${semFiltroArea.length ? '✗' : '✓'} telas de fechamento filtram unidade por área (administrativa não conta como loja): ${semFiltroArea.length ? semFiltroArea.join(', ') : 'todas ok'}`);

  // ------------------------------------------------------------------
  // NOC: a lista do poll de 30s tem que ir RESUMIDA (sem eventos, aparelhos
  // da rede, chat, series de rede, saida de comando) - mandar isso de todas
  // as maquinas a cada poll era a maior fatia da banda que estourou os 5 GB
  // do Render. O detalhe pesado continua existindo, mas so na rota /detalhe
  // de UMA maquina, e o painel so a chama com o modal aberto.
  let okNocResumo = false;
  try {
    const cab = token ? { Authorization: 'Bearer ' + token } : {};
    const lista = await pedir('/api/loja-status', cab);
    const itens = JSON.parse(lista.corpo);
    const alvo = itens.find((c) => c.codigo === 'AERO' && c.posto === 'ATM01');
    const detalhe = await pedir('/api/loja-status/AERO/computadores/ATM01/detalhe', cab);
    const det = detalhe.status === 200 ? JSON.parse(detalhe.corpo) : {};
    const html = require('fs').readFileSync(require('path').join(__dirname, 'public', 'loja-status.html'), 'utf8');
    const conferencias = {
      'a lista responde e acha a máquina semeada': lista.status === 200 && !!alvo,
      // o doc semeado tem redeDia e eventos, e a telemetria de cima gravou
      // dispositivos - NENHUM deles pode viajar na lista
      'a lista NÃO carrega os campos pesados': !!alvo && !itens.some((c) => 'eventos' in c || 'redeDia' in c
        || 'dispositivos' in c || 'chatMensagens' in c || 'ipHistorico' in c || 'ultimoComandoResultado' in c),
      'a lista mantém o que os cards usam': !!alvo && 'ultimoHeartbeatEm' in alvo && 'online' in alvo && 'tipo' in alvo,
      'o detalhe devolve os campos pesados': detalhe.status === 200 && 'redeDia' in det && 'eventos' in det && 'dispositivos' in det,
      'o painel busca o detalhe só do modal aberto': /buscarDetalheComp/.test(html) && /atualizarDetalheExtraDosModais/.test(html),
      'o modal renderiza mesclando lista + detalhe': /compComDetalhe\(c\)/.test(html),
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([n]) => n);
    okNocResumo = !falhas.length;
    if (falhas.length) console.log('  falhou em: ' + falhas.join(' · '));
  } catch (e) { okNocResumo = false; console.log('  erro: ' + e.message); }
  if (!okNocResumo) ruins += 1;
  console.log(`${okNocResumo ? '✓' : '✗'} NOC: lista do poll vai resumida e o detalhe pesado sai só por máquina`);

  // ------------------------------------------------------------------
  // fechamentosLive: (1) o TTL do cache e LONGO (toda escrita passa pelo
  // modulo e invalida na hora - reler a maior colecao do banco a cada 5min
  // era a maior fatia das leituras diarias do Firestore); (2) durante uma
  // importacao em lote (bravoImport) as invalidacoes ficam SUSPENSAS e uma
  // so e aplicada no final - sem isso, cada dia gravado fazia a proxima
  // leitura pagar a colecao inteira de novo.
  let okCacheFech = false;
  try {
    const fs = require('fs');
    const srcFech = fs.readFileSync(require('path').join(__dirname, 'fechamentosLive.js'), 'utf8');
    const srcBravo = fs.readFileSync(require('path').join(__dirname, 'bravoImport.js'), 'utf8');
    const fech = require('/home/user/adyen-monitor/server/fechamentosLive.js');

    // comportamento, medido em documentos lidos de verdade:
    fech.invalidarCache();
    let antes = LEITURAS.docs;
    await fech.listAll();
    const custoFrio = LEITURAS.docs - antes; // paga a coleção

    fech.suspenderInvalidacao();
    fech.invalidarCache(); // dentro do lote: tem que ser SEGURADA
    antes = LEITURAS.docs;
    await fech.listAll();
    const custoSuspenso = LEITURAS.docs - antes; // cache segue de pé -> 0

    fech.retomarInvalidacao(); // aplica a invalidação que ficou pendente
    antes = LEITURAS.docs;
    await fech.listAll();
    const custoAposRetomar = LEITURAS.docs - antes; // agora sim relê

    const conferencias = {
      'leitura fria paga a coleção': custoFrio >= 1,
      'invalidação suspensa não derruba o cache': custoSuspenso === 0,
      'retomar aplica a invalidação pendente': custoAposRetomar >= 1,
      'o TTL virou horas, não minutos': /createCache\(listAllUncached, 6 \* 60 \* 60 \* 1000\)/.test(srcFech),
      'o import do Bravo grava dentro da suspensão': /suspenderInvalidacao\(\);\s*try \{/.test(srcBravo),
      'e retoma num finally (mesmo com erro no meio)': /\} finally \{\s*fechamentosLive\.retomarInvalidacao\(\);/.test(srcBravo),
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([n]) => n);
    okCacheFech = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')} (frio=${custoFrio}, suspenso=${custoSuspenso}, retomar=${custoAposRetomar})`);
  } catch (e) { okCacheFech = false; console.log('  erro: ' + e.message); }
  if (!okCacheFech) ruins += 1;
  console.log(`${okCacheFech ? '✓' : '✗'} fechamentosLive: cache longo + invalidação em lote na importação (menos leituras no Firestore)`);

  // ------------------------------------------------------------------
  // "não chega alerta no celular" tem que ser diagnosticável pelo próprio
  // usuário: a rota de teste dispara um push real pra todos os aparelhos
  // dele e devolve a contagem; o sino (painel/monitor) chama esse teste
  // logo depois de ativar, então a pessoa vê na hora se chegou. Aqui, sem
  // VAPID configurada, a rota tem que responder configurado:false (e não
  // 500/pendurar) - é o mesmo caminho de código da produção até o envio.
  let okTestePush = false;
  try {
    const r = await postarJson('/api/push/testar', {}, token ? { Authorization: 'Bearer ' + token } : {});
    const d = r.status === 200 ? JSON.parse(r.corpo) : {};
    const fs = require('fs');
    const painel = fs.readFileSync(require('path').join(__dirname, 'public', 'painel.html'), 'utf8');
    const monitor = fs.readFileSync(require('path').join(__dirname, 'public', 'monitor.html'), 'utf8');
    const conferencias = {
      'a rota responde e diz se o push está configurado': r.status === 200 && 'configurado' in d && 'dispositivos' in d,
      'o sino do Painel dispara o teste ao ativar': /api\/push\/testar/.test(painel),
      'o sino do Monitor dispara o teste ao ativar': /api\/push\/testar/.test(monitor),
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([n]) => n);
    okTestePush = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')} (HTTP ${r.status} ${r.corpo.slice(0, 90)})`);
  } catch (e) { okTestePush = false; console.log('  erro: ' + e.message); }
  if (!okTestePush) ruins += 1;
  console.log(`${okTestePush ? '✓' : '✗'} push: teste de notificação de ponta a ponta (rota + sino do Painel/Monitor)`);

  // ------------------------------------------------------------------
  // Carrinho: divergência (saída negativa ao fechar turno) tem que virar
  // alerta - e o Dia a dia tem que sair em PDF. Fecha um turno de verdade
  // com saída negativa (contagem final maior que inicial, sem envio no
  // meio), confere que o cálculo acusa, que o aviso registra na Central de
  // Alertas mesmo sem VAPID, que o gancho está no caminho da CONTAGEM, e
  // que a rota de PDF devolve um PDF de verdade.
  let okCarrinho = false;
  try {
    const abastecimentoCarrinho = require('/home/user/adyen-monitor/server/abastecimentoCarrinho.js');
    const abastecimentoPrevisao = require('/home/user/adyen-monitor/server/abastecimentoPrevisao.js');
    const pushMod = require('/home/user/adyen-monitor/server/push.js');
    // a contagem semeada (ct1) tem calabresa 4; esta fecha o turno com 9 -
    // saiu 4 + 0 - 9 = -5 (sobrou mais do que entrou)
    await abastecimentoCarrinho.criar({
      operador: { usuario: 'anat1234', nome: 'Ana Teste' }, tipo: 'CONTAGEM',
      pizzas: { calabresa: 9, pepperoni: 0, mussarela: 0 }, insumos: [],
      criadoPorId: 'u1', criadoPorEmail: 't@t', criadoPorNome: 'Teste',
    });
    const ciclos = abastecimentoPrevisao.montarCiclos(await abastecimentoCarrinho.listAll());
    const ultimo = ciclos[ciclos.length - 1] || { itens: [] };
    const calabresa = ultimo.itens.find((i) => i.chave === 'pizza:calabresa') || {};

    await pushMod.notifyAbastecimentoDivergencia(ultimo.rotulo || 'teste', 'Calabresa (-5)');
    const alertaGravado = [...DOCS.entries()].some(([k, v]) => k.startsWith('alertasCentral/') && v && v.tipo === 'abastecimento-divergencia');

    const src = require('fs').readFileSync(require('path').join(__dirname, 'index.js'), 'utf8');
    const html = require('fs').readFileSync(require('path').join(__dirname, 'public', 'abastecimento-relatorios.html'), 'utf8');
    const pdf = await pedir(`/api/abastecimento/fluxo/relatorio.pdf?token=${encodeURIComponent(token)}`);

    const conferencias = {
      'o turno fechado acusa a saída negativa': calabresa.saida === -5,
      'o aviso registra na Central de Alertas (mesmo sem VAPID)': alertaGravado,
      'o gancho roda ao lançar CONTAGEM': /tipo === 'CONTAGEM'[\s\S]{0,200}verificarDivergenciaAbastecimento/.test(src),
      'a rota de PDF devolve um PDF': pdf.status === 200 && pdf.corpo.startsWith('%PDF'),
      'a tela tem o botão de PDF do Dia a dia': /baixarPdfDias/.test(html) && /fluxo\/relatorio\.pdf/.test(html),
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([n]) => n);
    okCarrinho = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')} (saida=${calabresa.saida}, pdf HTTP ${pdf.status})`);
  } catch (e) { okCarrinho = false; console.log('  erro: ' + e.message); }
  if (!okCarrinho) ruins += 1;
  console.log(`${okCarrinho ? '✓' : '✗'} Carrinho: divergência vira alerta e o Dia a dia sai em PDF`);

  // ------------------------------------------------------------------
  // Carrinho: "saiu -14 un" confundia quem lia (não dá pra "sair" uma
  // quantidade negativa) e o PDF completo despejava TODOS os ~27 itens de
  // cada dia pra achar 26 divergências perdidas no meio - pedido do Master
  // depois de ver o PDF: "precisamos ter um relatório apenas das
  // divergências". Confere a wording nova (fonte + tela) e que o PDF com
  // ?divergencias=1 sai menor que o completo (menos linhas = menos itens
  // saudáveis, só o que precisa de atenção).
  let okDivergenciasFiltro = false;
  try {
    const src = require('fs').readFileSync(require('path').join(__dirname, 'index.js'), 'utf8');
    const html = require('fs').readFileSync(require('path').join(__dirname, 'public', 'abastecimento-relatorios.html'), 'utf8');
    const pdfCompleto = await pedir(`/api/abastecimento/fluxo/relatorio.pdf?token=${encodeURIComponent(token)}`);
    const pdfFiltrado = await pedir(`/api/abastecimento/fluxo/relatorio.pdf?divergencias=1&token=${encodeURIComponent(token)}`);

    const conferencias = {
      'a wording nova ("a mais") existe no servidor - sem número negativo cru': /function fmtSaidaTxt/.test(src) && /a mais/.test(src),
      'o filtro ?divergencias=1 existe na rota do PDF': /req\.query\.divergencias === '1'/.test(src),
      'o PDF só-divergências sai válido e MENOR que o completo (menos linhas)':
        pdfFiltrado.status === 200 && pdfFiltrado.corpo.startsWith('%PDF') && pdfFiltrado.corpo.length < pdfCompleto.corpo.length,
      'a tela tem o toggle "só divergências"': /alternarSoDivergencias/.test(html) && /SO_DIVERGENCIAS/.test(html),
      'a tela usa a mesma frase clara ("a mais"), não o número negativo cru': /function fraseSaida/.test(html) && /a mais/.test(html),
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([n]) => n);
    okDivergenciasFiltro = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')} (completo ${pdfCompleto.corpo.length}b, filtrado ${pdfFiltrado.status===200 ? pdfFiltrado.corpo.length+'b' : pdfFiltrado.status})`);
  } catch (e) { okDivergenciasFiltro = false; console.log('  erro: ' + e.message); }
  if (!okDivergenciasFiltro) ruins += 1;
  console.log(`${okDivergenciasFiltro ? '✓' : '✗'} Carrinho: relatório só de divergências + "sobrou X a mais" em vez do número negativo cru`);

  // ------------------------------------------------------------------
  // Carrinho: explicação de UMA divergência específica (pedido do usuário -
  // "quero um local que apareça um relatório explicando e que eu possa
  // exportar em PDF para apresentar"). O turno que fechou negativo no teste
  // anterior tem que ter uma rota própria (identificada pelo "ate" do ciclo)
  // que devolve a explicação, gera um PDF de UMA página, e o link que a
  // notificação manda tem que apontar pra esse turno específico - não pra
  // tela genérica.
  let okExplicacaoTurno = false;
  try {
    const abastecimentoCarrinho = require('/home/user/adyen-monitor/server/abastecimentoCarrinho.js');
    const abastecimentoPrevisao = require('/home/user/adyen-monitor/server/abastecimentoPrevisao.js');
    const cab = token ? { Authorization: 'Bearer ' + token } : {};
    const ciclos = abastecimentoPrevisao.montarCiclos(await abastecimentoCarrinho.listAll());
    const ultimo = ciclos[ciclos.length - 1];

    const explicacao = await pedir(`/api/abastecimento/turno/${encodeURIComponent(ultimo.ate)}`, cab);
    const dExplicacao = explicacao.status === 200 ? JSON.parse(explicacao.corpo) : {};
    const pdfTurno = await pedir(`/api/abastecimento/turno/${encodeURIComponent(ultimo.ate)}/relatorio.pdf?token=${encodeURIComponent(token)}`);
    const turnoInexistente = await pedir(`/api/abastecimento/turno/${encodeURIComponent('2000-01-01T00:00:00.000Z')}`, cab);

    const srcPush = require('fs').readFileSync(require('path').join(__dirname, 'push.js'), 'utf8');
    const srcSw = require('fs').readFileSync(require('path').join(__dirname, 'public', 'sw.js'), 'utf8');
    const html = require('fs').readFileSync(require('path').join(__dirname, 'public', 'abastecimento-relatorios.html'), 'utf8');

    const conferencias = {
      'a explicação do turno traz o item negativo': explicacao.status === 200
        && (dExplicacao.negativos || []).some((i) => i.chave === 'pizza:calabresa' && i.saida === -5),
      'turno que não existe dá 404': turnoInexistente.status === 404,
      'o PDF de UM turno sai válido': pdfTurno.status === 200 && pdfTurno.corpo.startsWith('%PDF'),
      'o push da divergência manda o link já apontando pro turno': /url: turnoAte \? `\/abastecimento-relatorios\.html\?turno=/.test(srcPush),
      'o service worker navega respeitando a query string (não só o path)': /u\.pathname \+ u\.search === url/.test(srcSw),
      'a tela lê ?turno= no boot e mostra o card de explicação': /carregarExplicacaoTurno/.test(html) && /painel-explicacao-turno/.test(html),
      'a tela tem o botão de PDF desta divergência': /baixarPdfTurno/.test(html) && /turno\/\$\{encodeURIComponent\(TURNO_ATE\)\}\/relatorio\.pdf/.test(html),
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([n]) => n);
    okExplicacaoTurno = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')} (explicacao ${explicacao.status} ${explicacao.corpo.slice(0, 100)}, pdf ${pdfTurno.status})`);
  } catch (e) { okExplicacaoTurno = false; console.log('  erro: ' + e.message); }
  if (!okExplicacaoTurno) ruins += 1;
  console.log(`${okExplicacaoTurno ? '✓' : '✗'} Carrinho: explicação de UMA divergência + PDF de apresentação`);

  // ------------------------------------------------------------------
  // Carrinho: período customizado + relatório ESCRITO de desvios - pedido do
  // usuário: "preciso escolher periodo e tambem ter um relatorio escrito
  // explicando os possíveis ajustes e desvios erros operacionais informando
  // usuário do envio". O turno fechado negativo nos testes anteriores (abre
  // com 'Ana' via ct1, fecha com 'Ana Teste' via a CONTAGEM criada acima,
  // sem ENVIO no meio) tem que sair atribuído a essas pessoas, e o PDF
  // narrativo tem que existir tanto pra um período com divergência quanto
  // pra um período limpo (sem cair pra 404/500).
  let okRelatorioEscrito = false;
  try {
    const abastecimentoCarrinho = require('/home/user/adyen-monitor/server/abastecimentoCarrinho.js');
    const abastecimentoPrevisao = require('/home/user/adyen-monitor/server/abastecimentoPrevisao.js');
    const cab = token ? { Authorization: 'Bearer ' + token } : {};
    const ciclos = abastecimentoPrevisao.montarCiclos(await abastecimentoCarrinho.listAll());
    const ultimo = ciclos[ciclos.length - 1] || {};

    const hoje = new Date().toISOString().slice(0, 10);
    const pdfComDivergencia = await pedir(`/api/abastecimento/divergencias/relatorio-escrito.pdf?inicio=${hoje}&fim=${hoje}&token=${encodeURIComponent(token)}`, cab);
    const pdfPeriodoLimpo = await pedir(`/api/abastecimento/divergencias/relatorio-escrito.pdf?inicio=2000-01-01&fim=2000-01-02&token=${encodeURIComponent(token)}`, cab);

    const srcPrevisao = require('fs').readFileSync(require('path').join(__dirname, 'abastecimentoPrevisao.js'), 'utf8');
    const srcIndex = require('fs').readFileSync(require('path').join(__dirname, 'index.js'), 'utf8');
    const html = require('fs').readFileSync(require('path').join(__dirname, 'public', 'abastecimento-relatorios.html'), 'utf8');

    const conferencias = {
      'o ciclo sabe quem abriu o turno (contagem inicial)': ultimo.abreOperador === 'Ana',
      'o ciclo sabe quem fechou o turno (contagem final)': ultimo.fechaOperador === 'Ana Teste',
      'o ciclo lista os operadores de envio (vazio aqui, sem ENVIO no meio)': Array.isArray(ultimo.enviosOperadores) && ultimo.enviosOperadores.length === 0,
      'o PDF narrativo sai válido num período com divergência': pdfComDivergencia.status === 200 && pdfComDivergencia.corpo.startsWith('%PDF'),
      'o PDF narrativo sai válido num período limpo (sem divergência)': pdfPeriodoLimpo.status === 200 && pdfPeriodoLimpo.corpo.startsWith('%PDF'),
      'a rota nova está gated por Master': /divergencias\/relatorio-escrito\.pdf', auth\.requireMaster/.test(srcIndex),
      'a tela tem o seletor de período customizado': /periodo-inicio/.test(html) && /periodo-fim/.test(html) && /function aplicarPeriodoCustom/.test(html),
      'a tela monta o relatório escrito na hora, do que já foi carregado': /function renderRelatorioEscrito/.test(html) && /abreOperador/.test(html) && /enviosOperadores/.test(html),
      'a tela tem o botão de baixar o relatório escrito em PDF': /function baixarRelatorioEscrito/.test(html) && /divergencias\/relatorio-escrito\.pdf/.test(html),
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([n]) => n);
    okRelatorioEscrito = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')} (abre=${ultimo.abreOperador}, fecha=${ultimo.fechaOperador}, envios=${JSON.stringify(ultimo.enviosOperadores)}, pdf1 ${pdfComDivergencia.status}, pdf2 ${pdfPeriodoLimpo.status})`);
  } catch (e) { okRelatorioEscrito = false; console.log('  erro: ' + e.message); }
  if (!okRelatorioEscrito) ruins += 1;
  console.log(`${okRelatorioEscrito ? '✓' : '✗'} Carrinho: período customizado + relatório escrito de desvios (com quem abriu/fechou/enviou)`);

  // ------------------------------------------------------------------
  // Chamados de TI: triagem em duas etapas (N1 -> N2 -> presencial) -
  // pedido do usuário: "quebra de caixa, desbloqueio, entre tantos outros
  // são apenas chamados Remoto N1 só evolui para N2 só depois de evoluir
  // que pode ir para uma fila de presencial". Cria um chamado remoto de
  // verdade, confere que nasce N1, que escalar pra presencial é RECUSADO
  // em N1, que só o próprio técnico (ou gestor) evolui pro N2, e que só
  // depois disso o escalonamento funciona.
  let okNivelChamados = false;
  try {
    const chamadosTI = require('/home/user/adyen-monitor/server/chamadosTI.js');
    const cab = token ? { Authorization: 'Bearer ' + token } : {};

    const criado = await chamadosTI.create({
      unidade: 'AERO', unidadeNome: 'Aeroporto', titulo: 'Desbloqueio de login',
      tecnicoId: 'tec1', tecnicoEmail: 'tec1@t.com', criadoPorEmail: 'x@x',
    });

    // tentar escalar direto de N1 tem que ser recusado, mesmo com Master
    const escalarCedo = await postarJson(`/api/chamados/${criado.id}/escalar-presencial`, { motivo: 'teste' }, cab);

    // tecnico que NAO e o dono do chamado nao evolui o nivel de outro -
    // direto no modulo, pra testar a regra sem o atalho de Master
    let recusouOutroTecnico = false;
    try { await chamadosTI.evoluirNivel(criado.id, { tecnicoId: 'outro-tec', ehGestor: false }); } catch (e) { recusouOutroTecnico = /não é seu/.test(e.message); }

    // o dono evolui o proprio chamado
    const evoluido = await chamadosTI.evoluirNivel(criado.id, { tecnicoId: 'tec1', ehGestor: false });

    // agora sim, escalar pra presencial funciona (via rota HTTP)
    const escalarAgora = await postarJson(`/api/chamados/${criado.id}/escalar-presencial`, { motivo: 'precisa de visita' }, cab);
    const dEscalarAgora = escalarAgora.status === 200 ? JSON.parse(escalarAgora.corpo) : {};

    // segundo chamado so pra testar a rota HTTP /evoluir-nivel ponta a
    // ponta (Master sempre passa, via ehGestor)
    const outro = await chamadosTI.create({
      unidade: 'AERO', unidadeNome: 'Aeroporto', titulo: 'Quebra de caixa',
      tecnicoId: 'tec2', tecnicoEmail: 'tec2@t.com', criadoPorEmail: 'x@x',
    });
    const rotaEvoluir = await postarJson(`/api/chamados/${outro.id}/evoluir-nivel`, {}, cab);
    const dRotaEvoluir = rotaEvoluir.status === 200 ? JSON.parse(rotaEvoluir.corpo) : {};

    const html = require('fs').readFileSync(require('path').join(__dirname, 'public', 'tecnico.html'), 'utf8');

    const conferencias = {
      'chamado nasce em N1': criado.nivel === 'N1',
      'escalar direto de N1 é recusado': escalarCedo.status === 400 && /N1/.test(escalarCedo.corpo),
      'técnico que não é o dono não evolui o nível de outro': recusouOutroTecnico,
      'o dono evolui pro N2': evoluido.nivel === 'N2',
      'depois de N2, escalar pra presencial funciona': escalarAgora.status === 200 && dEscalarAgora.modalidade === 'presencial',
      'a rota HTTP /evoluir-nivel funciona (Master via ehGestor)': rotaEvoluir.status === 200 && dRotaEvoluir.nivel === 'N2',
      'a tela mostra o nível no chip e tem o botão de evoluir': /nivelDe\(c\)/.test(html) && /btn-evoluir-nivel/.test(html) && /function evoluirNivel/.test(html),
      'a tela só libera escalar em N2': /nivelDe\(c\)===.N2./.test(html),
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([n]) => n);
    okNivelChamados = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')} (escalarCedo ${escalarCedo.status} ${escalarCedo.corpo.slice(0, 80)}, escalarAgora ${escalarAgora.status})`);
  } catch (e) { okNivelChamados = false; console.log('  erro: ' + e.message); }
  if (!okNivelChamados) ruins += 1;
  console.log(`${okNivelChamados ? '✓' : '✗'} Chamados de TI: triagem em duas etapas (N1 -> N2 -> presencial)`);

  // ------------------------------------------------------------------
  // Monitor: a coluna UNID. sumiu ("—" em toda linha) depois da unificação
  // de códigos de 18/08 - as lojas GBE passaram a usar o NOME do Fechamento
  // ("Dominos Caruaru"), sem dígito, e o rótulo da célula jogava fora tudo
  // que não fosse número. Roda a função REAL extraída do HTML contra os
  // dois espaços de código (numérico ARCFOOD e nome GBE).
  let okUnidMonitor = false;
  try {
    const html = require('fs').readFileSync(require('path').join(__dirname, 'public', 'monitor.html'), 'utf8');
    const fonte = (html.match(/function soNumero\(unidade\)\{[\s\S]*?\n\}/) || [''])[0];
    // eslint-disable-next-line no-eval
    const soNumero = eval('(' + fonte.replace('function soNumero', 'function') + ')');
    const conferencias = {
      'código numérico continua saindo só o número': soNumero('19888') === '19888',
      'código antigo da Adyen continua saindo o número': soNumero('DOM_19798') === '19798',
      'código unificado SEM dígito mostra o nome (não "—")': soNumero('Dominos Caruaru') === 'Caruaru',
      'nome sem prefixo Dominos sai inteiro': soNumero('Milky Moo Tirol') === 'Milky Moo Tirol',
      'vazio segue como travessão': soNumero('') === '—' && soNumero(null) === '—',
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([n]) => n);
    okUnidMonitor = !falhas.length;
    if (falhas.length) console.log('  falhou em: ' + falhas.join(' · '));
  } catch (e) { okUnidMonitor = false; console.log('  erro: ' + e.message); }
  if (!okUnidMonitor) ruins += 1;
  console.log(`${okUnidMonitor ? '✓' : '✗'} Monitor: coluna UNID. mostra a loja mesmo com código unificado sem dígito`);

  // ------------------------------------------------------------------
  // Central do Beniboy: assumir um atendimento apresenta o atendente pro
  // visitante ("[saudação], Sr./Sra. [solicitante]! O/A [atendente] irá
  // seguir com o seu atendimento.") e RESPONDER numa conversa aberta também
  // assume (o responsável vira quem escreveu). A saudação segue o horário
  // de Brasília e o Sr./Sra. + O/A saem da heurística de gênero pelo nome.
  let okAssumir = false;
  try {
    const sc = require('/home/user/adyen-monitor/server/suporteChat.js');
    const chatNovo = await sc.criar({ nome: 'Letícia', contato: 'leticia@x.com', texto: 'não consigo acessar' });

    // assumir com atendente mulher
    const aposMarcela = await sc.atualizarStatusAtendimento(chatNovo.id, {
      statusAtendimento: 'EM_ATENDIMENTO', autor: { id: 'u9', email: 'marcela@x', nome: 'Marcela' },
    });
    const m1 = aposMarcela.mensagens[aposMarcela.mensagens.length - 1];
    const qtdAposMarcela = aposMarcela.mensagens.length;

    // a MESMA pessoa mexendo de novo no card não repete a apresentação
    const repetido = await sc.atualizarStatusAtendimento(chatNovo.id, {
      statusAtendimento: 'EM_ATENDIMENTO', autor: { id: 'u9', email: 'marcela@x', nome: 'Marcela' },
    });

    // outro atendente (homem) assume por cima: nova apresentação com "O"
    const aposCarlos = await sc.atualizarStatusAtendimento(chatNovo.id, {
      statusAtendimento: 'EM_ATENDIMENTO', autor: { id: 'u10', email: 'carlos@x', nome: 'Carlos' },
    });
    const m2 = aposCarlos.mensagens[aposCarlos.mensagens.length - 1];

    // responder pela rota também assume (Master escreve -> vira responsável,
    // com a apresentação ANTES da resposta digitada)
    const cab = token ? { Authorization: 'Bearer ' + token } : {};
    const resp = await postarMultipart(`/api/suporte-chats/${chatNovo.id}/responder`, { texto: 'já estou verificando' }, null, 'anexo', cab);
    const final = await sc.getOne(chatNovo.id);
    const msgs = final.mensagens;

    const html = require('fs').readFileSync(require('path').join(__dirname, 'public', 'beniboy.html'), 'utf8');
    const conferencias = {
      'apresentação com saudação + Sra. + A [atendente]':
        /^(Bom dia|Boa tarde|Boa noite|Boa madrugada), Sra\. Letícia! A Marcela irá seguir com o seu atendimento\.$/.test(m1.texto)
        && m1.de === 'suporte' && m1.automatica === true,
      'assumir grava o responsável': aposMarcela.responsavel && aposMarcela.responsavel.email === 'marcela@x',
      'mesma pessoa de novo não repete a apresentação': repetido.mensagens.length === qtdAposMarcela,
      'atendente homem sai com "O"': / O Carlos irá seguir com o seu atendimento\.$/.test(m2.texto),
      'responder pela rota assume o atendimento': resp.status === 200 && final.responsavel && final.responsavel.email === process.env.MASTER_EMAIL,
      'a apresentação vem antes da resposta digitada':
        msgs[msgs.length - 1].texto === 'já estou verificando' && msgs[msgs.length - 2].automatica === true,
      'heurística de gênero cobre as exceções': sc.ehNomeFeminino('Isabel') && !sc.ehNomeFeminino('Luca') && !sc.ehNomeFeminino('Rafael') && sc.ehNomeFeminino('Ana'),
      'a tela tem o botão de assumir (mesmo com outro responsável)': /assumirAtendimento\(/.test(html) && /respEmail !== meuEmail/.test(html),
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([n]) => n);
    okAssumir = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')} (m1="${m1 && m1.texto}", m2="${m2 && m2.texto}", resp HTTP ${resp.status})`);
  } catch (e) { okAssumir = false; console.log('  erro: ' + e.message); }
  if (!okAssumir) ruins += 1;
  console.log(`${okAssumir ? '✓' : '✗'} Beniboy: assumir/responder apresenta o atendente com saudação automática`);

  // ------------------------------------------------------------------
  // Link público de Compra (ticket-publico.html): quem recebe o link pra
  // COMPRAR precisa de uma vista limpa (título, itens em lista, observação,
  // aprovado/recusado) e das ações de quem compra: data da entrega, marcar
  // como comprada e anexar o comprovante - tudo autorizado só pelo link.
  let okCompraLink = false;
  try {
    DOCS.set('solicitacoes/cmp1', {
      id: 'cmp1', tipo: 'compra', status: 'APROVADO', numeroTicket: 10391,
      unidade: 'Milky Moo Tirol', unidadeNome: 'MilkyMoo Tirol',
      titulo: 'Comprar de insumos orçamento', observacao: 'Comprar até amanhã.',
      itens: [{ descricao: 'Biscoito maria 15 unidades', quantidade: 96 }, { descricao: 'suspiro 4 unidades', quantidade: 28 }],
      criadoEm: new Date().toISOString(), linkAcao: 'linkteste123', linkAcaoRevogado: false,
      comprada: false, anexos: [],
    });
    const antes = await pedir('/api/central/compra/cmp1/publico?link=linkteste123');
    const dAntes = antes.status === 200 ? JSON.parse(antes.corpo) : {};
    const errado = await pedir('/api/central/compra/cmp1/publico?link=outrolink');

    const marcar = await postarJson('/api/central/compra/cmp1/comprada-publico',
      { link: 'linkteste123', dataEntregaPrevista: '2026-08-22', autorNome: 'Valdenice' });
    const depois = await pedir('/api/central/compra/cmp1/publico?link=linkteste123');
    const dDepois = depois.status === 200 ? JSON.parse(depois.corpo) : {};

    const html = require('fs').readFileSync(require('path').join(__dirname, 'public', 'ticket-publico.html'), 'utf8');
    const conferencias = {
      'o link abre com itens e a ação de marcar comprada': antes.status === 200
        && dAntes.podeMarcarComprada === true && Array.isArray(dAntes.itens) && dAntes.itens.length === 2,
      'link errado é recusado': errado.status === 404,
      'marcar como comprada pelo link funciona': marcar.status === 200 && /"comprada":true/.test(marcar.corpo),
      'depois de comprada o estado reflete (data + sem ação de novo)':
        dDepois.comprada === true && dDepois.dataEntregaPrevista === '2026-08-22' && dDepois.podeMarcarComprada === false,
      'a tela tem o painel de compra (nome + data + comprovante)': /painel-comprada/.test(html) && /enviarComprada/.test(html) && /comprada-comprovante/.test(html),
      'itens saem em LISTA na vista de compra': /itens-lista/.test(html),
      'a vista de compra esconde o decidido-por/execução': /d\.tipo !== 'compra' && \(d\.status === 'APROVADO'/.test(html),
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([n]) => n);
    okCompraLink = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')} (antes ${antes.status}, marcar ${marcar.status} ${marcar.corpo.slice(0, 80)})`);
  } catch (e) { okCompraLink = false; console.log('  erro: ' + e.message); }
  if (!okCompraLink) ruins += 1;
  console.log(`${okCompraLink ? '✓' : '✗'} Compra pelo link: vista limpa + data de entrega + marcar comprada + comprovante`);

  // ------------------------------------------------------------------
  // Formulários com assinatura remota (Depósito/Diárias/Avulso/Reembolso):
  // criar gera um LINK por papel (nas diárias, um por linha da tabela);
  // cada pessoa assina pelo link no celular (token = credencial) e a
  // assinatura entra na posição certa do PDF. Fecha o ciclo inteiro aqui:
  // cria um Avulso (2 papéis), assina os dois pelo link público, o status
  // vira ASSINADO e o PDF sai válido; diárias geram 1 slot extra por linha.
  let okFormularios = false;
  try {
    const cab = token ? { Authorization: 'Bearer ' + token } : {};
    // PNG 1x1 válido - o mesmo formato que o canvas do assinar.html manda
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    const criado = await postarJson('/api/formularios', {
      tipo: 'avulso', unidade: "Domino's Bessa - João Pessoa",
      // o cnpj mandado aqui é ERRADO de propósito: o servidor tem que
      // ignorar e usar o do cadastro fixo (UNIDADES_FORM)
      campos: { cnpj: '99.999.999/9999-99', favorecido: 'Padaria Central', chavePix: 'pix@padaria.com' },
      linhas: [{ data: '20/08/2026', descricao: 'Pães para evento', valor: '150,50' }, { data: '20/08/2026', descricao: 'Bolo', valor: '87,22' }],
    }, cab);
    const f = criado.status === 200 ? JSON.parse(criado.corpo) : {};
    const linkDe = (papel) => (f.assinaturas || []).find((a) => a.chave === papel);
    const tokenDoLink = (papel) => new URLSearchParams(String(linkDe(papel).link).split('?')[1]).get('t');

    const vista = await pedir(`/api/formularios-publico/${f.id}?token=${tokenDoLink('favorecido')}`);
    const dVista = vista.status === 200 ? JSON.parse(vista.corpo) : {};
    const tokenErrado = await pedir(`/api/formularios-publico/${f.id}?token=naoexiste`);

    const ass1 = await postarJson(`/api/formularios-publico/${f.id}/assinar`, { token: tokenDoLink('favorecido'), nome: 'João Padeiro', imagem: PNG });
    const ass2 = await postarJson(`/api/formularios-publico/${f.id}/assinar`, { token: tokenDoLink('gerente'), nome: 'Marcela', imagem: PNG });
    const dAss2 = ass2.status === 200 ? JSON.parse(ass2.corpo) : {};
    const repetida = await postarJson(`/api/formularios-publico/${f.id}/assinar`, { token: tokenDoLink('gerente'), nome: 'Marcela', imagem: PNG });

    const depois = await pedir(`/api/formularios/${f.id}`, cab);
    const dDepois = depois.status === 200 ? JSON.parse(depois.corpo) : {};
    const pdf = await pedir(`/api/formularios/${f.id}/pdf?token=${encodeURIComponent(token)}`);

    // diárias: cada linha da tabela vira um slot próprio de assinatura
    const diarias = await postarJson('/api/formularios', {
      tipo: 'diarias', unidade: "Domino's Bessa - João Pessoa", campos: {},
      linhas: [{ nome: 'Carlos', datas: '18 e 19/08', chavePix: 'c@x', banco: 'BB', valor: '120' }, { nome: 'Ana', datas: '19/08', chavePix: 'a@x', banco: 'Nubank', valor: '60' }],
    }, cab);
    const dDiarias = diarias.status === 200 ? JSON.parse(diarias.corpo) : {};

    const fs = require('fs');
    const htmlAssinar = fs.readFileSync(require('path').join(__dirname, 'public', 'assinar.html'), 'utf8');
    const htmlForms = fs.readFileSync(require('path').join(__dirname, 'public', 'formularios.html'), 'utf8');
    const srcFormularios = fs.readFileSync(require('path').join(__dirname, 'formularios.js'), 'utf8');
    const conferencias = {
      'criar devolve um link de assinatura por papel': criado.status === 200
        && !!(linkDe('favorecido') && linkDe('favorecido').link) && !!(linkDe('gerente') && linkDe('gerente').link),
      'o total soma a coluna de valor (pt-BR)': f.valorTotal === 237.72,
      'CNPJ e razão social vêm do cadastro fixo (ignora o que o navegador mandou)':
        f.campos && f.campos.cnpj === '59.449.391/0001-79' && f.razaoSocial === 'America Bessa',
      'unidade fora do cadastro é recusada': (await postarJson('/api/formularios', { tipo: 'avulso', unidade: 'Loja Inventada', campos: {}, linhas: [{ data: 'x', descricao: 'y', valor: '1' }] }, cab)).status === 400,
      'o link público mostra o formulário e o papel de quem abriu': vista.status === 200 && dVista.meuPapel === 'favorecido' && dVista.jaAssinei === false,
      'token errado é recusado': tokenErrado.status === 404,
      'as duas assinaturas completam o formulário': ass1.status === 200 && ass2.status === 200 && dAss2.completo === true,
      'assinar duas vezes é recusado': repetida.status === 400,
      'o detalhe reflete ASSINADO com nomes': dDepois.status === 'ASSINADO' && dDepois.assinaturas.every((a) => a.assinado && a.nome),
      'o PDF sai válido': pdf.status === 200 && pdf.corpo.startsWith('%PDF'),
      'diárias criam um slot de assinatura POR LINHA + gerente':
        diarias.status === 200 && ['linha-0', 'linha-1', 'gerente'].every((c) => (dDiarias.assinaturas || []).some((a) => a.chave === c)),
      'a página de assinar tem o quadro de desenho': /canvas id="pad"/.test(htmlAssinar) && /toDataURL\('image\/png'\)/.test(htmlAssinar),
      'a tela de formulários gera links por papel': /Copiar link/.test(htmlForms) && /assinar\.html/.test(require('fs').readFileSync(require('path').join(__dirname, 'index.js'), 'utf8')),
      // pedido do Master ao ver o PDF pela primeira vez: "transformar no
      // mesmo formato do formulario dos exemplos que enviei" - o PDF tinha
      // virado texto puro preto/branco; confere que a paleta e a
      // identidade do papel original (Grupo Bravo Empresarial) voltaram
      'o PDF usa a paleta do papel original (azul escuro dos rótulos/título + azul claro da tabela/total)':
        /AZUL_ESCURO = '#1F4E79'/.test(srcFormularios) && /AZUL_CLARO = '#DCE6F1'/.test(srcFormularios),
      'o PDF traz o bloco de identidade fixo do Grupo Bravo Empresarial (mesmo texto em toda unidade)':
        /'BRAVO'/.test(srcFormularios) && /'EMPRESARIAL'/.test(srcFormularios),
      'Banco/Agência/Conta viram UMA linha "DADOS BANCÁRIOS" no cabeçalho (igual ao papel), não 3 linhas soltas':
        /label: 'DADOS BANCÁRIOS'/.test(srcFormularios) && /combo:/.test(srcFormularios),
      // Esta conferência era o OPOSTO: exigia "NOME DO COLABORADOR", por
      // fidelidade ao papel original. O Master mandou trocar depois - é
      // "Favorecido" em todo formulário, inclusive na assinatura. A regra
      // nova está no bloco de rótulos, mais abaixo; aqui fica só a trava de
      // que o termo velho não volta por descuido.
      'o Reembolso não usa mais "COLABORADOR" (virou Favorecido, por decisão do Master)':
        !/'NOME DO COLABORADOR'/.test(srcFormularios),
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([n]) => n);
    okFormularios = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')} (criar ${criado.status} ${criado.corpo.slice(0, 100)})`);
  } catch (e) { okFormularios = false; console.log('  erro: ' + e.message); }
  if (!okFormularios) ruins += 1;
  console.log(`${okFormularios ? '✓' : '✗'} Formulários: links de assinatura por papel, assinatura pelo celular e PDF montado`);

  // ------------------------------------------------------------------
  // Formulários - memória de favorecido + anexos: preencher um Reembolso
  // com CPF grava o favorecido (nome + dados bancários); digitar o mesmo
  // CPF de novo devolve tudo pra tela preencher sozinha. A criação também
  // aceita multipart com comprovantes (PDF/imagem, até 5) e as rotas de
  // anexo (logada e pública por token) respondem sem vazar por índice/token.
  let okFavorecido = false;
  try {
    const cab = token ? { Authorization: 'Bearer ' + token } : {};
    const reemb = await postarJson('/api/formularios', {
      tipo: 'reembolso', unidade: 'Spoleto Shopping Recife',
      campos: { favorecido: 'Sidney Ferreira de Lima', cpf: '092.055.424-58', banco: 'Santander', agencia: '0001', conta: '12345-6', chavePix: 'sidney@pix.com' },
      linhas: [{ data: '19/08/2026', fornecedor: 'Posto BR', descricao: 'Combustível', valor: '80,00' }],
    }, cab);
    const fR = reemb.status === 200 ? JSON.parse(reemb.corpo) : {};

    // busca pelo CPF só com dígitos E formatado (a rota limpa a máscara)
    const lembrado = await pedir('/api/formularios/favorecido?doc=09205542458', cab);
    const dLembrado = lembrado.status === 200 ? JSON.parse(lembrado.corpo) : {};
    const formatado = await pedir('/api/formularios/favorecido?doc=' + encodeURIComponent('092.055.424-58'), cab);
    const desconhecido = await pedir('/api/formularios/favorecido?doc=11111111111', cab);

    // multipart SEM arquivo tem que criar igual (é como a tela manda agora)
    const viaMultipart = await postarMultipart('/api/formularios', {
      payload: JSON.stringify({ tipo: 'avulso', unidade: 'Spoleto Tacaruna', campos: { favorecido: 'X' }, linhas: [{ data: 'x', descricao: 'y', valor: '10' }] }),
    }, null, 'anexos', cab);
    // arquivo que não é PDF nem imagem é barrado ANTES de tocar no storage
    const tipoRuim = await postarMultipart('/api/formularios', {
      payload: JSON.stringify({ tipo: 'avulso', unidade: 'Spoleto Tacaruna', campos: {}, linhas: [{ data: 'x', descricao: 'y', valor: '1' }] }),
    }, { nome: 'nota.txt', tipo: 'text/plain', buffer: Buffer.from('oi') }, 'anexos', cab);

    // rotas de anexo: índice inexistente e token errado caem em 404
    const tokenAss = new URLSearchParams(String((fR.assinaturas.find((a) => a.chave === 'favorecido') || {}).link).split('?')[1]).get('t');
    const anexoForaDoIndice = await pedir(`/api/formularios/${fR.id}/anexo/0?token=${encodeURIComponent(token)}`);
    const anexoPublicoForaDoIndice = await pedir(`/api/formularios-publico/${fR.id}/anexo/0?token=${tokenAss}`);
    const anexoTokenErrado = await pedir(`/api/formularios-publico/${fR.id}/anexo/0?token=naoexiste`);

    const fs2 = require('fs');
    const path2 = require('path');
    const htmlForms2 = fs2.readFileSync(path2.join(__dirname, 'public', 'formularios.html'), 'utf8');
    const htmlAssinar2 = fs2.readFileSync(path2.join(__dirname, 'public', 'assinar.html'), 'utf8');
    const conferencias = {
      'criar o reembolso grava o favorecido pelo CPF': reemb.status === 200 && lembrado.status === 200
        && dLembrado.nome === 'Sidney Ferreira de Lima' && dLembrado.banco === 'Santander' && dLembrado.chavePix === 'sidney@pix.com',
      'a busca aceita o CPF com máscara': formatado.status === 200,
      'CPF nunca usado devolve 404': desconhecido.status === 404,
      'criar por multipart (sem arquivo) funciona': viaMultipart.status === 200,
      'arquivo que não é PDF/imagem é recusado': tipoRuim.status === 400 && /PDF nem imagem/.test(tipoRuim.corpo),
      'anexo com índice inexistente dá 404 (logado e público)': anexoForaDoIndice.status === 404 && anexoPublicoForaDoIndice.status === 404,
      'anexo público com token errado dá 404': anexoTokenErrado.status === 404,
      'a tela de formulários tem o campo de comprovantes e manda FormData':
        /id="f-anexos"/.test(htmlForms2) && /new FormData\(\)/.test(htmlForms2) && /buscarFavorecido/.test(htmlForms2),
      'a página de assinar mostra os comprovantes': /anexo\//.test(htmlAssinar2) && /Comprovantes/.test(htmlAssinar2),
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([n]) => n);
    okFavorecido = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')} (reemb ${reemb.status} · lembrado ${lembrado.status} ${lembrado.corpo.slice(0, 80)} · multipart ${viaMultipart.status} ${viaMultipart.corpo.slice(0, 80)})`);
  } catch (e) { okFavorecido = false; console.log('  erro: ' + e.message); }
  if (!okFavorecido) ruins += 1;
  console.log(`${okFavorecido ? '✓' : '✗'} Formulários: favorecido lembrado pelo CPF + anexos de comprovante`);

  // ------------------------------------------------------------------
  // NOC - alarme falso de celular: quem abre o Zenith no CELULAR com o
  // monitoramento fixo gravado (zenithMonitorFixo) virava "computador da
  // loja"; cada bloqueio de tela disparava push de "Loja sem conexão".
  // Agora: (1) a tela de login não manda heartbeat de celular e apaga a
  // configuração gravada; (2) se a última batida de um posto 'interno' veio
  // de navegador de celular, a queda não vira push (só histórico no NOC).
  let okCelularNoc = false;
  try {
    const lojaStatusMod = require('./lojaStatus');
    const fs3 = require('fs');
    const path3 = require('path');
    const htmlLogin = fs3.readFileSync(path3.join(__dirname, 'public', 'index.html'), 'utf8');
    const srcIndex = fs3.readFileSync(path3.join(__dirname, 'index.js'), 'utf8');
    const srcLoja = fs3.readFileSync(path3.join(__dirname, 'lojaStatus.js'), 'utf8');
    const conferencias = {
      'navegador de celular Android é reconhecido': lojaStatusMod.ehCelular('Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36') === true,
      'iPhone é reconhecido': lojaStatusMod.ehCelular('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15') === true,
      'desktop NÃO é celular (queda real continua alertando)': lojaStatusMod.ehCelular('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36') === false,
      'o vigia NÃO é celular (queda com vigia continua alertando)': lojaStatusMod.ehCelular('NOCZenith/1.0 (Windows NT; PowerShell)') === false,
      'a varredura marca a transição vinda de celular': /celular: quedaDeCelular\(doc\)/.test(srcLoja) && /tipo === 'interno' && ehCelular\(doc\.userAgent\)/.test(srcLoja),
      'o push de loja offline/online pula transição de celular': /if \(t\.celular\) continue;/.test(srcIndex),
      'a tela de login não monitora em celular e apaga a configuração gravada':
        /Mobile/.test(htmlLogin) && /removeItem\('zenithMonitorFixo'\)/.test(htmlLogin),
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([n]) => n);
    okCelularNoc = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')}`);
  } catch (e) { okCelularNoc = false; console.log('  erro: ' + e.message); }
  if (!okCelularNoc) ruins += 1;
  console.log(`${okCelularNoc ? '✓' : '✗'} NOC: celular fechando o navegador não dispara alarme de loja caída`);

  // ------------------------------------------------------------------
  // Empresas (ver server/empresas.js): a camada de isolamento acima do
  // Grupo, pedido do usuário - "quero expandir trazer mais empresas...
  // porém preciso que elas não vejam uma as coisas do outro, exceto
  // suporte, que precisa ter acesso a tudo". Confere: (a) o seed de boot
  // cria MVPar (padrão) e Arcfood (lista fechada dos 4 códigos), (b)
  // empresaDaUnidade resolve os dois lados corretamente - explícito
  // (Arcfood) e "resto cai no padrão" (MVPar), (c) GET /api/meta/unidades
  // devolve o nome da empresa junto de cada unidade (usuarios.html usa
  // isso pro aviso de acesso cruzado), (d) ehTimeSuporte (consolidado em
  // auth.js) segue atravessando tudo pra quem tem a seção 'suporte',
  // mesmo sem ser Master, e (e) os 3 lugares que reimplementavam essa
  // checagem na mão (index.js local, usuarioLogadoDoHeader, loja-status.html)
  // agora usam todos a mesma fonte.
  let okEmpresas = false;
  try {
    const empresasMod = require('/home/user/adyen-monitor/server/empresas.js');
    const authMod = require('/home/user/adyen-monitor/server/auth.js');
    await empresasMod.ensureEmpresasSeed();
    const todas = await empresasMod.list();
    const gbe = todas.find((e) => e.nome === 'GBE');
    const arcfood = todas.find((e) => e.nome === 'Arcfood');

    const donaArcfood = await empresasMod.empresaDaUnidade('19821');
    const donaGbe = await empresasMod.empresaDaUnidade('Dominos Bessa');
    const donaInexistente = await empresasMod.empresaDaUnidade('CodigoQueNaoExiste123');

    const cab = token ? { Authorization: 'Bearer ' + token } : {};
    const listaUnidades = await pedir('/api/meta/unidades', cab);
    const dUnidades = listaUnidades.status === 200 ? JSON.parse(listaUnidades.corpo) : [];
    const itemArcfood = dUnidades.find((u) => u.codigo === '19821');
    const itemBessa = dUnidades.find((u) => u.codigo === 'Dominos Bessa');

    const suporteAtravessa = authMod.ehTimeSuporte({ isMaster: false, isAdmin: false, permissions: { sections: ['suporte'] } });
    const semSuporteNaoAtravessa = authMod.ehTimeSuporte({ isMaster: false, isAdmin: false, permissions: { sections: [] } });

    const fs4 = require('fs');
    const srcIndex4 = fs4.readFileSync(require('path').join(__dirname, 'index.js'), 'utf8');
    const srcLojaStatus = fs4.readFileSync(require('path').join(__dirname, 'public', 'loja-status.html'), 'utf8');

    const conferencias = {
      'o seed cria GBE com as unidades escolhidas uma a uma (sem catch-all)': !!gbe
        && !gbe.padrao
        && ['Dominos Bessa', 'Spoleto Shopping Recife', 'Saltiverso Patteo'].every((c) => gbe.unidades.includes(c)),
      'GBE também lista os códigos da Adyen/Entregas das mesmas lojas (senão o Monitor sai vazio)':
        !!gbe && ['DOM_19706', 'Caruaru', 'DOM19940'].every((c) => gbe.unidades.includes(c))
        && !gbe.unidades.some((c) => ['MMTirol Natal', 'Tirol Natal'].includes(c)),
      'o seed cria Arcfood com os códigos dela (Fechamento + Adyen)': !!arcfood && !arcfood.padrao
        && ['19821', '19855', '19888', '19889', 'Mooca', 'DOM__19821'].every((c) => arcfood.unidades.includes(c)),
      'nenhuma empresa é "padrão"/catch-all': todas.every((e) => !e.padrao),
      'empresaDaUnidade acha a Arcfood pelo código explícito': donaArcfood && donaArcfood.nome === 'Arcfood',
      'empresaDaUnidade acha o GBE pelo código explícito': donaGbe && donaGbe.nome === 'GBE',
      'código que ninguém listou NÃO cai em empresa nenhuma (não entra no GBE por acidente)': donaInexistente === null,
      'GET /api/meta/unidades expõe a empresa de cada unidade': itemArcfood && itemArcfood.empresa === 'Arcfood'
        && itemBessa && itemBessa.empresa === 'GBE',
      'ehTimeSuporte deixa passar quem tem a seção suporte (sem ser Master)': suporteAtravessa === true,
      'ehTimeSuporte recusa quem não é Master/Admin/suporte': semSuporteNaoAtravessa === false,
      'index.js não reimplementa mais a função local (usa auth.ehTimeSuporte)': /const ehTimeSuporte = auth\.ehTimeSuporte;/.test(srcIndex4)
        && !/function ehTimeSuporte\(req\) \{/.test(srcIndex4),
      'loja-status.html usa o campo do servidor em vez de re-derivar': /if\(!me\.ehTimeSuporte\)/.test(srcLojaStatus)
        && !/secoes\.includes\('suporte'\)/.test(srcLojaStatus),

      // ---- o pedido central do Master: o Admin manda DENTRO da empresa dele
      // e não enxerga a outra. Master e suporte seguem atravessando tudo.
      'Master não tem teto de empresa': authMod.escopoDeUnidades({ isMaster: true }) === null,
      'suporte não tem teto de empresa (atende loja de qualquer empresa)':
        authMod.escopoDeUnidades({ permissions: { sections: ['suporte'] }, unidadesDaEmpresa: ['19821'] }) === null,
      'Admin de uma empresa fica preso às unidades dela':
        JSON.stringify(authMod.escopoDeUnidades({ isAdmin: true, permissions: { sections: [] }, unidadesDaEmpresa: ['19821'] })) === '["19821"]',
      'acesso sem empresa vinculada continua como sempre foi (deploy não quebra ninguém)':
        authMod.escopoDeUnidades({ isAdmin: true, permissions: { sections: [] }, unidadesDaEmpresa: null }) === null,
      'Admin do GBE não vê dado da Arcfood, e vice-versa': (() => {
        const dados = [{ unidade: '19821' }, { unidade: 'Dominos Bessa' }];
        const comoArcfood = authMod.filtrarPorEmpresa({ isAdmin: true, permissions: { sections: [] }, unidadesDaEmpresa: arcfood.unidades }, dados);
        const comoGbe = authMod.filtrarPorEmpresa({ isAdmin: true, permissions: { sections: [] }, unidadesDaEmpresa: gbe.unidades }, dados);
        return comoArcfood.length === 1 && comoArcfood[0].unidade === '19821'
          && comoGbe.length === 1 && comoGbe[0].unidade === 'Dominos Bessa';
      })(),
      'registro sem unidade não vaza pelo filtro':
        authMod.filtrarPorEmpresa({ isAdmin: true, permissions: { sections: [] }, unidadesDaEmpresa: ['19821'] }, [{ semUnidade: 1 }]).length === 0,
      'as rotas que davam a lista inteira pro Admin agora passam pelo filtro de empresa':
        (srcIndex4.match(/auth\.filtrarPorEmpresa\(req,/g) || []).length >= 8,
      'as 4 rotas de check-in do RH respeitam a empresa em vez de mandar null':
        (srcIndex4.match(/req\.podeRhTodasUnidades\) \? auth\.escopoDeUnidades\(req\)/g) || []).length === 4,
      'existe rota pro Master vincular um acesso a uma empresa': /\/api\/users\/:id\/empresa'/.test(srcIndex4)
        && /'usuarios\.empresa':/.test(srcIndex4),
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([n]) => n);
    okEmpresas = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')}`);
  } catch (e) { okEmpresas = false; console.log('  erro: ' + e.message); }
  if (!okEmpresas) ruins += 1;
  console.log(`${okEmpresas ? '✓' : '✗'} Empresas: isolamento entre negócios (GBE/Arcfood escolhidas a dedo, Admin preso à empresa dele, suporte atravessa tudo)`);

  // ------------------------------------------------------------------
  // Empresas: as 6 áreas que existiam no cadastro (unidades.js) mas não
  // bloqueavam nada (RH/NOC/Estoque/Entregas/Parque/Monitor) - decisão do
  // usuário ao ser perguntado: "ampliar as 6 áreas também". Reaproveita o
  // MVPAR_TESTE já criado num teste anterior (areas: ['rh','noc',
  // 'solicitacoes']) - tem que deixar passar RH/NOC e recusar
  // Estoque/Parque (não estão na lista); pra Entregas/Monitor (rotas mais
  // caras de montar - multipart/dados do Monitor) confere por leitura de
  // fonte, no ponto exato onde a checagem foi inserida.
  let okAreasAmpliadas = false;
  try {
    const cab = token ? { Authorization: 'Bearer ' + token } : {};
    const nocOk = await postarJson('/api/loja-status/MVPAR_TESTE/computadores', { nome: 'PC Teste', tipo: 'interno' }, cab);
    const nocRecusado = await postarJson('/api/loja-status/19821/computadores', { nome: 'PC Teste', tipo: 'interno' }, cab);
    const estoqueRecusado = await postarJson('/api/inventario/recebimentos', {
      unidade: 'MVPAR_TESTE', setor: 'Teste', tipo: 'Teste', itens: [],
    }, cab);
    const parqueRecusado = await postarJson('/api/parque/checkins', {
      unidade: 'MVPAR_TESTE', unidadeNome: 'MVPar Teste', responsavel: { nome: 'Teste', cpf: '00000000000' },
      dataUtilizacao: '2026-08-20', tempoMinutos: 60,
    }, cab);

    const fs5 = require('fs');
    const srcIndex5 = fs5.readFileSync(require('path').join(__dirname, 'index.js'), 'utf8');

    const conferencias = {
      'NOC: unidade COM a área (MVPAR_TESTE) deixa cadastrar computador': nocOk.status === 200,
      'NOC: unidade SEM a área (19821, só tem "rh") é recusada': nocRecusado.status === 400 && /NOC/.test(nocRecusado.corpo),
      'Estoque: unidade sem a área é recusada no recebimento': estoqueRecusado.status === 400 && /Estoque/.test(estoqueRecusado.corpo),
      'Parque: unidade sem a área é recusada no check-in': parqueRecusado.status === 400 && /Parque/.test(parqueRecusado.corpo),
      'RH: a checagem de área está nos 2 pontos de criação de funcionário':
        (srcIndex5.match(/apareceEm\(unidade, 'rh'\)/g) || []).length === 2,
      'Entregas: a checagem de área está no lançamento': /apareceEm\(unidade, 'entregas'\)/.test(srcIndex5),
      'Monitor: as 4 listas principais (transações/pedidos/pedidos mudados/chargebacks) filtram por área':
        (srcIndex5.match(/await filtrarPorAreaMonitor\(/g) || []).length === 4,
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([n]) => n);
    okAreasAmpliadas = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')} (noc-ok ${nocOk.status}, noc-recusa ${nocRecusado.status} ${nocRecusado.corpo.slice(0, 80)}, estoque ${estoqueRecusado.status} ${estoqueRecusado.corpo.slice(0, 80)}, parque ${parqueRecusado.status} ${parqueRecusado.corpo.slice(0, 80)})`);
  } catch (e) { okAreasAmpliadas = false; console.log('  erro: ' + e.message); }
  if (!okAreasAmpliadas) ruins += 1;
  console.log(`${okAreasAmpliadas ? '✓' : '✗'} Empresas: as 6 áreas sem checagem (RH/NOC/Estoque/Entregas/Parque/Monitor) agora bloqueiam de verdade`);

  // ------------------------------------------------------------------
  // Arquivar / excluir empresa: o Master pediu que as duas ações fossem só
  // dele e SEMPRE com senha. O que precisa ficar provado aqui é que a senha
  // é uma trava de verdade (não só um campo na tela) e que arquivar tem
  // efeito real - empresa arquivada deixa de ser dona das unidades dela.
  let okEmpresaArquivar = false;
  try {
    const cab = { Authorization: 'Bearer ' + token };
    const SENHA = process.env.MASTER_PASSWORD;
    const empresasMod = require('/home/user/adyen-monitor/server/empresas.js');

    const criada = await postarJson('/api/empresas', {
      nome: 'Empresa Descartavel', tipoNegocio: 'alimentacao', unidades: ['MVPAR_TESTE'],
    }, cab);
    const idNova = criada.status === 200 ? JSON.parse(criada.corpo).id : null;

    // antes de arquivar, ela é a dona da unidade
    const donaAntes = await empresasMod.empresaDaUnidade('MVPAR_TESTE');

    const semSenha = await postarJson(`/api/empresas/${idNova}/arquivar`, {}, cab);
    const senhaErrada = await postarJson(`/api/empresas/${idNova}/arquivar`, { password: 'nao-e-essa' }, cab);
    const arquivou = await postarJson(`/api/empresas/${idNova}/arquivar`, { password: SENHA }, cab);

    empresasMod.invalidarCache();
    const donaDepois = await empresasMod.empresaDaUnidade('MVPAR_TESTE');
    const unidadesDepois = await empresasMod.unidadesDaEmpresa(idNova);
    const listaComArquivada = JSON.parse((await pedir('/api/empresas', cab)).corpo);

    const desarquivou = await postarJson(`/api/empresas/${idNova}/desarquivar`, { password: SENHA }, cab);
    empresasMod.invalidarCache();
    const donaVoltou = await empresasMod.empresaDaUnidade('MVPAR_TESTE');

    // excluir: sem senha recusa; com senha apaga
    const excluirSemSenha = await enviarJson('DELETE', `/api/empresas/${idNova}`, {}, cab);
    const excluiu = await enviarJson('DELETE', `/api/empresas/${idNova}`, { password: SENHA }, cab);
    empresasMod.invalidarCache();
    const sumiu = !(await empresasMod.list()).some((e) => e.id === idNova);

    const impacto = await pedir(`/api/empresas/${idNova}/impacto`, cab);

    const conferencias = {
      'arquivar sem senha nenhuma é recusado': semSenha.status === 400 && /Senha incorreta/.test(semSenha.corpo),
      'arquivar com senha errada é recusado': senhaErrada.status === 400 && /Senha incorreta/.test(senhaErrada.corpo),
      'recusa vem como 400, não 401 (401 desloga a sessão à toa)': senhaErrada.status === 400,
      'arquivar com a senha certa funciona': arquivou.status === 200 && JSON.parse(arquivou.corpo).arquivada === true,
      'antes de arquivar a empresa era dona da unidade': donaAntes && donaAntes.nome === 'Empresa Descartavel',
      'empresa ARQUIVADA deixa de ser dona da unidade (a unidade fica sem dono)': donaDepois === null,
      'empresa arquivada não dá escopo nenhum a quem estava vinculado': Array.isArray(unidadesDepois) && unidadesDepois.length === 0,
      'a arquivada continua na lista de gestão (senão não dava pra desarquivar)':
        listaComArquivada.some((e) => e.id === idNova && e.arquivada === true),
      'desarquivar devolve a empresa como dona': desarquivou.status === 200 && donaVoltou && donaVoltou.nome === 'Empresa Descartavel',
      'excluir sem senha é recusado': excluirSemSenha.status === 400 && /Senha incorreta/.test(excluirSemSenha.corpo),
      'excluir com a senha certa apaga de verdade': excluiu.status === 200 && sumiu,
      'impacto de empresa inexistente responde 404 em vez de estourar': impacto.status === 404,
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([n]) => n);
    okEmpresaArquivar = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')}`);
  } catch (e) { okEmpresaArquivar = false; console.log('  erro: ' + e.message); }
  if (!okEmpresaArquivar) ruins += 1;
  console.log(`${okEmpresaArquivar ? '✓' : '✗'} Empresa: arquivar/excluir só com Master + senha, e arquivada deixa de ser dona das unidades`);

  // ------------------------------------------------------------------
  // Mensagem direta: o Master disse que aviso que some da tela não serve -
  // tem que ser caixa de diálogo que a pessoa ABRE, e ela responde por
  // dentro. Prova aqui: a mensagem FICA GRAVADA (não depende de a pessoa
  // estar olhando a tela na hora), conta como não lida até ser aberta, e a
  // resposta volta pro remetente na mesma conversa.
  let okMensagemDireta = false;
  try {
    const cabMaster = { Authorization: 'Bearer ' + token };
    const md = require('/home/user/adyen-monitor/server/mensagensDiretas.js');

    // acesso comum pra ser o destinatário - semeado direto e logado pelo
    // auth.login, mesmo padrão dos outros blocos deste arquivo
    const bcryptMsg = require('bcryptjs');
    const alvoId = 'u-destino-msg';
    DOCS.set('users/' + alvoId, {
      email: 'destino.msg@teste.local', username: 'destinomsg',
      passwordHash: bcryptMsg.hashSync('SenhaAlvo!2026', 4), role: 'user', active: true,
      permissions: { sections: [], unidades: [], vaultSubgroups: [], tiposSolicitacao: [] },
      createdAt: new Date().toISOString(),
    });
    const tokenAlvo = (await auth.login('destino.msg@teste.local', 'SenhaAlvo!2026')).token;
    const cabAlvo = { Authorization: 'Bearer ' + tokenAlvo };

    const enviou = await postarJson('/api/mensagens/enviar', { userId: alvoId, texto: 'Confere o caixa de ontem, por favor.' }, cabMaster);
    const conversaId = enviou.status === 200 ? JSON.parse(enviou.corpo).id : null;

    // o destinatário vê a conversa esperando, com a mensagem gravada
    const minhas = await pedir('/api/mensagens/minhas', cabAlvo);
    const dMinhas = minhas.status === 200 ? JSON.parse(minhas.corpo) : [];
    const conv = dMinhas.find((c) => c.id === conversaId) || {};

    // quem não é participante não enxerga nem lendo direto pelo id
    const deOutro = await pedir(`/api/mensagens/${conversaId}`, cabAlvo);
    const respostaIntrusa = await postarJson(`/api/mensagens/${md.idDoPar('xxx', 'yyy')}/responder`, { texto: 'oi' }, cabAlvo);

    // abriu = leu
    await postarJson(`/api/mensagens/${conversaId}/lida`, {}, cabAlvo);
    const depoisDeLer = JSON.parse((await pedir('/api/mensagens/minhas', cabAlvo)).corpo).find((c) => c.id === conversaId) || {};

    // responde, e o remetente recebe na MESMA conversa
    const respondeu = await postarJson(`/api/mensagens/${conversaId}/responder`, { texto: 'Conferido, estava certo.' }, cabAlvo);
    const doMaster = JSON.parse((await pedir('/api/mensagens/minhas', cabMaster)).corpo).find((c) => c.id === conversaId) || {};

    // mandar de novo pra mesma pessoa continua a mesma conversa
    await postarJson('/api/mensagens/enviar', { userId: alvoId, texto: 'Obrigado!' }, cabMaster);
    const doMaster2 = JSON.parse((await pedir('/api/mensagens/minhas', cabMaster)).corpo);
    const conversasComAlvo = doMaster2.filter((c) => c.com && c.com.id === alvoId);

    const conferencias = {
      'a mensagem fica GRAVADA (não depende de estar com a tela aberta)':
        !!conv.id && (conv.mensagens || []).some((m) => m.texto === 'Confere o caixa de ontem, por favor.'),
      'chega marcada como não lida (é o que faz a caixa de diálogo aparecer)': conv.naoLidas === 1,
      'o destinatário vê de quem é': conv.com && conv.com.id,
      'ler pelo id funciona pra quem é da conversa': deOutro.status === 200,
      'quem não é da conversa não consegue responder nela': respostaIntrusa.status === 400,
      'depois de aberta, zera as não lidas': depoisDeLer.naoLidas === 0,
      'a resposta volta pro remetente na mesma conversa': respondeu.status === 200
        && (doMaster.mensagens || []).some((m) => m.texto === 'Conferido, estava certo.'),
      'a resposta conta como não lida pro remetente': doMaster.naoLidas === 1,
      'mandar de novo continua a MESMA conversa (não abre outra)': conversasComAlvo.length === 1,
      'mensagem vazia é recusada': (await postarJson('/api/mensagens/enviar', { userId: alvoId, texto: '   ' }, cabMaster)).status === 400,
      'não dá pra mandar mensagem pra si mesmo': /pra você mesmo/.test(
        (await postarJson('/api/mensagens/enviar', { userId: JSON.parse((await pedir('/api/me', cabMaster)).corpo).id, texto: 'eu' }, cabMaster)).corpo),
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([n]) => n);
    okMensagemDireta = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')}`);
  } catch (e) { okMensagemDireta = false; console.log('  erro: ' + e.message); }
  if (!okMensagemDireta) ruins += 1;
  console.log(`${okMensagemDireta ? '✓' : '✗'} Mensagem direta: virou conversa gravada que a pessoa abre e responde (não some mais da tela)`);

  // ------------------------------------------------------------------
  // Ticket # no formulário: pedido do Master - todo formulário nasce com
  // número, porque depois de assinado ele vira uma solicitação de Pagamento
  // e tem que chegar lá com o MESMO número. Por isso sai da sequência
  // compartilhada do ticketCounter, não de um contador próprio.
  let okTicketFormulario = false;
  try {
    const cab = { Authorization: 'Bearer ' + token };
    const form = require('/home/user/adyen-monitor/server/formularios.js');
    const solicitacoes = require('/home/user/adyen-monitor/server/solicitacoes.js');

    const f1 = await form.criar({
      tipo: 'avulso', unidade: 'São Braz Ilha do Leite',
      campos: {}, linhas: [{ descricao: 'Serviço X', valor: '150,00' }],
      criadoPorEmail: 'teste@teste.local',
    });
    // um ticket da Central logo depois: tem que ser o PRÓXIMO número, provando
    // que os dois bebem da mesma sequência (e não que cada um conta sozinho)
    const s1 = await solicitacoes.create({
      tipo: 'pagamento', unidade: 'São Braz Ilha do Leite', titulo: 'Pagamento X',
      criadoPorEmail: 'teste@teste.local',
    });
    const f2 = await form.criar({
      tipo: 'avulso', unidade: 'São Braz Ilha do Leite',
      campos: {}, linhas: [{ descricao: 'Serviço Y', valor: '90,00' }],
      criadoPorEmail: 'teste@teste.local',
    });

    // o número tem que sobreviver até a tela (listar) e até o PDF
    const listaForm = await pedir('/api/formularios', cab);
    const naLista = (listaForm.status === 200 ? JSON.parse(listaForm.corpo) : []).find((x) => x.id === f1.id) || {};
    const pdf = await pedirBinario(`/api/formularios/${f1.id}/pdf`, cab);
    const textoPdf = pdf.status === 200 ? textoDoPdf(pdf.buffer) : '';

    // e um formulário que já vem com número (o caso de "virou outra coisa")
    // reaproveita em vez de tirar outro da fila
    const f3 = await form.criar({
      tipo: 'avulso', unidade: 'São Braz Ilha do Leite',
      campos: {}, linhas: [{ descricao: 'Herdado', valor: '10,00' }],
      criadoPorEmail: 'teste@teste.local', numeroTicket: f1.numeroTicket,
    });

    const conferencias = {
      'o formulário nasce com número de ticket': Number.isFinite(f1.numeroTicket),
      'segue o padrão da casa (#10000 em diante)': f1.numeroTicket >= 10000,
      'é a MESMA sequência da Central (o ticket seguinte é o próximo número)':
        s1.numeroTicket === f1.numeroTicket + 1 && f2.numeroTicket === s1.numeroTicket + 1,
      'dois formulários nunca repetem número': f1.numeroTicket !== f2.numeroTicket,
      'o número chega na tela (listagem)': naLista.numeroTicket === f1.numeroTicket,
      'o PDF sai com o número impresso': pdf.status === 200 && textoPdf.includes(`Ticket #${f1.numeroTicket}`),
      'número recebido de fora é reaproveitado (vira outra coisa sem trocar de número)':
        f3.numeroTicket === f1.numeroTicket,
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([n]) => n);
    okTicketFormulario = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')} (f1 ${f1.numeroTicket}, s1 ${s1.numeroTicket}, f2 ${f2.numeroTicket}, pdf ${pdf.status})`);
  } catch (e) { okTicketFormulario = false; console.log('  erro: ' + e.message); }
  if (!okTicketFormulario) ruins += 1;
  console.log(`${okTicketFormulario ? '✓' : '✗'} Formulários: todo formulário nasce com Ticket # da MESMA sequência da Central (vira solicitação de Pagamento sem trocar de número)`);

  // ------------------------------------------------------------------
  // Link de preenchimento: pedido do Master - duas portas, ou a unidade
  // preenche tudo, ou manda o link pro próprio solicitante preencher os
  // dados dele (no Reembolso, quem sabe CPF/banco/agência/conta/PIX é ele).
  let okLinkPreencher = false;
  try {
    const cab = { Authorization: 'Bearer ' + token };
    const criado = await postarJson('/api/formularios/link-preenchimento', {
      tipo: 'reembolso', unidade: 'São Braz Ilha do Leite',
    }, cab);
    const d = criado.status === 200 ? JSON.parse(criado.corpo) : {};
    const tk = d.tokenPreenchimento;

    // clicar no botão de novo NÃO pode criar outro formulário nem queimar
    // outro número de ticket - tem que devolver o mesmo link
    const segundoClique = await postarJson('/api/formularios/link-preenchimento', {
      tipo: 'reembolso', unidade: 'São Braz Ilha do Leite',
    }, cab);
    const d2 = segundoClique.status === 200 ? JSON.parse(segundoClique.corpo) : {};

    // e cancelar o link tem que sumir com o formulário fantasma
    const paraCancelar = JSON.parse((await postarJson('/api/formularios/link-preenchimento', {
      tipo: 'avulso', unidade: 'São Braz Ilha do Leite',
    }, cab)).corpo);
    const cancelou = await enviarJson('DELETE', `/api/formularios/link-preenchimento/${paraCancelar.id}`, {}, cab);
    const listaPosCancel = JSON.parse((await pedir('/api/formularios', cab)).corpo);

    // o link é PÚBLICO (não exige login nem Basic Auth) e já traz a unidade
    const vista = await pedir(`/api/formularios-publico/preencher/${tk}`);
    const dv = vista.status === 200 ? JSON.parse(vista.corpo) : {};
    const tokenInvalido = await pedir('/api/formularios-publico/preencher/naoexiste123');

    const enviou = await postarJson(`/api/formularios-publico/preencher/${tk}`, {
      campos: { nome: 'Fulano de Tal', cpf: '12345678901', banco: 'Nubank', agencia: '0001', conta: '123456-7', pix: 'fulano@x.com' },
      linhas: [{ data: '20/08', fornecedor: 'Posto X', descricao: 'Combustível', valor: '120,50' }],
    });

    // depois de enviado: sai do "aguardando", ganha assinaturas e o MESMO ticket
    const depois = JSON.parse((await pedir('/api/formularios', cab)).corpo).find((x) => x.id === d.id) || {};
    const reenvio = await postarJson(`/api/formularios-publico/preencher/${tk}`, {
      campos: { nome: 'Outro' }, linhas: [{ descricao: 'x', valor: '1,00' }],
    });
    const vazio = await postarJson('/api/formularios-publico/preencher/' + tk, { campos: {}, linhas: [] });

    const conferencias = {
      'a unidade gera o link já com Ticket #': criado.status === 200 && Number.isFinite(d.numeroTicket) && !!tk,
      'clicar no botão de novo devolve O MESMO link (não cria formulário repetido)':
        segundoClique.status === 200 && d2.id === d.id && d2.tokenPreenchimento === tk,
      'e NÃO queima outro número de ticket': d2.numeroTicket === d.numeroTicket,
      'o reaproveitamento é avisado, pra tela não fingir que gerou outro': d2.reaproveitado === true,
      'dá pra cancelar um link ainda não preenchido': cancelou.status === 200,
      'o formulário fantasma some da lista depois de cancelado':
        !listaPosCancel.some((x) => x.id === paraCancelar.id),
      'nasce aguardando preenchimento, sem assinatura nenhuma':
        d.status === 'AGUARDANDO_PREENCHIMENTO' && (d.assinaturas || []).length === 0,
      'o link abre sem login e já vem com a unidade travada':
        vista.status === 200 && dv.unidade === 'São Braz Ilha do Leite' && dv.razaoSocial === 'Cafe SBI',
      'o link traz os campos do modelo pro solicitante preencher': (dv.cabecalho || []).length > 0 && (dv.colunas || []).length > 0,
      'token inválido não abre nada': tokenInvalido.status === 404,
      'o solicitante consegue enviar': enviou.status === 200,
      'depois de enviado sai de "aguardando" e entra no fluxo normal': depois.status === 'PENDENTE',
      'só AÍ nascem os slots de assinatura (antes não havia linha pra assinar)': (depois.assinaturas || []).length > 0,
      'o valor preenchido pelo solicitante é o que vale': depois.valorTotal === 120.5,
      'o Ticket # continua o MESMO do momento em que o link foi gerado': depois.numeroTicket === d.numeroTicket,
      'o mesmo link não serve pra preencher duas vezes': reenvio.status === 400 && /já foi preenchido/.test(reenvio.corpo),
      'envio sem nenhuma linha é recusado': vazio.status === 400,
      'depois de preenchido não dá mais pra "cancelar o link" (já é formulário de verdade)':
        (await enviarJson('DELETE', `/api/formularios/link-preenchimento/${d.id}`, {}, cab)).status === 400,
      'com o link já preenchido, o botão volta a gerar um link NOVO':
        JSON.parse((await postarJson('/api/formularios/link-preenchimento', { tipo: 'reembolso', unidade: 'São Braz Ilha do Leite' }, cab)).corpo).id !== d.id,
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([n]) => n);
    okLinkPreencher = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')} (criar ${criado.status}, vista ${vista.status}, enviar ${enviou.status} ${enviou.corpo.slice(0, 90)})`);
  } catch (e) { okLinkPreencher = false; console.log('  erro: ' + e.message); }
  if (!okLinkPreencher) ruins += 1;
  console.log(`${okLinkPreencher ? '✓' : '✗'} Formulários: link pro próprio solicitante preencher (a unidade escolhe: preenche ou envia o link)`);

  // ------------------------------------------------------------------
  // Nomenclatura dos formulários (pedido do Master): é "Favorecido", nunca
  // "Colaborador", e "Responsável" no lugar de "Gestor imediato" - inclusive
  // na assinatura. O ponto que exige cuidado: formulário JÁ GRAVADO
  // congelou o rótulo antigo, então o teste cria um registro com o rótulo
  // velho na mão e confere que ele passa a exibir o novo mesmo assim.
  let okRotulos = false;
  try {
    const cab = { Authorization: 'Bearer ' + token };
    const form = require('/home/user/adyen-monitor/server/formularios.js');
    const novo = await form.criar({
      tipo: 'reembolso', unidade: 'São Braz Ilha do Leite',
      campos: { favorecido: 'Fulano' }, linhas: [{ descricao: 'X', valor: '10,00' }],
      criadoPorEmail: 'teste@teste.local',
    });

    // simula um formulário criado ANTES da renomeação: rótulos velhos gravados
    const antigo = JSON.parse(JSON.stringify(DOCS.get('formularios/' + novo.id)));
    antigo.id = 'form-rotulo-antigo';
    antigo.assinaturas.favorecido.rotulo = 'Colaborador';
    antigo.assinaturas.responsavel.rotulo = 'Gestor imediato';
    DOCS.set('formularios/form-rotulo-antigo', antigo);

    // e um formulário de ANTES da renomeação das CHAVES (o Master liberou
    // mexer nelas: "os registros antigos foram testes"). Aqui o papel nem
    // existe mais no modelo - o esperado é NÃO quebrar: cai no rótulo que
    // está gravado, em vez de sumir com a assinatura.
    const legado = JSON.parse(JSON.stringify(antigo));
    legado.id = 'form-chave-antiga';
    legado.assinaturas = {
      colaborador: { ...antigo.assinaturas.favorecido, chave: 'colaborador', rotulo: 'Colaborador' },
      gestor: { ...antigo.assinaturas.responsavel, chave: 'gestor', rotulo: 'Gestor imediato' },
    };
    DOCS.set('formularios/form-chave-antiga', legado);
    form.invalidarCacheTeste && form.invalidarCacheTeste();

    const tokenColab = novo.assinaturas.find((a) => a.chave === 'favorecido').token;
    const vistaAss = await pedir(`/api/formularios-publico/${novo.id}?token=${tokenColab}`);
    const dv = vistaAss.status === 200 ? JSON.parse(vistaAss.corpo) : {};
    const detAntigo = await form.detalhar('form-rotulo-antigo');
    const detLegado = await form.detalhar('form-chave-antiga');
    const pdf = await pedirBinario(`/api/formularios/${novo.id}/pdf`, cab);
    const textoPdf = pdf.status === 200 ? textoDoPdf(pdf.buffer) : '';
    const fonte = require('fs').readFileSync(require('path').join(__dirname, 'formularios.js'), 'utf8');

    const rot = (d, chave) => (d.assinaturas.find((a) => a.chave === chave) || {}).rotulo;
    const conferencias = {
      'o campo do Reembolso diz FAVORECIDO, não COLABORADOR':
        /NOME DO FAVORECIDO/.test(fonte) && !/NOME DO COLABORADOR/.test(fonte),
      'a assinatura do favorecido chama "Favorecido"': rot(novo, 'favorecido') === 'Favorecido',
      'a outra assinatura chama "Responsável", não "Gestor imediato"': rot(novo, 'responsavel') === 'Responsável',
      'a tela pública de assinatura também mostra o nome novo':
        vistaAss.status === 200 && dv.meuRotulo === 'Favorecido'
        && (dv.assinaturas || []).some((a) => a.rotulo === 'Responsável'),
      'formulário ANTIGO (rótulo velho gravado) passa a exibir o novo':
        rot(detAntigo, 'favorecido') === 'Favorecido' && rot(detAntigo, 'responsavel') === 'Responsável',
      'o PDF sai com os nomes novos':
        textoPdf.includes('Favorecido') && textoPdf.includes('Responsável')
        && !textoPdf.includes('Gestor imediato'),
      // Avulso: quem recebe também é "Favorecido" agora (era "Fornecedor")
      'no Avulso, o campo e a assinatura de quem recebe também dizem Favorecido':
        /label: 'FAVORECIDO'/.test(fonte) && /label: 'CNPJ DO FAVORECIDO'/.test(fonte)
        && /papel: 'favorecido', rotulo: 'Favorecido'/.test(fonte),
      // mas a COLUNA do Reembolso segue "FORNECEDOR": ali é o estabelecimento
      // de cada despesa, não quem recebe - trocar apagaria essa distinção
      'a coluna de despesa do Reembolso continua FORNECEDOR (é o estabelecimento, não quem recebe)':
        /label: 'NOME DO FORNECEDOR'/.test(fonte),
      // as CHAVES acompanharam o rótulo: o que o código chama é o que a tela
      // mostra. Antes eram 'colaborador'/'gestor'/'fornecedor'.
      'as CHAVES internas também são favorecido/responsavel':
        !!novo.assinaturas.find((a) => a.chave === 'favorecido')
        && !!novo.assinaturas.find((a) => a.chave === 'responsavel')
        && !novo.assinaturas.find((a) => a.chave === 'colaborador' || a.chave === 'gestor')
        && /key: 'favorecido'/.test(fonte) && /key: 'cnpjFavorecido'/.test(fonte)
        && !/key: 'colaborador'/.test(fonte) && !/papel: 'gestor'/.test(fonte),
      // registro gravado com a chave velha não pode sumir da tela - fica com
      // o rótulo que ele mesmo gravou (aceito: eram registros de teste)
      'registro com a CHAVE velha continua aparecendo, com o rótulo que gravou':
        (detLegado.assinaturas || []).length === (detAntigo.assinaturas || []).length
        && rot(detLegado, 'colaborador') === 'Colaborador',
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([n]) => n);
    okRotulos = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')}`);
  } catch (e) { okRotulos = false; console.log('  erro: ' + e.message); }
  if (!okRotulos) ruins += 1;
  console.log(`${okRotulos ? '✓' : '✗'} Formulários: "Favorecido"/"Responsável" em tudo - tela, assinatura e PDF, inclusive nos já criados`);

  // ------------------------------------------------------------------
  // Master corrige ou cancela um formulário já lançado (pedido do Master:
  // "como master posso editar ou cancelar"). O que precisa ficar provado
  // aqui não é o CRUD - é o efeito colateral que importa: cancelar tem que
  // MATAR o link de assinatura que já foi pro WhatsApp de alguém, e editar
  // tem que DESCARTAR assinatura já coletada (assinatura vale pelo
  // documento que a pessoa viu).
  let okEditarCancelar = false;
  try {
    const cab = { Authorization: 'Bearer ' + token };
    const form = require('/home/user/adyen-monitor/server/formularios.js');
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const criado = await postarJson('/api/formularios', {
      tipo: 'avulso', unidade: 'Spoleto Tacaruna',
      campos: { favorecido: 'Padaria X', chavePix: 'p@x' },
      linhas: [{ data: '21/08', descricao: 'Pão', valor: '70,00' }],
    }, cab);
    const f = criado.status === 200 ? JSON.parse(criado.corpo) : {};
    // a rota nunca devolve o token cru - só o LINK com ele dentro (é o que
    // vai por WhatsApp). E cada edição gera token novo, então o token tem
    // que ser relido depois de cada uma.
    const tk = (lista, chave) => new URLSearchParams(String((lista.find((a) => a.chave === chave) || {}).link).split('?')[1]).get('t');

    // corrigir o valor: a assinatura do favorecido, já coletada, cai fora
    await postarJson(`/api/formularios-publico/${f.id}/assinar`, { token: tk(f.assinaturas, 'favorecido'), nome: 'João', imagem: PNG });
    const editado = await putJson(`/api/formularios/${f.id}`, {
      campos: { favorecido: 'Padaria X', chavePix: 'p@x' },
      linhas: [{ data: '21/08', descricao: 'Pão', valor: '90,00' }],
    }, cab);
    const dEdit = editado.status === 200 ? JSON.parse(editado.corpo) : {};
    const depoisDaEdicao = await form.detalhar(f.id);

    // salvar sem mudar nada não pode custar as assinaturas que sobraram
    await postarJson(`/api/formularios-publico/${f.id}/assinar`, { token: tk(dEdit.assinaturas, 'favorecido'), nome: 'João', imagem: PNG });
    const semMudanca = await putJson(`/api/formularios/${f.id}`, {
      campos: { favorecido: 'Padaria X', chavePix: 'p@x' },
      linhas: [{ data: '21/08', descricao: 'Pão', valor: '90,00' }],
    }, cab);
    const dSem = semMudanca.status === 200 ? JSON.parse(semMudanca.corpo) : {};

    // cancelar: o link do gerente (que nunca assinou) morre na hora
    const tokenGerente = tk(dEdit.assinaturas, 'gerente');
    const antesDoCancelamento = await pedir(`/api/formularios-publico/${f.id}?token=${tokenGerente}`);
    const cancelado = await postarJson(`/api/formularios/${f.id}/cancelar`, { motivo: 'lançado em duplicidade' }, cab);
    const depoisDoCancelamento = await pedir(`/api/formularios-publico/${f.id}?token=${tokenGerente}`);
    const assinarDepois = await postarJson(`/api/formularios-publico/${f.id}/assinar`, { token: tokenGerente, nome: 'Marcela', imagem: PNG });
    const dCancelado = await form.detalhar(f.id);
    const editarCancelado = await putJson(`/api/formularios/${f.id}`, { campos: {}, linhas: [{ data: 'x', descricao: 'y', valor: '1' }] }, cab);
    const pdfCancelado = await pedirBinario(`/api/formularios/${f.id}/pdf`, cab);

    const conferencias = {
      'editar recalcula o total': editado.status === 200 && depoisDaEdicao.valorTotal === 90,
      'editar descarta a assinatura que já estava lá': dEdit.assinaturasDescartadas === 1
        && depoisDaEdicao.assinaturas.every((a) => !a.assinado),
      'salvar sem mudar nada NÃO descarta assinatura': dSem.semMudanca === true
        && (await form.detalhar(f.id)).assinaturas.filter((a) => a.assinado).length === 1,
      'antes de cancelar, o link de assinatura funciona': antesDoCancelamento.status === 200,
      'cancelar mata o link que já estava na mão de alguém': cancelado.status === 200
        && depoisDoCancelamento.status === 404 && assinarDepois.status !== 200,
      'o registro fica gravado, com motivo e Ticket #': dCancelado.status === 'CANCELADO'
        && dCancelado.motivoCancelamento === 'lançado em duplicidade' && dCancelado.numeroTicket != null,
      'formulário cancelado não pode ser editado': editarCancelado.status === 400,
      'o PDF do cancelado sai carimbado': pdfCancelado.status === 200 && textoDoPdf(pdfCancelado.buffer).includes('CANCELADO'),
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([n]) => n);
    okEditarCancelar = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')}`);
  } catch (e) { okEditarCancelar = false; console.log('  erro: ' + e.message); }
  if (!okEditarCancelar) ruins += 1;
  console.log(`${okEditarCancelar ? '✓' : '✗'} Formulários: Master corrige (descartando assinatura) ou cancela (matando o link) sem apagar o registro`);

  console.log(ruins ? `\n${ruins} rota(s) com problema` : '\nTodas as rotas responderam sem estourar.');
  process.exit(ruins ? 1 : 0);
}, 2500);
