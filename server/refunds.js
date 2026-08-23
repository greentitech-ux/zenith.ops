// refunds.js
// Fila de solicitacoes de estorno. Dois jeitos de entrar nela:
// - origem "interno": um usuario Leitor pede estorno de um pedido Aprovado
//   (com uma observacao explicando o motivo), confirmando com a propria
//   senha (veja auth.verifyPassword, chamado em index.js antes de criar o
//   registro).
// - origem "cliente": o CLIENTE FINAL preenche um formulario publico (sem
//   login, ver estorno-cliente.html) contando os dados da venda (nao tem
//   acesso ao pspReference/pedidoId interno) e anexa o comprovante da
//   maquininha - mesmos campos do Google Forms que a empresa ja usava.
// De qualquer origem, o Master acompanha a mesma fila e Aprova (e executa o
// estorno na Adyen por fora) ou Rejeita (com um motivo).
const crypto = require('crypto');
const db = require('./firestore');
const { createCache } = require('./liveCache');
const ticketCounter = require('./ticketCounter');
const centralChat = require('./centralChat');

const refundsRef = db.collection('refundRequests');
// 'CONVERTIDO': o ticket saiu de Estorno e virou um dos tipos gerais (ver
// converterParaSolicitacao) - o registro fica de historico, quem continua a
// historia e o novo registro em solicitacoes.js (convertidoParaId)
const STATUSES = ['PENDENTE', 'APROVADO', 'REJEITADO', 'CONVERTIDO'];
// 'conversao': registro nascido de um ticket de outro tipo que virou Estorno
// (ver converterParaEstorno em solicitacoes.js) - os dados ja foram
// validados na criacao do ticket original, entao pula a validacao normal
const ORIGENS = ['interno', 'cliente', 'conversao'];

// andamento da EXECUCAO de verdade (o estorno em si na Adyen/Pix), depois que
// o pedido ja foi Aprovado - mesmo conceito/valores de
// solicitacoes.EXECUCAO_STATUSES, so faz sentido com status==='APROVADO'
const EXECUCAO_STATUSES = ['PENDENTE', 'EM_ANDAMENTO', 'FINALIZADO'];


