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

const MODELO = 'claude-opus-5';
const MAX_TOKENS = 700;
const MAX_RODADAS_TOOLS = 5; // seguranca do loop de tool use
// baixa interacao: depois disso o bot para de responder e o humano continua
const MAX_RESPOSTAS_BOT = 8;

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
function montarSystem(unidades, logado) {
  const temFerramentaPedido = !!(logado && logado.temMonitor);
  const texto = `Você é o Beniboy, atendente virtual do chat de suporte do Zenith Ops.

O Zenith Ops é o sistema interno de gestão do grupo (lojas Domino's, Spoleto, Milky Moo, São Braz e o parque Saltiverso). Quem fala com você é um funcionário ou parceiro das lojas — pode estar deslogado.

## Estilo (obrigatório)
- Respostas CURTAS e objetivas: 1 a 4 frases, sem enrolação, sem repetir o que a pessoa disse.
- BAIXA interação: resolva no menor número de trocas possível. Se der pra agir já, aja; se faltar só 1 dado, pergunte só ele (uma pergunta por vez).
- Português do Brasil, tom simpático e direto. Nada de listas longas nem textão.
- Nunca invente informação sobre o sistema. Se não souber ou o assunto for sensível (senha de outra pessoa, dados financeiros, urgência grave), use chamar_atendente.

## O que você sabe do Zenith
- Login: usuário + senha próprios. 3 senhas erradas BLOQUEIAM a conta — só o Master desbloqueia. Esqueceu a senha? O Master reseta (peça pra pessoa procurar o gestor, ou abra um ticket de suporte-ti).
- Acessos/permissões por tela (Fechamentos, Entregas, Estoque, Central, Chamados, Parque...) são liberados pelo Master na tela Usuários.
- Central de Solicitações: pedidos de compra, manutenção, suporte de TI, pagamento (boleto/despesa) e nota fiscal viram tickets numerados (#10000 em diante) que o Master aprova ou rejeita. Depois de aprovado, o andamento aparece no ticket.
- Fechamento de caixa: lançado em Lançar fechamento; erro em fechamento já enviado se corrige pelo botão "Pedir correção" no Histórico da Central (só 1 correção pendente por lançamento).
- Chamados de TI/Manutenção: nascem de tickets aprovados ou direto pelo time técnico; têm prioridade e prazo (SLA).
- Chat de suporte (onde você está): a conversa fica salva no navegador da pessoa; o time humano vê tudo e pode assumir a qualquer momento.
- Suporte humano por WhatsApp: (81) 99514-8654.

## Ferramentas
- criar_ticket: abre uma solicitação na Central. Antes de criar, CONFIRME em uma única mensagem o resumo (tipo, unidade, o que é). Só crie depois do "sim" da pessoa. Depois de criar, informe o número do ticket.
- consultar_ticket: andamento de um ticket pelo número.
- chamar_atendente: acione quando a pessoa pedir um humano, quando você não souber resolver, ou quando o assunto for sensível. Avise que o time já foi chamado e responde ali mesmo na conversa.${temFerramentaPedido ? `
- consultar_pedido: consulta o status de UM pedido específico no Monitor (aprovado, recusado, estornado, fraude suspeita). A busca já vem limitada às lojas que essa pessoa tem acesso - se não achar, pode ser de outra loja, não assuma fraude/erro. Nunca invente status; se a ferramenta não achar nada, diga isso e ofereça chamar_atendente.` : `
- Pedido estornado/fraude/aprovado no Monitor: você NÃO tem acesso a isso agora (só quem está logado com permissão de Monitor). Use chamar_atendente.`}

## Unidades válidas pra ticket (use exatamente um destes nomes; se a pessoa falar parecido, escolha o mais próximo; se não der pra saber, pergunte)
${unidades.map((u) => `- ${u}`).join('\n')}
${logado ? `\n## Quem fala com você agora\nConta logada: ${logado.username}${logado.isMaster ? ' (Master)' : ''}. ${temFerramentaPedido ? 'Tem acesso ao Monitor - pode usar consultar_pedido.' : 'Sem acesso ao Monitor - não tente consultar pedido, use chamar_atendente se precisar.'}` : ''}`;
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
];

