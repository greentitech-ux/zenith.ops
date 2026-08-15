// suporteBot.js
// "Beniboy" - atendente virtual do chat de suporte (widget 💬). Quando
// NENHUM humano assumiu a conversa, ele responde sozinho usando a API da
// Claude (Anthropic): tira duvidas rapidas sobre o Zenith, CRIA TICKET na
// Central direto pela conversa (compra/manutencao/TI/pagamento/nota),
// consulta o andamento de um ticket pelo numero e chama um atendente humano
// quando o assunto foge do alcance dele. Diretrizes de produto: atende
// QUALQUER pessoa (inclusive deslogada - o widget e publico), com BAIXA
// interacao (poucas trocas, direto ao ponto) e respostas curtas/objetivas.
//
// O bot so existe se a env var ANTHROPIC_API_KEY estiver configurada (no
// Render). Sem ela, tudo aqui vira no-op e o chat segue 100% humano, como
// era antes. A chave NUNCA aparece em codigo - so na env var.
//
// Quando o bot se cala (e o humano assume):
// - alguem do time respondeu na conversa (atendidoPorEmail preenchido);
// - o proprio bot chamou um atendente (botDesativado, via tool);
// - a conversa passou do limite de respostas do bot (baixa interacao).
const suporteChat = require('./suporteChat');
const solicitacoes = require('./solicitacoes');
const store = require('./store');
const pedidoWatch = require('./pedidoWatch');
const users = require('./users');
const abastecimentoCarrinho = require('./abastecimentoCarrinho');
const agenteAcoes = require('./agenteAcoes');
const qaAprovacoes = require('./qaAprovacoes');

// senha padrao que o Beniboy define quando a pessoa NAO lembra a senha atual
// (2a vez que o mesmo acesso trava depois de ja ter sido desbloqueado por
// ele) - literalmente os digitos de 1 a 8, pedido explicito do usuario;
// obriga trocar por uma propria no primeiro login (ver users.resetPassword)
const SENHA_PADRAO_BOT = '12345678';

const MODELO = 'claude-opus-5';
const MAX_TOKENS = 700;
const MAX_RODADAS_TOOLS = 5; // seguranca do loop de tool use
// baixa interacao: depois disso o bot para de responder e o humano continua
const MAX_RESPOSTAS_BOT = 8;

// rede de seguranca: as vezes o modelo escreve na resposta final que "ja
// chamou" um atendente sem de fato ter chamado a ferramenta chamar_atendente
// nessa rodada (ver instrucao no prompt acima) - se isso acontecer, o alarme
// (push + SSE, ver notifyBeniboyEscalonamento) nunca dispararia mesmo com a
// pessoa esperando um humano que ninguem avisou. Detecta a frase e forca o
// escalonamento de verdade, garantindo que a fala e a acao andem juntas.
const ESCALACAO_VERBO_RE = /\b(chamei|chamado|chamando|chamaria|vou\s+chamar|acionei|acionado|acionando|acionaria|vou\s+acionar|notifiquei|notificado|notificando|notificaria|vou\s+notificar)\b/i;
const ESCALACAO_ALVO_RE = /\b(atendente|humano|suporte|time)\b/i;

// tipos que o bot pode abrir na Central (mesma lista do formulario publico -
// estorno e ajuste de fechamento ficam de fora, tem fluxo proprio com login)
const TIPOS_TICKET = ['compra', 'manutencao', 'suporte-ti', 'pagamento', 'nota'];

let cliente = null;
function ativo() {
  return !!process.env.ANTHROPIC_API_KEY;
}
function getCliente() {
  if (!cliente) {
    const Anthropic = require('@anthropic-ai/sdk');
    cliente = new Anthropic(); // le ANTHROPIC_API_KEY da env var sozinho
  }
  return cliente;
}

// conhecimento base (resumo da Ajuda) + regras de conduta. E o bloco ESTAVEL
// do system - vai com cache_control pra nao pagar o prompt inteiro de novo a
// cada mensagem da mesma conversa (so a lista de unidades e o "logado"
// variam, e raramente mudam no meio de uma mesma conversa)
// texto livre de conhecimento/orientacao (editado pelo Master no painel NOC
// Zenith, ver agenteAcoes.js) - pedido explicito do usuario: "ensine tudo a
// ele pra que ele possa ensinar as pessoas que procurarem ajuda". SEM gate
// de logado/isMaster de proposito: só EDITAR o texto é Master-only (rota
// PUT /api/agente/contexto), mas o CONTEUDO precisa chegar em QUALQUER
// conversa - cliente final deslogado incluido - senao nunca ajuda ninguem
// alem do proprio Master conversando com o bot
async function montarBlocoConhecimento() {
  const contexto = await agenteAcoes.obterContexto();
  return contexto.texto ? `\n\n## Conhecimento adicional (definido pelo Master)\n${contexto.texto}` : '';
}

