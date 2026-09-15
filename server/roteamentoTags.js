// roteamentoTags.js
//
// QUEM CUIDA DE QUÊ. Um lugar só.
//
// Pedido do Master (14/09/2026): "as solicitações pelo beniboy precisamos
// fazer o máximo para automatizar elas; caso não dê, ela é direcionada para
// quem tem a tag dela". Antes, o que o Beniboy não resolvia caía na Central e
// esperava alguém passar por lá - um ticket de TI e um de manutenção tinham
// exatamente o mesmo destino, que era "o time".
//
// A regra é uma frase: o ASSUNTO tem uma TAG, a tag tem PESSOAS, e a pessoa
// recebe. Nada aqui inventa cargo nem rótulo - as tags são as de
// users.CARGOS_VALIDOS e os assuntos são os tipos que a Central já usa
// (solicitacoes.js) mais o pedido do agregador (agregadorFila.js).
//
// O que NÃO tem tag continua indo pra Central, como sempre foi. Isso é de
// propósito: compra, pagamento e nota são decisão de dinheiro, e o Master
// não delegou essas a ninguém. Quando delegar, é uma linha nesta tabela - e
// por isso ela vive aqui, e não espalhada em três arquivos.
const users = require('./users');

// assunto -> { tag, rotulo, url }
// `url` é pra onde o push leva quem recebeu: a tela onde o trabalho é feito.
const ASSUNTOS = {
  'suporte-ti': { tag: 'tecnico', rotulo: 'Suporte de TI', url: '/tecnico.html' },
  manutencao: { tag: 'manutencao', rotulo: 'Manutenção', url: '/manutencao.html' },
  agregador: { tag: 'coordenador-agregador', rotulo: 'Agregador (iFood/99food)', url: '/beniboy.html' },
};

function tagDoAssunto(assunto) {
  const a = ASSUNTOS[String(assunto || '').toLowerCase()];
  return a ? a.tag : null;
}

// Quem deve receber este assunto agora.
//
// Devolve sempre o mesmo formato, inclusive quando não há ninguém - quem
// chama nunca precisa de if pra saber se a tabela tem a linha:
//   { assunto, tag, rotulo, url, pessoas, dono }
//
// `dono` é quem vai no `direcionadoParaId` da solicitação, e só existe quando
// há UMA pessoa com a tag. Com duas ou mais, o ticket fica sem dono e todas
// são avisadas: escolher uma no par ou ímpar entrega o chamado pra quem pode
// estar de férias, e o outro deixa de olhar porque "já tem responsável".
async function destinoDe(assunto) {
  const chave = String(assunto || '').toLowerCase();
  const cfg = ASSUNTOS[chave] || null;
  if (!cfg) return { assunto: chave, tag: null, rotulo: null, url: null, pessoas: [], dono: null };
  const pessoas = await users.listarPorTag(cfg.tag);
  return {
    assunto: chave,
    tag: cfg.tag,
    rotulo: cfg.rotulo,
    url: cfg.url,
    pessoas,
    dono: pessoas.length === 1 ? pessoas[0] : null,
  };
}

// só pra tela/log: "Técnico (2 pessoas)" / "Manutenção (ninguém com a tag)"
function descreverDestino(destino) {
  if (!destino || !destino.tag) return 'Central (sem tag para esse assunto)';
  if (!destino.pessoas.length) return `${destino.rotulo} · ninguém com a tag ainda`;
  if (destino.dono) return `${destino.rotulo} · ${destino.dono.nome}`;
  return `${destino.rotulo} · ${destino.pessoas.length} pessoas`;
}

module.exports = { ASSUNTOS, tagDoAssunto, destinoDe, descreverDestino };
