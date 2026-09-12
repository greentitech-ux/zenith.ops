#!/usr/bin/env node
// varreduraVisual.js — a rede de seguranca VISUAL (o testeRotas.js e' a de rotas).
//
// POR QUE EXISTE. O testeRotas.js prova que uma regra esta no arquivo; nao
// prova que ela ficou certa nas 59 telas. Tudo que e' injetado pelo tema.js
// (balao, barra de rolagem, limpar filtros, checks) cai em layouts que
// ninguem olhou - e a tela 15 e' descoberta em producao ("Ate" empurrado,
// balao cortado, faixa na ficha). Este script abre TODAS as telas no
// Chromium, em celular e em desktop, e:
//
//   1. acusa erro de JS, rolagem horizontal, elemento fora da tela e dois
//      controles se sobrepondo na mesma faixa (checagens automaticas);
//   2. tira uma foto de cada tela e compara com a foto de referencia
//      (`--aceitar` grava a referencia), marcando o que mudou;
//   3. monta a prancha docs/varredura/prancha.html - lado a lado, antes e
//      depois, com o percentual de pixels que mudou. Bate o olho em 1 minuto.
//
// USO
//   node varreduraVisual.js --aceitar      # ANTES de mexer: grava a referencia
//   node varreduraVisual.js                # DEPOIS: compara e monta a prancha
//   node varreduraVisual.js --so tarefas,monitor   # so algumas telas
//   node varreduraVisual.js --estrito      # sai com erro se algo mudou de foto
//
// As fotos ficam em docs/varredura/ (ignorado pelo git: sao MBs e mudam a
// cada commit). A referencia e' LOCAL - grave antes de comecar a mexer.
//
// Precisa do Playwright (npm i -g playwright) e do Chromium dele. Sem isso
// o script diz o que falta em vez de fingir que passou.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const RAIZ = path.join(__dirname, 'public');
const SAIDA = path.join(__dirname, '..', 'docs', 'varredura');
const BASE = path.join(SAIDA, 'base');
const ATUAL = path.join(SAIDA, 'atual');
const args = process.argv.slice(2);
const ACEITAR = args.includes('--aceitar');
const ESTRITO = args.includes('--estrito');
const SO = (() => { const i = args.indexOf('--so'); return i >= 0 ? String(args[i + 1] || '').split(',').filter(Boolean) : null; })();
// telas que so existem com dado real ou fluxo de fora - abrem em branco por
// natureza; rodam mesmo assim (erro de JS conta), so nao contam como "vazia"
const VIEWPORTS = [
  { nome: 'celular', width: 390, height: 780, isMobile: true, hasTouch: true },
  { nome: 'desktop', width: 1280, height: 900 },
];
const ALTURA_FOTO = 1400;     // recorta a foto: tela longa inteira seria pesada e igual embaixo
const LIMIAR_DIFF = 0.5;      // % de pixels diferentes acima do qual a tela conta como "mudou"

function playwright() {
  for (const p of ['playwright', '/opt/node22/lib/node_modules/playwright', path.join(process.env.HOME || '', '.npm-global/lib/node_modules/playwright')]) {
    try { return require(p); } catch (e) { /* tenta o proximo */ }
  }
  console.error('Playwright não encontrado. Instale com: npm i -g playwright && npx playwright install chromium');
  process.exit(2);
}
function chromiumExec() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const raiz = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  try {
    const dir = fs.readdirSync(raiz).filter((d) => /^chromium-\d+$/.test(d)).sort().pop();
    if (dir) return path.join(raiz, dir, 'chrome-linux', 'chrome');
  } catch (e) { /* deixa o Playwright achar */ }
  return undefined;
}

