// tarefas.js
// Fila pessoal de execução. Tarefas ligadas a ticket são criadas pelo servidor
// e têm vínculo idempotente: atribuir o mesmo ticket duas vezes não duplica a
// pendência. A tarefa nunca substitui as regras próprias do ticket.
const crypto = require('crypto');
const db = require('./firestore');

const COLLECTION = db.collection('tarefas');
const CONTROLE = db.collection('tarefasControle');
const STATUS_ABERTO = new Set(['PENDENTE', 'A_FAZER', 'HOJE', 'EM_ANDAMENTO']);
const STATUS_EDITAVEIS = new Set(['PENDENTE', 'A_FAZER', 'HOJE', 'EM_ANDAMENTO']);
const STATUS_TAREFA = [...STATUS_EDITAVEIS, 'CONCLUIDA', 'CANCELADA', 'ARQUIVADA'];

function nomeUsuario(usuario) {
  return String(usuario?.nome || usuario?.name || usuario?.username || 'Usuário').trim().slice(0, 80);
}

function podeGerir(tarefa, acesso) {
  if (acesso.isMaster) return true;
  if (tarefa.responsavelId === acesso.usuario.id || tarefa.criadoPorId === acesso.usuario.id) return true;
  return !!acesso.isAdmin && !!tarefa.unidade && (acesso.unidades || []).includes(tarefa.unidade);
}

// Modelo do Asana: UM responsável (assignee, dono da entrega) e N participantes
// (collaborators). Participante faz a tarefa ANDAR - comenta, anexa e mexe no
// status. O que muda o combinado (prazo, quem participa) e o que destrói
// (remover a tarefa) fica com o dono; anexo, cada um tira o seu. Sem essa
// separação, "quem participa" viraria um segundo dono e o prazo mudaria sem
// quem cobra ficar sabendo.
function podeParticipar(tarefa, acesso) {
  return podeGerir(tarefa, acesso) || (tarefa.colaboradoresIds || []).includes(acesso.usuario.id);
}

function podeArquivar(tarefa, acesso) {
  return !!acesso.isMaster || (!!acesso.isAdmin && tarefa.status === 'CONCLUIDA'
    && !!tarefa.unidade && (acesso.unidades || []).includes(tarefa.unidade));
}

function statusDoTicket(ticket) {
  if (ticket.status === 'APROVADO') return ticket.execucaoStatus === 'FINALIZADO' ? 'CONCLUIDA' : 'A_FAZER';
  if (ticket.status === 'PENDENTE') return 'PENDENTE';
  return 'CANCELADA';
}

function chaveTicket(ticketId, usuarioId, email) {
  const alvo = String(usuarioId || email || '').trim().toLowerCase();
  return `ticket-${ticketId}-${crypto.createHash('sha256').update(alvo).digest('hex').slice(0, 16)}`;
}

function podeReceberTicket(usuario) {
  if (!usuario) return false;
  if (usuario.role === 'master') return true;
  const secoes = usuario.permissions?.sections || [];
  const cargo = String(usuario.cargo || '').toLowerCase();
  return ['suporte', 'tecnico', 'manutencao'].some((tag) => secoes.includes(tag) || cargo === tag);
}

function destinatarios(ticket, usuarios) {
  const ids = Array.isArray(ticket.atribuidosIds) && ticket.atribuidosIds.length
    ? ticket.atribuidosIds : [ticket.direcionadoParaId].filter(Boolean);
  const emails = Array.isArray(ticket.atribuidosEmails) && ticket.atribuidosEmails.length
    ? ticket.atribuidosEmails : [ticket.direcionadoParaEmail].filter(Boolean);
  if (!ids.length && !emails.length) return usuarios.filter((u) => u.role === 'master');
  const elegiveis = usuarios.filter((u) => podeReceberTicket(u)
    && (ids.includes(u.id) || emails.map((x) => String(x).toLowerCase()).includes(String(u.email || '').toLowerCase())));
  // Um ticket direcionado a alguém sem perfil operacional não desaparece da
  // fila: o Master recebe a pendência para decidir se a delega.
  return elegiveis.length ? elegiveis : usuarios.filter((u) => u.role === 'master');
}