async function create({
  pedidoId, unidade, unidadeNome, observacao, origem,
  motivoEstorno, motivoOutro, valorVenda, formaPagamento, bandeira, ultimos4,
  dataVenda, horaVenda, valorEstornar, nomeCliente, telefoneCliente, anexos,
  pixChave, pixNomeTitular, pixBanco, observacaoCliente,
  requestedById, requestedByEmail, direcionadoParaId, direcionadoParaEmail,
  numeroTicket, convertidoDeTipo, convertidoDeId, teste,
}) {
  origem = ORIGENS.includes(origem) ? origem : 'interno';

  if (origem === 'interno') {
    if (!pedidoId) throw new Error('pedidoId é obrigatório.');
    if (!String(observacao || '').trim()) throw new Error('Descreva o motivo do estorno.');
  } else if (origem === 'cliente') {
    if (!unidade) throw new Error('Selecione a loja onde comprou.');
    if (!motivoEstorno) throw new Error('Selecione o motivo do estorno.');
    if (motivoEstorno === 'Outro' && !String(motivoOutro || '').trim()) throw new Error('Explique o motivo do estorno.');
    if (valorVenda == null || valorVenda === '') throw new Error('Informe o valor total da venda.');
    if (!formaPagamento) throw new Error('Selecione a forma de pagamento.');
    if (!bandeira) throw new Error('Selecione a bandeira do cartão.');
    if (!dataVenda) throw new Error('Informe a data da venda.');
    if (valorEstornar == null || valorEstornar === '') throw new Error('Informe o valor a estornar.');
    if (!Array.isArray(anexos) || !anexos.length) throw new Error('Anexe o comprovante da maquininha.');
  }

  const doc = refundsRef.doc();
  const agora = new Date().toISOString();
  // numeroTicket normalmente e novo (Ticket #10000 em diante, sequencia unica
  // compartilhada com solicitacoes.js/fechamentosLive.js) - so vem
  // pre-definido quando esse registro nasce de uma conversao de outro ticket
  // (ver converterParaEstorno em solicitacoes.js), pra manter o mesmo numero
  const ticket = numeroTicket != null ? numeroTicket : await ticketCounter.proximoTicket();
  const registro = {
    id: doc.id,
    numeroTicket: ticket,
    // trilha de qual(is) tipo(s) esse ticket ja passou
    historicoTipos: [{ tipo: 'estorno', em: agora, porEmail: requestedByEmail || null }],
    // preenchido só quando esse registro NASCEU de uma conversão de outro
    // ticket (ver converterParaSolicitacao) - referencia de onde ele veio
    convertidoDeTipo: convertidoDeTipo || null,
    convertidoDeId: convertidoDeId || null,
    // preenchido quando ESSE ticket vira outro tipo (ver converterParaSolicitacao)
    // - status vira 'CONVERTIDO' e esses dois campos apontam pro registro que
    // continua a historia do ticket
    convertidoParaTipo: null,
    convertidoParaId: null,
    // marca visivel de "isso e teste" (ver users.js: qaMaster/qaUser) - o
    // acesso QA sempre grava aqui pra quem for atender/aprovar na Central
    // saber na hora que aquele ticket nao e um caso real
    teste: !!teste,
    origem,
    pedidoId: pedidoId || null,
    unidade: unidade || null,
    unidadeNome: unidadeNome || unidade || null,
    observacao: String(observacao || '').trim(),
    motivoEstorno: motivoEstorno || null,
    motivoOutro: motivoOutro ? String(motivoOutro).trim() : null,
    valorVenda: valorVenda != null && valorVenda !== '' ? Number(valorVenda) || 0 : null,
    formaPagamento: formaPagamento || null,
    bandeira: bandeira || null,
    ultimos4: ultimos4 ? String(ultimos4).slice(-4) : null,
    dataVenda: dataVenda || null,
    horaVenda: horaVenda || null,
    valorEstornar: valorEstornar != null && valorEstornar !== '' ? Number(valorEstornar) || 0 : null,
    nomeCliente: nomeCliente ? String(nomeCliente).trim().slice(0, 120) : null,
    telefoneCliente: telefoneCliente ? String(telefoneCliente).trim().slice(0, 30) : null,
    // dados pra devolver o dinheiro via Pix (alternativa ao estorno na propria
    // maquininha) - preenchidos pelo cliente no formulario publico, opcional
    pixChave: pixChave ? String(pixChave).trim().slice(0, 140) : null,
    pixNomeTitular: pixNomeTitular ? String(pixNomeTitular).trim().slice(0, 120) : null,
    pixBanco: pixBanco ? String(pixBanco).trim().slice(0, 80) : null,
    // observacao livre do cliente (distinta de `observacao`, que pra origem
    // 'cliente' e reconstruida em centralCards.js como o resumo formatado
    // pro time - aqui fica preservado so o texto que o cliente escreveu)
    observacaoCliente: observacaoCliente ? String(observacaoCliente).trim().slice(0, 1000) : null,
    anexos: Array.isArray(anexos) ? anexos : [],
    status: 'PENDENTE',
    requestedById: requestedById || null,
    requestedByEmail: requestedByEmail || null,
    // Master/Admin escolhido por quem lançou (opcional, ver grupos.js) - so
    // um "pra quem e mais direto", nao restringe quem mais pode decidir
    direcionadoParaId: direcionadoParaId || null,
    direcionadoParaEmail: direcionadoParaEmail || null,
    // notificacao (popup com som) fica ativa ate QUALQUER Master/Admin
    // sinalizar que viu - ver marcarNotificacaoVista
    notificacaoVista: false,
    notificacaoVistaPorEmail: null,
    notificacaoVistaPorUsername: null,
    notificacaoVistaEm: null,
    motivoDecisao: '',
    decidedByEmail: null,
    criadoEm: agora,
    decidedEm: null,
    // andamento da execucao, so preenchido (e so relevante) apos Aprovado -
    // ver EXECUCAO_STATUSES/atualizarExecucao
    execucaoStatus: null,
    execucaoPorNome: null,
    // link de acao pra alguem de fora resolver esse ticket (aprovar/rejeitar
    // OU avancar a execucao, dependendo do estado atual) sem precisar de
    // login - ver gerarLinkAcao/decidirComLink/atualizarExecucaoComLink e
    // ticket-publico.html. Diferente do tokenAcao de solicitacoes.js (que e
    // de uso unico, so pra decidir, e alimentado pelo relatorio por e-mail):
    // esse fica valido enquanto o ticket nao chegar num estado terminal, pra
    // o MESMO link servir a decisao e, depois, a execucao.
    linkAcao: null,
    linkAcaoGeradoEm: null,
    linkAcaoRevogado: false,
  };
  await doc.set(registro);
  refundsCache.invalidar();
  return registro;
}