// ---- servidor estatico + API falsa (mesma ideia do testeRotas: sem Firestore) ----
const TIPOS = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const ME = { id: 'u1', username: 'master', nome: 'Master', email: 'master@teste.local', role: 'master', isAdmin: true, ehTimeSuporte: true, unidades: ['19706'], permissions: { sections: [] } };
const UNIDADES = [{ codigo: '19706', nome: 'Mooca' }, { codigo: '19821', nome: 'Dom Sao Miguel' }];
function servidor() {
  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/api/')) {
      const json = (o, st) => { res.writeHead(st || 200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (u.pathname === '/api/me') return json(ME);
      if (u.pathname === '/api/meta/unidades-publico') return json(UNIDADES);
      if (u.pathname === '/api/stream') { res.writeHead(200, { 'content-type': 'text/event-stream' }); return; }
      if (u.pathname.startsWith('/api/tarefas/contexto')) return json({ unidades: UNIDADES, usuarios: [], tipos: [] });
      // rotas que devolvem OBJETO (a tela le uma propriedade e quebra com []):
      // o formato minimo que cada tela precisa pra abrir vazia sem estourar
      const OBJETOS = {
        '/api/bonificacao': { metricasColaboradores: [], colaboradores: [], itens: [] },
        // formatos copiados do que as rotas devolvem (comprasAcompanhamento.js e suporteChat.estatisticas)
        '/api/compras/acompanhamento': { etapas: [], linhas: [], resumo: { abertas: 0, travadas: 0, aprovadas: 0, compradas: 0, entregues: 0 }, hoje: new Date().toISOString().slice(0, 10) },
        '/api/suporte-chats/estatisticas': { total: 0, emAberto: 0, humanizados: 0, viaBot: 0, tempoMedioRespostaMs: 0, tempoMedioResolucaoMs: 0, porDia: [], porHora: [], porAssunto: [], porAgente: [] },
        '/api/pedido-semanal/regras': { regras: [] },
        '/api/fechamentos/recordes': { unidades: [], recordes: [] },
      };
      if (OBJETOS[u.pathname]) return json(OBJETOS[u.pathname]);
      // o resto: lista vazia ou objeto vazio - a tela tem que abrir mesmo sem dado
      return json(/\/(config|contexto|status|resumo|sincronizacao|kpis?)$/.test(u.pathname) ? {} : []);
    }
    const alvo = path.join(RAIZ, u.pathname === '/' ? 'index.html' : u.pathname);
    if (!alvo.startsWith(RAIZ) || !fs.existsSync(alvo) || fs.statSync(alvo).isDirectory()) { res.writeHead(404); return res.end('nao'); }
    res.writeHead(200, { 'content-type': TIPOS[path.extname(alvo)] || 'application/octet-stream' });
    fs.createReadStream(alvo).pipe(res);
  });
}

// ---- checagens dentro da pagina ----
// Roda no navegador. Devolve numeros, nao opinioes: a prancha mostra a foto,
// aqui so o que da pra afirmar por geometria.
function checarNaPagina() {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const W = innerWidth;
  const rolagemHorizontal = document.documentElement.scrollWidth > W + 1;
  // fora da tela: so o que esta no fluxo. Drawer/painel fixo fica fora de
  // proposito (nasce escondido a esquerda), e overlay fechado tambem
  // tabela, quadro e grade dentro de uma caixa com rolagem horizontal PROPRIA
  // podem ser mais largos que a tela - e' a regra do app (overflow-x:auto na
  // caixa). O que nao pode e' a PAGINA rolar de lado
  const dentroDeRolagem = (el) => { for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) { const o = getComputedStyle(n).overflowX; if (o === 'auto' || o === 'scroll') return true; } return false; };
  // filho de drawer/painel fixo (que nasce escondido fora da tela) tambem fica
  // fora - sem isso o menu ☰ recolhido acusava 3 "fora da tela" em toda tela
  const dentroDeFlutuante = (el) => { for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) { const p = getComputedStyle(n).position; if (p === 'fixed' || p === 'absolute') return true; } return false; };
  let foraDaTela = 0;
  const foraEx = [];
  for (const el of document.body.querySelectorAll('*')) {
    if (!vis(el)) continue;
    const pos = getComputedStyle(el).position;
    if (pos === 'fixed' || pos === 'absolute') continue;
    if (dentroDeRolagem(el) || dentroDeFlutuante(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.right > W + 1 || r.left < -1) { foraDaTela++; if (foraEx.length < 3) foraEx.push((el.tagName + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : '')).slice(0, 40)); }
  }
  // sobreposicao: filhos DIRETOS de uma faixa (flex/grid) que se cobrem. E'
  // assim que "Ate" com o botao dentro da coluna e' pego - dois irmaos que
  // deveriam estar lado a lado ocupando o mesmo lugar
  let sobrepostos = 0;
  const sobEx = [];
  for (const caixa of document.body.querySelectorAll('*')) {
    const d = getComputedStyle(caixa).display;
    if (!/flex|grid/.test(d)) continue;
    const filhos = [...caixa.children].filter((c) => vis(c) && !/absolute|fixed/.test(getComputedStyle(c).position)).map((c) => ({ c, r: c.getBoundingClientRect() }));
    for (let i = 0; i < filhos.length; i++) for (let j = i + 1; j < filhos.length; j++) {
      const a = filhos[i].r, b = filhos[j].r;
      const dx = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const dy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (dx > 4 && dy > 4) { sobrepostos++; if (sobEx.length < 3) sobEx.push((filhos[i].c.tagName + '+' + filhos[j].c.tagName + ' em ' + caixa.tagName + (caixa.id ? '#' + caixa.id : '') + (typeof caixa.className === 'string' && caixa.className ? '.' + caixa.className.split(' ')[0] : '')).slice(0, 60)); }
    }
  }
  const textoVisivel = (document.body.innerText || '').replace(/\s+/g, ' ').trim().length;
  return { rolagemHorizontal, foraDaTela, foraEx, sobrepostos, sobEx, textoVisivel };
}

