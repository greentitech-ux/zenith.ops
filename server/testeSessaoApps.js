'use strict';
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const fs = require('node:fs');
const Module = require('node:module');
process.env.JWT_SECRET = 'teste-local-sessao-apps-nao-producao';
const modulo = require('./sessaoApps');
async function verificar(sso) {
  const rotas = new Map(), encerradas = new Set();
  let bloqueado = false;
  sso.registrar({ post: (rota, handler) => rotas.set(rota, handler) }, {
    auth: { usuarioOpcionalDoToken: async token => {
      const p = jwt.verify(token, process.env.JWT_SECRET);
      return !bloqueado && !encerradas.has(p.sid) ? { id: p.sub, role: 'user', unidades: ['LOJA'] } : null;
    } },
    sessions: { encerrar: async sid => encerradas.add(sid) },
  });
  const token = jwt.sign({ sub: 'loja', sid: 'mesma-sessao', role: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  async function chamar({ host = 'www.nopulso.com.br', origin = 'https://' + host, cookie, bearer, migrar = false, sair = false, site = 'same-origin' } = {}) {
    const req = { headers: { host, origin, 'sec-fetch-site': site, ...(cookie ? { cookie } : {}), ...(bearer ? { authorization: 'Bearer ' + bearer } : {}) }, body: { migrar } };
    const res = { codigo: 200, cookies: [], set() {}, status(c) { this.codigo = c; return this; }, json(b) { this.corpo = b; return this; }, cookie(nome, valor, opcoes) { this.cookies.push({ nome, valor, opcoes }); }, clearCookie(nome, opcoes) { this.limpou = { nome, opcoes }; } };
    await rotas.get(sair ? '/api/auth/sair' : '/api/auth/sessao-apps')(req, res);
    return res;
  }
  const primeiro = await chamar({ bearer: token, migrar: true });
  assert.equal(primeiro.codigo, 200);
  assert.equal(primeiro.corpo.token, token);
  assert.equal(primeiro.cookies[0].opcoes.httpOnly, true);
  assert.equal(primeiro.cookies[0].opcoes.secure, true);
  assert.equal(primeiro.cookies[0].opcoes.sameSite, 'strict');
  assert(primeiro.cookies[0].opcoes.maxAge <= 3600000);
  const cookie = sso.COOKIE + '=' + token;
  for (const host of ['atendimento.nopulso.com.br', 'nopulso.com.br', 'www.nopulso.com.br']) {
    const r = await chamar({ host, cookie });
    assert.equal(r.codigo, 200);
    assert.equal(r.corpo.token, token, 'não cria nem eleva outra sessão');
  }
  assert.equal((await chamar({ bearer: token })).codigo, 401, 'não ressuscita localStorage antigo');
  assert.equal((await chamar({ host: 'outro.nopulso.com.br', cookie })).codigo, 403);
  assert.equal((await chamar({ origin: 'https://outro.nopulso.com.br', cookie })).codigo, 403);
  assert.equal((await chamar({ site: 'cross-site', cookie })).codigo, 403);
  assert.equal((await chamar({ origin: '', cookie })).codigo, 403);
  assert.equal((await chamar({ cookie: cookie + '; ' + cookie })).codigo, 401);
  assert.equal((await chamar({ cookie: sso.COOKIE + '=invalido', bearer: token, migrar: true })).codigo, 401);
  const semSid = jwt.sign({ sub: 'master', role: 'master' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  assert.equal((await chamar({ bearer: semSid, migrar: true })).codigo, 401);
  const vencido = jwt.sign({ sub: 'loja', sid: 'vencida' }, process.env.JWT_SECRET, { expiresIn: -1 });
  assert.equal((await chamar({ cookie: sso.COOKIE + '=' + vencido })).codigo, 401);
  bloqueado = true;
  assert.equal((await chamar({ cookie })).codigo, 401, 'respeita bloqueio, senha e horários da validação existente');
  bloqueado = false;
  const saida = await chamar({ host: 'atendimento.nopulso.com.br', cookie, sair: true });
  assert.equal(saida.codigo, 200);
  assert(saida.limpou);
  assert(encerradas.has('mesma-sessao'));
  assert.equal((await chamar({ cookie })).codigo, 401, 'Sair revoga o acesso no outro app');
  assert.equal((await chamar({ bearer: token, migrar: true })).codigo, 401);
}
(async () => {
  await verificar(modulo);
  // Sabotagem em memória: remover a lista fechada de hosts precisa reprovar.
  const arquivo = require.resolve('./sessaoApps');
  const sabotado = new Module(arquivo, module);
  sabotado.filename = arquivo; sabotado.paths = module.paths;
  sabotado._compile(fs.readFileSync(arquivo, 'utf8').replace('HOSTS.has(host) &&', ''), arquivo);
  await assert.rejects(() => verificar(sabotado.exports), assert.AssertionError);
  console.log('✓ Sessão única nos dois sentidos, migração, expiração, revogação, origem, cookies e sabotagem.');
})().catch(e => { console.error(e); process.exitCode = 1; });