// bloco NOC Zenith do prompt - so pra Master de verdade (mais restrito que
// os outros blocos condicionais, dado o poder da ferramenta). Só o CATALOGO
// de acoes executaveis fica aqui (o texto de conhecimento saiu pra
// montarBlocoConhecimento acima, que e universal) - busca fresco toda vez,
// mesmo espirito do "logado" variar por conversa
async function montarBlocoAgente(logado) {
  if (!logado || !logado.isMaster) return '';
  const acoes = await agenteAcoes.listarAtivas();
  const listaAcoes = acoes.length
    ? acoes.map((a) => `- [${a.id}] ${a.nome}: ${a.descricao} (${a.requerAprovacao ? 'precisa de aprovação do Master' : 'executa direto, sem aprovação'})`).join('\n')
    : '(nenhuma ação cadastrada ainda)';
  return `\n\n## NOC Zenith - ações que você pode executar (ferramenta executar_acao_agente)
Catálogo de ações cadastradas pelo Master (use o [id] exato ao chamar a ferramenta):
${listaAcoes}`;
}

async function montarSystem(unidades, logado) {
  const temFerramentaPedido = !!(logado && logado.temMonitor);
  const [blocoConhecimento, blocoAgente] = await Promise.all([montarBlocoConhecimento(), montarBlocoAgente(logado)]);
  const texto = `Você é o Beniboy, atendente virtual do chat de suporte do Zenith Ops.

O Zenith Ops é o sistema interno de gestão do grupo (lojas Domino's, Spoleto, Milky Moo, São Braz e o parque Saltiverso). Quem fala com você pode ser um funcionário/parceiro das lojas OU o CLIENTE FINAL de uma loja (o comprador, ex: alguém que quer um estorno) - na maioria das vezes de estorno é o próprio cliente falando direto com você, não um funcionário repassando. Não assuma qual dos dois é sem contexto - se não estiver claro, pergunte. De qualquer forma, a pessoa pode estar deslogada.

## Estilo (obrigatório)
- Respostas CURTAS e objetivas: 1 a 4 frases, sem enrolação, sem repetir o que a pessoa disse.
- BAIXA interação: resolva no menor número de trocas possível. Se der pra agir já, aja; se faltar só 1 dado, pergunte só ele (uma pergunta por vez).
- Português do Brasil, tom simpático e direto. Nada de listas longas nem textão.
- NUNCA diga que "chamou", "chamei", "acionei" ou "notifiquei" um atendente/time humano sem ter chamado a ferramenta chamar_atendente NESSA MESMA resposta - isso dispara um alarme real pro time, então a frase e a ação têm que andar sempre juntas. Se ainda não chamou a ferramenta, chame agora ou fale só no futuro ("posso chamar um atendente", "vou chamar um atendente").
- Nunca invente informação sobre o sistema. Se não souber ou o assunto for sensível (senha de outra pessoa, dados financeiros, urgência grave), use chamar_atendente.

## O que você sabe do Zenith
- Login bloqueado (3 senhas erradas seguidas): SEMPRE use desbloquear_login pra resolver na hora, nunca chame um atendente pra isso - vale tanto pro login principal do Zenith quanto pro login de operador do Abastecimento do Carrinho (balcão, 4 letras + 4 números). A pessoa volta a entrar com a MESMA senha de sempre; só se o mesmo acesso travar de novo é que entra uma senha nova (ver ferramenta abaixo).
- Estorno: NÃO dá pra você abrir esse ticket direto (exige login com acesso ao Monitor) - em vez disso, pergunte em qual loja foi a compra (pule essa pergunta se já souber pela "loja" do início da conversa) e use gerar_link_estorno_cliente. Se quem fala com você É o cliente (o mais comum), mande o link JÁ NESSA CONVERSA pra ele clicar e preencher ali mesmo - não precisa de WhatsApp nem de mais ninguém no meio. Se for um funcionário pedindo em nome de um cliente que não está no chat, aí sim ele repassa o link pro cliente por onde for mais fácil (WhatsApp é uma opção, não a única).
- Acessos/permissões por tela (Fechamentos, Entregas, Estoque, Central, Chamados, Parque...) são liberados pelo Master na tela Usuários.
- Central de Solicitações: pedidos de compra, manutenção, suporte de TI, pagamento (boleto/despesa) e nota fiscal viram tickets numerados (#10000 em diante) que o Master aprova ou rejeita. Depois de aprovado, o andamento aparece no ticket.
- Fechamento de caixa: lançado em Lançar fechamento; erro em fechamento já enviado se corrige pelo botão "Pedir correção" no Histórico da Central (só 1 correção pendente por lançamento).
- Chamados de TI/Manutenção: nascem de tickets aprovados ou direto pelo time técnico; têm prioridade e prazo (SLA).
- Chat de suporte (onde você está): a conversa fica salva no navegador da pessoa; o time humano vê tudo e pode assumir a qualquer momento. Esse chat é o canal PADRÃO de atendimento agora - resolva por aqui sempre que der.
- Suporte humano por WhatsApp: (81) 99514-8654 - é o ÚLTIMO recurso, só quando não der pra resolver por aqui de nenhum jeito (ex: chamar_atendente escalar e a pessoa insistir em outro canal). Nunca ofereça WhatsApp como primeira opção.

## Ferramentas
- criar_ticket: abre uma solicitação na Central. Antes de criar, CONFIRME em uma única mensagem o resumo (tipo, unidade, o que é). Só crie depois do "sim" da pessoa. Depois de criar, informe o número do ticket.
- consultar_ticket: andamento de um ticket pelo número.
- chamar_atendente: acione quando a pessoa pedir um humano, quando você não souber resolver, ou quando o assunto for sensível. Avise que o time já foi chamado e responde ali mesmo na conversa.
- desbloquear_login: destrava um acesso bloqueado (3 senhas erradas) - login principal do Zenith OU operador do Abastecimento do Carrinho, a ferramenta identifica sozinha qual é. Peça o nome de usuário ANTES de chamar. Por padrão mantém a MESMA senha - nunca invente nem envie senha nenhuma nessa primeira chamada. Se travar de novo: no login principal, PERGUNTE "você lembra da sua senha atual?" antes de chamar de novo com lembraSenha=true/false (só com false uma senha padrão é definida, e a pessoa é obrigada a cadastrar uma própria no próximo login); no operador do Abastecimento, a ferramenta já reseta pra uma senha nova sozinha - é só repassar a senha que ela devolver.${temFerramentaPedido ? `
- consultar_pedido: consulta o status de UM pedido específico no Monitor (aprovado, recusado, estornado, fraude suspeita). Peça os 3 dados ANTES de chamar (uma pergunta por vez, o que faltar): o código da loja (IDPULSE, a mesma coluna "Unidade" do Fechamento), o nome do cliente e o valor do pedido. A busca já vem limitada às lojas que essa pessoa tem acesso - se não achar, pode ser de outra loja, não assuma fraude/erro. Nunca invente status; se a ferramenta não achar nada, diga isso e ofereça chamar_atendente. Se o status desse pedido mudar depois da sua resposta, a pessoa é avisada automaticamente - não precisa te perguntar de novo.` : `
- Pedido estornado/fraude/aprovado no Monitor: você NÃO tem acesso a isso agora (só quem está logado com permissão de Monitor). Use chamar_atendente.`}${(logado && logado.isMaster) ? `
- executar_acao_agente: executa uma ação do catálogo NOC Zenith (veja a lista mais abaixo). Use SÓ pra ações que estão nessa lista - nunca invente uma ação nem tente rodar algo fora do catálogo. Se a ação precisar de aprovação, avise que mandou pro Master aprovar; se não precisar, informe o resultado direto.` : ''}

## Unidades válidas pra ticket (use exatamente um destes nomes; se a pessoa falar parecido, escolha o mais próximo; se não der pra saber, pergunte)
${unidades.map((u) => `- ${u}`).join('\n')}
${logado ? `\n## Quem fala com você agora\nConta logada: ${logado.username}${logado.isMaster ? ' (Master)' : ''}. ${temFerramentaPedido ? 'Tem acesso ao Monitor - pode usar consultar_pedido.' : 'Sem acesso ao Monitor - não tente consultar pedido, use chamar_atendente se precisar.'}` : ''}${blocoConhecimento}${blocoAgente}`;
  return [{ type: 'text', text: texto, cache_control: { type: 'ephemeral' } }];
}

