'use strict';
// Navegador real, páginas reais, rede integralmente interceptada e contas falsas.
// Não acessa o NoPulso de produção nem instala apps no Windows.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const { chromium } = require('playwright');
const sso = require('./sessaoApps');
process.env.JWT_SECRET = 'teste-navegador-sessao-apps-sem-producao';
const publicDir = path.join(__dirname, 'public');
const me = { id: 'loja', role: 'user', email: 'loja@teste.local', temPalavraRecuperacao: true, permissions: { sections: [] }, unidades: ['LOJA'] };
const revogadas = new Set(), rotas = new Map();
let logins = 0;
sso.registrar({ post: (rota, fn) => rotas.set(rota, fn) }, {
  auth: { usuarioOpcionalDoToken: async token => revogadas.has(jwt.verify(token, process.env.JWT_SECRET).sid) ? null : me },
  sessions: { encerrar: async sid => revogadas.add(sid) },
});
function resposta() {
  return {
    codigo: 200, headers: { 'content-type': 'application/json' },
    set(k, v) { this.headers[k] = v; }, status(c) { this.codigo = c; return this; }, json(b) { this.corpo = JSON.stringify(b); },
    cookie(k, v, op) { this.headers['set-cookie'] = `${k}=${v}; Domain=${op.domain}; Path=${op.path}; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(op.maxAge / 1000)}`; },
    clearCookie(k, op) { this.cookie(k, '', { ...op, maxAge: 0 }); },
  };
}
async function interceptar(route) {
  const request = route.request(), url = new URL(request.url());
  const headers = await request.allHeaders();
  const req = { headers: { ...headers, host: url.host }, body: request.postData() ? JSON.parse(request.postData()) : {} };
  const res = resposta();
  if (rotas.has(url.pathname)) {
    await rotas.get(url.pathname)(req, res);
    return route.fulfill({ status: res.codigo, headers: res.headers, body: res.corpo });
  }
  if (url.pathname === '/api/auth/login') {
    logins++;
    const token = jwt.sign({ sub: me.id, sid: 'sessao-' + logins, role: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    sso.gravar(req, res, token);
    res.json({ token, user: me });
    return route.fulfill({ headers: res.headers, body: res.corpo });
  }
  if (url.pathname === '/api/me') return route.fulfill({ json: me });
  if (url.pathname === '/api/beniboy/acesso') return route.fulfill({ json: { permitido: false, destino: '/atendimento/meu' } });
  if (url.pathname.startsWith('/api/')) return route.fulfill({ json: {} });
  if (['/tarefas', '/atendimento/meu'].includes(url.pathname)) {
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><script src="/tema.js"></script><h1>Área autenticada de teste</h1><button onclick="NoPulsoSessao.sair()">Sair</button>' });
  }
  const nome = url.pathname === '/' ? 'index.html' : url.pathname === '/atendimento/entrar' ? 'atendimento.html' : url.pathname.slice(1);
  const arquivo = path.resolve(publicDir, nome);
  if (!arquivo.startsWith(publicDir + path.sep) || !fs.existsSync(arquivo) || !fs.statSync(arquivo).isFile()) return route.fulfill({ status: 404, body: '' });
  const tipos = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
  return route.fulfill({ contentType: tipos[path.extname(arquivo)] || 'application/octet-stream', body: fs.readFileSync(arquivo) });
}
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true });
  try {
    const context = await browser.newContext();
    await context.route('**/*', interceptar);
    await context.addInitScript(() => localStorage.setItem('passkeyOferecidoAte', String(Date.now() + 86400000)));
    const principal = await context.newPage(), suporte = await context.newPage();
    await principal.goto('https://www.nopulso.com.br/');
    await principal.locator('#auth-email').fill('loja');
    await principal.locator('#auth-password').fill('senha-teste');
    await principal.locator('#auth-btn').click();
    await principal.waitForURL('**/tarefas');
    const token = await principal.evaluate(() => localStorage.getItem('authToken'));
    await suporte.goto('https://atendimento.nopulso.com.br/atendimento/entrar');
    await suporte.waitForURL('**/atendimento/meu');
    assert.equal(await suporte.evaluate(() => localStorage.getItem('authToken')), token);
    assert.equal(logins, 1, 'Abriu Atendimento sem um segundo login');
    const cookies = await context.cookies();
    const cookie = cookies.find(c => c.name === sso.COOKIE);
    assert(cookie.httpOnly && cookie.secure && cookie.sameSite === 'Strict');
    await suporte.getByRole('button', { name: 'Sair', exact: true }).click();
    await suporte.waitForURL('**/atendimento/entrar');
    await principal.goto('https://www.nopulso.com.br/');
    await principal.waitForFunction(() => !document.getElementById('auth-btn').disabled);
    assert.equal(await principal.evaluate(() => localStorage.getItem('authToken')), null);
    // Caminho inverso: login pelo Atendimento e abertura pelo ícone preto.
    await suporte.locator('#portal-usuario').fill('loja');
    await suporte.locator('#portal-senha').fill('senha-teste');
    await suporte.locator('#portal-entrar').click();
    await suporte.waitForURL('**/atendimento/meu');
    await principal.goto('https://www.nopulso.com.br/');
    await principal.waitForURL('**/tarefas');
    assert.equal(logins, 2);
    assert.equal(await principal.evaluate(() => localStorage.getItem('authToken')), await suporte.evaluate(() => localStorage.getItem('authToken')));
    // Outro perfil não deve herdar a conta de um navegador diferente.
    const isolado = await browser.newContext();
    await isolado.route('**/*', interceptar);
    const visitante = await isolado.newPage();
    await visitante.goto('https://atendimento.nopulso.com.br/atendimento/entrar');
    await visitante.waitForFunction(() => !document.getElementById('portal-entrar').disabled);
    assert.equal(await visitante.evaluate(() => localStorage.getItem('authToken')), null);
    console.log('✓ Chrome real: login nas duas direções, mesma sessão, saída compartilhada e isolamento entre perfis.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
