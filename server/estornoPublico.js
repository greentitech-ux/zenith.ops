'use strict';
const db = require('./firestore');
const tarefas = require('./tarefas');
const refunds = require('./refunds');

async function criar({ dados, usuario, anexos }) {
  const lote = db.batch();
  const tarefa = await tarefas.criar({
    titulo: `Estorno (cliente) · ${dados.nomeCliente || 'sem nome informado'}`,
    descricao: `Pedido de estorno recebido pelo formulário público. Unidade: ${dados.unidadeNome || dados.unidade}.`,
    unidade: dados.unidade, unidadeNome: dados.unidadeNome,
    origem: 'estorno-cliente', usuario, responsavel: usuario, anexosIniciais: anexos,
  }, { lote });
  const estorno = await refunds.create({
    ...dados, origem: 'cliente', anexos, numeroTicket: tarefa.numeroTicket,
    origemTarefa: { id: tarefa.id, numeroTicket: tarefa.numeroTicket },
  }, { lote });
  const vinculo = { chave: `estorno:${estorno.id}`, tipo: 'estorno', ticketTipo: 'estorno', id: estorno.id, numeroTicket: estorno.numeroTicket };
  lote.update(db.collection('tarefas').doc(tarefa.id), { estornoId: estorno.id, vinculo });
  // Ou os dois registros ficam persistidos e vinculados, ou nenhum fica.
  await lote.commit();
  refunds.invalidar();
  return { tarefa: { ...tarefa, estornoId: estorno.id, vinculo }, estorno };
}

module.exports = { criar };