const TOOLS_BASE = [
  {
    name: 'criar_ticket',
    description: 'Cria uma solicitação (ticket) na Central do Zenith. Use somente depois que a pessoa confirmar o resumo do pedido.',
    input_schema: {
      type: 'object',
      properties: {
        tipo: { type: 'string', enum: TIPOS_TICKET, description: 'compra = comprar algo pra loja; manutencao = consertar algo físico; suporte-ti = problema de computador/sistema/acesso; pagamento = boleto/despesa pro financeiro; nota = pedido de nota fiscal' },
        unidade: { type: 'string', description: 'Nome da unidade/loja, exatamente como na lista do prompt' },
        titulo: { type: 'string', description: 'Resumo curto do pedido (até 200 caracteres)' },
        descricao: { type: 'string', description: 'Detalhes relevantes que a pessoa passou' },
        prioridade: { type: 'string', enum: ['critica', 'alta', 'media', 'baixa'], description: 'Padrão: media. Só suba se a pessoa indicar urgência real.' },
      },
      required: ['tipo', 'unidade', 'titulo'],
    },
  },
  {
    name: 'consultar_ticket',
    description: 'Consulta o andamento de um ticket da Central pelo número (ex: 10045).',
    input_schema: {
      type: 'object',
      properties: { numero: { type: 'integer', description: 'Número do ticket, sem o #' } },
      required: ['numero'],
    },
  },
  {
    name: 'chamar_atendente',
    description: 'Chama um atendente humano pra essa conversa e encerra a sua participação. Use quando não souber resolver, quando a pessoa pedir, ou em assunto sensível.',
    input_schema: {
      type: 'object',
      properties: { motivo: { type: 'string', description: 'Resumo de 1 linha do que a pessoa precisa, pro atendente já chegar sabendo' } },
    },
  },
  {
    name: 'desbloquear_login',
    description: 'Desbloqueia um login que travou após 3 senhas erradas - do Zenith Ops OU um operador do Abastecimento do Carrinho (login de balcão, 4 letras + 4 números) - por padrão SEM mudar a senha (a pessoa volta a entrar com a mesma de sempre). Peça o nome de usuário antes de chamar. Se a ferramenta pedir, pergunte se a pessoa lembra a senha e chame de novo com lembraSenha preenchido (só existe pro login principal - operador do Abastecimento já reseta direto na segunda vez).',
    input_schema: {
      type: 'object',
      properties: {
        username: { type: 'string', description: 'Nome de usuário (login curto) de quem está bloqueado.' },
        lembraSenha: { type: 'boolean', description: 'Só preencha quando a ferramenta avisar que esse acesso já foi desbloqueado antes e travou de novo: true se a pessoa lembra a senha atual, false se não lembra.' },
      },
      required: ['username'],
    },
  },
  {
    name: 'gerar_link_estorno_cliente',
    description: 'Gera o link público (sem login) pra preencher um pedido de estorno com foto do comprovante - o Master avalia depois. Use sempre que alguém (o próprio cliente final, ou um funcionário em nome dele) precisar pedir um estorno. Peça o nome da loja da compra ANTES de chamar (pule se já souber pelo contexto da conversa). Se a ferramenta devolver uma lista de lojas parecidas, pergunte qual delas é a certa e chame de novo com o nome exato.',
    input_schema: {
      type: 'object',
      properties: {
        unidade: { type: 'string', description: 'Nome da loja onde o cliente fez o pedido, do jeito que a pessoa falou (ex: "Dom Bessa", "Caruaru").' },
      },
      required: ['unidade'],
    },
  },
];