async function marcarNotificacaoVista(id, { vistoPorEmail, vistoPorUsername }) {
  const ref = refundsRef.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Solicitação não encontrada.');
  await ref.update({ notificacaoVista: true, notificacaoVistaPorEmail: vistoPorEmail, notificacaoVistaPorUsername: vistoPorUsername || null, notificacaoVistaEm: new Date().toISOString() });
  refundsCache.invalidar();
  return getOne(id);
}

async function listAllUncached() {
  const snap = await refundsRef.orderBy('criadoEm', 'desc').get();
  return snap.docs.map((d) => d.data());
}
const refundsCache = createCache(listAllUncached, 5 * 60 * 1000);
const listAll = refundsCache.cached;


async function getOne(id) {
  const doc = await refundsRef.doc(id).get();
  return doc.exists ? doc.data() : null;
}

async function updateStatus(id, status, { motivoDecisao, decidedByEmail }) {
  if (!['APROVADO', 'REJEITADO'].includes(status)) throw new Error('Status inválido.');
  const ref = refundsRef.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Solicitação não encontrada.');
  const patch = {
    status,
    motivoDecisao: motivoDecisao || '',
    decidedByEmail,
    decidedEm: new Date().toISOString(),
  };
  // aprovar comeca o andamento de execucao em Pendente (ver EXECUCAO_STATUSES)
  if (status === 'APROVADO') patch.execucaoStatus = 'PENDENTE';
  await ref.update(patch);
  refundsCache.invalidar();
  return getOne(id);
}

// atualiza o andamento de execucao (Pendente/Em andamento/Finalizado) de um
// estorno ja Aprovado - mesmo espirito de solicitacoes.atualizarExecucao.
// porNome e opcional (quem mexeu - e-mail de quem esta logado, ou o nome que
// a pessoa digitou no link publico, ver atualizarExecucaoComLink)
async function atualizarExecucao(id, execucaoStatus, { porNome } = {}) {
  if (!EXECUCAO_STATUSES.includes(execucaoStatus)) throw new Error('Status de execução inválido.');
  const ref = refundsRef.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Solicitação não encontrada.');
  if (snap.data().status !== 'APROVADO') throw new Error('Só é possível atualizar o andamento de um estorno já aprovado.');
  const patch = { execucaoStatus };
  if (porNome) patch.execucaoPorNome = porNome;
  await ref.update(patch);
  refundsCache.invalidar();
  return getOne(id);
}

// true se o ticket ainda tem alguma acao pendente (decidir OU avancar a
// execucao) - usado tanto pra saber se vale a pena gerar/manter um link de
// acao quanto pra decidir, na pagina publica, se mostra botoes ou so o
// estado final somente-leitura
function podeAgirComLink(registro) {
  if (!registro) return false;
  if (registro.status === 'PENDENTE') return true;
  if (registro.status === 'APROVADO') return registro.execucaoStatus !== 'FINALIZADO';
  return false; // REJEITADO/CONVERTIDO - nada mais a fazer
}

