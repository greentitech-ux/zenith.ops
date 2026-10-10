'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

function testarDestinos(mod) {
  const anterior = process.env.ATENDIMENTO_HOST;
  try {
    process.env.ATENDIMENTO_HOST = 'atendimento.exemplo.test';
    assert.deepEqual(mod.navegacao('https://painel.exemplo.test'), {
      nopulso: 'https://painel.exemplo.test/', atendimento: 'https://atendimento.exemplo.test/atendimento/central',
    });
    for (const base of ['javascript:alert(1)', 'http://painel.test', 'https://user:senha@painel.test', 'https://painel.test/?token=secreto', 'https://painel.test/#token', 'https://painel.test/caminho', 'inválido']) {
      assert.equal(mod.navegacao(base).nopulso, null, 'Destino inseguro: ' + base);
    }
    process.env.ATENDIMENTO_HOST = 'atendimento.test/?token=secreto';
    assert.equal(mod.navegacao('https://painel.test').atendimento, null);
  } finally { if (anterior === undefined) delete process.env.ATENDIMENTO_HOST; else process.env.ATENDIMENTO_HOST = anterior; }
}
function testarSabotagem() {
  testarDestinos(require('./centralSubdominio'));
  const arquivo = path.join(__dirname, 'centralSubdominio.js');
  const codigo = fs.readFileSync(arquivo, 'utf8');
  const mutado = codigo.replace("if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.pathname !== '/')", 'if (false)');
  assert.notEqual(mutado, codigo);
  const mod = new Module(arquivo, module); mod.filename = arquivo; mod.paths = module.paths; mod._compile(mutado, arquivo);
  assert.throws(() => testarDestinos(mod.exports), /Destino inseguro/);
  console.log('✓ Destinos fixos, HTTPS sem credenciais/query/fragmento; sabotagem detectada.');
}
async function testarHttp({ DOCS, pedir, postarJson, token }) {
  const auth = require('./auth');
  const senha = 'SenhaDeTeste!2026';
  DOCS.set('users/navegacao-comum', {
    passwordHash: require('bcryptjs').hashSync(senha, 4), role: 'user', active: true,
    email: 'navegacao@teste.local', username: 'navegacao',
    permissions: { sections: [], unidades: [], vaultSubgroups: [], tiposSolicitacao: [] },
    createdAt: new Date().toISOString(),
  });
  const comum = (await auth.login('navegacao@teste.local', senha)).token;
  const headers = { Authorization: 'Bearer ' + comum };
  assert.equal((await pedir('/api/beniboy/acesso')).status, 401);
  assert.equal((await pedir('/api/beniboy/acesso', { Authorization: 'Bearer invalido' })).status, 401);
  const r = await pedir('/api/beniboy/acesso?returnTo=https://externo.test&token=ignorado', { ...headers, Host: 'externo.test' });
  assert.equal(r.status, 200, r.corpo);
  const d = JSON.parse(r.corpo);
  assert.equal(d.permitido, false);
  assert.equal(d.destino, '/atendimento/meu');
  assert.deepEqual(d.enderecos, require('./centralSubdominio').navegacao(process.env.APP_BASE_URL || 'https://www.nopulso.com.br'));
  assert(!r.corpo.includes(comum));
  const equipe = JSON.parse((await pedir('/api/beniboy/acesso', { Authorization: 'Bearer ' + token })).corpo);
  assert.equal(equipe.permitido, true); assert.equal(equipe.destino, '/atendimento/central');
  assert.equal((await pedir('/api/suporte-chats', headers)).status, 403, 'Usuário comum não recebe lista da equipe');
  assert.equal((await pedir('/api/meus-atendimentos')).status, 401);
  const suporte = require('./suporteChat');
  const base = { nome: 'Teste navegação', contato: 'teste@example.test', assunto: 'Computador', texto: 'Teste local' };
  const meu = await suporte.criar({ ...base, logado: { id: 'navegacao-comum' } });
  const outro = await suporte.criar({ ...base, logado: { id: 'outro-usuario' } });
  const lista = JSON.parse((await pedir('/api/meus-atendimentos', headers)).corpo);
  assert(lista.abertos.some(c => c.id === meu.id));
  assert(!lista.abertos.some(c => c.id === outro.id));
  assert.equal((await pedir('/api/meus-atendimentos/' + meu.id, headers)).status, 200);
  assert.equal((await pedir('/api/meus-atendimentos/' + outro.id, headers)).status, 404);
  assert.equal((await pedir('/api/meus-atendimentos/' + outro.id + '/anexo/0', headers)).status, 404);
  assert.equal((await postarJson('/api/meus-atendimentos/' + outro.id + '/mensagem', { texto: 'Não autorizado' }, headers)).status, 404);
  for (const rota of ['/atendimento-navegacao.js', '/meu-atendimento.js', '/atendimento/meu']) assert.equal((await pedir(rota)).status, 200, rota);
  console.log('✓ HTTP: anônimo/token inválido negados, comum separado da equipe, links sem sessão, leitura/resposta/anexos restritos ao dono.');
}
module.exports = { testarHttp, testarSabotagem };
if (require.main === module) testarSabotagem();
