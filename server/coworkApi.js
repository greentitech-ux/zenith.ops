// Gateway unico e fechado para Claude/Cowork operar o NoPulso.
// Nao e uma API administrativa generica: cada ferramenta tem executor,
// esquema e risco conhecidos. A identidade vem do servidor, nunca do modelo.
const crypto = require('crypto');
const db = require('./firestore');
const users = require('./users');
const agenteAcoes = require('./agenteAcoes');
const solicitacoes = require('./solicitacoes');
const formularios = require('./formularios');
const tarefas = require('./tarefas');
const lojaStatus = require('./lojaStatus');
const googleGmail = require('./googleGmail');

const AUDITORIA = db.collection('coworkApiAuditoria');
const IDEMPOTENCIA = db.collection('coworkApiIdempotencia');

const FERRAMENTAS = Object.freeze({
  preparar_reuniao: { descricao: 'Consulta pendências, reuniões, tickets e alertas do NOC para montar pauta e cobranças atuais.', risco: 'leitura', obrigatorios: [] },
  consultar_noc: { descricao: 'Consulta o estado atual e compacto dos computadores monitorados.', risco: 'leitura', obrigatorios: [] },
  pesquisar_emails: { descricao: 'Pesquisa a caixa corporativa autorizada usando a sintaxe de busca do Gmail.', risco: 'leitura', obrigatorios: [] },
  ler_email: { descricao: 'Lê uma mensagem específica encontrada pela pesquisa.', risco: 'leitura', obrigatorios: ['emailId'] },
  enviar_email: { descricao: 'Envia e-mail pela caixa corporativa autorizada.', risco: 'alto', obrigatorios: ['para', 'assunto', 'texto'], confirmar: true },
  criar_tarefa: { descricao: 'Cria uma tarefa no Meu Dia.', risco: 'baixo', obrigatorios: ['titulo'] },
  criar_reuniao: { descricao: 'Cria reunião e, sem link informado, agenda no Google Meet.', risco: 'baixo', obrigatorios: ['titulo', 'dataEntrega', 'horaInicio'] },
  concluir_tarefa: { descricao: 'Marca uma tarefa como concluída.', risco: 'medio', obrigatorios: ['tarefaId'], confirmar: true },
  cancelar_tarefa: { descricao: 'Cancela uma tarefa.', risco: 'alto', obrigatorios: ['tarefaId', 'motivo'], confirmar: true },
  criar_solicitacao_ti: { descricao: 'Abre solicitação de Suporte de TI na Central.', risco: 'baixo', obrigatorios: ['unidade', 'titulo'] },
  criar_formulario: { descricao: 'Cria formulário preenchido ou link para preenchimento.', risco: 'medio', obrigatorios: ['tipo', 'unidade'] },
  criar_usuario: { descricao: 'Cria acesso copiando permissões de um usuário-modelo.', risco: 'alto', obrigatorios: ['modelo', 'email', 'username'], confirmar: true, devolveSegredo: true },
  desbloquear_usuario: { descricao: 'Desbloqueia um acesso existente sem trocar a senha.', risco: 'alto', obrigatorios: ['usuario'], confirmar: true },
  criar_nova_senha: { descricao: 'Gera e aplica senha temporária aleatória; Master precisa repassá-la com segurança.', risco: 'alto', obrigatorios: ['usuario'], confirmar: true, devolveSegredo: true },
  executar_noc: { descricao: 'Enfileira uma ação fechada do NOC em computadores.', risco: 'alto', obrigatorios: ['tarefa', 'alvos'], confirmar: true },
});

function listarFerramentas() {
  return Object.entries(FERRAMENTAS).map(([nome, dados]) => ({ nome, ...dados }));
}

