// procedimentosSocorro.js
// CATALOGO DE PROCEDIMENTOS DE SOCORRO - o que se copia e cola NA MAQUINA.
//
// Pedido do Master (22/09/2026): "tudo que resolver um problema vamos criar um
// processo, organize o tipo da solucao para nao ficar um scroll imenso e ficar
// olhando um a um para saber o que faz".
//
// Dai o formato de cada item: ele diz QUANDO usar antes de dizer o que faz. Na
// hora do aperto a pergunta e "qual destes e o meu caso?", nao "o que este
// comando executa". A tela agrupa por categoria e abre fechado, entao a lista
// pode crescer sem virar rolagem.
//
// REGRA PRA CRESCER: cada procedimento so entra aqui depois de ter resolvido um
// problema DE VERDADE, com o caso que o originou escrito no campo `origem`.
// Procedimento inventado "por precaucao" e o que faz catalogo virar entulho -
// ninguem confia, ninguem usa, e na emergencia se lê um a um do mesmo jeito.
const socorroRede = require('./socorroRedeScript');
const reparoNocZenith = require('./reparoNocZenithScript');

// A ordem aqui e a ordem na tela. Rede vem primeiro porque maquina muda no NOC
// e o caso mais comum - e o unico em que nenhum comando do NOC alcanca ela.
const CATEGORIAS = [
  { id: 'rede', icone: '🌐', rotulo: 'Rede e internet' },
  { id: 'agente', icone: '🤖', rotulo: 'Agente NOCZenith' },
];

function listarProcedimentos(baseUrl) {
  return [
    {
      id: 'socorro-dns',
      categoria: 'rede',
      titulo: 'Socorro de rede e DNS',
      quando: 'A máquina sumiu do NOC, mas o AnyDesk chega nela.',
      faz: 'Mostra placa, IP, gateway e DNS. Se o DNS atual já resolve, não altera nada. '
        + 'Se não resolve, troca para 1.1.1.1 e 8.8.8.8, limpa o cache e testa.',
      cuidado: 'Com DNS público, nome interno da loja (servidor, impressora, pasta compartilhada) '
        + 'pode parar de resolver. O próprio comando mostra como voltar ao que era.',
      precisaAdmin: true,
      origem: 'MMTIROL-PDV01, 22/09/2026: 10h fora do NOC porque o DNS configurado parou de responder.',
      comando: socorroRede.montarComandoSocorroRede(),
    },
    {
      id: 'reparo-noczenith',
      categoria: 'agente',
      titulo: 'Reparar o NOCZenith',
      quando: 'O agente está instalado mas não reporta, ou ficou numa versão inválida.',
      faz: 'Baixa o reparo público, confere o conteúdo antes de executar e reinstala '
        + 'preservando a identidade da máquina. Tenta o endereço oficial e o adyen-monitor.',
      cuidado: 'Precisa de internet na máquina. Se ela não resolve DNS, use antes o socorro de rede.',
      precisaAdmin: true,
      origem: 'Agentes derrubados por versão inválida; o endereço duplo veio do DNS restrito de 22/09/2026.',
      comando: reparoNocZenith.montarComandoReparoNocZenith(baseUrl),
    },
  ];
}

// Agrupado como a tela mostra: categoria vazia nao aparece, entao a lista de
// categorias pode ganhar entradas antes de existir procedimento nelas.
function listarPorCategoria(baseUrl) {
  const itens = listarProcedimentos(baseUrl);
  return CATEGORIAS
    .map((c) => ({ ...c, procedimentos: itens.filter((p) => p.categoria === c.id) }))
    .filter((c) => c.procedimentos.length);
}

module.exports = { CATEGORIAS, listarProcedimentos, listarPorCategoria };
