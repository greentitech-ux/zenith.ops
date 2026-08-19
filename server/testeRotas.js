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
const store = require('/home/user/adyen-monitor/server/store.js');
const parque = require('/home/user/adyen-monitor/server/parque.js');
const sheetsSync = require('/home/user/adyen-monitor/server/sheetsSync.js');

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

  // ---- caso real reportado pelo usuário: "Tirol Natal" (merchantAccountCode
  // solto, sem lar em nenhuma lista fixa) duplicando com "MMTirol Natal" (a
  // mesma loja no espaço de Entregas) - aqui o destino do fold NÃO é
  // Fechamento (essa loja não tem), é o próprio código de Entregas ----
  store.addOrUpdate({ pspReference: 'psp-fold-tirol-natal', eventCode: 'AUTHORISATION', unidade: 'Tirol Natal', status: 'APROVADO', dataHora: new Date().toISOString(), valor: 15 });
  const unidadesComTirolNatalSolto = await pedir('/api/meta/unidades', { Authorization: 'Bearer ' + token });
  let okFundeTirolNatal = false;
  try {
    const lista = JSON.parse(unidadesComTirolNatalSolto.corpo);
    okFundeTirolNatal = unidadesComTirolNatalSolto.status === 200
      && !lista.some((u) => u.codigo === 'Tirol Natal')
      && lista.some((u) => u.codigo === 'MMTirol Natal' && u.nome === 'Milky Moo Tirol Natal');
  } catch (e) { okFundeTirolNatal = false; }
  if (!okFundeTirolNatal) ruins += 1;
  console.log(`${okFundeTirolNatal ? '✓' : '✗'} "Tirol Natal" (Monitor solto) funde em "MMTirol Natal" (Entregas, sem Fechamento pra essa loja): HTTP ${unidadesComTirolNatalSolto.status}`);

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

  // ---- envio pra planilha deixou de ser so ARCFOOD: a rota agora recebe o
  // grupo. Cobre o roteamento (nao chega a falar com o Google Sheets aqui) ----
  let okEnvioGrupo = false;
  try {
    const cab = token ? { Authorization: 'Bearer ' + token } : {};
    const invalido = await postarJson('/api/fechamentos/xpto/enviar-planilha', { data: '2026-08-18' }, cab);
    const dataRuim = await postarJson('/api/fechamentos/bravo/enviar-planilha', { data: '18/08/2026' }, cab);
    const bravo = await postarJson('/api/fechamentos/bravo/enviar-planilha', { data: '2026-08-18' }, cab);
    const corpoBravo = JSON.parse(bravo.corpo || '{}');
    okEnvioGrupo = invalido.status === 400 && /Grupo inválido/.test(invalido.corpo)
      && dataRuim.status === 400 && /Data inválida/.test(dataRuim.corpo)
      // sem lançamento nenhum semeado, as 12 lojas do Bravo caem em semLancamento
      && bravo.status === 200 && corpoBravo.grupo === 'BRAVO' && corpoBravo.semLancamento.length === 12;
  } catch (e) { okEnvioGrupo = false; }
  if (!okEnvioGrupo) ruins += 1;
  console.log(`${okEnvioGrupo ? '✓' : '✗'} enviar-planilha aceita ARCFOOD e BRAVO (grupo na rota, lojas do Bravo vindas do sheetsSync)`);

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

  // ---- Fechamentos: historico do Grupo Bravo agora vem de abas
  // descobertas dinamicamente na propria planilha (uma por unidade, ver
  // abasHistoricoBravo em sheetsSync.js), no lugar de tudo empilhado na
  // aba "BD" - mesmo padrao ja usado no historico da ARCFOOD (que tem
  // abas fixas, ver ARCFOOD_ABAS_HISTORICO). Sem credencial do Google
  // Sheets (sandbox), a descoberta falha de forma silenciosa - o que
  // importa aqui e' que uma falha ali NAO derruba sincronizar() inteiro ----
  let okAbasBravo = false;
  try {
    const abas = await sheetsSync.abasHistoricoBravo();
    const resultado = await sheetsSync.sincronizar({});
    okAbasBravo = Array.isArray(abas) && abas.length === 0 && Array.isArray(resultado);
  } catch (e) { okAbasBravo = false; }
  if (!okAbasBravo) ruins += 1;
  console.log(`${okAbasBravo ? '✓' : '✗'} Fechamentos: descoberta das abas de histórico do Grupo Bravo não derruba a sincronização quando a planilha está inacessível`);

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

  // Toda pagina que chama /api/ PRECISA mandar o token do login no header.
  // Sem isso o servidor devolve 401 e a pagina mostra "Você não tem acesso a
  // esta página" pra todo mundo, Master inclusive - parece falta de
  // permissao, mas e requisicao sem credencial. Ja aconteceu duas vezes
  // (noc-maquinas.html); esta trava e pra nao acontecer uma terceira.
  // As publicas de verdade ficam de fora: usam token proprio na URL.
  const PAGINAS_PUBLICAS = [
    'atendimento.html', 'decidir.html', 'estorno-cliente.html', 'rh-cadastro.html',
    'rh-colaborador.html', 'solicitacao-publica.html', 'ticket-publico.html',
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

  console.log(ruins ? `\n${ruins} rota(s) com problema` : '\nTodas as rotas responderam sem estourar.');
  process.exit(ruins ? 1 : 0);
}, 2500);