async function sincronizarTicket(ticket, usuarios, tipo = 'solicitacao') {
  if (!ticket?.id) return [];
  // Quebra de caixa é um alerta financeiro, não uma ordem de execução. Ela
  // só entra no Meu Dia quando alguém usar a ação explícita “Criar tarefa”.
  if (ticket.tipo === 'quebra-caixa') return [];
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
      await ref.update({ titulo: ticket.titulo, prioridade: ticket.prioridade || 'normal', status: statusDoTicket(ticket), atualizadoEm: agora,
        ...(statusDoTicket(ticket) === 'CONCLUIDA' && !atual.concluidaEm ? { concluidaEm: agora, concluidaPorNome: ticket.execucaoPorNome || 'Suporte' } : {}) });
      continue;
    }
    const tarefa = {
      id,
      origem: 'ticket',
      titulo: ticket.titulo || `Ticket #${ticket.numeroTicket || ''}`,
      prioridade: ticket.prioridade || 'normal',
      status: statusDoTicket(ticket),
      responsavelId: usuario.id,
       responsavelEmail: usuario.email || null,
       responsavelNome: nomeUsuario(usuario),
       criadoPorId: usuario.id, criadoPorNome: nomeUsuario(usuario),
      criadaEm: agora,
      atualizadoEm: agora,
      vinculo: { chave: chaveBase, tipo, ticketTipo: ticket.tipo || tipo, id: ticket.id, numeroTicket: ticket.numeroTicket || null },
      unidade: ticket.unidade || null,
      unidadeNome: ticket.unidadeNome || null,
      comentarios: [],
      dataInicio: agora.slice(0, 10), dataEntrega: null, anexos: [], colaboradores: [], colaboradoresIds: [],
    };
    await ref.set(tarefa);
    alteradas.push(tarefa);
  }
  return alteradas;
}

async function listarMinhas(acesso) {
  const snap = await COLLECTION.orderBy('atualizadoEm', 'desc').get();
  return snap.docs.map((d) => d.data())
    .filter((tarefa) => tarefa.status !== 'ARQUIVADA' && podeParticipar(tarefa, acesso))
    // podeGerir vai junto pra tela saber o que desabilitar (prazo, participantes,
    // remover) sem ter que reimplementar a regra no navegador
    .map((tarefa) => ({ ...tarefa, podeGerir: podeGerir(tarefa, acesso) }))
    .sort((a, b) => String(b.atualizadoEm).localeCompare(String(a.atualizadoEm)));
}

async function getOne(id) {
  const snap = await COLLECTION.doc(id).get();
  return snap.exists ? snap.data() : null;
}

function pessoasParaColaboradores(pessoas, responsavelId) {
  const vistos = new Set([responsavelId]);
  return (pessoas || []).filter((p) => p && p.id && !vistos.has(p.id) && vistos.add(p.id))
    .map((p) => ({ id: p.id, nome: nomeUsuario(p) })).slice(0, 20);
}

async function criar({ titulo, descricao, dataInicio, dataEntrega, unidade, unidadeNome, usuario, responsavel, colaboradores = [], vinculo = null }) {
  const texto = String(titulo || '').trim().slice(0, 200);
  if (!texto) throw new Error('Informe o título da tarefa.');
  const ref = COLLECTION.doc();
  const agora = new Date().toISOString();
  const inicio = /^\d{4}-\d{2}-\d{2}$/.test(dataInicio || '') ? dataInicio : agora.slice(0, 10);
  const entrega = /^\d{4}-\d{2}-\d{2}$/.test(dataEntrega || '') ? dataEntrega : null;
  const hoje = agora.slice(0, 10);
  const statusInicial = entrega && entrega < hoje ? 'PENDENTE' : (entrega === hoje ? 'HOJE' : 'A_FAZER');
  const equipe = pessoasParaColaboradores(colaboradores, (responsavel || usuario).id);
  const tarefa = {
    id: ref.id, origem: vinculo ? 'ticket-manual' : 'manual', titulo: texto,
    descricao: String(descricao || '').trim().slice(0, 2000),
    prioridade: 'normal', status: statusInicial, dataInicio: inicio, dataEntrega: entrega,
    responsavelId: (responsavel || usuario).id, responsavelEmail: (responsavel || usuario).email || null, responsavelNome: nomeUsuario(responsavel || usuario),
    criadoPorId: usuario.id, criadoPorNome: nomeUsuario(usuario),
    criadaEm: agora, atualizadoEm: agora, comentarios: [], vinculo, anexos: [],
    colaboradores: equipe, colaboradoresIds: equipe.map((p) => p.id),
    unidade: unidade || null, unidadeNome: unidadeNome || unidade || null,
  };
  await ref.set(tarefa);
  return tarefa;
}

