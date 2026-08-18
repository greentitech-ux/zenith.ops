// ouiFabricantes.js
// Fabricante do aparelho a partir do prefixo OUI do MAC (os 3 primeiros
// bytes identificam quem fabricou a placa de rede - mesma tecnica dos
// scanners de rede tipo Advanced IP Scanner). Pedido do Master: nos
// "aparelhos na rede da loja" do NOC Zenith, aparelho sem nome DNS/apelido
// deve mostrar o fabricante em vez de "sem nome".
//
// A tabela (ouiFabricantes.json, ~40 mil prefixos) foi gerada a partir da
// base de OUIs do Wireshark (registro oficial do IEEE) - e um dado publico
// e estavel: prefixo atribuido nao muda de dono, so surgem novos. Fica em
// memoria (~1,3MB) carregada uma vez no boot; a consulta e um lookup O(1).
const TABELA = require('./ouiFabricantes.json');

function fabricanteDe(mac) {
  const limpo = String(mac || '').toLowerCase().replace(/[^0-9a-f]/g, '');
  if (limpo.length < 6) return null;
  // MAC aleatorio/local (2o digito 2/6/a/e - bit "localmente administrado"):
  // o prefixo e inventado pelo aparelho, nao aponta pra fabricante nenhum
  if (['2', '6', 'a', 'e'].includes(limpo[1])) return null;
  return TABELA[limpo.slice(0, 6)] || null;
}

module.exports = { fabricanteDe };
