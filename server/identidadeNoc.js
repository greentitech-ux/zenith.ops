'use strict';

// Identidade visual, NÃO escopo de acesso. A prestadora atende o parque todo,
// mas isso não torna suas unidades propriedade de um cliente (nem vice-versa).
function ehSolutions(empresa) {
  return String(empresa && empresa.nome || '').trim().replace(/\s+/g, ' ').toLowerCase() === 'solutions ti tech';
}

function resolverIdentidade(codigo, empresas) {
  const ativas = (empresas || []).filter(e => !e.arquivada);
  const prestadoras = ativas.filter(ehSolutions);
  const prestadora = prestadoras.length === 1 ? prestadoras[0] : null;
  const vinculadas = ativas.filter(e => (e.unidades || []).includes(String(codigo || '').trim()));
  const clientes = vinculadas.filter(e => !ehSolutions(e));
  // Nunca escolher o primeiro por ordem alfabética em cadastro conflitante.
  const empresa = clientes.length === 1 && !vinculadas.some(ehSolutions) ? clientes[0]
    : clientes.length === 0 && vinculadas.length === 1 ? vinculadas[0] : null;
  return { empresa, prestadora };
}

module.exports = { resolverIdentidade };
