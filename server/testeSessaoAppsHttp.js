'use strict';
// Reaproveita somente o bootstrap de banco falso da suíte geral. Porta livre,
// servidor/index.js real e middleware real; nenhum serviço externo é usado.
const assert = require('node:assert/strict');
async function testar({ http, DOCS, port }) {
  const bcrypt = require('bcryptjs');
  DOCS.set('users/loja-sso', { email: 'loja-sso@teste.local', username: 'loja-sso', passwordHash: await bcrypt.hash('SenhaTeste!2026', 10), role: 'user', active: true, temPalavraRecuperacao: true, permissions: { sections: ['tarefas'], unidades: ['NOC_TESTE'] } });
  function pedir(caminho, { host = 'www.nopulso.com.br', token, cookie, body, method = 'POST', origin = 'https://' + host } = {}) {
    return new Promise((resolve, reject) => {
      const dados = JSON.stringify(body || {});
      const req = http.request({ host: '127.0.0.1', port, path: caminho, method, headers: { Host: host, Origin: origin, ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(dados) } }, res => {
        let texto = ''; res.on('data', c => texto += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(texto) }));
      });
      req.on('error', reject); req.setTimeout(10000, () => req.destroy(new Error('Timeout local'))); req.end(dados);
    });
  }
  const login = await pedir('/api/auth/login', { body: { identifier: 'loja-sso', password: 'SenhaTeste!2026' } });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  const token = login.data.token;
  const cookie = login.headers['set-cookie'].find(v => v.startsWith('__Secure-nopulsoSessao=')).split(';')[0];
  assert(login.headers['set-cookie'].some(v => /HttpOnly/.test(v) && /Secure/.test(v) && /SameSite=Strict/.test(v)));
  const atendimento = await pedir('/api/auth/sessao-apps', { host: 'atendimento.nopulso.com.br', cookie });
  assert.equal(atendimento.status, 200);
  assert.equal(atendimento.data.token, token);
  const perfil = await pedir('/api/me', { host: 'atendimento.nopulso.com.br', token, method: 'GET' });
  assert.equal(perfil.status, 200);
  assert.equal(perfil.data.role, 'user');
  assert.equal((await pedir('/api/meta/endereco-antigo', { token, method: 'GET' })).status, 403, 'SSO não concede Master');
  assert.equal((await pedir('/api/me', { cookie, method: 'GET' })).status, 401, 'Cookie não autentica APIs de negócio');
  assert.equal((await pedir('/api/auth/sessao-apps', { cookie, origin: 'https://malicioso.test' })).status, 403);
  assert.equal((await pedir('/api/auth/sair', { host: 'atendimento.nopulso.com.br', cookie, token })).status, 200);
  assert.equal((await pedir('/api/auth/sessao-apps', { cookie })).status, 401);
  assert.equal((await pedir('/api/me', { token, method: 'GET' })).status, 401, 'A mesma sessão foi revogada nos dois domínios');
  console.log('✓ HTTP real: senha + NOC, cookie, outro domínio, perfil comum, Master recusado e revogação.');
}
module.exports = { testar };
if (require.main === module) {
  process.env.JWT_SECRET = 'teste-http-sessao-apps-nao-producao';
  process.env.ENCRYPTION_KEY = '11'.repeat(32);
  const fs = require('node:fs'), path = require('node:path'), net = require('node:net'), Module = require('node:module');
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1', () => {
    const port = probe.address().port;
    probe.close(() => {
      const arquivo = path.join(__dirname, 'testeRotas.js');
      const fonte = fs.readFileSync(arquivo, 'utf8').split('setTimeout(async () => {')[0].replace(/\b8899\b/g, String(port));
      const m = new Module(arquivo, module); m.filename = arquivo; m.paths = module.paths;
      m._compile(fonte + `\nsetTimeout(()=>require('./testeSessaoAppsHttp').testar({http,DOCS,port:${port}}).then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)}),2500);`, arquivo);
    });
  });
}
