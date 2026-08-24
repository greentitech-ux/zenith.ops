// index.js
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');

const compression = require('compression');
const db = require('./firestore'); // so pro contador de leituras (ver relatorioLeituras)
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
const pixRepetido = require('./pixRepetido');
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
const liveCacheUtil = require('./liveCache');
const fechamentosReport = require('./fechamentosReport');
const monitorReport = require('./monitorReport');
const reportUtil = require('./reportUtil');
const sangrias = require('./sangrias');
const entregasLive = require('./entregasLive');
const entregasRegras = require('./entregasRegras');
const backup = require('./backup');
const relatorios = require('./relatorios');
const sheetsSync = require('./sheetsSync');
const bravoImport = require('./bravoImport');
const bravoMapa = require('./bravoMapa');
const entregasSync = require('./entregasSync');
const ifoodClient = require('./ifoodClient');
const ifoodStore = require('./ifoodStore');
const ifoodSync = require('./ifoodSync');
const solicitacoes = require('./solicitacoes');
const acessosPessoa = require('./acessosPessoa');
const formularios = require('./formularios');
const formulariosUnidades = require('./formulariosUnidades');
const comprasAcompanhamento = require('./comprasAcompanhamento');
const chamadosTI = require('./chamadosTI');
const chamadoRelatorio = require('./chamadoRelatorio');
const chamadosManutencao = require('./chamadosManutencao');
const suporteChat = require('./suporteChat');
const suporteChatPDF = require('./suporteChatPDF');
const segurancaChat = require('./segurancaChat');
const suporteBot = require('./suporteBot');
const pedidoWatch = require('./pedidoWatch');
const preferencias = require('./preferencias');
const docsMaster = require('./docsMaster');
const abastecimentoCarrinho = require('./abastecimentoCarrinho');
const abastecimentoPrevisao = require('./abastecimentoPrevisao');
const ativosTI = require('./ativosTI');
const centralChat = require('./centralChat');
const grupos = require('./grupos');
const empresas = require('./empresas');
const mensagensDiretas = require('./mensagensDiretas');
const redes = require('./redes');
const vendasRecordes = require('./vendasRecordes');
const inventario = require('./inventario');
const inventarioNotaOcr = require('./inventarioNotaOcr');
const canaisVendaOcr = require('./canaisVendaOcr');
const documentoIdentidadeOcr = require('./documentoIdentidadeOcr');
const rhCamposConfig = require('./rhCamposConfig');
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
const bonificacaoPerfis = require('./bonificacaoPerfis');
const bonificacao = require('./bonificacao');
const rhAdvertencias = require('./rhAdvertencias');
const unidadesExtras = require('./unidades');
const migracaoUnidades = require('./migracaoUnidades');
const pedidoSemanal = require('./pedidoSemanal');
const lojaStatus = require('./lojaStatus');
const qaAprovacoes = require('./qaAprovacoes');
const alertasCentral = require('./alertasCentral');
const agenteAcoes = require('./agenteAcoes');
const vigiaScript = require('./vigiaScript');
const loginCustom = require('./loginCustom');

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

// foto/PDF da nota fiscal de recebimento (ver inventarioNotaOcr.js) - vai
// pro Claude com visao, limite mais folgado que o do chat (nota as vezes vem
// como PDF escaneado em resolucao alta) mas sem chegar nos 50MB do upload
// generico, que e overkill pra 1 documento
const uploadNotaFiscal = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
});

// relatorio do PDV pra leitura dos Canais/Formas (ver canaisVendaOcr.js):
// diferente da nota fiscal, aqui podem vir VARIAS imagens do mesmo
// relatorio - a tela do Pulse nao cabe num print so quando a loja tem
// muito canal, e o gerente acaba fotografando em partes. O teto de 5 e o
// ponto em que a conta de tokens por leitura ainda vale a pena.
const uploadRelatorioPdv = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 5 },
});

// documento de identidade do cadastro de RH (ver documentoIdentidadeOcr.js):
// frente + verso + eventual segunda via. Limite por arquivo menor que o do
// relatorio do PDV porque e foto de documento, nao print de tela cheia
const uploadDocumentoIdentidade = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 3 },
});

// arquivo do pedido semanal que a loja anexa pra confirmar (ver
// pedidoSemanal.js) - vem do sistema do fornecedor, entao pode ser PDF,
// print da tela ou planilha; 1 por semana, sem teto apertado porque um
// pedido de insumos as vezes sai como PDF de varias paginas
const uploadPedidoSemanal = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
});

// fundo customizado da tela de login (ver loginCustom.js) - so imagem,
// limite generoso o bastante pra uma foto de boa qualidade sem exagerar
const uploadLoginFundo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
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

// gzip em TODA resposta compressivel (JSON, HTML, CSV, JS). Motivo direto:
// o plano free do Render inclui so 5 GB/mes de banda e o servico foi
// SUSPENSO por estourar isso em 20/08/2026. O /api/fechamentos sozinho
// devolve ~2,1 MB por chamada sem compressao - com gzip cai pra ~0,30 MB
// (7x). O filtro tira o SSE (/api/stream): o compression bufferiza o corpo
// e um event-stream comprimido so chega ao navegador quando o buffer enche,
// o que mataria o "tempo real" dos eventos. PDF ja e comprimido e o proprio
// compression pula tipos nao-compressiveis; o threshold padrao (1 KB) deixa
// resposta minuscula passar direto.
app.use(compression({
  filter: (req, res) => {
    if (req.path === '/api/stream') return false;
    return compression.filter(req, res);
  },
}));

