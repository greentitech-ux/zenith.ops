// fraudIdentity.js
// Cruza o nome do cliente (shopper) com o nome impresso no cartao pra ligar
// pedidos que, olhados isoladamente, pareceriam de pessoas diferentes - mas
// na pratica sao o mesmo anel de fraude usando nomes/cartoes diferentes a
// cada tentativa. Exemplo real: um pedido tem nomeCliente "Thais Mendes" e
// cardHolder "Luciano Jose"; outro pedido tem nomeCliente "Luciano Silva" e
// cardHolder "Thais M Mendes" - os nomes se cruzam entre os dois campos
// (shopper de um bate com o cartao do outro), entao viram o mesmo cluster
// de identidade mesmo sem nenhum nome ser identico.
//
// ATENCAO ao mexer nas regras de ligacao abaixo. A versao anterior ligava
// dois pedidos por UM UNICO termo de 3+ letras em comum. Em nome brasileiro
// isso junta o mundo inteiro: "Silva" aparece em ~10% da populacao, "Santos"
// em ~7%, e "Ana"/"Maria"/"Jose" sao igualmente comuns. Medido com trafego
// legitimo simulado (ver testeRotas.js): do 2o pedido do dia em diante TODO
// pedido caia no mesmo cluster, e 98,5% dos pedidos legitimos acabavam
// marcados como FRAUDE. Tres travas impedem isso de voltar:
//   1. ligar exige sobreposicao FORTE (ver deveLigar) - nunca um termo so
//      que seja comum no movimento do dia;
//   2. o cluster e POR UNIDADE - cliente de Recife nao e cliente de SP;
//   3. cluster que passa de MAX_PEDIDOS_CLUSTER e tratado como defeito, nao
//      como anel de fraude: para de valer como identidade.
//
// Guarda tudo em memoria com uma janela de tempo (igual ao cardHopping.js/
// cardTesting.js) - nao precisa persistir, e so pra ligar atividade recente.
const JANELA_MS = 24 * 60 * 60 * 1000; // 24h - liga pedidos recentes com nomes cruzados

// termo visto em >= esse numero de pedidos DISTINTOS da unidade na janela e
// considerado comum (sobrenome/prenome popular): sozinho ele nao liga nada
const LIMIAR_TERMO_COMUM = 4;

// acima disso o "cluster" deixou de ser um anel de fraude e virou defeito:
// nenhum ataque real usa dezenas de nomes distintos na mesma loja em 24h,
// mas um bug de ligacao chega la em minutos
const MAX_PEDIDOS_CLUSTER = 12;

// Sobrenomes e prenomes mais comuns no Brasil. NAO e uma lista de suspeitos:
// e o contrario - termo que esta aqui NAO identifica ninguem sozinho, entao
// nunca pode, por si so, ligar dois pedidos. Sem isso a malha so descobre
// que "Silva" e comum depois de ver 4 Silvas, e ate la ja ligou o dia todo
// num cluster so (era exatamente esse o defeito).
const TERMOS_COMUNS = new Set([
  // sobrenomes
  'silva', 'santos', 'oliveira', 'souza', 'sousa', 'rodrigues', 'ferreira',
  'alves', 'pereira', 'lima', 'gomes', 'costa', 'ribeiro', 'martins',
  'carvalho', 'almeida', 'lopes', 'soares', 'fernandes', 'vieira', 'barbosa',
  'rocha', 'dias', 'nascimento', 'andrade', 'moreira', 'nunes', 'marques',
  'machado', 'freitas', 'cardoso', 'ramos', 'goncalves', 'santana',
  'teixeira', 'araujo', 'correia', 'correa', 'cavalcanti', 'cavalcante',
  'monteiro', 'cruz', 'melo', 'mello', 'pinto', 'campos', 'cunha', 'batista',
  'moraes', 'morais', 'azevedo', 'miranda', 'reis', 'duarte', 'borges',
  'medeiros', 'castro', 'franca', 'sales', 'farias', 'pinheiro', 'aguiar',
  'sampaio', 'brito', 'matos', 'coelho', 'pires', 'xavier', 'magalhaes',
  'tavares', 'guimaraes', 'leite', 'assis', 'bezerra', 'macedo', 'neves',
  'lira', 'leal', 'maia', 'rezende', 'resende', 'moura', 'siqueira', 'braga',
  // prenomes
  'maria', 'jose', 'ana', 'joao', 'antonio', 'francisco', 'carlos', 'paulo',
  'pedro', 'lucas', 'luiz', 'luis', 'marcos', 'marcelo', 'rafael', 'daniel',
  'bruno', 'eduardo', 'felipe', 'rodrigo', 'manoel', 'gabriel', 'mateus',
  'matheus', 'sebastiao', 'andre', 'fernando', 'fabio', 'leonardo',
  'gustavo', 'thiago', 'tiago', 'vinicius', 'igor', 'juliana', 'fernanda',
  'patricia', 'aline', 'camila', 'amanda', 'bruna', 'jessica', 'leticia',
  'julia', 'luciana', 'vanessa', 'mariana', 'gabriela', 'larissa', 'cristina',
  'sandra', 'adriana', 'simone', 'carla', 'renata', 'andrea', 'monica',
  'claudia', 'beatriz', 'bianca', 'debora', 'priscila', 'rosa', 'francisca',
  'antonia', 'marcia', 'raimundo', 'geraldo', 'roberto', 'ricardo', 'sergio',
]);