const PROPRIEDADES_COMUNS = {
  termo: { type: 'string', description: 'Assunto, título ou texto para filtrar.' },
  consulta: { type: 'string', description: 'Busca do Gmail, por exemplo: newer_than:7d is:unread.' },
  emailId: { type: 'string' }, para: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
  assunto: { type: 'string' }, texto: { type: 'string' },
  unidade: { type: 'string', description: 'Código ou nome da unidade.' },
  unidadeNome: { type: 'string' }, titulo: { type: 'string' }, descricao: { type: 'string' },
  observacao: { type: 'string' }, prioridade: { type: 'string' }, dataEntrega: { type: 'string', description: 'AAAA-MM-DD' },
  horaInicio: { type: 'string', description: 'HH:MM' }, duracaoMin: { type: 'number' }, linkReuniao: { type: 'string' },
  tarefaId: { type: 'string' }, motivo: { type: 'string' }, usuario: { type: 'string', description: 'E-mail ou username.' },
  pedirTrocaSenha: { type: 'boolean' }, modelo: { type: 'string' }, email: { type: 'string' }, username: { type: 'string' },
  tipo: { type: 'string' }, modo: { type: 'string', enum: ['link', 'preenchido'] }, campos: { type: 'object' }, linhas: { type: 'array', items: { type: 'object' } },
  tarefa: { type: 'string', enum: ['reiniciar', 'abortar', 'anydesk', 'zebra', 'rede', 'corrigir-memoria-limitada'] },
  alvos: { type: 'array', items: { type: 'object', required: ['codigo', 'posto'], properties: { codigo: { type: 'string' }, posto: { type: 'string' } } } },
  limite: { type: 'number' }, confirmar: { type: 'boolean', description: 'Somente true após confirmação explícita do Master.' },
  idempotencyKey: { type: 'string', description: 'UUID novo por intenção de escrita; reutilize apenas ao repetir a mesma chamada.' },
};

function ferramentasMcp() {
  return Object.entries(FERRAMENTAS).map(([name, f]) => ({
    name, description: `${f.descricao} Risco: ${f.risco}.${f.confirmar ? ' Exige confirmação explícita.' : ''}`,
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: PROPRIEDADES_COMUNS,
      required: [...f.obrigatorios, ...(f.risco === 'leitura' ? [] : ['idempotencyKey']), ...(f.confirmar ? ['confirmar'] : [])],
    },
    annotations: { readOnlyHint: f.risco === 'leitura', destructiveHint: f.risco === 'alto', idempotentHint: f.risco === 'leitura' },
  }));
}

