// tarefas.js
// Fila pessoal de execução. Tarefas ligadas a ticket são criadas pelo servidor
// e têm vínculo idempotente: atribuir o mesmo ticket duas vezes não duplica a
// pendência. A tarefa nunca substitui as regras próprias do ticket.
const crypto = require('crypto');
const db = require('./firestore');

const COLLECTION = db.collection('tarefas');
const STATUS_ABERTO = new Set(['PENDENTE', 'EM_ANDAMENTO']);

function chaveTicket(ticketId, usuarioId, email) {
  const alvo = String(usuarioId || email || '').trim().toLowerCase();
  return `ticket-${ticketId}-${crypto.createHash('sha256').update(alvo).digest('hex').slice(0, 16)}`;
}

function podeReceberTicket(usuario) {
  return !!usuario && (usuario.role === 'master' || (usuario.permissions?.sections || []).includes('suporte'));
}

function destinatarios(ticket, usuarios) {
  const ids = Array.isArray(ticket.atribuidosIds) && ticket.atribuidosIds.length
    ? ticket.atribuidosIds : [ticket.direcionadoParaId].filter(Boolean);
  const emails = Array.isArray(ticket.atribuidosEmails) && ticket.atribuidosEmails.length
    ? ticket.atribuidosEmails : [ticket.direcionadoParaEmail].filter(Boolean);
  return usuarios.filter((u) => podeReceberTicket(u)
    && (ids.includes(u.id) || emails.map((x) => String(x).toLowerCase()).includes(String(u.email || '').toLowerCase())));
}

async function sincronizarTicket(ticket, usuarios, tipo = 'solicitacao') {
  if (!ticket?.id) return [];
  const chaveBase = `${tipo}:${ticket.id}`;
  const alvos = destinatarios(ticket, usuarios);
  const alvoIds = new Set(alvos.map((u) => u.id));
  const existentes = await COLLECTION.where('vinculo.chave', '==', chaveBase).get();
  const agora = new Date().toISOString();
  const alteradas = [];

  // Quem deixou de ser responsável não carrega um ticket antigo na fila.
  for (const doc of existentes.docs) {
    const tarefa = doc.data();
    if (STATUS_ABERTO.has(tarefa.status) && !alvoIds.has(tarefa.responsavelId)) {
      await doc.ref.update({ status: 'CANCELADA', canceladaEm: agora, motivoCancelamento: 'Ticket redirecionado.' });
    }
  }

  for (const usuario of alvos) {
    const id = chaveTicket(ticket.id, usuario.id, usuario.email);
    const ref = COLLECTION.doc(id);
    const snap = await ref.get();
    if (snap.exists) {
      const atual = snap.data();
      if (STATUS_ABERTO.has(atual.status)) await ref.update({ titulo: ticket.titulo, prioridade: ticket.prioridade || 'normal', atualizadoEm: agora });
      continue;
    }
    const tarefa = {
      id,
      origem: 'ticket',
      titulo: ticket.titulo || `Ticket #${ticket.numeroTicket || ''}`,
      prioridade: ticket.prioridade || 'normal',
      status: 'PENDENTE',
      responsavelId: usuario.id,
      responsavelEmail: usuario.email || null,
      criadaEm: agora,
      atualizadoEm: agora,
      vinculo: { chave: chaveBase, tipo, ticketTipo: ticket.tipo || tipo, id: ticket.id, numeroTicket: ticket.numeroTicket || null },
      unidade: ticket.unidade || null,
      unidadeNome: ticket.unidadeNome || null,
    };
    await ref.set(tarefa);
    alteradas.push(tarefa);
  }
  return alteradas;
}

async function listarMinhas({ usuarioId, isMaster }) {
  const snap = isMaster
    ? await COLLECTION.orderBy('atualizadoEm', 'desc').get()
    : await COLLECTION.where('responsavelId', '==', usuarioId).get();
  return snap.docs.map((d) => d.data()).sort((a, b) => String(b.atualizadoEm).localeCompare(String(a.atualizadoEm)));
}

async function getOne(id) {
  const snap = await COLLECTION.doc(id).get();
  return snap.exists ? snap.data() : null;
}

async function concluir(id, { usuarioId, isMaster, observacao }) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Tarefa não encontrada.');
  const tarefa = snap.data();
  if (tarefa.responsavelId !== usuarioId && !isMaster) throw new Error('Essa tarefa pertence a outro responsável.');
  if (!STATUS_ABERTO.has(tarefa.status)) throw new Error('Essa tarefa já foi encerrada.');
  const agora = new Date().toISOString();
  await ref.update({ status: 'CONCLUIDA', concluidaEm: agora, concluidaPorId: usuarioId, observacaoConclusao: String(observacao || '').trim().slice(0, 1000), atualizadoEm: agora });
  return getOne(id);
}

module.exports = { sincronizarTicket, listarMinhas, getOne, concluir, podeReceberTicket };
