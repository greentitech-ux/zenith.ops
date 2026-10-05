'use strict';
const assert = require('assert/strict');
const vigia = require('./vigiaScript');
const fonte = vigia.montarScriptVigia({ codigo: 'TESTE', posto: 'teste', token: 'token-teste', tipo: 'interno' });

function medidas(texto = fonte) {
  const m = texto.match(/\(\$cx - (\d+) \* \$e\) \$y \((\d+) \* \$e\) \((\d+) \* \$e\).*?\$y \+= (\d+) \* \$e/s);
  if (!m) return null;
  return { esquerda: Number(m[1]), largura: Number(m[2]), altura: Number(m[3]), bloco: Number(m[4]) };
}

const atual = medidas();
assert.deepEqual(atual, { esquerda: 308, largura: 616, altura: 196, bloco: 280 });
assert.equal(atual.largura, 440 * 1.4);
assert.equal(atual.altura, 140 * 1.4);
assert.equal(atual.esquerda * 2, atual.largura, 'logo permanece centralizada');
assert.ok(vigia.VERSAO_VIGIA >= 143, 'o agente instalado precisa baixar a mudança');
assert.throws(() => assert.deepEqual(medidas(fonte.replace('616 * $e', '440 * $e')), atual), 'sabotagem: tamanho antigo precisa reprovar');
console.log('✓ Modelo básico: logo do grupo 40% maior, centralizada e com espaço proporcional.');