// Atribuicao de LEITURAS do Firestore por rota (ver o contador em
// firestore.js). Precisa embrulhar o resto da cadeia num AsyncLocalStorage:
// com varias requisicoes em voo, medir "antes e depois" no middleware
// colocaria a leitura de uma rota na conta de outra. Usa req.path e nao
// req.originalUrl de proposito - id e querystring virariam milhares de
// chaves distintas no relatorio, escondendo justamente o padrao que a gente
// quer enxergar.
app.use((req, res, next) => {
  // contador ausente (fake do testeRotas.js, ou instalacao que falhou) nao
  // pode derrubar requisicao nenhuma - diagnostico e acessorio
  if (!db.contextoRota) return next();
  const rota = `${req.method} ${req.path.replace(/\/[0-9a-zA-Z_-]{16,}(?=\/|$)/g, '/:id')}`;
  db.contextoRota.run({ rota }, next);
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
  '/api/meta/endereco',
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
  '/api/rh/ler-documento-publico',
  '/api/rh/campos-config-publico',
  '/api/loja-status/heartbeat',
  '/api/loja-status/vigia-versao',
  '/assinar.html',
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
const ROTA_TICKET_PUBLICO_RE = /^\/api\/central\/[^/]+\/[^/]+\/(publico|chat-publico|decidir-publico|execucao-publico|comprada-publico|comprovante-publico|anexo-publico\/\d+)$/;
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
// NOCZenith reporta saude do HD (SMART/espaco) e a varredura passiva da rede
// local (ver nocMaquina.js) - mesmo motivo publico das outras: quem chama e a
// maquina, sem sessao de usuario. O token do agente continua obrigatorio.
const ROTA_LOJA_TELEMETRIA_RE = /^\/api\/loja-status\/[^/]+\/computadores\/[^/]+\/telemetria$/;
function rotaPublicaSemDashboard(path) {
  return ROTAS_PUBLICAS_SEM_DASHBOARD.has(path) || path.startsWith('/api/suporte-chat/') || path.startsWith('/api/rh/publico/')
    || path.startsWith('/api/formularios-publico/')
    || ROTA_TICKET_PUBLICO_RE.test(path) || ROTA_LOJA_IP_LOCAL_RE.test(path) || ROTA_LOJA_COMANDO_RESULTADO_RE.test(path)
    || ROTA_LOJA_ACESSO_REMOTO_RE.test(path) || ROTA_LOJA_VIGIA_SCRIPT_RE.test(path) || ROTA_LOJA_CHAT_RESPONDER_RE.test(path)
    || ROTA_LOJA_TELEMETRIA_RE.test(path);
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
    res.set('WWW-Authenticate', 'Basic realm="NoPulso"');
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

// Endereco oficial do app, pra tela avisar quem ainda entra pelo antigo.
// Publica e sem Firestore: e so devolver o APP_BASE_URL que ja esta em
// memoria, entao nao custa leitura nenhuma. Existe porque o tema.js e
// servido como arquivo estatico e nao tem como saber o endereco sozinho -
// e cravar o dominio novo no JS quebraria a regra de que APP_BASE_URL e a
// UNICA fonte do endereco (ver CLAUDE.md secao 4).
app.get('/api/meta/endereco', (req, res) => {
  res.json({ oficial: APP_BASE_URL });
});

// personalizacao da tela de login (fundo + balao do robo, ver loginCustom.js
// e o painel em login-custom.html, Master) - publica porque quem le e a
// propria tela de login, antes de qualquer sessao existir
app.get('/api/login-custom', async (req, res) => {
  res.json(loginCustom.semDetalheInterno(await loginCustom.obter()));
});
app.get('/api/login-custom/fundo', async (req, res) => {
  const config = await loginCustom.obter();
  if (!config.fundoArquivo) return res.sendStatus(404);
  storage.streamArquivo(config.fundoArquivo, null, res);
});
// imagem de cada logo do rodapé - pública pelo mesmo motivo do fundo: quem
// lê é a própria tela de login, antes de existir sessão
app.get('/api/login-custom/logo/:id', async (req, res) => {
  const logo = await loginCustom.acharLogo(req.params.id);
  if (!logo || !logo.arquivo) return res.sendStatus(404);
  storage.streamArquivo(logo.arquivo, null, res);
});

// dominio publico do app - usado pra montar links completos (clicaveis fora
// do NoPulso, ex: mandados pelo Beniboy no chat pro colaborador repassar pro
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
// nota) preenchida por QUEM NAO TEM login no NoPulso - pensado pro Beniboy
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
    // fluxo de COMPRA pelo link (ticket-publico.html): quem compra ve se ja
    // foi comprada, a data de entrega e o comprovante, e pode marcar
    comprada: !!r.comprada,
    dataEntregaPrevista: r.dataEntregaPrevista || null,
    temComprovante: !!r.comprovante,
    podeMarcarComprada: tipo === 'compra' && r.status === 'APROVADO' && !r.comprada,
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

// quem fez a compra marca como Comprada pelo link, com data de entrega e/ou
// comprovante da compra (mesmo fluxo Comprada da Central, autorizado pelo
// linkAcao em vez de sessao - ver marcarCompradaComLink em solicitacoes.js)
app.post('/api/central/:tipo/:id/comprada-publico', upload.single('comprovante'), async (req, res) => {
  try {
    if (req.params.tipo === 'estorno') return res.status(400).json({ error: 'Só pedidos de Compra podem ser marcados como Comprada.' });
    const payload = req.is('multipart/form-data') ? JSON.parse(req.body.payload || '{}') : req.body;
    let comprovante = null;
    if (req.file) {
      const registroAtual = await solicitacoes.getOne(req.params.id);
      const path = await storage.salvarArquivo((registroAtual && registroAtual.unidade) || 'geral', req.file, 'solicitacoes');
      comprovante = { nome: req.file.originalname, path, tipo: req.file.mimetype || 'application/octet-stream' };
    }
    const atualizado = await solicitacoes.marcarCompradaComLink(req.params.id, payload.link, {
      dataEntregaPrevista: payload.dataEntregaPrevista, comprovante, autorNome: payload.autorNome,
    });
    broadcast('solicitacao-decidida', atualizado, 'solicitacoes');
    res.json({ ok: true, comprada: true, dataEntregaPrevista: atualizado.dataEntregaPrevista });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// comprovante da COMPRA (o print/nota que quem comprou anexou ao marcar
// Comprada) - mesmo gate por link dos outros arquivos publicos do ticket
app.get('/api/central/:tipo/:id/comprovante-publico', async (req, res) => {
  const registro = await moduloTicket(req.params.tipo).buscarPorLinkAcao(req.params.id, req.query.link);
  if (!registro || !registro.comprovante) return res.sendStatus(404);
  storage.streamArquivo(registro.comprovante.path, registro.comprovante.tipo, res);
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

// ---------- Formulários com assinatura remota (ver formularios.js) ----------
// Lado PÚBLICO: quem recebeu um link de assinatura abre assinar.html no
// celular, confere o formulário e desenha a assinatura - o token do link é
// a credencial (um por papel; nas diárias, um por linha da tabela). Ficam
// ACIMA do app.use('/api', auth.requireAuth), mesmo motivo do ticket-publico.
app.get('/api/formularios-publico/:id', async (req, res) => {
  const vista = await formularios.vistaPublica(req.params.id, req.query.token);
  if (!vista) return res.status(404).json({ error: 'Link de assinatura inválido ou revogado.' });
  res.json(vista);
});

// PREENCHIMENTO POR LINK: o solicitante abre por um token e preenche os
// dados dele. A unidade já está travada no registro - o link não deixa
// escolher loja, só preencher o que falta.
app.get('/api/formularios-publico/preencher/:token', async (req, res) => {
  const vista = await formularios.vistaPreenchimento(req.params.token);
  if (!vista) return res.status(404).json({ error: 'Link de preenchimento inválido.' });
  res.json(vista);
});

// upload.array() só mexe quando o content-type é multipart (Ass. Boleto,
// que precisa mandar o arquivo do documento); requisição JSON pura (os
// outros tipos, sem anexo) passa direto - mesma convivência dos dois
// formatos na mesma rota já usada em /api/abastecimento.
app.post('/api/formularios-publico/preencher/:token', upload.array('anexos', 5), async (req, res) => {
  try {
    const payload = req.is('multipart/form-data') ? JSON.parse(req.body.payload || '{}') : req.body;
    const vista = await formularios.vistaPreenchimento(req.params.token);
    if (!vista) return res.status(404).json({ error: 'Link de preenchimento inválido.' });
    const anexos = [];
    for (const file of req.files || []) {
      const tipoOk = /^image\//.test(file.mimetype || '') || file.mimetype === 'application/pdf';
      if (!tipoOk) return res.status(400).json({ error: `Anexo "${file.originalname}" não é PDF nem imagem.` });
      const path = await storage.salvarArquivo(vista.id, file, 'formularios');
      anexos.push({ nome: file.originalname, path, tipo: file.mimetype });
    }
    const r = await formularios.salvarPreenchimento(req.params.token, { campos: payload.campos, linhas: payload.linhas, anexos });
    broadcast('formulario-preenchido', { id: r.id }, 'solicitacoes');
    res.json(r);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/formularios-publico/:id/assinar', async (req, res) => {
  try {
    const resultado = await formularios.assinar(req.params.id, req.body.token, { nome: req.body.nome, imagem: req.body.imagem });
    broadcast('formulario-assinado', { id: req.params.id }, 'solicitacoes');
    res.json(resultado);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// o próprio assinante pode baixar o PDF (com as assinaturas já na posição)
app.get('/api/formularios-publico/:id/pdf', async (req, res) => {
  const registro = await formularios.getOne(req.params.id);
  if (!registro || !formularios.chaveDoToken(registro, req.query.token)) return res.status(404).json({ error: 'Link inválido ou revogado.' });
  // gerarPdf virou async por causa do Ass. Boleto (lê o anexo do Storage
  // e copia as páginas dele) - sem o await, um erro lá vira unhandled
  // rejection e derruba o processo
  try { await formularios.gerarPdf(registro, res, { inline: req.query.inline === '1' }); } catch (err) {
    console.error('Erro ao gerar PDF do formulário:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Não consegui montar o PDF agora.' });
  }
});

// comprovantes anexados na criação - o assinante confere antes de assinar
app.get('/api/formularios-publico/:id/anexo/:indice', async (req, res) => {
  const registro = await formularios.getOne(req.params.id);
  if (!registro || !formularios.chaveDoToken(registro, req.query.token)) return res.status(404).json({ error: 'Link inválido ou revogado.' });
  const anexo = (registro.anexos || [])[Number(req.params.indice)];
  if (!anexo) return res.sendStatus(404);
  storage.streamArquivo(anexo.path, anexo.tipo, res);
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
    ehTimeSuporte: auth.ehTimeSuporte({ isMaster, isAdmin: !!user.isAdmin, permissions: user.permissions }),
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

// aceita anexo JA na abertura (foto do erro, PDF do boleto, print da tela) -
// quem abre o chamado normalmente esta com o arquivo na mao, e obrigar a
// mandar depois numa segunda mensagem fazia o anexo se perder. uploadChatAnexo
// deixa passar requisicao sem arquivo (e ate JSON puro), entao o caminho sem
// anexo continua exatamente como era.
app.post('/api/suporte-chat/iniciar', uploadChatAnexo.single('anexo'), async (req, res) => {
  try {
    const logado = await usuarioLogadoDoHeader(req);
    let anexo = null;
    if (req.file) {
      // MESMA validacao do anexo de mensagem (ver rota abaixo): tipo/tamanho
      // conferidos antes de qualquer coisa ir pro Storage
      const validacao = segurancaChat.validarAnexo(req.file);
      if (!validacao.ok) return res.status(400).json({ error: validacao.motivo });
      // grava o arquivo ANTES de criar a conversa: assim ela nunca nasce
      // apontando pra um anexo que falhou no upload. Se criar() recusar
      // depois (nome/contato/texto em branco), sobra um arquivo orfao no
      // Storage - preferivel a uma conversa aberta com o anexo faltando, que
      // e o que o usuario notaria.
      const path = await storage.salvarArquivo(`abertura-${Date.now()}`, req.file, 'suporte-chat');
      anexo = { nome: req.file.originalname, path, tipo: req.file.mimetype || 'application/octet-stream', tamanho: req.file.size };
    }
    const chat = await suporteChat.criar({ nome: req.body.nome, contato: req.body.contato, texto: req.body.texto, assunto: req.body.assunto, logado, lojaContexto: req.body.lojaContexto, anexo });
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
      // medicao de link (ver redeDiagnostico.js). Vem do agente/navegador e
      // esta rota e PUBLICA, entao e tratado como dado hostil - quem sanitiza
      // e o redeDiagnostico.sanitizarAmostra, chamado la dentro.
      rede: req.body.rede,
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

// ---------- saude do HD + varredura passiva da rede local, reportadas pelo
// NOCZenith (ver nocMaquina.js) - publica pelo mesmo motivo do ip-local:
// quem chama e a maquina, sem sessao. O token do agente e obrigatorio na
// pratica (exigirTokenSeTiver) pra ninguem plantar disco falso num
// computador que ja tem segredo ----------
app.post('/api/loja-status/:codigo/computadores/:posto/telemetria', async (req, res) => {
  try {
    const token = req.headers['x-noc-token'] || req.body.token || null;
    res.json(await lojaStatus.registrarTelemetria(req.params.codigo, req.params.posto, {
      disco: req.body.disco, dispositivos: req.body.dispositivos, uptimeHoras: req.body.uptimeHoras,
    }, token));
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
    // push do acesso remoto e OPT-IN (default desligado): as ferramentas que a
    // TI usa (AnyDesk/TeamViewer/DWService) mantem conexao 24h e enchiam o
    // Master de alerta falso. O evento fica registrado no historico do
    // computador de qualquer jeito; o push so sai se o Master ligar.
    if (await lojaStatus.pushAcessoRemotoAtivo()) {
      const mapa = await construirUnidadesMapa();
      push.notifyAcessoRemotoDetectado(mapa[req.params.codigo] || req.params.codigo, req.params.codigo, registro.nome, req.params.posto, req.body.detalhe)
        .catch((err) => console.error('Erro no push de acesso remoto:', err.message));
    }
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
// login no NoPulso (pedido do usuario: "link onde sera enviado ao colaborador
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
  res.json({
    ...funcionarioPublico(funcionario),
    // horas em aberto e o limite vão junto pra tela poder cobrar o check-out
    // sem ter que saber a regra: quem define o limite é o servidor
    limiteCheckoutHoras: rhCheckin.LIMITE_CHECKOUT_HORAS,
    checkinAberto: aberto
      ? { id: aberto.id, entrada: aberto.entrada.horario, horasEmAberto: rhCheckin.horasEmAberto(aberto) }
      : null,
  });
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
// sentido decididas por quem tem acesso ao NoPulso, nao por quem preenche um
// link publico. Devolve o linkToken de auto-atendimento (rh-colaborador.html)
// que rh.criar() ja gera sozinho, pra pessoa poder bater ponto na hora. ----------
// ---------- leitura do documento de identidade no cadastro de RH ----------
// Extra e Candidato (teste de 5 dias) nao digitam mais nome/nascimento: os
// campos vem da leitura do documento anexado (ver documentoIdentidadeOcr.js).
// A rota so LE - nada e gravado aqui; o cadastro em si continua sendo o
// POST separado, com o arquivo indo junto.
// Guarda-leitura: quando alguem clica em "Ler meu documento", a foto sobe e
// o modelo le. Antes, ENVIAR o cadastro subia a MESMA foto de novo e chamava
// o modelo DE NOVO - o dobro de upload no 4G da loja, o dobro de espera e o
// dobro de custo por cadastro. Era o pedido mais pesado do app inteiro, e era
// ele que morria antes de responder (o "Failed to fetch" que o usuario viu:
// fetch so rejeita assim quando a conexao cai sem resposta nenhuma).
//
// Agora a leitura fica guardada aqui com um token opaco, e o envio so
// referencia esse token. O SERVIDOR continua dono dos campos - a tela nunca
// manda o que o documento diz, so o token. E a garantia que existia antes
// (reler em vez de confiar na tela) continua de pe.
//
// Em memoria de proposito: e um estado de minutos, entre dois passos do mesmo
// formulario. Se o processo reiniciar no meio, o token some e a tela pede pra
// ler de novo - com essa mensagem, nao com um erro seco.
const LEITURAS_GUARDADAS = new Map();
const LEITURA_TTL_MS = 30 * 60 * 1000;
const LEITURAS_MAX = 60;
// Teto por BYTES, e nao so por quantidade: o que fica guardado aqui e foto de
// documento (ate 10 MB cada, ate 3 por leitura). Contar so entradas deixaria
// um numero inocente como 200 valer 6 GB de RAM e derrubar o processo inteiro
// - a mesma queda que este fix veio evitar, so que do outro lado.
const LEITURAS_MAX_BYTES = 120 * 1024 * 1024;
function pesoDaLeitura(reg) {
  return (reg.arquivos || []).reduce((t, a) => t + (a.buffer ? a.buffer.length : 0), 0);
}
function pesoGuardado() {
  let t = 0;
  for (const v of LEITURAS_GUARDADAS.values()) t += pesoDaLeitura(v);
  return t;
}

function guardarLeitura(dados) {
  const agora = Date.now();
  for (const [k, v] of LEITURAS_GUARDADAS) {
    if (agora - v.em > LEITURA_TTL_MS) LEITURAS_GUARDADAS.delete(k);
  }
  // teto duro: sem isso um robo batendo na rota publica encheria a memoria.
  // Descarta sempre a leitura MAIS ANTIGA (o Map itera na ordem de insercao):
  // quem acabou de fotografar o documento e quem esta prestes a enviar.
  const novo = { ...dados, em: agora };
  const peso = pesoDaLeitura(novo);
  while (LEITURAS_GUARDADAS.size
    && (LEITURAS_GUARDADAS.size >= LEITURAS_MAX || pesoGuardado() + peso > LEITURAS_MAX_BYTES)) {
    LEITURAS_GUARDADAS.delete(LEITURAS_GUARDADAS.keys().next().value);
  }
  const token = crypto.randomBytes(18).toString('hex');
  LEITURAS_GUARDADAS.set(token, novo);
  return token;
}
function pegarLeitura(token) {
  const reg = token && LEITURAS_GUARDADAS.get(String(token));
  if (!reg) return null;
  if (Date.now() - reg.em > LEITURA_TTL_MS) { LEITURAS_GUARDADAS.delete(String(token)); return null; }
  return reg;
}

async function responderLeituraDocumento(req, res) {
  try {
    const arquivos = (req.files || []).map((f) => ({ buffer: f.buffer, mimeType: f.mimetype }));
    if (!arquivos.length) return res.status(400).json({ error: 'Anexe a foto do documento.' });
    // valida formato ANTES de gastar teto/modelo: HEIC do iPhone ou tipo fora
    // do padrão viravam erro críptico da API na cara do candidato
    documentoIdentidadeOcr.validarArquivosDocumento(arquivos);
    // sem checagem de ativo() aqui: PDF digital é lido localmente dentro de
    // lerDocumento mesmo sem API key - só foto/escaneado exige o modelo
    const camposLidos = await rhCamposConfig.camposLidosDoDocumento();
    const leitura = await documentoIdentidadeOcr.lerDocumento({ arquivos, camposLidos });
    // guarda a leitura E os arquivos pro envio não precisar subir tudo de novo
    const docToken = guardarLeitura({ leitura, camposLidos, arquivos: req.files || [] });
    res.json({ ...leitura, docToken });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

// qual campo o cadastro digita na mao - a tela precisa saber ANTES de
// montar o formulario (mesmo papel do lerCanaisDisponivel no lançamento).
// Publica porque o link de auto-cadastro tambem monta o formulario.
app.get('/api/rh/campos-config-publico', async (req, res) => {
  const { camposManuais } = await rhCamposConfig.obter();
  res.json({ camposManuais, labels: rhCamposConfig.LABEL, campos: rhCamposConfig.CAMPOS_DO_DOCUMENTO });
});

// A versao publica fica fora do login (o link de auto-cadastro e aberto) e
// por isso tem teto por IP: cada leitura custa uma chamada de modelo, e
// endpoint de IA sem dono e o tipo de coisa que vira conta alta em uma noite.
// Contador em memoria mesmo - reiniciou o processo, zerou; o objetivo e
// travar abuso continuo, nao ser um limitador exato.
const LEITURA_DOC_TETO = 20;          // por IP
const LEITURA_DOC_JANELA_MS = 60 * 60 * 1000;
const leiturasDocPorIp = new Map();
function tetoLeituraDocumento(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || 'desconhecido';
  const agora = Date.now();
  const registro = leiturasDocPorIp.get(ip);
  if (!registro || agora - registro.desde > LEITURA_DOC_JANELA_MS) {
    leiturasDocPorIp.set(ip, { desde: agora, contagem: 1 });
    // limpeza oportunista: sem isso o Map cresceria pra sempre num processo
    // de longa duracao, guardando IP que nunca mais voltou
    if (leiturasDocPorIp.size > 5000) {
      for (const [k, v] of leiturasDocPorIp) {
        if (agora - v.desde > LEITURA_DOC_JANELA_MS) leiturasDocPorIp.delete(k);
      }
    }
    return next();
  }
  registro.contagem += 1;
  if (registro.contagem > LEITURA_DOC_TETO) {
    return res.status(429).json({ error: 'Muitas leituras seguidas. Espere alguns minutos e tente de novo.' });
  }
  return next();
}

app.post('/api/rh/ler-documento-publico', tetoLeituraDocumento, uploadDocumentoIdentidade.array('documento', 3), responderLeituraDocumento);

// Usado pelas DUAS rotas de cadastro (a publica e a da loja). O servidor le
// o documento DE NOVO na hora de gravar em vez de aceitar o que a tela
// mandou: os campos serem readonly no navegador impede erro de digitacao,
// nao impede alguem montar a requisicao na mao. Como o pedido e justamente
// que esses dados venham do documento e nao de digitacao, quem decide e a
// leitura do servidor. Custa uma chamada de modelo por cadastro (nao por
// tecla) - num fluxo de poucos cadastros por semana, e barato pelo que
// garante. Devolve tambem o arquivo salvo, pra ficar anexado na ficha.
// Checagem barata, ANTES de qualquer upload: sem ela o currículo ia pro
// Storage e só então rh.criar recusava por falta de documento - gravando
// lixo pra uma requisição que nunca ia virar cadastro.
// O currículo aceita PDF (o normal), foto ou Word - qualquer outra coisa é
// quase certeza de arquivo errado selecionado no celular, e recusar AQUI com
// frase clara é melhor que estourar depois no Storage/leitura sem explicação
function validarTipoCurriculo(arquivo) {
  if (!arquivo) return null;
  if (arquivo.buffer && arquivo.buffer.length === 0) {
    return 'O currículo veio vazio - ele ainda está no iCloud. Abra o arquivo uma vez no aparelho (pra ele baixar) e anexe de novo.';
  }
  const tipo = String(arquivo.mimetype || '').toLowerCase();
  if (/^(application\/pdf|image\/|application\/msword|application\/vnd\.openxmlformats)/.test(tipo)) return null;
  return `O currículo precisa ser PDF, foto ou documento do Word - o arquivo enviado veio como "${tipo || 'tipo desconhecido'}". Salve como PDF e tente de novo.`;
}

function exigeDocumentoIdentidade(tipoCadastro, arquivosDoc, guardado = null) {
  const tipo = tipoCadastro === 'candidato' ? 'candidato' : (tipoCadastro || 'extra');
  if (!['extra', 'candidato'].includes(tipo)) return null;
  // ja tem documento: ou veio agora no envio, ou ficou guardado do passo
  // "Ler meu documento" - nos dois casos o servidor tem a foto na mao
  if ((arquivosDoc || []).length) return null;
  if ((guardado?.arquivos || []).length) return null;
  return 'Anexe a foto do documento de identidade (RG, CNH ou CPF) - os dados são preenchidos por ele.';
}

async function lerEGuardarDocumentoIdentidade(arquivosReq, unidade, digitados = {}, guardado = null) {
  // Quando a tela ja passou pelo "Ler meu documento", a foto e a resposta do
  // modelo estao guardadas AQUI (ver LEITURAS_GUARDADAS) e o envio so manda o
  // token. Reaproveitar corta pela metade o que sobe do celular e paga uma
  // chamada de modelo em vez de duas - sem afrouxar nada: os campos continuam
  // saindo de uma leitura feita pelo servidor, nunca do que a tela digitou.
  // Se o envio trouxe foto propria, ela ganha: e leitura nova, mais recente.
  const arquivosBase = (arquivosReq || []).length ? arquivosReq : (guardado?.arquivos || []);
  if (!arquivosBase.length) return null;
  const deReuso = !(arquivosReq || []).length;
  const arquivos = arquivosBase.map((f) => ({ buffer: f.buffer, mimeType: f.mimetype }));
  const camposLidos = deReuso ? guardado.camposLidos : await rhCamposConfig.camposLidosDoDocumento();
  const leitura = deReuso ? guardado.leitura : await documentoIdentidadeOcr.lerDocumento({ arquivos, camposLidos });
  // so cobra o nome da leitura se o nome for um campo lido: com ele marcado
  // como manual, quem cadastra e que digita, e exigir da leitura travaria o
  // cadastro por um dado que nem foi pedido ao modelo
  if (camposLidos.includes('nome') && !leitura.nome) {
    throw new Error('Não consegui ler o nome no documento. Tire a foto de novo, com o documento inteiro, sem reflexo e bem iluminado.');
  }
  // cada campo vem de UMA fonte só: o que o Master deixou automático vem da
  // leitura (e o que a tela mandou é ignorado); o que ele marcou como
  // digitado na mão vem da tela. Sem essa separação explícita, um campo
  // liberado continuaria sendo sobrescrito pelo null da leitura.
  const campos = {};
  documentoIdentidadeOcr.TODOS_CAMPOS.forEach((c) => {
    campos[c] = camposLidos.includes(c) ? leitura[c] : (digitados[c] ?? null);
  });
  const primeiro = arquivosBase[0];
  const path = await storage.salvarArquivo(unidade, primeiro, 'rh-documentos');
  return {
    leitura,
    campos,
    anexo: { path, nomeOriginal: primeiro.originalname, tipo: primeiro.mimetype, paginas: arquivosBase.length },
  };
}

app.post('/api/rh/cadastro-publico', upload.fields([{ name: 'curriculo', maxCount: 1 }, { name: 'documento', maxCount: 3 }]), async (req, res) => {
  try {
    const { unidade, contato, cargoFuncao } = req.body;
    const tipoCadastro = req.body.tipoCadastro === 'candidato' ? 'candidato' : 'extra';
    const mapa = await construirUnidadesMapa();
    if (!unidade || !mapa[unidade]) return res.status(400).json({ error: 'Loja inválida.' });
    if (!(await unidadesExtras.apareceEm(unidade, 'rh'))) return res.status(400).json({ error: 'Essa unidade não tem RH habilitado.' });
    // token do passo "Ler meu documento": a foto ja subiu e ja foi lida, entao
    // o envio so aponta pra ela em vez de mandar os mesmos megabytes de novo.
    // Sem token (tela antiga, ou quem preencheu tudo na mao) o caminho de
    // antes continua valendo, com a foto vindo no proprio envio.
    const guardado = pegarLeitura(req.body.docToken);
    if (req.body.docToken && !guardado && !(req.files?.documento || []).length) {
      return res.status(400).json({ error: 'A leitura do documento expirou. Toque em "Ler meu documento" de novo antes de enviar.' });
    }
    // valida TODOS os anexos ANTES de qualquer outra coisa - erro de formato
    // tem que voltar com frase clara, não estourar no meio do envio
    const docsEnviados = (req.files?.documento || []).map((f) => ({ mimeType: f.mimetype, buffer: f.buffer }));
    if (docsEnviados.length) documentoIdentidadeOcr.validarArquivosDocumento(docsEnviados);
    const arquivoCurriculo = (req.files?.curriculo || [])[0];
    const erroCurriculo = validarTipoCurriculo(arquivoCurriculo);
    if (erroCurriculo) return res.status(400).json({ error: erroCurriculo });
    const faltaDoc = exigeDocumentoIdentidade(tipoCadastro, req.files?.documento, guardado);
    if (faltaDoc) return res.status(400).json({ error: faltaDoc });
    let curriculo = null;
    if (arquivoCurriculo) {
      const path = await storage.salvarArquivo(unidade, arquivoCurriculo, 'rh-curriculos');
      curriculo = { path, nomeOriginal: arquivoCurriculo.originalname, tipo: arquivoCurriculo.mimetype };
    }
    // nome/nascimento/CPF vem da leitura do documento feita AQUI, nao do
    // que a tela mandou (ver lerEGuardarDocumentoIdentidade)
    const doc = await lerEGuardarDocumentoIdentidade(req.files?.documento, unidade, req.body, guardado);
    const registro = await rh.criar({
      unidade, contato, cargoFuncao, tipoCadastro,
      chavePix: req.body.chavePix, banco: req.body.banco,
      ...(doc?.campos || {}),
      documentoIdentidade: doc?.anexo || null,
      leituraDocumento: doc?.leitura || null,
      curriculo, cadastradoPorId: null, cadastradoPorEmail: 'Auto-cadastro (link público)',
      precisaAprovacao: true,
    });
    // cadastro gravado: o token nao serve mais pra nada. Apagar aqui evita
    // que um reenvio acidental (dois toques no botao) vire ficha duplicada
    // sem foto nova, e libera a memoria antes do TTL.
    if (guardado) LEITURAS_GUARDADAS.delete(String(req.body.docToken));
    broadcast('rh-funcionario-criado', registro, 'rh');
    push.notifyRhCadastroPendente(registro.nome, registro.unidade);
    res.json({ id: registro.id, nome: registro.nome, linkToken: registro.linkToken });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// chave publica do VAPID - de proposito PUBLICA (e o "public" do proprio
// nome: qualquer navegador precisa dela pra montar a inscricao de push, a
// chave privada nunca sai do servidor). Fica aqui, ACIMA do auth.requireAuth,
// porque o service worker tambem precisa dela pra se re-inscrever sozinho
// depois de um pushsubscriptionchange (ver sw.js), sem nenhuma aba aberta
app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: push.PUBLIC_KEY });
});

// migra uma inscricao de push pra outra quando o proprio navegador troca o
// endpoint sozinho (evento pushsubscriptionchange, ver sw.js) - roda DENTRO
// do service worker, sem nenhuma aba aberta e sem acesso ao token de login
// da pagina, entao precisa ficar publica igual o resto dessa faixa (heartbeat,
// chat publico etc). Nao concede nada novo: so migra as permissoes (meta) de
// quem ja provou que tinha a inscricao antiga, sabendo o endpoint dela
app.post('/api/push/migrar-subscricao', async (req, res) => {
  try {
    await push.migrarSubscricao(req.body.oldEndpoint, req.body.subscricao);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// tudo abaixo daqui exige um usuario logado (token JWT, via header ou
// ?token= - o EventSource do SSE usa a query porque nao manda headers custom)
app.use('/api', auth.requireAuth);

// preferencias de tela da PESSOA logada (ver preferencias.js) - hoje so o
// seletor 🧩 Colunas do Fechamento usa. Fica no servidor, e nao no
// localStorage, pra escolha confirmada valer em qualquer aparelho e
// sobreviver a limpeza de cache do app.
app.get('/api/preferencias/:chave', async (req, res) => {
  try {
    const valor = await preferencias.obter(req.user.id, req.params.chave);
    res.json({ valor });
  } catch (e) {
    console.error('Erro ao ler preferencia:', e.message);
    res.status(500).json({ error: 'Erro ao ler preferência.' });
  }
});

app.put('/api/preferencias/:chave', async (req, res) => {
  try {
    const valor = await preferencias.salvar(req.user.id, req.params.chave, req.body && req.body.valor);
    res.json({ valor });
  } catch (e) {
    console.error('Erro ao salvar preferencia:', e.message);
    res.status(400).json({ error: e.message || 'Erro ao salvar preferência.' });
  }
});

app.get('/api/me', async (req, res) => {
  const ehSuporte = auth.ehTimeSuporte(req);
  // vertical(is) de negocio das empresas donas das unidades desse usuario -
  // usada pelo nav-menu.js/usuarios.html pra nao mostrar modulo de outra
  // vertical (ex: usuario so de unidade "alimentacao" nunca ve item de
  // menu marcado so pra "saude"). null = sem restricao (Master/suporte, que
  // atravessam toda empresa de proposito)
  let verticaisDoUsuario = null;
  if (!req.isMaster && !ehSuporte) {
    const unidades = req.permissions.unidades || [];
    const donas = await Promise.all(unidades.map((u) => empresas.empresaDaUnidade(u)));
    verticaisDoUsuario = [...new Set(donas.filter(Boolean).map((e) => e.tipoNegocio))];
  }
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
    podeBonifVerValorTotal: req.podeBonifVerValorTotal,
    podeBonifVerColaboradores: req.podeBonifVerColaboradores,
    precisaTrocarSenha: !!req.user.precisaTrocarSenha,
    isQaMaster: req.isQaMaster,
    isQaUser: req.isQaUser,
    ehTimeSuporte: ehSuporte,
    verticaisDoUsuario,
    // REDE(S) das lojas desse acesso (ARCFOOD / GBE, ver redes.js). O menu
    // usa isso pra so mostrar "Fechamentos Arcfood" pra quem tem loja
    // ARCFOOD e "Fechamentos GBE" pra quem tem loja do Grupo Bravo - antes
    // os dois itens apareciam pra qualquer um com a seção 'fechamentos',
    // levando a uma tela vazia da operacao do vizinho. null = sem recorte
    // (so Master). Sai das MESMAS unidades que filtram os dados
    // (auth.filterByUnidade), pra menu e dado nunca discordarem.
    redesDoUsuario: req.isMaster
      ? null
      : [...new Set((req.permissions.unidades || []).map((u) => redes.redeDaUnidade(u)).filter(Boolean))],
    empresaId: req.empresaId,
    // nome da empresa pra tela mostrar de quem esse acesso é (null = sem
    // empresa vinculada, que hoje significa "enxerga como sempre enxergou")
    empresaNome: req.empresaId
      ? ((await empresas.list()).find((e) => e.id === req.empresaId) || {}).nome || null
      : null,
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

// alerta pra UMA pessoa especifica, independente da tela do NoPulso que ela
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

// Silenciar/atender o alarme crítico numa tela cala o alarme nas OUTRAS
// sessões da MESMA pessoa (celular x computador). Entre abas do mesmo
// navegador quem resolve é o BroadcastChannel, sem passar por aqui - esta
// rota existe só pro caso de aparelhos diferentes (ver alarme-sync.js).
//
// broadcastParaUsuario filtra por req.user.id: eu só calo o MEU alarme.
// Silenciar o de outra pessoa seria um jeito silencioso de fazer um alerta
// crítico desaparecer da tela de quem deveria atender.
//
// Não grava nada: é um aviso ao vivo, sem estado pra guardar.
app.post('/api/alarme/silenciado', (req, res) => {
  broadcastParaUsuario(req.user.id, 'alarme-silenciado', { em: Date.now() });
  res.json({ ok: true });
});

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

    // ---------- Pix: regra propria (decisao do Master) ----------
    // Pix NAO recebe tag de FRAUDE nem de SUSPEITO pelas regras de cartao -
    // elas nao se aplicam (nao ha cartao, nao ha final de cartao, nao ha
    // chargeback). A unica marca possivel e SUSPEITO/"Repetido", quando o
    // mesmo cliente paga por Pix mais de uma vez na janela curta - mesmo
    // criterio da secao "Pedidos repetidos" do Monitor. Ver pixRepetido.js.
    if (pixRepetido.ehPix(tx)) {
      const repetido = pixRepetido.registrarPix(tx);
      if (repetido) {
        try {
          const clienteNome = tx.nomeCliente || tx.cardHolder || null;
          const registro = await fraudMarks.marcar({
            pedidoId: pedidoIdAtual,
            unidade: tx.unidade,
            nivel: 'SUSPEITO',
            motivo: `${pixRepetido.MOTIVO_REPETIDO}: ${repetido.repeticoes} Pix do mesmo cliente em ${repetido.janelaMinutos} min.`,
            clienteChave: clienteNome ? `nome:${clienteNome}` : null,
            clienteNome,
            statusPedido: tx.status,
            valor: tx.valor,
            marcadoPorEmail: 'deteccao-automatica@sistema',
          });
          broadcast('fraude-marcada', registro, 'monitor');
        } catch (err) {
          console.error('Erro ao marcar Pix repetido:', err.message);
        }
      }
    }
    // trava do resto do bloco de fraude: nenhuma regra de cartao encosta num
    // Pix. NAO da pra usar `continue` aqui - o resto do laco ainda precisa
    // rodar pro Pix (mudanca de status, chargeback, alerta de pedido que
    // alguem esta acompanhando pelo Beniboy).
    const ehPixTx = pixRepetido.ehPix(tx);

    // cruza o nome do cliente (shopper) com o nome impresso no cartao pra
    // ligar pedidos de nomes "diferentes" que na verdade sao o mesmo anel
    // de fraude (ex real: um pedido tem nomeCliente "Thais Mendes" e
    // cardHolder "Luciano Jose"; outro tem nomeCliente "Luciano Silva" e
    // cardHolder "Thais M Mendes" - os nomes se cruzam entre os campos).
    // Todo o resto do bloco usa esse cluster como identidade, em vez de so
    // o nome exato - ver fraudIdentity.js
    // a unidade escopa a malha de identidades: sem isso um sobrenome comum
    // ("Silva") ligava cliente de Recife com cliente de Sao Paulo
    const clusterInfo = ehPixTx
      ? null
      : fraudIdentity.registrarPedido(pedidoIdAtual, tx.nomeCliente, tx.cardHolder, tx.unidade);

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
    if ((tx.status === 'RECUSADO' || tx.status === 'APROVADO') && !jaFraudeNativaAdyen && !ehPixTx) {
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
    if (clusterInfo && !ehPixTx) {
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
        } else if (!jaMarcadoNesse && clusterInfo.nomesDistintos >= 2) {
          // o sinal e o CRUZAMENTO de nomes diferentes na mesma identidade,
          // nao o cliente que pediu duas vezes. Antes a condicao era
          // totalPedidos >= 2, o que marcava SUSPEITO todo cliente fiel que
          // pedisse duas vezes no mesmo dia.
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
// unidade sem area 'monitor' habilitada nao aparece nas telas de Monitor -
// diferente dos outros modulos (que bloqueiam o LANCAMENTO de um registro
// novo), aqui nao ha "lancamento": a transacao chega sozinha pelo webhook
// da Adyen e nunca pode ser recusada (perderia o dado). O gate certo e na
// LEITURA - a unidade so some das listas, o webhook continua gravando
// normalmente
async function filtrarPorAreaMonitor(lista) {
  const restritos = new Set(await unidadesExtras.codigosRestritosDe('monitor'));
  if (!restritos.size) return lista;
  return lista.filter((item) => !restritos.has(item.unidade));
}

app.get('/api/transactions', requireSection('monitor'), async (req, res) => {
  res.json(await filtrarPorAreaMonitor(auth.filterByUnidade(req, store.allTransactions())));
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

app.get('/api/orders', requireSection('monitor'), async (req, res) => {
  res.json(await filtrarPorAreaMonitor(auth.filterByUnidade(req, store.allOrders())));
});

app.get('/api/orders/changed', requireSection('monitor'), async (req, res) => {
  res.json(await filtrarPorAreaMonitor(auth.filterByUnidade(req, store.ordersChanged())));
});

app.get('/api/chargebacks', requireSection('monitor'), async (req, res) => {
  res.json(await filtrarPorAreaMonitor(auth.filterByUnidade(req, store.chargebacks())));
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
// ---------- limpeza das marcacoes automaticas (so Master) ----------
// A deteccao por nome marcou em massa cliente legitimo (ver fraudIdentity.js:
// medido em 98,5% de falso positivo antes do conserto). Estas duas rotas
// tiram do painel o que ela deixou pra tras.
//
// GET  = so conta, nao mexe em nada (o Master ve o numero antes de decidir)
// POST = remove de verdade, e SO com { confirmar: true } no corpo
//
// Duas travas de proposito: nunca toca em marcacao que um humano criou ou
// confirmou (ver ehAutomaticaIntocada em fraudMarks.js), e o "remover" e
// soft delete - o Relatorio de Fraude continua enxergando tudo.
app.get('/api/fraude/limpeza-automatica', auth.requireMaster, async (req, res) => {
  try {
    res.json(await fraudMarks.contarAutomaticasAtivas());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/fraude/limpeza-automatica', auth.requireMaster, async (req, res) => {
  if (req.body?.confirmar !== true) {
    return res.status(400).json({ error: 'Confirmação obrigatória: mande { "confirmar": true }.' });
  }
  try {
    const antes = await fraudMarks.contarAutomaticasAtivas();
    const r = await fraudMarks.removerAutomaticasAtivas(req.user?.email || 'master');
    console.log(`[fraude] limpeza automatica por ${req.user?.email}: ${r.removidas} removida(s), ${r.falhas} falha(s)`);
    broadcast('fraude-limpeza', { removidas: r.removidas }, 'monitor');
    res.json({ ...r, antes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
// Bessa/Caruaru/Garanhuns usam o MESMO codigo do Fechamento (ver
// FECHAMENTO_UNIDADES_NOMES acima) desde a unificacao de 2026-08-18 - antes
// cada um tinha um codigo proprio aqui (so o nome da aba na planilha de
// Entregas: "Bessa" em vez de "Dominos Bessa"), o que fazia a MESMA loja
// virar 2 cadastros separados no painel de Unidades. Decisao do Master:
// Fechamento e o dado mais importante, o codigo dele e que vale (ver
// migracaoUnidades.js pro script que corrigiu o que ja estava gravado, e
// entregasSync.js/normalizarCodigoEntrega pra planilha antiga continuar
// funcionando mesmo sem editar a coluna "Unidade" nela)
const ENTREGAS_UNIDADES_NOMES = {
  'Dominos Bessa': 'Dom Bessa',
  'Dominos Caruaru': 'Dom Caruaru',
  'Dominos Garanhuns': 'Dom Garanhuns',
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
  DOM19940: 'Dom Tirol', 'Dominos Tirol': 'Dom Tirol',
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
const GBE_MONITOR = new Set(['DOM_19798', 'DOM19911', 'DOM_19706', 'DOM_19633', 'DOM19940']);
function classificarUnidade(codigo) {
  if (ARCFOOD_FECHAMENTO.has(codigo)) return { secao: 'Fechamento', grupo: 'ARCFOOD' };
  if (ARCFOOD_MONITOR.has(codigo)) return { secao: 'Monitor / Disputas (Adyen)', grupo: 'ARCFOOD' };
  if (GBE_MONITOR.has(codigo)) return { secao: 'Monitor / Disputas (Adyen)', grupo: 'Grupo Bravo (GBE)' };
  // Fechamento antes de Entregas: desde a unificacao de codigos (ver
  // comentario de ENTREGAS_UNIDADES_NOMES), uma loja que faz as duas coisas
  // (ex: Dominos Bessa) tem o MESMO codigo nos dois mapas - o Master decidiu
  // que Fechamento e a classificacao principal quando isso acontece
  if (codigo in FECHAMENTO_UNIDADES_NOMES) return { secao: 'Fechamento', grupo: 'Grupo Bravo (GBE)' };
  if (codigo in ENTREGAS_UNIDADES_NOMES) return { secao: 'Entregas', grupo: 'Grupo Bravo (GBE)' };
  if (codigo in ifoodClient.IFOOD_UNIDADES_NOMES) return { secao: 'iFood', grupo: null };
  return { secao: 'Monitor / Disputas (Adyen)', grupo: 'Outras' };
}
// true so quando o codigo NAO e reconhecido por nenhuma lista fixa acima -
// usado por /api/meta/unidades pra saber se uma unidade e "de verdade"
// cadastrada em runtime (criada em /grupos.html, sem lar em lista nenhuma)
// ou se e uma unidade FIXA que so ganhou PERFIL (ver unidades.upsertPerfil).
// Sem essa distincao, dar perfil a uma loja fixa fazia ela "sumir" da secao
// certa (Entregas/Monitor/...) e ser jogada em "Cadastradas no sistema"
function codigoEhFixo(codigo) {
  const c = classificarUnidade(codigo);
  return !(c.secao === 'Monitor / Disputas (Adyen)' && c.grupo === 'Outras');
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
async function construirUnidadesMapaSemCache() {
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
  // funde qualquer codigo ANTIGO (Entregas OU Monitor/Adyen) que ainda
  // apareça em alguma fonte (planilha ainda nao resincronizada por completo,
  // cache antigo em memoria, transacao Adyen antiga em cache/snapshot...) no
  // codigo unificado - ver migracaoUnidades.js. Sem isso um "Caruaru"/"Mooca"
  // solto reaparecia do lado do cadastro já unificado mesmo depois da
  // migração já ter rodado no Firestore, porque entregasHistoricoData vem
  // direto da planilha (não do banco) e store.allTransactions() pode ter
  // carregado um snapshot/cache de antes da migração de transactions rodar
  Object.entries(migracaoUnidades.MAPA_CODIGO_UNIFICADO).forEach(([antigo, novo]) => {
    if (antigo in mapa) {
      mapa[novo] = mapa[novo] || mapa[antigo];
      delete mapa[antigo];
    }
  });
  // ultimo passo, sempre - reaplica os mapas fixos por cima de tudo, pra
  // garantir o nome unificado mesmo se algum dado importado/lançado tenha
  // gravado um unidadeNome diferente (cru, com typo, ou desatualizado)
  Object.keys(mapa).forEach((codigo) => { mapa[codigo] = nomeCanonicoUnidade(codigo, mapa[codigo]); });
  // ...e por ULTIMO mesmo, as unidades que o Master mandou excluir em
  // definitivo (ver CODIGOS_REMOVIDOS em migracaoUnidades.js). Tem que ser
  // aqui no fim: o código pode ter entrado por qualquer uma das fontes
  // acima (transação em cache, linha da planilha, fechamento antigo), e
  // tirar só da lista fixa fazia ele voltar sem nome na próxima montagem.
  migracaoUnidades.CODIGOS_REMOVIDOS.forEach((codigo) => { delete mapa[codigo]; });
  return mapa;
}
// A montagem acima refaz, EM CADA CHAMADA, um fold sobre todas as transações
// Adyen em memória + os históricos de fechamento/entrega - e ela roda em rota
// quente (Painel, formulários públicos, Beniboy) e dentro de job de minuto.
// As fontes Firestore por baixo já são cacheadas (liveCache), então o que se
// paga aqui é CPU pura repetindo o mesmo resultado. Unidade nova só nasce por
// cadastro (invalidado abaixo, aparece na hora) ou por dado importado - pra
// esse segundo caso o TTL de 60s é mais que suficiente. Ninguém fora da
// montagem escreve no objeto devolvido (conferido caller a caller), então
// compartilhar a mesma referência entre chamadores é seguro.
// TTL configurável só por causa do testeRotas: vários testes de lá mudam o
// dado por baixo (DOCS.set / store.addOrUpdate) e conferem o mapa em seguida
// - com memo ativo eles passariam OLHANDO PRO MAPA VELHO, virando teste de
// nada. A suíte roda com UNIDADES_MAPA_TTL_MS=0 (sem memo); produção usa 60s.
const UNIDADES_MAPA_TTL_MS = process.env.UNIDADES_MAPA_TTL_MS !== undefined
  ? Number(process.env.UNIDADES_MAPA_TTL_MS) : 60 * 1000;
const unidadesMapaCache = liveCacheUtil.createCache(construirUnidadesMapaSemCache, UNIDADES_MAPA_TTL_MS);
// TTL zerado desliga o memo DE VERDADE (createCache com TTL 0 ainda devolve
// o valor velho uma vez, pelo stale-while-revalidate - não serve pro teste)
const construirUnidadesMapa = UNIDADES_MAPA_TTL_MS > 0
  ? () => unidadesMapaCache.cached()
  : construirUnidadesMapaSemCache;
// derruba o cache junto com qualquer mudança de cadastro de unidade - quem
// acabou de cadastrar/renomear precisa ver o resultado na tela SEGUINTE, não
// dali a um minuto. Envolve a promessa da mutação (rota direta do Master e
// executor da aprovação QA usam o mesmo embrulho).
async function invalidandoUnidadesMapa(promessa) {
  const r = await promessa;
  unidadesMapaCache.invalidar();
  return r;
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
  // as cadastradas em runtime (de verdade, sem lar em NENHUMA lista fixa)
  // ganham classificacao propria no checklist - classificarUnidade so
  // conhece as listas fixas e jogaria elas em "Outras". Uma unidade FIXA que
  // so ganhou PERFIL (ver unidades.upsertPerfil) NAO entra aqui - ela
  // continua na secao real dela (Entregas/Monitor/...), senao "sumia" de lá
  const codigosExtras = new Set(
    (await unidadesExtras.listAll().catch(() => []))
      .map((u) => u.codigo)
      .filter((codigo) => !codigoEhFixo(codigo)),
  );
  const SECAO_ORDEM = ['Fechamento', 'Entregas', 'Monitor / Disputas (Adyen)', 'iFood'];
  // empresa dona de cada unidade - o Master ve isso no checklist pra saber
  // que dar acesso cruzando esse nome vai atravessar empresa (usuarios.html
  // confirma antes de deixar, ver confirmarCrossEmpresa)
  const entradas = Object.entries(mapa);
  const nomesEmpresa = await Promise.all(entradas.map(([codigo]) => empresas.empresaDaUnidade(codigo)));
  const lista = entradas
    .map(([codigo, nome], i) => ({
      codigo, nome,
      empresa: nomesEmpresa[i] ? nomesEmpresa[i].nome : null,
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
// ?area= opcional (ver unidades.js AREAS_VALIDAS): filtra as unidades que tem
// perfil restrito, pra um seletor especifico (ex: lancamento.html so quer
// unidade que de fato lanca fechamento, nao a MVPar) - sem o parametro,
// devolve o mapa inteiro, comportamento de sempre
app.get('/api/meta/unidades-extras', async (req, res) => {
  const m = await unidadesExtras.mapa().catch(() => ({}));
  res.json(req.query.area ? await unidadesExtras.filtrarMapaPorArea(m, req.query.area) : m);
});

// codigos (fixos OU cadastrados em runtime) com perfil que EXCLUI a area -
// pra telas que montam o seletor a partir de uma lista fixa PRE-POPULADA
// (ex: lancamento.html) e so DEPOIS mesclam unidades-extras por cima: um
// merge nunca REMOVE chave, entao uma unidade fixa que ganhou perfil
// restrito (ver PUT /api/meta/unidades/:codigo/perfil) precisa ser tirada
// à parte - ver unidades.codigosRestritosDe
app.get('/api/meta/unidades-restritas', async (req, res) => {
  if (!req.query.area) return res.json([]);
  res.json(await unidadesExtras.codigosRestritosDe(req.query.area).catch(() => []));
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
    // código excluído em definitivo (ver CODIGOS_REMOVIDOS) não volta por
    // cadastro manual - senão ficava um cadastro que a tela aceita mas que
    // construirUnidadesMapa esconde logo depois, sem explicação nenhuma
    if (migracaoUnidades.unidadeFoiRemovida(req.body.codigo)) {
      return res.status(400).json({ error: `O código "${String(req.body.codigo).trim()}" foi excluído em definitivo. Se essa loja voltou a existir, tire ele de CODIGOS_REMOVIDOS em migracaoUnidades.js.` });
    }
    const dados = {
      codigo: req.body.codigo, nome: req.body.nome, porEmail: req.user.email,
      // perfil da unidade: onde ela aparece e o que ela aceita. Vazio = sem
      // restrição, que é o comportamento de sempre (ver unidades.js)
      areas: req.body.areas, tiposSolicitacao: req.body.tiposSolicitacao,
    };
    if (await desviarSeQaMaster(req, res, 'unidadesExtras.criar', `Cadastrar unidade: ${req.body?.nome || req.body?.codigo || ''}`, { dados })) return;
    res.json(await invalidandoUnidadesMapa(unidadesExtras.criar(dados, codigosUnidadesFixas())));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/meta/unidades-extras/:id', auth.requireMaster, async (req, res) => {
  try {
    const patch = { nome: req.body.nome, areas: req.body.areas, tiposSolicitacao: req.body.tiposSolicitacao };
    if (await desviarSeQaMaster(req, res, 'unidadesExtras.editar', `Editar unidade ${req.params.id}`, { id: req.params.id, ...patch })) return;
    res.json(await invalidandoUnidadesMapa(unidadesExtras.atualizar(req.params.id, patch)));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// perfil (areas/tiposSolicitacao) de QUALQUER unidade, fixa ou cadastrada em
// runtime - diferente das rotas acima (que so tratam registros da colecao
// unidadesExtras pelo id), esta mexe pelo CODIGO, entao uma loja fixa (Adyen/
// planilha, codigo que nunca muda) tambem pode ganhar o mesmo perfil que a
// MVPar tem, sem precisar recriar nada (ver unidades.upsertPerfil)
app.put('/api/meta/unidades/:codigo/perfil', auth.requireMaster, async (req, res) => {
  try {
    const patch = { nome: req.body.nome, areas: req.body.areas, tiposSolicitacao: req.body.tiposSolicitacao, porEmail: req.user.email };
    if (await desviarSeQaMaster(req, res, 'unidadesExtras.perfil', `Definir perfil da unidade ${req.params.codigo}`, { codigo: req.params.codigo, ...patch })) return;
    res.json(await invalidandoUnidadesMapa(unidadesExtras.upsertPerfil(req.params.codigo, patch)));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/meta/unidades-extras/:id', auth.requireMaster, async (req, res) => {
  try {
    if (await desviarSeQaMaster(req, res, 'unidadesExtras.excluir', `Excluir unidade ${req.params.id}`, { id: req.params.id })) return;
    res.json(await invalidandoUnidadesMapa(unidadesExtras.remover(req.params.id)));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- PEDIDO SEMANAL (pedidoSemanal.js) ----------
// Lembrete do pedido de insumos que cada loja faz uma vez por semana, FORA
// do NoPulso (no sistema do fornecedor). A loja confirma anexando o pedido -
// o anexo e o que separa "cliquei pra sumir o aviso" de "o pedido existiu".
//
// A cobranca e por REGRA: cada regra vale pra um GRUPO (franquia inteira) ou
// pra LOJAS escolhidas a dedo, com dia da semana proprio. Loja que nao esta
// em regra nenhuma nao e cobrada - e assim que Sao Braz, Saltiverso e Milky
// Moo ficam de fora, sem lista de excecao pra alguem esquecer de manter.
//
// A lista de unidades candidatas nasce do Fechamento (uma entrada por loja,
// ver FECHAMENTO_UNIDADES_NOMES) mais as cadastradas em runtime. Nao uso
// construirUnidadesMapa() aqui de proposito: ele mescla apelidos e codigos de
// outros sistemas, e a mesma loja apareceria duas ou tres vezes na cobranca.
async function unidadesBasePedidoSemanal() {
  const extras = await unidadesExtras.mapa().catch(() => ({}));
  const mapa = { ...FECHAMENTO_UNIDADES_NOMES, ...extras };
  return Object.entries(mapa)
    .map(([codigo, nome]) => ({ codigo, nome }))
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
}

// tudo que o calculo precisa, numa ida so - as tres rotas de leitura usam
// exatamente o mesmo conjunto, e todas as fontes sao cacheadas
async function contextoPedidoSemanal() {
  const [regras, confirmacoes, base, listaGrupos] = await Promise.all([
    pedidoSemanal.listarRegras(), pedidoSemanal.listarConfirmacoes(),
    unidadesBasePedidoSemanal(), grupos.list().catch(() => []),
  ]);
  return { regras, confirmacoes, base, grupos: listaGrupos };
}

// Master/Admin acompanham TODAS as lojas (quem fez e quem nao fez); os
// demais so veem as unidades do proprio acesso - o lembrete e uma cobranca
// da loja, nao um placar publico
function filtrarUnidadesDoUsuario(req, lista) {
  if (req.isMaster || req.isAdmin) return auth.filtrarPorEmpresa(req, lista, 'codigo');
  const permitidas = new Set((req.permissions && req.permissions.unidades) || []);
  return lista.filter((u) => permitidas.has(u.codigo));
}

app.get('/api/pedido-semanal', async (req, res) => {
  const ctx = await contextoPedidoSemanal();
  const todas = pedidoSemanal.statusDasUnidades(ctx.base, ctx);
  res.json({
    // "ativo" aqui e do ponto de vista de QUEM PERGUNTA: existe alguma regra
    // ligada cobrando alguma unidade. A tela nao precisa saber de regra
    // nenhuma pra decidir se mostra o painel.
    ativo: todas.length > 0,
    podeVerTodas: !!(req.isMaster || req.isAdmin),
    unidades: filtrarUnidadesDoUsuario(req, todas),
  });
});

app.post('/api/pedido-semanal/:codigo/confirmar', uploadPedidoSemanal.single('arquivo'), async (req, res) => {
  try {
    const codigo = req.params.codigo;
    const ctx = await contextoPedidoSemanal();
    // a unidade tem que estar coberta por uma regra ativa E no acesso de
    // quem confirmou: sem os dois, um POST direto confirmaria loja alheia
    // (ou uma que nao faz pedido, criando cobranca do nada)
    const cobradas = pedidoSemanal.statusDasUnidades(ctx.base, ctx);
    const alvo = filtrarUnidadesDoUsuario(req, cobradas).find((u) => u.codigo === codigo);
    if (!alvo) return res.status(403).json({ error: 'Essa unidade não faz pedido semanal ou não está no seu acesso.' });
    if (!req.file) return res.status(400).json({ error: 'Anexe o arquivo do pedido (PDF, print ou planilha).' });

    const path = await storage.salvarArquivo(codigo, req.file, 'pedido-semanal');
    const registro = await pedidoSemanal.confirmar({
      unidade: codigo,
      unidadeNome: alvo.nome,
      // a semana vem do servidor, nunca do cliente: aceitar a data do corpo
      // deixaria confirmar semana passada (ou a de 2030) pra limpar a tela
      dataPedido: alvo.dataPedido,
      arquivo: { path, nome: req.file.originalname, tipo: req.file.mimetype, tamanho: req.file.size },
      porEmail: req.user.email,
      porNome: req.user.username || req.user.email,
    });
    broadcast('pedido-semanal-confirmado', { unidade: codigo, dataPedido: registro.dataPedido }, 'fechamentos');
    res.json({ ok: true, dataPedido: registro.dataPedido });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/pedido-semanal/:codigo/arquivo', async (req, res) => {
  const registro = await pedidoSemanal.buscarConfirmacao(req.params.codigo, String(req.query.data || ''));
  if (!registro || !registro.arquivo) return res.sendStatus(404);
  const podeVer = auth.filtrarPorEmpresa(req, [registro]).length
    && (req.isMaster || req.isAdmin
      || ((req.permissions && req.permissions.unidades) || []).includes(registro.unidade));
  if (!podeVer) return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
  storage.streamArquivo(registro.arquivo.path, registro.arquivo.tipo, res);
});

// ---- regras (Master) ----
// devolve junto as unidades e os grupos: a tela de cadastro precisa dos dois
// pra montar os seletores, e o "cobertas" mostra quem cada regra pega hoje -
// sem isso o Master salva no escuro e so descobre o alcance no dia do pedido
app.get('/api/pedido-semanal/regras', auth.requireMaster, async (req, res) => {
  const ctx = await contextoPedidoSemanal();
  const porUnidade = pedidoSemanal.regraDeCadaUnidade(ctx.base, ctx.regras, ctx.grupos);
  const cobertas = {};
  porUnidade.forEach((regra, codigo) => {
    if (!cobertas[regra.id]) cobertas[regra.id] = [];
    cobertas[regra.id].push(codigo);
  });
  res.json({
    regras: ctx.regras,
    // quem NAO esta em regra nenhuma - o Master precisa ver isso pra saber
    // que loja ficou sem cobranca por esquecimento, e nao por decisao
    semRegra: ctx.base.filter((u) => !porUnidade.has(u.codigo)),
    cobertas,
    unidades: ctx.base,
    grupos: ctx.grupos.map((g) => ({ id: g.id, nome: g.nome, unidades: g.unidades || [] })),
    dias: pedidoSemanal.DIAS_NOME,
  });
});

app.post('/api/pedido-semanal/regras', auth.requireMaster, async (req, res) => {
  try {
    if (await desviarSeQaMaster(req, res, 'pedidoSemanal.criarRegra', `Criar regra de pedido semanal: ${req.body?.nome || ''}`, req.body || {})) return;
    res.json(await pedidoSemanal.criarRegra(req.body || {}, { porEmail: req.user.email }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/pedido-semanal/regras/:id', auth.requireMaster, async (req, res) => {
  try {
    if (await desviarSeQaMaster(req, res, 'pedidoSemanal.editarRegra', `Editar regra de pedido semanal ${req.params.id}`, { id: req.params.id, ...(req.body || {}) })) return;
    res.json(await pedidoSemanal.atualizarRegra(req.params.id, req.body || {}, { porEmail: req.user.email }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/pedido-semanal/regras/:id', auth.requireMaster, async (req, res) => {
  try {
    if (await desviarSeQaMaster(req, res, 'pedidoSemanal.excluirRegra', `Excluir regra de pedido semanal ${req.params.id}`, { id: req.params.id })) return;
    res.json(await pedidoSemanal.removerRegra(req.params.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- Central de Alertas (alertasCentral.js) - log de TODOS os
// alertas do sistema (NOC, Beniboy, seguranca, QA, RH, fraude...), pra
// existir um lugar central que mostra o que aconteceu mesmo que o push
// tenha falhado/nao tocado ou a pessoa so va olhar horas depois (pedido
// explicito do usuario: "crie se preciso uma central de alertas que mostre
// qual o alerta e o que e"). Master-only, mesmo espirito de qa-aprovacoes ----------
app.get('/api/alertas-central', auth.requireMaster, async (req, res) => {
  // ?desde=<criadoEm do alerta mais novo que a tela ja tem> devolve SO os mais
  // novos que isso - e o que o polling de 15s usa (custa ~1 leitura em vez dos
  // 300 documentos da lista inteira, ver alertasCentral.js). Sem o parametro
  // devolve a lista completa, que e o caso da abertura da tela.
  const desde = String(req.query.desde || '').trim();
  res.json(desde ? await alertasCentral.listarDesde(desde) : await alertasCentral.listar());
});

// Diagnostico de custo do Firestore: quantos DOCUMENTOS cada colecao e cada
// rota leram desde o ultimo restart (ou desde o ultimo ?zerar=1). O console do
// Firebase so mostra o total da conta - sem isso nao da pra saber de onde vem
// o gasto, e otimizar vira chute.
app.get('/api/debug/leituras', auth.requireMaster, (req, res) => {
  if (!db.relatorioLeituras) return res.status(503).json({ error: 'Contador de leituras não está instalado neste processo.' });
  const relatorio = db.relatorioLeituras();
  if (String(req.query.zerar || '') === '1') db.zerarLeituras();
  res.json(relatorio);
});

app.post('/api/alertas-central/:id/atender', auth.requireMaster, async (req, res) => {
  try {
    const atualizado = await alertasCentral.atender(req.params.id, req.user.email);
    if (!atualizado) return res.status(404).json({ error: 'Alerta não encontrado.' });
    res.json(atualizado);
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
// A lista vai RESUMIDA (ver listarResumo em lojaStatus.js): o poll de 30s do
// painel multiplicava os historicos/listas de todas as maquinas e era a
// maior fatia da banda do servico. O detalhe completo de uma maquina sai na
// rota /detalhe abaixo, buscada so quando o modal dela esta aberto.
app.get('/api/loja-status', requireSection('suporte'), async (req, res) => {
  const [status, mapa] = await Promise.all([lojaStatus.listarResumo(), construirUnidadesMapa()]);
  res.json(status.map((s) => ({ ...s, unidadeNome: mapa[s.codigo] || s.codigo })));
});

// detalhe completo de UM computador (eventos, aparelhos da rede, chat,
// series de rede, saida do ultimo comando) - mesmo gate da lista
app.get('/api/loja-status/:codigo/computadores/:posto/detalhe', requireSection('suporte'), async (req, res) => {
  try {
    const c = await lojaStatus.detalhar(req.params.codigo, req.params.posto);
    if (!c) return res.status(404).json({ error: 'Computador não encontrado.' });
    res.json(c);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Botao de incidente: manda TODOS os computadores 'interno' matarem processos
// NOCZenith orfaos - e o que fecha a caixa "Ocorreu uma excecao sem
// tratamento" que ficou presa na tela das lojas. O comando NAO vem do corpo
// da requisicao: e uma constante do lojaStatus.js. Expor texto livre aqui
// seria um "executar qualquer coisa em toda a rede" numa rota HTTP.
// Master-only e sem desvio pra aprovacao QA: e ferramenta de incidente, e o
// comando ja e fixo e nao destrutivo (mata processo do proprio vigia).
app.post('/api/loja-status/limpar-travados', auth.requireMaster, async (req, res) => {
  try {
    const resultados = await lojaStatus.enfileirarComandoEmTodos(
      lojaStatus.COMANDO_LIMPAR_TRAVADOS, { origem: 'incidente' },
    );
    const enviados = resultados.filter((r) => r.ok);
    res.json({
      enviados: enviados.length,
      total: resultados.length,
      // cada maquina so pega na proxima batida (25s); quem falhou vem com o
      // motivo, pra dar pra decidir se precisa ir na mao
      detalhe: resultados,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Diagnostico de qualidade de link, pior primeiro (ver redeDiagnostico.js).
// Mesmo gate do painel do NOC - quem enxerga os computadores enxerga a saude
// da rede deles. Nao custa leitura extra: reaproveita o cache de listar().
app.get('/api/loja-status/rede', requireSection('suporte'), async (req, res) => {
  try {
    const [diag, mapa] = await Promise.all([
      lojaStatus.diagnosticoRede(req.query.dia),
      construirUnidadesMapa(),
    ]);
    res.json({
      ...diag,
      computadores: diag.computadores.map((c) => ({ ...c, unidadeNome: mapa[c.codigo] || c.codigo })),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Batiza um aparelho da rede da loja ("Impressora da cozinha"). O nome vale
// pra UNIDADE inteira, nao pro computador que por acaso enxergou aquele MAC -
// por isso a rota e por codigo de unidade. Mesmo gate do painel.
app.put('/api/loja-status/:codigo/dispositivos/:mac/apelido', requireSection('suporte'), async (req, res) => {
  try {
    res.json(await lojaStatus.definirApelidoDispositivo(req.params.codigo, req.params.mac, req.body.apelido));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Saude das maquinas: HD com problema (pior primeiro) + quantos aparelhos
// cada loja enxerga na propria rede (ver nocMaquina.js). Mesmo gate e mesmo
// cache do /rede acima - nenhuma leitura nova no Firestore.
app.get('/api/loja-status/maquinas', requireSection('suporte'), async (req, res) => {
  try {
    const [saude, mapa] = await Promise.all([lojaStatus.saudeMaquinas(), construirUnidadesMapa()]);
    res.json({
      ...saude,
      computadores: saude.computadores.map((c) => ({ ...c, unidadeNome: mapa[c.codigo] || c.codigo })),
      discos: saude.discos.map((d) => ({ ...d, unidadeNome: mapa[d.codigo] || d.codigo })),
      reiniciar: saude.reiniciar.map((r) => ({ ...r, unidadeNome: mapa[r.codigo] || r.codigo })),
      redes: saude.redes.map((r) => ({ ...r, unidadeNome: mapa[r.codigo] || r.codigo })),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- Monitor: alertar a propria loja sobre um pedido especifico -
// pedido explicito do usuario ("clico a linha do pagamento e escolho quais
// computadores, ou todos, pra dar o alerta"). Diferente do alerta de fraude
// de push.js (que avisa o TIME por push), isso avisa os COMPUTADORES da
// loja direto na tela deles, reusando o mesmo canal de mensagem do NOC
// NoPulso (lojaStatus.enviarMensagem -> mensagemPendente -> banner no
// proximo heartbeat, ver atendimento.html). Gate so por 'monitor' (nao
// 'suporte') - quem ve o Monitor tem que poder mandar esse alerta, mesmo
// sem acesso ao NOC Zenith.
//
// "unidade" aqui e o merchantAccountCode da Adyen (ex: "DOM19940"), mas o
// computador foi cadastrado com o codigo que listaUnidadesPublicas()
// escolheu pra loja (prefere o codigo de Fechamento quando existe - ver
// UNIDADES_APELIDOS). nomeCanonicoUnidade() resolve os dois lados pro
// MESMO nome fixo, entao comparar os nomes canonicos (em vez dos codigos
// crus) acha os computadores certos mesmo quando os codigos nao batem.
app.get('/api/monitor/loja-computadores', requireSection('monitor'), async (req, res) => {
  const unidade = String(req.query.unidade || '').trim();
  if (!unidade) return res.status(400).json({ error: 'Informe a unidade.' });
  const nomeAlvo = nomeCanonicoUnidade(unidade, unidade);
  const todos = await lojaStatus.listar();
  const computadores = todos
    .filter((c) => nomeCanonicoUnidade(c.codigo, c.codigo) === nomeAlvo)
    .map((c) => ({ codigo: c.codigo, posto: c.posto, nome: c.nome, tipo: c.tipo, online: c.online }));
  res.json({ unidadeNome: nomeAlvo, computadores });
});

app.post('/api/monitor/alertar-loja', requireSection('monitor'), async (req, res) => {
  try {
    const unidade = String(req.body.unidade || '').trim();
    const postos = Array.isArray(req.body.postos) ? req.body.postos : [];
    if (!unidade) return res.status(400).json({ error: 'Informe a unidade.' });
    if (!postos.length) return res.status(400).json({ error: 'Selecione ao menos um computador.' });
    const nomeAlvo = nomeCanonicoUnidade(unidade, unidade);
    const todos = await lojaStatus.listar();
    const alvo = todos.filter((c) => nomeCanonicoUnidade(c.codigo, c.codigo) === nomeAlvo && postos.includes(c.posto));
    if (!alvo.length) return res.status(404).json({ error: 'Nenhum computador encontrado pra essa loja.' });
    const cliente = String(req.body.cliente || 'Cliente').slice(0, 80);
    const valor = Number(req.body.valor || 0);
    const pedidoId = String(req.body.pedidoId || '').slice(0, 60);
    const texto = `🚨 CONFIRA ESSE PEDIDO: ${cliente} · R$ ${valor.toFixed(2)}${pedidoId ? ' · #' + pedidoId : ''} - o Monitor pediu pra verificar agora.`;
    await Promise.all(alvo.map((c) => lojaStatus.enviarMensagem(c.codigo, c.posto, texto, req.user.email)));
    res.json({ ok: true, avisados: alvo.length });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// tipo 'interno' (computador de escritorio/servidor, so pro monitoramento)
// aponta pra tela normal de login do NoPulso; 'atendimento' (o default,
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
    if (!(await unidadesExtras.apareceEm(req.params.codigo, 'noc'))) return res.status(400).json({ error: 'Essa unidade não tem NOC habilitado.' });
    const registro = await lojaStatus.cadastrarComputador(req.params.codigo, req.body.nome, req.body.tipo);
    const url = urlComputador(req.params.codigo, registro.posto, registro.tipo);
    res.json({ ...registro, url });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/loja-status/:codigo/computadores/:posto', requireSection('suporte'), async (req, res) => {
  try {
    const registro = await lojaStatus.editarComputador(req.params.codigo, req.params.posto, req.body.nome, req.body.tipo, req.body.ehNotebook);
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

app.put('/api/loja-status/:codigo/computadores/:posto/unidade', requireSection('suporte'), async (req, res) => {
  try {
    const registro = await lojaStatus.moverComputador(req.params.codigo, req.params.posto, req.body.novoCodigo);
    const url = urlComputador(registro.codigo, registro.posto, registro.tipo);
    res.json({ ...registro, url });
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

// ---------- Formulários com assinatura remota - lado LOGADO ----------
// Quem tem a seção 'formularios' (Master/Admin sempre) cria o formulário,
// recebe os links de assinatura de cada papel e acompanha/baixa o PDF.
function formularioComLinks(f) {
  if (!f) return f;
  return {
    ...f,
    assinaturas: f.assinaturas.map((a) => ({
      ...a,
      link: a.token ? `${APP_BASE_URL}/assinar.html?f=${encodeURIComponent(f.id)}&t=${encodeURIComponent(a.token)}` : null,
      token: undefined,
    })),
  };
}

// QUEM pode emitir formulário pra qual unidade. Tres coisas somadas, e as
// tres precisam valer:
//   1. o cadastro está ativo (unidade que fechou some do seletor, mas os
//      formulários dela continuam abrindo);
//   2. a unidade aparece na área "Formulários" do perfil dela (ver
//      unidades.js) - mesma regra das outras áreas;
//   3. a pessoa tem essa unidade liberada no acesso dela.
// O Master atravessa tudo. Cadastro ainda SEM unidade vinculada (codigo
// null) só aparece pro Master de propósito: sem código não dá pra dizer de
// quem é, e mostrar pra todo mundo era justamente o defeito - o gerente de
// uma loja via o formulário de pagamento de outra empresa.
async function unidadesDeFormularioPara(req) {
  const cadastros = await formulariosUnidades.listarAtivas();
  if (req.isMaster) return cadastros;
  const liberadas = new Set(req.permissions?.unidades || []);
  const permitidas = [];
  for (const c of cadastros) {
    if (!c.codigo || !liberadas.has(c.codigo)) continue;
    if (!(await unidadesExtras.apareceEm(c.codigo, 'formularios'))) continue;
    permitidas.push(c);
  }
  return permitidas;
}

// o formulário guarda o RÓTULO da unidade; a permissão fala em CÓDIGO. Os
// registros novos já gravam os dois (unidadeCodigo), os antigos são
// resolvidos pelo cadastro na hora de filtrar.
async function filtrarFormulariosPorUnidade(req, lista) {
  if (req.isMaster) return lista;
  const liberadas = new Set(req.permissions?.unidades || []);
  const porRotulo = await formulariosUnidades.mapaRotuloParaCodigo();
  return lista.filter((f) => {
    const codigo = f.unidadeCodigo || porRotulo[f.unidade];
    return codigo && liberadas.has(codigo);
  });
}

app.get('/api/formularios', requireSection('formularios'), async (req, res) => {
  res.json(await filtrarFormulariosPorUnidade(req, await formularios.listar()));
});

app.get('/api/formularios/tipos', requireSection('formularios'), (req, res) => {
  res.json(Object.entries(formularios.TIPOS).map(([tipo, m]) => ({
    tipo, rotulo: m.rotulo, cabecalho: m.cabecalho, colunas: m.colunas,
    assinantes: m.assinantes, assinaturaPorLinha: !!m.assinaturaPorLinha,
    soAnexo: !!m.soAnexo, anexoObrigatorio: !!m.anexoObrigatorio,
  })));
});

// cadastro unidade -> razão social + CNPJ (preenchimento sem edição),
// já cortado pelo que ESTA pessoa pode emitir
app.get('/api/formularios/unidades', requireSection('formularios'), async (req, res) => {
  res.json(await unidadesDeFormularioPara(req));
});

// ---- cadastro das unidades do formulário (Master) ----
// Registrado ACIMA de /api/formularios/:id pra não ser engolido pela rota
// de detalhe, mesmo motivo do /favorecido logo abaixo.
app.get('/api/formularios/cadastro-unidades', auth.requireMaster, async (req, res) => {
  res.json(await formulariosUnidades.listar());
});

app.post('/api/formularios/cadastro-unidades', auth.requireMaster, async (req, res) => {
  try {
    res.json(await formulariosUnidades.criar(req.body, req.user.email));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/formularios/cadastro-unidades/:id', auth.requireMaster, async (req, res) => {
  try {
    res.json(await formulariosUnidades.atualizar(req.params.id, req.body, req.user.email));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// sem DELETE de propósito: formulário já emitido tem que continuar abrindo
// com a razão social e o CNPJ que valiam quando foi assinado
app.put('/api/formularios/cadastro-unidades/:id/ativo', auth.requireMaster, async (req, res) => {
  try {
    res.json(await formulariosUnidades.alternarAtivo(req.params.id, req.body.ativo, req.user.email));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// memória de favorecido: digitou um CPF/CNPJ já usado antes -> devolve os
// dados bancários salvos na última vez pro front preencher sozinho.
// Registrada ANTES de /api/formularios/:id pra não cair no :id.
app.get('/api/formularios/favorecido', requireSection('formularios'), async (req, res) => {
  const achado = await formularios.buscarFavorecido(req.query.doc);
  if (!achado) return res.status(404).json({ error: 'Nenhum favorecido salvo com esse documento.' });
  // a memoria de favorecido e indexada so por CPF/CNPJ (nao tem unidade
  // dentro), entao sem esta checagem quem soubesse o CPF de alguem lia o
  // banco/agencia/conta/PIX dele mesmo que o pagamento tenha sido de outra
  // loja. A prova de que a pessoa "conhece" esse favorecido e ja ter emitido
  // um formulário pra ele numa unidade que ela ve - o Master atravessa
  // (filtrarFormulariosPorUnidade nao recorta pra ele).
  const meus = await filtrarFormulariosPorUnidade(req, await formularios.listar());
  const doc = String(achado.doc || '');
  const jaUsou = meus.some((f) => {
    const c = f.campos || {};
    return [c.cpf, c.cnpjFavorecido].some((v) => String(v || '').replace(/\D/g, '') === doc);
  });
  if (!jaUsou) return res.status(404).json({ error: 'Nenhum favorecido salvo com esse documento.' });
  res.json(achado);
});

// a trava de verdade é esta, não o seletor: esconder a opção na tela evita
// o erro honesto, não quem monta a requisição na mão.
// Tres respostas diferentes de propósito - dizer "você não tem acesso" pra
// uma unidade que simplesmente não existe manda a pessoa (ou o Master)
// procurar permissão onde o problema é outro:
async function recusarUnidadeDeFormulario(req, unidade) {
  const permitidas = await unidadesDeFormularioPara(req);
  if (permitidas.some((u) => u.unidade === unidade)) return null;
  // não está no cadastro: deixa passar pro formularios.criar dizer que a
  // unidade é inválida (400), que é o que de fato aconteceu
  const cadastro = await formulariosUnidades.obterPorUnidade(unidade);
  if (!cadastro) return null;
  if (cadastro.ativo === false) {
    return { status: 400, error: `A unidade "${cadastro.unidade}" está desativada no cadastro de formulários. Reative no cadastro (só Master) antes de emitir.` };
  }
  return { status: 403, error: 'Você não tem acesso a essa unidade para emitir formulário. Peça ao Master pra liberar essa unidade no seu acesso.' };
}

app.post('/api/formularios', requireSection('formularios'), upload.array('anexos', 5), async (req, res) => {
  try {
    const payload = req.is('multipart/form-data') ? JSON.parse(req.body.payload || '{}') : req.body;
    const recusa = await recusarUnidadeDeFormulario(req, payload.unidade);
    if (recusa) return res.status(recusa.status).json({ error: recusa.error });
    const anexos = [];
    for (const file of req.files || []) {
      const tipoOk = /^image\//.test(file.mimetype || '') || file.mimetype === 'application/pdf';
      if (!tipoOk) return res.status(400).json({ error: `Anexo "${file.originalname}" não é PDF nem imagem.` });
      const path = await storage.salvarArquivo(payload.unidade || 'geral', file, 'formularios');
      anexos.push({ nome: file.originalname, path, tipo: file.mimetype });
    }
    const criado = await formularios.criar({
      tipo: payload.tipo, unidade: payload.unidade, campos: payload.campos, linhas: payload.linhas, anexos,
      criadoPorId: req.user.id, criadoPorEmail: req.user.email,
    });
    res.json(formularioComLinks(criado));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// a unidade escolhe: preencher agora (POST /api/formularios, acima) ou
// gerar o link pro próprio solicitante preencher
app.post('/api/formularios/link-preenchimento', requireSection('formularios'), async (req, res) => {
  try {
    const recusa = await recusarUnidadeDeFormulario(req, req.body.unidade);
    if (recusa) return res.status(recusa.status).json({ error: recusa.error });
    res.json(await formularios.criarParaPreenchimento({
      tipo: req.body.tipo, unidade: req.body.unidade,
      criadoPorId: req.user.id, criadoPorEmail: req.user.email,
    }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/formularios/link-preenchimento/:id', requireSection('formularios'), async (req, res) => {
  try {
    res.json(await formularios.cancelarPreenchimento(req.params.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/formularios/:id', requireSection('formularios'), async (req, res) => {
  const f = await formularios.detalhar(req.params.id);
  if (!f) return res.status(404).json({ error: 'Formulário não encontrado.' });
  res.json(formularioComLinks(f));
});

app.get('/api/formularios/:id/pdf', requireSection('formularios'), async (req, res) => {
  const registro = await formularios.getOne(req.params.id);
  if (!registro) return res.status(404).json({ error: 'Formulário não encontrado.' });
  try { await formularios.gerarPdf(registro, res, { inline: req.query.inline === '1' }); } catch (err) {
    console.error('Erro ao gerar PDF do formulário:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Não consegui montar o PDF agora.' });
  }
});

app.get('/api/formularios/:id/anexo/:indice', requireSection('formularios'), async (req, res) => {
  const registro = await formularios.getOne(req.params.id);
  const anexo = registro && (registro.anexos || [])[Number(req.params.indice)];
  if (!anexo) return res.sendStatus(404);
  storage.streamArquivo(anexo.path, anexo.tipo, res);
});

// correção e cancelamento, só Master (ver formularios.js): editar refaz o
// conteúdo e descarta as assinaturas já coletadas - assinatura vale pelo
// que a pessoa viu; cancelar tira de circulação sem apagar o registro.
app.put('/api/formularios/:id', auth.requireMaster, async (req, res) => {
  try {
    const dados = { campos: req.body.campos, linhas: req.body.linhas, porEmail: req.user.email };
    if (await desviarSeQaMaster(req, res, 'formularios.editar', `Editar formulário ${req.params.id}`, { id: req.params.id, ...dados })) return;
    res.json(formularioComLinks(await formularios.editar(req.params.id, dados)));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/formularios/:id/cancelar', auth.requireMaster, async (req, res) => {
  try {
    const dados = { motivo: req.body.motivo, porEmail: req.user.email };
    if (await desviarSeQaMaster(req, res, 'formularios.cancelar', `Cancelar formulário ${req.params.id}`, { id: req.params.id, ...dados })) return;
    res.json(await formularios.cancelar(req.params.id, dados));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/formularios/:id', auth.requireMaster, async (req, res) => {
  if (await desviarSeQaMaster(req, res, 'formularios.remover', `Excluir formulário ${req.params.id}`, { id: req.params.id })) return;
  res.json(await formularios.remover(req.params.id));
});

// Formulário assinado -> ticket de Pagamento na Central, com os mesmos
// anexos (comprovantes, ou o boleto no Ass. Boleto) e o MESMO Ticket # -
// o formulário já nasce com esse número (ver criar()/criarParaPreenchimento
// em formularios.js), então os dois lados da mesma solicitação
// compartilham a numeração, igual à cobrança de chamado de TI/Manutenção
// (ver enviarCobrancaChamado acima).
app.post('/api/formularios/:id/enviar-pagamento', requireSection('formularios'), async (req, res) => {
  try {
    const registro = await formularios.getOne(req.params.id);
    if (!registro) return res.status(404).json({ error: 'Formulário não encontrado.' });
    if (!req.isMaster) {
      const liberadas = new Set(req.permissions?.unidades || []);
      const porRotulo = await formulariosUnidades.mapaRotuloParaCodigo();
      const codigo = registro.unidadeCodigo || porRotulo[registro.unidade];
      if (!codigo || !liberadas.has(codigo)) return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    }
    if (registro.status !== 'ASSINADO') return res.status(400).json({ error: 'Só dá pra enviar como Pagamento depois que todas as assinaturas estiverem completas.' });
    if (registro.enviadoPagamento) return res.status(400).json({ error: `Esse formulário já foi enviado como Pagamento (Ticket #${registro.numeroTicket}).` });
    const modelo = formularios.TIPOS[registro.tipo];
    const ticket = await solicitacoes.create({
      tipo: 'pagamento',
      numeroTicket: registro.numeroTicket,
      unidade: registro.unidadeCodigo || registro.unidade,
      unidadeNome: registro.unidade,
      titulo: `${modelo.rotulo} · ${registro.unidade}`,
      valorEstimado: registro.valorTotal,
      observacao: `Gerado do formulário ${modelo.rotulo} (Ticket #${registro.numeroTicket}, ${registro.unidade}), já assinado.\n\nOs dois tickets compartilham a numeração #${registro.numeroTicket}.`,
      itens: [],
      anexos: registro.anexos || [],
      ehOrcamento: false,
      criadoPorId: req.user.id,
      criadoPorEmail: req.user.email,
      direcionadoParaId: null,
      direcionadoParaEmail: null,
    });
    await formularios.marcarEnviadoPagamento(req.params.id, { pagamentoId: ticket.id });
    broadcast('solicitacao-criada', ticket, 'solicitacoes');
    push.notifySolicitacao(`Ticket #${ticket.numeroTicket} · Pagamento (formulário)`, `${modelo.rotulo} · ${registro.unidade} · R$ ${Number(registro.valorTotal || 0).toFixed(2)}`, ticket.id);
    res.json({ ticket });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- notificacoes push (estorno, estorno agendado, chargeback, fraude) ----------
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

// dispara uma notificacao de teste pra TODOS os aparelhos do proprio
// usuario e conta o que aconteceu - e o que transforma "nao chega alerta no
// celular" em diagnostico: se dispositivos=0, a inscricao nunca chegou ao
// servidor (reative o sino); se enviou e nao apareceu, o bloqueio esta no
// aparelho (permissao do site/economia de bateria). O sino chama isso
// sozinho logo depois de ativar (ver toggleNotifications em painel.html)
app.post('/api/push/testar', async (req, res) => {
  res.json(await push.testarPush(req.user.id));
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
  'manutencao.reiniciar': (p) => lojaStatus.enfileirarComandoEmAlvos(p.alvos, lojaStatus.COMANDO_REINICIAR, { origem: 'manutencao-reiniciar' }),
  'manutencao.abortarReinicio': (p) => lojaStatus.enfileirarComandoEmAlvos(p.alvos, lojaStatus.COMANDO_ABORTAR_REINICIO, { origem: 'manutencao-abortar' }),
  'formularios.editar': (p) => formularios.editar(p.id, { campos: p.campos, linhas: p.linhas, porEmail: p.porEmail }),
  'formularios.cancelar': (p) => formularios.cancelar(p.id, { motivo: p.motivo, porEmail: p.porEmail }),
  'formularios.remover': (p) => formularios.remover(p.id),
  'pedidoSemanal.criarRegra': (p) => pedidoSemanal.criarRegra(p),
  'pedidoSemanal.editarRegra': (p) => pedidoSemanal.atualizarRegra(p.id, p),
  'pedidoSemanal.excluirRegra': (p) => pedidoSemanal.removerRegra(p.id),
  'bonificacao.criarPerfil': (p) => bonificacaoPerfis.criar(p),
  'bonificacao.editarPerfil': (p) => bonificacaoPerfis.atualizar(p.id, p.dados),
  'bonificacao.excluirPerfil': (p) => bonificacaoPerfis.remover(p.id),
  'bonificacao.fechar': (p) => bonificacao.fechar(p.unidade, p.mes, null),
  'bonificacao.editarFechada': (p) => bonificacao.salvarCompletions(p.unidade, p.mes, { completionsGerente: p.completionsGerente, completionsColaboradores: p.completionsColaboradores }, null, { podeEditarFechada: true }),
  'bonificacao.resetar': (p) => bonificacao.resetarApuracao(p.unidade, p.mes, null),
  'bonificacao.excluirDaEquipe': (p) => rh.atualizarExcluirBonificacao(p.id, p.excluir),
  'usuarios.criar': (p) => users.create(p),
  'usuarios.criarCopiando': (p) => users.criarCopiandoDe(p),
  'usuarios.criarQaMaster': (p) => users.createQaMaster(p),
  'usuarios.permissoes': (p) => users.updatePermissions(p.id, p.permissions),
  'usuarios.ativo': (p) => users.setActive(p.id, p.active),
  'usuarios.horario': (p) => users.updateHorarioPermitido(p.id, p.horarioPermitido),
  'usuarios.isAdmin': (p) => users.updateIsAdmin(p.id, p.isAdmin),
  'usuarios.empresa': (p) => users.updateEmpresa(p.id, p.empresaId),
  'usuarios.qaUser': (p) => users.updateQaUser(p.id, p.qaUser),
  'usuarios.catalogoEstoque': (p) => users.updatePodeCatalogoEstoque(p.id, p.valor),
  'usuarios.catalogoInsumos': (p) => users.updatePodeCatalogoInsumos(p.id, p.valor),
  'usuarios.sessaoLonga': (p) => users.updateSessaoLonga(p.id, p.valor),
  'usuarios.cadastrarOperadores': (p) => users.updatePodeCadastrarOperadores(p.id, p.valor),
  'usuarios.rhTodasUnidades': (p) => users.updatePodeRhTodasUnidades(p.id, p.valor),
  'usuarios.rhCadastrarEfetivado': (p) => users.updatePodeRhCadastrarEfetivado(p.id, p.valor),
  'usuarios.bonifVerValorTotal': (p) => users.updatePodeBonifVerValorTotal(p.id, p.valor),
  'usuarios.bonifVerColaboradores': (p) => users.updatePodeBonifVerColaboradores(p.id, p.valor),
  'usuarios.cargo': (p) => users.updateCargo(p.id, p.cargo),
  'usuarios.resetSenha': (p) => users.resetPassword(p.id, p.password),
  // depois de desbloquear, o aviso pra pessoa sai igual ao caminho direto -
  // aqui sem aprovador identificado no payload, então vai só o push
  'usuarios.desbloquear': async (p) => {
    const r = await users.desbloquear(p.id, { pedirTrocaSenha: p.pedirTrocaSenha });
    avisarLoginDesbloqueado(p.id, { pedirTrocaSenha: !!p.pedirTrocaSenha });
    return r;
  },
  'usuarios.username': (p) => users.updateUsername(p.id, p.username),
  'usuarios.usernamesEmMassa': (p) => users.updateUsernamesEmMassa(p.itens),
  'usuarios.excluir': (p) => users.remove(p.id),
  'grupos.criar': (p) => grupos.create(p),
  'rh.camposConfig': (p) => rhCamposConfig.salvar(p.camposManuais, { porEmail: 'aprovação QA' }),
  'grupos.editar': (p) => grupos.update(p.id, p.dados),
  'grupos.excluir': (p) => grupos.remove(p.id),
  'empresas.criar': (p) => empresas.create(p),
  'empresas.editar': (p) => empresas.update(p.id, p.dados),
  'empresas.excluir': async (p) => { await users.desvincularEmpresa(p.id); return empresas.remove(p.id); },
  'empresas.arquivar': (p) => empresas.arquivar(p.id, { porEmail: p.porEmail }),
  'empresas.desarquivar': (p) => empresas.desarquivar(p.id),
  'unidadesExtras.criar': (p) => invalidandoUnidadesMapa(unidadesExtras.criar(p.dados, codigosUnidadesFixas())),
  'unidadesExtras.editar': (p) => invalidandoUnidadesMapa(unidadesExtras.atualizar(p.id, { nome: p.nome, areas: p.areas, tiposSolicitacao: p.tiposSolicitacao })),
  'unidadesExtras.excluir': (p) => invalidandoUnidadesMapa(unidadesExtras.remover(p.id)),
  'unidadesExtras.perfil': (p) => invalidandoUnidadesMapa(unidadesExtras.upsertPerfil(p.codigo, { nome: p.nome, areas: p.areas, tiposSolicitacao: p.tiposSolicitacao, porEmail: p.porEmail })),
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
  'abastecimento.capacidades': (p) => abastecimentoCarrinho.salvarCapacidades(p.capacidades),
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

// dispara uma acao 'comando_maquina' JA cadastrada num computador escolhido
// (Master clica ▶ Rodar no NOC). Enfileira o comando pro NOCZenith daquele
// computador interno. QA Master cai na fila de aprovacao (mesmo gate das
// outras acoes sensiveis).
app.post('/api/agente/acoes/:id/executar', auth.requireMaster, async (req, res) => {
  try {
    const { codigo, posto } = req.body;
    if (!codigo || !posto) return res.status(400).json({ error: 'Informe o computador (codigo e posto).' });
    const params = { acaoId: req.params.id, parametros: { codigo, posto } };
    if (await desviarSeQaMaster(req, res, 'agente.executarAcao', `Rodar ação do agente no computador ${codigo}/${posto}`, params)) return;
    const mensagem = await agenteAcoes.executarAcaoDoAgente(req.params.id, { codigo, posto });
    res.json({ mensagem });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// dispara a acao 'comando_maquina' em MASSA: em todos os computadores tipo
// interno (opcionalmente so de uma unidade). Enfileira 1 comando por maquina;
// pula quem ja tem um comando pendente (a fila so guarda um por vez) - devolve
// o resumo (quantos entraram, quais pulados e por que). Offline tambem entra
// na fila e roda quando a maquina voltar.
app.post('/api/agente/acoes/:id/executar-massa', auth.requireMaster, async (req, res) => {
  try {
    const todos = await lojaStatus.listar();
    let internos = todos.filter((c) => c.tipo === 'interno');
    if (req.body.unidade) internos = internos.filter((c) => c.codigo === req.body.unidade);
    if (!internos.length) return res.status(400).json({ error: 'Nenhum computador interno encontrado nesse escopo.' });
    const pulados = [];
    let enfileirados = 0;
    for (const c of internos) {
      try {
        await agenteAcoes.executarAcaoDoAgente(req.params.id, { codigo: c.codigo, posto: c.posto });
        enfileirados += 1;
      } catch (err) {
        pulados.push({ nome: c.nome || `${c.codigo}/${c.posto}`, motivo: err.message });
      }
    }
    res.json({ total: internos.length, enfileirados, pulados });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------
// JANELA DE MANUTENÇÃO: reiniciar máquinas do parque (pedido do Master:
// "um script (botão) onde apertaremos e reiniciaremos 1 a 1 ou um grupo de
// computadores, seja da unidade toda ou de várias unidades").
//
// Três travas, todas de propósito:
//  1) só Master (auth.requireMaster);
//  2) SENHA na hora - reiniciar o caixa de várias lojas no meio do
//     movimento é irreversível e visível pro cliente final, então segue o
//     mesmo padrão de excluir empresa: confirma quem está do outro lado;
//  3) o comando NÃO vem do corpo da requisição. A rota só escolhe entre
//     dois textos fixos no servidor (reiniciar / abortar) - aceitar texto
//     livre aqui seria criar um "rodar qualquer coisa em toda a rede".
//
// O alvo, sim, vem de fora: uma lista de {codigo, posto}. A tela monta
// essa lista de um computador só, de uma unidade inteira, ou de várias
// unidades - pro servidor é tudo a mesma chamada.
app.post('/api/loja-status/manutencao/reiniciar', auth.requireMaster, async (req, res) => {
  try {
    const alvos = Array.isArray(req.body.alvos) ? req.body.alvos : [];
    if (!alvos.length) return res.status(400).json({ error: 'Escolha pelo menos um computador.' });
    if (alvos.length > 200) return res.status(400).json({ error: 'Muitos alvos de uma vez - divida em lotes.' });
    const abortar = req.body.abortar === true;
    if (!(await exigirSenhaDoMaster(req, res))) return;
    const acao = abortar ? 'manutencao.abortarReinicio' : 'manutencao.reiniciar';
    const resumo = `${abortar ? 'Abortar reinício' : 'Reiniciar'} ${alvos.length} computador(es) do parque`;
    if (await desviarSeQaMaster(req, res, acao, resumo, { alvos, porEmail: req.user.email })) return;
    const comando = abortar ? lojaStatus.COMANDO_ABORTAR_REINICIO : lojaStatus.COMANDO_REINICIAR;
    const resultados = await lojaStatus.enfileirarComandoEmAlvos(alvos, comando, {
      origem: abortar ? 'manutencao-abortar' : 'manutencao-reiniciar',
    });
    const ok = resultados.filter((r) => r.ok);
    console.log(`[NOC] ${req.user.email} ${abortar ? 'abortou reinício em' : 'reiniciou'} ${ok.length}/${resultados.length} máquina(s)`);
    res.json({
      total: resultados.length,
      enfileirados: ok.length,
      recusados: resultados.filter((r) => !r.ok),
      // 2 minutos de contagem na tela da loja - é a janela pra abortar
      abortavelPorSegundos: abortar ? 0 : 120,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// config do NOC (Master): hoje so o toggle do push de acesso remoto
app.get('/api/loja-status/config', auth.requireMaster, async (req, res) => {
  res.json(await lojaStatus.getConfig());
});
app.put('/api/loja-status/config', auth.requireMaster, async (req, res) => {
  try {
    const patch = {};
    if (req.body.pushAcessoRemoto !== undefined) patch.pushAcessoRemoto = req.body.pushAcessoRemoto === true;
    res.json(await lojaStatus.setConfig(patch));
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

// Sugere email + usuario livres pro botao "Criar acesso" do ticket de
// Suporte de TI (ver central-historico.html). So calcula, nao grava nada.
app.get('/api/users/sugerir-acesso', auth.requireMaster, async (req, res) => {
  try {
    res.json(await users.sugerirAcesso({
      nome: req.query.nome,
      sobrenome: req.query.sobrenome,
      nomeCompleto: req.query.nomeCompleto,
      dominio: req.query.dominio,
    }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Cria o acesso copiando as PERMISSOES de um usuario que ja existe.
// Passa pelo mesmo gate do POST /api/users: se for um QA Master mexendo,
// vira aprovacao em vez de criar na hora.
app.post('/api/users/criar-copiando', auth.requireMaster, async (req, res) => {
  try {
    const { modeloId, email, username, senha, solicitacaoId } = req.body || {};
    const payload = { modeloId, email, username, senha };
    if (await desviarSeQaMaster(req, res, 'usuarios.criarCopiando', `Criar acesso ${email} copiando permissões de outro usuário`, payload)) return;
    const resultado = await users.criarCopiandoDe(payload);
    // deixa rastro no ticket que originou o acesso - sem isso ninguem
    // consegue, depois, ligar o acesso novo ao pedido que o gerou.
    // Falha aqui nao desfaz a criacao (o acesso ja existe e vale), so loga.
    if (solicitacaoId) {
      try {
        await centralChat.addMessage({
          tipo: req.body.solicitacaoTipo || 'suporte-ti',
          cardId: solicitacaoId,
          autorId: req.user.id,
          autorEmail: req.user.email,
          autorUsername: req.user.username || null,
          texto: `👤 Acesso criado no NoPulso: ${resultado.usuario.email} (usuário: ${resultado.usuario.username}), permissões copiadas de ${resultado.copiadoDe.username || resultado.copiadoDe.email}. A senha foi entregue pelo Master por fora do app e será trocada no primeiro login.`,
        });
      } catch (err) {
        console.error('Acesso criado, mas falhou registrar no chat do ticket:', err.message);
      }
    }
    res.json(resultado);
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

// vincula o acesso a uma empresa - e o que limita ate onde vai o "ve tudo"
// de um Admin (ver escopoDeUnidades em auth.js). Vazio desvincula.
app.put('/api/users/:id/empresa', auth.requireMaster, async (req, res) => {
  try {
    const empresaId = req.body.empresaId || null;
    const nome = empresaId ? ((await empresas.list()).find((e) => e.id === empresaId) || {}).nome : null;
    const resumo = empresaId ? `Vincular o acesso ${req.params.id} à empresa ${nome || empresaId}` : `Desvincular o acesso ${req.params.id} de qualquer empresa`;
    if (await desviarSeQaMaster(req, res, 'usuarios.empresa', resumo, { id: req.params.id, empresaId })) return;
    res.json(await users.updateEmpresa(req.params.id, empresaId));
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

// as 2 flags da Bonificação (ver users.js) - quem só tem a seção 'bonificacao'
// vê o próprio card; estas abrem faturamento/pool/taxas e a lista nominal de
// colaboradores. Nunca mostrar todos pra todo mundo (pedido do Master).
app.put('/api/users/:id/bonif-ver-valor-total', auth.requireMaster, async (req, res) => {
  try {
    if (await desviarSeQaMaster(req, res, 'usuarios.bonifVerValorTotal', `Editar permissão Bonificação (ver valor total) do acesso ${req.params.id}`, { id: req.params.id, valor: req.body.podeBonifVerValorTotal })) return;
    res.json(await users.updatePodeBonifVerValorTotal(req.params.id, req.body.podeBonifVerValorTotal));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/users/:id/bonif-ver-colaboradores', auth.requireMaster, async (req, res) => {
  try {
    if (await desviarSeQaMaster(req, res, 'usuarios.bonifVerColaboradores', `Editar permissão Bonificação (ver colaboradores) do acesso ${req.params.id}`, { id: req.params.id, valor: req.body.podeBonifVerColaboradores })) return;
    res.json(await users.updatePodeBonifVerColaboradores(req.params.id, req.body.podeBonifVerColaboradores));
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
    const resultado = await users.desbloquear(req.params.id, { pedirTrocaSenha: !!req.body.pedirTrocaSenha });
    // avisa a pessoa na hora - mesma frase do pop-up de quem desbloqueou
    avisarLoginDesbloqueado(req.params.id, { porId: req.user.id, porEmail: req.user.email, pedirTrocaSenha: !!req.body.pedirTrocaSenha });
    res.json(resultado);
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
  // fechamento do Saltiverso mora numa colecao a parte (saltiversoFechamentos,
  // schema proprio) - entra aqui so na LEITURA, convertido pro mesmo formato
  // de linha (ver saltiversoFechamento.comoFechamento), pra aparecer junto
  // com as lojas no painel geral em vez de só na tela dedicada dele
  const saltiversoLancado = (await saltiversoFechamento.listAll()).map(saltiversoFechamento.comoFechamento);
  const combinado = sheetsSync.mesclarLancamentosDoMesmoDia([...fechamentosData, ...lancados, ...sangriasLancadas, ...saltiversoLancado]);
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
// So a ARCFOOD tem planilha de destino: o Grupo Bravo aposentou a dele
// (2026-08) e agora e 100% nativo no Firestore, entao mandar fechamento de
// volta pra la nao existe mais - a aba "BD" que recebia essa escrita foi
// apagada. Quando a ARCFOOD tambem for implantada em todas as unidades,
// essa rota inteira sai junto.
const UNIDADES_ENVIO_PLANILHA = {
  ARCFOOD: ['19821', '19855', '19888', '19889'],
};

app.post('/api/fechamentos/:grupo/enviar-planilha', auth.requireMaster, async (req, res) => {
  try {
    const grupo = String(req.params.grupo || '').toUpperCase();
    const unidades = UNIDADES_ENVIO_PLANILHA[grupo];
    if (!unidades) return res.status(400).json({ error: 'Grupo sem planilha de destino. Só a ARCFOOD ainda usa planilha.' });
    const data = (req.body && req.body.data) || ontemBrasiliaISO();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return res.status(400).json({ error: 'Data inválida.' });
    const lancados = (await fechamentosLive.listByUnidades(unidades)).filter((f) => f.data === data);
    const porUnidade = new Map(lancados.map((f) => [f.unidade, f]));

    const resultado = { grupo, data, enviados: [], semLancamento: [], erros: [] };
    for (const cod of unidades) {
      const f = porUnidade.get(cod);
      const nome = (f && f.unidadeNome) || FECHAMENTO_UNIDADES_NOMES[cod] || cod;
      if (!f) { resultado.semLancamento.push(nome); continue; }
      try {
        const r = await sheetsSync.enviarFechamentoPlanilha(f, grupo);
        resultado.enviados.push({ unidade: nome, acao: r.acao });
      } catch (err) {
        resultado.erros.push({ unidade: nome, erro: err.message });
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
  // colunas escondidas/reordenadas no seletor 🧩 Colunas da tela (fechamentos.html)
  const ocultas = new Set(String(req.query.ocultas || '').split(',').filter(Boolean));
  const ordem = String(req.query.ordem || '').split(',').filter(Boolean);
  return fechamentosReport.prepararRelatorio(fechamentos, listaGrupos, ocultas, ordem);
}

// mesma agregacao por unidade do painel "Comparativo por unidade" da tela
// (renderUnidadesTable em fechamentos.html) - a coluna "Previsao (mes)" fica
// de fora do relatorio de proposito: e uma projecao calculada em cima do
// historico completo (nao so do periodo filtrado) e nao faz sentido como
// valor estatico exportado
// Sai DIVIDIDO POR REDE (ver redes.js): as unidades de cada rede em bloco,
// com uma linha de subtotal, e o total geral no fim. Sao duas operacoes com
// contabilidade separada - a lista unica ordenada por faturamento misturava
// as duas e obrigava a somar na mao.
function prepararFechamentosPorUnidade(rows) {
  const colunas = [
    { key: 'rede', label: 'Rede' },
    { key: 'unidade', label: 'Unid.' }, { key: 'qtd', label: 'Fechamentos' }, { key: 'faturamento', label: 'Faturamento' },
    { key: 'diferenca', label: 'Diferença' }, { key: 'tc', label: 'TC total' }, { key: 'cancelados', label: 'Cancelados' },
  ];
  const porUnidade = {};
  rows.forEach((r) => {
    const c = (porUnidade[r.unidade] ||= { codigo: r.unidade, nome: r.unidadeNome || r.unidade, qtd: 0, faturamento: 0, diferenca: 0, tc: 0, cancelados: 0 });
    c.qtd++; c.faturamento += r.faturamento || 0; c.diferenca += r.diferenca || 0; c.tc += r.tc || 0; c.cancelados += r.cancelados || 0;
  });
  const agregados = Object.values(porUnidade);
  // a linha ja vem formatada (string) pro reportUtil generico - por isso o
  // subtotal e somado ANTES, em cima dos numeros, nunca dos textos
  const comoLinha = (c, rede) => ({
    rede, unidade: c.nome, qtd: c.qtd,
    faturamento: reportUtil.fmtMoneyBR(c.faturamento), diferenca: reportUtil.fmtMoneyBR(c.diferenca),
    tc: c.tc.toFixed(0), cancelados: c.cancelados.toFixed(0),
  });

  const grupos = redes.agruparPorRede(agregados, 'codigo');
  const linhas = [];
  grupos.forEach((g, i) => {
    g.itens.sort((a, b) => b.faturamento - a.faturamento).forEach((c, j) => {
      // cada rede numa folha propria no PDF (ver _novaPagina em reportUtil);
      // a primeira nao quebra, senao sai uma folha em branco na frente
      const linha = comoLinha(c, g.nome);
      if (i > 0 && j === 0) linha._novaPagina = true;
      linhas.push(linha);
    });
    const soma = g.itens.reduce((acc, c) => ({
      qtd: acc.qtd + c.qtd, faturamento: acc.faturamento + c.faturamento, diferenca: acc.diferenca + c.diferenca,
      tc: acc.tc + c.tc, cancelados: acc.cancelados + c.cancelados,
    }), { qtd: 0, faturamento: 0, diferenca: 0, tc: 0, cancelados: 0 });
    linhas.push(comoLinha({ ...soma, nome: `SUBTOTAL (${g.itens.length} unidade(s))` }, g.nome));
  });
  // com uma rede so, o total geral repetiria o subtotal logo acima
  if (grupos.length > 1) {
    const geral = agregados.reduce((acc, c) => ({
      qtd: acc.qtd + c.qtd, faturamento: acc.faturamento + c.faturamento, diferenca: acc.diferenca + c.diferenca,
      tc: acc.tc + c.tc, cancelados: acc.cancelados + c.cancelados,
    }), { qtd: 0, faturamento: 0, diferenca: 0, tc: 0, cancelados: 0 });
    // consolidado em folha propria - no pe da ultima rede seria lido como
    // total daquela rede
    linhas.push({ ...comoLinha({ ...geral, nome: 'TOTAL GERAL' }, 'Consolidado'), _novaPagina: true });
  }
  return { colunas, linhas, unidades: agregados.length };
}

app.get('/api/fechamentos/relatorio-unidades.:formato(csv|pdf)', requireSection('fechamentos'), async (req, res) => {
  const { colunas, linhas, unidades } = prepararFechamentosPorUnidade(await fechamentosFiltrados(req));
  if (req.params.formato === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${reportUtil.nomeArquivoComData('fechamentos-por-unidade')}.csv"`);
    return res.send(reportUtil.toCSV(colunas, linhas));
  }
  reportUtil.writePDF(res, { titulo: 'Fechamentos · Comparativo por Unidade', subtitulo: `Exportado em ${reportUtil.agoraBrasiliaFmt()} · ${unidades} unidade(s) · dividido por rede`, colunas, linhas, nomeArquivo: reportUtil.nomeArquivoComData('fechamentos-por-unidade') });
});

// ---------- relatorio de Fechamentos (CSV/PDF) do periodo filtrado na tela -
// mesma secao 'fechamentos' da tela (nao restrito ao Master), respeitando as
// unidades que o usuario tem permissao de ver ----------
app.get('/api/fechamentos/relatorio.csv', requireSection('fechamentos'), async (req, res) => {
  const { colunas, linhas, secoes } = await montarRelatorioFechamentos(req);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fechamentosReport.slugify('relatorio-fechamentos')}-${reportUtil.dataArquivo()}.csv"`);
  res.send(fechamentosReport.toCSV(colunas, linhas, secoes));
});

app.get('/api/fechamentos/relatorio.pdf', requireSection('fechamentos'), async (req, res) => {
  const { inicio, fim } = req.query;
  const { colunas, linhas, secoes } = await montarRelatorioFechamentos(req);
  const periodo = inicio || fim ? ` · período: ${inicio || 'início'} a ${fim || 'hoje'}` : '';
  // dizer QUAIS redes entraram evita a duvida de "cade a ARCFOOD?" quando o
  // filtro da tela deixou uma delas de fora
  const porRede = secoes.map((sc) => `${sc.nome}: ${sc.qtd}`).join(' · ');
  const subtitulo = `Exportado em ${agoraBrasiliaFmt()}${periodo} · ${linhas.length} fechamento(s)${porRede ? ' · ' + porRede : ''}`;
  fechamentosReport.writePDF(res, { titulo: 'Relatório de Fechamentos', subtitulo, colunas, linhas, secoes, nomeArquivo: `relatorio-fechamentos-${reportUtil.dataArquivo()}` });
});

// ---------- recordes de venda (maior/menor dia, maior/menor semana) por
// unidade + quem bateu recorde recentemente (candidatos a plano de meta) -
// ver vendasRecordes.js. Usa a MESMA base de fechamentosFiltrados() da tela
// (planilha + lançado no sistema + sangria, já filtrado por permissão) -
// inicio/fim são OPCIONAIS aqui (a tela manda um filtro de Período próprio,
// separado do de Fechamentos): sem eles, olha o histórico inteiro, que é o
// normal - o recorde geralmente precisa olhar todo o passado, não só um
// período recente. Com eles, restringe a busca de recorde a essa janela
// (ex: "qual foi o recorde só neste trimestre") ----------
app.get('/api/fechamentos/recordes', requireSection('fechamentos'), async (req, res) => {
  try {
    const janelaDias = Number(req.query.janela) > 0 ? Number(req.query.janela) : 30;
    const fechamentos = await fechamentosFiltrados(req);
    res.json(vendasRecordes.montar(fechamentos, { janelaDias }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/fechamentos/sincronizacao', requireSection('fechamentos'), (req, res) => {
  res.json(statusSincronizacaoPlanilhas);
});

// forca uma sincronizacao imediata com as planilhas - so o Master (evita
// disparar chamadas extras na API do Google sem necessidade). Por padrao a
// leitura e INCREMENTAL (so as linhas novas desde a ultima leitura); passe
// { completa: true } pra reler a planilha inteira (pega linha antiga editada)
// Migração de UMA VEZ SÓ da planilha aposentada do Grupo Bravo pro banco
// (ver bravoImport.js). Três ações, nesta ordem - a rota não deixa pular:
//   simular         -> lê a planilha e devolve os totais, sem gravar nada
//   cadastrar-campos-> acrescenta no grupo as definições de canal/forma que
//                      faltam (sem isso o faturamento entraria zerado)
//   gravar          -> grava, exigindo a palavra de confirmação
// Master de verdade só: um QA Master não pode disparar 844 escritas.
// Idempotente - dia que já existe é pulado, então rodar duas vezes não
// duplica e uma queda no meio se resolve rodando de novo.
app.post('/api/fechamentos/bravo/importar', auth.requireMaster, async (req, res) => {
  if (req.isQaMaster) {
    return res.status(403).json({ error: 'Importação da planilha não roda em acesso de QA - precisa de um Master de verdade.' });
  }
  const acao = String(req.body?.acao || 'simular');
  try {
    if (acao === 'simular') return res.json({ acao, ...(await bravoImport.simular()), campos: await bravoImport.conferirCampos() });
    if (acao === 'cadastrar-campos') return res.json({ acao, ...(await bravoImport.cadastrarCampos()) });
    // Conferência de COLUNAS: mostra o que a planilha tem, o que o NoPulso já
    // conhece e o que é parecido o suficiente pra valer uma pergunta. Não grava.
    if (acao === 'analisar-colunas') return res.json({ acao, ...(await bravoImport.analisarColunas()) });
    // Grava as decisões do Master (unificar / criar / ignorar). A partir daqui
    // toda leitura da planilha já respeita elas - sem deploy.
    if (acao === 'decidir-colunas') {
      const r = await bravoMapa.salvarDecisoes(req.body?.decisoes, req.user.email);
      // a leitura cacheada foi montada com as decisões ANTIGAS - se ficasse,
      // a gravação usaria o mapeamento que o Master acabou de trocar
      bravoImport.invalidarLeitura();
      return res.json({ acao, ...r });
    }
    if (acao === 'gravar') {
      const r = await bravoImport.importar({
        confirmar: req.body?.confirmar, unidade: req.body?.unidade || null,
        pular: req.body?.pular, limite: req.body?.limite,
      });
      fechamentosLive.invalidarCache();
      return res.json({ acao, ...r });
    }
    // "repor" = mesmo que gravar, mas em vez de pular o dia que já existe,
    // troca ele pela versão mesclada da planilha. Conserta os dias que
    // entraram pela metade na primeira importação (quando o dia tinha mais de
    // uma linha e só a primeira gravava). Nunca toca em fechamento lançado por
    // uma pessoa - ver o modo repor em bravoImport.js.
    if (acao === 'repor') {
      const r = await bravoImport.importar({
        confirmar: req.body?.confirmar, repor: true, unidade: req.body?.unidade || null,
        pular: req.body?.pular, limite: req.body?.limite,
      });
      fechamentosLive.invalidarCache();
      return res.json({ acao, ...r });
    }
    return res.status(400).json({ error: 'Ação inválida. Use simular, analisar-colunas, decidir-colunas, cadastrar-campos, gravar ou repor.' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

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

// Le a foto do relatorio de vendas do PDV e devolve um RASCUNHO com o valor
// de cada Canal de venda (ver canaisVendaOcr.js) - mesmo motor de visao da
// leitura de nota fiscal do Estoque. Nao grava nada: quem confere e envia o
// fechamento continua sendo a loja, campo a campo.
//
// So responde se o GRUPO daquela unidade tiver o recurso ligado
// (lerCanaisPorImagem, marcado pelo Master em /grupos.html). O formato do
// relatorio muda de PDV pra PDV: liberar pra todo mundo de uma vez seria
// entregar leitura ruim pra lojas que nem foram testadas.
app.post('/api/fechamentos/ler-canais', requireSection('lancamento'), uploadRelatorioPdv.array('imagem', 5), async (req, res) => {
  try {
    const unidade = req.body.unidade;
    if (!unidade) return res.status(400).json({ error: 'Informe a unidade.' });
    if (!req.isMaster && !(req.permissions?.unidades || []).includes(unidade)) {
      return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    }
    const arquivos = (req.files || []).map((f) => ({ buffer: f.buffer, mimeType: f.mimetype }));
    if (!arquivos.length) return res.status(400).json({ error: 'Anexe a foto do relatório de vendas.' });
    if (!canaisVendaOcr.ativo()) return res.status(400).json({ error: 'Leitura automática por imagem não está configurada neste servidor.' });
    const grupo = await grupos.grupoDaUnidade(unidade);
    if (!grupo || grupo.lerCanaisPorImagem !== true) {
      return res.status(400).json({ error: 'Essa loja não usa leitura de Canais por imagem. O Master ativa em Grupos.' });
    }
    // le as duas secoes na mesma passada: o relatorio do PDV mostra os canais
    // e as formas de pagamento no mesmo print, e mandar a imagem duas vezes
    // custaria o dobro pra ler exatamente a mesma coisa
    // campo marcado como "digitado na mao" no Grupo (Pix CNPJ, Outros...) nao
    // vai pro modelo: ele nao sai no relatorio, entao listar seria so dar ao
    // modelo a chance de casar uma linha qualquer com ele
    const paraLeitura = (lista) => (lista || []).filter((c) => c.manual !== true).map((c) => ({ campo: c.campo, label: c.label, tipo: c.tipo }));
    // KPI entra na leitura quando o valor cabe numa resposta simples: numero
    // (quantidade/moeda/kg) OU texto solto (ex: "2,05" - metrica de tempo em
    // minutos DECIMAL que o Master cadastrou como "Texto Livre" porque o
    // tipo "Tempo" da tela so aceita mm:ss). Tempo (mm:ss) e arquivo ficam de
    // fora: mm:ss exigiria o modelo acertar um formato rigido, e arquivo nem
    // e leitura de valor (e upload de anexo)
    const kpisOcrElegiveis = (grupo.kpisExtras || []).filter((k) => ['quantidade', 'moeda', 'kg', 'texto'].includes(k.tipo || 'quantidade'));
    // a dica e escrita pelo Master no cadastro do grupo: cada PDV imprime de
    // um jeito (ordem das linhas, coluna que vale) e isso nao cabe no codigo
    // sem virar um "if" por bandeira
    const rascunho = await canaisVendaOcr.lerCanais({
      arquivos,
      canais: paraLeitura(grupo.canaisVendaExtras),
      formas: paraLeitura(grupo.formasPagamentoExtras),
      kpis: paraLeitura(kpisOcrElegiveis),
      dica: grupo.dicaLeituraCanais,
    });
    res.json(rascunho);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

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
    const { unidade, unidadeNome, grupo, data, campos, canaisVendaExtras, formasPagamentoExtras, observacao, detalhesMaquinas, detalhesMaquinasPos, detalhesSaidas } = body;
    if (!req.isMaster && !(req.permissions.unidades || []).includes(unidade)) {
      return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    }
    // "Responsável" e travado no usuario logado - nao aceita mais o texto
    // livre do body (mesmo que a tela mande algo, e ignorado). Decisao do
    // Master: quem lanca no sistema E quem assina o fechamento sao sempre a
    // mesma pessoa, sem excecao - antes era texto digitado a mao, sem
    // vinculo nenhum com o login (podia divergir do que "criadoPorEmail" ja
    // registrava por baixo dos panos)
    const gerente = req.user.username || req.user.email;
    // unidade administrativa (ex: MVPar) pode nao ter fechamento - vale ate
    // pro Master, mesma logica do check de tiposSolicitacao (ver unidades.js)
    if (unidade && !(await unidadesExtras.apareceEm(unidade, 'fechamento'))) {
      return res.status(400).json({ error: 'Essa unidade não tem fechamento habilitado.' });
    }
    const arquivosKpi = await uploadArquivosKpi(req.files, unidade || 'geral');
    const kpisExtras = { ...(body.kpisExtras || {}), ...arquivosKpi };
    const registro = await fechamentosLive.create({
      unidade, unidadeNome, grupo, data, gerente, campos, kpisExtras, canaisVendaExtras, formasPagamentoExtras, observacao, detalhesMaquinas, detalhesMaquinasPos, detalhesSaidas,
      criadoPorId: req.user.id,
      criadoPorEmail: req.user.email,
    });
    broadcast('fechamento-lancado', registro, 'lancamento');
    // aviso de rotina de que a loja fechou o dia (pedido do Master: "quero
    // receber notificação quando os fechamentos forem realizados"). Nao
    // segura a resposta e nunca derruba o lançamento: o fechamento ja esta
    // gravado, o push e' bonus
    push.notifyFechamentoLancado(registro, { exceptUserId: req.user.id })
      .catch((err) => console.error('Erro no push de fechamento lançado:', err.message));
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
// RECORTE POR UNIDADE do cadastro de grupos (ver "A REGRA DA UNIDADE" em
// auth.js). O cadastro do grupo e global, mas a LISTA DE LOJAS dele nao
// pode sair inteira pra quem so manda numa: a tela de KPI's monta as
// colunas/series a partir deste campo, entao o Tatuape via "Mooca" no
// grafico (vazio, porque /api/fechamentos ja filtra - mas via). Grupo onde
// a pessoa nao tem NENHUMA loja nao volta: sem unidade nenhuma dentro, ele
// so renderia tela vazia com o nome de uma operacao que nao e dela.
function recortarGruposPorUnidade(req, lista) {
  const visiveis = auth.unidadesVisiveis(req);
  if (!visiveis) return lista;
  return (lista || [])
    .map((g) => ({ ...g, unidades: (g.unidades || []).filter((u) => visiveis.has(u)) }))
    .filter((g) => g.unidades.length);
}

app.get('/api/grupos', requireAnySection('lancamento', 'fechamentos', 'solicitacoes'), async (req, res) => {
  const lista = await grupos.list();
  // "lerCanaisDisponivel" e derivado, nao cadastro: o Master pode ter ligado
  // a leitura por foto no grupo, mas se o servidor esta sem ANTHROPIC_API_KEY
  // ela nao funciona. O lancamento TRAVA os campos que a foto preenche, entao
  // sem essa distincao a loja ficaria sem conseguir lancar - com os campos
  // bloqueados e nenhuma forma de preenche-los. grupos.html ignora esse campo
  // (o toggle de cadastro continua sendo lerCanaisPorImagem).
  const ocrLigado = canaisVendaOcr.ativo();
  // RECORTE POR UNIDADE (ver "A REGRA DA UNIDADE" em auth.js). O cadastro
  // do grupo e global, mas a LISTA DE LOJAS dele nao pode sair inteira pra
  // quem so manda numa: a tela de KPI's monta as colunas/series a partir
  // deste campo, entao o Tatuape via "Mooca" no grafico (vazio, porque
  // /api/fechamentos ja filtra - mas via). Grupo onde a pessoa nao tem
  // NENHUMA loja nao volta: sem unidade nenhuma dentro, ele so renderia
  // tela vazia com o nome de uma operacao que nao e dela.
  res.json(recortarGruposPorUnidade(req, lista)
    .map((g) => ({ ...g, lerCanaisDisponivel: g.lerCanaisPorImagem === true && ocrLigado })));
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
  // sem isso dava pra descobrir quem responde pelas solicitações de uma loja
  // que nao e sua so trocando ?unidade= na URL (ver "A REGRA DA UNIDADE" em
  // auth.js) - a tela nunca ofereceu, mas a rota aceitava
  if (!auth.podeVerUnidade(req, unidade)) return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
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
  const linhas = recortarGruposPorUnidade(req, await grupos.list()).map((g) => ({
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

// ---------- Bonificação: perfis salvos (Master/Admin) + apuração mensal ----------
// Perfis (percentuais + métricas com peso, por lista de unidades) - ver
// bonificacaoPerfis.js. Mesma régua de quem mexe em grupos.js: Master ou
// Admin (a rede inteira, não "por unidade" - quem só tem a seção
// 'bonificacao' nunca chega nessas rotas, só na apuração abaixo).
app.get('/api/bonificacao/perfis', auth.requireMasterOrAdmin, async (req, res) => {
  try {
    res.json(await bonificacaoPerfis.listar());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/bonificacao/perfis', auth.requireMasterOrAdmin, async (req, res) => {
  try {
    if (await desviarSeQaMaster(req, res, 'bonificacao.criarPerfil', `Criar perfil de bonificação: ${req.body?.nome || ''}`, req.body)) return;
    res.json(await bonificacaoPerfis.criar({ ...req.body, criadoPorEmail: req.user.email }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/bonificacao/perfis/:id', auth.requireMasterOrAdmin, async (req, res) => {
  try {
    if (await desviarSeQaMaster(req, res, 'bonificacao.editarPerfil', `Editar perfil de bonificação ${req.params.id}`, { id: req.params.id, dados: req.body })) return;
    res.json(await bonificacaoPerfis.atualizar(req.params.id, { ...req.body, atualizadoPorEmail: req.user.email }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/bonificacao/perfis/:id', auth.requireMasterOrAdmin, async (req, res) => {
  try {
    if (await desviarSeQaMaster(req, res, 'bonificacao.excluirPerfil', `Excluir perfil de bonificação ${req.params.id}`, { id: req.params.id })) return;
    await bonificacaoPerfis.remover(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Apuração do mês - a unidade pedida tem que estar no acesso de quem pede
// (mesmo guard de rh.js/fechamentosLive.js). A resposta sempre passa por
// montarRespostaPorPermissao antes de sair - nunca manda faturamento/nome
// de colaborador pra quem não tem a flag, mesmo que a pessoa edite a URL.
app.get('/api/bonificacao', requireSection('bonificacao'), async (req, res) => {
  try {
    const { unidade, mes } = req.query;
    if (!req.isMaster && !(req.permissions.unidades || []).includes(unidade)) return res.sendStatus(404);
    const apuracao = await bonificacao.obterOuCriarRascunho(unidade, mes);
    res.json(bonificacao.montarRespostaPorPermissao(apuracao, {
      podeVerTotal: req.isMaster || req.isAdmin || req.podeBonifVerValorTotal,
      podeVerColaboradores: req.isMaster || req.isAdmin || req.podeBonifVerColaboradores,
    }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/bonificacao', requireSection('bonificacao'), async (req, res) => {
  try {
    const { unidade, mes, completionsGerente, completionsColaboradores } = req.body;
    if (!req.isMaster && !(req.permissions.unidades || []).includes(unidade)) return res.sendStatus(404);
    // corrigir uma apuração já FECHADA é privilégio de Master/Admin (mesma
    // régua de quem pode fechar) - só nesse caso passa pelo desvio de QA
    // Master, senão todo clique de checkbox de todo mundo virava aprovação
    const podeEditarFechada = req.isMaster || req.isAdmin;
    if (podeEditarFechada) {
      const atual = await bonificacao.obterOuCriarRascunho(unidade, mes);
      if (atual.status === 'fechado') {
        if (await desviarSeQaMaster(req, res, 'bonificacao.editarFechada', `Editar apuração de bonificação já fechada ${unidade} (${mes})`, { unidade, mes, completionsGerente, completionsColaboradores })) return;
      }
    }
    const apuracao = await bonificacao.salvarCompletions(unidade, mes, { completionsGerente, completionsColaboradores }, req.user.email, { podeEditarFechada });
    res.json(bonificacao.montarRespostaPorPermissao(apuracao, {
      podeVerTotal: req.isMaster || req.isAdmin || req.podeBonifVerValorTotal,
      podeVerColaboradores: req.isMaster || req.isAdmin || req.podeBonifVerColaboradores,
    }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/bonificacao/fechar', requireSection('bonificacao'), auth.requireMasterOrAdmin, async (req, res) => {
  try {
    const { unidade, mes } = req.body;
    if (!req.isMaster && !(req.permissions.unidades || []).includes(unidade)) return res.sendStatus(404);
    if (await desviarSeQaMaster(req, res, 'bonificacao.fechar', `Fechar apuração de bonificação ${unidade} (${mes})`, { unidade, mes })) return;
    const apuracao = await bonificacao.fechar(unidade, mes, req.user.email);
    res.json(bonificacao.montarRespostaPorPermissao(apuracao, {
      podeVerTotal: req.isMaster || req.isAdmin || req.podeBonifVerValorTotal,
      podeVerColaboradores: req.isMaster || req.isAdmin || req.podeBonifVerColaboradores,
    }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// "reseta em caso de erro" (pedido do Master) - mesma régua de quem fecha
// (Master/Admin): apaga a apuração salva e devolve o estado limpo que
// obterOuCriarRascunho monta na hora.
app.post('/api/bonificacao/resetar', requireSection('bonificacao'), auth.requireMasterOrAdmin, async (req, res) => {
  try {
    const { unidade, mes } = req.body;
    if (!req.isMaster && !(req.permissions.unidades || []).includes(unidade)) return res.sendStatus(404);
    if (await desviarSeQaMaster(req, res, 'bonificacao.resetar', `Resetar apuração de bonificação ${unidade} (${mes})`, { unidade, mes })) return;
    const apuracao = await bonificacao.resetarApuracao(unidade, mes, req.user.email);
    res.json(bonificacao.montarRespostaPorPermissao(apuracao, {
      podeVerTotal: req.isMaster || req.isAdmin || req.podeBonifVerValorTotal,
      podeVerColaboradores: req.isMaster || req.isAdmin || req.podeBonifVerColaboradores,
    }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// quem não pode editar uma apuração já fechada (não é Master/Admin) e
// discorda de algo pede revisão aqui - vira aviso na tela do Master +
// push (mesmo canal de solicitação da Central)
app.post('/api/bonificacao/pedir-revisao', requireSection('bonificacao'), async (req, res) => {
  try {
    const { unidade, mes, motivo } = req.body;
    if (!req.isMaster && !(req.permissions.unidades || []).includes(unidade)) return res.sendStatus(404);
    const apuracao = await bonificacao.pedirRevisao(unidade, mes, { motivo, porEmail: req.user.email, porNome: req.user.username || req.user.email });
    push.notifySolicitacao('Bonificação: pedido de revisão', `${unidade} · ${mes} · por ${req.user.username || req.user.email}${motivo ? ' · ' + motivo : ''}`, `bonif-revisao-${unidade}-${mes}`, '/bonificacao.html');
    res.json(bonificacao.montarRespostaPorPermissao(apuracao, {
      podeVerTotal: req.isMaster || req.isAdmin || req.podeBonifVerValorTotal,
      podeVerColaboradores: req.isMaster || req.isAdmin || req.podeBonifVerColaboradores,
    }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// resumo agregado (aba Histórico) - só quem enxerga o valor total (Master/
// Admin/flag); sem parâmetro de unidade, agrega só o que o próprio acesso
// tem permissão de ver (nunca "todas do sistema" pra quem não é Master/Admin)
app.get('/api/bonificacao/resumo', requireSection('bonificacao'), async (req, res) => {
  try {
    if (!req.isMaster && !req.isAdmin && !req.podeBonifVerValorTotal) {
      return res.status(403).json({ error: 'Você não tem permissão pra ver o resumo de bonificação.' });
    }
    const { mes } = req.query;
    const unidades = req.isMaster
      ? (await bonificacaoPerfis.listar()).flatMap((p) => p.unidades || [])
      : (req.permissions.unidades || []);
    res.json(await bonificacao.resumoMes([...new Set(unidades)], mes));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// equipe da unidade (Master/Admin) - pra marcar quem é gerente/assistente e
// não deve entrar na divisão de colaboradores (já é remunerado pela fatia
// de gerente). É uma decisão administrativa por pessoa, não por mês - por
// isso fica igual à régua de Perfis (Master/Admin), não pra todo mundo com
// a seção 'bonificacao'.
app.get('/api/bonificacao/equipe', auth.requireMasterOrAdmin, async (req, res) => {
  try {
    const { unidade } = req.query;
    res.json(await bonificacao.equipeDaUnidade(unidade));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/bonificacao/equipe/:id/excluir', auth.requireMasterOrAdmin, async (req, res) => {
  try {
    if (await desviarSeQaMaster(req, res, 'bonificacao.excluirDaEquipe', `Marcar funcionário ${req.params.id} como fora da divisão de colaboradores da Bonificação`, { id: req.params.id, excluir: req.body.excluir })) return;
    res.json(await rh.atualizarExcluirBonificacao(req.params.id, req.body.excluir));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- Empresas: camada de isolamento acima do Grupo (Empresa -> Grupo
// -> Unidade) - cada empresa e a fronteira que separa uma rede de outra
// (ex: MVPar/Grupo Bravo x Arcfood), pra quando o NoPulso hospedar empresas
// de negocios diferentes (ver empresaDaUnidade em empresas.js, e
// verticaisDoUsuario em GET /api/me pra saber quais modulos cabem em cada
// vertical) ----------
app.get('/api/empresas', auth.requireMaster, async (req, res) => {
  res.json(await empresas.list());
});

app.post('/api/empresas', auth.requireMaster, async (req, res) => {
  try {
    if (await desviarSeQaMaster(req, res, 'empresas.criar', `Criar empresa: ${req.body?.nome || ''}`, req.body)) return;
    res.json(await empresas.create(req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/empresas/:id', auth.requireMaster, async (req, res) => {
  try {
    if (await desviarSeQaMaster(req, res, 'empresas.editar', `Editar empresa ${req.params.id}`, { id: req.params.id, dados: req.body })) return;
    res.json(await empresas.update(req.params.id, req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ARQUIVAR / EXCLUIR EMPRESA - as duas ações destrutivas do cadastro de
// empresas. Regra do Master, valendo pras duas: só o acesso Master, e
// SEMPRE reconfirmando a senha, mesmo com a sessão aberta. auth.requireMaster
// já barra qualquer um que não seja Master; a senha é a segunda camada,
// contra o caso real de alguém mexer numa máquina que ficou logada.
//
// Devolve 400 (não 401) quando a senha está errada: o wrapper de fetch das
// páginas desloga em qualquer 401, e senha de confirmação errada não
// significa sessão inválida (mesmo motivo comentado na rota de sangria).
async function exigirSenhaDoMaster(req, res) {
  const senhaOk = await auth.verifyPassword(req.user.id, req.body?.password);
  if (!senhaOk) {
    res.status(400).json({ error: 'Senha incorreta.' });
    return false;
  }
  return true;
}

// quantos acessos e unidades a decisão atinge - a tela mostra isso ANTES de
// pedir a senha, pra a escolha entre arquivar e excluir ser informada em vez
// de às cegas
app.get('/api/empresas/:id/impacto', auth.requireMaster, async (req, res) => {
  try {
    const empresa = (await empresas.list()).find((e) => e.id === req.params.id);
    if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });
    const vinculados = await users.listarPorEmpresa(req.params.id);
    res.json({
      nome: empresa.nome,
      arquivada: !!empresa.arquivada,
      unidades: (empresa.unidades || []).length,
      acessos: vinculados.length,
      acessosNomes: vinculados.slice(0, 20).map((u) => u.username || u.email),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/empresas/:id/arquivar', auth.requireMaster, async (req, res) => {
  try {
    if (!(await exigirSenhaDoMaster(req, res))) return;
    if (await desviarSeQaMaster(req, res, 'empresas.arquivar', `Arquivar empresa ${req.params.id}`, { id: req.params.id, porEmail: req.user.email })) return;
    res.json(await empresas.arquivar(req.params.id, { porEmail: req.user.email }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/empresas/:id/desarquivar', auth.requireMaster, async (req, res) => {
  try {
    if (!(await exigirSenhaDoMaster(req, res))) return;
    if (await desviarSeQaMaster(req, res, 'empresas.desarquivar', `Desarquivar empresa ${req.params.id}`, { id: req.params.id })) return;
    res.json(await empresas.desarquivar(req.params.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/empresas/:id', auth.requireMaster, async (req, res) => {
  try {
    if (!(await exigirSenhaDoMaster(req, res))) return;
    if (await desviarSeQaMaster(req, res, 'empresas.excluir', `Excluir empresa ${req.params.id}`, { id: req.params.id })) return;
    // solta quem estava vinculado ANTES de apagar: acesso apontando pra uma
    // empresa que não existe mais fica sem enxergar nada (empresa inexistente
    // = lista de unidades vazia) e sem nenhuma pista do porquê. Soltando, a
    // pessoa volta a valer pelas unidades marcadas no próprio acesso.
    const soltos = await users.desvincularEmpresa(req.params.id);
    await empresas.remove(req.params.id);
    res.json({ ok: true, acessosDesvinculados: soltos });
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

// fechamento de caixa do Saltiverso (por operador, ver saltiversoFechamento.js):
// so Gerente/Ass.Gerente DA UNIDADE ou Master/Admin veem quanto cada caixa
// faturou e a lista de todos os caixas do dia. O operador comum so enxerga o
// PROPRIO caixa e nunca o faturado (nem o dele) - senao da pra descobrir o
// faturado pela diferenca que ele mesmo calcularia (declarado - diferenca).
function podeVerFaturadoSaltiverso(req, unidade) {
  if (req.isMaster || req.isAdmin) return true;
  return !!(req.user && users.ehCargoGerente(req.user.cargo) && (req.permissions.unidades || []).includes(unidade));
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

// le a foto/PDF da nota de recebimento (ver inventarioNotaOcr.js) e devolve
// um RASCUNHO (data, fornecedor, numero + itens ja tentando casar com o
// catalogo) pro gerente conferir na tela antes de confirmar - nao grava
// recebimento nenhum sozinho, cada linha confirmada vira um POST
// /api/inventario/recebimentos normal (o mesmo de sempre), um por vez.
// A FOTO/PDF em si e salva no Storage aqui (mesmo se a leitura falhar em
// achar itens) - o comprovante fica guardado pra conferencia e, mais pra
// frente, pra alimentar o custo operacional do DRE com o documento de
// origem de cada custo lançado
app.post('/api/inventario/recebimentos/ler-nota', requireSection('inventario'), uploadNotaFiscal.single('nota'), async (req, res) => {
  try {
    const unidade = req.body.unidade;
    if (!podeUnidadeInventario(req, unidade)) return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    if (!req.file) return res.status(400).json({ error: 'Anexe a foto ou o PDF da nota.' });
    if (!inventarioNotaOcr.ativo()) return res.status(400).json({ error: 'Leitura automática de nota não está configurada neste servidor.' });
    const notaArquivo = await storage.salvarArquivo(unidade, req.file, 'inventario-notas');
    const catalogo = (await inventario.listCatalogo(unidade))
      .filter((i) => i.ativo !== false)
      .map((i) => ({ id: i.id, nome: i.nome, unidadeMedida: i.unidadeMedida }));
    const rascunho = await inventarioNotaOcr.lerNota({ buffer: req.file.buffer, mimeType: req.file.mimetype, catalogo });
    rascunho.notaArquivo = notaArquivo;
    res.json(rascunho);
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
    if (!(await unidadesExtras.apareceEm(req.body.unidade, 'estoque'))) return res.status(400).json({ error: 'Essa unidade não tem Estoque habilitado.' });
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
// mostra a foto/PDF da nota que originou o recebimento (ver notaFiscalArquivo
// em inventario.js) - pra conferir o comprovante contra o que foi lançado
app.get('/api/inventario/recebimentos/:id/nota', requireSection('inventario'), async (req, res) => {
  const registro = (await inventario.listRecebimentos()).find((r) => r.id === req.params.id);
  if (!registro) return res.status(404).json({ error: 'Recebimento não encontrado.' });
  if (!podeUnidadeInventario(req, registro.unidade)) return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
  if (!registro.notaFiscalArquivo) return res.status(404).json({ error: 'Esse recebimento não tem nota anexada.' });
  storage.streamArquivo(registro.notaFiscalArquivo, null, res);
});

app.get('/api/inventario/saidas', requireSection('inventario'), async (req, res) => {
  const todos = await inventario.listSaidas();
  res.json(req.isMaster ? todos : todos.filter((s) => podeUnidadeInventario(req, s.unidade)));
});
app.post('/api/inventario/saidas', requireSection('inventario'), async (req, res) => {
  try {
    if (!podeUnidadeInventario(req, req.body.unidade)) return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    if (!(await unidadesExtras.apareceEm(req.body.unidade, 'estoque'))) return res.status(400).json({ error: 'Essa unidade não tem Estoque habilitado.' });
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

// visao historica das contagens (planilha: itens x dias, contagem + saida)
app.get('/api/inventario/historico-contagens', requireSection('inventario'), async (req, res) => {
  try {
    const { unidade, inicio, fim } = req.query;
    if (!unidade || !inicio || !fim) return res.status(400).json({ error: 'Informe unidade, início e fim.' });
    if (!podeUnidadeInventario(req, unidade)) return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    res.json(await inventario.historicoContagens(unidade, inicio, fim));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ocorrencias de possivel desvio de estoque (ver inventario.verificarDesvioEstoque)
// - fica so na aba Estoque/Ocorrências, restrito ao Master (nao vira ticket
// na Central de Solicitações)
app.get('/api/inventario/desvios', auth.requireMaster, async (req, res) => {
  try {
    res.json(await inventario.listDesvios());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/inventario/desvios/:id/resolver', auth.requireMaster, async (req, res) => {
  try {
    res.json(await inventario.resolverDesvio(req.params.id, { resolvidoPorEmail: req.user.email, resolucaoObs: req.body.resolucaoObs }));
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

// relatorio (CSV/PDF) dos recebimentos de mercadoria - a tela so mostra os
// ultimos 30 (ver renderRecebimentos em estoque.html), o relatorio sai com o
// HISTORICO INTEIRO da unidade (ou o periodo, se inicio/fim vierem na
// query), pra dar pra conferir compra/CMV fora do sistema
app.get('/api/inventario/recebimentos/relatorio.:formato(csv|pdf)', requireSection('inventario'), async (req, res) => {
  try {
    const { unidade, inicio, fim } = req.query;
    if (!unidade) return res.status(400).json({ error: 'Informe a unidade.' });
    if (!podeUnidadeInventario(req, unidade)) return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    const todos = await inventario.listRecebimentos();
    const linhas = todos
      .filter((r) => r.unidade === unidade && (!inicio || (r.data || '') >= inicio) && (!fim || (r.data || '') <= fim))
      .sort((a, b) => (b.data || '').localeCompare(a.data || ''))
      .map((r) => ({
        data: reportUtil.fmtDataBR(r.data), item: r.itemNome, setor: inventario.SETORES[r.setor] || r.setor,
        fornecedor: r.fornecedor, quantidade: r.quantidade, valorUnitario: reportUtil.fmtMoneyBR(r.valorUnitario),
        valorTotal: reportUtil.fmtMoneyBR(r.valorTotal), notaFiscal: r.notaFiscal || '—',
      }));
    const colunas = [
      { key: 'data', label: 'Data' }, { key: 'item', label: 'Item' }, { key: 'setor', label: 'Setor' },
      { key: 'fornecedor', label: 'Fornecedor' }, { key: 'quantidade', label: 'Quantidade' },
      { key: 'valorUnitario', label: 'Valor unit.' }, { key: 'valorTotal', label: 'Valor total' }, { key: 'notaFiscal', label: 'Nota fiscal' },
    ];
    const nomeArquivo = reportUtil.nomeArquivoComData(`inventario-recebimentos-${unidade}`);
    if (req.params.formato === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}.csv"`);
      return res.send(reportUtil.toCSV(colunas, linhas));
    }
    const periodo = inicio || fim ? ` · período: ${inicio || 'início'} a ${fim || 'hoje'}` : ' · histórico completo';
    reportUtil.writePDF(res, {
      titulo: 'Inventário - Recebimentos de mercadoria',
      subtitulo: `${INVENTARIO_UNIDADES_NOMES[unidade] || unidade}${periodo} · ${linhas.length} recebimento(s)`,
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
    if (!(await unidadesExtras.apareceEm(unidade, 'parque'))) return res.status(400).json({ error: 'Essa unidade não tem Parque habilitado.' });
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
      termoAssinado: req.body.termoAssinado,
    });
    // a venda fechou: tira a emissão do termo da lista de pendentes. Falha
    // aqui não desfaz a venda (ela vale), só deixa a emissão pendente - que
    // é o lado seguro do erro: sobra pendência pro gerente conferir, em vez
    // de sumir com o rastro.
    // baixa pelo id que o front mandou E por atendimento (unidade+CPF/nome+
    // dia): o id mora numa variavel da aba e some se a pagina recarregar ou
    // a venda for fechada em outro computador. Sem a baixa por atendimento a
    // venda acontecia, o cliente pagava, e a pendencia continuava aberta
    // virando alerta de "termo sem venda".
    try {
      const baixadas = await parque.finalizarEmissoesDoAtendimento(registro.id, {
        unidade, responsavel, dataUtilizacao,
      }, req.body.emissaoTermoId);
      if (baixadas.length > 1) {
        console.log(`Parque: check-in ${registro.id} baixou ${baixadas.length} emissões do mesmo atendimento (reimpressão de termo).`);
      }
    } catch (err) {
      console.error('Check-in criado, mas falhou baixar a emissão do termo:', err.message);
    }
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

// Previa do termo, a partir do que ESTA NO FORMULARIO - nao cria nada, nao
// grava nada. Existe porque o termo passou a ser assinado ANTES de efetivar
// a venda: o atendente preenche responsavel/criancas, imprime por aqui,
// colhe a assinatura e so entao libera o pagamento. O gerarTermoPDF ja
// aceitava um objeto qualquer, entao nao precisou mudar nada nele.
app.post('/api/parque/termo-previa.pdf', requireAnySection('parque', 'parque-checkin'), async (req, res) => {
  try {
    const b = req.body || {};
    const resp = b.responsavel || {};
    if (!String(resp.nome || '').trim()) return res.status(400).json({ error: 'Preencha o nome do responsável antes de imprimir o termo.' });
    const criancas = Array.isArray(b.criancas) ? b.criancas.slice(0, 40) : [];
    if (!criancas.length) return res.status(400).json({ error: 'Adicione pelo menos uma criança antes de imprimir o termo.' });
    // GRAVA A EMISSAO ANTES DE MANDAR O PDF. É o que fecha a brecha: se o
    // atendente imprimir e sumir sem finalizar, a pendencia ja esta no
    // banco e aparece pro gerente. Fechar o navegador nao desfaz.
    const emissao = await parque.criarEmissaoTermo({
      unidade: b.unidade,
      unidadeNome: b.unidadeNome || b.unidade,
      responsavel: resp,
      criancas,
      dataUtilizacao: b.dataUtilizacao,
      tempoMinutos: b.tempoMinutos,
      valorPrevisto: b.valorPrevisto,
      emitidoPorId: req.user.id,
      emitidoPorEmail: req.user.email,
    });
    // o corpo e um PDF, entao o id volta por header (o front le pra saber
    // qual emissao finalizar/cancelar depois)
    res.setHeader('X-Emissao-Id', emissao.id);
    res.setHeader('Access-Control-Expose-Headers', 'X-Emissao-Id');
    // monta um checkin "de mentira" so pro PDF - mesma forma que o salvo,
    // sem id e sem passar pelo Firestore
    termoResponsabilidade.gerarTermoPDF(res, {
      unidadeNome: b.unidadeNome || b.unidade || '',
      unidade: b.unidade || '',
      responsavel: resp,
      criancas,
      dataUtilizacao: b.dataUtilizacao || null,
      tempoMinutos: b.tempoMinutos || null,
      criadoEm: new Date().toISOString(),
      previa: true,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Termos emitidos e nao resolvidos: cada linha é um atendimento em que o
// termo saiu e a venda nunca fechou. É a lista que o gerente confere - so
// que so o gate do PUSH (notifyParqueTermoPendente/podeReceberPcdCortesia)
// era Master/Gerente; a ROTA que alimenta a TELA ficava aberta pra
// qualquer acesso com a secao 'parque' (ex: atendente), expondo nome,
// email e horas em aberto de quem emitiu cada termo. Mesmo gate do
// financeiro (ver podeVerFinanceiro em parque.html).
app.get('/api/parque/termo-emissoes', requireAnySection('parque', 'parque-checkin'), async (req, res) => {
  try {
    if (!req.isMaster && !users.ehCargoGerente(req.user.cargo)) {
      return res.status(403).json({ error: 'Apenas gerente ou master vê os termos em aberto.' });
    }
    res.json(await parque.listarEmissoesTermo({
      unidades: req.isMaster ? null : (req.permissions.unidades || []),
      apenasPendentes: req.query.todas !== '1',
      dias: Math.min(90, Math.max(1, Number(req.query.dias) || 7)),
    }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Cancelar = assumir que o termo saiu e a venda NAO aconteceu. Exige
// motivo; o registro fica com quem cancelou e quando. Nao apaga nada.
app.post('/api/parque/termo-emissoes/:id/cancelar', requireAnySection('parque', 'parque-checkin'), async (req, res) => {
  try {
    res.json(await parque.cancelarEmissaoTermo(req.params.id, {
      motivo: req.body && req.body.motivo,
      canceladoPorId: req.user.id,
      canceladoPorEmail: req.user.email,
    }));
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

// exclui um check-in de vez (Master). O resto do time usa "Pedir correção"
// (que passa por aprovacao); a exclusao direta e so do Master.
app.delete('/api/parque/checkins/:id', auth.requireMaster, async (req, res) => {
  try {
    const atual = await parque.getOne(req.params.id);
    if (!atual) return res.status(404).json({ error: 'Check-in não encontrado.' });
    await parque.remover(req.params.id);
    broadcast('parque-checkin-atualizado', { id: req.params.id, removido: true }, 'parque');
    broadcast('parque-checkin-atualizado', { id: req.params.id, removido: true }, 'parque-checkin');
    res.json({ ok: true });
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

// depois de enviado, um check-in nao pode mais ser mexido direto - correcao
// (alterar dados/criancas ou excluir) vira um pedido que o Gerente da
// unidade ou o Master/Admin aprova na propria aba Parque.
//
// NAO abre Ticket na Central (pedido explicito do usuario). Abria antes,
// pra "prestacao de contas" do Gerente, mas na pratica virava um card que
// nascia ja resolvido: a decisao acontece aqui, aplica na hora, e o ticket
// so ficava aberto esperando alguem fechar. O rastro (quem pediu, o que
// propos, quem decidiu e quando) mora no proprio pedido e aparece no
// historico do painel do Parque - ver renderEdicoes em parque.html.
// Sem push, como antes.
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
    const pedido = await parque.solicitarEdicao({
      checkinId: req.params.id,
      tipoCorrecao,
      proposta,
      motivo,
      // pedidos antigos guardam o ticket que existia na epoca; os novos
      // nascem sem - a tela mostra o link so quando tem
      numeroTicket: null,
      ticketId: null,
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
  if (req.isMaster || req.isAdmin) return res.json(auth.filtrarPorEmpresa(req, todas));
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
    // Pedido novo não tem ticket (ver rota de solicitar-edicao). Este bloco
    // sobrevive só pros pedidos ANTIGOS, criados quando a correção ainda
    // abria um card na Central: eles continuam recebendo a nota da decisão,
    // pra quem for fechar aquele card saber o que aconteceu.
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
  let lista = (req.isMaster || req.isAdmin)
    ? auth.filtrarPorEmpresa(req, await parque.listAll())
    : await parque.listByUnidades(req.permissions.unidades || []);
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
      valor: req.body.valor, forma: req.body.forma, data: req.body.data,
      porId: req.user.id, porEmail: req.user.email,
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
// login no NoPulso - cadastro no 1o dia (nome/contato/curriculo), acompanha-
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

app.post('/api/rh/ler-documento', requireSection('rh'), uploadDocumentoIdentidade.array('documento', 3), responderLeituraDocumento);

app.post('/api/rh/funcionarios', requireSection('rh'), upload.fields([{ name: 'curriculo', maxCount: 1 }, { name: 'documento', maxCount: 3 }]), async (req, res) => {
  try {
    const { unidade, nome, contato, cargoFuncao, dataNascimento, dataAdmissao, tipoCadastro } = req.body;
    // "1" ou "true" vindo de multipart/form-data (checkbox HTML manda string)
    const semExperiencia = req.body.semExperiencia === 'true' || req.body.semExperiencia === '1' || req.body.semExperiencia === true;
    if (!podeAcessarUnidadeRh(req, unidade)) {
      return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    }
    if (!(await unidadesExtras.apareceEm(unidade, 'rh'))) return res.status(400).json({ error: 'Essa unidade não tem RH habilitado.' });
    if (tipoCadastro === 'efetivado' && !podeCadastrarEfetivado(req)) {
      return res.status(403).json({ error: 'Só o RH pode cadastrar alguém já efetivado direto. Cadastre como Extra ou Candidato (teste de 5 dias).' });
    }
    const faltaDoc = exigeDocumentoIdentidade(tipoCadastro, req.files?.documento);
    if (faltaDoc) return res.status(400).json({ error: faltaDoc });
    // mesma validação de formato do link público (ver cadastro-publico)
    const docsInternos = (req.files?.documento || []).map((f) => ({ mimeType: f.mimetype, buffer: f.buffer }));
    if (docsInternos.length) documentoIdentidadeOcr.validarArquivosDocumento(docsInternos);
    const arquivoCurriculo = (req.files?.curriculo || [])[0];
    const erroCurriculo = validarTipoCurriculo(arquivoCurriculo);
    if (erroCurriculo) return res.status(400).json({ error: erroCurriculo });
    let curriculo = null;
    if (arquivoCurriculo) {
      const path = await storage.salvarArquivo(unidade || 'geral', arquivoCurriculo, 'rh-curriculos');
      curriculo = { path, nomeOriginal: arquivoCurriculo.originalname, tipo: arquivoCurriculo.mimetype };
    }
    // Extra e Candidato so entram com documento, e os dados vem da leitura
    // dele. Efetivado (contratacao formal pelo RH) segue digitado - la o
    // pacote de documentos e outro e mais completo (DOCUMENTOS_OBRIGATORIOS)
    const doc = await lerEGuardarDocumentoIdentidade(req.files?.documento, unidade || 'geral', req.body);
    const registro = await rh.criar({
      unidade, contato, cargoFuncao, dataAdmissao, tipoCadastro, semExperiencia,
      chavePix: req.body.chavePix, banco: req.body.banco,
      // sem documento (Efetivado) tudo continua vindo do formulário
      nome, dataNascimento,
      ...(doc?.campos || {}),
      documentoIdentidade: doc?.anexo || null,
      leituraDocumento: doc?.leitura || null,
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
// no RH (ex: planilha de RH externa sendo migrada pro NoPulso)
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
  if (req.isMaster || req.isAdmin || req.podeRhTodasUnidades) return res.json(auth.filtrarPorEmpresa(req, await rh.listAll()));
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

// ---------- pagamento de diárias por check-in (Master) ----------
// Extra e candidato em teste são pagos por DIÁRIA (1 check-in = 1 diária).
// O Master gera daqui um formulário de Pagamento de Diária (formularios.js,
// tipo diariasRh) com uma linha por check-in ainda não pago, e recebe na
// hora os dois links de assinatura (Favorecido + Responsável).
function dataBrasileira(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso || '');
}

// o que o modal de "pagar diárias" precisa pra abrir: os check-ins que ainda
// não viraram formulário, os dados de pagamento já salvos na ficha e as
// unidades de formulário (com a sugestão casada pelo código da unidade)
app.get('/api/rh/funcionarios/:id/diarias-pendentes', auth.requireMaster, async (req, res) => {
  try {
    const f = await rh.getOne(req.params.id);
    if (!f) return res.status(404).json({ error: 'Funcionário não encontrado.' });
    const checkins = (await rhCheckin.listPorFuncionario(f.id))
      .filter((c) => (c.status === 'aberto' || c.status === 'fechado') && !c.diariaFormularioId)
      .sort((a, b) => String(a.data).localeCompare(String(b.data)))
      .map((c) => ({
        id: c.id, data: c.data, status: c.status,
        entrada: c.entrada?.horario || null, saida: c.saida?.horario || null,
      }));
    const unidadesForm = await formulariosUnidades.listarAtivas();
    res.json({
      funcionario: {
        id: f.id, nome: f.nome, unidade: f.unidade, tipoCadastro: f.tipoCadastro,
        cpf: f.cpf || null, chavePix: f.chavePix || null, banco: f.banco || null,
      },
      checkins,
      unidadesFormulario: unidadesForm.map((u) => ({ unidade: u.unidade, codigo: u.codigo || null })),
      unidadeFormularioSugerida: (unidadesForm.find((u) => u.codigo === f.unidade) || {}).unidade || null,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/rh/funcionarios/:id/gerar-formulario-diarias', auth.requireMaster, async (req, res) => {
  try {
    const f = await rh.getOne(req.params.id);
    if (!f) return res.status(404).json({ error: 'Funcionário não encontrado.' });
    if (f.tipoCadastro === 'efetivado') {
      return res.status(400).json({ error: 'Diária é pra extra e candidato em teste - efetivado recebe pela folha.' });
    }
    const valor = formularios.parseValor(req.body.valorDiaria);
    if (!(valor > 0)) return res.status(400).json({ error: 'Informe o valor da diária (ex: 120,00).' });
    const ids = [...new Set((Array.isArray(req.body.checkinIds) ? req.body.checkinIds : []).map(String))];
    if (!ids.length) return res.status(400).json({ error: 'Selecione ao menos um check-in pra pagar.' });
    if (ids.length > 20) return res.status(400).json({ error: 'No máximo 20 diárias por formulário - gere em dois.' });

    // chave PIX/banco informados aqui ficam salvos NA FICHA: o próximo
    // pagamento (e o formulário de Reembolso, via memória de favorecido)
    // já nasce preenchido
    const chavePix = String(req.body.chavePix != null ? req.body.chavePix : (f.chavePix || '')).trim();
    const banco = String(req.body.banco != null ? req.body.banco : (f.banco || '')).trim();
    if (!chavePix) return res.status(400).json({ error: 'Informe a chave PIX do favorecido - é como a diária vai ser paga (fica salva na ficha pra próxima).' });
    if (chavePix !== (f.chavePix || '') || banco !== (f.banco || '')) {
      await rh.atualizar(f.id, { chavePix, banco });
    }

    const porId = new Map((await rhCheckin.listPorFuncionario(f.id)).map((c) => [c.id, c]));
    const linhas = [];
    for (const id of ids) {
      const c = porId.get(id);
      if (!c) return res.status(400).json({ error: 'Um dos check-ins selecionados não é dessa pessoa.' });
      if (!(c.status === 'aberto' || c.status === 'fechado')) {
        return res.status(400).json({ error: `O check-in de ${dataBrasileira(c.data)} ainda não foi aprovado - não vira diária.` });
      }
      // a trava do pagamento em dobro: check-in que já entrou num formulário
      // não entra em outro (mesmo que o Master clique duas vezes)
      if (c.diariaFormularioId) {
        return res.status(400).json({ error: `O check-in de ${dataBrasileira(c.data)} já está em outro formulário de pagamento - diária não é paga duas vezes.` });
      }
      linhas.push({ data: c.data, nome: f.nome, valor });
    }
    linhas.sort((a, b) => String(a.data).localeCompare(String(b.data)));
    linhas.forEach((l) => { l.data = dataBrasileira(l.data); });

    const cpfFmt = f.cpf ? `${f.cpf.slice(0, 3)}.${f.cpf.slice(3, 6)}.${f.cpf.slice(6, 9)}-${f.cpf.slice(9)}` : '';
    const criado = await formularios.criar({
      tipo: 'diariasRh', unidade: req.body.unidadeFormulario,
      campos: { favorecido: f.nome, cpf: cpfFmt, banco, chavePix },
      linhas,
      criadoPorId: req.user.id, criadoPorEmail: req.user.email,
    });
    await rhCheckin.vincularFormularioDiarias(ids, criado.id);
    res.json(formularioComLinks(criado));
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
// feature existir no NoPulso, vindo de relatorio externo da folha)
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
  const unidades = (req.isMaster || req.isAdmin || req.podeRhTodasUnidades) ? auth.escopoDeUnidades(req) : (req.permissions.unidades || []);
  const lista = await rhCheckin.listByUnidadesData(unidades, req.query.data);
  res.json(lista.map((c) => sanitizarCheckin(c, req.isMaster)));
});

app.get('/api/rh/checkins/abertos', requireSection('rh'), async (req, res) => {
  const unidades = (req.isMaster || req.isAdmin || req.podeRhTodasUnidades) ? auth.escopoDeUnidades(req) : (req.permissions.unidades || []);
  const lista = await rhCheckin.listAbertos(unidades);
  res.json(lista.map((c) => sanitizarCheckin(c, req.isMaster)));
});

app.get('/api/rh/checkins/resumo', requireSection('rh'), async (req, res) => {
  const unidades = (req.isMaster || req.isAdmin || req.podeRhTodasUnidades) ? auth.escopoDeUnidades(req) : (req.permissions.unidades || []);
  res.json(await rhCheckin.resumoSemana(unidades));
});

// contador individual (semana + total) por pessoa - usado nos cards de "Por
// Unidade" e "Extras", separado do resumo global acima
app.get('/api/rh/checkins/contagem-por-funcionario', requireSection('rh'), async (req, res) => {
  const unidades = (req.isMaster || req.isAdmin || req.podeRhTodasUnidades) ? auth.escopoDeUnidades(req) : (req.permissions.unidades || []);
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
  if (req.isMaster || req.isAdmin || req.podeRhTodasUnidades) return res.json(auth.filtrarPorEmpresa(req, await rhAdvertencias.listAll()));
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
  const vendas = await saltiversoVendas.listVendasDoDia(unidade, data);
  // a lista COMPLETA do dia (toda venda, com valor e forma) é o faturado de
  // bandeja: somando os cards, o atendente sabia exatamente quanto declarar
  // no caixa cego e a conferência não provava nada. Atendente comum só vê as
  // PRÓPRIAS vendas (que ele mesmo digitou - não há segredo nelas); a lista
  // do dia inteiro fica pra Gerente/Master, igual ao faturado do fechamento.
  if (podeVerFaturadoSaltiverso(req, unidade)) return res.json(vendas);
  // ...e mesmo as PRÓPRIAS vendas escondem o VALOR depois de 2h (pedido do
  // usuário): a janela recente existe pra conferir/apontar erro de digitação
  // na hora; depois dela o card continua lá (hora, itens, forma) mas sem
  // número, senão bastava rolar a lista no fim do dia e somar. Poda em
  // memória sobre a resposta já montada - custo zero de Firestore.
  const corte = Date.now() - 2 * 60 * 60 * 1000;
  res.json(vendas
    .filter((v) => v.criadoPorId === req.user.id)
    .map((v) => (new Date(v.criadoEm).getTime() >= corte ? v : {
      ...v, total: null, valorOculto: true,
      itens: (v.itens || []).map(({ nome, quantidade }) => ({ nome, quantidade })),
      pagamentos: (v.pagamentos || []).map(({ forma }) => ({ forma })),
    })));
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

// versao reduzida do estado do dia pro operador comum: NUNCA inclui faturado
// (nem o dele, nem o geral) nem a lista dos outros caixas - so o status do
// PROPRIO caixa (declarado que ele mesmo digitou + resultado categorico
// ok/sobrando/faltando) e se o dia ja fechou (sem valores).
function estadoDoDiaParaOperador(estado, operadorId) {
  const podar = (c) => (c ? {
    id: c.id, origem: c.origem || 'balcao', declarado: c.declarado, somaDeclarado: c.somaDeclarado,
    resultado: c.resultado, observacao: c.observacao, lancadoEm: c.lancadoEm,
  } : null);
  const meus = (estado.caixas || []).filter((c) => c.operadorId === operadorId);
  const doOrigem = (origem) => podar(meus.find((c) => (c.origem || 'balcao') === origem) || null);
  const caixaFesta = doOrigem('festa');
  return {
    unidade: estado.unidade, data: estado.data,
    meuCaixa: doOrigem('balcao'),
    meuCaixaFesta: caixaFesta,
    // saber que EXISTE dinheiro de festa dele hoje nao entrega valor nenhum
    // (foi ele mesmo que vendeu) e e o que faz a caixinha de festa aparecer
    // na tela pra ele declarar
    temFesta: caixaFesta !== null || (estado.pendentes || []).some((p) => p.operadorId === operadorId && p.origem === 'festa'),
    diaFechado: !!estado.fechamento,
  };
}

// estado do dia: faturado ao vivo + caixas fechados + operadores pendentes +
// doc do dia (se ja fechou). So Gerente/Master ve isso completo - o operador
// comum recebe uma versao reduzida (ver estadoDoDiaParaOperador acima).
app.get('/api/saltiverso/fechamento', requireSection('parque-loja'), async (req, res) => {
  try {
    const { unidade, data } = req.query;
    if (!podeUnidadeInventario(req, unidade)) return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    const estado = await saltiversoFechamento.estadoDoDia(unidade, data);
    res.json(podeVerFaturadoSaltiverso(req, unidade) ? estado : estadoDoDiaParaOperador(estado, req.user.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// o operador logado fecha O SEU caixa (declara o que contou, as cegas - nunca
// viu o faturado antes de digitar). A resposta tambem e podada pra quem nao
// e Gerente/Master: nada de faturadoOperador/diferencaOperador, so o
// resultado categorico (o mesmo motivo do estadoDoDiaParaOperador acima).
app.post('/api/saltiverso/fechamento/caixa', requireSection('parque-loja'), async (req, res) => {
  try {
    const { unidade, unidadeNome, data, declarado, observacao, origem } = req.body;
    if (!podeUnidadeInventario(req, unidade)) return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    const caixa = await saltiversoFechamento.lancarCaixa({
      unidade, unidadeNome, data, declarado, observacao, origem,
      operadorId: req.user.id, operadorEmail: req.user.email, operadorNome: req.user.username || req.user.email,
    });
    broadcast('saltiverso-caixa-lancado', caixa, 'parque-loja');
    if (podeVerFaturadoSaltiverso(req, unidade)) return res.json(caixa);
    res.json({ id: caixa.id, origem: caixa.origem, declarado: caixa.declarado, somaDeclarado: caixa.somaDeclarado, resultado: caixa.resultado, observacao: caixa.observacao, lancadoEm: caixa.lancadoEm });
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
    if (!podeVerFaturadoSaltiverso(req, unidade)) return res.status(403).json({ error: 'Apenas gerente ou master pode fechar o dia.' });
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
  if (req.isMaster || req.isAdmin) return res.json(auth.filtrarPorEmpresa(req, todas));
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
// ---------- acompanhamento das COMPRAS pelo gerente da loja (ver
// comprasAcompanhamento.js e /compras.html) ----------
// Visibilidade DIFERENTE da Central: la o criterio e "o que eu criei ou me
// atribuiram" (todosCardsCentral), e por isso um gerente nao enxergava o
// pedido que o assistente dele lancou - nem o que entrou pelo formulario
// publico da loja. Aqui o criterio e a UNIDADE, igual ao resto do app
// (Fechamento, Entregas, Estoque): quem tem a tag Gerente/Ass. Gerente
// acompanha TODAS as compras das unidades que ja pode ver.
// Quem nao e gerente cai na regra antiga (so o que criou), pra isso nao
// virar uma porta lateral que mostra o pedido da loja pra qualquer acesso
// que tenha a secao.
function comprasVisiveisPara(req, lista) {
  if (req.isMaster) return lista;
  const unidades = req.permissions?.unidades || [];
  if (users.ehCargoGerente(req.user.cargo) && unidades.length) {
    return lista.filter((c) => unidades.includes(c.unidade));
  }
  return lista.filter((c) => c.criadoPorId === req.user.id);
}

app.get('/api/compras/acompanhamento', requireSection('solicitacoes'), async (req, res) => {
  try {
    // a restricao por tipo de solicitacao (users.js: tiposSolicitacao) vale
    // aqui igual vale na Central - se o acesso nao pode ver "compra", essa
    // tela nao pode ser o atalho que mostra
    const tiposPerm = tiposSolicitacaoPermitidos(req);
    if (tiposPerm && !tiposPerm.has('compra')) {
      return res.status(403).json({ error: 'Seu acesso não inclui solicitações de compra.' });
    }
    const todas = await solicitacoes.listAll();
    const visiveis = comprasVisiveisPara(req, todas);
    res.json({
      ...comprasAcompanhamento.montar(visiveis, {
        etapa: req.query.etapa || null,
        unidade: req.query.unidade || null,
      }),
      // a tela usa pra decidir se mostra o seletor de unidade
      unidades: [...new Set(visiveis.map((c) => c.unidade))].sort(),
      porUnidade: req.isMaster || users.ehCargoGerente(req.user.cargo),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// so que pra pedidos que nao tem uma secao propria ja existente. Aprovar um
// pedido de Suporte de TI ja cria o Chamado (ver chamadosTI.js) ----------
app.post('/api/solicitacoes', requireSection('solicitacoes'), upload.array('anexos', 4), async (req, res) => {
  try {
    const payload = req.is('multipart/form-data') ? JSON.parse(req.body.payload || '{}') : req.body;
    const { tipo, unidade, unidadeNome, titulo, valorEstimado, observacao, itens, ehOrcamento, fornecedor, vencimento, direcionadoParaId, direcionadoParaEmail, prioridade, nomePessoa, motivoAcesso, dataEfetiva, dataRetornoPrevista } = payload;
    if (!req.isMaster && unidade && !(req.permissions.unidades || []).includes(unidade)) {
      return res.status(403).json({ error: 'Você não tem acesso a essa unidade.' });
    }
    const tiposPerm = tiposSolicitacaoPermitidos(req);
    if (tiposPerm && !tiposPerm.has(tipo)) {
      return res.status(403).json({ error: 'Você não tem acesso a esse tipo de solicitação.' });
    }
    // restrição da UNIDADE (diferente da do usuário acima): unidade
    // administrativa tipo a MVPar só aceita os tipos que ela de fato usa.
    // Vale até pro Master - se a empresa não tem operação, ninguém deveria
    // conseguir abrir chamado de manutenção nela, nem por engano.
    if (unidade && !(await unidadesExtras.aceitaTipo(unidade, tipo))) {
      const perfilUnidade = await unidadesExtras.perfil(unidade);
      return res.status(400).json({
        error: `${unidadeNome || unidade} só aceita solicitação de: ${(perfilUnidade.tiposSolicitacao || []).join(', ')}.`,
      });
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
      nomePessoa, motivoAcesso, dataEfetiva, dataRetornoPrevista,
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

// checklist de bloqueio/liberacao de acesso (tipo 'acesso-pessoa') - ver
// acessosPessoa.js e solicitacoes.atualizarAcessoChecklist/marcarAcessoConcluido.
// So aparece depois de Aprovado, mesmo espirito do "Comprada" acima: uma
// acao manual, no ritmo do Master, dentro do mesmo painel de detalhe.
app.get('/api/solicitacoes/:id/acesso-candidatos', auth.requireMasterOrAdmin, async (req, res) => {
  try {
    const registro = await solicitacoes.getOne(req.params.id);
    if (!registro) return res.status(404).json({ error: 'Solicitação não encontrada.' });
    if (registro.tipo !== 'acesso-pessoa') return res.status(400).json({ error: 'Esse ticket não é de bloqueio de acesso.' });
    const candidatos = await acessosPessoa.buscarCandidatos({ nomePessoa: registro.nomePessoa, unidade: registro.unidade });
    res.json(candidatos);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// executa de verdade - so Master (mais estrito que o resto da Central,
// porque aqui derruba login/desliga cadastro pra valer, nao so decide um
// ticket). :sistema em users|rh|abastecimento. acao 'confirmar' precisa de
// alvoId (o candidato que o Master escolheu); 'nao-encontrado' so anota que
// aquele sistema nao tem nada pra essa pessoa
app.patch('/api/solicitacoes/:id/acesso/:sistema', auth.requireMaster, async (req, res) => {
  try {
    const { sistema } = req.params;
    const { acao, alvoId } = req.body;
    const registro = await solicitacoes.getOne(req.params.id);
    if (!registro) return res.status(404).json({ error: 'Solicitação não encontrada.' });
    if (registro.tipo !== 'acesso-pessoa') return res.status(400).json({ error: 'Esse ticket não é de bloqueio de acesso.' });
    if (registro.status !== 'APROVADO') return res.status(400).json({ error: 'Só tickets já Aprovados têm checklist de acesso.' });
    if (acao === 'confirmar') {
      if (!alvoId) return res.status(400).json({ error: 'Informe o candidato confirmado.' });
      const porEmail = req.user.email;
      const { motivoAcesso, dataEfetiva, dataRetornoPrevista } = registro;
      if (sistema === 'users') {
        await acessosPessoa.bloquearLogin(alvoId, porEmail);
      } else if (sistema === 'rh') {
        if (motivoAcesso === 'ferias') await acessosPessoa.marcarFeriasRh(alvoId, { dataEfetiva, dataRetornoPrevista, porEmail });
        else await acessosPessoa.desligarFuncionarioRh(alvoId, { dataEfetiva, motivoAcesso, porEmail });
      } else if (sistema === 'abastecimento') {
        if (motivoAcesso === 'ferias') await acessosPessoa.suspenderOperadorAbastecimento(alvoId, porEmail);
        else await acessosPessoa.removerOperadorAbastecimento(alvoId, porEmail);
      } else {
        return res.status(400).json({ error: 'Sistema inválido.' });
      }
    } else if (acao !== 'nao-encontrado') {
      return res.status(400).json({ error: 'Ação inválida.' });
    }
    const atualizado = await solicitacoes.atualizarAcessoChecklist(req.params.id, sistema, {
      status: acao === 'confirmar' ? 'confirmado' : 'nao-encontrado',
      alvoId: acao === 'confirmar' ? alvoId : null,
      executadoPorEmail: req.user.email,
    });
    broadcast('solicitacao-decidida', atualizado, 'solicitacoes');
    res.json(atualizado);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/solicitacoes/:id/acesso-concluido', auth.requireMasterOrAdmin, async (req, res) => {
  try {
    const atualizado = await solicitacoes.marcarAcessoConcluido(req.params.id, req.user.email);
    broadcast('solicitacao-decidida', atualizado, 'solicitacoes');
    res.json(atualizado);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// so pra ferias: restaura os sistemas que foram confirmados (login/RH/
// operador) quando a pessoa volta. Tolera falha parcial linha a linha -
// mesmo espirito de updateUsernamesEmMassa - pra um erro num sistema nao
// travar a reativacao dos outros dois
app.post('/api/solicitacoes/:id/acesso-reativar-tudo', auth.requireMaster, async (req, res) => {
  try {
    const registro = await solicitacoes.getOne(req.params.id);
    if (!registro) return res.status(404).json({ error: 'Solicitação não encontrada.' });
    if (registro.tipo !== 'acesso-pessoa') return res.status(400).json({ error: 'Esse ticket não é de bloqueio de acesso.' });
    if (registro.motivoAcesso !== 'ferias') return res.status(400).json({ error: 'Reativar só vale pra ticket de férias.' });
    const porEmail = req.user.email;
    const checklist = registro.acessoChecklist || {};
    const resultados = [];
    for (const sistema of ['users', 'rh', 'abastecimento']) {
      const linha = checklist[sistema];
      if (!linha || linha.status !== 'confirmado') continue;
      try {
        if (sistema === 'users') await acessosPessoa.reativarLogin(linha.alvoId, porEmail);
        else if (sistema === 'rh') await acessosPessoa.encerrarFeriasRh(linha.alvoId, porEmail);
        else await acessosPessoa.reativarOperadorAbastecimento(linha.alvoId, porEmail);
        resultados.push({ sistema, ok: true });
      } catch (err) {
        resultados.push({ sistema, ok: false, error: err.message });
      }
    }
    res.json({ resultados });
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
          // avisa a pessoa na hora - mesma frase do pop-up de quem aprovou
          avisarLoginDesbloqueado(atual.criadoPorId, { porId: req.user.id, porEmail: req.user.email, pedirTrocaSenha: !!req.body.pedirTrocaSenha });
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
// envio/REENVIO sob demanda do relatorio (o mesmo e-mail do agendamento,
// recalculado agora). "para" opcional manda pra outro endereco sem mexer na
// config - serve pro Master conferir na propria caixa antes de mandar pro
// destinatario real. Mantem o caminho antigo (/testar) porque o botao da
// tela ja apontava pra ele.
async function reenviarRelatorioMV(req, res) {
  try {
    const para = String(req.body?.para || req.query.para || '').trim();
    res.json(await relatorioMV.enviarRelatorio({
      origem: 'manual', porEmail: req.user.email, paraOverride: para || null,
    }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}
app.get('/api/relatorio-mv/testar', auth.requireMaster, reenviarRelatorioMV);
app.post('/api/relatorio-mv/reenviar', auth.requireMaster, reenviarRelatorioMV);

// historico dos ultimos envios (agendados e manuais, com sucesso e com erro)
// - e o que responde "ja saiu hoje? pra quem? com quantos?" antes de reenviar
app.get('/api/relatorio-mv/envios', auth.requireMaster, async (req, res) => {
  try {
    res.json(await relatorioMV.listarEnvios(req.query.limite));
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
// quais campos do cadastro de Extra/Candidato saem da digitação em vez da
// leitura do documento (ver rhCamposConfig.js). Mesmo desenho do "digitado
// na mão" dos Canais/Formas: quem marca é o Master, a loja só encontra o
// campo já liberado. Passa por desviarSeQaMaster como o resto do admin.
app.put('/api/rh/campos-config', auth.requireMaster, async (req, res) => {
  try {
    if (await desviarSeQaMaster(req, res, 'rh.camposConfig', 'Alterar campos digitados na mão do cadastro RH', req.body)) return;
    res.json(await rhCamposConfig.salvar(req.body.camposManuais, { porEmail: req.user.email }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/relatorio-config', auth.requireMaster, async (req, res) => {
  res.json(await relatorioMV.getConfig());
});

// "por que o relatorio veio zerado?" - o filtro do relatorio depende de duas
// pontas casarem (usuario gatilho existir E os tickets estarem direcionados a
// ele), e as duas falhando davam a mesma tela de zeros (ver diagnostico em
// relatorioMV.js). Rota propria porque o Master pode querer conferir sem
// gerar a previa inteira.
app.get('/api/relatorio-mv/diagnostico', auth.requireMaster, async (req, res) => {
  try {
    res.json(await relatorioMV.diagnostico());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
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

// ---------------------------------------------------------------------
// Relatório dos KPI's operacionais (CSV e PDF).
//
// A matriz vem PRONTA da tela, e isso é decisão, não preguiça: o valor de
// cada célula depende de escolhas que moram lá (média x soma por KPI, o
// override manual do seletor de agregação, o período). Recalcular aqui
// criaria uma segunda fonte de verdade, e o relatório passaria a poder
// discordar da tela que a pessoa está olhando - que é exatamente o que um
// comparativo não pode fazer.
//
// O servidor não aceita qualquer coisa: valida o formato, corta tamanho, e
// os títulos/cabeçalho são fixos aqui. O que chega de fora é dado, não
// layout.
function sanitizarMatrizKpi(body) {
  const texto = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
  const lojas = (Array.isArray(body.lojas) ? body.lojas : []).slice(0, 30).map((u) => texto(u, 60)).filter(Boolean);
  const linhas = (Array.isArray(body.linhas) ? body.linhas : []).slice(0, 200).map((l) => ({
    kpi: texto(l && l.kpi, 80),
    agregacao: texto(l && l.agregacao, 10),
    valores: (Array.isArray(l && l.valores) ? l.valores : []).slice(0, 30).map((v) => texto(v, 20)),
  })).filter((l) => l.kpi);
  const ofensores = (Array.isArray(body.ofensores) ? body.ofensores : []).slice(0, 3).map((o) => ({
    kpi: texto(o && o.kpi, 40), loja: texto(o && o.loja, 40), texto: texto(o && o.texto, 24),
  })).filter((o) => o.kpi);
  return {
    grupo: texto(body.grupo, 60) || 'Grupo',
    inicio: texto(body.inicio, 10), fim: texto(body.fim, 10),
    lancamentos: Number(body.lancamentos) || 0,
    lojas, linhas, ofensores,
  };
}

app.post('/api/kpis-operacionais/relatorio', requireSection('fechamentos'), async (req, res) => {
  try {
    const d = sanitizarMatrizKpi(req.body || {});
    if (!d.linhas.length) return res.status(400).json({ error: 'Nada pra exportar nesse período.' });
    const colunas = [
      { key: 'kpi', label: 'KPI' },
      { key: 'agregacao', label: 'Agreg.' },
      ...d.lojas.map((u, i) => ({ key: 'l' + i, label: u })),
    ];
    const linhas = d.linhas.map((l) => {
      const linha = { kpi: l.kpi, agregacao: l.agregacao };
      d.lojas.forEach((_, i) => { linha['l' + i] = l.valores[i] == null || l.valores[i] === '' ? '—' : l.valores[i]; });
      return linha;
    });
    const periodo = `${reportUtil.fmtDataBR(d.inicio)} a ${reportUtil.fmtDataBR(d.fim)}`;
    const subtitulo = `${d.grupo} · ${periodo} · ${d.lancamentos} lançamento(s) · ${d.linhas.length} KPI's · ${d.lojas.length} loja(s)`;
    const nomeArquivo = reportUtil.nomeArquivoComData(`kpis-${reportUtil.slugify(d.grupo, 'grupo')}`);

    if (req.query.formato === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}.csv"`);
      return res.send(reportUtil.toCSV(colunas, linhas));
    }
    // no PDF os ofensores viram o bloco de destaque no topo: é a primeira
    // coisa que alguém quer saber ao abrir o arquivo, antes da matriz
    const resumo = d.ofensores.map((o) => [o.texto, `${o.kpi} · ${o.loja}`]);
    return reportUtil.writePDF(res, {
      titulo: "KPI's operacionais", subtitulo, colunas, linhas,
      resumo: resumo.length ? resumo : null,
      semDadosMsg: 'Nenhum KPI preenchido nesse período.',
      nomeArquivo,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// painel de personalização da tela de login (ver /login-custom.html) -
// Master edita o texto do balão do robô e o fundo; a leitura pública (tela
// de login em si) está lá em cima, perto de /api/meta/unidades-publico
app.put('/api/login-custom', auth.requireMaster, async (req, res) => {
  try {
    const config = await loginCustom.salvar({
      ativo: req.body.ativo,
      bubbleTitulo: req.body.bubbleTitulo,
      bubbleTexto: req.body.bubbleTexto,
      atualizadoPorEmail: req.user.email,
    });
    res.json(config);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.post('/api/login-custom/fundo', auth.requireMaster, uploadLoginFundo.single('fundo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Anexe uma imagem.' });
    const atual = await loginCustom.obter();
    const caminho = await storage.salvarArquivo('login-custom', req.file, 'login-custom');
    const config = await loginCustom.salvarFundo(caminho, req.user.email);
    // apaga o fundo antigo DEPOIS de garantir que o novo já foi salvo - se o
    // upload novo falhasse antes, o antigo continuaria valendo em vez de
    // sumir e deixar a tela sem nada
    if (atual.fundoArquivo && atual.fundoArquivo !== caminho) await storage.apagarArquivo(atual.fundoArquivo);
    res.json(config);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.delete('/api/login-custom/fundo', auth.requireMaster, async (req, res) => {
  try {
    const atual = await loginCustom.obter();
    if (atual.fundoArquivo) await storage.apagarArquivo(atual.fundoArquivo);
    const config = await loginCustom.removerFundo(req.user.email);
    res.json(config);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// logos das empresas do grupo no rodapé do login. Antes era imagem fixa no
// código: empresa entrava ou saía do grupo e só dava pra refletir isso com
// deploy. Agora o Master sobe e remove pela tela.
app.get('/api/login-custom/logos', auth.requireMaster, async (req, res) => {
  const config = await loginCustom.obter();
  res.json((config.logos || []).map((l) => ({ id: l.id, nome: l.nome, em: l.em || null })));
});
app.post('/api/login-custom/logos', auth.requireMaster, uploadLoginFundo.single('logo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Anexe a imagem da logo.' });
    if (!/^image\//.test(req.file.mimetype || '')) return res.status(400).json({ error: 'A logo precisa ser uma imagem (PNG de preferência, com fundo transparente).' });
    const caminho = await storage.salvarArquivo('login-custom', req.file, 'login-custom');
    try {
      const config = await loginCustom.adicionarLogo({ nome: req.body.nome, caminho, atualizadoPorEmail: req.user.email });
      res.json(loginCustom.semDetalheInterno(config));
    } catch (err) {
      // cadastro recusou (limite cheio, por exemplo): não deixa o arquivo
      // órfão no Storage ocupando espaço sem ninguém apontando pra ele
      await storage.apagarArquivo(caminho).catch(() => {});
      throw err;
    }
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.delete('/api/login-custom/logos/:id', auth.requireMaster, async (req, res) => {
  try {
    const { config, arquivoRemovido } = await loginCustom.removerLogo(req.params.id, req.user.email);
    if (arquivoRemovido) await storage.apagarArquivo(arquivoRemovido).catch(() => {});
    res.json(loginCustom.semDetalheInterno(config));
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

// Relatório de chamados (central-historico.html): filtro dedicado por cima
// de filtrarCardsCentral, com Ticket #, Status e duas janelas de data que
// dataDe/dataAte (abertura) nao cobre - fechamento (decididoEm) e
// interacao (mensagens do chat, via centralChat). A janela de interacao
// precisa cruzar com centralChat.listAllCached() porque a data/autor de
// quem conversou nao mora no card - so nas mensagens vinculadas a ele.
async function cardsFiltradosRelatorio(req) {
  let cards = filtrarCardsCentral(await todosCardsCentral(req), req);
  const { ticket, status, fechamentoDe, fechamentoAte, interacaoDe, interacaoAte, interacaoUsuario } = req.query;
  if (ticket) {
    const alvo = String(ticket).trim();
    cards = cards.filter((c) => String(c.numeroTicket != null ? c.numeroTicket : '').includes(alvo));
  }
  if (status) cards = cards.filter((c) => c.status === status);
  if (fechamentoDe || fechamentoAte) {
    cards = cards.filter((c) => {
      const d = (c.decididoEm || '').slice(0, 10);
      if (!d) return false;
      return (!fechamentoDe || d >= fechamentoDe) && (!fechamentoAte || d <= fechamentoAte);
    });
  }
  if (interacaoDe || interacaoAte || interacaoUsuario) {
    const mensagens = await centralChat.listAllCached();
    const alvoUsuario = interacaoUsuario ? String(interacaoUsuario).trim().toLowerCase() : '';
    const chavesOk = new Set();
    for (const m of mensagens) {
      const d = (m.criadoEm || '').slice(0, 10);
      if (interacaoDe && d < interacaoDe) continue;
      if (interacaoAte && d > interacaoAte) continue;
      if (alvoUsuario) {
        const bate = (m.autorEmail || '').toLowerCase().includes(alvoUsuario) || (m.autorUsername || '').toLowerCase().includes(alvoUsuario);
        if (!bate) continue;
      }
      chavesOk.add(`${m.tipo}:${m.cardId}`);
    }
    cards = cards.filter((c) => chavesOk.has(`${c.tipo}:${c.id}`));
  }
  return cards;
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

app.get('/api/central/relatorio.:formato(csv|pdf|json)', requireSection('solicitacoes'), async (req, res) => {
  const cards = await cardsFiltradosRelatorio(req);
  if (req.params.formato === 'json') return res.json(cards);
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
// consolidado em auth.js (era reimplementado aqui, no objeto de
// usuarioLogadoDoHeader e de novo em loja-status.html - unica fonte agora)
const ehTimeSuporte = auth.ehTimeSuporte;

app.get('/api/chamados', requireAnySection('tecnico', 'suporte'), async (req, res) => {
  const todos = auth.filtrarPorEmpresa(req, await chamadosTI.listAll());
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
// A contagem recem-lancada fecha o turno cujo fim e exatamente ela (ver
// montarCiclos em abastecimentoPrevisao.js). Saida apurada NEGATIVA = sobrou
// mais do que entrou: contagem errada ou envio que nao foi lancado. E o ⚠
// vermelho do "Dia a dia" em Relatorios do Carrinho - so que empurrado pro
// celular do Master/Admin na hora, com registro na Central de Alertas.
async function verificarDivergenciaAbastecimento(contagem) {
  const regs = await abastecimentoCarrinho.listAll();
  const ciclos = abastecimentoPrevisao.montarCiclos(regs);
  const ciclo = ciclos.filter((c) => c.ate === contagem.criadoEm).pop();
  if (!ciclo) return; // primeira contagem de todas - ainda nao fecha turno
  const negativos = ciclo.itens.filter((i) => i.saida < 0);
  if (!negativos.length) return;
  const resumo = negativos.slice(0, 5)
    .map((i) => `${i.nome} (${i.saida}${i.tipo === 'pizza' ? '' : ' un'})`).join(' · ')
    + (negativos.length > 5 ? ` e mais ${negativos.length - 5} item(ns)` : '');
  await push.notifyAbastecimentoDivergencia(ciclo.rotulo, resumo, ciclo.ate);
}

// "-14 un" lido solto (sem contexto do sinal) confunde quem le - a
// coluna se chama "Saiu" e o numero vem negativo, e "saiu -14" nao faz
// sentido fisico (nao da pra sair uma quantidade negativa). O que aconteceu
// de verdade e o oposto: SOBROU 14 a mais do que devia, por isso escreve
// assim - o texto explicativo continua igual na coluna Alerta ao lado
function fmtSaidaTxt(saida, un) {
  if (saida == null) return 'sem fechamento';
  if (saida < 0) return `⚠ ${Math.abs(saida)}${un} a mais`;
  return `${saida}${un}`;
}

// mesmo calculo do fluxo, so recortado pra UM turno (identificado pelo "ate"
// - o criadoEm da contagem que fechou aquele ciclo, unico por turno). Serve
// de base tanto pra tela de explicacao quanto pro PDF de apresentacao logo
// abaixo - o link que a notificacao de divergencia manda aponta pra ca.
async function buscarTurno(ate) {
  const regs = await abastecimentoCarrinho.listAll();
  const ciclos = abastecimentoPrevisao.montarCiclos(regs);
  return ciclos.find((c) => c.ate === ate) || null;
}

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
    // uma CONTAGEM fecha um turno (par de contagens consecutivas): se a
    // saida apurada ficou negativa em algum item, avisa o Master na hora em
    // vez de esperar alguem abrir o relatorio. Fire-and-forget de proposito:
    // o lancamento da contagem nunca pode falhar por causa do aviso
    if (registro.tipo === 'CONTAGEM') {
      verificarDivergenciaAbastecimento(registro)
        .catch((err) => console.error('Erro ao checar divergência do carrinho:', err.message));
    }
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

// ---------- comparativo Abastecimento x Fechamento (so Master): quanto de
// cada sabor de pizza foi ENVIADO pro carrinho ontem (abastecimentoCarrinho)
// x quanto ficou registrado nos KPIs Extras do Fechamento (grupos.js) da
// mesma unidade+dia - pedido explicito do usuario, pra flagar diferenca sem
// precisar cruzar as duas telas na mao. Casa o KPI pelo nome (campo/label
// normalizado) porque kpisExtras e livre - o Master cadastra o rotulo em
// grupos.html, o "campo" (slug) so sai daqui ----------
app.get('/api/abastecimento/comparativo-fechamento', auth.requireMaster, async (req, res) => {
  try {
    const unidade = "Domino's Carrinho Aeroporto Recife";
    // aceita ?data=YYYY-MM-DD pra consultar outro dia (padrao: ontem, o caso
    // de uso original) - pedido explicito do usuario de poder ver dias
    // passados, nao so o ultimo
    const dataPedida = req.query.data;
    if (dataPedida && !/^\d{4}-\d{2}-\d{2}$/.test(dataPedida)) return res.status(400).json({ error: 'Data inválida.' });
    const data = dataPedida || ontemBrasiliaISO();
    const regs = await abastecimentoCarrinho.listAll();
    const enviado = {};
    abastecimentoCarrinho.SABORES.forEach((s) => { enviado[s] = 0; });
    regs.forEach((r) => {
      if (r.tipo !== 'ENVIO') return;
      const dia = new Date(r.criadoEm).toLocaleDateString('sv-SE', { timeZone: FUSO_BR });
      if (dia !== data) return;
      abastecimentoCarrinho.SABORES.forEach((s) => { enviado[s] += Number(r.pizzas && r.pizzas[s]) || 0; });
    });

    const fechamentos = await fechamentosLive.listByUnidades([unidade]);
    const fechamento = fechamentos.find((f) => f.data === data) || null;
    const grupo = await grupos.grupoDaUnidade(unidade);
    const kpisDef = (grupo && grupo.kpisExtras) || [];
    const normalizar = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    // distancia de edicao (Levenshtein) - o Master digita o rotulo do KPI na
    // mao em grupos.html, entao um typo (ex: "Calabress" sem o "a" final)
    // nao pode fazer o comparativo simplesmente nao achar o campo
    function levenshtein(a, b) {
      const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
      for (let j = 0; j <= b.length; j += 1) dp[0][j] = j;
      for (let i = 1; i <= a.length; i += 1) {
        for (let j = 1; j <= b.length; j += 1) {
          dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
        }
      }
      return dp[a.length][b.length];
    }
    // bate se o sabor aparece como substring (rotulo mais descritivo, ex:
    // "Pizza Calabresa Grande") OU se alguma palavra do rotulo/campo esta a
    // no maximo 2 edicoes do nome do sabor (tolera erro de digitacao)
    function bateComSabor(texto, sabor) {
      const norm = normalizar(texto);
      if (norm.includes(sabor)) return true;
      return norm.split(/[^a-z0-9]+/).some((palavra) => palavra.length >= 4 && levenshtein(palavra, sabor) <= 2);
    }

    const comparativo = abastecimentoCarrinho.SABORES.map((sabor) => {
      const def = kpisDef.find((k) => bateComSabor(k.campo, sabor) || bateComSabor(k.label, sabor));
      const registrado = (fechamento && def) ? (Number(fechamento.kpisExtras && fechamento.kpisExtras[def.campo]) || 0) : null;
      return {
        sabor,
        enviado: enviado[sabor],
        registrado,
        diferenca: registrado != null ? registrado - enviado[sabor] : null,
        kpiEncontrado: !!def,
      };
    });

    res.json({ unidade, data, temFechamento: !!fechamento, comparativo });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- fluxo de entrada e saida do carrinho (so Master) ----------
// Reconciliacao de estoque no mesmo espirito do calcularDiferencas do
// inventario.js, adaptada pro que o Abastecimento realmente registra:
//
//   saida apurada = saldo inicial + entradas - saldo final
//
// - saldo inicial/final saem das CONTAGENS (primeira e ultima do periodo) -
//   por isso a conta so fecha com PELO MENOS DUAS contagens; com menos que
//   isso a rota devolve reconciliavel:false e so os totais brutos, em vez de
//   inventar um numero que nao se sustenta.
// - a janela de reconciliacao e o intervalo ENTRE essas duas contagens (nao
//   o periodo inteiro): envio que entrou antes da primeira contagem ja esta
//   dentro do saldo inicial, contar de novo estouraria a conta.
// - entradas usam o que foi REALMENTE RECEBIDO quando o carrinho conferiu
//   (recebimento.recebido), e o enviado quando ainda nao conferiu - a
//   diferenca entre os dois aparece separada como "perda em transito".
// - AVARIAS entram como coluna informativa, NAO subtraem da saida apurada:
//   a avaria e declarada na contagem e nao da pra saber daqui se o item
//   danificado foi contado junto ou ja descartado - subtrair arriscaria
//   contar a mesma perda duas vezes.
//
// Tudo em UNIDADES (insumo lancado em caixa vira quantidade x qtdPorCaixa),
// senao bebida em caixa e bebida em unidade nao somam na mesma escala.
app.get('/api/abastecimento/fluxo', auth.requireMaster, async (req, res) => {
  try {
    const hoje = hojeBrasiliaISO();
    const fim = req.query.fim || hoje;
    const inicio = req.query.inicio || (() => {
      const d = new Date(`${fim}T00:00:00`);
      d.setDate(d.getDate() - 6);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    })();
    const dataOk = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
    if (!dataOk(inicio) || !dataOk(fim)) return res.status(400).json({ error: 'Data inválida.' });
    if (inicio > fim) return res.status(400).json({ error: 'O início não pode ser depois do fim.' });

    const SABORES = abastecimentoCarrinho.SABORES;
    const diaDe = (iso) => new Date(iso).toLocaleDateString('sv-SE', { timeZone: FUSO_BR });
    const inteiro = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
    // insumo pode ser lancado em caixa - normaliza tudo pra unidade
    const emUnidades = (ins, qtd) => (ins.embalagem === 'caixa' && ins.qtdPorCaixa ? inteiro(qtd) * ins.qtdPorCaixa : inteiro(qtd));

    const regs = await abastecimentoCarrinho.listAll();
    const noPeriodo = regs.filter((r) => { const d = diaDe(r.criadoEm); return d >= inicio && d <= fim; });
    const contagens = noPeriodo.filter((r) => r.tipo === 'CONTAGEM').sort((a, b) => String(a.criadoEm).localeCompare(String(b.criadoEm)));
    const envios = noPeriodo.filter((r) => r.tipo === 'ENVIO');

    const primeira = contagens[0] || null;
    const ultima = contagens.length > 1 ? contagens[contagens.length - 1] : null;
    const reconciliavel = !!(primeira && ultima);

    const itens = new Map();
    function slot(chave, nome, tipo) {
      if (!itens.has(chave)) itens.set(chave, { chave, nome, tipo, saldoInicial: 0, saldoFinal: 0, entradas: 0, enviado: 0, recebido: 0, avarias: 0 });
      return itens.get(chave);
    }
    const rotuloSabor = (s) => s.charAt(0).toUpperCase() + s.slice(1);

    function somarContagem(c, campo) {
      SABORES.forEach((s) => { slot(`pizza:${s}`, rotuloSabor(s), 'pizza')[campo] += inteiro((c.pizzas || {})[s]); });
      (c.insumos || []).forEach((ins) => {
        if (!ins.insumoId) return; // texto livre legado nao entra na conta
        slot(`insumo:${ins.insumoId}`, ins.nome, 'insumo')[campo] += inteiro(ins.totalUnidades) || emUnidades(ins, ins.quantidade);
      });
    }
    if (primeira) somarContagem(primeira, 'saldoInicial');
    if (ultima) somarContagem(ultima, 'saldoFinal');

    // avarias declaradas em qualquer contagem do periodo (+ detalhe pro Master
    // conseguir ir na origem: dia, quantidade e o que a loja escreveu)
    const avariasDetalhe = [];
    contagens.forEach((c) => {
      (c.avarias || []).forEach((a) => {
        if (!a.insumoId) return;
        slot(`insumo:${a.insumoId}`, a.nome, 'insumo').avarias += inteiro(a.quantidade);
        avariasDetalhe.push({ data: diaDe(c.criadoEm), nome: a.nome, quantidade: inteiro(a.quantidade), observacao: a.observacao || '', temFoto: !!a.foto });
      });
    });

    // enviado x recebido no periodo inteiro (metrica operacional) e entradas
    // so dentro da janela entre as duas contagens (metrica de reconciliacao)
    let perdaTransitoTotal = 0;
    envios.forEach((e) => {
      const naJanela = reconciliavel && e.criadoEm > primeira.criadoEm && e.criadoEm <= ultima.criadoEm;
      const rec = e.recebimento && e.recebimento.recebido ? e.recebimento.recebido : null;
      SABORES.forEach((s) => {
        const env = inteiro((e.pizzas || {})[s]);
        if (!env) return;
        const receb = rec && rec.pizzas && rec.pizzas[s] != null ? inteiro(rec.pizzas[s]) : env;
        const alvo = slot(`pizza:${s}`, rotuloSabor(s), 'pizza');
        alvo.enviado += env;
        alvo.recebido += receb;
        perdaTransitoTotal += env - receb;
        if (naJanela) alvo.entradas += e.recebidoEm ? receb : env;
      });
      (e.insumos || []).forEach((ins, idx) => {
        if (!ins.insumoId) return;
        const env = inteiro(ins.totalUnidades) || emUnidades(ins, ins.quantidade);
        // quantidadeRecebida vem na MESMA embalagem do lancamento (caixa ou
        // unidade), entao converte de novo antes de comparar com o enviado
        const recIns = rec && Array.isArray(rec.insumos) ? rec.insumos[idx] : null;
        const receb = recIns && recIns.quantidadeRecebida != null ? emUnidades(ins, recIns.quantidadeRecebida) : env;
        const alvo = slot(`insumo:${ins.insumoId}`, ins.nome, 'insumo');
        alvo.enviado += env;
        alvo.recebido += receb;
        perdaTransitoTotal += env - receb;
        if (naJanela) alvo.entradas += e.recebidoEm ? receb : env;
      });
    });

    const lista = [...itens.values()].map((i) => ({
      ...i,
      perdaTransito: i.enviado - i.recebido,
      saidaApurada: reconciliavel ? i.saldoInicial + i.entradas - i.saldoFinal : null,
    })).filter((i) => i.tipo === 'pizza' || i.enviado || i.avarias || i.saldoInicial || i.saldoFinal)
      .sort((a, b) => (a.tipo === b.tipo ? a.nome.localeCompare(b.nome, 'pt-BR') : (a.tipo === 'pizza' ? -1 : 1)));

    const diasNoPeriodo = Math.round((new Date(`${fim}T00:00:00`) - new Date(`${inicio}T00:00:00`)) / 86400000) + 1;
    const diasComContagem = new Set(contagens.map((c) => diaDe(c.criadoEm))).size;

    // A conta acima fecha o PERIODO inteiro (primeira x ultima contagem).
    // Como a operacao conta 2x por dia (inicio do turno da manha e da
    // madrugada), cada par de contagens consecutivas ja e um ciclo fechado -
    // da pra abrir o mesmo periodo turno a turno e dia a dia sem estimar
    // nada. Ver abastecimentoPrevisao.js.
    const ciclos = abastecimentoPrevisao.montarCiclos(noPeriodo);
    const capacidades = abastecimentoPrevisao.estimarCapacidades(ciclos, (await abastecimentoCarrinho.getConfig()).capacidades);

    res.json({
      periodo: { inicio, fim, diasNoPeriodo },
      dias: abastecimentoPrevisao.resumoPorDia(noPeriodo, { inicio, fim, ciclos }),
      ciclos,
      capacidades: [...capacidades.values()],
      reconciliavel,
      // sem as duas contagens a conta nao fecha - a tela avisa em vez de
      // mostrar um "consumo" que na verdade e chute
      motivoNaoReconciliavel: reconciliavel ? null : (contagens.length ? 'Só tem uma contagem no período - são necessárias pelo menos duas pra fechar a conta.' : 'Nenhuma contagem lançada no período.'),
      janela: reconciliavel ? { de: primeira.criadoEm, ate: ultima.criadoEm } : null,
      itens: lista,
      avariasDetalhe: avariasDetalhe.sort((a, b) => b.data.localeCompare(a.data)).slice(0, 50),
      indicadores: {
        contagens: contagens.length,
        diasComContagem,
        diasNoPeriodo,
        envios: envios.length,
        enviosSemRecebimento: envios.filter((e) => !e.recebidoEm).length,
        recebimentosDivergentes: envios.filter((e) => e.recebimento && e.recebimento.confere === false).length,
        perdaTransitoTotal,
        avariasTotal: avariasDetalhe.reduce((s, a) => s + a.quantidade, 0),
      },
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PDF do "Dia a dia" dos Relatorios do Carrinho: mesmo calculo da tela
// (resumoPorDia/montarCiclos), item a item por dia, com a divergencia
// (saida negativa) marcada em texto na coluna Alerta. Mesmo gate da tela.
app.get('/api/abastecimento/fluxo/relatorio.pdf', auth.requireMaster, async (req, res) => {
  try {
    const hoje = hojeBrasiliaISO();
    const fim = req.query.fim || hoje;
    const inicio = req.query.inicio || (() => {
      const d = new Date(`${fim}T00:00:00`);
      d.setDate(d.getDate() - 6);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    })();
    const dataOk = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
    if (!dataOk(inicio) || !dataOk(fim) || inicio > fim) return res.status(400).json({ error: 'Período inválido.' });

    const diaDe = (iso) => new Date(iso).toLocaleDateString('sv-SE', { timeZone: FUSO_BR });
    const regs = await abastecimentoCarrinho.listAll();
    const noPeriodo = regs.filter((r) => { const d = diaDe(r.criadoEm); return d >= inicio && d <= fim; });
    const ciclos = abastecimentoPrevisao.montarCiclos(noPeriodo);
    const dias = abastecimentoPrevisao.resumoPorDia(noPeriodo, { inicio, fim, ciclos });
    // ?divergencias=1 - recorte "só o que deu problema": em vez de despejar
    // os ~27 itens de cada dia (a maioria sem nada de errado), fica só a
    // linha que realmente precisa de atenção - pedido do Master depois de
    // ver o PDF completo: "precisamos ter um relatório apenas das
    // divergências" pra não ter que garimpar
    const soDivergencias = req.query.divergencias === '1';

    let divergencias = 0;
    const linhas = [];
    dias.forEach((dia) => {
      const itensDoDia = soDivergencias ? dia.itens.filter((i) => i.saida != null && i.saida < 0) : dia.itens;
      itensDoDia.forEach((i, j) => {
        const un = i.tipo === 'pizza' ? '' : ' un';
        const divergente = i.saida != null && i.saida < 0;
        if (divergente) divergencias += 1;
        linhas.push({
          dia: j === 0 ? reportUtil.fmtDataBR(dia.dia) : '',
          meta: j === 0 ? `${dia.contagens} contagem(ns) · ${dia.envios} envio(s) · ${dia.ciclosFechados} turno(s)` : '',
          item: i.nome,
          entrou: `${i.entradas}${un}`,
          saiu: fmtSaidaTxt(i.saida, un),
          alerta: divergente ? 'DIVERGÊNCIA: sobrou mais do que entrou (contagem ou envio não lançado)' : '',
        });
      });
    });

    reportUtil.writePDF(res, {
      titulo: `Relatórios do Carrinho — ${soDivergencias ? 'Só divergências' : 'Dia a dia'}`,
      subtitulo: `Período ${reportUtil.fmtDataBR(inicio)} a ${reportUtil.fmtDataBR(fim)} · gerado em ${reportUtil.agoraBrasiliaFmt()}`,
      resumo: [
        [dias.length, 'dias com movimento'],
        [noPeriodo.filter((r) => r.tipo === 'CONTAGEM').length, 'contagens'],
        [noPeriodo.filter((r) => r.tipo === 'ENVIO').length, 'envios'],
        [divergencias, 'divergências (saída negativa)'],
      ],
      colunas: [
        { key: 'dia', label: 'Dia' },
        { key: 'meta', label: 'Movimento do dia' },
        { key: 'item', label: 'Item' },
        { key: 'entrou', label: 'Entrou' },
        { key: 'saiu', label: 'Saiu' },
        { key: 'alerta', label: 'Alerta' },
      ],
      larguras: { dia: 60, meta: 150, item: 170, entrou: 70, saiu: 90, alerta: 221 },
      linhas,
      nomeArquivo: `carrinho-${soDivergencias ? 'divergencias' : 'dia-a-dia'}-${inicio}-a-${fim}`,
      semDadosMsg: soDivergencias ? 'Nenhuma divergência no período. 🎉' : 'Nenhum movimento no período.',
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// relatorio ESCRITO de ajustes/desvios: paragrafo por paragrafo, apontando
// QUEM contou/enviou em cada turno com divergencia - pedido do Master:
// "relatorio escrito explicando os possiveis ajustes e desvios erros
// operacionais informando usuario do envio". Diferente dos PDFs tabulares
// acima (Dia a dia / so divergencias): aqui e prosa, pronta pra ler e agir.
app.get('/api/abastecimento/divergencias/relatorio-escrito.pdf', auth.requireMaster, async (req, res) => {
  try {
    const hoje = hojeBrasiliaISO();
    const fim = req.query.fim || hoje;
    const inicio = req.query.inicio || (() => {
      const d = new Date(`${fim}T00:00:00`);
      d.setDate(d.getDate() - 6);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    })();
    const dataOk = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
    if (!dataOk(inicio) || !dataOk(fim) || inicio > fim) return res.status(400).json({ error: 'Período inválido.' });

    const diaDe = (iso) => new Date(iso).toLocaleDateString('sv-SE', { timeZone: FUSO_BR });
    const regs = await abastecimentoCarrinho.listAll();
    const noPeriodo = regs.filter((r) => { const d = diaDe(r.criadoEm); return d >= inicio && d <= fim; });
    const ciclos = abastecimentoPrevisao.montarCiclos(noPeriodo).filter((c) => c.dia >= inicio && c.dia <= fim);
    const divergentes = ciclos.filter((c) => c.itens.some((i) => i.saida < 0)).sort((a, b) => a.de.localeCompare(b.de));

    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="carrinho-relatorio-desvios-${inicio}-a-${fim}.pdf"`);
    doc.pipe(res);

    doc.fontSize(8).fillColor('#5b6470').text('SOLUTIONS TI TECH · ZENITH OPS', { characterSpacing: 1 });
    doc.moveDown(0.3);
    doc.fontSize(16).fillColor('#111').text('Relatório de ajustes e desvios — Relatórios do Carrinho');
    doc.fontSize(9).fillColor('#666').text(`Período ${reportUtil.fmtDataBR(inicio)} a ${reportUtil.fmtDataBR(fim)} · gerado em ${reportUtil.agoraBrasiliaFmt()}`);
    doc.moveDown(1);

    if (!divergentes.length) {
      doc.fontSize(11).fillColor('#222').text('Nenhuma divergência encontrada no período. 🎉');
    } else {
      doc.fontSize(10).fillColor('#444').text(`${divergentes.length} turno(s) com divergência no período - abaixo, o que aconteceu em cada um e quem esteve envolvido.`);
      doc.moveDown(1);
      divergentes.forEach((c, idx) => {
        if (doc.y > 680) doc.addPage();
        const negativos = c.itens.filter((i) => i.saida < 0);
        doc.fontSize(12).fillColor('#111').text(`${idx + 1}. Turno ${c.rotulo} (${reportUtil.fmtDataBR(c.dia)})`);
        doc.fontSize(9.5).fillColor('#444');
        doc.text(`Contagem de abertura: ${c.abreOperador || 'não identificado'} · Contagem de fechamento: ${c.fechaOperador || 'não identificado'}`);
        doc.text(c.enviosOperadores.length ? `Envios no turno, feitos por: ${c.enviosOperadores.join(', ')}` : 'Nenhum envio registrado nesse turno.');
        doc.moveDown(0.3);
        negativos.forEach((i) => {
          const un = i.tipo === 'pizza' ? '' : ' un';
          doc.fontSize(9.5).fillColor('#b91c1c').text(`⚠ ${i.nome}: sobrou ${Math.abs(i.saida)}${un} a mais do que o esperado`);
        });
        doc.fontSize(9).fillColor('#555').text(
          c.enviosOperadores.length
            ? `Possível causa: contagem de abertura ou fechamento incorreta (conferir com ${c.abreOperador || '?'} e ${c.fechaOperador || '?'}), ou envio lançado com quantidade errada (conferir com ${c.enviosOperadores.join(', ')}).`
            : `Possível causa: como não houve envio registrado nesse turno, o mais provável é erro na contagem de abertura ou fechamento - conferir com ${c.abreOperador || '?'} e ${c.fechaOperador || '?'}.`,
          { width: 490 }
        );
        doc.moveDown(1);
      });
    }
    doc.end();
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// explicacao de UM turno especifico - a tela usa isso pra montar o card
// "o que aconteceu" quando chega pelo link da notificacao de divergencia
app.get('/api/abastecimento/turno/:ate', auth.requireMaster, async (req, res) => {
  try {
    const ciclo = await buscarTurno(req.params.ate);
    if (!ciclo) return res.status(404).json({ error: 'Turno não encontrado (pode já ter saído da janela de dados).' });
    res.json({ ciclo, negativos: ciclo.itens.filter((i) => i.saida < 0) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PDF de UMA divergencia especifica, pensado pra apresentar (franqueado,
// Master de outra unidade etc) - ao contrario do "Dia a dia" (que despeja o
// periodo inteiro), esse e o recorte de um turno so, pronto pra explicar o
// que aconteceu sem precisar reabrir a tela
app.get('/api/abastecimento/turno/:ate/relatorio.pdf', auth.requireMaster, async (req, res) => {
  try {
    const ciclo = await buscarTurno(req.params.ate);
    if (!ciclo) return res.status(404).json({ error: 'Turno não encontrado (pode já ter saído da janela de dados).' });
    const negativos = ciclo.itens.filter((i) => i.saida < 0);
    // divergentes primeiro - quem abre o PDF ve o problema sem precisar rolar
    const linhas = [...ciclo.itens].sort((a, b) => (a.saida < 0 ? 0 : 1) - (b.saida < 0 ? 0 : 1)).map((i) => {
      const un = i.tipo === 'pizza' ? '' : ' un';
      return {
        item: i.nome,
        tipo: i.tipo === 'pizza' ? 'pizza' : 'insumo',
        inicial: `${i.saldoInicial}${un}`,
        entrou: `${i.entradas}${un}`,
        final: `${i.saldoFinal}${un}`,
        saiu: fmtSaidaTxt(i.saida, un),
        explicacao: i.saida < 0 ? 'Saída negativa: sobrou mais do que entrou — sinal de contagem ou envio não lançado nesse turno.' : '',
      };
    });
    reportUtil.writePDF(res, {
      titulo: 'Explicação da divergência — Relatórios do Carrinho',
      subtitulo: `Turno ${ciclo.rotulo} · fechado em ${reportUtil.fmtDataHoraBR(ciclo.ate)} · gerado em ${reportUtil.agoraBrasiliaFmt()}`,
      resumo: [
        [negativos.length, negativos.length === 1 ? 'item com saída negativa' : 'itens com saída negativa'],
        [ciclo.envios, ciclo.envios === 1 ? 'envio no turno' : 'envios no turno'],
        [ciclo.itens.length, 'itens contados no turno'],
        [`${ciclo.horas.toFixed(1)}h`, 'duração do turno'],
      ],
      colunas: [
        { key: 'item', label: 'Item' },
        { key: 'tipo', label: 'Tipo' },
        { key: 'inicial', label: 'Saldo inicial' },
        { key: 'entrou', label: 'Entrou' },
        { key: 'final', label: 'Saldo final' },
        { key: 'saiu', label: 'Saída apurada' },
        { key: 'explicacao', label: 'Explicação' },
      ],
      larguras: { item: 110, tipo: 55, inicial: 75, entrou: 65, final: 75, saiu: 90, explicacao: 291 },
      linhas,
      linhasDinamicas: true,
      nomeArquivo: `carrinho-divergencia-${ciclo.dia}-${reportUtil.slugify(ciclo.rotulo)}`,
      semDadosMsg: 'Turno sem itens.',
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// SUGESTAO DE ENVIO (pre-envio): quanto falta pra encher o carrinho depois
// da ultima contagem. Gate mais estreito que o do GET /api/abastecimento de
// proposito: e ferramenta de QUEM ENVIA (loja) - o carrinho conta e pede, a
// loja e que decide o que separar. Master/Admin passam (fazem as duas
// pontas, ver podeEnviarAbastecimento).
// E so uma sugestao: quem lanca ajusta na tela.
app.get('/api/abastecimento/sugestao-envio', auth.requireAuth, async (req, res) => {
  try {
    if (!podeEnviarAbastecimento(req)) {
      return res.status(403).json({ error: 'O pré-envio é da loja (quem envia).' });
    }
    const [regs, config] = await Promise.all([abastecimentoCarrinho.listAll(), abastecimentoCarrinho.getConfig()]);
    res.json(abastecimentoPrevisao.sugerirEnvio(regs, { capacidadesManuais: config.capacidades }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// capacidade do carrinho por item (o que cabe nas 2 geladeiras). Cadastro
// do Master; sem cadastro, a sugestao usa a capacidade ESTIMADA pelo
// historico. O GET devolve as duas coisas juntas pra tela mostrar a
// estimativa como sugestao de preenchimento do campo.
app.get('/api/abastecimento/capacidades', auth.requireMaster, async (req, res) => {
  try {
    const [regs, config] = await Promise.all([abastecimentoCarrinho.listAll(), abastecimentoCarrinho.getConfig()]);
    const estimadas = abastecimentoPrevisao.estimarCapacidades(abastecimentoPrevisao.montarCiclos(regs), config.capacidades);
    res.json({ cadastradas: config.capacidades, itens: [...estimadas.values()] });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/abastecimento/capacidades', auth.requireMaster, async (req, res) => {
  if (await desviarSeQaMaster(req, res, 'abastecimento.capacidades', 'Capacidade do carrinho por item', { capacidades: req.body?.capacidades })) return;
  try {
    const config = await abastecimentoCarrinho.salvarCapacidades(req.body?.capacidades);
    broadcast('abastecimento-atualizado', { capacidades: true });
    res.json({ ok: true, capacidades: config.capacidades });
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

// correlaciona uma conversa do chat de suporte com a loja de onde ela veio
// (chat.lojaContexto - nome da loja, setado quando a pessoa abre o link/QR
// de atendimento.html, ver suporteChat.js) com o NOC Zenith, pra saber se
// "a loja caiu" e' a causa real de uma conversa travada, em vez do Beniboy
// simplesmente nao ter resolvido - usado pra trocar o alarme/texto do push
// (ver notifyBeniboyEscalonamento). So computador tipo 'atendimento' conta
// (e' o que hospeda esse widget de chat) - se nenhum tiver batido heartbeat,
// a loja esta sem conexao de verdade.
async function lojaContextoEstaOffline(lojaContexto) {
  if (!lojaContexto) return false;
  try {
    const { encontrada } = await resolverUnidadePublica(lojaContexto);
    if (!encontrada) return false;
    const computadores = (await lojaStatus.listar()).filter((c) => c.codigo === encontrada.codigo && c.tipo === 'atendimento');
    return computadores.length > 0 && computadores.every((c) => !c.online);
  } catch (err) {
    return false;
  }
}

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
      // se a loja de onde veio essa conversa esta sem conexao, a causa real
      // da conversa travada nao e o Beniboy "nao ter resolvido" - troca o
      // alarme critico por um push explicando isso (ver lojaContextoEstaOffline)
      const lojaOffline = await lojaContextoEstaOffline(r.chat?.lojaContexto);
      // alarme critico: alem do push normal (Master/Admin), o Master + tag
      // Suporte recebem um alerta sonoro que insiste ate ser silenciado -
      // push em TODOS os acessos logados dessa pessoa (celular fechado/outro
      // app, ver podeReceberCritico) + SSE (app aberto na hora, ver
      // suporte-chat.js). Seção 'suporte' de verdade (ver VALID_SECTIONS em
      // users.js): Master passa direto (bypass no broadcast()), quem tem
      // essa seção recebe tambem, Admin sem a seção fica de fora.
      push.notifyBeniboyEscalonamento(r.chat, r.motivoAtendente, { lojaOffline });
      broadcast('beniboy-escalonamento', { chatId, nome: r.chat?.nome || '', motivo: r.motivoAtendente || '' }, 'suporte');
      // marca o instante desse 1o alerta - a varredura reforcarAlarmesBeniboy()
      // usa isso pra saber quando repetir, ja que ninguem assumiu ainda
      suporteChat.marcarAlertaEnviado(chatId).catch(() => {});
      // acabou de nascer um alarme por reforcar: liga a varredura rapida
      // (ver reforcarAlarmesBeniboy)
      alarmeBeniboyPendente = true;
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
// Ha alguma conversa escalada esperando reforco? Nasce true pra que o
// primeiro tick depois de um deploy sempre confira o banco (pode ter ficado
// alguem escalado da instancia anterior). Depois disso quem manda e o
// resultado da propria varredura + a escalacao nova em acionarBeniboy.
let alarmeBeniboyPendente = true;

async function reforcarAlarmesBeniboy() {
  const pendentes = await suporteChat.listarParaReforcarAlarme();
  // sem ninguem esperando, a varredura passa pro ritmo lento (ver o
  // agendamento) - a consulta so volta a ser de 15 em 15s quando ha de fato
  // um alarme por reforcar
  alarmeBeniboyPendente = pendentes.length > 0;
  for (const chat of pendentes) {
    const lojaOffline = await lojaContextoEstaOffline(chat.lojaContexto);
    if (lojaOffline) {
      // a loja ja caiu - a escalacao inicial ja avisou isso (com o texto
      // certo, sem sirene, ver acionarBeniboy) e a varredura de
      // conectividade (rodarVarreduraLojaStatus) segue avisando "loja sem
      // conexao" por conta propria. Reforcar o alarme critico aqui de novo
      // so criaria alarme falso repetido pra algo que ninguem consegue
      // "atender" agora - so marca como avisado de novo pra nao cair aqui
      // outra vez no proximo tick
      await suporteChat.marcarAlertaEnviado(chat.id);
      continue;
    }
    push.notifyBeniboyEscalonamento(chat, null);
    broadcast('beniboy-escalonamento', { chatId: chat.id, nome: chat.nome || '', motivo: '' }, 'suporte');
    await suporteChat.marcarAlertaEnviado(chat.id);
  }
}

// confere se alguem esta de olho nesse pedido (vigia gravado pelo Beniboy em
// pedidoWatch.js quando respondeu consultar_pedido) e, se o status mudou
// desde aquela resposta, avisa a pessoa - SSE se o NoPulso estiver aberto
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
// acima (broadcastParaUsuario p/ quem esta com o NoPulso aberto, qualquer
// tela, + push.notifyUsuario p/ quem fechou o app) ----------
app.get('/api/mensagens/usuarios-alvo', auth.requireAuth, async (req, res) => {
  if (!ehTimeSuporte(req)) return res.status(403).json({ error: 'Você não tem acesso a essa área.' });
  const lista = await users.list();
  res.json(lista
    .filter((u) => u.active)
    .map((u) => ({ id: u.id, email: u.email, username: u.username, unidades: (u.permissions && u.permissions.unidades) || null })));
});

// Mensagem direta agora é CONVERSA gravada (ver mensagensDiretas.js), não
// mais um aviso que sumia da tela em 20s: fica esperando a pessoa abrir a
// caixa de diálogo, e ela responde por dentro. O broadcast + push continuam,
// só que agora avisando que existe conversa pra abrir, em vez de serem a
// única entrega da mensagem.
app.post('/api/mensagens/enviar', auth.requireAuth, async (req, res) => {
  if (!ehTimeSuporte(req)) return res.status(403).json({ error: 'Você não tem acesso a essa área.' });
  try {
    const userId = String(req.body.userId || '').trim();
    const alvo = userId ? await auth.getUserById(userId) : null;
    if (!alvo) return res.status(400).json({ error: 'Selecione quem vai receber.' });
    const conversa = await mensagensDiretas.enviar({
      deId: req.user.id, deEmail: req.user.email,
      paraId: userId, paraEmail: alvo.email,
      texto: req.body.texto,
    });
    avisarMensagemDireta(userId, conversa.id, req.user.email, req.body.texto);
    res.json({ ok: true, id: conversa.id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// aviso de "tem conversa pra abrir" - as duas entregas de sempre (SSE pra
// quem está com o NoPulso aberto em qualquer tela, push pra quem fechou o
// app). O texto vai junto só pra prévia; a mensagem de verdade está gravada.
function avisarMensagemDireta(userId, conversaId, deEmail, texto) {
  const previa = String(texto || '').trim().slice(0, 140);
  broadcastParaUsuario(userId, 'mensagem-direta', { conversaId, previa, deEmail, em: Date.now() });
  push.notifyUsuario(userId, `Mensagem de ${deEmail}`, previa, 'mensagem-direta-' + conversaId, '/painel.html')
    .catch((err) => console.error('Erro no push de mensagem direta:', err.message));
}

// Aviso pro DONO da conta quando o login dela é desbloqueado - o mesmo texto
// do pop-up que quem aprovou vê, só que endereçado à pessoa (pedido do
// Master: "quando aprovado, enviar mensagem para o cliente do jeito que está
// nesse pop-up"). Sai pelos dois canais de sempre: mensagem direta gravada
// (a caixa de diálogo abre assim que ela entrar de novo, e dá pra responder)
// e push no celular - que é o canal que chega ANTES do login, o estado
// provável de quem estava bloqueado. Nunca derruba o desbloqueio: avisar é
// bônus, a conta já está aberta.
async function avisarLoginDesbloqueado(userId, { porId, porEmail, pedirTrocaSenha } = {}) {
  if (!userId) return;
  const texto = pedirTrocaSenha
    ? '🔓 Login desbloqueado! Você já pode entrar de novo - na entrada, o sistema vai pedir pra você definir uma senha nova.'
    : '🔓 Login desbloqueado! Você já pode entrar de novo com a mesma senha de sempre.';
  try {
    // a mensagem sai em nome de quem aprovou (a pessoa pode responder);
    // sem aprovador identificado (ex: fila QA) fica só o push abaixo
    if (porId && String(porId) !== String(userId)) {
      const alvo = await auth.getUserById(userId).catch(() => null);
      const conversa = await mensagensDiretas.enviar({
        deId: porId, deEmail: porEmail || null,
        paraId: userId, paraEmail: (alvo && alvo.email) || null,
        texto,
      });
      broadcastParaUsuario(userId, 'mensagem-direta', { conversaId: conversa.id, previa: texto.slice(0, 140), deEmail: porEmail || null, em: Date.now() });
    }
  } catch (e) {
    console.error('Aviso de desbloqueio (mensagem direta) não foi:', e.message);
  }
  push.notifyUsuario(userId, '🔓 Login desbloqueado', texto, 'desbloqueio-' + userId, '/')
    .catch((err) => console.error('Aviso de desbloqueio (push) não foi:', err.message));
}

// as conversas de QUEM ESTÁ LOGADO - qualquer acesso, não só o time de
// suporte: quem recebeu um recado precisa poder abrir e responder
app.get('/api/mensagens/minhas', auth.requireAuth, async (req, res) => {
  res.json(await mensagensDiretas.listarDoUsuario(req.user.id));
});

app.get('/api/mensagens/:id', auth.requireAuth, async (req, res) => {
  const conversa = await mensagensDiretas.obter(req.params.id, req.user.id);
  if (!conversa) return res.status(404).json({ error: 'Conversa não encontrada.' });
  res.json(conversa);
});

app.post('/api/mensagens/:id/responder', auth.requireAuth, async (req, res) => {
  try {
    const conversa = await mensagensDiretas.responder(req.params.id, {
      deId: req.user.id, deEmail: req.user.email, texto: req.body.texto,
    });
    // avisa o outro lado do mesmo jeito - resposta também é mensagem direta
    const outro = (conversa.participantes || []).find((p) => p !== String(req.user.id));
    if (outro) avisarMensagemDireta(outro, conversa.id, req.user.email, req.body.texto);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/mensagens/:id/lida', auth.requireAuth, async (req, res) => {
  try {
    res.json(await mensagensDiretas.marcarLida(req.params.id, req.user.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ----- lado do atendimento -----
app.get('/api/suporte-chats', auth.requireAuth, async (req, res) => {
  if (!ehTimeSuporte(req)) return res.status(403).json({ error: 'Você não tem acesso a essa área.' });
  const todos = await suporteChat.listAll();
  // token do visitante nunca sai pro atendimento - nao precisa
  res.json(todos.map(({ token, ...resto }) => resto));
});

// dashboard de metricas dos atendimentos via chat (dashboard-atendimentos.html)
// - pedido explicito do usuario, inspirado num dashboard de outra plataforma
// de atendimento que ele usa. de/ate no formato YYYY-MM-DD (opcionais).
app.get('/api/suporte-chats/estatisticas', auth.requireAuth, async (req, res) => {
  if (!ehTimeSuporte(req)) return res.status(403).json({ error: 'Você não tem acesso a essa área.' });
  const { de, ate } = req.query;
  res.json(await suporteChat.estatisticas({ de, ate }));
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
    // responder numa conversa aberta ASSUME o atendimento (pedido do
    // usuario): quem escreve vira o responsavel, o card vai pra "Em
    // atendimento" e o visitante recebe a apresentacao automatica (ver
    // mensagemAssumir em suporteChat.js) antes da resposta digitada.
    const atual = await suporteChat.getOne(req.params.id);
    if (atual && atual.status === 'ABERTO'
        && (!atual.responsavel || atual.responsavel.email !== req.user.email)) {
      await suporteChat.atualizarStatusAtendimento(req.params.id, {
        statusAtendimento: 'EM_ATENDIMENTO',
        autor: { id: req.user.id, email: req.user.email, nome: req.user.username || req.user.email },
      });
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

// evolui a triagem de N1 pra N2 - mesmo tecnico com o chamado (ou gestor,
// Master/Admin) - so depois disso a porta pra presencial libera (ver
// escalar-presencial abaixo e evoluirNivel em chamadosTI.js)
app.post('/api/chamados/:id/evoluir-nivel', requireAnySection('tecnico', 'suporte'), async (req, res) => {
  try {
    const chamado = await chamadosTI.evoluirNivel(req.params.id, {
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
      nivel: req.body.nivel,
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

// Relatorio do atendimento em PDF: o chamado inteiro num arquivo so, com as
// fotos EMBUTIDAS (ver chamadoRelatorio.js). E o que vai anexado numa
// cobranca, mandado pro franqueado ou guardado como comprovante do servico -
// tudo isso por gente que nao tem acesso ao NoPulso, entao link nao serve.
// Aberto numa aba nova (<a href>), por isso a autenticacao vem no ?token=
// (auth.js:242 ja aceita) em vez de header.
app.get('/api/chamados/:id/relatorio.pdf', requireAnySection('tecnico', 'suporte'), async (req, res) => {
  try {
    const chamado = await chamadosTI.getOne(req.params.id);
    if (!chamado) return res.status(404).json({ error: 'Chamado não encontrado.' });
    await chamadoRelatorio.gerarRelatorioPDF(res, chamado, { geradoPor: req.user.email });
  } catch (err) {
    console.error('Erro ao gerar relatório do chamado:', err.message);
    // se o PDF ja comecou a sair, nao da pra trocar por JSON - o cliente
    // recebe um arquivo truncado e o erro fica no log
    if (!res.headersSent) res.status(500).json({ error: 'Não foi possível gerar o relatório agora.' });
    else res.end();
  }
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
  const todos = auth.filtrarPorEmpresa(req, await chamadosManutencao.listAll());
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
    if (!(await unidadesExtras.apareceEm(unidade, 'entregas'))) return res.status(400).json({ error: 'Essa unidade não tem Entregas habilitado.' });
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
      LIMIT_FILE_SIZE: 'Arquivo muito grande pra este envio. Diminua a foto (ou salve o PDF em qualidade menor) e tente de novo.',
      LIMIT_FILE_COUNT: 'Muitos arquivos de uma vez (máximo 8 anexos por registro).',
      LIMIT_UNEXPECTED_FILE: 'Campo de arquivo inesperado no envio.',
    };
    return res.status(400).json({ error: mensagens[err.code] || 'Erro ao enviar anexo: ' + err.message });
  }
  next(err);
});

// Teto de tempo pro aquecimento antes de abrir a porta (ver aquecerBoot).
const BOOT_AQUECIMENTO_MS = Number(process.env.BOOT_AQUECIMENTO_MS || 20000);

// Roda uma tarefa de boot que NUNCA rejeita: erro vira log e a subida
// continua. E o mesmo espirito dos try/catch que existiam aqui antes - se o
// Firestore estiver fora do ar (cota estourada, RESOURCE_EXHAUSTED), o app
// sobe com o cache vazio em vez de nao subir; quando o Firestore normalizar,
// as proximas leituras/gravacoes voltam sozinhas, sem redeploy manual.
function tarefaDeBoot(tarefa, oQue) {
  return Promise.resolve()
    .then(tarefa) // o .then tambem captura throw SINCRONO dentro da tarefa
    .catch((err) => {
      console.error(`Boot: ${oQue} falhou (app sobe mesmo assim):`, err.message);
    });
}

// Espera o aquecimento por no maximo `ms`. Se estourar, devolve o controle
// (a porta abre) e o aquecimento SEGUE rodando em segundo plano - quando
// terminar, o cache fica quente sozinho.
//
// POR QUE ISSO EXISTE: o app so chamava app.listen() DEPOIS de esperar
// store.init() + auth.ensureMaster(), sem limite de tempo nenhum. As duas
// fazem chamada de rede (snapshot no Storage, colecao no Firestore). O
// try/catch que envolvia as duas pega ERRO, mas nao pega LENTIDAO: uma
// chamada que nunca volta nao lanca excecao - ela so nao volta. Resultado:
// a porta nunca abria, e o Render derrubava o deploy por timeout depois de
// 15 minutos esperando o bind (deploy 889769f, 16/08/2026 11:03->11:18).
// Ficar de pe com cache frio e melhor que nao ficar de pe.
function aquecerBoot(promessa, ms) {
  let alarme;
  const limite = new Promise((resolve) => {
    alarme = setTimeout(() => {
      console.warn(`Boot: aquecimento passou de ${ms}ms - abrindo a porta e terminando em segundo plano.`);
      resolve();
    }, ms);
  });
  // limpa o timer quando o aquecimento termina antes, pra ele nao segurar o
  // event loop à toa. `promessa` vem de tarefaDeBoot e nunca rejeita, entao
  // esta corrida nao deixa rejeicao orfa pra tras (que no Node >=15 derruba
  // o processo - seria um remedio pior que a doenca).
  promessa.then(() => clearTimeout(alarme));
  return Promise.race([promessa, limite]);
}

(async () => {
  const aquecimento = (async () => {
    await tarefaDeBoot(() => store.init(), 'carregar histórico do Firestore');
    await tarefaDeBoot(() => auth.ensureMaster(), 'garantir usuário Master');
    await tarefaDeBoot(() => grupos.ensureGrupoSaltiverso(), 'garantir grupo do Saltiverso Patteo');
    await tarefaDeBoot(() => empresas.ensureEmpresasSeed(), 'garantir empresas MVPar/Arcfood');
  })();
  await aquecerBoot(aquecimento, BOOT_AQUECIMENTO_MS);

  app.listen(PORT, async () => {
    console.log(`NoPulso rodando em http://localhost:${PORT}`);
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
    // PRÉ-AQUECIMENTO: DESLIGADO por padrão (23/08/2026).
    //
    // Ele lê 8 coleções INTEIRAS a cada boot, só pra que o primeiro visitante
    // depois de um deploy não espere a leitura. Com o consumo em regime já
    // perto de zero (ver o espelho do NOC em lojaStatus.js), isso passou a
    // ser o MAIOR custo restante: cada deploy custava ~5 mil leituras, e num
    // dia de trabalho são dezenas de deploys. O gráfico do Firebase em 23/08
    // mostrava exatamente isso - piso no chão e um pico a cada subida.
    //
    // Sem ele, quem abrir primeiro paga a leitura uma vez (a mesma que ia
    // acontecer no pré-aquecimento) e todo mundo depois pega do cache. A
    // diferença é uma tela um pouco mais lenta pra UMA pessoa, uma vez por
    // deploy - contra ler tudo em toda subida, sempre, mesmo quando ninguém
    // abre o app (madrugada, fim de semana).
    //
    // PRE_AQUECER_CACHES=1 religa.
    if (process.env.PRE_AQUECER_CACHES === '1') {
      Promise.allSettled([
        fechamentosLive.listAll(), entregasLive.listAll(), solicitacoes.listAll(),
        parque.listAll(), festas.listAll(), mensalistas.listAll(),
        chamadosTI.listAll(), sangrias.listAll(),
      ]).then((r) => {
        const falhas = r.filter((x) => x.status === 'rejected').length;
        console.log(`Caches pré-aquecidos (${r.length - falhas}/${r.length} coleções).`);
      });
    }

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

    // termo impresso e venda nunca fechada: avisa Master/Gerente da unidade
    // depois de PARQUE_TERMO_ALERTA_HORAS (1h por padrão). Cada atendimento
    // avisa UMA vez (o parque.emissoesParaAlertar marca avisadoEm) - alerta
    // repetido é alerta que a pessoa aprende a ignorar.
    const varrerTermosPendentes = async () => {
      const h = horaBrasilia();
      if (h < 8 || h >= 23) return; // fora do horário do parque não há o que cobrar
      const pendentes = await parque.emissoesParaAlertar();
      for (const e of pendentes) {
        await push.notifyParqueTermoPendente(e);
        console.log(`Parque: termo sem venda há ${e.horas}h (${e.unidadeNome || e.unidade} · ${e.responsavelNome || 's/ nome'}) - Master/Gerente avisados.`);
      }
    };
    varrerTermosPendentes().catch((err) => console.error('Erro na varredura de termos pendentes:', err.message));
    setInterval(() => {
      varrerTermosPendentes().catch((err) => console.error('Erro na varredura de termos pendentes:', err.message));
    }, 10 * 60 * 1000);

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
        // HD morrendo/enchendo (ver nocMaquina.js): avisa uma vez por piora,
        // nunca a cada medicao - HD com setor realocado continua assim pra
        // sempre e um alerta repetido vira ruido que ninguem le
        // política da casa: reboot semanal. Avisa a cada semana nova sem
        // reiniciar, não todo dia (ver avaliarUptime em nocMaquina.js)
        if (t.tipo === 'reiniciar') {
          push.notifyReinicioPendente(nome, t.codigo, t.nome, t.posto, t.dias)
            .catch((err) => console.error('Erro no push de reinício pendente:', err.message));
          continue;
        }
        if (t.tipo === 'disco') {
          push.notifyDiscoAlerta(nome, t.codigo, t.nome, t.posto, t.nivel, t.motivos)
            .catch((err) => console.error('Erro no push de alerta de disco:', err.message));
          continue;
        }
        // máquina reiniciou/desligou: quem detecta é o agente (comparando o
        // LastBootUpTime a cada batida), não a ausência de heartbeat
        if (t.tipo === 'reiniciou') {
          push.notifyMaquinaReiniciou(nome, t.codigo, t.nome, t.posto, t.inesperado)
            .catch((err) => console.error('Erro no push de reinício:', err.message));
          continue;
        }
        // caiu a Ethernet mas a máquina segue no ar (Wi-Fi): degradação,
        // não queda - por isso não passa pelo caminho de offline abaixo
        if (t.tipo === 'link') {
          push.notifyLinkDegradado(nome, t.codigo, t.nome, t.posto, t.linkTipo, t.ethernetCaida)
            .catch((err) => console.error('Erro no push de link degradado:', err.message));
          continue;
        }
        // celular que fechou o navegador num posto 'interno' não é loja caída
        // (ver quedaDeCelular em lojaStatus.js), e notebook marcado no
        // cadastro hiberna/dorme fora de hora - o NOC mostra a transição nos
        // dois casos, mas ninguém é acordado com push por causa disso
        if (t.celular || t.ehNotebook) continue;
        // reiniciada PELO NOC e não voltou na janela: incidente de verdade,
        // com causa provável conhecida - não passa pelo caminho de "caiu"
        if (t.tipo === 'reinicio-nao-voltou') {
          push.notifyReinicioNaoVoltou(nome, t.codigo, t.nome, t.posto, t.minutos)
            .catch((err) => console.error('Erro no push de reinício não voltou:', err.message));
          continue;
        }
        // t.reiniciando / t.voltouDeReinicio: o NOC sabe que foi ele quem
        // mandou reiniciar, então o alerta conta ISSO em vez de mandar
        // verificar uma internet que não tem problema nenhum.
        // t.confirmada / 'offline-confirmada' / t.quedaCurta: o push crítico
        // (sonoro) só sai com a queda CONFIRMADA (silêncio além de
        // CONFIRMACAO_QUEDA_MS em lojaStatus.js) - oscilação que cai e volta
        // em poucos minutos fica só no painel/histórico, sem apitar ninguém
        if (t.tipo === 'offline') {
          if (t.reiniciando || t.confirmada) {
            push.notifyLojaOffline(nome, t.codigo, t.nome, t.posto, t.reiniciando).catch((err) => console.error('Erro no push de loja offline:', err.message));
          }
        } else if (t.tipo === 'offline-confirmada') {
          push.notifyLojaOffline(nome, t.codigo, t.nome, t.posto, false).catch((err) => console.error('Erro no push de loja offline:', err.message));
        } else if (t.tipo === 'online' && !t.quedaCurta) {
          push.notifyLojaVoltou(nome, t.codigo, t.nome, t.posto, t.voltouDeReinicio).catch((err) => console.error('Erro no push de loja online:', err.message));
        }
      }
    };
    // 2min (era 1min). O limiar de queda é 90s e o push crítico só sai depois
    // da janela de confirmação, então o que muda de fato é a detecção chegar
    // até 1min mais tarde numa queda - contra metade das varreduras por dia.
    // NOC_VARREDURA_MS ajusta sem deploy.
    const VARREDURA_MS = Number(process.env.NOC_VARREDURA_MS) > 0
      ? Number(process.env.NOC_VARREDURA_MS) : 2 * 60 * 1000;
    setInterval(() => {
      rodarVarreduraLojaStatus().catch((err) => console.error('Erro na varredura de conectividade das lojas:', err.message));
    }, VARREDURA_MS);

    // reforco do alarme critico do Beniboy (ver reforcarAlarmesBeniboy) -
    // roda a cada 15s, so repete de fato quem passou de REALERTA_MS (30s)
    // sem ninguem assumir. Varredura mais rapida que o proprio REALERTA_MS
    // pra nao empilhar atraso em cima do atraso (senao o reforco "de 30s"
    // virava de fato ~1min30 esperando o proximo tick de 1min)
    // ...mas so enquanto HA alguem esperando. A consulta e sempre filtrada
    // (ABERTO + bot desativado + PENDENTE), so que uma consulta que nao acha
    // nada ainda custa 1 leitura no Firestore: de 15 em 15s isso dava 5.760
    // leituras/dia pra descobrir, quase sempre, que nao ha nada a fazer. Sem
    // ninguem escalado, o ritmo cai pra 2min (8 ticks); a escalacao nova
    // (acionarBeniboy) liga o ritmo rapido na hora, sem esperar tick nenhum.
    let ticksAlarmeBeniboy = 0;
    setInterval(() => {
      ticksAlarmeBeniboy += 1;
      if (!alarmeBeniboyPendente && ticksAlarmeBeniboy % 8 !== 0) return;
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

    // RH: ponto aberto além da jornada (ver LIMITE_CHECKOUT_HORAS em
    // rhCheckin.js). Roda de hora em hora; quem decide se cada registro está
    // vencido é a própria varredura, que já respeita o intervalo entre
    // repetições.
    //
    // O PRIMEIRO aviso de cada check-in sai a qualquer hora - esquecer o
    // check-out às 23h é exatamente o caso que precisa aparecer. As
    // repetições ficam em silêncio das 23h às 6h: insistir de madrugada não
    // faz ninguém bater ponto, só ensina a ignorar o alerta.
    const rodarAlertaCheckoutRh = async () => {
      const h = horaBrasilia();
      const noturno = h >= 23 || h < 6;
      const atrasados = await rhCheckin.verificarCheckoutsAtrasados();
      for (const c of atrasados) {
        if (noturno && !c.primeiroAviso) continue;
        push.notifyRhCheckoutAtrasado(c, c.horasEmAberto);
        broadcast('rh-checkin-atualizado', { id: c.id, unidade: c.unidade }, 'rh');
        await rhCheckin.marcarAlertaCheckout(c.id);
      }
    };
    rodarAlertaCheckoutRh().catch((err) => console.error('Erro no alerta de check-out do RH:', err.message));
    setInterval(() => {
      rodarAlertaCheckoutRh().catch((err) => console.error('Erro no alerta de check-out do RH:', err.message));
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

  // Desligamento: grava o que ficou pendente das batidas de heartbeat.
  //
  // Desde a mudanca de custo (ver PERSIST_MS em lojaStatus.js) a batida de
  // cada computador so vai pro Firestore de 5 em 5 minutos - no meio do
  // caminho o timestamp fresco mora so na memoria deste processo. O Render
  // manda SIGTERM antes de trocar a instancia num deploy; sem este flush a
  // instancia nova subiria lendo timestamps de ate 5min atras e dispararia
  // alerta de queda em massa de lojas que nunca cairam.
  let desligando = false;
  const desligar = async (sinal) => {
    if (desligando) return; // Render manda SIGTERM e depois SIGKILL - nao repetir
    desligando = true;
    try {
      const gravados = await lojaStatus.flushHeartbeatsPendentes();
      if (gravados) console.log(`${sinal}: ${gravados} heartbeat(s) pendente(s) gravado(s) antes de sair.`);
    } catch (err) {
      console.error(`${sinal}: falha ao gravar heartbeats pendentes:`, err.message);
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => desligar('SIGTERM'));
  process.on('SIGINT', () => desligar('SIGINT'));
})();