// gera (ou renova) o link de acao pra alguem de fora resolver esse ticket
// sem login (ver ticket-publico.html) - ao contrario do tokenAcao de
// solicitacoes.js, nao exige status PENDENTE (so nao deixa gerar um link
// pra um ticket que ja nao tem mais nada a fazer) e NAO e de uso unico: o
// mesmo link continua valido depois de aprovar, pra a mesma pessoa (ou
// outra) avancar a execucao em seguida.
async function gerarLinkAcao(id) {
  const registro = await getOne(id);
  if (!registro) throw new Error('Solicitação não encontrada.');
  if (!podeAgirComLink(registro)) throw new Error('Esse ticket já foi resolvido, não há mais nada a fazer por link.');
  const linkAcao = crypto.randomBytes(24).toString('hex');
  await refundsRef.doc(id).update({ linkAcao, linkAcaoGeradoEm: new Date().toISOString(), linkAcaoRevogado: false });
  refundsCache.invalidar();
  return { linkAcao };
}

// invalida o link atual (ex: vazou, ou foi mandado pra pessoa errada) - gerar
// de novo com gerarLinkAcao cria outro token, o antigo para de funcionar na
// hora
async function revogarLinkAcao(id) {
  await refundsRef.doc(id).update({ linkAcaoRevogado: true });
  refundsCache.invalidar();
  return getOne(id);
}

// confere o link recebido em ticket-publico.html - devolve o registro se
// bater e nao tiver sido revogado, null em qualquer outro caso (mesmo
// espirito de rh.buscarPorToken: nao distingue o motivo pro chamador)
async function buscarPorLinkAcao(id, link) {
  if (!id || !link) return null;
  const registro = await getOne(id);
  if (!registro) return null;
  if (!registro.linkAcao || registro.linkAcao !== link || registro.linkAcaoRevogado) return null;
  return registro;
}

// decide (aprova/recusa) via o link de acao - mesma logica de updateStatus,
// so que autorizando pelo link em vez de sessao, e aceitando um nome livre
// (quem abriu o link pode nao ter conta no NoPulso)
async function decidirComLink(id, link, { acao, motivoDecisao, comprovante, autorNome }) {
  const registro = await buscarPorLinkAcao(id, link);
  if (!registro) throw new Error('Link inválido ou revogado.');
  if (registro.status !== 'PENDENTE') throw new Error('Esse ticket já foi decidido.');
  if (!['aprovar', 'recusar'].includes(acao)) throw new Error('Ação inválida.');
  const status = acao === 'aprovar' ? 'APROVADO' : 'REJEITADO';
  const patch = {
    status,
    motivoDecisao: motivoDecisao || '',
    decidedByEmail: autorNome || registro.direcionadoParaEmail || 'via link',
    decidedEm: new Date().toISOString(),
  };
  if (status === 'APROVADO') patch.execucaoStatus = 'PENDENTE';
  if (comprovante) patch.anexos = [...(registro.anexos || []), comprovante];
  await refundsRef.doc(id).update(patch);
  refundsCache.invalidar();
  return getOne(id);
}

// avanca a execucao via o link de acao - mesma validacao de decidirComLink
async function atualizarExecucaoComLink(id, link, execucaoStatus, { autorNome }) {
  const registro = await buscarPorLinkAcao(id, link);
  if (!registro) throw new Error('Link inválido ou revogado.');
  if (registro.status !== 'APROVADO') throw new Error('Esse ticket ainda não foi aprovado.');
  return atualizarExecucao(id, execucaoStatus, { porNome: autorNome || 'via link' });
}


// edicao direta pelo Master - poder de corrigir qualquer campo do pedido de
// estorno (dado errado digitado pelo cliente, unidade errada, etc.),
// independente do status. So mexe no que vier em `campos`.
const CAMPOS_TEXTO = ['pedidoId', 'unidade', 'unidadeNome', 'observacao', 'motivoEstorno', 'motivoOutro', 'formaPagamento', 'bandeira', 'ultimos4', 'dataVenda', 'horaVenda', 'nomeCliente', 'telefoneCliente', 'pixChave', 'pixNomeTitular', 'pixBanco', 'observacaoCliente'];
const CAMPOS_NUMERICOS = ['valorVenda', 'valorEstornar'];
async function update(id, campos) {
  const ref = refundsRef.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Solicitação não encontrada.');
  const patch = {};
  CAMPOS_TEXTO.forEach((campo) => { if (campos[campo] != null) patch[campo] = String(campos[campo]).trim() || null; });
  CAMPOS_NUMERICOS.forEach((campo) => {
    if (Object.prototype.hasOwnProperty.call(campos, campo)) {
      patch[campo] = campos[campo] != null && campos[campo] !== '' ? Number(campos[campo]) || 0 : null;
    }
  });
  await ref.update(patch);
  refundsCache.invalidar();
  return getOne(id);
}