async function adicionarAnexo(id, acesso, anexo) {
  const ref = COLLECTION.doc(id); const snap = await ref.get();
  if (!snap.exists) throw new Error('Tarefa não encontrada.');
  const tarefa = snap.data();
  if (!podeParticipar(tarefa, acesso)) throw new Error('Você não pode anexar nesta tarefa.');
  const item = {
    id: crypto.randomBytes(8).toString('hex'), nome: String(anexo.nome || 'print').slice(0, 160),
    path: anexo.path, tipo: anexo.tipo || 'application/octet-stream', tamanho: Number(anexo.tamanho || 0),
    enviadoEm: new Date().toISOString(), enviadoPorId: acesso.usuario.id, enviadoPorNome: nomeUsuario(acesso.usuario),
  };
  await ref.update({ anexos: [...(tarefa.anexos || []), item].slice(-20), atualizadoEm: item.enviadoEm });
  return getOne(id);
}

// O X do anexo remove pelo ID do próprio anexo, não pela posição na lista:
// entre desenhar a tela e o clique alguém pode ter anexado outra coisa, e por
// índice o clique apagaria o arquivo errado.
async function removerAnexo(id, acesso, anexoId) {
  const ref = COLLECTION.doc(id); const snap = await ref.get();
  if (!snap.exists) throw new Error('Tarefa não encontrada.');
  const tarefa = snap.data();
  if (!podeParticipar(tarefa, acesso)) throw new Error('Você não pode remover anexo desta tarefa.');
  const lista = tarefa.anexos || [];
  const alvo = lista.find((a) => a && a.id === String(anexoId));
  if (!alvo) throw new Error('Anexo não encontrado.');
  if (!podeGerir(tarefa, acesso) && alvo.enviadoPorId !== acesso.usuario.id) throw new Error('Quem participa remove só o anexo que enviou.');
  const agora = new Date().toISOString();
  await ref.update({ anexos: lista.filter((a) => a !== alvo), atualizadoEm: agora });
  return { tarefa: await getOne(id), path: alvo.path || null };
}

// Data de início e previsão de conclusão são editáveis enquanto a tarefa está
// aberta. Previsão vazia é válida (tarefa sem prazo); previsão antes do início
// não é - viraria "previsão vencida" no mesmo instante em que foi salva.
async function atualizarDatas(id, acesso, { dataInicio, dataEntrega } = {}) {
  const ref = COLLECTION.doc(id); const snap = await ref.get();
  if (!snap.exists) throw new Error('Tarefa não encontrada.');
  const tarefa = snap.data();
  if (!podeGerir(tarefa, acesso)) throw new Error('Você não pode alterar esta tarefa.');
  if (!STATUS_ABERTO.has(tarefa.status)) throw new Error('Essa tarefa já foi encerrada.');
  const dia = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
  const inicio = dataInicio === undefined ? (tarefa.dataInicio || null) : dia(dataInicio);
  const entrega = dataEntrega === undefined ? (tarefa.dataEntrega || null) : dia(dataEntrega);
  if (dataInicio !== undefined && String(dataInicio || '').trim() && !inicio) throw new Error('Data de início inválida.');
  if (dataEntrega !== undefined && String(dataEntrega || '').trim() && !entrega) throw new Error('Previsão de conclusão inválida.');
  if (inicio && entrega && entrega < inicio) throw new Error('A previsão de conclusão não pode ser anterior à data de início.');
  await ref.update({ dataInicio: inicio, dataEntrega: entrega, atualizadoEm: new Date().toISOString() });
  return getOne(id);
}

async function arquivarQuebrasAutomaticas() {
  const snap = await COLLECTION.get();
  const agora = new Date().toISOString();
  const alvos = snap.docs.filter((d) => {
    const tarefa = d.data();
    return tarefa.status !== 'ARQUIVADA' && tarefa.vinculo?.ticketTipo === 'quebra-caixa' && tarefa.origem === 'ticket';
  });
  await Promise.all(alvos.map((doc) => doc.ref.update({ status: 'ARQUIVADA', arquivadaEm: agora, arquivadaPorNome: 'Sistema', motivoArquivamento: 'Quebra de caixa não gera tarefa automaticamente.', atualizadoEm: agora })));
  return alvos.length;
}

