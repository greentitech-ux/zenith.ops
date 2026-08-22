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
  const okTeto = /LEITURAS_MAX_BYTES\s*=/.test(srcGuarda)
    && /pesoGuardado\(\) \+ peso > LEITURAS_MAX_BYTES/.test(srcGuarda)
    && /LEITURAS_GUARDADAS\.delete\(LEITURAS_GUARDADAS\.keys\(\)\.next\(\)\.value\)/.test(srcGuarda);
  if (!okTeto) ruins += 1;
  console.log(`${okTeto ? '✓' : '✗'} link público: leitura guardada tem teto de MEMÓRIA (bytes), não só de quantidade`);
  OCR_FALSO.ligado = false;

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
    // e o link de "solicitante preenche" não faz sentido nesse tipo
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
      'não oferece link de preenchimento (não há o que preencher)': linkPreench.status === 400,
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
        { kpi: 'Tempo de entrega', agregacao: 'média', valores: ['42:00', '31:00'] },
        // celula vazia tem que virar tracinho, nao "undefined" nem sumir
        { kpi: 'Nota do cliente', agregacao: 'média', valores: ['4,1', ''] },
        // KPI com nome que o Excel executaria como formula
        { kpi: '=SOMA(A1:A9)', agregacao: 'soma', valores: ['10', '20'] },
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
      'CSV sai com uma coluna por loja, na ordem da tela':
        linhasCsv[0] === 'KPI,Agreg.,Dom Aeroporto,Dom Tirol',
      'CSV leva os valores exatamente como a tela calculou':
        linhasCsv[1] === 'Tempo de entrega,média,42:00,31:00',
      'loja sem valor no periodo sai como tracinho, nao vazia':
        linhasCsv[2] === 'Nota do cliente,média,"4,1",—',
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

  console.log(ruins ? `\n${ruins} rota(s) com problema` : '\nTodas as rotas responderam sem estourar.');
  process.exit(ruins ? 1 : 0);
}, 2500);