// so entra na lista de ferramentas quando chat.logado.temMonitor (ver
// usuarioLogadoDoHeader em index.js) - visitante anonimo ou logado sem
// permissao de Monitor nunca ve nem essa ferramenta oferecida ao modelo
const TOOL_CONSULTAR_PEDIDO = {
  name: 'consultar_pedido',
  description: 'Consulta o status de um pedido/transação específico no Monitor (aprovado, recusado, estornado, fraude suspeita). Só disponível pra quem está logado com acesso (Monitor ou tag de Gerente) - o resultado já vem limitado às lojas dessa pessoa. Exige os 3 dados: código da loja (IDPULSE), nome do cliente e valor.',
  input_schema: {
    type: 'object',
    properties: {
      idPulse: { type: 'string', description: 'Código numérico da loja (IDPULSE), igual aparece na coluna "Unidade" do Fechamento - ex: 19888, 19798, 19911.' },
      nomeCliente: { type: 'string', description: 'Nome do cliente do pedido, como a pessoa souber (pode ser parcial).' },
      valor: { type: 'string', description: 'Valor do pedido em reais, como a pessoa informar (ex: "45,90").' },
    },
    required: ['idPulse', 'nomeCliente', 'valor'],
  },
};

// so entra na lista quando logado.isMaster (mais restrito que o
// consultar_pedido acima - essa ferramenta pode chegar a executar coisas de
// verdade, ver EXECUTORES_ACAO_SISTEMA/comando_maquina em agenteAcoes.js)
const TOOL_EXECUTAR_ACAO_AGENTE = {
  name: 'executar_acao_agente',
  description: 'Executa uma ação cadastrada no catálogo NOC Zenith (lista completa vem no prompt, com o [id] de cada uma). Use só pra ações que estão literalmente nessa lista - nunca invente uma ação. Se a ação precisar de "codigo"/"posto" (comando de máquina), pergunte qual computador antes de chamar.',
  input_schema: {
    type: 'object',
    properties: {
      acaoId: { type: 'string', description: 'O [id] exato da ação, copiado da lista do prompt.' },
      parametros: { type: 'object', description: 'Dados que essa ação específica precisa (ver a descrição dela no prompt) - ex: codigo/posto pra comando de máquina, ou email/username/permissions pra criar um usuário do Zenith.' },
      resumo: { type: 'string', description: 'Resumo de 1 linha do que vai ser feito, pro card de aprovação (se precisar) ou pro registro do que foi executado.' },
    },
    required: ['acaoId', 'resumo'],
  },
};