function tokenValido(recebido) {
  const esperado = String(process.env.NOPULSO_AGENT_API_TOKEN || '');
  const atual = String(recebido || '').replace(/^Bearer\s+/i, '');
  if (!esperado || !atual) return false;
  const a = Buffer.from(atual); const b = Buffer.from(esperado);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function resolverAtor() {
  const identificador = String(process.env.NOPULSO_AGENT_MASTER || '').trim();
  if (!identificador) throw new Error('NOPULSO_AGENT_MASTER não configurado no servidor.');
  const ator = await users.findByIdentifier(identificador);
  if (!ator || ator.active === false || ator.role !== 'master') {
    throw new Error('NOPULSO_AGENT_MASTER precisa apontar para um Master ativo.');
  }
  return ator;
}

function validar(nome, entrada, confirmar) {
  const ferramenta = FERRAMENTAS[nome];
  if (!ferramenta) throw new Error('Ferramenta não permitida. Consulte GET /api/agent/tools.');
  const faltando = ferramenta.obrigatorios.filter((campo) => entrada?.[campo] == null || entrada[campo] === '');
  if (faltando.length) throw new Error(`Campos obrigatórios: ${faltando.join(', ')}.`);
  if (ferramenta.confirmar && confirmar !== true) {
    const erro = new Error('Esta ação altera dados sensíveis e exige confirmar=true após confirmação explícita do Master.');
    erro.code = 'CONFIRMACAO_NECESSARIA';
    throw erro;
  }
  return ferramenta;
}

async function despachar(nome, entrada, ator) {
  const p = { ...(entrada || {}), porId: ator.id };
  if (nome === 'pesquisar_emails') return googleGmail.pesquisar({ consulta: p.consulta, limite: p.limite });
  if (nome === 'ler_email') return googleGmail.ler(p.emailId);
  if (nome === 'enviar_email') return googleGmail.enviar({ para: p.para, assunto: p.assunto, texto: p.texto });
  if (nome === 'preparar_reuniao') {
    const acesso = { usuario: ator, isMaster: true, isAdmin: false, unidades: [] };
    const [listaTarefas, listaSolicitacoes, maquinas] = await Promise.all([
      tarefas.listarMinhas(acesso), solicitacoes.listAll(), lojaStatus.listarResumo(),
    ]);
    const termo = String(p.termo || '').trim().toLocaleLowerCase('pt-BR');
    const unidade = String(p.unidade || '').trim().toLocaleLowerCase('pt-BR');
    const limite = Math.min(100, Math.max(1, Number(p.limite) || 40));
    const combina = (x) => {
      if (unidade && !String(x.unidade || x.codigo || '').toLocaleLowerCase('pt-BR').includes(unidade)
        && !String(x.unidadeNome || '').toLocaleLowerCase('pt-BR').includes(unidade)) return false;
      if (!termo) return true;
      return JSON.stringify([x.titulo, x.descricao, x.observacao, x.unidade, x.unidadeNome, x.responsavelNome, x.status])
        .toLocaleLowerCase('pt-BR').includes(termo);
    };
    const tarefasCompactas = listaTarefas.filter(combina).slice(0, limite).map((t) => ({
      id: t.id, ticket: t.numeroTicket, titulo: t.titulo, descricao: t.descricao || null,
      status: t.status, prioridade: t.prioridade, responsavel: t.responsavelNome || t.responsavelEmail,
      unidade: t.unidadeNome || t.unidade, dataEntrega: t.dataEntrega,
      reuniao: !!t.ehReuniao, horaInicio: t.horaInicio || null,
      subtarefas: (t.subtarefas || []).map((s) => ({ titulo: s.titulo, concluida: !!s.concluida })),
      decisoes: (t.decisoes || []).slice(-10),
      comentariosRecentes: (t.comentarios || []).slice(-5).map((c) => ({ por: c.porNome, em: c.em, texto: c.texto })),
    }));
    const solicitacoesCompactas = listaSolicitacoes.filter((s) => s.status !== 'REJEITADO' && combina(s)).slice(0, limite).map((s) => ({
      id: s.id, ticket: s.numeroTicket, tipo: s.tipo, titulo: s.titulo, status: s.status,
      execucaoStatus: s.execucaoStatus || null, prioridade: s.prioridade || null,
      unidade: s.unidadeNome || s.unidade, criadoEm: s.criadoEm,
    }));
    const noc = maquinas.filter((m) => !m.online || (m.degradacao || []).length).filter(combina).slice(0, limite).map((m) => ({
      unidade: m.nomeUnidade || m.codigo, codigo: m.codigo, posto: m.posto,
      // mesmo defeito da consultar_noc: os dois campos nao existem no resumo
      maquina: m.nome || null, online: !!m.online,
      estado: m.estado, degradacao: m.degradacao || [], ultimoContato: m.ultimoHeartbeatEm || null,
    }));
    return { geradoEm: new Date().toISOString(), filtros: { termo: p.termo || null, unidade: p.unidade || null }, tarefas: tarefasCompactas, solicitacoes: solicitacoesCompactas, alertasNoc: noc };
  }
  if (nome === 'consultar_noc') {
    const unidade = String(p.unidade || '').trim().toLocaleLowerCase('pt-BR');
    return (await lojaStatus.listarResumo()).filter((m) => !unidade || String(m.codigo || '').toLocaleLowerCase('pt-BR').includes(unidade) || String(m.nomeUnidade || '').toLocaleLowerCase('pt-BR').includes(unidade)).slice(0, 200).map((m) => ({
      codigo: m.codigo, posto: m.posto, unidade: m.nomeUnidade || m.codigo,
      // O nome do computador vive em `nome`. nomeComputador e hostname nao
      // existem no resumo, entao isto voltava null em TODAS as maquinas e a
      // resposta saia sem dizer de qual computador estava falando.
      maquina: m.nome || null, online: !!m.online,
      estado: m.estado, degradacao: m.degradacao || [], ultimoContato: m.ultimoHeartbeatEm || null,
      // A versao do NOCZenith que a maquina reporta. Sem ela nao da pra
      // responder "quem ja baixou a versao nova?" sem abrir a tela do NOC -
      // e o resumo ja traz o campo, entao nao custa leitura nenhuma.
      versaoAgente: m.agenteVersao || null,
    }));
  }
  const mapa = {
    criar_tarefa: 'criar_tarefa', criar_reuniao: 'marcar_reuniao',
    concluir_tarefa: 'concluir_tarefa', cancelar_tarefa: 'cancelar_tarefa',
    criar_usuario: 'criar_usuario_copiando', desbloquear_usuario: 'desbloquear_usuario',
    criar_nova_senha: 'resetar_senha_usuario', executar_noc: 'noc_comando',
  };
  if (mapa[nome]) return agenteAcoes.executarAcaoSistema(mapa[nome], p);
  if (nome === 'criar_solicitacao_ti') {
    const r = await solicitacoes.create({
      tipo: 'suporte-ti', unidade: p.unidade, unidadeNome: p.unidadeNome,
      titulo: p.titulo, observacao: p.observacao, prioridade: p.prioridade,
      itens: [], anexos: [], ehOrcamento: false,
      criadoPorId: ator.id, criadoPorEmail: `${ator.email} via Claude/Cowork`,
      direcionadoParaId: null, direcionadoParaEmail: null,
    });
    return `Solicitação de TI #${r.numeroTicket} criada: ${r.titulo}.`;
  }
  if (nome === 'criar_formulario') {
    const base = { tipo: p.tipo, unidade: p.unidade, criadoPorId: ator.id, criadoPorEmail: `${ator.email} via Claude/Cowork` };
    const r = p.modo === 'preenchido'
      ? await formularios.criar({ ...base, campos: p.campos || {}, linhas: p.linhas || [], anexos: [] })
      : await formularios.criarParaPreenchimento(base);
    const baseUrl = String(process.env.PUBLIC_BASE_URL || 'https://www.nopulso.com.br').replace(/\/$/, '');
    return { mensagem: `Formulário #${r.numeroTicket} criado.`, id: r.id, linkPreenchimento: r.tokenPreenchimento ? `${baseUrl}/formulario-preencher.html?token=${encodeURIComponent(r.tokenPreenchimento)}` : null };
  }
  throw new Error('Executor não implementado.');
}

async function executar({ nome, entrada, confirmar, idempotencyKey }) {
  const ferramenta = validar(String(nome || ''), entrada || {}, confirmar);
  const chave = String(idempotencyKey || '').trim().slice(0, 160);
  if (!chave && ferramenta.risco !== 'leitura') throw new Error('idempotencyKey é obrigatório para evitar ações duplicadas.');
  if (ferramenta.risco === 'leitura') {
    const ator = await resolverAtor();
    const resultado = await despachar(nome, entrada || {}, ator);
    await AUDITORIA.doc().set({ nome, risco: 'leitura', atorId: ator.id, atorEmail: ator.email, status: 'CONCLUIDO', criadoEm: new Date().toISOString() });
    return { ok: true, resultado, tempoReal: true };
  }
  const ator = await resolverAtor();
  const ref = IDEMPOTENCIA.doc(crypto.createHash('sha256').update(chave).digest('hex'));
  const anterior = await ref.get();
  if (anterior.exists) return { ...anterior.data().resposta, repetida: true };
  // Reserva ANTES de alterar qualquer coisa. Duas chamadas simultâneas com a
  // mesma chave não podem criar dois tickets/usuários. `create` é atômico.
  try {
    await ref.create({ criadoEm: new Date().toISOString(), nome, status: 'EXECUTANDO' });
  } catch (err) {
    const concorrente = await ref.get();
    if (concorrente.exists && concorrente.data().resposta) return { ...concorrente.data().resposta, repetida: true };
    const e = new Error('Esta ação com a mesma idempotencyKey já está em execução. Aguarde e consulte novamente.');
    e.code = 'ACAO_EM_EXECUCAO';
    throw e;
  }
  const auditoria = AUDITORIA.doc();
  const inicio = new Date().toISOString();
  await auditoria.set({ id: auditoria.id, nome, risco: ferramenta.risco, atorId: ator.id, atorEmail: ator.email, idempotencyKeyHash: ref.id, status: 'EXECUTANDO', criadoEm: inicio });
  try {
    const resultado = await despachar(nome, entrada || {}, ator);
    const resposta = { ok: true, requestId: auditoria.id, resultado, sensivel: !!ferramenta.devolveSegredo };
    // Senhas temporárias nunca ficam no Firestore. Na repetição informamos que
    // a ação já ocorreu, sem executar de novo nem reexibir o segredo.
    const respostaPersistida = ferramenta.devolveSegredo
      ? { ok: true, requestId: auditoria.id, resultado: 'Ação já executada; o segredo temporário não é armazenado nem pode ser reexibido.', sensivel: true }
      : resposta;
    await ref.update({ status: 'CONCLUIDO', resposta: respostaPersistida, concluidoEm: new Date().toISOString() });
    await auditoria.update({ status: 'CONCLUIDO', concluidoEm: new Date().toISOString() });
    return resposta;
  } catch (err) {
    await ref.update({ status: 'ERRO', erro: String(err.message || err).slice(0, 500), concluidoEm: new Date().toISOString() }).catch(() => {});
    await auditoria.update({ status: 'ERRO', concluidoEm: new Date().toISOString(), erro: String(err.message || err).slice(0, 500) });
    throw err;
  }
}

module.exports = { listarFerramentas, ferramentasMcp, tokenValido, executar };