// so entra na lista de ferramentas quando chat.logado.temMonitor (ver
// usuarioLogadoDoHeader em index.js) - visitante anonimo ou logado sem
// permissao de Monitor nunca ve nem essa ferramenta oferecida ao modelo
const TOOL_CONSULTAR_PEDIDO = {
  name: 'consultar_pedido',
  description: 'Consulta o status de um pedido/transação específico no Monitor (aprovado, recusado, estornado, fraude suspeita). Só disponível pra quem está logado com acesso ao Monitor - o resultado já vem limitado às lojas dessa pessoa.',
  input_schema: {
    type: 'object',
    properties: {
      identificador: { type: 'string', description: 'O que a pessoa souber sobre o pedido: referência (pspReference/merchantReference), nome do cliente, ou os últimos 4 dígitos do cartão.' },
    },
    required: ['identificador'],
  },
};

function montarTools(logado) {
  return (logado && logado.temMonitor) ? [...TOOLS_BASE, TOOL_CONSULTAR_PEDIDO] : TOOLS_BASE;
}

// historico da conversa -> turns da API. Mensagens do visitante viram user;
// as do bot viram assistant. Se um humano do time ja falou, o bot nem chega
// aqui (gate em responderConversa)
function montarMensagens(chat) {
  const turnos = [];
  const contexto = `(Início da conversa. Quem escreve: ${chat.nome || 'visitante'}${chat.contato ? ` · contato: ${chat.contato}` : ''})`;
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

async function executarTool(nome, input, chat, resultado) {
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
    });
    resultado.tickets.push(registro);
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
  if (nome === 'consultar_pedido') {
    // defesa em profundidade: mesmo que o modelo tentasse chamar essa tool
    // fora do previsto, ela so entra em TOOLS quando chat.logado.temMonitor -
    // aqui checa de novo antes de tocar em qualquer dado do Monitor
    if (!chat.logado || !chat.logado.temMonitor) return 'Sem acesso ao Monitor pra essa consulta - chame um atendente.';
    const query = String(input.identificador || '').trim().toLowerCase();
    if (!query) return 'Peça pra pessoa informar a referência do pedido, o nome do cliente ou os 4 últimos dígitos do cartão.';
    let pedidos = store.allOrders();
    if (!chat.logado.isMaster) {
      const permitidas = new Set(chat.logado.unidades || []);
      pedidos = pedidos.filter((o) => o.unidade && permitidas.has(o.unidade));
    }
    const encontrados = pedidos
      .filter((o) => String(o.pedidoId || '').toLowerCase().includes(query)
        || String(o.cliente || '').toLowerCase().includes(query)
        || String(o.last4 || '').includes(query))
      .sort((a, b) => String(b.ultimaAtualizacao || '').localeCompare(String(a.ultimaAtualizacao || '')))
      .slice(0, 5);
    if (!encontrados.length) return 'Nenhum pedido encontrado com essa referência nas lojas que essa pessoa tem acesso (pode ser de outra loja, ou já saiu da retenção do Monitor).';
    return JSON.stringify(encontrados.map((o) => ({
      pedido: o.pedidoId, unidade: o.unidade, cliente: o.cliente, valor: o.valor,
      status: o.statusAtual, metodo: o.metodo, cartaoFinal: o.last4,
      aprovadoEm: o.dataCompra, estornadoEm: o.dataChargeback, fraudeSuspeita: !!o.fraudeSuspeita,
    })));
  }
  return `Ferramenta desconhecida: ${nome}`;
}

// trava por conversa: o visitante pode mandar 2 mensagens seguidas (ou o
// poll disparar em corrida) - so UMA execucao do bot por conversa por vez
const emAndamento = new Set();

// Gera (e grava) a resposta do bot pra conversa. Retorna null quando o bot
// nao deve/nao consegue falar; senao { chat, tickets, chamouAtendente }.
// `unidades` = nomes validos pra abertura de ticket (vem do index.js).
async function responderConversa(chatId, { unidades = [] } = {}) {
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
    const system = montarSystem(unidades, chat.logado);
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
          saida = await executarTool(bloco.name, bloco.input || {}, chat, resultado);
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