function montarTools(logado) {
  const tools = (logado && logado.temMonitor) ? [...TOOLS_BASE, TOOL_CONSULTAR_PEDIDO] : [...TOOLS_BASE];
  if (logado && logado.isMaster) tools.push(TOOL_EXECUTAR_ACAO_AGENTE);
  return tools;
}

// historico da conversa -> turns da API. Mensagens do visitante viram user;
// as do bot viram assistant. Se um humano do time ja falou, o bot nem chega
// aqui (gate em responderConversa)
function montarMensagens(chat) {
  const turnos = [];
  const contexto = `(Início da conversa. Quem escreve: ${chat.nome || 'visitante'}${chat.contato ? ` · contato: ${chat.contato}` : ''}${chat.lojaContexto ? ` · loja: ${chat.lojaContexto} (já sabida pelo link/QR code que a pessoa usou - não precisa perguntar de novo)` : ''})`;
  for (const m of chat.mensagens || []) {
    const role = m.de === 'visitante' ? 'user' : 'assistant';
    const texto = String(m.texto || '').trim();
    if (!texto) continue;
    if (turnos.length && turnos[turnos.length - 1].role === role) {
      turnos[turnos.length - 1].content += '\n' + texto;
    } else {
      turnos.push({ role, content: texto });
    }
  }
  if (turnos.length && turnos[0].role === 'user') turnos[0].content = contexto + '\n' + turnos[0].content;
  return turnos;
}

