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
const unidades = require('./unidades');
const qaAprovacoes = require('./qaAprovacoes');
const push = require('./push');

const AUDITORIA = db.collection('coworkApiAuditoria');
const IDEMPOTENCIA = db.collection('coworkApiIdempotencia');

const FERRAMENTAS = Object.freeze({
  consultar_autorizacao: { descricao: 'Consulta se o Master já autorizou (ou recusou) uma ação pedida antes, e o resultado dela.', risco: 'leitura', obrigatorios: ['autorizacaoId'] },
  preparar_reuniao: { descricao: 'Consulta pendências, reuniões, tickets e alertas do NOC para montar pauta e cobranças atuais.', risco: 'leitura', obrigatorios: [] },
  consultar_noc: { descricao: 'Consulta o estado atual e compacto dos computadores monitorados.', risco: 'leitura', obrigatorios: [] },
  pesquisar_emails: { descricao: 'Pesquisa a caixa corporativa autorizada usando a sintaxe de busca do Gmail.', risco: 'leitura', obrigatorios: [] },
  ler_email: { descricao: 'Lê uma mensagem específica encontrada pela pesquisa.', risco: 'leitura', obrigatorios: ['emailId'] },
  enviar_email: { descricao: 'Envia e-mail pela caixa corporativa autorizada.', risco: 'alto', obrigatorios: ['para', 'assunto', 'texto'], autorizar: true },
  criar_tarefa: { descricao: 'Cria uma tarefa no Meu Dia.', risco: 'baixo', obrigatorios: ['titulo'] },
  criar_reuniao: { descricao: 'Cria reunião e, sem link informado, agenda no Google Meet.', risco: 'baixo', obrigatorios: ['titulo', 'dataEntrega', 'horaInicio'] },
  concluir_tarefa: { descricao: 'Marca uma tarefa como concluída.', risco: 'medio', obrigatorios: ['tarefaId'], autorizar: true },
  cancelar_tarefa: { descricao: 'Cancela uma tarefa.', risco: 'alto', obrigatorios: ['tarefaId', 'motivo'], autorizar: true },
  criar_solicitacao_ti: { descricao: 'Abre solicitação de Suporte de TI na Central.', risco: 'baixo', obrigatorios: ['unidade', 'titulo'] },
  criar_formulario: { descricao: 'Cria formulário preenchido ou link para preenchimento.', risco: 'medio', obrigatorios: ['tipo', 'unidade'] },
  criar_usuario: { descricao: 'Cria acesso copiando permissões de um usuário-modelo.', risco: 'alto', obrigatorios: ['modelo', 'email', 'username'], autorizar: true, devolveSegredo: true },
  desbloquear_usuario: { descricao: 'Desbloqueia um acesso existente sem trocar a senha.', risco: 'alto', obrigatorios: ['usuario'], autorizar: true },
  criar_nova_senha: { descricao: 'Gera e aplica senha temporária aleatória; Master precisa repassá-la com segurança.', risco: 'alto', obrigatorios: ['usuario'], autorizar: true, devolveSegredo: true },
  executar_noc: { descricao: 'Enfileira uma ação fechada do NOC em computadores. Resetar Zebra só é permitido em unidade com marca Domino\'s configurada e Zebra monitorada. Para "TEF parou", use gsurf-rsa: reinicia o GSurfRSA Listener somente nas cinco unidades autorizadas e pode interromper uma transação por alguns segundos.', risco: 'alto', obrigatorios: ['tarefa', 'alvos'], autorizar: true },
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
  tarefa: { type: 'string', enum: ['reiniciar', 'abortar', 'anydesk', 'zebra', 'gsurf-rsa', 'rede', 'corrigir-memoria-limitada'] },
  alvos: { type: 'array', items: { type: 'object', required: ['codigo', 'posto'], properties: { codigo: { type: 'string' }, posto: { type: 'string' } } } },
  limite: { type: 'number' },
  // compatibilidade: versões antigas do Cowork mandavam confirmar=true. Não
  // autoriza mais nada - quem autoriza é o Master, no celular.
  confirmar: { type: 'boolean', description: 'Ignorado. A autorização é feita pelo Master no NoPulso (digital ou senha).' },
  autorizacaoId: { type: 'string', description: 'Id devolvido quando a ação ficou aguardando autorização.' },
  idempotencyKey: { type: 'string', description: 'UUID novo por intenção de escrita; reutilize apenas ao repetir a mesma chamada.' },
};

function ferramentasMcp() {
  return Object.entries(FERRAMENTAS).map(([name, f]) => ({
    name, description: `${f.descricao} Risco: ${f.risco}.${f.autorizar ? ' NÃO executa na hora: vira um pedido de autorização que chega no celular do Master (digital ou senha). A resposta traz pendente=true e autorizacaoId; acompanhe com consultar_autorizacao e só diga que foi feito depois de status aprovado.' : ''}`,
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: PROPRIEDADES_COMUNS,
      required: [...f.obrigatorios, ...(f.risco === 'leitura' ? [] : ['idempotencyKey'])],
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

// Antes de 23/09/2026 a trava das ações sensíveis era um `confirmar=true`
// mandado PELO PRÓPRIO MODELO depois de perguntar no chat - ou seja, não
// havia trava do lado do NoPulso: criar acesso, gerar senha, comando no NOC e
// e-mail rodavam na hora. Agora essas ferramentas (`autorizar: true`) viram
// um pedido na fila de autorização, com aviso no celular do Master, e só
// rodam quando ele aprova com a digital ou a senha (ver executarAutorizado).
function validar(nome, entrada) {
  const ferramenta = FERRAMENTAS[nome];
  if (!ferramenta) throw new Error('Ferramenta não permitida. Consulte GET /api/agent/tools.');
  const faltando = ferramenta.obrigatorios.filter((campo) => entrada?.[campo] == null || entrada[campo] === '');
  if (faltando.length) throw new Error(`Campos obrigatórios: ${faltando.join(', ')}.`);
  return ferramenta;
}

// O que a tela de autorização mostra. Sai do PAYLOAD (o que vai rodar), com
// rótulo em português - nunca um resumo escrito pelo modelo, que poderia
// dizer uma coisa e pedir outra.
const ROTULOS = {
  para: 'Para', assunto: 'Assunto', texto: 'Texto', tarefaId: 'Tarefa', motivo: 'Motivo',
  modelo: 'Copiar permissões de', email: 'E-mail', username: 'Usuário', usuario: 'Acesso',
  pedirTrocaSenha: 'Pedir troca de senha', tarefa: 'Comando', alvos: 'Computadores', unidade: 'Unidade',
  titulo: 'Título', descricao: 'Descrição', observacao: 'Observação',
};
const TITULO_ACAO = {
  enviar_email: 'Enviar e-mail', concluir_tarefa: 'Concluir tarefa', cancelar_tarefa: 'Cancelar tarefa',
  criar_usuario: 'Criar acesso', desbloquear_usuario: 'Desbloquear acesso', criar_nova_senha: 'Gerar senha temporária',
  executar_noc: 'Comando no NOC',
};
function valorLegivel(v) {
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === 'object' ? [x.codigo, x.posto].filter(Boolean).join(' / ') || JSON.stringify(x) : String(x))).join(', ');
  if (typeof v === 'boolean') return v ? 'sim' : 'não';
  if (v && typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
function detalhesDoPedido(nome, entrada) {
  return Object.entries(entrada || {})
    .filter(([k, v]) => !['idempotencyKey', 'confirmar', 'porId'].includes(k) && v != null && v !== '')
    .map(([k, v]) => ({ rotulo: ROTULOS[k] || k, valor: valorLegivel(v) }));
}
function resumoDoPedido(nome, entrada) {
  const e = entrada || {};
  const alvo = e.username || e.usuario || e.email || e.tarefaId || (Array.isArray(e.alvos) ? `${e.alvos.length} computador(es)` : '') || e.assunto || '';
  return `${TITULO_ACAO[nome] || nome}${e.tarefa ? ` (${e.tarefa})` : ''}${alvo ? ` · ${valorLegivel(alvo)}` : ''}`;
}
// comando de máquina aprovado horas depois já não é o que se pediu
const VALIDADE_AUTORIZACAO_MS = { executar_noc: 2 * 60 * 60 * 1000 };
const VALIDADE_PADRAO_MS = 24 * 60 * 60 * 1000;

// Chamado pela APROVAÇÃO (index.js, EXECUTORES_QA['cowork.executar']), com
// o Master já conferido por digital/senha. Roda exatamente o que ficou
// gravado no pedido. `segredo` avisa que o resultado tem senha temporária:
// ela vai só pra tela do Master, nunca pro Firestore nem pro Claude.
async function executarAutorizado(payload) {
  const nome = String(payload && payload.nome || '');
  const ferramenta = FERRAMENTAS[nome];
  if (!ferramenta || !ferramenta.autorizar) throw new Error('Ação do Claude inválida.');
  const ator = await resolverAtor();
  const resultado = await despachar(nome, payload.entrada || {}, ator);
  const texto = typeof resultado === 'string' ? resultado : JSON.stringify(resultado);
  return {
    resultado: texto,
    resultadoPersistido: ferramenta.devolveSegredo ? 'Executado. A senha temporária foi mostrada só ao Master, na autorização.' : texto,
  };
}

async function despachar(nome, entrada, ator) {
  const p = { ...(entrada || {}), porId: ator.id };
  if (nome === 'consultar_autorizacao') {
    const a = await qaAprovacoes.obter(String(p.autorizacaoId || ''));
    // só os pedidos do próprio Claude: o id de um pedido de QA Master ou do
    // Beniboy não abre o conteúdo dele por aqui
    if (!a || a.origem !== 'cowork') throw new Error('Autorização não encontrada.');
    const vencida = a.status === 'pendente' && a.expiraEm && Date.parse(a.expiraEm) <= Date.now();
    return {
      autorizacaoId: a.id, status: vencida ? 'expirado' : a.status, resumo: a.resumo,
      decididoEm: a.decididoEm || null, motivoRecusa: a.motivoRejeicao || null,
      erro: a.erroExecucao || null, resultado: a.resultado || null,
    };
  }
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
  if (nome === 'executar_noc') {
    const tarefa = String(p.tarefa || '');
    const alvos = Array.isArray(p.alvos) ? p.alvos.filter((a) => a && a.codigo && a.posto) : [];
    if (!alvos.length) throw new Error('Informe ao menos um computador alvo (codigo e posto).');
    if (tarefa === 'zebra') {
      // Marca vem do perfil explícito da unidade; nunca do nome. Sem perfil
      // Domino's ou sem Zebra monitorada, não há comando para enfileirar.
      const codigos = [...new Set(alvos.map((a) => String(a.codigo)))];
      for (const codigo of codigos) {
        const perfil = await unidades.perfil(codigo);
        if (!perfil || perfil.marca !== 'dominos') {
          throw new Error(`Reset de Zebra recusado para ${codigo}: a unidade precisa estar cadastrada com marca Domino's.`);
        }
        const zebras = await lojaStatus.impressorasPraSondar(codigo);
        if (!zebras.length) {
          throw new Error(`Reset de Zebra recusado para ${codigo}: não há impressora Zebra monitorada com IP atual nesta unidade.`);
        }
      }
    }
    if (tarefa === 'gsurf-rsa') {
      // O TEF só usa este listener nas unidades abaixo. A permissão é por
      // código canônico da unidade, nunca por trecho do nome exibido.
      const unidadesTefAutorizadas = new Set([
        "Domino's Carrinho Aeroporto Recife",
        'Dominos Praça Aeroporto Recife',
        'Spoleto Praça Aeroporto Recife',
        'Spoleto Shopping Recife',
        'Spoleto Shopping Tacaruna',
      ]);
      const naoAutorizadas = [...new Set(alvos.map((a) => String(a.codigo)))].filter((codigo) => !unidadesTefAutorizadas.has(codigo));
      if (naoAutorizadas.length) {
        throw new Error(`TEF parou / GSurfRSA recusado para: ${naoAutorizadas.join(', ')}. Permitido somente em Dom Car Aero Recife, Dom Praça Aero Recife, Spo Praça Aero Recife, Spo Shop Recife e Spo Shop Tacaruna.`);
      }
    }
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

async function executar({ nome, entrada, idempotencyKey }) {
  const ferramenta = validar(String(nome || ''), entrada || {});
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
    if (ferramenta.autorizar) {
      // não executa: vira pedido, e o celular do Master toca
      const entradaLimpa = { ...(entrada || {}) }; delete entradaLimpa.confirmar; delete entradaLimpa.idempotencyKey;
      const resumo = resumoDoPedido(nome, entradaLimpa);
      const pedido = await qaAprovacoes.criar({
        tipo: 'cowork.executar', resumo, origem: 'cowork',
        detalhes: detalhesDoPedido(nome, entradaLimpa),
        expiraEm: new Date(Date.now() + (VALIDADE_AUTORIZACAO_MS[nome] || VALIDADE_PADRAO_MS)).toISOString(),
        payload: { nome, entrada: entradaLimpa },
        criadoPorId: ator.id, criadoPorEmail: 'Claude (Cowork)',
      });
      push.notifyQaAprovacaoPendente(resumo, 'Claude (Cowork)', { id: pedido.id, origem: 'cowork' })
        .catch((e) => console.error('Falha ao avisar autorização do Claude:', e.message));
      const resposta = { ok: true, requestId: auditoria.id, pendente: true, autorizacaoId: pedido.id,
        resultado: `Aguardando autorização do Master no celular (digital ou senha): ${resumo}. Consulte com consultar_autorizacao antes de dizer que foi feito.` };
      await ref.update({ status: 'AGUARDANDO_AUTORIZACAO', resposta, concluidoEm: new Date().toISOString() });
      await auditoria.update({ status: 'AGUARDANDO_AUTORIZACAO', autorizacaoId: pedido.id, concluidoEm: new Date().toISOString() });
      return resposta;
    }
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

module.exports = { listarFerramentas, ferramentasMcp, tokenValido, executar, executarAutorizado };
