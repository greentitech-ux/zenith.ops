'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const PUBLICO = path.join(__dirname, 'public');
const SAIDA = path.join(__dirname, '../docs/varredura/navegacao');
const enderecos = { nopulso: 'https://painel.exemplo.test/', atendimento: 'https://atendimento.exemplo.test/atendimento/central' };
const usuario = { id: 'dono', username: 'Teste', role: 'user', temPalavraRecuperacao: true };
const conversa = { id: 'c1', numeroTicket: 123, assunto: 'Computador', status: 'ABERTO', mensagens: [{ de: 'visitante', texto: '<img src=x onerror=alert(1)>', em: '2026-10-09T18:00:00Z' }] };
async function executar() {
  fs.mkdirSync(SAIDA, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    async function ambiente(opcoes = {}) {
      const context = await browser.newContext({ viewport: { width: opcoes.width || 1280, height: 900 } });
      const estado = { chamadas: [], erros: [], acesso: opcoes.acesso || 200, urls: opcoes.urls || enderecos, equipe: !!opcoes.equipe };
      await context.addInitScript(({ token, tema }) => {
        if (token) localStorage.setItem('authToken', token);
        localStorage.setItem('zenithTema', tema);
      }, { token: opcoes.token === undefined ? 'sessao-local' : opcoes.token, tema: opcoes.tema || 'escuro' });
      await context.route('**/*', async route => {
        const req = route.request(), u = new URL(req.url()); estado.chamadas.push({ url: u.href, headers: req.headers(), method: req.method() });
        const json = (d, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(d) });
        if (u.pathname === '/api/beniboy/acesso') return json({ permitido: estado.equipe, destino: estado.equipe ? '/atendimento/central' : '/atendimento/meu', enderecos: estado.urls }, estado.acesso);
        if (u.pathname === '/api/me') return json(usuario, estado.acesso);
        if (u.pathname === '/api/auth/login') return json({ token: 'sessao-nova', user: usuario });
        if (u.pathname === '/api/meus-atendimentos') return json({ abertos: [conversa], ultimoEncerrado: null }, estado.acesso);
        if (u.pathname === '/api/meus-atendimentos/c1' || u.pathname === '/api/meu-atendimento/c1') return json(conversa, estado.acesso);
        if (u.pathname.startsWith('/api/')) return json([]);
        if (opcoes.semScript && u.pathname === '/atendimento-navegacao.js') return route.fulfill({ status: 503, body: '' });
        if (u.origin === 'https://painel.exemplo.test' && u.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<h1>NoPulso: destino valida sua própria sessão</h1>' });
        if (u.pathname === '/menu-teste') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<html><head><meta charset="utf-8"><style>body{font:14px Arial,sans-serif}</style></head><body><nav class="nav-panel"></nav><script src="/nav-menu.js"></script></body></html>' });
        if (u.pathname === '/navegacao-teste') return route.fulfill({ contentType: 'text/html', body: '<html><head></head><body><a data-area-destino="nopulso" hidden>NoPulso</a><script src="/atendimento-navegacao.js"></script></body></html>' });
        let nome = ({ '/atendimento/meu': 'meu-atendimento.html', '/atendimento/entrar': 'atendimento.html', '/atendimento/central': 'beniboy.html', '/': 'index.html' })[u.pathname] || u.pathname.slice(1);
        const arquivo = path.resolve(PUBLICO, nome);
        if (!arquivo.startsWith(PUBLICO + path.sep) || !fs.existsSync(arquivo) || fs.statSync(arquivo).isDirectory()) return route.fulfill({ status: 404, body: '' });
        let body = fs.readFileSync(arquivo);
        if (opcoes.sabotagem && nome === 'atendimento-navegacao.js') body = Buffer.from(body.toString().replace('if (!r.ok) return;', 'if (false) return;'));
        const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2' }[path.extname(arquivo)] || 'application/octet-stream';
        return route.fulfill({ contentType: mime, body });
      });
      const page = await context.newPage(); page.on('pageerror', e => estado.erros.push(e.message));
      return { context, page, estado };
    }
    for (const tema of ['escuro', 'claro']) for (const width of [320, 390, 768, 1280]) {
      const { context, page, estado } = await ambiente({ width, tema });
      await page.goto('https://atendimento.exemplo.test/atendimento/meu');
      const link = page.locator('[data-area-destino="nopulso"]'); await link.waitFor({ state: 'visible' });
      assert.equal(await link.getAttribute('href'), enderecos.nopulso);
      assert.equal(await link.getAttribute('target'), '_blank');
      assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
      await page.locator('[data-id="c1"]').click();
      await page.locator('#mensagem').fill('Rascunho que deve permanecer');
      assert.equal(await page.locator('.msg img').count(), 0, 'Mensagem não executa HTML');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'Sem rolagem horizontal');
      if (width === 390 && tema === 'escuro') {
        const novaAba = context.waitForEvent('page'); await link.click(); const destino = await novaAba;
        await destino.waitForLoadState('domcontentloaded');
        assert.equal(await destino.evaluate(() => window.opener), null);
        assert.equal(await page.locator('#mensagem').inputValue(), 'Rascunho que deve permanecer');
        assert.equal(page.url(), 'https://atendimento.exemplo.test/atendimento/meu');
        const navegou = estado.chamadas.find(c => c.url === enderecos.nopulso);
        assert(navegou && !navegou.headers.authorization && !navegou.headers.referer, 'Sem credenciais nem referência na navegação');
        await destino.close();
      }
      await page.screenshot({ path: path.join(SAIDA, `meus-atendimentos-${tema}-${width}.png`) });
      assert.deepEqual(estado.erros, []); await context.close();
    }
    async function sessaoRecusada(sabotagem = false) {
      const { context, page } = await ambiente({ acesso: 401, sabotagem });
      try {
        await page.goto('https://atendimento.exemplo.test/navegacao-teste');
        await page.evaluate(() => window.prepararNavegacaoAtendimento());
        assert.equal(await page.locator('[data-area-destino]').isVisible(), false, 'Sessão recusada não libera atalho');
      } finally { await context.close(); }
    }
    await sessaoRecusada();
    await assert.rejects(sessaoRecusada(true), /Sessão recusada não libera atalho/);
    for (const opcoes of [{ token: null }, { urls: { nopulso: 'javascript:alert(1)' } }, { urls: { nopulso: 'https://painel.test/?token=secreto' } }]) {
      const { context, page } = await ambiente(opcoes);
      await page.goto('https://atendimento.exemplo.test/atendimento/meu');
      await page.waitForTimeout(150);
      assert.equal(await page.locator('[data-area-destino]').isVisible(), false);
      await context.close();
    }
    // Os links secretos antigos continuam funcionando, sem virar sessão.
    {
      const { context, page } = await ambiente({ token: null });
      await page.goto('https://atendimento.exemplo.test/atendimento/meu#id=c1&token=legado');
      await page.locator('#mensagem').waitFor();
      assert.equal(await page.locator('[data-area-destino]').isVisible(), false); await context.close();
    }
    // Usuário comum que abre o atalho instalado não cai na Central da equipe.
    {
      const { context, page } = await ambiente();
      await page.goto('https://atendimento.exemplo.test/atendimento/central');
      await page.waitForURL('**/atendimento/meu'); await context.close();
    }
    for (const equipe of [false, true]) {
      const { context, page } = await ambiente({ token: null, equipe });
      await page.goto('https://atendimento.exemplo.test/atendimento/entrar');
      await page.locator('#portal-usuario').fill('teste'); await page.locator('#portal-senha').fill('senha-local');
      await page.locator('#portal-entrar').click();
      await page.waitForURL(equipe ? '**/atendimento/central' : '**/atendimento/meu');
      assert.equal(await page.evaluate(() => localStorage.getItem('authToken')), 'sessao-nova'); await context.close();
    }
    for (const width of [320, 390, 768, 1280]) {
      const { context, page } = await ambiente({ width });
      await page.goto('https://painel.exemplo.test/menu-teste');
      const link = page.locator('[data-area-destino="atendimento"]');
      await link.waitFor({ state: 'attached' });
      await page.waitForFunction(() => !!document.querySelector('[data-area-destino="atendimento"]').getAttribute('href'));
      await page.evaluate(() => window.abrirMenu());
      await link.waitFor({ state: 'visible' });
      await page.waitForFunction(() => document.querySelector('#nav-drawer').getBoundingClientRect().left >= -1);
      assert.equal(await link.getAttribute('href'), enderecos.atendimento);
      assert((await link.textContent()).includes('Voltar ao Atendimento ↗'));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.screenshot({ path: path.join(SAIDA, `menu-${width}.png`) }); await context.close();
    }
    {
      const { context, page } = await ambiente({ token: null, semScript: true });
      await page.goto('https://painel.exemplo.test/menu-teste');
      await page.evaluate(() => window.abrirMenu());
      assert.equal(await page.locator('[data-area-destino]').isVisible(), false, 'Sem script e sem sessão o link continua oculto');
      await context.close();
    }
    for (const width of [390, 1280]) {
      const { context, page } = await ambiente({ width, equipe: true });
      await page.goto('https://atendimento.exemplo.test/atendimento/central');
      await page.locator('#link-nopulso').waitFor({ state: 'visible' });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.screenshot({ path: path.join(SAIDA, `central-${width}.png`) }); await context.close();
    }
    console.log('✓ Navegador: 320/390/768/1280, claro/escuro, nova aba sem opener/token, rascunho, sessão recusada/anônima, URLs inválidas, legado, destinos por perfil e menu. Sabotagem detectada.');
  } finally { await browser.close(); }
}
executar().catch(e => { console.error(e); process.exitCode = 1; });
