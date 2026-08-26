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
  // ref precisa ser um doc de verdade (update/set/delete), não só {path} -
  // vários módulos (auth.js/sessions.js/centralChat.js/parque.js/
  // vaultSubgroups.js) chamam doc.ref.update(...)/.delete(...) em cima de
  // resultado de query; sem isso o fake não pegava esse padrão nenhuma vez
  // (throw silencioso engolido por quem chamava), mesmo em código de
  // produção que depende dele - ver auth.js:154/162 (bloqueio de senha)
  return { exists: dados !== undefined, id: caminho.split('/').pop(), data: () => dados, ref: fakeDoc(caminho) };
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
  // batch GRAVA de verdade. Era no-op, e isso fazia o fake mentir do mesmo
  // jeito que o set()/update() mentiam antes (ver runTransaction abaixo):
  // qualquer semente ou escrita em lote passava batido, o teste via a
  // coleção vazia e o defeito só aparecia em produção. Acumula as operações
  // e aplica no commit, como o Firestore de verdade.
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
// A varredura tem 2min de carência depois do boot do processo (ver
// CARENCIA_POS_BOOT_MS em lojaStatus.js): logo após subir, ela não anuncia
// queda de máquina cuja última batida é anterior ao boot, pra não inventar
// alarme com timestamp velho vindo do banco. O teste inteiro roda dentro
// desses 2min, então sem zerar isso nenhuma queda simulada seria avaliada.
process.env.LOJA_STATUS_CARENCIA_BOOT_MS = '0';
// memo do mapa de unidades DESLIGADO na suíte: vários testes daqui mudam o
// dado por baixo (DOCS.set / store.addOrUpdate) e conferem o mapa em seguida
// - com memo ativo eles passariam olhando pro mapa velho, sem provar nada.
// A fiação do memo em produção é conferida por teste de fonte (ver adiante).
process.env.UNIDADES_MAPA_TTL_MS = '0';

// Storage de mentira EM MEMÓRIA. Antes ele só estourava, o que bastava
// enquanto nenhum teste precisava LER um anexo de volta - o Ass. Boleto
// precisa: o PDF dele é o arquivo anexado com a assinatura carimbada
// dentro, então sem storage não dá pra provar nada do que importa.
const ARQUIVOS = new Map();
const bucketFake = {
  file: (caminho) => ({
    save: async (buffer) => { ARQUIVOS.set(caminho, Buffer.from(buffer)); },
    download: async () => {
      if (!ARQUIVOS.has(caminho)) throw new Error('arquivo não existe: ' + caminho);
      return [ARQUIVOS.get(caminho)];
    },
    createReadStream: () => {
      const { Readable } = require('stream');
      return Readable.from([ARQUIVOS.get(caminho) || Buffer.alloc(0)]);
    },
    delete: async () => { ARQUIVOS.delete(caminho); },
  }),
};

// Leitor de documento de mentira, DESLIGADO por padrão (os testes que já
// existem provam justamente o caminho sem ANTHROPIC_API_KEY, e stubar de
// vez apagaria eles). Ligado, conta quantas vezes o modelo foi chamado - é
// o que prova que o cadastro pelo link público lê o documento UMA vez, e
// não duas: era a leitura repetida que dobrava o upload do celular e
// derrubava o envio antes da resposta (o "Failed to fetch").
const OCR_FALSO = { ligado: false, chamadas: 0, resposta: {} };
Module._load = function (req, parent, isMain) {
  if (req === './firestore') return fakeDb;
  if (req === './storageBucket') return { resolverBucket: async () => bucketFake, comBucket: async (fn) => fn(bucketFake) };
  if (req === './documentoIdentidadeOcr') {
    const real = origLoad.apply(this, arguments);
    return new Proxy(real, {
      get(alvo, prop) {
        if (!OCR_FALSO.ligado) return alvo[prop];
        if (prop === 'ativo') return () => true;
        if (prop === 'lerDocumento') return async () => { OCR_FALSO.chamadas += 1; return { ...OCR_FALSO.resposta }; };
        return alvo[prop];
      },
    });
  }
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
// mesma ideia do pedirBinario, so que POST com corpo JSON: o relatorio de
// KPI's manda a matriz JA CALCULADA na tela e recebe o PDF de volta (a
// conta e feita no navegador; recalcular no servidor criaria uma segunda
// fonte de verdade que pode discordar do que a pessoa esta vendo)
function postarBinario(caminho, corpoObj, headers = {}) {
  const corpo = Buffer.from(JSON.stringify(corpoObj));
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: 8899, path: caminho, method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': corpo.length },
    }, (res) => {
      const pedacos = [];
      res.on('data', (c) => pedacos.push(c));
      res.on('end', () => resolve({ status: res.statusCode, buffer: Buffer.concat(pedacos) }));
    });
    req.on('error', () => resolve({ status: 0, buffer: Buffer.alloc(0) }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ status: -1, buffer: Buffer.alloc(0) }); });
    req.end(corpo);
  });
}
function pedirBinario(caminho, headers = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: 8899, path: caminho, headers }, (res) => {
      const pedacos = [];
      res.on('data', (c) => pedacos.push(c));
      // headers junto: o "Ver x Baixar" do PDF é só o Content-Disposition
      // (inline x attachment), então sem ler o header não dá pra testar
      res.on('end', () => resolve({ status: res.statusCode, buffer: Buffer.concat(pedacos), headers: res.headers }));
    });
    req.on('error', () => resolve({ status: 0, buffer: Buffer.alloc(0), headers: {} }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ status: -1, buffer: Buffer.alloc(0), headers: {} }); });
    req.end();
  });
}
function textoDoPdf(b) {
  const zlib = require('zlib');
  let bruto = ''; let i = 0;
  while ((i = b.indexOf('stream', i)) >= 0) {
    let ini = i + 6; if (b[ini] === 13) ini += 1; if (b[ini] === 10) ini += 1;
    const fim = b.indexOf('endstream', ini); if (fim < 0) break;
    const cru = b.subarray(ini, fim);
    try { bruto += zlib.inflateSync(cru).toString('latin1'); } catch (e) {
      // stream sem compressão: é o caso do pdf-lib (Ass. Boleto). Só entra
      // se parecer conteúdo de página - stream de imagem viraria lixo.
      const txt = cru.toString('latin1');
      if (/\bBT\b|\bTj\b|\bTJ\b/.test(txt)) bruto += txt;
    }
    i = fim + 9;
  }
  // três formas de texto convivem aqui: o pdfkit escreve
  // [<hex> num <hex>] TJ (uma palavra fatiada pelo kerning - junta os
  // pedaços hex e ignora os números de espaçamento); o pdf-lib (Ass.
  // Boleto) escreve <hex> Tj; e (texto) Tj literal aparece em PDF de
  // outras origens.
  const deHex = (h) => Buffer.from(h, 'hex').toString('latin1');
  return bruto
    .replace(/\[([^\]]*)\]\s*TJ/g, (_, dentro) =>
      (dentro.match(/<([0-9A-Fa-f]*)>/g) || []).map((h) => deHex(h.slice(1, -1))).join('') + ' ')
    .replace(/<([0-9A-Fa-f]+)>\s*Tj/g, (_, hex) => deHex(hex) + ' ')
    .replace(/\(((?:\\.|[^\\)])*)\)\s*Tj/g, (_, dentro) =>
      dentro.replace(/\\([()\\])/g, '$1') + ' ');
}

function pedir(caminho, headers = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: 8899, path: caminho, headers }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, corpo: b }));
    });
    req.on('error', (e) => resolve({ status: 0, corpo: e.message }));
    // 4s marcava timeout até em rota que respondia certo (relatório de
    // fechamentos em PDF passou a levar mais que isso no ambiente de teste,
    // sem nenhum travamento real - só devagar). 10s ainda pega rota
    // genuinamente pendurada, sem falso positivo por lentidão do ambiente.
    req.setTimeout(10000, () => { req.destroy(); resolve({ status: -1, corpo: 'TIMEOUT (requisição pendurada)' }); });
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
// DELETE autenticado - o suite só tinha GET/POST/PUT até aqui
function pedirJsonDelete(caminho, headers = {}) {
  return enviarJson('DELETE', caminho, {}, headers);
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
    ['/api/inventario/saidas/relatorio.csv?unidade=19821', 'relatório de saídas - inventário (CSV)'],
    ['/api/inventario/saidas/relatorio.pdf?unidade=19821', 'relatório de saídas - inventário (PDF)'],
    ['/api/inventario/historico-contagens/relatorio.csv?unidade=19821&inicio=2020-01-01&fim=2030-01-01', 'relatório de histórico de contagens - inventário (CSV)'],
    ['/api/inventario/historico-contagens/relatorio.pdf?unidade=19821&inicio=2020-01-01&fim=2030-01-01', 'relatório de histórico de contagens - inventário (PDF)'],
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

  // pedido do Master: impressora/VM marcada como "monitorar" entra no alarme
  // de rede (ver varrerAlertas em lojaStatus.js) - a rota tem que aceitar e
  // devolver tipo+monitorar, não só o apelido
  const apelidoTipo = await putJson('/api/loja-status/AERO/dispositivos/a4:2b:b0:11:22:33/apelido',
    { apelido: 'Impressora Zebra Caixa', tipo: 'impressora', monitorar: true },
    token ? { Authorization: 'Bearer ' + token } : {});
  const okApelidoTipo = apelidoTipo.status === 200 && /"tipo":"impressora"/.test(apelidoTipo.corpo) && /"monitorar":true/.test(apelidoTipo.corpo);
  if (!okApelidoTipo) ruins += 1;
  console.log(`${okApelidoTipo ? '✓' : '✗'} apelido de aparelho aceita tipo+monitorar (alarme de rede): HTTP ${apelidoTipo.status} ${apelidoTipo.corpo.slice(0, 90)}`);

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

  // ---- LEITURA DA FOTO DO RELATÓRIO: valor tem que bater com a linha ----
  // Caso real (21/08): num "Resumo de Pedidos" impresso em DUAS colunas, a
  // leitura devolveu Cancelado=6 (era o valor de Dine In), PickUp=4 (valor de
  // "Editado", coluna da direita) e Retornado=1, com Dine In vazio. Os três
  // errados eram justamente os que valiam 0 no relatório. Reler a MESMA foto
  // deu outro resultado, também errado - não é foto ruim, é desalinhamento de
  // coluna, e ele não é estável.
  //
  // A conferência não depende do modelo acertar: ele já diz de que linha tirou
  // cada número (textoOrigem), e o servidor confere o nome do campo contra
  // essa linha. Aqui os pares REAIS daquele relatório.
  let okOcrConfere = false;
  try {
    const ocr = require('/home/user/adyen-monitor/server/canaisVendaOcr.js');
    const bate = ocr.rotuloBateComOrigem;
    const casos = {
      // ---- os três que passaram errado naquele dia: têm que ser recusados
      'Cancelado com o valor de Dine In é recusado': bate('Cancelado', 'Dine In 6') === false,
      'PickUp com o valor de Editado é recusado': bate('PickUp (R$)', 'Editado 4') === false,
      'Retornado com o valor de Delivery <=10 é recusado': bate('Retornado (R$)', 'Delivery <=10 1') === false,
      // ---- e os certos do MESMO relatório têm que passar (alarme falso aqui
      // treina quem lança a ignorar o aviso, e aí ele não serve pra nada)
      'Delivery na própria linha passa': bate('Delivery', 'Delivery 46') === true,
      'Carryout x "Carry Out" (espaço só no relatório) passa': bate('Carryout', 'Carry Out 12') === true,
      'PickUp x "Pick Up 0" passa': bate('PickUp (R$)', 'Pick Up 0') === true,
      'Dine In (R$) x "Dine In 6" passa': bate('Dine In (R$)', 'Dine In 6') === true,
      'Total x "Total 64" passa': bate('Total', 'Total 64') === true,
      'Taxa de Entrega passa': bate('Taxa de Entrega', 'Taxa de Entrega 386,10') === true,
      // acento no relatório e não no cadastro (e vice-versa)
      'Media Saida de Loja (OTD) x "Média Saída de Loja 15,84" passa':
        bate('Media Saida de Loja (OTD)', 'Média Saída de Loja 15,84') === true,
      'Avg Delivery Time (Calc) x "Avg Delivery Time 26.64" passa':
        bate('Avg Delivery Time (Calc)', 'Avg Delivery Time 26.64') === true,
      // sigla de 3 letras (OTD, ADT, DOT) é o nome inteiro do KPI nesse
      // relatório - se ela não casar, todo indicador de tempo vira suspeito
      'OTD x "OTD 15,84" passa': bate('OTD', 'OTD 15,84') === true,
      'ADT x "ADT 2,31" passa': bate('ADT', 'ADT 2,31') === true,
      'OTD com o valor de outra linha é recusado': bate('OTD', 'Leg Time 8,91') === false,
      // sem texto pra comparar não é motivo pra acusar: não saber é diferente
      // de estar errado, e alarme falso aqui custa a credibilidade do aviso
      'origem só com o número não vira suspeita': bate('Cancelado', '6') === true,
      'origem vazia não vira suspeita': bate('Cancelado', null) === true,
      // troca entre canais parecidos, que é o outro jeito de errar
      'Delivery com o valor de iFood é recusado': bate('Delivery', 'iFood 320,50') === false,
    };
    const falhas = Object.entries(casos).filter(([, ok]) => !ok).map(([n]) => n);
    okOcrConfere = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')}`);
  } catch (e) { okOcrConfere = false; console.log('  erro: ' + e.message); }
  if (!okOcrConfere) ruins += 1;
  console.log(`${okOcrConfere ? '✓' : '✗'} Leitura por foto: valor cuja linha de origem não menciona o campo é recusado (troca de coluna)`);

  // O quadro "Extreme Late Deliveries" imprime as DUAS coisas: a contagem por
  // faixa (coluna #) e, na última linha, a taxa por mil. Com o campo "Extremo"
  // guardando quantidade, pegar a linha da taxa troca "2 pedidos" por "43,48"
  // - números que não se parecem, mas que ninguém nota trocados no formulário.
  let okTaxa = false;
  try {
    const ocr = require('/home/user/adyen-monitor/server/canaisVendaOcr.js');
    const taxaEmContagem = ocr.valorDeTaxaEmCampoDeContagem;
    const casos = {
      'campo de contagem recebendo "Per 1000" é recusado':
        taxaEmContagem('Extremo', 'Per 1000* 43,48') === true,
      'variação em português também é pega':
        taxaEmContagem('Extremo', 'Extremos por mil 43,48') === true,
      'a contagem da faixa passa': taxaEmContagem('Extremo', '40-45 Min 1') === false,
      // o campo que PEDE a taxa continua aceitando a linha da taxa - senão o
      // aviso dispararia justamente onde a leitura está certa
      'campo cujo nome fala em por mil aceita a taxa':
        taxaEmContagem('Extremos por mil', 'Per 1000* 43,48') === false,
      'campo "Per 1000" aceita a taxa':
        taxaEmContagem('Extreme Lates Per 1000', 'Per 1000* 43,48') === false,
      // linha comum não pode virar suspeita por acaso
      'linha normal não vira suspeita': taxaEmContagem('Delivery', 'Delivery 46') === false,
      'origem vazia não vira suspeita': taxaEmContagem('Extremo', null) === false,
    };
    const falhas = Object.entries(casos).filter(([, ok]) => !ok).map(([n]) => n);
    okTaxa = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')}`);
  } catch (e) { okTaxa = false; console.log('  erro: ' + e.message); }
  if (!okTaxa) ruins += 1;
  console.log(`${okTaxa ? '✓' : '✗'} Leitura por foto: taxa ("Per 1000") não entra em campo que pede quantidade`);

  // A prova está impressa no próprio relatório: o quadro "Resumo de Pedidos"
  // lista as parcelas e o Total. No dia do erro a leitura somava 69 e o
  // relatório dizia 64 - a conta não fechava, e ninguém fazia a conta.
  // Modelo transcreve o quadro (ler layout), servidor soma (aritmética).
  let okSoma = false;
  try {
    const ocr = require('/home/user/adyen-monitor/server/canaisVendaOcr.js');
    const parte = (t, v, k) => ({ textoOrigem: t, valor: v, chave: k });
    // ---- o quadro do print, lido ERRADO (foi o que aconteceu)
    const errado = ocr.conferirSomas([{
      titulo: 'Resumo de Pedidos', totalTexto: 'Total 64', totalValor: 64,
      partes: [
        parte('Delivery 46', 46, 'kpi.delivery'), parte('Carry Out 12', 12, 'kpi.carryout'),
        parte('Pick Up 4', 4, 'kpi.pickup'), parte('Dine In 0', 0, 'kpi.dinein'),
        parte('Cancelado 6', 6, 'kpi.cancelado'), parte('Retornado 1', 1, 'kpi.retornado'),
      ],
    }]);
    // ---- o MESMO quadro lido certo
    const certo = ocr.conferirSomas([{
      titulo: 'Resumo de Pedidos', totalTexto: 'Total 64', totalValor: 64,
      partes: [
        parte('Delivery 46', 46, 'kpi.delivery'), parte('Carry Out 12', 12, 'kpi.carryout'),
        parte('Pick Up 0', 0, 'kpi.pickup'), parte('Dine In 6', 6, 'kpi.dinein'),
        parte('Cancelado 0', 0, 'kpi.cancelado'), parte('Retornado 0', 0, 'kpi.retornado'),
      ],
    }]);
    const casos = {
      'a leitura errada do print é pega pela soma': errado.length === 1 && errado[0].soma === 69 && errado[0].total === 64,
      'a soma acusa TODAS as parcelas do quadro, não adivinha qual errou':
        errado.length === 1 && errado[0].chaves.length === 6,
      'a leitura certa do MESMO quadro passa': certo.length === 0,
      // parcela que não é campo cadastrado entra na SOMA mesmo assim - senão
      // um quadro com uma linha a mais nunca fecharia e o aviso viraria ruído
      // 3 parcelas de propósito: com 2 a guarda de "quadro pequeno demais"
      // mascararia o defeito de tirar a parcela não cadastrada da soma
      'parcela sem campo cadastrado ainda entra na conta': ocr.conferirSomas([{
        titulo: 'x', totalValor: 100,
        partes: [parte('A 30', 30, 'kpi.a'), parte('B 30', 30, 'kpi.b'), parte('Linha nao cadastrada 40', 40, null)],
      }]).length === 0,
      // dinheiro: centavo de arredondamento não é erro de leitura
      'diferença de centavo por arredondamento não vira alarme': ocr.conferirSomas([{
        titulo: 'x', totalValor: 100.00,
        partes: [parte('A 33,33', 33.33, 'k.a'), parte('B 33,33', 33.33, 'k.b'), parte('C 33,34', 33.34, 'k.c')],
      }]).length === 0,
      'diferença de verdade em dinheiro é pega': ocr.conferirSomas([{
        titulo: 'x', totalValor: 100,
        partes: [parte('A 33,33', 33.33, 'k.a'), parte('B 33,33', 33.33, 'k.b')],
      }]).length === 1,
      // quadro que não prova nada não pode gerar aviso
      'quadro sem total não vira alarme': ocr.conferirSomas([{ titulo: 'x', partes: [parte('A 1', 1, 'k.a'), parte('B 2', 2, 'k.b')] }]).length === 0,
      'quadro com uma parcela só não vira alarme': ocr.conferirSomas([{ titulo: 'x', totalValor: 9, partes: [parte('A 1', 1, 'k.a')] }]).length === 0,
      'conferencias ausente não quebra': ocr.conferirSomas(undefined).length === 0,
    };
    const falhas = Object.entries(casos).filter(([, ok]) => !ok).map(([n]) => n);
    okSoma = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')}`);
  } catch (e) { okSoma = false; console.log('  erro: ' + e.message); }
  if (!okSoma) ruins += 1;
  console.log(`${okSoma ? '✓' : '✗'} Leitura por foto: a soma das parcelas x o total impresso pega o desalinhamento (69 ≠ 64)`);

  // ---- LEITURA DUPLA: só entra sozinho o valor em que as duas concordam ----
  // O caso real (21/08, 2ª ocorrência): o Service Times Summary foi lido com
  // tudo deslocado uma linha - Leg Time recebeu 23,6 (valor do Run Time),
  // Tempo de Espera recebeu 8,91 (valor do Leg Time), Produção recebeu 5,09
  // (valor do Avg Carryout Load Time) - e NENHUMA trava alcançou: o quadro
  // não imprime total (a soma não confere) e o modelo escreveu textoOrigem
  // coerente com o próprio erro (o rótulo confere). Mas reler dava OUTRO
  // resultado: a instabilidade é mensurável. Aqui, os números exatos.
  let okConsenso = false;
  try {
    const ocr = require('/home/user/adyen-monitor/server/canaisVendaOcr.js');
    const item = (campo, valor) => ({ secao: 'kpi', campo, label: campo, valor, textoOrigem: `${campo} ${valor}` });
    const base = { suspeitos: [], somasRuins: [], naoIdentificados: [], data: '2026-08-21' };
    // leitura A: a CERTA (bate com o relatório impresso)
    const A = { ...base,
      itens: [item('atendimento', 2.31), item('producao', 5.27), item('espera', 3.54),
        item('otd', 15.84), item('legtime', 8.91), item('runtime', 23.6)],
      faltando: [{ secao: 'kpi', campo: 'extremo', label: 'Extremo' }],
    };
    // leitura B: a DESLOCADA (o que apareceu na tela da loja)
    const B = { ...base,
      itens: [item('atendimento', 2.31), item('producao', 5.09), item('espera', 8.91),
        item('otd', 8.91), item('legtime', 23.6)],
      faltando: [{ secao: 'kpi', campo: 'runtime', label: 'runtime' }, { secao: 'kpi', campo: 'extremo', label: 'Extremo' }],
    };
    const r = ocr.reconciliarLeituras(A, B);
    const soCampo = (lista) => lista.map((x) => x.campo).sort().join(',');
    const casos = {
      'só o campo em que as duas concordaram entra sozinho': soCampo(r.itens) === 'atendimento',
      'os 4 deslocados viram suspeitos com os dois valores': r.suspeitos.filter((x) => /não bateram/.test(x.motivo || '')).length === 4,
      'campo que só apareceu numa leitura vira suspeito, não item':
        r.suspeitos.some((x) => x.campo === 'runtime' && /só apareceu/.test(x.motivo || '')),
      'nenhum valor deslocado entrou como item': !r.itens.some((x) => ['producao','espera','otd','legtime'].includes(x.campo)),
      'faltando nas duas continua faltando': soCampo(r.faltando) === 'extremo',
      // as duas iguais = tudo entra, zero suspeito (o caso normal não pode piorar)
      'duas leituras iguais preenchem tudo sem suspeita': (() => {
        const rr = ocr.reconciliarLeituras(A, JSON.parse(JSON.stringify(A)));
        return soCampo(rr.itens) === soCampo(A.itens) && rr.suspeitos.length === 0 && rr.data === '2026-08-21';
      })(),
      // suspeito de UMA leitura (rótulo/taxa/soma) segue suspeito mesmo se a
      // outra trouxe o campo como item - uma desconfiar já basta
      'suspeito de uma leitura rebaixa o item da outra': (() => {
        const A2 = { ...base, itens: [item('extremo', 2)], faltando: [] };
        const B2 = { ...base, itens: [], suspeitos: [{ secao: 'kpi', campo: 'extremo', label: 'Extremo', valor: 43.48, motivo: 'taxa em campo de quantidade' }], faltando: [] };
        const rr = ocr.reconciliarLeituras(A2, B2);
        return rr.itens.length === 0 && rr.suspeitos.length >= 1;
      })(),
      'datas divergentes não escolhem uma no chute': ocr.reconciliarLeituras({ ...base, itens: [], faltando: [] }, { ...base, data: '2026-08-20', itens: [], faltando: [] }).data === null,
    };
    const falhas = Object.entries(casos).filter(([, ok]) => !ok).map(([n]) => n);
    okConsenso = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')}`);
  } catch (e) { okConsenso = false; console.log('  erro: ' + e.message); }
  if (!okConsenso) ruins += 1;
  console.log(`${okConsenso ? '✓' : '✗'} Leitura por foto: leitura dupla - só preenche sozinho o valor em que as DUAS leituras bateram`);

  // ---- DESEMPATE: 3ª leitura com modelo mais forte, só na divergência ----
  // "Aumentar o modelo" do jeito barato: em vez de pagar o modelo caro em
  // toda leitura, ele entra APENAS nos campos em que as duas leituras normais
  // discordaram - melhor de 3. E maioria não revoga regra: suspeito
  // determinístico (rótulo/taxa/soma) não é desempatável.
  let okDesempate = false;
  try {
    const ocr = require('/home/user/adyen-monitor/server/canaisVendaOcr.js');
    const item = (campo, valor) => ({ secao: 'kpi', campo, label: campo, valor, textoOrigem: `${campo} ${valor}` });
    const consensoBase = {
      itens: [item('atendimento', 2.31)],
      suspeitos: [
        { ...item('legtime', 8.91), candidatos: [8.91, 23.6], motivo: 'li duas vezes e os valores não bateram (1ª leitura: 8.91 · 2ª: 23.6)' },
        { ...item('runtime', 23.6), candidatos: [23.6], motivo: 'só apareceu numa das duas leituras (valor lido: 23.6)' },
        { ...item('extremo', 43.48), motivo: 'taxa em campo de quantidade' }, // determinístico: SEM candidatos
      ],
      somasRuins: [], naoIdentificados: [], faltando: [], data: '2026-08-21',
    };
    const clonar = () => JSON.parse(JSON.stringify(consensoBase));
    const casos = {
      'desempate confirma um dos candidatos: o campo entra com o vencedor': (() => {
        const r = ocr.desempatar(clonar(), { itens: [item('legtime', 8.91), item('runtime', 23.6)] });
        return r.itens.some((x) => x.campo === 'legtime' && x.valor === 8.91)
          && r.itens.some((x) => x.campo === 'runtime' && x.valor === 23.6)
          && !r.suspeitos.some((x) => x.campo === 'legtime');
      })(),
      'desempate traz um TERCEIRO valor: continua suspeito, com os três à mostra': (() => {
        const r = ocr.desempatar(clonar(), { itens: [item('legtime', 15.84)] });
        const sp = r.suspeitos.find((x) => x.campo === 'legtime');
        return !!sp && /TERCEIRO valor \(15.84\)/.test(sp.motivo) && !r.itens.some((x) => x.campo === 'legtime');
      })(),
      'desempate não achou o campo: continua suspeito, dizendo isso': (() => {
        const r = ocr.desempatar(clonar(), { itens: [] });
        const sp = r.suspeitos.find((x) => x.campo === 'legtime');
        return !!sp && /também não deu certeza/.test(sp.motivo);
      })(),
      'suspeito determinístico (taxa/rótulo/soma) NÃO é desempatável': (() => {
        // o desempate "confirma" 43.48 - e mesmo assim o campo não entra:
        // maioria de leituras não revoga a regra que o recusou
        const r = ocr.desempatar(clonar(), { itens: [item('extremo', 43.48)] });
        return !r.itens.some((x) => x.campo === 'extremo') && r.suspeitos.some((x) => x.campo === 'extremo');
      })(),
      'o que já estava verde não é tocado': (() => {
        const r = ocr.desempatar(clonar(), { itens: [item('atendimento', 9.99)] });
        return r.itens.find((x) => x.campo === 'atendimento').valor === 2.31;
      })(),
    };
    const falhas = Object.entries(casos).filter(([, ok]) => !ok).map(([n]) => n);
    okDesempate = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')}`);
  } catch (e) { okDesempate = false; console.log('  erro: ' + e.message); }
  if (!okDesempate) ruins += 1;
  console.log(`${okDesempate ? '✓' : '✗'} Leitura por foto: desempate (melhor de 3) com modelo forte só nos campos divergentes`);

  // fonte: o desempate SÓ roda quando há divergência (o dia normal não paga a
  // 3ª chamada), e os modelos saem de env var (trocar sem mexer em código)
  let okDesempateFonte = false;
  try {
    const src = require('fs').readFileSync(__dirname + '/canaisVendaOcr.js', 'utf8');
    okDesempateFonte = /process\.env\.OCR_MODELO \|\| 'claude-sonnet-5'/.test(src)
      && /process\.env\.OCR_MODELO_DESEMPATE \|\| 'claude-opus-5'/.test(src)
      && /if \(!pendentes\.length\) return consenso;/.test(src)
      && /desempatar\(consenso, await umaLeitura\(MODELO_DESEMPATE\)\)/.test(src);
  } catch (e) { okDesempateFonte = false; }
  if (!okDesempateFonte) ruins += 1;
  console.log(`${okDesempateFonte ? '✓' : '✗'} Leitura por foto: desempate só na divergência + modelos configuráveis por env`);

  // e a leitura de fato roda duas vezes (fonte): sem isso o consenso é teatro
  let okDupla = false;
  try {
    const src = require('fs').readFileSync(__dirname + '/canaisVendaOcr.js', 'utf8');
    okDupla = /Promise\.allSettled\(\[umaLeitura\(\), umaLeitura\(\)\]\)/.test(src)
      && /reconciliarLeituras\(ra\.value, rb\.value\)/.test(src);
  } catch (e) { okDupla = false; }
  if (!okDupla) ruins += 1;
  console.log(`${okDupla ? '✓' : '✗'} Leitura por foto: a leitura roda DUAS vezes em paralelo antes de preencher`);

  // O fechamento completo (5 fotos: cartão, resumo de pedidos, service
  // times, taxa...) estourava o teto de resposta de 8000 tokens depois que a
  // resposta ganhou textoOrigem por campo e a transcrição dos quadros - e a
  // loja via "campos demais pra processar" num relatório de tamanho normal,
  // sendo mandada fazer leituras separadas por um limite NOSSO. Teto de
  // resposta não é teto de custo (só se paga pelo que o modelo escreve),
  // então ele fica alto E a resposta fica enxuta - as duas coisas, porque
  // qualquer uma sozinha pode não bastar num relatório maior que este.
  let okTetoResposta = false;
  try {
    const src = require('fs').readFileSync(__dirname + '/canaisVendaOcr.js', 'utf8');
    const m = src.match(/max_tokens:\s*(\d+)/);
    okTetoResposta = !!m && Number(m[1]) >= 32000
      && /Mantenha CURTO: só o par nome\+valor/.test(src)          // textoOrigem enxuto
      && /PELO MENOS UM campo da lista cadastrada/.test(src)        // conferencias só onde conferem algo
      && /No máximo 4 quadros/.test(src)
      && /stop_reason === 'max_tokens'/.test(src)                   // o último recurso continua explicado
      // com teto alto o SDK RECUSA chamada sem streaming ("Streaming is
      // required for operations that may take longer than 10 minutes") -
      // foi o erro que a loja viu na tela. Voltar pra .create() reintroduz.
      && /messages\.stream\(/.test(src) && /\.finalMessage\(\)/.test(src)
      && !/messages\.create\(/.test(src);
  } catch (e) { okTetoResposta = false; }
  if (!okTetoResposta) ruins += 1;
  console.log(`${okTetoResposta ? '✓' : '✗'} Leitura por foto: 5 fotos do fechamento completo cabem numa leitura só (teto alto + resposta enxuta)`);

  // O prompt precisa dizer as três coisas que o relatório em duas colunas
  // exige - sem elas o modelo desalinha de novo e a conferência vira o único
  // freio, em vez do segundo
  let okPromptColunas = false;
  try {
    const src = require('fs').readFileSync(__dirname + '/canaisVendaOcr.js', 'utf8');
    okPromptColunas = /DUAS COLUNAS/.test(src) && /ZERO NÃO SE PULA/.test(src)
      && /textoOrigem" tem que ser a linha REAL/.test(src)
      && /"conferencias": quando o relatório imprime um TOTAL/.test(src)
      && /TAXA NÃO É QUANTIDADE/.test(src);
  } catch (e) { okPromptColunas = false; }
  if (!okPromptColunas) ruins += 1;
  console.log(`${okPromptColunas ? '✓' : '✗'} Leitura por foto: o prompt avisa do layout em 2 colunas, do zero que não se pula e do textoOrigem conferido`);

  // ---- FORMULÁRIOS: o seletor de Unidade respeita quem foi liberado ----
  // O Master libera uma pessoa pra UMA loja e o seletor mostrava TODAS -
  // gerente de uma loja via (e podia emitir) formulário de pagamento de
  // outra empresa. A causa: a lista de unidades do formulário era escrita à
  // mão ("Domino's Caruaru") e não batia com o código que as permissões
  // usam ("Dominos Caruaru"), então não havia com o que casar. As duas
  // pontas do mesmo defeito - a LISTA de formulários, que compara igual,
  // vinha vazia pra quem não é Master.
  let okFormUnidades = false;
  try {
    const bcrypt = require('bcryptjs');
    const senhaHash = bcrypt.hashSync('SenhaDeTeste!2026', 4);
    DOCS.set('users/u-form-caruaru', {
      passwordHash: senhaHash, role: 'user', active: true,
      email: 'form-caruaru@teste.local', username: 'formcaruaru',
      permissions: { sections: ['formularios'], unidades: ['Dominos Caruaru'], vaultSubgroups: [], tiposSolicitacao: [] },
      createdAt: new Date().toISOString(),
    });
    const tk = (await auth.login('form-caruaru@teste.local', 'SenhaDeTeste!2026')).token;
    const cab = { Authorization: 'Bearer ' + tk };
    const cabMaster = token ? { Authorization: 'Bearer ' + token } : {};

    const dela = JSON.parse((await pedir('/api/formularios/unidades', cab)).corpo);
    const doMaster = JSON.parse((await pedir('/api/formularios/unidades', cabMaster)).corpo);

    // ela vê SÓ a dela; o Master continua vendo tudo
    const soADela = dela.length === 1 && dela[0].unidade === "Domino's Caruaru";
    const masterVeTudo = doMaster.length > dela.length;
    // e a razão social/CNPJ continuam vindo travados do cadastro
    const temCadastro = soADela && dela[0].razaoSocial === 'America Caruaru' && /50\.724\.770/.test(dela[0].cnpj);
    // a unidade nova que faltava (só existia CNPJ no papel) agora está lá
    const temSaltiverso = doMaster.some((u) => u.unidade === 'Saltiverso Patteo' && /66\.644\.523/.test(u.cnpj));
    // cadastro sem unidade vinculada não vaza: falha fechada, só o Master
    const semVinculoSoMaster = !dela.some((u) => u.unidade === 'Big Brother - Recife')
      && doMaster.some((u) => u.unidade === 'Big Brother - Recife');

    // a trava de verdade é no servidor: mandar a unidade na requisição, sem
    // passar pelo seletor, tem que tomar 403
    const forjado = await postarJson('/api/formularios', {
      tipo: 'reembolso', unidade: 'Spoleto Shopping Recife', campos: {}, linhas: [],
    }, cab);
    const recusaForjado = forjado.status === 403 && /não tem acesso a essa unidade/i.test(forjado.corpo);
    const forjadoLink = await postarJson('/api/formularios/link-preenchimento', {
      tipo: 'reembolso', unidade: 'Spoleto Shopping Recife',
    }, cab);
    const recusaLink = forjadoLink.status === 403;

    // e o caminho legítimo, na unidade dela, continua funcionando
    const legitimo = await postarJson('/api/formularios', {
      tipo: 'reembolso', unidade: "Domino's Caruaru",
      campos: { favorecido: 'Fulano', descricao: 'Teste' },
      linhas: [{ descricao: 'Item de teste', valor: '10,00' }],
    }, cab);
    const criou = legitimo.status === 200;
    // ...e aparece na lista DELA (era isso que vinha vazio: o registro guarda
    // o rótulo, a permissão fala em código - agora grava os dois)
    const lista = JSON.parse((await pedir('/api/formularios', cab)).corpo);
    const veOProprio = Array.isArray(lista) && lista.some((f) => f.unidade === "Domino's Caruaru");

    okFormUnidades = soADela && masterVeTudo && temCadastro && temSaltiverso
      && semVinculoSoMaster && recusaForjado && recusaLink && criou && veOProprio;
    if (!okFormUnidades) {
      console.log(`  detalhe: soADela=${soADela} masterVeTudo=${masterVeTudo} cadastro=${temCadastro} saltiverso=${temSaltiverso} semVinculo=${semVinculoSoMaster} forjado=${recusaForjado} link=${recusaLink} criou=${criou}(${legitimo.corpo.slice(0, 90)}) veOProprio=${veOProprio}`);
    }
  } catch (e) { okFormUnidades = false; console.log('  erro: ' + e.message); }
  if (!okFormUnidades) ruins += 1;
  console.log(`${okFormUnidades ? '✓' : '✗'} Formulários: o seletor de Unidade mostra só o que foi liberado (e o servidor recusa o resto)`);

  // ------------------------------------------------------------------
  // Pedido do usuário: campo de data tem que abrir o calendário de
  // verdade, não caixa de texto. A marca `data:true` no modelo (ver
  // formularios.js TIPOS) é o que a tela usa pra trocar o input - aqui só
  // confere que ela sai na rota que a tela consulta, nos campos certos e
  // SÓ neles (ex: "DATA(S)" das diárias, que aceita mais de uma data
  // junta, tem que continuar de fora).
  let okCamposData = false;
  try {
    const cab = { Authorization: 'Bearer ' + token };
    const tipos = JSON.parse((await pedir('/api/formularios/tipos', cab)).corpo || '[]');
    const acha = (tipo) => tipos.find((t) => t.tipo === tipo);
    const campoData = (modelo, lista, key) => {
      const c = (modelo[lista] || []).find((x) => x.key === key);
      return c ? !!c.data : null;
    };
    okCamposData = campoData(acha('deposito'), 'colunas', 'data') === true
      && campoData(acha('diariasRh'), 'colunas', 'data') === true
      && campoData(acha('avulso'), 'colunas', 'data') === true
      && campoData(acha('reembolso'), 'colunas', 'data') === true
      && campoData(acha('assBoleto'), 'cabecalho', 'vencimento') === true
      // "DATA(S)" das diárias fica de fora de propósito (mais de uma data junta)
      && campoData(acha('diarias'), 'colunas', 'datas') !== true;
  } catch (e) { okCamposData = false; console.log('  erro: ' + e.message); }
  if (!okCamposData) ruins += 1;
  console.log(`${okCamposData ? '✓' : '✗'} Formulários: campos de data vêm marcados pro seletor de calendário (e só eles)`);

  // O cadastro de unidade saiu do código pra uma tela do Master: CNPJ muda
  // por decisão de contabilidade, não por deploy. E CNPJ entra travado no
  // PDF - um dígito trocado só aparece quando alguém tenta conciliar.
  let okFormCadastro = false;
  try {
    const cabMaster = token ? { Authorization: 'Bearer ' + token } : {};
    const cnpjTorto = await postarJson('/api/formularios/cadastro-unidades', {
      unidade: 'Loja Nova Teste', razaoSocial: 'Nova Teste LTDA', cnpj: '11.111.111/1111-11',
    }, cabMaster);
    const recusouCnpj = cnpjTorto.status === 400 && /d[ií]gito verificador|inv[áa]lido/i.test(cnpjTorto.corpo);

    const nova = await postarJson('/api/formularios/cadastro-unidades', {
      unidade: 'Loja Nova Teste', razaoSocial: 'Nova Teste LTDA',
      cnpj: '66644523000189', codigo: 'Dominos Bessa',
    }, cabMaster);
    const criou = nova.status === 200;
    const novaId = criou ? JSON.parse(nova.corpo).id : null;
    // CNPJ digitado só com números sai formatado - é assim que entra no PDF
    const formatou = criou && JSON.parse(nova.corpo).cnpj === '66.644.523/0001-89';

    const repetida = await postarJson('/api/formularios/cadastro-unidades', {
      unidade: 'Loja Nova Teste', razaoSocial: 'Outra', cnpj: '50.625.368/0001-13',
    }, cabMaster);
    const recusouDuplicada = repetida.status === 400 && /já existe/i.test(repetida.corpo);

    // desativar tira do seletor SEM apagar: formulário já emitido tem que
    // continuar abrindo com a razão social e o CNPJ de quando foi assinado
    await putJson(`/api/formularios/cadastro-unidades/${novaId}/ativo`, { ativo: false }, cabMaster);
    const depois = JSON.parse((await pedir('/api/formularios/unidades', cabMaster)).corpo);
    const sumiuDoSeletor = !depois.some((u) => u.unidade === 'Loja Nova Teste');
    const continuaNoCadastro = JSON.parse((await pedir('/api/formularios/cadastro-unidades', cabMaster)).corpo)
      .some((u) => u.unidade === 'Loja Nova Teste');

    // e ninguém além do Master mexe nisso
    const tkOutro = (await auth.login('form-caruaru@teste.local', 'SenhaDeTeste!2026')).token;
    const intruso = await postarJson('/api/formularios/cadastro-unidades', {
      unidade: 'Invadida', razaoSocial: 'X', cnpj: '50.625.368/0001-13',
    }, { Authorization: 'Bearer ' + tkOutro });
    const soMaster = intruso.status === 403;

    okFormCadastro = recusouCnpj && criou && formatou && recusouDuplicada
      && sumiuDoSeletor && continuaNoCadastro && soMaster;
    if (!okFormCadastro) {
      console.log(`  detalhe: cnpjTorto=${recusouCnpj} criou=${criou}(${nova.corpo.slice(0, 80)}) formatou=${formatou} duplicada=${recusouDuplicada} sumiu=${sumiuDoSeletor} continua=${continuaNoCadastro} soMaster=${soMaster}`);
    }
  } catch (e) { okFormCadastro = false; console.log('  erro: ' + e.message); }
  if (!okFormCadastro) ruins += 1;
  console.log(`${okFormCadastro ? '✓' : '✗'} Formulários: Master cadastra/corrige/desativa unidade sem deploy (CNPJ conferido pelo dígito)`);

  // ---- ÓRFÃOS DE EDIÇÃO NAS PÁGINAS: sintaxe válida, execução morta ----
  // O RH ficou de TELA BRANCA em produção por um `async` órfão: uma edição
  // inseriu um bloco entre o `async` e o `function carregarCheckins`, e o
  // `async` sozinho virou referência a uma variável inexistente. `node
  // --check` NÃO pega (é sintaxe válida - ASI transforma em `async;`), o
  // erro só existe em runtime, e ele mata o script inteiro da página: o
  // cabeçalho carrega e o corpo nunca renderiza. Este pente varre TODAS as
  // páginas atrás desse resíduo de edição.
  let okOrfaos = false;
  try {
    const fs2 = require('fs');
    const dirPub = __dirname + '/public';
    const problemas = [];
    fs2.readdirSync(dirPub).filter((f) => f.endsWith('.html') || f.endsWith('.js')).forEach((f) => {
      const linhas = fs2.readFileSync(`${dirPub}/${f}`, 'utf8').split('\n');
      linhas.forEach((l, i) => {
        // `async` sozinho na linha (com ou sem comentário depois): nunca é
        // código intencional - `async function`/`async (` ficam na mesma linha
        if (/^\s*async\s*(\/\/.*)?$/.test(l)) problemas.push(`${f}:${i + 1}`);
      });
    });
    okOrfaos = problemas.length === 0;
    if (problemas.length) console.log(`  async órfão em: ${problemas.join(', ')}`);
  } catch (e) { okOrfaos = false; console.log('  erro: ' + e.message); }
  if (!okOrfaos) ruins += 1;
  console.log(`${okOrfaos ? '✓' : '✗'} Páginas: nenhum async órfão deixado por edição (o que deixou o RH de tela branca)`);

  // ---- SEÇÕES RECOLHÍVEIS: toda página do app carrega recolher.js ----
  // Pedido do usuário: "tudo que tiver consumindo espaço na tela" recolhe pro
  // título. O contrato aqui é de ROLLOUT: página interna (tem o menu,
  // nav-menu.js) sem recolher.js é página que ficou de fora - inclusive as
  // que forem criadas daqui pra frente.
  {
    let semRecolher = [];
    try {
      const fs3 = require('fs');
      const dirPub3 = require('path').join(__dirname, 'public');
      fs3.readdirSync(dirPub3).filter((f) => f.endsWith('.html')).forEach((f) => {
        const html = fs3.readFileSync(`${dirPub3}/${f}`, 'utf8');
        if (html.includes('/nav-menu.js') && !html.includes('/recolher.js')) semRecolher.push(f);
      });
    } catch (e) { semRecolher = ['erro: ' + e.message]; }
    const okRecolher = semRecolher.length === 0;
    if (!okRecolher) { ruins += 1; console.log('  sem recolher.js: ' + semRecolher.join(', ')); }
    console.log(`${okRecolher ? '✓' : '✗'} Páginas do app: todas carregam recolher.js (seções recolhem pro título)`);
  }

  // ---- RH: saída depois da meia-noite é o MESMO turno ----
  // Caso real: entrada 15:07, check-out automático 00:30 já com data do dia
  // seguinte - "ainda faz parte do dia vigente". A tela de edição tem UMA
  // data (a do dia trabalhado); a saída "menor" que a entrada rola pro dia
  // seguinte no relógio, o registro continua no dia da ENTRADA, e turno que
  // ficaria com mais de 18h volta pra conferência (digitação trocada).
  DOCS.set('rhCheckins/ckvirada', {
    id: 'ckvirada', funcionarioId: 'f-virada', funcionarioNome: 'Teste Virada', unidade: 'Dominos Caruaru',
    data: '2026-08-21', status: 'aberto',
    entrada: { horario: '2026-08-21T18:07:00.000Z' }, // 15:07 em Brasília
    saida: { horario: '2026-08-21T20:00:00.000Z' },
  });
  const virada = await enviarJson('PATCH', '/api/rh/checkins/ckvirada', {
    entradaData: '2026-08-21', entradaHora: '15:07', saidaData: '2026-08-21', saidaHora: '00:30',
  }, { Authorization: 'Bearer ' + token });
  const docVirada = DOCS.get('rhCheckins/ckvirada') || {};
  const okVirada = virada.status === 200
    && docVirada.saida && docVirada.saida.horario === '2026-08-22T03:30:00.000Z' // 00:30 de Brasília do dia SEGUINTE
    && docVirada.saida.viradaDeDia === true
    && docVirada.data === '2026-08-21'; // o dia vigente continua o da entrada
  if (!okVirada) ruins += 1;
  console.log(`${okVirada ? '✓' : '✗'} RH: saída 00:30 com entrada 15:07 vira madrugada do dia seguinte, no mesmo turno: HTTP ${virada.status} saida=${docVirada.saida && docVirada.saida.horario}`);

  const viradaLonga = await enviarJson('PATCH', '/api/rh/checkins/ckvirada', {
    entradaData: '2026-08-21', entradaHora: '15:07', saidaData: '2026-08-21', saidaHora: '14:00',
  }, { Authorization: 'Bearer ' + token });
  const okViradaLonga = viradaLonga.status === 400 && /mais de 18h/.test(viradaLonga.corpo);
  if (!okViradaLonga) ruins += 1;
  console.log(`${okViradaLonga ? '✓' : '✗'} RH: saída que daria turno de 23h volta pra conferência em vez de gravar: HTTP ${viradaLonga.status} ${viradaLonga.corpo.slice(0, 80)}`);

  // ---- DIÁRIAS POR CHECK-IN -> FORMULÁRIO DE PAGAMENTO (Master) ----
  // Extra/candidato em teste recebem por diária (1 check-in = 1 diária = 1
  // linha). O Master gera o formulário e recebe os links de assinatura do
  // Favorecido e do Responsável. A trava central que este bloco protege:
  // check-in que JÁ entrou num formulário não entra em outro (pagar a mesma
  // diária duas vezes é exatamente a fraude que o fluxo existe pra impedir).
  {
    const cabM = { Authorization: 'Bearer ' + token };
    DOCS.set('rhFuncionarios/f-diarias', {
      id: 'f-diarias', nome: 'Diarista Da Silva', unidade: 'Dominos Bessa', tipoCadastro: 'extra', status: 'ativo',
      dataAdmissao: '2026-08-10', criadoEm: '2026-08-10T10:00:00Z', linkToken: 'tok-diarias', cpf: '11144477735',
    });
    const mkCk = (id, data, status, extra = {}) => DOCS.set('rhCheckins/' + id, {
      id, funcionarioId: 'f-diarias', funcionarioNome: 'Diarista Da Silva', unidade: 'Dominos Bessa', data,
      entrada: { horario: data + 'T12:00:00.000Z' },
      saida: status === 'fechado' ? { horario: data + 'T20:00:00.000Z' } : null,
      status, criadoEm: data + 'T12:00:00.000Z', ...extra,
    });
    mkCk('ckd1', '2026-08-18', 'fechado');
    mkCk('ckd2', '2026-08-19', 'fechado');
    mkCk('ckd3', '2026-08-20', 'pendente_aprovacao'); // não aprovado: não vira diária
    mkCk('ckd4', '2026-08-17', 'fechado', { diariaFormularioId: 'form-antigo' }); // já pago
    const rhModDia = require('./rh.js');
    rhModDia.invalidar && rhModDia.invalidar();
    require('./rhCheckin.js').invalidar();

    const pend = await pedir('/api/rh/funcionarios/f-diarias/diarias-pendentes', cabM);
    let pendJ = {};
    try { pendJ = JSON.parse(pend.corpo); } catch (e) { pendJ = {}; }
    const idsPend = (pendJ.checkins || []).map((c) => c.id);
    const okPendDia = pend.status === 200 && idsPend.length === 2 && idsPend.includes('ckd1') && idsPend.includes('ckd2')
      && pendJ.unidadeFormularioSugerida === "Domino's Bessa - João Pessoa";
    if (!okPendDia) ruins += 1;
    console.log(`${okPendDia ? '✓' : '✗'} diárias: só check-in aprovado e ainda não pago entra na lista (e a empresa certa vem sugerida): HTTP ${pend.status} ids=${idsPend.join('|')} sugerida=${pendJ.unidadeFormularioSugerida}`);

    const ger = await postarJson('/api/rh/funcionarios/f-diarias/gerar-formulario-diarias', {
      checkinIds: ['ckd1', 'ckd2'], valorDiaria: '150,00', chavePix: '83 98888-0000', banco: 'Nubank',
      unidadeFormulario: "Domino's Bessa - João Pessoa",
    }, cabM);
    let gerJ = {};
    try { gerJ = JSON.parse(ger.corpo); } catch (e) { gerJ = {}; }
    const chavesAss = (gerJ.assinaturas || []).map((a) => a.chave).sort().join(',');
    const okGerDia = ger.status === 200 && gerJ.tipo === 'diariasRh'
      && (gerJ.linhas || []).length === 2 && gerJ.valorTotal === 300
      && gerJ.linhas[0].data === '18/08/2026' && gerJ.linhas[0].nome === 'Diarista Da Silva'
      && chavesAss === 'favorecido,responsavel'
      && (gerJ.assinaturas || []).every((a) => a.link && a.link.includes('/assinar.html?'))
      && gerJ.campos && gerJ.campos.chavePix === '83 98888-0000' && gerJ.campos.cpf === '111.444.777-35'
      && gerJ.numeroTicket != null;
    if (!okGerDia) ruins += 1;
    console.log(`${okGerDia ? '✓' : '✗'} diárias: 2 check-ins viram formulário com 2 linhas (R$ 300) + links de assinatura Favorecido/Responsável: HTTP ${ger.status} ${ger.corpo.slice(0, 110)}`);

    const dobro = await postarJson('/api/rh/funcionarios/f-diarias/gerar-formulario-diarias', {
      checkinIds: ['ckd1'], valorDiaria: '150,00', unidadeFormulario: "Domino's Bessa - João Pessoa",
    }, cabM);
    const okDobro = dobro.status === 400 && /já está em outro formulário/i.test(dobro.corpo);
    if (!okDobro) ruins += 1;
    console.log(`${okDobro ? '✓' : '✗'} diárias: check-in já pago é recusado (diária não sai duas vezes): HTTP ${dobro.status} ${dobro.corpo.slice(0, 90)}`);

    const depois = await pedir('/api/rh/funcionarios/f-diarias/diarias-pendentes', cabM);
    let depoisJ = {};
    try { depoisJ = JSON.parse(depois.corpo); } catch (e) { depoisJ = {}; }
    const okFicha = depois.status === 200 && (depoisJ.checkins || []).length === 0
      && depoisJ.funcionario && depoisJ.funcionario.chavePix === '83 98888-0000' && depoisJ.funcionario.banco === 'Nubank';
    if (!okFicha) ruins += 1;
    console.log(`${okFicha ? '✓' : '✗'} diárias: a chave PIX fica salva na ficha e os check-ins pagos somem da lista: HTTP ${depois.status} pix=${depoisJ.funcionario && depoisJ.funcionario.chavePix} restam=${(depoisJ.checkins || []).length}`);
  }

  // ---- DESBLOQUEIO AVISA A PESSOA ----
  // Quando o ticket automático de "Login bloqueado" é aprovado, quem estava
  // bloqueado recebe a MESMA frase do pop-up de quem aprovou ("Login
  // desbloqueado! ... mesma senha de sempre"), como mensagem direta gravada
  // (abre assim que ela entrar de novo) + push. Este bloco protege o canal
  // gravado: aprova o ticket e confere que a conversa existe, com o texto
  // certo, em nome de quem aprovou.
  {
    const cabM = { Authorization: 'Bearer ' + token };
    DOCS.set('users/u-bloq-teste', {
      email: 'bloqueado@teste.local', username: 'bloqueadoteste', passwordHash: 'x', role: 'user', active: true,
      permissions: { sections: [], unidades: [], vaultSubgroups: [], tiposSolicitacao: [] },
      locked: true, failedAttempts: 3,
    });
    const authMod = require('./auth.js');
    const ticketBloq = await require('./solicitacoes.js').create({
      tipo: 'suporte-ti', unidade: 'geral', unidadeNome: 'Sem unidade vinculada a este login',
      titulo: 'Login bloqueado: bloqueado@teste.local',
      observacao: 'Acesso bloqueado automaticamente após 3 tentativas de senha erradas seguidas.',
      criadoPorId: 'u-bloq-teste', criadoPorEmail: authMod.ROBO_BLOQUEIO_EMAIL,
    });
    const aprova = await enviarJson('PATCH', `/api/solicitacoes/${ticketBloq.id}/status`, { status: 'APROVADO' }, cabM);
    // o aviso é disparado sem segurar a resposta da aprovação - dá um
    // instante pra gravação da conversa assentar antes de conferir
    await new Promise((r) => setTimeout(r, 200));
    let aprovaJ = {};
    try { aprovaJ = JSON.parse(aprova.corpo); } catch (e) { aprovaJ = {}; }
    const userBloq = DOCS.get('users/u-bloq-teste') || {};
    const conversaBloq = [...DOCS.entries()]
      .filter(([k]) => k.startsWith('mensagensDiretas/')).map(([, v]) => v)
      .find((c) => (c.participantes || []).includes('u-bloq-teste'));
    const ultimaMsg = conversaBloq && conversaBloq.mensagens && conversaBloq.mensagens[conversaBloq.mensagens.length - 1];
    const okAvisoBloq = aprova.status === 200 && aprovaJ.desbloqueado === true
      && userBloq.locked === false && userBloq.failedAttempts === 0
      && !!ultimaMsg && /Login desbloqueado/.test(ultimaMsg.texto) && /mesma senha de sempre/.test(ultimaMsg.texto)
      && ultimaMsg.deEmail === 'master@teste.local';
    if (!okAvisoBloq) ruins += 1;
    console.log(`${okAvisoBloq ? '✓' : '✗'} desbloqueio: aprovar o ticket avisa a PESSOA com a frase do pop-up (mesma senha de sempre): HTTP ${aprova.status} msg=${ultimaMsg ? ultimaMsg.texto.slice(0, 60) : 'NENHUMA'}`);
  }

  // ---- LINK PUBLICO DE CADASTRO (EXTRA): a foto sobe UMA vez ----
  // O envio estava dando "Failed to fetch" no celular da loja. Nao era erro
  // do servidor: a MESMA foto de 6 MB subia duas vezes (uma pra ler o
  // documento, outra no envio) e o modelo era chamado duas vezes - 13 MB e
  // duas leituras por cadastro. O pedido morria antes de responder, e fetch
  // so rejeita assim quando a conexao cai sem resposta nenhuma.
  // O que este bloco protege: a leitura fica guardada no servidor com um
  // token, e o envio manda so o token. Se alguem desfizer isso, o contador
  // de chamadas ao modelo volta pra 2 e o teste acusa.
  OCR_FALSO.ligado = true;
  OCR_FALSO.chamadas = 0;
  OCR_FALSO.resposta = { nome: 'Maria da Leitura', dataNascimento: '1996-08-12', cpf: null, rg: null, nomeMae: null, tipoDocumento: 'RG', naoLidos: [] };
  const fotoDoc = { nome: 'rg.png', tipo: 'image/png', buffer: pngFalso };

  const leu = await postarMultipart('/api/rh/ler-documento-publico', {}, fotoDoc, 'documento');
  let docToken = null;
  try { docToken = JSON.parse(leu.corpo).docToken; } catch (e) { docToken = null; }
  const okLeu = leu.status === 200 && !!docToken && OCR_FALSO.chamadas === 1;
  if (!okLeu) ruins += 1;
  console.log(`${okLeu ? '✓' : '✗'} link público: "Ler meu documento" devolve token da leitura: HTTP ${leu.status} chamadas=${OCR_FALSO.chamadas} ${leu.corpo.slice(0, 70)}`);

  // envio SEM reenviar a foto - so o token. Tem que gravar a ficha com o
  // nome LIDO (nao com o que a tela mandou) e sem pagar leitura nova.
  const comToken = await postarMultipart('/api/rh/cadastro-publico',
    { unidade: 'Dominos Tirol', tipoCadastro: 'extra', contato: '84999990000', cargoFuncao: 'Atendente',
      nome: 'NOME QUE A TELA MANDOU', docToken },
    { nome: 'cv.pdf', tipo: 'application/pdf', buffer: Buffer.from('%PDF-1.4 teste') }, 'curriculo');
  let corpoToken = {};
  try { corpoToken = JSON.parse(comToken.corpo); } catch (e) { corpoToken = {}; }
  const okComToken = comToken.status === 200 && corpoToken.nome === 'Maria da Leitura' && OCR_FALSO.chamadas === 1;
  if (!okComToken) ruins += 1;
  console.log(`${okComToken ? '✓' : '✗'} link público: envio reaproveita a leitura (1 upload, 1 leitura): HTTP ${comToken.status} chamadas=${OCR_FALSO.chamadas} ${comToken.corpo.slice(0, 80)}`);

  // token gasto/expirado precisa de uma frase que diga o que fazer - o
  // token some depois do cadastro, entao este mesmo ja nao vale mais
  const gasto = await postarMultipart('/api/rh/cadastro-publico',
    { unidade: 'Dominos Tirol', tipoCadastro: 'extra', contato: '84999990000', cargoFuncao: 'Atendente', docToken },
    { nome: 'cv.pdf', tipo: 'application/pdf', buffer: Buffer.from('%PDF-1.4 teste') }, 'curriculo');
  const okGasto = gasto.status === 400 && /expirou/i.test(gasto.corpo) && /Ler meu documento/i.test(gasto.corpo);
  if (!okGasto) ruins += 1;
  console.log(`${okGasto ? '✓' : '✗'} link público: token usado/expirado explica o que fazer: HTTP ${gasto.status} ${gasto.corpo.slice(0, 90)}`);

  // caminho antigo (tela sem token, ou quem nunca clicou em ler) continua
  // valendo: manda a foto no proprio envio e o servidor le na hora
  OCR_FALSO.resposta = { ...OCR_FALSO.resposta, nome: 'Joao Sem Token' };
  const semNada = await postarMultipart('/api/rh/cadastro-publico',
    { unidade: 'Dominos Tirol', tipoCadastro: 'extra', contato: '84999990001', cargoFuncao: 'Atendente' },
    [{ nome: 'cv.pdf', tipo: 'application/pdf', buffer: Buffer.from('%PDF-1.4 teste') }], 'curriculo');
  // (esse primeiro sem documento nenhum tem que ser recusado)
  const okSemNada = semNada.status === 400 && /documento de identidade/i.test(semNada.corpo);
  if (!okSemNada) ruins += 1;
  console.log(`${okSemNada ? '✓' : '✗'} link público sem token E sem foto é recusado: HTTP ${semNada.status} ${semNada.corpo.slice(0, 80)}`);

  const antesDoAntigo = OCR_FALSO.chamadas;
  const caminhoAntigo = await postarMultipart('/api/rh/cadastro-publico',
    { unidade: 'Dominos Tirol', tipoCadastro: 'extra', contato: '84999990001', cargoFuncao: 'Atendente' },
    fotoDoc, 'documento');
  // sem currículo o cadastro para em outra trava, mas a leitura JÁ rodou -
  // é ela que este teste está medindo
  const okAntigo = OCR_FALSO.chamadas === antesDoAntigo + 1;
  if (!okAntigo) ruins += 1;
  console.log(`${okAntigo ? '✓' : '✗'} link público sem token ainda lê a foto do próprio envio: chamadas=${OCR_FALSO.chamadas} (antes ${antesDoAntigo}) HTTP ${caminhoAntigo.status}`);
  // A leitura guardada segura foto de documento em MEMORIA (ate 3 arquivos de
  // 10 MB cada). Um teto so por quantidade seria uma armadilha: "200 leituras"
  // parece inofensivo e vale 6 GB de RAM - derrubaria o processo do mesmo
  // jeito que o upload dobrado derrubava a requisicao. Confere por leitura de
  // fonte porque o teto real so apareceria com dezenas de MB de upload, e o
  // proprio teto por IP da rota (20/h) impede chegar la pelo HTTP.
  const srcGuarda = require('fs').readFileSync(__dirname + '/index.js', 'utf8');
  // ---- VALIDAÇÃO DOS ANEXOS (caso real: "não conseguem anexar, dá erro").
  // O media_type ia CRU pro modelo: foto HEIC do iPhone ou o "image/jpg"
  // fora do padrão de alguns Android viravam erro críptico da API na cara
  // do candidato. Agora: HEIC é recusado ANTES do modelo com frase que diz
  // o que fazer; "image/jpg" é normalizado e passa; arquivo grande demais
  // volta como JSON claro (não um HTML 500); currículo de tipo errado é
  // recusado com explicação. ----
  const antesHeic = OCR_FALSO.chamadas;
  const heic = await postarMultipart('/api/rh/ler-documento-publico', {},
    { nome: 'rg.heic', tipo: 'image/heic', buffer: pngFalso }, 'documento');
  const okHeic = heic.status === 400 && /HEIC/.test(heic.corpo) && /Mais compatível/.test(heic.corpo)
    && OCR_FALSO.chamadas === antesHeic; // recusa ANTES de gastar modelo
  if (!okHeic) ruins += 1;
  console.log(`${okHeic ? '✓' : '✗'} anexos: HEIC do iPhone é recusado ANTES do modelo, com frase que diz o que fazer: HTTP ${heic.status} ${heic.corpo.slice(0, 80)}`);

  const jpgTorto = await postarMultipart('/api/rh/ler-documento-publico', {},
    { nome: 'rg.jpg', tipo: 'image/jpg', buffer: pngFalso }, 'documento');
  const okJpgTorto = jpgTorto.status === 200 && /docToken/.test(jpgTorto.corpo);
  if (!okJpgTorto) ruins += 1;
  console.log(`${okJpgTorto ? '✓' : '✗'} anexos: "image/jpg" fora do padrão é normalizado e a leitura segue: HTTP ${jpgTorto.status}`);

  const gigante = await postarMultipart('/api/rh/ler-documento-publico', {},
    { nome: 'rg.png', tipo: 'image/png', buffer: Buffer.alloc(11 * 1024 * 1024) }, 'documento');
  const okGigante = gigante.status === 400 && /muito grande/i.test(gigante.corpo);
  if (!okGigante) ruins += 1;
  console.log(`${okGigante ? '✓' : '✗'} anexos: arquivo acima do limite volta como JSON claro ("muito grande"), não erro mudo: HTTP ${gigante.status} ${gigante.corpo.slice(0, 70)}`);

  // caminho DIGITAL (o principal, pedido do usuário: "poucos usam documento
  // físico"): PDF do documento é aceito de ponta a ponta
  const docPdf = await postarMultipart('/api/rh/ler-documento-publico', {},
    { nome: 'rg-digital.pdf', tipo: 'application/pdf', buffer: Buffer.from('%PDF-1.4 doc') }, 'documento');
  const okDocPdf = docPdf.status === 200 && /docToken/.test(docPdf.corpo);
  if (!okDocPdf) ruins += 1;
  console.log(`${okDocPdf ? '✓' : '✗'} anexos: PDF do documento (RG/CNH digital) é aceito na leitura: HTTP ${docPdf.status}`);

  const docVazio = await postarMultipart('/api/rh/ler-documento-publico', {},
    { nome: 'rg.pdf', tipo: 'application/pdf', buffer: Buffer.alloc(0) }, 'documento');
  const okDocVazio = docVazio.status === 400 && /veio vazio/i.test(docVazio.corpo) && /iCloud/.test(docVazio.corpo);
  if (!okDocVazio) ruins += 1;
  console.log(`${okDocVazio ? '✓' : '✗'} anexos: arquivo de 0 byte (placeholder do iCloud) é recusado explicando como resolver: HTTP ${docVazio.status} ${docVazio.corpo.slice(0, 80)}`);

  const cvErrado = await postarMultipart('/api/rh/cadastro-publico',
    { unidade: 'Dominos Tirol', tipoCadastro: 'extra', contato: '84999990002', cargoFuncao: 'Atendente' },
    { nome: 'curriculo.exe', tipo: 'application/x-msdownload', buffer: Buffer.from('MZ') }, 'curriculo');
  const okCvErrado = cvErrado.status === 400 && /currículo precisa ser PDF/i.test(cvErrado.corpo);
  if (!okCvErrado) ruins += 1;
  console.log(`${okCvErrado ? '✓' : '✗'} anexos: currículo de tipo errado é recusado com explicação (antes de qualquer upload): HTTP ${cvErrado.status} ${cvErrado.corpo.slice(0, 80)}`);

  const okTeto = /LEITURAS_MAX_BYTES\s*=/.test(srcGuarda)
    && /pesoGuardado\(\) \+ peso > LEITURAS_MAX_BYTES/.test(srcGuarda)
    && /LEITURAS_GUARDADAS\.delete\(LEITURAS_GUARDADAS\.keys\(\)\.next\(\)\.value\)/.test(srcGuarda);
  if (!okTeto) ruins += 1;
  console.log(`${okTeto ? '✓' : '✗'} link público: leitura guardada tem teto de MEMÓRIA (bytes), não só de quantidade`);
  OCR_FALSO.ligado = false;

  // ---- LEITURA HÍBRIDA: PDF digital (gov.br) é lido LOCAL, sem modelo ----
  // Estes testes rodam com o OCR falso DESLIGADO e sem ANTHROPIC_API_KEY no
  // ambiente: se a leitura do PDF digital passasse pelo modelo, daria erro de
  // configuração. Passar aqui PROVA que o caminho local não custa nada.
  const PDFKit = require('pdfkit');
  const gerarPdfTexto = (linhas) => new Promise((resolve) => {
    const doc = new PDFKit();
    const parts = [];
    doc.on('data', (c) => parts.push(c));
    doc.on('end', () => resolve(Buffer.concat(parts)));
    linhas.forEach((l) => doc.text(l));
    doc.end();
  });
  const pdfCnhDigital = await gerarPdfTexto([
    'CARTEIRA NACIONAL DE HABILITACAO', 'NOME', 'MARIA DA EXTRACAO LOCAL',
    'CPF 111.444.777-35', 'DATA NASCIMENTO 12/08/1996',
  ]);
  const leuLocal = await postarMultipart('/api/rh/ler-documento-publico', {},
    { nome: 'cnh-digital.pdf', tipo: 'application/pdf', buffer: pdfCnhDigital }, 'documento');
  let corpoLocal = {};
  try { corpoLocal = JSON.parse(leuLocal.corpo); } catch (e) { corpoLocal = {}; }
  const okLeuLocal = leuLocal.status === 200 && corpoLocal.origemLeitura === 'pdf-local'
    && corpoLocal.nome === 'MARIA DA EXTRACAO LOCAL' && corpoLocal.cpf === '11144477735'
    && corpoLocal.dataNascimento === '1996-08-12' && !!corpoLocal.docToken;
  if (!okLeuLocal) ruins += 1;
  console.log(`${okLeuLocal ? '✓' : '✗'} híbrido: CNH digital (PDF com texto) é lida LOCAL, de graça e sem API key: HTTP ${leuLocal.status} ${leuLocal.corpo.slice(0, 110)}`);

  // PDF SEM camada de texto útil não pode "chutar": cai no modelo - e sem
  // API key no ambiente, isso vira o erro de configuração (comportamento
  // conservador provado: local só assume com nome + CPF/nascimento validados)
  const pdfSemTexto = await postarMultipart('/api/rh/ler-documento-publico', {},
    { nome: 'escaneado.pdf', tipo: 'application/pdf', buffer: Buffer.from('%PDF-1.4 sem camada de texto') }, 'documento');
  const okPdfSemTexto = pdfSemTexto.status === 400 && /não está configurada/i.test(pdfSemTexto.corpo);
  if (!okPdfSemTexto) ruins += 1;
  console.log(`${okPdfSemTexto ? '✓' : '✗'} híbrido: PDF sem texto extraível NÃO é chutado - cai no modelo (aqui, sem key, erro de config): HTTP ${pdfSemTexto.status} ${pdfSemTexto.corpo.slice(0, 80)}`);

  // foto continua exigindo o modelo (comportamento de antes preservado)
  const fotoSemKey = await postarMultipart('/api/rh/ler-documento-publico', {},
    { nome: 'rg.png', tipo: 'image/png', buffer: pngFalso }, 'documento');
  const okFotoSemKey = fotoSemKey.status === 400 && /não está configurada/i.test(fotoSemKey.corpo);
  if (!okFotoSemKey) ruins += 1;
  console.log(`${okFotoSemKey ? '✓' : '✗'} híbrido: foto sem API key ainda dá o mesmo erro de configuração de antes: HTTP ${fotoSemKey.status} ${fotoSemKey.corpo.slice(0, 80)}`);

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

  // ---- FECHAMENTO LANÇADO AVISA (pedido do Master: "quero receber
  // notificação quando os fechamentos forem realizados"). O push em si não
  // sai aqui (a suíte roda sem chave VAPID), mas o MESMO caminho grava o
  // aviso na Central de Alertas - que é justamente o canal que sobra quando
  // o celular estava no bolso. Aproveita o fechamento que acabou de ser
  // lançado logo acima (Dom Carrão, 19/08).
  // O aviso sai FORA da resposta da rota (não segura o lançamento), então
  // dá um instante pra ele assentar antes de conferir.
  await new Promise((r) => setTimeout(r, 250));
  const alertaFech = [...DOCS.entries()]
    .filter(([k]) => k.startsWith('alertasCentral/'))
    .map(([, v]) => v)
    .find((a) => a && a.tipo === 'fechamento');
  const okAvisoFech = !!alertaFech
    && /Fechamento lançado/.test(alertaFech.titulo || '')
    && /Dom Carrão/.test(alertaFech.resumo || '')
    && /19\/08/.test(alertaFech.resumo || '')
    && alertaFech.url === '/fechamentos.html'
    // rotina NUNCA toca sirene - só alerta de urgência é critico
    && alertaFech.critico === false;
  if (!okAvisoFech) ruins += 1;
  console.log(`${okAvisoFech ? '✓' : '✗'} fechamento lançado vira aviso (Central de Alertas + push), sem sirene: ${alertaFech ? String(alertaFech.resumo).slice(0, 95) : 'NENHUM AVISO'}`);

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

  // ---- MEMO do mapa de unidades (varredura de sábado): construirUnidadesMapa
  // refazia o fold sobre TODAS as transações + históricos a cada chamada, em
  // rota quente e em job de minuto - CPU pura repetindo o mesmo resultado.
  // A suíte roda com UNIDADES_MAPA_TTL_MS=0 (memo desligado, ver topo do
  // arquivo), então o comportamento com memo não dá pra exercitar por HTTP
  // aqui - o contrato é conferido na FONTE:
  //  1. produção usa o cache (só o TTL zerado desliga);
  //  2. TODA mutação de unidade (rota direta E executor da aprovação QA)
  //     derruba o cache - sem isso o Master cadastra uma unidade e ela só
  //     aparece na tela dali a um minuto, que foi o bug que o memo podia criar.
  {
    const srcIdx = require('fs').readFileSync(__dirname + '/index.js', 'utf8');
    const wraps = (srcIdx.match(/invalidandoUnidadesMapa\(unidadesExtras\./g) || []).length;
    const okMemoUnidades = /const unidadesMapaCache = liveCacheUtil\.createCache\(construirUnidadesMapaSemCache, UNIDADES_MAPA_TTL_MS\)/.test(srcIdx)
      && /UNIDADES_MAPA_TTL_MS > 0\s*\n?\s*\? \(\) => unidadesMapaCache\.cached\(\)/.test(srcIdx)
      && /unidadesMapaCache\.invalidar\(\);/.test(srcIdx)
      && wraps >= 8; // 4 rotas do Master + 4 executores da aprovação QA
    if (!okMemoUnidades) ruins += 1;
    console.log(`${okMemoUnidades ? '✓' : '✗'} mapa de unidades tem memo em produção e TODA mutação de unidade invalida (${wraps} pontos embrulhados)`);
  }

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

  // ---- Saltiverso: caixa CEGO de verdade - a lista de "vendas de hoje"
  // era o faturado de bandeja (toda venda do dia, com valor e forma, pra
  // qualquer um com a seção; somando os cards o atendente sabia exatamente
  // quanto declarar e a conferência não provava nada). Atendente comum só
  // recebe as PRÓPRIAS vendas; Gerente/Master seguem vendo o dia todo. ----
  let okVendasCegas = false;
  try {
    const bcrypt2 = require('bcryptjs');
    const baseSalti = {
      passwordHash: bcrypt2.hashSync('SenhaDeTeste!2026', 4), role: 'user', active: true,
      permissions: { sections: ['parque-loja'], unidades: ['Saltiverso Patteo'], vaultSubgroups: [], tiposSolicitacao: [] },
      createdAt: new Date().toISOString(),
    };
    DOCS.set('users/u-gerente-salti', { ...baseSalti, email: 'gerente-salti@teste.local', username: 'gerentesalti', cargo: 'gerente' });
    DOCS.set('users/u-atende-salti', { ...baseSalti, email: 'atende-salti@teste.local', username: 'atendesalti', cargo: null });
    const vendaBase = { unidade: 'Saltiverso Patteo', unidadeNome: 'Saltiverso Patteo', data: '2026-08-22', itens: [], total: 50, pagamentos: [{ forma: 'pix', valor: 50 }], cancelada: false, criadoEm: new Date().toISOString() };
    DOCS.set('saltiversoVendas/vs-atende', { ...vendaBase, id: 'vs-atende', criadoPorId: 'u-atende-salti', criadoPorEmail: 'atende-salti@teste.local' });
    DOCS.set('saltiversoVendas/vs-colega', { ...vendaBase, id: 'vs-colega', total: 80, criadoPorId: 'u-outra-pessoa', criadoPorEmail: 'colega@teste.local' });
    // venda do PRÓPRIO atendente com mais de 2h: continua na lista dele, mas
    // SEM valor (total/pagamentos podados) - senão bastava rolar a lista no
    // fim do dia e somar as próprias vendas
    DOCS.set('saltiversoVendas/vs-antiga', { ...vendaBase, id: 'vs-antiga', total: 70, criadoPorId: 'u-atende-salti', criadoPorEmail: 'atende-salti@teste.local', criadoEm: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() });
    const tkGerSalti = (await auth.login('gerente-salti@teste.local', 'SenhaDeTeste!2026')).token;
    const tkAteSalti = (await auth.login('atende-salti@teste.local', 'SenhaDeTeste!2026')).token;
    const rota = '/api/saltiverso/vendas?unidade=Saltiverso%20Patteo&data=2026-08-22';
    const comoGerSalti = await pedir(rota, { Authorization: 'Bearer ' + tkGerSalti });
    const comoAteSalti = await pedir(rota, { Authorization: 'Bearer ' + tkAteSalti });
    const listaGer = JSON.parse(comoGerSalti.corpo);
    const listaAte = JSON.parse(comoAteSalti.corpo);
    const minhaRecente = listaAte.find((v) => v.id === 'vs-atende');
    const minhaAntiga = listaAte.find((v) => v.id === 'vs-antiga');
    const antigaDoGerente = listaGer.find((v) => v.id === 'vs-antiga');
    okVendasCegas = comoGerSalti.status === 200 && comoAteSalti.status === 200
      && listaGer.length === 3 // gerente vê o dia inteiro, com valores (até a antiga)
      && antigaDoGerente && antigaDoGerente.total === 70 && !antigaDoGerente.valorOculto
      && listaAte.length === 2 && !listaAte.some((v) => v.id === 'vs-colega') // atendente só vê as próprias
      && minhaRecente && minhaRecente.total === 50 // recente (menos de 2h): valor visível pra conferir na hora
      && minhaAntiga && minhaAntiga.valorOculto === true && minhaAntiga.total === null // +2h: sem valor
      && !(minhaAntiga.pagamentos || []).some((p) => p.valor !== undefined);
  } catch (e) { okVendasCegas = false; }
  if (!okVendasCegas) ruins += 1;
  console.log(`${okVendasCegas ? '✓' : '✗'} Saltiverso: atendente só vê as PRÓPRIAS vendas do dia (a lista completa entregava o faturado do caixa cego); gerente vê tudo`);

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
  // Foto do relatório de PDV pesa 5-8MB de celular, e até 5 delas por
  // leitura - o que sobe pro servidor (e dali pro Claude) é o gargalo real
  // da demora que o Master reportou ("a leitura esta lenta"), não o modelo
  // em si. Mesmo remédio já usado no documento de identidade do RH
  // (rh-cadastro.html): reduzir ANTES de subir, uma vez só, guardando o
  // arquivo já reduzido em ARQUIVOS_RELATORIO - a leitura em si nem sabe
  // que isso aconteceu.
  let okComprimeFotoRelatorio = false;
  try {
    const html = require('fs').readFileSync(require('path').join(__dirname, 'public', 'lancamento.html'), 'utf8');
    const listener = (html.match(/addEventListener\('change',[\s\S]*?\n\}\);/) || [''])[0];
    const conferencias = {
      'existe a função de comprimir o lote de fotos escolhidas': /async function comprimirVariasRelatorio\(/.test(html),
      'PDF sobe inteiro (comprimir só mexe em imagem)': /function comprimirImagemRelatorio\([\s\S]{0,200}return file;.*PDF sobe inteiro/.test(html),
      'a compressão nunca trava a leitura por conta própria (qualquer erro devolve o arquivo original)': /catch\(e\)\{\s*\n\s*return file; \/\/ qualquer tropeço/.test(html),
      'o listener de change chama a compressão antes de guardar o arquivo': !!listener && /ARQUIVOS_RELATORIO\s*=\s*await comprimirVariasRelatorio\(arquivos\)/.test(listener),
      'o listener continua recusando mais que o teto de fotos (a checagem não sumiu com a mudança)': !!listener && /arquivos\.length > MAX_FOTOS_RELATORIO/.test(listener),
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([n]) => n);
    okComprimeFotoRelatorio = !falhas.length;
    if (falhas.length) console.log('  falhou em: ' + falhas.join(' · '));
  } catch (e) { okComprimeFotoRelatorio = false; console.log('  erro: ' + e.message); }
  if (!okComprimeFotoRelatorio) ruins += 1;
  console.log(`${okComprimeFotoRelatorio ? '✓' : '✗'} Foto do relatório: reduzida no navegador ANTES de subir (upload mais rápido, mesma leitura)`);

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
  // NOC - alarme falso de celular: quem abre o NoPulso no CELULAR com o
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
      // o pulo agora cobre celular E notebook (mesma linha, ver o teste de
      // oscilação adiante) - o que este teste protege é o celular estar nela
      'o push de loja offline/online pula transição de celular': /if \(t\.celular \|\| t\.ehNotebook\) continue;/.test(srcIndex),
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
    // "Ver" (?inline=1) e "Baixar" são a MESMA rota: muda só o
    // Content-Disposition. Conferir os dois porque só o header separa abrir
    // no visualizador de encher a pasta de Downloads.
    const pdfVer = await pedirBinario(`/api/formularios/${f1.id}/pdf?inline=1`, cab);

    // e um formulário que já vem com número (o caso de "virou outra coisa")
    // reaproveita em vez de tirar outro da fila
    const f3 = await form.criar({
      tipo: 'avulso', unidade: 'São Braz Ilha do Leite',
      campos: {}, linhas: [{ descricao: 'Herdado', valor: '10,00' }],
      criadoPorEmail: 'teste@teste.local', numeroTicket: f1.numeroTicket,
    });

    const conferencias = {
      'o formulário nasce com número de ticket': Number.isFinite(f1.numeroTicket),
      'PDF sem inline vem pra BAIXAR': /^attachment/.test(pdf.headers['content-disposition'] || ''),
      'PDF com ?inline=1 vem pra VER no navegador': /^inline/.test(pdfVer.headers['content-disposition'] || ''),
      'e os dois entregam o mesmo documento': pdfVer.status === 200 && pdfVer.buffer.length === pdf.buffer.length,
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
  // Pedido do Master: "no link de preenchimento já aparecer também a opção
  // de assinatura, evitando o envio de 2 links" - quando quem preenche pelo
  // link é a MESMA pessoa que assina (TIPOS.*.preenchedorAssina), a resposta
  // do preenchimento já traz o token do slot dela, pra tela pública seguir
  // direto pro quadro de assinatura. No Reembolso o favorecido preenche E
  // assina (o Responsável continua com o link dele à parte); no Depósito o
  // gerente é preenchedor E o ÚNICO assinante, então assinar já fecha tudo.
  let okPreencherJaAssina = false;
  try {
    const cab = { Authorization: 'Bearer ' + token };
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    // token de verdade não sai por API nenhuma (formularioComLinks troca por
    // link em /api/formularios/:id, e a listagem nem inclui) - só o próprio
    // módulo (getOne) enxerga o valor bruto gravado, é o mesmo recurso que
    // o teste "okRotulos" logo abaixo já usa
    const form = require('/home/user/adyen-monitor/server/formularios.js');

    // --- Reembolso: favorecido preenche e assina, responsavel só assina ---
    const linkReemb = JSON.parse((await postarJson('/api/formularios/link-preenchimento', {
      tipo: 'reembolso', unidade: 'São Braz Ilha do Leite',
    }, cab)).corpo);
    const vistaReemb = JSON.parse((await pedir(`/api/formularios-publico/preencher/${linkReemb.tokenPreenchimento}`)).corpo);
    const envioReemb = await postarJson(`/api/formularios-publico/preencher/${linkReemb.tokenPreenchimento}`, {
      campos: { favorecido: 'Fulano de Tal', cpf: '12345678901', banco: 'Nubank', agencia: '0001', conta: '123456-7', chavePix: 'fulano@x.com' },
      linhas: [{ data: '20/08', fornecedor: 'Posto X', descricao: 'Combustível', valor: '120,50' }],
    });
    const dReemb = envioReemb.status === 200 ? JSON.parse(envioReemb.corpo) : {};
    // token devolvido tem que ser MESMO do slot 'favorecido' que nasceu -
    // confere contra o registro bruto (getOne), não só confia na resposta
    // do próprio preenchimento
    const registroReemb = dReemb.id ? await form.getOne(dReemb.id) : null;
    const tokenFavorecidoReal = registroReemb && registroReemb.assinaturas && registroReemb.assinaturas.favorecido;
    const tokenResponsavelReal = registroReemb && registroReemb.assinaturas && registroReemb.assinaturas.responsavel;
    const assinouFavorecido = await postarJson(`/api/formularios-publico/${dReemb.id}/assinar`, {
      token: dReemb.meuToken, nome: 'Fulano de Tal', imagem: PNG,
    });
    const dAssinouFavorecido = assinouFavorecido.status === 200 ? JSON.parse(assinouFavorecido.corpo) : {};
    // o token do favorecido não pode ser o mesmo do responsavel - senão a
    // mesma pessoa que preencheu conseguiria assinar os dois papéis
    const assinarDeNovoComMesmoToken = await postarJson(`/api/formularios-publico/${dReemb.id}/assinar`, {
      token: dReemb.meuToken, nome: 'Fulano de Novo', imagem: PNG,
    });

    // --- Depósito: gerente preenche E é o ÚNICO assinante -> assinar já fecha tudo ---
    const linkDep = JSON.parse((await postarJson('/api/formularios/link-preenchimento', {
      tipo: 'deposito', unidade: 'Spoleto Tacaruna',
    }, cab)).corpo);
    const vistaDep = JSON.parse((await pedir(`/api/formularios-publico/preencher/${linkDep.tokenPreenchimento}`)).corpo);
    const envioDep = await postarJson(`/api/formularios-publico/preencher/${linkDep.tokenPreenchimento}`, {
      campos: { nomeGerente: 'Marcela' },
      linhas: [{ data: '20/08', periodo: '20/08 a 21/08', envelope: '001', valor: '500,00' }],
    });
    const dDep = envioDep.status === 200 ? JSON.parse(envioDep.corpo) : {};
    const assinouGerente = dDep.meuToken ? await postarJson(`/api/formularios-publico/${dDep.id}/assinar`, {
      token: dDep.meuToken, nome: 'Marcela', imagem: PNG,
    }) : { status: 0, corpo: '' };
    const dAssinouGerente = assinouGerente.status === 200 ? JSON.parse(assinouGerente.corpo) : {};

    // --- Diárias (assinaturaPorLinha) e Ass. Boleto (favorecido preenche
    // mas NÃO assina - só o responsavel) não têm preenchedorAssina de
    // propósito - a resposta do preenchimento não pode inventar um token ---
    const linkDiarias = JSON.parse((await postarJson('/api/formularios/link-preenchimento', {
      tipo: 'diarias', unidade: 'Spoleto Tacaruna',
    }, cab)).corpo);
    const envioDiarias = await postarJson(`/api/formularios-publico/preencher/${linkDiarias.tokenPreenchimento}`, {
      campos: {}, linhas: [{ nome: 'João', datas: '20/08', chavePix: 'joao@x.com', banco: 'Nubank', valor: '100,00' }],
    });
    const dDiarias = envioDiarias.status === 200 ? JSON.parse(envioDiarias.corpo) : {};

    const conferencias = {
      'preencher.html sabe de antemão (via vista) que o favorecido do Reembolso também assina': vistaReemb.preenchedorAssina === 'favorecido',
      'preencher.html sabe que o gerente do Depósito também assina': vistaDep.preenchedorAssina === 'gerente',
      'salvarPreenchimento devolve o token do papel certo (Reembolso)': !!dReemb.meuToken && dReemb.meuPapel === 'favorecido',
      'e é exatamente o token que nasceu pro slot favorecido, não outro qualquer': tokenFavorecidoReal && dReemb.meuToken === tokenFavorecidoReal.token,
      'assinar com esse token direto, sem precisar de um segundo link, funciona': assinouFavorecido.status === 200 && dAssinouFavorecido.chave === 'favorecido',
      'com o Responsável ainda sem assinar, o formulário não fecha sozinho': dAssinouFavorecido.completo === false,
      'o token do favorecido é diferente do token do responsavel (cada papel só assina com o token dele)':
        !!tokenFavorecidoReal && !!tokenResponsavelReal && tokenFavorecidoReal.token !== tokenResponsavelReal.token,
      'usar o token do favorecido de novo não assina duas vezes (a assinatura já estava registrada)':
        assinarDeNovoComMesmoToken.status === 400 && /já foi registrada/.test(assinarDeNovoComMesmoToken.corpo),
      'Depósito: token devolvido é do gerente': dDep.meuPapel === 'gerente' && !!dDep.meuToken,
      'Depósito: como o gerente é o ÚNICO assinante, essa assinatura sozinha já fecha o formulário': assinouGerente.status === 200 && dAssinouGerente.completo === true,
      'Diárias (assinatura por linha) não devolve token nenhum - não é um caso preenchedor=assinante':
        dDiarias.meuToken === undefined && dDiarias.meuPapel === undefined,
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([n]) => n);
    okPreencherJaAssina = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')}`);
  } catch (e) { okPreencherJaAssina = false; console.log('  erro: ' + e.message); }
  if (!okPreencherJaAssina) ruins += 1;
  console.log(`${okPreencherJaAssina ? '✓' : '✗'} Formulários: link de preenchimento já oferece a assinatura pro mesmo papel, sem precisar de um segundo link`);

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

  // ------------------------------------------------------------------
  // Ass. Boleto (pedido do Master): anexa um boleto (PDF ou imagem), abre
  // a caixa de assinatura, e o PDF que sai é O PRÓPRIO ARQUIVO com a
  // assinatura dentro - não um formulário separado falando sobre ele.
  // É esse "dentro" que o teste tem que provar: o PDF de saída precisa
  // conter as PÁGINAS DO ORIGINAL, não uma folha nova.
  let okBoleto = false;
  try {
    const cab = { Authorization: 'Bearer ' + token };
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const { PDFDocument } = require('pdf-lib');

    // um "boleto" de 2 páginas com uma marca reconhecível dentro
    const origem = await PDFDocument.create();
    origem.addPage().drawText('BOLETO ORIGINAL 12345', { x: 50, y: 700, size: 14 });
    origem.addPage().drawText('SEGUNDA VIA DO BOLETO', { x: 50, y: 700, size: 14 });
    const boletoPdf = Buffer.from(await origem.save());

    const payload = (extra = {}) => JSON.stringify({
      tipo: 'assBoleto', unidade: 'Spoleto Tacaruna',
      campos: { favorecido: 'Energisa', descricao: 'Conta de luz', vencimento: '30/08/2026', valor: '1.234,56' },
      ...extra,
    });

    // sem anexo não existe o que assinar - tem que barrar
    const semAnexo = await postarMultipart('/api/formularios', { payload: payload() }, null, 'anexos', cab);
    // o link de "solicitante preenche" também vale pro Ass. Boleto agora
    // (ver o teste dedicado logo abaixo) - aqui só confere que a unidade
    // ainda consegue anexar direto, sem passar pelo link
    const linkPreench = await postarJson('/api/formularios/link-preenchimento', { tipo: 'assBoleto', unidade: 'Spoleto Tacaruna' }, cab);

    const criado = await postarMultipart('/api/formularios', { payload: payload() },
      { nome: 'boleto.pdf', tipo: 'application/pdf', buffer: boletoPdf }, 'anexos', cab);
    const f = criado.status === 200 ? JSON.parse(criado.corpo) : {};
    const tk = (lista, chave) => new URLSearchParams(String((lista.find((a) => a.chave === chave) || {}).link).split('?')[1]).get('t');

    // PDF ANTES de assinar: já sai (pra conferência), com as páginas do original
    const pdfAntes = await pedirBinario(`/api/formularios/${f.id}/pdf`, cab);
    const docAntes = pdfAntes.status === 200 ? await PDFDocument.load(pdfAntes.buffer) : null;

    // "só abrir a caixa de assinatura e realizar": a tela manda pra MESMA
    // rota pública do link, com o token do slot
    const assinou = await postarJson(`/api/formularios-publico/${f.id}/assinar`,
      { token: tk(f.assinaturas, 'responsavel'), nome: 'Thiago Silva', imagem: PNG });
    const dAss = assinou.status === 200 ? JSON.parse(assinou.corpo) : {};

    const pdfDepois = await pedirBinario(`/api/formularios/${f.id}/pdf`, cab);
    const docDepois = pdfDepois.status === 200 ? await PDFDocument.load(pdfDepois.buffer) : null;
    const textoDepois = pdfDepois.status === 200 ? textoDoPdf(pdfDepois.buffer) : '';

    // imagem também vira documento assinável (1 página, a foto dentro)
    const umPixel = Buffer.from(String(PNG).split(',')[1], 'base64');
    const criadoImg = await postarMultipart('/api/formularios', { payload: payload() },
      { nome: 'boleto.png', tipo: 'image/png', buffer: umPixel }, 'anexos', cab);
    const fImg = criadoImg.status === 200 ? JSON.parse(criadoImg.corpo) : {};
    const pdfImg = criadoImg.status === 200 ? await pedirBinario(`/api/formularios/${fImg.id}/pdf`, cab) : { status: 0 };

    const conferencias = {
      'sem anexo o formulário nem é criado': semAnexo.status === 400 && /Anexe o boleto/.test(semAnexo.corpo),
      'link de preenchimento também funciona nesse tipo': linkPreench.status === 200,
      'criar com o boleto anexado funciona e já nasce com Ticket #':
        criado.status === 200 && f.numeroTicket != null && (f.anexos || []).length === 1,
      'não exige linha de tabela (o documento é o anexo)': f.linhas.length === 0 && f.valorTotal === 1234.56,
      'tem UM slot de assinatura, o Responsável':
        f.assinaturas.length === 1 && f.assinaturas[0].chave === 'responsavel',
      'o PDF traz as páginas DO ORIGINAL, não uma folha nova':
        !!docAntes && docAntes.getPageCount() === 2 && !!docDepois && docDepois.getPageCount() === 2,
      'assinar pela própria tela (mesma rota do link) fecha o documento':
        assinou.status === 200 && dAss.completo === true,
      'o PDF assinado identifica unidade, ticket e quem assinou':
        textoDepois.includes('Ticket #') && textoDepois.includes('Thiago Silva')
        && textoDepois.includes('Responsável') && !textoDepois.includes('AGUARDANDO ASSINATURA'),
      'antes de assinar o PDF avisa que está sem assinatura':
        textoDoPdf(pdfAntes.buffer).includes('AGUARDANDO ASSINATURA'),
      'anexo em imagem também vira PDF assinável': pdfImg.status === 200
        && (await PDFDocument.load(pdfImg.buffer)).getPageCount() === 1,
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([n]) => n);
    okBoleto = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')}`);
  } catch (e) { okBoleto = false; console.log('  erro: ' + e.message); }
  if (!okBoleto) ruins += 1;
  console.log(`${okBoleto ? '✓' : '✗'} Ass. Boleto: anexo assinado vira PDF com a assinatura DENTRO do próprio documento`);

  // ------------------------------------------------------------------
  // Pedido do Master: no Ass. Boleto, o link de preenchimento também serve
  // pro FAVORECIDO anexar o boleto e preencher os dados dele - e o
  // Responsável só pode receber o link de ASSINATURA depois que isso
  // acontece (não pode assinar um documento que ainda nem chegou).
  let okBoletoLink = false;
  try {
    const cab = { Authorization: 'Bearer ' + token };
    const { PDFDocument } = require('pdf-lib');
    const form = require('/home/user/adyen-monitor/server/formularios.js');

    const origem = await PDFDocument.create();
    origem.addPage().drawText('BOLETO VIA LINK 999', { x: 50, y: 700, size: 14 });
    const boletoPdf = Buffer.from(await origem.save());
    const camposFavorecido = { favorecido: 'Energisa 2', descricao: 'Conta de água', vencimento: '15/09/2026', valor: '500,00' };

    const gerado = await postarJson('/api/formularios/link-preenchimento', { tipo: 'assBoleto', unidade: 'Spoleto Tacaruna' }, cab);
    const dGerado = gerado.status === 200 ? JSON.parse(gerado.corpo) : {};
    const tokenPreench = dGerado.tokenPreenchimento;

    // a vista pública já avisa que é soAnexo/anexoObrigatorio - é o que a
    // tela usa pra trocar a tabela de Itens pelo campo de arquivo
    const vista = tokenPreench ? await pedir(`/api/formularios-publico/preencher/${tokenPreench}`) : { status: 0 };
    const dVista = vista.status === 200 ? JSON.parse(vista.corpo) : {};

    // ANTES do favorecido mandar o anexo, não existe token de assinatura
    // nenhum - o slot do Responsável só nasce dentro de salvarPreenchimento
    const semTokenAntes = dVista.id ? await pedir(`/api/formularios-publico/${dVista.id}?token=qualquercoisa`) : { status: 0 };

    // mandar sem anexo tem que barrar, igual na criação direta
    const preenchSemAnexo = tokenPreench ? await postarMultipart(`/api/formularios-publico/preencher/${tokenPreench}`,
      { payload: JSON.stringify({ campos: camposFavorecido }) }, null, 'anexos') : { status: 0 };

    const preenchido = tokenPreench ? await postarMultipart(`/api/formularios-publico/preencher/${tokenPreench}`,
      { payload: JSON.stringify({ campos: camposFavorecido }) },
      { nome: 'boleto-link.pdf', tipo: 'application/pdf', buffer: boletoPdf }, 'anexos') : { status: 0 };

    const fDepois = dVista.id ? await form.detalhar(dVista.id) : null;
    const tokenResponsavel = fDepois ? (fDepois.assinaturas.find((a) => a.chave === 'responsavel') || {}).token : null;

    // agora sim - o Responsável assina o boleto que o favorecido mandou
    const assinou = tokenResponsavel ? await postarJson(`/api/formularios-publico/${dVista.id}/assinar`,
      { token: tokenResponsavel, nome: 'Marcela Costa', imagem: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' }) : { status: 0 };

    const conferencias = {
      'gera o link e já com Ticket #': gerado.status === 200 && dGerado.numeroTicket != null,
      'a vista pública avisa que é soAnexo/anexoObrigatorio': dVista.soAnexo === true && dVista.anexoObrigatorio === true,
      'antes do favorecido mandar, nenhum token de assinatura existe ainda': semTokenAntes.status === 404,
      'sem anexo o preenchimento é recusado': preenchSemAnexo.status === 400 && /Anexe o boleto/.test(preenchSemAnexo.corpo),
      'com o boleto anexado, o preenchimento é aceito': preenchido.status === 200,
      'DEPOIS do preenchimento, o slot do Responsável nasce com token': !!tokenResponsavel,
      'o formulário sai de AGUARDANDO e já tem o anexo do favorecido': !!fDepois && fDepois.status === 'PENDENTE' && (fDepois.anexos || []).length === 1,
      'o Responsável consegue assinar o documento que o favorecido mandou': assinou.status === 200,
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([n]) => n);
    okBoletoLink = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')}`);
  } catch (e) { okBoletoLink = false; console.log('  erro: ' + e.message); }
  if (!okBoletoLink) ruins += 1;
  console.log(`${okBoletoLink ? '✓' : '✗'} Ass. Boleto por link: favorecido anexa e preenche, Responsável só assina depois`);

  // ------------------------------------------------------------------
  // Pedido do usuário: "preciso que o master consiga deletar o anexo para
  // que coloquem outro" - print mostrando o Ass. Boleto já com o anexo
  // errado, esperando assinatura. Antes disso a única saída era Cancelar +
  // lançar outro (perde o Ticket #, some da fila de Triagem). Reabrir volta
  // o MESMO link ao estado "aguardando o anexo", com o MESMO Ticket #.
  let okReabrirAnexo = false;
  try {
    const cab = { Authorization: 'Bearer ' + token };
    const form = require('/home/user/adyen-monitor/server/formularios.js');
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    const payload = JSON.stringify({
      tipo: 'assBoleto', unidade: 'Spoleto Tacaruna',
      campos: { favorecido: 'Energisa Reabrir', descricao: 'Conta errada anexada', vencimento: '30/08/2026', valor: '999,00' },
    });
    const criado = await postarMultipart('/api/formularios', { payload },
      { nome: 'boleto-errado.pdf', tipo: 'application/pdf', buffer: Buffer.from('%PDF-1.4 boleto errado') }, 'anexos', cab);
    const f = criado.status === 200 ? JSON.parse(criado.corpo) : {};
    const tk = (lista, chave) => new URLSearchParams(String((lista.find((a) => a.chave === chave) || {}).link).split('?')[1]).get('t');

    // alguém já assinou o documento ERRADO - tem que sumir junto com o anexo
    await postarJson(`/api/formularios-publico/${f.id}/assinar`, { token: tk(f.assinaturas, 'responsavel'), nome: 'Assinou o Errado', imagem: PNG });
    const antesDeReabrir = await form.getOne(f.id);

    // sabotagem de cenário, não de código: tenta reabrir tipo que não é
    // soAnexo - tem que recusar (não faz sentido "reabrir anexo" de um
    // Reembolso, que nem tem anexo obrigatório nesse fluxo)
    const outroTipo = await postarMultipart('/api/formularios', {
      payload: JSON.stringify({
        tipo: 'reembolso', unidade: 'São Braz Ilha do Leite',
        campos: { favorecido: 'Não Anexo', cpf: '000.000.000-00', banco: 'Banco', agencia: '0001', conta: '1-2', chavePix: 'x@x.com' },
        linhas: [{ data: '20/08/2026', fornecedor: 'Fornecedor', descricao: 'Item', valor: '10,00' }],
      }),
    }, null, 'anexos', cab);
    const fOutroTipo = outroTipo.status === 200 ? JSON.parse(outroTipo.corpo) : {};
    const recusaOutroTipo = fOutroTipo.id ? await postarJson(`/api/formularios/${fOutroTipo.id}/reabrir-anexo`, {}, cab) : { status: 0 };

    // reabrir um link que NUNCA foi preenchido (ainda AGUARDANDO) não faz
    // sentido - já está exatamente no estado que reabrir devolveria
    const linkVazio = await postarJson('/api/formularios/link-preenchimento', { tipo: 'assBoleto', unidade: 'Spoleto Tacaruna' }, cab);
    const dLinkVazio = linkVazio.status === 200 ? JSON.parse(linkVazio.corpo) : {};
    const recusaJaAguardando = dLinkVazio.id ? await postarJson(`/api/formularios/${dLinkVazio.id}/reabrir-anexo`, {}, cab) : { status: 0 };

    const r = await postarJson(`/api/formularios/${f.id}/reabrir-anexo`, {}, cab);
    const dReaberto = r.status === 200 ? JSON.parse(r.corpo) : {};
    const depoisDeReabrir = await form.getOne(f.id);

    // este formulário nasceu pelo caminho "unidade anexa direto" (sem link
    // de preenchimento) - por isso não tinha tokenPreenchimento nenhum
    // antes. Reabrir tem que CRIAR um, senão o Master não teria como
    // reenviar pro favorecido depois de apagar o anexo errado. Com o link
    // recém-criado, a tela pública tem que aceitar preenchimento de novo.
    const vistaDeNovo = depoisDeReabrir.tokenPreenchimento
      ? await pedir(`/api/formularios-publico/preencher/${depoisDeReabrir.tokenPreenchimento}`) : { status: 0 };
    const dVistaDeNovo = vistaDeNovo.status === 200 ? JSON.parse(vistaDeNovo.corpo) : {};

    // segundo cenário: um Ass. Boleto que JÁ nasceu por link (favorecido
    // preencheu, já tem tokenPreenchimento de verdade) - reabrir tem que
    // PRESERVAR esse link (é o que já está na mão do favorecido), não
    // trocar por outro
    const linkComAnexo = await postarJson('/api/formularios/link-preenchimento', { tipo: 'assBoleto', unidade: 'Spoleto Tacaruna' }, cab);
    const dLinkComAnexo = linkComAnexo.status === 200 ? JSON.parse(linkComAnexo.corpo) : {};
    const tokenAntesDoPreench = dLinkComAnexo.tokenPreenchimento;
    if (tokenAntesDoPreench) {
      await form.salvarPreenchimento(tokenAntesDoPreench, {
        campos: { favorecido: 'Via link', descricao: 'Boleto via link', vencimento: '10/09/2026', valor: '77,00' },
        anexos: [{ nome: 'boleto-via-link.pdf', path: 'anexos-teste/boleto-via-link.pdf', tipo: 'application/pdf' }],
      });
    }
    const rLink = dLinkComAnexo.id ? await postarJson(`/api/formularios/${dLinkComAnexo.id}/reabrir-anexo`, {}, cab) : { status: 0 };
    const dReabertoLink = rLink.status === 200 ? JSON.parse(rLink.corpo) : {};

    const conferencias = {
      'antes de reabrir: tem 1 anexo e 1 assinatura já colhida (o cenário do bug)':
        (antesDeReabrir.anexos || []).length === 1 && !!antesDeReabrir.assinaturas.responsavel?.imagem,
      'tipo sem soAnexo é recusado (não faz sentido reabrir anexo de quem não tem)':
        recusaOutroTipo.status === 400 && /soAnexo|Ass\. Boleto/.test(recusaOutroTipo.corpo),
      'link que nunca foi preenchido (ainda aguardando) é recusado': recusaJaAguardando.status === 400,
      'reabrir responde 200 e devolve status de volta pra aguardando': r.status === 200 && dReaberto.status === 'AGUARDANDO_PREENCHIMENTO',
      'o anexo errado SOME de verdade no banco': (depoisDeReabrir.anexos || []).length === 0,
      'a assinatura já colhida (no documento errado) também some': Object.keys(depoisDeReabrir.assinaturas || {}).length === 0,
      'o Ticket # é o MESMO de antes (não vira outro formulário)': depoisDeReabrir.numeroTicket === f.numeroTicket,
      'criado direto (sem link antes) - reabrir GERA um link novo pra reenviar': !!depoisDeReabrir.tokenPreenchimento,
      'com o link recém-criado, a tela pública aceita preenchimento (jaPreenchido some)': dVistaDeNovo.jaPreenchido === false,
      'criado por link (já tinha token de verdade) - reabrir PRESERVA o mesmo link':
        rLink.status === 200 && !!tokenAntesDoPreench && dReabertoLink.tokenPreenchimento === tokenAntesDoPreench,
      'a tela (formularios.html) tem o botão "Trocar anexo", só pro soAnexo e só Master': (() => {
        const html = require('fs').readFileSync(require('path').join(__dirname, 'public', 'formularios.html'), 'utf8');
        return /onclick="reabrirAnexo\('\$\{f\.id\}','[^']*'\)"/.test(html)
          && /t && t\.soAnexo \? `<button[^`]*onclick="reabrirAnexo/.test(html)
          && /async function reabrirAnexo\(id, rotulo\)\{[\s\S]{0,400}\/reabrir-anexo/.test(html);
      })(),
      'os campos que o favorecido já tinha digitado continuam lá (só troca o arquivo)': depoisDeReabrir.campos.favorecido === 'Energisa Reabrir',
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([n]) => n);
    okReabrirAnexo = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')}`);
  } catch (e) { okReabrirAnexo = false; console.log('  erro: ' + e.message); }
  if (!okReabrirAnexo) ruins += 1;
  console.log(`${okReabrirAnexo ? '✓' : '✗'} Ass. Boleto: Master reabre o anexo errado (mesmo link, mesmo Ticket #) pra trocarem por outro`);

  // ------------------------------------------------------------------
  // Pedido do usuário: formulário assinado precisa virar um ticket de
  // Pagamento na Central, com os MESMOS anexos - e o formulário já nasce
  // com Ticket # da mesma sequência, então os dois lados compartilham o
  // número (ver enviarCobrancaChamado, mesmo padrão pra chamados de TI).
  let okEnviarPagamento = false;
  try {
    const cab = { Authorization: 'Bearer ' + token };
    const solicitacoesMod = require('/home/user/adyen-monitor/server/solicitacoes.js');
    const form = require('/home/user/adyen-monitor/server/formularios.js');
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    const criado = await postarMultipart('/api/formularios', {
      payload: JSON.stringify({
        tipo: 'reembolso', unidade: 'São Braz Ilha do Leite',
        campos: { favorecido: 'Marina Alves', cpf: '111.222.333-44', banco: 'Nubank', agencia: '0001', conta: '99887-6', chavePix: 'marina@pix.com' },
        linhas: [{ data: '20/08/2026', fornecedor: 'Papelaria Central', descricao: 'Material de escritório', valor: '210,50' }],
      }),
    }, { nome: 'nota-fiscal.pdf', tipo: 'application/pdf', buffer: Buffer.from('%PDF-1.4 comprovante') }, 'anexos', cab);
    const f = criado.status === 200 ? JSON.parse(criado.corpo) : {};
    const tk = (lista, chave) => new URLSearchParams(String((lista.find((a) => a.chave === chave) || {}).link).split('?')[1]).get('t');

    // ainda não assinado - tem que barrar
    const cedoDemais = await postarJson(`/api/formularios/${f.id}/enviar-pagamento`, {}, cab);

    await postarJson(`/api/formularios-publico/${f.id}/assinar`, { token: tk(f.assinaturas, 'favorecido'), nome: 'Marina Alves', imagem: PNG });
    await postarJson(`/api/formularios-publico/${f.id}/assinar`, { token: tk(f.assinaturas, 'responsavel'), nome: 'Gerente São Braz', imagem: PNG });

    const enviado = await postarJson(`/api/formularios/${f.id}/enviar-pagamento`, {}, cab);
    const dEnviado = enviado.status === 200 ? JSON.parse(enviado.corpo) : {};
    const ticketCriado = dEnviado.ticket ? await solicitacoesMod.getOne(dEnviado.ticket.id) : null;
    const fDepois = await form.detalhar(f.id);

    // não pode mandar duas vezes (senão duplicava o ticket na Central) -
    // confere pela CONTAGEM, não só pelo status: a trava tem que impedir
    // ANTES de criar outro ticket, não só devolver erro depois de já ter
    // criado um segundo
    const denovo = await postarJson(`/api/formularios/${f.id}/enviar-pagamento`, {}, cab);
    const ticketsComEsseNumero = (await solicitacoesMod.listAll()).filter((s) => s.numeroTicket === f.numeroTicket && s.tipo === 'pagamento');

    const conferencias = {
      'formulário ainda não assinado é recusado': cedoDemais.status === 400,
      'assinado, o envio funciona e devolve o ticket': enviado.status === 200 && !!dEnviado.ticket,
      'o ticket de Pagamento nasce com o MESMO Ticket # do formulário':
        !!ticketCriado && ticketCriado.numeroTicket === f.numeroTicket && ticketCriado.tipo === 'pagamento',
      'o ticket leva os anexos do formulário (o comprovante)':
        !!ticketCriado && ticketCriado.anexos.length === 1 && ticketCriado.anexos[0].nome === 'nota-fiscal.pdf',
      'o formulário fica marcado como enviado - não dá pra mandar de novo':
        !!fDepois.enviadoPagamento && denovo.status === 400,
      'mandar de novo não cria um SEGUNDO ticket com o mesmo número': ticketsComEsseNumero.length === 1,
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([n]) => n);
    okEnviarPagamento = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')}`);
  } catch (e) { okEnviarPagamento = false; console.log('  erro: ' + e.message); }
  if (!okEnviarPagamento) ruins += 1;
  console.log(`${okEnviarPagamento ? '✓' : '✗'} Formulários: assinado vira ticket de Pagamento com o mesmo Ticket # e os anexos`);

  // ------------------------------------------------------------------
  // O link de preenchimento tem que ABRIR. Parece óbvio demais pra virar
  // teste - e foi exatamente por isso que quebrou: a página lia o token do
  // CAMINHO da URL antes da query, e "/preencher.html" devolvia a string
  // "preencher.html" (truthy), então o ?token= nunca era lido e TODO link
  // gerado caía em "Link inválido". O servidor estava certo o tempo todo.
  // Este teste roda a MESMA função de leitura que está na página.
  let okTokenLink = false;
  try {
    const cab = { Authorization: 'Bearer ' + token };
    const gerado = await postarJson('/api/formularios/link-preenchimento',
      { tipo: 'reembolso', unidade: 'Spoleto Shopping Recife' }, cab);
    const g = gerado.status === 200 ? JSON.parse(gerado.corpo) : {};

    // extrai lerToken() da página e roda contra a URL de verdade
    const fs = require('fs');
    const pagina = fs.readFileSync(require('path').join(__dirname, 'public', 'preencher.html'), 'utf8');
    const trecho = (pagina.match(/function lerToken\(\)\{[\s\S]*?\n\}/) || [])[0];
    let lerToken = null;
    if (trecho) {
      // location falso: é o que a página enxerga com o link real na mão
      const fabricar = new Function('location', `${trecho}; return lerToken;`);
      lerToken = (url) => {
        const u = new URL(url);
        return fabricar({ search: u.search, pathname: u.pathname })();
      };
    }
    const linkReal = `https://adyen-monitor.onrender.com/preencher.html?token=${g.tokenPreenchimento}`;
    const lido = lerToken ? lerToken(linkReal) : null;
    // e o servidor tem que aceitar exatamente o que a página leu
    const abriu = await pedir(`/api/formularios-publico/preencher/${encodeURIComponent(lido || 'vazio')}`);
    const dAbriu = abriu.status === 200 ? JSON.parse(abriu.corpo) : {};
    const tokenErrado = await pedir('/api/formularios-publico/preencher/preencher.html');

    const conferencias = {
      'gerar o link devolve um token': gerado.status === 200 && !!g.tokenPreenchimento,
      'a página lê o token do ?token= (e não a string "preencher.html")':
        lido === g.tokenPreenchimento,
      'o link real abre o formulário no servidor':
        abriu.status === 200 && dAbriu.numeroTicket === g.numeroTicket && dAbriu.jaPreenchido === false,
      'token inventado continua sendo recusado': tokenErrado.status === 404,
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([n]) => n);
    okTokenLink = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')}`);
  } catch (e) { okTokenLink = false; console.log('  erro: ' + e.message); }
  if (!okTokenLink) ruins += 1;
  console.log(`${okTokenLink ? '✓' : '✗'} Link de preenchimento: a URL que vai pro WhatsApp abre de verdade (token lido do ?token=)`);

  // ------------------------------------------------------------------
  // NOC: Ethernet, reinício e janela de manutenção.
  // Pergunta que originou tudo isso: "por que estão ficando OFF se o
  // computador tem REDE?". A resposta é que "offline" só quer dizer
  // "parou de falar" - e três coisas MUITO diferentes caíam no mesmo
  // ponto vermelho. O que este teste tem que provar é a separação delas.
  let okNoc = false;
  try {
    const cab = { Authorization: 'Bearer ' + token };
    const ls = require('/home/user/adyen-monitor/server/lojaStatus.js');
    const UNI = 'NOCTESTE';
    await ls.cadastrarComputador(UNI, 'PDV-NOC', 'interno');
    const postoNoc = (await ls.listar()).find((c) => c.codigo === UNI && c.nome === 'PDV-NOC').posto;
    const tk = await ls.garantirAgentToken(UNI, postoNoc);

    const bater = (extra) => ls.heartbeat(UNI, postoNoc, { userAgent: 'NOCZenith/1.0', ...extra }, tk);
    const doc = async () => (await ls.detalhar(UNI, postoNoc));

    // 1) primeira batida: no cabo, tudo certo
    const BOOT1 = Date.now() - 3 * 3600 * 1000;
    await bater({ bootEm: BOOT1, link: { tipo: 'ethernet', nome: 'Ethernet', mbps: 1000 } });
    const noCabo = await doc();

    // 2) o cabo cai e ela segue viva pelo Wi-Fi: NÃO é queda, é degradação
    await bater({ bootEm: BOOT1, link: { tipo: 'wifi', nome: 'Wi-Fi', mbps: 130, ethernetCaida: true } });
    const noWifi = await doc();
    const alertasLink = await ls.varrerAlertas();
    const alertaLink = alertasLink.find((t) => t.tipo === 'link' && t.codigo === UNI);

    // 3) a máquina reinicia: o LastBootUpTime muda. Isso é detectado mesmo
    //    sem ela ter sumido do painel - é a diferença entre "reiniciou" e
    //    "caiu a rede", que antes não existia.
    await bater({ bootEm: Date.now(), desligamentoInesperado: true, link: { tipo: 'ethernet', nome: 'Ethernet', mbps: 1000 } });
    const depoisDoBoot = await doc();
    const alertasBoot = await ls.varrerAlertas();
    const alertaBoot = alertasBoot.find((t) => t.tipo === 'reiniciou' && t.codigo === UNI);

    // 4) máquina cadastrada que NUNCA bateu: 'sem-agente', não 'indisponível'
    await ls.cadastrarComputador(UNI, 'NUNCA-INSTALOU', 'interno');
    const semAgente = (await ls.listar()).find((c) => c.codigo === UNI && c.nome === 'NUNCA-INSTALOU');

    // 5) janela de manutenção: exige senha, e o comando é fixo no servidor
    const semSenha = await postarJson('/api/loja-status/manutencao/reiniciar',
      { alvos: [{ codigo: UNI, posto: postoNoc }] }, cab);
    const senhaErrada = await postarJson('/api/loja-status/manutencao/reiniciar',
      { alvos: [{ codigo: UNI, posto: postoNoc }], password: 'errada' }, cab);
    const comSenha = await postarJson('/api/loja-status/manutencao/reiniciar',
      { alvos: [{ codigo: UNI, posto: postoNoc }], password: process.env.MASTER_PASSWORD }, cab);
    const dReinicio = comSenha.status === 200 ? JSON.parse(comSenha.corpo) : {};
    // a máquina recebe o comando na batida seguinte
    const entrega = await bater({ bootEm: Date.now(), link: { tipo: 'ethernet' } });

    const conferencias = {
      'no cabo = operacional, e o painel mostra a velocidade':
        noCabo.estado === 'operacional' && noCabo.link.tipo === 'ethernet' && noCabo.link.mbps === 1000,
      'caiu a Ethernet mas segue no ar = DEGRADADO (não offline)':
        noWifi.online === true && noWifi.estado === 'degradado'
        && noWifi.degradacao.includes('Ethernet caída'),
      'a queda de Ethernet vira alerta próprio': !!alertaLink && alertaLink.ethernetCaida === true,
      'reinício é detectado pelo boot, não por ausência de heartbeat':
        !!alertaBoot && alertaBoot.inesperado === true,
      'o reinício fica no registro do computador':
        (depoisDoBoot.eventos || []).some((e) => e.tipo === 'reiniciou' && e.inesperado),
      'a queda de link também fica no registro':
        (depoisDoBoot.eventos || []).some((e) => e.tipo === 'link' && e.ethernetCaida),
      'voltar pro cabo tira a máquina de degradado': depoisDoBoot.estado === 'operacional',
      'máquina que nunca bateu é "sem agente", não "indisponível"':
        semAgente.estado === 'sem-agente' && semAgente.online === false,
      'reiniciar sem senha é recusado': semSenha.status === 400,
      'reiniciar com senha errada é recusado': senhaErrada.status === 400,
      'reiniciar com a senha certa enfileira o comando':
        comSenha.status === 200 && dReinicio.enfileirados === 1 && dReinicio.abortavelPorSegundos === 120,
      'a máquina recebe o comando de reinício na batida seguinte':
        !!entrega.comandoPendente && /shutdown \/r \/t 120/.test(entrega.comandoPendente.comando),
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([n]) => n);
    okNoc = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')}`);
  } catch (e) { okNoc = false; console.log('  erro: ' + e.message); }
  if (!okNoc) ruins += 1;
  console.log(`${okNoc ? '✓' : '✗'} NOC: Ethernet caída vira DEGRADADO, reinício é detectado pelo boot, e o Master reinicia o parque com senha`);

  // ------------------------------------------------------------------
  // Logos das empresas do grupo no rodapé do login. Antes era UMA imagem
  // fixa no código: empresa entrava ou saía do grupo e só dava pra
  // refletir isso com deploy. O que precisa ficar provado: o Master
  // cadastra/remove, e a rota PÚBLICA (lida pela tela de login, antes de
  // existir sessão) nunca devolve o caminho do arquivo no Storage.
  let okLogos = false;
  try {
    const cab = { Authorization: 'Bearer ' + token };
    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

    const semArquivo = await postarMultipart('/api/login-custom/logos', { nome: 'Sem imagem' }, null, 'logo', cab);
    const naoImagem = await postarMultipart('/api/login-custom/logos', { nome: 'PDF' },
      { nome: 'x.pdf', tipo: 'application/pdf', buffer: Buffer.from('%PDF-1.4') }, 'logo', cab);

    const criada = await postarMultipart('/api/login-custom/logos', { nome: 'Grupo Bravo' },
      { nome: 'bravo.png', tipo: 'image/png', buffer: PNG }, 'logo', cab);
    const dCriada = criada.status === 200 ? JSON.parse(criada.corpo) : {};
    const logo = (dCriada.logos || [])[0] || {};

    // a tela de login lê ESTA rota, sem token nenhum
    const publico = await pedir('/api/login-custom');
    const dPublico = publico.status === 200 ? JSON.parse(publico.corpo) : {};
    const imagem = await pedirBinario(`/api/login-custom/logo/${encodeURIComponent(logo.id || 'x')}`);
    const inexistente = await pedir('/api/login-custom/logo/naoexiste');

    const removida = await pedirJsonDelete(`/api/login-custom/logos/${encodeURIComponent(logo.id)}`, cab);
    const dRemovida = removida.status === 200 ? JSON.parse(removida.corpo) : {};
    const removerDeNovo = await pedirJsonDelete(`/api/login-custom/logos/${encodeURIComponent(logo.id)}`, cab);

    const conferencias = {
      'sem arquivo é recusado': semArquivo.status === 400,
      'arquivo que não é imagem é recusado': naoImagem.status === 400,
      'Master cadastra a logo com nome': criada.status === 200 && logo.nome === 'Grupo Bravo' && !!logo.id,
      'a tela de login (sem sessão) enxerga a logo cadastrada':
        publico.status === 200 && (dPublico.logos || []).some((l) => l.id === logo.id),
      'a rota pública NUNCA devolve o caminho do arquivo no Storage':
        !/login-custom\//.test(publico.corpo) && (dPublico.logos || []).every((l) => l.arquivo === undefined)
        && dPublico.fundoArquivo === undefined,
      'a imagem sai pela rota pública': imagem.status === 200 && imagem.buffer.length > 0,
      'id inexistente devolve 404': inexistente.status === 404,
      'Master remove e a lista fica vazia de novo':
        removida.status === 200 && (dRemovida.logos || []).length === 0,
      'remover a mesma logo duas vezes é recusado': removerDeNovo.status === 400,
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([n]) => n);
    okLogos = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')}`);
  } catch (e) { okLogos = false; console.log('  erro: ' + e.message); }
  if (!okLogos) ruins += 1;
  console.log(`${okLogos ? '✓' : '✗'} Login: Master sobe/remove as logos das empresas do rodapé (sem deploy, sem vazar caminho de arquivo)`);

  // ------------------------------------------------------------------
  // A máquina que o NOC mandou reiniciar sai do ar - e o alerta dizia
  // "Loja sem conexão - verifique a internet/computador da loja". Ou seja:
  // afirmava como causa exatamente aquilo que o sistema sabia ser falso, e
  // mandava alguém procurar um problema que não existe. Aqui fica provado
  // que o NOC conta a verdade: reiniciando é reiniciando; e se NÃO voltar
  // na janela, aí sim vira incidente - com a causa provável já conhecida.
  let okReinicioAlerta = false;
  try {
    const cab = { Authorization: 'Bearer ' + token };
    const ls = require('/home/user/adyen-monitor/server/lojaStatus.js');
    const UNI = 'NOCREBOOT';
    await ls.cadastrarComputador(UNI, 'PDV-REBOOT', 'interno');
    const posto = (await ls.listar()).find((c) => c.codigo === UNI && c.nome === 'PDV-REBOOT').posto;
    const tk = await ls.garantirAgentToken(UNI, posto);
    const BOOT = Date.now() - 3600 * 1000;
    await ls.heartbeat(UNI, posto, { userAgent: 'NOCZenith/1.0', bootEm: BOOT }, tk);

    // o Master manda reiniciar
    const mandou = await postarJson('/api/loja-status/manutencao/reiniciar',
      { alvos: [{ codigo: UNI, posto }], password: process.env.MASTER_PASSWORD }, cab);

    // a máquina some do ar (simula o reboot: última batida fica velha)
    const idDoc = `lojaStatus/${UNI}__${posto}`;
    const antes = DOCS.get(idDoc);
    DOCS.set(idDoc, { ...antes, ultimoHeartbeatEm: Date.now() - 5 * 60 * 1000 });
    ls.descartarEspelhoTeste();
    const quedaReinicio = (await ls.varrerAlertas()).find((t) => t.codigo === UNI && t.tipo === 'offline');

    // ela volta: o reinício se encerra
    await ls.heartbeat(UNI, posto, { userAgent: 'NOCZenith/1.0', bootEm: Date.now() }, tk);
    const volta = (await ls.varrerAlertas()).find((t) => t.codigo === UNI && t.tipo === 'online');
    const depoisDeVoltar = await ls.detalhar(UNI, posto);

    // agora um caso em que ela NÃO volta: reinício comandado há muito tempo
    const doc2 = DOCS.get(idDoc);
    DOCS.set(idDoc, {
      ...doc2,
      ultimoHeartbeatEm: Date.now() - 20 * 60 * 1000,
      reinicioComandadoEm: Date.now() - 15 * 60 * 1000,
      reinicioNaoVoltouAvisado: false, avisadoOffline: true,
    });
    ls.descartarEspelhoTeste();
    const naoVoltou = (await ls.varrerAlertas()).find((t) => t.codigo === UNI && t.tipo === 'reinicio-nao-voltou');

    // e uma queda COMUM (sem reinício comandado) continua sendo queda
    const doc3 = DOCS.get(idDoc);
    DOCS.set(idDoc, {
      ...doc3, ultimoHeartbeatEm: Date.now() - 5 * 60 * 1000,
      reinicioComandadoEm: null, avisadoOffline: false,
    });
    ls.descartarEspelhoTeste();
    const quedaComum = (await ls.varrerAlertas()).find((t) => t.codigo === UNI && t.tipo === 'offline');

    const conferencias = {
      'o comando de reinício sai': mandou.status === 200,
      'sumir logo após o reinício NÃO é tratado como queda de internet':
        !!quedaReinicio && quedaReinicio.reiniciando === true,
      'o registro guarda que a saída foi reinício comandado':
        (depoisDeVoltar.eventos || []).some((e) => e.tipo === 'offline' && e.motivo === 'reinicio-comandado'),
      'quando volta, o alerta diz que voltou DO REINÍCIO': !!volta && volta.voltouDeReinicio === true,
      'voltar limpa a marca (queda futura não é mais "reiniciando")':
        !depoisDeVoltar.reinicioComandadoEm,
      'reiniciada e NÃO voltou na janela vira incidente próprio':
        !!naoVoltou && naoVoltou.minutos >= 8,
      'queda comum continua sendo queda comum':
        !!quedaComum && !quedaComum.reiniciando,
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([n]) => n);
    okReinicioAlerta = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')}`);
  } catch (e) { okReinicioAlerta = false; console.log('  erro: ' + e.message); }
  if (!okReinicioAlerta) ruins += 1;
  console.log(`${okReinicioAlerta ? '✓' : '✗'} NOC: máquina que NÓS mandamos reiniciar aparece como "reiniciando", não como "sem conexão"`);

  // ---- NOC: oscilação NÃO é queda (pedido do usuário: "cai e volta em
  // 1-2-3 minutos, será que é queda?"). O painel acusa na hora, mas o push
  // crítico (o sonoro) só sai com a queda CONFIRMADA (silêncio além de
  // CONFIRMACAO_QUEDA_MS, 4min). Notebook marcado no cadastro nunca apita
  // (hiberna fora de hora). ----
  let okOscilacao = false;
  try {
    const ls = require('/home/user/adyen-monitor/server/lojaStatus.js');
    const UNI = 'NOCOSCILA';
    await ls.cadastrarComputador(UNI, 'PDV-OSCILA', 'interno');
    const posto = (await ls.listar()).find((c) => c.codigo === UNI && c.nome === 'PDV-OSCILA').posto;
    const tk = await ls.garantirAgentToken(UNI, posto);
    await ls.heartbeat(UNI, posto, { userAgent: 'NOCZenith/1.0' }, tk);
    const idDoc = `lojaStatus/${UNI}__${posto}`;

    // 1) some por 2min (menos que a confirmação): painel acusa, push ainda não
    DOCS.set(idDoc, { ...DOCS.get(idDoc), ultimoHeartbeatEm: Date.now() - 2 * 60 * 1000, avisadoOffline: false, quedaPushPendente: false });
    ls.descartarEspelhoTeste();
    const caiu = (await ls.varrerAlertas()).find((t) => t.codigo === UNI && t.tipo === 'offline');
    // 2) volta antes de confirmar: transição marcada como quedaCurta (o job
    //    de push pula tanto o "caiu" quanto o "voltou")
    await ls.heartbeat(UNI, posto, { userAgent: 'NOCZenith/1.0' }, tk);
    const voltou = (await ls.varrerAlertas()).find((t) => t.codigo === UNI && t.tipo === 'online');
    // 3) cai de novo e FICA fora: detecta sem apitar, e o tick com o silêncio
    //    já além de 4min emite a confirmação - UMA vez só
    DOCS.set(idDoc, { ...DOCS.get(idDoc), ultimoHeartbeatEm: Date.now() - 2 * 60 * 1000, avisadoOffline: false, quedaPushPendente: false });
    ls.descartarEspelhoTeste();
    const caiu2 = (await ls.varrerAlertas()).find((t) => t.codigo === UNI && t.tipo === 'offline');
    DOCS.set(idDoc, { ...DOCS.get(idDoc), ultimoHeartbeatEm: Date.now() - 5 * 60 * 1000, offlineDesde: Date.now() - 5 * 60 * 1000 });
    ls.descartarEspelhoTeste();
    const confirmou = (await ls.varrerAlertas()).find((t) => t.codigo === UNI && t.tipo === 'offline-confirmada');
    const confirmouDeNovo = (await ls.varrerAlertas()).find((t) => t.codigo === UNI && t.tipo === 'offline-confirmada');
    // 4) notebook: até queda longa carrega a marca, e o job de push pula
    await ls.editarComputador(UNI, posto, 'PDV-OSCILA', 'interno', true);
    DOCS.set(idDoc, { ...DOCS.get(idDoc), ultimoHeartbeatEm: Date.now() - 10 * 60 * 1000, avisadoOffline: false, quedaPushPendente: false });
    ls.descartarEspelhoTeste();
    const notebook = (await ls.varrerAlertas()).find((t) => t.codigo === UNI && t.tipo === 'offline');
    // fiação do job: celular E notebook são pulados antes de qualquer push,
    // e o push de offline só sai com reiniciando/confirmada
    const srcIdx2 = require('fs').readFileSync(__dirname + '/index.js', 'utf8');
    const okFiacao = /if \(t\.celular \|\| t\.ehNotebook\) continue;/.test(srcIdx2)
      && /if \(t\.reiniciando \|\| t\.confirmada\)/.test(srcIdx2)
      && /t\.tipo === 'offline-confirmada'/.test(srcIdx2)
      && /t\.tipo === 'online' && !t\.quedaCurta/.test(srcIdx2);

    const conferencias = {
      'queda curta é detectada mas SEM confirmação (sem push)': !!caiu && caiu.confirmada === false,
      'volta rápida vem marcada como quedaCurta (nem o "voltou" apita)': !!voltou && voltou.quedaCurta === true,
      'segunda queda também começa sem apitar': !!caiu2 && caiu2.confirmada === false,
      'passou de 4min fora: confirmação sai UMA vez': !!confirmou && !confirmouDeNovo,
      'notebook marcado carrega a marca até em queda longa': !!notebook && notebook.ehNotebook === true && notebook.confirmada === true,
      'o job de push pula celular/notebook e só apita queda confirmada': okFiacao,
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([n]) => n);
    okOscilacao = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')}`);
  } catch (e) { okOscilacao = false; console.log('  erro: ' + e.message); }
  if (!okOscilacao) ruins += 1;
  console.log(`${okOscilacao ? '✓' : '✗'} NOC: oscilação de 1-3min não apita (painel registra, push só com queda confirmada; notebook nunca apita)`);

  // ------------------------------------------------------------------
  // Pedido do Master: impressoras (Zebra/Bematech) e VMs do servidor que já
  // aparecem na varredura de rede de cada loja (Varrer-RedeLocal, roda 1x
  // por hora) precisam alarmar quando perdem rede - mas só os equipamentos
  // MARCADOS como monitorados (ver definirApelidoDispositivo), e só depois
  // de ficarem ausentes por tempo real: 1 scan perdido é normal (cache ARP,
  // DHCP renovando), então NÃO pode reusar o debounce de 4min do computador
  // (que roda a cada 25s) - aqui exige ~2 ciclos de scan sem aparecer.
  let okDispositivoAlarme = false;
  try {
    const ls = require('/home/user/adyen-monitor/server/lojaStatus.js');
    const UNI = 'NOCDISP';
    await ls.cadastrarComputador(UNI, 'PDV-DISP', 'interno');
    const posto = (await ls.listar()).find((c) => c.codigo === UNI && c.nome === 'PDV-DISP').posto;
    const idDoc = `lojaStatus/${UNI}__${posto}`;
    const MAC_ZEBRA = 'a4:2b:b0:11:22:44';
    const MAC_NAO_MONITORADO = 'a4:2b:b0:11:22:55';

    // marca a Zebra como monitorada (impressora)
    await ls.definirApelidoDispositivo(UNI, MAC_ZEBRA, { apelido: 'Impressora Zebra Caixa', tipo: 'impressora', monitorar: true });
    // e injeta um apelido no formato LEGADO (string pura, como o doc já
    // gravava antes de tipo/monitorar existirem) direto no Firestore falso -
    // sem passar por definirApelidoDispositivo, pra provar que a leitura
    // antiga continua funcionando sem migração nenhuma
    const apelidosAtuais = DOCS.get('lojaStatusConfig/apelidosRede') || { unidades: {} };
    DOCS.set('lojaStatusConfig/apelidosRede', {
      unidades: { ...apelidosAtuais.unidades, [UNI]: { ...(apelidosAtuais.unidades[UNI] || {}), [MAC_NAO_MONITORADO]: 'Bematech (nome antigo)' } },
    });

    const base = DOCS.get(idDoc);
    DOCS.set(idDoc, {
      ...base,
      dispositivos: [
        { mac: MAC_ZEBRA, ip: '10.161.117.215', nome: 'ZEBRA', desde: Date.now() - 86400000, visto: Date.now() - 70 * 60 * 1000, ativo: false },
        { mac: MAC_NAO_MONITORADO, ip: '10.161.117.201', nome: 'BEMATECH', desde: Date.now() - 86400000, visto: Date.now() - 5 * 3600 * 1000, ativo: false },
      ],
    });
    ls.descartarEspelhoTeste();

    // apelido legado (string) continua lendo certo, e NÃO vira monitorado sozinho
    const dispLegado = (await ls.listar()).find((c) => c.codigo === UNI).dispositivos.find((d) => d.mac === MAC_NAO_MONITORADO);

    // 1 scan perdido (70min < limiar de ~2h): ainda não confirma queda
    const semAlarmeCedo = (await ls.varrerAlertas()).find((t) => t.codigo === UNI && t.tipo === 'dispositivo-offline');

    // passou do limiar (~2h ausente): confirma queda
    const base2 = DOCS.get(idDoc);
    DOCS.set(idDoc, { ...base2, dispositivos: base2.dispositivos.map((d) => (d.mac === MAC_ZEBRA ? { ...d, visto: Date.now() - 130 * 60 * 1000 } : d)) });
    ls.descartarEspelhoTeste();
    const caiu = (await ls.varrerAlertas()).find((t) => t.codigo === UNI && t.tipo === 'dispositivo-offline');
    // segunda passada, sem mudar nada: não duplica o alarme
    const caiuDeNovo = (await ls.varrerAlertas()).find((t) => t.codigo === UNI && t.tipo === 'dispositivo-offline');
    // o Bematech (legado, NÃO monitorado) nunca alarma, mesmo ausente há muito mais tempo
    const naoMonitoradoAlarmou = (await ls.varrerAlertas()).find((t) => t.codigo === UNI && t.mac === MAC_NAO_MONITORADO);

    // volta: gera dispositivo-online e limpa o flag
    const base3 = DOCS.get(idDoc);
    DOCS.set(idDoc, { ...base3, dispositivos: base3.dispositivos.map((d) => (d.mac === MAC_ZEBRA ? { ...d, ativo: true, visto: Date.now() } : d)) });
    ls.descartarEspelhoTeste();
    const voltou = (await ls.varrerAlertas()).find((t) => t.codigo === UNI && t.tipo === 'dispositivo-online');

    // flag REALMENTE resetado: uma queda nova depois de voltar alarma de novo
    const base4 = DOCS.get(idDoc);
    DOCS.set(idDoc, { ...base4, dispositivos: base4.dispositivos.map((d) => (d.mac === MAC_ZEBRA ? { ...d, ativo: false, visto: Date.now() - 130 * 60 * 1000 } : d)) });
    ls.descartarEspelhoTeste();
    const caiuOutraVez = (await ls.varrerAlertas()).find((t) => t.codigo === UNI && t.tipo === 'dispositivo-offline');

    // wiring: index.js despacha pro push.notifyDispositivo* certo, e o push
    // usa o MESMO gate crítico (Master + tag suporte) dos outros alarmes NOC
    const srcIdxDisp = require('fs').readFileSync(__dirname + '/index.js', 'utf8');
    const srcPushDisp = require('fs').readFileSync(__dirname + '/push.js', 'utf8');
    const okWiring = /t\.tipo === 'dispositivo-offline'/.test(srcIdxDisp)
      && /push\.notifyDispositivoOffline\(/.test(srcIdxDisp)
      && /t\.tipo === 'dispositivo-online'/.test(srcIdxDisp)
      && /push\.notifyDispositivoOnline\(/.test(srcIdxDisp);
    const iNotify = srcPushDisp.indexOf('async function notifyDispositivoOffline');
    const okGateCritico = /podeReceberCritico\(sub\)/.test(srcPushDisp.slice(iNotify, iNotify + 900));

    const conferencias = {
      'apelido legado (string) continua lendo certo, sem virar monitorado sozinho':
        !!dispLegado && dispLegado.apelido === 'Bematech (nome antigo)' && dispLegado.tipo === null && dispLegado.monitorar === false,
      '1 scan perdido (70min) ainda não confirma queda': !semAlarmeCedo,
      'passou do limiar (~2h): confirma queda com apelido/tipo certos':
        !!caiu && caiu.apelido === 'Impressora Zebra Caixa' && caiu.tipoDispositivo === 'impressora',
      'confirma UMA vez só (idempotente)': !caiuDeNovo,
      'dispositivo NÃO monitorado nunca alarma, mesmo ausente por muito mais tempo': !naoMonitoradoAlarmou,
      'volta gera dispositivo-online': !!voltou && voltou.apelido === 'Impressora Zebra Caixa',
      'depois de voltar, uma queda NOVA alarma de novo (flag realmente resetado)': !!caiuOutraVez,
      'index.js despacha pro push.notifyDispositivo* certo': okWiring,
      'o push de dispositivo offline usa o mesmo gate crítico dos outros alarmes NOC': okGateCritico,
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([n]) => n);
    okDispositivoAlarme = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')}`);
  } catch (e) { okDispositivoAlarme = false; console.log('  erro: ' + e.message); }
  if (!okDispositivoAlarme) ruins += 1;
  console.log(`${okDispositivoAlarme ? '✓' : '✗'} NOC: impressora/VM marcada como monitorada alarma ao perder rede (só depois de ~2 scans ausentes), nunca pra quem não foi marcado`);

  // ---- NOC: tipos de aparelho abertos (Impressora, VM Host, PULSE, GCOM + "+ Novo") ----
  // Pedido do Master: a lista fechada em 2 tipos não cobria o que ele enxerga
  // na loja. O tipo criado numa unidade tem que valer pra rede toda, e um
  // tipo já gravado num aparelho NUNCA pode sumir por não estar mais na lista.
  let okTiposDispositivo = false;
  try {
    const ls = require('./lojaStatus');
    const UNI = 'DOM_19706';
    const OUTRA = 'DOM_19798';
    const MAC_HOST = 'a4:2b:b0:11:22:66';
    const MAC_ROTEADOR = 'a4:2b:b0:11:22:77';

    const idsBase = (await ls.listarTiposDispositivo()).map((t) => t.id);

    // tipo da lista base (o que o Master nomeia no scanner da loja). Também
    // derruba o cache de 30s dos apelidos, pra injeção logo abaixo valer.
    const comHost = await ls.definirApelidoDispositivo(UNI, MAC_HOST, { apelido: 'VM19798HOST1', tipo: 'vmhost', monitorar: true });

    // aparelho com um tipo que NÃO está em lista nenhuma (o tipo saiu da lista
    // depois de já estar gravado) - injetado direto no Firestore falso, sem
    // passar pela API, que é como isso aconteceria de verdade
    const docApelidos = DOCS.get('lojaStatusConfig/apelidosRede') || { unidades: {} };
    DOCS.set('lojaStatusConfig/apelidosRede', {
      unidades: {
        ...docApelidos.unidades,
        [UNI]: {
          ...(docApelidos.unidades[UNI] || {}),
          [MAC_ROTEADOR]: { apelido: 'Roteador do balcão', tipo: 'roteador-legado', monitorar: false },
        },
      },
      tipos: [],
    });
    const listaSemExtras = await ls.listarTiposDispositivo();
    // editar SÓ o nome não pode apagar o tipo que a lista não conhece mais
    const soRenomeado = await ls.definirApelidoDispositivo(UNI, MAC_ROTEADOR, { apelido: 'Roteador do balcão 2' });

    // "+ Novo tipo" da tela: texto livre vira slug e passa a existir
    const comNovo = await ls.definirApelidoDispositivo(OUTRA, MAC_ROTEADOR, { apelido: 'Roteador da sala', tipoNovo: 'Roteador Wi-Fi' });
    const criado = (await ls.listarTiposDispositivo()).find((t) => t.id === 'roteador-wi-fi');

    // criar o MESMO tipo de novo não pode empilhar cópia atrás de cópia NO
    // DOCUMENTO (a lista de saída dedupla sozinha e esconderia o vazamento -
    // o que cresceria sem parar é o doc gravado, uma linha por vez que
    // alguém escolhesse o tipo já existente)
    await ls.definirApelidoDispositivo(UNI, MAC_HOST, { tipoNovo: 'Roteador Wi-Fi' });
    await ls.definirApelidoDispositivo(OUTRA, MAC_ROTEADOR, { tipoNovo: 'Roteador Wi-Fi' });
    const gravados = (DOCS.get('lojaStatusConfig/apelidosRede') || {}).tipos || [];
    const semDuplicar = gravados.filter((t) => t.id === 'roteador-wi-fi').length;

    const srcPushTipo = require('fs').readFileSync(__dirname + '/push.js', 'utf8');

    const conf = {
      'lista base cobre o que o Master enxerga na loja (impressora/VM Host/PULSE/GCOM)':
        ['impressora', 'vmhost', 'pulse', 'gcom'].every((id) => idsBase.includes(id)),
      "'vm' antigo continua na lista (aparelho já marcado não perde o tipo)": idsBase.includes('vm'),
      'tipo da lista grava normal': comHost.tipo === 'vmhost',
      '"+ Novo tipo" vira slug e fica gravado no aparelho': comNovo.tipo === 'roteador-wi-fi',
      'tipo criado numa unidade passa a existir pra rede toda, com o rótulo digitado':
        !!criado && criado.rotulo === 'Roteador Wi-Fi',
      'escolher de novo um tipo que já existe não empilha cópia no documento': semDuplicar === 1,
      'tipo fora de qualquer lista sobrevive a uma edição de nome':
        !listaSemExtras.some((t) => t.id === 'roteador-legado')
        && soRenomeado.tipo === 'roteador-legado' && soRenomeado.apelido === 'Roteador do balcão 2',
      'o push usa o RÓTULO do tipo no título, não uma lista fechada':
        /const \{ icone, rotulo \} = rotuloTipoDispositivo\(tipoDispositivo, tipoRotulo\)/.test(srcPushTipo)
        && /title: `\$\{icone\} \$\{rotulo\} sem rede`/.test(srcPushTipo),
    };
    const falhas = Object.entries(conf).filter(([, ok]) => !ok).map(([n]) => n);
    okTiposDispositivo = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')}`);
  } catch (e) { okTiposDispositivo = false; console.log('  erro: ' + e.message); }
  if (!okTiposDispositivo) ruins += 1;
  console.log(`${okTiposDispositivo ? '✓' : '✗'} NOC: tipo de aparelho aberto - base (Impressora/VM Host/PULSE/GCOM) + "+ Novo tipo" valendo pra rede toda`);

  // ---- NOC: vigia BLINDADO contra reinício (NOCZenith v17) ----
  // O que derrubou o parque em ago/2026: a tarefa agendada só disparava no
  // LOGIN, então cada máquina reiniciada (lembrete semanal + botão da
  // manutenção) ficava muda até alguém logar. Este bloco protege as peças
  // da correção no script gerado - se alguém remover a tarefa de boot, o
  // limite de execução ou a cedência entre instâncias, acusa aqui.
  {
    const vg = require('./vigiaScript.js');
    const sInt = vg.montarScriptVigia({ codigo: 'DomCG', posto: 'GER', tipo: 'interno', agentToken: 'ab12' });
    const sAt = vg.montarScriptVigia({ codigo: 'DomCG', posto: 'CX1', tipo: 'atendimento', agentToken: 'ab12' });
    const htmlNoc = require('fs').readFileSync(__dirname + '/public/loja-status.html', 'utf8');
    const confVigia = {
      'instala tarefa de BOOT (SYSTEM, -AtStartup) quando roda como Admin':
        sInt.includes('-AtStartup') && sInt.includes('New-ScheduledTaskPrincipal -UserId "SYSTEM"') && sInt.includes('-Loop -Servico'),
      'sem o limite de 72h do Windows que matava a tarefa em silêncio':
        sInt.includes('-ExecutionTimeLimit (New-TimeSpan -Seconds 0)') && sInt.includes('MultipleInstances IgnoreNew'),
      'instância de boot cede a vez pra de login (sem heartbeat/comando dobrado)':
        sInt.includes('Marcar-UiAtiva') && sInt.includes('UiEstaAtiva') && sInt.includes('$EmEsperaServico'),
      'auto-update repassa o -Servico (a de boot renasce como boot)':
        sInt.includes('if ($Servico) { $argsNovo += " -Servico" }'),
      'boot (SYSTEM) não abre janela de chat nem navegador':
        sInt.includes('if (-not $Servico) { try { Iniciar-JanelaChat }') && sAt.includes('if (-not $Servico) {'),
      'blindagem vale também pro tipo atendimento':
        sAt.includes('-AtStartup') && sAt.includes('UiEstaAtiva'),
      'versão bumpada (sem bump, nenhum agente vivo atualiza)':
        vg.VERSAO_VIGIA >= 17,
      'modal de reinício avisa que máquina sem Admin precisa de login':
        /como Administrador/.test(htmlNoc) && /alguém fizer login no Windows/.test(htmlNoc),
      'typo "calada há há" corrigido no card':
        !htmlNoc.includes('calada há ${'),
    };
    const errosVigia = Object.entries(confVigia).filter(([, ok]) => !ok).map(([k]) => k);
    if (errosVigia.length) ruins += 1;
    console.log(`${errosVigia.length ? '✗' : '✓'} NOC: NOCZenith blindado contra reinício (tarefa de boot SYSTEM + cedência + sem limite de 72h)${errosVigia.length ? ' - FALHOU: ' + errosVigia.join(' | ') : ''}`);
  }

  // ---- CENTRAL DE ALERTAS: threads por máquina (como as fraudes do Monitor) ----
  // O NOC repetia o par "sem conexão"/"reconectou" a cada oscilação da mesma
  // máquina e a Central virava um paredão de cards iguais. A página agrupa em
  // threads: mesmo tipo + mesma máquina, o mais novo à mostra e os anteriores
  // recolhidos. A lógica é pura (marcada com [THREAD-PURO-*] no HTML) - este
  // teste extrai o trecho e roda o agrupamento de verdade, com o mesmo
  // formato de resumo que o push.js grava.
  {
    const htmlCa = require('fs').readFileSync(__dirname + '/public/central-alertas.html', 'utf8');
    // o marcador de início fica no meio de um comentário - corta a partir da
    // linha SEGUINTE a ele, senão o resto da frase entra como código solto
    const m = /\[THREAD-PURO-INICIO\][^\n]*\n([\s\S]*?)\/\/ \[THREAD-PURO-FIM\]/.exec(htmlCa);
    let okThreads = false;
    let detalheThreads = 'trecho [THREAD-PURO] não encontrado na página';
    if (m) {
      try {
        const mod = new Function(m[1] + '\nreturn { chaveThread, agruparEmThreads };')();
        const alerta = (id, tipo, resumo, criadoEm) => ({ id, tipo, resumo, criadoEm, atendidoEm: null });
        // ordem decrescente de criadoEm, como a API devolve
        const itens = [
          alerta('a6', 'noc-online', 'AEROCar-ATM01 · Dom Car Aero Recife voltou a responder.', '2026-08-22T16:10:00Z'),
          alerta('a5', 'noc-offline', 'AEROCar-ATM01 · Dom Car Aero Recife parou de responder - verifique.', '2026-08-22T16:05:00Z'),
          alerta('a4', 'noc-online', 'AEROCar-ATM01 · Dom Car Aero Recife voltou a responder.', '2026-08-22T15:49:00Z'),
          alerta('a3', 'noc-offline', 'AEROCar-ATM01 · Dom Car Aero Recife parou de responder - verifique.', '2026-08-22T15:47:00Z'),
          alerta('a2', 'noc-offline', 'DomCG-DISP · Dom Campina Grande parou de responder - verifique.', '2026-08-22T15:40:00Z'),
          alerta('a1', 'rh-cadastro-pendente', 'Fulano · Dom Bessa aguardando aprovação.', '2026-08-22T15:30:00Z'),
        ];
        const ent = mod.agruparEmThreads(itens);
        okThreads = ent.length === 4 // 6 cards viram 4 entradas
          // thread de "reconectou" da ATM01: o das 16:10 na frente, o das 15:49 recolhido
          && ent[0].principal.id === 'a6' && ent[0].antigos.length === 1 && ent[0].antigos[0].id === 'a4'
          // thread de "sem conexão" da ATM01: 16:05 na frente, 15:47 recolhido
          && ent[1].principal.id === 'a5' && ent[1].antigos.length === 1 && ent[1].antigos[0].id === 'a3'
          // máquina DIFERENTE não entra no thread da ATM01
          && ent[2].principal.id === 'a2' && ent[2].antigos.length === 0
          // tipo que não é NOC segue solto, sem chave de thread
          && ent[3].principal.id === 'a1' && ent[3].chave === null
          // e a ordem da lista continua a cronológica dos mais novos
          && ent.map((e) => e.principal.id).join(',') === 'a6,a5,a2,a1';
        detalheThreads = ent.map((e) => `${e.principal.id}+${e.antigos.length}`).join(' ');
      } catch (e) { detalheThreads = e.message; }
    }
    if (!okThreads) ruins += 1;
    console.log(`${okThreads ? '✓' : '✗'} Central de Alertas: oscilações da mesma máquina viram THREAD (mais novo à mostra, anteriores recolhidos): ${detalheThreads}`);
  }

  // ---- KPI's operacionais: exportar a matriz + ranking de ofensores ----
  // O que importa provar aqui: (1) o CSV/PDF sai com EXATAMENTE a matriz que
  // a tela mandou (a conta e feita no navegador de proposito - ver o
  // comentario em postarBinario), (2) periodo vazio nao gera arquivo mudo, e
  // (3) a "direcao" do KPI (ruim quando sobe / ruim quando cai), que e o que
  // da sentido a palavra "ofensivo", sobrevive ao cadastro em Grupos.
  let okKpiRelatorio = false;
  try {
    const cab = { Authorization: 'Bearer ' + token };
    const grupoCriado = await postarJson('/api/grupos', {
      nome: 'Grupo KPI Teste',
      unidades: ['AERO'],
      kpisExtras: [
        { label: 'Tempo de entrega', tipo: 'tempo', direcao: 'menor-melhor' },
        { label: 'Nota do cliente', tipo: 'quantidade', direcao: 'maior-melhor' },
        // direcao inexistente tem que cair pra 'neutro', nunca ser gravada crua
        { label: 'Inventado', tipo: 'quantidade', direcao: 'ruim-quando-chove' },
        // sem direcao nenhuma: o campo nem deve aparecer no registro
        { label: 'Sem direcao', tipo: 'quantidade' },
      ],
    }, cab);
    const g = grupoCriado.status === 200 ? JSON.parse(grupoCriado.corpo) : { kpisExtras: [] };
    const porLabel = {};
    (g.kpisExtras || []).forEach((k) => { porLabel[k.label] = k; });

    // a matriz que a tela manda: 2 lojas, 2 KPI's, um valor faltando
    const matriz = {
      grupo: 'Grupo KPI Teste',
      inicio: '2026-08-01', fim: '2026-08-20', lancamentos: 12,
      lojas: ['Dom Aeroporto', 'Dom Tirol'],
      linhas: [
        { kpi: 'Tempo de entrega', agregacao: 'média', valores: ['42:00', '31:00'], total: '36:30' },
        // celula vazia tem que virar tracinho, nao "undefined" nem sumir - e
        // total ausente (tela antiga, ou antes do deploy) tambem cai pro
        // mesmo tracinho, nunca "undefined"
        { kpi: 'Nota do cliente', agregacao: 'média', valores: ['4,1', ''] },
        // KPI com nome que o Excel executaria como formula
        { kpi: '=SOMA(A1:A9)', agregacao: 'soma', valores: ['10', '20'], total: '30' },
      ],
      ofensores: [
        { kpi: 'Tempo de entrega', loja: 'Dom Aeroporto', texto: '+35% vs mediana' },
      ],
    };
    const csv = await postarJson('/api/kpis-operacionais/relatorio?formato=csv', matriz, cab);
    const linhasCsv = csv.corpo.replace(/^﻿/, '').split('\r\n');
    const pdf = await postarBinario('/api/kpis-operacionais/relatorio', matriz, cab);
    const textoPdf = pdf.status === 200 ? textoDoPdf(pdf.buffer) : '';
    const vazio = await postarJson('/api/kpis-operacionais/relatorio?formato=csv',
      { ...matriz, linhas: [] }, cab);

    const conferencias = {
      'KPI ruim-quando-sobe e ruim-quando-cai ficam gravados como cadastrados':
        porLabel['Tempo de entrega']?.direcao === 'menor-melhor'
        && porLabel['Nota do cliente']?.direcao === 'maior-melhor',
      'direcao inventada vira "neutro" em vez de entrar crua':
        porLabel['Inventado']?.direcao === 'neutro',
      'KPI sem direcao nao ganha o campo do nada':
        porLabel['Sem direcao'] && porLabel['Sem direcao'].direcao === undefined,
      'CSV sai com uma coluna por loja, na ordem da tela, e Total no fim':
        linhasCsv[0] === 'KPI,Agreg.,Dom Aeroporto,Dom Tirol,Total',
      'CSV leva os valores exatamente como a tela calculou, incluindo o Total':
        linhasCsv[1] === 'Tempo de entrega,média,42:00,31:00,36:30',
      'loja sem valor no periodo sai como tracinho, nao vazia - e Total ausente tambem':
        linhasCsv[2] === 'Nota do cliente,média,"4,1",—,—',
      'nome de KPI que parece formula nao e executado pelo Excel':
        linhasCsv[3].startsWith("'=SOMA"),
      'PDF responde de verdade': pdf.status === 200,
      'PDF imprime a matriz': /Tempo de entrega/.test(textoPdf) && /DOM TIROL/.test(textoPdf),
      'PDF abre com o ofensor em destaque, antes da tabela':
        /35% vs mediana/.test(textoPdf) && textoPdf.indexOf('35% vs mediana') < textoPdf.indexOf('Nota do cliente'),
      'periodo sem KPI nenhum recusa em vez de gerar arquivo vazio':
        vazio.status === 400 && /Nada pra exportar/.test(vazio.corpo),
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([n]) => n);
    okKpiRelatorio = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')}`);
  } catch (e) { okKpiRelatorio = false; console.log('  erro: ' + e.message); }
  if (!okKpiRelatorio) ruins += 1;
  console.log(`${okKpiRelatorio ? '✓' : '✗'} KPI's operacionais: matriz da tela vira CSV/PDF e o PDF abre pelos indicadores mais ofensivos`);

  // ------------------------------------------------------------------
  // KPI's operacionais: coluna Total no Comparativo por loja - pedido do
  // Master ("quero o total pra ter visão rápida de como foi em todas as
  // unidades"). A tela recalcula sobre TODOS os lançamentos das lojas
  // juntos (não soma as células já arredondadas), pra não dar número
  // errado nos KPI's agregados por média (Tempo/OTD/Taxa) - ver
  // totalLinha() em kpis-operacionais.html.
  let okKpiTotal = false;
  try {
    const html = require('fs').readFileSync(require('path').join(__dirname, 'public', 'kpis-operacionais.html'), 'utf8');
    const conf = {
      'existe uma função só pra calcular o Total, usada na tela E no export (não duas contas separadas)':
        /function totalLinha\(porLoja, lojas, modo\)\{/.test(html)
        && (html.match(/totalLinha\(porLoja, lojas, modo\)/g) || []).length >= 3, // a definição + os 2 usos
      'a função recombina TODOS os lançamentos das lojas antes de agregar (não soma médias já arredondadas)':
        /const todos = lojas\.flatMap\(u => porLoja\[u\]\);\s*\n\s*return fmtValor\(agregar\(todos, modo\), modo\);/.test(html),
      'o cabeçalho da matriz ganha a coluna Total, no fim': /<th class="total-col">Total<\/th>/.test(html),
      'a tela usa totalLinha pra preencher a célula da linha': /const txtTotal = totalLinha\(porLoja, lojas, modo\);/.test(html),
      'o export (CSV/PDF) manda o total calculado pela MESMA função, não recalcula na mão':
        /total: totalLinha\(porLoja, lojas, modo\) \?\? ''/.test(html),
    };
    const falhas = Object.entries(conf).filter(([, ok]) => !ok).map(([n]) => n);
    okKpiTotal = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')}`);
  } catch (e) { okKpiTotal = false; console.log('  erro: ' + e.message); }
  if (!okKpiTotal) ruins += 1;
  console.log(`${okKpiTotal ? '✓' : '✗'} KPI's operacionais: coluna Total no Comparativo por loja, recalculada sobre os lançamentos (não soma célula arredondada)`);

  // ---- RH: foto+localização obrigatórias e cobrança do check-out ----
  // Duas regras juntas porque valem pro MESMO registro de ponto, seja extra
  // ou candidato em teste: (1) nem entrada nem saída passam sem foto E
  // localização, (2) passou de LIMITE_CHECKOUT_HORAS em aberto, o sistema
  // começa a cobrar - e volta a cobrar de tempos em tempos, não uma vez só.
  let okPontoRh = false;
  try {
    const rhc = require('/home/user/adyen-monitor/server/rhCheckin.js');
    const rhMod = require('/home/user/adyen-monitor/server/rh.js');
    const PNG_MIN = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const fotoFake = { path: 'rh-checkins/x.png', tipo: 'image/png' };
    const localFake = { lat: -7.2, lng: -35.9, precisao: 12 };

    // duas pessoas: um extra e um candidato em teste
    const pessoas = {};
    for (const [chave, tipo, status] of [['extra', 'extra', 'ativo'], ['candidato', 'candidato', 'candidato']]) {
      const id = 'f-' + chave;
      DOCS.set('rhFuncionarios/' + id, {
        id, nome: 'Pessoa ' + chave, unidade: 'DomCG', tipoCadastro: tipo, status,
        dataAdmissao: '2026-08-20', criadoEm: '2026-08-20T10:00:00Z', linkToken: 'tok-' + chave,
        feedbackTeste: null,
      });
      pessoas[chave] = id;
    }
    rhMod.invalidar && rhMod.invalidar();
    rhc.invalidar();

    // (1) entrada e saída exigem foto E localização - pros DOIS tipos
    const recusas = {};
    for (const chave of ['extra', 'candidato']) {
      const semFoto = await rhc.registrarEntrada({ funcionarioId: pessoas[chave], foto: null, localizacao: localFake })
        .then(() => null).catch((e) => e.message);
      const semLocal = await rhc.registrarEntrada({ funcionarioId: pessoas[chave], foto: fotoFake, localizacao: null })
        .then(() => null).catch((e) => e.message);
      recusas[chave] = { semFoto, semLocal };
    }

    // entrada válida do extra, pra ter um check-in aberto pra fechar
    const entrada = await rhc.registrarEntrada({ funcionarioId: pessoas.extra, foto: fotoFake, localizacao: localFake });
    const saidaSemFoto = await rhc.registrarSaida(entrada.id, { foto: null, localizacao: localFake })
      .then(() => null).catch((e) => e.message);
    const saidaSemLocal = await rhc.registrarSaida(entrada.id, { foto: fotoFake, localizacao: null })
      .then(() => null).catch((e) => e.message);

    // (2) cobrança do check-out: envelhece a entrada pra pouco antes e pouco
    // depois do limite, e confere que só o segundo caso é cobrado.
    // As horas abaixo são LITERAIS de propósito (8,5h e 9,2h): se viessem de
    // rhc.LIMITE_CHECKOUT_HORAS, mudar a constante moveria a régua junto e o
    // teste passaria com qualquer limite - inclusive um errado.
    const chave = 'rhCheckins/' + entrada.id;
    const envelhecer = (horas) => {
      const d = DOCS.get(chave);
      DOCS.set(chave, { ...d, entrada: { ...d.entrada, horario: new Date(Date.now() - horas * 3600000).toISOString() } });
      rhc.invalidar();
    };

    envelhecer(8.5);
    const antesDoLimite = await rhc.verificarCheckoutsAtrasados();
    envelhecer(9.2);
    const noLimite = await rhc.verificarCheckoutsAtrasados();
    // primeiro aviso: pode furar o silêncio noturno
    const primeiro = noLimite.find((c) => c.id === entrada.id);
    await rhc.marcarAlertaCheckout(entrada.id);
    rhc.invalidar();
    // logo depois de avisar, não repete
    const logoDepois = await rhc.verificarCheckoutsAtrasados();
    // mas volta a cobrar quando passa o intervalo de repetição
    const d2 = DOCS.get(chave);
    DOCS.set(chave, { ...d2, alertaCheckoutEm: new Date(Date.now() - 3 * 3600000).toISOString() });
    rhc.invalidar();
    const repetiu = await rhc.verificarCheckoutsAtrasados();

    // fechar o ponto tira a pessoa da cobrança - é o que o alerta pede
    await rhc.registrarSaida(entrada.id, { foto: fotoFake, localizacao: localFake });
    rhc.invalidar();
    const depoisDeFechar = await rhc.verificarCheckoutsAtrasados();

    const conferencias = {
      'o limite de jornada é o combinado (9h)': rhc.LIMITE_CHECKOUT_HORAS === 9,
      'extra não entra sem foto': /foto/i.test(recusas.extra.semFoto || ''),
      'extra não entra sem localização': /localiza/i.test(recusas.extra.semLocal || ''),
      'candidato em teste não entra sem foto': /foto/i.test(recusas.candidato.semFoto || ''),
      'candidato em teste não entra sem localização': /localiza/i.test(recusas.candidato.semLocal || ''),
      'check-out também exige foto': /foto/i.test(saidaSemFoto || ''),
      'check-out também exige localização': /localiza/i.test(saidaSemLocal || ''),
      'antes do limite ninguém é cobrado': !antesDoLimite.some((c) => c.id === entrada.id),
      'com 9,2h em aberto, vira cobrança': !!primeiro,
      'a cobrança informa há quantas horas está aberto': !!primeiro && primeiro.horasEmAberto >= 9,
      'o primeiro aviso é marcado como primeiro (pode tocar de madrugada)': !!primeiro && primeiro.primeiroAviso === true,
      'logo após avisar, não repete o alerta': !logoDepois.some((c) => c.id === entrada.id),
      'passado o intervalo, volta a cobrar': repetiu.some((c) => c.id === entrada.id),
      'e a repetição NÃO é primeiro aviso (respeita a madrugada)':
        (repetiu.find((c) => c.id === entrada.id) || {}).primeiroAviso === false,
      'bater o check-out encerra a cobrança': !depoisDeFechar.some((c) => c.id === entrada.id),
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([n]) => n);
    okPontoRh = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')}`);
  } catch (e) { okPontoRh = false; console.log('  erro: ' + e.message); }
  if (!okPontoRh) ruins += 1;
  console.log(`${okPontoRh ? '✓' : '✗'} RH: ponto sem foto/localização é recusado (extra e teste) e ponto aberto demais vira cobrança de check-out`);

  // ---- Parque: correção que não corrige nada é recusada na origem ----
  // Caso real: a pessoa escreveu "Trocar o tempo de 30 minutos Para 1 hora"
  // na JUSTIFICATIVA e não mexeu no seletor de Tempo. A proposta foi enviada
  // com tempo → 30min (igual ao cadastrado), alguém aprovou de boa fé, e o
  // sistema aplicou fielmente o mesmo valor de antes - parecendo que aprovar
  // não funcionava. O motor sempre funcionou; o que faltava era recusar a
  // proposta vazia ANTES de virar pedido.
  let okCorrecaoParque = false;
  try {
    const pq = require('/home/user/adyen-monitor/server/parque.js');
    const base = {
      id: 'pc1', unidade: 'SALT', unidadeNome: 'Saltiverso Patteo',
      responsavel: { nome: 'Aline Bezerra', contato: '8199431-0362' },
      dataUtilizacao: '2026-08-21', tempoMinutos: 30, metodoPagamento: 'Dinheiro',
      criancas: [{ nome: 'Arthur Xavier', meia: true }], adultoCortesia: false, quantAC: 0,
      iniciado: true, timeInicial: '13:05', timeFinal: '13:35', minutosExtras: 0, minutosAdicionados: 0,
    };
    DOCS.set('parqueCheckins/pc1', base);

    // (1) proposta idêntica (o que realmente aconteceu) não vira pedido
    const igual = await pq.solicitarEdicao({
      checkinId: 'pc1', tipoCorrecao: 'alterar', motivo: 'Trocar o tempo de 30 minutos Para 1 hora',
      proposta: { responsavel: { nome: 'Aline Bezerra', contato: '8199431-0362' }, dataUtilizacao: '2026-08-21', tempoMinutos: 30 },
      solicitadoPorEmail: 'op@teste.local',
    }).then(() => null).catch((e) => e.message);

    // (2) proposta com a mudança de verdade passa e, aprovada, muda tempo/horário/valor
    const valorAntes = pq.valorDoCheckin(DOCS.get('parqueCheckins/pc1'));
    const pedido = await pq.solicitarEdicao({
      checkinId: 'pc1', tipoCorrecao: 'alterar', motivo: 'Trocar o tempo de 30 minutos Para 1 hora',
      proposta: { tempoMinutos: 60 }, solicitadoPorEmail: 'op@teste.local',
    });
    await pq.decidirEdicao(pedido.id, 'APROVADO', { decididoPorEmail: 'gerente@teste.local' });
    const depois = DOCS.get('parqueCheckins/pc1');
    const valorDepois = pq.valorDoCheckin(depois);

    // (3) o comparador enxerga mudança em outros campos, não só no tempo
    const soNome = pq.propostaMudaAlgo({ responsavel: { nome: 'Aline B. Xavier' } }, base);
    const soCrianca = pq.propostaMudaAlgo({ criancas: [{ nome: 'Arthur Xavier', meia: false }] }, base);
    const mesmaCriancaOrdemTrocada = pq.propostaMudaAlgo(
      { criancas: [{ nome: 'Arthur Xavier', meia: true }] }, base,
    );

    const conferencias = {
      'proposta igual ao cadastrado é recusada': /nenhum campo foi alterado/i.test(igual || ''),
      'e o erro diz que justificativa não altera o check-in': /justificativa/i.test(igual || ''),
      'proposta com mudança de verdade é aceita': !!pedido && pedido.status === 'PENDENTE',
      'aprovar troca o tempo': Number(depois.tempoMinutos) === 60,
      'aprovar recalcula o horário de saída': String(depois.timeFinal).startsWith('14:05'),
      'aprovar muda o valor': valorDepois > valorAntes,
      'mudar só o nome conta como mudança': soNome === true,
      'mudar só a meia de uma criança conta como mudança': soCrianca === true,
      'criança idêntica NÃO conta como mudança': mesmaCriancaOrdemTrocada === false,
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([n]) => n);
    okCorrecaoParque = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')}`);
  } catch (e) { okCorrecaoParque = false; console.log('  erro: ' + e.message); }
  if (!okCorrecaoParque) ruins += 1;
  console.log(`${okCorrecaoParque ? '✓' : '✗'} Parque: correção sem mudança nenhuma é recusada (e a que muda de verdade altera tempo, horário e valor)`);

  // ---- Toast de solicitação: arrastar pro lado fecha SEM marcar como vista ----
  // O pedido era "arrastar pra sair, porém sem marcar como visualizado".
  // Duas coisas podem quebrar isso sem ninguém perceber: (1) o gesto em si
  // (limiar, direção, o `pointercancel` que o Chromium dispara quando o
  // arrasto começa em cima de texto selecionável - foi exatamente isso que
  // quebrou na primeira versão), e (2) alguém "consertar" o fechamento
  // pendurando o marcar-visto nele, que é o oposto do pedido. Por isso o
  // teste roda a função de verdade (recortada do arquivo pelos marcadores)
  // num elemento de mentira, e confere as duas cópias do toast que vivem
  // fora do notif-central.js (Painel e Histórico têm a sua, de antes dele).
  let okArrastar = false;
  try {
    const fsA = require('fs'); const pathA = require('path');
    const dirPub = pathA.join(__dirname, 'public');
    const fonteNotif = fsA.readFileSync(pathA.join(dirPub, 'notif-central.js'), 'utf8');
    const recorte = fonteNotif.match(/\[ARRASTAR-INICIO\][^\n]*\n[\s\S]*?\n([\s\S]*?)\n  \/\/ \[ARRASTAR-FIM\]/);
    if (!recorte) throw new Error('marcadores [ARRASTAR-INICIO]/[ARRASTAR-FIM] sumiram do notif-central.js');
    // eslint-disable-next-line no-new-func
    const arrastarParaFechar = new Function(`${recorte[1]}\nreturn arrastarParaFechar;`)();

    function elementoFalso(largura) {
      const ouvintes = {};
      return {
        offsetWidth: largura, style: {}, removido: false, capturou: false,
        dragstartsBarrados: 0,
        addEventListener(nome, fn) { (ouvintes[nome] = ouvintes[nome] || []).push(fn); },
        removeEventListener(nome, fn) {
          ouvintes[nome] = (ouvintes[nome] || []).filter((f) => f !== fn);
        },
        setPointerCapture() { this.capturou = true; },
        remove() { this.removido = true; },
        disparar(nome, ev) { (ouvintes[nome] || []).slice().forEach((fn) => fn(ev || {})); },
      };
    }
    function gesto(el, passos) {
      el.disparar('pointerdown', { pointerId: 1, pointerType: 'touch', button: 0, clientX: 200, clientY: 100 });
      passos.forEach(([dx, dy]) => {
        el.disparar('pointermove', { pointerId: 1, clientX: 200 + dx, clientY: 100 + dy });
      });
      el.disparar('pointerup', { pointerId: 1 });
    }

    // (1) arrasto horizontal decidido: sai da tela e chama o callback
    const forte = elementoFalso(320);
    let fechouCallback = 0;
    arrastarParaFechar(forte, () => { fechouCallback += 1; });
    gesto(forte, [[20, 2], [90, 4], [180, 6]]);
    forte.disparar('transitionend');

    // (2) arrasto curto (abaixo do limite): volta pro lugar, NÃO some
    const curto = elementoFalso(320);
    arrastarParaFechar(curto, () => { fechouCallback += 1; });
    gesto(curto, [[20, 1], [40, 2]]);
    curto.disparar('transitionend');

    // (3) rolagem vertical não pode ser confundida com o gesto lateral
    const vertical = elementoFalso(320);
    arrastarParaFechar(vertical, () => { fechouCallback += 1; });
    gesto(vertical, [[3, 40], [200, 160]]);

    // (4) arrastar pro outro lado também fecha (o gesto é dos dois lados)
    const paraEsquerda = elementoFalso(320);
    arrastarParaFechar(paraEsquerda);
    gesto(paraEsquerda, [[-20, 2], [-95, 3], [-200, 5]]);
    paraEsquerda.disparar('transitionend');

    // (5) sem transitionend (transição cortada pelo navegador), o setTimeout
    //     de segurança ainda tira o card - senão ele ficaria invisível e vivo
    const semTransicao = elementoFalso(320);
    arrastarParaFechar(semTransicao);
    gesto(semTransicao, [[20, 0], [90, 0], [180, 0]]);
    const sumiuSozinho = await new Promise((r) => setTimeout(() => r(semTransicao.removido), 420));

    const htmlPainel = fsA.readFileSync(pathA.join(dirPub, 'painel.html'), 'utf8');
    const htmlHist = fsA.readFileSync(pathA.join(dirPub, 'central-historico.html'), 'utf8');
    // o marcar-visto tem que continuar preso ao botão Visualizar, e o gesto
    // não pode aparecer perto dele em nenhuma das cópias
    const gestoNaoMarca = [fonteNotif, htmlPainel, htmlHist].every((src) => {
      const i = src.indexOf('ZenithArrastarParaFechar');
      if (i < 0) return true; // ausência é problema de outra conferência, não desta
      return !/marcar-visto/.test(src.slice(i, i + 400));
    });

    const conferencias = {
      'arrastar de verdade tira o card da tela': forte.removido === true,
      'e avisa quem pediu (callback)': fechouCallback === 1,
      'o card é levado pra fora, não só apagado': /translateX\(3\d\d/.test(String(forte.style.transform || '')),
      'arrasto curto NÃO fecha': curto.removido === false,
      'e o arrasto curto volta pro lugar': curto.style.transform === '' && curto.style.opacity === '',
      'rolagem vertical NÃO fecha': vertical.removido === false,
      'arrastar pro outro lado também fecha': paraEsquerda.removido === true,
      'sem transitionend, a rede de segurança ainda fecha': sumiuSozinho === true,
      'o gesto pede captura do ponteiro (não perde o dedo no caminho)': forte.capturou === true,
      'a rolagem vertical da página continua livre': forte.style.touchAction === 'pan-y',
      'seleção de texto travada (senão o Chromium cancela o gesto)':
        forte.style.userSelect === 'none' && forte.style.webkitUserSelect === 'none',
      'notif-central publica o gesto pras outras páginas':
        /window\.ZenithArrastarParaFechar\s*=/.test(fonteNotif),
      'o Painel usa o mesmo gesto': /window\.ZenithArrastarParaFechar\(/.test(htmlPainel),
      'o Histórico usa o mesmo gesto': /window\.ZenithArrastarParaFechar\(/.test(htmlHist),
      'e as duas cópias chamam com guarda (página sem o arquivo não quebra)':
        /if \(window\.ZenithArrastarParaFechar\)/.test(htmlPainel)
        && /if \(window\.ZenithArrastarParaFechar\)/.test(htmlHist),
      'arrastar NÃO marca a solicitação como vista': gestoNaoMarca,
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([n]) => n);
    okArrastar = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')}`);
  } catch (e) { okArrastar = false; console.log('  erro: ' + e.message); }
  if (!okArrastar) ruins += 1;
  console.log(`${okArrastar ? '✓' : '✗'} Notificação: arrastar pro lado fecha o toast SEM marcar como visualizado`);

  // ---- A REGRA DA UNIDADE: Tatuapé não vê nada da Mooca (nem no mesmo grupo) ----
  // O pedido foi literal: "uma unidade não pode ter acesso a dados da outra
  // mesmo que ela esteja dentro do mesmo grupo, da mesma empresa. Tatuapé não
  // pode ver nada da Mooca". As duas SÃO da Arcfood e SÃO do mesmo grupo de
  // KPI's - é o caso mais difícil, porque tudo que separa por empresa ou por
  // rede deixa essas duas juntas. O furo real era o cadastro do grupo: ele
  // saía inteiro em /api/grupos, e a tela de KPI's monta as colunas/séries a
  // partir dele - então o Tatuapé via "Mooca" no comparativo. Este teste usa
  // dois acessos DE VERDADE (login, HTTP), não um mock de permissão.
  let okIsolamentoUnidade = false;
  try {
    const bcrypt = require('bcryptjs');
    const senhaHash = bcrypt.hashSync('SenhaDeTeste!2026', 4);
    const criarAcesso = async (id, email, unidades) => {
      DOCS.set('users/' + id, {
        passwordHash: senhaHash, role: 'user', active: true,
        email, username: id,
        permissions: { sections: ['fechamentos', 'solicitacoes'], unidades, vaultSubgroups: [], tiposSolicitacao: [] },
        createdAt: new Date().toISOString(),
      });
      const tk = (await auth.login(email, 'SenhaDeTeste!2026')).token;
      return { Authorization: 'Bearer ' + tk };
    };
    // 19889 = Tatuapé, 19888 = Mooca (ver CODIGOS_ARCFOOD em redes.js)
    const cabTatuape = await criarAcesso('u-tatuape', 'tatuape@teste.local', ['19889']);
    const cabMooca = await criarAcesso('u-mooca', 'mooca@teste.local', ['19888']);
    // quem manda nas duas continua vendo as duas - a regra é "só as que
    // estiverem no acesso", não "só uma"
    const cabAmbas = await criarAcesso('u-ambas', 'ambas@teste.local', ['19888', '19889']);
    const cabMaster = token ? { Authorization: 'Bearer ' + token } : {};

    // um grupo de KPI com AS DUAS lojas dentro (o cenário do pedido)
    await postarJson('/api/grupos', {
      nome: 'Arcfood SP Teste',
      unidades: ['19888', '19889'],
      kpisExtras: [{ label: 'Tempo de forno', tipo: 'tempo' }],
    }, cabMaster);

    const gruposDe = async (cab) => {
      const r = await pedir('/api/grupos', cab);
      const lista = r.status === 200 ? JSON.parse(r.corpo) : [];
      return lista.find((g) => g.nome === 'Arcfood SP Teste') || null;
    };
    const gTatuape = await gruposDe(cabTatuape);
    const gMooca = await gruposDe(cabMooca);
    const gAmbas = await gruposDe(cabAmbas);
    const gMaster = await gruposDe(cabMaster);

    // fechamento de CADA loja, pra provar que o dado também não atravessa
    DOCS.set('fechamentosLive/f-tat', { id: 'f-tat', unidade: '19889', unidadeNome: 'Dom Tatuape', data: '2026-08-20', faturamento: 1000 });
    DOCS.set('fechamentosLive/f-moo', { id: 'f-moo', unidade: '19888', unidadeNome: 'Dom Mooca', data: '2026-08-20', faturamento: 2000 });
    const fechDe = async (cab) => {
      const r = await pedir('/api/fechamentos', cab);
      return (r.status === 200 ? JSON.parse(r.corpo) : []).map((f) => f.unidade);
    };
    const fTatuape = await fechDe(cabTatuape);
    const fMooca = await fechDe(cabMooca);

    // trocar ?unidade= na URL não pode revelar quem responde pela loja vizinha
    const respVizinha = await pedir('/api/grupos/responsaveis?unidade=' + encodeURIComponent('19888'), cabTatuape);
    const respPropria = await pedir('/api/grupos/responsaveis?unidade=' + encodeURIComponent('19889'), cabTatuape);

    const authMod = require('/home/user/adyen-monitor/server/auth.js');
    const srcNav = require('fs').readFileSync(require('path').join(__dirname, 'public', 'nav-menu.js'), 'utf8');
    const srcKpis = require('fs').readFileSync(require('path').join(__dirname, 'public', 'kpis-operacionais.html'), 'utf8');

    const conferencias = {
      // ---- o furo do pedido: a lista de lojas do grupo
      'o grupo chega no Tatuapé só com o Tatuapé dentro':
        !!gTatuape && JSON.stringify(gTatuape.unidades) === '["19889"]',
      'e chega na Mooca só com a Mooca': !!gMooca && JSON.stringify(gMooca.unidades) === '["19888"]',
      'quem tem as DUAS lojas continua vendo as duas':
        !!gAmbas && gAmbas.unidades.length === 2
        && gAmbas.unidades.includes('19888') && gAmbas.unidades.includes('19889'),
      'o Master segue vendo o grupo inteiro': !!gMaster && gMaster.unidades.length === 2,

      // ---- e o dado em si
      'o Tatuapé só recebe fechamento do Tatuapé':
        fTatuape.length > 0 && fTatuape.every((u) => u === '19889'),
      'a Mooca só recebe fechamento da Mooca':
        fMooca.length > 0 && fMooca.every((u) => u === '19888'),

      // ---- trocar a unidade na URL na mão
      'pedir os responsáveis da loja vizinha é recusado (403)': respVizinha.status === 403,
      'e os da própria loja continuam respondendo': respPropria.status === 200,

      // ---- a fonte única da regra (auth.js), exercitada direto
      'Master não tem recorte de unidade': authMod.unidadesVisiveis({ isMaster: true }) === null,
      'ser Admin NÃO dá unidade de brinde':
        authMod.podeVerUnidade({ isAdmin: true, permissions: { unidades: ['19889'] } }, '19888') === false,
      'ser do time de suporte também não':
        authMod.podeVerUnidade({ permissions: { sections: ['suporte'], unidades: ['19889'] } }, '19888') === false,
      'registro sem unidade nunca passa':
        authMod.podeVerUnidade({ permissions: { unidades: ['19889'] } }, '') === false
        && authMod.filterByUnidade({ permissions: { unidades: ['19889'] } }, [{ semUnidade: 1 }]).length === 0,

      // ---- as duas abas de Fechamento por rede
      'o menu marca "Fechamentos Arcfood" como item da rede ARCFOOD':
        /nav-fechamentos-arcfood[\s\S]{0,220}?redes: \['ARCFOOD'\]/.test(srcNav),
      'e "Fechamentos GBE" como item da rede GBE':
        /nav-fechamentos-gbe[\s\S]{0,200}?redes: \['GBE'\]/.test(srcNav),
      'o menu esconde item de rede que não é do usuário': (() => {
        const m = eval('(' + (srcNav.match(/function temRede\(me, it\) \{[\s\S]*?\n  \}/) || [''])[0].replace(/^function temRede/, 'function temRede') + ')');
        const soGbe = { redesDoUsuario: ['GBE'] };
        const soArc = { redesDoUsuario: ['ARCFOOD'] };
        const master = { redesDoUsuario: null };
        const arcfood = { redes: ['ARCFOOD'] };
        const semRede = { rotulo: 'Entregas' };
        return m(soGbe, arcfood) === false && m(soArc, arcfood) === true
          && m(master, arcfood) === true && m(soGbe, semRede) === true;
      })(),
      'o servidor manda a(s) rede(s) do acesso no /api/me':
        /redesDoUsuario: req\.isMaster/.test(require('fs').readFileSync(require('path').join(__dirname, 'index.js'), 'utf8')),

      // ---- a tela de KPI's, que era o sintoma relatado
      'a tela de KPI\'s recorta as lojas do grupo pelo acesso':
        /return doGrupo\.filter\(u => UNIDADES_PERMITIDAS\.has\(u\)\);/.test(srcKpis)
        && /if\(!UNIDADES_PERMITIDAS\) return doGrupo;/.test(srcKpis),
      'e derruba grupo onde a pessoa não tem loja nenhuma':
        /\.filter\(g => !UNIDADES_PERMITIDAS \|\| \(g\.unidades\|\|\[\]\)\.some/.test(srcKpis),
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([n]) => n);
    okIsolamentoUnidade = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')}`);
  } catch (e) { okIsolamentoUnidade = false; console.log('  erro: ' + e.message); }
  if (!okIsolamentoUnidade) ruins += 1;
  console.log(`${okIsolamentoUnidade ? '✓' : '✗'} Unidade: Tatuapé não vê NADA da Mooca (mesmo grupo, mesma empresa) - nem no cadastro do grupo, nem no dado, nem trocando a URL`);

  // ---------- Marca NoPulso: o acento NAO pode ficar cravado no CSS ----------
  // O limao #b8ff3c so funciona no tema Escuro. No tema Claro o tema.js
  // troca o --accent por #5b8c00, porque limao puro sobre branco e
  // ilegivel. Quem escreve a cor direto no CSS escapa dessa troca e a tela
  // quebra pra quem usa o modo Claro - foi exatamente o que aconteceu no
  // suporte-chat.js (14 ocorrencias) na primeira leva do rebranding.
  // Aceito: a declaracao do token em :root e o fallback var(--accent,#b8ff3c),
  // que so entra em pagina que nao declara :root (alerta-beniboy.html).
  let okAcentoTokenizado = false;
  try {
    const fsA = require('fs'), pathA = require('path');
    const dirA = pathA.join(__dirname, 'public');
    const cravadas = [];
    for (const arq of fsA.readdirSync(dirA).filter((f) => /\.(html|js)$/.test(f))) {
      const src = fsA.readFileSync(pathA.join(dirA, arq), 'utf8');
      src.split('\n').forEach((linha, i) => {
        if (!linha.includes('#b8ff3c')) return;
        // tira o que e legitimo antes de procurar sobra
        const limpa = linha
          .replace(/var\(--accent2?\s*,\s*#b8ff3c\)/g, '')
          .replace(/--accent\s*:\s*#b8ff3c/g, '')
          .replace(/\/\/.*$/, '');           // comentario de linha
        if (limpa.includes('#b8ff3c')) cravadas.push(`${arq}:${i + 1}`);
      });
    }
    okAcentoTokenizado = cravadas.length === 0;
    if (cravadas.length) console.log(`  acento cravado em: ${cravadas.slice(0, 8).join(' · ')}${cravadas.length > 8 ? ` (+${cravadas.length - 8})` : ''}`);
  } catch (e) { okAcentoTokenizado = false; console.log('  erro: ' + e.message); }
  if (!okAcentoTokenizado) ruins += 1;
  console.log(`${okAcentoTokenizado ? '\u2713' : '\u2717'} Marca: o acento limao passa sempre pelo token (nao quebra o tema Claro)`);

  // ---------- Fontes servidas pelo proprio app ----------
  // As lojas tem piso de latencia alto e algumas ficam atras de rede
  // restrita: uma fonte vinda do CDN do Google e ponto de falha externo.
  let okFontesLocais = false;
  try {
    const fsF = require('fs'), pathF = require('path');
    const dirF = pathF.join(__dirname, 'public');
    const tema = fsF.readFileSync(pathF.join(dirF, 'tema.js'), 'utf8');
    const cssF = fsF.readFileSync(pathF.join(dirF, 'fontes', 'fontes.css'), 'utf8');
    const arquivos = ['archivo-latin.woff2', 'archivo-latin-ext.woff2',
                      'jetbrainsmono-latin.woff2', 'jetbrainsmono-latin-ext.woff2'];
    const conf = {
      'o tema.js injeta /fontes/fontes.css': /href *= *'\/fontes\/fontes\.css'/.test(tema),
      'e nao busca mais no CDN do Google':
        !/href *= *['"`]https:\/\/fonts\.(googleapis|gstatic)/.test(tema),
      'o css aponta so pra arquivos locais':
        /url\(\/fontes\//.test(cssF) && !/url\(https:/.test(cssF),
      'as 4 woff2 existem e nao estao vazias':
        arquivos.every((a) => {
          const st = fsF.statSync(pathF.join(dirF, 'fontes', a));
          return st.size > 5000;
        }),
      'font-display:swap (texto aparece antes da fonte chegar)':
        (cssF.match(/font-display: *swap/g) || []).length >= 4,
    };
    const falhasF = Object.entries(conf).filter(([, ok]) => !ok).map(([n]) => n);
    okFontesLocais = !falhasF.length;
    if (falhasF.length) console.log(`  falhou em: ${falhasF.join(' \u00b7 ')}`);
  } catch (e) { okFontesLocais = false; console.log('  erro: ' + e.message); }
  if (!okFontesLocais) ruins += 1;
  console.log(`${okFontesLocais ? '\u2713' : '\u2717'} Fontes: Archivo/JetBrains Mono saem do proprio servidor, sem depender do Google`);

  // ---------- Beniboy: um desenho so, servido pelo tema.js ----------
  // O avatar do assistente (BENIBOY.md) aparece em 6 lugares: widget de
  // chat, atendimento publico, Central, item do menu, tela de alarme e o
  // icone do push. Antes cada um tinha o SEU emoji ou o SEU SVG - a cabeca
  // de robo do login e a do widget eram DUAS copias diferentes do mesmo
  // desenho, e ja tinham divergido. Agora sai tudo de window.beniboySVG no
  // tema.js.
  //
  // Este teste reprova se alguem: (a) tirar o helper do tema.js, (b)
  // trouxer de volta o robo antigo, (c) voltar a cravar o emoji num dos
  // pontos de aplicacao, ou (d) animar a MARCA junto com o avatar - a
  // polyline do logotipo (.auth-marca / .nmz-marca) e identidade, fica
  // parada; quem bate e o Beniboy.
  let okBeniboy = false;
  try {
    const fsB = require('fs'), pathB = require('path');
    const dirB = pathB.join(__dirname, 'public');
    const ler = (f) => fsB.readFileSync(pathB.join(dirB, f), 'utf8');
    const tema = ler('tema.js');
    const widget = ler('suporte-chat.js');
    const login = ler('index.html');
    const nav = ler('nav-menu.js');
    const alarme = ler('alerta-beniboy.html');
    const atend = ler('atendimento.html');
    const central = ler('beniboy.html');
    const sw = ler('sw.js');
    const push = fsB.readFileSync(pathB.join(__dirname, 'push.js'), 'utf8');

    const conf = {
      'tema.js expoe o desenho pra todo mundo':
        /window\.beniboySVG\s*=\s*function/.test(tema) && /class="beniboy/.test(tema),
      'a cor do avatar sai do token (nao quebra o tema Claro)':
        /\.beniboy\{[^}]*color:var\(--accent/.test(tema)
        && /\.beniboy\.pensando\{[^}]*var\(--accent2/.test(tema)
        && /\.beniboy\.alarme\{[^}]*var\(--bad/.test(tema)
        && /\.beniboy\.resolvido\{[^}]*var\(--ok/.test(tema),
      // A regra que vale em TODO lugar (BENIBOY.md secoes 2 e 8): a linha e
      // solida e o que anda e um brilho curto por cima. O "tracar e apagar"
      // deixava o desenho vazio parte do ciclo - ruim em 112px na tela de
      // alarme e pior ainda num PDF/PPTX, que congela um frame.
      'a linha nunca desaparece: a base e solida, quem anda e o brilho':
        !/\.bb-traco\{[^}]*stroke-dasharray/.test(tema)
        && !/\.marca-base\{[^}]*stroke-dasharray/.test(tema)
        && /\.beniboy \.bb-brilho\{[^}]*stroke-dasharray:9 64/.test(tema)
        && /\.marca-brilho\{[^}]*stroke-dasharray:12 82/.test(tema),
      'o brilho tambem passa pelo token (branco sobre fundo branco vira buraco)':
        /stroke:var\(--pulso-brilho,#fff\)/.test(tema)
        && (tema.match(/stroke:var\(--pulso-brilho,#fff\)/g) || []).length === 2
        && /--pulso-brilho:#[0-9a-f]{6};/.test(tema),
      'reduced-motion desliga o batimento':
        /prefers-reduced-motion:reduce[\s\S]{0,200}bb-brilho\{animation:none/.test(tema),
      'o robo antigo do login foi embora (markup e keyframes)':
        !/login-bot|login-float|login-blink|login-arml|login-armr/.test(login),
      'o robo antigo do widget foi embora':
        !/szc-bot-eyes|szc-bot-arm-l|szc-bot-arm-r/.test(widget),
      'widget, atendimento, Central, menu e alarme usam o mesmo helper':
        /beniboySVG\(40\)/.test(widget) && /beniboySVG\(112, 'alarme no-vermelho'\)/.test(widget)
        && /beniboySVG\(64\)/.test(atend)
        && /beniboySVG\(48\)/.test(central)
        && /beniboySVG\(20\)/.test(nav)
        && /beniboySVG\(112, 'alarme no-vermelho'\)/.test(alarme),
      'o item do menu continua com o id da permissao':
        /id: 'nav-beniboy'/.test(nav),
      'o push do Beniboy tem icone proprio e o sw sabe usar':
        /icone: '\/beniboy-192\.png'/.test(push)
        && /icon: data\.icone \|\| '\/icon-192\.png'/.test(sw)
        && fsB.existsSync(pathB.join(dirB, 'beniboy-192.png')),
      // Decisao do usuario: o sinal vital se mexe onde quer que apareca,
      // logotipo incluido. O que NAO pode e o logotipo sumir - por isso a
      // linha de base continua inteira e quem anda e o pulso por cima.
      'a marca tambem bate, nas 3 aparicoes (login x2 e drawer)':
        /\.marca-brilho\{[^}]*animation:marca-brilho/.test(tema)
        && /@keyframes marca-brilho/.test(tema)
        && (login.match(/class="marca-brilho"/g) || []).length === 2
        && (login.match(/class="marca-base"/g) || []).length === 2
        && /class="marca-brilho"/.test(nav) && /class="marca-base"/.test(nav),
      'reduced-motion tambem desliga o brilho da marca':
        /prefers-reduced-motion:reduce[\s\S]{0,120}\.marca-brilho\{animation:none/.test(tema),
    };
    const ruinsB = Object.entries(conf).filter(([, ok]) => !ok).map(([n]) => n);
    okBeniboy = !ruinsB.length;
    if (ruinsB.length) console.log(`  falhou em: ${ruinsB.join(' · ')}`);
  } catch (e) { okBeniboy = false; console.log('  erro: ' + e.message); }
  if (!okBeniboy) ruins += 1;
  console.log(`${okBeniboy ? '\u2713' : '\u2717'} Beniboy: um desenho so pros 6 lugares, a linha sempre inteira e a marca batendo junto`);

  // ---------- Aviso de mudanca de endereco ----------
  // Quem entra pelo endereco antigo precisa saber que o app mudou de casa.
  // O perigo esta em ONDE esse aviso aparece: index.html na raiz e
  // abastecimento.html sao as telas que fazem heartbeat pelo navegador na
  // maquina de loja. localStorage e por origem - um clique ali apaga o
  // zenithMonitorFixo, a maquina esquece a unidade e a loja acusa offline.
  // Este teste existe pra ninguem tirar essa trava sem perceber.
  let okAvisoEndereco = false;
  try {
    const fsE = require('fs'), pathE = require('path');
    const tema = fsE.readFileSync(pathE.join(__dirname, 'public', 'tema.js'), 'utf8');
    const idx = fsE.readFileSync(pathE.join(__dirname, 'index.js'), 'utf8');

    const rota = await pedir('/api/meta/endereco');
    let corpoRota = {};
    try { corpoRota = JSON.parse(rota.corpo); } catch (e) { /* fica vazio */ }

    const conf = {
      'a rota devolve o endereco oficial (e e publica, sem Firestore)':
        rota.status === 200 && typeof corpoRota.oficial === 'string' && /^https?:\/\//.test(corpoRota.oficial),
      'o destino vem do APP_BASE_URL, nao de dominio cravado no JS':
        /res\.json\(\{ oficial: APP_BASE_URL \}\)/.test(idx)
        && !/nopulso\.com\.br/.test(tema),
      'as telas de heartbeat da loja ficam de fora':
        /TELAS_DE_HEARTBEAT\s*=\s*\['\/', '\/index\.html', '\/abastecimento\.html'\]/.test(tema)
        && /TELAS_DE_HEARTBEAT\.indexOf\(location\.pathname\) !== -1\) return;/.test(tema),
      'so aparece pra quem esta logado (cliente em pagina publica nao ve)':
        /if \(!localStorage\.getItem\('authToken'\)\) return;/.test(tema),
      'e some sozinho quando ja se esta no endereco certo':
        /destino\.origin === location\.origin\) return;/.test(tema),
    };
    const ruinsE = Object.entries(conf).filter(([, ok]) => !ok).map(([n]) => n);
    okAvisoEndereco = !ruinsE.length;
    if (ruinsE.length) console.log(`  falhou em: ${ruinsE.join(' · ')}`);
  } catch (e) { okAvisoEndereco = false; console.log('  erro: ' + e.message); }
  if (!okAvisoEndereco) ruins += 1;
  console.log(`${okAvisoEndereco ? '\u2713' : '\u2717'} Mudanca de endereco: avisa quem entra pelo antigo, menos na maquina de loja`);

  // ---------- Painel: o desenho novo sem inventar dado ----------
  // O mockup 1b trazia "Meta do mes 71,2%" e "Faturamento hoje +8,4%" - dois
  // numeros que NAO existem no sistema (nao ha meta em lugar nenhum, e o
  // fechamento so e lancado quando a loja fecha, entao "hoje" nao tem dado).
  // A linguagem visual foi aproveitada; os numeros falsos, nao. Ver CLAUDE.md
  // secao 6. Este teste existe pra ninguem "completar" o painel depois
  // colando esses campos de volta.
  let okPainelReal = false;
  try {
    const fsP = require('fs'), pathP = require('path');
    const painel = fsP.readFileSync(pathP.join(__dirname, 'public', 'painel.html'), 'utf8');

    // o intervalo que o indicador "ao vivo" promete tem que ser o mesmo que o
    // codigo realmente usa - numero de tela batendo com o comportamento
    const promete = (painel.match(/ao vivo · (\d+)s/) || [])[1];
    const real = (painel.match(/renderizarCards\(\); \}, (\d+)\)/) || [])[1];

    // Tira comentario antes de procurar: o proprio codigo EXPLICA por que a
    // "meta do mes" ficou de fora, e essa explicacao nao pode reprovar o
    // teste. O que vale e o que a tela mostra, nao o que o codigo comenta.
    const semComentario = painel
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');

    const conf = {
      'nao inventa meta nem faturamento de hoje':
        !/Meta do m[êe]s/i.test(semComentario) && !/Faturamento hoje/i.test(semComentario),
      'o card de Alertas e so do Master (a rota e requireMaster)':
        /\{ chave:'alertas', soMaster:true, build:cardAlertas \}/.test(painel)
        && /app\.get\('\/api\/alertas-central', auth\.requireMaster/.test(
             fsP.readFileSync(pathP.join(__dirname, 'index.js'), 'utf8')),
      'o "ao vivo" promete o intervalo que o codigo cumpre':
        !!promete && !!real && Number(promete) * 1000 === Number(real),
      'chips por unidade saem do fechamento de ontem':
        /class="punidade"/.test(painel) && /d\.unidadeNome\|\|d\.unidade/.test(painel),
      'diferenca de caixa vem do campo quebra, nao de conta inventada':
        /d\.quebra\|\|0/.test(painel),
      'alerta usa cor semantica, nao a cor da marca':
        /\.palerta\.bad > \.sev\{background:var\(--bad\)/.test(painel)
        && !/\.palerta[^{]*\{[^}]*var\(--accent\)/.test(painel),
    };
    const ruinsP = Object.entries(conf).filter(([, ok]) => !ok).map(([n]) => n);
    okPainelReal = !ruinsP.length;
    if (ruinsP.length) console.log(`  falhou em: ${ruinsP.join(' · ')}`);
  } catch (e) { okPainelReal = false; console.log('  erro: ' + e.message); }
  if (!okPainelReal) ruins += 1;
  console.log(`${okPainelReal ? '\u2713' : '\u2717'} Painel: desenho novo do mockup sem inventar numero que o sistema nao tem`);

  // ---------- Fechamentos: linha de total e quem nao lancou ----------
  // Do mockup 1c ficou o que o dado sustenta: a linha "Total do grupo" no
  // rodape da tabela e o aviso de quem nao lancou. Ficaram DE FORA os badges
  // CONFERIDO/TRATATIVA - a tela nao tem conferencia nem tratativa; "diferenca
  // zero" nao e a mesma coisa que "alguem conferiu", e chamar assim faria a
  // operacao confiar numa checagem que ninguem fez. Ver CLAUDE.md secao 6.
  let okFechReal = false;
  try {
    const fsF = require('fs'), pathF = require('path');
    const fech = fsF.readFileSync(pathF.join(__dirname, 'public', 'fechamentos.html'), 'utf8');
    const semComentarioF = fech
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');

    // a linha do previsao dentro do array `defs` - ela NAO pode ganhar `soma`
    const linhaPrevisao = (fech.split('\n').find((l) => /key:'previsao'/.test(l)) || '');

    const confF = {
      'a linha de total sai do MESMO defs do thead/tbody (nao pode desalinhar)':
        /const tfoot = defs\.map\(/.test(fech) && /<tfoot><tr>\$\{tfoot\}<\/tr><\/tfoot>/.test(fech),
      'a previsao do dia seguinte fica fora do total':
        !!linhaPrevisao && !/soma:/.test(linhaPrevisao),
      'o total soma faturamento, declarado e diferenca':
        /soma:d=>d\.faturamento/.test(fech) && /soma:d=>d\.totalDeclarado/.test(fech)
        && /soma:d=>d\.diferenca/.test(fech),
      'as colunas de canal/forma tambem entram no total':
        /soma:d=>valorColuna\(d, c\)/.test(fech),
      'nao inventa badge de conferencia nem de tratativa':
        !/CONFERIDO/.test(semComentarioF) && !/TRATATIVA/i.test(semComentarioF),
      'o aviso diz "nenhum lancamento no periodo", nao "nao lancou"':
        /nenhum lan\u00e7amento no per\u00edodo/.test(semComentarioF)
        && /\.filter\(c=>!lancaram\.has\(c\)\)/.test(fech),
      'o aviso usa o mesmo cruzamento de filtros da tabela':
        /const semLancamento = unidadesEfetivasParaRelatorio\(\)/.test(fech),
      'os 6 KPIs reais continuam de pe (o mockup 1c apagava 4 deles)':
        /lbl:'Fechamentos', val:`\$\{lojasFecharam\} de \$\{roster\.length\}`/.test(fech)
        && /lbl:'Total declarado'/.test(fech) && /lbl:'TC total'/.test(fech)
        && /lbl:'Cancelados'/.test(fech) && /delta:deltaFat/.test(fech),
    };
    const ruinsF = Object.entries(confF).filter(([, ok]) => !ok).map(([n]) => n);
    okFechReal = !ruinsF.length;
    if (ruinsF.length) console.log(`  falhou em: ${ruinsF.join(' \u00b7 ')}`);
  } catch (e) { okFechReal = false; console.log('  erro: ' + e.message); }
  if (!okFechReal) ruins += 1;
  console.log(`${okFechReal ? '\u2713' : '\u2717'} Fechamentos: linha de total e quem nao lancou, sem badge inventado`);

  // ---------- Lancamento: a foto do relatorio ----------
  // O mockup 2h desenha a leitura por foto como se fosse nova - ela ja existe
  // e faz MAIS do que o desenho (varias fotos, campo suspeito liberado, soma
  // que nao fecha, zero em branco). Do mockup entrou so o que faltava: o chip
  // "da foto" por secao e a hora da leitura.
  // O que NAO pode acontecer: cravar a lista de campos do desenho (Delivery,
  // Carryout, Adyen, Pix CNPJ...). Esses campos sao CADASTRADOS por grupo em
  // /grupos.html - cravar a lista do Domino's apagaria os canais e formas de
  // toda franquia que nao e Domino's. Ver CLAUDE.md secao 6.
  let okLancFoto = false;
  try {
    const fsL = require('fs'), pathL = require('path');
    const lanc = fsL.readFileSync(pathL.join(__dirname, 'public', 'lancamento.html'), 'utf8');
    const semComentarioL = lanc
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');

    const confL = {
      'os campos continuam vindo do grupo, nao cravados no HTML':
        /canais-extras-container/.test(lanc) && /formas-extras-container/.test(lanc)
        && /kpis-extras-container/.test(lanc)
        && !/<label>\s*Carryout\s*<\/label>/.test(semComentarioL)
        && !/<label>\s*Pix CNPJ\s*<\/label>/.test(semComentarioL),
      'o chip conta o DOM, nao a ultima leitura (varias fotos em rodadas)':
        /input\.campo-automatico\[readonly\]/.test(lanc)
        && /function pintarChipsFoto\(\)/.test(lanc),
      'a leitura diz a hora (senao nao da pra saber se e desta rodada)':
        /Lido \u00e0s \$\{hora\}/.test(lanc)
        && /toLocaleTimeString\('pt-BR'/.test(lanc),
      'campo achado pela foto continua travado (a trava e a garantia)':
        /el\.readOnly = true;/.test(lanc)
        && /campo-automatico'\);/.test(lanc),
      'campo que a leitura nao confirmou continua sendo liberado':
        /\(data\.suspeitos\|\|\[\]\)\.forEach/.test(lanc)
        && /\(data\.faltando\|\|\[\]\)\.forEach/.test(lanc),
      'o chip usa token de cor, nao hex cravado':
        /\.chip-foto\{[^}]*var\(--ok\)/.test(lanc)
        && !/\.chip-foto\{[^}]*#[0-9a-fA-F]{6}/.test(lanc),
    };
    const ruinsL = Object.entries(confL).filter(([, ok]) => !ok).map(([n]) => n);
    okLancFoto = !ruinsL.length;
    if (ruinsL.length) console.log(`  falhou em: ${ruinsL.join(' \u00b7 ')}`);
  } catch (e) { okLancFoto = false; console.log('  erro: ' + e.message); }
  if (!okLancFoto) ruins += 1;
  console.log(`${okLancFoto ? '\u2713' : '\u2717'} Lancamento: campos vem do grupo e a foto continua travando o que leu`);

  // ---------- Fraude: a deteccao nao pode marcar loja inteira ----------
  // A malha de identidade ligava dois pedidos por UM termo de 3+ letras em
  // comum. Com nome brasileiro ("Silva" ~10% da populacao) isso juntava o dia
  // inteiro num cluster so: medido, 98,5% dos pedidos LEGITIMOS viravam
  // FRAUDE. Este teste roda os modulos reais contra trafego legitimo gerado
  // aqui e reprova se a taxa voltar a subir - e confere que o ataque de
  // verdade continua sendo pego (senao a gente so troca um problema por
  // outro).
  let okFraude = false;
  try {
    const fi = require('./fraudIdentity');
    const ch = require('./cardHopping');
    const pix = require('./pixRepetido');

    // gerador deterministico (mesma semente sempre) - teste nao pode variar
    let semente = 20260823;
    const rnd = () => { semente = (semente * 1103515245 + 12345) % 2147483648; return semente / 2147483648; };
    const SOBRE = ['Silva','Santos','Oliveira','Souza','Rodrigues','Ferreira','Alves','Pereira','Lima','Costa','Gomes','Ribeiro'];
    const PRE = ['Maria','Jose','Ana','Joao','Carlos','Paulo','Lucas','Bruno','Juliana','Camila','Rafael','Felipe'];
    const nomeBr = () => `${PRE[Math.floor(rnd() * PRE.length)]} ${SOBRE[Math.floor(rnd() * SOBRE.length)]} ${SOBRE[Math.floor(rnd() * SOBRE.length)]}`;
    const UNI = ['DOM_19706', 'DOM_19798', 'Mooca', 'Carrao'];

    const marcas = new Map();
    const norm = (n) => String(n || '').trim().toLowerCase();
    function processa(tx, id) {
      if (pix.ehPix(tx)) { if (pix.registrarPix(tx)) marcas.set(id, { nivel: 'SUSPEITO', nome: tx.nomeCliente }); return; }
      const info = fi.registrarPedido(id, tx.nomeCliente, tx.cardHolder, tx.unidade);
      if (ch.registrarTentativa(tx, info ? `${tx.unidade}:cluster:${info.clusterId}` : undefined)) {
        marcas.set(id, { nivel: 'FRAUDE', nome: tx.nomeCliente }); return;
      }
      if (!info) return;
      const set = new Set(info.nomes.map(norm));
      if ([...marcas.values()].some((m) => m.nivel === 'FRAUDE' && set.has(norm(m.nome)))) {
        marcas.set(id, { nivel: 'FRAUDE', nome: tx.nomeCliente });
      } else if (info.nomesDistintos >= 2) {
        marcas.set(id, { nivel: 'SUSPEITO', nome: tx.nomeCliente });
      }
    }

    const legitimos = [];
    for (let i = 0; i < 250; i++) {
      const nome = nomeBr();
      const id = 'L' + i; legitimos.push(id);
      processa({ unidade: UNI[i % UNI.length], nomeCliente: nome, cardHolder: nome, metodo: 'mc',
        last4: String(1000 + Math.floor(rnd() * 9000)), status: rnd() < 0.12 ? 'RECUSADO' : 'APROVADO' }, id);
    }
    const fraudeFalsa = legitimos.filter((id) => marcas.get(id) && marcas.get(id).nivel === 'FRAUDE').length;
    const marcadoTotal = legitimos.filter((id) => marcas.has(id)).length;

    // ataque real: mesma pessoa, 5 cartoes distintos, mesma loja, em minutos
    const ataque = [];
    for (let k = 0; k < 5; k++) {
      const id = 'ATQ' + k; ataque.push(id);
      processa({ unidade: 'DOM_19706', nomeCliente: 'Thalyson Bergamini', cardHolder: 'Thalyson Bergamini',
        metodo: 'visa', last4: String(7770 + k), status: 'RECUSADO' }, id);
    }
    const pegou = ataque.some((id) => marcas.get(id) && marcas.get(id).nivel === 'FRAUDE');

    // anel que cruza nome do cliente x nome do cartao (o caso do comentario)
    const anel = [['Thais Bergamini', 'Luciano Wanderlei'], ['Luciano Bergamini', 'Thais Wanderlei'], ['Thais Wanderlei', 'Luciano Bergamini']];
    let pegouAnel = false;
    anel.forEach((par, k) => {
      const id = 'ANEL' + k;
      processa({ unidade: 'Mooca', nomeCliente: par[0], cardHolder: par[1], metodo: 'visa', last4: String(4440 + k), status: 'RECUSADO' }, id);
      if (marcas.has(id)) pegouAnel = true;
    });

    // Pix: nunca FRAUDE; repetido vira SUSPEITO/"Repetido"
    const pixIds = [];
    for (let k = 0; k < 3; k++) {
      const id = 'PIX' + k; pixIds.push(id);
      processa({ unidade: 'Carrao', nomeCliente: 'Joana Prestes', cardHolder: null, metodo: 'pix', last4: null, status: 'APROVADO' }, id);
    }
    const pixFraude = pixIds.some((id) => marcas.get(id) && marcas.get(id).nivel === 'FRAUDE');
    const pixSuspeito = pixIds.some((id) => marcas.get(id) && marcas.get(id).nivel === 'SUSPEITO');

    const fonteFi = require('fs').readFileSync(require('path').join(__dirname, 'fraudIdentity.js'), 'utf8');
    const fonteIdx = require('fs').readFileSync(require('path').join(__dirname, 'index.js'), 'utf8');

    const conf = {
      'nenhum pedido legitimo vira FRAUDE': fraudeFalsa === 0,
      'ruido total nos legitimos fica abaixo de 10%': marcadoTotal / 250 < 0.10,
      'ataque de troca de cartao continua sendo pego': pegou,
      'anel com nomes cruzados continua sendo pego': pegouAnel,
      'Pix nunca leva FRAUDE': !pixFraude,
      'Pix repetido leva SUSPEITO': pixSuspeito,
      'Pix nao entra na malha de identidade nem no cardHopping':
        /const clusterInfo = ehPixTx/.test(fonteIdx) && /&& !ehPixTx\) \{/.test(fonteIdx),
      'a malha e escopada por unidade': /chaveEscopo\(unidade, t\)/.test(fonteFi)
        && /registrarPedido\(pedidoIdAtual, tx\.nomeCliente, tx\.cardHolder, tx\.unidade\)/.test(fonteIdx),
      'termo comum nao liga sozinho': /TERMOS_COMUNS\.has\(token\)/.test(fonteFi),
      'cluster que explode para de valer como identidade': /MAX_PEDIDOS_CLUSTER/.test(fonteFi)
        && /cluster\.saturado = true/.test(fonteFi),
      'SUSPEITO exige nomes CRUZADOS, nao cliente que pediu 2x':
        /clusterInfo\.nomesDistintos >= 2/.test(fonteIdx),
      'a limpeza nunca apaga marcacao que humano criou ou confirmou':
        /m\.criadoPorEmail === EMAIL_DETECCAO && m\.atualizadoPorEmail === EMAIL_DETECCAO/
          .test(require('fs').readFileSync(require('path').join(__dirname, 'fraudMarks.js'), 'utf8')),
      'a limpeza exige confirmacao explicita': /confirmar !== true/.test(fonteIdx),
    };
    const ruinsF = Object.entries(conf).filter(([, ok]) => !ok).map(([n]) => n);
    okFraude = !ruinsF.length;
    if (ruinsF.length) console.log(`  falhou em: ${ruinsF.join(' \u00b7 ')} (falso FRAUDE: ${fraudeFalsa}/250, ruido: ${marcadoTotal}/250)`);
  } catch (e) { okFraude = false; console.log('  erro: ' + e.message); }
  if (!okFraude) ruins += 1;
  console.log(`${okFraude ? '\u2713' : '\u2717'} Fraude: cliente legitimo nao vira fraudador, ataque continua pego, Pix so "Repetido"`);

  // ---------- Termo do parque: direito de NAO autorizar imagem ----------
  // O corpo do termo diz "autorizo ... a fazer uso das imagens". Sem uma
  // opcao de recusa, assinar era condicao pra entrar - e consentimento sob
  // essa condicao nao e livre (LGPD, Lei 13.709). O termo IMPRESSO que o
  // parque usa ja tem o quadrado; o PDF gerado aqui nao tinha.
  // Este teste gera o PDF de verdade e le o texto de dentro dele.
  let okTermo = false;
  try {
    const { PassThrough } = require('stream');
    const termo = require('./termoResponsabilidade');
    const pedacos = [];
    const fake = new PassThrough();
    fake.setHeader = () => {};
    fake.on('data', (d) => pedacos.push(d));
    const pronto = new Promise((r) => fake.on('end', r));
    termo.gerarTermoPDF(fake, {
      responsavel: { nome: 'Teste da Silva', cpf: '000.000.000-00' },
      dataUtilizacao: '2026-08-23',
      criancas: [{ nome: 'Filho de Teste' }],
      // de proposito SEM tempoMinutos: e o caso que imprimia "(undefined min)"
    });
    await pronto;
    // o pdfkit guarda o texto em streams comprimidos; o suficiente pra este
    // teste e conferir a FONTE, que e o que o Master vai ler e manter
    const fonteBruta = require('fs').readFileSync(require('path').join(__dirname, 'termoResponsabilidade.js'), 'utf8');
    // sem comentario: comentar a chamada com "//" deixava a string no arquivo
    // e o teste passava com o bloco desligado
    const fonte = fonteBruta
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');
    const pdfBytes = Buffer.concat(pedacos).length;
    // procura a CHAMADA, nao a definicao: 'renderOpcaoImagem(doc, x, largura)'
    // aparece nas duas, e casar com a definicao fazia o teste passar mesmo com
    // a chamada comentada ou apagada
    const posChamada = fonte.search(/^\s*renderOpcaoImagem\(doc, x, largura\);/m);
    const posAssinatura = fonte.indexOf('const yAssinatura');

    const conf = {
      'o PDF continua sendo gerado': pdfBytes > 2000,
      'existe a opcao de NAO autorizar o uso de imagem':
        /Não autorizo o WOW PARK a fazer uso da minha imagem/.test(fonte)
        && /function renderOpcaoImagem/.test(fonte),
      // >= 0 importa: com a chamada apagada, indexOf devolve -1 e -1 < qualquer
      // coisa passava - o teste dizia OK com o bloco fora do PDF
      'o bloco e mesmo CHAMADO, e antes da assinatura':
        posChamada >= 0 && posAssinatura >= 0 && posChamada < posAssinatura,
      'tem quadrado de marcar, nao so texto': /doc\.rect\(x, yTopo \+ 1, lado, lado\)/.test(fonte),
      'explica que marcar = recusar e branco = autorizar':
        /Marque o quadrado acima apenas se NÃO autorizar/.test(fonte),
      'nao imprime "(undefined min)" quando nao ha tempo':
        /Number\(checkin\.tempoMinutos\) > 0 \? /.test(fonte)
        && !/\$\{checkin\.tempoMinutos\} min/.test(fonte),
      'o espaco depois do nome em negrito nao e comido pelo pdfkit':
        /proximo\.startsWith\(' '\) \? EMPRESA_NOME_MAIUSCULO \+ ' '/.test(fonte),
    };
    const ruinsT = Object.entries(conf).filter(([, ok]) => !ok).map(([n]) => n);
    okTermo = !ruinsT.length;
    if (ruinsT.length) console.log(`  falhou em: ${ruinsT.join(' \u00b7 ')}`);
  } catch (e) { okTermo = false; console.log('  erro: ' + e.message); }
  if (!okTermo) ruins += 1;
  console.log(`${okTermo ? '\u2713' : '\u2717'} Termo do parque: da pra NAO autorizar o uso de imagem, e sem "undefined" impresso`);

  // ---------- Bonificação: motor de cálculo + perfis salvos + visibilidade ----------
  // Mecânica portada de um simulador solto do Master (bônus de gerente/
  // equipe em cima do faturamento) - aqui é só a fórmula pura, testada com
  // números fixos conferidos na mão (mesmo espírito do motor de
  // inventario.js). Cobre também o invariante "unidade pertence a 1 perfil
  // por vez" (mesma ideia de grupoDaUnidade em grupos.js) e a poda de campos
  // por permissão - pedido explícito do usuário foi "nunca mostrar todos pra
  // todo mundo", e isso tem que acontecer no SERVIDOR, antes de sair pro
  // navegador, não escondido só no CSS.
  let okBonificacao = false;
  try {
    const bonificacaoPerfis = require('./bonificacaoPerfis');
    const bonificacao = require('./bonificacao');

    // ---- 1) motor puro: números fixos conferidos na mão ----
    const perfilExemplo = {
      percentualPool: 1, splitMetasOutras: 70, splitGerente: 60, splitGerenteOutras: 25,
      metricasGerente: [
        { campo: 'faturamento', peso: 40 }, { campo: 'documentacao', peso: 35 }, { campo: 'gestaoPessoal', peso: 25 },
      ],
      metricasColaboradores: [
        { campo: 'assiduidade', peso: 40 }, { campo: 'treinamentos', peso: 30 }, { campo: 'comportamento', peso: 20 }, { campo: 'iniciativas', peso: 10 },
      ],
    };
    const completionsGerenteEx = [
      { campo: 'faturamento', percentual: 95 }, { campo: 'documentacao', percentual: 100 }, { campo: 'gestaoPessoal', percentual: 88 },
    ];
    const completionsColabEx = [
      { campo: 'assiduidade', percentual: 100 }, { campo: 'treinamentos', percentual: 80 }, { campo: 'comportamento', percentual: 95 }, { campo: 'iniciativas', percentual: 70 },
    ];
    const r1 = bonificacao.calcular(perfilExemplo, 100000, 12, completionsGerenteEx, completionsColabEx);

    // ---- 2) casos de borda ----
    const rFatZero = bonificacao.calcular(perfilExemplo, 0, 12, completionsGerenteEx, completionsColabEx);
    const rSemFuncionario = bonificacao.calcular(perfilExemplo, 100000, 0, completionsGerenteEx, completionsColabEx);
    const rSoColab = bonificacao.calcular({ ...perfilExemplo, metricasGerente: [] }, 100000, 12, [], completionsColabEx);
    const rSoGerente = bonificacao.calcular({ ...perfilExemplo, metricasColaboradores: [] }, 100000, 12, completionsGerenteEx, []);
    // pesos que NÃO somam 100% (40+30=70) - a taxa fica proporcional ao peso
    // usado, sem normalizar pro que faltou: o sistema não inventa os 30% que
    // não foram configurados (mesma lógica de "não inventar rótulo/número"
    // do CLAUDE.md §6, aplicada ao motor de cálculo)
    const rPesoIncompleto = bonificacao.calcular(
      { ...perfilExemplo, metricasGerente: [{ campo: 'a', peso: 40 }, { campo: 'b', peso: 30 }], metricasColaboradores: [] },
      100000, 12, [{ campo: 'a', percentual: 100 }, { campo: 'b', percentual: 100 }], [],
    );

    // ---- 3) perfis: uma unidade só pertence a 1 perfil por vez ----
    const perfilA = await bonificacaoPerfis.criar({ nome: 'TESTE Domino\'s', unidades: ['TESTE_UN_X', 'TESTE_UN_Y'], criadoPorEmail: 'teste@local' });
    const perfilB = await bonificacaoPerfis.criar({ nome: 'TESTE Domino\'s Caruaru', unidades: ['TESTE_UN_Y', 'TESTE_UN_Z'], criadoPorEmail: 'teste@local' });
    const perfilARelido = await bonificacaoPerfis.obter(perfilA.id);
    const perfilDaUnidadeY = await bonificacaoPerfis.perfilDaUnidade('TESTE_UN_Y');
    const perfilDaUnidadeSemDono = await bonificacaoPerfis.perfilDaUnidade('TESTE_UN_NUNCA_CONFIGURADA');

    // ---- 4) visibilidade: a mesma apuração, 3 combinações de permissão ----
    const apuracaoFake = {
      semPerfil: false, unidade: 'TESTE_UN_X', mes: '2026-08', status: 'rascunho', perfilNome: 'TESTE Domino\'s',
      temGerente: true, temColab: true, gerenteRecebe: 470.25,
      colabTotal: 454.5, colabPorPessoa: 37.88,
      fechadoPorEmail: null, fechadoEm: null,
      metricasGerente: perfilExemplo.metricasGerente, metricasColaboradores: perfilExemplo.metricasColaboradores,
      completionsGerente: completionsGerenteEx, completionsColaboradores: completionsColabEx,
      sugestaoAssiduidade: 96,
      faturamento: 100000, pool: 1000, metas: 700, outras: 300, taxaGerente: 95, taxaColab: 90,
      funcionarios: [{ id: 'f1', nome: 'Colaborador Teste' }],
    };
    const semNada = bonificacao.montarRespostaPorPermissao(apuracaoFake, { podeVerTotal: false, podeVerColaboradores: false });
    const soTotal = bonificacao.montarRespostaPorPermissao(apuracaoFake, { podeVerTotal: true, podeVerColaboradores: false });
    const soColab = bonificacao.montarRespostaPorPermissao(apuracaoFake, { podeVerTotal: false, podeVerColaboradores: true });

    const conf = {
      // motor puro
      'taxa do gerente bate com a conta na mão (95%)': r1.taxaGerente === 95,
      'taxa dos colaboradores bate com a conta na mão (90%)': r1.taxaColab === 90,
      'gerente recebe exatamente R$470,25': r1.gerenteRecebe === 470.25,
      'colaboradores recebem R$454,50 no total': r1.colabTotal === 454.5,
      'e R$37,88 por pessoa (454,50 / 12)': r1.colabPorPessoa === 37.88,
      'faturamento zero zera tudo (não gera bônus do nada)': rFatZero.gerenteRecebe === 0 && rFatZero.colabTotal === 0,
      'zero funcionário ativo não quebra a divisão (por pessoa = 0)': rSemFuncionario.colabPorPessoa === 0,
      'perfil só-colaborador não bonifica gerente': rSoColab.gerenteRecebe === 0 && rSoColab.colabTotal > 0,
      'perfil só-gerente não bonifica colaborador': rSoGerente.colabTotal === 0 && rSoGerente.gerenteRecebe > 0,
      'pesos que não somam 100% não são normalizados (fica no que foi configurado)': rPesoIncompleto.taxaGerente === 70,
      // perfis nomeados e salvos
      'perfil B "rouba" a unidade Y do perfil A ao ser criado': perfilARelido.unidades.includes('TESTE_UN_X') && !perfilARelido.unidades.includes('TESTE_UN_Y'),
      'perfilDaUnidade acha o dono certo (perfil B, não A)': !!perfilDaUnidadeY && perfilDaUnidadeY.id === perfilB.id,
      'unidade nunca configurada não devolve perfil nenhum (não inventa default)': perfilDaUnidadeSemDono === null,
      // visibilidade - a poda tem que acontecer ANTES de sair pro navegador
      'sem nenhuma das 2 flags: não vaza faturamento': semNada.faturamento === undefined,
      'sem nenhuma das 2 flags: não vaza lista nominal': semNada.colaboradores === undefined,
      'sem nenhuma das 2 flags: ainda mostra o agregado dos colaboradores': !!semNada.colaboradoresResumo && semNada.colaboradoresResumo.porPessoa === 37.88,
      'com podeVerValorTotal: mostra faturamento/pool/taxas': soTotal.faturamento === 100000 && soTotal.pool === 1000 && soTotal.taxaGerente === 95,
      'com podeVerValorTotal (sem verColaboradores): continua sem nome': soTotal.colaboradores === undefined,
      'com podeVerColaboradores: mostra nome a nome': Array.isArray(soColab.colaboradores) && soColab.colaboradores[0].nome === 'Colaborador Teste',
      'com podeVerColaboradores (sem verValorTotal): continua sem faturamento': soColab.faturamento === undefined,
    };
    const ruinsB = Object.entries(conf).filter(([, ok]) => !ok).map(([n]) => n);
    okBonificacao = !ruinsB.length;
    if (ruinsB.length) console.log(`  falhou em: ${ruinsB.join(' · ')} (taxaGerente=${r1.taxaGerente} gerenteRecebe=${r1.gerenteRecebe} colabTotal=${r1.colabTotal} colabPorPessoa=${r1.colabPorPessoa})`);
  } catch (e) { okBonificacao = false; console.log('  erro: ' + e.message); }
  if (!okBonificacao) ruins += 1;
  console.log(`${okBonificacao ? '✓' : '✗'} Bonificação: motor bate com a conta na mão, unidade só num perfil por vez, permissão poda o payload`);

  // ---------- Bonificação: as ROTAS de verdade (não só o módulo) ----------
  // O bloco acima chama bonificacao.js/bonificacaoPerfis.js direto - prova a
  // mecânica, mas não passa pelo Express (auth, requireSection,
  // desviarSeQaMaster, parsing do corpo). Aqui bate em CADA rota pela porta
  // 8899 de verdade, como Master, do jeito que o resto da suíte já faz.
  const cabMasterBonif = token ? { Authorization: 'Bearer ' + token } : {};
  let okBonifRotas = false;
  try {
    const rCriar = await postarJson('/api/bonificacao/perfis', {
      nome: 'TESTE HTTP Perfil', unidades: ['TESTE_HTTP_UN'],
      percentualPool: 1, splitMetasOutras: 70, splitGerente: 60, splitGerenteOutras: 25,
      metricasGerente: [{ label: 'Faturamento', peso: 100 }],
      metricasColaboradores: [{ label: 'Assiduidade', peso: 100 }],
    }, cabMasterBonif);
    const perfilCriado = JSON.parse(rCriar.corpo || '{}');

    const rLista = await pedir('/api/bonificacao/perfis', cabMasterBonif);
    const lista = JSON.parse(rLista.corpo || '[]');

    const rApuracao1 = await pedir('/api/bonificacao?unidade=TESTE_HTTP_UN&mes=2026-08', cabMasterBonif);
    const apuracao1 = JSON.parse(rApuracao1.corpo || '{}');
    // unidade sem NENHUM perfil configurado (Master, então passa do guard de
    // unidade - o que muda aqui é só a resposta de "sem perfil")
    const rSemPerfilNenhum = await pedir('/api/bonificacao?unidade=TESTE_HTTP_UN_SEM_PERFIL&mes=2026-08', cabMasterBonif);
    const semPerfilNenhum = JSON.parse(rSemPerfilNenhum.corpo || '{}');

    const rSalvar = await putJson('/api/bonificacao', {
      unidade: 'TESTE_HTTP_UN', mes: '2026-08',
      completionsGerente: [{ campo: 'faturamento', percentual: 90 }],
      completionsColaboradores: [{ campo: 'assiduidade', percentual: 80 }],
    }, cabMasterBonif);
    const apuracaoSalva = JSON.parse(rSalvar.corpo || '{}');

    // ---- gerente/assistente não pode receber a bonificação 2x ----
    // dois funcionários ativos na unidade: um "colaborador" comum e um que
    // vai virar "gerente" (marcado excluirBonificacao) - antes de marcar,
    // os dois contam na divisão; depois, só o comum conta
    DOCS.set('rhFuncionarios/f-bonif-colab', {
      id: 'f-bonif-colab', unidade: 'TESTE_HTTP_UN', nome: 'Colaborador Comum',
      status: 'ativo', atestados: [], emAtestado: false, atestadoAtual: null, criadoEm: new Date().toISOString(),
    });
    DOCS.set('rhFuncionarios/f-bonif-gerente', {
      id: 'f-bonif-gerente', unidade: 'TESTE_HTTP_UN', nome: 'Gerente da Unidade', cargoFuncao: 'Gerente',
      status: 'ativo', atestados: [], emAtestado: false, atestadoAtual: null, criadoEm: new Date().toISOString(),
    });
    // DOCS.set() escreve direto no Firestore falso, por fora do módulo -
    // sem invalidar, o cache de 60s do rh.js (já aquecido pelos testes de
    // RH anteriores nesta mesma suíte) continuava devolvendo a lista velha
    require('./rh').invalidar();
    const apuracaoAntesExcluir = JSON.parse((await pedir('/api/bonificacao?unidade=TESTE_HTTP_UN&mes=2026-08', cabMasterBonif)).corpo || '{}');

    const rEquipeAntes = await pedir('/api/bonificacao/equipe?unidade=TESTE_HTTP_UN', cabMasterBonif);
    const equipeAntes = JSON.parse(rEquipeAntes.corpo || '[]');

    const rMarcarGerente = await putJson('/api/bonificacao/equipe/f-bonif-gerente/excluir', { excluir: true }, cabMasterBonif);
    const rEquipeDepois = await pedir('/api/bonificacao/equipe?unidade=TESTE_HTTP_UN', cabMasterBonif);
    const equipeDepois = JSON.parse(rEquipeDepois.corpo || '[]');
    const apuracaoDepoisExcluir = JSON.parse((await pedir('/api/bonificacao?unidade=TESTE_HTTP_UN&mes=2026-08', cabMasterBonif)).corpo || '{}');

    const rResumo = await pedir('/api/bonificacao/resumo?mes=2026-08', cabMasterBonif);
    const resumo = JSON.parse(rResumo.corpo || '{}');

    // usuário comum, só com a seção e a PRÓPRIA unidade - prova que a rota
    // usa permissions.unidades igual o resto do app (sem bypass de Admin
    // "vê tudo", que era o bug original desta rota antes de revisar)
    const bcrypt = require('bcryptjs');
    DOCS.set('users/u-bonif-teste', {
      passwordHash: bcrypt.hashSync('SenhaDeTeste!2026', 4), role: 'user', active: true,
      email: 'bonif-teste@teste.local', username: 'bonifteste',
      permissions: { sections: ['bonificacao'], unidades: ['TESTE_HTTP_UN'], vaultSubgroups: [], tiposSolicitacao: [] },
      createdAt: new Date().toISOString(),
    });
    const tokenBonifLimitado = (await auth.login('bonif-teste@teste.local', 'SenhaDeTeste!2026')).token;
    const cabLimitado = { Authorization: 'Bearer ' + tokenBonifLimitado };
    const rDentro = await pedir('/api/bonificacao?unidade=TESTE_HTTP_UN&mes=2026-08', cabLimitado);
    const rUnidadeFora = await pedir('/api/bonificacao?unidade=UNIDADE_QUE_NAO_TA_NO_ACESSO&mes=2026-08', cabLimitado);
    // usuário comum (sem Admin) não vê nem mexe na equipe - é decisão
    // administrativa, mesma régua de Perfis (requireMasterOrAdmin)
    const rEquipeSemAdmin = await pedir('/api/bonificacao/equipe?unidade=TESTE_HTTP_UN', cabLimitado);

    const rFechar = await postarJson('/api/bonificacao/fechar', { unidade: 'TESTE_HTTP_UN', mes: '2026-08' }, cabMasterBonif);
    const apuracaoFechada = JSON.parse(rFechar.corpo || '{}');

    // quem NÃO é Master/Admin continua travado depois de fechada - a trava
    // só abriu pra Master/Admin corrigir (ver salvarCompletions abaixo)
    const rSalvarFechadaNaoMaster = await putJson('/api/bonificacao', {
      unidade: 'TESTE_HTTP_UN', mes: '2026-08', completionsGerente: [], completionsColaboradores: [],
    }, cabLimitado);

    // quem não pode editar pede revisão - vira aviso visível na apuração
    // (ap-revisao-aviso na tela) + push pro Master
    const rPedirRevisao = await postarJson('/api/bonificacao/pedir-revisao', {
      unidade: 'TESTE_HTTP_UN', mes: '2026-08', motivo: 'taxa do gerente parece errada',
    }, cabLimitado);
    const apuracaoComRevisao = JSON.parse((await pedir('/api/bonificacao?unidade=TESTE_HTTP_UN&mes=2026-08', cabMasterBonif)).corpo || '{}');

    // resetar é Master/Admin, mesma régua de fechar - usuário comum toma 403
    const rResetarSemAdmin = await postarJson('/api/bonificacao/resetar', { unidade: 'TESTE_HTTP_UN', mes: '2026-08' }, cabLimitado);

    // Master CORRIGE mesmo com a apuração fechada - continua fechada
    // (não reabre sozinha), ganha editadoPorEmail, e o pedido de revisão
    // pendente é dado como resolvido
    const rSalvarDepoisDeFechado = await putJson('/api/bonificacao', {
      unidade: 'TESTE_HTTP_UN', mes: '2026-08',
      completionsGerente: [{ campo: 'faturamento', percentual: 50 }],
      completionsColaboradores: [{ campo: 'assiduidade', percentual: 50 }],
    }, cabMasterBonif);
    const apuracaoCorrigida = JSON.parse(rSalvarDepoisDeFechado.corpo || '{}');

    // "reseta em caso de erro" - some com o que foi salvo, volta pro
    // estado limpo (rascunho, sem editadoPorEmail/fechadoPorEmail)
    const rResetar = await postarJson('/api/bonificacao/resetar', { unidade: 'TESTE_HTTP_UN', mes: '2026-08' }, cabMasterBonif);
    const apuracaoResetada = JSON.parse(rResetar.corpo || '{}');

    const rSemAuth = await pedir('/api/bonificacao?unidade=TESTE_HTTP_UN&mes=2026-08');

    const rExcluir = await pedirJsonDelete('/api/bonificacao/perfis/' + perfilCriado.id, cabMasterBonif);

    const conf = {
      'POST cria o perfil e devolve o id': rCriar.status === 200 && !!perfilCriado.id,
      'GET lista traz o perfil criado': lista.some((p) => p.id === perfilCriado.id),
      'GET apuração acha o perfil pela unidade': apuracao1.perfilNome === 'TESTE HTTP Perfil' && apuracao1.status === 'rascunho',
      'unidade sem perfil nenhum devolve semPerfil (não inventa default)': semPerfilNenhum.semPerfil === true,
      'PUT grava as completions e recalcula (90% de taxa)': apuracaoSalva.taxaGerente === 90 && apuracaoSalva.status === 'rascunho',
      'GET resumo do mês inclui a unidade': (resumo.porUnidade || []).some((u) => u.unidade === 'TESTE_HTTP_UN'),
      // Histórico mostra por colaborador/quantidade/total (não só o total) -
      // aqui a exclusão do gerente já rodou (linha 5499), então só 1 conta
      'GET resumo traz por colaborador/quantidade junto do total, batendo com a divisão': (() => {
        const u = (resumo.porUnidade || []).find((x) => x.unidade === 'TESTE_HTTP_UN');
        return !!u && u.colabQuantidade === 1 && Math.abs(u.colabPorPessoa * u.colabQuantidade - u.colabTotal) < 0.02;
      })(),
      'usuário comum com a unidade no acesso consegue ler a própria apuração': rDentro.status === 200,
      'o MESMO usuário não alcança unidade fora do próprio acesso (404)': rUnidadeFora.status === 404,
      'usuário comum (sem Admin) não acessa a equipe (403)': rEquipeSemAdmin.status === 403,
      'antes de marcar, os 2 funcionários contam na divisão de colaboradores': apuracaoAntesExcluir.colaboradoresResumo.quantidade === 2,
      'GET equipe lista os 2, nenhum marcado ainda': equipeAntes.length === 2 && equipeAntes.every((f) => !f.excluirBonificacao),
      'PUT marca o gerente como excluído': rMarcarGerente.status === 200,
      'GET equipe reflete a marcação': equipeDepois.find((f) => f.id === 'f-bonif-gerente').excluirBonificacao === true,
      'depois de marcar, só o colaborador comum conta na divisão (não recebe 2x)': apuracaoDepoisExcluir.colaboradoresResumo.quantidade === 1,
      'POST fechar muda o status pra fechado': rFechar.status === 200 && apuracaoFechada.status === 'fechado',
      'quem não é Master/Admin continua travado depois de fechada': rSalvarFechadaNaoMaster.status === 400,
      'pedir revisão funciona e fica visível na apuração': rPedirRevisao.status === 200
        && !!apuracaoComRevisao.revisaoPedida && apuracaoComRevisao.revisaoPedida.motivo === 'taxa do gerente parece errada',
      'resetar é Master/Admin - usuário comum toma 403': rResetarSemAdmin.status === 403,
      'Master CORRIGE mesmo com a apuração fechada (continua fechada, recalcula)':
        rSalvarDepoisDeFechado.status === 200 && apuracaoCorrigida.status === 'fechado' && apuracaoCorrigida.taxaGerente === 50,
      'a correção registra quem editou depois de fechada': !!apuracaoCorrigida.editadoPorEmail,
      'a correção dá o pedido de revisão pendente como resolvido': apuracaoCorrigida.revisaoPedida === null,
      'resetar apaga tudo e volta pra rascunho limpo': rResetar.status === 200
        && apuracaoResetada.status === 'rascunho' && apuracaoResetada.taxaGerente === 0 && apuracaoResetada.editadoPorEmail === null,
      'sem token nenhum, a rota exige login (401)': rSemAuth.status === 401,
      'DELETE remove o perfil de teste (limpeza)': rExcluir.status === 200,
    };
    const ruinsBR = Object.entries(conf).filter(([, ok]) => !ok).map(([n]) => n);
    okBonifRotas = !ruinsBR.length;
    if (ruinsBR.length) console.log(`  falhou em: ${ruinsBR.join(' · ')}`);
  } catch (e) { okBonifRotas = false; console.log('  erro: ' + e.message); }
  if (!okBonifRotas) ruins += 1;
  console.log(`${okBonifRotas ? '✓' : '✗'} Bonificação: as rotas de verdade (perfil → apuração → fechar → resumo) respondem pela porta`);

  // ------------------------------------------------------------------
  // Relatório de chamados (central-historico.html): filtro dedicado por
  // Ticket #, Status, e as janelas de data que dataDe/dataAte (abertura) não
  // cobria - Fechamento (decididoEm) e Interação (mensagens do chat, via
  // centralChat). Isola por numeroTicket (globalmente único) em vez de
  // depender de "nenhum outro ticket bate" - a suíte inteira já criou muita
  // coisa até aqui.
  let okRelatorioChamados = false;
  try {
    const cab = token ? { Authorization: 'Bearer ' + token } : {};
    const hoje = new Date().toISOString().slice(0, 10);
    const amanha = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

    const criarA = await postarJson('/api/solicitacoes', {
      tipo: 'compra', unidade: 'AERO', unidadeNome: 'Aeroporto', titulo: 'Relatório teste A', valorEstimado: 10,
    }, cab);
    const ticketA = JSON.parse(criarA.corpo || '{}');
    await enviarJson('PATCH', `/api/solicitacoes/${ticketA.id}/status`, { status: 'APROVADO', motivoDecisao: 'ok compra' }, cab);
    await postarJson(`/api/central/compra/${ticketA.id}/chat`, { texto: 'mensagem de teste' }, cab);

    const criarB = await postarJson('/api/solicitacoes', {
      tipo: 'compra', unidade: 'AERO', unidadeNome: 'Aeroporto', titulo: 'Relatório teste B', valorEstimado: 20,
    }, cab);
    const ticketB = JSON.parse(criarB.corpo || '{}');

    const buscar = (qs) => pedir(`/api/central/relatorio.json?${qs}`, cab).then((r) => ({ status: r.status, itens: JSON.parse(r.corpo || '[]') }));

    const rTicketA = await buscar(`ticket=${ticketA.numeroTicket}`);
    const rTicketAStatusErrado = await buscar(`ticket=${ticketA.numeroTicket}&status=REJEITADO`);
    const rTicketB = await buscar(`ticket=${ticketB.numeroTicket}`);
    const rFechamentoSemDecisao = await buscar(`ticket=${ticketB.numeroTicket}&fechamentoDe=${hoje}`);
    // só fechamentoAte (sem De): ticket sem decisão tem decididoEm='' - sem
    // a trava explícita, '' <= qualquer data bate por comparação de string
    const rFechamentoAteSemDecisao = await buscar(`ticket=${ticketB.numeroTicket}&fechamentoAte=${amanha}`);
    const rFechamentoNoRange = await buscar(`ticket=${ticketA.numeroTicket}&fechamentoDe=${hoje}&fechamentoAte=${hoje}`);
    const rInteracaoBate = await buscar(`ticket=${ticketA.numeroTicket}&interacaoUsuario=${encodeURIComponent('master')}`);
    const rInteracaoSemChat = await buscar(`ticket=${ticketB.numeroTicket}&interacaoUsuario=${encodeURIComponent('master')}`);
    const rInteracaoForaDaData = await buscar(`ticket=${ticketA.numeroTicket}&interacaoDe=${amanha}`);
    const rSemFiltro = await pedir('/api/central/relatorio.json', cab);

    const conf = {
      'formato json existe e devolve o ticket certo pelo número, já aprovado': rTicketA.status === 200 && rTicketA.itens.length === 1
        && rTicketA.itens[0].id === ticketA.id && rTicketA.itens[0].status === 'APROVADO',
      'status errado some com o resultado (filtro de fato filtra)': rTicketAStatusErrado.itens.length === 0,
      'ticket pendente sem decisão aparece sozinho': rTicketB.status === 200 && rTicketB.itens.length === 1 && rTicketB.itens[0].status === 'PENDENTE',
      'ticket sem decisão some quando filtra por fechamento': rFechamentoSemDecisao.itens.length === 0,
      'ticket sem decisão some mesmo só com fechamentoAte (sem De)': rFechamentoAteSemDecisao.itens.length === 0,
      'ticket decidido hoje aparece na janela de fechamento hoje': rFechamentoNoRange.itens.length === 1,
      'usuário da interação bate com quem mandou mensagem no chat': rInteracaoBate.itens.length === 1,
      'ticket sem NENHUMA mensagem some do filtro de interação': rInteracaoSemChat.itens.length === 0,
      'interação fora da data (amanhã) não bate com mensagem de hoje': rInteracaoForaDaData.itens.length === 0,
      'sem filtro nenhum, exige pelo menos um antes de exportar CSV/PDF - mas json não bloqueia, é só a tela que valida': rSemFiltro.status === 200,
    };
    const ruinsRC = Object.entries(conf).filter(([, ok]) => !ok).map(([n]) => n);
    okRelatorioChamados = !ruinsRC.length;
    if (ruinsRC.length) console.log(`  falhou em: ${ruinsRC.join(' · ')}`);
  } catch (e) { okRelatorioChamados = false; console.log('  erro: ' + e.message); }
  if (!okRelatorioChamados) ruins += 1;
  console.log(`${okRelatorioChamados ? '✓' : '✗'} Relatório de chamados: Ticket #/Status/Fechamento/Interação filtram de verdade (não só passam direto)`);

  // ------------------------------------------------------------------
  // Central -> Histórico: dropdown "Loja" agrupado por nome (não por código).
  // Uma mesma loja pode ter mais de um código histórico cadastrado (espaços
  // de código diferentes - ver CLAUDE.md "unificação de unidades", encerrada,
  // não mexer no mapeamento) - o filtro tinha que ficar preso a UM código só,
  // fazendo "Dom Bessa" aparecer 2-3 vezes na lista com o mesmo rótulo. O
  // fix é só de apresentação: o dropdown manda todos os códigos daquele nome
  // juntos (separados por vírgula, no mesmo "unidade=A,B" que já existe pro
  // filtro de "tipo"), e filtrarCardsCentral() casa qualquer um deles.
  let okFiltroUnidadeMultiCodigo = false;
  try {
    const cab = token ? { Authorization: 'Bearer ' + token } : {};
    const codA = 'MULTICOD-A', codB = 'MULTICOD-B', codC = 'MULTICOD-C';

    const criarA = await postarJson('/api/solicitacoes', {
      tipo: 'compra', unidade: codA, unidadeNome: 'Loja Multicódigo', titulo: 'Multicódigo A', valorEstimado: 5,
    }, cab);
    const ticketA = JSON.parse(criarA.corpo || '{}');
    const criarB = await postarJson('/api/solicitacoes', {
      tipo: 'compra', unidade: codB, unidadeNome: 'Loja Multicódigo', titulo: 'Multicódigo B', valorEstimado: 5,
    }, cab);
    const ticketB = JSON.parse(criarB.corpo || '{}');
    const criarC = await postarJson('/api/solicitacoes', {
      tipo: 'compra', unidade: codC, unidadeNome: 'Outra Loja', titulo: 'Multicódigo C (loja diferente)', valorEstimado: 5,
    }, cab);
    const ticketC = JSON.parse(criarC.corpo || '{}');

    const buscar = (qs) => pedir(`/api/central/relatorio.json?${qs}`, cab).then((r) => JSON.parse(r.corpo || '[]').map((c) => c.id));

    const idsJuntos = await buscar(`unidade=${codA},${codB}`);
    const idsSoA = await buscar(`unidade=${codA}`);
    const idsSoC = await buscar(`unidade=${codC}`);

    const htmlCH = require('fs').readFileSync(require('path').join(__dirname, 'public', 'central-historico.html'), 'utf8');

    const conf = {
      'unidade=A,B (dropdown agrupado por nome) traz os 2 tickets da mesma loja': idsJuntos.includes(ticketA.id) && idsJuntos.includes(ticketB.id),
      'unidade=A,B não vaza pra loja diferente (C fica de fora)': !idsJuntos.includes(ticketC.id),
      'unidade=A sozinho continua sem trazer B (não virou "qualquer coisa bate")': idsSoA.includes(ticketA.id) && !idsSoA.includes(ticketB.id),
      'unidade=C (código isolado) traz só o próprio, sem A nem B': idsSoC.length === 1 && idsSoC[0] === ticketC.id,
      'dropdown "Loja" agrupa os códigos por nome resolvido (1 <option> por nome, não por código)':
        /codigosPorNome\.get\(nome\)\.join\(','\)/.test(htmlCH) && /const codigosPorNome = new Map\(\);/.test(htmlCH),
      'filtro em tela (renderKanban) casa qualquer código do grupo, não só o primeiro selecionado':
        /const codigosUnidade = FILTRO_UNIDADE\.split\(','\); base = base\.filter\(c=>codigosUnidade\.includes\(c\.unidade\)\);/.test(htmlCH),
    };
    const ruinsFU = Object.entries(conf).filter(([, ok]) => !ok).map(([n]) => n);
    okFiltroUnidadeMultiCodigo = !ruinsFU.length;
    if (ruinsFU.length) console.log(`  falhou em: ${ruinsFU.join(' · ')}`);
  } catch (e) { okFiltroUnidadeMultiCodigo = false; console.log('  erro: ' + e.message); }
  if (!okFiltroUnidadeMultiCodigo) ruins += 1;
  console.log(`${okFiltroUnidadeMultiCodigo ? '✓' : '✗'} Central -> Histórico: filtro "Loja" casa todos os códigos históricos da mesma unidade (dropdown não duplica mais o nome)`);

  // Início (resumo pessoal - por status/unidade + meus abertos/concluídos):
  // nasceu dentro do Histórico e foi pra página própria (central-inicio.html)
  // porque misturado com o quadro do Histórico ficava bagunçado (pedido do
  // usuário). Sem rota nova (roda sobre /api/central igual ao Histórico),
  // então a checagem é de fonte - a parte que mais quebra sem avisar é
  // alguém tirar a chamada de renderInicio() de dentro de carregarCentral()
  // (widget para de atualizar silenciosamente) ou "meus" desviar da regra
  // de 3 partes que todosCardsCentral usa no servidor (criadoPorId/
  // direcionadoParaId/atribuidosIds - ver index.js)
  let okInicioWidget = false;
  try {
    const html = require('fs').readFileSync(require('path').join(__dirname, 'public', 'central-inicio.html'), 'utf8');
    const historico = require('fs').readFileSync(require('path').join(__dirname, 'public', 'central-historico.html'), 'utf8');
    const conf = {
      'renderInicio existe na página própria': /function renderInicio\(\)/.test(html),
      'carregarCentral() chama renderInicio (senão o widget nunca atualiza)':
        /async function carregarCentral\(\)\{[\s\S]*?renderInicio\(\);[\s\S]*?\n\}/.test(html),
      'souEuCard cobre as 3 partes de "meu" (mesma regra do todosCardsCentral)':
        /souEuCard\(c\)\{[\s\S]{0,300}criadoPorId===ME\.id[\s\S]{0,100}direcionadoParaId===ME\.id[\s\S]{0,150}atribuidosIds[\s\S]{0,50}\}/.test(html),
      'os 4 containers do widget existem no HTML': ['inicio-status-corpo', 'inicio-unidade-corpo', 'inicio-meus-corpo', 'inicio-concluidos-corpo']
        .every((id) => html.includes(`id="${id}"`)),
      'meus abertos e meus concluídos reaproveitam o card do Relatório (rcCardHtml)': (() => {
        const i = html.indexOf('function renderInicio()');
        return i >= 0 && /rcCardHtml/.test(html.slice(i, i + 2000));
      })(),
      'de verdade separado do Histórico - não sobrou o widget duplicado lá': !historico.includes('id="inicio-status-corpo"'),
    };
    const ruinsInicio = Object.entries(conf).filter(([, ok]) => !ok).map(([n]) => n);
    okInicioWidget = !ruinsInicio.length;
    if (ruinsInicio.length) console.log(`  falhou em: ${ruinsInicio.join(' · ')}`);
  } catch (e) { okInicioWidget = false; console.log('  erro: ' + e.message); }
  if (!okInicioWidget) ruins += 1;
  console.log(`${okInicioWidget ? '✓' : '✗'} Início: widget pessoal (por status/unidade + meus abertos/concluídos) tem página própria, separada do Histórico`);

  // ---------- rh.js: férias como estado ATIVO (novo, reversível) ----------
  // dataUltimasFerias so alimenta o alerta de vencimento (NR-7) - nunca foi
  // um estado "de ferias AGORA". Este par (registrarFerias/
  // registrarRetornoFerias) e novo, mesmo desenho reversivel do atestado,
  // so que com retorno OBRIGATORIO (pedido do usuario: ferias sempre tem
  // data de volta) e sem restricao de tipoCadastro (atestado so vale pra
  // quem nao e extra; ferias vale pra qualquer ativo).
  let okFeriasRh = false;
  try {
    const rh = require('./rh');
    DOCS.set('rhFuncionarios/f-ferias-1', {
      id: 'f-ferias-1', unidade: 'TESTE_FERIAS_UN', nome: 'Beltrano Ferias', tipoCadastro: 'extra',
      status: 'ativo', atestados: [], emAtestado: false, atestadoAtual: null,
      ferias: [], emFerias: false, feriasAtual: null, criadoEm: new Date().toISOString(),
    });
    DOCS.set('rhFuncionarios/f-ferias-inativo', {
      id: 'f-ferias-inativo', unidade: 'TESTE_FERIAS_UN', nome: 'Inativo Teste',
      status: 'inativo', atestados: [], emAtestado: false, atestadoAtual: null,
      ferias: [], emFerias: false, feriasAtual: null, criadoEm: new Date().toISOString(),
    });
    rh.invalidar();

    const semRetorno = await rh.registrarFerias('f-ferias-1', { inicio: '2026-08-01', retornoPrevisto: '', porEmail: 'teste@local' }).then(() => true).catch(() => false);
    const emInativo = await rh.registrarFerias('f-ferias-inativo', { inicio: '2026-08-01', retornoPrevisto: '2026-08-15', porEmail: 'teste@local' }).then(() => true).catch(() => false);
    const registrado = await rh.registrarFerias('f-ferias-1', { inicio: '2026-08-01', retornoPrevisto: '2026-08-15', porEmail: 'teste@local' });
    const dupla = await rh.registrarFerias('f-ferias-1', { inicio: '2026-08-02', retornoPrevisto: '2026-08-16', porEmail: 'teste@local' }).then(() => true).catch(() => false);
    const retornoEmQuemNaoEsta = await rh.registrarRetornoFerias('f-ferias-inativo', { porEmail: 'teste@local' }).then(() => true).catch(() => false);
    const retornou = await rh.registrarRetornoFerias('f-ferias-1', { porEmail: 'teste@local' });

    // sabotagem-alvo: desligar() enquanto ainda de ferias tem que zerar o
    // flag tambem - senao uma reativacao futura volta com ferias fantasma
    await rh.registrarFerias('f-ferias-1', { inicio: '2026-09-01', retornoPrevisto: '2026-09-15', porEmail: 'teste@local' });
    const desligadoDeFerias = await rh.desligar('f-ferias-1', { motivo: 'teste', porEmail: 'teste@local' });

    const conf = {
      'retorno vazio é recusado (obrigatório, diferente do atestado)': semRetorno === false,
      'registrar férias em inativo é recusado': emInativo === false,
      'registrar férias grava emFerias sem mudar status, mesmo pra tipoCadastro extra': registrado.emFerias === true && registrado.status === 'ativo' && registrado.feriasAtual.retornoPrevisto === '2026-08-15',
      'dupla férias é recusada': dupla === false,
      'retorno em quem não está de férias é recusado': retornoEmQuemNaoEsta === false,
      'retorno limpa o estado e empurra pro histórico': retornou.emFerias === false && retornou.feriasAtual === null && retornou.ferias.length === 1 && !!retornou.ferias[0].retorno,
      'desligar() enquanto em férias também zera emFerias/feriasAtual': desligadoDeFerias.emFerias === false && desligadoDeFerias.feriasAtual === null && desligadoDeFerias.status === 'inativo',
    };
    const ruinsFR = Object.entries(conf).filter(([, ok]) => !ok).map(([n]) => n);
    okFeriasRh = !ruinsFR.length;
    if (ruinsFR.length) console.log(`  falhou em: ${ruinsFR.join(' · ')}`);
  } catch (e) { okFeriasRh = false; console.log('  erro: ' + e.message); }
  if (!okFeriasRh) ruins += 1;
  console.log(`${okFeriasRh ? '✓' : '✗'} RH: férias é estado reversível (retorno obrigatório) e desligar() zera férias fantasma`);

  // ---------- Acesso de pessoa (tipo 'acesso-pessoa'): checklist com confirmação humana ----------
  // Gerente avisa desligamento/férias (Central ou Beniboy) - o ticket vira
  // um checklist de 3 sistemas (login/RH/operador do Abastecimento) que o
  // Master confirma um a um. NUNCA bloqueia sozinho: o login não guarda o
  // nome da pessoa (só email/username), então os candidatos são só
  // sugestão (ver acessosPessoa.js). Cobre o ciclo completo e o ponto de
  // sincronia do perfil por unidade (unidades.js TIPOS_SOLICITACAO_VALIDOS
  // - sem ele, uma unidade com perfil restrito não consegue nem cadastrar
  // 'acesso-pessoa' na própria lista de tipos aceitos).
  let okAcessoPessoa = false;
  try {
    const cab = token ? { Authorization: 'Bearer ' + token } : {};
    const rh = require('./rh');
    const users = require('./users');
    const unidades = require('./unidades');
    const abastecimentoCarrinho = require('./abastecimentoCarrinho');
    const bcrypt = require('bcryptjs');

    const semRetorno = await postarJson('/api/solicitacoes', {
      tipo: 'acesso-pessoa', unidade: 'TESTE_ACESSO_UN', unidadeNome: 'Teste Acesso',
      titulo: 'x', nomePessoa: 'Fulano Testado', motivoAcesso: 'ferias', dataEfetiva: '2026-08-01',
    }, cab);
    const motivoInvalido = await postarJson('/api/solicitacoes', {
      tipo: 'acesso-pessoa', unidade: 'TESTE_ACESSO_UN', unidadeNome: 'Teste Acesso',
      titulo: 'x', nomePessoa: 'Fulano Testado', motivoAcesso: 'demissao', dataEfetiva: '2026-08-01',
    }, cab);

    const criarFerias = await postarJson('/api/solicitacoes', {
      tipo: 'acesso-pessoa', unidade: 'TESTE_ACESSO_UN', unidadeNome: 'Teste Acesso',
      titulo: 'Férias — Fulano Testado', nomePessoa: 'Fulano Testado', motivoAcesso: 'ferias',
      dataEfetiva: '2026-08-01', dataRetornoPrevista: '2026-08-15',
    }, cab);
    const ticketFerias = JSON.parse(criarFerias.corpo || '{}');

    const criarDesligamento = await postarJson('/api/solicitacoes', {
      tipo: 'acesso-pessoa', unidade: 'TESTE_ACESSO_UN', unidadeNome: 'Teste Acesso',
      titulo: 'Desligamento — Ciclano Sumido', nomePessoa: 'Ciclano Sumido', motivoAcesso: 'desligamento',
      dataEfetiva: '2026-08-01',
    }, cab);
    const ticketDesligamento = JSON.parse(criarDesligamento.corpo || '{}');

    const criarPendente = await postarJson('/api/solicitacoes', {
      tipo: 'acesso-pessoa', unidade: 'TESTE_ACESSO_UN', unidadeNome: 'Teste Acesso',
      titulo: 'Desligamento — Nunca Aprovado', nomePessoa: 'Nunca Aprovado', motivoAcesso: 'desligamento', dataEfetiva: '2026-08-01',
    }, cab);
    const ticketPendente = JSON.parse(criarPendente.corpo || '{}');

    const criarCompraQualquer = await postarJson('/api/solicitacoes', {
      tipo: 'compra', unidade: 'TESTE_ACESSO_UN', unidadeNome: 'Teste Acesso', titulo: 'Compra qualquer', valorEstimado: 1,
    }, cab);
    const ticketCompraQualquer = JSON.parse(criarCompraQualquer.corpo || '{}');

    // candidatos: RH (nome+unidade), login (heurística nome->username, MESMA
    // unidade) e operador do Abastecimento (só nome, sem unidade - o cadastro
    // não tem esse campo)
    DOCS.set('rhFuncionarios/f-acesso-1', {
      id: 'f-acesso-1', unidade: 'TESTE_ACESSO_UN', nome: 'Fulano Testado',
      status: 'ativo', atestados: [], emAtestado: false, atestadoAtual: null,
      ferias: [], emFerias: false, feriasAtual: null, criadoEm: new Date().toISOString(),
    });
    rh.invalidar();
    DOCS.set('users/u-acesso-dentro', {
      passwordHash: bcrypt.hashSync('SenhaDeTeste!2026', 4), role: 'user', active: true,
      email: 'fulano.testado@teste.local', username: 'fulano',
      permissions: { sections: ['solicitacoes'], unidades: ['TESTE_ACESSO_UN'], vaultSubgroups: [], tiposSolicitacao: [] },
      createdAt: new Date().toISOString(),
    });
    // MESMO username (bate na heurística), unidade DIFERENTE - prova que o
    // filtro de unidade é real, não só o nome
    DOCS.set('users/u-acesso-fora', {
      passwordHash: bcrypt.hashSync('SenhaDeTeste!2026', 4), role: 'user', active: true,
      email: 'outrafulano@teste.local', username: 'fulano',
      permissions: { sections: ['solicitacoes'], unidades: ['TESTE_ACESSO_OUTRA_UN'], vaultSubgroups: [], tiposSolicitacao: [] },
      createdAt: new Date().toISOString(),
    });
    users.invalidar();
    const operador = await abastecimentoCarrinho.criarOperador({ usuario: 'tstx', senha: '1234', nome: 'Fulano Testado', papel: 'pedido', criadoPorEmail: 'teste@local' });

    const candidatosAntesAprovar = await pedir(`/api/solicitacoes/${ticketFerias.id}/acesso-candidatos`, cab);
    const candidatosTipoErrado = await pedir(`/api/solicitacoes/${ticketCompraQualquer.id}/acesso-candidatos`, cab);

    await enviarJson('PATCH', `/api/solicitacoes/${ticketFerias.id}/status`, { status: 'APROVADO', motivoDecisao: 'ok' }, cab);
    await enviarJson('PATCH', `/api/solicitacoes/${ticketDesligamento.id}/status`, { status: 'APROVADO', motivoDecisao: 'ok' }, cab);

    const rCandidatos = await pedir(`/api/solicitacoes/${ticketFerias.id}/acesso-candidatos`, cab);
    const candidatos = JSON.parse(rCandidatos.corpo || '{}');

    // confirmar os 3 sistemas do ticket de FÉRIAS - bloqueio reversível
    const rConfirmarLogin = await enviarJson('PATCH', `/api/solicitacoes/${ticketFerias.id}/acesso/users`, { acao: 'confirmar', alvoId: 'u-acesso-dentro' }, cab);
    const loginAposConfirmar = await auth.login('fulano.testado@teste.local', 'SenhaDeTeste!2026').then(() => true).catch(() => false);

    const rConfirmarRh = await enviarJson('PATCH', `/api/solicitacoes/${ticketFerias.id}/acesso/rh`, { acao: 'confirmar', alvoId: 'f-acesso-1' }, cab);
    const funcionarioAposConfirmar = await rh.getOne('f-acesso-1');

    const rConfirmarAbastecimento = await enviarJson('PATCH', `/api/solicitacoes/${ticketFerias.id}/acesso/abastecimento`, { acao: 'confirmar', alvoId: operador.id }, cab);
    const operadorAposConfirmar = (await abastecimentoCarrinho.listarOperadores()).find((o) => o.id === operador.id);

    // "não encontrado" no ticket de DESLIGAMENTO - não desliga nada, só anota
    const rNaoEncontrado = await enviarJson('PATCH', `/api/solicitacoes/${ticketDesligamento.id}/acesso/rh`, { acao: 'nao-encontrado' }, cab);
    const naoEncontrado = JSON.parse(rNaoEncontrado.corpo || '{}');

    const concluirSemAprovar = await enviarJson('PATCH', `/api/solicitacoes/${ticketPendente.id}/acesso-concluido`, {}, cab);
    const concluirFerias = await enviarJson('PATCH', `/api/solicitacoes/${ticketFerias.id}/acesso-concluido`, {}, cab);

    const reativarDesligamento = await postarJson(`/api/solicitacoes/${ticketDesligamento.id}/acesso-reativar-tudo`, {}, cab);
    const reativarFerias = await postarJson(`/api/solicitacoes/${ticketFerias.id}/acesso-reativar-tudo`, {}, cab);
    const loginAposReativar = await auth.login('fulano.testado@teste.local', 'SenhaDeTeste!2026').then(() => true).catch(() => false);
    const funcionarioAposReativar = await rh.getOne('f-acesso-1');
    const operadorAposReativar = (await abastecimentoCarrinho.listarOperadores()).find((o) => o.id === operador.id);

    // ponto de sincronia: perfil de unidade restrito PRECISA aceitar
    // 'acesso-pessoa' explicitamente pra Master conseguir cadastrar o tipo
    // na própria lista aceita da unidade (unidades.js:TIPOS_SOLICITACAO_VALIDOS)
    const perfilRestrito = await unidades.upsertPerfil('TESTE_ACESSO_RESTRITA_UN', { nome: 'Restrita Teste', tiposSolicitacao: ['compra', 'acesso-pessoa'], porEmail: 'teste@local' });
    const rCriarNaRestritaPermitido = await postarJson('/api/solicitacoes', {
      tipo: 'acesso-pessoa', unidade: 'TESTE_ACESSO_RESTRITA_UN', unidadeNome: 'Restrita', titulo: 'x',
      nomePessoa: 'Fulano', motivoAcesso: 'desligamento', dataEfetiva: '2026-08-01',
    }, cab);
    const rCriarNaRestritaBloqueado = await postarJson('/api/solicitacoes', {
      tipo: 'manutencao', unidade: 'TESTE_ACESSO_RESTRITA_UN', unidadeNome: 'Restrita', titulo: 'x',
    }, cab);

    const conf = {
      'férias sem previsão de retorno é recusado (obrigatório)': semRetorno.status === 400,
      'motivoAcesso fora do enum é recusado': motivoInvalido.status === 400,
      'desligamento não exige data de retorno': criarDesligamento.status === 200 && !ticketDesligamento.dataRetornoPrevista,
      'título nasce sozinho, sem o gerente digitar': ticketFerias.titulo === 'Férias — Fulano Testado',
      'ticket nasce com acessoChecklist "tudo pendente"':
        ticketFerias.acessoChecklist.users.status === 'pendente' && ticketFerias.acessoChecklist.rh.status === 'pendente'
        && ticketFerias.acessoChecklist.abastecimento.status === 'pendente' && ticketFerias.acessoChecklist.concluido === false,
      'busca de candidatos funciona mesmo antes de Aprovado (é só leitura, sem mutação)': candidatosAntesAprovar.status === 200,
      'acesso-candidatos só funciona nesse tipo (400 pra compra)': candidatosTipoErrado.status === 400,
      'candidato de RH aparece por nome+unidade, entre os ativos': candidatos.rh.some((f) => f.id === 'f-acesso-1'),
      'candidato de login aparece pela heurística nome→username, MESMA unidade': candidatos.users.some((u) => u.id === 'u-acesso-dentro'),
      'usuário de OUTRA unidade não aparece, mesmo com username idêntico': !candidatos.users.some((u) => u.id === 'u-acesso-fora'),
      'candidato do Abastecimento aparece só por nome (sem unidade)': candidatos.abastecimento.some((o) => o.id === operador.id),
      'confirmar login bloqueia de verdade (login para de autenticar)': rConfirmarLogin.status === 200 && loginAposConfirmar === false,
      'confirmar RH com motivo férias marca emFerias (não desliga)': rConfirmarRh.status === 200 && funcionarioAposConfirmar.emFerias === true && funcionarioAposConfirmar.status === 'ativo',
      'confirmar Abastecimento com motivo férias só desativa (continua na lista)': rConfirmarAbastecimento.status === 200 && !!operadorAposConfirmar && operadorAposConfirmar.ativo === false,
      '"não encontrado" não desliga nada, só grava o estado': rNaoEncontrado.status === 200 && naoEncontrado.acessoChecklist.rh.status === 'nao-encontrado',
      'acesso-concluido exige status Aprovado': concluirSemAprovar.status === 400,
      'acesso-concluido funciona no ticket Aprovado': concluirFerias.status === 200,
      'reativar-tudo é recusado pra ticket de desligamento (só férias)': reativarDesligamento.status === 400,
      'reativar-tudo (férias) reativa o login': reativarFerias.status === 200 && loginAposReativar === true,
      'reativar-tudo (férias) encerra a férias no RH': funcionarioAposReativar.emFerias === false,
      'reativar-tudo (férias) reativa o operador do Abastecimento': !!operadorAposReativar && operadorAposReativar.ativo === true,
      'perfil restrito da unidade GUARDA acesso-pessoa na lista aceita (não filtra por engano)': perfilRestrito.tiposSolicitacao.includes('acesso-pessoa'),
      'unidade com perfil restrito, mas COM acesso-pessoa na lista, aceita criar': rCriarNaRestritaPermitido.status === 200,
      'a MESMA unidade restrita bloqueia um tipo que não está na lista (manutenção)': rCriarNaRestritaBloqueado.status === 400,
    };
    const ruinsAP = Object.entries(conf).filter(([, ok]) => !ok).map(([n]) => n);
    okAcessoPessoa = !ruinsAP.length;
    if (ruinsAP.length) console.log(`  falhou em: ${ruinsAP.join(' · ')}`);
  } catch (e) { okAcessoPessoa = false; console.log('  erro: ' + e.message); }
  if (!okAcessoPessoa) ruins += 1;
  console.log(`${okAcessoPessoa ? '✓' : '✗'} Acesso de pessoa: checklist com confirmação humana bloqueia/reativa os 3 sistemas de verdade`);

  // ------------------------------------------------------------------
  // Adiantamento: formulário assinado (formularios.js) -> ticket 'adiantamento'
  // na Central (NÃO 'pagamento', ver enviar-pagamento em index.js) -> só
  // finaliza pela prestação de contas (nota + valor gasto), nunca clicando
  // direto em "Finalizado" no Andamento. Cobre o pedido do usuário: "não
  // pode ficar no ar" sem alguém prestar contas do dinheiro adiantado.
  let okAdiantamento = false;
  try {
    const cab = { Authorization: 'Bearer ' + token };
    const solicitacoesMod = require('/home/user/adyen-monitor/server/solicitacoes.js');
    const form = require('/home/user/adyen-monitor/server/formularios.js');
    const bcrypt = require('bcryptjs');
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    // acesso comum (não Master, não Admin) - só pra provar que a prestação
    // de contas é MESMO Master/Admin-only, não basta ter a seção formularios
    DOCS.set('users/u-adiant-comum', {
      passwordHash: bcrypt.hashSync('SenhaDeTeste!2026', 4), role: 'user', active: true,
      email: 'comum.adiantamento@teste.local', username: 'comumadiant',
      permissions: { sections: ['formularios', 'solicitacoes'], unidades: ['São Braz Ilha do Leite'], vaultSubgroups: [], tiposSolicitacao: [] },
      createdAt: new Date().toISOString(),
    });
    require('/home/user/adyen-monitor/server/users.js').invalidar();
    const loginComum = await auth.login('comum.adiantamento@teste.local', 'SenhaDeTeste!2026');
    const cabComum = { Authorization: 'Bearer ' + loginComum.token };

    const criado = await postarMultipart('/api/formularios', {
      payload: JSON.stringify({
        tipo: 'adiantamento', unidade: 'São Braz Ilha do Leite',
        campos: { favorecido: 'Roberto Adiantado', cnpjFavorecido: '', banco: 'Nubank', agencia: '0001', conta: '55443-2', chavePix: 'roberto@pix.com' },
        linhas: [{ data: '20/08/2026', descricao: 'Compra emergencial de gás', valor: '500,00' }],
      }),
    }, null, 'anexos', cab);
    const f = criado.status === 200 ? JSON.parse(criado.corpo) : {};
    const tk = (lista, chave) => new URLSearchParams(String((lista.find((a) => a.chave === chave) || {}).link).split('?')[1]).get('t');

    await postarJson(`/api/formularios-publico/${f.id}/assinar`, { token: tk(f.assinaturas, 'favorecido'), nome: 'Roberto Adiantado', imagem: PNG });
    await postarJson(`/api/formularios-publico/${f.id}/assinar`, { token: tk(f.assinaturas, 'gerente'), nome: 'Gerente São Braz', imagem: PNG });

    const enviado = await postarJson(`/api/formularios/${f.id}/enviar-pagamento`, {}, cab);
    const dEnviado = enviado.status === 200 ? JSON.parse(enviado.corpo) : {};
    const ticketId = dEnviado.ticket && dEnviado.ticket.id;

    const ticketAntesAprovar = ticketId ? await solicitacoesMod.getOne(ticketId) : null;

    // tentar finalizar direto (via /execucao) antes de aprovar - e depois de
    // aprovado, mas SEM prestação de contas - os dois têm que ser recusados
    const finalizarPendente = ticketId ? await enviarJson('PATCH', `/api/solicitacoes/${ticketId}/execucao`, { execucaoStatus: 'FINALIZADO' }, cab) : { status: 0 };

    await enviarJson('PATCH', `/api/solicitacoes/${ticketId}/status`, { status: 'APROVADO', motivoDecisao: 'ok adiantamento' }, cab);

    const finalizarDireto = await enviarJson('PATCH', `/api/solicitacoes/${ticketId}/execucao`, { execucaoStatus: 'FINALIZADO' }, cab);
    const dFinalizarDireto = JSON.parse(finalizarDireto.corpo || '{}');
    const andamentoOk = await enviarJson('PATCH', `/api/solicitacoes/${ticketId}/execucao`, { execucaoStatus: 'EM_ANDAMENTO' }, cab);

    // prestação de contas: acesso comum é recusado (403), mesmo tendo a
    // seção formularios/solicitacoes - a rota é Master/Admin-only
    const pcComum = await enviarJson('PATCH', `/api/solicitacoes/${ticketId}/prestacao-contas`, { valorGasto: 480 }, cabComum);

    // tipo errado (compra) é recusado
    const compraQualquer = await postarJson('/api/solicitacoes', { tipo: 'compra', unidade: 'São Braz Ilha do Leite', titulo: 'Compra qualquer', valorEstimado: 1 }, cab);
    const dCompraQualquer = JSON.parse(compraQualquer.corpo || '{}');
    const pcTipoErrado = await enviarJson('PATCH', `/api/solicitacoes/${dCompraQualquer.id}/prestacao-contas`, { valorGasto: 1 }, cab);

    // sem valorGasto é recusado
    const pcSemValor = await enviarJson('PATCH', `/api/solicitacoes/${ticketId}/prestacao-contas`, {}, cab);

    // registra com sobra (gastou menos que os R$500 adiantados)
    const pcOk = await enviarJson('PATCH', `/api/solicitacoes/${ticketId}/prestacao-contas`, { valorGasto: 480 }, cab);
    const dPcOk = JSON.parse(pcOk.corpo || '{}');

    // agora SIM finaliza direto é recusado de novo (já tá finalizado, mas
    // por outro motivo - continua não sendo esse o caminho)
    const finalizarDepoisDeFechado = await enviarJson('PATCH', `/api/solicitacoes/${ticketId}/execucao`, { execucaoStatus: 'PENDENTE' }, cab);

    const desfazer = await enviarJson('DELETE', `/api/solicitacoes/${ticketId}/prestacao-contas`, {}, cab);
    const dDesfazer = JSON.parse(desfazer.corpo || '{}');

    const conf = {
      'formulário de Adiantamento existe e assina como Favorecido+Gerente (igual Avulso)': enviado.status === 200 && !!dEnviado.ticket,
      'vira ticket tipo "adiantamento" na Central, NÃO "pagamento"': !!ticketAntesAprovar && ticketAntesAprovar.tipo === 'adiantamento',
      'ticket nasce com valorEstimado = valor total do formulário (R$500)': !!ticketAntesAprovar && Number(ticketAntesAprovar.valorEstimado) === 500,
      'ticket nasce com prestacaoContas "pendente" (valorGasto null)': !!ticketAntesAprovar && ticketAntesAprovar.prestacaoContas && ticketAntesAprovar.prestacaoContas.valorGasto === null,
      'finalizar direto (/execucao) antes de aprovar é recusado (nem chega na trava de tipo)': finalizarPendente.status === 400,
      'finalizar direto (/execucao) depois de Aprovado é recusado - só pela prestação de contas': finalizarDireto.status === 400 && /prestação de contas/.test(dFinalizarDireto.error || ''),
      'Em Andamento continua liberado pelo /execucao normal (só Finalizado é travado)': andamentoOk.status === 200,
      'prestação de contas: acesso comum (não Master/Admin) é recusado, 403': pcComum.status === 403,
      'prestação de contas: tipo errado (compra) é recusado': pcTipoErrado.status === 400,
      'prestação de contas: sem valorGasto é recusado': pcSemValor.status === 400,
      'prestação de contas: registra e finaliza o Andamento sozinho': pcOk.status === 200 && dPcOk.execucaoStatus === 'FINALIZADO',
      'prestação de contas: diferença calculada certa (500 adiantado - 480 gasto = 20 de sobra)': Number(dPcOk.prestacaoContas.diferenca) === 20,
      'depois de fechado, /execucao continua recusando mudar (mesma trava, não é caso especial)': finalizarDepoisDeFechado.status === 400,
      'desfazer prestação de contas volta pra Em Andamento e limpa o valor': desfazer.status === 200 && dDesfazer.execucaoStatus === 'EM_ANDAMENTO' && dDesfazer.prestacaoContas.valorGasto === null,
    };
    const ruinsAD = Object.entries(conf).filter(([, ok]) => !ok).map(([n]) => n);
    okAdiantamento = !ruinsAD.length;
    if (ruinsAD.length) console.log(`  falhou em: ${ruinsAD.join(' · ')}`);
  } catch (e) { okAdiantamento = false; console.log('  erro: ' + e.message); }
  if (!okAdiantamento) ruins += 1;
  console.log(`${okAdiantamento ? '✓' : '✗'} Adiantamento: vira ticket próprio (não Pagamento) e só finaliza pela prestação de contas`);

  // ------------------------------------------------------------------
  // Painel de Saidas (Sangria/Deposito + "outras saidas" avulsas do
  // Fechamento, unificadas com estado de verificacao - ver saidasPainel.js).
  // Cobre: as duas fontes aparecem juntas, so Master/Admin verifica (nao a
  // propria loja), a chave de uma "saida avulsa" e validada contra o
  // fechamento de verdade (nao aceita indice inventado), verificar pode ser
  // desfeito, e o isolamento por grupo continua valendo (a rota so usa
  // auth.filterByUnidade, igual /api/fechamentos - "1 grupo não vê o outro"
  // era o pedido explícito do usuário).
  let okSaidasPainel = false;
  try {
    const bcrypt = require('bcryptjs');
    const cabMaster = { Authorization: 'Bearer ' + token };

    const fech = await postarJson('/api/fechamentos/lancar', {
      unidade: 'TESTE_SAIDA_ARC', unidadeNome: 'Loja Teste ARC', grupo: 'ARCFOOD', data: '2026-08-20',
      campos: { entradaDinheiro: 500 },
      detalhesSaidas: [
        { descricao: 'Motoboy extra (painel saidas)', valor: 37.5 },
        { descricao: 'Compra de gelo (painel saidas)', valor: 12 },
        // era assim que a planilha antiga da ARCFOOD lancava sangria: uma
        // "outra saida" com o texto na descricao (com acento, inclusive)
        { descricao: 'Sangriá do turno da noite', valor: 80 },
      ],
    }, cabMaster);
    const fechData = JSON.parse(fech.corpo);

    const sangria = await postarJson('/api/sangrias', {
      unidade: 'TESTE_SAIDA_BRAVO', unidadeNome: 'Loja Teste BRAVO', grupo: 'BRAVO', data: '2026-08-20',
      valor: 250, descricao: 'Sangria painel teste', periodoInicio: '2026-08-20', periodoFim: '2026-08-20',
      nomeDepositante: 'Fulano Teste', password: process.env.MASTER_PASSWORD,
    }, cabMaster);
    const sangriaData = JSON.parse(sangria.corpo);

    const senhaHash = bcrypt.hashSync('SenhaDeTeste!2026', 4);
    // loja: so a unidade ARCFOOD, secao sangria (nao lancamento) - ve a
    // lista mas nao consegue verificar (so Master/Admin, decisao do usuario)
    DOCS.set('users/u-saidas-loja', {
      passwordHash: senhaHash, role: 'user', active: true,
      email: 'saidas-loja@teste.local', username: 'saidasloja',
      permissions: { sections: ['sangria'], unidades: ['TESTE_SAIDA_ARC'], vaultSubgroups: [], tiposSolicitacao: [] },
      createdAt: new Date().toISOString(),
    });
    const tkLoja = (await auth.login('saidas-loja@teste.local', 'SenhaDeTeste!2026')).token;
    const cabLoja = { Authorization: 'Bearer ' + tkLoja };

    // Admin (nao Master, sem unidade nenhuma marcada) - prova que "Master OU
    // Admin" verifica de verdade
    DOCS.set('users/u-saidas-admin', {
      passwordHash: senhaHash, role: 'user', isAdmin: true, active: true,
      email: 'saidas-admin@teste.local', username: 'saidasadmin',
      permissions: { sections: ['lancamento', 'sangria'], unidades: [], vaultSubgroups: [], tiposSolicitacao: [] },
      createdAt: new Date().toISOString(),
    });
    const tkAdmin = (await auth.login('saidas-admin@teste.local', 'SenhaDeTeste!2026')).token;
    const cabAdmin = { Authorization: 'Bearer ' + tkAdmin };

    // Admin COM a unidade ARC: o Admin acima tem unidades:[] de proposito
    // (prova que Admin verifica sem ter unidade), mas por isso mesmo nao
    // enxerga linha nenhuma - nao serve pra provar o gate de Entrada/Saldo
    DOCS.set('users/u-saidas-admin-arc', {
      passwordHash: senhaHash, role: 'user', isAdmin: true, active: true,
      email: 'saidas-admin-arc@teste.local', username: 'saidasadminarc',
      permissions: { sections: ['lancamento', 'sangria'], unidades: ['TESTE_SAIDA_ARC'], vaultSubgroups: [], tiposSolicitacao: [] },
      createdAt: new Date().toISOString(),
    });
    const tkAdminArc = (await auth.login('saidas-admin-arc@teste.local', 'SenhaDeTeste!2026')).token;
    const cabAdminArc = { Authorization: 'Bearer ' + tkAdminArc };

    // BRAVO: so a unidade da sangria - prova o isolamento (nao ve a saida
    // avulsa da unidade ARCFOOD)
    DOCS.set('users/u-saidas-bravo', {
      passwordHash: senhaHash, role: 'user', active: true,
      email: 'saidas-bravo@teste.local', username: 'saidasbravo',
      permissions: { sections: ['sangria'], unidades: ['TESTE_SAIDA_BRAVO'], vaultSubgroups: [], tiposSolicitacao: [] },
      createdAt: new Date().toISOString(),
    });
    const tkBravo = (await auth.login('saidas-bravo@teste.local', 'SenhaDeTeste!2026')).token;
    const cabBravo = { Authorization: 'Bearer ' + tkBravo };

    const params = 'inicio=2026-08-20&fim=2026-08-20';
    // a rota devolve {itens, entradas} - "entradas" so vem preenchido pra
    // Master/Admin (base do Saldo, ver /api/saidas-painel)
    const respMaster = JSON.parse((await pedir(`/api/saidas-painel?${params}`, cabMaster)).corpo);
    const listaMaster = respMaster.itens;
    const itemSaida = listaMaster.find((it) => it.descricao === 'Motoboy extra (painel saidas)');
    const itemSangria = listaMaster.find((it) => it.chave === `sangria::${sangriaData.id}`);

    const respBravo = JSON.parse((await pedir(`/api/saidas-painel?${params}`, cabBravo)).corpo);
    const listaBravo = respBravo.itens;
    const respAdminArc = JSON.parse((await pedir(`/api/saidas-painel?${params}`, cabAdminArc)).corpo);
    // a loja TEM a unidade ARC (e ve as saidas dela) - se nao vier entrada
    // nenhuma, foi o gate de papel que barrou, nao o filtro de unidade
    const respLoja = JSON.parse((await pedir(`/api/saidas-painel?${params}`, cabLoja)).corpo);
    const listaGrupoArcfood = JSON.parse((await pedir(`/api/saidas-painel?${params}&grupo=ARCFOOD`, cabMaster)).corpo).itens;
    const listaGrupoBravo = JSON.parse((await pedir(`/api/saidas-painel?${params}&grupo=BRAVO`, cabMaster)).corpo).itens;

    // a conta do Saldo: entrada - saidas avulsas - sangria
    const somar = (arr) => arr.reduce((t, x) => t + (x.valor || 0), 0);
    const entradaArc = somar(respMaster.entradas.filter((e) => e.unidade === 'TESTE_SAIDA_ARC' && e.data === '2026-08-20'));
    const saidasArc = somar(listaMaster.filter((it) => it.origem === 'saida' && it.unidade === 'TESTE_SAIDA_ARC'));

    const rVerificarLoja = await enviarJson('PATCH', '/api/saidas-painel/verificar', { chave: itemSaida.chave, verificada: true }, cabLoja);
    const rChaveFalsa = await enviarJson('PATCH', '/api/saidas-painel/verificar', { chave: `${fechData.id}::99`, verificada: true }, cabAdmin);
    const rVerificarAdmin = await enviarJson('PATCH', '/api/saidas-painel/verificar', { chave: itemSaida.chave, verificada: true }, cabAdmin);
    const verificadaAdmin = JSON.parse(rVerificarAdmin.corpo);
    const rVerificarSangria = await enviarJson('PATCH', '/api/saidas-painel/verificar', { chave: itemSangria.chave, verificada: true }, cabMaster);
    const rDesfazerSangria = await enviarJson('PATCH', '/api/saidas-painel/verificar', { chave: itemSangria.chave, verificada: false }, cabMaster);
    const desfeita = JSON.parse(rDesfazerSangria.corpo);

    const listaDepois = JSON.parse((await pedir(`/api/saidas-painel?${params}`, cabMaster)).corpo).itens;
    const itemSaidaDepois = listaDepois.find((it) => it.chave === itemSaida.chave);

    // ---- mover saida avulsa -> Sangria/Deposito (pedido do Master) ----
    const itemFalsaSangria = listaMaster.find((it) => it.descricao === 'Sangriá do turno da noite');
    const nasceComoSaida = itemFalsaSangria.origem === 'saida' && !itemFalsaSangria.reclassificada;
    // Admin nao move: o Master pediu "so o master ter acesso"
    const rMoverAdmin = await enviarJson('PATCH', '/api/saidas-painel/reclassificar', { chave: itemFalsaSangria.chave, origem: 'sangria' }, cabAdminArc);
    // sangria de verdade (colecao propria) nao tem pra onde ir
    const rMoverSangriaReal = await enviarJson('PATCH', '/api/saidas-painel/reclassificar', { chave: itemSangria.chave, origem: 'sangria' }, cabMaster);
    const rMover = await enviarJson('PATCH', '/api/saidas-painel/reclassificar', { chave: itemFalsaSangria.chave, origem: 'sangria' }, cabMaster);
    const aposMover = JSON.parse((await pedir(`/api/saidas-painel?${params}`, cabMaster)).corpo).itens
      .find((it) => it.chave === itemFalsaSangria.chave);
    // mover nao pode apagar a verificacao ja feita (e vice-versa): os dois
    // estados moram no MESMO documento
    const rVerificarMovida = await enviarJson('PATCH', '/api/saidas-painel/verificar', { chave: itemFalsaSangria.chave, verificada: true }, cabMaster);
    const aposVerificar = JSON.parse((await pedir(`/api/saidas-painel?${params}`, cabMaster)).corpo).itens
      .find((it) => it.chave === itemFalsaSangria.chave);
    // desfazer volta pra saida avulsa sem perder a verificacao
    await enviarJson('PATCH', '/api/saidas-painel/reclassificar', { chave: itemFalsaSangria.chave, origem: null }, cabMaster);
    const aposDesfazer = JSON.parse((await pedir(`/api/saidas-painel?${params}`, cabMaster)).corpo).itens
      .find((it) => it.chave === itemFalsaSangria.chave);

    // em lote: "as que tem Sangria na descricao", dentro do filtro da tela
    const rLoteAdmin = await enviarJson('POST', '/api/saidas-painel/reclassificar-sangrias', { inicio: '2026-08-20', fim: '2026-08-20' }, cabAdminArc);
    const rLote = await enviarJson('POST', '/api/saidas-painel/reclassificar-sangrias', { inicio: '2026-08-20', fim: '2026-08-20' }, cabMaster);
    const loteData = JSON.parse(rLote.corpo);
    const aposLote = JSON.parse((await pedir(`/api/saidas-painel?${params}`, cabMaster)).corpo).itens;
    const movidaNoLote = aposLote.find((it) => it.chave === itemFalsaSangria.chave);
    const naoMexeuNoResto = aposLote.find((it) => it.chave === itemSaida.chave);

    const conf = {
      'as duas fontes aparecem juntas pro Master (sangria + saída avulsa)': !!itemSaida && !!itemSangria,
      'nasce tudo com verificada:false': itemSaida.verificada === false && itemSangria.verificada === false,
      '1 grupo não vê o outro: loja BRAVO não vê a saída avulsa do ARCFOOD':
        !listaBravo.some((it) => it.chave === itemSaida.chave),
      'filtro por grupo (query) bate com a franquia certa':
        listaGrupoArcfood.some((it) => it.chave === itemSaida.chave) && !listaGrupoArcfood.some((it) => it.chave === itemSangria.chave)
        && listaGrupoBravo.some((it) => it.chave === itemSangria.chave) && !listaGrupoBravo.some((it) => it.chave === itemSaida.chave),
      'loja (não Master/Admin) vê a lista mas não consegue verificar': listaBravo.length >= 0 && rVerificarLoja.status === 403,
      'chave inventada (índice que não existe nesse fechamento) é recusada': rChaveFalsa.status === 400,
      'Admin (não Master) consegue verificar - decisão explícita do usuário': rVerificarAdmin.status === 200 && verificadaAdmin.verificada === true,
      'verificar guarda quem verificou': verificadaAdmin.verificadaPorEmail === 'saidas-admin@teste.local' && !!verificadaAdmin.verificadaEm,
      'dá pra desfazer a verificação (não é só ida sem volta)': rVerificarSangria.status === 200 && rDesfazerSangria.status === 200 && desfeita.verificada === false,
      'o item verificado pelo Admin continua marcado numa leitura nova': !!itemSaidaDepois && itemSaidaDepois.verificada === true,
      'Master recebe a entrada em dinheiro do fechamento (base do Saldo)': entradaArc === 500,
      'Admin também recebe as entradas (das unidades dele)':
        respAdminArc.entradas.some((e) => e.unidade === 'TESTE_SAIDA_ARC' && e.valor === 500),
      // o gate e' no SERVIDOR: esconder o card no HTML deixaria o numero
      // viajar pro navegador da loja do mesmo jeito
      'loja (nem Master nem Admin) não recebe entrada nenhuma, mesmo tendo a unidade e vendo as saídas dela':
        respLoja.itens.some((it) => it.unidade === 'TESTE_SAIDA_ARC')
        && Array.isArray(respLoja.entradas) && respLoja.entradas.length === 0,
      'a conta fecha: entrada 500 − saídas 129,50 = 370,50 na unidade ARC':
        Math.round(saidasArc * 100) === 12950 && Math.round((entradaArc - saidasArc) * 100) === 37050,
      'saída com "Sangria" na descrição nasce como saída avulsa (nada muda sozinho)': nasceComoSaida,
      'só o Master move - Admin é recusado nas duas rotas': rMoverAdmin.status === 403 && rLoteAdmin.status === 403,
      'Sangria/Depósito de verdade (coleção própria) não tem pra onde ir': rMoverSangriaReal.status === 400,
      'mover leva o item pra coluna Sangria e marca que foi movido à mão':
        rMover.status === 200 && !!aposMover && aposMover.origem === 'sangria' && aposMover.reclassificada === true,
      'verificar depois de mover não desfaz a mudança (os dois estados no mesmo doc)':
        rVerificarMovida.status === 200 && aposVerificar.origem === 'sangria' && aposVerificar.verificada === true,
      'desfazer volta pra saída avulsa SEM perder a verificação':
        !!aposDesfazer && aposDesfazer.origem === 'saida' && aposDesfazer.reclassificada === false && aposDesfazer.verificada === true,
      'em lote move só as que têm "Sangria" na descrição (acento não atrapalha)':
        rLote.status === 200 && loteData.movidas === 1
        && !!movidaNoLote && movidaNoLote.origem === 'sangria'
        && !!naoMexeuNoResto && naoMexeuNoResto.origem === 'saida',
    };
    const ruinsSP = Object.entries(conf).filter(([, ok]) => !ok).map(([n]) => n);
    okSaidasPainel = !ruinsSP.length;
    if (ruinsSP.length) console.log(`  falhou em: ${ruinsSP.join(' · ')}`);
  } catch (e) { okSaidasPainel = false; console.log('  erro: ' + e.message); }
  if (!okSaidasPainel) ruins += 1;
  console.log(`${okSaidasPainel ? '✓' : '✗'} Painel de Saídas: Sangria/Depósito + outras saídas unificadas, verificação Master/Admin, isolamento por grupo`);

  // ------------------------------------------------------------------
  // Pedido real do Master: "tem muitas saídas que vieram da planilha e
  // percebi que não aparece aqui, só as lançadas no próprio sistema". Causa
  // raiz dupla: (1) linhaParaFechamento (leitura da planilha ARCFOOD) nunca
  // lia os pares "Saida Dinheiro N"/"Descricao Saida N" pra dentro de
  // detalhesSaidas - só guardava o TOTAL (totalSaida); (2) mesmo corrigido
  // isso, /api/saidas-painel só olhava fechamentosLive.listAll() (Firestore)
  // - o fechamento importado da planilha nunca é gravado lá, vive só em
  // memória (fechamentosData, ver index.js) - então nunca apareceria de
  // qualquer forma. As duas pontas têm que estar certas.
  let okSaidasPlanilha = false;
  try {
    const sheetsSyncMod = require('/home/user/adyen-monitor/server/sheetsSync.js');
    const saidasPainelMod = require('/home/user/adyen-monitor/server/saidasPainel.js');

    // linha real de planilha ARCFOOD, com 2 saidas preenchidas e 3 vazias -
    // as vazias nao podem virar item fantasma no painel
    const header = ['ID', 'Nome', 'Unidade', 'Data', 'Faturam.', 'Total Saida',
      'Saida Dinheiro', 'Descricao Saida', 'Saida Dinheiro 02', 'Descricao Saida 02', 'Saida Dinheiro 03', 'Descricao Saida 03'];
    const linha = ['pl-teste-01', 'Gerente Planilha', 'Sao Miguel', '15/08/26', 'R$ 1.000,00', 'R$ 87,50',
      'R$ 37,50', 'Motoboy planilha', 'R$ 50,00', 'Compra de gelo planilha', '', ''];
    const fechPlanilha = sheetsSyncMod.linhaParaFechamento('ARCFOOD', header, linha);

    // mesma linha, mas com o cabeçalho como ele realmente aparece na planilha
    // historica da ARCFOOD depois de anos de edição manual: "Saída Dinheiro"
    // com acento, "Descrição Saída" com acento e caixa diferente na 2ª saída
    // - o Master reportou que só ALGUMAS saídas apareciam, exatamente porque
    // header.indexOf('Saida Dinheiro') (sem acento, no código) não batia com
    // a coluna acentuada da planilha
    const headerAcentuado = ['ID', 'Nome', 'Unidade', 'Data', 'Faturam.', 'Total Saida',
      'Saída Dinheiro', 'Descrição Saída', 'saída dinheiro 02', 'DESCRIÇÃO SAÍDA 02', 'Saida Dinheiro 03', 'Descricao Saida 03'];
    const fechPlanilhaAcentuada = sheetsSyncMod.linhaParaFechamento('ARCFOOD', headerAcentuado, linha);

    // duas linhas do MESMO dia/unidade (fechamento principal + uma linha de
    // sangria separada, cada uma com seu proprio item de saida) - o merge
    // tem que concatenar os dois, nao ficar só com o da linha "principal"
    const linhaSangriaMesmoDia = { ...fechPlanilha, id: 'pl-teste-02', faturamento: 0, totalSaida: 20, detalhesSaidas: [{ valor: 20, descricao: 'Sangria planilha' }] };
    const mescladas = sheetsSyncMod.mesclarLancamentosDoMesmoDia([fechPlanilha, linhaSangriaMesmoDia]);
    const fechMesclado = mescladas.find((f) => f.unidade === fechPlanilha.unidade && f.data === fechPlanilha.data);

    // saidasPainel.listar/marcarVerificada aceitando um fechamento que NAO
    // esta no Firestore (fechamentosLive) - simula o que index.js passa como
    // fechamentosData
    const listaComExtra = await saidasPainelMod.listar([fechPlanilha]);
    const itemPlanilha = listaComExtra.find((it) => it.descricao === 'Motoboy planilha');
    const listaSemExtra = await saidasPainelMod.listar([]);
    const semExtraSomeu = !listaSemExtra.some((it) => it.descricao === 'Motoboy planilha');

    const verificado = itemPlanilha
      ? await saidasPainelMod.marcarVerificada(itemPlanilha.chave, { verificada: true, porId: 'u-teste', porEmail: 'teste@teste.local' }, [fechPlanilha])
      : null;
    let semExtraRecusa = false;
    try {
      if (itemPlanilha) await saidasPainelMod.marcarVerificada(itemPlanilha.chave, { verificada: true, porId: 'u-teste', porEmail: 'teste@teste.local' }, []);
    } catch (e) { semExtraRecusa = /não encontrada/i.test(e.message); }

    const conferencias = {
      'a leitura da planilha ARCFOOD lê os 2 pares preenchidos de Saida Dinheiro/Descricao Saida':
        fechPlanilha.detalhesSaidas.length === 2
        && fechPlanilha.detalhesSaidas.some((d) => d.valor === 37.5 && d.descricao === 'Motoboy planilha')
        && fechPlanilha.detalhesSaidas.some((d) => d.valor === 50 && d.descricao === 'Compra de gelo planilha'),
      'pares vazios (Saida Dinheiro 03) não viram item fantasma': fechPlanilha.detalhesSaidas.every((d) => d.descricao !== ''),
      'cabeçalho com acento/caixa diferente ("Saída Dinheiro", "saída dinheiro 02") lê as mesmas 2 saídas':
        fechPlanilhaAcentuada.detalhesSaidas.length === 2
        && fechPlanilhaAcentuada.detalhesSaidas.some((d) => d.valor === 37.5 && d.descricao === 'Motoboy planilha')
        && fechPlanilhaAcentuada.detalhesSaidas.some((d) => d.valor === 50 && d.descricao === 'Compra de gelo planilha'),
      'cabeçalho acentuado também lê ID/Unidade/Faturam. certos (get() não quebrou os outros campos)':
        fechPlanilhaAcentuada.id === fechPlanilha.id && fechPlanilhaAcentuada.unidade === fechPlanilha.unidade
        && fechPlanilhaAcentuada.faturamento === fechPlanilha.faturamento,
      'Grupo Bravo não lê ARCFOOD_SAIDA_SLOTS (formato de coluna é só da ARCFOOD)':
        sheetsSyncMod.linhaParaFechamento('BRAVO', ['ID', 'Unidade', 'Data', 'Faturam.'], ['pl-b1', 'Dominos Bessa', '15/08/2026', 'R$ 100,00']).detalhesSaidas.length === 0,
      'mesclar do mesmo dia CONCATENA detalhesSaidas das 2 linhas (não fica só com o da principal)':
        !!fechMesclado && fechMesclado.detalhesSaidas.length === 3
        && fechMesclado.detalhesSaidas.some((d) => d.descricao === 'Sangria planilha'),
      'saidasPainel.listar(extras) inclui o item da planilha (que não está no Firestore)': !!itemPlanilha,
      'sem passar os extras, o item da planilha não aparece (prova que veio do parâmetro, não de outro lugar)': semExtraSomeu,
      'marcarVerificada aceita a chave de um fechamento só-em-memória quando os extras são passados':
        !!verificado && verificado.verificada === true,
      'sem os extras, a MESMA chave é recusada (não é "sempre aceita")': semExtraRecusa,
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([n]) => n);
    okSaidasPlanilha = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')}`);
  } catch (e) { okSaidasPlanilha = false; console.log('  erro: ' + e.message); }
  if (!okSaidasPlanilha) ruins += 1;
  console.log(`${okSaidasPlanilha ? '✓' : '✗'} Painel de Saídas: saída itemizada importada da planilha ARCFOOD também aparece (antes só a lançada no app)`);

  // wiring: index.js precisa passar fechamentosData pros 3 pontos que usam
  // saidasPainel (listar x2 + marcarVerificada) - sem isso, o fix acima fica
  // só no módulo e nunca chega no que a tela de verdade chama
  let okSaidasWiring = false;
  try {
    const src = require('fs').readFileSync(require('path').join(__dirname, 'index.js'), 'utf8');
    const ocorrenciasListar = (src.match(/saidasPainel\.listar\(fechamentosData\)/g) || []).length;
    const ocorrenciasVerificar = /saidasPainel\.marcarVerificada\([^)]*fechamentosData\)/.test(src);
    okSaidasWiring = ocorrenciasListar >= 2 && ocorrenciasVerificar;
    if (!okSaidasWiring) console.log(`  listar(fechamentosData): ${ocorrenciasListar}x, marcarVerificada com fechamentosData: ${ocorrenciasVerificar}`);
  } catch (e) { okSaidasWiring = false; console.log('  erro: ' + e.message); }
  if (!okSaidasWiring) ruins += 1;
  console.log(`${okSaidasWiring ? '✓' : '✗'} Painel de Saídas: as 3 rotas (listar, relatório, verificar) passam o snapshot da planilha pro módulo`);

  // ------------------------------------------------------------------
  // Pedido real do Master: "a coluna TC ela hoje se chama Total nos KPIs...
  // preciso que esses dados apareçam, pois ela só fica zerada... e remover
  // a coluna cancelado ao lado de TC". Causa raiz: TC deixou de ser um campo
  // fixo digitado - hoje é um KPI Extra dinâmico (grupos.html) chamado
  // "Total"; o campo legado `tc` só é preenchido por linha de planilha
  // antiga. prepararFechamentosPorUnidade (relatorio-unidades.csv/pdf) tem
  // que somar os dois, casando por NOME (campoTcDoGrupo/chaveLabel) - e
  // Cancelados sai de vez (o Master pediu pra tirar). Também: a planilha
  // pode ter chamado essa coluna de "TC" OU "Quantidade de Pedidos".
  let okTcComparativo = false;
  try {
    const sheetsSyncMod = require('/home/user/adyen-monitor/server/sheetsSync.js');
    // 'Mooca' é uma das 4 lojas de verdade da ARCFOOD (ver ARCFOOD_UNIDADES_POR_NOME)
    // - linhaParaFechamento descarta linha de unidade desconhecida
    const fechQtdPedidos = sheetsSyncMod.linhaParaFechamento(
      'ARCFOOD',
      ['ID', 'Unidade', 'Data', 'Faturam.', 'Quantidade de Pedidos'],
      ['pl-tc-1', 'Mooca', '01/08/2026', 'R$ 100,00', '7'],
    );

    DOCS.set('grupos/g-tc-teste', {
      id: 'g-tc-teste', nome: 'Grupo TC teste', unidades: ['UnidTCTeste'],
      kpisExtras: [{ label: 'Total', campo: 'total', tipo: 'quantidade' }],
      canaisVendaExtras: [], formasPagamentoExtras: [],
    });
    // linha "legado" (schema antigo, tc digitado direto - planilha) e linha
    // "sistema" (kpisExtras.total, o jeito atual) no MESMO comparativo - o
    // relatorio tem que somar as duas, nao escolher uma
    DOCS.set('fechamentosLive/UnidTCTeste__2026-08-01', {
      id: 'UnidTCTeste__2026-08-01', unidade: 'UnidTCTeste', unidadeNome: 'Unidade TC Teste',
      grupo: 'ARCFOOD', data: '2026-08-01', faturamento: 1000, totalDeclarado: 1000, diferenca: 0,
      tc: 4, cancelados: 9, kpisExtras: {},
    });
    DOCS.set('fechamentosLive/UnidTCTeste__2026-08-02', {
      id: 'UnidTCTeste__2026-08-02', unidade: 'UnidTCTeste', unidadeNome: 'Unidade TC Teste',
      grupo: 'ARCFOOD', data: '2026-08-02', faturamento: 2000, totalDeclarado: 2000, diferenca: 0,
      tc: 0, cancelados: 0, kpisExtras: { total: 12 },
    });
    // DOCS.set grava direto no Firestore falso, por fora de grupos.js/
    // fechamentosLive.js - os caches deles (TTL de 5min/6h, ver createCache)
    // ja estao quentes a essa altura da suite (testes anteriores ja leram
    // /api/grupos e /api/fechamentos), entao sem invalidar explicitamente a
    // rota abaixo devolveria o snapshot ANTIGO, sem as linhas que acabei de
    // semear
    require('/home/user/adyen-monitor/server/grupos.js').invalidarCache();
    require('/home/user/adyen-monitor/server/fechamentosLive.js').invalidarCache();

    const r = await pedir(
      '/api/fechamentos/relatorio-unidades.csv?unidades=UnidTCTeste&inicio=2026-08-01&fim=2026-08-02',
      token ? { Authorization: 'Bearer ' + token } : {},
    );

    const conferencias = {
      'linhaParaFechamento lê TC pela coluna "Quantidade de Pedidos" quando não tem "TC"': fechQtdPedidos.tc === 7,
      'rota /relatorio-unidades.csv respondeu 200': r.status === 200,
      'TC total soma o campo legado (tc:4) com o KPI Extra "Total" do grupo (kpisExtras.total:12) = 16': /,16(\r?\n|,)/.test(r.corpo),
      'coluna Cancelados não existe mais no cabeçalho': !/Cancelados/i.test(r.corpo),
      'coluna TC total continua no cabeçalho': /TC total/.test(r.corpo),
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([n]) => n);
    okTcComparativo = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')} · corpo: ${r.corpo.slice(0, 300)}`);
  } catch (e) { okTcComparativo = false; console.log('  erro: ' + e.message); }
  if (!okTcComparativo) ruins += 1;
  console.log(`${okTcComparativo ? '✓' : '✗'} Comparativo por unidade: TC soma campo legado + KPI Extra "Total" (novo nome do TC), Cancelados removido`);

  // mesmo pedido, do lado da TELA (fechamentos.html): seletor 🧩 Colunas
  // próprio pro "Comparativo por unidade" (pedido: "eu possa escolher quais
  // dados fazem parte dessa tabela"), Cancelados fora do cabeçalho fixo, TC
  // lido via valorTc (campo legado `tc` + KPI Extra "Total" do grupo)
  let okTcComparativoTela = false;
  try {
    const html = require('fs').readFileSync(require('path').join(__dirname, 'public', 'fechamentos.html'), 'utf8');
    const conf = {
      'renderUnidadesTable não soma mais "cancelados"': !/c\.cancelados/.test(html),
      'renderUnidadesTable lê TC via valorTc(r, grupo), não r.tc direto': /c\.tc \+= valorTc\(r, grupoKpiDaUnidade\(r\.unidade\)\)/.test(html),
      'campoTcDoGrupo casa o KPI Extra por nome ("Total"), igual à unificação de Canais/Formas': /function campoTcDoGrupo\(grupo\)\{[\s\S]{0,300}chaveLabel\('Total'\)/.test(html),
      'cabeçalho fixo do HTML não tem mais <th>Cancelados</th>': !/<th>Cancelados<\/th>/.test(html),
      'botão 🧩 Colunas do Comparativo por unidade existe': /abrirSeletorColunasUnidades\(\)/.test(html) && /Comparativo por unidade/.test(html),
      'seletor tem Salvar gravando no servidor (preferência própria, não a da tabela principal)':
        /const PREF_COLUNAS_UNIDADES = 'fechamentoColunasUnidades'/.test(html)
        && /function salvarColunasUnidades\(\)/.test(html),
      // mesmo bug apontado pelo usuário no tooltip do gráfico de Faturamento
      // por unidade ("este TC que aparece aqui precisa ajustar também") - o
      // gráfico e o card "TC total" de cima (renderKpis) somavam o campo
      // legado `tc` direto, igual a tabela já corrigida acima
      'gráfico de Faturamento por unidade lê TC via valorTc (não r.tc direto)':
        /porDiaUnidadeTC\[r\.unidade\]\[r\.data\] \+= valorTc\(r, grupoKpiDaUnidade\(r\.unidade\)\)/.test(html),
      'card "TC total" do topo (renderKpis) também lê TC via valorTc por linha':
        /const tc = \+rows\.reduce\(\(s,d\)=>s\+valorTc\(d, grupoKpiDaUnidade\(d\.unidade\)\),0\)\.toFixed\(2\)/.test(html),
    };
    const falhas = Object.entries(conf).filter(([, ok]) => !ok).map(([n]) => n);
    okTcComparativoTela = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')}`);
  } catch (e) { okTcComparativoTela = false; console.log('  erro: ' + e.message); }
  if (!okTcComparativoTela) ruins += 1;
  console.log(`${okTcComparativoTela ? '✓' : '✗'} Comparativo por unidade (tela): seletor de colunas próprio + TC unificado (tabela+gráfico+card) + Cancelados fora`);

  // ------------------------------------------------------------------
  // Bug relatado pelo usuário: "botão de aprovar selecionados deu erro" -
  // alert "Failed to fetch" no celular ao selecionar ~1180 tickets de Quebra
  // de caixa e clicar "Aprovar selecionados". Causa raiz: /api/central/
  // decidir-lote decidia um ticket de cada vez, em SÉRIE - cada um faz 2-3
  // idas ao Firestore (get+update+getOne), e em série isso passa longe do
  // tempo que o navegador/rede móvel aguenta sem soltar a conexão (o
  // servidor nem quebrava - só ainda não tinha terminado quando o fetch()
  // desistiu). Fix: processa em FATIAS paralelas (Promise.all) - mesma
  // lógica de decisão por ticket, sem mudar nada nela, só sem esperar um
  // terminar pra começar o próximo. O teste aqui cobre a preocupação real
  // de paralelizar: a contagem (decididos/pulados) não pode embaralhar nem
  // "perder" ticket com várias fatias em voo ao mesmo tempo.
  let okDecidirLoteParalelo = false;
  try {
    const cab = { Authorization: 'Bearer ' + token };
    const solicitacoesMod = require('/home/user/adyen-monitor/server/solicitacoes.js');
    const fechamentosLiveMod = require('/home/user/adyen-monitor/server/fechamentosLive.js');
    const N = 45; // mais de 2 fatias de 20, pra provar que o loop ENTRE fatias também funciona
    const criados = [];
    for (let i = 0; i < N; i++) {
      criados.push(await solicitacoesMod.create({
        tipo: 'quebra-caixa', unidade: 'São Braz Ilha do Leite', titulo: `Quebra lote ${i}`,
        criadoPorEmail: 'teste@teste.local',
      }));
    }
    // suporte-ti fica de fora do lote de propósito (precisa escolher técnico
    // pelo card) e um id que não existe - os dois têm que sobrar em
    // "pulados" pelo filtro ANTES do processamento em paralelo
    const foraDoLote = await solicitacoesMod.create({
      tipo: 'suporte-ti', unidade: 'São Braz Ilha do Leite', titulo: 'Chamado TI lote',
      criadoPorEmail: 'teste@teste.local',
    });
    // ajuste de fechamento JÁ DECIDIDO antes do lote - esse é o caso que
    // exercita o try/catch DENTRO do Promise.all (não o filtro de cima): o
    // card continua visível/apto (mapa.has() bate), mas decidirEdicao
    // recusa em runtime ("Esse pedido já foi decidido") - prova que um erro
    // de UM ticket, no meio de uma fatia paralela, cai em "pulados" sem
    // derrubar a fatia inteira nem os outros 45
    DOCS.set('fechamentosLive/sabotagem-lote-fech', {
      id: 'sabotagem-lote-fech', unidade: 'UnidLoteTeste', unidadeNome: 'Unidade Lote Teste',
      grupo: 'ARCFOOD', data: '2026-08-01', faturamento: 100, totalDeclarado: 100, diferenca: 0,
    });
    fechamentosLiveMod.invalidarCache();
    const edicaoJaDecidida = await fechamentosLiveMod.solicitarEdicao({
      fechamentoId: 'sabotagem-lote-fech', tipoCorrecao: 'excluir', motivo: 'teste sabotagem lote',
      solicitadoPorEmail: 'teste@teste.local',
    });
    await fechamentosLiveMod.decidirEdicao(edicaoJaDecidida.id, 'APROVADO', { decididoPorEmail: 'teste@teste.local' });

    const tickets = [
      ...criados.map((s) => ({ tipo: s.tipo, id: s.id })),
      { tipo: 'suporte-ti', id: foraDoLote.id },
      { tipo: 'compra', id: 'id-que-nao-existe-no-lote' },
      { tipo: 'ajuste-fechamento', id: edicaoJaDecidida.id },
    ];
    const r = await postarJson('/api/central/decidir-lote', { tickets, status: 'APROVADO' }, cab);
    const data = r.status === 200 ? JSON.parse(r.corpo) : {};
    // confere no banco de verdade, não só na resposta - paralelismo mal
    // feito poderia, em tese, deixar alguma escrita pra trás sem que a
    // contagem devolvida acusasse
    const conferidos = await Promise.all(criados.map((s) => solicitacoesMod.getOne(s.id)));

    const conferencias = {
      'rota respondeu 200': r.status === 200,
      'decididos = 45 (nem mais, nem menos, mesmo processando em paralelo)': data.decididos === N,
      'os 45 de verdade viraram APROVADO no banco': conferidos.every((c) => c && c.status === 'APROVADO'),
      'suporte-ti ficou de fora (filtro antes do lote)': !!(data.pulados && data.pulados.some((p) => p.id === foraDoLote.id)),
      'id inexistente aparece em pulados, sem quebrar o lote inteiro': !!(data.pulados && data.pulados.some((p) => p.id === 'id-que-nao-existe-no-lote')),
      'ajuste já decidido falha DENTRO da fatia paralela e cai em pulados (não derruba os outros 45)':
        !!(data.pulados && data.pulados.some((p) => p.id === edicaoJaDecidida.id && /já foi decidido/i.test(p.motivo || ''))),
      'pulados tem exatamente os 3 esperados, nada a mais nem a menos': data.pulados && data.pulados.length === 3,
    };
    const falhas = Object.entries(conferencias).filter(([, ok]) => !ok).map(([n]) => n);
    okDecidirLoteParalelo = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')}`);
  } catch (e) { okDecidirLoteParalelo = false; console.log('  erro: ' + e.message); }
  if (!okDecidirLoteParalelo) ruins += 1;
  console.log(`${okDecidirLoteParalelo ? '✓' : '✗'} Central: aprovar em lote processa em fatias paralelas sem perder, duplicar nem embaralhar ticket`);

  // ------------------------------------------------------------------
  // Formulários: a lista tinha virado um monte só se amontoando (pedido do
  // usuário) - organização de fonte, no mesmo desenho já usado em
  // Central/Solicitações (central-historico.html): chips de tipo com
  // contagem, e o MESMO padrão de botões por status (clica e a lista
  // aparece embaixo, só um aberto por vez) tanto na Triagem (só o que
  // precisa de alguém agora + o que foi assinado HOJE + TODOS os
  // cancelados) quanto na aba de um tipo específico (histórico completo,
  // sem esse corte de "hoje" no Assinado) - pedido do usuário: aplicar o
  // mesmo estilo também nas abas de tipo, não só na Triagem.
  let okFormulariosOrganizacao = false;
  try {
    const html = require('fs').readFileSync(require('path').join(__dirname, 'public', 'formularios.html'), 'utf8');
    const conf = {
      'chips de tipo com contagem existem': /id="tipo-filtro-row"/.test(html) && /function renderTipoFiltroRowForm/.test(html),
      'Triagem deixa passar cancelado (coluna própria) e só o assinado de HOJE': (() => {
        const i = html.indexOf('function passaTriagemForm');
        const trecho = html.slice(i, i + 400);
        return i >= 0 && !/CANCELADO.*return false/.test(trecho) && /ASSINADO.*return assinadoHoje/.test(trecho);
      })(),
      'os 4 status certos existem (viraram botão, não coluna sempre visível), incluindo Cancelados':
        /status:'AGUARDANDO_PREENCHIMENTO', titulo:'Aguardando preenchimento'/.test(html)
        && /status:'PENDENTE', titulo:'Aguardando assinatura'/.test(html)
        && /status:'ASSINADO', titulo: emTriagem \? 'Assinado hoje' : 'Assinado'/.test(html)
        && /status:'CANCELADO', titulo:'Cancelados'/.test(html),
      // pedido do usuário: nada de coluna sempre aberta - clica no botão do
      // status e a lista aparece embaixo dele, só uma aberta por vez
      'clicar no botão de status alterna (mesmo clique fecha de novo) e só mostra a lista de quem está aberto':
        /function toggleStatusTriagem\(status\)\{\s*TRIAGEM_STATUS_ABERTO = \(TRIAGEM_STATUS_ABERTO===status\) \? null : status;/.test(html)
        && /const cardsAbertos = TRIAGEM_STATUS_ABERTO \? visiveis\.filter/.test(html),
      'aba de um tipo específico usa o MESMO padrão de botões (não voltou a ser lista corrida)':
        !/alvo\.innerHTML = visiveis\.map\(cardHtml\)\.join\(''\);/.test(html)
        && /const COLUNAS = \[/.test(html),
      'só muda o rótulo do Assinado entre Triagem (hoje) e aba de tipo (histórico completo)':
        /titulo: emTriagem \? 'Assinado hoje' : 'Assinado'/.test(html),
      'trocar de aba de tipo fecha o status que estava aberto (não carrega estado de uma aba pra outra)':
        /function selecionarTipoFiltroLista\(tipo\)\{ TIPO_FILTRO_LISTA = tipo; TRIAGEM_STATUS_ABERTO = null; renderLista\(\); \}/.test(html),
      'filtro de loja/busca existe': /id="filtro-unidade-lista"/.test(html) && /id="filtro-busca-lista"/.test(html),
    };
    const falhas = Object.entries(conf).filter(([, ok]) => !ok).map(([n]) => n);
    okFormulariosOrganizacao = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')}`);
  } catch (e) { okFormulariosOrganizacao = false; console.log('  erro: ' + e.message); }
  if (!okFormulariosOrganizacao) ruins += 1;
  console.log(`${okFormulariosOrganizacao ? '✓' : '✗'} Formulários: lista organizada por tipo (chips+contagem) e botões por status também na aba de tipo, igual Triagem`);

  // ------------------------------------------------------------------
  // Formulários: filtros de tempo (Hoje/Ontem/Semana/Mês + De-Até) sobre a
  // lista - pedido do usuário. Sem restrição por padrão (uma pendência
  // antiga não pode sumir da Triagem só por estar fora do período).
  let okFormulariosPeriodo = false;
  try {
    const html = require('fs').readFileSync(require('path').join(__dirname, 'public', 'formularios.html'), 'utf8');
    const conf = {
      'inputs De/Até + presets existem na tela': /id="filtro-data-de-lista"/.test(html) && /id="filtro-data-ate-lista"/.test(html)
        && /id="presets-periodo-lista"/.test(html),
      'os 5 presets certos (Todos/Hoje/Ontem/Semana/Mês)':
        /\{lbl:'Todos', tipo:'todos'\}, \{lbl:'Hoje', tipo:'hoje'\}, \{lbl:'Ontem', tipo:'ontem'\}, \{lbl:'Semana', tipo:'semana'\}, \{lbl:'Mês', tipo:'mes'\}/.test(html),
      'sem filtro nenhum (Todos) não restringe nada - pendência antiga não some da Triagem': (() => {
        const i = html.indexOf('function passaPeriodoForm');
        const trecho = html.slice(i, i + 200);
        return i >= 0 && /if\(!FILTRO_DATA_DE_LISTA && !FILTRO_DATA_ATE_LISTA\) return true;/.test(trecho);
      })(),
      'o filtro de período é aplicado na mesma base que unidade/busca (afeta Triagem e abas de tipo)':
        /passaBuscaForm\(f\) && passaPeriodoForm\(f\)/.test(html),
      'o período é calculado em Brasília (não no fuso do navegador/servidor)':
        /toLocaleDateString\('sv-SE', \{ timeZone: FUSO_BR_LISTA \}\)/.test(html),
    };
    const falhas = Object.entries(conf).filter(([, ok]) => !ok).map(([n]) => n);
    okFormulariosPeriodo = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')}`);
  } catch (e) { okFormulariosPeriodo = false; console.log('  erro: ' + e.message); }
  if (!okFormulariosPeriodo) ruins += 1;
  console.log(`${okFormulariosPeriodo ? '✓' : '✗'} Formulários: filtros de tempo (Hoje/Ontem/Semana/Mês/De-Até) sobre a lista, sem restringir por padrão`);

  // ------------------------------------------------------------------
  // Central -> Histórico (Solicitações): o kanban de 3 colunas SEMPRE
  // visíveis lado a lado (Pendente/Aprovado/Rejeitado) virou o mesmo padrão
  // de botões por status de formularios.html - clica e a lista aparece
  // embaixo, só um aberto por vez. Também ganhou os presets de tempo
  // (Hoje/Ontem/Semana/Mês) por cima do De/Até que já existia.
  let okCentralHistoricoBotoes = false;
  try {
    const html = require('fs').readFileSync(require('path').join(__dirname, 'public', 'central-historico.html'), 'utf8');
    const conf = {
      'as 3 colunas sempre visíveis (kanban-board/kanban-col) saíram da tela':
        !/class="kanban-board"/.test(html) && !/class="kanban-col"/.test(html),
      'viraram botão clicável, mesmo padrão de formularios.html':
        /id="status-toggle-row"/.test(html) && /function toggleStatusCentral\(status\)\{/.test(html),
      'clicar no botão de status alterna (mesmo clique fecha de novo)':
        /STATUS_ABERTO = \(STATUS_ABERTO===status\) \? null : status;/.test(html),
      'trocar de tipo (Triagem <-> aba de um assunto) fecha o status que estava aberto':
        /function selecionarFiltroTipo\(tipo\)\{\s*FILTRO_TIPOS = tipo \? new Set\(\[tipo\]\) : new Set\(\);\s*STATUS_ABERTO = null;/.test(html)
        && /function toggleFiltroTipoMulti\(tipo\)\{[\s\S]{0,120}STATUS_ABERTO = null;/.test(html),
      'a cor semântica de cada status (badge PENDENTE/APROVADO/REJEITADO) continua no botão':
        /<span class="badge \$\{status\}">\$\{LABEL_STATUS\[status\]\}<\/span>/.test(html),
      'o hint (aguardando início / hoje) só aparece em Triagem, não na aba de um assunto':
        /const HINT_STATUS = emTriagem \? \{ APROVADO:'· aguardando início', REJEITADO:'· hoje' \} : \{\};/.test(html),
      'a seleção em lote (CHAVES_VISIVEIS) continua sobre TODOS os status, não só o aberto':
        /CHAVES_VISIVEIS = visiveis\.map\(c=>c\.tipo\+'::'\+c\.id\);/.test(html),
    };
    const falhas = Object.entries(conf).filter(([, ok]) => !ok).map(([n]) => n);
    okCentralHistoricoBotoes = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')}`);
  } catch (e) { okCentralHistoricoBotoes = false; console.log('  erro: ' + e.message); }
  if (!okCentralHistoricoBotoes) ruins += 1;
  console.log(`${okCentralHistoricoBotoes ? '✓' : '✗'} Central -> Histórico: kanban de status virou botão (clica e abre embaixo), igual Formulários`);

  // ------------------------------------------------------------------
  // Central -> Histórico: presets de tempo (Hoje/Ontem/Semana/Mês) por cima
  // do filtro De/Até que já existia - calculados em Brasília.
  let okCentralHistoricoPeriodo = false;
  try {
    const html = require('fs').readFileSync(require('path').join(__dirname, 'public', 'central-historico.html'), 'utf8');
    const conf = {
      'presets existem por cima do De/Até que já existia': /id="presets-periodo-central"/.test(html)
        && /id="filtro-data-de"/.test(html) && /id="filtro-data-ate"/.test(html),
      'os 5 presets certos (Todos/Hoje/Ontem/Semana/Mês)':
        /\{lbl:'Todos', tipo:'todos'\}, \{lbl:'Hoje', tipo:'hoje'\}, \{lbl:'Ontem', tipo:'ontem'\}, \{lbl:'Semana', tipo:'semana'\}, \{lbl:'Mês', tipo:'mes'\}/.test(html),
      'o período é calculado em Brasília (não no fuso do navegador/servidor)':
        /toLocaleDateString\('sv-SE', \{ timeZone: FUSO_BR \}\)/.test(html),
      'editar a data na mão limpa o preset ativo (não fica um botão marcado com data diferente)':
        /function aoMudarPeriodoCentral\(\)\{\s*document\.querySelectorAll\('#presets-periodo-central \.preset-btn'\)\.forEach\(b=>b\.classList\.remove\('active'\)\);/.test(html),
      'Limpar filtros também limpa o preset (volta pro Todos)':
        /function limparFiltrosExtra\(\)\{[\s\S]{0,500}b\.dataset\.tipo==='todos'/.test(html),
    };
    const falhas = Object.entries(conf).filter(([, ok]) => !ok).map(([n]) => n);
    okCentralHistoricoPeriodo = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')}`);
  } catch (e) { okCentralHistoricoPeriodo = false; console.log('  erro: ' + e.message); }
  if (!okCentralHistoricoPeriodo) ruins += 1;
  console.log(`${okCentralHistoricoPeriodo ? '✓' : '✗'} Central -> Histórico: filtros de tempo (Hoje/Ontem/Semana/Mês) por cima do De/Até`);

  // ------------------------------------------------------------------
  // Chamados de TI/Manutenção (tecnico.html): os 5 chips mutuamente
  // exclusivos (todos/ativos/remoto/presencial/concluidos) viraram o mesmo
  // padrão de botão-por-status de formularios.html/central-historico.html.
  // Modalidade saiu do chip e virou filtro à parte, combinável com
  // qualquer status (antes "ativos" e "presencial" eram mutuamente
  // exclusivos - não dava pra ver os dois juntos).
  let okTecnicoBotoes = false;
  try {
    const html = require('fs').readFileSync(require('path').join(__dirname, 'public', 'tecnico.html'), 'utf8');
    const conf = {
      'os chips antigos (filtros-chips/filtro-chip) saíram da tela':
        !/class="filtros-chips"/.test(html) && !/class="filtro-chip/.test(html),
      'viraram botão clicável, mesmo padrão de formularios.html/central-historico.html':
        /id="status-toggle-row"/.test(html) && /function toggleStatusTecnico\(chave\)\{/.test(html),
      'clicar no botão de status alterna (mesmo clique fecha de novo)':
        /STATUS_ABERTO_TECNICO = \(STATUS_ABERTO_TECNICO===chave\) \? null : chave;/.test(html),
      'os 3 buckets certos, Ativos juntando ABERTO+INICIADO (mesmo agrupamento de sempre)':
        /pertence: c => c\.status==='ABERTO' \|\| c\.status==='INICIADO'/.test(html)
        && /pertence: c => c\.status==='CONCLUIDO'/.test(html)
        && /pertence: c => c\.status==='CANCELADO'/.test(html),
      'modalidade virou filtro à parte, aplicado na MESMA base que os status (combina com qualquer um)':
        /const base = CHAMADOS\.filter\(passaBusca\)\.filter\(passaModalidade\)\.filter\(passaPeriodoTecnico\);/.test(html),
      'a cor semântica do status (badge ABERTO/INICIADO/CONCLUIDO/CANCELADO) continua no card':
        /<span class="badge \$\{c\.status\}">\$\{c\.status\}<\/span>/.test(html),
    };
    const falhas = Object.entries(conf).filter(([, ok]) => !ok).map(([n]) => n);
    okTecnicoBotoes = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')}`);
  } catch (e) { okTecnicoBotoes = false; console.log('  erro: ' + e.message); }
  if (!okTecnicoBotoes) ruins += 1;
  console.log(`${okTecnicoBotoes ? '✓' : '✗'} Chamados de TI: chips de status viraram botão (clica e abre embaixo), modalidade virou filtro combinável`);

  // ------------------------------------------------------------------
  // Chamados de TI: ganhou os mesmos presets de tempo (Hoje/Ontem/Semana/
  // Mês) por cima de um De/Até que não existia antes nessa tela.
  let okTecnicoPeriodo = false;
  try {
    const html = require('fs').readFileSync(require('path').join(__dirname, 'public', 'tecnico.html'), 'utf8');
    const conf = {
      'inputs De/Até + presets existem na tela': /id="filtro-data-de-tecnico"/.test(html) && /id="filtro-data-ate-tecnico"/.test(html)
        && /id="presets-periodo-tecnico"/.test(html),
      'os 5 presets certos (Todos/Hoje/Ontem/Semana/Mês)':
        /\{lbl:'Todos', tipo:'todos'\}, \{lbl:'Hoje', tipo:'hoje'\}, \{lbl:'Ontem', tipo:'ontem'\}, \{lbl:'Semana', tipo:'semana'\}, \{lbl:'Mês', tipo:'mes'\}/.test(html),
      'sem filtro nenhum (Todos) não restringe nada - chamado antigo não some da lista':
        /function passaPeriodoTecnico\(c\)\{\s*if\(!FILTRO_DATA_DE_TECNICO && !FILTRO_DATA_ATE_TECNICO\) return true;/.test(html),
      'o período é calculado em Brasília (não no fuso do navegador/servidor)':
        /toLocaleDateString\('sv-SE', \{ timeZone: FUSO_BR \}\)/.test(html),
      'editar a data na mão limpa o preset ativo (não fica um botão marcado com data diferente)':
        /function aoMudarPeriodoTecnico\(manteveFocoPreset\)\{\s*if\(!manteveFocoPreset\) document\.querySelectorAll\('#presets-periodo-tecnico \.preset-btn'\)\.forEach\(b=>b\.classList\.remove\('active'\)\);/.test(html),
      'presets são montados no boot (não fica em branco até o primeiro clique)':
        /montarPresetsPeriodoTecnico\(\);\s*await carregarChamados\(\);/.test(html),
    };
    const falhas = Object.entries(conf).filter(([, ok]) => !ok).map(([n]) => n);
    okTecnicoPeriodo = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')}`);
  } catch (e) { okTecnicoPeriodo = false; console.log('  erro: ' + e.message); }
  if (!okTecnicoPeriodo) ruins += 1;
  console.log(`${okTecnicoPeriodo ? '✓' : '✗'} Chamados de TI: filtros de tempo (Hoje/Ontem/Semana/Mês/De-Até), sem restringir por padrão`);

  // ------------------------------------------------------------------
  // Duplicação de loja no "Chamados em aberto (por unidade)" (Histórico):
  // o estorno criado pela Central não mandava unidadeNome nenhum - o
  // fallback de refunds.js (unidadeNome || unidade || null) gravava o
  // CÓDIGO interno cru como se fosse nome de exibição, duplicando a mesma
  // loja na tabela (ex: "Dominos Bessa" vs o nome já normalizado "Dom
  // Bessa"). A correção é só mandar/repassar o unidadeNome que a Central já
  // calcula (UNIDADES_NOMES) - não mexe em normalizarCodigoUnidade() nem em
  // nenhuma das decisões fechadas de código de unidade do CLAUDE.md, é uma
  // camada anterior (ticket nasce com o nome certo, em vez de nascer errado
  // e precisar de correção depois).
  let okEstornoUnidadeNome = false;
  try {
    const cabMaster = { Authorization: 'Bearer ' + token };
    const r = await postarJson('/api/refund-requests', {
      pedidoId: 'PEDIDO-TESTE-UNIDADENOME',
      unidade: 'DOM_BESSA_COD_INTERNO',
      unidadeNome: 'Dom Bessa',
      observacao: 'Teste de forwarding de unidadeNome',
      password: process.env.MASTER_PASSWORD,
    }, cabMaster);
    const criado = r.status === 200 ? JSON.parse(r.corpo) : {};
    const htmlCentral = require('fs').readFileSync(require('path').join(__dirname, 'public', 'central.html'), 'utf8');
    const iEstorno = htmlCentral.indexOf("TIPO_SELECIONADO === 'estorno'");
    const trechoEstorno = htmlCentral.slice(iEstorno, iEstorno + 400);
    const conf = {
      'a rota cria o ticket normalmente': r.status === 200,
      'grava o nome canônico enviado, não o código interno': criado.unidadeNome === 'Dom Bessa',
      'o código interno continua guardado separado (unidade)': criado.unidade === 'DOM_BESSA_COD_INTERNO',
      'a Central manda unidadeNome no POST de estorno (não só unidade)':
        iEstorno >= 0 && /unidadeNome: UNIDADES_NOMES\[/.test(trechoEstorno),
    };
    const falhas = Object.entries(conf).filter(([, ok]) => !ok).map(([n]) => n);
    okEstornoUnidadeNome = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')} (status ${r.status} ${r.corpo.slice(0, 150)})`);
  } catch (e) { okEstornoUnidadeNome = false; console.log('  erro: ' + e.message); }
  if (!okEstornoUnidadeNome) ruins += 1;
  console.log(`${okEstornoUnidadeNome ? '✓' : '✗'} Estorno: ticket grava o unidadeNome canônico (nome de exibição), não o código interno cru`);

  // ------------------------------------------------------------------
  // Duplicação de loja (parte 2): o chamado automático de bloqueio de senha
  // (criarChamadoBloqueio em auth.js) juntava TODAS as unidades do login
  // num único unidadeNome (ex: "Loja A, Loja B, Loja C") - isso nunca bate
  // com nenhuma unidade de verdade e polui a contagem "por unidade" com uma
  // loja fantasma por combinação. A correção usa só a primeira unidade no
  // campo estruturado; a lista completa continua na observação, pra quem
  // aprova ver todas as unidades do login. Dispara o fluxo de VERDADE (3
  // senhas erradas via auth.login), não um ticket seedado à mão.
  let okBloqueioUnidadeNome = false;
  try {
    const bcrypt = require('bcryptjs');
    const senhaHash = bcrypt.hashSync('SenhaCerta!2026', 4);
    DOCS.set('users/u-bloq-multi-unidade', {
      email: 'bloqmulti@teste.local', username: 'bloqmulti', passwordHash: senhaHash, role: 'user', active: true,
      permissions: { sections: [], unidades: ['Dominos Bessa', 'Dominos Tirol'], vaultSubgroups: [], tiposSolicitacao: [] },
      failedAttempts: 0, locked: false,
    });
    for (let i = 0; i < 3; i++) {
      try { await auth.login('bloqmulti@teste.local', 'SenhaErrada!Nope'); } catch (e) { /* esperado */ }
    }
    // criarChamadoBloqueio dispara sem segurar a resposta do login - dá um
    // instante pra gravação assentar antes de conferir
    await new Promise((r) => setTimeout(r, 200));
    const ticket = [...DOCS.entries()]
      .filter(([k]) => k.startsWith('solicitacoes/')).map(([, v]) => v)
      .find((t) => t.titulo === 'Login bloqueado: bloqmulti@teste.local');
    const conf = {
      'o chamado automático foi criado': !!ticket,
      'unidadeNome NÃO junta as unidades (era o bug)': !!ticket && ticket.unidadeNome === 'Dominos Bessa',
      'unidade (código) é a primeira da lista, igual unidadeNome': !!ticket && ticket.unidade === 'Dominos Bessa',
      'a lista completa continua na observação, pra quem aprova ver todas as unidades':
        !!ticket && /Dominos Bessa, Dominos Tirol/.test(ticket.observacao || ''),
      'o login foi bloqueado de verdade (3 tentativas)': (DOCS.get('users/u-bloq-multi-unidade') || {}).locked === true,
    };
    const falhas = Object.entries(conf).filter(([, ok]) => !ok).map(([n]) => n);
    okBloqueioUnidadeNome = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')}`);
  } catch (e) { okBloqueioUnidadeNome = false; console.log('  erro: ' + e.message); }
  if (!okBloqueioUnidadeNome) ruins += 1;
  console.log(`${okBloqueioUnidadeNome ? '✓' : '✗'} Bloqueio automático: chamado usa só a primeira unidade em unidadeNome (não junta todas), evitando loja "fantasma" no Histórico por unidade`);

  // ------------------------------------------------------------------
  // Painel de Saídas: o filtro de Loja virou um multiselect com checkbox
  // (pedido do usuário: "um check para selecionar 1 ou 2 ou 3 ou todas as
  // unidades"), no lugar do <select> de escolha única. Continua restrito ao
  // Grupo escolhido (ARCFOOD não oferece loja do GBE pra marcar, e
  // vice-versa - mesmo pedido de isolamento já coberto na rota
  // /api/saidas-painel).
  let okSaidasMultiselect = false;
  try {
    const html = require('fs').readFileSync(require('path').join(__dirname, 'public', 'saidas.html'), 'utf8');
    const conf = {
      'a Loja virou multiselect com checkbox, não mais <select> de escolha única':
        /id="ms-unidade-btn"/.test(html) && /id="ms-unidade-panel"/.test(html) && !/<select id="f-unidade"/.test(html),
      'as opções da Loja são filtradas pelo Grupo escolhido (não lista loja de fora do grupo)': (() => {
        const i = html.indexOf('function paresUnidadeDoGrupo');
        const trecho = html.slice(i, i + 300);
        return i >= 0 && /it\.grupo===grupo/.test(trecho);
      })(),
      'trocar o Grupo atualiza o painel de checkboxes da Loja':
        /function aoMudarFiltro\(\)\{ renderUnidadePanel\(\); renderTudo\(\); \}/.test(html),
      'o filtro em memória aceita 0 (todas), 1, 2 ou N unidades marcadas ao mesmo tempo':
        /SEL_UNIDADE\.size===0 \|\| SEL_UNIDADE\.has\(it\.unidade\)/.test(html),
      'o relatório (CSV/PDF) manda todas as unidades marcadas, não só uma':
        /params\.set\('unidades', \[\.\.\.SEL_UNIDADE\]\.join\(','\)\)/.test(html),
    };
    const falhas = Object.entries(conf).filter(([, ok]) => !ok).map(([n]) => n);
    okSaidasMultiselect = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')}`);
  } catch (e) { okSaidasMultiselect = false; console.log('  erro: ' + e.message); }
  if (!okSaidasMultiselect) ruins += 1;
  console.log(`${okSaidasMultiselect ? '✓' : '✗'} Painel de Saídas: filtro de Loja é multiselect com checkbox (1, 2, 3 ou todas), sempre restrito ao Grupo escolhido`);

  // ------------------------------------------------------------------
  // Painel de Saídas: Conferência virou 3 colunas por TIPO (Sangria/Depósito
  // · Saída avulsa) em vez de 2 colunas por status - pedido do Master. A
  // coluna Verificadas continua junta (mistura os 2 tipos), só as
  // pendentes é que se separam.
  let okSaidasConferencia3col = false;
  try {
    const html = require('fs').readFileSync(require('path').join(__dirname, 'public', 'saidas.html'), 'utf8');
    const conf = {
      'o grid vira 3 colunas (não mais 2)': /\.kanban-3col\{display:grid;grid-template-columns:1fr;gap:14px;\}/.test(html)
        && /@media\(min-width:760px\)\{ \.kanban-3col\{grid-template-columns:1fr 1fr 1fr;\} \}/.test(html),
      'coluna própria de Sangria/Depósito pendente': /id="col-pendentes-sangria"/.test(html),
      'coluna própria de Saída avulsa pendente': /id="col-pendentes-saida"/.test(html),
      'coluna Verificadas continua existindo (junta os 2 tipos)': /id="col-verificadas"/.test(html),
      'renderTudo separa pendentes por origem (sangria x resto)': (() => {
        const i = html.indexOf('function renderTudo(){');
        const trecho = html.slice(i, i + 900);
        return /pendentesSangria = pendentes\.filter\(it=>it\.origem==='sangria'\)/.test(trecho)
          && /pendentesSaida = pendentes\.filter\(it=>it\.origem!=='sangria'\)/.test(trecho);
      })(),
    };
    const falhas = Object.entries(conf).filter(([, ok]) => !ok).map(([n]) => n);
    okSaidasConferencia3col = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')}`);
  } catch (e) { okSaidasConferencia3col = false; console.log('  erro: ' + e.message); }
  if (!okSaidasConferencia3col) ruins += 1;
  console.log(`${okSaidasConferencia3col ? '✓' : '✗'} Painel de Saídas: Conferência em 3 colunas por tipo (Sangria/Depósito · Saída avulsa), Verificadas continua junta`);

  // ------------------------------------------------------------------
  // Painel de Saídas, tela: os indicadores novos (Entrada em dinheiro e
  // Dinheiro em loja) e o gate deles. Pedido do Master: "entrada menos
  // saídas avulsas menos sangria = quanto de dinheiro tem em loja", e
  // "Saldo e a coluna de Verificadas só aparece para Master e Admin".
  let okSaidasSaldoUi = false;
  try {
    const html = require('fs').readFileSync(require('path').join(__dirname, 'public', 'saidas.html'), 'utf8');
    const conf = {
      'os dois cards novos existem': /id="kpi-entrada"/.test(html) && /id="kpi-saldo"/.test(html),
      'a fórmula fica escrita no card (ninguém precisa adivinhar de onde vem)':
        /entrada − saídas − sangria/.test(html),
      'a conta é entrada − saídas − sangria, nessa ordem':
        /const saldo = totalEntrada - totalSaidas - totalSangrias;/.test(html),
      // vermelho e' cor semantica (saiu mais do que entrou), nao decoracao
      'saldo negativo fica vermelho': /elSaldo\.classList\.toggle\('bad', saldo < 0\)/.test(html),
      'Saldo, Entrada e Verificadas nascem escondidos e só aparecem pra quem confere':
        /id="card-saldo"[^>]*class="[^"]*hidden|class="kpi destaque hidden" id="card-saldo"/.test(html)
        && /PODE_CONFERIR = IS_MASTER \|\| IS_ADMIN;/.test(html)
        && /card-saldo'\)\.classList\.remove\('hidden'\)/.test(html)
        && /col-verificadas-wrap'\)\.classList\.remove\('hidden'\)/.test(html),
      'sem a coluna Verificadas, as 2 que sobram ocupam a largura': /sem-verificadas/.test(html),
      'mover pra Sangria é botão de Master, item a item, com desfazer':
        /IS_MASTER && !it\.chave\.startsWith\('sangria::'\)/.test(html)
        && /moverOrigem\('\$\{it\.chave\}','sangria'\)/.test(html)
        && /moverOrigem\('\$\{it\.chave\}',null\)/.test(html),
      'o botão em lote só aparece pro Master e só quando há o que mover':
        /const candidatas = IS_MASTER \? filtrados\.filter\(pareceSangria\)\.length : 0;/.test(html)
        && /btnMover\.classList\.toggle\('hidden', !candidatas\)/.test(html),
    };
    const falhas = Object.entries(conf).filter(([, ok]) => !ok).map(([n]) => n);
    okSaidasSaldoUi = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')}`);
  } catch (e) { okSaidasSaldoUi = false; console.log('  erro: ' + e.message); }
  if (!okSaidasSaldoUi) ruins += 1;
  console.log(`${okSaidasSaldoUi ? '✓' : '✗'} Painel de Saídas: Entrada em dinheiro + Dinheiro em loja (entrada − saídas − sangria), só pra Master/Admin`);

  // ------------------------------------------------------------------
  // Pedido real do Master: "lancei uma sangria dia 20, teve entrada de
  // dinheiro naquele dia, então a próxima sangria já inicia com o De em
  // dia 20, só preenchendo o Até" - o "De" do período nasce igual ao "Até"
  // da ÚLTIMA sangria/depósito lançada pra unidade escolhida, em vez de
  // vir sempre em branco.
  let okSangriaAutoDe = false;
  try {
    const html = require('fs').readFileSync(require('path').join(__dirname, 'public', 'lancamento.html'), 'utf8');
    const i = html.indexOf('function preencherPeriodoSangria(){');
    const trecho = html.slice(i, i + 400);
    const conf = {
      'select de unidade chama preencherPeriodoSangria() ao trocar': /id="s-unidade" required onchange="preencherPeriodoSangria\(\)"/.test(html),
      'acha a ÚLTIMA sangria/depósito da unidade escolhida (SANGRIAS já vem ordenado por data desc)':
        /const ultima = unidade \? \(SANGRIAS\|\|\[\]\)\.find\(s=>s\.unidade===unidade\) : null;/.test(trecho),
      '"De" recebe o "Até" (periodoFim) da última - não a data crua do lançamento':
        /document\.getElementById\('s-periodo-inicio'\)\.value = ultima \? \(ultima\.periodoFim \|\| ultima\.data \|\| ''\) : '';/.test(trecho),
      'roda de novo no boot (unidade já vem pré-selecionada ao abrir a tela)': /if\(podeSangria\)\{ await carregarSangrias\(\); preencherPeriodoSangria\(\); \}/.test(html),
      'roda de novo depois de registrar uma sangria (a PRÓXIMA já nasce preenchida, sem esperar reload)':
        /await carregarSangrias\(\);\s*\n\s*preencherPeriodoSangria\(\);\s*\n\s*\}catch/.test(html),
    };
    const falhas = Object.entries(conf).filter(([, ok]) => !ok).map(([n]) => n);
    okSangriaAutoDe = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')}`);
  } catch (e) { okSangriaAutoDe = false; console.log('  erro: ' + e.message); }
  if (!okSangriaAutoDe) ruins += 1;
  console.log(`${okSangriaAutoDe ? '✓' : '✗'} Sangria/Depósito: "De" nasce com o "Até" da última sangria da unidade, atualiza ao trocar unidade e após lançar`);

  // ------------------------------------------------------------------
  // Relatórios em PDF: a coluna Descrição não pode sair cortada com "..."
  // (print do usuário mostrando "uber para pegar nutella e..." truncado no
  // PDF do Painel de Saídas). reportUtil.writePDF já tinha esse recurso
  // (linhasDinamicas: a linha cresce pra baixo e quebra o texto) mas era
  // opt-in - só 2 relatórios usavam. Virou o padrão pra TODOS os relatórios
  // que passam por reportUtil (é sempre melhor: nunca corta informação, e
  // só cresce a linha quando o texto realmente não cabe). O Painel de
  // Saídas também ganhou larguras explícitas dando mais espaço pra
  // Descrição, tirado das colunas curtas (Data/Valor/Verificada), sem
  // encolher "Verificada por" (email + data/hora, também precisa de espaço).
  let okPdfSemCorte = false;
  try {
    const src = require('fs').readFileSync(require('path').join(__dirname, 'reportUtil.js'), 'utf8');
    const srcIndex = require('fs').readFileSync(require('path').join(__dirname, 'index.js'), 'utf8');
    const iRota = srcIndex.indexOf("saidas-painel/relatorio");
    const trechoRota = srcIndex.slice(iRota, iRota + 2200);

    // exercita de verdade: um item com descrição bem comprida tem que virar
    // um PDF válido (a troca de ellipsis por quebra de linha não pode
    // quebrar a geração)
    const cabMaster = { Authorization: 'Bearer ' + token };
    const descLonga = 'uber para pegar nutella e ingredientes que faltaram de última hora pro bolo de aniversário da equipe';
    await postarJson('/api/fechamentos/lancar', {
      unidade: 'TESTE_SAIDA_DESC', unidadeNome: 'Loja Teste Descrição', grupo: 'ARCFOOD', data: '2026-08-21', campos: {},
      detalhesSaidas: [{ descricao: descLonga, valor: 19 }],
    }, cabMaster);
    const pdfResp = await pedirBinario(`/api/saidas-painel/relatorio.pdf?inicio=2026-08-21&fim=2026-08-21&grupo=ARCFOOD`, cabMaster);

    const conf = {
      'linhasDinamicas (quebra em vez de cortar) é o padrão do writePDF, não opt-in':
        /const dinamico = linhasDinamicas !== false;/.test(src),
      'com o padrão ligado, a célula nunca usa ellipsis (só quando alguém desligar de propósito)':
        /const opcoesCelula = dinamico[\s\S]{0,120}: \{ width: [\s\S]{0,60}ellipsis: true \};/.test(src),
      'o Painel de Saídas dá largura explícita maior pra Descrição, tirada das colunas curtas':
        /descricao: 236/.test(trechoRota) && /LARGURAS_SAIDAS_PAINEL/.test(trechoRota),
      'o relatório PDF sai válido com descrição comprida (a quebra de linha não quebra o PDF)':
        pdfResp.status === 200 && pdfResp.buffer.slice(0, 4).toString() === '%PDF',
    };
    const falhas = Object.entries(conf).filter(([, ok]) => !ok).map(([n]) => n);
    okPdfSemCorte = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')} (PDF status ${pdfResp.status})`);
  } catch (e) { okPdfSemCorte = false; console.log('  erro: ' + e.message); }
  if (!okPdfSemCorte) ruins += 1;
  console.log(`${okPdfSemCorte ? '✓' : '✗'} Relatórios PDF: Descrição nunca sai cortada com "..." (quebra de linha é o padrão em todos os relatórios)`);

  // ------------------------------------------------------------------
  // Formulários - campo de data clica em qualquer lugar (não só no ícone) +
  // Período do caixa (Depósito) virou 2 seletores De/Até em vez de texto
  // livre. Pedido do usuário. O servidor nunca sabe que existem 2 inputs -
  // a tela junta num valor só ("DD/MM/AAAA a DD/MM/AAAA") antes de mandar,
  // mesma convenção DD/MM/AAAA que os campos `data` já usavam.
  let okDataClicavel = false;
  try {
    const fs = require('fs');
    const path = require('path');
    const htmlForms = fs.readFileSync(path.join(__dirname, 'public', 'formularios.html'), 'utf8');
    const htmlPreencher = fs.readFileSync(path.join(__dirname, 'public', 'preencher.html'), 'utf8');
    const srcForms = fs.readFileSync(path.join(__dirname, 'formularios.js'), 'utf8');
    const temaJs = fs.readFileSync(path.join(__dirname, 'public', 'tema.js'), 'utf8');
    const cabMaster = { Authorization: 'Bearer ' + token };
    const tipos = JSON.parse((await pedir('/api/formularios/tipos', cabMaster)).corpo || '[]');
    const depositoPeriodo = (tipos.find((t) => t.tipo === 'deposito').colunas || []).find((c) => c.key === 'periodo');
    const conf = {
      'o schema marca Período do caixa como intervalo (2 datas), não texto livre':
        /key: 'periodo', label: 'PERÍODO DO CAIXA', intervalo: true/.test(srcForms),
      'a rota que a tela consulta expõe esse flag pro cliente': depositoPeriodo && depositoPeriodo.intervalo === true,
      // clique-em-qualquer-lugar-do-campo virou global (tema.js, carregado por
      // TODAS as 56 páginas) em vez de duplicado por tela - formularios.html/
      // preencher.html não têm mais listener próprio disso
      'formularios.html não duplica mais o listener (cobertura virou global)':
        !/input\[type=date\]/.test(htmlForms) && !/showPicker/.test(htmlForms),
      'preencher.html (link público) também não duplica mais':
        !/input\[type=date\]/.test(htmlPreencher) && !/showPicker/.test(htmlPreencher),
      // também tem que estar nos DOIS lugares que desenham a linha (criar E
      // editar) - senão abrir pra corrigir um Depósito antigo mostra o
      // Período do caixa como texto livre de novo
      'formularios.html: renderiza De/Até pro intervalo tanto ao criar quanto ao editar um item':
        (htmlForms.match(/if\(c\.intervalo\)/g) || []).length >= 2 && /data-col="\$\{escapeHtml\(c\.key\)\}:de"/.test(htmlForms) && /data-ed-col="\$\{escapeHtml\(c\.key\)\}:de"/.test(htmlForms),
      // tem que juntar nos DOIS caminhos que coletam linha (criar E editar) -
      // não só num deles, senão corrigir um Depósito perde o intervalo
      'formularios.html: junta De/Até num valor só antes de mandar, tanto ao criar quanto ao editar':
        /function combinarIntervalosDaLinha/.test(htmlForms)
        && (htmlForms.match(/return combinarIntervalosDaLinha\(l\);/g) || []).length >= 2,
      'preencher.html: o mesmo formulário público também junta De/Até':
        /function combinarIntervalo/.test(htmlPreencher) && /c\.intervalo/.test(htmlPreencher),
    };
    const falhas = Object.entries(conf).filter(([, ok]) => !ok).map(([n]) => n);
    okDataClicavel = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')}`);
  } catch (e) { okDataClicavel = false; console.log('  erro: ' + e.message); }
  if (!okDataClicavel) ruins += 1;
  console.log(`${okDataClicavel ? '✓' : '✗'} Formulários: data clica em qualquer lugar do campo + Período do caixa virou 2 seletores De/Até`);

  // ------------------------------------------------------------------
  // "onde for data em todo o sistema ao clicar precisa abrir a opção de
  // escolher a data" - pedido do usuário depois de ver o filtro de
  // Relatório de chamados (central-historico.html) sem esse comportamento.
  // Antes só formularios.html/preencher.html tinham o listener (duplicado,
  // local); agora mora em tema.js, o ÚNICO arquivo carregado pelas 56
  // páginas, então cobre o sistema inteiro de uma vez - inclusive telas
  // futuras, sem precisar lembrar de colar o snippet de novo.
  let okDataClicavelGlobal = false;
  try {
    const fs = require('fs');
    const path = require('path');
    const temaJs = fs.readFileSync(path.join(__dirname, 'public', 'tema.js'), 'utf8');
    const paginas = fs.readdirSync(path.join(__dirname, 'public')).filter((f) => f.endsWith('.html'));
    const semTema = paginas.filter((f) => !/src="\/tema\.js"/.test(fs.readFileSync(path.join(__dirname, 'public', f), 'utf8')));
    const conf = {
      'tema.js delega o clique em qualquer input[type=date] pro showPicker':
        /document\.addEventListener\('click', function \(e\) \{\s*var el = e\.target\.closest && e\.target\.closest\('input\[type=date\]'\);\s*if \(el && typeof el\.showPicker === 'function'\)/.test(temaJs),
      'todas as páginas carregam tema.js (senão a cobertura não é global de verdade)':
        semTema.length === 0,
      'central-historico.html (Relatório de chamados, onde o usuário viu o problema) carrega tema.js':
        /src="\/tema\.js"/.test(fs.readFileSync(path.join(__dirname, 'public', 'central-historico.html'), 'utf8')),
    };
    const falhas = Object.entries(conf).filter(([, ok]) => !ok).map(([n]) => n);
    okDataClicavelGlobal = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')}${semTema.length ? ` (sem tema.js: ${semTema.join(', ')})` : ''}`);
  } catch (e) { okDataClicavelGlobal = false; console.log('  erro: ' + e.message); }
  if (!okDataClicavelGlobal) ruins += 1;
  console.log(`${okDataClicavelGlobal ? '✓' : '✗'} Todo o sistema: campo de data clica em qualquer lugar (centralizado em tema.js, não mais por página)`);

  // ------------------------------------------------------------------
  // Formulários (Triagem): a nota explicativa fixa acima dos botões de
  // status foi removida a pedido do usuário ("não precisa") - os botões já
  // são autoexplicativos (nome + contagem), a nota só duplicava informação.
  let okTriagemSemNota = false;
  try {
    const html = require('fs').readFileSync(require('path').join(__dirname, 'public', 'formularios.html'), 'utf8');
    const conf = {
      'a nota fixa (div/CSS/toggle) não existe mais na tela':
        !/triagem-nota/.test(html),
      'os 4 botões de status continuam lá (não é a linha inteira que sumiu)':
        /COLUNAS = \[/.test(html) && /AGUARDANDO_PREENCHIMENTO/.test(html),
    };
    const falhas = Object.entries(conf).filter(([, ok]) => !ok).map(([n]) => n);
    okTriagemSemNota = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')}`);
  } catch (e) { okTriagemSemNota = false; console.log('  erro: ' + e.message); }
  if (!okTriagemSemNota) ruins += 1;
  console.log(`${okTriagemSemNota ? '✓' : '✗'} Formulários: nota fixa da Triagem removida, botões de status continuam`);

  // ------------------------------------------------------------------
  // Estoque/Inventário: CSV/PDF nas duas tabelas de números que ainda não
  // tinham (Saída e Histórico de contagens) - pedido do usuário ("emitir
  // CSV e PDF de tudo que for tabela numeros, dados relevantes"). As rotas
  // em si já são batidas por HTTP na lista "casos" lá em cima; aqui só
  // confere que a tela realmente oferece o botão (senão a rota existir
  // sozinha não ajuda ninguém).
  let okEstoqueExport = false;
  try {
    const html = require('fs').readFileSync(require('path').join(__dirname, 'public', 'estoque.html'), 'utf8');
    const conf = {
      'Saída: botões CSV/PDF chamando a rota certa':
        /onclick="baixarRelatorioSaidas\('csv'\)"/.test(html) && /onclick="baixarRelatorioSaidas\('pdf'\)"/.test(html)
        && /function baixarRelatorioSaidas\(formato\)\{[\s\S]{0,200}\/api\/inventario\/saidas\/relatorio\.\$\{formato\}/.test(html),
      'Histórico de contagens: botões CSV/PDF chamando a rota certa':
        /onclick="baixarRelatorioHistorico\('csv'\)"/.test(html) && /onclick="baixarRelatorioHistorico\('pdf'\)"/.test(html)
        && /function baixarRelatorioHistorico\(formato\)\{[\s\S]{0,400}\/api\/inventario\/historico-contagens\/relatorio\.\$\{formato\}/.test(html),
      'o relatório do Histórico respeita o filtro de setor que já existe na tela (não exporta tudo se a tela tá filtrada)':
        /const setor = document\.getElementById\('h-setor'\)\.value;\s*if\(setor\) params\.set\('setor', setor\);/.test(html),
    };
    const falhas = Object.entries(conf).filter(([, ok]) => !ok).map(([n]) => n);
    okEstoqueExport = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')}`);
  } catch (e) { okEstoqueExport = false; console.log('  erro: ' + e.message); }
  if (!okEstoqueExport) ruins += 1;
  console.log(`${okEstoqueExport ? '✓' : '✗'} Estoque/Inventário: CSV/PDF em Saída e Histórico de contagens (faltavam)`);

  // ------------------------------------------------------------------
  // Nome da unidade em destaque proprio (amarelo/negrito/maior) em qualquer
  // card ou detalhe de ticket/chamado - pedido do usuario ao ver o nome da
  // loja se misturando com email/data na mesma cor. Token+classe moram no
  // tema.js (unico arquivo carregado pelas 56 paginas), aplicado nas duas
  // familias de ticket mostradas nos prints: Central de Solicitacoes
  // (central-historico.html + ticket-publico.html) e Chamados de TI/
  // Manutencao (tecnico.html).
  let okDestaqueUnidade = false;
  try {
    const fs = require('fs');
    const path = require('path');
    const temaJs = fs.readFileSync(path.join(__dirname, 'public', 'tema.js'), 'utf8');
    const htmlCentral = fs.readFileSync(path.join(__dirname, 'public', 'central-historico.html'), 'utf8');
    const htmlTicketPublico = fs.readFileSync(path.join(__dirname, 'public', 'ticket-publico.html'), 'utf8');
    const htmlTecnico = fs.readFileSync(path.join(__dirname, 'public', 'tecnico.html'), 'utf8');
    const conf = {
      'tema.js define o token de cor + a classe utilitaria (negrito 800, maior que o texto ao redor)':
        /--destaque-unidade:#ffd43b;/.test(temaJs)
        && /\.nome-unidade\{ color:var\(--destaque-unidade,#ffd43b\); font-weight:800; font-size:1\.08em; \}/.test(temaJs),
      'o token tem versao escura pro tema Claro (amarelo claro sobre fundo branco seria ilegivel)':
        /:root\[data-tema="claro"\]\{ --destaque-unidade:#8a6300; \}/.test(temaJs),
      'Central -> Histórico: card da lista usa a classe no nome da unidade':
        /<div class="sub"><span class="nome-unidade">\$\{escapeHtml\(c\.unidadeNome\|\|c\.unidade\|\|'—'\)\}<\/span>/.test(htmlCentral),
      'Central -> Histórico: detalhe do ticket (#d-sub) usa a classe, nos dois lugares que escrevem nele (abrir e depois de mudar responsável)':
        /function fmtDSub\(c, atribuidosTxt\)\{\s*return `<span class="nome-unidade">/.test(htmlCentral)
        && (htmlCentral.match(/document\.getElementById\('d-sub'\)\.innerHTML = fmtDSub\(/g) || []).length >= 2,
      'ticket-publico.html (link público) também destaca a unidade':
        /<span class="nome-unidade">\$\{escapeHtml\(d\.unidadeNome\)\}<\/span>/.test(htmlTicketPublico),
      'Chamados de TI: card da lista e o detalhe do chamado usam a classe':
        /<div class="sub"><span class="nome-unidade">\$\{escapeHtml\(c\.unidadeNome\|\|c\.unidade\)\}<\/span>/.test(htmlTecnico)
        && /<span class="nome-unidade">\$\{escapeHtml\(c\.unidadeNome\|\|c\.unidade\)\}<\/span> · \$\{fmtDataHora\(c\.criadoEm\)\}<div class="chips-linha">/.test(htmlTecnico),
    };
    const falhas = Object.entries(conf).filter(([, ok]) => !ok).map(([n]) => n);
    okDestaqueUnidade = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')}`);
  } catch (e) { okDestaqueUnidade = false; console.log('  erro: ' + e.message); }
  if (!okDestaqueUnidade) ruins += 1;
  console.log(`${okDestaqueUnidade ? '✓' : '✗'} Nome da unidade em destaque (amarelo/negrito/maior) nos tickets/chamados`);

  // ------------------------------------------------------------------
  // Central -> Histórico: o botão "Aprovado" só dizia um número solto - o
  // usuário apontou que aprovar não é fim de linha, tem 3 estágios de
  // andamento por baixo (Pendente/Em andamento/Finalizado, ver
  // ANDAMENTO_INFO/renderAndamento já existentes no detalhe do ticket).
  // Agora o botão mostra a contagem quebrada por estágio, e a lista aberta
  // vem agrupada com subtítulo por estágio em vez de uma pilha só.
  let okAprovadoEstagios = false;
  try {
    const html = require('fs').readFileSync(require('path').join(__dirname, 'public', 'central-historico.html'), 'utf8');
    const conf = {
      'o botão "Aprovado" (e só ele) ganha a quebra por estágio, reaproveitando o ANDAMENTO_INFO que o detalhe já usa':
        /const subcontagens = status==='APROVADO'/.test(html)
        && /Object\.keys\(ANDAMENTO_INFO\)\.map\(st=>/.test(html)
        && /class="stb-subcounts"/.test(html),
      'Pendente/Rejeitado não ganham a quebra (eles não têm estágio de andamento nenhum)':
        (() => {
          const i = html.indexOf("const subcontagens = status==='APROVADO'");
          const trecho = html.slice(i, i + 400);
          return /: ''/.test(trecho);
        })(),
      'a lista aberta do Aprovado vem agrupada com subtítulo por estágio (não é mais uma pilha só)':
        /STATUS_ABERTO==='APROVADO' && doColuna\.length/.test(html)
        && /class="kanban-grupo-titulo"/.test(html),
      'o agrupamento usa o MESMO ANDAMENTO_INFO do detalhe (não inventa rótulo novo, regra do CLAUDE.md)':
        (() => {
          const i = html.indexOf('const ANDAMENTO_INFO');
          const bloco = html.slice(i, i + 200);
          return /PENDENTE: \{ label: 'Pendente', icone: '🟡' \}/.test(bloco)
            && /EM_ANDAMENTO: \{ label: 'Em andamento', icone: '🔵' \}/.test(bloco)
            && /FINALIZADO: \{ label: 'Finalizado', icone: '✅' \}/.test(bloco);
        })(),
    };
    const falhas = Object.entries(conf).filter(([, ok]) => !ok).map(([n]) => n);
    okAprovadoEstagios = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')}`);
  } catch (e) { okAprovadoEstagios = false; console.log('  erro: ' + e.message); }
  if (!okAprovadoEstagios) ruins += 1;
  console.log(`${okAprovadoEstagios ? '✓' : '✗'} Central -> Histórico: botão "Aprovado" mostra os 3 estágios de andamento, não só um número`);

  // ------------------------------------------------------------------
  // Pedido do Master: dentro do widget de chat, quando Master ou Suporte
  // está DENTRO de uma conversa aberta (atendRenderConversa), precisa ter
  // um jeito de ir pra Central do Beniboy - antes esse link só existia na
  // LISTA de conversas (atendRenderLista), então quem estava respondendo
  // uma conversa (aberta direto por um popup de alarme, por exemplo) tinha
  // que voltar pra lista antes de conseguir chegar na Central.
  let okChatLinkBeniboy = false;
  try {
    const src = require('fs').readFileSync(require('path').join(__dirname, 'public', 'suporte-chat.js'), 'utf8');
    const i = src.indexOf('function atendRenderConversa(chat, manterScroll) {');
    const trecho = src.slice(i, i + 2500);
    // o botao de PDF fica dentro do ramo verdadeiro do ternario ATEND.ehMaster
    // ? `...` : '<span></span>' - extrai só esse ramo (sem cruzar a crase de
    // fechamento) pra provar que o botao do Beniboy está FORA dele
    const ramoSoMaster = (trecho.match(/ATEND\.ehMaster \? `([^`]*)`/) || [])[1] || '';
    const conf = {
      'a conversa aberta tem um botão pra Central do Beniboy': /id="szc-atend-beniboy"/.test(trecho),
      'não fica escondido atrás do "só Master" do botão de PDF (Suporte não-Master também tem que ver)':
        !ramoSoMaster.includes('szc-atend-beniboy'),
      'manda pro beniboy.html JÁ na conversa certa (?chat=)':
        /location\.href = '\/beniboy\.html\?chat=' \+ encodeURIComponent\(chat\.id\)/.test(trecho),
    };
    const falhas = Object.entries(conf).filter(([, ok]) => !ok).map(([n]) => n);
    okChatLinkBeniboy = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')}`);
  } catch (e) { okChatLinkBeniboy = false; console.log('  erro: ' + e.message); }
  if (!okChatLinkBeniboy) ruins += 1;
  console.log(`${okChatLinkBeniboy ? '✓' : '✗'} Chat de suporte: Master/Suporte tem link pra Central do Beniboy de dentro da conversa aberta, não só na lista`);

  // ------------------------------------------------------------------
  // Status das Lojas: editar um dispositivo da rede virou um modal (apelido +
  // tipo + monitorar), não mais um prompt() de uma linha só - pedido do
  // Master pra marcar impressora/VM como monitorada. Dispositivo marcado tem
  // que mostrar um indicador (🔔) na lista, senão ninguém confere pelo
  // painel o que está armado sem abrir cada aparelho.
  let okModalDispositivo = false;
  try {
    const html = require('fs').readFileSync(require('path').join(__dirname, 'public', 'loja-status.html'), 'utf8');
    const conf = {
      'modal de dispositivo existe (não é mais prompt())': /id="disp-overlay"/.test(html) && !/function renomearDispositivo/.test(html),
      // o select e' montado pela lista do servidor (Impressora, VM Host,
      // PULSE, GCOM + o que o Master criar) - opcao cravada aqui volta a
      // limitar o Master a 2 tipos
      'select de tipo e dinamico (nada cravado no HTML)':
        /<select id="disp-tipo" onchange="dispTipoMudou\(\)"><\/select>/.test(html)
        && /TIPOS_DISP\.some/.test(html)
        && !/<option value="impressora"/.test(html),
      'tem o "+ Novo tipo" e o campo do nome dele':
        /<option value="__novo__">/.test(html) && /id="disp-tipo-novo"/.test(html),
      'tem checkbox de monitorar': /id="disp-monitorar"/.test(html),
      'salvar manda apelido+tipo+monitorar pro PUT existente':
        /apelido: document\.getElementById\('disp-apelido'\)\.value/.test(html)
        && /tipo: escolhido === '__novo__' \? null : \(escolhido \|\| null\)/.test(html)
        && /monitorar: document\.getElementById\('disp-monitorar'\)\.checked/.test(html)
        && /corpo\.tipoNovo = tipoNovo/.test(html),
      // o modal do aparelho abre DE DENTRO do modal de detalhe (o lapis fica
      // na lista de aparelhos). Sem z-index proprio ele nasce ATRAS de quem
      // o chamou - foi exatamente o que o Master reportou
      'modal do aparelho fica na frente do modal de detalhe':
        /#disp-overlay\{z-index:(\d+);\}/.test(html)
        && Number(html.match(/#disp-overlay\{z-index:(\d+);\}/)[1])
           > Number(html.match(/\.overlay\{[^}]*z-index:(\d+)/)[1]),
      'dispositivo monitorado mostra o chip 🔔 na linha': /d\.monitorar \? `<span class="disp-monitor-chip"/.test(html),
      'tipo do aparelho aparece na propria linha': /d\.tipoRotulo \? `<span class="disp-tipo-chip"/.test(html),
    };
    const falhas = Object.entries(conf).filter(([, ok]) => !ok).map(([n]) => n);
    okModalDispositivo = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')}`);
  } catch (e) { okModalDispositivo = false; console.log('  erro: ' + e.message); }
  if (!okModalDispositivo) ruins += 1;
  console.log(`${okModalDispositivo ? '✓' : '✗'} Status das Lojas: editar dispositivo vira modal (apelido+tipo+monitorar) com chip 🔔 pro que está armado`);

  // ------------------------------------------------------------------
  // Pedido do Master: "preciso ser avisado sempre que tiver alguem no chat
  // aguardando ser atendido / o alerta insista ate que algum atendente
  // assuma". Antes o reforço do alarme SÓ pegava conversa que o Beniboy
  // tinha escalado (botDesativado) - quem estava esperando com o bot ainda
  // ligado (bot travado, sem chave, ou respondendo sem resolver) não gerava
  // alarme nenhum, só o push comum. É por isso que "chegava notificação mas
  // não o alerta". Agora entra também quem falou por último e está esperando
  // além da carência, e continua insistindo até sair do PENDENTE.
  let okAlarmeAguardando = false;
  try {
    const sc = require('/home/user/adyen-monitor/server/suporteChat.js');
    const agora = Date.now();
    const iso = (msAtras) => new Date(agora - msAtras).toISOString();
    // `aguardandoHumano` é gravado pelo próprio código (criar/adicionarMensagem/
    // desativarBot) - aqui o fixture reproduz o que a produção grava, senão o
    // teste não estaria testando a mesma coisa que roda de verdade
    const chatDoc = (id, extra) => {
      const msgs = (extra && extra.mensagens) || [];
      const ultima = msgs[msgs.length - 1];
      DOCS.set(`suporteChats/${id}`, {
        id, nome: 'Visitante ' + id, status: 'ABERTO', statusAtendimento: 'PENDENTE',
        criadoEm: iso(30 * 60 * 1000), atualizadoEm: iso(30 * 60 * 1000),
        aguardandoHumano: ultima
          ? (ultima.de === 'visitante' ? true : !!(extra && extra.botDesativado))
          : true,
        ...extra,
      });
    };
    // limpa qualquer chat que outro bloco tenha deixado ABERTO+PENDENTE,
    // senão ele entra na varredura e polui a contagem deste teste
    [...DOCS.keys()].filter((k) => k.startsWith('suporteChats/')).forEach((k) => {
      const d = DOCS.get(k);
      if (d && d.status === 'ABERTO' && d.statusAtendimento === 'PENDENTE') DOCS.delete(k);
    });

    // 1) Beniboy escalou: alarma na hora (comportamento que já existia)
    chatDoc('esc1', { botDesativado: true, ultimoAlertaEm: iso(5 * 60 * 1000),
      mensagens: [{ de: 'visitante', texto: 'me ajuda', em: iso(10 * 60 * 1000) }] });
    // 2) visitante falou por último e espera há 12min, bot AINDA ligado -
    //    é o caso que antes não alarmava nunca
    chatDoc('esperando', { botDesativado: false, ultimoAlertaEm: iso(5 * 60 * 1000),
      mensagens: [{ de: 'visitante', texto: 'alguem ai?', em: iso(12 * 60 * 1000) }] });
    // 3) visitante acabou de escrever (30s): dentro da carência, NÃO alarma
    chatDoc('recente', { botDesativado: false, ultimoAlertaEm: iso(5 * 60 * 1000),
      mensagens: [{ de: 'visitante', texto: 'oi', em: iso(30 * 1000) }] });
    // 4) o bot respondeu por último: ninguém está esperando, NÃO alarma
    chatDoc('respondido', { botDesativado: false, ultimoAlertaEm: iso(5 * 60 * 1000),
      mensagens: [{ de: 'visitante', texto: 'oi', em: iso(20 * 60 * 1000) },
        { de: 'suporte', texto: 'resolvido?', em: iso(15 * 60 * 1000) }] });
    // 5) alguém ASSUMIU (saiu do PENDENTE): silencia, mesmo esperando muito
    chatDoc('assumido', { botDesativado: true, statusAtendimento: 'EM_ATENDIMENTO',
      ultimoAlertaEm: iso(5 * 60 * 1000),
      mensagens: [{ de: 'visitante', texto: 'oi', em: iso(40 * 60 * 1000) }] });
    // 6) já alarmou há 5s: respeita o REALERTA_MS (30s) e não repete agora
    chatDoc('recemAlertado', { botDesativado: true, ultimoAlertaEm: iso(5 * 1000),
      mensagens: [{ de: 'visitante', texto: 'oi', em: iso(20 * 60 * 1000) }] });
    // 7) conversa do formato ANTIGO (aberta antes deste deploy, sem o campo
    //    aguardandoHumano): não alarma. É um transitório conhecido - a
    //    próxima mensagem grava o campo e a varredura de ociosos (40min)
    //    encerra quem ficou parado. Documentado aqui pra ninguém "consertar"
    //    isso voltando a filtrar em memória, que é o que custava caro.
    DOCS.set('suporteChats/formatoAntigo', {
      id: 'formatoAntigo', nome: 'Visitante antigo', status: 'ABERTO',
      statusAtendimento: 'PENDENTE', botDesativado: true,
      criadoEm: iso(30 * 60 * 1000), atualizadoEm: iso(30 * 60 * 1000),
      ultimoAlertaEm: iso(5 * 60 * 1000),
      mensagens: [{ de: 'visitante', texto: 'oi', em: iso(20 * 60 * 1000) }],
    });

    const ids = (await sc.listarParaReforcarAlarme()).map((c) => c.id).sort();
    const esperando = (await sc.listarParaReforcarAlarme()).find((c) => c.id === 'esperando');

    // CUSTO (CLAUDE.md §3): o Firestore cobra por documento DEVOLVIDO, e essa
    // varredura roda o dia inteiro. A propriedade que importa não é "devolve
    // poucos", é "NÃO cresce com o volume de conversas". Mede antes e depois
    // de jogar 10 conversas vivas em que o bot JÁ respondeu (o caso comum
    // quando o Beniboy está funcionando): o custo tem que ficar igual, senão
    // o filtro voltou pra memória e cada tick paga por toda conversa aberta.
    const antesLeituras = LEITURAS.docs;
    await sc.listarParaReforcarAlarme();
    const custoPorTick = LEITURAS.docs - antesLeituras;

    for (let i = 0; i < 10; i++) {
      chatDoc('botRespondeu' + i, { botDesativado: false, ultimoAlertaEm: iso(5 * 60 * 1000),
        mensagens: [{ de: 'visitante', texto: 'oi', em: iso(20 * 60 * 1000) },
          { de: 'suporte', texto: 'posso ajudar?', em: iso(19 * 60 * 1000), bot: true }] });
    }
    const antesCom10 = LEITURAS.docs;
    await sc.listarParaReforcarAlarme();
    const custoCom10AMais = LEITURAS.docs - antesCom10;

    // wiring: o job tem que mandar o tempo de espera no texto do push de
    // quem entrou por espera (e não por escalação do Beniboy)
    const srcIdxAl = require('fs').readFileSync(__dirname + '/index.js', 'utf8');
    const okTextoEspera = /aguardando atendimento há \$\{chat\.esperaMin\} min/.test(srcIdxAl)
      && /push\.notifyBeniboyEscalonamento\(chat, motivo\)/.test(srcIdxAl);

    const conf = {
      'conversa escalada pelo Beniboy continua alarmando': ids.includes('esc1'),
      'quem está esperando há 12min alarma mesmo SEM o Beniboy ter escalado': ids.includes('esperando'),
      'visitante que acabou de escrever (30s) NÃO alarma - carência pro bot responder': !ids.includes('recente'),
      'conversa cuja última palavra é do atendente/bot NÃO alarma (ninguém esperando)': !ids.includes('respondido'),
      'depois que alguém ASSUME (sai do PENDENTE) o alarme para': !ids.includes('assumido'),
      'respeita o intervalo de re-alerta (não repete 5s depois)': !ids.includes('recemAlertado'),
      'o push de quem esperou carrega os minutos de espera': !!esperando && esperando.esperaMin >= 11 && esperando.esperaMin <= 13,
      'index.js manda o tempo de espera no texto do push': okTextoEspera,
      // 6 chats no cenário, 2 realmente esperando: a consulta filtra no
      // BANCO (aguardandoHumano), não em memória - senão os 6 viriam a cada
      // tick, o dia inteiro (ver o comentário de custo em suporteChat.js)
      [`o custo NÃO cresce com o volume: +10 conversas onde o bot respondeu manteve ${custoPorTick} -> ${custoCom10AMais} leitura(s) por tick`]:
        custoCom10AMais === custoPorTick,
      'conversa do formato antigo (sem o campo) não alarma - transitório conhecido do deploy': !ids.includes('formatoAntigo'),
    };
    const falhas = Object.entries(conf).filter(([, ok]) => !ok).map(([n]) => n);
    okAlarmeAguardando = !falhas.length;
    if (falhas.length) console.log(`  falhou em: ${falhas.join(' · ')}`);
  } catch (e) { okAlarmeAguardando = false; console.log('  erro: ' + e.message); }
  if (!okAlarmeAguardando) ruins += 1;
  console.log(`${okAlarmeAguardando ? '✓' : '✗'} Chat: alarme insiste por QUEM ESTÁ ESPERANDO (não só quando o Beniboy escala) e só para quando alguém assume`);

  console.log(ruins ? `\n${ruins} rota(s) com problema` : '\nTodas as rotas responderam sem estourar.');
  process.exit(ruins ? 1 : 0);
}, 2500);