// o quanto os DOIS nomes precisam se parecer no conjunto (Jaccard: termos em
// comum / termos no total). Dois clientes distintos que dividem sobrenome
// ficam la embaixo ("Ana Paula Silva Santos" x "Bruno Silva Santos" = 2/5 =
// 0,40); o mesmo cliente ou o anel que cruza shopper x cartao passa fácil
// ("Thais Mendes"/"Luciano Jose" x "Luciano Silva"/"Thais M Mendes" = 3/5 =
// 0,60). Sozinho isso nao basta - ver deveLigar.
const LIMIAR_SIMILARIDADE = 0.5;

const STOPWORDS = new Set([
  'de', 'da', 'do', 'das', 'dos', 'e',
  // tratamentos e abreviacoes que aparecem no nome impresso no cartao e nao
  // identificam ninguem
  'sr', 'sra', 'dr', 'dra', 'jr', 'neto', 'filho', 'junior',
]);

function normalizarTexto(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// termos com 3+ letras, ignorando preposicoes/conectivos - "Thais", "Mendes",
// "Luciano", "Silva" contam; "de", "da" nao contam
function tokensSignificativos(nome) {
  return normalizarTexto(nome).split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

let proximoId = 1;
const clusters = new Map(); // id -> {id, unidade, pedidos:Set, tokens:Set, nomeContagem:Map, ultimaAtividade, saturado}
const tokenParaClusters = new Map(); // "unidade|token" -> Set<clusterId>
const freqTermo = new Map(); // "unidade|token" -> Set<pedidoId> (quantos pedidos distintos usaram o termo)

function chaveEscopo(unidade, token) {
  return `${unidade == null ? '' : unidade}|${token}`;
}

function limparAntigos() {
  const agora = Date.now();
  for (const [id, c] of clusters) {
    if (agora - c.ultimaAtividade > JANELA_MS) {
      c.tokens.forEach((t) => {
        const chave = chaveEscopo(c.unidade, t);
        const ids = tokenParaClusters.get(chave);
        if (!ids) return;
        ids.delete(id);
        if (!ids.size) {
          tokenParaClusters.delete(chave);
          freqTermo.delete(chave);
        }
      });
      clusters.delete(id);
    }
  }
}

// termo que ja apareceu em muitos pedidos distintos desta unidade nao
// identifica ninguem - e so um sobrenome/prenome popular do movimento
function termoComum(unidade, token) {
  if (TERMOS_COMUNS.has(token)) return true; // comum no pais, vale desde o 1o pedido
  const vistos = freqTermo.get(chaveEscopo(unidade, token));
  return !!vistos && vistos.size >= LIMIAR_TERMO_COMUM; // comum NESTA loja
}

// A regra de ligacao. Dois pedidos so viram a MESMA identidade quando a
// sobreposicao dos nomes e forte o bastante pra nao ser coincidencia:
//   - 3+ termos em comum liga sempre (é o caso do anel de fraude que cruza
//     shopper x cartao: "Thais Mendes"/"Luciano Jose" x "Luciano Silva"/
//     "Thais M Mendes" compartilha thais+mendes+luciano);
//   - 2 termos ligam se pelo menos UM deles nao for comum no movimento
//     ("Ana Silva Souza" x "Ana Silva Santos" compartilha ana+silva, os dois
//     comuns -> NAO liga, sao dois clientes diferentes);
//   - 1 termo so liga se ele for raro ("Thais" numa loja onde so essa pessoa
//     se chama Thais liga; "Silva" nunca liga).
function deveLigar(unidade, compartilhados, tokensPedido, tokensCluster) {
  if (!compartilhados.length) return false;

  // 1) os nomes tem que se PARECER como conjunto, nao so ter termo em comum.
  // Sem isso, "Ana Paula Silva Santos" e "Bruno Silva Santos" viram a mesma
  // pessoa por dividirem dois sobrenomes comuns.
  const uniao = new Set([...tokensPedido, ...tokensCluster]).size;
  const similaridade = uniao ? compartilhados.length / uniao : 0;
  if (similaridade < LIMIAR_SIMILARIDADE) return false;

  // 2) e pelo menos UM dos termos em comum tem que identificar alguem. Se a
  // coincidencia inteira e feita de nome comum (ana + silva), nao da pra
  // afirmar que sao a mesma pessoa - e afirmar errado aqui marca cliente
  // legitimo como fraudador.
  return compartilhados.some((t) => !termoComum(unidade, t));
}

// nome mais frequente do cluster vira o "nome representativo" (o que
// aparece mais vezes entre nomeCliente/cardHolder de todos os pedidos
// ligados) - normalmente e o nome real da pessoa, os outros sao variacoes/
// cartoes emprestados/roubados
function nomeRepresentativo(cluster) {
  let melhor = null;
  let melhorContagem = -1;
  cluster.nomeContagem.forEach((qtd, nome) => {
    if (qtd > melhorContagem) {
      melhor = nome;
      melhorContagem = qtd;
    }
  });
  return melhor;
}

function novoCluster(unidade) {
  const c = {
    id: proximoId++,
    unidade: unidade == null ? null : unidade,
    pedidos: new Set(),
    tokens: new Set(),
    nomeContagem: new Map(),
    ultimaAtividade: Date.now(),
    saturado: false,
  };
  clusters.set(c.id, c);
  return c;
}

function indexar(cluster, tokens, pedidoId) {
  tokens.forEach((t) => {
    cluster.tokens.add(t);
    const chave = chaveEscopo(cluster.unidade, t);
    if (!tokenParaClusters.has(chave)) tokenParaClusters.set(chave, new Set());
    tokenParaClusters.get(chave).add(cluster.id);
    if (!freqTermo.has(chave)) freqTermo.set(chave, new Set());
    freqTermo.get(chave).add(pedidoId);
  });
}

// registra um pedido (nome do cliente + nome do cartao) na malha de
// identidades cruzadas e devolve o cluster resolvido. `unidade` escopa a
// malha: a mesma pessoa em duas lojas diferentes sao duas identidades, o
// que e o certo pra deteccao (um ataque acontece numa loja) e evita que
// sobrenome comum junte o pais inteiro.
//
// Devolve null quando nao da pra afirmar identidade nenhuma: sem termo
// aproveitavel, ou cluster saturado (ver MAX_PEDIDOS_CLUSTER). Quem chama
// TEM que tratar null como "nao sei", nunca como "nao e fraude".
function registrarPedido(pedidoId, nomeCliente, cardHolder, unidade) {
  limparAntigos();
  const nomes = [nomeCliente, cardHolder].filter(Boolean);
  const todosTokens = new Set();
  nomes.forEach((n) => tokensSignificativos(n).forEach((t) => todosTokens.add(t)));
  if (!todosTokens.size) return null;
  const tokens = [...todosTokens];

  // candidatos: clusters desta unidade que compartilham algum termo. Conta
  // QUANTOS termos cada um compartilha, pra decidir com a regra forte.
  const compartilhadosPorCluster = new Map(); // clusterId -> [tokens]
  tokens.forEach((t) => {
    const ids = tokenParaClusters.get(chaveEscopo(unidade, t));
    if (!ids) return;
    ids.forEach((id) => {
      if (!compartilhadosPorCluster.has(id)) compartilhadosPorCluster.set(id, []);
      compartilhadosPorCluster.get(id).push(t);
    });
  });

  // so o MELHOR candidato entra (mais termos em comum). A versao anterior
  // fundia TODOS os clusters que tocassem qualquer termo - era essa fusao em
  // cadeia que transformava o dia inteiro num cluster so.
  let melhor = null;
  let melhorQtd = 0;
  compartilhadosPorCluster.forEach((compartilhados, id) => {
    const c = clusters.get(id);
    if (!c || c.saturado) return;
    if (!deveLigar(unidade, compartilhados, tokens, c.tokens)) return;
    if (compartilhados.length > melhorQtd) {
      melhor = c;
      melhorQtd = compartilhados.length;
    }
  });

  const cluster = melhor || novoCluster(unidade);

  nomes.forEach((n) => cluster.nomeContagem.set(n, (cluster.nomeContagem.get(n) || 0) + 1));
  indexar(cluster, tokens, pedidoId);
  cluster.pedidos.add(pedidoId);
  cluster.ultimaAtividade = Date.now();

  // trava final: se mesmo com a regra forte um cluster explodiu, e defeito -
  // ele para de valer como identidade em vez de marcar meia loja como fraude
  if (cluster.pedidos.size > MAX_PEDIDOS_CLUSTER) {
    if (!cluster.saturado) {
      cluster.saturado = true;
      console.warn(
        `[fraudIdentity] cluster ${cluster.id} (${unidade || 'sem unidade'}) passou de ${MAX_PEDIDOS_CLUSTER} pedidos `
        + `com ${cluster.nomeContagem.size} nomes distintos - tratando como defeito de ligacao, nao como fraude.`
      );
    }
    return null;
  }

  return {
    clusterId: cluster.id,
    unidade: cluster.unidade,
    nomes: [...cluster.nomeContagem.keys()],
    nomesDistintos: cluster.nomeContagem.size,
    totalPedidos: cluster.pedidos.size,
    nomeRepresentativo: nomeRepresentativo(cluster),
  };
}

const limpeza = setInterval(limparAntigos, 5 * 60 * 1000);
limpeza.unref(); // nao impede o processo de encerrar (ex: em testes)

module.exports = {
  registrarPedido,
  tokensSignificativos,
  LIMIAR_TERMO_COMUM,
  LIMIAR_SIMILARIDADE,
  MAX_PEDIDOS_CLUSTER,
  TERMOS_COMUNS,
};