async function atualizarStatus(id, acesso, status) {
  if (!STATUS_EDITAVEIS.has(status)) throw new Error('Use a ação de concluir para finalizar uma tarefa.');
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Tarefa não encontrada.');
  const tarefa = snap.data();
  if (!podeParticipar(tarefa, acesso)) throw new Error('Você não pode alterar esta tarefa.');
  if (!STATUS_ABERTO.has(tarefa.status) && tarefa.status !== 'CONCLUIDA') throw new Error('Essa tarefa já foi encerrada.');
  const reaberta = tarefa.status === 'CONCLUIDA';
  await ref.update({ status, atualizadoEm: new Date().toISOString(), ...(reaberta ? { concluidaEm: null, concluidaPorId: null, concluidaPorNome: null, reabertaEm: new Date().toISOString(), reabertaPorNome: nomeUsuario(acesso.usuario) } : {}) });
  return getOne(id);
}

async function adicionarComentario(id, { usuario, isMaster, isAdmin, unidades, texto }) {
  const corpo = String(texto || '').trim().slice(0, 2000);
  if (!corpo) throw new Error('Escreva um comentário.');
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Tarefa não encontrada.');
  const tarefa = snap.data();
  if (!podeParticipar(tarefa, { usuario, isMaster, isAdmin, unidades })) throw new Error('Você não pode comentar nesta tarefa.');
  const agora = new Date().toISOString();
  const comentario = { id: crypto.randomBytes(8).toString('hex'), texto: corpo, porId: usuario.id, porNome: nomeUsuario(usuario), em: agora };
  await ref.update({ comentarios: [...(tarefa.comentarios || []), comentario].slice(-100), atualizadoEm: agora });
  return getOne(id);
}

async function concluir(id, { usuario, isMaster, isAdmin, unidades, observacao }) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Tarefa não encontrada.');
  const tarefa = snap.data();
  if (!podeParticipar(tarefa, { usuario, isMaster, isAdmin, unidades })) throw new Error('Você não pode concluir esta tarefa.');
  if (!STATUS_ABERTO.has(tarefa.status)) throw new Error('Essa tarefa já foi encerrada.');
  const agora = new Date().toISOString();
  await ref.update({ status: 'CONCLUIDA', concluidaEm: agora, concluidaPorId: usuario.id, concluidaPorNome: nomeUsuario(usuario), observacaoConclusao: String(observacao || '').trim().slice(0, 1000), atualizadoEm: agora });
  return getOne(id);
}

// Trocar quem participa muda o combinado da tarefa - fica com o dono, igual
// ao prazo. Participante que se auto-adicionasse entraria em tarefa de outra
// unidade sem ninguém aprovar.
async function definirColaboradores(id, acesso, pessoas) {
  const ref = COLLECTION.doc(id); const snap = await ref.get();
  if (!snap.exists) throw new Error('Tarefa não encontrada.');
  const tarefa = snap.data();
  if (!podeGerir(tarefa, acesso)) throw new Error('Só o responsável, quem criou ou o Admin muda quem participa.');
  const equipe = pessoasParaColaboradores(pessoas, tarefa.responsavelId);
  await ref.update({ colaboradores: equipe, colaboradoresIds: equipe.map((p) => p.id), atualizadoEm: new Date().toISOString() });
  return getOne(id);
}

// Trocar o responsável é redistribuir o serviço, não executar - fica com quem
// distribui (Master, Admin, gerente) e com o próprio responsável, que pode
// passar adiante o que não é dele. A validação de QUEM pode receber é a mesma
// da criação, e roda na rota (index.js).
async function definirResponsavel(id, acesso, pessoa) {
  const ref = COLLECTION.doc(id); const snap = await ref.get();
  if (!snap.exists) throw new Error('Tarefa não encontrada.');
  const tarefa = snap.data();
  if (!podeGerir(tarefa, acesso)) throw new Error('Só o responsável, quem criou ou o Admin troca o responsável.');
  if (!STATUS_ABERTO.has(tarefa.status)) throw new Error('Essa tarefa já foi encerrada.');
  if (!pessoa || !pessoa.id) throw new Error('Escolha quem fica responsável.');
  // quem vira responsável sai da lista de participantes: acumular os dois
  // papéis faria a mesma pessoa aparecer duas vezes na tela
  const equipe = (tarefa.colaboradores || []).filter((p) => p.id !== pessoa.id);
  await ref.update({
    responsavelId: pessoa.id, responsavelEmail: pessoa.email || null, responsavelNome: nomeUsuario(pessoa),
    colaboradores: equipe, colaboradoresIds: equipe.map((p) => p.id),
    atualizadoEm: new Date().toISOString(),
  });
  return getOne(id);
}