async function remove(id) {
  await refundsRef.doc(id).delete();
  refundsCache.invalidar();
}

// troca o Master/Admin responsavel por um pedido de estorno ja existente -
// mesmo criterio do redirecionar() de solicitacoes.js (atribuidosIds/Emails
// e quem de fato enxerga o card na Central quando nao e Master)
async function redirecionar(id, { direcionadoParaId, direcionadoParaEmail, atribuidosIds, atribuidosEmails }) {
  const ref = refundsRef.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Solicitação não encontrada.');
  await ref.update({
    direcionadoParaId: direcionadoParaId || null,
    direcionadoParaEmail: direcionadoParaEmail || null,
    atribuidosIds: Array.isArray(atribuidosIds) ? atribuidosIds.filter(Boolean) : [],
    atribuidosEmails: Array.isArray(atribuidosEmails) ? atribuidosEmails.filter(Boolean) : [],
  });
  refundsCache.invalidar();
  return getOne(id);
}

// converte um pedido de Estorno num dos 5 tipos gerais da Central (Compra,
// Manutencao, Suporte de TI, Pagamento, Nota) - ex: virou uma manutencao em
// vez de reembolso ao cliente. Marca este registro como CONVERTIDO e cria um
// novo em solicitacoes.js com o MESMO numero de ticket, preservando o
// historico (ver historicoTipos/convertidoDeTipo/convertidoDeId). Require
// tardio de solicitacoes.js (dependencia "de efeito colateral", nao do
// modulo em si) pra evitar require circular no topo do arquivo, ja que
// solicitacoes.js tambem precisa chamar de volta pra converterParaEstorno.
async function converterParaSolicitacao(id, novoTipo, dadosExtras, porEmail) {
  const solicitacoes = require('./solicitacoes');
  if (!solicitacoes.TIPOS.includes(novoTipo)) throw new Error('Tipo de destino inválido.');
  const ref = refundsRef.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Solicitação não encontrada.');
  const atual = snap.data();
  if (atual.status === 'CONVERTIDO') throw new Error('Este ticket já foi convertido.');
  const d = dadosExtras || {};
  const novo = await solicitacoes.create({
    tipo: novoTipo,
    unidade: d.unidade || atual.unidade,
    unidadeNome: d.unidadeNome || atual.unidadeNome || d.unidade || atual.unidade,
    titulo: d.titulo || atual.observacao || `Estorno #${atual.numeroTicket} convertido`,
    valorEstimado: d.valorEstimado != null && d.valorEstimado !== '' ? d.valorEstimado : atual.valorEstornar,
    observacao: d.observacao || atual.observacao || '',
    itens: d.itens,
    anexos: atual.anexos,
    ehOrcamento: false,
    fornecedor: d.fornecedor,
    vencimento: d.vencimento,
    criadoPorId: atual.requestedById,
    criadoPorEmail: atual.requestedByEmail,
    direcionadoParaId: atual.direcionadoParaId,
    direcionadoParaEmail: atual.direcionadoParaEmail,
    numeroTicket: atual.numeroTicket,
    convertidoDeTipo: 'estorno',
    convertidoDeId: atual.id,
    teste: atual.teste,
  });
  await ref.update({
    status: 'CONVERTIDO',
    convertidoParaTipo: novoTipo,
    convertidoParaId: novo.id,
  });
  await centralChat.reatribuirCard('estorno', id, novoTipo, novo.id);
  refundsCache.invalidar();
  return novo;
}

module.exports = {
  STATUSES, EXECUCAO_STATUSES, create, listAll, getOne, updateStatus, update, remove, marcarNotificacaoVista,
  redirecionar, converterParaSolicitacao, atualizarExecucao, podeAgirComLink, gerarLinkAcao, revogarLinkAcao,
  buscarPorLinkAcao, decidirComLink, atualizarExecucaoComLink,
  invalidar: () => refundsCache.invalidar(),
};
