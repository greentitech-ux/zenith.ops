// Saldo contábil dos movimentos registrados. Uma sangria não zera o caixa:
// desconta somente o valor efetivamente lançado. O fundo fixo não integra
// esta conta. Não altera lançamentos nem a conferência histórica das sangrias.
'use strict';

function centavos(valor) {
  const n = Number(valor);
  if (valor == null || valor === '' || !Number.isFinite(n)) throw new Error('Valor monetário inválido no saldo de caixa.');
  const c = Math.round((Math.abs(n) + Number.EPSILON) * 100) * Math.sign(n);
  if (!Number.isSafeInteger(c)) throw new Error('Valor monetário fora do limite seguro.');
  return c;
}

function calcular(itens, entradas, { inicio, ate } = {}) {
  const de = inicio && /^\d{4}-\d{2}-\d{2}$/.test(inicio) ? inicio : null;
  const corte = ate && /^\d{4}-\d{2}-\d{2}$/.test(ate) ? ate : null;
  const desde = de ? new Date(Date.parse(de + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10) : null;
  const grupos = new Map();
  function incluir(x, tipo) {
    if (!x.unidade) return;
    if (!grupos.has(x.unidade)) grupos.set(x.unidade, {
      unidade: x.unidade, unidadeNome: x.unidadeNome || x.unidade,
      grupo: x.grupo || null, entrou: 0, saiu: 0, retirado: 0, movimentos: 0,
    });
    const g = grupos.get(x.unidade);
    if (!g.grupo && x.grupo) g.grupo = x.grupo;
    if (!x.data || (de && x.data < de) || (corte && x.data > corte)) return;
    g[tipo] += centavos(x.valor);
    if (!Number.isSafeInteger(g[tipo])) throw new Error('Saldo fora do limite seguro.');
    g.movimentos++;
  }
  entradas.forEach(x => incluir(x, 'entrou'));
  itens.forEach(x => incluir(x, x.origem === 'sangria' ? 'retirado' : 'saiu'));
  let total = 0;
  const porUnidade = [...grupos.values()].map(g => {
    const base = { unidade: g.unidade, unidadeNome: g.unidadeNome, grupo: g.grupo, ate: corte };
    if (!g.movimentos) return { ...base, desde: null, semBase: true, entrou: null, saiu: null, retirado: null, valor: null };
    const saldo = g.entrou - g.saiu - g.retirado;
    total += saldo;
    if (!Number.isSafeInteger(saldo) || !Number.isSafeInteger(total)) throw new Error('Saldo fora do limite seguro.');
    return { ...base, desde, semBase: false, entrou: g.entrou / 100,
      saiu: g.saiu / 100, retirado: g.retirado / 100, valor: saldo / 100 };
  });
  porUnidade.sort((a, b) => a.unidadeNome.localeCompare(b.unidadeNome, 'pt-BR'));
  return { total: total / 100, inicio: de, ate: corte, porUnidade };
}

module.exports = { calcular };