// Uma tarefa iniciada pode virar um ticket ou um formulário. O documento em
// si NÃO nasce aqui: nasce na tela que já sabe validar cada tipo (Central e
// Formulários), e o que fica guardado na tarefa é só o RASTRO - o que ela
// gerou, pra quem abrir a tarefa depois achar o documento.
//
// De propósito não mexe em `vinculo`: aquele campo é a chave de idempotência
// da sincronização de ticket (vinculo.chave). Escrever nele aqui faria uma
// sincronização futura adotar - e poder cancelar - uma tarefa que não nasceu
// daquele ticket.
async function registrarGerado(id, acesso, item) {
  const ref = COLLECTION.doc(id); const snap = await ref.get();
  if (!snap.exists) throw new Error('Tarefa não encontrada.');
  const tarefa = snap.data();
  if (!podeParticipar(tarefa, acesso)) throw new Error('Você não pode alterar esta tarefa.');
  const tipo = ['solicitacao', 'estorno', 'formulario'].includes(item && item.tipo) ? item.tipo : null;
  if (!tipo || !item.id) throw new Error('Documento gerado inválido.');
  const registro = {
    tipo, id: String(item.id).slice(0, 120),
    numeroTicket: item.numeroTicket != null ? Number(item.numeroTicket) || null : null,
    rotulo: String(item.rotulo || '').slice(0, 80) || null,
    em: new Date().toISOString(), porNome: nomeUsuario(acesso.usuario),
  };
  const lista = (tarefa.gerou || []).filter((g) => !(g.tipo === registro.tipo && g.id === registro.id));
  await ref.update({ gerou: [...lista, registro].slice(-10), atualizadoEm: registro.em });
  return getOne(id);
}

async function arquivar(id, acesso) {
  const ref = COLLECTION.doc(id); const snap = await ref.get();
  if (!snap.exists) throw new Error('Tarefa não encontrada.');
  const tarefa = snap.data();
  if (!podeArquivar(tarefa, acesso)) throw new Error('Somente o Master pode remover tarefas; Admin remove apenas concluídas da sua unidade.');
  const agora = new Date().toISOString();
  await ref.update({ status: 'ARQUIVADA', arquivadaEm: agora, arquivadaPorId: acesso.usuario.id, arquivadaPorNome: nomeUsuario(acesso.usuario), atualizadoEm: agora });
  return getOne(id);
}

async function sincronizarRetroativo({ solicitacoes = [], estornos = [], usuarios = [], forcar = false } = {}) {
  const versao = 'tickets-v2';
  const ref = CONTROLE.doc(`retroativo-${versao}`);
  const anterior = await ref.get();
  if (anterior.exists && !forcar) return { executada: false, motivo: 'já sincronizado nesta versão', ...anterior.data() };

  const quebrasArquivadas = await arquivarQuebrasAutomaticas();
  let alteradas = 0;
  for (const ticket of solicitacoes) alteradas += (await sincronizarTicket(ticket, usuarios, 'solicitacao')).length;
  for (const ticket of estornos) alteradas += (await sincronizarTicket(ticket, usuarios, 'estorno')).length;
  const resultado = {
    executada: true, versao, alteradas, solicitacoes: solicitacoes.length, estornos: estornos.length,
    concluidaEm: new Date().toISOString(), quebrasArquivadas,
  };
  await ref.set(resultado);
  return resultado;
}

module.exports = { sincronizarTicket, sincronizarRetroativo, listarMinhas, getOne, criar, atualizarStatus, adicionarComentario, adicionarAnexo, removerAnexo, atualizarDatas, definirColaboradores, definirResponsavel, registrarGerado, concluir, arquivar, podeReceberTicket, podeGerirTarefa: podeGerir, podeParticiparTarefa: podeParticipar };
