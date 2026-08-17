// redes.js
// A qual REDE cada unidade pertence: ARCFOOD ou GBE (Grupo Bravo).
//
// Existe porque essa divisão era repetida em três lugares com regras
// diferentes: o checklist de permissões (classificarUnidade em index.js), o
// filtro da tela de Fechamentos (lista BRAVO fixa no HTML) e nada no
// relatório. A lista fixa tinha um defeito silencioso: loja nova não entrava
// em nenhum dos dois grupos e sumia do filtro sem ninguém perceber.
//
// A regra aqui é o inverso: ARCFOOD é uma lista FECHADA (são 4 lojas, de uma
// operação específica, e isso não muda sozinho); GBE é o RESTO. Assim loja
// nova nasce no GBE, que é o comportamento certo por padrão - e o dia que
// entrar uma ARCFOOD nova, é uma linha aqui.
'use strict';

const ARCFOOD = 'ARCFOOD';
const GBE = 'GBE';

const REDES = [
  { id: GBE, nome: 'Grupo Bravo (GBE)' },
  { id: ARCFOOD, nome: 'ARCFOOD' },
];
const NOME_DA_REDE = Object.fromEntries(REDES.map((r) => [r.id, r.nome]));

// Mooca, Tatuapé, Carrão e São Miguel. Os codigos numericos sao os do
// Fechamento; os demais sao como as MESMAS lojas aparecem em outros espacos
// de dados (Adyen/Monitor) - a mesma loja fisica tem codigo diferente em
// cada sistema, e a rede tem que ser a mesma nos dois (ver UNIDADES_APELIDOS
// em index.js).
const CODIGOS_ARCFOOD = new Set([
  '19821', '19855', '19888', '19889',
  'Sao Miguel', 'Carrao', 'Mooca', 'Tatuape',
  'DOM__19821', 'DOM__19855', 'DOM___19888', 'DOM_19889',
]);

// unidade sem codigo nao tem rede - devolver GBE aqui faria lixo virar
// linha do Grupo Bravo no relatorio
function redeDaUnidade(codigo) {
  const c = String(codigo == null ? '' : codigo).trim();
  if (!c) return null;
  return CODIGOS_ARCFOOD.has(c) ? ARCFOOD : GBE;
}

const ehArcfood = (codigo) => redeDaUnidade(codigo) === ARCFOOD;

// separa uma lista de registros (fechamentos, linhas de comparativo...) nas
// duas redes, na ordem de REDES. `campo` diz onde esta o codigo da unidade.
// Rede sem nenhum registro NAO entra: secao vazia no relatorio e ruido, e
// faz parecer que a rede existe mas nao faturou - quando o filtro da tela
// simplesmente nao incluiu ela.
function agruparPorRede(registros, campo = 'unidade') {
  return REDES
    .map((rede) => ({
      ...rede,
      itens: (registros || []).filter((r) => redeDaUnidade(r && r[campo]) === rede.id),
    }))
    .filter((g) => g.itens.length);
}

module.exports = { ARCFOOD, GBE, REDES, NOME_DA_REDE, CODIGOS_ARCFOOD, redeDaUnidade, ehArcfood, agruparPorRede };
