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
const centralChat = require('./centralChat');
const disputes = require('./disputes');
const defesaChargeback = require('./defesaChargeback');
const storage = require('./storage');
const push = require('./push');

const AUDITORIA = db.collection('coworkApiAuditoria');
const IDEMPOTENCIA = db.collection('coworkApiIdempotencia');

const FERRAMENTAS = Object.freeze({
  // ---- consultas (etapa 2, 23/09/2026): o Claude enxerga antes de agir ----
  consultar_ticket: { descricao: 'Acha pelo NÚMERO que a pessoa vê (ex.: 12052 ou "#12052") a tarefa do Meu Dia e/ou a solicitação da Central com esse número. Devolve o tarefaId/solicitacaoId interno - é ele que as ações pedem, não o número.', risco: 'leitura', obrigatorios: ['numero'] },
  listar_tarefas: { descricao: 'Lista tarefas e reuniões ABERTAS do Meu Dia (Pendente, A fazer, Hoje, Em andamento), filtrando por unidade, status, responsável e texto. Concluída/cancelada: use consultar_ticket com o número.', risco: 'leitura', obrigatorios: [] },
  listar_solicitacoes: { descricao: 'Lista solicitações da Central (compra, suporte de TI, manutenção, pagamento, nota...) por unidade, tipo, status (PENDENTE, APROVADO, REJEITADO, CONVERTIDO) e texto, da mais nova pra mais antiga.', risco: 'leitura', obrigatorios: [] },
  ler_chat_ticket: { descricao: 'Lê a conversa de uma solicitação da Central (a caixa "Escrever uma mensagem..." do ticket). Informe o numero, ou solicitacaoId.', risco: 'leitura', obrigatorios: [] },
  listar_usuarios: { descricao: 'Lista acessos por cargo, unidade ou texto (nome, e-mail, username) - pra escolher o usuário-modelo de criar_usuario ou o responsável de uma tarefa. Não traz senha nem nada secreto.', risco: 'leitura', obrigatorios: [] },
  ler_reuniao: { descricao: 'Lê uma reunião do Meu Dia: pauta, participantes, resumo, anotações (comentários), decisões e o TEXTO das transcrições anexadas (.txt, .vtt, .md, .docx). Informe tarefaId ou numero.', risco: 'leitura', obrigatorios: [] },
  // ---- defesa de chargeback (24/09/2026): a unidade responde no Meu Dia, o
  // NoPulso gera o PDF, o Claude anexa na Adyen e registra aqui o que fez ----
  listar_disputas: { descricao: 'Lista os casos de chargeback/aviso de fraude da Adyen com prazo, status (MONITORANDO, ABERTA, ENVIADA, GANHA, PERDIDA), tarefa de defesa e se a defesa já está pronta pra anexar. Filtros: status, unidade, somenteProntas.', risco: 'leitura', obrigatorios: [] },
  obter_disputa: { descricao: 'Um caso completo: dados do pagamento, motivo, prazos, respostas da unidade e LINKS TEMPORÁRIOS (2h) do PDF da defesa e de cada evidência, pra baixar e anexar na Adyen. Informe disputaId, ou numero (ticket da tarefa), ou o PSP do pagamento/disputa.', risco: 'leitura', obrigatorios: [] },
  registrar_defesa_enviada: { descricao: 'Registra no NoPulso que a defesa FOI anexada e enviada na Adyen (status ENVIADA). Use só depois de enviar de fato, com a confirmação do Master na conversa.', risco: 'baixo', obrigatorios: ['disputaId'] },
  registrar_disputa_aceita: { descricao: 'Registra no NoPulso que o chargeback foi ACEITO na Adyen, sem defesa (status PERDIDA). Use só depois de aceitar de fato, com a confirmação do Master na conversa.', risco: 'baixo', obrigatorios: ['disputaId'] },
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
  numero: { type: 'string', description: 'Número do ticket/tarefa que a pessoa vê, ex.: 12052.' },
  status: { type: 'string', description: 'Tarefa: PENDENTE, A_FAZER, HOJE, EM_ANDAMENTO. Solicitação: PENDENTE, APROVADO, REJEITADO, CONVERTIDO.' },
  responsavel: { type: 'string', description: 'Nome, e-mail ou username.' },
  cargo: { type: 'string', description: 'Tag de cargo, ex.: gerente, supervisor, suporte.' },
  solicitacaoId: { type: 'string' },
  disputaId: { type: 'string' }, psp: { type: 'string', description: 'PSP do pagamento ou da disputa (Adyen).' },
  somenteProntas: { type: 'boolean', description: 'Só as defesas prontas pra anexar na Adyen.' },
  incluirInativos: { type: 'boolean' },
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

// ---------- CONSULTAS (etapa 2) ----------
// O que volta é o MÍNIMO pra decidir e agir, sempre com os dois números
// separados: `ticket` é o que a pessoa vê (#12052), `tarefaId` /
// `solicitacaoId` é o que as ações pedem. Misturar os dois foi o que impediu
// cancelar a #12052 (ela teve que ser recriada).
const minusc = (v) => String(v == null ? '' : v).toLocaleLowerCase('pt-BR');
const contem = (campos, termo) => !termo || campos.some((c) => minusc(c).includes(termo));
const limiteDe = (v, padrao, max) => Math.min(max, Math.max(1, Number(v) || padrao));

function tarefaCompacta(t) {
  return {
    tarefaId: t.id, ticket: t.numeroTicket || null, titulo: t.titulo, status: t.status, prioridade: t.prioridade || null,
    reuniao: !!t.ehReuniao, dataEntrega: t.dataEntrega || null, horaInicio: t.horaInicio || null,
    unidade: t.unidadeNome || t.unidade || null, codigoUnidade: t.unidade || null,
    responsavel: t.responsavelNome || t.responsavelEmail || null, responsavelEmail: t.responsavelEmail || null,
    participantes: (t.colaboradores || []).map((c) => c.nome || c.email).filter(Boolean),
    criadoPor: t.criadoPorNome || null, criadaEm: t.criadaEm || null, atualizadoEm: t.atualizadoEm || null,
    vinculo: t.vinculo && t.vinculo.id ? { tipo: t.vinculo.ticketTipo || t.vinculo.tipo || null, solicitacaoId: t.vinculo.id } : null,
    descricao: t.descricao ? String(t.descricao).slice(0, 400) : null,
  };
}
function solicitacaoCompacta(x) {
  return {
    solicitacaoId: x.id, ticket: x.numeroTicket || null, tipo: x.tipo, titulo: x.titulo, status: x.status,
    execucaoStatus: x.execucaoStatus || null, prioridade: x.prioridade || null,
    unidade: x.unidadeNome || x.unidade || null, codigoUnidade: x.unidade || null,
    criadoPor: x.criadoPorEmail || null, criadoEm: x.criadoEm || null,
    direcionadoPara: x.direcionadoParaEmail || null, valorEstimado: x.valorEstimado ?? null,
    observacao: x.observacao ? String(x.observacao).slice(0, 500) : null,
    itens: (x.itens || []).slice(0, 20),
  };
}

async function consultarTicket(numero) {
  const n = Number(String(numero == null ? '' : numero).replace(/\D/g, ''));
  if (!n) throw new Error('Informe o número, ex.: 12052.');
  const [listaTarefas, todasSolicitacoes] = await Promise.all([tarefas.porNumero(n), solicitacoes.listAll()]);
  const achadas = todasSolicitacoes.filter((x) => Number(x.numeroTicket) === n);
  return {
    numero: n,
    tarefas: listaTarefas.map(tarefaCompacta),
    solicitacoes: achadas.map(solicitacaoCompacta),
    aviso: !listaTarefas.length && !achadas.length ? 'Nenhuma tarefa nem solicitação com esse número (estorno e ajuste de fechamento não entram nesta consulta).' : null,
  };
}

async function listarTarefas(p) {
  const unidade = minusc(p.unidade).trim(); const termo = minusc(p.termo).trim();
  const resp = minusc(p.responsavel).trim(); const status = String(p.status || '').trim().toUpperCase();
  const limite = limiteDe(p.limite, 40, 100);
  const abertas = await tarefas.listarAbertas();
  const filtradas = abertas.filter((t) => (!status || t.status === status)
    && (!unidade || minusc(t.unidade).includes(unidade) || minusc(t.unidadeNome).includes(unidade))
    && (!resp || contem([t.responsavelNome, t.responsavelEmail], resp))
    && contem([t.titulo, t.descricao, t.numeroTicket, t.unidadeNome, t.responsavelNome], termo))
    .sort((a, b) => String(b.atualizadoEm || '').localeCompare(String(a.atualizadoEm || '')));
  return {
    total: filtradas.length, mostrando: Math.min(limite, filtradas.length),
    // o teto da consulta: se bateu, a lista pode estar incompleta
    listaCompleta: abertas.length < tarefas.LIMITE_ABERTAS_AGENTE,
    tarefas: filtradas.slice(0, limite).map(tarefaCompacta),
  };
}

async function listarSolicitacoes(p) {
  const unidade = minusc(p.unidade).trim(); const termo = minusc(p.termo).trim();
  const tipo = minusc(p.tipo).trim(); const status = String(p.status || '').trim().toUpperCase();
  const limite = limiteDe(p.limite, 40, 100);
  const filtradas = (await solicitacoes.listAll()).filter((x) => !x.teste
    && (!status || x.status === status) && (!tipo || minusc(x.tipo) === tipo)
    && (!unidade || minusc(x.unidade).includes(unidade) || minusc(x.unidadeNome).includes(unidade))
    && contem([x.titulo, x.observacao, x.numeroTicket, x.unidadeNome, x.criadoPorEmail, x.tipo], termo))
    .sort((a, b) => String(b.criadoEm || '').localeCompare(String(a.criadoEm || '')));
  return { total: filtradas.length, mostrando: Math.min(limite, filtradas.length), solicitacoes: filtradas.slice(0, limite).map(solicitacaoCompacta) };
}

async function lerChatTicket(p) {
  let alvo = null;
  if (p.solicitacaoId) alvo = await solicitacoes.getOne(String(p.solicitacaoId));
  else if (p.numero) {
    const n = Number(String(p.numero).replace(/\D/g, ''));
    alvo = (await solicitacoes.listAll()).find((x) => Number(x.numeroTicket) === n) || null;
  } else throw new Error('Informe o numero ou o solicitacaoId.');
  if (!alvo) throw new Error('Solicitação não encontrada.');
  const mensagens = await centralChat.listByCard(alvo.tipo, alvo.id);
  return {
    solicitacao: solicitacaoCompacta(alvo),
    mensagens: mensagens.map((m) => ({ por: m.autorUsername || m.autorEmail || 'Usuário', em: m.criadoEm, texto: m.texto || '', temFoto: !!m.imagem })),
  };
}

async function listarUsuarios(p) {
  const cargo = minusc(p.cargo).trim(); const unidade = minusc(p.unidade).trim(); const termo = minusc(p.termo).trim();
  const limite = limiteDe(p.limite, 40, 150);
  const todos = await users.list();
  const filtrados = todos.filter((u) => (p.incluirInativos || u.active !== false)
    && (!cargo || (u.cargos || []).some((c) => minusc(c).includes(cargo)) || minusc(u.cargo).includes(cargo) || (cargo === 'master' && u.role === 'master'))
    && (!unidade || (u.permissions && (u.permissions.unidades || []).some((x) => minusc(x).includes(unidade))))
    && contem([u.username, u.email], termo))
    .sort((a, b) => minusc(a.username || a.email).localeCompare(minusc(b.username || b.email)));
  return {
    total: filtrados.length, mostrando: Math.min(limite, filtrados.length),
    usuarios: filtrados.slice(0, limite).map((u) => ({
      username: u.username || null, email: u.email, papel: u.role === 'master' ? 'master' : (u.isAdmin ? 'admin' : 'usuario'),
      cargo: u.cargo || null, cargos: u.cargos || [], ativo: u.active !== false, bloqueado: !!u.locked,
      unidades: u.permissions ? (u.permissions.unidades || []) : 'todas (master)',
      secoes: u.permissions ? (u.permissions.sections || []) : 'todas (master)',
    })),
  };
}

const TRANSCRICAO_MAX_CARACTERES = 200000;
async function lerReuniao(p) {
  let t = null;
  if (p.tarefaId) t = await tarefas.getOne(String(p.tarefaId));
  else if (p.numero) t = (await tarefas.porNumero(p.numero)).find((x) => x.ehReuniao) || null;
  else throw new Error('Informe tarefaId ou numero.');
  if (!t || !t.ehReuniao) throw new Error('Reunião não encontrada.');
  const anexosTranscricao = (t.anexos || []).filter((a) => a.transcricao || tarefas.ehArquivoDeTranscricao(a.nome)).slice(-3);
  const transcricoes = [];
  for (const a of anexosTranscricao) {
    const buf = await storage.baixarArquivo(a.path);
    const texto = tarefas.textoDaTranscricao(buf, a.nome);
    transcricoes.push({
      nome: a.nome, enviadaPor: a.enviadoPorNome || null, em: a.enviadoEm || null,
      texto: texto ? texto.slice(0, TRANSCRICAO_MAX_CARACTERES) : null,
      cortada: !!texto && texto.length > TRANSCRICAO_MAX_CARACTERES,
      aviso: texto ? null : 'Não consegui ler o texto deste arquivo.',
    });
  }
  return {
    ...tarefaCompacta(t), duracaoMin: t.duracaoMin || null, linkReuniao: t.linkReuniao || null,
    descricao: t.descricao || null,
    resumo: t.resumoReuniao ? { texto: t.resumoReuniao.texto, por: t.resumoReuniao.porNome, em: t.resumoReuniao.em } : null,
    anotacoes: (t.comentarios || []).filter((c) => !c.sistema).map((c) => ({ por: c.porNome, em: c.em, texto: c.texto })),
    decisoes: (t.decisoes || []).map((d) => ({ ticket: d.numeroTicket, titulo: d.titulo, tarefaId: d.tarefaId })),
    subtarefas: (t.subtarefas || []).map((x) => ({ titulo: x.titulo, feita: !!(x.feita || x.concluida) })),
    transcricoes,
  };
}

// ---------- DEFESA DE CHARGEBACK ----------
function casoCompacto(c) {
  return {
    disputaId: c.id, status: c.status, resultado: c.resultado || null, unidade: c.unidade,
    valor: c.valor ?? null, dataCompra: c.dataCompra || null, cartao: [c.metodo ? String(c.metodo).toUpperCase() : '', c.last4 ? 'final ' + c.last4 : ''].filter(Boolean).join(' ') || null,
    motivo: c.motivoAdyen ? `${defesaChargeback.traduzirMotivo(c.motivoAdyen).pt} (${c.motivoAdyen})` : null,
    prazoAdyen: c.prazoDefesa || null, prazoInterno: c.prazoInterno || null,
    pspPagamento: c.pspPagamento || null, pspDisputa: c.pspDisputa || null, pedidoAdyen: c.pedidoId,
    tarefaId: c.tarefaId || null, tarefaTicket: c.tarefaNumero || null, responsavel: c.responsavelNome || null,
    defesaPronta: !!c.defesaProntaEm, decisaoDaUnidade: c.decisao || null, avisoFraudeEm: c.avisoFraudeEm || null,
    envio: c.envio || null, aceite: c.aceite || null,
  };
}
async function listarDisputas(p) {
  const unidade = minusc(p.unidade).trim(); const status = String(p.status || '').trim().toUpperCase();
  const limite = limiteDe(p.limite, 40, 100);
  const lista = (await disputes.listAll()).filter((c) => (!status || c.status === status)
    && (!unidade || minusc(c.unidade).includes(unidade)) && (!p.somenteProntas || (c.defesaProntaEm && c.status === 'ABERTA')))
    // o que vence primeiro vem primeiro
    .sort((a, b) => String(a.prazoInterno || a.prazoDefesa || '9').localeCompare(String(b.prazoInterno || b.prazoDefesa || '9')));
  return { total: lista.length, mostrando: Math.min(limite, lista.length), disputas: lista.slice(0, limite).map(casoCompacto) };
}
async function acharCaso(p) {
  if (p.disputaId) return disputes.getOne(String(p.disputaId));
  const todos = await disputes.listAll();
  if (p.psp) return todos.find((c) => c.pspPagamento === p.psp || c.pspDisputa === p.psp || c.pedidoId === p.psp) || null;
  if (p.numero) { const n = Number(String(p.numero).replace(/\D/g, '')); return todos.find((c) => Number(c.tarefaNumero) === n) || null; }
  throw new Error('Informe disputaId, numero (ticket da tarefa) ou psp.');
}
async function obterDisputa(p) {
  const c = await acharCaso(p);
  if (!c) throw new Error('Disputa não encontrada.');
  const tarefa = c.tarefaId ? await tarefas.getOne(c.tarefaId) : null;
  const respostas = (tarefa && tarefa.defesaChargeback && tarefa.defesaChargeback.respostas) || {};
  const segredo = process.env.JWT_SECRET || '';
  const base = String(process.env.APP_BASE_URL || 'https://www.nopulso.com.br').replace(/\/$/, '');
  const link = (caminho, nome) => `${base}/api/defesa-arquivo?t=${encodeURIComponent(defesaChargeback.assinarLink(caminho, nome, segredo))}`;
  const evidencias = (c.evidencias && c.evidencias.length ? c.evidencias : ((tarefa && tarefa.anexos) || []).filter((a) => a.evidencia));
  return {
    ...casoCompacto(c),
    tarefa: tarefa ? { status: tarefa.status, ticket: tarefa.numeroTicket, concluidaEm: tarefa.concluidaEm || null, concluidaPor: tarefa.concluidaPorNome || null } : null,
    respostasDaUnidade: defesaChargeback.QUESTOES.filter((q) => respostas[q.id] != null && q.id !== 'telefoneCliente')
      .map((q) => ({ pergunta: q.rotulo, resposta: Array.isArray(respostas[q.id]) ? respostas[q.id].join('; ') : String(respostas[q.id]) })),
    faltaNaDefesa: tarefa && tarefa.defesaChargeback ? defesaChargeback.faltando(respostas, tarefa.anexos) : [],
    pdfDaDefesa: c.defesaPdf ? { link: link(c.defesaPdf.path, c.defesaPdf.nome), paginas: c.defesaPdf.paginas, tamanhoKB: Math.round((c.defesaPdf.tamanho || 0) / 1024), avisos: c.defesaPdf.avisos || [] } : null,
    evidencias: evidencias.map((a) => {
      const e = defesaChargeback.EVIDENCIAS.find((x) => x.id === a.evidencia);
      return { tipo: e ? e.rotulo : a.evidencia, nome: a.nome, link: link(a.path, a.nome) };
    }),
    linksValemAte: new Date(Date.now() + defesaChargeback.VALIDADE_LINK_MS).toISOString(),
    comoAnexar: c.defesaPdf
      ? 'Na Adyen: Disputes -> abra a disputa ' + (c.pspDisputa || '(ver pspPagamento)') + ' -> Defend -> anexe o PDF da defesa (e as evidências em separado se houver aviso de tamanho). Depois de enviar, chame registrar_defesa_enviada.'
      : 'A defesa ainda não está pronta: a unidade precisa concluir a tarefa de defesa no Meu Dia.',
  };
}
async function registrarNaDisputa(nome, p, ator) {
  const c = await disputes.getOne(String(p.disputaId));
  if (!c) throw new Error('Disputa não encontrada.');
  if (['GANHA', 'PERDIDA'].includes(c.status)) throw new Error(`Essa disputa já está encerrada (${c.status}).`);
  const porNome = `Claude (Cowork) · ${ator.username || ator.email}`;
  if (nome === 'registrar_defesa_enviada') {
    // sem PDF gerado não houve defesa pelo NoPulso - registrar ENVIADA aqui
    // esconderia uma disputa que ainda pode vencer sem resposta
    if (!c.defesaProntaEm) throw new Error('A defesa ainda não foi gerada: a tarefa da unidade não foi concluída.');
    const r = await disputes.registrarAcao(c.id, { status: 'ENVIADA', porNome, observacao: p.observacao, campo: 'envio' });
    return `Disputa ${r.id} registrada como ENVIADA.`;
  }
  const r = await disputes.registrarAcao(c.id, { status: 'PERDIDA', porNome, observacao: p.observacao || 'Chargeback aceito sem defesa.', campo: 'aceite' });
  await disputes.salvarCaso(c.id, { resultado: 'chargeback aceito sem defesa' });
  return `Disputa ${r.id} registrada como PERDIDA (aceita).`;
}

async function despachar(nome, entrada, ator) {
  const p = { ...(entrada || {}), porId: ator.id };
  if (nome === 'listar_disputas') return listarDisputas(p);
  if (nome === 'obter_disputa') return obterDisputa(p);
  if (nome === 'registrar_defesa_enviada' || nome === 'registrar_disputa_aceita') return registrarNaDisputa(nome, p, ator);
  if (nome === 'consultar_ticket') return consultarTicket(p.numero);
  if (nome === 'listar_tarefas') return listarTarefas(p);
  if (nome === 'listar_solicitacoes') return listarSolicitacoes(p);
  if (nome === 'ler_chat_ticket') return lerChatTicket(p);
  if (nome === 'listar_usuarios') return listarUsuarios(p);
  if (nome === 'ler_reuniao') return lerReuniao(p);
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
