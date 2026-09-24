// enderecoAntigo.js
// MIGRAÇÃO 100% PRO DOMÍNIO NOVO (Master, 24/09/2026: "quero tudo direcionado
// pra www.nopulso.com.br sem .html, desligando de vez a antiga URL").
//
// O endereço antigo (o subdomínio do Render) não pode simplesmente ser
// desligado: ainda há quem fale com ele, e cada um quebra de um jeito:
//   - o webhook da Adyen (as transações param de chegar no Monitor);
//   - agente NOCZenith antigo e tablet (a máquina vira "offline" no NOC);
//   - tela de loja fazendo heartbeat pelo navegador (esquece a unidade: o
//     localStorage é por ORIGEM - CLAUDE.md §4).
// Este módulo faz duas coisas:
//
// 1. LEVA AS TELAS EMBORA. Todo GET de tela no endereço antigo recebe uma
//    página de passagem que copia o localStorage (unidade da máquina, sessão,
//    tema, preferências) e abre a MESMA tela no endereço novo, já sem ".html".
//    Quem recebe é o tema.js do lado novo, e só aceita se a pessoa veio de
//    fato do endereço antigo (Referer) - senão um link forjado plantaria uma
//    sessão alheia no navegador de alguém. API, webhook e agentes NÃO são
//    redirecionados: cliente de máquina não segue redirect de POST.
//
// 2. MEDE QUEM AINDA USA. Cada acesso ao endereço antigo conta, por tipo e
//    por dia. O NOC mostra; quando webhook, agentes e heartbeat ficarem em
//    zero por 7 dias, dá pra desligar o subdomínio no Render sem perder nada.
//
// Custo (CLAUDE.md §3): contagem em memória; 1 leitura no boot e no máximo
// 1 escrita por hora, e só se mudou.
const db = require('./firestore');

const HOST_ANTIGO = 'adyen-monitor.onrender.com';
const DOC = db.collection('config').doc('enderecoAntigo');
const DIAS_GUARDADOS = 14;
const DIAS_SEM_USO_PRA_DESLIGAR = 7;
// o que precisa estar em zero pra desligar: quem NÃO é redirecionado
const CRITICOS = ['webhook-adyen', 'agente-pc', 'agente-android', 'heartbeat-navegador', 'api'];

// chaves do localStorage que NÃO vão pro endereço novo: a oferta de
// biometria é por endereço (a digital cadastrada no antigo não vale no novo),
// então ela tem de ser oferecida de novo lá
const NAO_LEVAR = ['passkeyOferecidoAte'];

function hostDe(req) {
  return String((req.headers && req.headers.host) || '').split(':')[0].trim().toLowerCase();
}
function ehHostAntigo(req) { return hostDe(req) === HOST_ANTIGO; }

// "/tarefas.html?x=1" -> "/tarefas?x=1"; "/index.html" -> "/"
function caminhoSemHtml(caminho) {
  const p = String(caminho || '/');
  if (/^\/index\.html$/i.test(p)) return '/';
  return p.replace(/\.html$/i, '') || '/';
}

// tela = o navegador pedindo uma PÁGINA (não API, não arquivo)
function ehNavegacaoDeTela(req) {
  if (req.method !== 'GET') return false;
  const p = String(req.path || '/');
  if (p.startsWith('/api/') || p.startsWith('/webhooks/') || p.startsWith('/mcp/')) return false;
  if (/\.[a-z0-9]+$/i.test(p) && !/\.html$/i.test(p)) return false; // .js, .png, .ps1...
  const aceita = String(req.headers.accept || '');
  return aceita.includes('text/html') || /\.html$/i.test(p);
}

function categoria(req) {
  const p = String(req.path || '/');
  const ua = String(req.headers['user-agent'] || '');
  if (p === '/webhooks/adyen') return 'webhook-adyen';
  if (/agente-android/.test(p) || /okhttp|NoPulsoAgente|Dalvik/i.test(ua)) return 'agente-android';
  if (/PowerShell/i.test(ua) || req.headers['x-noc-token']) return 'agente-pc';
  if (p === '/api/loja-status/heartbeat') return 'heartbeat-navegador';
  if (ehNavegacaoDeTela(req)) return 'tela';
  if (p.startsWith('/api/') || p.startsWith('/mcp/')) return 'api';
  return 'arquivo';
}

// ---------- contagem ----------
const estado = { dias: {}, ultimos: {}, carregado: false, sujo: false };
function hojeSP(agora = Date.now()) {
  return new Date(agora).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}
