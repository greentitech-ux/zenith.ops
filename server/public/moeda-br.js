// Formatação VISUAL compartilhada por telas, relatórios e avisos.
// Nunca usar para valores de inputs, cálculos, armazenamento ou payloads bancários.
(function (raiz, criar) {
  const api = criar();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.NoPulsoMoeda = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const formatos = new Map();
  function numero(valor, casas = 2) {
    const n = Number(valor);
    const seguro = Number.isFinite(n) ? n : 0;
    // Arredonda apenas a apresentação; o número original permanece intocado.
    const arredondado = Number(seguro.toFixed(casas));
    const minimo = Math.abs(arredondado) >= 1000 && Number.isInteger(arredondado) ? 0 : casas;
    const chave = casas + ':' + minimo;
    if (!formatos.has(chave)) formatos.set(chave, new Intl.NumberFormat('pt-BR', {
      useGrouping: true, minimumFractionDigits: minimo, maximumFractionDigits: casas,
    }));
    return formatos.get(chave).format(Object.is(arredondado, -0) ? 0 : arredondado);
  }
  function formatar(valor, casas = 2) {
    const n = Number(valor);
    return (Number.isFinite(n) && Number(n.toFixed(casas)) < 0 ? '-' : '') + 'R$ ' + numero(Math.abs(n), casas);
  }
  return Object.freeze({ numero, formatar });
});
