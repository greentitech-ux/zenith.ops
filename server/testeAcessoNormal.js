'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { montarScriptVigia, VERSAO_VIGIA } = require('./vigiaScript');
const ler = nome => fs.readFileSync(path.join(__dirname, 'public', nome), 'utf8');
const compat = ler('sessao-unidade.js');
const removidos = [];
const armazenamento = {removeItem: chave => removidos.push(chave)};
vm.runInNewContext(compat, {window:{}, localStorage:armazenamento, location:{replace(){throw Error('Redirecionamento automático');}}});
assert.deepEqual(removidos.sort(), ['nopulso.unidade','nopulso.unidade.atividade'].sort());
assert.doesNotMatch(compat, /authToken|setInterval|setTimeout/);
assert.doesNotMatch(ler('tema.js'), /sessao-unidade\.js|__zenithUnidadeChat/);
assert.doesNotMatch(ler('loja-status.html'), /novo-comp-chat-unidade|editar-comp-chat-unidade/);
assert.doesNotMatch(ler('unidade.html'), /Colaborador|Abrir chat|acesso-unidade/);
assert.match(ler('suporte-chat.js'), /if \(!token\) return null/);
assert.ok(VERSAO_VIGIA >= 140);
function conferirAgente(ps) {
  assert.doesNotMatch(ps, /api\/acesso-unidade\/vinculo|launcher da unidade/);
  assert.match(ps, /atalho-nopulso-original\.lnk/);
  assert.match(ps, /\$areas -notcontains/);
  assert.match(ps, /Copy-Item -LiteralPath \$backup -Destination \$alvo/);
}
const ps = montarScriptVigia({codigo:'TESTE',posto:'PC',tipo:'interno',agentToken:'abcdef',acessoChatUnidade:true});
conferirAgente(ps);
assert.throws(() => conferirAgente(ps.replace('Copy-Item -LiteralPath $backup -Destination $alvo', 'REMOVIDO')), 'A sabotagem deve ser detectada');
console.log('✓ Acesso normal preservado: suporte sem identidade automática, sessão intacta, portal retirado e restauração de atalho protegida.');