// ---- PNG: decodificar e codificar sem dependencia (so o que o Playwright gera: RGBA 8 bits, sem entrelacar) ----
function lerPng(buf) {
  let p = 8; let w = 0, h = 0, corTipo = 6; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p); const tipo = buf.toString('ascii', p + 4, p + 8); const dados = buf.subarray(p + 8, p + 8 + len);
    if (tipo === 'IHDR') { w = dados.readUInt32BE(0); h = dados.readUInt32BE(4); corTipo = dados[9]; if (dados[8] !== 8 || (corTipo !== 2 && corTipo !== 6) || dados[12] !== 0) throw new Error('PNG fora do formato esperado (RGB/RGBA 8 bits, sem entrelaçar)'); }
    if (tipo === 'IDAT') idat.push(dados);
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  // o Chromium grava RGB (tipo 2); RGBA (tipo 6) tambem entra. Sai sempre RGBA
  const bpp = corTipo === 2 ? 3 : 4, stride = w * bpp; const out = Buffer.alloc(w * h * 4);
  let ant = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]; const lin = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)); const cur = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = ant[i], c = i >= bpp ? ant[i - bpp] : 0; let v = lin[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
      cur[i] = v & 255;
    }
    if (bpp === 4) cur.copy(out, y * stride);
    else for (let x = 0; x < w; x++) { out[(y * w + x) * 4] = cur[x * 3]; out[(y * w + x) * 4 + 1] = cur[x * 3 + 1]; out[(y * w + x) * 4 + 2] = cur[x * 3 + 2]; out[(y * w + x) * 4 + 3] = 255; }
    ant = cur;
  }
  return { w, h, dados: out };
}
function crc32(buf) { let c, crc = 0xffffffff; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
function escreverPng(w, h, rgba) {
  const chunk = (tipo, dados) => { const len = Buffer.alloc(4); len.writeUInt32BE(dados.length); const td = Buffer.concat([Buffer.from(tipo, 'ascii'), dados]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// compara duas fotos; devolve % de pixels diferentes e a imagem de diferenca
// (o que mudou em vermelho sobre a foto atual esmaecida)
function comparar(a, b) {
  const w = Math.min(a.w, b.w), h = Math.min(a.h, b.h);
  const out = Buffer.alloc(w * h * 4); let dif = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const ia = (y * a.w + x) * 4, ib = (y * b.w + x) * 4, io = (y * w + x) * 4;
    const d = Math.abs(a.dados[ia] - b.dados[ib]) + Math.abs(a.dados[ia + 1] - b.dados[ib + 1]) + Math.abs(a.dados[ia + 2] - b.dados[ib + 2]);
    if (d > 48) { dif++; out[io] = 255; out[io + 1] = 40; out[io + 2] = 40; out[io + 3] = 255; }
    else { const g = (b.dados[ib] + b.dados[ib + 1] + b.dados[ib + 2]) / 3; out[io] = out[io + 1] = out[io + 2] = 90 + g * 0.5; out[io + 3] = 255; }
  }
  const pct = (100 * dif) / (w * h);
  return { pct, tamanhoMudou: a.w !== b.w || a.h !== b.h, png: escreverPng(w, h, out) };
}

// ---- a varredura ----
(async () => {
  const { chromium } = playwright();
  fs.mkdirSync(BASE, { recursive: true }); fs.mkdirSync(ATUAL, { recursive: true });
  const srv = servidor(); await new Promise((r) => srv.listen(0, r)); const porta = srv.address().port;
  const exec = chromiumExec();
  const navegador = await chromium.launch(exec ? { executablePath: exec } : {});
  const telas = fs.readdirSync(RAIZ).filter((f) => f.endsWith('.html')).filter((f) => !SO || SO.some((s) => f.startsWith(s))).sort();
  const linhas = []; let problemas = 0, mudaram = 0;
  const t0 = Date.now();
  for (const vp of VIEWPORTS) {
    const ctx = await navegador.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: !!vp.isMobile, hasTouch: !!vp.hasTouch, deviceScaleFactor: 1, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
    await ctx.addInitScript(() => { try { localStorage.setItem('authToken', 'fake'); } catch (e) { /* ok */ } });
    for (const tela of telas) {
      const pg = await ctx.newPage();
      const erros = [];
      // guarda a LINHA do erro: "undefined (reading 'x')" sem a linha obriga a
      // abrir o navegador na mao pra descobrir de onde veio
      pg.on('pageerror', (e) => {
        const m = String(e.stack || '').match(/\.html:(\d+):(\d+)/);
        let onde = '';
        if (m) { try { const L = fs.readFileSync(path.join(RAIZ, tela), 'utf8').split('\n'); onde = ` [linha ${m[1]}: ${(L[+m[1] - 1] || '').trim().slice(0, 70)}]`; } catch (e2) { /* ok */ } }
        erros.push(String(e.message).slice(0, 120) + onde);
      });
      pg.on('dialog', (d) => d.dismiss().catch(() => {}));
      const chave = `${tela.replace(/\.html$/, '')}.${vp.nome}`;
      const linha = { tela, vp: vp.nome, chave, erros, checks: null, foto: null, base: null, diff: null, pct: null, avisos: [] };
      try {
        await pg.goto(`http://127.0.0.1:${porta}/${tela}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await pg.waitForTimeout(1100);
        linha.checks = await pg.evaluate(checarNaPagina);
        const fotoBuf = await pg.screenshot({ clip: { x: 0, y: 0, width: vp.width, height: ALTURA_FOTO }, fullPage: true });
        linha.foto = path.join(ATUAL, chave + '.png'); fs.writeFileSync(linha.foto, fotoBuf);
        const baseArq = path.join(BASE, chave + '.png');
        if (ACEITAR) { fs.copyFileSync(linha.foto, baseArq); linha.base = baseArq; }
        else if (fs.existsSync(baseArq)) {
          linha.base = baseArq;
          const r = comparar(lerPng(fs.readFileSync(baseArq)), lerPng(fotoBuf));
          linha.pct = r.pct; linha.diff = path.join(ATUAL, chave + '.diff.png'); fs.writeFileSync(linha.diff, r.png);
          if (r.pct > LIMIAR_DIFF || r.tamanhoMudou) { linha.avisos.push(`mudou ${r.pct.toFixed(2)}%${r.tamanhoMudou ? ' (tamanho)' : ''}`); mudaram++; }
        } else linha.avisos.push('sem referência (rode --aceitar)');
        const c = linha.checks;
        if (erros.length) linha.avisos.push(`erro JS: ${erros[0]}`);
        if (c.rolagemHorizontal) linha.avisos.push('rolagem horizontal');
        if (c.foraDaTela) linha.avisos.push(`${c.foraDaTela} fora da tela (${c.foraEx.join(', ')})`);
        if (c.sobrepostos) linha.avisos.push(`${c.sobrepostos} sobreposição (${c.sobEx.join(', ')})`);
        if (erros.length || c.rolagemHorizontal || c.foraDaTela || c.sobrepostos) problemas++;
      } catch (e) { linha.avisos.push('não abriu: ' + String(e.message).slice(0, 80)); problemas++; }
      linhas.push(linha);
      const marca = linha.avisos.length ? (linha.avisos.some((a) => /mudou|sem referência/.test(a)) && linha.avisos.length === 1 ? '~' : '✗') : '✓';
      console.log(`${marca} ${chave.padEnd(34)} ${linha.avisos.join(' · ')}`);
      await pg.close();
    }
    await ctx.close();
  }
  await navegador.close(); srv.close();

  // ---- a prancha ----
  const rel = (p) => p ? path.relative(SAIDA, p).split(path.sep).join('/') : '';
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const card = (l) => {
    const ruim = l.avisos.some((a) => !/mudou|sem referência/.test(a));
    const mudou = l.avisos.some((a) => /^mudou/.test(a));
    return `<section class="card ${ruim ? 'ruim' : mudou ? 'mudou' : 'ok'}">
      <h3>${esc(l.chave)} <small>${ruim ? '✗ problema' : mudou ? '~ mudou' : '✓'}</small></h3>
      ${l.avisos.length ? `<ul>${l.avisos.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>` : ''}
      <div class="fotos">
        ${l.base ? `<figure><figcaption>referência</figcaption><img src="${esc(rel(l.base))}"></figure>` : ''}
        ${l.foto ? `<figure><figcaption>agora</figcaption><img src="${esc(rel(l.foto))}"></figure>` : ''}
        ${l.diff ? `<figure><figcaption>o que mudou (${l.pct.toFixed(2)}%)</figcaption><img src="${esc(rel(l.diff))}"></figure>` : ''}
      </div></section>`;
  };
  // problema primeiro, depois o que mudou, depois o que esta igual
  const ordem = (l) => (l.avisos.some((a) => !/mudou|sem referência/.test(a)) ? 0 : l.avisos.some((a) => /^mudou/.test(a)) ? 1 : 2);
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Varredura visual · NoPulso</title>
<style>body{margin:0;padding:20px;background:#0b0d10;color:#e7ecf1;font:13px Arial,sans-serif}h1{font-size:18px;margin:0 0 4px}.sub{color:#8c99a7;margin-bottom:16px}
.card{border:1px solid #27313b;border-left:4px solid #27313b;border-radius:10px;padding:10px 12px;margin-bottom:12px;background:#12161b}.card.ruim{border-left-color:#ff6b6b}.card.mudou{border-left-color:#ffbd59}.card.ok{opacity:.75}
h3{margin:0 0 6px;font-size:13px;font-family:monospace}h3 small{color:#8c99a7;font-weight:400;margin-left:8px}ul{margin:0 0 8px;padding-left:18px;color:#ffbd59}.card.ruim ul{color:#ff6b6b}
.fotos{display:flex;gap:10px;overflow-x:auto}figure{margin:0;flex:none}figcaption{font-size:10px;color:#8c99a7;margin-bottom:3px;text-transform:uppercase;letter-spacing:.04em}img{display:block;max-height:320px;border:1px solid #27313b;border-radius:6px;background:#000}
.card.ok img{max-height:120px}</style></head><body>
<h1>Varredura visual</h1><div class="sub">${linhas.length} fotos · ${problemas} com problema · ${mudaram} mudaram de aparência · ${new Date().toLocaleString('pt-BR')} · ${Math.round((Date.now() - t0) / 1000)}s</div>
${linhas.slice().sort((a, b) => ordem(a) - ordem(b)).map(card).join('\n')}
</body></html>`;
  fs.writeFileSync(path.join(SAIDA, 'prancha.html'), html);

  console.log(`\n${linhas.length} fotos · ${problemas} com problema · ${mudaram} mudaram · prancha: docs/varredura/prancha.html`);
  if (ACEITAR) console.log('Referência gravada em docs/varredura/base/.');
  process.exit(problemas ? 1 : (ESTRITO && mudaram ? 1 : 0));
})().catch((e) => { console.error('Varredura falhou:', e.message); process.exit(2); });