async function executarTool(nome, input, chat, resultado, resolverUnidadesPorIdPulse, resolverUnidadePublica, linkEstornoCliente) {
  if (nome === 'criar_ticket') {
    const tipo = TIPOS_TICKET.includes(input.tipo) ? input.tipo : null;
    if (!tipo) return 'Erro: tipo inválido.';
    const quem = [chat.nome, chat.contato].filter(Boolean).join(' · ');
    const registro = await solicitacoes.create({
      tipo,
      unidade: String(input.unidade || '').trim(),
      unidadeNome: String(input.unidade || '').trim(),
      titulo: String(input.titulo || '').trim(),
      observacao: [String(input.descricao || '').trim(), `Aberto pelo Beniboy (chat de suporte)${quem ? ' — ' + quem : ''}.`].filter(Boolean).join('\n\n'),
      itens: [], anexos: [], ehOrcamento: false,
      prioridade: input.prioridade,
      criadoPorId: null,
      criadoPorEmail: `Beniboy (chat de suporte)${quem ? ' — ' + quem : ''}`,
      direcionadoParaId: null, direcionadoParaEmail: null,
      // o ticket herda o MESMO numero do protocolo dessa conversa, em vez de
      // tirar um novo da sequencia - pedido explicito do usuario: "o numero
      // do ticket sempre sera o mesmo do protocolo... o proximo ticket tem
      // que ser na sequencia, nunca repetir"
      numeroTicket: chat.numeroTicket,
    });
    resultado.tickets.push(registro);
    await suporteChat.adicionarTicketVinculado(chat.id, { tipo: 'solicitacao', ticketId: registro.id, numero: registro.numeroTicket });
    return `Ticket #${registro.numeroTicket} criado com sucesso (tipo ${tipo}, unidade ${registro.unidadeNome}). Informe esse número à pessoa.`;
  }
  if (nome === 'consultar_ticket') {
    const numero = Number(input.numero);
    const todos = await solicitacoes.listAll();
    const t = todos.find((s) => s.numeroTicket === numero);
    if (!t) return `Nenhum ticket #${numero} encontrado na Central (pode ser de outro tipo, ex. estorno ou correção de fechamento — nesse caso, chame um atendente).`;
    return JSON.stringify({
      numero: t.numeroTicket, tipo: t.tipo, titulo: t.titulo, unidade: t.unidadeNome || t.unidade,
      status: t.status, andamento: t.execucaoStatus || null, prioridade: t.prioridade || null,
      criadoEm: t.criadoEm, decididoEm: t.decididoEm, motivoDecisao: t.motivoDecisao || null,
    });
  }
  if (nome === 'chamar_atendente') {
    await suporteChat.desativarBot(chat.id);
    resultado.chamouAtendente = true;
    resultado.motivoAtendente = String(input.motivo || '').trim();
    return 'Atendente humano chamado — o time foi notificado e vai responder nessa mesma conversa. Avise a pessoa e se despeça.';
  }
  if (nome === 'desbloquear_login') {
    const usuarioAlvo = String(input.username || '').trim();
    if (!usuarioAlvo) return 'Peça o nome de usuário (login curto) de quem está bloqueado.';
    // etiqueta essa conversa como "Desbloqueio" na Central do Beniboy (ver
    // beniboy.html) assim que a ferramenta e de fato chamada - independente
    // do resultado (achou/nao achou/ja desbloqueado), o assunto ja e esse
    await suporteChat.marcarDesbloqueio(chat.id);
    const alvo = await users.findByIdentifier(usuarioAlvo);

    if (alvo) {
      if (alvo.role === 'master') return 'Não encontrei esse usuário (ou é o Master, que não desbloqueia por aqui) - chame um atendente.';

      // confere identidade antes de mexer em QUALQUER acesso: quem esta no
      // chat e do time (Master/Admin/secao suporte, ajudando outra pessoa) OU
      // o contato informado no INICIO da conversa bate com o e-mail cadastrado
      // desse acesso (autoatendimento). Sem essa checagem, qualquer visitante
      // anonimo do widget publico poderia mexer no login de QUALQUER pessoa so
      // sabendo o usuario dela.
      const staffAjudando = !!(chat.logado && chat.logado.ehTimeSuporte);
      const contatoBate = !!(chat.contato && alvo.email
        && String(chat.contato).trim().toLowerCase() === String(alvo.email).trim().toLowerCase());
      if (!staffAjudando && !contatoBate) {
        return 'Não consigo confirmar que é o dono desse acesso (o contato informado no início da conversa não bate com o e-mail cadastrado) - chame um atendente.';
      }

      if (!alvo.locked) return `O acesso de "${alvo.username || alvo.email}" não está bloqueado agora.`;

      if (!alvo.desbloqueadoPeloBotEm) {
        await users.desbloquear(alvo.id, { viaBot: true });
        return `Pronto! O acesso de "${alvo.username || alvo.email}" foi desbloqueado - a pessoa já pode entrar de novo com a MESMA senha de sempre, sem trocar nada.`;
      }
      // esse mesmo acesso ja tinha sido desbloqueado por mim antes e travou de
      // novo - pode ser que a senha esteja mesmo errada
      if (input.lembraSenha == null) {
        return 'Esse acesso já foi desbloqueado uma vez e travou de novo. Pergunte pra pessoa: "Você lembra da sua senha atual?" e chame essa mesma ferramenta de novo com lembraSenha=true (se lembrar) ou lembraSenha=false (se não lembrar - aí eu defino uma senha padrão pra ela cadastrar uma própria).';
      }
      if (input.lembraSenha) {
        await users.desbloquear(alvo.id, { viaBot: true });
        return `Desbloqueado de novo, mesma senha de sempre. Se travar outra vez, é bem provável que a senha esteja errada mesmo - vale perguntar de novo se lembra.`;
      }
      await users.resetPassword(alvo.id, SENHA_PADRAO_BOT);
      return `Prontinho! Defini a senha padrão "${SENHA_PADRAO_BOT}" pra esse acesso - a pessoa entra com ela e é OBRIGADA a cadastrar uma senha própria na hora. Avise a pessoa.`;
    }

    // nao achou no login principal do Zenith - tenta o login de operador do
    // Abastecimento do Carrinho (balcao, 4 letras + 4 numeros). Esse login ja
    // fica atras do login normal do Zenith + secao de abastecimento (nao da
    // acesso a mais nada sozinho, ver abastecimentoCarrinho.js), entao aqui
    // nao exige a mesma checagem de identidade do login principal - alias,
    // operador nao tem e-mail cadastrado pra comparar de qualquer forma
    const operador = await abastecimentoCarrinho.buscarOperadorPorUsuario(usuarioAlvo);
    if (!operador) return `Não encontrei nenhum login (nem principal, nem operador do Abastecimento do Carrinho) com o usuário "${usuarioAlvo}" - chame um atendente.`;
    if (operador.ativo === false) return `O operador "${operador.usuario}" está inativo - chame um atendente pra reativar.`;
    if (!operador.bloqueado) return `O login de operador "${operador.usuario}" não está bloqueado agora.`;

    if (!operador.desbloqueadoPeloBotEm) {
      await abastecimentoCarrinho.desbloquearOperador(operador.id, { viaBot: true });
      return `Pronto! O login de operador "${operador.usuario}" (Abastecimento do Carrinho) foi desbloqueado - a pessoa já pode entrar de novo com a MESMA senha de sempre. Se travar outra vez, é só me chamar de novo.`;
    }
    // esse operador ja tinha travado uma vez depois de eu ja ter desbloqueado
    // mantendo a senha - reseta direto pra uma nova (login de balcao, sem
    // fluxo de troca propria: a pessoa so digita a que eu passar)
    const novaSenhaOperador = String(Math.floor(1000 + Math.random() * 9000));
    await abastecimentoCarrinho.desbloquearOperador(operador.id, { novaSenha: novaSenhaOperador });
    return `Esse login de operador já tinha travado antes. Resetei a senha - a nova senha de "${operador.usuario}" é "${novaSenhaOperador}" (4 números). Informe essa senha pra pessoa digitar no login do Abastecimento do Carrinho.`;
  }
  if (nome === 'gerar_link_estorno_cliente') {
    if (!resolverUnidadePublica || !linkEstornoCliente) return 'Sem acesso a essa ferramenta agora - chame um atendente.';
    const termo = String(input.unidade || '').trim();
    if (!termo) return 'Peça o nome da loja onde o cliente fez o pedido.';
    const { encontrada, candidatas } = await resolverUnidadePublica(termo);
    if (!encontrada && !candidatas.length) {
      return `Não achei nenhuma loja parecida com "${termo}". Peça pra pessoa confirmar o nome certo (ex: "Dom Bessa", "Caruaru") ou chame um atendente.`;
    }
    if (!encontrada) {
      const nomes = candidatas.slice(0, 8).map((u) => u.nome).join(', ');
      return `Achei mais de uma loja parecida com "${termo}": ${nomes}. Pergunte qual delas é a certa e chame essa ferramenta de novo com o nome exato.`;
    }
    const link = linkEstornoCliente(encontrada.codigo);
    return `Link gerado pra loja "${encontrada.nome}": ${link}\nSe quem está falando com você é o próprio cliente, mande esse link JÁ NESSA CONVERSA pra ele clicar e preencher ali mesmo (dados do pedido + foto do comprovante), sem precisar de WhatsApp nem de mais ninguém. Se for um funcionário pedindo em nome de um cliente que não está aqui, ele repassa o link pro cliente por onde for mais fácil. De qualquer forma, um atendente humano confere e decide depois - não invente prazo nem promessa de aprovação.`;
  }
  if (nome === 'consultar_pedido') {
    // defesa em profundidade: mesmo que o modelo tentasse chamar essa tool
    // fora do previsto, ela so entra em TOOLS quando chat.logado.temMonitor -
    // aqui checa de novo antes de tocar em qualquer dado do Monitor
    if (!chat.logado || !chat.logado.temMonitor) return 'Sem acesso a essa consulta - chame um atendente.';
    const idPulse = String(input.idPulse || '').trim();
    const nomeCliente = String(input.nomeCliente || '').trim().toLowerCase();
    const valorTexto = String(input.valor || '').trim();
    if (!idPulse || !nomeCliente || !valorTexto) return 'Peça pra pessoa informar o código da loja (IDPULSE), o nome do cliente e o valor do pedido.';
    const valorNum = parseFloat(valorTexto.replace(/[^\d,.-]/g, '').replace(',', '.'));

    // resolve o IDPULSE (codigo do Fechamento) pros codigos correspondentes
    // no espaco do Monitor (merchantAccountCode da Adyen) - sem resolver
    // (config antiga, sem index.js repassando a funcao), usa o codigo cru
    const candidatos = new Set(resolverUnidadesPorIdPulse ? resolverUnidadesPorIdPulse(idPulse) : [idPulse]);
    let pedidos = store.allOrders().filter((o) => o.unidade && candidatos.has(o.unidade));
    if (!chat.logado.isMaster) {
      const permitidas = new Set(chat.logado.unidades || []);
      pedidos = pedidos.filter((o) => permitidas.has(o.unidade));
    }
    pedidos = pedidos.filter((o) => String(o.cliente || '').toLowerCase().includes(nomeCliente));
    if (!Number.isNaN(valorNum)) {
      pedidos = pedidos.filter((o) => Math.abs((o.valor || 0) - valorNum) < 0.01);
    }
    const encontrados = pedidos
      .sort((a, b) => String(b.ultimaAtualizacao || '').localeCompare(String(a.ultimaAtualizacao || '')))
      .slice(0, 5);
    if (!encontrados.length) return 'Nenhum pedido encontrado com esses dados nas lojas que essa pessoa tem acesso (confira o código da loja, o nome e o valor - ou pode ser de outra loja, ou já saiu da retenção do Monitor).';
    // registra o "retrato" do status visto agora - se mudar depois, a pessoa
    // e avisada sozinha (SSE com o Zenith aberto + push com fechado), sem
    // precisar voltar aqui perguntar de novo (ver pedidoWatch.js/index.js)
    for (const o of encontrados) {
      pedidoWatch.registrar({ pedidoId: o.pedidoId, userId: chat.logado.id, unidade: o.unidade, statusVisto: o.statusAtual, chatId: chat.id }).catch(() => {});
    }
    return JSON.stringify(encontrados.map((o) => ({
      pedido: o.pedidoId, unidade: o.unidade, cliente: o.cliente, valor: o.valor,
      status: o.statusAtual, metodo: o.metodo, cartaoFinal: o.last4,
      aprovadoEm: o.dataCompra, estornadoEm: o.dataChargeback, fraudeSuspeita: !!o.fraudeSuspeita,
    })));
  }
  if (nome === 'executar_acao_agente') {
    // defesa em profundidade: mesmo espirito do recheck de consultar_pedido
    // - so entra em TOOLS quando logado.isMaster, mas confere de novo aqui
    // antes de tocar em qualquer execucao real
    if (!chat.logado || !chat.logado.isMaster) return 'Sem acesso a essa ferramenta - chame um atendente.';
    const acao = await agenteAcoes.obter(input.acaoId);
    if (!acao || !acao.ativo) return 'Essa ação não existe (ou foi desativada) no catálogo NOC Zenith - confira o [id] certo.';
    const resumo = String(input.resumo || acao.nome).slice(0, 300);
    if (acao.requerAprovacao) {
      await qaAprovacoes.criar({
        tipo: 'agente.executarAcao',
        resumo,
        payload: { acaoId: input.acaoId, parametros: input.parametros || {} },
        criadoPorId: null,
        criadoPorEmail: 'Beniboy (agente)',
      });
      return `Ação "${acao.nome}" preparada e enviada pra aprovação do Master (fica visível em NOC Zenith).`;
    }
    try {
      const resultadoAcao = await agenteAcoes.executarAcaoDoAgente(input.acaoId, input.parametros || {});
      return `Ação "${acao.nome}" executada: ${resultadoAcao}`;
    } catch (err) {
      return `Erro ao executar "${acao.nome}": ${err.message}`;
    }
  }
  return `Ferramenta desconhecida: ${nome}`;
}

