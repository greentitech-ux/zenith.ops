// index.js
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');

const store = require('./store');
const { normalize } = require('./normalize');
const { lookupBank } = require('./binLookup');
const push = require('./push');
const cardTesting = require('./cardTesting');
const cardHopping = require('./cardHopping');
const disputes = require('./disputes');
const fraudMarks = require('./fraudMarks');
const fraudReport = require('./fraudReport');
const alertReport = require('./alertReport');
const fraudIdentity = require('./fraudIdentity');
const storage = require('./storage');
const auth = require('./auth');
const users = require('./users');
const sessions = require('./sessions');
const vaultGroups = require('./vaultGroups');
const vaultSubgroups = require('./vaultSubgroups');
const vaultEntries = require('./vaultEntries');
const vaultExport = require('./vaultExport');
const refunds = require('./refunds');
const fechamentosLive = require('./fechamentosLive');
const fechamentosReport = require('./fechamentosReport');
const monitorReport = require('./monitorReport');
const reportUtil = require('./reportUtil');
const sangrias = require('./sangrias');
const entregasLive = require('./entregasLive');
const entregasRegras = require('./entregasRegras');
const backup = require('./backup');
const relatorios = require('./relatorios');
const sheetsSync = require('./sheetsSync');
const entregasSync = require('./entregasSync');
const ifoodClient = require('./ifoodClient');
const ifoodStore = require('./ifoodStore');
const ifoodSync = require('./ifoodSync');
const solicitacoes = require('./solicitacoes');
const chamadosTI = require('./chamadosTI');
const chamadosManutencao = require('./chamadosManutencao');
const suporteChat = require('./suporteChat');
const suporteChatPDF = require('./suporteChatPDF');
const segurancaChat = require('./segurancaChat');
const suporteBot = require('./suporteBot');
const pedidoWatch = require('./pedidoWatch');
const docsMaster = require('./docsMaster');
const abastecimentoCarrinho = require('./abastecimentoCarrinho');
const ativosTI = require('./ativosTI');
const centralChat = require('./centralChat');
const grupos = require('./grupos');
const inventario = require('./inventario');
const parque = require('./parque');
const festas = require('./festas');
const mensalistas = require('./mensalistas');
const termoResponsabilidade = require('./termoResponsabilidade');
const saltiversoImport = require('./saltiversoImport');
const saltiversoVendas = require('./saltiversoVendas');
const saltiversoFechamento = require('./saltiversoFechamento');
const centralCards = require('./centralCards');
const relatorioMV = require('./relatorioMV');
const rh = require('./rh');
const rhCheckin = require('./rhCheckin');
const rhAdvertencias = require('./rhAdvertencias');
const unidadesExtras = require('./unidades');
const lojaStatus = require('./lojaStatus');
const qaAprovacoes = require('./qaAprovacoes');
const agenteAcoes = require('./agenteAcoes');
const vigiaScript = require('./vigiaScript');

const upload = multer({
  storage: multer.memoryStorage(),
  // anexos de disputa incluem foto/print (pequenos), mas tambem video e audio
  // de ligacao (maiores) - ate 8 arquivos de 50MB cada por registro
  limits: { fileSize: 50 * 1024 * 1024, files: 8 },
});

// anexo do chat de suporte (widget publico, sem login) - so imagem/PDF (ver
// segurancaChat.validarAnexo), 1 arquivo por mensagem, limite bem mais baixo
// que o `upload` generico acima de proposito: e a unica rota de upload do
// app aberta pra qualquer visitante anonimo da internet
const uploadChatAnexo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
});

const app = express();

// cabecalhos de seguranca basicos em TODA resposta (sem dependencia nova):
// - nosniff: navegador nao "adivinha" tipo de arquivo (evita executar
//   upload malicioso como script)
// - SAMEORIGIN: nenhum site externo pode embutir o app num iframe
//   (clickjacking)
// - Referrer-Policy: paginas com token na URL (downloads/SSE) nao vazam a
//   URL completa pro destino quando alguem clica num link externo
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// fuso horario usado em todos os timestamps "Exportado em ..." dos
// relatorios (CSV/PDF) - sem isso, new Date().toLocaleString() usa o fuso
// do servidor (normalmente UTC em hospedagem), saindo com 2-3h de diferenca
// do horario real de Brasilia
const FUSO_BR = 'America/Sao_Paulo';
function agoraBrasiliaFmt() {
  return new Date().toLocaleString('pt-BR', { timeZone: FUSO_BR });
}

// ---------- resiliencia contra falhas temporarias do Firestore/rede ----------
// antes disso, qualquer erro nao tratado (ex: "RESOURCE_EXHAUSTED: Quota
// exceeded" do Firestore, ou uma falha de rede momentanea) derrubava o
// processo inteiro (Node encerra sozinho em uncaughtException/
// unhandledRejection sem handler). No Render isso reinicia a instancia, o
// boot roda de novo (store.init() releem tudo), e se a causa for cota
// estourada, o restart nao resolve nada - so entra num ciclo de crash-loop
// que ainda piora a propria cota (mais leituras a cada restart). Logamos o
// erro e mantemos o processo de pe; requisicoes que dependiam daquela
// chamada especifica falham com erro 500 (tratado nas rotas via try/catch),
// mas o servidor inteiro continua no ar pros outros usuarios/telas.
process.on('unhandledRejection', (err) => {
  console.error('Erro nao tratado (unhandledRejection) - processo continua rodando:', err && err.message ? err.message : err);
});
process.on('uncaughtException', (err) => {
  console.error('Excecao nao tratada (uncaughtException) - processo continua rodando:', err && err.message ? err.message : err);
});

// ---------- autenticacao basica pro dashboard/API ----------

// protege tudo (dashboard, APIs, imagens/videos anexados) atras de usuario e
// senha - o webhook da Adyen fica de fora (ja e verificado por assinatura
// HMAC, e a Adyen nao manda esse header). Sem DASHBOARD_USER/PASSWORD
// configurados, o site fica aberto (so pra facilitar teste local). Essa e
// so a primeira camada (quem tem a senha do site) - por dentro dela, cada
// pessoa loga com sua propria conta (veja auth.js) e so ve o que o Master
// liberou pra ela.
const DASHBOARD_USER = process.env.DASHBOARD_USER || '';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
function senhasIguais(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
// pagina/rotas do link publico de estorno (compartilhado com o CLIENTE FINAL
// pelo WhatsApp/QR code, sem login nenhum - ver estorno-cliente.html) tem que
// ficar de fora dessa autenticacao do dashboard. Sem essa excecao, o
// navegador do cliente pedia usuario/senha (que ele nao tem) so pra abrir a
// pagina, ou - se a pagina abria mas a chamada de API é que caia no muro -
// recebia texto puro em vez de JSON, quebrando o fetch().json() com um erro
// cru na tela ("Unexpected token 'A'...")
const ROTAS_PUBLICAS_SEM_DASHBOARD = new Set([
  '/webhooks/adyen',
  '/estorno-cliente.html',
  '/solicitacao-publica.html',
  '/atendimento.html',
  '/api/meta/unidades-publico',
  '/api/refund-requests/publico',
  '/api/solicitacoes/publico',
  '/api/bot/solicitacoes',
  '/decidir.html',
  '/api/solicitacoes/decidir-info',
  '/api/solicitacoes/decidir',
  '/suporte-chat.js',
  '/rh-colaborador.html',
  '/rh-cadastro.html',
  '/api/rh/cadastro-publico',
  '/api/loja-status/heartbeat',
  '/api/loja-status/vigia-versao',
]);
// o chat de suporte do site tem rotas com id dinamico (/api/suporte-chat/:id
// e /api/suporte-chat/:id/mensagem) - liberadas por prefixo. So o lado
// PUBLICO (singular "suporte-chat/"); o lado do atendimento e
// /api/suporte-chats (plural), que continua atras do login normal. O link de
// auto-atendimento do RH (rh-colaborador.html) tambem e por prefixo, ja que
// o token vai na propria rota (/api/rh/publico/:token/...)
// link de acao de ticket (ver ticket-publico.html) - so os sub-caminhos que
// terminam em "-publico"/"publico" ficam liberados; /api/central/:tipo/:id/chat
// (sem sufixo) continua atras do login normal, entao o regex precisa ser
// especifico pra nao vazar essa rota autenticada por engano
const ROTA_TICKET_PUBLICO_RE = /^\/api\/central\/[^/]+\/[^/]+\/(publico|chat-publico|decidir-publico|execucao-publico|anexo-publico\/\d+)$/;
// script de vigia (roda fora do navegador, direto no Windows - ver
// loja-status.html "Baixar vigia") reportando o IP da rede local: mesmo
// motivo do heartbeat, precisa ser publica (a maquina nao tem sessao de
// usuario logado)
const ROTA_LOJA_IP_LOCAL_RE = /^\/api\/loja-status\/[^/]+\/computadores\/[^/]+\/ip-local$/;
// NOCZenith reporta o resultado de um comando do agente (ver
// agenteAcoes.js/lojaStatus.js enfileirarComando) - mesmo motivo publico
// do ip-local: quem chama e a maquina, sem sessao de usuario
const ROTA_LOJA_COMANDO_RESULTADO_RE = /^\/api\/loja-status\/[^/]+\/computadores\/[^/]+\/comando-resultado$/;
// NOCZenith reporta uma conexao de acesso remoto detectada (AnyDesk,
// TeamViewer, DWService etc - ver loja-status.html "Baixar vigia") - mesmo
// motivo publico do ip-local: quem chama e a maquina, sem sessao de usuario
const ROTA_LOJA_ACESSO_REMOTO_RE = /^\/api\/loja-status\/[^/]+\/computadores\/[^/]+\/acesso-remoto$/;
// o proprio conteudo do NOCZenith (ver vigiaScript.js) - usada tanto pelo
// botao "Baixar NOCZenith" quanto pela autoatualizacao do script ja rodando
// (Verificar-Atualizacao), por isso publica igual as outras: a maquina
// (ou o navegador sem precisar mandar cookie/token) e quem chama
const ROTA_LOJA_VIGIA_SCRIPT_RE = /^\/api\/loja-status\/[^/]+\/computadores\/[^/]+\/vigia\.ps1$/;
// NOCZenith reporta o que a pessoa digitou na janela de chat flutuante
// (ver vigiaScript.js) - mesmo motivo publico das outras: quem chama e a
// maquina, sem sessao de usuario
const ROTA_LOJA_CHAT_RESPONDER_RE = /^\/api\/loja-status\/[^/]+\/computadores\/[^/]+\/chat-responder$/;
function rotaPublicaSemDashboard(path) {
  return ROTAS_PUBLICAS_SEM_DASHBOARD.has(path) || path.startsWith('/api/suporte-chat/') || path.startsWith('/api/rh/publico/')
    || ROTA_TICKET_PUBLICO_RE.test(path) || ROTA_LOJA_IP_LOCAL_RE.test(path) || ROTA_LOJA_COMANDO_RESULTADO_RE.test(path)
    || ROTA_LOJA_ACESSO_REMOTO_RE.test(path) || ROTA_LOJA_VIGIA_SCRIPT_RE.test(path) || ROTA_LOJA_CHAT_RESPONDER_RE.test(path);
}
if (DASHBOARD_USER && DASHBOARD_PASSWORD) {
  app.use((req, res, next) => {
    if (rotaPublicaSemDashboard(req.path)) return next();
    const header = req.headers.authorization || '';
    const [scheme, encoded] = header.split(' ');
    if (scheme === 'Basic' && encoded) {
      const [user, ...rest] = Buffer.from(encoded, 'base64').toString('utf8').split(':');
      const pass = rest.join(':');
      if (senhasIguais(user, DASHBOARD_USER) && senhasIguais(pass, DASHBOARD_PASSWORD)) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Zenith Ops"');
    res.status(401).send('Autenticação necessária.');
  });
} else {
  console.warn('AVISO: DASHBOARD_USER/DASHBOARD_PASSWORD nao configurados - o dashboard esta acessivel sem senha.');
}

app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3000;

// identificador unico deste processo - muda a cada deploy/restart. O
// dashboard usa isso pra recarregar sozinho quando detecta que o servidor
// subiu uma versao nova, sem precisar que alguem aperte "atualizar".
const BOOT_ID = crypto.randomUUID();

// chaves HMAC por merchant account (cada webhook na Adyen tem a sua propria chave).
// aceita tanto o formato novo (ADYEN_HMAC_KEYS, um JSON) quanto o antigo
// (ADYEN_HMAC_KEY, uma unica chave usada para qualquer conta) para nao quebrar
// quem ainda nao migrou.
let HMAC_KEYS = {};
if (process.env.ADYEN_HMAC_KEYS) {
  try {
    HMAC_KEYS = JSON.parse(process.env.ADYEN_HMAC_KEYS);
  } catch (e) {
    console.error('ADYEN_HMAC_KEYS nao e um JSON valido:', e.message);
  }
}
const LEGACY_HMAC_KEY = process.env.ADYEN_HMAC_KEY || '';

// ---------- login (sem token ainda) e portao de autenticacao pro resto da API ----------
// freio de forca-bruta no login, por IP+conta: a conta comum ja bloqueia
// sozinha com 3 senhas erradas, mas a MASTER nao (senao um atacante
// derrubaria o dono de proposito) - este freio cobre exatamente esse caso.
// 10 tentativas FALHAS em 15 min travam novas tentativas daquele IP pra
// aquela conta; acerto zera. Em memoria - reinicio limpa, o que e ok:
// forca-bruta precisa de milhares de tentativas seguidas.
const LOGIN_FALHAS = new Map();
const LOGIN_JANELA_MS = 15 * 60 * 1000;
const LOGIN_MAX_FALHAS = 10;
function chaveLogin(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
  const conta = String(req.body.identifier || req.body.email || '').trim().toLowerCase();
  return `${ip}|${conta}`;
}
app.post('/api/auth/login', async (req, res) => {
  const chave = chaveLogin(req);
  const falhas = LOGIN_FALHAS.get(chave);
  if (falhas && falhas.count >= LOGIN_MAX_FALHAS && Date.now() - falhas.desdeMs < LOGIN_JANELA_MS) {
    return res.status(429).json({ error: 'Muitas tentativas de login. Aguarde 15 minutos e tente de novo.' });
  }
  try {
    const result = await auth.login(req.body.identifier || req.body.email, req.body.password, {
      userAgent: req.headers['user-agent'],
      ip: req.headers['x-forwarded-for'] || req.ip,
    });
    LOGIN_FALHAS.delete(chave);
    res.json(result);
  } catch (err) {
    const atual = LOGIN_FALHAS.get(chave);
    if (!atual || Date.now() - atual.desdeMs >= LOGIN_JANELA_MS) LOGIN_FALHAS.set(chave, { count: 1, desdeMs: Date.now() });
    else atual.count += 1;
    // faxina preguicosa pra o Map nao crescer sem limite
    if (LOGIN_FALHAS.size > 2000) {
      for (const [k, v] of LOGIN_FALHAS) { if (Date.now() - v.desdeMs >= LOGIN_JANELA_MS) LOGIN_FALHAS.delete(k); }
    }
    res.status(401).json({ error: err.message });
  }
});

// ---------- pedido de estorno feito pelo CLIENTE FINAL (sem login, ver
// estorno-cliente.html) - unicas rotas publicas alem do login e do webhook
// da Adyen, por isso registradas antes do portao de autenticacao abaixo.
// O pedido cai na mesma fila que a loja ja usa (refunds.js), com origem
// "cliente" - o Master avalia em Central de Solicitações ou no Monitor. ----------
// lista {codigo, nome} pro formulario publico de estorno (estorno-cliente.html)
// escolher a loja - um codigo por NOME (prefere o codigo do Fechamento
// quando o mesmo nome aparece em mais de um espaco de codigo, ver
// classificarUnidade). Extraida da rota pra tambem ser usada pelo resolver
// do Beniboy (resolverUnidadePublica, ver acionarBeniboy) - mesma fonte,
// nunca duas listas divergentes.
async function listaUnidadesPublicas() {
  const mapa = await construirUnidadesMapa();
  const porNome = new Map();
  Object.entries(mapa).forEach(([codigo, nome]) => {
    const secao = classificarUnidade(codigo).secao;
    const atual = porNome.get(nome);
    if (!atual || (secao === 'Fechamento' && atual.secao !== 'Fechamento')) {
      porNome.set(nome, { codigo, nome, secao });
    }
  });
  return [...porNome.values()]
    .map(({ codigo, nome }) => ({ codigo, nome }))
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
}

app.get('/api/meta/unidades-publico', async (req, res) => {
  res.json(await listaUnidadesPublicas());
});

// dominio publico do app - usado pra montar links completos (clicaveis fora
// do Zenith, ex: mandados pelo Beniboy no chat pro colaborador repassar pro
// cliente por WhatsApp). Mesmo padrao ja usado em relatorioMV.js.
const APP_BASE_URL = (process.env.APP_BASE_URL || 'https://adyen-monitor.onrender.com').replace(/\/+$/, '');

// acha a loja que mais bate com o que o colaborador escreveu no chat (nome
// solto, com ou sem acento/maiusculas - ex: "dom bessa", "Bessa") - usado
// pelo Beniboy pra montar o link publico de estorno sem exigir que a pessoa
// saiba o nome EXATO cadastrado. Match exato (sem acento) primeiro; senao,
// junta os nomes que CONTEM o termo digitado - 1 so resultado -> acha, mais
// de 1 -> pede pra pessoa escolher entre eles (nunca adivinha errado),
// nenhum -> null.
function normalizarBusca(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
}
async function resolverUnidadePublica(termo) {
  const alvo = normalizarBusca(termo);
  if (!alvo) return { encontrada: null, candidatas: [] };
  const lista = await listaUnidadesPublicas();
  const exata = lista.find((u) => normalizarBusca(u.nome) === alvo);
  if (exata) return { encontrada: exata, candidatas: [] };
  const candidatas = lista.filter((u) => normalizarBusca(u.nome).includes(alvo));
  if (candidatas.length === 1) return { encontrada: candidatas[0], candidatas: [] };
  return { encontrada: null, candidatas };
}
function linkEstornoCliente(codigo) {
  return `${APP_BASE_URL}/estorno-cliente.html?unidade=${encodeURIComponent(codigo)}`;
}

app.post('/api/refund-requests/publico', upload.array('anexos', 5), async (req, res) => {
  try {
    const payload = req.is('multipart/form-data') ? JSON.parse(req.body.payload || '{}') : req.body;
    const {
      unidade, motivoEstorno, motivoOutro, valorVenda, formaPagamento, bandeira, ultimos4,
      dataVenda, horaVenda, valorEstornar, nomeCliente, telefoneCliente,
      pixChave, pixNomeTitular, pixBanco, observacao: observacaoCliente,
    } = payload;

    const mapa = await construirUnidadesMapa();
    const unidadeNome = mapa[unidade] || unidade;

    const anexos = [];
    for (const file of req.files || []) {
      const path = await storage.salvarArquivo(unidade || 'geral', file, 'estornos-cliente');
      anexos.push({ nome: file.originalname, path, tipo: file.mimetype || 'application/octet-stream' });
    }

    const registro = await refunds.create({
      origem: 'cliente', unidade, unidadeNome, motivoEstorno, motivoOutro, valorVenda, formaPagamento,
      bandeira, ultimos4, dataVenda, horaVenda, valorEstornar, nomeCliente, telefoneCliente, anexos,
      pixChave, pixNomeTitular, pixBanco, observacaoCliente,
    });
    broadcast('refund-requested', registro, 'monitor');
    push.notifySolicitacao(`Ticket #${registro.numeroTicket} · Pedido de estorno (cliente)`, `${unidadeNome} · R$ ${(Number(valorEstornar) || 0).toFixed(2)}`, registro.id);
    res.json({ ok: true, id: registro.id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- solicitacao generica (compra/manutencao/suporte-ti/pagamento/
// nota) preenchida por QUEM NAO TEM login no Zenith - pensado pro Beniboy
// (agente de suporte) mandar esse link quando o atendimento chegar num ponto
// que precisa de outra acao, sem precisar ensinar a pessoa a usar o sistema
// inteiro. Vira uma solicitacao normal na Central, so que sem criadoPorId
// (fica registrado como "Formulário público", com nome/contato de quem
// preencheu se informados). Estorno e ajuste de fechamento ficam de fora:
// estorno ja tem seu proprio formulario (estorno-cliente.html) e ajuste de
// fechamento depende de escolher "meu fechamento", que exige login. ----------
app.post('/api/solicitacoes/publico', upload.array('anexos', 4), async (req, res) => {
  try {
    const payload = req.is('multipart/form-data') ? JSON.parse(req.body.payload || '{}') : req.body;
    const {
      tipo, unidade, titulo, valorEstimado, observacao, itens, fornecedor, vencimento,
      solicitanteNome, solicitanteContato,
    } = payload;

    const TIPOS_PUBLICOS = ['compra', 'manutencao', 'suporte-ti', 'pagamento', 'nota'];
    if (!TIPOS_PUBLICOS.includes(tipo)) return res.status(400).json({ error: 'Tipo de solicitação inválido.' });

    const mapa = await construirUnidadesMapa();
    const unidadeNome = mapa[unidade] || unidade;

    const anexos = [];
    for (const file of req.files || []) {
      const path = await storage.salvarArquivo(unidade || 'geral', file, 'solicitacoes');
      anexos.push({ nome: file.originalname, path, tipo: file.mimetype || 'application/octet-stream' });
    }

    const quemPediu = [String(solicitanteNome || '').trim(), String(solicitanteContato || '').trim()].filter(Boolean).join(' · ');
    const registro = await solicitacoes.create({
      tipo, unidade, unidadeNome, titulo, valorEstimado, observacao, itens, anexos,
      ehOrcamento: false, fornecedor, vencimento,
      criadoPorId: null,
      criadoPorEmail: `Formulário público${quemPediu ? ' — ' + quemPediu : ''}`,
      direcionadoParaId: null,
      direcionadoParaEmail: null,
    });
    broadcast('solicitacao-criada', registro, 'solicitacoes');
    push.notifySolicitacao(`Ticket #${registro.numeroTicket} · Nova solicitação (formulário público)`, `${registro.titulo || ''} · ${registro.unidadeNome || ''}`, registro.id);
    res.json({ ok: true, id: registro.id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- rota do robo de cobranças (Claude le o email central e lança
// demandas de pagamento aqui, sem login de usuario) - protegida por um token
// fixo em env var (BOT_API_TOKEN). Sem a env var configurada, a rota fica
// desativada por completo. So cria solicitações (nunca decide/edita/exclui),
// entao o dano possivel de um token vazado e baixo - e trocar a env var
// revoga na hora. ----------
app.post('/api/bot/solicitacoes', async (req, res) => {
  const esperado = process.env.BOT_API_TOKEN || '';
  const recebido = String(req.headers['x-bot-token'] || '');
  if (!esperado) return res.status(404).json({ error: 'Rota desativada (BOT_API_TOKEN não configurado).' });
  if (!recebido || !senhasIguais(recebido, esperado)) return res.status(401).json({ error: 'Token inválido.' });
  try {
    const { tipo, unidade, unidadeNome, titulo, valorEstimado, observacao, fornecedor, vencimento } = req.body;
    const registro = await solicitacoes.create({
      tipo: tipo || 'pagamento', unidade, unidadeNome, titulo, valorEstimado, observacao,
      itens: [], anexos: [], ehOrcamento: false, fornecedor, vencimento,
      criadoPorId: 'bot-cobrancas',
      criadoPorEmail: 'robô de cobranças (email)',
      direcionadoParaId: null,
      direcionadoParaEmail: null,
    });
    broadcast('solicitacao-criada', registro, 'solicitacoes');
    push.notifySolicitacao(`Ticket #${registro.numeroTicket} · Nova solicitação (robô de cobranças)`, `${registro.titulo || ''} · ${registro.unidadeNome || ''}`, registro.id);
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- aprovar/recusar por e-mail, SEM LOGIN (ver decidir.html e
// relatorioMV.js) - protegido pelo token de uso unico gerado a cada envio do
// relatorio diario (solicitacoes.gerarTokenAcao), nao pela sessao do
// dashboard. So devolve/aceita o minimo necessario pra pagina publica
// funcionar (nunca a lista inteira do pedido nem dados de outras
// solicitacoes), seguindo o mesmo cuidado do link publico de estorno. ----------
app.get('/api/solicitacoes/decidir-info', async (req, res) => {
  const registro = await solicitacoes.buscarEstadoPorToken(req.query.ticket, req.query.token);
  if (!registro) return res.status(404).json({ error: 'Link inválido ou não encontrado.' });
  res.json({
    numeroTicket: registro.numeroTicket,
    tipo: registro.tipo,
    titulo: registro.titulo,
    unidadeNome: registro.unidadeNome || registro.unidade,
    valorEstimado: registro.valorEstimado,
    observacao: registro.observacao,
    criadoEm: registro.criadoEm,
    status: registro.status,
    execucaoStatus: registro.execucaoStatus,
    decididoPorEmail: registro.decididoPorEmail,
    decididoEm: registro.decididoEm,
    motivoDecisao: registro.motivoDecisao,
    podeDecidir: solicitacoes.podeDecidirComToken(registro, req.query.token),
  });
});

app.post('/api/solicitacoes/decidir', upload.single('comprovante'), async (req, res) => {
  try {
    const payload = req.is('multipart/form-data') ? JSON.parse(req.body.payload || '{}') : req.body;
    const { ticket, token, acao, motivoDecisao } = payload;
    const registro = await solicitacoes.validarToken(ticket, token);
    if (!registro) return res.status(404).json({ error: 'Link inválido, expirado ou já usado.' });
    let comprovante = null;
    if (req.file) {
      const path = await storage.salvarArquivo(registro.unidade || 'geral', req.file, 'solicitacoes');
      comprovante = { nome: req.file.originalname, path, tipo: req.file.mimetype || 'application/octet-stream' };
    }
    const configRelatorio = await relatorioMV.getConfig();
    const atualizado = await solicitacoes.decidirPorToken(ticket, token, {
      acao, motivoDecisao, comprovante, decididoPorEmail: configRelatorio.emailDestino,
    });
    broadcast('solicitacao-decidida', atualizado, 'solicitacoes');
    res.json({ ok: true, numeroTicket: atualizado.numeroTicket, status: atualizado.status });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- link de acao "compartilhavel" pra QUALQUER ticket da Central
// (Estorno + os 5 tipos gerais) - gerado sob demanda pelo botao "Enviar
// link" (central-historico.html), NAO pelo relatorio diario. Diferente do
// tokenAcao/decidir-info acima (uso unico, so decide, so solicitacoes.js):
// esse fica valido enquanto o ticket nao chegar num estado terminal (ver
// podeAgirComLink em refunds.js/solicitacoes.js), cobre decidir E, depois de
// aprovado, avancar a execucao, e devolve o detalhe COMPLETO (anexos+chat) -
// ver ticket-publico.html. Ficam ACIMA do app.use('/api', auth.requireAuth)
// (mesmo motivo do decidir-info/decidir acima). ----------
function moduloTicket(tipo) {
  return tipo === 'estorno' ? refunds : solicitacoes;
}

function payloadPublicoTicket(tipo, r) {
  const base = {
    numeroTicket: r.numeroTicket,
    tipo,
    unidadeNome: r.unidadeNome || r.unidade,
    status: r.status,
    execucaoStatus: r.execucaoStatus,
    execucaoPorNome: r.execucaoPorNome || null,
    criadoEm: r.criadoEm,
    motivoDecisao: r.motivoDecisao,
    decididoPorEmail: r.decididoPorEmail || r.decidedByEmail || null,
    decididoEm: r.decididoEm || r.decidedEm || null,
    anexos: (r.anexos || []).map((a, i) => ({ nome: a.nome, index: i })),
    podeDecidir: r.status === 'PENDENTE',
    podeAtualizarExecucao: r.status === 'APROVADO' && r.execucaoStatus !== 'FINALIZADO',
  };
  if (tipo === 'estorno') {
    return {
      ...base,
      titulo: `Estorno${r.nomeCliente ? ' · ' + r.nomeCliente : ''}`,
      observacao: r.observacao,
      motivoEstorno: r.motivoEstorno,
      motivoOutro: r.motivoOutro,
      valorVenda: r.valorVenda,
      formaPagamento: r.formaPagamento,
      bandeira: r.bandeira,
      ultimos4: r.ultimos4,
      dataVenda: r.dataVenda,
      horaVenda: r.horaVenda,
      valorEstornar: r.valorEstornar,
      nomeCliente: r.nomeCliente,
      telefoneCliente: r.telefoneCliente,
      pixChave: r.pixChave,
      pixNomeTitular: r.pixNomeTitular,
      pixBanco: r.pixBanco,
      observacaoCliente: r.observacaoCliente,
    };
  }
  return {
    ...base,
    titulo: r.titulo,
    valorEstimado: r.valorEstimado,
    observacao: r.observacao,
    itens: r.itens,
    ehOrcamento: r.ehOrcamento,
    fornecedor: r.fornecedor,
    vencimento: r.vencimento,
  };
}

app.get('/api/central/:tipo/:id/publico', async (req, res) => {
  const registro = await moduloTicket(req.params.tipo).buscarPorLinkAcao(req.params.id, req.query.link);
  if (!registro) return res.status(404).json({ error: 'Link inválido ou revogado.' });
  res.json(payloadPublicoTicket(req.params.tipo, registro));
});

app.get('/api/central/:tipo/:id/anexo-publico/:index', async (req, res) => {
  const registro = await moduloTicket(req.params.tipo).buscarPorLinkAcao(req.params.id, req.query.link);
  if (!registro) return res.sendStatus(404);
  const anexo = registro.anexos && registro.anexos[Number(req.params.index)];
  if (!anexo) return res.sendStatus(404);
  storage.streamArquivo(anexo.path, anexo.tipo, res);
});

app.get('/api/central/:tipo/:id/chat-publico', async (req, res) => {
  const registro = await moduloTicket(req.params.tipo).buscarPorLinkAcao(req.params.id, req.query.link);
  if (!registro) return res.status(404).json({ error: 'Link inválido ou revogado.' });
  res.json(await centralChat.listByCard(req.params.tipo, req.params.id));
});

app.post('/api/central/:tipo/:id/chat-publico', upload.single('imagem'), async (req, res) => {
  try {
    const payload = req.is('multipart/form-data') ? JSON.parse(req.body.payload || '{}') : req.body;
    const registro = await moduloTicket(req.params.tipo).buscarPorLinkAcao(req.params.id, payload.link);
    if (!registro) return res.status(404).json({ error: 'Link inválido ou revogado.' });
    const autorNome = String(payload.autorNome || '').trim().slice(0, 80) || 'Visitante';
    let imagem = null;
    if (req.file) {
      const path = await storage.salvarArquivo(req.params.id, req.file, 'central-chat');
      imagem = { nome: req.file.originalname, path, tipo: req.file.mimetype || 'application/octet-stream' };
    }
    const mensagem = await centralChat.addMessage({
      tipo: req.params.tipo,
      cardId: req.params.id,
      autorId: null,
      autorEmail: null,
      autorUsername: `${autorNome} · externo`,
      texto: payload.texto,
      imagem,
    });
    broadcast('central-chat-nova', mensagem, 'solicitacoes');
    res.json(mensagem);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/central/:tipo/:id/decidir-publico', upload.single('comprovante'), async (req, res) => {
  try {
    const payload = req.is('multipart/form-data') ? JSON.parse(req.body.payload || '{}') : req.body;
    const modulo = moduloTicket(req.params.tipo);
    let comprovante = null;
    if (req.file) {
      const registroAtual = await modulo.getOne(req.params.id);
      const path = await storage.salvarArquivo((registroAtual && registroAtual.unidade) || 'geral', req.file, 'solicitacoes');
      comprovante = { nome: req.file.originalname, path, tipo: req.file.mimetype || 'application/octet-stream' };
    }
    const atualizado = await modulo.decidirComLink(req.params.id, payload.link, {
      acao: payload.acao, motivoDecisao: payload.motivoDecisao, comprovante, autorNome: payload.autorNome,
    });
    broadcast(req.params.tipo === 'estorno' ? 'refund-request-changed' : 'solicitacao-decidida', atualizado, req.params.tipo === 'estorno' ? 'monitor' : 'solicitacoes');
    res.json({ ok: true, status: atualizado.status });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/central/:tipo/:id/execucao-publico', async (req, res) => {
  try {
    const modulo = moduloTicket(req.params.tipo);
    const atualizado = await modulo.atualizarExecucaoComLink(req.params.id, req.body.link, req.body.execucaoStatus, { autorNome: req.body.autorNome });
    broadcast(req.params.tipo === 'estorno' ? 'refund-request-changed' : 'solicitacao-decidida', atualizado, req.params.tipo === 'estorno' ? 'monitor' : 'solicitacoes');
    res.json({ ok: true, execucaoStatus: atualizado.execucaoStatus });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// lado do VISITANTE do chat de suporte (widget de canto, ver suporte-chat.js) -
// publico de proposito (Ajuda #212: "logado ou nao"), por isso fica ACIMA do
// app.use('/api', auth.requireAuth) logo abaixo. acionarBeniboy() e uma
// function declaration definida mais pra frente no arquivo, mas isso nao
// importa aqui: hoisting cobre o modulo inteiro, e o corpo dessas rotas so
// roda quando uma requisicao chega, muito depois do arquivo inteiro carregar
// se a pessoa que abriu o chat tem sessao valida (widget manda o mesmo
// authToken do localStorage - ver suporte-chat.js), devolve um retrato
// achatado da permissao dela: so o que o Beniboy precisa (suporteBot.js)
// pra decidir se oferece "consultar_pedido" e ja filtrar pelas lojas certas -
// nunca a permissao inteira. null pra visitante anonimo (widget publico).
async function usuarioLogadoDoHeader(req) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  const user = scheme === 'Bearer' ? await auth.usuarioOpcionalDoToken(token) : null;
  if (!user) return null;
  const isMaster = user.role === 'master';
  return {
    id: user.id,
    username: user.username || user.email,
    isMaster,
    unidades: isMaster ? null : (user.permissions?.unidades || []),
    // secao 'monitor' OU tag de cargo "Gerente" liberam sozinhas a ferramenta
    // de consulta de pedido do Beniboy - qualquer uma das duas basta, pedido
    // explicito do usuario ("Gerente libera sozinho")
    temMonitor: isMaster || (user.permissions?.sections || []).includes('monitor') || users.ehCargoGerente(user.cargo),
    // time de suporte (Master/Admin/secao 'suporte') ajudando OUTRA pessoa a
    // desbloquear o login pelo chat - usado por desbloquear_login
    // (suporteBot.js) pra dispensar a checagem de "contato bate com o email"
    // que protege o autoatendimento anonimo contra desbloquear conta alheia
    ehTimeSuporte: isMaster || !!user.isAdmin || (user.permissions?.sections || []).includes('suporte'),
  };
}

// forense minima de quem mandou uma mensagem/anexo suspeito no chat publico -
// pedido explicito do usuario: "tentar pegar o máximo de informação do
// acesso que tentou infiltrar malicioso". So o que da pra tirar de um
// request HTTP comum (sem exigir nada do navegador da pessoa)
function contextoSeguranca(req) {
  return {
    ip: String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim(),
    userAgent: req.headers['user-agent'] || '',
    referer: req.headers.referer || req.headers.referrer || '',
    em: new Date().toISOString(),
  };
}

// registra + avisa o Master AGORA (alarme critico, ver dispararAlarmeBeniboy
// em suporte-chat.js e push.notifySegurancaChat) de uma tentativa suspeita
// (texto tipo comando/script, ou upload bloqueado - ver segurancaChat.js).
// Fire-and-forget de proposito (mesmo padrao das outras notificacoes desse
// arquivo) - nunca atrasa nem derruba a resposta da rota que chamou
async function alertarSegurancaChat(req, chat, motivo, detalheExtra) {
  const alerta = { motivo, detalheExtra: detalheExtra ? String(detalheExtra).slice(0, 300) : null, ...contextoSeguranca(req) };
  try {
    await suporteChat.registrarAlertaSeguranca(chat.id, alerta);
  } catch (e) { console.error('Erro ao registrar alerta de segurança do chat:', e.message); }
  broadcast('chat-seguranca-alerta', { id: chat.id, nome: chat.nome, motivo, numeroTicket: chat.numeroTicket }, 'suporte');
  push.notifySegurancaChat(chat, motivo).catch((err) => console.error('Erro no push de alerta de segurança:', err.message));
}

app.post('/api/suporte-chat/iniciar', async (req, res) => {
  try {
    const logado = await usuarioLogadoDoHeader(req);
    const chat = await suporteChat.criar({ nome: req.body.nome, contato: req.body.contato, texto: req.body.texto, assunto: req.body.assunto, logado, lojaContexto: req.body.lojaContexto });
    broadcast('suporte-chat', { id: chat.id }, 'suporte');
    push.notifySolicitacao(`💬 Ticket #${chat.numeroTicket} · Novo chat de suporte`, `${chat.nome} · ${chat.contato}`, chat.id, '/tecnico.html');
    res.json({ id: chat.id, token: chat.token, numeroTicket: chat.numeroTicket });
    acionarBeniboy(chat.id);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/suporte-chat/:id', async (req, res) => {
  const chat = await suporteChat.getPublico(req.params.id, req.query.token);
  if (!chat) return res.sendStatus(404);
  res.json(chat);
});

// upload.single deixa passar mesmo sem arquivo nenhum (so multipart/
// form-data em vez de JSON) - o widget sempre manda assim agora (ver
// suporte-chat.js), tenha foto ou nao, pra usar o MESMO caminho dos dois casos
app.post('/api/suporte-chat/:id/mensagem', uploadChatAnexo.single('anexo'), async (req, res) => {
  try {
    const texto = req.body.texto || '';
    let anexo = null;
    if (req.file) {
      const validacao = segurancaChat.validarAnexo(req.file);
      if (!validacao.ok) {
        // upload bloqueado - so alerta se o id+token realmente batem com uma
        // conversa existente (evita virar um jeito facil de spammar alerta
        // pro Master so testando ids aleatorios)
        const chatAtual = await suporteChat.getComToken(req.params.id, req.body.token);
        if (chatAtual) {
          await alertarSegurancaChat(req, chatAtual, `Upload bloqueado: ${validacao.motivo}`, `arquivo: ${req.file.originalname} (${req.file.mimetype}, ${req.file.size} bytes)`);
        }
        return res.status(400).json({ error: validacao.motivo });
      }
      const path = await storage.salvarArquivo(req.params.id, req.file, 'suporte-chat');
      anexo = { nome: req.file.originalname, path, tipo: req.file.mimetype || 'application/octet-stream', tamanho: req.file.size };
    }
    const chat = await suporteChat.adicionarMensagem(req.params.id, { de: 'visitante', texto, token: req.body.token, anexo });
    broadcast('suporte-chat', { id: chat.id }, 'suporte');
    // notificacao no celular do time tambem em MENSAGEM nova (nao so na
    // abertura da conversa) - o atendente ve e responde de onde estiver
    push.notifySolicitacao(`💬 Ticket #${chat.numeroTicket} · Nova mensagem no chat de suporte`, `${chat.nome} · ${texto.slice(0, 80) || (anexo ? '📎 ' + anexo.nome : '')}`, chat.id, '/tecnico.html');
    // fecha a brecha de seguranca pedida pelo usuario: texto tipo comando/
    // script no chat publico (sem login) NUNCA e executado pelo Beniboy (ele
    // so gera texto - ver suporteBot.js), mas mandar isso e sinal forte de
    // alguem tentando manipular o atendimento/bot - alerta o Master na hora
    // com o maximo de contexto do acesso (ver alertarSegurancaChat acima)
    const motivoSuspeito = segurancaChat.detectarConteudoSuspeito(texto);
    if (motivoSuspeito) alertarSegurancaChat(req, chat, motivoSuspeito, texto);
    res.json({ ok: true });
    acionarBeniboy(chat.id);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// download do anexo de uma mensagem do chat - pro proprio visitante, mesmo
// token da conversa. Enderecado pelo INDICE da mensagem no array (mensagens
// so sao acrescentadas, nunca reordenadas/removidas - indice e estavel)
app.get('/api/suporte-chat/:id/anexo/:indice', async (req, res) => {
  const chat = await suporteChat.getComToken(req.params.id, req.query.token);
  if (!chat) return res.sendStatus(404);
  const msg = (chat.mensagens || [])[Number(req.params.indice)];
  if (!msg || !msg.anexo) return res.sendStatus(404);
  storage.streamArquivo(msg.anexo.path, msg.anexo.tipo, res);
});

// PDF da conversa pro proprio visitante (pedido explicito: "botao de gerar
// pdf da conversa") - publica igual as outras rotas de /api/suporte-chat/,
// protegida pelo mesmo token da conversa (ver suporteChat.getComToken)
app.get('/api/suporte-chat/:id/pdf', async (req, res) => {
  const chat = await suporteChat.getComToken(req.params.id, req.query.token);
  if (!chat) return res.sendStatus(404);
  suporteChatPDF.gerarChatPDF(res, chat);
});

// ---------- heartbeat de presenca das lojas (ver lojaStatus.js) - a tela
// publica atendimento.html em modo quiosque manda isso periodicamente;
// precisa ficar publica (sem login) pelo mesmo motivo do chat de suporte:
// e a propria tela da loja quem chama, sem sessao de usuario. A resposta
// carrega a mensagem pendente (se o Master/Suporte mandou uma - ver
// POST /api/loja-status/:codigo/mensagem mais abaixo), de uso unico ----------
app.post('/api/loja-status/heartbeat', async (req, res) => {
  try {
    // ip vem sempre do servidor (nunca do body que o cliente manda) - mesmo
    // padrao do freio de forca-bruta do login, ja que esse endpoint tambem e
    // publico e o client-side nao tem como saber o proprio IP publico
    const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim() || null;
    // token do agente vem no cabecalho (NOCZenith atualizado) - so ele libera
    // a entrega do comando/chat (ver lojaStatus.heartbeat); presenca/IP nao
    // dependem dele, pra maquina legada nao sumir do painel
    const token = req.headers['x-noc-token'] || req.body.token || null;
    const { mensagemPendente, comandoPendente, chatMensagens } = await lojaStatus.heartbeat(req.body.unidade, req.body.posto, {
      ip, userAgent: req.body.userAgent, abertoDesde: req.body.abertoDesde,
    }, token);
    res.json({ ok: true, mensagemPendente, comandoPendente, chatMensagens });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- IP local reportado pelo script de vigia (ver lojaStatus.js
// atualizarIpLocal + loja-status.html "Baixar vigia") - roda nativo no
// Windows, fora do navegador, por isso precisa ficar publica igual o
// heartbeat. Diferente do heartbeat, o IP vem do PROPRIO corpo da
// requisicao (nao de x-forwarded-for): e o IP da rede local da maquina, que
// o servidor nunca teria como enxergar sozinho ----------
app.post('/api/loja-status/:codigo/computadores/:posto/ip-local', async (req, res) => {
  try {
    const token = req.headers['x-noc-token'] || req.body.token || null;
    res.json(await lojaStatus.atualizarIpLocal(req.params.codigo, req.params.posto, req.body.ip, token));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- resultado de comando do agente reportado pelo NOCZenith (ver
// agenteAcoes.js/lojaStatus.js enfileirarComando+marcarComandoExecutado) -
// mesma logica publica do ip-local: quem chama e a maquina, sem sessao ----------
app.post('/api/loja-status/:codigo/computadores/:posto/comando-resultado', async (req, res) => {
  try {
    const token = req.headers['x-noc-token'] || req.body.token || null;
    res.json(await lojaStatus.marcarComandoExecutado(req.body.comandoId, { resultado: req.body.resultado, erro: req.body.erro }, {
      codigo: req.params.codigo, posto: req.params.posto, token,
    }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- resposta digitada na janela de chat flutuante do NOCZenith
// (ver vigiaScript.js) - mesma logica publica do ip-local/comando-resultado:
// quem chama e a maquina, sem sessao de usuario. So entra na thread
// (lojaStatus.responderChat) - o Master ve no modal de mensagem de
// loja-status.html no proximo poll ----------
app.post('/api/loja-status/:codigo/computadores/:posto/chat-responder', async (req, res) => {
  try {
    const token = req.headers['x-noc-token'] || req.body.token || null;
    res.json(await lojaStatus.responderChat(req.params.codigo, req.params.posto, req.body.texto, token));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- acesso remoto (AnyDesk/TeamViewer/DWService/etc) detectado pelo
// NOCZenith no computador onde esta instalado (ver lojaStatus.js
// registrarAcessoRemoto + loja-status.html "Baixar vigia") - publica pelo
// mesmo motivo do ip-local (quem chama e a maquina, sem sessao de usuario).
// Push vai SO pro Master (ver push.notifyAcessoRemotoDetectado) - e um
// alerta de seguranca, nao um aviso operacional pro time de suporte ----------
app.post('/api/loja-status/:codigo/computadores/:posto/acesso-remoto', async (req, res) => {
  try {
    const token = req.headers['x-noc-token'] || req.body.token || null;
    const registro = await lojaStatus.registrarAcessoRemoto(req.params.codigo, req.params.posto, req.body.detalhe, token);
    const mapa = await construirUnidadesMapa();
    push.notifyAcessoRemotoDetectado(mapa[req.params.codigo] || req.params.codigo, req.params.codigo, registro.nome, req.params.posto, req.body.detalhe)
      .catch((err) => console.error('Erro no push de acesso remoto:', err.message));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- versao/conteudo do NOCZenith (ver vigiaScript.js) - a versao e
// o que a autoatualizacao (Verificar-Atualizacao, dentro do proprio script)
// confere periodicamente pra saber se precisa baixar de novo; o .ps1 e o
// mesmo conteudo tanto pro botao "Baixar NOCZenith" quanto pra
// autoatualizacao baixar e sobrescrever o proprio arquivo ----------
app.get('/api/loja-status/vigia-versao', (req, res) => {
  res.json({ versao: vigiaScript.VERSAO_VIGIA });
});

// o .ps1 CARREGA o segredo do computador (agentToken) assado dentro dele -
// entao nao pode mais ser 100% publico como era. Libera pra: (1) sessao de
// Master/Suporte (o botao "Baixar NOCZenith" manda o Bearer), OU (2) um
// agente que ja tem o token daquele computador (a autoatualizacao manda no
// cabecalho X-NOC-Token) - prova que e a maquina certa se atualizando. Um
// computador ainda SEM token (nunca baixou o script novo) tambem passa, so
// pra migracao (mesma exposicao que ja existia antes desse hardening); no
// primeiro download o token e gerado e a partir dai o script fica travado
app.get('/api/loja-status/:codigo/computadores/:posto/vigia.ps1', async (req, res) => {
  try {
    const tipo = lojaStatus.TIPOS_COMPUTADOR.includes(req.query.tipo) ? req.query.tipo : 'atendimento';
    const { codigo, posto } = req.params;
    const tokenReq = req.headers['x-noc-token'] || null;
    const tokenAtual = await lojaStatus.tokenDoComputador(codigo, posto);
    let liberado = false;
    if (!tokenAtual) {
      liberado = true; // legado/migracao: computador ainda sem segredo
    } else if (tokenReq && tokenReq === tokenAtual) {
      liberado = true; // autoatualizacao do proprio agente (prova o token)
    } else {
      // sessao de Master/Suporte (download manual pela loja-status.html)
      const [scheme, bearer] = String(req.headers.authorization || '').split(' ');
      const user = scheme === 'Bearer' ? await auth.usuarioOpcionalDoToken(bearer) : null;
      const secoes = (user && user.permissions && user.permissions.sections) || [];
      liberado = !!user && (user.role === 'master' || user.isAdmin || secoes.includes('suporte'));
    }
    if (!liberado) return res.status(403).type('text/plain').send('# Acesso negado. Baixe o NOCZenith pela tela NOC Zenith (logado como Master/Suporte).');
    const agentToken = await lojaStatus.garantirAgentToken(codigo, posto);
    const conteudo = vigiaScript.montarScriptVigia({ codigo, posto, tipo, agentToken });
    res.type('text/plain').send(conteudo);
  } catch (err) {
    res.status(400).type('text/plain').send('# Erro ao gerar o script: ' + err.message);
  }
});

// comando de UMA LINHA pra colar no PowerShell da loja (botao "Copiar comando"
// na tela NOC Zenith) - baixa e instala o NOCZenith contornando o Controle de
// Aplicativo Inteligente do Windows 11 (ver montarComandoInstalacao). O comando
// leva o X-NOC-Token do computador, entao so quem gerencia (Master/Admin/Suporte)
// pode gera-lo. auth.requireAuth explicito porque esta antes do gate global.
app.get('/api/loja-status/:codigo/computadores/:posto/comando-instalacao', auth.requireAuth, async (req, res) => {
  try {
    const secoes = (req.user.permissions && req.user.permissions.sections) || [];
    if (!(req.isMaster || req.isAdmin || secoes.includes('suporte'))) {
      return res.status(403).json({ error: 'Sem permissão pra gerar o comando de instalação.' });
    }
    const tipo = lojaStatus.TIPOS_COMPUTADOR.includes(req.query.tipo) ? req.query.tipo : 'atendimento';
    const { codigo, posto } = req.params;
    const agentToken = await lojaStatus.garantirAgentToken(codigo, posto);
    res.json({ comando: vigiaScript.montarComandoInstalacao({ codigo, posto, tipo, agentToken }) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- RH: link de auto-atendimento (rh-colaborador.html) - o proprio
// colaborador preenche os dados e bate ponto por foto pelo celular, sem
// login no Zenith (pedido do usuario: "link onde sera enviado ao colaborador
// pra ele preencher os dados e fazer o check-in todos os dias"). O token
// (rh.buscarPorToken) e o unico "login" desse fluxo - por isso essas rotas
// ficam ACIMA do app.use('/api', auth.requireAuth) logo abaixo, junto dos
// outros fluxos publicos (chat de suporte, decidir, etc) ----------

// vista "segura" do funcionario pro proprio link - so o que a pessoa
// preenche/ve de si mesma, nunca campo administrativo (experiencia,
// linkToken, quem cadastrou, historico...)
function funcionarioPublico(f) {
  if (!f) return null;
  return {
    id: f.id, nome: f.nome, contato: f.contato, cargoFuncao: f.cargoFuncao,
    dataNascimento: f.dataNascimento, unidade: f.unidade, status: f.status,
    temCurriculo: !!f.curriculo,
  };
}

app.get('/api/rh/publico/:token', async (req, res) => {
  const funcionario = await rh.buscarPorToken(req.params.token);
  if (!funcionario) return res.status(404).json({ error: 'Link inválido.' });
  const aberto = await rhCheckin.buscarAbertoDoFuncionario(funcionario.id);
  res.json({ ...funcionarioPublico(funcionario), checkinAberto: aberto ? { id: aberto.id, entrada: aberto.entrada.horario } : null });
});

app.post('/api/rh/publico/:token/checkin', upload.single('foto'), async (req, res) => {
  try {
    const funcionario = await rh.buscarPorToken(req.params.token);
    if (!funcionario) return res.status(404).json({ error: 'Link inválido.' });
    let foto = null;
    if (req.file) {
      const path = await storage.salvarArquivo(funcionario.id, req.file, 'rh-checkins');
      foto = { path, tipo: req.file.mimetype };
    }
    const localizacao = lerLocalizacaoDoBody(req.body);
    const registro = await rhCheckin.registrarEntrada({ funcionarioId: funcionario.id, foto, localizacao, registradoPorEmail: null });
    broadcast('rh-checkin-atualizado', { id: registro.id, unidade: registro.unidade }, 'rh');
    if (registro.status === 'pendente_aprovacao') {
      push.notifyRhAprovacaoPendente(registro.funcionarioNome, registro.unidade, registro.motivoPendencia);
    }
    res.json({ id: registro.id, status: registro.status, entrada: registro.entrada.horario });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/rh/publico/:token/checkin/saida', upload.single('foto'), async (req, res) => {
  try {
    const funcionario = await rh.buscarPorToken(req.params.token);
    if (!funcionario) return res.status(404).json({ error: 'Link inválido.' });
    const aberto = await rhCheckin.buscarAbertoDoFuncionario(funcionario.id);
    if (!aberto) return res.status(400).json({ error: 'Você não tem check-in em aberto.' });
    let foto = null;
    if (req.file) {
      const path = await storage.salvarArquivo(funcionario.id, req.file, 'rh-checkins');
      foto = { path, tipo: req.file.mimetype };
    }
    const localizacao = lerLocalizacaoDoBody(req.body);
    const registro = await rhCheckin.registrarSaida(aberto.id, { foto, localizacao, registradoPorEmail: null });
    broadcast('rh-checkin-atualizado', { id: registro.id, unidade: registro.unidade }, 'rh');
    res.json({ id: registro.id, status: registro.status, saida: registro.saida.horario });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- auto-cadastro do PROPRIO colaborador no 1o dia de trabalho
// (server/public/rh-cadastro.html) - RH/gerente gera o link (com unidade e
// tipo ja travados, ver copiarLinkCadastroRh em rh.html) e manda pro novo
// contratado preencher os proprios dados, sem precisar login nem digitar
// nada por ele. So libera 'extra'/'candidato' (nunca 'efetivado' - contratacao
// direta continua exigindo Master/Admin/tag, ver podeCadastrarEfetivado) e
// nunca aceita semExperiencia, pelo mesmo motivo: essas duas coisas so fazem
// sentido decididas por quem tem acesso ao Zenith, nao por quem preenche um
// link publico. Devolve o linkToken de auto-atendimento (rh-colaborador.html)
// que rh.criar() ja gera sozinho, pra pessoa poder bater ponto na hora. ----------
app.post('/api/rh/cadastro-publico', upload.single('curriculo'), async (req, res) => {
  try {
    const { unidade, nome, contato, cargoFuncao, dataNascimento } = req.body;
    const tipoCadastro = req.body.tipoCadastro === 'candidato' ? 'candidato' : 'extra';
    const mapa = await construirUnidadesMapa();
    if (!unidade || !mapa[unidade]) return res.status(400).json({ error: 'Loja inválida.' });
    let curriculo = null;
    if (req.file) {
      const path = await storage.salvarArquivo(unidade, req.file, 'rh-curriculos');
      curriculo = { path, nomeOriginal: req.file.originalname, tipo: req.file.mimetype };
    }
    const registro = await rh.criar({
      unidade, nome, contato, cargoFuncao, dataNascimento, tipoCadastro,
      curriculo, cadastradoPorId: null, cadastradoPorEmail: 'Auto-cadastro (link público)',
      precisaAprovacao: true,
    });
    broadcast('rh-funcionario-criado', registro, 'rh');
    push.notifyRhCadastroPendente(registro.nome, registro.unidade);
    res.json({ id: registro.id, nome: registro.nome, linkToken: registro.linkToken });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// tudo abaixo daqui exige um usuario logado (token JWT, via header ou
// ?token= - o EventSource do SSE usa a query porque nao manda headers custom)
app.use('/api', auth.requireAuth);

app.get('/api/me', (req, res) => {
  res.json({
    id: req.user.id,
    email: req.user.email,
    username: req.user.username || null,
    role: req.user.role,
    cargo: req.user.cargo || null,
    permissions: req.permissions,
    isAdmin: req.isAdmin,
    podeCatalogoEstoque: req.podeCatalogoEstoque,
    podeCatalogoInsumos: req.podeCatalogoInsumos,
    podeCadastrarOperadores: req.podeCadastrarOperadores,
    podeRhTodasUnidades: req.podeRhTodasUnidades,
    podeRhCadastrarEfetivado: req.podeRhCadastrarEfetivado,
    precisaTrocarSenha: !!req.user.precisaTrocarSenha,
    isQaMaster: req.isQaMaster,
    isQaUser: req.isQaUser,
  });
});

// self-service: o proprio usuario logado troca a propria senha (exige a
// senha atual) - usado tanto pela troca voluntaria (Painel > Alterar senha)
// quanto pela troca obrigatoria no primeiro login apos um reset do Master
app.post('/api/me/senha', async (req, res) => {
  try {
    res.json(await users.alterarSenhaPropria(req.user.id, req.body.senhaAtual, req.body.novaSenha, req.sid));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// so a secao pedida bloqueia quem nao tem permissao - Master sempre passa
function requireSection(section) {
  return (req, res, next) => {
    if (!auth.hasSection(req, section)) return res.status(403).json({ error: 'Você não tem acesso a essa área.' });
    next();
  };
}

// passa se o usuario tiver QUALQUER uma das secoes pedidas - usado pra rotas
// de leitura compartilhadas entre dois papeis diferentes (ex: ver a sangria
// do dia dentro do Fechamento, sem ter a secao "sangria" pra criar/editar)
function requireAnySection(...sections) {
  return (req, res, next) => {
    if (!sections.some((s) => auth.hasSection(req, s))) return res.status(403).json({ error: 'Você não tem acesso a essa área.' });
    next();
  };
}

// ---------- clientes SSE conectados (para empurrar atualizacoes ao vivo pro dashboard) ----------
// cada cliente guarda suas proprias permissoes, pra so receber eventos das
// unidades/secoes que ele pode ver. ATENCAO: eventos de chamado (TI/
// manutencao) mandam so { id } de proposito, sem `unidade` - quem e
// tecnico/responsavel de manutencao enxerga pela lista de atribuicao (nao
// pela permissao de unidade), entao incluir `unidade` faria o filtro abaixo
// descartar o evento pra quem tem permissions.unidades vazio/diferente
const sseClients = new Set();
function broadcast(event, data, section) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    if (!client.isMaster) {
      if (section && !client.sections.has(section)) continue;
      if (data && data.unidade && !client.unidades.has(data.unidade)) continue;
    }
    client.res.write(payload);
  }
}

// alerta pra UMA pessoa especifica, independente da tela do Zenith que ela
// estiver com aberta (nao filtra por secao/unidade - se e pra ELA, e pra
// ela em qualquer tela) - usado pelo vigia de pedido do Beniboy
// (pedidoWatch.js). So cobre quem esta com o app ABERTO agora; pra quem
// fechou, o alerta chega por push (ver push.notifyUsuario)
function broadcastParaUsuario(userId, event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    if (client.userId === userId) client.res.write(payload);
  }
}

app.get('/api/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  res.write(`event: hello\ndata: ${JSON.stringify({ bootId: BOOT_ID })}\n\n`);
  const client = {
    res,
    userId: req.user.id,
    isMaster: req.isMaster,
    sections: req.isMaster ? null : new Set(req.permissions.sections || []),
    unidades: req.isMaster ? null : new Set(req.permissions.unidades || []),
  };
  sseClients.add(client);
  req.on('close', () => sseClients.delete(client));
});

// ---------- validacao de assinatura HMAC da Adyen ----------
// https://docs.adyen.com/development-resources/webhooks/verify-hmac-signatures/
function hmacValid(item) {
  const key = HMAC_KEYS[item.merchantAccountCode] || LEGACY_HMAC_KEY;
  if (!key) return true; // ATENCAO: sem chave configurada para essa conta, aceitamos tudo (só para testes locais)
  const a = item.additionalData || {};
  const sign = a['hmacSignature'];
  if (!sign) return false;

  const fields = [
    item.pspReference,
    item.originalReference || '',
    item.merchantAccountCode,
    item.merchantReference,
    String(item.amount?.value ?? ''),
    item.amount?.currency ?? '',
    item.eventCode,
    String(item.success),
  ];
  const signingString = fields.join(':');
  const keyBuf = Buffer.from(key, 'hex');
  const hmac = crypto.createHmac('sha256', keyBuf).update(signingString, 'utf8').digest('base64');
  return hmac === sign;
}

// quando um cluster de identidade (fraudIdentity) e confirmado como fraude
// (padrao de troca de cartao intensificou, ou ja existe outra marca FRAUDE
// no mesmo cluster), qualquer marca SUSPEITO ainda ativa nesse cluster
// tambem vira FRAUDE - "intensificou, muda a tag toda do grupo junto"
async function escalarClusterParaFraude(nomes, motivo) {
  if (!nomes || !nomes.length) return;
  const nomesNorm = new Set(nomes.map(fraudMarks.normalizarNome));
  const marcas = await fraudMarks.listAllCached();

  const suspeitosDoCluster = marcas.filter((m) => m.nivel === 'SUSPEITO' && nomesNorm.has(fraudMarks.normalizarNome(m.clienteNome)));
  for (const m of suspeitosDoCluster) {
    const registro = await fraudMarks.marcar({
      pedidoId: m.pedidoId,
      unidade: m.unidade,
      nivel: 'FRAUDE',
      motivo,
      clienteChave: m.clienteChave,
      clienteNome: m.clienteNome,
      statusPedido: m.statusPedido,
      valor: m.valor,
      marcadoPorEmail: 'deteccao-automatica@sistema',
    });
    broadcast('fraude-marcada', registro, 'monitor');
  }
}

// ---------- endpoint de webhook ----------
app.post('/webhooks/adyen', async (req, res) => {
  const items = req.body?.notificationItems || [];

  for (const wrapper of items) {
    const item = wrapper.NotificationRequestItem;
    if (!item) continue;

    if (!hmacValid(item)) {
      console.warn('Assinatura HMAC invalida, ignorando notificacao', item.pspReference);
      continue;
    }

    // eventos administrativos (ex: aviso de relatorio pronto) nao sao transacoes -
    // nao devem aparecer na lista de pedidos do dashboard
    if (item.eventCode === 'REPORT_AVAILABLE') {
      console.log('Relatorio disponivel:', item.reason);
      continue;
    }

    const tx = normalize(item);
    store.addOrUpdate(tx);
    broadcast('transaction', tx, 'monitor');
    push.notify(tx); // estorno, estorno agendado, chargeback ou fraude -> push no celular/navegador

    // recusas seguidas do mesmo cartao em poucos minutos -> possivel teste de cartao clonado
    if (tx.status === 'RECUSADO') {
      const alerta = cardTesting.registrarRecusa(tx);
      if (alerta) {
        push.notifyRaw(
          `Possível teste de cartão — ${tx.unidade || ''}`,
          `${alerta.tentativas} recusas seguidas do cartão •• ${tx.last4} em ${alerta.janelaMinutos} min`,
          `card-testing-${tx.unidade}-${tx.last4}`,
          tx.unidade
        );
      }
    }

    // identificador de pedido usado em todo o bloco de deteccao de fraude
    // abaixo (mesmo calculo usado no resto do arquivo)
    const pedidoIdAtual = tx.merchantReference || tx.originalReference || tx.pspReference;

    // cruza o nome do cliente (shopper) com o nome impresso no cartao pra
    // ligar pedidos de nomes "diferentes" que na verdade sao o mesmo anel
    // de fraude (ex real: um pedido tem nomeCliente "Thais Mendes" e
    // cardHolder "Luciano Jose"; outro tem nomeCliente "Luciano Silva" e
    // cardHolder "Thais M Mendes" - os nomes se cruzam entre os campos).
    // Todo o resto do bloco usa esse cluster como identidade, em vez de so
    // o nome exato - ver fraudIdentity.js
    const clusterInfo = fraudIdentity.registrarPedido(pedidoIdAtual, tx.nomeCliente, tx.cardHolder);

    // a propria Adyen ja marca o pedido como suspeito de fraude
    // (fraudResultType/totalFraudScore) - nesse caso NAO colocamos nossa
    // TAG de FRAUDE por cima: duplicaria a mesma informacao nos relatorios.
    // O objetivo da nossa deteccao e pegar o que a Adyen NAO pegou sozinha.
    const jaFraudeNativaAdyen = !!tx.fraudeSuspeita;

    // mesmo cliente (mesmo nome) testando varios finais de cartao
    // DIFERENTES num intervalo curto -> padrao classico de cartao
    // clonado/roubado, com ou sem nenhuma aprovacao acontecer (um ataque
    // 100% recusado e igualmente suspeito). Quando detecta, marca o
    // pedido que cruzou o limiar como FRAUDE automaticamente, na mesma
    // fila do botao manual "Marcar fraude" - aparece no painel/monitor
    // sem precisar de ninguem clicar. So dispara uma vez por ataque (ver
    // cardHopping.js); as tentativas seguintes da mesma pessoa (podem ser
    // muitas, em massa) entram sozinhas pela propagacao por identidade
    // logo abaixo, sem precisar de um motivo detalhado pra cada uma -
    // e qualquer SUSPEITO ja existente no mesmo cluster de nomes escala
    // pra FRAUDE junto (o padrao "intensificou" pro grupo inteiro)
    if ((tx.status === 'RECUSADO' || tx.status === 'APROVADO') && !jaFraudeNativaAdyen) {
      // conta cartoes distintos pelo CLUSTER (nomes cruzados), nao so pelo
      // nome exato desse pedido - assim um ataque que troca de nome a cada
      // tentativa (alem do cartao) tambem cruza o limiar
      const chaveCardHopping = clusterInfo ? `${tx.unidade}:cluster:${clusterInfo.clusterId}` : undefined;
      const padraoTroca = cardHopping.registrarTentativa(tx, chaveCardHopping);
      if (padraoTroca) {
        try {
          const clienteNome = tx.nomeCliente || tx.cardHolder || null;
          const registro = await fraudMarks.marcar({
            pedidoId: pedidoIdAtual,
            unidade: tx.unidade,
            nivel: 'FRAUDE',
            motivo: `Detecção automática: ${padraoTroca.cartoesDistintos} finais de cartão diferentes testados pelo mesmo cliente em ${padraoTroca.janelaMinutos} min.`,
            clienteChave: clienteNome ? `nome:${clienteNome}` : null,
            clienteNome,
            statusPedido: tx.status,
            valor: tx.valor,
            marcadoPorEmail: 'deteccao-automatica@sistema',
          });
          broadcast('fraude-marcada', registro, 'monitor');
          push.notifyRaw(
            `🚫 Fraude detectada automaticamente — ${tx.unidade || ''}`,
            `${clienteNome || 'Cliente'} testou ${padraoTroca.cartoesDistintos} cartões diferentes em pouco tempo`,
            `fraude-auto-${pedidoIdAtual}`,
            tx.unidade
          );
          if (clusterInfo) {
            await escalarClusterParaFraude(clusterInfo.nomes, 'Escalado: padrão de troca de cartão confirmado no mesmo grupo de pedidos.');
          }
        } catch (err) {
          console.error('Erro ao marcar fraude automática (troca de cartão):', err.message);
        }
      }
    }

    // identidade cruzada (cluster de nomes/cartoes ligados, ver acima): a
    // partir do 2º pedido conectado no mesmo cluster ja marca SUSPEITO,
    // mesmo sem repetir cartao - nao precisa esperar acumular varias
    // tentativas iguais, o simples cruzamento de nome ja e o sinal. Se o
    // cluster ja tem FRAUDE confirmada (por essa via ou pela troca de
    // cartao acima, ou por marcacao manual), propaga pro pedido novo e
    // escala qualquer SUSPEITO residual do mesmo grupo junto. Preferimos
    // alertar demais a deixar passar batido - o Master sempre pode
    // remover a marcacao de um pedido especifico se for engano.
    if (clusterInfo) {
      try {
        const marcasExistentes = await fraudMarks.listAllCached();
        const jaMarcadoNesse = marcasExistentes.some((m) => m.pedidoId === pedidoIdAtual);

        const nomesClusterNorm = new Set(clusterInfo.nomes.map(fraudMarks.normalizarNome));
        const marcaFraudeCluster = marcasExistentes.find(
          (m) => m.nivel === 'FRAUDE' && nomesClusterNorm.has(fraudMarks.normalizarNome(m.clienteNome))
        );
        const clienteNome = tx.nomeCliente || tx.cardHolder || null;

        if (marcaFraudeCluster) {
          if (!jaMarcadoNesse && !jaFraudeNativaAdyen) {
            const registro = await fraudMarks.marcar({
              pedidoId: pedidoIdAtual,
              unidade: tx.unidade,
              nivel: 'FRAUDE',
              motivo: 'Cliente já identificado como fraude (nome ou cartão relacionado a pedido(s) anterior(es)).',
              clienteChave: clienteNome ? `nome:${clienteNome}` : null,
              clienteNome,
              statusPedido: tx.status,
              valor: tx.valor,
              marcadoPorEmail: 'deteccao-automatica@sistema',
            });
            broadcast('fraude-marcada', registro, 'monitor');
            push.notifyRaw(
              `🚫 Fraude (cliente já conhecido) — ${tx.unidade || ''}`,
              `${clienteNome || 'Cliente'} está ligado a pedido(s) já confirmado(s) como fraude`,
              `fraude-auto-${pedidoIdAtual}`,
              tx.unidade
            );
          }
          await escalarClusterParaFraude(clusterInfo.nomes, 'Escalado: outro pedido do mesmo grupo já confirmado como fraude.');
        } else if (!jaMarcadoNesse && clusterInfo.totalPedidos >= 2) {
          const registro = await fraudMarks.marcar({
            pedidoId: pedidoIdAtual,
            unidade: tx.unidade,
            nivel: 'SUSPEITO',
            motivo: `Nome ou cartão relacionado a outro pedido recente (grupo: ${clusterInfo.nomeRepresentativo || 'sem nome'}).`,
            clienteChave: clienteNome ? `nome:${clienteNome}` : null,
            clienteNome,
            statusPedido: tx.status,
            valor: tx.valor,
            marcadoPorEmail: 'deteccao-automatica@sistema',
          });
          broadcast('fraude-marcada', registro, 'monitor');
        }
      } catch (err) {
        console.error('Erro ao processar identidade cruzada de fraude:', err.message);
      }
    }

    // se esse pedido ja tinha outro status antes (ex: APROVADO -> ESTORNADO -> CHARGEBACK),
    // avisa o dashboard pra atualizar a secao de pedidos que mudaram de status
    const order = store.orderFor(tx.merchantReference || tx.originalReference || tx.pspReference);
    if (order && new Set(order.history.map((h) => h.status)).size > 1) {
      broadcast('order-changed', order, 'monitor');
    }
    // alguem pode estar de olho nesse pedido especifico (perguntou pro
    // Beniboy no chat) - confere e alerta se o status mudou desde a resposta
    if (order) {
      verificarAlertaPedido(order).catch((err) => console.error('[pedidoWatch] falha ao verificar alerta:', err.message));
    }

    // avisa o dashboard pra atualizar a secao dedicada de chargebacks
    if (['CHARGEBACK', 'CHARGEBACK_REVERTIDO', 'NOTIFICATION_OF_CHARGEBACK', 'DISPUTE_DEFENSE_PERIOD_ENDED', 'RETRIEVAL_REQUEST'].includes(tx.status)) {
      broadcast('chargeback', order || tx, 'monitor');
    }

    // BIN lookup assincrono (nao bloqueia a resposta do webhook - a Adyen espera resposta rapida)
    if (tx.bin) {
      lookupBank(tx.bin).then((bank) => {
        if (bank) {
          const updated = { ...tx, bancoEmissor: bank };
          store.addOrUpdate(updated);
          broadcast('update', updated, 'monitor');
        }
      });
    }
  }

  // a Adyen exige essa resposta exata, e rapido (poucos segundos)
  res.send('[accepted]');
});

// ---------- API para o dashboard (secao "monitor") ----------
app.get('/api/transactions', requireSection('monitor'), (req, res) => {
  res.json(auth.filterByUnidade(req, store.allTransactions()));
});

app.get('/api/clients/:key', requireSection('monitor'), (req, res) => {
  const allowed = req.isMaster ? null : new Set(req.permissions.unidades || []);
  res.json(store.clientStats(decodeURIComponent(req.params.key), allowed));
});

// comentario manual sobre um estorno (ex: "estornei eu mesmo pelo painel da Adyen")
app.patch('/api/transactions/:pspReference/:eventCode/comentario', requireSection('monitor'), (req, res) => {
  const eventCode = decodeURIComponent(req.params.eventCode);
  const existente = store.allTransactions().find((t) => t.pspReference === req.params.pspReference && t.eventCode === eventCode);
  if (!existente) return res.sendStatus(404);
  if (!req.isMaster && !(req.permissions.unidades || []).includes(existente.unidade)) return res.sendStatus(404);

  const tx = store.setComentario(req.params.pspReference, eventCode, req.body.comentario || '');
  broadcast('update', tx, 'monitor');
  res.json(tx);
});

app.get('/api/orders', requireSection('monitor'), (req, res) => {
  res.json(auth.filterByUnidade(req, store.allOrders()));
});

app.get('/api/orders/changed', requireSection('monitor'), (req, res) => {
  res.json(auth.filterByUnidade(req, store.ordersChanged()));
});

app.get('/api/chargebacks', requireSection('monitor'), (req, res) => {
  res.json(auth.filterByUnidade(req, store.chargebacks()));
});

// ---------- relatorios (CSV/PDF) dos paineis do Monitor de transacoes:
// Transacoes, Pedidos repetidos, Chargeback, Pedidos que mudaram de status e
// Comparativo por unidade - mesma secao 'monitor' da tela (nao restrito ao
// Master), respeitando as unidades que o usuario tem permissao de ver.
// Filtros por query string: inicio/fim (periodo), status (lista separada por
// virgula) e unidades (lista separada por virgula) - mesmos filtros da tela.
function filtrarTransacoesPeriodo(req) {
  const { inicio, fim, status, unidades } = req.query;
  const statusSet = status ? new Set(String(status).split(',').filter(Boolean)) : null;
  const unidadesSet = unidades ? new Set(String(unidades).split(',').filter(Boolean)) : null;
  const permitido = auth.filterByUnidade(req, store.allTransactions());
  return permitido.filter((t) =>
    (!statusSet || statusSet.has(t.status)) &&
    (!unidadesSet || unidadesSet.has(t.unidade)) &&
    (!inicio || (t.dataHora || '') >= inicio) &&
    (!fim || (t.dataHora || '') <= fim + 'T23:59:59')
  );
}
function filtrarPedidosPeriodo(lista, req, campoData) {
  const { inicio, fim, status, unidades } = req.query;
  const statusSet = status ? new Set(String(status).split(',').filter(Boolean)) : null;
  const unidadesSet = unidades ? new Set(String(unidades).split(',').filter(Boolean)) : null;
  const permitido = auth.filterByUnidade(req, lista);
  return permitido.filter((o) => {
    const data = o[campoData] || o.ultimaAtualizacao;
    return (!statusSet || statusSet.has(o.statusAtual)) &&
      (!unidadesSet || unidadesSet.has(o.unidade)) &&
      (!inicio || (data || '') >= inicio) &&
      (!fim || (data || '') <= fim + 'T23:59:59');
  });
}
function unidadesDoQuery(req) {
  return req.query.unidades ? String(req.query.unidades).split(',').filter(Boolean) : [];
}
function periodoTexto(req) {
  const { inicio, fim } = req.query;
  return inicio || fim ? ` · período: ${inicio || 'início'} a ${fim || 'hoje'}` : '';
}

app.get('/api/monitor/relatorio-transacoes.csv', requireSection('monitor'), (req, res) => {
  const { colunas, linhas } = monitorReport.prepararTransacoes(filtrarTransacoesPeriodo(req));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${monitorReport.nomeArquivoComUnidades('transacoes', unidadesDoQuery(req))}.csv"`);
  res.send(monitorReport.toCSV(colunas, linhas));
});
app.get('/api/monitor/relatorio-transacoes.pdf', requireSection('monitor'), (req, res) => {
  const { colunas, linhas } = monitorReport.prepararTransacoes(filtrarTransacoesPeriodo(req));
  const subtitulo = `Exportado em ${agoraBrasiliaFmt()}${periodoTexto(req)} · ${linhas.length} transação(ões)`;
  monitorReport.writePDF(res, {
    titulo: 'Relatório de Transações', subtitulo, colunas, linhas,
    nomeArquivo: monitorReport.nomeArquivoComUnidades('transacoes', unidadesDoQuery(req)),
  });
});

app.get('/api/monitor/relatorio-repetidos.csv', requireSection('monitor'), (req, res) => {
  const { colunas, linhas } = monitorReport.prepararRepetidos(filtrarTransacoesPeriodo(req));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${monitorReport.nomeArquivoComUnidades('pedidos-repetidos', unidadesDoQuery(req))}.csv"`);
  res.send(monitorReport.toCSV(colunas, linhas));
});
app.get('/api/monitor/relatorio-repetidos.pdf', requireSection('monitor'), (req, res) => {
  const { colunas, linhas } = monitorReport.prepararRepetidos(filtrarTransacoesPeriodo(req));
  const subtitulo = `Exportado em ${agoraBrasiliaFmt()}${periodoTexto(req)} · ${linhas.length} grupo(s) de pedidos repetidos`;
  monitorReport.writePDF(res, {
    titulo: 'Relatório de Pedidos Repetidos', subtitulo, colunas, linhas,
    nomeArquivo: monitorReport.nomeArquivoComUnidades('pedidos-repetidos', unidadesDoQuery(req)),
  });
});

app.get('/api/monitor/relatorio-chargebacks.csv', requireSection('monitor'), (req, res) => {
  const { colunas, linhas } = monitorReport.prepararChargebacks(filtrarPedidosPeriodo(store.chargebacks(), req, 'dataChargeback'));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${monitorReport.nomeArquivoComUnidades('chargebacks', unidadesDoQuery(req))}.csv"`);
  res.send(monitorReport.toCSV(colunas, linhas));
});
app.get('/api/monitor/relatorio-chargebacks.pdf', requireSection('monitor'), (req, res) => {
  const { colunas, linhas } = monitorReport.prepararChargebacks(filtrarPedidosPeriodo(store.chargebacks(), req, 'dataChargeback'));
  const subtitulo = `Exportado em ${agoraBrasiliaFmt()}${periodoTexto(req)} · ${linhas.length} chargeback(s)`;
  monitorReport.writePDF(res, {
    titulo: 'Relatório de Chargebacks', subtitulo, colunas, linhas,
    nomeArquivo: monitorReport.nomeArquivoComUnidades('chargebacks', unidadesDoQuery(req)),
  });
});

app.get('/api/monitor/relatorio-mudaram-status.csv', requireSection('monitor'), (req, res) => {
  const { colunas, linhas } = monitorReport.prepararMudaramStatus(filtrarPedidosPeriodo(store.ordersChanged(), req, 'ultimaAtualizacao'));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${monitorReport.nomeArquivoComUnidades('pedidos-mudaram-status', unidadesDoQuery(req))}.csv"`);
  res.send(monitorReport.toCSV(colunas, linhas));
});
app.get('/api/monitor/relatorio-mudaram-status.pdf', requireSection('monitor'), (req, res) => {
  const { colunas, linhas } = monitorReport.prepararMudaramStatus(filtrarPedidosPeriodo(store.ordersChanged(), req, 'ultimaAtualizacao'));
  const subtitulo = `Exportado em ${agoraBrasiliaFmt()}${periodoTexto(req)} · ${linhas.length} pedido(s)`;
  monitorReport.writePDF(res, {
    titulo: 'Relatório de Pedidos que Mudaram de Status', subtitulo, colunas, linhas,
    nomeArquivo: monitorReport.nomeArquivoComUnidades('pedidos-mudaram-status', unidadesDoQuery(req)),
  });
});

// comparativo-unidade usa fraudMarks.listAllCached() (nao listAll()) -
// listAll() faz leitura direta no Firestore sem cache; usar sem cache aqui
// foi a causa provavel de estourar a cota de leitura numa versao anterior
// desta feature (revertida em producao por esse motivo). Ver fraudMarks.js.
app.get('/api/monitor/relatorio-comparativo-unidade.csv', requireSection('monitor'), async (req, res) => {
  try {
    const marcas = await fraudMarks.listAllCached();
    const rows = monitorReport.semFraudeECapeado(filtrarTransacoesPeriodo(req), marcas);
    const { colunas, linhas } = monitorReport.prepararComparativoUnidade(rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${monitorReport.nomeArquivoComUnidades('comparativo-unidade', unidadesDoQuery(req))}.csv"`);
    res.send(monitorReport.toCSV(colunas, linhas));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get('/api/monitor/relatorio-comparativo-unidade.pdf', requireSection('monitor'), async (req, res) => {
  try {
    const marcas = await fraudMarks.listAllCached();
    const rows = monitorReport.semFraudeECapeado(filtrarTransacoesPeriodo(req), marcas);
    const { colunas, linhas } = monitorReport.prepararComparativoUnidade(rows);
    const subtitulo = `Exportado em ${agoraBrasiliaFmt()}${periodoTexto(req)} · ${linhas.length} unidade(s)`;
    monitorReport.writePDF(res, {
      titulo: 'Relatório Comparativo por Unidade', subtitulo, colunas, linhas,
      nomeArquivo: monitorReport.nomeArquivoComUnidades('comparativo-unidade', unidadesDoQuery(req)),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- marcacao manual de suspeita/fraude por pedido (monitoramento
// efetivo, separado do status que vem da Adyen - esse continua intacto) ----------
app.get('/api/fraude', requireSection('monitor'), (req, res) => {
  fraudMarks.listAllCached().then((lista) => res.json(auth.filterByUnidade(req, lista)));
});


app.post('/api/fraude/marcar', requireSection('monitor'), async (req, res) => {
  try {
    const { pedidoId, unidade, nivel, motivo, clienteChave, clienteNome, statusPedido, valor } = req.body;
    if (!req.isMaster && unidade && !(req.permissions.unidades || []).includes(unidade)) {
      return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    }
    const registro = await fraudMarks.marcar({
      pedidoId, unidade, nivel, motivo, clienteChave, clienteNome, statusPedido, valor,
      marcadoPorEmail: req.user.email,
    });
    broadcast('fraude-marcada', registro, 'monitor');
    if (nivel === 'FRAUDE') {
      push.notifyRaw(
        '🚫 Pedido marcado como fraude',
        `${registro.clienteNome || 'Cliente'} · ${registro.unidade || ''}${registro.motivo ? ' · ' + registro.motivo : ''}`,
        `fraude-${registro.pedidoId}`,
        registro.unidade
      );
    }
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/fraude/:pedidoId', requireSection('monitor'), async (req, res) => {
  await fraudMarks.remover(decodeURIComponent(req.params.pedidoId), req.user.email);
  broadcast('fraude-removida', { pedidoId: req.params.pedidoId }, 'monitor');
  res.json({ ok: true });
});

// ---------- relatorio de fraude (Master) - resumo por cliente pra
// apresentar incidentes (quantidade, se algum pedido passou, acao tomada) -
// usa o historico completo (inclui marcacoes ja removidas) ----------
app.get('/api/fraude/relatorio.csv', auth.requireMaster, async (req, res) => {
  const { inicio, fim } = req.query;
  const historico = await fraudMarks.listHistorico();
  const filtrado = historico.filter((m) => (!inicio || (m.criadoEm || '') >= inicio) && (!fim || (m.criadoEm || '') <= fim + 'T23:59:59'));
  const linhas = fraudReport.agruparPorCliente(filtrado);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fraudReport.slugify('relatorio-fraude')}-${reportUtil.dataArquivo()}.csv"`);
  res.send(fraudReport.toCSV(linhas));
});

app.get('/api/fraude/relatorio.pdf', auth.requireMaster, async (req, res) => {
  const { inicio, fim } = req.query;
  const historico = await fraudMarks.listHistorico();
  const filtrado = historico.filter((m) => (!inicio || (m.criadoEm || '') >= inicio) && (!fim || (m.criadoEm || '') <= fim + 'T23:59:59'));
  const linhas = fraudReport.agruparPorCliente(filtrado);
  const periodo = inicio || fim ? ` · período: ${inicio || 'início'} a ${fim || 'hoje'}` : '';
  const subtitulo = `Exportado em ${agoraBrasiliaFmt()}${periodo} · ${linhas.length} cliente(s) monitorado(s)`;
  fraudReport.writePDF(res, { titulo: 'Relatório de Fraude', subtitulo, linhas, nomeArquivo: `relatorio-fraude-${reportUtil.dataArquivo()}` });
});

// ---------- relatorio do painel "Alertas de falha/fraude" (Master) - mesma
// deteccao/agrupamento por cliente do renderAlerts() em index.html ----------
app.get('/api/alertas/relatorio.csv', auth.requireMaster, (req, res) => {
  const { inicio, fim } = req.query;
  const transacoes = store.allTransactions().filter((t) => (!inicio || (t.dataHora || '') >= inicio) && (!fim || (t.dataHora || '') <= fim + 'T23:59:59'));
  const linhas = alertReport.agruparPorCliente(alertReport.construirAlertas(transacoes));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${alertReport.slugify('relatorio-alertas')}-${reportUtil.dataArquivo()}.csv"`);
  res.send(alertReport.toCSV(linhas));
});

app.get('/api/alertas/relatorio.pdf', auth.requireMaster, (req, res) => {
  const { inicio, fim } = req.query;
  const transacoes = store.allTransactions().filter((t) => (!inicio || (t.dataHora || '') >= inicio) && (!fim || (t.dataHora || '') <= fim + 'T23:59:59'));
  const linhas = alertReport.agruparPorCliente(alertReport.construirAlertas(transacoes));
  const periodo = inicio || fim ? ` · período: ${inicio || 'início'} a ${fim || 'hoje'}` : '';
  const subtitulo = `Exportado em ${agoraBrasiliaFmt()}${periodo} · ${linhas.length} cliente(s) com alerta`;
  alertReport.writePDF(res, { titulo: 'Relatório de Alertas', subtitulo, linhas, nomeArquivo: `relatorio-alertas-${reportUtil.dataArquivo()}` });
});

app.get('/api/summary', requireSection('monitor'), (req, res) => {
  const all = auth.filterByUnidade(req, store.allTransactions());
  const aprovadas = all.filter((t) => t.status === 'APROVADO');
  const recusadas = all.filter((t) => t.status === 'RECUSADO');
  res.json({
    total: all.length,
    aprovadas: aprovadas.length,
    recusadas: recusadas.length,
    volumeAprovado: +aprovadas.reduce((s, t) => s + t.valor, 0).toFixed(2),
    chargebacks: all.filter((t) => t.status.includes('CHARGEBACK')).length,
    fraudeSuspeita: all.filter((t) => t.fraudeSuspeita).length,
  });
});

// unidades da planilha de fechamento - IDs proprios (codigo da loja ARCFOOD
// ou nome da loja do Grupo Bravo), diferentes do merchantAccountCode da
// Adyen. Ficam fixos aqui porque uma unidade pode precisar de permissao
// mesmo antes de ter qualquer transacao Adyen ou fechamento lancado.
const FECHAMENTO_UNIDADES_NOMES = {
  '19821': 'Dom Sao Miguel', '19855': 'Dom Carrão', '19888': 'Dom Mooca', '19889': 'Dom Tatuape',
  "Domino's Carrinho Aeroporto Recife": 'Dom Car Aero Recife',
  'Dominos Bessa': 'Dom Bessa',
  'Dominos Campina Grande': 'Dom Campina Grande',
  'Dominos Caruaru': 'Dom Caruaru',
  'Dominos Garanhuns': 'Dom Garanhuns',
  'Dominos Praça Aeroporto Recife': 'Dom Praça Aero Recife',
  'Dominos Tirol': 'Dom Tirol',
  'Milky Moo Tirol': 'MilkyMoo Tirol',
  'Spoleto Praça Aeroporto Recife': 'Spo Praça Aero Recife',
  'Spoleto Shopping Recife': 'Spo Shop Recife',
  'Spoleto Shopping Tacaruna': 'Spo Shop Tacaruna',
  'São Braz IL': 'Sao Braz Ilha',
  // lojas novas, sem conta Adyen prevista - ficam fixas aqui so pra ja
  // aparecerem no checklist de permissoes do Master antes do 1o lançamento
  'Spo Shop Midway': 'Spo Shop Midway',
  'Saltiverso Patteo': 'Saltiverso Patteo',
  // unidade administrativa (RH, financeiro etc) - nao e loja, mas precisa
  // aparecer nos mesmos seletores pra cobrir quem trabalha fora de loja
  Administrativa: 'Administrativa',
};

// unidades do Inventario - por enquanto so as lojas Domino's (mesmos codigos
// do Fechamento, ver FECHAMENTO_UNIDADES_NOMES acima); as demais redes
// (Milky Moo, Spoleto etc) tem planilha/dinamica propria de estoque, ainda
// nao mapeada - entram quando o usuario mandar o modelo de cada uma
const INVENTARIO_UNIDADES_NOMES = {
  '19821': 'Dom Sao Miguel', '19855': 'Dom Carrão', '19888': 'Dom Mooca', '19889': 'Dom Tatuape',
  "Domino's Carrinho Aeroporto Recife": 'Dom Car Aero Recife',
  'Dominos Bessa': 'Dom Bessa',
  'Dominos Campina Grande': 'Dom Campina Grande',
  'Dominos Caruaru': 'Dom Caruaru',
  'Dominos Garanhuns': 'Dom Garanhuns',
  'Dominos Praça Aeroporto Recife': 'Dom Praça Aero Recife',
  'Dominos Tirol': 'Dom Tirol',
  // Saltiverso: catalogo de bebidas/meias vendidas no balcao (ver
  // saltiversoVendas.js/saltiverso-vendas.html) - mesma chave=valor usada em
  // FECHAMENTO_UNIDADES_NOMES pra essa unidade
  'Saltiverso Patteo': 'Saltiverso Patteo',
};

// unidades do app de entregas (motoboys) - nomes como aparecem nas planilhas
// atuais do AppSheet ("MOTOS BRAVO"); igual ao Fechamento, ficam fixas aqui
// pra ja aparecerem no checklist de permissoes mesmo antes de qualquer
// lançamento. O Master pode liberar mais conforme novas unidades entrarem
// (o app de entregas ainda esta sendo migrado loja a loja do AppSheet).
const ENTREGAS_UNIDADES_NOMES = {
  'MMTirol Natal': 'Milky Moo Tirol Natal (Entregas)',
  Bessa: 'Dom Bessa',
  Caruaru: 'Dom Caruaru',
  Garanhuns: 'Dom Garanhuns',
};

// apelidos - a mesma loja fisica as vezes aparece com codigos diferentes em
// espacos de dados diferentes (ex: "19888" no Fechamento, "DOM___19888" e
// "Mooca" como merchantAccountCode direto na Adyen - reflexo de como cada
// conta foi configurada la, fora do nosso controle). Nao dá pra unificar os
// CODIGOS sem risco de desalinhar permissao/dado ja gravado, mas o NOME
// exibido pode e deve ser sempre o mesmo - aplicado por ultimo, sempre
// sobrescrevendo, pra nao depender da ordem dos merges acima
const UNIDADES_APELIDOS = {
  '19888': 'Dom Mooca', 'DOM___19888': 'Dom Mooca', Mooca: 'Dom Mooca',
  '19889': 'Dom Tatuape', 'DOM_19889': 'Dom Tatuape', Tatuape: 'Dom Tatuape',
  '19821': 'Dom Sao Miguel', 'DOM__19821': 'Dom Sao Miguel', 'Sao Miguel': 'Dom Sao Miguel',
  '19855': 'Dom Carrão', 'DOM__19855': 'Dom Carrão', Carrao: 'Dom Carrão',
  DOM_19798: 'Dom Caruaru', Caruaru: 'Dom Caruaru', 'Dominos Caruaru': 'Dom Caruaru',
  DOM19911: 'Dom Garanhuns', Garanhuns: 'Dom Garanhuns', 'Dominos Garanhuns': 'Dom Garanhuns',
  DOM_19706: 'Dom Bessa', Bessa: 'Dom Bessa', 'Dominos Bessa': 'Dom Bessa',
  DOM_19633: 'Dom Campina Grande', 'Dominos Campina Grande': 'Dom Campina Grande',
  "Domino's Carrinho Aeroporto Recife": 'Dom Car Aero Recife',
  'Dominos Praça Aeroporto Recife': 'Dom Praça Aero Recife',
  'Spoleto Praça Aeroporto Recife': 'Spo Praça Aero Recife',
  'Spoleto Shopping Recife': 'Spo Shop Recife',
  'Spoleto Shopping Tacaruna': 'Spo Shop Tacaruna',
  'São Braz IL': 'Sao Braz Ilha',
  'Milky Moo Tirol': 'MilkyMoo Tirol',
};

// classificacao de cada codigo por secao (de qual sistema ele vem - isso que
// explica a mesma loja ter mais de um codigo) e grupo (franquia/rede a que
// pertence) - so pra organizar o checklist de permissoes na tela de
// Usuarios; nao afeta em nada o filtro de permissao em si
const ARCFOOD_FECHAMENTO = new Set(['19821', '19855', '19888', '19889']);
const ARCFOOD_MONITOR = new Set(['Mooca', 'Tatuape', 'Carrao', 'Sao Miguel', 'DOM___19888', 'DOM_19889', 'DOM__19821', 'DOM__19855']);
const GBE_MONITOR = new Set(['DOM_19798', 'DOM19911', 'DOM_19706', 'DOM_19633']);
function classificarUnidade(codigo) {
  if (ARCFOOD_FECHAMENTO.has(codigo)) return { secao: 'Fechamento', grupo: 'ARCFOOD' };
  if (ARCFOOD_MONITOR.has(codigo)) return { secao: 'Monitor / Disputas (Adyen)', grupo: 'ARCFOOD' };
  if (GBE_MONITOR.has(codigo)) return { secao: 'Monitor / Disputas (Adyen)', grupo: 'Grupo Bravo (GBE)' };
  if (codigo in ENTREGAS_UNIDADES_NOMES) return { secao: 'Entregas', grupo: 'Grupo Bravo (GBE)' };
  if (codigo in FECHAMENTO_UNIDADES_NOMES) return { secao: 'Fechamento', grupo: 'Grupo Bravo (GBE)' };
  if (codigo in ifoodClient.IFOOD_UNIDADES_NOMES) return { secao: 'iFood', grupo: null };
  return { secao: 'Monitor / Disputas (Adyen)', grupo: 'Outras' };
}

// nome canonico de um codigo de unidade, olhando os mapas fixos nesta ordem
// (apelidos manuais > fechamento > entregas > ifood) - usado sempre que
// alguem precisa MOSTRAR o nome de uma unidade a partir do codigo, pra nunca
// depender do unidadeNome gravado num documento antigo (que pode ter sido
// salvo errado, ex: entregasSync.js gravava o proprio codigo como nome)
function nomeCanonicoUnidade(codigo, fallback) {
  return UNIDADES_APELIDOS[codigo] || FECHAMENTO_UNIDADES_NOMES[codigo] || ENTREGAS_UNIDADES_NOMES[codigo]
    || ifoodClient.IFOOD_UNIDADES_NOMES[codigo] || fallback || codigo;
}

// resolve um "IDPULSE" (codigo numerico da loja, como aparece na coluna
// Unidade do Fechamento - ex: 19888) pros codigos correspondentes no espaco
// do Monitor (merchantAccountCode da Adyen - ex: "DOM___19888"/"Mooca", que
// sao a MESMA loja em namespaces diferentes, ver comentario de
// UNIDADES_APELIDOS acima). Usado pelo Beniboy (consultar_pedido) pra achar
// o pedido pela loja que a pessoa informou, mesmo ela so conhecendo o codigo
// do Fechamento. Sem apelido cadastrado pra esse codigo ainda (loja nova),
// devolve o proprio codigo digitado como unica tentativa - nunca inventa
// correspondencia pra loja que ainda nao esta em nenhuma tabela fixa.
function resolverUnidadesPorIdPulse(idPulse) {
  const bruto = String(idPulse || '').trim();
  if (!bruto) return [];
  const nome = UNIDADES_APELIDOS[bruto] || FECHAMENTO_UNIDADES_NOMES[bruto];
  if (!nome) return [bruto];
  return Object.keys(UNIDADES_APELIDOS).filter((codigo) => UNIDADES_APELIDOS[codigo] === nome);
}

// lista de unidades pra montar o seletor de permissoes na tela de Usuarios -
// junta as unidades ja vistas nas transacoes Adyen (secoes Monitor/Disputas)
// com as unidades fixas de Fechamento/Lançamento/Entregas (espacos de codigo
// diferentes, nao e o merchantAccountCode da Adyen) e as que ja aparecem nos
// dados importados/lançados, pra nunca faltar opcao no checklist do Master.
// O NOME de cada codigo sempre vem por ultimo de nomeCanonicoUnidade(), nunca
// do unidadeNome gravado num fechamento/entrega antigo - documentos velhos
// podem ter guardado um nome cru/errado (ex: o proprio codigo) e isso NAO
// pode "vazar" e sobrescrever o nome bonito que ja temos fixo aqui; o
// unidadeNome do documento so serve de fallback pra codigo que ainda nao
// esta em nenhum mapa fixo (unidade nova, ainda sem apelido cadastrado)
async function construirUnidadesMapa() {
  const mapa = {};
  store.allTransactions().forEach((t) => { if (t.unidade) mapa[t.unidade] = mapa[t.unidade] || t.unidade; });
  Object.entries(FECHAMENTO_UNIDADES_NOMES).forEach(([codigo, nome]) => { mapa[codigo] = nome; });
  Object.entries(ENTREGAS_UNIDADES_NOMES).forEach(([codigo, nome]) => { mapa[codigo] = nome; });
  Object.entries(ifoodClient.IFOOD_UNIDADES_NOMES).forEach(([codigo, nome]) => { mapa[codigo] = mapa[codigo] || nome; });
  require('./fechamentos-snapshot.json').forEach((f) => { if (f.unidade) mapa[f.unidade] = f.unidadeNome || mapa[f.unidade] || f.unidade; });
  (await fechamentosLive.listAll()).forEach((f) => { if (f.unidade) mapa[f.unidade] = f.unidadeNome || mapa[f.unidade] || f.unidade; });
  entregasHistoricoData.forEach((e) => { if (e.unidade) mapa[e.unidade] = e.unidadeNome || mapa[e.unidade] || e.unidade; });
  (await entregasLive.listAll()).forEach((e) => { if (e.unidade) mapa[e.unidade] = e.unidadeNome || mapa[e.unidade] || e.unidade; });
  // unidades cadastradas pelo Master em runtime (unidades.js) - loja nova ou
  // unidade administrativa que ainda nao existe em nenhuma lista fixa
  Object.entries(await unidadesExtras.mapa().catch(() => ({}))).forEach(([codigo, nome]) => { mapa[codigo] = mapa[codigo] || nome; });
  // ultimo passo, sempre - reaplica os mapas fixos por cima de tudo, pra
  // garantir o nome unificado mesmo se algum dado importado/lançado tenha
  // gravado um unidadeNome diferente (cru, com typo, ou desatualizado)
  Object.keys(mapa).forEach((codigo) => { mapa[codigo] = nomeCanonicoUnidade(codigo, mapa[codigo]); });
  return mapa;
}

// diagnostico de anexos (Master): testa um upload real em cada bucket
// candidato do Firebase Storage e devolve o erro cru de cada um - abrir no
// navegador logado (ou com ?token=) quando os anexos estiverem falhando,
// pra saber a causa exata sem depender do log do Render
app.get('/api/admin/storage-diagnostico', auth.requireMaster, async (req, res) => {
  try {
    res.json(await require('./storageBucket').diagnostico());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/meta/unidades', auth.requireMaster, async (req, res) => {
  const mapa = await construirUnidadesMapa();
  // as cadastradas em runtime ganham classificacao propria no checklist -
  // classificarUnidade so conhece as listas fixas e jogaria elas em "Outras"
  const codigosExtras = new Set((await unidadesExtras.listAll().catch(() => [])).map((u) => u.codigo));
  const SECAO_ORDEM = ['Fechamento', 'Entregas', 'Monitor / Disputas (Adyen)', 'iFood'];
  const lista = Object.entries(mapa)
    .map(([codigo, nome]) => ({
      codigo, nome,
      ...(codigosExtras.has(codigo) ? { secao: 'Fechamento', grupo: 'Cadastradas no sistema' } : classificarUnidade(codigo)),
    }))
    .sort((a, b) =>
      (SECAO_ORDEM.indexOf(a.secao) - SECAO_ORDEM.indexOf(b.secao)) ||
      String(a.grupo).localeCompare(String(b.grupo), 'pt-BR') ||
      a.nome.localeCompare(b.nome, 'pt-BR')
    );
  res.json(lista);
});

// ---------- unidades cadastradas pelo Master (unidades.js) ----------
// mapa {codigo: nome} pra QUALQUER usuario logado - as paginas (RH, Central,
// Lançamento...) mesclam isso por cima do UNIDADES_NOMES fixo delas no boot,
// entao uma unidade nova cadastrada aqui aparece nos seletores sem deploy
app.get('/api/meta/unidades-extras', async (req, res) => {
  res.json(await unidadesExtras.mapa().catch(() => ({})));
});

// lista completa (com id/criadoPor) pra tela de gestao - so Master
app.get('/api/meta/unidades-extras/lista', auth.requireMaster, async (req, res) => {
  res.json(await unidadesExtras.listAll());
});

// codigos que ja existem nas listas fixas - um cadastro novo nao pode
// reutiliza-los (duas fontes de verdade pro mesmo codigo)
function codigosUnidadesFixas() {
  return new Set([
    ...Object.keys(FECHAMENTO_UNIDADES_NOMES),
    ...Object.keys(ENTREGAS_UNIDADES_NOMES),
    ...Object.keys(UNIDADES_APELIDOS),
    ...Object.keys(ifoodClient.IFOOD_UNIDADES_NOMES),
  ]);
}

app.post('/api/meta/unidades-extras', auth.requireMaster, async (req, res) => {
  try {
    const dados = { codigo: req.body.codigo, nome: req.body.nome, porEmail: req.user.email };
    if (await desviarSeQaMaster(req, res, 'unidadesExtras.criar', `Cadastrar unidade: ${req.body?.nome || req.body?.codigo || ''}`, { dados })) return;
    res.json(await unidadesExtras.criar(dados, codigosUnidadesFixas()));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/meta/unidades-extras/:id', auth.requireMaster, async (req, res) => {
  try {
    if (await desviarSeQaMaster(req, res, 'unidadesExtras.editar', `Editar unidade ${req.params.id}`, { id: req.params.id, nome: req.body.nome })) return;
    res.json(await unidadesExtras.atualizar(req.params.id, { nome: req.body.nome }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/meta/unidades-extras/:id', auth.requireMaster, async (req, res) => {
  try {
    if (await desviarSeQaMaster(req, res, 'unidadesExtras.excluir', `Excluir unidade ${req.params.id}`, { id: req.params.id })) return;
    res.json(await unidadesExtras.remover(req.params.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- status de conectividade das lojas (lojaStatus.js) - tela
// loja-status.html (secao "suporte", mesmo publico do Beniboy/tecnico).
// Cada unidade pode ter varios computadores cadastrados - a lista devolvida
// aqui e achatada (1 item por computador), a tela agrupa por unidade pra
// exibir. "nome" no item e o nome do COMPUTADOR (ver lojaStatus.js); o nome
// de exibicao da unidade vai em "unidadeNome" pra nao colidir ----------
app.get('/api/loja-status', requireSection('suporte'), async (req, res) => {
  const [status, mapa] = await Promise.all([lojaStatus.listar(), construirUnidadesMapa()]);
  res.json(status.map((s) => ({ ...s, unidadeNome: mapa[s.codigo] || s.codigo })));
});

// tipo 'interno' (computador de escritorio/servidor, so pro monitoramento)
// aponta pra tela normal de login do Zenith; 'atendimento' (o default,
// tablet/quiosque na entrada da loja) aponta pro chat publico do Beniboy -
// ver comentario de TIPOS_COMPUTADOR em lojaStatus.js
function urlComputador(codigo, posto, tipo) {
  const base = tipo === 'interno' ? '/' : '/atendimento.html';
  return `${APP_BASE_URL}${base}?unidade=${encodeURIComponent(codigo)}&posto=${encodeURIComponent(posto)}`;
}

// cadastra um novo computador pra uma unidade - devolve o link/QR pronto pra
// colar/salvar naquele computador
app.post('/api/loja-status/:codigo/computadores', requireSection('suporte'), async (req, res) => {
  try {
    const registro = await lojaStatus.cadastrarComputador(req.params.codigo, req.body.nome, req.body.tipo);
    const url = urlComputador(req.params.codigo, registro.posto, registro.tipo);
    res.json({ ...registro, url });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/loja-status/:codigo/computadores/:posto', requireSection('suporte'), async (req, res) => {
  try {
    const registro = await lojaStatus.editarComputador(req.params.codigo, req.params.posto, req.body.nome, req.body.tipo);
    const url = urlComputador(req.params.codigo, req.params.posto, registro.tipo);
    res.json({ ...registro, url });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/loja-status/:codigo/computadores/:posto', requireSection('suporte'), async (req, res) => {
  try {
    res.json(await lojaStatus.removerComputador(req.params.codigo, req.params.posto));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/loja-status/:codigo/computadores/:posto/anydesk', requireSection('suporte'), async (req, res) => {
  try {
    res.json(await lojaStatus.definirAnydeskId(req.params.codigo, req.params.posto, req.body.anydeskId));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/loja-status/:codigo/computadores/:posto/mensagem', requireSection('suporte'), async (req, res) => {
  try {
    res.json(await lojaStatus.enviarMensagem(req.params.codigo, req.params.posto, req.body.texto, req.user.email));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- registros de disputa/monitoramento (secao "disputas") ----------
function disputaPermitida(req, registro) {
  if (!registro) return false;
  if (req.isMaster) return true;
  return !registro.unidade || (req.permissions.unidades || []).includes(registro.unidade);
}

app.post('/api/disputes', requireSection('disputas'), upload.array('anexos', 8), async (req, res) => {
  try {
    const { pedidoId, unidade, nomeContato, telefoneContato, notas } = req.body;
    if (!pedidoId) return res.status(400).json({ error: 'pedidoId é obrigatório' });
    if (!req.isMaster && unidade && !(req.permissions.unidades || []).includes(unidade)) {
      return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    }

    const anexos = [];
    for (const file of req.files || []) {
      const path = await storage.salvarArquivo(pedidoId, file);
      anexos.push({ nome: file.originalname, path, tipo: file.mimetype || 'application/octet-stream' });
    }

    const registro = await disputes.create({ pedidoId, unidade, nomeContato, telefoneContato, notas, anexos });
    broadcast('dispute-changed', { pedidoId: registro.pedidoId, status: registro.status, unidade: registro.unidade }, 'disputas');
    res.json(registro);
  } catch (err) {
    console.error('Erro ao criar disputa:', err.message);
    res.status(500).json({ error: 'Erro ao salvar disputa' });
  }
});

app.get('/api/disputes', requireSection('disputas'), async (req, res) => {
  res.json(auth.filterByUnidade(req, (await disputes.listAll()).filter((d) => req.isMaster || !d.unidade || (req.permissions.unidades || []).includes(d.unidade))));
});

// relatorio (CSV/PDF) da tela de Relatórios de disputa (relatorios.html) -
// agrupado por pedido igual a tela, cruzando com o pedido (cliente/valor/
// unidade) - mesmo filtro de status (aba ativa) da tela
app.get('/api/disputes/relatorio.:formato(csv|pdf)', requireSection('disputas'), async (req, res) => {
  const { status } = req.query;
  const permitidas = (await disputes.listAll()).filter((d) => req.isMaster || !d.unidade || (req.permissions.unidades || []).includes(d.unidade));
  const filtradas = auth.filterByUnidade(req, permitidas).filter((d) => !status || status === 'TODOS' || d.status === status);
  const ordersById = {};
  store.allOrders().forEach((o) => { ordersById[o.pedidoId] = o; });

  const colunas = [
    { key: 'pedidoId', label: 'Pedido' }, { key: 'cliente', label: 'Cliente' }, { key: 'unidade', label: 'Unidade' },
    { key: 'valor', label: 'Valor' }, { key: 'status', label: 'Status' }, { key: 'contato', label: 'Contato' },
    { key: 'notas', label: 'Notas' }, { key: 'criadoEm', label: 'Registrado em' },
  ];
  const linhas = [...filtradas].sort((a, b) => (b.criadoEm || '').localeCompare(a.criadoEm || '')).map((d) => {
    const o = ordersById[d.pedidoId] || {};
    return {
      pedidoId: d.pedidoId, cliente: o.cliente || 'cliente desconhecido', unidade: o.unidade || d.unidade || '—',
      valor: reportUtil.fmtMoneyBR(o.valor), status: String(d.status || '').replace(/_/g, ' '),
      contato: [d.nomeContato, d.telefoneContato].filter(Boolean).join(' · ') || '—',
      notas: d.notas || '—', criadoEm: reportUtil.fmtDataHoraBR(d.criadoEm),
    };
  });
  if (req.params.formato === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${reportUtil.nomeArquivoComData('relatorio-disputas')}.csv"`);
    return res.send(reportUtil.toCSV(colunas, linhas));
  }
  reportUtil.writePDF(res, { titulo: 'Relatório de Disputas', subtitulo: `Exportado em ${reportUtil.agoraBrasiliaFmt()} · ${linhas.length} registro(s)`, colunas, linhas, nomeArquivo: reportUtil.nomeArquivoComData('relatorio-disputas') });
});

app.get('/api/disputes/:pedidoId', requireSection('disputas'), async (req, res) => {
  const lista = await disputes.listByPedido(decodeURIComponent(req.params.pedidoId));
  res.json(lista.filter((d) => disputaPermitida(req, d)));
});

app.patch('/api/disputes/:id/status', requireSection('disputas'), async (req, res) => {
  try {
    const atual = await disputes.getOne(req.params.id);
    if (!disputaPermitida(req, atual)) return res.sendStatus(404);
    const registro = await disputes.updateStatus(req.params.id, req.body.status);
    broadcast('dispute-changed', { pedidoId: registro.pedidoId, status: registro.status, unidade: registro.unidade }, 'disputas');
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/disputes/:id', requireSection('disputas'), async (req, res) => {
  const atual = await disputes.getOne(req.params.id);
  if (!disputaPermitida(req, atual)) return res.sendStatus(404);
  await disputes.remove(req.params.id);
  res.json({ ok: true });
});

app.get('/api/disputes/anexo/:disputeId/:index', requireSection('disputas'), async (req, res) => {
  const registro = await disputes.getOne(req.params.disputeId);
  if (!disputaPermitida(req, registro)) return res.sendStatus(404);
  const anexo = registro && registro.anexos && registro.anexos[Number(req.params.index)];
  if (!anexo) return res.sendStatus(404);
  storage.streamArquivo(anexo.path, anexo.tipo, res);
});

// ---------- notificacoes push (estorno, estorno agendado, chargeback, fraude) ----------
app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: push.PUBLIC_KEY });
});

app.post('/api/push/subscribe', async (req, res) => {
  // guarda quem e essa inscricao (Master ve tudo; usuario comum so recebe
  // alerta das unidades e secoes que ele tem acesso - sem isso o push
  // vazava fraude/chargeback/estorno de TODAS as unidades pra qualquer
  // pessoa logada que clicasse no sino, ignorando as permissoes dela)
  await push.addSubscription(req.body, {
    userId: req.user.id,
    isMaster: req.isMaster,
    isAdmin: req.isAdmin,
    isQaMaster: req.isQaMaster,
    podeRhTodasUnidades: req.podeRhTodasUnidades,
    unidades: req.isMaster ? null : (req.permissions.unidades || []),
    sections: req.isMaster ? null : (req.permissions.sections || []),
    cargo: (req.user && req.user.cargo) || null,
  });
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', async (req, res) => {
  await push.removeSubscription(req.body.endpoint);
  res.json({ ok: true });
});

// ---------- cofre de senhas (secao "cofre") ----------
// grupos (ex: GBE) contem subgrupos (unidades, ex: DOM_BESSA, SPO_TACARUNA) -
// e nos subgrupos que as senhas ficam. Grupos/subgrupos sao da organizacao
// inteira; o Master decide quem enxerga qual SUBGRUPO (permissions.
// vaultSubgroups) - dentro de um subgrupo liberado, o usuario pode ver e
// gerenciar as senhas normalmente (o modo Leitor do Monitor nao se aplica
// aqui, senao toda troca de senha dependeria do Master).
function subgruposPermitidos(req) {
  return req.isMaster ? null : new Set(req.permissions.vaultSubgroups || []);
}

// tipos de card da Central (estorno/ajuste-fechamento/compra/manutencao/
// suporte-ti/pagamento/nota) que o usuario pode ver - Master sempre ve tudo;
// pra quem nao e Master, uma lista VAZIA significa SEM restricao (ve todos os
// tipos, mesmo comportamento de antes dessa permissao existir) - so quando o
// Master marca tipos especificos e que a Central passa a mostrar so esses
// (ex: um Admin que so cuida de Suporte de TI nao precisa ver Estorno/Compra)
function tiposSolicitacaoPermitidos(req) {
  // QA User sempre ve/cria todos os tipos, independente do que o Master
  // tenha restringido pra ele (pedido explicito: "autorização pra criar
  // todos os tipos de solicitações") - tudo que ele criar sai marcado
  // "TESTE" (ver solicitacoes.create/refunds.create), entao liberar o tipo
  // aqui nao expoe nada real, so testa o fluxo inteiro
  if (req.isMaster || req.isQaUser) return null;
  const tipos = (req.permissions.tiposSolicitacao || []);
  return tipos.length ? new Set(tipos) : null;
}
// true = bloqueado (tem restricao de tipo ativa e esse tipo nao esta nela) -
// usado nas rotas de decisao/acao (aprovar, direcionar, trocar tipo,
// converter), nao so na listagem, mesmo criterio do subgruposPermitidos do cofre
function tipoBloqueado(req, tipo) {
  const permitidos = tiposSolicitacaoPermitidos(req);
  return !!(permitidos && !permitidos.has(tipo));
}

app.get('/api/vault/groups', requireSection('cofre'), async (req, res) => {
  res.json(await vaultGroups.list());
});

app.post('/api/vault/groups', auth.requireMaster, async (req, res) => {
  try {
    if (await desviarSeQaMaster(req, res, 'vaultGroups.criar', `Criar grupo do Cofre: ${req.body?.name || ''}`, { name: req.body.name })) return;
    res.json(await vaultGroups.create(req.body.name));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/vault/groups/:id', auth.requireMaster, async (req, res) => {
  try {
    if (await desviarSeQaMaster(req, res, 'vaultGroups.editar', `Editar grupo do Cofre ${req.params.id}`, { id: req.params.id, name: req.body.name })) return;
    res.json(await vaultGroups.rename(req.params.id, req.body.name));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/vault/groups/:id', auth.requireMaster, async (req, res) => {
  try {
    if (await desviarSeQaMaster(req, res, 'vaultGroups.excluir', `Excluir grupo do Cofre ${req.params.id}`, { id: req.params.id })) return;
    await vaultGroups.remove(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// lista de subgrupos - Master ve todos (pra montar a arvore inteira e a tela
// de usuarios); usuario comum so ve os subgrupos liberados pra ele
app.get('/api/vault/subgroups', requireSection('cofre'), async (req, res) => {
  const todos = await vaultSubgroups.listAll();
  if (req.isMaster) return res.json(todos);
  const permitidos = subgruposPermitidos(req);
  res.json(todos.filter((s) => permitidos.has(s.id)));
});

app.post('/api/vault/subgroups', auth.requireMaster, async (req, res) => {
  try {
    if (await desviarSeQaMaster(req, res, 'vaultSubgroups.criar', `Criar subgrupo do Cofre: ${req.body?.name || ''}`, { groupId: req.body.groupId, name: req.body.name })) return;
    res.json(await vaultSubgroups.create(req.body.groupId, req.body.name));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/vault/subgroups/:id', auth.requireMaster, async (req, res) => {
  try {
    if (await desviarSeQaMaster(req, res, 'vaultSubgroups.editar', `Editar subgrupo do Cofre ${req.params.id}`, { id: req.params.id, name: req.body.name })) return;
    res.json(await vaultSubgroups.rename(req.params.id, req.body.name));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/vault/subgroups/:id', auth.requireMaster, async (req, res) => {
  try {
    if (await desviarSeQaMaster(req, res, 'vaultSubgroups.excluir', `Excluir subgrupo do Cofre ${req.params.id}`, { id: req.params.id })) return;
    await vaultSubgroups.remove(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/vault/entries', requireSection('cofre'), async (req, res) => {
  const permitidos = subgruposPermitidos(req); // null = Master, todos
  if (req.query.subgroupId) {
    if (permitidos && !permitidos.has(req.query.subgroupId)) return res.json([]);
    return res.json(await vaultEntries.listBySubgroups([req.query.subgroupId]));
  }
  res.json(await vaultEntries.listBySubgroups(permitidos ? [...permitidos] : null));
});

app.post('/api/vault/entries', requireSection('cofre'), async (req, res) => {
  try {
    const permitidos = subgruposPermitidos(req);
    const subgroupId = req.body.subgroupId || null;
    if (permitidos && (!subgroupId || !permitidos.has(subgroupId))) return res.status(403).json({ error: 'Você não tem acesso a esse subgrupo.' });
    res.json(await vaultEntries.create(req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/vault/entries/:id', requireSection('cofre'), async (req, res) => {
  try {
    const permitidos = subgruposPermitidos(req);
    const atual = await vaultEntries.get(req.params.id);
    if (!atual) return res.sendStatus(404);
    if (permitidos && (!atual.subgroupId || !permitidos.has(atual.subgroupId))) return res.sendStatus(404);
    if (permitidos && req.body.subgroupId !== undefined && (!req.body.subgroupId || !permitidos.has(req.body.subgroupId))) {
      return res.status(403).json({ error: 'Você não tem acesso a esse subgrupo.' });
    }
    res.json(await vaultEntries.update(req.params.id, req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/vault/entries/:id', requireSection('cofre'), async (req, res) => {
  try {
    const permitidos = subgruposPermitidos(req);
    const atual = await vaultEntries.get(req.params.id);
    if (!atual) return res.sendStatus(404);
    if (permitidos && (!atual.subgroupId || !permitidos.has(atual.subgroupId))) return res.sendStatus(404);
    await vaultEntries.remove(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// exporta o cofre (tudo, um grupo ou um subgrupo) em CSV ou PDF - so o Master
// (a senha vai em texto puro no arquivo, de proposito - e pra servir como
// inventario/backup). ?scope=all|group|subgroup&id=<groupId|subgroupId>
async function resolverEscopoExportacao(req) {
  const scope = ['group', 'subgroup'].includes(req.query.scope) ? req.query.scope : 'all';
  const id = req.query.id || null;
  const [groups, subgroups] = await Promise.all([vaultGroups.list(), vaultSubgroups.listAll()]);
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const subgroupById = new Map(subgroups.map((s) => [s.id, s]));

  let subgroupIds = null; // null = tudo
  let titulo = 'Cofre de senhas · Todas as senhas';
  if (scope === 'subgroup') {
    const sub = subgroupById.get(id);
    if (!sub) throw new Error('Subgrupo não encontrado.');
    const grp = groupById.get(sub.groupId);
    subgroupIds = [sub.id];
    titulo = `Cofre de senhas · ${grp ? grp.name + ' / ' : ''}${sub.name}`;
  } else if (scope === 'group') {
    const grp = groupById.get(id);
    if (!grp) throw new Error('Grupo não encontrado.');
    subgroupIds = subgroups.filter((s) => s.groupId === id).map((s) => s.id);
    titulo = `Cofre de senhas · ${grp.name}`;
  }

  const entries = await vaultEntries.listBySubgroups(subgroupIds);
  const rows = entries
    .map((e) => {
      const sub = e.subgroupId ? subgroupById.get(e.subgroupId) : null;
      const grp = sub ? groupById.get(sub.groupId) : null;
      return {
        grupo: grp ? grp.name : '',
        subgrupo: sub ? sub.name : '',
        titulo: e.title,
        url: e.url,
        usuario: e.username,
        senha: e.password,
        observacao: e.note,
        atualizadoEm: e.updatedAt,
      };
    })
    .sort((a, b) => (a.grupo + a.subgrupo + a.titulo).localeCompare(b.grupo + b.subgrupo + b.titulo, 'pt-BR'));

  return { titulo, rows };
}

app.get('/api/vault/export.csv', auth.requireMaster, async (req, res) => {
  try {
    const { titulo, rows } = await resolverEscopoExportacao(req);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${vaultExport.slugify(titulo)}-${reportUtil.dataArquivo()}.csv"`);
    res.send(vaultExport.toCSV(rows));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/vault/export.pdf', auth.requireMaster, async (req, res) => {
  try {
    const { titulo, rows } = await resolverEscopoExportacao(req);
    const subtitulo = `Exportado em ${agoraBrasiliaFmt()} · ${rows.length} senha(s)`;
    vaultExport.writePDF(res, { titulo, subtitulo, rows, nomeArquivo: `${vaultExport.slugify(titulo)}-${reportUtil.dataArquivo()}` });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// dispara (sem bloquear a resposta) o e-mail imediato pro MV quando um card
// - de qualquer uma das 3 filas - nasce ou e redirecionado pro MV (por
// e-mail OU pelo usuario de username "MV" - ver relatorioMV.ehDoMV, checado
// dentro de notificarCardMV). Usa centralCards.normalizarCard() pra sempre
// montar o card no mesmo formato que o e-mail espera, mesmo vindo de
// registros "crus" (refunds.js/fechamentosLive.js tem nomes de campo
// diferentes de solicitacoes.js)
function notificarSeDirecionadoAoMV(tipo, registroCru) {
  const card = centralCards.normalizarCard(tipo, registroCru);
  relatorioMV.notificarCardMV(card).catch((err) => console.error('Erro ao notificar card pro MV por e-mail:', err.message));
}

// ---------- solicitacoes de estorno (usuario Leitor pede, Master aprova/rejeita) ----------
app.post('/api/refund-requests', requireSection('monitor'), async (req, res) => {
  try {
    const { pedidoId, unidade, observacao, password, direcionadoParaId, direcionadoParaEmail } = req.body;
    if (!req.isMaster && unidade && !(req.permissions.unidades || []).includes(unidade)) {
      return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    }
    const senhaOk = await auth.verifyPassword(req.user.id, password);
    if (!senhaOk) return res.status(401).json({ error: 'Senha incorreta.' });

    const registro = await refunds.create({
      pedidoId,
      unidade,
      observacao,
      requestedById: req.user.id,
      requestedByEmail: req.user.email,
      direcionadoParaId,
      direcionadoParaEmail,
      teste: req.isQaMaster || req.isQaUser,
    });
    broadcast('refund-requested', registro, 'monitor');
    broadcast('refund-requested', registro, 'solicitacoes');
    push.notifySolicitacao(`Ticket #${registro.numeroTicket} · Pedido de estorno`, `${req.user.email} · ${unidade || ''}`, registro.id);
    notificarSeDirecionadoAoMV('estorno', registro);
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/refund-requests', requireSection('monitor'), async (req, res) => {
  const todas = await refunds.listAll();
  if (req.isMaster) return res.json(auth.filterByUnidade(req, todas));
  res.json(todas.filter((r) => r.requestedById === req.user.id));
});

app.patch('/api/refund-requests/:id/status', auth.requireMasterOrAdmin, async (req, res) => {
  try {
    if (tipoBloqueado(req, 'estorno')) return res.status(403).json({ error: 'Você não tem acesso a esse tipo de solicitação.' });
    const registro = await refunds.updateStatus(req.params.id, req.body.status, {
      motivoDecisao: req.body.motivoDecisao,
      decidedByEmail: req.user.email,
    });
    broadcast('refund-request-changed', registro, 'monitor');
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// so o Master atribui quem enxerga/resolve o pedido (1 ou mais pessoas) -
// independente de quem foi direcionado na hora da criacao
app.patch('/api/refund-requests/:id/direcionar', auth.requireMaster, async (req, res) => {
  try {
    if (tipoBloqueado(req, 'estorno')) return res.status(403).json({ error: 'Você não tem acesso a esse tipo de solicitação.' });
    const registro = await refunds.redirecionar(req.params.id, req.body);
    broadcast('refund-request-changed', registro, 'monitor');
    notificarSeDirecionadoAoMV('estorno', registro);
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// converte um ticket de Estorno num dos 5 tipos gerais da Central (ex: virou
// uma Manutenção em vez de reembolso) - mesmo numero de ticket, novo
// registro em solicitacoes.js (ver refunds.converterParaSolicitacao)
app.post('/api/refund-requests/:id/converter', auth.requireMasterOrAdmin, async (req, res) => {
  try {
    const { novoTipo, dados } = req.body;
    if (tipoBloqueado(req, 'estorno') || tipoBloqueado(req, novoTipo)) {
      return res.status(403).json({ error: 'Você não tem acesso a esse tipo de solicitação.' });
    }
    const novo = await refunds.converterParaSolicitacao(req.params.id, novoTipo, dados, req.user.email);
    broadcast('refund-request-changed', await refunds.getOne(req.params.id), 'monitor');
    broadcast('solicitacao-criada', novo, 'solicitacoes');
    res.json(novo);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// comprovante anexado pelo cliente final no pedido de estorno publico - so
// o Master ve (dado sensivel do cliente: nome, telefone, foto do comprovante)
app.get('/api/refund-requests/anexo/:id/:index', auth.requireMasterOrAdmin, async (req, res) => {
  const registro = await refunds.getOne(req.params.id);
  if (!registro) return res.sendStatus(404);
  const anexo = (registro.anexos || [])[Number(req.params.index)];
  if (!anexo) return res.sendStatus(404);
  storage.streamArquivo(anexo.path, anexo.tipo, res);
});

// edicao/exclusao direta pelo Master - corrigir um dado errado no pedido de
// estorno (loja errada, valor digitado errado pelo cliente, etc.) ou
// remove-lo de vez da fila, independente do status
app.patch('/api/refund-requests/:id', auth.requireMaster, async (req, res) => {
  try {
    const registro = await refunds.update(req.params.id, req.body);
    broadcast('refund-request-changed', registro, 'monitor');
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/refund-requests/:id', auth.requireMaster, async (req, res) => {
  try {
    await refunds.remove(req.params.id);
    broadcast('refund-request-changed', { id: req.params.id, excluido: true }, 'monitor');
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- gestao de usuarios (so o Master) ----------
// leitura tambem libera pro Admin, que precisa da lista de tecnicos pra
// decidir solicitacoes de Suporte de TI; escrita continua so-Master
app.get('/api/users', auth.requireMasterOrAdmin, async (req, res) => {
  const [lista, resumoSessoes] = await Promise.all([users.list(), sessions.resumoPorUsuario()]);
  res.json(lista.map((u) => {
    const resumo = resumoSessoes[u.id];
    return { ...u, sessoesAtivas: resumo?.locais || 0, online: !!resumo?.online, ultimaAtividadeEm: resumo?.ultimaAtividadeEm || null };
  }));
});

// locais logados com um usuario especifico (device/IP/ultima atividade) -
// pra alem da contagem que ja vem na listagem acima
app.get('/api/users/:id/sessoes', auth.requireMasterOrAdmin, async (req, res) => {
  res.json(await sessions.listarDoUsuario(req.params.id));
});

// encerra um local especifico sem precisar trocar a senha (o que derrubaria
// TODOS os locais de uma vez) - util quando alguem esqueceu logado em
// computador compartilhado, ou pra tirar um dispositivo que nao deveria
// estar usando aquele login
app.delete('/api/users/:id/sessoes/:sessionId', auth.requireMaster, async (req, res) => {
  await sessions.encerrar(req.params.sessionId);
  res.json({ ok: true });
});

// relatorio (CSV/PDF) da tabela "Acessos cadastrados" de usuarios.html -
// mesma tela, sem filtro (a lista inteira, ja que so o Master ve isso)
app.get('/api/users/relatorio.:formato(csv|pdf)', auth.requireMaster, async (req, res) => {
  const unidadesMapa = await construirUnidadesMapa();
  const colunas = [
    { key: 'email', label: 'Email' }, { key: 'papel', label: 'Papel' }, { key: 'status', label: 'Status' },
    { key: 'secoes', label: 'Seções' }, { key: 'unidades', label: 'Unidades' }, { key: 'subgrupos', label: 'Cofre (subgrupos)' },
  ];
  const linhas = (await users.list()).map((u) => {
    const perms = u.permissions || { sections: [], unidades: [], vaultSubgroups: [] };
    const isMaster = u.role === 'master';
    return {
      email: u.email, papel: u.role,
      status: u.locked ? 'bloqueado' : (u.active ? 'ativo' : 'desativado'),
      secoes: isMaster ? 'tudo' : (perms.sections || []).join(', ') || '—',
      unidades: isMaster ? 'tudo' : (perms.unidades || []).map((c) => unidadesMapa[c] || c).join(', ') || '—',
      subgrupos: isMaster ? 'tudo' : (perms.vaultSubgroups || []).join(', ') || '—',
    };
  });
  if (req.params.formato === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${reportUtil.nomeArquivoComData('usuarios-acessos')}.csv"`);
    return res.send(reportUtil.toCSV(colunas, linhas));
  }
  reportUtil.writePDF(res, { titulo: 'Usuários · Acessos Cadastrados', subtitulo: `Exportado em ${reportUtil.agoraBrasiliaFmt()} · ${linhas.length} acesso(s)`, colunas, linhas, nomeArquivo: reportUtil.nomeArquivoComData('usuarios-acessos') });
});

// ---------- QA Master: fila de aprovação (ver qaAprovacoes.js) ----------
// QA Master (users.js: qaMaster) tem 100% do acesso de um Master de
// verdade - todas as rotas abaixo continuam abertas pra ele (auth.requireMaster
// deixa passar igual). A UNICA diferenca e nas rotas "sensiveis" (exclusões +
// configuração global: Usuários/Grupos/Unidades/estrutura do Cofre) - em vez
// de executar a ação na hora, ela fica PARADA aqui até um Master de verdade
// aprovar. EXECUTORES_QA é o catálogo de "o que fazer de verdade quando
// aprovar", indexado pelo mesmo `tipo` gravado na hora de desviar - assim a
// ação sobrevive até um restart do servidor (fica só o tipo+payload
// salvos, nunca uma função/closure).
const EXECUTORES_QA = {
  'usuarios.criar': (p) => users.create(p),
  'usuarios.criarQaMaster': (p) => users.createQaMaster(p),
  'usuarios.permissoes': (p) => users.updatePermissions(p.id, p.permissions),
  'usuarios.ativo': (p) => users.setActive(p.id, p.active),
  'usuarios.horario': (p) => users.updateHorarioPermitido(p.id, p.horarioPermitido),
  'usuarios.isAdmin': (p) => users.updateIsAdmin(p.id, p.isAdmin),
  'usuarios.qaUser': (p) => users.updateQaUser(p.id, p.qaUser),
  'usuarios.catalogoEstoque': (p) => users.updatePodeCatalogoEstoque(p.id, p.valor),
  'usuarios.catalogoInsumos': (p) => users.updatePodeCatalogoInsumos(p.id, p.valor),
  'usuarios.sessaoLonga': (p) => users.updateSessaoLonga(p.id, p.valor),
  'usuarios.cadastrarOperadores': (p) => users.updatePodeCadastrarOperadores(p.id, p.valor),
  'usuarios.rhTodasUnidades': (p) => users.updatePodeRhTodasUnidades(p.id, p.valor),
  'usuarios.rhCadastrarEfetivado': (p) => users.updatePodeRhCadastrarEfetivado(p.id, p.valor),
  'usuarios.cargo': (p) => users.updateCargo(p.id, p.cargo),
  'usuarios.resetSenha': (p) => users.resetPassword(p.id, p.password),
  'usuarios.desbloquear': (p) => users.desbloquear(p.id, { pedirTrocaSenha: p.pedirTrocaSenha }),
  'usuarios.username': (p) => users.updateUsername(p.id, p.username),
  'usuarios.usernamesEmMassa': (p) => users.updateUsernamesEmMassa(p.itens),
  'usuarios.excluir': (p) => users.remove(p.id),
  'grupos.criar': (p) => grupos.create(p),
  'grupos.editar': (p) => grupos.update(p.id, p.dados),
  'grupos.excluir': (p) => grupos.remove(p.id),
  'unidadesExtras.criar': (p) => unidadesExtras.criar(p.dados, codigosUnidadesFixas()),
  'unidadesExtras.editar': (p) => unidadesExtras.atualizar(p.id, { nome: p.nome }),
  'unidadesExtras.excluir': (p) => unidadesExtras.remover(p.id),
  'vaultGroups.criar': (p) => vaultGroups.create(p.name),
  'vaultGroups.editar': (p) => vaultGroups.rename(p.id, p.name),
  'vaultGroups.excluir': (p) => vaultGroups.remove(p.id),
  'vaultSubgroups.criar': (p) => vaultSubgroups.create(p.groupId, p.name),
  'vaultSubgroups.editar': (p) => vaultSubgroups.rename(p.id, p.name),
  'vaultSubgroups.excluir': (p) => vaultSubgroups.remove(p.id),
  // NOC Zenith (ver agenteAcoes.js): unico executor cujo comportamento e
  // dinamico - re-le o catalogo (Master-editavel) no momento da aprovacao
  // em vez de chamar uma funcao fixa como os demais
  'agente.executarAcao': (p) => agenteAcoes.executarAcaoDoAgente(p.acaoId, p.parametros),
  'agente.acoes.criar': (p) => agenteAcoes.criar(p),
  'agente.acoes.editar': (p) => agenteAcoes.atualizar(p.id, p.dados, p.atualizadoPorEmail),
  'agente.acoes.excluir': (p) => agenteAcoes.remover(p.id),
  'agente.contexto.editar': (p) => agenteAcoes.salvarContexto(p.texto, p.atualizadoPorEmail),
};

// chamar no topo de cada rota sensível, ANTES de executar a ação de
// verdade: se quem está pedindo é QA Master, desvia pra fila de aprovação
// (responde a requisição e devolve true - a rota deve dar `return` na
// sequência); Master de verdade (ou qualquer outro papel que a rota já
// permita) segue direto, devolve false e a rota continua normal
async function desviarSeQaMaster(req, res, tipo, resumo, payload) {
  if (!req.isQaMaster) return false;
  const pendente = await qaAprovacoes.criar({
    tipo, resumo, payload, criadoPorId: req.user.id, criadoPorEmail: req.user.email,
  });
  push.notifyQaAprovacaoPendente(resumo, req.user.email).catch((e) => console.error('Falha ao notificar aprovação QA pendente:', e.message));
  res.status(202).json({ pendenteAprovacao: true, id: pendente.id, resumo });
  return true;
}

// só Master de verdade decide (QA Master não pode aprovar/rejeitar a
// própria fila - senão a "proteção" seria só decorativa)
function requireMasterDeVerdade(req, res, next) {
  if (!req.isMaster) return res.status(403).json({ error: 'Apenas o acesso Master pode fazer isso.' });
  if (req.isQaMaster) return res.status(403).json({ error: 'QA Master não pode aprovar/rejeitar essas solicitações - peça pra um Master de verdade revisar.' });
  next();
}

app.get('/api/qa-aprovacoes', requireMasterDeVerdade, async (req, res) => {
  res.json(await qaAprovacoes.listar());
});

app.post('/api/qa-aprovacoes/:id/aprovar', requireMasterDeVerdade, async (req, res) => {
  try {
    const pendente = await qaAprovacoes.obter(req.params.id);
    if (!pendente) return res.status(404).json({ error: 'Solicitação não encontrada.' });
    if (pendente.status === 'aprovado') return res.status(400).json({ error: 'Essa ação já foi aprovada e executada.' });
    if (pendente.status === 'rejeitado') return res.status(400).json({ error: 'Essa ação já foi rejeitada.' });
    const executor = EXECUTORES_QA[pendente.tipo];
    if (!executor) return res.status(500).json({ error: `Tipo de ação desconhecido: ${pendente.tipo}` });
    try {
      await executor(pendente.payload || {});
    } catch (execErr) {
      await qaAprovacoes.marcarDecidido(req.params.id, { status: 'erro', decididoPorEmail: req.user.email, erroExecucao: execErr.message });
      return res.status(400).json({ error: `Aprovado, mas a ação falhou ao executar: ${execErr.message}` });
    }
    const atualizado = await qaAprovacoes.marcarDecidido(req.params.id, { status: 'aprovado', decididoPorEmail: req.user.email });
    res.json(atualizado);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/qa-aprovacoes/:id/rejeitar', requireMasterDeVerdade, async (req, res) => {
  try {
    const pendente = await qaAprovacoes.obter(req.params.id);
    if (!pendente) return res.status(404).json({ error: 'Solicitação não encontrada.' });
    const atualizado = await qaAprovacoes.marcarDecidido(req.params.id, { status: 'rejeitado', decididoPorEmail: req.user.email, motivoRejeicao: req.body.motivo || null });
    res.json(atualizado);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- NOC Zenith: catálogo de ações do agente + contexto (ver
// agenteAcoes.js) - painel dentro de loja-status.html. Master-only (mais
// restrito que o resto da página, que é 'suporte'); se for QA Master,
// desvia pra aprovação igual a qualquer outra configuração global ----------
app.get('/api/agente/acoes', auth.requireMaster, async (req, res) => {
  res.json(await agenteAcoes.listar());
});

app.post('/api/agente/acoes', auth.requireMaster, async (req, res) => {
  try {
    if (await desviarSeQaMaster(req, res, 'agente.acoes.criar', `Nova ação do agente: ${req.body?.nome || ''}`, { ...req.body, criadoPorEmail: req.user.email })) return;
    res.json(await agenteAcoes.criar({ ...req.body, criadoPorEmail: req.user.email }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/agente/acoes/:id', auth.requireMaster, async (req, res) => {
  try {
    if (await desviarSeQaMaster(req, res, 'agente.acoes.editar', `Editar ação do agente: ${req.body?.nome || ''}`, { id: req.params.id, dados: req.body, atualizadoPorEmail: req.user.email })) return;
    res.json(await agenteAcoes.atualizar(req.params.id, req.body, req.user.email));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/agente/acoes/:id', auth.requireMaster, async (req, res) => {
  try {
    if (await desviarSeQaMaster(req, res, 'agente.acoes.excluir', 'Excluir ação do agente', { id: req.params.id })) return;
    res.json(await agenteAcoes.remover(req.params.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/agente/contexto', auth.requireMaster, async (req, res) => {
  res.json(await agenteAcoes.obterContexto());
});

app.put('/api/agente/contexto', auth.requireMaster, async (req, res) => {
  try {
    if (await desviarSeQaMaster(req, res, 'agente.contexto.editar', 'Editar contexto do agente', { texto: req.body?.texto, atualizadoPorEmail: req.user.email })) return;
    res.json(await agenteAcoes.salvarContexto(req.body?.texto, req.user.email));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/users', auth.requireMaster, async (req, res) => {
  try {
    if (await desviarSeQaMaster(req, res, 'usuarios.criar', `Criar acesso: ${req.body?.email || ''}`, req.body)) return;
    res.json(await users.create(req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// cria um acesso QA Master - role 'master' de verdade (100% de acesso, ver
// users.createQaMaster), so que com a flag qaMaster que desvia as acoes
// sensiveis pra fila de aprovacao (ver EXECUTORES_QA acima). So um Master de
// verdade cria (um QA Master tentando criar outro tambem cai na fila)
app.post('/api/users/qa-master', auth.requireMaster, async (req, res) => {
  try {
    if (await desviarSeQaMaster(req, res, 'usuarios.criarQaMaster', `Criar acesso QA Master: ${req.body?.email || ''}`, req.body)) return;
    res.json(await users.createQaMaster(req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/users/:id/permissions', auth.requireMaster, async (req, res) => {
  try {
    if (await desviarSeQaMaster(req, res, 'usuarios.permissoes', `Editar permissões do acesso ${req.params.id}`, { id: req.params.id, permissions: req.body.permissions })) return;
    res.json(await users.updatePermissions(req.params.id, req.body.permissions));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/users/:id/active', auth.requireMaster, async (req, res) => {
  try {
    if (await desviarSeQaMaster(req, res, 'usuarios.ativo', `${req.body.active ? 'Ativar' : 'Desativar'} acesso ${req.params.id}`, { id: req.params.id, active: req.body.active })) return;
    res.json(await users.setActive(req.params.id, req.body.active));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/users/:id/horario-permitido', auth.requireMaster, async (req, res) => {
  try {
    if (await desviarSeQaMaster(req, res, 'usuarios.horario', `Editar horário permitido do acesso ${req.params.id}`, { id: req.params.id, horarioPermitido: req.body.horarioPermitido })) return;
    res.json(await users.updateHorarioPermitido(req.params.id, req.body.horarioPermitido));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/users/:id/is-admin', auth.requireMaster, async (req, res) => {
  try {
    if (await desviarSeQaMaster(req, res, 'usuarios.isAdmin', `${req.body.isAdmin ? 'Dar' : 'Tirar'} Admin do acesso ${req.params.id}`, { id: req.params.id, isAdmin: req.body.isAdmin })) return;
    res.json(await users.updateIsAdmin(req.params.id, req.body.isAdmin));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// tag "QA User": acesso comum que sempre ve/cria todos os tipos de
// solicitacao na Central e tem tudo que criar marcado "TESTE" (ver
// users.updateQaUser/tiposSolicitacaoPermitidos)
app.put('/api/users/:id/qa-user', auth.requireMaster, async (req, res) => {
  try {
    if (await desviarSeQaMaster(req, res, 'usuarios.qaUser', `${req.body.qaUser ? 'Ativar' : 'Desativar'} tag QA User no acesso ${req.params.id}`, { id: req.params.id, qaUser: req.body.qaUser })) return;
    res.json(await users.updateQaUser(req.params.id, req.body.qaUser));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/users/:id/catalogo-estoque', auth.requireMaster, async (req, res) => {
  try {
    if (await desviarSeQaMaster(req, res, 'usuarios.catalogoEstoque', `Editar permissão de Catálogo do Estoque do acesso ${req.params.id}`, { id: req.params.id, valor: req.body.podeCatalogoEstoque })) return;
    res.json(await users.updatePodeCatalogoEstoque(req.params.id, req.body.podeCatalogoEstoque));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/users/:id/catalogo-insumos', auth.requireMaster, async (req, res) => {
  try {
    if (await desviarSeQaMaster(req, res, 'usuarios.catalogoInsumos', `Editar permissão de Catálogo de Insumos do acesso ${req.params.id}`, { id: req.params.id, valor: req.body.podeCatalogoInsumos })) return;
    res.json(await users.updatePodeCatalogoInsumos(req.params.id, req.body.podeCatalogoInsumos));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// "manter sempre conectado" (30 dias em vez de 8h) - login compartilhado de
// loja/terminal. So vale a partir do proximo login (ver users.js).
app.put('/api/users/:id/sessao-longa', auth.requireMaster, async (req, res) => {
  try {
    if (await desviarSeQaMaster(req, res, 'usuarios.sessaoLonga', `Editar "sempre conectado" do acesso ${req.params.id}`, { id: req.params.id, valor: req.body.sessaoLonga })) return;
    res.json(await users.updateSessaoLonga(req.params.id, req.body.sessaoLonga));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// tag "cadastrar Operadores" do Abastecimento: quem tem ve o botao 👥 e
// cadastra logins locais de balcao (ativar/desativar/remover/desbloquear
// continuam so do Master)
app.put('/api/users/:id/cadastrar-operadores', auth.requireMaster, async (req, res) => {
  try {
    if (await desviarSeQaMaster(req, res, 'usuarios.cadastrarOperadores', `Editar permissão de cadastrar Operadores do acesso ${req.params.id}`, { id: req.params.id, valor: req.body.podeCadastrarOperadores })) return;
    res.json(await users.updatePodeCadastrarOperadores(req.params.id, req.body.podeCadastrarOperadores));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/users/:id/rh-todas-unidades', auth.requireMaster, async (req, res) => {
  try {
    if (await desviarSeQaMaster(req, res, 'usuarios.rhTodasUnidades', `Editar permissão RH (todas as unidades) do acesso ${req.params.id}`, { id: req.params.id, valor: req.body.podeRhTodasUnidades })) return;
    res.json(await users.updatePodeRhTodasUnidades(req.params.id, req.body.podeRhTodasUnidades));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/users/:id/rh-cadastrar-efetivado', auth.requireMaster, async (req, res) => {
  try {
    if (await desviarSeQaMaster(req, res, 'usuarios.rhCadastrarEfetivado', `Editar permissão RH (cadastrar efetivado) do acesso ${req.params.id}`, { id: req.params.id, valor: req.body.podeRhCadastrarEfetivado })) return;
    res.json(await users.updatePodeRhCadastrarEfetivado(req.params.id, req.body.podeRhCadastrarEfetivado));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// tag de cargo (Loja/Gerente) - rotulo de organizacao, nao muda permissao
app.put('/api/users/:id/cargo', auth.requireMaster, async (req, res) => {
  try {
    if (await desviarSeQaMaster(req, res, 'usuarios.cargo', `Editar cargo do acesso ${req.params.id}`, { id: req.params.id, cargo: req.body.cargo })) return;
    res.json(await users.updateCargo(req.params.id, req.body.cargo));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/users/:id/reset-password', auth.requireMaster, async (req, res) => {
  try {
    if (await desviarSeQaMaster(req, res, 'usuarios.resetSenha', `Resetar senha do acesso ${req.params.id}`, { id: req.params.id, password: req.body.password })) return;
    res.json(await users.resetPassword(req.params.id, req.body.password));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// desbloqueio SEM mexer na senha - a pessoa volta a usar a MESMA senha de
// sempre (mesma dinamica do "🔒 Nova senha", so que sem definir senha
// nenhuma). pedirTrocaSenha (opcional) e a UNICA forma de tambem forcar
// trocar no proximo login - continua entrando com a senha ATUAL pra isso,
// nunca uma senha padrao tipo "inicial1"
app.post('/api/users/:id/desbloquear', auth.requireMaster, async (req, res) => {
  try {
    if (await desviarSeQaMaster(req, res, 'usuarios.desbloquear', `Desbloquear acesso ${req.params.id}`, { id: req.params.id, pedirTrocaSenha: !!req.body.pedirTrocaSenha })) return;
    res.json(await users.desbloquear(req.params.id, { pedirTrocaSenha: !!req.body.pedirTrocaSenha }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// "Reset Senha" rapido (Painel, menu ☰) - Master ou Admin acham o acesso so
// pelo usuario/email (sem precisar abrir a tela de Usuarios) e definem uma
// senha nova na hora - mesmo efeito do "Nova senha" de Usuarios (desbloqueia
// e obriga trocar no proximo login, ver users.resetPassword)
app.post('/api/users/reset-senha-rapido', auth.requireMasterOrAdmin, async (req, res) => {
  try {
    const alvo = await users.findByIdentifier(req.body.identificador);
    if (!alvo) return res.status(404).json({ error: 'Nenhum acesso encontrado com esse usuário/email.' });
    if (alvo.role === 'master') return res.status(400).json({ error: 'Não é possível redefinir a senha do Master por aqui.' });
    await users.resetPassword(alvo.id, req.body.novaSenha);
    res.json({ ok: true, email: alvo.email });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/users/:id/username', auth.requireMaster, async (req, res) => {
  try {
    if (await desviarSeQaMaster(req, res, 'usuarios.username', `Editar usuário (login) do acesso ${req.params.id}`, { id: req.params.id, username: req.body.username })) return;
    res.json(await users.updateUsername(req.params.id, req.body.username));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// atualizacao em massa: Master cola uma lista "email,username" (ex: de uma
// planilha) e o backend aplica linha a linha, sem parar no primeiro erro
app.post('/api/users/usernames-em-massa', auth.requireMaster, async (req, res) => {
  try {
    if (await desviarSeQaMaster(req, res, 'usuarios.usernamesEmMassa', `Atualização em massa de usuários (${(req.body.itens || []).length} linha(s))`, { itens: req.body.itens })) return;
    res.json(await users.updateUsernamesEmMassa(req.body.itens));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/users/:id', auth.requireMaster, async (req, res) => {
  try {
    if (await desviarSeQaMaster(req, res, 'usuarios.excluir', `Excluir acesso ${req.params.id}`, { id: req.params.id })) return;
    await users.remove(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- backup do banco (so o Master ve/aciona) ----------
app.get('/api/backups', auth.requireMaster, async (req, res) => {
  try {
    res.json(await backup.listarBackups());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/backups/run', auth.requireMaster, async (req, res) => {
  try {
    res.json(await backup.rodarBackup({ forcar: true }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// recuperar um fechamento excluido por engano - le a coleção fechamentosLive
// de dentro de um arquivo de backup especifico (a lista completa, pro Master
// buscar/filtrar na tela) e permite restaurar um registro pontual de volta
// pro Firestore, exatamente como estava naquele backup
app.get('/api/backups/:nome/fechamentos', auth.requireMaster, async (req, res) => {
  try {
    const dump = await backup.lerBackup(req.params.nome);
    res.json(dump.fechamentosLive || []);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/backups/:nome/fechamentos/:id/restaurar', auth.requireMaster, async (req, res) => {
  try {
    const registro = await backup.restaurarDocumento(req.params.nome, 'fechamentosLive', req.params.id);
    fechamentosLive.invalidarCache();
    broadcast('fechamento-restaurado', registro, 'lancamento');
    broadcast('fechamento-restaurado', registro, 'fechamentos');
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- relatorio periodico de transacoes (so o Master ve/aciona) ----------
// PDF+CSV do periodo, gerado antes da limpeza do banco (ver relatorios.js) -
// e o que substitui guardar toda transacao pra sempre: chargeback/fraude
// ficam no banco (retidos), o resto vira so esse relatorio depois de
// RELATORIO_INTERVALO_DIAS dias.
app.get('/api/relatorios', auth.requireMaster, async (req, res) => {
  try {
    res.json(await relatorios.listarRelatorios());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/relatorios/rodar', auth.requireMaster, async (req, res) => {
  try {
    res.json(await relatorios.rodarRelatorio({ forcar: true }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/relatorios/:nome', auth.requireMaster, async (req, res) => {
  await relatorios.baixarArquivo(req.params.nome, res);
});

// ---------- fechamentos de caixa (secao "fechamentos") ----------
// combina os fechamentos das planilhas do Google Sheets (ARCFOOD + Grupo
// Bravo, aba "BD") com os fechamentos lançados ao vivo pelas lojas. As
// unidades aqui (19821/19855/19888/19889, ou o nome da loja no Grupo Bravo)
// sao codigos proprios da planilha, num espaco diferente do
// merchantAccountCode da Adyen usado em Monitor/Disputas - mas o mesmo campo
// permissions.unidades e reaproveitado pra filtrar as duas coisas (o Master
// escolhe os codigos certos pelo seletor de /api/meta/unidades, que junta os
// dois espacos).
//
// fechamentosData comeca com o snapshot estatico (fallback pro caso da 1a
// sincronizacao ainda nao ter rodado, ou de a API do Sheets estar fora do
// ar) e e substituido pelos dados frescos da planilha assim que
// sincronizarPlanilhasFechamento roda com sucesso (1x no boot; depois so
// quando o Master aciona manualmente - sem sincronizacao automatica).
let fechamentosData = require('./fechamentos-snapshot.json');
let statusSincronizacaoPlanilhas = { ultimaEm: null, ultimoErro: null, sincronizando: false };

async function sincronizarPlanilhasFechamento({ completa = false } = {}) {
  if (statusSincronizacaoPlanilhas.sincronizando) return statusSincronizacaoPlanilhas;
  statusSincronizacaoPlanilhas.sincronizando = true;
  try {
    const dados = await sheetsSync.sincronizar({ completa });
    if (dados.length) {
      fechamentosData = dados;
      statusSincronizacaoPlanilhas.ultimaEm = new Date().toISOString();
      statusSincronizacaoPlanilhas.ultimoErro = null;
      statusSincronizacaoPlanilhas.linhasNovas = dados.linhasNovas ?? null;
      console.log(`Fechamentos: sincronizados ${dados.length} registros das planilhas do Google Sheets (${dados.linhasNovas ?? '?'} linha(s) nova(s) lida(s)).`);
    } else {
      statusSincronizacaoPlanilhas.ultimoErro = 'A sincronização rodou mas não retornou nenhuma linha - planilhas continuam com os dados anteriores.';
      console.warn(statusSincronizacaoPlanilhas.ultimoErro);
    }
  } catch (err) {
    statusSincronizacaoPlanilhas.ultimoErro = err.message;
    console.error('Erro ao sincronizar planilhas de fechamento:', err.message);
  } finally {
    statusSincronizacaoPlanilhas.sincronizando = false;
  }
  return statusSincronizacaoPlanilhas;
}

app.get('/api/fechamentos', requireSection('fechamentos'), async (req, res) => {
  const lancados = await fechamentosLive.listAll();
  const sangriasLancadas = (await sangrias.listAll()).map(sangrias.comoFechamento);
  const combinado = sheetsSync.mesclarLancamentosDoMesmoDia([...fechamentosData, ...lancados, ...sangriasLancadas]);
  res.json(auth.filterByUnidade(req, combinado));
});

// registro CRU (sem mesclar com sangria/planilha) de um fechamento - usado
// pela edicao direta do Master, pra nunca editar em cima de um valor que ja
// vem somado com a sangria do dia (ver sangrias.js/comoFechamento)
app.get('/api/fechamentos/:id/bruto', auth.requireMaster, async (req, res) => {
  const registro = await fechamentosLive.getOne(req.params.id);
  if (!registro) return res.status(404).json({ error: 'Fechamento não encontrado.' });
  res.json(registro);
});

// data de hoje em Brasilia, formato YYYY-MM-DD
function hojeBrasiliaISO() {
  const partes = new Intl.DateTimeFormat('en-CA', { timeZone: FUSO_BR, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const o = {};
  partes.forEach((p) => { if (p.type !== 'literal') o[p.type] = p.value; });
  return `${o.year}-${o.month}-${o.day}`;
}

// varre fechamentos ja lançados num período e cria os tickets de Quebra de
// caixa que faltaram (ver fechamentosLive.backfillQuebraCaixa) - pensado pra
// pegar retroativamente quem foi lançado ANTES dessa feature existir.
// Idempotente: pode rodar de novo sem duplicar. So Master.
app.post('/api/fechamentos/quebra-caixa/backfill', auth.requireMaster, async (req, res) => {
  try {
    const inicio = (req.body && req.body.inicio) || '2026-07-01';
    const fim = (req.body && req.body.fim) || hojeBrasiliaISO();
    const resultado = await fechamentosLive.backfillQuebraCaixa(inicio, fim);
    resultado.cardsCriados.forEach((card) => broadcast('solicitacao-criada', card, 'solicitacoes'));
    if (resultado.cardsCriados.length) {
      push.notifySolicitacao(
        `${resultado.cardsCriados.length} ticket(s) de Quebra de caixa criados retroativamente`,
        `Período ${inicio} a ${fim}`,
        resultado.cardsCriados[0].id,
      );
    }
    res.json({
      periodo: { inicio, fim },
      verificados: resultado.verificados,
      criados: resultado.cardsCriados.length,
      jaTinhaCard: resultado.jaTinhaCard,
      semDiferencaRelevante: resultado.semDiferencaRelevante,
      erros: resultado.erros,
      tickets: resultado.cardsCriados.map((c) => ({ numeroTicket: c.numeroTicket, unidade: c.unidadeNome, titulo: c.titulo })),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// data de ontem em Brasilia, formato YYYY-MM-DD (mesmo padrao ja usado em
// parque.js/hojeBrasiliaISO, so que D-1)
function ontemBrasiliaISO() {
  const partes = new Intl.DateTimeFormat('en-CA', { timeZone: FUSO_BR, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const o = {};
  partes.forEach((p) => { if (p.type !== 'literal') o[p.type] = p.value; });
  const hoje = new Date(`${o.year}-${o.month}-${o.day}T00:00:00`);
  hoje.setDate(hoje.getDate() - 1);
  return `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}-${String(hoje.getDate()).padStart(2, '0')}`;
}

// caminho inverso do sincronizarPlanilhasFechamento acima: manda o
// fechamento lançado ao vivo no app (nao mais preenchido na planilha) de
// volta pra planilha ARCFOOD, pros stakeholders que ainda acompanham por
// ela. So Master, e so sob demanda (nao automatico) - escreve numa
// planilha externa/compartilhada, e um dado errado lá tem mais trabalho
// pra desfazer do que só rodar de novo depois de corrigir.
app.post('/api/fechamentos/arcfood/enviar-planilha', auth.requireMaster, async (req, res) => {
  try {
    const data = (req.body && req.body.data) || ontemBrasiliaISO();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return res.status(400).json({ error: 'Data inválida.' });
    const unidadesArcfood = ['19821', '19855', '19888', '19889'];
    const lancados = (await fechamentosLive.listByUnidades(unidadesArcfood)).filter((f) => f.data === data);
    const porUnidade = new Map(lancados.map((f) => [f.unidade, f]));

    const resultado = { data, enviados: [], semLancamento: [], erros: [] };
    for (const cod of unidadesArcfood) {
      const f = porUnidade.get(cod);
      if (!f) { resultado.semLancamento.push(FECHAMENTO_UNIDADES_NOMES[cod] || cod); continue; }
      try {
        const r = await sheetsSync.enviarFechamentoArcfood(f);
        resultado.enviados.push({ unidade: f.unidadeNome || FECHAMENTO_UNIDADES_NOMES[cod] || cod, acao: r.acao });
      } catch (err) {
        resultado.erros.push({ unidade: f.unidadeNome || FECHAMENTO_UNIDADES_NOMES[cod] || cod, erro: err.message });
      }
    }
    res.json(resultado);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// aplica os mesmos filtros do front (periodo ja efetivo - o proprio front
// resolve qualquer corte extra da tabela antes de mandar inicio/fim - mais
// grupo e unidades) - usado pelos relatorios de Fechamentos e de Comparativo
// por unidade abaixo
async function fechamentosFiltrados(req) {
  const { inicio, fim, grupo, unidades } = req.query;
  const lancados = await fechamentosLive.listAll();
  const sangriasLancadas = (await sangrias.listAll()).map(sangrias.comoFechamento);
  const combinado = sheetsSync.mesclarLancamentosDoMesmoDia([...fechamentosData, ...lancados, ...sangriasLancadas]);
  const permitido = auth.filterByUnidade(req, combinado);
  const unidadesSet = unidades ? new Set(String(unidades).split(',').filter(Boolean)) : null;
  return permitido.filter((f) =>
    (!grupo || f.grupo === grupo) &&
    (!unidadesSet || unidadesSet.has(f.unidade)) &&
    (!inicio || (f.data || '') >= inicio) &&
    (!fim || (f.data || '') <= fim)
  );
}

// monta as mesmas colunas/linhas mostradas no painel "Fechamentos" da tela
// (inclusive os Canais de venda/Formas de pagamento por grupo que foram de
// fato preenchidos) - usado pelos dois formatos de relatorio abaixo
async function montarRelatorioFechamentos(req) {
  const [fechamentos, listaGrupos] = await Promise.all([fechamentosFiltrados(req), grupos.list()]);
  // colunas escondidas no seletor 🧩 Colunas da tela (fechamentos.html)
  const ocultas = new Set(String(req.query.ocultas || '').split(',').filter(Boolean));
  return fechamentosReport.prepararRelatorio(fechamentos, listaGrupos, ocultas);
}

// mesma agregacao por unidade do painel "Comparativo por unidade" da tela
// (renderUnidadesTable em fechamentos.html) - a coluna "Previsao (mes)" fica
// de fora do relatorio de proposito: e uma projecao calculada em cima do
// historico completo (nao so do periodo filtrado) e nao faz sentido como
// valor estatico exportado
function prepararFechamentosPorUnidade(rows) {
  const colunas = [
    { key: 'unidade', label: 'Unid.' }, { key: 'qtd', label: 'Fechamentos' }, { key: 'faturamento', label: 'Faturamento' },
    { key: 'diferenca', label: 'Diferença' }, { key: 'tc', label: 'TC total' }, { key: 'cancelados', label: 'Cancelados' },
  ];
  const porUnidade = {};
  rows.forEach((r) => {
    const c = (porUnidade[r.unidade] ||= { nome: r.unidadeNome || r.unidade, qtd: 0, faturamento: 0, diferenca: 0, tc: 0, cancelados: 0 });
    c.qtd++; c.faturamento += r.faturamento || 0; c.diferenca += r.diferenca || 0; c.tc += r.tc || 0; c.cancelados += r.cancelados || 0;
  });
  const linhas = Object.values(porUnidade).sort((a, b) => b.faturamento - a.faturamento).map((c) => ({
    unidade: c.nome, qtd: c.qtd, faturamento: reportUtil.fmtMoneyBR(c.faturamento), diferenca: reportUtil.fmtMoneyBR(c.diferenca),
    tc: c.tc.toFixed(0), cancelados: c.cancelados.toFixed(0),
  }));
  return { colunas, linhas };
}

app.get('/api/fechamentos/relatorio-unidades.:formato(csv|pdf)', requireSection('fechamentos'), async (req, res) => {
  const { colunas, linhas } = prepararFechamentosPorUnidade(await fechamentosFiltrados(req));
  if (req.params.formato === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${reportUtil.nomeArquivoComData('fechamentos-por-unidade')}.csv"`);
    return res.send(reportUtil.toCSV(colunas, linhas));
  }
  reportUtil.writePDF(res, { titulo: 'Fechamentos · Comparativo por Unidade', subtitulo: `Exportado em ${reportUtil.agoraBrasiliaFmt()} · ${linhas.length} unidade(s)`, colunas, linhas, nomeArquivo: reportUtil.nomeArquivoComData('fechamentos-por-unidade') });
});

// ---------- relatorio de Fechamentos (CSV/PDF) do periodo filtrado na tela -
// mesma secao 'fechamentos' da tela (nao restrito ao Master), respeitando as
// unidades que o usuario tem permissao de ver ----------
app.get('/api/fechamentos/relatorio.csv', requireSection('fechamentos'), async (req, res) => {
  const { colunas, linhas } = await montarRelatorioFechamentos(req);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fechamentosReport.slugify('relatorio-fechamentos')}-${reportUtil.dataArquivo()}.csv"`);
  res.send(fechamentosReport.toCSV(colunas, linhas));
});

app.get('/api/fechamentos/relatorio.pdf', requireSection('fechamentos'), async (req, res) => {
  const { inicio, fim } = req.query;
  const { colunas, linhas } = await montarRelatorioFechamentos(req);
  const periodo = inicio || fim ? ` · período: ${inicio || 'início'} a ${fim || 'hoje'}` : '';
  const subtitulo = `Exportado em ${agoraBrasiliaFmt()}${periodo} · ${linhas.length} fechamento(s)`;
  fechamentosReport.writePDF(res, { titulo: 'Relatório de Fechamentos', subtitulo, colunas, linhas, nomeArquivo: `relatorio-fechamentos-${reportUtil.dataArquivo()}` });
});

app.get('/api/fechamentos/sincronizacao', requireSection('fechamentos'), (req, res) => {
  res.json(statusSincronizacaoPlanilhas);
});

// forca uma sincronizacao imediata com as planilhas - so o Master (evita
// disparar chamadas extras na API do Google sem necessidade). Por padrao a
// leitura e INCREMENTAL (so as linhas novas desde a ultima leitura); passe
// { completa: true } pra reler a planilha inteira (pega linha antiga editada)
app.post('/api/fechamentos/sincronizar-planilhas', auth.requireMaster, async (req, res) => {
  const status = await sincronizarPlanilhasFechamento({ completa: req.body?.completa === true });
  if (status.ultimoErro) return res.status(502).json(status);
  res.json(status);
});

// KPI's extras tipo "arquivo" (ver grupos.js) mandam o arquivo com fieldname
// "kpiArquivo:<campo>" - sobe cada um pro Storage e devolve {campo: caminho}
// pra mesclar no mapa de kpisExtras antes de mandar pro fechamentosLive (que
// grava o caminho como o "valor" desse campo, ver sanitizarMapaExtras)
async function uploadArquivosKpi(files, ownerId) {
  const out = {};
  for (const file of files || []) {
    const m = /^kpiArquivo:(.+)$/.exec(file.fieldname);
    if (!m) continue;
    out[m[1]] = await storage.salvarArquivo(ownerId, file, 'fechamento-kpis');
  }
  return out;
}

// ---------- lancamento de fechamento pela propria loja (secao "lancamento") ----------
// substitui o AppSheet: a loja loga com um usuario proprio (papel "Fechamento",
// limitado a sua(s) unidade(s)) e lanca o fechamento do dia direto no banco.
// Depois de lancado o registro e imutavel - qualquer correcao vira um pedido
// que so o Master pode aprovar (fechamentosLive.js guarda o historico).
// upload.any(): so entra em acao se o body vier multipart (quando algum KPI
// extra tipo "arquivo" tem foto/anexo escolhido, ver lancamento.html) -
// requisicao JSON normal (sem arquivo nenhum) passa direto, sem afetar nada.
app.post('/api/fechamentos/lancar', requireSection('lancamento'), upload.any(), async (req, res) => {
  try {
    const body = req.is('multipart/form-data') ? JSON.parse(req.body.payload || '{}') : req.body;
    const { unidade, unidadeNome, grupo, data, gerente, campos, canaisVendaExtras, formasPagamentoExtras, observacao, detalhesMaquinas, detalhesMaquinasPos, detalhesSaidas } = body;
    if (!req.isMaster && !(req.permissions.unidades || []).includes(unidade)) {
      return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    }
    const arquivosKpi = await uploadArquivosKpi(req.files, unidade || 'geral');
    const kpisExtras = { ...(body.kpisExtras || {}), ...arquivosKpi };
    const registro = await fechamentosLive.create({
      unidade, unidadeNome, grupo, data, gerente, campos, kpisExtras, canaisVendaExtras, formasPagamentoExtras, observacao, detalhesMaquinas, detalhesMaquinasPos, detalhesSaidas,
      criadoPorId: req.user.id,
      criadoPorEmail: req.user.email,
    });
    broadcast('fechamento-lancado', registro, 'lancamento');
    // diferença passou do limite (ver fechamentosLive.LIMITE_QUEBRA_CAIXA) -
    // ticket automatico de "Quebra de caixa" ja nasceu junto, so falta
    // avisar a Central igual qualquer solicitacao nova
    if (registro.cardQuebraCaixa) {
      broadcast('solicitacao-criada', registro.cardQuebraCaixa, 'solicitacoes');
      push.notifySolicitacao(
        `Ticket #${registro.cardQuebraCaixa.numeroTicket} · Quebra de caixa`,
        `${registro.unidadeNome} · ${registro.cardQuebraCaixa.titulo}`,
        registro.cardQuebraCaixa.id,
      );
      notificarSeDirecionadoAoMV('quebra-caixa', registro.cardQuebraCaixa);
    }
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/fechamentos/meus', requireSection('lancamento'), async (req, res) => {
  if (req.isMaster) return res.json(await fechamentosLive.listAll());
  res.json(await fechamentosLive.listByUnidades(req.permissions.unidades || []));
});

// ---------- grupos (franquias) - cada uma pode ter seus proprios KPI's
// extras no fechamento (ver grupos.js). Leitura liberada pra quem lanca
// fechamento (precisa saber quais campos extras preencher) ou corrige
// (central.html); so o Master cria/edita/apaga grupo ----------
app.get('/api/grupos', requireAnySection('lancamento', 'fechamentos', 'solicitacoes'), async (req, res) => {
  res.json(await grupos.list());
});

// so id+email de quem pode ser "responsavel" por uma solicitação - usado
// tanto pra quem NAO e Master/Admin poder "direcionar" uma solicitação pra
// alguem do proprio grupo de lojas na criação (ver central.html) quanto pro
// Master "Atribuir responsável" (visibilidade na Central, ver
// central-historico.html), sem expor a lista inteira de usuarios (essa e
// Master/Admin-only, GET /api/users). Quem entra na lista:
//   - todo Master ativo (sempre, sem precisar configurar nada);
//   - Admins configurados como responsaveis do grupo em /grupos.html;
//   - Admins que ja se ENGAJARAM com solicitações dessas lojas (aprovaram/
//     rejeitaram alguma, ou mandaram mensagem no chat) - assim o admin que
//     comeca a atuar num grupo passa a aparecer/ser notificavel sozinho,
//     sem depender do Master lembrar de cadastra-lo como responsavel;
//   - qualquer pessoa com a seção "manutencao" ou "tecnico" liberada (por
//     pedido do usuario: precisa poder marcar o Joao/tecnico direto aqui
//     pra ele enxergar o card no proprio Histórico/Painel)
app.get('/api/grupos/responsaveis', requireSection('solicitacoes'), async (req, res) => {
  const { unidade } = req.query;
  if (!unidade) return res.status(400).json({ error: 'Informe a unidade.' });
  const grupo = await grupos.grupoDaUnidade(unidade);
  const unidadesDoGrupo = new Set(grupo ? grupo.unidades || [] : [unidade]);
  const idsConfigurados = new Set(grupo ? grupo.responsaveis || [] : []);

  const [todos, estornos, ajustes, gerais, chats] = await Promise.all([
    users.list(), refunds.listAll(), fechamentosLive.listarEdicoes(), solicitacoes.listAll(), centralChat.listAllCached(),
  ]);

  const cardsDoGrupo = [
    ...estornos.filter((r) => unidadesDoGrupo.has(r.unidade)).map((r) => ({ key: `estorno:${r.id}`, decisor: r.decidedByEmail })),
    ...ajustes.filter((p) => unidadesDoGrupo.has(p.unidade)).map((p) => ({ key: `ajuste-fechamento:${p.id}`, decisor: p.decididoPorEmail })),
    ...gerais.filter((s) => unidadesDoGrupo.has(s.unidade)).map((s) => ({ key: `${s.tipo}:${s.id}`, decisor: s.decididoPorEmail })),
  ];
  const chavesDoGrupo = new Set(cardsDoGrupo.map((c) => c.key));
  const emailsEngajados = new Set(cardsDoGrupo.map((c) => c.decisor).filter(Boolean));
  chats.forEach((m) => { if (chavesDoGrupo.has(m.cardKey) && m.autorEmail) emailsEngajados.add(m.autorEmail); });

  function papelDe(u) {
    if (u.role === 'master') return 'master';
    if (u.isAdmin) return 'admin';
    const secoesUsuario = u.permissions?.sections || [];
    if (secoesUsuario.includes('manutencao')) return 'manutencao';
    if (secoesUsuario.includes('tecnico')) return 'tecnico';
    return null;
  }
  const responsaveis = todos
    .filter((u) => u.active !== false && (
      u.role === 'master' ||
      (u.isAdmin && (idsConfigurados.has(u.id) || emailsEngajados.has(u.email))) ||
      (u.permissions?.sections || []).includes('manutencao') ||
      (u.permissions?.sections || []).includes('tecnico')
    ))
    .map((u) => ({ id: u.id, email: u.email, username: u.username || null, papel: papelDe(u) }));
  res.json(responsaveis);
});

// relatorio (CSV/PDF) da tabela "Grupos cadastrados" de grupos.html
app.get('/api/grupos/relatorio.:formato(csv|pdf)', requireAnySection('lancamento', 'fechamentos', 'solicitacoes'), async (req, res) => {
  const unidadesMapa = await construirUnidadesMapa();
  const colunas = [
    { key: 'nome', label: 'Nome' }, { key: 'unidades', label: 'Unidades' },
    { key: 'canais', label: 'Canais de venda extras' }, { key: 'formas', label: 'Formas de pagamento extras' }, { key: 'kpis', label: 'KPIs extras' },
  ];
  const listaExtras = (lista) => (lista || []).map((k) => k.label).join(', ') || '—';
  const linhas = (await grupos.list()).map((g) => ({
    nome: g.nome,
    unidades: (g.unidades || []).map((u) => unidadesMapa[u] || u).join(', ') || '—',
    canais: listaExtras(g.canaisVendaExtras), formas: listaExtras(g.formasPagamentoExtras), kpis: listaExtras(g.kpisExtras),
  }));
  if (req.params.formato === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${reportUtil.nomeArquivoComData('grupos')}.csv"`);
    return res.send(reportUtil.toCSV(colunas, linhas));
  }
  reportUtil.writePDF(res, { titulo: 'Grupos Cadastrados', subtitulo: `Exportado em ${reportUtil.agoraBrasiliaFmt()} · ${linhas.length} grupo(s)`, colunas, linhas, nomeArquivo: reportUtil.nomeArquivoComData('grupos') });
});

app.post('/api/grupos', auth.requireMaster, async (req, res) => {
  try {
    if (await desviarSeQaMaster(req, res, 'grupos.criar', `Criar grupo: ${req.body?.nome || ''}`, req.body)) return;
    res.json(await grupos.create(req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/grupos/:id', auth.requireMaster, async (req, res) => {
  try {
    if (await desviarSeQaMaster(req, res, 'grupos.editar', `Editar grupo ${req.params.id}`, { id: req.params.id, dados: req.body })) return;
    res.json(await grupos.update(req.params.id, req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/grupos/:id', auth.requireMaster, async (req, res) => {
  try {
    if (await desviarSeQaMaster(req, res, 'grupos.excluir', `Excluir grupo ${req.params.id}`, { id: req.params.id })) return;
    await grupos.remove(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- Inventario (contagem fisica, recebimento de mercadoria e CMV -
// por enquanto so as lojas Domino's, ver INVENTARIO_UNIDADES_NOMES acima).
// Secao propria "inventario"; qualquer um com a secao pode lançar contagem/
// recebimento/saida das unidades liberadas pra ele; editar catalogo e
// excluir lançamento e Master-only, mesmo padrao do resto do app ----------
function podeUnidadeInventario(req, unidade) {
  return req.isMaster || (req.permissions.unidades || []).includes(unidade);
}

app.get('/api/inventario/unidades', requireSection('inventario'), (req, res) => {
  const unidades = req.isMaster
    ? Object.keys(INVENTARIO_UNIDADES_NOMES)
    : (req.permissions.unidades || []).filter((u) => INVENTARIO_UNIDADES_NOMES[u]);
  res.json(unidades.map((codigo) => ({ codigo, nome: INVENTARIO_UNIDADES_NOMES[codigo] })));
});

// setores/tipos do catalogo - fixos + os que o Master for cadastrando (ver
// inventario.js). So Master cria (mesmo padrao de permissao do catalogo).
app.get('/api/inventario/setores', requireSection('inventario'), async (req, res) => {
  res.json(await inventario.listSetores());
});
app.post('/api/inventario/setores', auth.requireMasterOuCatalogoEstoque, async (req, res) => {
  try {
    res.json(await inventario.criarSetor(req.body.nome));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.get('/api/inventario/tipos', requireSection('inventario'), async (req, res) => {
  res.json(await inventario.listTipos());
});
app.post('/api/inventario/tipos', auth.requireMasterOuCatalogoEstoque, async (req, res) => {
  try {
    res.json(await inventario.criarTipo(req.body.nome));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// catalogo e por loja (cada uma organiza o proprio, ver inventario.js) -
// toda rota abaixo exige `unidade` e confere acesso a ela, mesmo padrao das
// rotas de contagem/recebimento/saida
app.get('/api/inventario/catalogo', requireSection('inventario'), async (req, res) => {
  const unidade = req.query.unidade;
  if (!podeUnidadeInventario(req, unidade)) return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
  res.json(await inventario.listCatalogo(unidade));
});
// cadastrar item novo fica aberto pra qualquer um com acesso a Inventario -
// e uma necessidade do dia a dia da loja (contar um item que ainda nao
// existe no catalogo, ver abrirNovoItemContagem em estoque.html), diferente
// de REORGANIZAR o catalogo existente (editar setor/tipo/custo/ativo,
// excluir), que ai sim fica restrito a quem tem a permissao de Catalogo
app.post('/api/inventario/catalogo', requireSection('inventario'), async (req, res) => {
  try {
    if (!podeUnidadeInventario(req, req.body.unidade)) return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    res.json(await inventario.criarItem(req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.put('/api/inventario/catalogo/:id', auth.requireMasterOuCatalogoEstoque, async (req, res) => {
  try {
    if (!req.isMaster) {
      const unidadeDoItem = await inventario.obterItemUnidade(req.params.id);
      if (unidadeDoItem && !podeUnidadeInventario(req, unidadeDoItem)) return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    }
    res.json(await inventario.atualizarItem(req.params.id, req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.delete('/api/inventario/catalogo/:id', auth.requireMasterOuCatalogoEstoque, async (req, res) => {
  try {
    if (!req.isMaster) {
      const unidadeDoItem = await inventario.obterItemUnidade(req.params.id);
      if (unidadeDoItem && !podeUnidadeInventario(req, unidadeDoItem)) return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    }
    await inventario.removerItem(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
// reordenar itens de um setor NUMA loja (drag-and-drop no Contagem/
// Catalogo) - mesma permissao de "reorganizar catalogo" das rotas acima
app.put('/api/inventario/catalogo/ordem', auth.requireMasterOuCatalogoEstoque, async (req, res) => {
  try {
    if (!podeUnidadeInventario(req, req.body.unidade)) return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    res.json(await inventario.reordenarItens(req.body.unidade, req.body.setor, req.body.ids));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
// carrega o catalogo padrao extraido das planilhas do Domino's - idempotente
// POR LOJA (so adiciona, em cada loja, o que ainda nao existe la pelo nome -
// nao mexe no que a loja ja customizou). Sem `unidades` no corpo, aplica em
// TODAS as lojas de uma vez (uso tipico: popular a rede inteira de uma vez).
app.post('/api/inventario/catalogo/seed', auth.requireMaster, async (req, res) => {
  try {
    const unidadesAlvo = Array.isArray(req.body.unidades) && req.body.unidades.length
      ? req.body.unidades
      : Object.keys(INVENTARIO_UNIDADES_NOMES);
    res.json(await inventario.seedCatalogoPadrao(unidadesAlvo));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/inventario/recebimentos', requireSection('inventario'), async (req, res) => {
  const todos = await inventario.listRecebimentos();
  res.json(req.isMaster ? todos : todos.filter((r) => podeUnidadeInventario(req, r.unidade)));
});
app.post('/api/inventario/recebimentos', requireSection('inventario'), async (req, res) => {
  try {
    if (!podeUnidadeInventario(req, req.body.unidade)) return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    const registro = await inventario.criarRecebimento({ ...req.body, criadoPorId: req.user.id, criadoPorEmail: req.user.email });
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.delete('/api/inventario/recebimentos/:id', auth.requireMaster, async (req, res) => {
  try {
    await inventario.removerRecebimento(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/inventario/saidas', requireSection('inventario'), async (req, res) => {
  const todos = await inventario.listSaidas();
  res.json(req.isMaster ? todos : todos.filter((s) => podeUnidadeInventario(req, s.unidade)));
});
app.post('/api/inventario/saidas', requireSection('inventario'), async (req, res) => {
  try {
    if (!podeUnidadeInventario(req, req.body.unidade)) return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    const registro = await inventario.criarSaida({ ...req.body, criadoPorId: req.user.id, criadoPorEmail: req.user.email });
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.delete('/api/inventario/saidas/:id', auth.requireMaster, async (req, res) => {
  try {
    await inventario.removerSaida(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// contagens de TODAS as unidades permitidas numa data - usado pelo card de
// Estoque no Painel (quantas/quais unidades ja fizeram a contagem hoje +
// detalhamento por setor/item quando o usuario clica numa unidade)
app.get('/api/inventario/contagens-do-dia', requireSection('inventario'), async (req, res) => {
  const { data } = req.query;
  if (!data) return res.status(400).json({ error: 'Informe a data.' });
  const todas = await inventario.listContagens();
  res.json(todas.filter((c) => c.data === data && podeUnidadeInventario(req, c.unidade)));
});

app.get('/api/inventario/contagens', requireSection('inventario'), async (req, res) => {
  const { unidade, data } = req.query;
  if (!unidade || !data) return res.status(400).json({ error: 'Informe unidade e data.' });
  if (!podeUnidadeInventario(req, unidade)) return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
  const registro = await inventario.getContagem(unidade, data);
  res.json(registro || { unidade, data, contagens: {} });
});
app.put('/api/inventario/contagens', requireSection('inventario'), async (req, res) => {
  try {
    if (!podeUnidadeInventario(req, req.body.unidade)) return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    const registro = await inventario.upsertContagem({ ...req.body, criadoPorId: req.user.id, criadoPorEmail: req.user.email });
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// resumo do periodo pra aba Estoque (entradas/consumo/saidas/desperdicio):
// compara duas contagens quaisquer, sem exigir dias consecutivos - ver
// inventario.js/resumoPeriodo
app.get('/api/inventario/resumo-periodo', requireSection('inventario'), async (req, res) => {
  try {
    const { unidade, inicio, fim } = req.query;
    if (!unidade || !inicio || !fim) return res.status(400).json({ error: 'Informe unidade, início e fim.' });
    if (!podeUnidadeInventario(req, unidade)) return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    res.json(await inventario.resumoPeriodo(unidade, inicio, fim));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// motor de diferenca (esperado x real) + ranking de ofensores + CMV - ver
// inventario.js/calcularDiferencas
app.get('/api/inventario/diferencas', requireSection('inventario'), async (req, res) => {
  try {
    const { unidade, inicio, fim } = req.query;
    if (!unidade || !inicio || !fim) return res.status(400).json({ error: 'Informe unidade, início e fim.' });
    if (!podeUnidadeInventario(req, unidade)) return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    res.json(await inventario.calcularDiferencas(unidade, inicio, fim));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/inventario/relatorio.:formato(csv|pdf)', requireSection('inventario'), async (req, res) => {
  try {
    const { unidade, inicio, fim } = req.query;
    if (!unidade || !inicio || !fim) return res.status(400).json({ error: 'Informe unidade, início e fim.' });
    if (!podeUnidadeInventario(req, unidade)) return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    const { ofensores } = await inventario.calcularDiferencas(unidade, inicio, fim);
    const colunas = [
      { key: 'itemNome', label: 'Item' }, { key: 'setor', label: 'Setor' },
      { key: 'entradas', label: 'Entradas' }, { key: 'vendas', label: 'Vendas' }, { key: 'desperdicios', label: 'Desperdício' },
      { key: 'diferencaQtd', label: 'Diferença (qtd)' }, { key: 'diferencaValor', label: 'Diferença (R$)' },
    ];
    const linhas = ofensores.map((o) => ({ ...o, setor: inventario.SETORES[o.setor] || o.setor, diferencaValor: reportUtil.fmtMoneyBR(o.diferencaValor) }));
    const nomeArquivo = reportUtil.nomeArquivoComData(`inventario-diferencas-${unidade}`);
    if (req.params.formato === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}.csv"`);
      return res.send(reportUtil.toCSV(colunas, linhas));
    }
    reportUtil.writePDF(res, {
      titulo: 'Inventário - Diferenças (ofensores)',
      subtitulo: `${INVENTARIO_UNIDADES_NOMES[unidade] || unidade} · ${reportUtil.fmtDataBR(inicio)} a ${reportUtil.fmtDataBR(fim)}`,
      colunas, linhas, nomeArquivo,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- Saltiverso Patteo (parque de trampolins): controle de entrada
// (check-ins) e reservas de festa. Duas secoes de checkin/painel (mesmo
// padrao entregas/entregas-lancamento) + uma secao de festas ----------

// tabela de precos (tempos contratados, PCD, desconto de aniversariante) -
// mesmo padrao de /api/festas/tabela: GET liberado pra quem opera o
// check-in, PUT (editar) so Master, ja que mexe direto no financeiro
app.get('/api/parque/tabela', requireAnySection('parque', 'parque-checkin'), async (req, res) => {
  res.json(await parque.getConfigPrecos());
});

app.put('/api/parque/tabela', auth.requireMaster, async (req, res) => {
  try {
    const tabela = await parque.salvarConfigPrecos(req.body);
    broadcast('parque-tabela-atualizada', {}, 'parque');
    broadcast('parque-tabela-atualizada', {}, 'parque-checkin');
    res.json(tabela);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/parque/checkins', requireSection('parque-checkin'), async (req, res) => {
  try {
    const { unidade, unidadeNome, responsavel, dataUtilizacao, tempoMinutos, timeInicial, horarioPrevisto, observacao, adultoCortesia, quantAC, criancas, usou, usarCreditoMin, metodoPagamento, pagamentos, meiasExtras, motivoCortesia, categoriaTempo } = req.body;
    if (!req.isMaster && !(req.permissions.unidades || []).includes(unidade)) {
      return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    }
    // credito de tempo guardado de um checkout antecipado anterior (ver
    // parque.checkout) - consome antes de criar, pra nao aplicar minutos
    // que na verdade nao estavam mais disponiveis
    let minutosExtras = 0;
    if (usarCreditoMin > 0) {
      minutosExtras = await parque.usarCredito(responsavel?.cpf, usarCreditoMin);
    }
    const registro = await parque.criar({
      unidade, unidadeNome, responsavel, dataUtilizacao, tempoMinutos, timeInicial, horarioPrevisto, observacao, adultoCortesia, quantAC, criancas, usou, minutosExtras, metodoPagamento, pagamentos, meiasExtras, motivoCortesia, categoriaTempo,
      colaboradorId: req.user.id, colaboradorNome: req.user.email,
      criadoPorId: req.user.id, criadoPorEmail: req.user.email,
    });
    broadcast('parque-checkin-criado', registro, 'parque');
    broadcast('parque-checkin-criado', registro, 'parque-checkin');
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/parque/checkins', requireAnySection('parque', 'parque-checkin'), async (req, res) => {
  if (req.isMaster) return res.json(await parque.listAll());
  res.json(await parque.listByUnidades(req.permissions.unidades || []));
});

// autopreenchimento do formulario de check-in: acha o cadastro mais recente
// com o mesmo CPF (de check-ins anteriores, inclusive os importados da
// planilha antiga) pra loja nao ter que digitar tudo de novo num cliente
// recorrente. "credito" (tempo guardado de um checkout antecipado - ver
// parque.checkout) vale pra qualquer unidade, independente do check-in
// anterior estar ou nao dentro do que esse usuario enxerga
app.get('/api/parque/cliente-por-cpf', requireAnySection('parque', 'parque-checkin'), async (req, res) => {
  const [encontrado, credito, visitaHojeBruta] = await Promise.all([
    parque.buscarPorCpf(req.query.cpf),
    parque.creditoPorCpf(req.query.cpf),
    parque.visitaHojePorCpf(req.query.cpf),
  ]);
  // visita de hoje (pro fluxo do Relançar) segue a mesma regra de unidade
  // do cadastro: so aparece se esse usuario enxerga a unidade dela
  const visitaHoje = (visitaHojeBruta && (req.isMaster || (req.permissions.unidades || []).includes(visitaHojeBruta.unidade)))
    ? visitaHojeBruta : null;
  if (!encontrado || (!req.isMaster && !(req.permissions.unidades || []).includes(encontrado.unidade))) {
    return res.json({ responsavel: null, credito, visitaHoje });
  }
  res.json({ responsavel: encontrado.responsavel, credito, visitaHoje });
});

// importacao unica (idempotente) dos dados historicos da planilha antiga -
// so o Master pode rodar, ja que reprocessa tudo de novo toda vez que e
// chamada (custa leituras/escritas no Firestore e uma chamada a API do
// Google Sheets)
app.post('/api/parque/importar-planilha', auth.requireMaster, async (req, res) => {
  try {
    const resultado = await saltiversoImport.importar();
    broadcast('parque-checkin-criado', { unidade: 'Saltiverso Patteo' }, 'parque');
    broadcast('festa-criada', { unidade: 'Saltiverso Patteo' }, 'festas');
    res.json(resultado);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/parque/checkins/:id/termo.pdf', requireAnySection('parque', 'parque-checkin'), async (req, res) => {
  const checkin = await parque.getOne(req.params.id);
  if (!checkin) return res.sendStatus(404);
  if (!req.isMaster && !(req.permissions.unidades || []).includes(checkin.unidade)) return res.sendStatus(404);
  termoResponsabilidade.gerarTermoPDF(res, checkin);
});

app.patch('/api/parque/checkins/:id', requireAnySection('parque', 'parque-checkin'), async (req, res) => {
  try {
    const atual = await parque.getOne(req.params.id);
    if (!atual) return res.status(404).json({ error: 'Check-in não encontrado.' });
    if (!req.isMaster && !(req.permissions.unidades || []).includes(atual.unidade)) {
      return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    }
    // qualquer um com acesso pode marcar o termo como assinado (operacao de
    // balcao); demais campos (editar cadastro) seguem liberados do mesmo jeito
    const registro = await parque.atualizar(req.params.id, req.body);
    broadcast('parque-checkin-atualizado', registro, 'parque');
    broadcast('parque-checkin-atualizado', registro, 'parque-checkin');
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// aciona o relogio: o horario que conta pra pulseira/tempo contratado e o
// do check-in fisico, nao o do cadastro/pagamento (que pode ter acontecido
// minutos ou horas antes)
app.post('/api/parque/checkins/:id/checkin', requireAnySection('parque', 'parque-checkin'), async (req, res) => {
  try {
    const atual = await parque.getOne(req.params.id);
    if (!atual) return res.status(404).json({ error: 'Check-in não encontrado.' });
    if (!req.isMaster && !(req.permissions.unidades || []).includes(atual.unidade)) {
      return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    }
    const registro = await parque.checkin(req.params.id);
    broadcast('parque-checkin-atualizado', registro, 'parque');
    broadcast('parque-checkin-atualizado', registro, 'parque-checkin');
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// cortesia (alcada dupla): Gerente da unidade aprova/nega no 1o nivel
// (aprovacao libera a entrada mas o card segue aberto pro Master); o Master
// da a palavra final - aprovando (encerra) ou rejeitando a justificativa
// (escala pro Admin responsavel MV encerrar com parecer)
app.post('/api/parque/checkins/:id/cortesia/decidir', requireAnySection('parque', 'parque-checkin'), async (req, res) => {
  try {
    const atual = await parque.getOne(req.params.id);
    if (!atual) return res.status(404).json({ error: 'Check-in não encontrado.' });
    const ehGerente = req.user && users.ehCargoGerente(req.user.cargo) && !req.isMaster
      && (req.permissions?.unidades || []).includes(atual.unidade);
    if (!req.isMaster && !ehGerente) {
      return res.status(403).json({ error: 'Só o Gerente da unidade ou o Master decide uma cortesia.' });
    }
    const registro = await parque.decidirCortesia(req.params.id, {
      nivel: req.isMaster ? 'master' : 'gerente',
      aprovado: req.body.aprovado === true,
      motivo: req.body.motivo,
      porEmail: req.user.email,
    });
    broadcast('parque-checkin-atualizado', registro, 'parque');
    broadcast('parque-checkin-atualizado', registro, 'parque-checkin');
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/parque/checkins/:id/cortesia/encerrar', requireAnySection('parque', 'parque-checkin'), async (req, res) => {
  try {
    if (!parque.ehAdminCortesia(req.user)) {
      return res.status(403).json({ error: 'Só o Admin responsável (MV) encerra uma cortesia escalada.' });
    }
    const registro = await parque.encerrarCortesia(req.params.id, { porEmail: req.user.email, parecer: req.body.parecer });
    broadcast('parque-checkin-atualizado', registro, 'parque');
    broadcast('parque-checkin-atualizado', registro, 'parque-checkin');
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// compra de tempo extra durante a vigencia: estende o timeFinal e soma o
// valor do tempo adicional (tabela x criancas) - meias nao sao cobradas de
// novo (ja estao com as do check-in original)
app.post('/api/parque/checkins/:id/adicionar-tempo', requireAnySection('parque', 'parque-checkin'), async (req, res) => {
  try {
    const atual = await parque.getOne(req.params.id);
    if (!atual) return res.status(404).json({ error: 'Check-in não encontrado.' });
    if (!req.isMaster && !(req.permissions.unidades || []).includes(atual.unidade)) {
      return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    }
    const registro = await parque.adicionarTempo(req.params.id, {
      minutos: req.body.minutos,
      metodoPagamento: req.body.metodoPagamento,
      porEmail: req.user.email,
    });
    broadcast('parque-checkin-atualizado', registro, 'parque');
    broadcast('parque-checkin-atualizado', registro, 'parque-checkin');
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// o tempo ja acabou mas ainda e o MESMO dia e a familia quer voltar: cria
// uma nova compra copiando os dados/criancas e reaproveitando o Termo
// assinado da compra anterior (sem meias - ja estao com elas)
app.post('/api/parque/checkins/:id/relancar', requireSection('parque-checkin'), async (req, res) => {
  try {
    const origem = await parque.getOne(req.params.id);
    if (!origem) return res.status(404).json({ error: 'Check-in não encontrado.' });
    if (!req.isMaster && !(req.permissions.unidades || []).includes(origem.unidade)) {
      return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    }
    const registro = await parque.relancar(req.params.id, {
      tempoMinutos: req.body.tempoMinutos,
      metodoPagamento: req.body.metodoPagamento,
      horarioPrevisto: req.body.horarioPrevisto,
      criadoPorId: req.user.id,
      criadoPorEmail: req.user.email,
    });
    broadcast('parque-checkin-criado', registro, 'parque');
    broadcast('parque-checkin-criado', registro, 'parque-checkin');
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// checkout antecipado (emergencia): a familia precisa sair antes do tempo
// contratado acabar - para o relogio agora. O credito so vira de verdade
// quando um Gerente da unidade (ou Master/Admin) aprova - ver
// podeAprovarCheckoutParque/rota de aprovar-checkout abaixo
app.post('/api/parque/checkins/:id/checkout', requireAnySection('parque', 'parque-checkin'), async (req, res) => {
  try {
    const atual = await parque.getOne(req.params.id);
    if (!atual) return res.status(404).json({ error: 'Check-in não encontrado.' });
    if (!req.isMaster && !(req.permissions.unidades || []).includes(atual.unidade)) {
      return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    }
    const registro = await parque.checkout(req.params.id, { motivo: req.body.motivo });
    broadcast('parque-checkin-atualizado', registro, 'parque');
    broadcast('parque-checkin-atualizado', registro, 'parque-checkin');
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// so um Gerente da PROPRIA unidade (tag de cargo, ver users.js) ou
// Master/Admin pode confirmar um check-out antecipado - e essa aprovacao
// que efetivamente gera o credito de tempo (ver parque.aprovarCheckout)
function podeAprovarCheckoutParque(req, unidade) {
  if (req.isMaster || req.isAdmin) return true;
  if (!req.user || !users.ehCargoGerente(req.user.cargo)) return false;
  return (req.permissions?.unidades || []).includes(unidade);
}

app.post('/api/parque/checkins/:id/aprovar-checkout', requireAnySection('parque', 'parque-checkin'), async (req, res) => {
  try {
    const atual = await parque.getOne(req.params.id);
    if (!atual) return res.status(404).json({ error: 'Check-in não encontrado.' });
    if (!podeAprovarCheckoutParque(req, atual.unidade)) {
      return res.status(403).json({ error: 'Só um Gerente da unidade (ou Master/Admin) pode aprovar o check-out.' });
    }
    const registro = await parque.aprovarCheckout(req.params.id, { aprovadoPorEmail: req.user.email });
    broadcast('parque-checkin-atualizado', registro, 'parque');
    broadcast('parque-checkin-atualizado', registro, 'parque-checkin');
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// desfaz um check-out ainda pendente (a crianca voltou a brincar) - retoma
// o relogio com o tempo que sobrava, sem gerar credito nenhum
app.post('/api/parque/checkins/:id/retomar-checkout', requireAnySection('parque', 'parque-checkin'), async (req, res) => {
  try {
    const atual = await parque.getOne(req.params.id);
    if (!atual) return res.status(404).json({ error: 'Check-in não encontrado.' });
    if (!req.isMaster && !(req.permissions.unidades || []).includes(atual.unidade)) {
      return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    }
    const registro = await parque.retomarCheckout(req.params.id);
    broadcast('parque-checkin-atualizado', registro, 'parque');
    broadcast('parque-checkin-atualizado', registro, 'parque-checkin');
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// resumo legivel de um check-in do parque / de uma proposta de alteracao,
// pro texto do Ticket de correcao (o Master le tudo na Central)
function resumoCheckinParque(c) {
  const criancas = (c.criancas || []).map((cr) => cr.nome).join(', ') || '—';
  return `${c.responsavel?.nome || '—'} · ${reportUtil.fmtDataBR(c.dataUtilizacao)} · ${c.tempoMinutos}min · ${reportUtil.fmtMoneyBR(parque.valorDoCheckin(c))} (${c.metodoPagamento || 'sem método'}) · previsto ${(c.horarioPrevisto || '').slice(0, 5) || '—'} · A.C. ${c.adultoCortesia ? 'x' + (c.quantAC || 1) : 'não'} · crianças: ${criancas}${c.observacao ? ' · obs: ' + c.observacao : ''}`;
}
function resumoPropostaParque(p) {
  const partes = [];
  if (p.responsavel?.nome !== undefined) partes.push(`nome → ${p.responsavel.nome}`);
  if (p.responsavel?.contato !== undefined) partes.push(`contato → ${p.responsavel.contato || '—'}`);
  if (p.dataUtilizacao !== undefined) partes.push(`data → ${reportUtil.fmtDataBR(p.dataUtilizacao)}`);
  if (p.tempoMinutos !== undefined) partes.push(`tempo → ${p.tempoMinutos}min`);
  if (p.horarioPrevisto !== undefined) partes.push(`previsto → ${(p.horarioPrevisto || '').slice(0, 5) || '—'}`);
  if (p.metodoPagamento !== undefined) partes.push(`método → ${p.metodoPagamento || '—'}`);
  if (p.adultoCortesia !== undefined) partes.push(`A.C. → ${p.adultoCortesia ? 'x' + (p.quantAC || 1) : 'não'}`);
  if (p.criancas !== undefined) partes.push(`crianças → ${p.criancas.map((cr) => cr.nome).join(', ')}`);
  if (p.observacao !== undefined) partes.push(`obs → ${p.observacao || '—'}`);
  return partes.join(' · ') || '—';
}

// depois de enviado, um check-in nao pode mais ser mexido direto - correcao
// (alterar dados/criancas ou excluir) vira um pedido que o Gerente da
// unidade ou o Master/Admin aprova, mesmo fluxo do fechamento de caixa e do
// Abastecimento. Todo pedido tambem abre um Ticket na Central: mesmo quando
// o Gerente aprova pra agilizar, ele presta contas e o Master da a palavra
// final concluindo o ticket. Sem push - Master/Admin nao recebem
// notificacao dessas correcoes, veem na Central quando abrirem
app.post('/api/parque/checkins/:id/solicitar-edicao', requireAnySection('parque', 'parque-checkin'), async (req, res) => {
  try {
    const atual = await parque.getOne(req.params.id);
    if (!atual) return res.status(404).json({ error: 'Check-in não encontrado.' });
    if (!req.isMaster && !(req.permissions.unidades || []).includes(atual.unidade)) {
      return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    }
    // valida tudo ANTES de abrir o ticket, pra nao criar ticket orfao se o
    // pedido em si for recusado (proposta invalida, pendencia duplicada...)
    const motivo = String(req.body.motivo || '').trim();
    if (!motivo) return res.status(400).json({ error: 'Descreva o motivo da correção.' });
    const jaPendente = (await parque.listarEdicoes()).some((p) => p.checkinId === req.params.id && p.status === 'PENDENTE');
    if (jaPendente) return res.status(400).json({ error: 'Já existe um pedido de correção pendente para esse check-in.' });
    const tipoCorrecao = req.body.tipoCorrecao === 'alterar' ? 'alterar' : 'excluir';
    const proposta = tipoCorrecao === 'alterar' ? parque.validarPropostaEdicao(req.body.proposta) : null;
    const propostaTxt = tipoCorrecao === 'excluir' ? 'EXCLUIR o check-in inteiro' : resumoPropostaParque(proposta);
    const ticket = await solicitacoes.create({
      tipo: 'suporte-ti',
      unidade: atual.unidade,
      unidadeNome: atual.unidadeNome || atual.unidade,
      titulo: `Parque: correção solicitada (${atual.responsavel?.nome || 'check-in'} · ${reportUtil.fmtDataBR(atual.dataUtilizacao)})`,
      observacao: `Correção pedida por ${req.user.username || req.user.email}.\n\nCadastrado: ${resumoCheckinParque(atual)}\nProposta: ${propostaTxt}\n\nJustificativa: ${motivo}\n\nO Gerente da unidade pode aprovar/rejeitar na tela do Parque pra agilizar; a palavra final (prestação de contas) é do Master, concluindo este ticket.`,
      prioridade: 'alta',
      criadoPorId: req.user.id,
      criadoPorEmail: req.user.email,
      direcionadoParaId: null,
      direcionadoParaEmail: null,
    });
    broadcast('solicitacao-criada', ticket, 'solicitacoes');
    const pedido = await parque.solicitarEdicao({
      checkinId: req.params.id,
      tipoCorrecao,
      proposta,
      motivo,
      numeroTicket: ticket.numeroTicket,
      ticketId: ticket.id,
      solicitadoPorId: req.user.id,
      solicitadoPorEmail: req.user.email,
    });
    broadcast('parque-edicao-solicitada', pedido, 'parque');
    res.json(pedido);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/parque/checkins/edicoes', requireSection('parque'), async (req, res) => {
  const todas = await parque.listarEdicoes();
  if (req.isMaster || req.isAdmin) return res.json(todas);
  // Gerente ve os pedidos das unidades dele (pra poder decidir); os demais
  // acompanham so os proprios pedidos
  if (req.user && users.ehCargoGerente(req.user.cargo)) {
    const unidades = req.permissions?.unidades || [];
    return res.json(todas.filter((p) => unidades.includes(p.unidade) || p.solicitadoPorId === req.user.id));
  }
  res.json(todas.filter((p) => p.solicitadoPorId === req.user.id));
});

// decidir a correcao: Gerente da PROPRIA unidade ou Master/Admin (mesma
// regra do check-out antecipado - ver podeAprovarCheckoutParque). Aprovar
// aplica a mudanca na hora (alterar aplica a proposta, excluir remove o
// registro); quando quem decidiu foi o Gerente, a decisao fica registrada
// no Ticket pro Master dar a palavra final (prestacao de contas)
app.patch('/api/parque/checkins/edicoes/:id', requireAnySection('parque', 'parque-checkin'), async (req, res) => {
  try {
    const pedidoAtual = (await parque.listarEdicoes()).find((p) => p.id === req.params.id);
    if (!pedidoAtual) return res.status(404).json({ error: 'Pedido não encontrado.' });
    if (!podeAprovarCheckoutParque(req, pedidoAtual.unidade)) {
      return res.status(403).json({ error: 'Só um Gerente da unidade (ou Master/Admin) pode decidir a correção.' });
    }
    const decididoPorGerente = !(req.isMaster || req.isAdmin);
    const pedido = await parque.decidirEdicao(req.params.id, req.body.status, {
      decididoPorEmail: req.user.email,
      motivoDecisao: req.body.motivoDecisao,
      decididoPorGerente,
    });
    broadcast('parque-edicao-decidida', pedido, 'parque');
    if (pedido.status === 'APROVADO' && pedido.tipoCorrecao === 'alterar' && pedido.checkinAtualizado) {
      broadcast('parque-checkin-atualizado', pedido.checkinAtualizado, 'parque');
      broadcast('parque-checkin-atualizado', pedido.checkinAtualizado, 'parque-checkin');
    } else if (pedido.status === 'APROVADO' && pedido.tipoCorrecao !== 'alterar') {
      broadcast('parque-checkin-excluido', { id: pedido.checkinId }, 'parque');
      broadcast('parque-checkin-excluido', { id: pedido.checkinId }, 'parque-checkin');
    }
    // prestacao de contas no ticket: registra quem decidiu e o que mudou,
    // pro Master revisar e concluir (nao notifica ninguem por push)
    if (pedido.ticketId) {
      try {
        const t = await solicitacoes.getOne(pedido.ticketId);
        if (t) {
          const quando = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
          const quem = decididoPorGerente ? `Gerente ${req.user.username || req.user.email}` : (req.user.username || req.user.email);
          const nota = `[Decisão] ${pedido.status} por ${quem} em ${quando}${req.body.motivoDecisao ? ' — ' + String(req.body.motivoDecisao).slice(0, 300) : ''}.${decididoPorGerente ? ' Aguardando a palavra final do Master (concluir este ticket).' : ''}`;
          await solicitacoes.update(pedido.ticketId, { observacao: `${t.observacao || ''}\n\n${nota}` });
        }
      } catch (e) {
        console.error('Falha ao registrar decisão no ticket do parque:', e.message);
      }
    }
    res.json(pedido);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/parque/relatorio.:formato(csv|pdf)', requireSection('parque'), async (req, res) => {
  const lista = req.isMaster ? await parque.listAll() : await parque.listByUnidades(req.permissions.unidades || []);
  const colunas = [
    { key: 'unidade', label: 'Unidade' }, { key: 'responsavel', label: 'Responsável' }, { key: 'contato', label: 'Contato' },
    { key: 'data', label: 'Data' }, { key: 'horario', label: 'Horário' }, { key: 'criancas', label: 'Crianças' },
    { key: 'ac', label: 'A.C.' }, { key: 'checkin', label: 'Check-in' }, { key: 'termo', label: 'Termo assinado' },
  ];
  const linhas = lista.map((c) => ({
    unidade: c.unidadeNome || c.unidade,
    responsavel: c.responsavel?.nome,
    contato: c.responsavel?.contato,
    data: reportUtil.fmtDataBR(c.dataUtilizacao),
    horario: c.iniciado ? `${(c.timeInicial || '').slice(0, 5)} às ${(c.timeFinal || '').slice(0, 5)}` : '—',
    criancas: (c.criancas || []).map((cr) => cr.nome).join(', '),
    ac: c.adultoCortesia ? `Sim (${c.quantAC})` : 'Não',
    checkin: c.iniciado ? 'Feito' : 'Aguardando',
    termo: c.termoAssinado ? 'Sim' : 'Não',
  }));
  const nomeArquivo = reportUtil.nomeArquivoComData('parque-checkins');
  if (req.params.formato === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}.csv"`);
    return res.send(reportUtil.toCSV(colunas, linhas));
  }
  reportUtil.writePDF(res, { titulo: 'Saltiverso - Check-ins do Parque', subtitulo: `Exportado em ${reportUtil.agoraBrasiliaFmt()} · ${linhas.length} check-in(s)`, colunas, linhas, nomeArquivo });
});

// relatorio FINANCEIRO das entradas do parque: cada registro com valor
// (tabela por pulseira: 30min=R$40, 60min=R$50, demais combinam os blocos)
// e a forma de pagamento. Financeiro e assunto de gestao: Master/Admin veem
// tudo, Gerente ve as unidades dele; os demais nao acessam
const METODOS_PARQUE_LABEL = { dinheiro: 'Dinheiro', pix: 'Pix', debito: 'Débito', credito: 'Crédito', cortesia: 'Cortesia', misto: 'Múltiplas formas' };
app.get('/api/parque/financeiro.:formato(csv|pdf)', requireSection('parque'), async (req, res) => {
  const ehGestor = req.isMaster || req.isAdmin || (req.user && users.ehCargoGerente(req.user.cargo));
  if (!ehGestor) return res.status(403).json({ error: 'Só o Gerente da unidade ou o Master/Admin acessam o financeiro.' });
  let lista = (req.isMaster || req.isAdmin) ? await parque.listAll() : await parque.listByUnidades(req.permissions.unidades || []);
  const { unidade, inicio, fim } = req.query;
  lista = lista
    .filter((c) => (!unidade || c.unidade === unidade) && (!inicio || c.dataUtilizacao >= inicio) && (!fim || c.dataUtilizacao <= fim))
    .sort((a, b) => (b.dataUtilizacao + (b.timeInicial || '')).localeCompare(a.dataUtilizacao + (a.timeInicial || '')));
  const colunas = [
    { key: 'data', label: 'Data' }, { key: 'responsavel', label: 'Responsável' }, { key: 'tempo', label: 'Tempo' },
    { key: 'pulseiras', label: 'Pulseiras' }, { key: 'valorPulseira', label: 'Valor/pulseira' }, { key: 'meias', label: 'Meias' },
    { key: 'valor', label: 'Valor total' },
    { key: 'metodo', label: 'Método' }, { key: 'checkin', label: 'Check-in' },
  ];
  const porMetodo = {};
  let total = 0;
  const linhas = lista.map((c) => {
    const valor = parque.valorDoCheckin(c);
    // dividido entre mais de uma forma (ver pagamentos em parque.js): o
    // resumo por metodo reflete o valor de CADA forma, nao o total inteiro
    // debaixo de um rotulo generico - assim dinheiro x cartao bate certo
    const temSplit = Array.isArray(c.pagamentos) && c.pagamentos.length > 0;
    const metodo = temSplit
      ? c.pagamentos.map((p) => METODOS_PARQUE_LABEL[p.forma] || p.forma).join(' + ')
      : (METODOS_PARQUE_LABEL[c.metodoPagamento] || 'sem método');
    total += valor;
    if (temSplit) {
      for (const p of c.pagamentos) {
        const label = METODOS_PARQUE_LABEL[p.forma] || p.forma;
        porMetodo[label] = (porMetodo[label] || 0) + p.valor;
      }
    } else {
      porMetodo[metodo] = (porMetodo[metodo] || 0) + valor;
    }
    return {
      data: reportUtil.fmtDataBR(c.dataUtilizacao),
      responsavel: c.responsavel?.nome,
      tempo: `${c.tempoMinutos}min${c.minutosAdicionados ? ` +${c.minutosAdicionados}min` : ''}`,
      pulseiras: (c.criancas || []).length || c.pulseiras || 0,
      valorPulseira: reportUtil.fmtMoneyBR(c.valorPulseira != null ? c.valorPulseira : parque.valorPorTempo(c.tempoMinutos)),
      meias: c.valorMeias ? reportUtil.fmtMoneyBR(c.valorMeias) : '—',
      valor: reportUtil.fmtMoneyBR(valor),
      metodo,
      checkin: c.iniciado ? 'Feito' : 'Aguardando',
    };
  });
  const resumoMetodos = Object.entries(porMetodo).map(([m, v]) => `${m} ${reportUtil.fmtMoneyBR(v)}`).join(' · ');
  const nomeArquivo = reportUtil.nomeArquivoComData('parque-financeiro');
  if (req.params.formato === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}.csv"`);
    return res.send(reportUtil.toCSV(colunas, linhas));
  }
  reportUtil.writePDF(res, {
    titulo: 'Saltiverso - Financeiro das Entradas',
    subtitulo: `Exportado em ${reportUtil.agoraBrasiliaFmt()} · ${linhas.length} entrada(s) · Total ${reportUtil.fmtMoneyBR(total)}${resumoMetodos ? ' · ' + resumoMetodos : ''}`,
    colunas, linhas, nomeArquivo,
  });
});

// ---------- Saltiverso Patteo: reservas de festa ----------
// tabela oficial de preços (Missão x horas x saltonautas) - editável pelo
// Master direto em festas.html, sem precisar de deploy toda vez que a
// promoção muda (ver festas.getTabela/salvarTabela)
app.get('/api/festas/tabela', requireSection('festas'), async (req, res) => {
  res.json(await festas.getTabela());
});

app.put('/api/festas/tabela', auth.requireMaster, async (req, res) => {
  try {
    const tabela = await festas.salvarTabela(req.body);
    broadcast('festas-tabela-atualizada', {}, 'festas');
    res.json(tabela);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/festas', requireSection('festas'), async (req, res) => {
  try {
    const { unidade, cliente, dataVenda, dataDeUso, horaInicio, horaFim, missao, horas, saltonautas, valorTotal, desconto, sinal, restante, observacao, referenciaVendaOriginal } = req.body;
    if (!req.isMaster && !(req.permissions.unidades || []).includes(unidade)) {
      return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    }
    const registro = await festas.criar({
      unidade, cliente, dataVenda, dataDeUso, horaInicio, horaFim, missao, horas, saltonautas, valorTotal, desconto, sinal, restante, observacao, referenciaVendaOriginal,
      criadoPorId: req.user.id, criadoPorEmail: req.user.email,
    });
    broadcast('festa-criada', registro, 'festas');
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/festas', requireSection('festas'), async (req, res) => {
  if (req.isMaster) return res.json(await festas.listAll());
  res.json(await festas.listByUnidades(req.permissions.unidades || []));
});

app.patch('/api/festas/:id', requireSection('festas'), async (req, res) => {
  try {
    const atual = await festas.getOne(req.params.id);
    if (!atual) return res.status(404).json({ error: 'Reserva não encontrada.' });
    if (!req.isMaster && !(req.permissions.unidades || []).includes(atual.unidade)) {
      return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    }
    const registro = await festas.atualizar(req.params.id, req.body);
    broadcast('festa-atualizada', registro, 'festas');
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/festas/:id', auth.requireMaster, async (req, res) => {
  try {
    await festas.remover(req.params.id);
    broadcast('festa-excluida', { id: req.params.id }, 'festas');
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// recebimento pos-venda das festas (pagamentos parciais): so Gerente da
// PROPRIA unidade ou Master/Admin. Fluxo antifraude em 2 passos: reabrir
// (auditado) -> lancar o complemento (append-only, nunca editavel); o
// status vira 'pago' quando cobre o total, senao 'pagamento-parcial'
function podeReceberFesta(req, unidade) {
  if (req.isMaster || req.isAdmin) return true;
  return req.user && users.ehCargoGerente(req.user.cargo) && (req.permissions.unidades || []).includes(unidade);
}

app.post('/api/festas/:id/reabrir-pagamento', requireSection('festas'), async (req, res) => {
  try {
    const atual = await festas.getOne(req.params.id);
    if (!atual) return res.status(404).json({ error: 'Reserva não encontrada.' });
    if (!podeReceberFesta(req, atual.unidade)) {
      return res.status(403).json({ error: 'Só o Gerente da unidade ou o Master/Admin pode reabrir o recebimento.' });
    }
    const registro = await festas.reabrirPagamento(req.params.id, { porEmail: req.user.email });
    broadcast('festa-atualizada', registro, 'festas');
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/festas/:id/recebimentos', requireSection('festas'), async (req, res) => {
  try {
    const atual = await festas.getOne(req.params.id);
    if (!atual) return res.status(404).json({ error: 'Reserva não encontrada.' });
    if (!podeReceberFesta(req, atual.unidade)) {
      return res.status(403).json({ error: 'Só o Gerente da unidade ou o Master/Admin pode lançar recebimento.' });
    }
    const registro = await festas.registrarRecebimento(req.params.id, {
      valor: req.body.valor, forma: req.body.forma, data: req.body.data, porEmail: req.user.email,
    });
    broadcast('festa-atualizada', registro, 'festas');
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/festas/relatorio.:formato(csv|pdf)', requireSection('festas'), async (req, res) => {
  const lista = req.isMaster ? await festas.listAll() : await festas.listByUnidades(req.permissions.unidades || []);
  const colunas = [
    { key: 'codigo', label: 'Código' }, { key: 'unidade', label: 'Unidade' }, { key: 'cliente', label: 'Cliente' },
    { key: 'dataDeUso', label: 'Data do evento' }, { key: 'valorTotal', label: 'Valor total' },
    { key: 'recebido', label: 'Recebido' }, { key: 'devido', label: 'Restante devido' },
    { key: 'status', label: 'Status' }, { key: 'utilizado', label: 'Utilizado' },
  ];
  const linhas = lista.map((f) => ({
    codigo: f.codigo, unidade: f.unidade, cliente: f.cliente?.nome,
    dataDeUso: reportUtil.fmtDataBR(f.dataDeUso), valorTotal: reportUtil.fmtMoneyBR(f.valorTotal),
    recebido: reportUtil.fmtMoneyBR(festas.totalRecebido(f)), devido: reportUtil.fmtMoneyBR(festas.restanteDevido(f)),
    status: f.status, utilizado: f.utilizado ? 'Sim' : 'Não',
  }));
  const nomeArquivo = reportUtil.nomeArquivoComData('festas');
  if (req.params.formato === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}.csv"`);
    return res.send(reportUtil.toCSV(colunas, linhas));
  }
  reportUtil.writePDF(res, { titulo: 'Saltiverso - Reservas de Festa', subtitulo: `Exportado em ${reportUtil.agoraBrasiliaFmt()} · ${linhas.length} reserva(s)`, colunas, linhas, nomeArquivo });
});

// ---------- RH: ficha de funcionarios (extras e efetivos), independente de
// login no Zenith - cadastro no 1o dia (nome/contato/curriculo), acompanha-
// mento de teste com alerta automatico no 5o dia (ver rodarAlertaTesteRh
// mais abaixo) e aniversariante do dia (calculado no front sobre a mesma
// lista, ver rh.aniversariantesHoje) ----------
// Master, Admin (visao corporativa, igual ja usado em festas/parque) OU a
// tag dedicada "RH (todas as unidades)" (podeRhTodasUnidades, atribuida pelo
// Master em Usuarios sem precisar dar Admin pra pessoa) - e o jeito do time
// de RH central cadastrar/decidir candidatos de qualquer unidade do grupo
function podeAcessarUnidadeRh(req, unidade) {
  return req.isMaster || req.isAdmin || req.podeRhTodasUnidades || (req.permissions.unidades || []).includes(unidade);
}

// so Master/Admin ou quem tem a tag "RH: pode cadastrar efetivado direto"
// (podeRhCadastrarEfetivado) pode cadastrar alguem ja como "efetivado" -
// contratacao direta, sem passar pelo teste de 5 dias. A loja (gerente
// comum, so com a secao 'rh') continua liberada pra Extra e Candidato
// (teste), mas nao pode pular direto pra efetivado - so o RH de verdade
function podeCadastrarEfetivado(req) {
  return req.isMaster || req.isAdmin || req.podeRhCadastrarEfetivado;
}

// aprovacao de pendencias do RH (check-in de extra alem do limite semanal,
// candidato com teste vencido sem decisao, advertencia) -so o time de RH de
// verdade (tag "RH todas as unidades"), Admin ou Master, NUNCA a loja comum
// (que e justamente quem gerou/deixou passar a pendencia)
function podeAprovarRh(req) {
  return req.isMaster || req.isAdmin || req.podeRhTodasUnidades;
}

// cadastro feito por quem NAO e Master/Admin/RH de verdade (secao 'rh') fica
// "pendente_aprovacao" ate alguem que pode aprovar decidir (ver
// podeAprovarRh). Hoje, como a rota interna abaixo ja exige a secao 'rh',
// isso so acontece de fato pelo link publico (cadastradoPorId null, sem
// usuario logado) - mas calculamos de forma generica pensando que a tag
// 'rh' vai ficar restrita a quem trabalha no RH de verdade, e o gerente da
// loja vai passar a usar so o link publico
function precisaAprovacaoCadastro(req) {
  if (!req || !req.user) return true;
  return !(req.isMaster || req.isAdmin || auth.hasSection(req, 'rh'));
}

app.post('/api/rh/funcionarios', requireSection('rh'), upload.single('curriculo'), async (req, res) => {
  try {
    const { unidade, nome, contato, cargoFuncao, dataNascimento, dataAdmissao, tipoCadastro } = req.body;
    // "1" ou "true" vindo de multipart/form-data (checkbox HTML manda string)
    const semExperiencia = req.body.semExperiencia === 'true' || req.body.semExperiencia === '1' || req.body.semExperiencia === true;
    if (!podeAcessarUnidadeRh(req, unidade)) {
      return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    }
    if (tipoCadastro === 'efetivado' && !podeCadastrarEfetivado(req)) {
      return res.status(403).json({ error: 'Só o RH pode cadastrar alguém já efetivado direto. Cadastre como Extra ou Candidato (teste de 5 dias).' });
    }
    let curriculo = null;
    if (req.file) {
      const path = await storage.salvarArquivo(unidade || 'geral', req.file, 'rh-curriculos');
      curriculo = { path, nomeOriginal: req.file.originalname, tipo: req.file.mimetype };
    }
    const registro = await rh.criar({
      unidade, nome, contato, cargoFuncao, dataNascimento, dataAdmissao, tipoCadastro, semExperiencia,
      curriculo, cadastradoPorId: req.user.id, cadastradoPorEmail: req.user.email,
      precisaAprovacao: precisaAprovacaoCadastro(req),
    });
    broadcast('rh-funcionario-criado', registro, 'rh');
    if (registro.status === 'pendente_aprovacao') {
      push.notifyRhCadastroPendente(registro.nome, registro.unidade);
    }
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// backfill em lote (Master) - cadastra varias pessoas de uma vez ja como
// efetivado, cada uma na etapa/prazo de experiencia informados; usado
// quando um grupo de gente que ja trabalha ha tempo nunca foi cadastrada
// no RH (ex: planilha de RH externa sendo migrada pro Zenith)
app.post('/api/rh/funcionarios/importar-lote', auth.requireMaster, async (req, res) => {
  try {
    const linhas = Array.isArray(req.body.linhas) ? req.body.linhas : [];
    if (!linhas.length) return res.status(400).json({ error: 'Nenhuma linha pra importar.' });
    const resultados = await rh.importarLote(linhas, { porEmail: req.user.email });
    resultados.forEach((r) => { if (r.ok) broadcast('rh-funcionario-criado', { id: r.id }, 'rh'); });
    res.json(resultados);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// limpeza pontual de cadastros duplicados (mesmo nome, mesma loja) que
// existiam antes da trava em rh.criar() - idempotente, sem duplicados
// sobrando nao faz nada; ver rh.mesclarDuplicados pro criterio de qual ficha
// fica (a que tem check-in fechado) e qual sai
app.post('/api/rh/funcionarios/mesclar-duplicados', auth.requireMaster, async (req, res) => {
  try {
    const relatorio = await rh.mesclarDuplicados(rhCheckin);
    if (relatorio.length) broadcast('rh-funcionario-atualizado', {}, 'rh');
    res.json(relatorio);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/rh/funcionarios', requireSection('rh'), async (req, res) => {
  if (req.isMaster || req.isAdmin || req.podeRhTodasUnidades) return res.json(await rh.listAll());
  res.json(await rh.listByUnidades(req.permissions.unidades || []));
});

app.patch('/api/rh/funcionarios/:id', auth.requireMaster, async (req, res) => {
  try {
    const atual = await rh.getOne(req.params.id);
    if (!atual) return res.status(404).json({ error: 'Funcionário não encontrado.' });
    if (!podeAcessarUnidadeRh(req, atual.unidade)) {
      return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    }
    const patch = { ...req.body };
    const registro = await rh.atualizar(req.params.id, patch);
    broadcast('rh-funcionario-atualizado', registro, 'rh');
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// regenera o token do link de auto-atendimento (rh-colaborador.html) - pra
// usar se o link vazar/for parar em grupo errado: quem tinha o link antigo
// perde o acesso na hora, o gerente manda o novo pro colaborador
app.post('/api/rh/funcionarios/:id/regenerar-link', requireSection('rh'), async (req, res) => {
  try {
    const atual = await rh.getOne(req.params.id);
    if (!atual) return res.status(404).json({ error: 'Funcionário não encontrado.' });
    if (!podeAcessarUnidadeRh(req, atual.unidade)) {
      return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    }
    const registro = await rh.regenerarLink(req.params.id);
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// cadastros feitos pela loja ou pelo link publico que ficaram
// "pendente_aprovacao" (ver precisaAprovacaoCadastro acima) - so quem pode
// aprovar (RH todas-unidades/Admin/Master) ve e decide
app.get('/api/rh/funcionarios/pendentes-aprovacao-cadastro', requireSection('rh'), async (req, res) => {
  if (!podeAprovarRh(req)) return res.json([]);
  res.json(await rh.listPendentesAprovacaoCadastro());
});

app.post('/api/rh/funcionarios/:id/aprovar-cadastro', requireSection('rh'), async (req, res) => {
  try {
    if (!podeAprovarRh(req)) return res.status(403).json({ error: 'Só o RH, o Admin ou o Master podem aprovar.' });
    const registro = await rh.aprovarCadastro(req.params.id, { porEmail: req.user.email });
    broadcast('rh-funcionario-atualizado', registro, 'rh');
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/rh/funcionarios/:id/reprovar-cadastro', requireSection('rh'), async (req, res) => {
  try {
    if (!podeAprovarRh(req)) return res.status(403).json({ error: 'Só o RH, o Admin ou o Master podem recusar.' });
    const registro = await rh.reprovarCadastro(req.params.id, { porEmail: req.user.email, motivo: req.body.motivo });
    broadcast('rh-funcionario-atualizado', registro, 'rh');
    push.notifyRhCadastroReprovado(registro.nome, registro.unidade, registro.aprovacaoCadastro && registro.aprovacaoCadastro.motivo);
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/rh/funcionarios/:id/decisao-teste', requireSection('rh'), async (req, res) => {
  try {
    const atual = await rh.getOne(req.params.id);
    if (!atual) return res.status(404).json({ error: 'Funcionário não encontrado.' });
    if (!podeAcessarUnidadeRh(req, atual.unidade)) {
      return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    }
    const registro = await rh.registrarDecisaoTeste(req.params.id, {
      decisao: req.body.decisao, observacao: req.body.observacao, porEmail: req.user.email,
    });
    broadcast('rh-funcionario-atualizado', registro, 'rh');
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// decisao da etapa de experiencia formal (CLT, 30 ou 60 dias) - renovar
// (so na etapa de 30, abre a de 60)/efetivar/desligar (ver
// registrarDecisaoExperiencia em rh.js)
app.post('/api/rh/funcionarios/:id/decisao-experiencia', requireSection('rh'), async (req, res) => {
  try {
    const atual = await rh.getOne(req.params.id);
    if (!atual) return res.status(404).json({ error: 'Funcionário não encontrado.' });
    if (!podeAcessarUnidadeRh(req, atual.unidade)) {
      return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    }
    const registro = await rh.registrarDecisaoExperiencia(req.params.id, {
      decisao: req.body.decisao, observacao: req.body.observacao, porEmail: req.user.email,
    });
    broadcast('rh-funcionario-atualizado', registro, 'rh');
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ajuste manual (Master) do estagio de experiencia - so pra backfill/
// correcao (ex: colaborador que ja estava em experiencia antes dessa
// feature existir no Zenith, vindo de relatorio externo da folha)
app.post('/api/rh/funcionarios/:id/experiencia', auth.requireMaster, async (req, res) => {
  try {
    const atual = await rh.getOne(req.params.id);
    if (!atual) return res.status(404).json({ error: 'Funcionário não encontrado.' });
    const registro = await rh.definirExperiencia(req.params.id, {
      etapa: req.body.etapa, prazoEtapaAte: req.body.prazoEtapaAte, porEmail: req.user.email,
    });
    broadcast('rh-funcionario-atualizado', registro, 'rh');
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/rh/funcionarios/:id/atestado', requireSection('rh'), async (req, res) => {
  try {
    const atual = await rh.getOne(req.params.id);
    if (!atual) return res.status(404).json({ error: 'Funcionário não encontrado.' });
    if (!podeAcessarUnidadeRh(req, atual.unidade)) {
      return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    }
    const registro = await rh.registrarAtestado(req.params.id, {
      inicio: req.body.inicio, previsaoRetorno: req.body.previsaoRetorno, porEmail: req.user.email,
    });
    broadcast('rh-funcionario-atualizado', registro, 'rh');
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/rh/funcionarios/:id/atestado/retorno', requireSection('rh'), async (req, res) => {
  try {
    const atual = await rh.getOne(req.params.id);
    if (!atual) return res.status(404).json({ error: 'Funcionário não encontrado.' });
    if (!podeAcessarUnidadeRh(req, atual.unidade)) {
      return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    }
    const registro = await rh.registrarRetornoAtestado(req.params.id, { porEmail: req.user.email });
    broadcast('rh-funcionario-atualizado', registro, 'rh');
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- desligamento (vira ex-colaborador com data + motivo; não apaga) ----------
app.post('/api/rh/funcionarios/:id/desligar', requireSection('rh'), async (req, res) => {
  try {
    const atual = await rh.getOne(req.params.id);
    if (!atual) return res.status(404).json({ error: 'Funcionário não encontrado.' });
    if (!podeAcessarUnidadeRh(req, atual.unidade)) return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    const registro = await rh.desligar(req.params.id, { motivo: req.body.motivo, data: req.body.data, porEmail: req.user.email });
    broadcast('rh-funcionario-atualizado', registro, 'rh');
    res.json(registro);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/rh/funcionarios/:id/reativar', auth.requireMaster, async (req, res) => {
  try {
    const registro = await rh.reativar(req.params.id);
    broadcast('rh-funcionario-atualizado', registro, 'rh');
    res.json(registro);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ---------- exame periódico (ASO): "fiz hoje" reinicia o vencimento ----------
app.post('/api/rh/funcionarios/:id/exame-periodico', requireSection('rh'), async (req, res) => {
  try {
    const atual = await rh.getOne(req.params.id);
    if (!atual) return res.status(404).json({ error: 'Funcionário não encontrado.' });
    if (!podeAcessarUnidadeRh(req, atual.unidade)) return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    const registro = await rh.registrarExamePeriodico(req.params.id, { data: req.body.data, periodicidadeMeses: req.body.periodicidadeMeses });
    broadcast('rh-funcionario-atualizado', registro, 'rh');
    res.json(registro);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ---------- documentos anexados (RG/CPF, CTPS, ASO, contrato...) ----------
app.post('/api/rh/funcionarios/:id/documentos', requireSection('rh'), upload.single('documento'), async (req, res) => {
  try {
    const atual = await rh.getOne(req.params.id);
    if (!atual) return res.status(404).json({ error: 'Funcionário não encontrado.' });
    if (!podeAcessarUnidadeRh(req, atual.unidade)) return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    if (!req.file) return res.status(400).json({ error: 'Anexe um arquivo.' });
    const path = await storage.salvarArquivo(atual.id, req.file, 'rh-documentos');
    const registro = await rh.adicionarDocumento(req.params.id, {
      tipo: req.body.tipo,
      anexo: { nome: req.file.originalname, path, mime: req.file.mimetype, tamanho: req.file.size },
      porEmail: req.user.email,
    });
    broadcast('rh-funcionario-atualizado', registro, 'rh');
    res.json(registro);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/rh/funcionarios/:id/documentos/:index', requireSection('rh'), async (req, res) => {
  const atual = await rh.getOne(req.params.id);
  if (!atual) return res.sendStatus(404);
  if (!podeAcessarUnidadeRh(req, atual.unidade)) return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
  const doc = (atual.documentos || [])[Number(req.params.index)];
  if (!doc) return res.sendStatus(404);
  storage.streamArquivo(doc.path, doc.mime, res);
});

app.delete('/api/rh/funcionarios/:id/documentos/:index', auth.requireMaster, async (req, res) => {
  try {
    const { funcionario } = await rh.removerDocumento(req.params.id, req.params.index);
    broadcast('rh-funcionario-atualizado', funcionario, 'rh');
    res.json(funcionario);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ---------- painel de métricas + central de alertas trabalhistas (gestão:
// RH todas-unidades / Admin / Master) ----------
app.get('/api/rh/metricas', requireSection('rh'), async (req, res) => {
  if (!podeAprovarRh(req)) return res.status(403).json({ error: 'Só o RH (todas as unidades), Admin ou Master veem o painel.' });
  res.json(await rh.metricas());
});

app.get('/api/rh/alertas', requireSection('rh'), async (req, res) => {
  if (!podeAprovarRh(req)) return res.status(403).json({ error: 'Só o RH (todas as unidades), Admin ou Master veem os alertas.' });
  res.json(await rh.alertasTrabalhistas());
});

app.get('/api/rh/funcionarios/:id/curriculo', requireSection('rh'), async (req, res) => {
  const atual = await rh.getOne(req.params.id);
  if (!atual || !atual.curriculo) return res.sendStatus(404);
  if (!podeAcessarUnidadeRh(req, atual.unidade)) {
    return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
  }
  storage.streamArquivo(atual.curriculo.path, atual.curriculo.tipo, res);
});

app.delete('/api/rh/funcionarios/:id', auth.requireMaster, async (req, res) => {
  try {
    await rh.remover(req.params.id);
    broadcast('rh-funcionario-excluido', { id: req.params.id }, 'rh');
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- RH: check-in/check-out por foto (kiosk fixo na entrada da loja,
// ver server/public/rh-checkin.html) - identifica quem apareceu num dia
// qualquer sem depender da memoria do gerente ----------

// le lat/lng do body (manda junto com a foto no multipart) - o navegador
// pega isso sozinho, sem nenhum campo/prompt proprio nosso pedindo (so o
// prompt nativo do navegador). Foto e localizacao sao obrigatorias (pedido
// explicito do usuario) - se os campos nao vierem, rhCheckin.registrarEntrada/
// registrarSaida rejeita o check-in/check-out (ver validacao la)
function lerLocalizacaoDoBody(body) {
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const precisao = Number(body.precisao);
  return { lat, lng, precisao: Number.isFinite(precisao) ? precisao : null };
}

// a localizacao so aparece pra quem e Master de verdade (nem Admin, nem RH
// todas-unidades) - pedido explicito do usuario ("silenciosamente so pro
// master"); pra todo mundo mais, some do JSON antes de responder
function sanitizarCheckin(c, isMaster) {
  if (isMaster || !c) return c;
  const limpo = { ...c };
  if (limpo.entrada) limpo.entrada = { ...limpo.entrada, localizacao: undefined };
  if (limpo.saida) limpo.saida = { ...limpo.saida, localizacao: undefined };
  return limpo;
}

app.post('/api/rh/checkins', requireSection('rh'), upload.single('foto'), async (req, res) => {
  try {
    const { funcionarioId } = req.body;
    const funcionario = await rh.getOne(funcionarioId);
    if (!funcionario) return res.status(404).json({ error: 'Funcionário não encontrado.' });
    if (!podeAcessarUnidadeRh(req, funcionario.unidade)) {
      return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    }
    let foto = null;
    if (req.file) {
      const path = await storage.salvarArquivo(funcionarioId, req.file, 'rh-checkins');
      foto = { path, tipo: req.file.mimetype };
    }
    const localizacao = lerLocalizacaoDoBody(req.body);
    const registro = await rhCheckin.registrarEntrada({ funcionarioId, foto, localizacao, registradoPorEmail: req.user.email });
    broadcast('rh-checkin-atualizado', { id: registro.id, unidade: registro.unidade }, 'rh');
    if (registro.status === 'pendente_aprovacao') {
      push.notifyRhAprovacaoPendente(registro.funcionarioNome, registro.unidade, registro.motivoPendencia);
    }
    res.json(sanitizarCheckin(registro, req.isMaster));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/rh/checkins/:id/saida', requireSection('rh'), upload.single('foto'), async (req, res) => {
  try {
    const atual = await rhCheckin.getOne(req.params.id);
    if (!atual) return res.status(404).json({ error: 'Check-in não encontrado.' });
    if (!podeAcessarUnidadeRh(req, atual.unidade)) {
      return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    }
    let foto = null;
    if (req.file) {
      const path = await storage.salvarArquivo(atual.funcionarioId, req.file, 'rh-checkins');
      foto = { path, tipo: req.file.mimetype };
    }
    const localizacao = lerLocalizacaoDoBody(req.body);
    const registro = await rhCheckin.registrarSaida(req.params.id, { foto, localizacao, registradoPorEmail: req.user.email });
    broadcast('rh-checkin-atualizado', { id: registro.id, unidade: registro.unidade }, 'rh');
    res.json(sanitizarCheckin(registro, req.isMaster));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Master corrige um check-in lançado errado (horário digitado errado no
// kiosk) ou exclui um registro duplicado/indevido - nenhum dos dois passa
// pela permissão comum de unidade, e de propósito: são as únicas ações
// desse tipo no RH restritas ao Master puro (nem Admin, nem RH todas-
// unidades), já que mexem em prova de ponto já registrada
app.patch('/api/rh/checkins/:id', auth.requireMaster, async (req, res) => {
  try {
    const atual = await rhCheckin.getOne(req.params.id);
    if (!atual) return res.status(404).json({ error: 'Check-in não encontrado.' });
    const registro = await rhCheckin.editarHorarios(req.params.id, {
      entradaData: req.body.entradaData, entradaHora: req.body.entradaHora,
      saidaData: req.body.saidaData, saidaHora: req.body.saidaHora,
      porEmail: req.user.email,
    });
    broadcast('rh-checkin-atualizado', { id: registro.id, unidade: registro.unidade }, 'rh');
    res.json(sanitizarCheckin(registro, req.isMaster));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Master encerra manualmente um check-in que ficou aberto - pedido explicito
// do usuario: "o master precisa ter como realizar o encerramento pois eles
// podem esquecer... para não deixar aberto o master fecha". Sem foto/
// localizacao (o Master pode estar fechando de longe, sem a pessoa por
// perto), fica marcado como encerrado pelo Master (ver encerrarManual)
app.post('/api/rh/checkins/:id/encerrar', auth.requireMaster, async (req, res) => {
  try {
    const atual = await rhCheckin.getOne(req.params.id);
    if (!atual) return res.status(404).json({ error: 'Check-in não encontrado.' });
    const registro = await rhCheckin.encerrarManual(req.params.id, { porEmail: req.user.email });
    broadcast('rh-checkin-atualizado', { id: registro.id, unidade: registro.unidade }, 'rh');
    res.json(sanitizarCheckin(registro, req.isMaster));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/rh/checkins/:id', auth.requireMaster, async (req, res) => {
  try {
    const atual = await rhCheckin.getOne(req.params.id);
    if (!atual) return res.status(404).json({ error: 'Check-in não encontrado.' });
    await rhCheckin.remover(req.params.id);
    broadcast('rh-checkin-excluido', { id: req.params.id, unidade: atual.unidade }, 'rh');
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/rh/checkins', requireSection('rh'), async (req, res) => {
  // Master/Admin/RH-todas-unidades: null = sem filtro de unidade (ver
  // rhCheckin.listByUnidadesData)
  const unidades = (req.isMaster || req.isAdmin || req.podeRhTodasUnidades) ? null : (req.permissions.unidades || []);
  const lista = await rhCheckin.listByUnidadesData(unidades, req.query.data);
  res.json(lista.map((c) => sanitizarCheckin(c, req.isMaster)));
});

app.get('/api/rh/checkins/abertos', requireSection('rh'), async (req, res) => {
  const unidades = (req.isMaster || req.isAdmin || req.podeRhTodasUnidades) ? null : (req.permissions.unidades || []);
  const lista = await rhCheckin.listAbertos(unidades);
  res.json(lista.map((c) => sanitizarCheckin(c, req.isMaster)));
});

app.get('/api/rh/checkins/resumo', requireSection('rh'), async (req, res) => {
  const unidades = (req.isMaster || req.isAdmin || req.podeRhTodasUnidades) ? null : (req.permissions.unidades || []);
  res.json(await rhCheckin.resumoSemana(unidades));
});

// contador individual (semana + total) por pessoa - usado nos cards de "Por
// Unidade" e "Extras", separado do resumo global acima
app.get('/api/rh/checkins/contagem-por-funcionario', requireSection('rh'), async (req, res) => {
  const unidades = (req.isMaster || req.isAdmin || req.podeRhTodasUnidades) ? null : (req.permissions.unidades || []);
  res.json(await rhCheckin.contagemPorFuncionario(unidades));
});

app.get('/api/rh/checkins/:id/foto/:tipo', requireSection('rh'), async (req, res) => {
  const atual = await rhCheckin.getOne(req.params.id);
  if (!atual) return res.sendStatus(404);
  if (!podeAcessarUnidadeRh(req, atual.unidade)) {
    return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
  }
  const bloco = req.params.tipo === 'saida' ? atual.saida : atual.entrada;
  if (!bloco || !bloco.foto) return res.sendStatus(404);
  storage.streamArquivo(bloco.foto.path, bloco.foto.tipo, res);
});

// pendencias de check-in (extra alem do limite semanal, candidato com teste
// vencido sem decisao) - so quem pode aprovar (RH todas-unidades/Admin/
// Master) ve e decide; aprovar ja registra a entrada na hora
app.get('/api/rh/checkins/pendentes-aprovacao', requireSection('rh'), async (req, res) => {
  if (!podeAprovarRh(req)) return res.json([]);
  // sanitiza igual as outras rotas de check-in: localizacao so pro Master -
  // Admin/RH-todas-unidades aprovam a pendencia, mas nao veem o GPS
  res.json((await rhCheckin.listPendentesAprovacao(null)).map((c) => sanitizarCheckin(c, req.isMaster)));
});

app.post('/api/rh/checkins/pendentes-aprovacao/:id/aprovar', requireSection('rh'), async (req, res) => {
  try {
    if (!podeAprovarRh(req)) return res.status(403).json({ error: 'Só o RH, o Admin ou o Master podem aprovar.' });
    const registro = await rhCheckin.aprovarPendencia(req.params.id, { porEmail: req.user.email });
    broadcast('rh-checkin-atualizado', { id: registro.id, unidade: registro.unidade }, 'rh');
    res.json(sanitizarCheckin(registro, req.isMaster));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/rh/checkins/pendentes-aprovacao/:id/recusar', requireSection('rh'), async (req, res) => {
  try {
    if (!podeAprovarRh(req)) return res.status(403).json({ error: 'Só o RH, o Admin ou o Master podem recusar.' });
    const registro = await rhCheckin.recusarPendencia(req.params.id, { porEmail: req.user.email, motivo: req.body.motivo });
    broadcast('rh-checkin-atualizado', { id: registro.id, unidade: registro.unidade }, 'rh');
    res.json(sanitizarCheckin(registro, req.isMaster));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- RH: solicitacao de advertencia disciplinar - so pra colaborador
// EFETIVADO (extra e candidato em teste nao tem essa opcao). Fluxo:
// pendente -> (RH/Admin/Master aprova) -> aguardando_documento (48h) ->
// (RH anexa o arquivo) -> aguardando_assinatura -> (gerente sobe assinado)
// -> concluida. Duvidas rolam no chat generico (centralChat.js, tipo
// 'rh-advertencia') ----------
function podeSolicitarAdvertencia(funcionario) {
  return !!funcionario && funcionario.status === 'ativo' && funcionario.tipoCadastro !== 'extra';
}

app.post('/api/rh/advertencias', requireSection('rh'), upload.array('evidencias', 6), async (req, res) => {
  try {
    const { funcionarioId, motivo } = req.body;
    const funcionario = await rh.getOne(funcionarioId);
    if (!funcionario) return res.status(404).json({ error: 'Funcionário não encontrado.' });
    if (!podeAcessarUnidadeRh(req, funcionario.unidade)) {
      return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    }
    if (!podeSolicitarAdvertencia(funcionario)) {
      return res.status(400).json({ error: 'Advertência é só pra colaborador efetivado - não vale pra extra nem candidato em teste.' });
    }
    const evidencias = [];
    for (const file of req.files || []) {
      const path = await storage.salvarArquivo(funcionarioId, file, 'rh-advertencias-evidencias');
      evidencias.push({ path, tipo: file.mimetype, nomeOriginal: file.originalname });
    }
    const registro = await rhAdvertencias.criar({
      funcionarioId, funcionarioNome: funcionario.nome, unidade: funcionario.unidade, motivo, evidencias,
      solicitadoPorId: req.user.id, solicitadoPorEmail: req.user.email,
    });
    broadcast('rh-advertencia-atualizada', { id: registro.id, unidade: registro.unidade }, 'rh');
    push.notifyRhAdvertenciaPendente(registro);
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/rh/advertencias', requireSection('rh'), async (req, res) => {
  if (req.isMaster || req.isAdmin || req.podeRhTodasUnidades) return res.json(await rhAdvertencias.listAll());
  res.json(await rhAdvertencias.listByUnidades(req.permissions.unidades || []));
});

app.post('/api/rh/advertencias/:id/decisao', requireSection('rh'), async (req, res) => {
  try {
    if (!podeAprovarRh(req)) return res.status(403).json({ error: 'Só o RH, o Admin ou o Master podem decidir.' });
    const atual = await rhAdvertencias.getOne(req.params.id);
    if (!atual) return res.status(404).json({ error: 'Solicitação não encontrada.' });
    if (!podeAcessarUnidadeRh(req, atual.unidade)) {
      return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    }
    const registro = await rhAdvertencias.decidir(req.params.id, {
      aprovado: !!req.body.aprovado, motivoRecusa: req.body.motivoRecusa, porEmail: req.user.email,
    });
    broadcast('rh-advertencia-atualizada', { id: registro.id, unidade: registro.unidade }, 'rh');
    if (registro.solicitadoPorId) {
      push.notifyUsuario(
        registro.solicitadoPorId,
        registro.status === 'aguardando_documento' ? '📋 RH · advertência aprovada' : '📋 RH · advertência recusada',
        `${registro.funcionarioNome} - ${registro.status === 'aguardando_documento' ? 'aprovada, aguardando o documento do RH.' : 'a solicitação foi recusada.'}`,
        `rh-advertencia-decisao-${registro.id}`,
        '/rh.html',
      );
    }
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/rh/advertencias/:id/documento', requireSection('rh'), upload.single('arquivo'), async (req, res) => {
  try {
    if (!podeAprovarRh(req)) return res.status(403).json({ error: 'Só o RH, o Admin ou o Master podem anexar o documento.' });
    const atual = await rhAdvertencias.getOne(req.params.id);
    if (!atual) return res.status(404).json({ error: 'Solicitação não encontrada.' });
    if (!podeAcessarUnidadeRh(req, atual.unidade)) {
      return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    }
    if (!req.file) return res.status(400).json({ error: 'Anexe um arquivo.' });
    const path = await storage.salvarArquivo(req.params.id, req.file, 'rh-advertencias-documento');
    const registro = await rhAdvertencias.anexarDocumento(req.params.id, {
      documento: { path, tipo: req.file.mimetype, nomeOriginal: req.file.originalname }, porEmail: req.user.email,
    });
    broadcast('rh-advertencia-atualizada', { id: registro.id, unidade: registro.unidade }, 'rh');
    if (registro.solicitadoPorId) {
      push.notifyUsuario(
        registro.solicitadoPorId, '📋 RH · documento de advertência pronto',
        `${registro.funcionarioNome} - baixe o documento e colha a assinatura do colaborador.`,
        `rh-advertencia-documento-${registro.id}`, '/rh.html',
      );
    }
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/rh/advertencias/:id/documento', requireSection('rh'), async (req, res) => {
  const atual = await rhAdvertencias.getOne(req.params.id);
  if (!atual || !atual.documento) return res.sendStatus(404);
  if (!podeAcessarUnidadeRh(req, atual.unidade)) {
    return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
  }
  storage.streamArquivo(atual.documento.path, atual.documento.tipo, res);
});

app.post('/api/rh/advertencias/:id/assinado', requireSection('rh'), upload.single('arquivo'), async (req, res) => {
  try {
    const atual = await rhAdvertencias.getOne(req.params.id);
    if (!atual) return res.status(404).json({ error: 'Solicitação não encontrada.' });
    if (!podeAcessarUnidadeRh(req, atual.unidade)) {
      return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    }
    if (!req.file) return res.status(400).json({ error: 'Anexe o arquivo assinado.' });
    const path = await storage.salvarArquivo(req.params.id, req.file, 'rh-advertencias-assinado');
    const registro = await rhAdvertencias.enviarAssinado(req.params.id, {
      documento: { path, tipo: req.file.mimetype, nomeOriginal: req.file.originalname }, porEmail: req.user.email,
    });
    broadcast('rh-advertencia-atualizada', { id: registro.id, unidade: registro.unidade }, 'rh');
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/rh/advertencias/:id/assinado', requireSection('rh'), async (req, res) => {
  const atual = await rhAdvertencias.getOne(req.params.id);
  if (!atual || !atual.documentoAssinado) return res.sendStatus(404);
  if (!podeAcessarUnidadeRh(req, atual.unidade)) {
    return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
  }
  storage.streamArquivo(atual.documentoAssinado.path, atual.documentoAssinado.tipo, res);
});

app.get('/api/rh/advertencias/:id/evidencia/:idx', requireSection('rh'), async (req, res) => {
  const atual = await rhAdvertencias.getOne(req.params.id);
  if (!atual) return res.sendStatus(404);
  if (!podeAcessarUnidadeRh(req, atual.unidade)) {
    return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
  }
  const evidencia = (atual.evidencias || [])[Number(req.params.idx)];
  if (!evidencia) return res.sendStatus(404);
  storage.streamArquivo(evidencia.path, evidencia.tipo, res);
});

app.get('/api/rh/advertencias/:id/mensagens', requireSection('rh'), async (req, res) => {
  const atual = await rhAdvertencias.getOne(req.params.id);
  if (!atual) return res.status(404).json({ error: 'Solicitação não encontrada.' });
  if (!podeAcessarUnidadeRh(req, atual.unidade)) {
    return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
  }
  res.json(await centralChat.listByCard('rh-advertencia', req.params.id));
});

app.post('/api/rh/advertencias/:id/mensagens', requireSection('rh'), async (req, res) => {
  try {
    const atual = await rhAdvertencias.getOne(req.params.id);
    if (!atual) return res.status(404).json({ error: 'Solicitação não encontrada.' });
    if (!podeAcessarUnidadeRh(req, atual.unidade)) {
      return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    }
    const mensagem = await centralChat.addMessage({
      tipo: 'rh-advertencia', cardId: req.params.id, autorId: req.user.id,
      autorEmail: req.user.email, autorUsername: req.user.username || null, texto: req.body.texto, imagem: null,
    });
    broadcast('rh-advertencia-chat', { id: req.params.id }, 'rh');
    res.json(mensagem);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- Saltiverso Patteo: venda de bebidas/meias no balcão + fechamento
// de caixa dedicado - secao propria 'parque-loja' (cobre balcao E
// fechamento, mesma pessoa normalmente faz os dois). Gerenciar catalogo
// (adicionar bebida/meia, editar preco) usa as rotas /api/inventario/catalogo*
// que ja existem, so precisa da secao 'inventario' (+ podeCatalogoEstoque
// pra quem nao e Master) - ver podeUnidadeInventario acima ----------
app.get('/api/saltiverso/catalogo', requireSection('parque-loja'), async (req, res) => {
  try {
    const unidade = req.query.unidade;
    if (!podeUnidadeInventario(req, unidade)) return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    const catalogo = await inventario.listCatalogo(unidade);
    res.json(catalogo.filter((i) => i.ativo !== false && ['BEBIDA', 'MEIA'].includes(i.tipo)));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/saltiverso/vendas', requireSection('parque-loja'), async (req, res) => {
  try {
    const { unidade, unidadeNome, itens, pagamentos } = req.body;
    if (!podeUnidadeInventario(req, unidade)) return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    const venda = await saltiversoVendas.criarVenda({
      unidade, unidadeNome, itens, pagamentos,
      criadoPorId: req.user.id, criadoPorEmail: req.user.email,
    });
    broadcast('saltiverso-venda-criada', venda, 'parque-loja');
    res.json(venda);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/saltiverso/vendas', requireSection('parque-loja'), async (req, res) => {
  const { unidade, data } = req.query;
  if (!podeUnidadeInventario(req, unidade)) return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
  res.json(await saltiversoVendas.listVendasDoDia(unidade, data));
});

app.delete('/api/saltiverso/vendas/:id', auth.requireMaster, async (req, res) => {
  try {
    const venda = await saltiversoVendas.cancelarVenda(req.params.id, { porId: req.user.id, porEmail: req.user.email });
    broadcast('saltiverso-venda-cancelada', venda, 'parque-loja');
    res.json(venda);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// estado do dia: faturado ao vivo + caixas fechados + operadores pendentes +
// doc do dia (se ja fechou). Base da nova tela de fechamento por caixa.
app.get('/api/saltiverso/fechamento', requireSection('parque-loja'), async (req, res) => {
  try {
    const { unidade, data } = req.query;
    if (!podeUnidadeInventario(req, unidade)) return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    res.json(await saltiversoFechamento.estadoDoDia(unidade, data));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// o operador logado fecha O SEU caixa (declara o que contou)
app.post('/api/saltiverso/fechamento/caixa', requireSection('parque-loja'), async (req, res) => {
  try {
    const { unidade, unidadeNome, data, declarado, observacao } = req.body;
    if (!podeUnidadeInventario(req, unidade)) return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    const caixa = await saltiversoFechamento.lancarCaixa({
      unidade, unidadeNome, data, declarado, observacao,
      operadorId: req.user.id, operadorEmail: req.user.email, operadorNome: req.user.username || req.user.email,
    });
    broadcast('saltiverso-caixa-lancado', caixa, 'parque-loja');
    res.json(caixa);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// pedir alteracao de um caixa ja lancado (trava anti-fraude) - vai pra
// aprovacao do Master
app.post('/api/saltiverso/fechamento/caixa/:id/solicitar-alteracao', requireSection('parque-loja'), async (req, res) => {
  try {
    const pedido = await saltiversoFechamento.solicitarAlteracaoCaixa(req.params.id, {
      declarado: req.body.declarado, motivo: req.body.motivo,
      solicitadoPorId: req.user.id, solicitadoPorEmail: req.user.email,
    });
    broadcast('saltiverso-caixa-alteracao', pedido, 'parque-loja');
    res.json(pedido);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/saltiverso/fechamento/alteracoes', auth.requireMasterOrAdmin, async (req, res) => {
  res.json(await saltiversoFechamento.listAlteracoesPendentes(req.query.unidade));
});

app.post('/api/saltiverso/fechamento/alteracoes/:id/decidir', auth.requireMasterOrAdmin, async (req, res) => {
  try {
    const r = await saltiversoFechamento.decidirAlteracaoCaixa(req.params.id, { aprovado: !!req.body.aprovado, porId: req.user.id, porEmail: req.user.email });
    broadcast('saltiverso-caixa-alteracao-decidida', r, 'parque-loja');
    res.json(r);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/saltiverso/fechamento', requireSection('parque-loja'), async (req, res) => {
  try {
    const { unidade, unidadeNome, data, observacao } = req.body;
    if (!podeUnidadeInventario(req, unidade)) return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    const fechamento = await saltiversoFechamento.fecharDia({
      unidade, unidadeNome, data, observacao,
      criadoPorId: req.user.id, criadoPorEmail: req.user.email,
    });
    broadcast('saltiverso-fechamento-criado', fechamento, 'parque-loja');
    res.json(fechamento);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/saltiverso/fechamento/:id', auth.requireMaster, async (req, res) => {
  try {
    const { totalDeclarado, observacao } = req.body;
    const fechamento = await saltiversoFechamento.corrigirFechamento(req.params.id, { totalDeclarado, observacao }, { porId: req.user.id, porEmail: req.user.email });
    broadcast('saltiverso-fechamento-corrigido', fechamento, 'parque-loja');
    res.json(fechamento);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/saltiverso/fechamentos', requireSection('parque-loja'), async (req, res) => {
  const { unidade, dataInicio, dataFim } = req.query;
  if (!podeUnidadeInventario(req, unidade)) return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
  res.json(await saltiversoFechamento.listFechamentos(unidade, dataInicio, dataFim));
});

// ---------- Saltiverso Patteo: passaporte mensal (mensalistas) - reaproveita
// a secao 'parque' (mesmo publico que ja gerencia o painel do parque) em vez
// de criar uma quarta secao de permissao so pra isso ----------
app.post('/api/mensalistas', requireSection('parque'), async (req, res) => {
  try {
    const { unidade, unidadeNome, nome, cpf, contato, email, cep, numero, complemento, dataInicial, valorPlano, usuarios } = req.body;
    if (!req.isMaster && !(req.permissions.unidades || []).includes(unidade)) {
      return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    }
    const registro = await mensalistas.criar({
      unidade, unidadeNome, nome, cpf, contato, email, cep, numero, complemento, dataInicial, valorPlano, usuarios,
      criadoPorId: req.user.id, criadoPorEmail: req.user.email,
    });
    broadcast('mensalista-criado', registro, 'parque');
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/mensalistas', requireSection('parque'), async (req, res) => {
  if (req.isMaster) return res.json(await mensalistas.listAll());
  res.json(await mensalistas.listByUnidades(req.permissions.unidades || []));
});

app.patch('/api/mensalistas/:id', requireSection('parque'), async (req, res) => {
  try {
    const atual = await mensalistas.getOne(req.params.id);
    if (!atual) return res.status(404).json({ error: 'Mensalista não encontrado.' });
    if (!req.isMaster && !(req.permissions.unidades || []).includes(atual.unidade)) {
      return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    }
    const registro = await mensalistas.atualizar(req.params.id, req.body);
    broadcast('mensalista-atualizado', registro, 'parque');
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/mensalistas/:id', auth.requireMaster, async (req, res) => {
  try {
    await mensalistas.remover(req.params.id);
    broadcast('mensalista-excluido', { id: req.params.id }, 'parque');
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- sangria (retirada de caixa) registrada em campo, ao longo do
// dia - pensado pra quem visita varias lojas (ex: supervisor) e nao ta
// esperando o fechamento do dia sair pra lancar a retirada. Fica separado do
// fechamento e so e mesclado com ele na leitura (GET /api/fechamentos).
// Secao propria "sangria" (independente de "lancamento") - permite liberar
// alguem so pra registrar sangria, em unidades especificas, sem dar acesso
// as demais secoes do Fechamento (Faturamento, Declarado, etc) ----------
app.post('/api/sangrias', requireSection('sangria'), async (req, res) => {
  try {
    const { unidade, unidadeNome, grupo, data, valor, descricao, periodoInicio, periodoFim, nomeDepositante, password } = req.body;
    if (!req.isMaster && !(req.permissions.unidades || []).includes(unidade)) {
      return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    }
    // 400, nao 401 - o wrapper global de fetch das paginas desloga em
    // qualquer 401 (token invalido), e uma senha de confirmacao errada
    // aqui nao significa que a sessao do usuario esta invalida
    const senhaOk = await auth.verifyPassword(req.user.id, password);
    if (!senhaOk) return res.status(400).json({ error: 'Senha incorreta.' });
    const registro = await sangrias.criar({
      unidade, unidadeNome, grupo, data, valor, descricao, periodoInicio, periodoFim, nomeDepositante,
      criadoPorId: req.user.id,
      criadoPorEmail: req.user.email,
    });
    broadcast('sangria-lancada', registro, 'sangria');
    broadcast('sangria-lancada', registro, 'lancamento');
    broadcast('sangria-lancada', registro, 'fechamentos');
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/sangrias/minhas', requireSection('sangria'), async (req, res) => {
  if (req.isMaster) return res.json(await sangrias.listAll());
  res.json(await sangrias.listByUnidades(req.permissions.unidades || []));
});

// edicao/exclusao direta - so o Master. A sangria so existe nessa colecao
// (o fechamento so a enxerga mesclada na leitura), entao editar/excluir
// aqui ja reflete automaticamente em qualquer lugar que mostra o
// fechamento mesclado (fechamentos.html, "Faturamento" do dia, etc)
app.patch('/api/sangrias/:id', auth.requireMaster, async (req, res) => {
  try {
    const registro = await sangrias.atualizar(req.params.id, req.body);
    broadcast('sangria-atualizada', registro, 'sangria');
    broadcast('sangria-atualizada', registro, 'lancamento');
    broadcast('sangria-atualizada', registro, 'fechamentos');
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/sangrias/:id', auth.requireMaster, async (req, res) => {
  try {
    await sangrias.remover(req.params.id);
    broadcast('sangria-excluida', { id: req.params.id }, 'sangria');
    broadcast('sangria-excluida', { id: req.params.id }, 'lancamento');
    broadcast('sangria-excluida', { id: req.params.id }, 'fechamentos');
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// leitura somente-informativa da sangria de um dia/unidade especifico -
// usada pelo formulario de Fechamento (secao "lancamento") pra mostrar a
// saida de caixa ja registrada, sem dar acesso de criar/editar sangria (que
// exige a secao "sangria" separada, ver rotas acima)
app.get('/api/sangrias/do-dia', requireAnySection('lancamento', 'sangria'), async (req, res) => {
  const { unidade, data } = req.query;
  if (!unidade || !data) return res.status(400).json({ error: 'unidade e data são obrigatórios.' });
  if (!req.isMaster && !(req.permissions.unidades || []).includes(unidade)) {
    return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
  }
  const todas = await sangrias.listByUnidades([unidade]);
  res.json(todas.filter((s) => s.data === data));
});

app.post('/api/fechamentos/:id/solicitar-edicao', requireSection('lancamento'), upload.array('anexos', 4), async (req, res) => {
  try {
    const atual = await fechamentosLive.getOne(req.params.id);
    if (!atual) return res.status(404).json({ error: 'Fechamento não encontrado.' });
    if (!req.isMaster && !(req.permissions.unidades || []).includes(atual.unidade)) {
      return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    }
    const payload = req.is('multipart/form-data') ? JSON.parse(req.body.payload || '{}') : req.body;
    const anexos = [];
    for (const file of req.files || []) {
      const path = await storage.salvarArquivo(req.params.id, file, 'fechamento-edicoes');
      anexos.push({ nome: file.originalname, path, tipo: file.mimetype || 'application/octet-stream' });
    }
    const pedido = await fechamentosLive.solicitarEdicao({
      fechamentoId: req.params.id,
      tipoCorrecao: payload.tipoCorrecao,
      mudancas: payload.mudancas,
      mudancasCanais: payload.mudancasCanais,
      mudancasFormas: payload.mudancasFormas,
      mudancasKpis: payload.mudancasKpis,
      itemNovo: payload.itemNovo,
      novaData: payload.novaData,
      motivo: payload.motivo,
      anexos,
      solicitadoPorId: req.user.id,
      solicitadoPorEmail: req.user.email,
      direcionadoParaId: payload.direcionadoParaId,
      direcionadoParaEmail: payload.direcionadoParaEmail,
    });
    broadcast('fechamento-edicao-solicitada', pedido, 'lancamento');
    broadcast('fechamento-edicao-solicitada', pedido, 'solicitacoes');
    push.notifySolicitacao(`Ticket #${pedido.numeroTicket} · Correção de fechamento solicitada`, `${req.user.email} · ${payload.tipoCorrecao || ''}`, pedido.id);
    notificarSeDirecionadoAoMV('ajuste-fechamento', pedido);
    res.json(pedido);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/fechamentos/edicoes/anexo/:edicaoId/:index', requireSection('lancamento'), async (req, res) => {
  const pedido = await fechamentosLive.getEdicao(req.params.edicaoId);
  if (!pedido) return res.sendStatus(404);
  if (!req.isMaster && pedido.solicitadoPorId !== req.user.id) return res.sendStatus(404);
  const anexo = pedido.anexos && pedido.anexos[Number(req.params.index)];
  if (!anexo) return res.sendStatus(404);
  storage.streamArquivo(anexo.path, anexo.tipo, res);
});

// edicao direta de um lancamento - so o Master, sem passar pela fila de
// aprovacao (ele mesmo e quem aprovaria, entao pedir pra si mesmo so
// atrasaria); ainda assim fica registrado no historico do fechamento.
// upload.any(): so entra em acao quando o Master troca o arquivo de um KPI
// extra tipo "arquivo" (ver fechamentos.html/central-historico.html) -
// requisicao JSON normal passa direto.
// Master corrige a UNIDADE e/ou a DATA de um fechamento ja lancado - por
// baixo o registro e movido (o ID e unidade+data, ver moverFechamento).
// Devolve o registro novo, inclusive o id novo, pro cliente continuar
// editando os demais campos em cima dele
app.patch('/api/fechamentos/:id/mover', auth.requireMaster, async (req, res) => {
  try {
    const { novaUnidade, novaData, motivo } = req.body;
    const registro = await fechamentosLive.moverFechamento({
      fechamentoId: req.params.id,
      novaUnidade,
      novaUnidadeNome: novaUnidade ? nomeCanonicoUnidade(novaUnidade) : null,
      novaData,
      motivo,
      editadoPorEmail: req.user.email,
    });
    broadcast('fechamento-editado-direto', registro, 'lancamento');
    broadcast('fechamento-editado-direto', registro, 'fechamentos');
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/fechamentos/:id/editar-direto', auth.requireMaster, upload.any(), async (req, res) => {
  try {
    const body = req.is('multipart/form-data') ? JSON.parse(req.body.payload || '{}') : req.body;
    const arquivosKpi = await uploadArquivosKpi(req.files, req.params.id);
    const mudancasKpis = { ...(body.mudancasKpis || {}), ...arquivosKpi };
    const registro = await fechamentosLive.editarDireto({
      fechamentoId: req.params.id,
      mudancas: body.mudancas,
      mudancasKpis,
      mudancasCanais: body.mudancasCanais,
      mudancasFormas: body.mudancasFormas,
      motivo: body.motivo,
      editadoPorEmail: req.user.email,
    });
    broadcast('fechamento-editado-direto', registro, 'lancamento');
    broadcast('fechamento-editado-direto', registro, 'fechamentos');
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// serve o arquivo de um KPI extra tipo "arquivo" (ver grupos.js/lancamento.html)
// - o valor gravado em kpisExtras[campo] E o caminho no Storage (nao um
// numero), ver sanitizarMapaExtras em fechamentosLive.js
function mimeGuess(caminho) {
  const ext = String(caminho).split('.').pop().toLowerCase();
  const mapa = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf' };
  return mapa[ext] || 'application/octet-stream';
}
app.get('/api/fechamentos/:id/kpi-arquivo/:campo', requireAnySection('lancamento', 'fechamentos', 'solicitacoes'), async (req, res) => {
  const fechamento = await fechamentosLive.getOne(req.params.id);
  if (!fechamento) return res.sendStatus(404);
  if (!req.isMaster && !(req.permissions.unidades || []).includes(fechamento.unidade)) return res.sendStatus(404);
  const caminho = (fechamento.kpisExtras || {})[req.params.campo];
  if (!caminho || typeof caminho !== 'string') return res.sendStatus(404);
  storage.streamArquivo(caminho, mimeGuess(caminho), res);
});

// exclui um fechamento lançado de vez - so o Master. Vale so pra fechamentos
// de verdade (lancados pelo app, tem criadoPorId) - linha vinda da planilha
// importada ou de sangria mapeada nao existe como documento aqui, entao
// simplesmente da erro "nao encontrado" se tentarem
app.delete('/api/fechamentos/:id', auth.requireMaster, async (req, res) => {
  try {
    await fechamentosLive.remove(req.params.id);
    broadcast('fechamento-excluido', { id: req.params.id }, 'lancamento');
    broadcast('fechamento-excluido', { id: req.params.id }, 'fechamentos');
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// fila de pedidos de correcao - so o Master decide (aprova/rejeita), mas quem
// pediu pode acompanhar o status do proprio pedido
app.get('/api/fechamentos/edicoes', requireSection('lancamento'), async (req, res) => {
  const todas = await fechamentosLive.listarEdicoes();
  if (req.isMaster || req.isAdmin) return res.json(todas);
  res.json(todas.filter((p) => p.solicitadoPorId === req.user.id));
});

app.patch('/api/fechamentos/edicoes/:id', auth.requireMasterOrAdmin, async (req, res) => {
  try {
    if (tipoBloqueado(req, 'ajuste-fechamento')) return res.status(403).json({ error: 'Você não tem acesso a esse tipo de solicitação.' });
    const pedido = await fechamentosLive.decidirEdicao(req.params.id, req.body.status, {
      decididoPorEmail: req.user.email,
      motivoDecisao: req.body.motivoDecisao,
    });
    broadcast('fechamento-edicao-decidida', pedido, 'lancamento');
    broadcast('fechamento-edicao-decidida', pedido, 'fechamentos');
    broadcast('fechamento-edicao-decidida', pedido, 'solicitacoes');
    res.json(pedido);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/fechamentos/edicoes/:id/direcionar', auth.requireMaster, async (req, res) => {
  try {
    if (tipoBloqueado(req, 'ajuste-fechamento')) return res.status(403).json({ error: 'Você não tem acesso a esse tipo de solicitação.' });
    const pedido = await fechamentosLive.redirecionarEdicao(req.params.id, req.body);
    broadcast('fechamento-edicao-decidida', pedido, 'lancamento');
    broadcast('fechamento-edicao-decidida', pedido, 'fechamentos');
    broadcast('fechamento-edicao-decidida', pedido, 'solicitacoes');
    notificarSeDirecionadoAoMV('ajuste-fechamento', pedido);
    res.json(pedido);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// exclui so o PEDIDO de ajuste da fila - poder do Master de limpar a fila.
// Se ja tinha sido aprovado, o fechamento em si nao e desfeito (ele ja foi
// alterado quando decidirEdicao rodou); pra corrigir o fechamento depois
// disso o Master usa /editar-direto normalmente.
app.delete('/api/fechamentos/edicoes/:id', auth.requireMaster, async (req, res) => {
  try {
    await fechamentosLive.removerEdicao(req.params.id);
    broadcast('fechamento-edicao-decidida', { id: req.params.id, excluido: true }, 'solicitacoes');
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- Compra / Manutenção / Suporte de TI (secao "solicitacoes") -
// mesmo fluxo de fila-com-aprovacao do Estorno e do Ajuste de Fechamento,
// so que pra pedidos que nao tem uma secao propria ja existente. Aprovar um
// pedido de Suporte de TI ja cria o Chamado (ver chamadosTI.js) ----------
app.post('/api/solicitacoes', requireSection('solicitacoes'), upload.array('anexos', 4), async (req, res) => {
  try {
    const payload = req.is('multipart/form-data') ? JSON.parse(req.body.payload || '{}') : req.body;
    const { tipo, unidade, unidadeNome, titulo, valorEstimado, observacao, itens, ehOrcamento, fornecedor, vencimento, direcionadoParaId, direcionadoParaEmail, prioridade } = payload;
    if (!req.isMaster && unidade && !(req.permissions.unidades || []).includes(unidade)) {
      return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    }
    const tiposPerm = tiposSolicitacaoPermitidos(req);
    if (tiposPerm && !tiposPerm.has(tipo)) {
      return res.status(403).json({ error: 'Você não tem acesso a esse tipo de solicitação.' });
    }
    const anexos = [];
    for (const file of req.files || []) {
      const path = await storage.salvarArquivo(unidade || 'geral', file, 'solicitacoes');
      anexos.push({ nome: file.originalname, path, tipo: file.mimetype || 'application/octet-stream' });
    }
    const registro = await solicitacoes.create({
      tipo, unidade, unidadeNome, titulo, valorEstimado, observacao, itens, anexos, ehOrcamento, fornecedor, vencimento,
      criadoPorId: req.user.id,
      criadoPorEmail: req.user.email,
      direcionadoParaId,
      direcionadoParaEmail,
      prioridade,
      teste: req.isQaMaster || req.isQaUser,
    });
    broadcast('solicitacao-criada', registro, 'solicitacoes');
    push.notifySolicitacao(`Ticket #${registro.numeroTicket} · Nova solicitação`, `${req.user.email} · ${registro.titulo || tipo || ''}`, registro.id);
    notificarSeDirecionadoAoMV(registro.tipo, registro);
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/solicitacoes/anexo/:id/:index', requireSection('solicitacoes'), async (req, res) => {
  const registro = await solicitacoes.getOne(req.params.id);
  if (!registro) return res.sendStatus(404);
  if (!podeVerCard(req, registro)) return res.sendStatus(404);
  const anexo = registro.anexos && registro.anexos[Number(req.params.index)];
  if (!anexo) return res.sendStatus(404);
  storage.streamArquivo(anexo.path, anexo.tipo, res);
});

app.get('/api/solicitacoes/:id/comprovante', requireSection('solicitacoes'), async (req, res) => {
  const registro = await solicitacoes.getOne(req.params.id);
  if (!registro) return res.sendStatus(404);
  if (!podeVerCard(req, registro)) return res.sendStatus(404);
  if (!registro.comprovante) return res.sendStatus(404);
  storage.streamArquivo(registro.comprovante.path, registro.comprovante.tipo, res);
});

// marcar/desmarcar Comprada - so pedidos de Compra ja Aprovados, Master ou
// Admin, com data de entrega prevista e/ou print do comprovante da compra
// (os dois opcionais, ver solicitacoes.marcarComprada)
app.patch('/api/solicitacoes/:id/comprada', auth.requireMasterOrAdmin, upload.single('comprovante'), async (req, res) => {
  try {
    const payload = req.is('multipart/form-data') ? JSON.parse(req.body.payload || '{}') : req.body;
    const atual = await solicitacoes.getOne(req.params.id);
    if (!atual) return res.status(404).json({ error: 'Solicitação não encontrada.' });
    if (tipoBloqueado(req, atual.tipo)) return res.status(403).json({ error: 'Você não tem acesso a esse tipo de solicitação.' });
    let comprovante = null;
    if (req.file) {
      const path = await storage.salvarArquivo(atual.unidade || 'geral', req.file, 'solicitacoes');
      comprovante = { nome: req.file.originalname, path, tipo: req.file.mimetype || 'application/octet-stream' };
    }
    const registro = await solicitacoes.marcarComprada(req.params.id, {
      dataEntregaPrevista: payload.dataEntregaPrevista,
      comprovante,
      marcadoPorEmail: req.user.email,
    });
    broadcast('solicitacao-decidida', registro, 'solicitacoes');
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/solicitacoes/:id/comprada', auth.requireMasterOrAdmin, async (req, res) => {
  try {
    const registro = await solicitacoes.desmarcarComprada(req.params.id);
    broadcast('solicitacao-decidida', registro, 'solicitacoes');
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// aprovar/rejeitar - so o Master. Se for suporte-ti e for aprovado, ja cria
// o Chamado vinculado (precisa escolher o tecnico no corpo da requisicao) -
// EXCETO se for um ticket automatico de "Login bloqueado" (ver
// auth.criarChamadoBloqueio): aprovar esse tipo especifico nao despacha
// tecnico nenhum, e uma acao direto na conta - desbloqueia SEM mexer na
// senha (a pessoa volta a usar a mesma de sempre); so forca trocar no
// proximo login se o Master marcar isso no corpo (pedirTrocaSenha)
app.patch('/api/solicitacoes/:id/status', auth.requireMasterOrAdmin, async (req, res) => {
  try {
    const { status, motivoDecisao, tecnicoId, tecnicoEmail, responsaveis } = req.body;
    const atual = await solicitacoes.getOne(req.params.id);
    if (!atual) return res.status(404).json({ error: 'Solicitação não encontrada.' });
    if (tipoBloqueado(req, atual.tipo)) return res.status(403).json({ error: 'Você não tem acesso a esse tipo de solicitação.' });
    const ehBloqueioLogin = atual.tipo === 'suporte-ti' && atual.criadoPorEmail === auth.ROBO_BLOQUEIO_EMAIL;
    if (status === 'APROVADO' && atual.tipo === 'suporte-ti' && !ehBloqueioLogin && !tecnicoId) {
      return res.status(400).json({ error: 'Escolha o técnico responsável pelo chamado.' });
    }
    if (status === 'APROVADO' && atual.tipo === 'manutencao' && (!Array.isArray(responsaveis) || !responsaveis.length)) {
      return res.status(400).json({ error: 'Escolha quem vai fazer a manutenção.' });
    }
    const registro = await solicitacoes.updateStatus(req.params.id, status, { motivoDecisao, decidedByEmail: req.user.email });

    let chamado = null;
    let desbloqueado = null;
    let avisoSenha = null;
    if (status === 'APROVADO' && atual.tipo === 'suporte-ti') {
      if (ehBloqueioLogin) {
        try {
          // desbloqueia SEM mexer na senha - a pessoa volta a usar a MESMA de
          // sempre; so se o Master marcar a opcao (checkbox no card do
          // ticket) e que tambem forca trocar no proximo login
          await users.desbloquear(atual.criadoPorId, { pedirTrocaSenha: !!req.body.pedirTrocaSenha });
          desbloqueado = true;
        } catch (e) {
          avisoSenha = `Ticket aprovado, mas não foi possível desbloquear o acesso automaticamente: ${e.message}`;
        }
      } else {
        chamado = await chamadosTI.create({
          unidade: atual.unidade,
          unidadeNome: atual.unidadeNome,
          titulo: atual.titulo,
          descricao: atual.observacao,
          // todo chamado nasce remoto (triagem) - ninguem escolhe modalidade
          // na aprovacao; a prioridade herda a da solicitacao se o aprovador
          // nao escolher outra (ver chamadosTI.escalarPresencial pra depois)
          prioridade: req.body.prioridade || atual.prioridade,
          tecnicoId,
          tecnicoEmail,
          solicitacaoId: atual.id,
          numeroTicket: atual.numeroTicket,
          criadoPorEmail: req.user.email,
        });
        await solicitacoes.vincularChamado(atual.id, chamado.id);
        broadcast('chamado-criado', { id: chamado.id }, 'tecnico');
      }
    } else if (status === 'APROVADO' && atual.tipo === 'manutencao') {
      chamado = await chamadosManutencao.create({
        unidade: atual.unidade,
        unidadeNome: atual.unidadeNome,
        titulo: atual.titulo,
        descricao: atual.observacao,
        responsaveis,
        solicitacaoId: atual.id,
        numeroTicket: atual.numeroTicket,
        criadoPorEmail: req.user.email,
      });
      await solicitacoes.vincularChamado(atual.id, chamado.id);
      broadcast('chamado-manutencao-criado', { id: chamado.id }, 'manutencao');
    }
    broadcast('solicitacao-decidida', registro, 'solicitacoes');
    res.json({ ...registro, chamado, desbloqueado, avisoSenha });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// re-priorizacao na triagem (Master/Admin): muda a prioridade e recalcula o
// prazo de SLA a partir da criacao do ticket
app.patch('/api/solicitacoes/:id/prioridade', auth.requireMasterOrAdmin, async (req, res) => {
  try {
    const atual = await solicitacoes.getOne(req.params.id);
    if (!atual) return res.status(404).json({ error: 'Solicitação não encontrada.' });
    if (tipoBloqueado(req, atual.tipo)) return res.status(403).json({ error: 'Você não tem acesso a esse tipo de solicitação.' });
    const registro = await solicitacoes.atualizarPrioridade(req.params.id, req.body.prioridade);
    broadcast('solicitacao-decidida', registro, 'solicitacoes');
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/solicitacoes/:id/direcionar', auth.requireMaster, async (req, res) => {
  try {
    const atual = await solicitacoes.getOne(req.params.id);
    if (!atual) return res.status(404).json({ error: 'Solicitação não encontrada.' });
    if (tipoBloqueado(req, atual.tipo)) return res.status(403).json({ error: 'Você não tem acesso a esse tipo de solicitação.' });
    const registro = await solicitacoes.redirecionar(req.params.id, req.body);
    broadcast('solicitacao-decidida', registro, 'solicitacoes');
    notificarSeDirecionadoAoMV(registro.tipo, registro);
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// troca o tipo de um ticket dentro dos 5 tipos gerais (Compra, Manutenção,
// Suporte de TI, Pagamento, Nota) - ex: virou Pagamento apos a execucao do
// servico de Manutencao. Mesmo registro, so o tipo muda (ver solicitacoes.mudarTipo)
app.patch('/api/solicitacoes/:id/tipo', auth.requireMasterOrAdmin, async (req, res) => {
  try {
    const atual = await solicitacoes.getOne(req.params.id);
    if (!atual) return res.status(404).json({ error: 'Solicitação não encontrada.' });
    if (tipoBloqueado(req, atual.tipo) || tipoBloqueado(req, req.body.novoTipo)) {
      return res.status(403).json({ error: 'Você não tem acesso a esse tipo de solicitação.' });
    }
    const registro = await solicitacoes.mudarTipo(req.params.id, req.body.novoTipo, req.user.email);
    broadcast('solicitacao-decidida', registro, 'solicitacoes');
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// andamento de execucao (Pendente/Em andamento/Finalizado) de um ticket ja
// Aprovado - acompanha o trabalho de verdade depois da decisao, separado do
// status de aprovar/rejeitar (ver solicitacoes.atualizarExecucao)
app.patch('/api/solicitacoes/:id/execucao', auth.requireMasterOrAdmin, async (req, res) => {
  try {
    const atual = await solicitacoes.getOne(req.params.id);
    if (!atual) return res.status(404).json({ error: 'Solicitação não encontrada.' });
    if (tipoBloqueado(req, atual.tipo)) return res.status(403).json({ error: 'Você não tem acesso a esse tipo de solicitação.' });
    const registro = await solicitacoes.atualizarExecucao(req.params.id, req.body.execucaoStatus, { porNome: req.user.email });
    broadcast('solicitacao-decidida', registro, 'solicitacoes');
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// mesma logica pro Estorno (antes so os 5 tipos gerais tinham andamento de
// execucao) - ver refunds.atualizarExecucao/EXECUCAO_STATUSES
app.patch('/api/refund-requests/:id/execucao', auth.requireMasterOrAdmin, async (req, res) => {
  try {
    if (tipoBloqueado(req, 'estorno')) return res.status(403).json({ error: 'Você não tem acesso a esse tipo de solicitação.' });
    const registro = await refunds.atualizarExecucao(req.params.id, req.body.execucaoStatus, { porNome: req.user.email });
    broadcast('refund-request-changed', registro, 'monitor');
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// gera/revoga o link de acao compartilhavel (ver moduloTicket/gerarLinkAcao
// acima) - mesmo publico de quem decide/executa um ticket em app
app.post('/api/central/:tipo/:id/gerar-link', auth.requireMasterOrAdmin, async (req, res) => {
  try {
    if (tipoBloqueado(req, req.params.tipo)) return res.status(403).json({ error: 'Você não tem acesso a esse tipo de solicitação.' });
    const { linkAcao } = await moduloTicket(req.params.tipo).gerarLinkAcao(req.params.id);
    const url = `${APP_BASE_URL}/ticket-publico.html?tipo=${encodeURIComponent(req.params.tipo)}&ticket=${encodeURIComponent(req.params.id)}&link=${encodeURIComponent(linkAcao)}`;
    res.json({ url });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/central/:tipo/:id/revogar-link', auth.requireMasterOrAdmin, async (req, res) => {
  try {
    if (tipoBloqueado(req, req.params.tipo)) return res.status(403).json({ error: 'Você não tem acesso a esse tipo de solicitação.' });
    await moduloTicket(req.params.tipo).revogarLinkAcao(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// converte um ticket de Compra/Manutenção/Suporte de TI/Pagamento/Nota num
// pedido de Estorno (outra colecao) - mesmo numero de ticket, novo registro
// em refunds.js (ver solicitacoes.converterParaEstorno)
app.post('/api/solicitacoes/:id/converter-estorno', auth.requireMasterOrAdmin, async (req, res) => {
  try {
    const atual = await solicitacoes.getOne(req.params.id);
    if (!atual) return res.status(404).json({ error: 'Solicitação não encontrada.' });
    if (tipoBloqueado(req, atual.tipo) || tipoBloqueado(req, 'estorno')) {
      return res.status(403).json({ error: 'Você não tem acesso a esse tipo de solicitação.' });
    }
    const novo = await solicitacoes.converterParaEstorno(req.params.id, req.body, req.user.email);
    broadcast('solicitacao-decidida', await solicitacoes.getOne(req.params.id), 'solicitacoes');
    broadcast('refund-requested', novo, 'monitor');
    res.json(novo);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// edicao/exclusao direta pelo Master - corrigir um dado errado no pedido
// (titulo, valor, observacao, itens, unidade) ou remove-lo de vez da fila,
// independente do status
app.patch('/api/solicitacoes/:id', auth.requireMaster, async (req, res) => {
  try {
    const registro = await solicitacoes.update(req.params.id, req.body);
    broadcast('solicitacao-decidida', registro, 'solicitacoes');
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/solicitacoes/:id', auth.requireMaster, async (req, res) => {
  try {
    await solicitacoes.remove(req.params.id);
    broadcast('solicitacao-decidida', { id: req.params.id, excluido: true }, 'solicitacoes');
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// leitura unificada pra Central: junta Estorno (refunds.js) + Ajuste de
// Fechamento (fechamentosLive.js) + Compra/Manutenção/Suporte de TI
// (solicitacoes.js) num feed so, cada card ja normalizado no mesmo formato -
// cada usuario ve exatamente o que veria nas rotas individuais de cada tipo
// (Master ve tudo, loja ve so o que ela mesma pediu). A agregacao em si (sem
// filtro de permissao) mora em centralCards.js, reaproveitada tambem pelo
// relatorio diario do MV (relatorioMV.js) - ver aviso la no topo do arquivo
async function todosCardsCentral(req) {
  let cards = await centralCards.listarTodos();
  // so o Master enxerga tudo. Admin/qualquer outro usuario so ve o que
  // criou ou o que foi explicitamente atribuido a ele (👤 Atribuir
  // responsável, agora multi-pessoa) - Admin perdeu o bypass automatico
  if (!req.isMaster) {
    cards = cards.filter((c) =>
      c.criadoPorId === req.user.id ||
      c.direcionadoParaId === req.user.id ||
      (Array.isArray(c.atribuidosIds) && c.atribuidosIds.includes(req.user.id))
    );
  }
  const tiposPerm = tiposSolicitacaoPermitidos(req);
  if (tiposPerm) cards = cards.filter((c) => tiposPerm.has(c.tipo));
  cards.sort((a, b) => (b.criadoEm || '').localeCompare(a.criadoEm || ''));
  return cards;
}

// tecnico/manutencao tambem podem chamar - nao tem a secao "solicitacoes",
// mas podem ter sido atribuidos a um card (ver "Atribuir responsável",
// Master-only) e precisam conseguir abrir o Histórico pra ve-lo; a
// visibilidade real quem decide e todosCardsCentral() (so o que criou ou
// foi atribuido, exceto Master que ve tudo)
app.get('/api/central', requireAnySection('solicitacoes', 'manutencao', 'tecnico'), async (req, res) => {
  res.json(await todosCardsCentral(req));
});

// dispara o relatorio diario do MV na hora, pra testar (ver relatorioMV.js -
// mesmo relatorio que roda sozinho no horario configurado em RELATORIO_HORA)
app.get('/api/relatorio-mv/testar', auth.requireMaster, async (req, res) => {
  try {
    res.json(await relatorioMV.enviarRelatorio());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// pre-visualiza o relatorio (mesmo conteudo que seria enviado agora) SEM
// mandar e-mail nenhum - forma rapida do Master conferir sem precisar ir na
// caixa de entrada (ver relatorioMV.previewHtml)
app.get('/api/relatorio-mv/preview', auth.requireMaster, async (req, res) => {
  try {
    res.json(await relatorioMV.previewHtml());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// configuração do relatório diário/notificações (ver /email.html) - QUEM
// recebe (emailDestino) e QUAL usuário dispara o envio (usuarioGatilho,
// pelo username) - editável na hora pelo Master, sem precisar mexer em env
// var nem redeploy (ver relatorioMV.getConfig/salvarConfig)
app.get('/api/relatorio-config', auth.requireMaster, async (req, res) => {
  res.json(await relatorioMV.getConfig());
});

app.post('/api/relatorio-config', auth.requireMaster, async (req, res) => {
  try {
    const config = await relatorioMV.salvarConfig({
      emailDestino: req.body.emailDestino,
      emailCopia: req.body.emailCopia,
      usuarioGatilho: req.body.usuarioGatilho,
      horaEnvio: req.body.horaEnvio,
      diasSemana: req.body.diasSemana,
    });
    res.json(config);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// busca o card cru (de qualquer um dos 3 modulos) - usado no gate de acesso
// do chat/anexos (dono do pedido, atribuido, ou Master)
async function buscarCardCru(tipo, id) {
  if (tipo === 'estorno') {
    const r = await refunds.getOne(id);
    return r && { criadoPorId: r.requestedById, direcionadoParaId: r.direcionadoParaId, atribuidosIds: r.atribuidosIds };
  }
  if (tipo === 'ajuste-fechamento') {
    const r = await fechamentosLive.getEdicao(id);
    return r && { criadoPorId: r.solicitadoPorId, direcionadoParaId: r.direcionadoParaId, atribuidosIds: r.atribuidosIds };
  }
  // chat direto no CHAMADO (TI/Manutencao): quem enxerga o kanban conversa -
  // chatLivre libera o podeVerCard pra qualquer um que passou no guard de
  // secao da rota (tecnico/suporte/manutencao/Master)
  if (tipo === 'chamado-ti') {
    const r = await chamadosTI.getOne(id);
    return r && { criadoPorId: null, direcionadoParaId: r.tecnicoId, atribuidosIds: [], chatLivre: true };
  }
  if (tipo === 'chamado-manutencao') {
    const r = await chamadosManutencao.getOne(id);
    return r && { criadoPorId: null, direcionadoParaId: null, atribuidosIds: (r.responsaveis || []).map((x) => x.id), chatLivre: true };
  }
  const r = await solicitacoes.getOne(id);
  return r && { criadoPorId: r.criadoPorId, direcionadoParaId: r.direcionadoParaId, atribuidosIds: r.atribuidosIds };
}

// so o Master ve tudo; os demais (inclusive Admin) so o que criaram ou o
// que foi explicitamente atribuido a eles - mesmo criterio de
// todosCardsCentral(), usado tambem pro chat e pelos anexos/comprovante
function podeVerCard(req, card) {
  if (req.isMaster) return true;
  if (card.chatLivre) return true;
  if (card.criadoPorId === req.user.id) return true;
  if (card.direcionadoParaId === req.user.id) return true;
  if (Array.isArray(card.atribuidosIds) && card.atribuidosIds.includes(req.user.id)) return true;
  return false;
}

// chat de uma solicitacao da Central - quem criou o pedido, quem foi
// atribuido, ou o Master podem ver/participar (pra questionar antes de
// decidir, e pra quem pediu poder responder)
app.get('/api/central/:tipo/:id/chat', requireAnySection('solicitacoes', 'manutencao', 'tecnico', 'suporte'), async (req, res) => {
  try {
    const card = await buscarCardCru(req.params.tipo, req.params.id);
    if (!card) return res.status(404).json({ error: 'Solicitação não encontrada.' });
    if (!podeVerCard(req, card)) return res.sendStatus(404);
    if (!card.chatLivre && card.criadoPorId !== req.user.id && !req.isMaster && tipoBloqueado(req, req.params.tipo)) return res.sendStatus(404);
    res.json(await centralChat.listByCard(req.params.tipo, req.params.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/central/:tipo/:id/chat', requireAnySection('solicitacoes', 'manutencao', 'tecnico', 'suporte'), upload.single('imagem'), async (req, res) => {
  try {
    const card = await buscarCardCru(req.params.tipo, req.params.id);
    if (!card) return res.status(404).json({ error: 'Solicitação não encontrada.' });
    if (!podeVerCard(req, card)) return res.sendStatus(404);
    if (!card.chatLivre && card.criadoPorId !== req.user.id && !req.isMaster && tipoBloqueado(req, req.params.tipo)) return res.sendStatus(404);
    let imagem = null;
    if (req.file) {
      const path = await storage.salvarArquivo(req.params.id, req.file, 'central-chat');
      imagem = { nome: req.file.originalname, path, tipo: req.file.mimetype || 'application/octet-stream' };
    }
    const mensagem = await centralChat.addMessage({
      tipo: req.params.tipo,
      cardId: req.params.id,
      autorId: req.user.id,
      autorEmail: req.user.email,
      autorUsername: req.user.username || null,
      texto: req.body.texto,
      imagem,
    });
    // chat de CHAMADO alcanca as pontas certas (tecnico/suporte/manutencao),
    // que nao necessariamente tem a secao 'solicitacoes'
    if (req.params.tipo === 'chamado-ti') {
      broadcast('central-chat-nova', mensagem, 'tecnico');
      broadcast('central-chat-nova', mensagem, 'suporte');
    } else if (req.params.tipo === 'chamado-manutencao') {
      broadcast('central-chat-nova', mensagem, 'manutencao');
    } else {
      broadcast('central-chat-nova', mensagem, 'solicitacoes');
    }
    res.json(mensagem);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// foto anexada a uma mensagem do chat - mesmo gate de acesso do card (dono
// do pedido, atribuido, ou Master), resolvido a partir do card que a
// mensagem pertence
app.get('/api/central/chat/foto/:messageId', requireAnySection('solicitacoes', 'manutencao', 'tecnico', 'suporte'), async (req, res) => {
  const mensagem = await centralChat.getMessage(req.params.messageId);
  if (!mensagem || !mensagem.imagem) return res.sendStatus(404);
  const card = await buscarCardCru(mensagem.tipo, mensagem.cardId);
  if (!card || !podeVerCard(req, card)) return res.sendStatus(404);
  storage.streamArquivo(mensagem.imagem.path, mensagem.imagem.tipo, res);
});

// sinaliza que um Master/Admin ja viu a notificacao (popup com som) de uma
// solicitação nova - basta UM sinalizar pra ela parar de tocar/aparecer pros
// outros tambem (ver mostrarNotificacaoSolicitacao em painel.html/
// central-historico.html); nao decide a solicitação, so acusa recebimento
app.post('/api/central/:tipo/:id/marcar-visto', auth.requireMasterOrAdmin, async (req, res) => {
  try {
    const { tipo, id } = req.params;
    let registro;
    const vistoPorEmail = req.user.email;
    const vistoPorUsername = req.user.username || null;
    if (tipo === 'estorno') registro = await refunds.marcarNotificacaoVista(id, { vistoPorEmail, vistoPorUsername });
    else if (tipo === 'ajuste-fechamento') registro = await fechamentosLive.marcarNotificacaoVistaEdicao(id, { vistoPorEmail, vistoPorUsername });
    else registro = await solicitacoes.marcarNotificacaoVista(id, { vistoPorEmail, vistoPorUsername });
    broadcast('central-notificacao-vista', { tipo, id, vistoPorEmail, vistoPorUsername }, 'solicitacoes');
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// envio manual (sob demanda) de 1 ou mais tickets por e-mail pra um
// destinatario qualquer (fornecedor, gerente etc.) - Master/Admin decide na
// hora quem recebe, sem fluxo de decisao por e-mail (isso e so informativo,
// ver relatorioMV.enviarCardsPorEmail). Reaproveita todosCardsCentral(req)
// pra so deixar enviar tickets que o usuario logado ja pode ver
app.post('/api/central/enviar-email', auth.requireMasterOrAdmin, async (req, res) => {
  try {
    const { tickets, destinatario } = req.body;
    if (!destinatario) return res.status(400).json({ error: 'Informe o e-mail de destino.' });
    if (!Array.isArray(tickets) || !tickets.length) return res.status(400).json({ error: 'Selecione ao menos um ticket.' });
    const todos = await todosCardsCentral(req);
    const cards = tickets
      .map(({ tipo, id }) => todos.find((c) => c.tipo === tipo && c.id === id))
      .filter(Boolean);
    if (!cards.length) return res.status(404).json({ error: 'Ticket(s) não encontrado(s).' });
    await relatorioMV.enviarCardsPorEmail(cards, destinatario);
    res.json({ enviados: cards.length });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// apagar mensagem - so o Master (nao o Admin, que so participa da conversa)
app.delete('/api/central/:tipo/:id/chat/:messageId', auth.requireMaster, async (req, res) => {
  try {
    await centralChat.removeMessage(req.params.messageId);
    broadcast('central-chat-removida', { tipo: req.params.tipo, cardId: req.params.id, messageId: req.params.messageId }, 'solicitacoes');
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- relatorio (CSV/PDF) do quadro Kanban de central-historico.html -
// mesmos filtros de loja/grupo/data ativos na tela ----------
const ARCFOOD_UNIDADES_CODIGOS = new Set(['19821', '19855', '19888', '19889']);
function grupoDaUnidadeServer(u) { return ARCFOOD_UNIDADES_CODIGOS.has(u) ? 'ARCFOOD' : 'Grupo Bravo (GBE)'; }
const TIPOS_CENTRAL_LABEL = { estorno: 'Estorno', 'ajuste-fechamento': 'Ajuste de fechamento', compra: 'Compra', manutencao: 'Manutenção', 'suporte-ti': 'Suporte de TI' };

function filtrarCardsCentral(cards, req) {
  const { unidade, grupo, dataDe, dataAte, tipo } = req.query;
  // "tipo" aceita 1 ou varios separados por virgula (a tela permite marcar
  // mais de um tipo ao mesmo tempo pelo check no canto do botao de filtro)
  const tipos = tipo ? String(tipo).split(',').filter(Boolean) : [];
  return cards.filter((c) => {
    const dataBrasilia = (c.criadoEm || '').slice(0, 10);
    return (!unidade || c.unidade === unidade) &&
      (!grupo || grupoDaUnidadeServer(c.unidade) === grupo) &&
      (!dataDe || dataBrasilia >= dataDe) &&
      (!dataAte || dataBrasilia <= dataAte) &&
      (!tipos.length || tipos.includes(c.tipo));
  });
}

// junta os itens da lista de compra (descricao + qtd) numa unica string pra
// caber numa celula de tabela - mesmo formato "descricao · qtd. N" usado no
// modal de detalhe (central-historico.html), so que numa linha so
function formatarItensCompra(itens) {
  if (!Array.isArray(itens) || !itens.length) return '—';
  return itens.map((i) => i.quantidade != null && i.quantidade !== '' ? `${i.descricao} · qtd. ${i.quantidade}` : i.descricao).join('; ');
}

function prepararRelatorioCentral(cards) {
  const colunas = [
    { key: 'tipo', label: 'Tipo' }, { key: 'unidade', label: 'Unidade' }, { key: 'titulo', label: 'Título' },
    { key: 'itens', label: 'Itens' },
    { key: 'valor', label: 'Valor' }, { key: 'status', label: 'Status' }, { key: 'criadoPor', label: 'Criado por' }, { key: 'criadoEm', label: 'Criado em' },
    { key: 'decididoPor', label: 'Decidido por' }, { key: 'decididoEm', label: 'Decidido em' }, { key: 'motivoDecisao', label: 'Motivo da decisão' },
  ];
  const linhas = cards.map((c) => ({
    tipo: TIPOS_CENTRAL_LABEL[c.tipo] || c.tipo, unidade: c.unidadeNome || c.unidade || '—', titulo: c.titulo || '—',
    itens: formatarItensCompra(c.itens),
    valor: c.valorEstimado != null ? reportUtil.fmtMoneyBR(c.valorEstimado) : '—',
    status: c.status, criadoPor: c.criadoPorEmail || '—', criadoEm: reportUtil.fmtDataHoraBR(c.criadoEm),
    decididoPor: c.decididoPorEmail || '—', decididoEm: reportUtil.fmtDataHoraBR(c.decididoEm), motivoDecisao: c.motivoDecisao || '—',
  }));
  return { colunas, linhas };
}

// Titulo e Itens sao os campos mais lidos do relatorio (o que identifica o
// pedido e o que precisa ser comprado), por isso ganham bem mais largura que
// o padrao uniforme - as demais colunas perdem espaco proporcionalmente,
// sobretudo Decidido por/em e Motivo, que costumam vir "-" enquanto o ticket
// ainda esta pendente
const LARGURAS_RELATORIO_CENTRAL = {
  tipo: 55, unidade: 62, titulo: 135, itens: 125, valor: 48, status: 52,
  criadoPor: 80, criadoEm: 60, decididoPor: 50, decididoEm: 42, motivoDecisao: 40,
};

app.get('/api/central/relatorio.:formato(csv|pdf)', requireSection('solicitacoes'), async (req, res) => {
  const cards = filtrarCardsCentral(await todosCardsCentral(req), req);
  const { colunas, linhas } = prepararRelatorioCentral(cards);
  // nome do arquivo reflete o filtro de tipo ativo na tela (ex: "Compra" ->
  // solicitacoes-compra-2026-08-07.csv), nao um "central-solicitacoes.csv"
  // generico que nao diz se e de tudo ou so de um tipo
  const tiposArquivo = req.query.tipo ? String(req.query.tipo).split(',').filter(Boolean) : [];
  const baseArquivo = tiposArquivo.length
    ? `solicitacoes-${tiposArquivo.map((t) => TIPOS_CENTRAL_LABEL[t] || t).join('-')}`
    : 'central-solicitacoes-todas';
  const nomeArquivo = reportUtil.nomeArquivoComData(baseArquivo);
  if (req.params.formato === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}.csv"`);
    return res.send(reportUtil.toCSV(colunas, linhas));
  }
  // linhasDinamicas: a linha cresce pra baixo ate mostrar a lista de itens
  // inteira (e qualquer outra celula longa), em vez de cortar com "..."
  reportUtil.writePDF(res, { titulo: 'Central de Solicitações · Histórico', subtitulo: `Exportado em ${reportUtil.agoraBrasiliaFmt()} · ${linhas.length} solicitação(ões)`, colunas, linhas, larguras: LARGURAS_RELATORIO_CENTRAL, nomeArquivo, linhasDinamicas: true });
});

// casa a lista de itens (descricao + "tem foto?") mandada em payload.itens
// com os arquivos que vieram no upload, na mesma ordem - usado no check-in
// ("antes") e na finalizacao ("depois") tanto de Chamados de TI quanto de
// Manutencao (mesmo padrao de lista dinamica das pecas/maquininhas)
async function processarItensComFoto(itensMeta, arquivos, chamadoId, pastaStorage) {
  const restantes = [...(arquivos || [])];
  const itens = [];
  for (const meta of (Array.isArray(itensMeta) ? itensMeta : [])) {
    let foto = null;
    if (meta && meta.temFoto && restantes.length) {
      const file = restantes.shift();
      const path = await storage.salvarArquivo(chamadoId, file, pastaStorage);
      foto = { nome: file.originalname, path, tipo: file.mimetype || 'application/octet-stream' };
    }
    itens.push({ descricao: meta && meta.descricao, foto });
  }
  return itens;
}

// avarias da Contagem do Abastecimento: mesmo casamento por ordem de
// processarItensComFoto (acima), mas preservando insumoId/quantidade/
// observacao em vez de so descricao - a rota /api/abastecimento chama isso
// antes de mandar a lista pra abastecimentoCarrinho.criar()
async function processarAvariasComFoto(itensMeta, arquivos) {
  const restantes = [...(arquivos || [])];
  const itens = [];
  for (const meta of (Array.isArray(itensMeta) ? itensMeta : [])) {
    let foto = null;
    if (meta && meta.temFoto && restantes.length) {
      const file = restantes.shift();
      const path = await storage.salvarArquivo('contagem', file, 'abastecimento-avarias');
      foto = { nome: file.originalname, path, tipo: file.mimetype || 'application/octet-stream' };
    }
    itens.push({ insumoId: meta && meta.insumoId, quantidade: meta && meta.quantidade, observacao: meta && meta.observacao, foto });
  }
  return itens;
}

async function processarAssinatura(file, chamadoId, pastaStorage) {
  if (!file) return null;
  const path = await storage.salvarArquivo(chamadoId, file, pastaStorage);
  return { nome: file.originalname, path, tipo: file.mimetype || 'image/png' };
}

// ---------- Chamados de TI - duas modalidades (ver chamadosTI.js):
// 'presencial' (tecnico vai a loja, check-in/checkout) e 'remoto' (time de
// Suporte resolve a distancia, pode nascer ja concluido pra registro
// retroativo). Visibilidade: Master/Admin ve tudo; quem tem a secao
// "suporte" ve todos os remotos + os atribuidos a ele; tecnico (secao
// "tecnico") ve so os atribuidos a ele. Nasce vinculado a uma solicitacao
// de Suporte de TI aprovada (rota acima) ou aberto direto pelo
// Master/Admin/Suporte (POST abaixo) ----------
function ehTimeSuporte(req) {
  return req.isMaster || req.isAdmin || auth.hasSection(req, 'suporte');
}

app.get('/api/chamados', requireAnySection('tecnico', 'suporte'), async (req, res) => {
  const todos = await chamadosTI.listAll();
  if (req.isMaster || req.isAdmin) return res.json(todos);
  if (auth.hasSection(req, 'suporte')) {
    return res.json(todos.filter((c) => chamadosTI.modalidadeDe(c) === 'remoto' || c.tecnicoId === req.user.id));
  }
  res.json(todos.filter((c) => c.tecnicoId === req.user.id));
});

// abertura direta de chamado - SEMPRE nasce remoto (triagem), sem excecao;
// Master/Admin escolhe o responsavel, o time de Suporte abre sempre no
// proprio nome - o objetivo e nunca perder registro de atuacao ("abrir e ja
// fechar" via jaResolvido + observacaoResolucao). Escalar pra presencial e um
// passo separado, depois da triagem (ver POST /api/chamados/:id/escalar-presencial)
app.post('/api/chamados', auth.requireAuth, async (req, res) => {
  try {
    if (!ehTimeSuporte(req)) return res.status(403).json({ error: 'Você não tem acesso a essa área.' });
    const { unidade, unidadeNome, titulo, descricao, tecnicoId, tecnicoEmail, prioridade, jaResolvido, observacaoResolucao } = req.body;
    const ehGestor = req.isMaster || req.isAdmin;
    const chamado = await chamadosTI.create({
      unidade,
      unidadeNome,
      titulo,
      descricao,
      prioridade,
      jaResolvido,
      observacaoResolucao,
      tecnicoId: ehGestor ? (tecnicoId || req.user.id) : req.user.id,
      tecnicoEmail: ehGestor ? (tecnicoId ? tecnicoEmail : req.user.email) : req.user.email,
      criadoPorEmail: req.user.email,
    });
    broadcast('chamado-criado', { id: chamado.id }, 'tecnico');
    res.json(chamado);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- Inventario de ATIVOS DE TI das lojas (secao 'ativos-ti') ----------
// o tecnico que visita a loja registra a vistoria (areas Loja/Rack, item +
// quantidade + observacao); o inventario atual = vistoria mais recente.
// Master concede a secao pro tecnico; Master/Admin sempre podem
app.get('/api/ativos-ti', requireSection('ativos-ti'), async (req, res) => {
  res.json(await ativosTI.listAll());
});

app.post('/api/ativos-ti', requireSection('ativos-ti'), async (req, res) => {
  try {
    const registro = await ativosTI.criar({
      unidade: req.body.unidade,
      unidadeNome: req.body.unidadeNome,
      areas: req.body.areas,
      observacao: req.body.observacao,
      criadoPorEmail: req.user.email,
      criadoPorNome: req.user.username || req.user.email,
    });
    broadcast('ativos-ti-atualizado', { id: registro.id });
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/ativos-ti/:id', auth.requireMaster, async (req, res) => {
  try {
    await ativosTI.remover(req.params.id);
    broadcast('ativos-ti-atualizado', { id: req.params.id, excluido: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- Abastecimento do carrinho Dominos Aeroporto - o CARRINHO abre
// um PEDIDO de pizzas/insumos e a LOJA registra o ENVIO (de preferencia
// vinculado ao pedido que atende). Substitui o AppSheet/planilha
// "AbastecimentoCarrinho". Permissao POR PONTA: a secao
// 'abastecimento-carrinho' e de quem PEDE (carrinho) e a
// 'abastecimento-loja' de quem ENVIA (loja) - Master/Admin fazem os dois.
// O broadcast vai sem filtro de secao porque as duas pontas tem secoes
// diferentes e o payload e so { id } ----------
function podePedirAbastecimento(req) {
  return req.isAdmin || auth.hasSection(req, 'abastecimento-carrinho');
}
function podeEnviarAbastecimento(req) {
  return req.isAdmin || auth.hasSection(req, 'abastecimento-loja');
}

// leitura: qualquer ponta - e tambem Master/Admin (indicadores no Painel)
app.get('/api/abastecimento', auth.requireAuth, async (req, res) => {
  if (!podePedirAbastecimento(req) && !podeEnviarAbastecimento(req)) {
    return res.status(403).json({ error: 'Você não tem acesso a essa área.' });
  }
  res.json(await abastecimentoCarrinho.listAll());
});

// operador bloqueou AGORA (3 senhas erradas): gera o ticket pro Master
// desbloquear - a pessoa do balcao nao precisa correr atras de ninguem
async function abrirTicketBloqueioOperador(op, req) {
  try {
    const registro = await solicitacoes.create({
      tipo: 'suporte-ti',
      unidade: "Domino's Carrinho Aeroporto Recife",
      unidadeNome: 'Dom Car Aero Recife',
      titulo: `Abastecimento: desbloquear operador @${op.usuario}`,
      observacao: `O operador local @${op.usuario}${op.nome ? ` (${op.nome})` : ''} do Abastecimento do Carrinho foi bloqueado após 3 senhas erradas.\n\nSó o Master desbloqueia: página Abastecimento → 👥 Operadores → 🔓 desbloquear (dá pra manter a mesma senha ou definir uma nova de 4 números).`,
      prioridade: 'alta',
      criadoPorId: req.user?.id || null,
      criadoPorEmail: req.user?.email || 'abastecimento (bloqueio automático)',
      direcionadoParaId: null,
      direcionadoParaEmail: null,
    });
    broadcast('solicitacao-criada', registro, 'solicitacoes');
    push.notifySolicitacao(`Ticket #${registro.numeroTicket} · Operador bloqueado (Abastecimento)`, `@${op.usuario} · 3 senhas erradas — Master desbloqueia`, registro.id);
  } catch (e) {
    console.error('Falha ao abrir ticket de bloqueio de operador:', e.message);
  }
}

// CONTAGEM manda AVARIAS com foto opcional por item -> vem multipart (campo
// "payload" com o JSON + arquivos em "fotosAvarias"); PEDIDO/ENVIO continuam
// JSON puro, sem avarias. upload.array() so mexe quando o content-type e
// multipart - request JSON passa direto (req.body ja populado pelo
// express.json de sempre), entao os dois formatos convivem na mesma rota.
app.post('/api/abastecimento', auth.requireAuth, upload.array('fotosAvarias', 20), async (req, res) => {
  try {
    const body = req.is('multipart/form-data') ? JSON.parse(req.body.payload || '{}') : req.body;
    // CONTAGEM e o inventario do turno do carrinho - mesma ponta de quem pede
    if ((body.tipo === 'PEDIDO' || body.tipo === 'CONTAGEM') && !podePedirAbastecimento(req)) {
      return res.status(403).json({ error: 'Você não tem a permissão de PEDIDO (lado do carrinho).' });
    }
    if (body.tipo === 'ENVIO' && !podeEnviarAbastecimento(req)) {
      return res.status(403).json({ error: 'Você não tem a permissão de ENVIO (lado da loja).' });
    }
    // login LOCAL de operador (4 letras + 4 numeros, cadastrado na propria
    // pagina): obrigatorio em todo lancamento, e o papel do operador tem
    // que bater com o tipo - e a assinatura de QUEM fez, no balcao
    const operador = await abastecimentoCarrinho.validarOperador({
      usuario: body.operadorUsuario,
      senha: body.operadorSenha,
      papel: body.tipo === 'ENVIO' ? 'envio' : 'pedido',
    });
    const avarias = await processarAvariasComFoto(body.avarias, req.files);
    const registro = await abastecimentoCarrinho.criar({
      operador,
      tipo: body.tipo,
      pizzas: body.pizzas,
      insumos: body.insumos,
      avarias,
      observacao: body.observacao,
      atendePedidoId: body.atendePedidoId,
      jaRecebido: body.jaRecebido,
      criadoPorId: req.user.id,
      criadoPorEmail: req.user.email,
      criadoPorNome: req.user.username || req.user.email,
    });
    broadcast('abastecimento-atualizado', { id: registro.id, tipo: registro.tipo });
    if (registro.tipo === 'PEDIDO') {
      // aviso operacional do balcao: vai so pra quem opera a loja (secao
      // abastecimento-loja) - Master/Admin nao recebem esse push
      push.notifyAbastecimento(
        registro.jaRecebido ? '📦 Pedido já entregue — só dar baixa' : '🛒 Carrinho pediu abastecimento',
        registro.jaRecebido ? `${registro.criadoPorNome} · lançamento atrasado, o material já chegou` : `${registro.criadoPorNome} · pizzas/insumos aguardando envio`,
        registro.id, 'abastecimento-loja',
      );
    }
    res.json(registro);
  } catch (err) {
    if (err.operadorBloqueado) abrirTicketBloqueioOperador(err.operadorBloqueado, req);
    res.status(400).json({ error: err.message, papelErrado: !!err.papelErrado });
  }
});

// foto de uma avaria da Contagem - mesmo guard de leitura do GET /api/abastecimento
app.get('/api/abastecimento/avaria-foto/:id/:index', auth.requireAuth, async (req, res) => {
  if (!podePedirAbastecimento(req) && !podeEnviarAbastecimento(req)) return res.sendStatus(403);
  const registro = await abastecimentoCarrinho.getOne(req.params.id);
  if (!registro) return res.sendStatus(404);
  const foto = (registro.avarias || [])[Number(req.params.index)]?.foto;
  if (!foto) return res.sendStatus(404);
  storage.streamArquivo(foto.path, foto.tipo, res);
});

// "Ja lancei" do pedido retroativo ("ja recebi"): a loja confirma que o
// envio ja tinha sido registrado antes - fecha o ciclo SEM criar envio
// duplicado. Exige a senha do operador (papel envio), como todo lancamento
app.post('/api/abastecimento/:id/ja-lancei', auth.requireAuth, async (req, res) => {
  try {
    if (!podeEnviarAbastecimento(req)) return res.status(403).json({ error: 'Você não tem a permissão de ENVIO (lado da loja).' });
    const operador = await abastecimentoCarrinho.validarOperador({
      usuario: req.body.operadorUsuario,
      senha: req.body.operadorSenha,
      papel: 'envio',
    });
    const registro = await abastecimentoCarrinho.marcarJaLancado(req.params.id, { operador });
    broadcast('abastecimento-atualizado', { id: registro.id });
    res.json(registro);
  } catch (err) {
    if (err.operadorBloqueado) abrirTicketBloqueioOperador(err.operadorBloqueado, req);
    res.status(400).json({ error: err.message, papelErrado: !!err.papelErrado });
  }
});

// OK do popup de pedido novo (lado da loja): para o alarme e sinaliza pro
// carrinho que a loja ja viu o pedido
app.post('/api/abastecimento/:id/visto', auth.requireAuth, async (req, res) => {
  try {
    if (!podeEnviarAbastecimento(req)) return res.status(403).json({ error: 'Você não tem a permissão de ENVIO (lado da loja).' });
    const registro = await abastecimentoCarrinho.marcarVisto(req.params.id, { email: req.user.email, nome: req.user.username || req.user.email });
    broadcast('abastecimento-atualizado', { id: registro.id });
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// loja marca "SENDO PREPARADO" (o retorno que o carrinho espera; sem isso em
// 5min apos o visto, o lado da loja recebe o popup de PEDIDO ATRASADO)
app.post('/api/abastecimento/:id/preparo', auth.requireAuth, async (req, res) => {
  try {
    if (!podeEnviarAbastecimento(req)) return res.status(403).json({ error: 'Você não tem a permissão de ENVIO (lado da loja).' });
    const registro = await abastecimentoCarrinho.marcarPreparo(req.params.id, { email: req.user.email, nome: req.user.username || req.user.email });
    broadcast('abastecimento-atualizado', { id: registro.id });
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// conversa lateral do pedido (carrinho <-> loja). A ponta e derivada da
// permissao de quem escreve; Master/Admin (que tem as duas) escolhe no body
app.post('/api/abastecimento/:id/mensagem', auth.requireAuth, async (req, res) => {
  try {
    const pede = podePedirAbastecimento(req);
    const envia = podeEnviarAbastecimento(req);
    if (!pede && !envia) return res.status(403).json({ error: 'Você não tem acesso a essa área.' });
    const de = pede && !envia ? 'carrinho' : (envia && !pede ? 'loja' : (req.body.de === 'carrinho' ? 'carrinho' : 'loja'));
    const registro = await abastecimentoCarrinho.adicionarMensagem(req.params.id, {
      de,
      texto: req.body.texto,
      autorEmail: req.user.email,
      autorNome: req.user.username || req.user.email,
    });
    broadcast('abastecimento-atualizado', { id: registro.id });
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// SO MASTER: encerra a conversa do pedido (some do seletor do chip pra
// todo mundo e nao aceita mais mensagem - o historico continua no registro)
app.post('/api/abastecimento/:id/conversa-encerrar', auth.requireAuth, auth.requireMaster, async (req, res) => {
  try {
    const registro = await abastecimentoCarrinho.encerrarConversa(req.params.id, { porEmail: req.user.email });
    broadcast('abastecimento-atualizado', { id: registro.id });
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// SO MASTER: baixa a conversa do pedido em PDF (registro/evidencia antes de
// encerrar, ou de conversa ja encerrada)
app.get('/api/abastecimento/:id/conversa.pdf', auth.requireAuth, auth.requireMaster, async (req, res) => {
  const reg = await abastecimentoCarrinho.getOne(req.params.id);
  if (!reg || reg.tipo !== 'PEDIDO') return res.status(404).json({ error: 'Pedido não encontrado.' });
  const mensagens = reg.mensagens || [];
  reportUtil.writePDF(res, {
    titulo: `Conversa do pedido · ${reportUtil.fmtDataHoraBR(reg.criadoEm)}`,
    subtitulo: `Pedido de ${reg.criadoPorNome || '?'} · ${mensagens.length} mensagem(ns)`
      + (reg.conversaEncerrada ? ` · conversa encerrada por ${reg.conversaEncerradaPorEmail || 'Master'} em ${reportUtil.fmtDataHoraBR(reg.conversaEncerradaEm)}` : '')
      + ` · gerado em ${reportUtil.agoraBrasiliaFmt()}`,
    colunas: [
      { key: 'hora', label: 'Hora' },
      { key: 'quem', label: 'Quem' },
      { key: 'texto', label: 'Mensagem' },
    ],
    larguras: { hora: 100, quem: 170, texto: 480 },
    linhas: mensagens.map((m) => ({
      hora: reportUtil.fmtDataHoraBR(m.em),
      quem: `${m.de === 'loja' ? 'Loja' : 'Carrinho'}${m.autorNome ? ' · ' + m.autorNome : ''}`,
      texto: m.texto || '',
    })),
    semDadosMsg: 'Sem mensagens nessa conversa.',
    nomeArquivo: reportUtil.nomeArquivoComData(`conversa-pedido-${(reg.criadoEm || '').slice(0, 10)}`),
  });
});

// confirmacao de recebimento pelo carrinho: o envio nao finaliza sozinho -
// quem recebe confere quantidades (falta diminui/zera; "a mais" que o
// pedido exige confirmacao explicita)
app.post('/api/abastecimento/:id/recebimento', auth.requireAuth, async (req, res) => {
  try {
    if (!podePedirAbastecimento(req)) return res.status(403).json({ error: 'Você não tem a permissão de PEDIDO (lado do carrinho).' });
    const registro = await abastecimentoCarrinho.confirmarRecebimento(req.params.id, {
      pizzas: req.body.pizzas,
      insumos: req.body.insumos,
      confirmaExtras: !!req.body.confirmaExtras,
      porEmail: req.user.email,
      porNome: req.user.username || req.user.email,
    });
    broadcast('abastecimento-atualizado', { id: registro.id });
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// recebimento que NAO bate e o popup nao resolve (chegou item fora da
// lista do envio, ou o "a mais" registrado nao e o que chegou de verdade):
// encerra a conferencia como DIVERGENCIA e gera um Ticket de analise
app.post('/api/abastecimento/:id/divergencia', auth.requireAuth, async (req, res) => {
  try {
    if (!podePedirAbastecimento(req)) return res.status(403).json({ error: 'Você não tem a permissão de PEDIDO (lado do carrinho).' });
    const envio = await abastecimentoCarrinho.getOne(req.params.id);
    if (!envio || envio.tipo !== 'ENVIO') return res.status(404).json({ error: 'Envio não encontrado.' });
    if (envio.recebidoEm) return res.status(400).json({ error: 'Esse envio já foi conferido.' });
    const MOTIVOS = {
      'extras-nao-conferem': 'o "a mais" registrado no envio NÃO é o que chegou',
      'itens-fora-da-lista': 'chegaram itens que não estão na lista do envio',
    };
    const motivo = MOTIVOS[req.body.motivo] ? req.body.motivo : 'divergencia';
    const enviouTxt = abastecimentoCarrinho.SABORES
      .filter((s) => Number(envio.pizzas?.[s]) > 0).map((s) => `${envio.pizzas[s]} ${s}`)
      .concat((envio.insumos || []).map((i) => i.insumoId ? `${i.nome} (${i.quantidade} ${i.embalagem === 'caixa' ? 'cx' : 'un'})` : i.descricao))
      .join(', ') || '—';
    const detalhe = String(req.body.detalhe || '').trim().slice(0, 500);
    const ticket = await solicitacoes.create({
      tipo: 'suporte-ti',
      unidade: "Domino's Carrinho Aeroporto Recife",
      unidadeNome: 'Dom Car Aero Recife',
      titulo: `Abastecimento: divergência no recebimento (envio ${new Date(envio.criadoEm).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })})`,
      observacao: `O carrinho NÃO conseguiu bater o recebimento com o envio registrado.\n\nProblema: ${MOTIVOS[motivo] || 'divergência no recebimento'}.\nEnvio registrado: ${enviouTxt}.\nOperador do envio: ${envio.operadorUsuario ? '@' + envio.operadorUsuario : envio.criadoPorNome || '—'}.\nQuem conferiu no carrinho: ${req.user.username || req.user.email}.${detalhe ? `\nDetalhe informado: ${detalhe}` : ''}\n\nAnalisar o lançamento na página Abastecimento (Movimentações) e ajustar com a equipe.`,
      prioridade: 'alta',
      criadoPorId: req.user.id,
      criadoPorEmail: req.user.email,
      direcionadoParaId: null,
      direcionadoParaEmail: null,
    });
    broadcast('solicitacao-criada', ticket, 'solicitacoes');
    push.notifySolicitacao(`Ticket #${ticket.numeroTicket} · Divergência no Abastecimento`, `${MOTIVOS[motivo] || 'recebimento não bate com o envio'}`, ticket.id);
    const registro = await abastecimentoCarrinho.registrarDivergencia(req.params.id, {
      motivo,
      detalhe,
      numeroTicket: ticket.numeroTicket,
      porEmail: req.user.email,
      porNome: req.user.username || req.user.email,
    });
    broadcast('abastecimento-atualizado', { id: registro.id });
    res.json({ registro, numeroTicket: ticket.numeroTicket });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// pedir CORRECAO de um lancamento (pedido OU envio): quantidade errada,
// envio fora do tempo, qualquer imprevisto - abre um Ticket pro Master na
// Central e marca o card com o numero (as duas pontas podem pedir)
app.post('/api/abastecimento/:id/pedir-correcao', auth.requireAuth, async (req, res) => {
  try {
    if (!podePedirAbastecimento(req) && !podeEnviarAbastecimento(req)) {
      return res.status(403).json({ error: 'Você não tem acesso a essa área.' });
    }
    const reg = await abastecimentoCarrinho.getOne(req.params.id);
    if (!reg || !['PEDIDO', 'ENVIO', 'CONTAGEM'].includes(reg.tipo)) return res.status(404).json({ error: 'Lançamento não encontrado.' });
    if (reg.correcao && reg.correcao.numeroTicket && (reg.correcao.status || 'pendente') === 'pendente') {
      return res.status(400).json({ error: `Já existe um pedido de correção em análise pra esse lançamento (Ticket #${reg.correcao.numeroTicket}).` });
    }
    const motivo = String(req.body.motivo || '').trim().slice(0, 500);
    if (!motivo) return res.status(400).json({ error: 'Descreva a justificativa da correção.' });
    // assinatura obrigatoria: QUALQUER operador de balcao (pede ou envia)
    // autentica com usuario+senha pra confirmar o pedido de correcao
    const operador = await abastecimentoCarrinho.validarOperadorQualquerPapel({
      usuario: req.body.operadorUsuario,
      senha: req.body.operadorSenha,
    });
    const acao = req.body.acao === 'remover' ? 'remover' : 'alterar';
    const itensTxtDe = (pizzas, insumos) => abastecimentoCarrinho.SABORES
      .filter((s) => Number(pizzas?.[s]) > 0).map((s) => `${pizzas[s]} ${s}`)
      .concat((insumos || []).filter((i) => Number(i.quantidade) > 0)
        .map((i) => i.insumoId ? `${i.nome || i.insumoId} (${i.quantidade} ${i.embalagem === 'caixa' ? 'cx' : 'un'})` : `${i.descricao || ''} (${i.quantidade})`))
      .join(', ') || '—';
    const enviadoTxt = itensTxtDe(reg.pizzas, reg.insumos);
    const propostaTxt = acao === 'remover' ? 'REMOVER o lançamento inteiro' : itensTxtDe(req.body.pizzas, req.body.insumos);
    const quando = new Date(reg.criadoEm).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const ticket = await solicitacoes.create({
      tipo: 'suporte-ti',
      unidade: "Domino's Carrinho Aeroporto Recife",
      unidadeNome: 'Dom Car Aero Recife',
      titulo: `Abastecimento: correção solicitada (${reg.tipo} de ${quando})`,
      observacao: `Correção pedida pelo operador ${operador.nome || operador.usuario} (@${operador.usuario}), na sessão de ${req.user.username || req.user.email}.\n\nLançamento: ${reg.tipo} de ${quando}, por ${reg.operadorNome || reg.criadoPorNome || '—'}${reg.operadorUsuario ? ' (@' + reg.operadorUsuario + ')' : ''}.\nLançado: ${enviadoTxt}\nProposta: ${propostaTxt}\n\nJustificativa: ${motivo}\n\nAprovar ou recusar direto no card, na tela do Abastecimento.`,
      prioridade: 'alta',
      criadoPorId: req.user.id,
      criadoPorEmail: req.user.email,
      direcionadoParaId: null,
      direcionadoParaEmail: null,
    });
    broadcast('solicitacao-criada', ticket, 'solicitacoes');
    push.notifySolicitacao(`Ticket #${ticket.numeroTicket} · Correção no Abastecimento`, `${acao === 'remover' ? 'Remover lançamento' : 'Alterar quantidades'} — ${motivo.slice(0, 100)}`, ticket.id);
    const registro = await abastecimentoCarrinho.registrarPedidoCorrecao(req.params.id, {
      acao,
      propostaPizzas: req.body.pizzas,
      propostaInsumos: req.body.insumos,
      motivo,
      numeroTicket: ticket.numeroTicket,
      porEmail: req.user.email,
      porNome: req.user.username || req.user.email,
      operador,
    });
    broadcast('abastecimento-atualizado', { id: registro.id });
    res.json({ registro, numeroTicket: ticket.numeroTicket });
  } catch (err) {
    if (err.operadorBloqueado) abrirTicketBloqueioOperador(err.operadorBloqueado, req);
    res.status(400).json({ error: err.message });
  }
});

// decisao do Master: aprovar aplica a proposta (altera quantidades ou
// remove o lancamento); recusar so registra a recusa no card
app.post('/api/abastecimento/:id/correcao/decidir', auth.requireMaster, async (req, res) => {
  try {
    const resultado = await abastecimentoCarrinho.decidirCorrecao(req.params.id, {
      aprovar: !!req.body.aprovar,
      porEmail: req.user.email,
      porNome: req.user.username || req.user.email,
    });
    broadcast('abastecimento-atualizado', { id: req.params.id });
    res.json(resultado);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// SO MASTER: edicao direta da Contagem, sem ticket/analise (pedido/envio
// continua so pelo fluxo normal de "pedir correção" acima)
app.patch('/api/abastecimento/:id/editar-direto', auth.requireAuth, auth.requireMaster, async (req, res) => {
  try {
    const registro = await abastecimentoCarrinho.editarDireto(req.params.id, {
      pizzas: req.body.pizzas,
      insumos: req.body.insumos,
    }, {
      editadoPorEmail: req.user.email,
      editadoPorNome: req.user.username || req.user.email,
    });
    broadcast('abastecimento-atualizado', { id: registro.id });
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ----- config (Master define os horarios do popup de contagem + os tempos
// dos 3 alarmes do fluxo: pedido/envio/recebimento, ver abastecimentoCarrinho.js) -----
app.get('/api/abastecimento-config', requireAnySection('abastecimento-carrinho', 'abastecimento-loja'), async (req, res) => {
  res.json(await abastecimentoCarrinho.getConfig());
});

app.put('/api/abastecimento-config', auth.requireMaster, async (req, res) => {
  try {
    const config = await abastecimentoCarrinho.salvarConfig({
      horasContagem: req.body.horasContagem,
      alertaPedidoMin: req.body.alertaPedidoMin,
      alertaEnvioMin: req.body.alertaEnvioMin,
      alertaRecebimentoMin: req.body.alertaRecebimentoMin,
    });
    broadcast('abastecimento-atualizado', { config: true });
    res.json(config);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ----- operadores locais (login de balcao 4 letras + 4 numeros) -----
// cadastro: Master/Admin, na propria pagina; ativar/desativar, remover e
// DESBLOQUEIO: SO Master. A senha so muda no desbloqueio (opcional - da pra
// manter a mesma); o proprio operador troca o papel autenticando a senha
function podeCadastrarOperadores(req) {
  return req.isMaster || req.isAdmin || req.podeCadastrarOperadores;
}

app.get('/api/abastecimento-operadores', auth.requireAuth, async (req, res) => {
  if (!podeCadastrarOperadores(req)) return res.status(403).json({ error: 'Você não tem a permissão de cadastrar operadores.' });
  res.json(await abastecimentoCarrinho.listarOperadores());
});

// o PROPRIO operador troca seu papel (pede <-> envia) com a propria senha -
// qualquer usuario logado das duas pontas pode acionar do balcao
app.post('/api/abastecimento-operadores/trocar-papel', auth.requireAuth, async (req, res) => {
  try {
    if (!podePedirAbastecimento(req) && !podeEnviarAbastecimento(req) && !podeCadastrarOperadores(req)) {
      return res.status(403).json({ error: 'Você não tem acesso a essa área.' });
    }
    res.json(await abastecimentoCarrinho.trocarPapelOperador({
      usuario: req.body.usuario,
      senha: req.body.senha,
      papel: req.body.papel,
    }));
  } catch (err) {
    if (err.operadorBloqueado) abrirTicketBloqueioOperador(err.operadorBloqueado, req);
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/abastecimento-operadores', auth.requireAuth, async (req, res) => {
  try {
    if (!podeCadastrarOperadores(req)) return res.status(403).json({ error: 'Você não tem a permissão de cadastrar operadores.' });
    const registro = await abastecimentoCarrinho.criarOperador({
      usuario: req.body.usuario,
      senha: req.body.senha,
      nome: req.body.nome,
      papel: req.body.papel,
      criadoPorEmail: req.user.email,
    });
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// editar (ativar/desativar, papel, nome): SO Master
app.patch('/api/abastecimento-operadores/:id', auth.requireMaster, async (req, res) => {
  try {
    res.json(await abastecimentoCarrinho.atualizarOperador(req.params.id, { nome: req.body.nome, papel: req.body.papel, ativo: req.body.ativo }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// remover: SO Master
app.delete('/api/abastecimento-operadores/:id', auth.requireMaster, async (req, res) => {
  try {
    await abastecimentoCarrinho.removerOperador(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// desbloqueio (via ticket gerado no bloqueio): senha opcional - em branco
// mantem a mesma, preenchida redefine
app.post('/api/abastecimento-operadores/:id/desbloquear', auth.requireMaster, async (req, res) => {
  try {
    res.json(await abastecimentoCarrinho.desbloquearOperador(req.params.id, { novaSenha: req.body.novaSenha }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ----- catalogo de insumos (padroniza o que pode ser lancado) -----
// ler: qualquer ponta; gerenciar: Master/Admin ou permissao podeCatalogoInsumos
function podeGerirCatalogoInsumos(req) {
  return req.isMaster || req.isAdmin || req.podeCatalogoInsumos;
}

app.get('/api/abastecimento-insumos', requireAnySection('abastecimento-carrinho', 'abastecimento-loja'), async (req, res) => {
  res.json(await abastecimentoCarrinho.listarInsumos());
});

app.post('/api/abastecimento-insumos', auth.requireAuth, async (req, res) => {
  try {
    if (!podeGerirCatalogoInsumos(req)) return res.status(403).json({ error: 'Você não tem permissão pra mexer no cadastro de insumos.' });
    const registro = await abastecimentoCarrinho.criarInsumo({ nome: req.body.nome, qtdPorCaixa: req.body.qtdPorCaixa, criadoPorEmail: req.user.email });
    broadcast('abastecimento-insumos-atualizado', { id: registro.id });
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/abastecimento-insumos/:id', auth.requireAuth, async (req, res) => {
  try {
    if (!podeGerirCatalogoInsumos(req)) return res.status(403).json({ error: 'Você não tem permissão pra mexer no cadastro de insumos.' });
    const registro = await abastecimentoCarrinho.atualizarInsumo(req.params.id, { nome: req.body.nome, qtdPorCaixa: req.body.qtdPorCaixa, ativo: req.body.ativo });
    broadcast('abastecimento-insumos-atualizado', { id: registro.id });
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/abastecimento/:id', auth.requireMaster, async (req, res) => {
  try {
    await abastecimentoCarrinho.remover(req.params.id);
    broadcast('abastecimento-atualizado', { id: req.params.id, excluido: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// topicos da Ajuda exclusivos de Master/Admin - servidos pelo backend de
// proposito (ver docsMaster.js): conteudo que so a gestao pode conhecer nao
// viaja pro navegador de quem nao e Master/Admin
app.get('/api/ajuda/topicos-master', auth.requireMasterOrAdmin, (req, res) => {
  res.json(docsMaster.TOPICOS_MASTER);
});

// ---------- Chat de suporte do site (widget 💬 em todas as telas) ----------
// Lado PUBLICO (sem login): o visitante cria a conversa e recebe {id, token};
// o token e a chave dele pra ler/escrever depois. Lado do atendimento
// (Master/Admin/secao "suporte"): lista, responde, gera chamado remoto
// vinculado e finaliza - tudo na tela de Chamados TI.
// Beniboy (suporteBot.js): responde a conversa em segundo plano quando
// nenhum humano assumiu. Roda DEPOIS da resposta HTTP (fire-and-forget) -
// o widget do visitante busca a conversa a cada 5s e a resposta do bot
// aparece ali. Qualquer falha da API so cai no log: o time humano ja foi
// notificado pelo push normal e atende como sempre.
async function acionarBeniboy(chatId) {
  if (!suporteBot.ativo()) return;
  try {
    const mapa = await construirUnidadesMapa();
    const unidades = [...new Set(Object.values(mapa))].sort();
    const r = await suporteBot.responderConversa(chatId, { unidades, resolverUnidadesPorIdPulse, resolverUnidadePublica, linkEstornoCliente });
    if (!r) return;
    broadcast('suporte-chat', { id: chatId }, 'suporte');
    for (const t of r.tickets || []) {
      broadcast('solicitacao-criada', t, 'solicitacoes');
      push.notifySolicitacao(`Ticket #${t.numeroTicket} · Nova solicitação (Beniboy · chat)`, `${t.titulo || ''} · ${t.unidadeNome || ''}`, t.id);
    }
    if (r.chamouAtendente) {
      push.notifySolicitacao('💬 Beniboy pediu um atendente humano', `${r.chat?.nome || ''}${r.motivoAtendente ? ' · ' + r.motivoAtendente : ''}`.slice(0, 120), chatId, '/tecnico.html');
      // alarme critico: alem do push normal (Master/Admin), o Master + tag
      // Suporte recebem um alerta sonoro que insiste ate ser silenciado -
      // push em TODOS os acessos logados dessa pessoa (celular fechado/outro
      // app, ver podeReceberCritico) + SSE (app aberto na hora, ver
      // suporte-chat.js). Seção 'suporte' de verdade (ver VALID_SECTIONS em
      // users.js): Master passa direto (bypass no broadcast()), quem tem
      // essa seção recebe tambem, Admin sem a seção fica de fora.
      push.notifyBeniboyEscalonamento(r.chat, r.motivoAtendente);
      broadcast('beniboy-escalonamento', { chatId, nome: r.chat?.nome || '', motivo: r.motivoAtendente || '' }, 'suporte');
      // marca o instante desse 1o alerta - a varredura reforcarAlarmesBeniboy()
      // usa isso pra saber quando repetir, ja que ninguem assumiu ainda
      suporteChat.marcarAlertaEnviado(chatId).catch(() => {});
    }
  } catch (err) {
    console.error('[suporteBot] falha no acionamento:', err.message);
  }
}

// reforca o alarme critico do Beniboy enquanto a conversa continuar sem
// ninguem do time assumir (ver suporteChat.listarParaReforcarAlarme) - antes
// disso o alarme so tocava 1x na escalacao e nunca mais, mesmo com a pessoa
// esperando um humano que ninguem avisou de novo. Roda a cada 1min (ver
// agendamento mais abaixo); a propria varredura de ociosos do suporte
// (40min sem nenhuma mensagem nova) acaba fechando quem ficou mesmo
// abandonado, entao isso nao fica reforcando pra sempre.
async function reforcarAlarmesBeniboy() {
  const pendentes = await suporteChat.listarParaReforcarAlarme();
  for (const chat of pendentes) {
    push.notifyBeniboyEscalonamento(chat, null);
    broadcast('beniboy-escalonamento', { chatId: chat.id, nome: chat.nome || '', motivo: '' }, 'suporte');
    await suporteChat.marcarAlertaEnviado(chat.id);
  }
}

// confere se alguem esta de olho nesse pedido (vigia gravado pelo Beniboy em
// pedidoWatch.js quando respondeu consultar_pedido) e, se o status mudou
// desde aquela resposta, avisa a pessoa - SSE se o Zenith estiver aberto
// agora (qualquer tela, ver broadcastParaUsuario) + push se estiver fechado
// (pedido explicito do usuario: "precisa alcançar mesmo com o app fechado").
// Chamado a cada evento do webhook da Adyen; alerta e de uso unico (dispara
// e remove o vigia - nao repete a cada evento seguinte do mesmo pedido).
async function verificarAlertaPedido(order) {
  if (!order || !order.pedidoId) return;
  const vigias = await pedidoWatch.listarPorPedido(order.pedidoId);
  for (const vigia of vigias) {
    if (vigia.statusVisto === order.statusAtual) continue;
    const dados = {
      pedidoId: order.pedidoId, unidade: order.unidade, cliente: order.cliente, valor: order.valor,
      statusAnterior: vigia.statusVisto, statusAtual: order.statusAtual,
    };
    broadcastParaUsuario(vigia.userId, 'pedido-status-mudou', dados);
    push.notifyUsuario(
      vigia.userId,
      `Pedido ${order.pedidoId} mudou de status`,
      `${order.cliente || 'Cliente'} · R$ ${(order.valor || 0).toFixed(2)} · ${vigia.statusVisto || '—'} → ${order.statusAtual}`,
      'pedido-' + order.pedidoId,
      '/monitor.html'
    ).catch((err) => console.error('[pedidoWatch] falha no push:', err.message));
    await pedidoWatch.remover(order.pedidoId, vigia.userId);
  }
}

// ---------- mensagem direta (Master/Suporte -> usuario logado) - pedido do
// usuario: poder AVISAR proativamente um funcionario, nao so responder quem
// chama no chat de suporte. Reusa a mesma entrega dupla do vigia de pedido
// acima (broadcastParaUsuario p/ quem esta com o Zenith aberto, qualquer
// tela, + push.notifyUsuario p/ quem fechou o app) ----------
app.get('/api/mensagens/usuarios-alvo', auth.requireAuth, async (req, res) => {
  if (!ehTimeSuporte(req)) return res.status(403).json({ error: 'Você não tem acesso a essa área.' });
  const lista = await users.list();
  res.json(lista
    .filter((u) => u.active)
    .map((u) => ({ id: u.id, email: u.email, username: u.username, unidades: (u.permissions && u.permissions.unidades) || null })));
});

app.post('/api/mensagens/enviar', auth.requireAuth, async (req, res) => {
  if (!ehTimeSuporte(req)) return res.status(403).json({ error: 'Você não tem acesso a essa área.' });
  const texto = String(req.body.texto || '').trim().slice(0, 500);
  const userId = String(req.body.userId || '').trim();
  if (!userId || !texto) return res.status(400).json({ error: 'Selecione o usuário e escreva a mensagem.' });
  broadcastParaUsuario(userId, 'mensagem-direta', { texto, deEmail: req.user.email, em: Date.now() });
  push.notifyUsuario(userId, `Mensagem de ${req.user.email}`, texto, 'mensagem-direta-' + Date.now(), '/painel.html')
    .catch((err) => console.error('Erro no push de mensagem direta:', err.message));
  res.json({ ok: true });
});

// ----- lado do atendimento -----
app.get('/api/suporte-chats', auth.requireAuth, async (req, res) => {
  if (!ehTimeSuporte(req)) return res.status(403).json({ error: 'Você não tem acesso a essa área.' });
  const todos = await suporteChat.listAll();
  // token do visitante nunca sai pro atendimento - nao precisa
  res.json(todos.map(({ token, ...resto }) => resto));
});

// PDF da conversa pro lado do atendimento (mesmo conteudo da rota publica
// acima, so que autenticada) - so Master, pedido explicito do usuario (o
// resto do time de suporte continua respondendo normalmente, so não gera
// o PDF)
app.get('/api/suporte-chats/:id/pdf', auth.requireMaster, async (req, res) => {
  const chat = await suporteChat.getOne(req.params.id);
  if (!chat) return res.sendStatus(404);
  suporteChatPDF.gerarChatPDF(res, chat);
});

// anexo de uma mensagem, lado do atendimento (mesmo gate das outras rotas de
// /api/suporte-chats)
app.get('/api/suporte-chats/:id/anexo/:indice', auth.requireAuth, async (req, res) => {
  if (!ehTimeSuporte(req)) return res.status(403).json({ error: 'Você não tem acesso a essa área.' });
  const chat = await suporteChat.getOne(req.params.id);
  if (!chat) return res.sendStatus(404);
  const msg = (chat.mensagens || [])[Number(req.params.indice)];
  if (!msg || !msg.anexo) return res.sendStatus(404);
  storage.streamArquivo(msg.anexo.path, msg.anexo.tipo, res);
});

app.post('/api/suporte-chats/:id/responder', auth.requireAuth, uploadChatAnexo.single('anexo'), async (req, res) => {
  try {
    if (!ehTimeSuporte(req)) return res.status(403).json({ error: 'Você não tem acesso a essa área.' });
    let anexo = null;
    if (req.file) {
      const validacao = segurancaChat.validarAnexo(req.file);
      if (!validacao.ok) return res.status(400).json({ error: validacao.motivo });
      const path = await storage.salvarArquivo(req.params.id, req.file, 'suporte-chat');
      anexo = { nome: req.file.originalname, path, tipo: req.file.mimetype || 'application/octet-stream', tamanho: req.file.size };
    }
    const chat = await suporteChat.adicionarMensagem(req.params.id, { de: 'suporte', texto: req.body.texto, autorEmail: req.user.email, anexo });
    broadcast('suporte-chat', { id: chat.id }, 'suporte');
    const { token, ...resto } = chat;
    res.json(resto);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/suporte-chats/:id/finalizar', auth.requireAuth, async (req, res) => {
  try {
    if (!ehTimeSuporte(req)) return res.status(403).json({ error: 'Você não tem acesso a essa área.' });
    const chat = await suporteChat.finalizar(req.params.id, { autorEmail: req.user.email });
    broadcast('suporte-chat', { id: chat.id }, 'suporte');
    const { token, ...resto } = chat;
    res.json(resto);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// transforma a conversa num chamado REMOTO vinculado (registro/evidencia da
// atuacao) - o responsavel e quem esta atendendo; se a atuacao ja acabou,
// jaResolvido abre e fecha na hora
app.post('/api/suporte-chats/:id/gerar-chamado', auth.requireAuth, async (req, res) => {
  try {
    if (!ehTimeSuporte(req)) return res.status(403).json({ error: 'Você não tem acesso a essa área.' });
    const chat = await suporteChat.getOne(req.params.id);
    if (!chat) return res.status(404).json({ error: 'Conversa não encontrada.' });
    if (chat.chamadoId) return res.status(400).json({ error: 'Essa conversa já tem um chamado vinculado.' });
    const chamado = await chamadosTI.create({
      unidade: req.body.unidade || 'Suporte remoto',
      unidadeNome: req.body.unidade || 'Suporte remoto',
      titulo: `Chat do site · ${chat.nome}`,
      descricao: `Contato: ${chat.contato}\n\nPrimeira mensagem: ${chat.mensagens?.[0]?.texto || ''}`,
      modalidade: 'remoto',
      prioridade: req.body.prioridade,
      jaResolvido: !!req.body.jaResolvido,
      observacaoResolucao: req.body.observacaoResolucao,
      tecnicoId: req.user.id,
      tecnicoEmail: req.user.email,
      criadoPorEmail: req.user.email,
      // o chamado herda o MESMO numero do protocolo da conversa (nao tira um
      // novo da sequencia) - pedido explicito do usuario: "o numero do
      // ticket sempre sera o mesmo do protocolo... o proximo ticket tem que
      // ser na sequencia, nunca repetir"
      numeroTicket: chat.numeroTicket,
    });
    await suporteChat.vincularChamado(chat.id, chamado.id);
    await suporteChat.adicionarTicketVinculado(chat.id, { tipo: 'chamado-ti', ticketId: chamado.id, numero: chamado.numeroTicket });
    broadcast('chamado-criado', { id: chamado.id }, 'tecnico');
    broadcast('suporte-chat', { id: chat.id }, 'suporte');
    res.json({ chamado });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// move o card no funil da Central do Beniboy (beniboy.html) - drag-and-drop
// e botoes de acao rapida chamam essa mesma rota. nivelDestino so e exigido
// pro status TRANSFERIDO (2=agente humano, 3=Master); motivoSemSolucao so
// pro status SEM_SOLUCAO. Mesmo guard de acesso do resto do atendimento.
app.post('/api/suporte-chats/:id/status', auth.requireAuth, async (req, res) => {
  try {
    if (!ehTimeSuporte(req)) return res.status(403).json({ error: 'Você não tem acesso a essa área.' });
    const autor = { id: req.user.id, email: req.user.email, nome: req.user.username || req.user.email };
    const antes = await suporteChat.getOne(req.params.id);
    let chat = await suporteChat.atualizarStatusAtendimento(req.params.id, {
      statusAtendimento: req.body.statusAtendimento,
      nivelDestino: req.body.nivelDestino,
      motivoSemSolucao: req.body.motivoSemSolucao,
      autor,
    });
    // 1a vez que alguem assume a conversa (PENDENTE -> EM_ATENDIMENTO): avisa
    // o numero do ticket pro visitante - pedido explicito do usuario: "o
    // numero do ticket é informado assim que o setor inicia o atendimento"
    if (antes && antes.statusAtendimento === 'PENDENTE' && req.body.statusAtendimento === 'EM_ATENDIMENTO' && chat.numeroTicket) {
      chat = await suporteChat.adicionarMensagem(req.params.id, {
        de: 'suporte',
        texto: `Olá! Iremos agilizar seu atendimento. O número do seu ticket, caso precise, é #${chat.numeroTicket}.`,
        autorEmail: autor.email,
      });
    }
    broadcast('suporte-chat', { id: chat.id }, 'suporte');
    const { token, ...resto } = chat;
    res.json(resto);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- Central de Soluções: pagina agregadora que reune os 3 tipos de
// chat (widget publico, chat de solicitacao, chat de chamado) numa lista so,
// agrupada por assunto - nao recria envio/leitura, so resolve visibilidade e
// agrupa em cima das rotas de chat que ja existem. Guard: a secao
// 'central-solucoes' decide quem pode ABRIR a pagina; dentro dela, cada
// conversa so aparece se o guard fino de origem (podeVerCard / secao
// 'suporte') ja liberaria hoje - ninguem enxerga mais do que ja podia ----------

// mesma resolucao de buscarCardCru, mas devolvendo o card INTEIRO (nao so os
// campos de visibilidade) pra extrair titulo/tipo sem 2a leitura no Firestore
async function buscarCardCompletoSolucoes(tipo, id) {
  if (tipo === 'estorno') {
    const r = await refunds.getOne(id);
    return r && { ...r, criadoPorId: r.requestedById, chatLivre: false };
  }
  if (tipo === 'ajuste-fechamento') {
    const r = await fechamentosLive.getEdicao(id);
    return r && { ...r, criadoPorId: r.solicitadoPorId, chatLivre: false };
  }
  if (tipo === 'chamado-ti') {
    const r = await chamadosTI.getOne(id);
    return r && { ...r, direcionadoParaId: r.tecnicoId, atribuidosIds: [], chatLivre: true };
  }
  if (tipo === 'chamado-manutencao') {
    const r = await chamadosManutencao.getOne(id);
    return r && { ...r, direcionadoParaId: null, atribuidosIds: (r.responsaveis || []).map((x) => x.id), chatLivre: true };
  }
  const r = await solicitacoes.getOne(id);
  return r && { ...r };
}

app.get('/api/central-solucoes', requireSection('central-solucoes'), async (req, res) => {
  try {
    const itens = [];
    // widget publico - so pra quem atende suporte (mesmo guard de /api/suporte-chats)
    if (ehTimeSuporte(req)) {
      const chats = await suporteChat.listAll();
      for (const chat of chats) {
        const ultima = (chat.mensagens || [])[chat.mensagens.length - 1] || null;
        itens.push({
          origem: 'suporte',
          tipo: 'suporte-chat',
          id: chat.id,
          assunto: chat.assunto || 'Suporte geral',
          titulo: chat.nome,
          status: chat.status,
          total: (chat.mensagens || []).length,
          ultimaMensagem: ultima && { texto: ultima.texto, em: ultima.em, de: ultima.de === 'visitante' ? chat.nome : 'Suporte' },
          atualizadoEm: chat.atualizadoEm,
        });
      }
    }
    // chat de solicitacao/chamado - agrupado por card, so os que o usuario pode ver
    const grupos = await centralChat.listAllGroupedByCard();
    for (const g of grupos) {
      const card = await buscarCardCompletoSolucoes(g.tipo, g.cardId);
      if (!card || !podeVerCard(req, card)) continue;
      const ehChamado = g.tipo === 'chamado-ti' || g.tipo === 'chamado-manutencao';
      const assunto = ehChamado ? (card.titulo || 'Chamado') : (TIPOS_CENTRAL_LABEL[g.tipo] || g.tipo);
      itens.push({
        origem: 'central',
        tipo: g.tipo,
        id: g.cardId,
        assunto,
        titulo: card.titulo || assunto,
        status: card.status || null,
        total: g.total,
        ultimaMensagem: { texto: g.ultimaMensagem.texto, em: g.ultimaMensagem.criadoEm, de: g.ultimaMensagem.autorUsername || g.ultimaMensagem.autorEmail },
        atualizadoEm: g.ultimaMensagem.criadoEm,
      });
    }
    itens.sort((a, b) => (b.atualizadoEm || '').localeCompare(a.atualizadoEm || ''));
    res.json(itens);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// concluir chamado REMOTO (sem visita): responsavel pelo chamado ou
// Master/Admin fechando por ele - so a observacao do que foi feito
app.post('/api/chamados/:id/concluir-remoto', requireAnySection('tecnico', 'suporte'), async (req, res) => {
  try {
    const chamado = await chamadosTI.concluirRemoto(req.params.id, {
      observacaoTecnico: req.body.observacaoTecnico,
      tecnicoId: req.user.id,
      ehGestor: req.isMaster || req.isAdmin,
    });
    broadcast('chamado-atualizado', { id: chamado.id }, 'tecnico');
    res.json(chamado);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/chamados/:id', auth.requireMaster, async (req, res) => {
  const chamado = await chamadosTI.getOne(req.params.id);
  if (!chamado) return res.sendStatus(404);
  res.json(chamado);
});

// Master troca o tecnico responsavel (ex: escalado ficou indisponivel) -
// mesmo botao "Atribuir Técnico" ao lado de "Atribuir responsável" no
// detalhe da Central (ver central-historico.html)
app.patch('/api/chamados/:id', auth.requireMaster, async (req, res) => {
  try {
    const chamado = await chamadosTI.reatribuir(req.params.id, { tecnicoId: req.body.tecnicoId, tecnicoEmail: req.body.tecnicoEmail });
    broadcast('chamado-atualizado', { id: chamado.id }, 'tecnico');
    res.json(chamado);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// edicao do Master: modalidade (presencial <-> remoto), status (concluido,
// ativo, cancelado, reaberto) e prioridade - autonomia total
app.patch('/api/chamados/:id/editar', auth.requireMaster, async (req, res) => {
  try {
    const chamado = await chamadosTI.editarMaster(req.params.id, {
      modalidade: req.body.modalidade,
      status: req.body.status,
      prioridade: req.body.prioridade,
    });
    broadcast('chamado-atualizado', { id: chamado.id }, 'tecnico');
    res.json(chamado);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// TRIAGEM: Master OU alguem com a secao "suporte" (mesmo criterio de quem
// atende os chamados remotos/chats do site, ver ehTimeSuporte) decide que um
// chamado remoto precisa de visita e escala pra presencial - unica porta pra
// essa transicao fora da edicao livre do Master (editarMaster, acima)
app.post('/api/chamados/:id/escalar-presencial', auth.requireAuth, async (req, res) => {
  try {
    if (!ehTimeSuporte(req)) return res.status(403).json({ error: 'Só o Master ou o time de Suporte fazem a triagem.' });
    const chamado = await chamadosTI.escalarPresencial(req.params.id, {
      tecnicoId: req.body.tecnicoId || null,
      tecnicoEmail: req.body.tecnicoEmail || null,
      motivo: req.body.motivo,
      autorEmail: req.user.email,
    });
    broadcast('chamado-atualizado', { id: chamado.id }, 'tecnico');
    res.json(chamado);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// reclassificar: esse chamado foi aberto no tipo errado (ex: o Beniboy
// classificou como Suporte-TI, mas era Nota Fiscal). Muda o tipo da
// solicitacao vinculada (mudarTipo -> reatribui o card na Central) e encerra
// o chamado de TI, movendo o ticket pra fila certa com o MESMO numero.
const TIPOS_RECLASSIFICAR = { compra: 'Compra', manutencao: 'Manutenção', pagamento: 'Pagamento', nota: 'Nota Fiscal', 'suporte-ti': 'Suporte de TI' };
app.post('/api/chamados/:id/reclassificar', auth.requireAuth, async (req, res) => {
  try {
    if (!ehTimeSuporte(req)) return res.status(403).json({ error: 'Só o Master ou o time de Suporte reclassificam um chamado.' });
    const chamado = await chamadosTI.getOne(req.params.id);
    if (!chamado) return res.status(404).json({ error: 'Chamado não encontrado.' });
    const novoTipo = String(req.body.novoTipo || '').trim();
    if (!TIPOS_RECLASSIFICAR[novoTipo]) return res.status(400).json({ error: 'Tipo de destino inválido.' });
    if (!chamado.solicitacaoId) return res.status(400).json({ error: 'Esse chamado não tem uma solicitação vinculada para reclassificar.' });
    if (chamado.status === 'CANCELADO' || chamado.status === 'CONCLUIDO') return res.status(400).json({ error: 'Esse chamado já foi encerrado.' });
    const sol = await solicitacoes.mudarTipo(chamado.solicitacaoId, novoTipo, req.user.email);
    await chamadosTI.cancelar(chamado.id, { motivo: `Reclassificado como ${TIPOS_RECLASSIFICAR[novoTipo]} — movido para a Central` });
    broadcast('chamado-atualizado', { id: chamado.id }, 'tecnico');
    broadcast('solicitacao-criada', sol, 'solicitacoes');
    res.json({ ok: true, solicitacao: sol });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// data de execucao: o tecnico responsavel (ou Master/Admin) diz quando vai
// atuar - o SLA cobre so a TRIAGEM (atribuir + marcar essa data); a partir
// daqui o combinado passa a ser a data marcada
app.post('/api/chamados/:id/data-execucao', requireAnySection('tecnico', 'suporte'), async (req, res) => {
  try {
    const chamado = await chamadosTI.definirDataExecucao(req.params.id, {
      dataExecucao: req.body.dataExecucao,
      tecnicoId: req.user.id,
      ehGestor: req.isMaster || req.isAdmin,
    });
    broadcast('chamado-atualizado', { id: chamado.id }, 'tecnico');
    res.json(chamado);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// orcamento de peca (qualquer modalidade): lista descricao + valor
app.put('/api/chamados/:id/orcamento-pecas', requireAnySection('tecnico', 'suporte'), async (req, res) => {
  try {
    const chamado = await chamadosTI.salvarOrcamentoPecas(req.params.id, req.body.orcamentoPecas);
    broadcast('chamado-atualizado', { id: chamado.id }, 'tecnico');
    res.json(chamado);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// cobranca de chamado (TI ou Manutencao): salvar e/ou ENVIAR - enviar gera o
// ticket de PAGAMENTO na Central com a MESMA numeracao do chamado, juntando
// os dois lados da historia (o servico e a cobranca dele)
async function enviarCobrancaChamado({ modulo, chamadoId, origem, req }) {
  let chamado = await modulo.garantirTicket(chamadoId);
  if (!chamado.cobranca || !(chamado.cobranca.valor > 0)) throw new Error('Informe o valor da cobrança antes de enviar.');
  if (chamado.cobranca.enviadaEm) throw new Error('A cobrança desse chamado já foi enviada.');
  if (!chamado.cobranca.boleto) throw new Error('Anexe o boleto da cobrança antes de enviar.');
  const ticket = await solicitacoes.create({
    tipo: 'pagamento',
    numeroTicket: chamado.numeroTicket,
    unidade: chamado.unidade,
    unidadeNome: chamado.unidadeNome,
    titulo: `Cobrança ${origem} · ${chamado.titulo}`,
    valorEstimado: chamado.cobranca.valor,
    observacao: `Cobrança gerada do chamado de ${origem} (Ticket #${chamado.numeroTicket} — "${chamado.titulo}", ${chamado.unidadeNome}).${chamado.cobranca.descricao ? `\n\nObservação: ${chamado.cobranca.descricao}` : ''}\n\nBoleto anexado. Os dois tickets compartilham a numeração #${chamado.numeroTicket}.`,
    itens: [],
    anexos: [chamado.cobranca.boleto],
    ehOrcamento: false,
    criadoPorId: req.user.id,
    criadoPorEmail: req.user.email,
    direcionadoParaId: null,
    direcionadoParaEmail: null,
  });
  chamado = await modulo.marcarCobrancaEnviada(chamadoId, { pagamentoId: ticket.id });
  broadcast('solicitacao-criada', ticket, 'solicitacoes');
  push.notifySolicitacao(`Ticket #${ticket.numeroTicket} · Cobrança de ${origem}`, `${chamado.titulo} · R$ ${Number(chamado.cobranca.valor).toFixed(2)}`, ticket.id);
  return { chamado, ticket };
}

app.post('/api/chamados/:id/cobranca', requireAnySection('tecnico', 'suporte'), upload.single('boleto'), async (req, res) => {
  try {
    let boleto = null;
    if (req.file) {
      const path = await storage.salvarArquivo(req.params.id, req.file, 'chamados-cobranca');
      boleto = { nome: req.file.originalname, path, tipo: req.file.mimetype || 'application/octet-stream' };
    }
    let chamado = await chamadosTI.salvarCobranca(req.params.id, { valor: req.body.valor, descricao: req.body.descricao, boleto });
    let numeroTicket = null;
    if (req.body.enviar === '1' || req.body.enviar === true) {
      const r = await enviarCobrancaChamado({ modulo: chamadosTI, chamadoId: req.params.id, origem: 'TI', req });
      chamado = r.chamado;
      numeroTicket = r.ticket.numeroTicket;
    }
    broadcast('chamado-atualizado', { id: chamado.id }, 'tecnico');
    res.json({ chamado, numeroTicket });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// boleto anexado a cobranca - mesmo publico que enxerga o kanban
app.get('/api/chamados/:id/cobranca/boleto', requireAnySection('tecnico', 'suporte'), async (req, res) => {
  const chamado = await chamadosTI.getOne(req.params.id);
  if (!chamado || !chamado.cobranca || !chamado.cobranca.boleto) return res.sendStatus(404);
  storage.streamArquivo(chamado.cobranca.boleto.path, chamado.cobranca.boleto.tipo, res);
});

// evidencias do chamado: observacao (texto) + quantas fotos precisar por
// observacao - registradas a qualquer momento
app.post('/api/chamados/:id/evidencias', requireAnySection('tecnico', 'suporte'), upload.array('fotos', 10), async (req, res) => {
  try {
    const fotos = [];
    for (const file of req.files || []) {
      const path = await storage.salvarArquivo(req.params.id, file, 'chamados-evidencias');
      fotos.push({ nome: file.originalname, path, tipo: file.mimetype || 'application/octet-stream' });
    }
    const chamado = await chamadosTI.adicionarEvidencia(req.params.id, {
      descricao: req.body.descricao,
      fotos,
      autorEmail: req.user.email,
      autorNome: req.user.username || req.user.email,
    });
    broadcast('chamado-atualizado', { id: chamado.id }, 'tecnico');
    res.json(chamado);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/chamados/:id/evidencias/:indice', auth.requireMaster, async (req, res) => {
  try {
    const chamado = await chamadosTI.removerEvidencia(req.params.id, req.params.indice);
    broadcast('chamado-atualizado', { id: chamado.id }, 'tecnico');
    res.json(chamado);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/chamados/:id/evidencia-foto/:indice/:fotoIndice', requireAnySection('tecnico', 'suporte'), async (req, res) => {
  const chamado = await chamadosTI.getOne(req.params.id);
  const foto = chamado?.evidencias?.[Number(req.params.indice)]?.fotos?.[Number(req.params.fotoIndice)];
  if (!foto) return res.sendStatus(404);
  storage.streamArquivo(foto.path, foto.tipo, res);
});

// check-in: tecnico chegou na loja, registra os itens (descricao + foto) de
// como esta antes de mexer
app.post('/api/chamados/:id/iniciar', requireSection('tecnico'), upload.array('fotosAntes', 6), async (req, res) => {
  try {
    const payload = JSON.parse(req.body.payload || '{}');
    const itensAntes = await processarItensComFoto(payload.itens, req.files, req.params.id, 'chamados-antes');
    const chamado = await chamadosTI.iniciar(req.params.id, { itensAntes, tecnicoId: req.user.id });
    broadcast('chamado-atualizado', { id: chamado.id }, 'tecnico');
    res.json(chamado);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// finalizar (checkout): itens do "depois", observacao, pecas compradas (se
// precisou) e assinatura de quem recebeu o servico na loja
app.post('/api/chamados/:id/concluir', requireSection('tecnico'), upload.fields([{ name: 'fotosDepois', maxCount: 6 }, { name: 'assinatura', maxCount: 1 }]), async (req, res) => {
  try {
    const payload = JSON.parse(req.body.payload || '{}');
    const itensDepois = await processarItensComFoto(payload.itens, req.files?.fotosDepois, req.params.id, 'chamados-depois');
    const assinatura = await processarAssinatura((req.files?.assinatura || [])[0], req.params.id, 'chamados-assinatura');
    const chamado = await chamadosTI.concluir(req.params.id, {
      itensDepois,
      observacaoTecnico: payload.observacaoTecnico,
      pecas: payload.pecas,
      tecnicoId: req.user.id,
      assinaturaNomeLoja: payload.assinaturaNomeLoja,
      assinatura,
    });
    broadcast('chamado-atualizado', { id: chamado.id }, 'tecnico');
    res.json(chamado);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/chamados/foto/:chamadoId/:campo/:index', requireSection('tecnico'), async (req, res) => {
  const chamado = await chamadosTI.getOne(req.params.chamadoId);
  if (!chamado) return res.sendStatus(404);
  if (!req.isMaster && chamado.tecnicoId !== req.user.id) return res.sendStatus(404);
  const campo = ['itensAntes', 'itensDepois', 'assinatura'].includes(req.params.campo) ? req.params.campo : null;
  if (!campo) return res.status(400).end();
  const foto = campo === 'assinatura' ? chamado.assinatura : chamado[campo]?.[Number(req.params.index)]?.foto;
  if (!foto) return res.sendStatus(404);
  storage.streamArquivo(foto.path, foto.tipo, res);
});

// ---------- Chamados de Manutenção (secao "manutencao") - cada chamado pode
// ter 1 ou 2 responsaveis (hoje sao 2 pessoas de manutencao); quem nao esta
// atribuido nao ve o chamado. Master tem autonomia total: ve/cria/edita/
// exclui qualquer chamado. Fluxo: ABERTO -> (ACEITO com Data da Execucao |
// RECUSADO) -> INICIADO (check-in) -> EM_ESPERA (opcional, ex: falta peca) ->
// CONCLUIDO. Nasce vinculado a uma solicitacao de Manutencao aprovada (rota
// acima) ou criado direto pelo Master ----------
function ehResponsavelManutencao(chamado, userId) {
  return (chamado.responsaveis || []).some((r) => r.id === userId);
}

app.get('/api/chamados-manutencao', requireSection('manutencao'), async (req, res) => {
  const todos = await chamadosManutencao.listAll();
  // Master e Admin veem TODOS os chamados (sem depender de estarem na lista
  // de responsaveis); quem executa ve so o que foi atribuido a ele
  if (req.isMaster || req.isAdmin) return res.json(todos);
  res.json(todos.filter((c) => ehResponsavelManutencao(c, req.user.id)));
});

// o chamado nasceu como Manutenção mas na verdade era Suporte de TI:
// converte pra um chamado de TI de verdade (MESMO Ticket #), escolhendo o
// tecnico e a modalidade; o de manutencao fecha como CANCELADO apontando
// pro novo - nada se perde, a numeracao junta os dois
app.post('/api/chamados-manutencao/:id/converter-para-ti', auth.requireMaster, async (req, res) => {
  try {
    const chamado = await chamadosManutencao.getOne(req.params.id);
    if (!chamado) return res.status(404).json({ error: 'Chamado não encontrado.' });
    if (chamado.convertidoParaTIId) return res.status(400).json({ error: 'Esse chamado já foi convertido pra Suporte TI.' });
    const novo = await chamadosTI.create({
      unidade: chamado.unidade,
      unidadeNome: chamado.unidadeNome,
      titulo: chamado.titulo,
      descricao: `${chamado.descricao || ''}\n\n[Convertido de um chamado de Manutenção pelo Master]`.trim(),
      tecnicoId: req.body.tecnicoId,
      tecnicoEmail: req.body.tecnicoEmail,
      solicitacaoId: chamado.solicitacaoId || null,
      criadoPorEmail: req.user.email,
      prioridade: chamado.prioridade,
      numeroTicket: chamado.numeroTicket != null ? chamado.numeroTicket : null,
    });
    const atualizado = await chamadosManutencao.marcarConvertidoParaTI(req.params.id, { chamadoTIId: novo.id, porEmail: req.user.email });
    broadcast('chamado-manutencao-atualizado', { id: req.params.id }, 'manutencao');
    broadcast('chamado-criado', { id: novo.id }, 'tecnico');
    res.json({ chamado: atualizado, chamadoTI: novo });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/chamados-manutencao/:id', auth.requireMaster, async (req, res) => {
  const chamado = await chamadosManutencao.getOne(req.params.id);
  if (!chamado) return res.sendStatus(404);
  res.json(chamado);
});

app.post('/api/chamados-manutencao', auth.requireMaster, async (req, res) => {
  try {
    const { unidade, unidadeNome, titulo, descricao, responsaveis } = req.body;
    const chamado = await chamadosManutencao.create({ unidade, unidadeNome, titulo, descricao, responsaveis, criadoPorEmail: req.user.email });
    broadcast('chamado-manutencao-criado', { id: chamado.id }, 'manutencao');
    res.json(chamado);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/chamados-manutencao/:id/aceitar', requireSection('manutencao'), async (req, res) => {
  try {
    const chamado = await chamadosManutencao.aceitar(req.params.id, { userId: req.user.id, dataExecucao: req.body.dataExecucao });
    broadcast('chamado-manutencao-atualizado', { id: chamado.id }, 'manutencao');
    res.json(chamado);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/chamados-manutencao/:id/recusar', requireSection('manutencao'), async (req, res) => {
  try {
    const chamado = await chamadosManutencao.recusar(req.params.id, { userId: req.user.id, motivo: req.body.motivo });
    broadcast('chamado-manutencao-atualizado', { id: chamado.id }, 'manutencao');
    res.json(chamado);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// check-in: responsavel chegou na loja, registra os itens (descricao + foto)
// de como esta antes de mexer
app.post('/api/chamados-manutencao/:id/iniciar', requireSection('manutencao'), upload.array('fotosAntes', 6), async (req, res) => {
  try {
    const payload = JSON.parse(req.body.payload || '{}');
    const itensAntes = await processarItensComFoto(payload.itens, req.files, req.params.id, 'chamados-manutencao-antes');
    const chamado = await chamadosManutencao.iniciar(req.params.id, { itensAntes, userId: req.user.id });
    broadcast('chamado-manutencao-atualizado', { id: chamado.id }, 'manutencao');
    res.json(chamado);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/chamados-manutencao/:id/em-espera', requireSection('manutencao'), async (req, res) => {
  try {
    const chamado = await chamadosManutencao.marcarEmEspera(req.params.id, { userId: req.user.id, motivo: req.body.motivo });
    broadcast('chamado-manutencao-atualizado', { id: chamado.id }, 'manutencao');
    res.json(chamado);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/chamados-manutencao/:id/retomar', requireSection('manutencao'), async (req, res) => {
  try {
    const chamado = await chamadosManutencao.retomar(req.params.id, { userId: req.user.id });
    broadcast('chamado-manutencao-atualizado', { id: chamado.id }, 'manutencao');
    res.json(chamado);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// finalizar (checkout): itens do "depois", observacao, pecas compradas (se
// precisou) e assinatura de quem recebeu o servico na loja
app.post('/api/chamados-manutencao/:id/concluir', requireSection('manutencao'), upload.fields([{ name: 'fotosDepois', maxCount: 6 }, { name: 'assinatura', maxCount: 1 }]), async (req, res) => {
  try {
    const payload = JSON.parse(req.body.payload || '{}');
    const itensDepois = await processarItensComFoto(payload.itens, req.files?.fotosDepois, req.params.id, 'chamados-manutencao-depois');
    const assinatura = await processarAssinatura((req.files?.assinatura || [])[0], req.params.id, 'chamados-manutencao-assinatura');
    const chamado = await chamadosManutencao.concluir(req.params.id, {
      itensDepois,
      observacaoResponsavel: payload.observacaoResponsavel,
      pecas: payload.pecas,
      userId: req.user.id,
      assinaturaNomeLoja: payload.assinaturaNomeLoja,
      assinatura,
    });
    broadcast('chamado-manutencao-atualizado', { id: chamado.id }, 'manutencao');
    res.json(chamado);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Master: autonomia total pra corrigir titulo/descricao/data/responsaveis/status
// orcamento de peca do chamado de manutencao
app.put('/api/chamados-manutencao/:id/orcamento-pecas', requireSection('manutencao'), async (req, res) => {
  try {
    const chamado = await chamadosManutencao.salvarOrcamentoPecas(req.params.id, req.body.orcamentoPecas);
    broadcast('chamado-manutencao-atualizado', { id: chamado.id }, 'manutencao');
    res.json(chamado);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// cobranca do chamado de manutencao: salvar e/ou enviar (gera o ticket de
// PAGAMENTO com a mesma numeracao - ver enviarCobrancaChamado)
app.post('/api/chamados-manutencao/:id/cobranca', requireSection('manutencao'), upload.single('boleto'), async (req, res) => {
  try {
    let boleto = null;
    if (req.file) {
      const path = await storage.salvarArquivo(req.params.id, req.file, 'chamados-cobranca');
      boleto = { nome: req.file.originalname, path, tipo: req.file.mimetype || 'application/octet-stream' };
    }
    let chamado = await chamadosManutencao.salvarCobranca(req.params.id, { valor: req.body.valor, descricao: req.body.descricao, boleto });
    let numeroTicket = null;
    if (req.body.enviar === '1' || req.body.enviar === true) {
      const r = await enviarCobrancaChamado({ modulo: chamadosManutencao, chamadoId: req.params.id, origem: 'Manutenção', req });
      chamado = r.chamado;
      numeroTicket = r.ticket.numeroTicket;
    }
    broadcast('chamado-manutencao-atualizado', { id: chamado.id }, 'manutencao');
    res.json({ chamado, numeroTicket });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/chamados-manutencao/:id/cobranca/boleto', requireSection('manutencao'), async (req, res) => {
  const chamado = await chamadosManutencao.getOne(req.params.id);
  if (!chamado || !chamado.cobranca || !chamado.cobranca.boleto) return res.sendStatus(404);
  storage.streamArquivo(chamado.cobranca.boleto.path, chamado.cobranca.boleto.tipo, res);
});

// evidencias do chamado de manutencao (mesma mecanica da TI)
app.post('/api/chamados-manutencao/:id/evidencias', requireSection('manutencao'), upload.array('fotos', 10), async (req, res) => {
  try {
    const fotos = [];
    for (const file of req.files || []) {
      const path = await storage.salvarArquivo(req.params.id, file, 'chamados-evidencias');
      fotos.push({ nome: file.originalname, path, tipo: file.mimetype || 'application/octet-stream' });
    }
    const chamado = await chamadosManutencao.adicionarEvidencia(req.params.id, {
      descricao: req.body.descricao,
      fotos,
      autorEmail: req.user.email,
      autorNome: req.user.username || req.user.email,
    });
    broadcast('chamado-manutencao-atualizado', { id: chamado.id }, 'manutencao');
    res.json(chamado);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/chamados-manutencao/:id/evidencias/:indice', auth.requireMaster, async (req, res) => {
  try {
    const chamado = await chamadosManutencao.removerEvidencia(req.params.id, req.params.indice);
    broadcast('chamado-manutencao-atualizado', { id: chamado.id }, 'manutencao');
    res.json(chamado);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/chamados-manutencao/:id/evidencia-foto/:indice/:fotoIndice', requireSection('manutencao'), async (req, res) => {
  const chamado = await chamadosManutencao.getOne(req.params.id);
  const foto = chamado?.evidencias?.[Number(req.params.indice)]?.fotos?.[Number(req.params.fotoIndice)];
  if (!foto) return res.sendStatus(404);
  storage.streamArquivo(foto.path, foto.tipo, res);
});

app.patch('/api/chamados-manutencao/:id', auth.requireMaster, async (req, res) => {
  try {
    const chamado = await chamadosManutencao.atualizar(req.params.id, req.body);
    broadcast('chamado-manutencao-atualizado', { id: chamado.id }, 'manutencao');
    res.json(chamado);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/chamados-manutencao/:id', auth.requireMaster, async (req, res) => {
  try {
    await chamadosManutencao.remover(req.params.id);
    broadcast('chamado-manutencao-excluido', { id: req.params.id }, 'manutencao');
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/chamados-manutencao/foto/:chamadoId/:campo/:index', requireSection('manutencao'), async (req, res) => {
  const chamado = await chamadosManutencao.getOne(req.params.chamadoId);
  if (!chamado) return res.sendStatus(404);
  if (!req.isMaster && !ehResponsavelManutencao(chamado, req.user.id)) return res.sendStatus(404);
  const campo = ['itensAntes', 'itensDepois', 'assinatura'].includes(req.params.campo) ? req.params.campo : null;
  if (!campo) return res.status(400).end();
  const foto = campo === 'assinatura' ? chamado.assinatura : chamado[campo]?.[Number(req.params.index)]?.foto;
  if (!foto) return res.sendStatus(404);
  storage.streamArquivo(foto.path, foto.tipo, res);
});

// ---------- entregas (motoboys) - substitui o app de entregas do AppSheet ----------
// mesmo desenho do fechamento: secao "entregas-lancamento" e onde a loja
// lança as corridas dos entregadores do dia (varias por unidade+data, uma por
// entregador/turno); secao "entregas" e o dashboard de acompanhamento
// (Master ve tudo, cada loja so ve as suas unidades). Etiqueta (foto do
// comprovante/etiquetas do entregador) e opcional, guardada no mesmo Storage
// dos anexos de disputa.
//
// entregasHistoricoData: historico importado direto da planilha "MOTOS
// BRAVO" (AppSheet) via entregasSync - comeca vazio (so aparece depois da 1a
// sincronizacao, no boot) e e somente leitura (nao tem dono/permissao de
// edicao, so o Master ve as diferencas na planilha em si). A aba "BDMotos"
// fica de fora por enquanto (sem coluna Data preenchida - ver entregasSync.js).
let entregasHistoricoData = [];
let statusSincronizacaoEntregas = { ultimaEm: null, ultimoErro: null, sincronizando: false };

async function sincronizarPlanilhaEntregas({ completa = false } = {}) {
  if (statusSincronizacaoEntregas.sincronizando) return statusSincronizacaoEntregas;
  statusSincronizacaoEntregas.sincronizando = true;
  try {
    const dados = await entregasSync.sincronizar({ completa });
    if (dados.length) {
      entregasHistoricoData = dados;
      statusSincronizacaoEntregas.ultimaEm = new Date().toISOString();
      statusSincronizacaoEntregas.ultimoErro = null;
      statusSincronizacaoEntregas.linhasNovas = dados.linhasNovas ?? null;
      console.log(`Entregas: sincronizados ${dados.length} registros historicos da planilha do Google Sheets (${dados.linhasNovas ?? '?'} linha(s) nova(s) lida(s)).`);
    } else {
      statusSincronizacaoEntregas.ultimoErro = 'A sincronização rodou mas não retornou nenhuma linha - histórico continua com os dados anteriores.';
      console.warn(statusSincronizacaoEntregas.ultimoErro);
    }
  } catch (err) {
    statusSincronizacaoEntregas.ultimoErro = err.message;
    console.error('Erro ao sincronizar planilha de entregas:', err.message);
  } finally {
    statusSincronizacaoEntregas.sincronizando = false;
  }
  return statusSincronizacaoEntregas;
}

app.get('/api/entregas/sincronizacao', requireSection('entregas'), (req, res) => {
  res.json(statusSincronizacaoEntregas);
});

// forca uma sincronizacao imediata - so o Master (evita chamadas extras na
// API do Google sem necessidade). Incremental por padrao; { completa: true }
// rele a planilha inteira
app.post('/api/entregas/sincronizar-planilha', auth.requireMaster, async (req, res) => {
  const status = await sincronizarPlanilhaEntregas({ completa: req.body?.completa === true });
  if (status.ultimoErro) return res.status(502).json(status);
  res.json(status);
});

// regra de pagamento por unidade (ver entregasRegras.js) - leitura liberada
// pra quem lança ou vê Entregas (o formulário de lançamento precisa saber se
// a unidade é "fixo" - esconde os campos de valor - ou "plataforma" - mantém
// digitação manual); edição só o Master
app.get('/api/entregas/regras', requireAnySection('entregas', 'entregas-lancamento'), async (req, res) => {
  const todas = await entregasRegras.listAll();
  const porUnidade = {};
  todas.forEach((r) => { porUnidade[r.unidade] = r; });
  const unidades = req.isMaster ? Object.keys({ ...ENTREGAS_UNIDADES_NOMES, ...porUnidade }) : (req.permissions.unidades || []);
  res.json(unidades.map((u) => porUnidade[u] || entregasRegras.defaultRegra(u)));
});

app.put('/api/entregas/regras/:unidade', auth.requireMaster, async (req, res) => {
  try {
    const registro = await entregasRegras.salvar(req.params.unidade, req.body, req.user.email);
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/entregas/lancar', requireSection('entregas-lancamento'), upload.single('etiqueta'), async (req, res) => {
  try {
    const { unidade, unidadeNome, data, entregador, campos, obsRetorno, obsExtra, observacao, camposRemovidos, motivoRemocaoCampos } = JSON.parse(req.body.payload || '{}');
    if (!req.isMaster && !(req.permissions.unidades || []).includes(unidade)) {
      return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    }
    const registro = await entregasLive.create({
      unidade, unidadeNome, data, entregador, campos, obsRetorno, obsExtra, observacao, camposRemovidos, motivoRemocaoCampos,
      etiquetaFile: req.file || null,
      criadoPorId: req.user.id,
      criadoPorEmail: req.user.email,
    });
    broadcast('entrega-lancada', registro, 'entregas-lancamento');
    broadcast('entrega-lancada', registro, 'entregas');
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/entregas/meus', requireSection('entregas-lancamento'), async (req, res) => {
  if (req.isMaster) return res.json(await entregasLive.listAll());
  res.json(await entregasLive.listByUnidades(req.permissions.unidades || []));
});

// dashboard de acompanhamento (secao separada - pode ser liberada sem dar
// acesso de lançamento, e vice-versa) - junta o historico da planilha
// (AppSheet, somente leitura) com os lançamentos ao vivo pela loja
app.get('/api/entregas', requireSection('entregas'), async (req, res) => {
  res.json(auth.filterByUnidade(req, [...entregasHistoricoData, ...(await entregasLive.listAll())]));
});

// ---------- relatorios (CSV/PDF) do dashboard de Entregas: Por entregador,
// Por unidade, Lançamentos - mesmos 3 paineis de entregas.html, com os
// mesmos filtros de periodo/unidades ativos na tela ----------
function filtrarEntregasPeriodo(lista, req) {
  const { inicio, fim, unidades } = req.query;
  const unidadesSet = unidades ? new Set(String(unidades).split(',').filter(Boolean)) : null;
  return lista.filter((d) =>
    (!unidadesSet || unidadesSet.has(d.unidade)) &&
    (!inicio || (d.data || '') >= inicio) &&
    (!fim || (d.data || '') <= fim)
  );
}
function unidadeNomeEntrega(d) { return d.unidade ? nomeCanonicoUnidade(d.unidade, d.unidadeNome) : (d.unidadeNome || '—'); }

function prepararEntregasPorEntregador(rows) {
  const colunas = [
    { key: 'unidade', label: 'Unidade' }, { key: 'entregador', label: 'Nome' }, { key: 'quant', label: 'Quant.' },
    { key: 'valor', label: 'Valor' }, { key: 'ajudaCusto', label: 'Ajuda de Custo' }, { key: 'entrega', label: 'Entrega' },
    { key: 'retorno', label: 'Retorno' }, { key: 'extra', label: 'Extra' }, { key: 'bonus', label: 'Valor Gami' },
    { key: 'foraDeArea', label: 'Fora de Área' }, { key: 'coopRecebe', label: 'COOP recebe' }, { key: 'tm', label: 'TM' },
  ];
  const porEntregador = {};
  rows.forEach((r) => {
    const chave = r.entregador + '::' + r.unidade;
    const c = (porEntregador[chave] ||= { entregador: r.entregador, unidade: unidadeNomeEntrega(r), entrega: 0, retorno: 0, extra: 0, foraDeArea: 0, ajudaCusto: 0, bonus: 0, valor: 0, coopRecebe: 0 });
    c.entrega += r.entrega || 0; c.retorno += r.retorno || 0; c.extra += r.extra || 0; c.foraDeArea += r.foraDeArea || 0;
    c.ajudaCusto += r.ajudaCusto || 0; c.bonus += r.bonus || 0; c.valor += r.valor || 0; c.coopRecebe += r.coopRecebe || 0;
  });
  const linhas = Object.values(porEntregador).sort((a, b) => b.valor - a.valor).map((c) => ({
    unidade: c.unidade, entregador: c.entregador, quant: c.entrega + c.extra + c.retorno,
    valor: reportUtil.fmtMoneyBR(c.valor), ajudaCusto: reportUtil.fmtMoneyBR(c.ajudaCusto),
    entrega: c.entrega, retorno: c.retorno, extra: c.extra, bonus: reportUtil.fmtMoneyBR(c.bonus),
    foraDeArea: c.foraDeArea, coopRecebe: reportUtil.fmtMoneyBR(c.coopRecebe),
    tm: reportUtil.fmtMoneyBR(c.entrega ? c.valor / c.entrega : 0),
  }));
  return { colunas, linhas };
}

function prepararEntregasPorUnidade(rows) {
  const colunas = [
    { key: 'unidade', label: 'Unid.' }, { key: 'corridas', label: 'Corridas' }, { key: 'entrega', label: 'Entregas' },
    { key: 'retorno', label: 'Retorno' }, { key: 'extra', label: 'Extra' }, { key: 'foraDeArea', label: 'Fora área' },
    { key: 'bonus', label: 'Bônus' }, { key: 'ajudaCusto', label: 'Ajuda custo' },
    { key: 'valor', label: 'Valor pago' }, { key: 'coopRecebe', label: 'COOP recebe' }, { key: 'tm', label: 'TM' },
  ];
  const porUnidade = {};
  rows.forEach((r) => {
    const c = (porUnidade[r.unidade] ||= { nome: unidadeNomeEntrega(r), corridas: 0, entrega: 0, retorno: 0, extra: 0, foraDeArea: 0, bonus: 0, ajudaCusto: 0, valor: 0, coopRecebe: 0 });
    c.corridas++; c.entrega += r.entrega || 0; c.retorno += r.retorno || 0; c.extra += r.extra || 0;
    c.foraDeArea += r.foraDeArea || 0; c.bonus += r.bonus || 0; c.ajudaCusto += r.ajudaCusto || 0;
    c.valor += r.valor || 0; c.coopRecebe += r.coopRecebe || 0;
  });
  const linhas = Object.values(porUnidade).sort((a, b) => b.valor - a.valor).map((c) => ({
    unidade: c.nome, corridas: c.corridas, entrega: c.entrega, retorno: c.retorno, extra: c.extra, foraDeArea: c.foraDeArea,
    bonus: reportUtil.fmtMoneyBR(c.bonus), ajudaCusto: reportUtil.fmtMoneyBR(c.ajudaCusto),
    valor: reportUtil.fmtMoneyBR(c.valor), coopRecebe: reportUtil.fmtMoneyBR(c.coopRecebe),
    tm: reportUtil.fmtMoneyBR(c.entrega ? c.valor / c.entrega : 0),
  }));
  return { colunas, linhas };
}

const MOTIVOS_REMOCAO_CAMPO_LABEL = { atraso: 'Atraso', saiu_antes: 'Saiu antes do fim do turno', prejuizo: 'Gerou prejuízo', outro: 'Outro' };

function prepararEntregasLancamentos(rows) {
  const colunas = [
    { key: 'data', label: 'Data' }, { key: 'unidade', label: 'Unid.' }, { key: 'entregador', label: 'Entregador' },
    { key: 'entrega', label: 'Entregas' }, { key: 'retorno', label: 'Retorno' }, { key: 'extra', label: 'Extra' },
    { key: 'pos00hs', label: 'Pos 00hs' }, { key: 'foraDeArea', label: 'Fora área' }, { key: 'bonus', label: 'Bônus' },
    { key: 'ajudaCusto', label: 'Ajuda custo' }, { key: 'camposRemovidos', label: 'Campos removidos' },
    { key: 'valor', label: 'Valor' }, { key: 'coopRecebe', label: 'COOP' },
    { key: 'quantTotal', label: 'Qtd. total' }, { key: 'observacao', label: 'Observação' },
  ];
  const linhas = [...rows].sort((a, b) => (b.data || '').localeCompare(a.data || '')).map((d) => ({
    data: reportUtil.fmtDataBR(d.data), unidade: unidadeNomeEntrega(d), entregador: d.entregador || '—',
    entrega: d.entrega || 0, retorno: d.retorno || 0, extra: d.extra || 0, pos00hs: d.pos00hs || 0, foraDeArea: d.foraDeArea || 0,
    bonus: reportUtil.fmtMoneyBR(d.bonus), ajudaCusto: reportUtil.fmtMoneyBR(d.ajudaCusto),
    camposRemovidos: (d.camposRemovidos && d.camposRemovidos.length)
      ? `${d.camposRemovidos.join(', ')} (${MOTIVOS_REMOCAO_CAMPO_LABEL[d.motivoRemocaoCampos] || 'Sim'})`
      : '—',
    valor: reportUtil.fmtMoneyBR(d.valor), coopRecebe: reportUtil.fmtMoneyBR(d.coopRecebe),
    quantTotal: d.quantTotal || 0, observacao: d.observacao || '—',
  }));
  return { colunas, linhas };
}

async function todasEntregasPermitidas(req) {
  return auth.filterByUnidade(req, [...entregasHistoricoData, ...(await entregasLive.listAll())]);
}

app.get('/api/entregas/relatorio-entregadores.:formato(csv|pdf)', requireSection('entregas'), async (req, res) => {
  const rows = filtrarEntregasPeriodo(await todasEntregasPermitidas(req), req);
  const { colunas, linhas } = prepararEntregasPorEntregador(rows);
  if (req.params.formato === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${reportUtil.nomeArquivoComData('entregas-por-entregador')}.csv"`);
    return res.send(reportUtil.toCSV(colunas, linhas));
  }
  reportUtil.writePDF(res, { titulo: 'Entregas · Por Entregador', subtitulo: `Exportado em ${reportUtil.agoraBrasiliaFmt()} · ${linhas.length} entregador(es)`, colunas, linhas, nomeArquivo: reportUtil.nomeArquivoComData('entregas-por-entregador') });
});

app.get('/api/entregas/relatorio-unidades.:formato(csv|pdf)', requireSection('entregas'), async (req, res) => {
  const rows = filtrarEntregasPeriodo(await todasEntregasPermitidas(req), req);
  const { colunas, linhas } = prepararEntregasPorUnidade(rows);
  if (req.params.formato === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${reportUtil.nomeArquivoComData('entregas-por-unidade')}.csv"`);
    return res.send(reportUtil.toCSV(colunas, linhas));
  }
  reportUtil.writePDF(res, { titulo: 'Entregas · Por Unidade', subtitulo: `Exportado em ${reportUtil.agoraBrasiliaFmt()} · ${linhas.length} unidade(s)`, colunas, linhas, nomeArquivo: reportUtil.nomeArquivoComData('entregas-por-unidade') });
});

app.get('/api/entregas/relatorio-lancamentos.:formato(csv|pdf)', requireSection('entregas'), async (req, res) => {
  const rows = filtrarEntregasPeriodo(await todasEntregasPermitidas(req), req);
  const { colunas, linhas } = prepararEntregasLancamentos(rows);
  if (req.params.formato === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${reportUtil.nomeArquivoComData('entregas-lancamentos')}.csv"`);
    return res.send(reportUtil.toCSV(colunas, linhas));
  }
  reportUtil.writePDF(res, { titulo: 'Entregas · Lançamentos', subtitulo: `Exportado em ${reportUtil.agoraBrasiliaFmt()} · ${linhas.length} lançamento(s)`, colunas, linhas, nomeArquivo: reportUtil.nomeArquivoComData('entregas-lancamentos') });
});

app.get('/api/entregas/etiqueta/:id', (req, res, next) => {
  if (!req.isMaster && !auth.hasSection(req, 'entregas') && !auth.hasSection(req, 'entregas-lancamento')) {
    return res.status(403).json({ error: 'Você não tem acesso a essa área.' });
  }
  next();
}, async (req, res) => {
  const registro = await entregasLive.getOne(req.params.id);
  if (!registro || !registro.etiquetaPath) return res.sendStatus(404);
  if (!req.isMaster && !(req.permissions.unidades || []).includes(registro.unidade)) return res.sendStatus(404);
  storage.streamArquivo(registro.etiquetaPath, null, res);
});

app.post('/api/entregas/:id/solicitar-edicao', requireSection('entregas-lancamento'), async (req, res) => {
  try {
    const atual = await entregasLive.getOne(req.params.id);
    if (!atual) return res.status(404).json({ error: 'Lançamento não encontrado.' });
    if (!req.isMaster && !(req.permissions.unidades || []).includes(atual.unidade)) {
      return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    }
    const pedido = await entregasLive.solicitarEdicao({
      entregaId: req.params.id,
      mudancas: req.body.mudancas,
      motivo: req.body.motivo,
      solicitadoPorId: req.user.id,
      solicitadoPorEmail: req.user.email,
    });
    broadcast('entrega-edicao-solicitada', pedido, 'entregas-lancamento');
    res.json(pedido);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// edicao direta - so o Master, sem fila de aprovacao (ainda fica no historico)
app.patch('/api/entregas/:id/editar-direto', auth.requireMaster, async (req, res) => {
  try {
    const registro = await entregasLive.editarDireto({
      entregaId: req.params.id,
      mudancas: req.body.mudancas,
      motivo: req.body.motivo,
      editadoPorEmail: req.user.email,
    });
    broadcast('entrega-editada-direto', registro, 'entregas-lancamento');
    broadcast('entrega-editada-direto', registro, 'entregas');
    res.json(registro);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/entregas/edicoes', requireSection('entregas-lancamento'), async (req, res) => {
  const todas = await entregasLive.listarEdicoes();
  if (req.isMaster) return res.json(todas);
  res.json(todas.filter((p) => p.solicitadoPorId === req.user.id));
});

app.patch('/api/entregas/edicoes/:id', auth.requireMaster, async (req, res) => {
  try {
    const pedido = await entregasLive.decidirEdicao(req.params.id, req.body.status, {
      decididoPorEmail: req.user.email,
      motivoDecisao: req.body.motivoDecisao,
    });
    broadcast('entrega-edicao-decidida', pedido, 'entregas-lancamento');
    broadcast('entrega-edicao-decidida', pedido, 'entregas');
    res.json(pedido);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- vendas do iFood (secao "ifood") ----------
// so leitura - dados financeiros da Sales API do iFood (nao tem lançamento
// manual nem edição, diferente de Fechamentos/Entregas), sincronizados
// periodicamente por ifoodSync (ver boot mais abaixo). Mesmo espaco de
// "unidade" das outras seções (o merchantId do iFood vira o código
// filtrado por permissao, igual FECHAMENTO_UNIDADES_NOMES/ENTREGAS_UNIDADES_NOMES).
app.get('/api/ifood/vendas', requireSection('ifood'), async (req, res) => {
  res.json(auth.filterByUnidade(req, await ifoodStore.listAllCached()));
});

// ---------- relatorios (CSV/PDF) do dashboard de iFood: Por unidade, Vendas -
// mesmos 2 paineis de ifood.html, com os mesmos filtros de periodo/unidades
// ativos na tela ----------
function filtrarVendasIfoodPeriodo(lista, req) {
  const { inicio, fim, unidades } = req.query;
  const unidadesSet = unidades ? new Set(String(unidades).split(',').filter(Boolean)) : null;
  return lista.filter((d) => {
    const dataVenda = (d.dataHora || '').slice(0, 10);
    return (!unidadesSet || unidadesSet.has(d.unidade)) &&
      (!inicio || dataVenda >= inicio) &&
      (!fim || dataVenda <= fim);
  });
}

function prepararIfoodPorUnidade(rows) {
  const colunas = [
    { key: 'unidade', label: 'Unid.' }, { key: 'vendas', label: 'Vendas' }, { key: 'bruto', label: 'Valor bruto' },
    { key: 'comissao', label: 'Comissão' }, { key: 'liquido', label: 'Valor líquido' }, { key: 'tm', label: 'Ticket médio' },
  ];
  const porUnidade = {};
  rows.forEach((r) => {
    const c = (porUnidade[r.unidade] ||= { vendas: 0, bruto: 0, comissao: 0, liquido: 0 });
    c.vendas++; c.bruto += r.valorBruto || 0; c.comissao += r.taxaComissao || 0; c.liquido += r.valorLiquido || 0;
  });
  const linhas = Object.entries(porUnidade).sort((a, b) => b[1].bruto - a[1].bruto).map(([u, c]) => ({
    unidade: ifoodClient.IFOOD_UNIDADES_NOMES[u] || u, vendas: c.vendas, bruto: reportUtil.fmtMoneyBR(c.bruto),
    comissao: reportUtil.fmtMoneyBR(c.comissao), liquido: reportUtil.fmtMoneyBR(c.liquido),
    tm: reportUtil.fmtMoneyBR(c.vendas ? c.bruto / c.vendas : 0),
  }));
  return { colunas, linhas };
}

function prepararIfoodVendas(rows) {
  const colunas = [
    { key: 'data', label: 'Data' }, { key: 'unidade', label: 'Unid.' }, { key: 'numeroPedido', label: 'Nº pedido' },
    { key: 'bruto', label: 'Valor bruto' }, { key: 'comissao', label: 'Comissão' }, { key: 'liquido', label: 'Valor líquido' },
    { key: 'formaPagamento', label: 'Forma pagto' }, { key: 'status', label: 'Status' },
  ];
  const linhas = [...rows].sort((a, b) => (b.dataHora || '').localeCompare(a.dataHora || '')).map((d) => ({
    data: reportUtil.fmtDataHoraBR(d.dataHora), unidade: ifoodClient.IFOOD_UNIDADES_NOMES[d.unidade] || d.unidade || '—',
    numeroPedido: d.numeroPedido || '—', bruto: reportUtil.fmtMoneyBR(d.valorBruto), comissao: reportUtil.fmtMoneyBR(d.taxaComissao),
    liquido: reportUtil.fmtMoneyBR(d.valorLiquido), formaPagamento: d.formaPagamento || '—', status: d.status || '—',
  }));
  return { colunas, linhas };
}

app.get('/api/ifood/relatorio-unidades.:formato(csv|pdf)', requireSection('ifood'), async (req, res) => {
  const rows = filtrarVendasIfoodPeriodo(auth.filterByUnidade(req, await ifoodStore.listAllCached()), req);
  const { colunas, linhas } = prepararIfoodPorUnidade(rows);
  if (req.params.formato === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${reportUtil.nomeArquivoComData('ifood-por-unidade')}.csv"`);
    return res.send(reportUtil.toCSV(colunas, linhas));
  }
  reportUtil.writePDF(res, { titulo: 'iFood · Por Unidade', subtitulo: `Exportado em ${reportUtil.agoraBrasiliaFmt()} · ${linhas.length} unidade(s)`, colunas, linhas, nomeArquivo: reportUtil.nomeArquivoComData('ifood-por-unidade') });
});

app.get('/api/ifood/relatorio-vendas.:formato(csv|pdf)', requireSection('ifood'), async (req, res) => {
  const rows = filtrarVendasIfoodPeriodo(auth.filterByUnidade(req, await ifoodStore.listAllCached()), req);
  const { colunas, linhas } = prepararIfoodVendas(rows);
  if (req.params.formato === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${reportUtil.nomeArquivoComData('ifood-vendas')}.csv"`);
    return res.send(reportUtil.toCSV(colunas, linhas));
  }
  reportUtil.writePDF(res, { titulo: 'iFood · Vendas', subtitulo: `Exportado em ${reportUtil.agoraBrasiliaFmt()} · ${linhas.length} venda(s)`, colunas, linhas, nomeArquivo: reportUtil.nomeArquivoComData('ifood-vendas') });
});

app.get('/api/ifood/sincronizacao', requireSection('ifood'), (req, res) => {
  res.json(ifoodSync.getStatus());
});

// forca uma sincronizacao imediata - so o Master (evita chamadas extras na API do iFood sem necessidade)
app.post('/api/ifood/sincronizar', auth.requireMaster, async (req, res) => {
  const status = await ifoodSync.sincronizarVendasIfood();
  res.json(status);
});

app.use(express.static(path.join(__dirname, 'public')));

// mensagens amigaveis pros erros mais comuns de upload (arquivo grande demais,
// anexos demais) em vez de estourar uma pagina de erro generica do Express
app.use((err, req, res, next) => {
  if (err && err.name === 'MulterError') {
    const mensagens = {
      LIMIT_FILE_SIZE: 'Arquivo muito grande (máximo 50MB por anexo).',
      LIMIT_FILE_COUNT: 'Muitos arquivos de uma vez (máximo 8 anexos por registro).',
      LIMIT_UNEXPECTED_FILE: 'Campo de arquivo inesperado no envio.',
    };
    return res.status(400).json({ error: mensagens[err.code] || 'Erro ao enviar anexo: ' + err.message });
  }
  next(err);
});

(async () => {
  try {
    await store.init(); // carrega o historico do Firestore antes de aceitar trafego
  } catch (err) {
    // se o Firestore estiver temporariamente indisponivel (ex: cota
    // estourada, RESOURCE_EXHAUSTED) o app ainda sobe com o cache vazio
    // (em vez de nao subir de jeito nenhum) - assim que o Firestore
    // normalizar, as proximas leituras/gravacoes voltam a funcionar
    // sozinhas, sem precisar de um redeploy manual.
    console.error('Falha ao carregar historico do Firestore no boot (app sobe mesmo assim, com cache vazio):', err.message);
  }
  try {
    await auth.ensureMaster(); // garante que existe um acesso Master pra logar
  } catch (err) {
    console.error('Falha ao garantir usuario Master no boot:', err.message);
  }

  app.listen(PORT, async () => {
    console.log(`Zenith Ops rodando em http://localhost:${PORT}`);
    // status do atendente virtual do chat de suporte (ver suporteBot.js) -
    // uma linha no log do Render pra conferir na hora se a env var pegou
    console.log(suporteBot.ativo()
      ? '🤖 Beniboy (chat de suporte) ATIVO - ANTHROPIC_API_KEY configurada.'
      : '🤖 Beniboy (chat de suporte) desativado - configure a env var ANTHROPIC_API_KEY pra ligar.');
    console.log(`Webhook: POST http://localhost:${PORT}/webhooks/adyen`);

    const contas = Object.keys(HMAC_KEYS);
    if (contas.length) console.log(`HMAC configurada para: ${contas.join(', ')}`);
    else if (!LEGACY_HMAC_KEY) console.warn('AVISO: nenhuma ADYEN_HMAC_KEYS/ADYEN_HMAC_KEY configurada - assinatura nao esta sendo verificada.');

    // relatorio periodico de transacoes (PDF+CSV) + limpeza do banco: gera o
    // retrato do periodo antes de apagar - so fica retido pra sempre quem
    // teve chargeback/fraude (ver store.pruneOld). Roda no start e depois a
    // cada RELATORIO_INTERVALO_DIAS dias (2 por padrao).
    relatorios.rodarRelatorio().catch((err) => console.error('Erro ao gerar relatório periódico:', err.message));
    setInterval(() => {
      relatorios.rodarRelatorio().catch((err) => console.error('Erro ao gerar relatório periódico:', err.message));
    }, relatorios.INTERVALO_DIAS * 24 * 60 * 60 * 1000);

    // backup automatico do banco: roda no start e depois 1x/dia (o Master
    // tambem pode acionar na hora pela tela de Usuarios/Backup)
    backup.rodarBackup().catch((err) => console.error('Erro no backup automático:', err.message));
    setInterval(() => {
      backup.rodarBackup().catch((err) => console.error('Erro no backup automático:', err.message));
    }, 24 * 60 * 60 * 1000);

    // retencao do Abastecimento (decisao do Master 2026-08-09): registros
    // com mais de N dias (30 por padrao; env ABASTECIMENTO_RETENCAO_DIAS)
    // sao salvos em JSON no Storage e APAGADOS do Firestore - roda 1x/dia.
    // Falha no upload = nada apagado (ver arquivarAntigos).
    const rodarRetencaoAbastecimento = () => abastecimentoCarrinho.arquivarAntigos()
      .then((r) => { if (r.arquivados) console.log(`Abastecimento: ${r.arquivados} registro(s) com mais de ${r.dias} dias arquivados em ${r.arquivo}`); })
      .catch((err) => console.error('Erro na retenção do Abastecimento:', err.message));
    rodarRetencaoAbastecimento();
    setInterval(rodarRetencaoAbastecimento, 24 * 60 * 60 * 1000);

    // planilhas do Google Sheets (fechamentos + entregas): SEM sincronizacao
    // automatica - decisao do Master em 2026-08-09 (antes havia janelas fixas
    // de 05:00/18:00). Roda 1x no boot porque o historico vive em memoria -
    // sem essa carga inicial as telas de Fechamentos/Entregas ficariam
    // vazias a cada deploy/reinicio do Render. Depois disso, planilha so e
    // lida quando o Master aciona o botao "Sincronizar" na tela. TODA
    // leitura (boot incluso) e incremental: o ponto da ultima sincronizacao
    // fica salvo no Storage e so as linhas novas desde ela sao lidas - a
    // planilha inteira so no primeiro uso ou com { completa: true }
    // (ver sheetsSync.js/criarPersistenciaEstado).
    sincronizarPlanilhasFechamento();
    sincronizarPlanilhaEntregas();

    // pre-aquece em segundo plano os caches das colecoes mais acessadas
    // (as que o Painel dispara ao abrir). Sem isso, o primeiro visitante
    // depois de um deploy/reinicio paga a leitura completa de varias
    // colecoes na frente dele - o "delay pra carregar" relatado em
    // 2026-08-09. Com o stale-while-revalidate do liveCache, depois desta
    // carga inicial nenhuma requisicao volta a esperar releitura de cache.
    Promise.allSettled([
      fechamentosLive.listAll(), entregasLive.listAll(), solicitacoes.listAll(),
      parque.listAll(), festas.listAll(), mensalistas.listAll(),
      chamadosTI.listAll(), sangrias.listAll(),
    ]).then((r) => {
      const falhas = r.filter((x) => x.status === 'rejected').length;
      console.log(`Caches pré-aquecidos (${r.length - falhas}/${r.length} coleções).`);
    });

    // sincroniza as vendas do iFood (Sales API - so leitura, ver
    // server/ifoodClient.js): roda no start e depois periodicamente. Padrao
    // bem mais espaçado que o Sheets Sync (1h) porque a Sales API e um
    // relatorio financeiro que so fecha de vez em D+1/D+2 - nao ha ganho em
    // consultar com mais frequencia que isso.
    ifoodSync.sincronizarVendasIfood().catch((err) => console.error('Erro ao sincronizar vendas do iFood:', err.message));
    const intervaloIfood = Number(process.env.IFOOD_SYNC_INTERVAL_MS) || 60 * 60 * 1000;
    setInterval(() => {
      ifoodSync.sincronizarVendasIfood().catch((err) => console.error('Erro ao sincronizar vendas do iFood:', err.message));
    }, intervaloIfood);

    // varredura do check-in automatico do Saltiverso: pra cada check-in do
    // dia com horarioPrevisto ja vencido e que ninguem confirmou na mao, o
    // relogio comeca sozinho nesse horario. Esse e o fluxo NORMAL do parque
    // (o botao manual so serve pra entrada ANTECIPADA - entra antes, sai
    // antes), entao nao gera push/alerta nenhum: so o broadcast SSE pras
    // telas abertas atualizarem a lista. Roda a cada 1 minuto.
    // fora do horario de funcionamento do parque (shopping fechado) nao
    // existe check-in pra iniciar - pular a varredura de madrugada corta
    // ~1/3 das consultas diarias ao Firestore desse job e deixa o servidor
    // quieto quando so ha abas esquecidas abertas
    const horaBrasilia = () => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }).format(new Date()).replace('24', '0'));
    const rodarAutoCheckinsParque = async () => {
      const h = horaBrasilia();
      if (h < 8 || h >= 23) return;
      const feitos = await parque.rodarAutoCheckins();
      for (const c of feitos) {
        broadcast('parque-checkin-automatico', c, 'parque');
        broadcast('parque-checkin-automatico', c, 'parque-checkin');
      }
    };
    rodarAutoCheckinsParque().catch((err) => console.error('Erro na varredura de check-in automático:', err.message));
    setInterval(() => {
      rodarAutoCheckinsParque().catch((err) => console.error('Erro na varredura de check-in automático:', err.message));
    }, 60 * 1000);

    // varredura do chat de suporte (Beniboy): conversa ABERTA sem nenhuma
    // mensagem nova (visitante ou time) ha mais de 40min se encerra sozinha
    // (SEM_SOLUCAO, ver suporteChat.finalizarOciosos) - evita conversa morta
    // pendurada pra sempre no funil da Central do Beniboy. Roda a cada 5min.
    const rodarFinalizacaoOciososSuporte = async () => {
      const finalizados = await suporteChat.finalizarOciosos();
      for (const chat of finalizados) broadcast('suporte-chat', { id: chat.id }, 'suporte');
    };
    rodarFinalizacaoOciososSuporte().catch((err) => console.error('Erro na varredura de chats ociosos do suporte:', err.message));
    setInterval(() => {
      rodarFinalizacaoOciososSuporte().catch((err) => console.error('Erro na varredura de chats ociosos do suporte:', err.message));
    }, 5 * 60 * 1000);

    // varredura de conectividade das lojas (ver lojaStatus.varrerAlertas) -
    // quiosque (atendimento.html) parou de mandar heartbeat -> avisa Master/
    // Suporte (push+SSE), no espirito de alerta de RMM (Atera etc) que o
    // usuario pediu. Roda a cada 1min - o limiar de 90s ja da folga suficiente
    // pra nao confundir jitter de rede com queda de verdade.
    const rodarVarreduraLojaStatus = async () => {
      const transicoes = await lojaStatus.varrerAlertas();
      if (!transicoes.length) return;
      const mapa = await construirUnidadesMapa();
      for (const t of transicoes) {
        const nome = mapa[t.codigo] || t.codigo;
        broadcast('loja-status-mudou', { codigo: t.codigo, posto: t.posto, nome, computadorNome: t.nome, tipo: t.tipo }, 'suporte');
        if (t.tipo === 'offline') push.notifyLojaOffline(nome, t.codigo, t.nome, t.posto).catch((err) => console.error('Erro no push de loja offline:', err.message));
        else push.notifyLojaVoltou(nome, t.codigo, t.nome, t.posto).catch((err) => console.error('Erro no push de loja online:', err.message));
      }
    };
    setInterval(() => {
      rodarVarreduraLojaStatus().catch((err) => console.error('Erro na varredura de conectividade das lojas:', err.message));
    }, 60 * 1000);

    // reforco do alarme critico do Beniboy (ver reforcarAlarmesBeniboy) -
    // roda a cada 15s, so repete de fato quem passou de REALERTA_MS (30s)
    // sem ninguem assumir. Varredura mais rapida que o proprio REALERTA_MS
    // pra nao empilhar atraso em cima do atraso (senao o reforco "de 30s"
    // virava de fato ~1min30 esperando o proximo tick de 1min)
    setInterval(() => {
      reforcarAlarmesBeniboy().catch((err) => console.error('Erro no reforço do alarme do Beniboy:', err.message));
    }, 15 * 1000);

    // RH: alerta do 5o dia de teste (ver rh.verificarTestesVencidos) - so
    // roda dentro do horario comercial (evita acordar ninguem de madrugada);
    // a checagem em si (alertaTesteEnviadoEm) garante que cada funcionario
    // so gera 1 push, mesmo rodando de hora em hora
    const rodarAlertaTesteRh = async () => {
      const h = horaBrasilia();
      if (h < 8 || h >= 20) return;
      const vencidos = await rh.verificarTestesVencidos();
      for (const f of vencidos) {
        push.notifyRhTesteVencido(f);
        broadcast('rh-teste-vencido', { id: f.id, unidade: f.unidade, nome: f.nome }, 'rh');
        await rh.marcarAlertaTesteEnviado(f.id);
      }
    };
    rodarAlertaTesteRh().catch((err) => console.error('Erro no alerta de teste do RH:', err.message));
    setInterval(() => {
      rodarAlertaTesteRh().catch((err) => console.error('Erro no alerta de teste do RH:', err.message));
    }, 60 * 60 * 1000);

    // RH: experiencia formal (CLT, 30+60 dias) perto do prazo - avisos
    // escalonados em D-5/D-3/D-2/D-1 (ver rh.verificarAlertasExperiencia);
    // so no D-1 (ultimo aviso antes do vencimento) o gerente da unidade
    // tambem e avisado, alem do RH/Admin/Master (ver notifyExperienciaPrazoGerente)
    const rodarAlertaExperienciaRh = async () => {
      const h = horaBrasilia();
      if (h < 8 || h >= 20) return;
      const pendencias = await rh.verificarAlertasExperiencia();
      for (const { funcionario, diasRestantes, limite } of pendencias) {
        push.notifyExperienciaPrazo(funcionario, diasRestantes);
        if (limite === 1) push.notifyExperienciaPrazoGerente(funcionario);
        broadcast('rh-funcionario-atualizado', { id: funcionario.id, unidade: funcionario.unidade }, 'rh');
        await rh.marcarAlertaExperienciaEnviado(funcionario.id, limite);
      }
    };
    rodarAlertaExperienciaRh().catch((err) => console.error('Erro no alerta de experiência do RH:', err.message));
    setInterval(() => {
      rodarAlertaExperienciaRh().catch((err) => console.error('Erro no alerta de experiência do RH:', err.message));
    }, 60 * 60 * 1000);

    // RH: advertencia aprovada que passou das 48h sem o RH anexar o
    // documento (ver rhAdvertencias.verificarPrazosVencidos) - roda o dia
    // inteiro (nao so horario comercial, o prazo corre sem parar); o campo
    // alertaPrazoVencidoEnviadoEm garante 1 unico push por solicitacao
    const rodarAlertaAdvertenciaVencida = async () => {
      const vencidas = await rhAdvertencias.verificarPrazosVencidos();
      for (const a of vencidas) {
        push.notifyRhAdvertenciaPrazoVencido(a);
        broadcast('rh-advertencia-atualizada', { id: a.id, unidade: a.unidade }, 'rh');
        await rhAdvertencias.marcarAlertaPrazoVencidoEnviado(a.id);
      }
    };
    rodarAlertaAdvertenciaVencida().catch((err) => console.error('Erro no alerta de prazo de advertência:', err.message));
    setInterval(() => {
      rodarAlertaAdvertenciaVencida().catch((err) => console.error('Erro no alerta de prazo de advertência:', err.message));
    }, 30 * 60 * 1000);

    // relatorio diario do MV por e-mail (ver relatorioMV.js) - so agenda se
    // as credenciais de ENVIO estiverem configuradas (quem manda, RELATORIO_
    // EMAIL_USER/PASS); pra QUEM recebe ha sempre um valor (config editavel
    // em /email.html, com fallback embutido no codigo), entao nao entra
    // nessa checagem. Sem credenciais de envio, o Master ainda pode
    // disparar na hora por GET /api/relatorio-mv/testar (que ai sim avisa o
    // erro de configuração)
    if (process.env.RELATORIO_EMAIL_USER && process.env.RELATORIO_EMAIL_PASS) {
      relatorioMV.iniciarAgendamento().catch((err) => console.error('Erro ao agendar relatório diário MV:', err.message));
    } else {
      console.warn('AVISO: RELATORIO_EMAIL_USER/RELATORIO_EMAIL_PASS não configurados - relatório diário do MV desativado.');
    }
  });
})();