async function carregar() {
  if (estado.carregado) return;
  estado.carregado = true;
  try {
    const snap = await DOC.get();
    if (snap.exists) {
      const d = snap.data() || {};
      // soma com o que já contou desde o boot (a leitura pode chegar depois)
      for (const [dia, cats] of Object.entries(d.dias || {})) {
        estado.dias[dia] = estado.dias[dia] || {};
        for (const [c, n] of Object.entries(cats || {})) estado.dias[dia][c] = (estado.dias[dia][c] || 0) + (Number(n) || 0);
      }
      for (const [c, u] of Object.entries(d.ultimos || {})) if (!estado.ultimos[c]) estado.ultimos[c] = u;
    }
  } catch (e) { /* sem histórico, segue contando do zero */ }
}
function registrar(req, agora = Date.now()) {
  const c = categoria(req);
  const dia = hojeSP(agora);
  estado.dias[dia] = estado.dias[dia] || {};
  estado.dias[dia][c] = (estado.dias[dia][c] || 0) + 1;
  estado.ultimos[c] = {
    em: new Date(agora).toISOString(),
    caminho: String(req.path || '').slice(0, 120),
    agente: String(req.headers['user-agent'] || '').slice(0, 120),
  };
  estado.sujo = true;
  if (!estado.carregado) carregar();
  return c;
}
function diasRecentes(agora = Date.now()) {
  const limite = hojeSP(agora - DIAS_GUARDADOS * 86400000);
  return Object.fromEntries(Object.entries(estado.dias).filter(([dia]) => dia > limite).sort());
}
async function gravar() {
  if (!estado.sujo) return;
  estado.sujo = false;
  try {
    // set SEM merge de propósito: com merge o Firestore mescla mapa chave a
    // chave e os dias velhos nunca sairiam do documento
    await DOC.set({ dias: diasRecentes(), ultimos: estado.ultimos, atualizadoEm: new Date().toISOString() });
  } catch (e) { estado.sujo = true; }
}
const relogio = setInterval(gravar, 60 * 60 * 1000);
if (relogio.unref) relogio.unref();

function resumo(agora = Date.now()) {
  const dias = diasRecentes(agora);
  const limite7 = hojeSP(agora - DIAS_SEM_USO_PRA_DESLIGAR * 86400000);
  const ultimos7 = {};
  for (const [dia, cats] of Object.entries(dias)) {
    if (dia <= limite7) continue;
    for (const [c, n] of Object.entries(cats)) ultimos7[c] = (ultimos7[c] || 0) + n;
  }
  const pendentes = CRITICOS.filter((c) => ultimos7[c]);
  // só dá pra afirmar "7 dias sem uso" se há 7 dias de medição
  const medindoDesde = Object.keys(estado.dias).sort()[0] || hojeSP(agora);
  const diasMedidos = Math.floor((Date.parse(hojeSP(agora)) - Date.parse(medindoDesde)) / 86400000);
  return {
    host: HOST_ANTIGO, dias, ultimos: estado.ultimos, ultimos7dias: ultimos7,
    medindoDesde, diasMedidos, pendentes,
    prontoParaDesligar: !pendentes.length && diasMedidos >= DIAS_SEM_USO_PRA_DESLIGAR,
  };
}

// ---------- a página de passagem ----------
function destinoNovo(oficial, req) {
  const base = String(oficial || '').replace(/\/+$/, '');
  const url = String(req.originalUrl || req.url || '/');
  const i = url.indexOf('?');
  const caminho = caminhoSemHtml(i >= 0 ? url.slice(0, i) : url);
  return base + caminho + (i >= 0 ? url.slice(i) : '');
}
function paginaDePassagem(destino) {
  // JSON dentro de <script>: "<" escapado pra ninguém fechar a tag pela URL
  const js = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
  const html = String(destino).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<meta name="theme-color" content="#0b0d10"><title>NoPulso · novo endereço</title></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d10;color:#e7ecf1;font:15px Arial,sans-serif;text-align:center;padding:16px">
<p>O NoPulso mudou de endereço. Abrindo…<br><a href="${html}" style="color:inherit">${html}</a></p>
<script>(function(){
  var destino = ${js(destino)}, fora = ${js(NAO_LEVAR)}, dados = {};
  try { for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (fora.indexOf(k) === -1) dados[k] = localStorage.getItem(k); } } catch (e) {}
  var marca = '';
  try { var s = JSON.stringify(dados); if (s !== '{}' && s.length < 400000) marca = '#nopulso-migrar=' + encodeURIComponent(s); } catch (e) {}
  location.replace(destino + marca);
})();</script></body></html>`;
}

// middleware: conta tudo; tela vai embora; o resto segue servido normal
function middleware(obterOficial) {
  return (req, res, next) => {
    if (!ehHostAntigo(req)) return next();
    const oficial = obterOficial();
    let oficialHost = '';
    try { oficialHost = new URL(oficial).hostname.toLowerCase(); } catch (e) { /* sem destino válido */ }
    const c = registrar(req);
    // sem destino válido (ou o oficial É o antigo): não há pra onde levar
    if (!oficialHost || oficialHost === HOST_ANTIGO) return next();
    if (c !== 'tela') return next();
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).type('html').send(paginaDePassagem(destinoNovo(oficial, req)));
  };
}

module.exports = {
  HOST_ANTIGO, NAO_LEVAR, CRITICOS, DIAS_SEM_USO_PRA_DESLIGAR,
  ehHostAntigo, caminhoSemHtml, ehNavegacaoDeTela, categoria, registrar, resumo, gravar,
  destinoNovo, paginaDePassagem, middleware,
  _estado: estado,
};