// trava por conversa: o visitante pode mandar 2 mensagens seguidas (ou o
// poll disparar em corrida) - so UMA execucao do bot por conversa por vez
const emAndamento = new Set();

// Gera (e grava) a resposta do bot pra conversa. Retorna null quando o bot
// nao deve/nao consegue falar; senao { chat, tickets, chamouAtendente }.
// `unidades` = nomes validos pra abertura de ticket (vem do index.js).
async function responderConversa(chatId, { unidades = [], resolverUnidadesPorIdPulse, resolverUnidadePublica, linkEstornoCliente } = {}) {
  if (!ativo() || emAndamento.has(chatId)) return null;
  emAndamento.add(chatId);
  try {
    const chat = await suporteChat.getOne(chatId);
    if (!chat || chat.status !== 'ABERTO') return null;
    if (chat.atendidoPorEmail || chat.botDesativado) return null; // humano assumiu / bot ja se despediu
    const msgs = chat.mensagens || [];
    if (!msgs.length || msgs[msgs.length - 1].de !== 'visitante') return null; // nada novo pra responder
    if (msgs.filter((m) => m.bot).length >= MAX_RESPOSTAS_BOT) return null; // baixa interacao: passou do limite, fica pro humano

    const resultado = { tickets: [], chamouAtendente: false, motivoAtendente: '' };
    const mensagens = montarMensagens(chat);
    const system = await montarSystem(unidades, chat.logado);
    const tools = montarTools(chat.logado);
    let resp = await getCliente().messages.create({
      model: MODELO, max_tokens: MAX_TOKENS, system, messages: mensagens,
      tools, output_config: { effort: 'low' },
    });

    let rodadas = 0;
    while (resp.stop_reason === 'tool_use' && rodadas < MAX_RODADAS_TOOLS) {
      rodadas += 1;
      mensagens.push({ role: 'assistant', content: resp.content });
      const results = [];
      for (const bloco of resp.content) {
        if (bloco.type !== 'tool_use') continue;
        let saida;
        try {
          saida = await executarTool(bloco.name, bloco.input || {}, chat, resultado, resolverUnidadesPorIdPulse, resolverUnidadePublica, linkEstornoCliente);
        } catch (err) {
          saida = `Erro ao executar: ${err.message}`;
        }
        results.push({ type: 'tool_result', tool_use_id: bloco.id, content: saida });
      }
      mensagens.push({ role: 'user', content: results });
      resp = await getCliente().messages.create({
        model: MODELO, max_tokens: MAX_TOKENS, system, messages: mensagens,
        tools, output_config: { effort: 'low' },
      });
    }

    if (resp.stop_reason === 'refusal') return null; // sem resposta - fica pro humano
    const texto = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (!texto) return null;

    // rede de seguranca: o texto diz que ja chamou humano mas a ferramenta
    // chamar_atendente nao rodou nessa resposta - forca o escalonamento pra
    // o alarme (push+SSE) nunca deixar de disparar quando o bot promete isso
    if (!resultado.chamouAtendente && ESCALACAO_VERBO_RE.test(texto) && ESCALACAO_ALVO_RE.test(texto)) {
      await suporteChat.desativarBot(chatId);
      resultado.chamouAtendente = true;
      resultado.motivoAtendente = 'Bot disse ter chamado atendente sem usar a ferramenta (rede de segurança)';
    }

    const atualizado = await suporteChat.adicionarMensagem(chatId, { de: 'suporte', texto, bot: true });
    return { chat: atualizado, ...resultado };
  } catch (err) {
    // erro de API (rede, cota, chave...) NUNCA quebra o chat - o time humano
    // ja foi notificado da mensagem pelo push normal e atende como antes
    console.error('[suporteBot] falha ao responder:', err.message);
    return null;
  } finally {
    emAndamento.delete(chatId);
  }
}

module.exports = { ativo, responderConversa, MODELO };
