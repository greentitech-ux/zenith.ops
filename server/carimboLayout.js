// carimboLayout.js
// ONDE O CARIMBO DO PAPEL DE PAREDE FICA NA ARTE. Fonte unica da verdade:
// o vigiaScript.js le daqui e injeta os numeros no PowerShell que a maquina
// roda. Mexer no carimbo e mexer NESTE arquivo - nao no meio do script.
//
// Documentacao para humanos: docs/CARIMBO.md (as medidas sao as mesmas).
//
// DOIS BLOCOS INDEPENDENTES, cada um no seu slot reservado da arte:
//   unidade  - regua ambar + nome da LOJA
//   etiqueta - a placa branca com o codigo da maquina (DOM-MC-ATM01)
// Ate a arte de setembro/2026 a etiqueta vinha empilhada embaixo do nome da
// loja; agora ela tem slot proprio no meio da arte, e os dois nao se falam.
//
// ESCALA: todo numero aqui e' pixel na resolucao de referencia (base). A
// maquina multiplica tudo por $esc = largura_da_arte / largura_de_referencia.
// Com a proporcao preservada isso equivale a usar porcentagem da altura, e
// serve 2560x1440 / 1366x768 sem nenhum numero novo.
//
// FONTE: o desenho pede Barlow/Barlow Condensed. Elas NAO existem no Windows
// das lojas e aqui nao ha navegador (isto e' System.Drawing em PowerShell),
// entao 'familias' e' uma lista de tentativa em ordem - a primeira instalada
// vence. Trocar a ordem aqui muda o que a loja ve.
const FAMILIAS_CONDENSADA = ['Barlow Condensed SemiBold', 'Barlow Condensed', 'Oswald', 'Segoe UI Semibold', 'Arial Narrow'];

const CARIMBO_LAYOUT = {
  horizontal: {
    base: { largura: 1920, altura: 1080 },
    // regua + nome da loja, encostados na direita
    unidade: { margemDireita: 84, topo: 70, fonte: 50, gap: 10, reguaW: 88, reguaH: 3 },
    // placa branca centralizada, dentro do card "OFERECA ESSA AVENTURA"
    etiqueta: { topo: 575, fonte: 46, raio: 12, padX: 26, padY: 8, espacamento: 0.14, sombraY: 10 },
  },
  vertical: {
    base: { largura: 1080, altura: 1920 },
    unidade: { topo: 1669, fonte: 46, gap: 18, reguaW: 88, reguaH: 3 },
    etiqueta: { topo: 651, fonte: 58, raio: 14, padX: 34, padY: 10, espacamento: 0.14, sombraY: 10 },
  },
  cores: {
    regua: '#e0a33e',
    nomeLoja: '#ffffff',
    etiquetaFundo: '#ffffff',
    etiquetaTexto: '#0a4f79',
  },
  familias: { condensada: FAMILIAS_CONDENSADA },
};

module.exports = { CARIMBO_LAYOUT };
