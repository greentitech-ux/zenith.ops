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
const store = require('/home/user/adyen-monitor/server/store.js');

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

  // ---- MIGRAÇÃO Entregas→Fechamento (ver migracaoUnidades.js): unifica o
  // código "Bessa" (Entregas) pro código "Dominos Bessa" (Fechamento) -
  // caso real que motivou a mudança (Dom Bessa aparecia como 2 cadastros) ----
  DOCS.set('entregasLive/mig1', { id: 'mig1', unidade: 'Bessa', unidadeNome: 'Dom Bessa', data: '2026-08-01', entregador: 'Fulano' });
  DOCS.set('entregaEdicoes/mig2', { id: 'mig2', entregaId: 'mig1', unidade: 'Bessa', status: 'PENDENTE' });
  DOCS.set('entregasRegras/Bessa', { unidade: 'Bessa', modo: 'plataforma', plataformaNome: 'GAMI', camposValor: [] });

  const previaMig = await pedir('/api/admin/migrar-codigos-entregas', { Authorization: 'Bearer ' + token });
  let okPreviaMig = false;
  try {
    const d = JSON.parse(previaMig.corpo);
    const bessa = d.find((x) => x.antigo === 'Bessa');
    okPreviaMig = previaMig.status === 200 && bessa
      && bessa.entregasLive === 1 && bessa.entregaEdicoes === 1 && bessa.entregasRegras === true
      && DOCS.get('entregasLive/mig1').unidade === 'Bessa'; // dry-run nao grava nada
  } catch (e) { okPreviaMig = false; }
  if (!okPreviaMig) ruins += 1;
  console.log(`${okPreviaMig ? '✓' : '✗'} prévia da migração de códigos conta o impacto sem gravar nada: HTTP ${previaMig.status} ${previaMig.corpo.slice(0, 120)}`);

  const executouMig = await postarJson('/api/admin/migrar-codigos-entregas', {}, { Authorization: 'Bearer ' + token });
  let okExecutouMig = false;
  try {
    okExecutouMig = executouMig.status === 200
      && DOCS.get('entregasLive/mig1').unidade === 'Dominos Bessa'
      && DOCS.get('entregaEdicoes/mig2').unidade === 'Dominos Bessa'
      && !DOCS.has('entregasRegras/Bessa')
      && DOCS.get('entregasRegras/Dominos Bessa').unidade === 'Dominos Bessa';
  } catch (e) { okExecutouMig = false; }
  if (!okExecutouMig) ruins += 1;
  console.log(`${okExecutouMig ? '✓' : '✗'} migração executada troca o código gravado (entregasLive/edições/regras): HTTP ${executouMig.status}`);

  const rodouDeNovo = await pedir('/api/admin/migrar-codigos-entregas', { Authorization: 'Bearer ' + token });
  let okIdempotente = false;
  try {
    const d = JSON.parse(rodouDeNovo.corpo);
    const bessa = d.find((x) => x.antigo === 'Bessa');
    okIdempotente = rodouDeNovo.status === 200 && bessa && bessa.entregasLive === 0 && bessa.entregaEdicoes === 0 && bessa.entregasRegras === false;
  } catch (e) { okIdempotente = false; }
  if (!okIdempotente) ruins += 1;
  console.log(`${okIdempotente ? '✓' : '✗'} rodar a migração de novo não acha mais nada pra mudar (idempotente): HTTP ${rodouDeNovo.status}`);

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

  // ---- MIGRAÇÃO Monitor(Adyen)→Fechamento (ver migracaoUnidades.js):
  // unifica "Mooca" (merchantAccountCode) pro código "19888" (Fechamento) -
  // cobre transações, fraude, disputas, estornos e permissões. O usuário de
  // teste tem permissão pra DOIS códigos antigos do MESMO mapa ao mesmo
  // tempo (Mooca + Sao Miguel), de propósito: é o caso que expôs o bug do
  // passe-por-código (2ª gravação desfazendo a 1ª) corrigido nesta revisão ----
  store.addOrUpdate({ pspReference: 'psp-mig-mon-1', eventCode: 'AUTHORISATION', unidade: 'Mooca', status: 'APROVADO', dataHora: new Date().toISOString(), valor: 77 });
  DOCS.set('fraudMarks/fm-mig-1', { id: 'fm-mig-1', pedidoId: 'ped-mig-mon-1', unidade: 'Mooca', nivel: 'SUSPEITO', removido: false, criadoEm: new Date().toISOString(), atualizadoEm: new Date().toISOString() });
  DOCS.set('disputes/d-mig-1', { id: 'd-mig-1', pedidoId: 'ped-mig-mon-1', unidade: 'Mooca', status: 'MONITORANDO', criadoEm: new Date().toISOString(), atualizadoEm: new Date().toISOString() });
  DOCS.set('refundRequests/r-mig-1', { id: 'r-mig-1', pedidoId: 'ped-mig-mon-1', unidade: 'Mooca', status: 'PENDENTE' });
  DOCS.set('users/mig-user-1', { email: 'mig1@teste.local', role: 'user', active: true, permissions: { sections: [], unidades: ['Mooca', 'Sao Miguel'], vaultSubgroups: [], tiposSolicitacao: [] }, createdAt: new Date().toISOString() });
  // users.list() tem cache de 60s (ver liveCache.js) - sem invalidar, o
  // usuario semeado acima direto no DOCS ficaria invisivel pra migracao
  const users = require('/home/user/adyen-monitor/server/users.js');
  await users.updatePermissions('mig-user-1', { unidades: ['Mooca', 'Sao Miguel'] });

  const previaMigMon = await pedir('/api/admin/migrar-codigos-monitor', { Authorization: 'Bearer ' + token });
  let okPreviaMigMon = false;
  try {
    const d = JSON.parse(previaMigMon.corpo);
    const mooca = d.find((x) => x.antigo === 'Mooca');
    okPreviaMigMon = previaMigMon.status === 200 && mooca
      && mooca.transacoes === 1 && mooca.fraudMarks === 1 && mooca.disputes === 1 && mooca.refundRequests === 1 && mooca.usuarios === 1
      && DOCS.get('fraudMarks/fm-mig-1').unidade === 'Mooca'; // dry-run nao grava nada
  } catch (e) { okPreviaMigMon = false; }
  if (!okPreviaMigMon) ruins += 1;
  console.log(`${okPreviaMigMon ? '✓' : '✗'} prévia da migração Monitor conta o impacto (transações/fraude/disputas/estornos/usuários) sem gravar nada: HTTP ${previaMigMon.status} ${previaMigMon.corpo.slice(0, 160)}`);

  const executouMigMon = await postarJson('/api/admin/migrar-codigos-monitor', {}, { Authorization: 'Bearer ' + token });
  let okExecutouMigMon = false;
  try {
    const txMigrada = store.allTransactions().find((t) => t.pspReference === 'psp-mig-mon-1');
    const permsUsuario = DOCS.get('users/mig-user-1').permissions.unidades;
    okExecutouMigMon = executouMigMon.status === 200
      && txMigrada && txMigrada.unidade === '19888'
      && DOCS.get('fraudMarks/fm-mig-1').unidade === '19888'
      && DOCS.get('disputes/d-mig-1').unidade === '19888'
      && DOCS.get('refundRequests/r-mig-1').unidade === '19888'
      // as DUAS permissões (de mapas diferentes) sobrevivem - a antiga (Bug
      // encontrado nesta revisão) fazia a 2a gravação reverter a 1a
      && permsUsuario.includes('19888') && permsUsuario.includes('19821')
      && !permsUsuario.includes('Mooca') && !permsUsuario.includes('Sao Miguel');
  } catch (e) { okExecutouMigMon = false; }
  if (!okExecutouMigMon) ruins += 1;
  console.log(`${okExecutouMigMon ? '✓' : '✗'} migração Monitor executada troca o código em transações/fraude/disputas/estornos/AMBAS as permissões do usuário: HTTP ${executouMigMon.status}`);

  const rodouDeNovoMon = await pedir('/api/admin/migrar-codigos-monitor', { Authorization: 'Bearer ' + token });
  let okIdempotenteMon = false;
  try {
    const d = JSON.parse(rodouDeNovoMon.corpo);
    const mooca = d.find((x) => x.antigo === 'Mooca');
    okIdempotenteMon = rodouDeNovoMon.status === 200 && mooca
      && mooca.transacoes === 0 && mooca.fraudMarks === 0 && mooca.disputes === 0 && mooca.refundRequests === 0 && mooca.usuarios === 0;
  } catch (e) { okIdempotenteMon = false; }
  if (!okIdempotenteMon) ruins += 1;
  console.log(`${okIdempotenteMon ? '✓' : '✗'} rodar a migração Monitor de novo não acha mais nada pra mudar (idempotente): HTTP ${rodouDeNovoMon.status}`);

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
