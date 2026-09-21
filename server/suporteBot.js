// suporteBot.js
// "Beniboy" - atendente virtual do chat de suporte (widget 💬). Quando
// NENHUM humano assumiu a conversa, ele responde sozinho usando a API da
// Claude (Anthropic): tira duvidas rapidas sobre o NoPulso, CRIA TICKET na
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
const auth = require('./auth');
const abastecimentoCarrinho = require('./abastecimentoCarrinho');
const agenteAcoes = require('./agenteAcoes');
const lojaStatus = require('./lojaStatus');
const qaAprovacoes = require('./qaAprovacoes');
const roteamentoTags = require('./roteamentoTags');
const tarefas = require('./tarefas');

// senha padrao que o Beniboy define quando a pessoa NAO lembra a senha atual
// (2a vez que o mesmo acesso trava depois de ja ter sido desbloqueado por
// ele) - literalmente os digitos de 1 a 8, pedido explicito do usuario;
// obriga trocar por uma propria no primeiro login (ver users.resetPassword)
const SENHA_PADRAO_BOT = '12345678';

// O MODELO DO BENIBOY, e por que ele é uma env var.
//
// Ele roda em Opus 5, não em Haiku - vale conferir antes de decidir soltar a
// mão no tamanho do prompt: a diferença de preço por token entre os dois é de
// mais de uma ordem de grandeza, e o Beniboy responde TODA conversa do widget,
// em 59 telas. Trocar pra Haiku 4.5 é preencher SUPORTE_BOT_MODELO no Render
// com 'claude-haiku-4-5-20251001'; sem a variável, nada muda.
const MODELO = process.env.SUPORTE_BOT_MODELO || 'claude-opus-5';
// O chat nao e' so uma FAQ: ele coleta dados, aciona ferramentas e devolve
// uma decisao. Um pouco mais de margem evita que ele abandone uma resolucao
// no meio para economizar duas frases. Continua configuravel no Render para
// que o custo fique sob controle.
const MAX_TOKENS = Number(process.env.SUPORTE_BOT_MAX_TOKENS) || 1100;
const ESFORCO = process.env.SUPORTE_BOT_ESFORCO || 'medium';
const MAX_RODADAS_TOOLS = 5; // seguranca do loop de tool use
// Limite e rede de seguranca, nao uma forma silenciosa de abandonar a
// conversa. Ao chegar nele, responderConversa faz handoff explicito, com
// nota interna e alarme para o time.
const MAX_RESPOSTAS_BOT = 12;

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
// PAUSAR ITEM / FECHAR LOJA no iFood / 99food: quem executa e o COWORK
// AGREGADOR, o robo do Master que opera os paineis dos agregadores. O bot nao
// bloqueia nada sozinho e nao chama "um atendente": ele poe o pedido na fila
// do Cowork (ver bloquear_no_agregador abaixo, agregadorFila.js e
// acionarBeniboy em index.js) e continua na conversa - o retorno do Cowork
// volta pra ela sozinho. Se o Cowork nao executar, o coordenador agregador
// humano e chamado atras (push.notifyAgregador).
const ACOES_AGREGADOR = ['pausar-item', 'fechar-loja'];
const CANAIS_AGREGADOR = ['ifood', '99food', 'ambos'];

const TIPOS_TICKET = ['compra', 'manutencao', 'suporte-ti', 'pagamento', 'nota', 'acesso-pessoa'];
const MOTIVOS_ACESSO_TICKET = ['desligamento', 'ferias'];

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
// NoPulso, ver agenteAcoes.js) - pedido explicito do usuario: "ensine tudo a
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
  // ação de sistema leva junto QUAIS parâmetros coletar (PARAMETROS_EXECUTOR)
  // - sem isso o modelo chutava o nome do campo e a ação falhava só na hora
  // de executar, depois de o Master já ter aprovado
  const listaAcoes = acoes.length
    ? acoes.map((a) => {
      const params = a.tipo === 'acao_sistema' && agenteAcoes.PARAMETROS_EXECUTOR[a.executorSistema]
        ? ` Parâmetros: ${agenteAcoes.PARAMETROS_EXECUTOR[a.executorSistema]}.`
        : '';
      return `- [${a.id}] ${a.nome}: ${a.descricao} (${a.requerAprovacao ? 'precisa de aprovação do Master' : 'executa direto, sem aprovação'}).${params}`;
    }).join('\n')
    : '(nenhuma ação cadastrada ainda)';
  return `\n\n## NOC-NoPulso - ações que você pode executar (ferramenta executar_acao_agente)
Catálogo de ações cadastradas pelo Master (use o [id] exato ao chamar a ferramenta):
${listaAcoes}`;
}

function hojeBrasil() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

async function montarSystem(unidades, logado, unidadesPorCodigo = {}) {
  const temFerramentaPedido = !!(logado && logado.temMonitor);
  const [blocoConhecimento, blocoAgente] = await Promise.all([montarBlocoConhecimento(), montarBlocoAgente(logado)]);
  const texto = `Você é o Beniboy, atendente virtual do chat de suporte do NoPulso.

O NoPulso é o sistema interno de gestão do grupo (lojas Domino's, Spoleto, Milky Moo, São Braz e o parque Saltiverso). Quem fala com você pode ser um funcionário/parceiro das lojas OU o CLIENTE FINAL de uma loja (o comprador, ex: alguém que quer um estorno) - na maioria das vezes de estorno é o próprio cliente falando direto com você, não um funcionário repassando. Não assuma qual dos dois é sem contexto - se não estiver claro, pergunte. De qualquer forma, a pessoa pode estar deslogada.

## Estilo (obrigatório)
- Respostas CURTAS e objetivas: 1 a 4 frases, sem enrolação, sem repetir o que a pessoa disse.
- BAIXA interação: resolva no menor número de trocas possível. Se der pra agir já, aja; se faltar só 1 dado, pergunte só ele (uma pergunta por vez).
- Português do Brasil, tom simpático e direto. Nada de listas longas nem textão.
- NUNCA diga que "chamou", "chamei", "acionei" ou "notifiquei" um atendente/time humano sem ter chamado a ferramenta chamar_atendente NESSA MESMA resposta - isso dispara um alarme real pro time, então a frase e a ação têm que andar sempre juntas. Se ainda não chamou a ferramenta, chame agora ou fale só no futuro ("posso chamar um atendente", "vou chamar um atendente").
- Nunca invente informação sobre o sistema. Se não souber ou o assunto for sensível (senha de outra pessoa, dados financeiros, urgência grave), use chamar_atendente.

## Ordem de resolução (obrigatória)
1. Entenda a intenção e use o contexto que já existe na conversa; não peça de novo nome, loja, número ou dado que a pessoa já informou.
2. Se houver uma ferramenta capaz de resolver ou consultar, use-a antes de pensar em chamar alguém. Depois explique o resultado em linguagem simples.
3. Se a ação tiver impacto operacional, prepare-a para aprovação quando o catálogo disser que exige aprovação. Nunca alegue que algo foi executado antes do retorno da ferramenta.
4. Só escale para humano quando faltar uma autorização, uma informação que não está disponível ou uma ferramenta. Antes da escalada, registre o resumo e a pendência.
5. Nunca deixe a pessoa sem próximo passo: informe o que foi feito, o que está pendente e onde a confirmação aparecerá.

## Playbook obrigatório: impressora
- Se a pessoa disser que a impressora não imprime, está travada, pausada ou com fila parada, identifique primeiro se é uma **Zebra**. Se ela não tiver dito a marca, pergunte somente: "É uma Zebra?". Se o acesso tiver mais de uma unidade e ela ainda não informou a loja, pergunte também qual é a unidade.
- Confirmada a Zebra e a unidade, use **estado_impressora** imediatamente. Não abra ticket nem chame humano antes dessa leitura.
- Se a leitura apontar tampa/cabeça aberta, falta de papel ou ribbon, explique o ajuste físico e **não** reinicie.
- Se não houver impedimento físico, use **resetar_impressora** automaticamente na mesma conversa, sem pedir nova autorização: a pessoa já pediu ajuda para a impressora. Informe que o reset foi enviado para a unidade, que só a fila/impressora será reiniciada e peça um teste após cerca de 1 minuto.
- Se não houver Zebra cadastrada/monitorada ou nenhum computador NOC disponível, registre o motivo e chame um atendente. Nunca invente que o reset foi enviado.

## O que você sabe do NoPulso
- Problema para entrar: depois de receber o nome de usuário, SEMPRE use desbloquear_login para diagnosticar antes de concluir que é senha. A ferramenta diferencia bloqueio por tentativas, horário restrito, acesso desativado e conta já liberada. Só quando for bloqueio real ela destrava mantendo a MESMA senha; se for horário, ela aciona o Master para revisar a liberação sem mudar a senha.
- Estorno: NÃO dá pra você abrir esse ticket direto (exige login com acesso ao Monitor) - em vez disso, pergunte em qual loja foi a compra (pule essa pergunta se já souber pela "loja" do início da conversa) e use gerar_link_estorno_cliente. Se quem fala com você É o cliente (o mais comum), mande o link JÁ NESSA CONVERSA pra ele clicar e preencher ali mesmo - não precisa de WhatsApp nem de mais ninguém no meio. Se for um funcionário pedindo em nome de um cliente que não está no chat, aí sim ele repassa o link pro cliente por onde for mais fácil (WhatsApp é uma opção, não a única).
- Pausar item ou fechar a loja no iFood/99food: quem faz é o COWORK AGREGADOR, o robô que opera os painéis - não é com um atendente. Use bloquear_no_agregador (nunca chamar_atendente). Pergunte o que faltar, uma coisa por vez: a loja, o app (iFood, 99food ou os dois) e, se for pausar item, qual item. Depois é só avisar que está sendo feito; a confirmação cai na conversa sozinha - nunca prometa prazo nem diga que já está feito antes da confirmação chegar.
- Acessos/permissões por tela (Fechamentos, Entregas, Estoque, Central, Chamados, Parque...) são liberados pelo Master na tela Usuários.
- Central de Solicitações: pedidos de compra, manutenção, suporte de TI, pagamento (boleto/despesa) e nota fiscal viram tickets numerados (#10000 em diante) que o Master aprova ou rejeita. Depois de aprovado, o andamento aparece no ticket.
- Fechamento de caixa: lançado em Lançar fechamento; erro em fechamento já enviado se corrige pelo botão "Pedir correção" no Histórico da Central (só 1 correção pendente por lançamento).
- Chamados de TI/Manutenção: nascem de tickets aprovados ou direto pelo time técnico; têm prioridade e prazo (SLA).
- Chat de suporte (onde você está): a conversa fica salva no navegador da pessoa; o time humano vê tudo e pode assumir a qualquer momento. Esse chat é o canal PADRÃO de atendimento agora - resolva por aqui sempre que der.
- Suporte humano por WhatsApp: (81) 99514-8654 - é o ÚLTIMO recurso, só quando não der pra resolver por aqui de nenhum jeito (ex: chamar_atendente escalar e a pessoa insistir em outro canal). Nunca ofereça WhatsApp como primeira opção.

## Ferramentas
- criar_ticket: abre uma solicitação na Central. Antes de criar, CONFIRME em uma única mensagem o resumo (tipo, unidade, o que é). Só crie depois do "sim" da pessoa. Depois de criar, informe o número do ticket.
- consultar_ticket: andamento de um ticket pelo número.
- criar_tarefa: quando uma pessoa logada e autorizada pedir uma tarefa para si. Não transforme esse pedido em ticket da Central. Sem unidade, a tarefa é pessoal; "hoje" usa a data de referência abaixo. O responsável é quem está falando; participantes só entram se estiverem no escopo dela.
- consultar_meu_atendimento: consulta o protocolo DESTA conversa e os tickets que ela própria abriu. Use quando a pessoa perguntar pelo próprio protocolo, andamento ou número do ticket; não peça o número se ele já é o protocolo exibido no chat.
- chamar_atendente: acione quando a pessoa pedir um humano, quando você não souber resolver, ou quando o assunto for sensível. ANTES de chamar, use registrar_nota_interna com um resumo (situacao PENDENTE) pra o humano já chegar sabendo. Avise que o time já foi chamado e responde ali mesmo na conversa.
- bloquear_no_agregador: põe na fila do Cowork Agregador o pedido de PAUSAR ITEM ou FECHAR LOJA no iFood/99food. Ele faz o bloqueio no painel e confirma nessa conversa sozinho; você continua nela (a ferramenta NÃO te tira dela) e avisa a pessoa em 1 frase que já está sendo feito. Só chame com loja, app e - pra pausar item - o item em mãos.
- registrar_nota_interna: deixa um resumo interno do atendimento (só o time vê, nunca a pessoa). Use principalmente ANTES de chamar_atendente (o que ficou pendente) e sempre que valer registrar o que foi feito. Não fala com a pessoa nem encerra a conversa.
- encerrar_atendimento: encerra a conversa como RESOLVIDA. Use SÓ quando a pessoa confirmar, com clareza, que resolveu / não precisa de mais nada - nunca pra passar pra um humano (isso é chamar_atendente) nem com algo ainda pendente. Depois de chamar, mande UMA mensagem curta de despedida; a conversa fecha em seguida.
- desbloquear_login: diagnostica e, se necessário, destrava um login que não entra - login principal do NoPulso OU operador do Abastecimento do Carrinho, a ferramenta identifica sozinha qual é. Peça o nome de usuário ANTES de chamar. Por padrão, bloqueio real é resolvido mantendo a MESMA senha. Se o resultado indicar horário restrito, explique que não é senha e que o Master foi acionado para liberar/revisar o horário. Se travar de novo depois de um desbloqueio real: no login principal, PERGUNTE "você lembra da sua senha atual?" antes de chamar de novo com lembraSenha=true/false (só com false uma senha padrão é definida, e a pessoa é obrigada a cadastrar uma própria no próximo login); no operador do Abastecimento, a ferramenta já reseta pra uma senha nova sozinha - é só repassar a senha que ela devolver.${temFerramentaPedido ? `
- consultar_pedido: consulta o status de UM pedido específico no Monitor (aprovado, recusado, estornado, fraude suspeita). Peça os 3 dados ANTES de chamar (uma pergunta por vez, o que faltar): o código da loja (IDPULSE, a mesma coluna "Unidade" do Fechamento), o nome do cliente e o valor do pedido. A busca já vem limitada às lojas que essa pessoa tem acesso - se não achar, pode ser de outra loja, não assuma fraude/erro. Nunca invente status; se a ferramenta não achar nada, diga isso e ofereça chamar_atendente. Se o status desse pedido mudar depois da sua resposta, a pessoa é avisada automaticamente - não precisa te perguntar de novo.` : `
- Pedido estornado/fraude/aprovado no Monitor: você NÃO tem acesso a isso agora (só quem está logado com permissão de Monitor). Use chamar_atendente.`}${(logado && logado.isMaster) ? `
- executar_acao_agente: executa uma ação do catálogo NOC-NoPulso (veja a lista mais abaixo). Use SÓ pra ações que estão nessa lista - nunca invente uma ação nem tente rodar algo fora do catálogo. Se a ação precisar de aprovação, avise que mandou pro Master aprovar; se não precisar, informe o resultado direto.` : ''}

## Unidades válidas pra ticket (use exatamente um destes nomes; se a pessoa falar parecido, escolha o mais próximo; se não der pra saber, pergunte)
${unidades.map((u) => `- ${u}`).join('\n')}
${logado ? `\n## Quem fala com você agora\nConta logada: ${logado.username}${logado.isMaster ? ' (Master)' : ''}. ${temFerramentaPedido ? 'Tem acesso ao Monitor - pode usar consultar_pedido.' : 'Sem acesso ao Monitor - não tente consultar pedido, use chamar_atendente se precisar.'}${logado.podeCriarTarefa ? ' Pode criar tarefas próprias pelo chat.' : ' Não tem permissão para criar novas tarefas.'}` : ''}

## Data de referência
Hoje no Brasil é ${hojeBrasil()}. Quando a pessoa disser "hoje", use esta data no formato AAAA-MM-DD.${logado && logado.podeCriarTarefa && !logado.isMaster && Array.isArray(logado.unidades) && logado.unidades.length ? `\nUnidades desta conta para uma tarefa: ${logado.unidades.map((codigo) => `${unidadesPorCodigo[codigo] || codigo} [${codigo}]`).join(', ')}.` : ''}${blocoConhecimento}${blocoAgente}`;
  return [{ type: 'text', text: texto, cache_control: { type: 'ephemeral' } }];
}

const TOOLS_BASE = [
  {
    name: 'criar_tarefa',
    description: 'Cria uma tarefa no Meu Dia para a própria pessoa logada. Use quando ela pedir explicitamente uma tarefa. Não cria ticket da Central. O responsável é sempre quem está falando; participantes só são adicionados se estiverem no mesmo escopo de acesso.',
    input_schema: {
      type: 'object',
      properties: {
        titulo: { type: 'string', description: 'Título curto da tarefa.' },
        descricao: { type: 'string', description: 'Contexto ou resultado esperado, se informado.' },
        prioridade: { type: 'string', enum: ['critica', 'alta', 'media', 'baixa'], description: 'Crítica equivale a SLA de 4 horas.' },
        dataEntrega: { type: 'string', description: 'Previsão de conclusão em AAAA-MM-DD.' },
        unidade: { type: 'string', description: 'Código da unidade entre colchetes no prompt. Opcional; sem unidade, a tarefa é pessoal.' },
        participantes: { type: 'array', items: { type: 'string' }, description: 'Nomes, e-mails ou usernames de participantes. Opcional.' },
      },
      required: ['titulo'],
    },
  },
  {
    name: 'criar_ticket',
    description: 'Cria uma solicitação (ticket) na Central do NoPulso. Use somente depois que a pessoa confirmar o resumo do pedido.',
    input_schema: {
      type: 'object',
      properties: {
        tipo: { type: 'string', enum: TIPOS_TICKET, description: 'compra = comprar algo pra loja; manutencao = consertar algo físico; suporte-ti = problema de computador/sistema/acesso; pagamento = boleto/despesa pro financeiro; nota = pedido de nota fiscal; acesso-pessoa = gerente avisando desligamento ou férias de alguém, pra bloquear os acessos dela' },
        unidade: { type: 'string', description: 'Nome da unidade/loja, exatamente como na lista do prompt' },
        titulo: { type: 'string', description: 'Resumo curto do pedido (até 200 caracteres) - pra tipo acesso-pessoa não precisa perguntar, é montado sozinho' },
        descricao: { type: 'string', description: 'Detalhes relevantes que a pessoa passou' },
        prioridade: { type: 'string', enum: ['critica', 'alta', 'media', 'baixa'], description: 'Padrão: media. Só suba se a pessoa indicar urgência real.' },
        nomePessoa: { type: 'string', description: 'SÓ pra tipo acesso-pessoa: nome completo de quem foi desligado ou saiu de férias.' },
        motivoAcesso: { type: 'string', enum: MOTIVOS_ACESSO_TICKET, description: 'SÓ pra tipo acesso-pessoa: desligamento ou ferias.' },
        dataEfetiva: { type: 'string', description: 'SÓ pra tipo acesso-pessoa: último dia trabalhado (desligamento) ou início das férias, formato AAAA-MM-DD.' },
        dataRetornoPrevista: { type: 'string', description: 'SÓ pra tipo acesso-pessoa com motivoAcesso=ferias: previsão de volta, formato AAAA-MM-DD. Obrigatório nesse caso.' },
      },
      required: ['tipo', 'unidade', 'titulo'],
    },
  },
  {
    name: 'consultar_meu_atendimento',
    description: 'Consulta o protocolo desta conversa e os tickets vinculados a ela. Não expõe ticket de outra pessoa.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'consultar_ticket',
    description: 'Consulta o andamento de um ticket da Central pelo número (ex: 10045). Disponível somente para o time autorizado.',
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
    name: 'bloquear_no_agregador',
    description: 'Manda PAUSAR ITEM ou FECHAR A LOJA no iFood ou no 99food. O pedido entra na fila do Cowork Agregador (o robô que opera os painéis), que faz o bloqueio e confirma sozinho na conversa. Use SEMPRE que o pedido for esse, em vez de chamar_atendente. Colete ANTES de chamar: a unidade/loja, o canal (iFood, 99food ou os dois) e, quando for pausar item, QUAL item. Não encerra a conversa - você continua nela.',
    input_schema: {
      type: 'object',
      properties: {
        acao: { type: 'string', enum: ACOES_AGREGADOR, description: 'pausar-item = tirar um item do cardápio; fechar-loja = fechar a loja no app' },
        canal: { type: 'string', enum: CANAIS_AGREGADOR, description: 'Em qual app: ifood, 99food ou ambos' },
        unidade: { type: 'string', description: 'Nome da unidade/loja, do jeito que a pessoa falou' },
        item: { type: 'string', description: 'SÓ pra acao=pausar-item: qual item deve ser pausado. Obrigatório nesse caso.' },
        motivo: { type: 'string', description: 'Por que (ex: acabou o estoque, cozinha parada, fila grande). 1 linha.' },
      },
      required: ['acao', 'canal', 'unidade'],
    },
  },
  {
    name: 'desbloquear_login',
    description: 'Diagnostica um login que não entra e resolve bloqueio por 3 senhas erradas quando for seguro. Diferencia horário restrito, acesso desativado e conta já liberada; só desbloqueia quando a causa for bloqueio real e, por padrão, mantém a mesma senha. Peça o nome de usuário antes de chamar.',
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
  {
    name: 'registrar_nota_interna',
    description: 'Registra um resumo/nota interna sobre esse atendimento, visível SÓ pro time (nunca pro visitante). Use pra deixar registrado o que a pessoa precisava e o que foi feito - principalmente ANTES de chamar um atendente (chamar_atendente), pra o humano já chegar sabendo, e o que ficou pendente. Não fala com a pessoa nem encerra nada; é só o registro interno.',
    input_schema: {
      type: 'object',
      properties: {
        resumo: { type: 'string', description: 'O que a pessoa precisava e o que foi feito até aqui, em 1 a 4 frases. Inclua perfil (cliente ou colaborador), loja/marca e tipo do problema quando souber.' },
        situacao: { type: 'string', enum: ['RESOLVIDO', 'PENDENTE'], description: 'RESOLVIDO se você resolveu; PENDENTE se ainda falta algo (ex: um humano precisa continuar).' },
        pendencia: { type: 'string', description: 'Só quando PENDENTE: o que exatamente falta fazer, pro time saber o próximo passo.' },
      },
      required: ['resumo', 'situacao'],
    },
  },
  {
    name: 'encerrar_atendimento',
    description: 'Encerra a conversa marcando como RESOLVIDA. Use SÓ quando a pessoa confirmar, de forma clara, que o problema foi resolvido / que não precisa de mais nada. NÃO use pra passar pra um humano (isso é chamar_atendente) nem quando ainda há algo pendente. Depois de chamar, mande UMA mensagem curta de despedida - a conversa fecha logo em seguida e a pessoa não consegue mais escrever nela.',
    input_schema: {
      type: 'object',
      properties: {
        resumo: { type: 'string', description: 'Resumo de 1 a 2 frases do que a pessoa precisava e como foi resolvido - vira o relatório interno de encerramento (só o time vê).' },
      },
      required: ['resumo'],
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
  description: 'Executa uma ação cadastrada no catálogo NOC-NoPulso (lista completa vem no prompt, com o [id] de cada uma). Use só pra ações que estão literalmente nessa lista - nunca invente uma ação. Se a ação precisar de "codigo"/"posto" (comando de máquina), pergunte qual computador antes de chamar.',
  input_schema: {
    type: 'object',
    properties: {
      acaoId: { type: 'string', description: 'O [id] exato da ação, copiado da lista do prompt.' },
      parametros: { type: 'object', description: 'Dados que essa ação específica precisa (ver a descrição dela no prompt) - ex: codigo/posto pra comando de máquina, ou email/username/permissions pra criar um usuário do NoPulso.' },
      resumo: { type: 'string', description: 'Resumo de 1 linha do que vai ser feito, pro card de aprovação (se precisar) ou pro registro do que foi executado.' },
    },
    required: ['acaoId', 'resumo'],
  },
};

// IMPRESSORA ZEBRA: as duas unicas acoes de hardware que o Beniboy faz pra
// quem NAO e' Master. Diferente de executar_acao_agente, aqui ele nao escolhe
// COMANDO nenhum - a primeira so LE o estado e a segunda so reinicia a Zebra da
// loja de quem esta falando. E' um par de propósito: reiniciar sem ler antes e'
// o erro que a gente quer evitar (tampa aberta nao se conserta reiniciando).
const TOOL_ESTADO_IMPRESSORA = {
  name: 'estado_impressora',
  description: 'Le o estado ATUAL das impressoras Zebra da loja da pessoa (sem papel, cabeca/tampa aberta, sem ribbon, fila parada, pausada). SEMPRE use isto ANTES de resetar_impressora - reiniciar sem saber o estado nao resolve e tira a impressora do ar por ~30s. Se a pessoa tem acesso a mais de uma loja, peca qual antes.',
  input_schema: {
    type: 'object',
    properties: { unidade: { type: 'string', description: 'Codigo da loja. So preencha se a pessoa tem acesso a mais de uma e ja disse qual.' } },
    required: [],
  },
};
const TOOL_RESETAR_IMPRESSORA = {
  name: 'resetar_impressora',
  description: 'Reinicia a impressora Zebra da loja da pessoa: descarta a fila presa e a impressora volta em ~30s. O COMPUTADOR nao e tocado. Resolve fila travada e impressora pausada. NAO resolve tampa/cabeca aberta, falta de papel nem ribbon acabado - nesses casos a propria ferramenta recusa e diz o que a pessoa tem que fazer na maquina. Chame estado_impressora antes.',
  input_schema: {
    type: 'object',
    properties: { unidade: { type: 'string', description: 'Codigo da loja. So preencha se a pessoa tem acesso a mais de uma e ja disse qual.' } },
    required: [],
  },
};

function montarTools(logado) {
  // Ticket por numero contem dados operacionais. Visitante publico consulta
  // apenas o proprio protocolo; a busca por um numero arbitrario fica com o
  // time autenticado (Master/Admin/secao Suporte).
  const tools = TOOLS_BASE.filter((tool) => tool.name !== 'consultar_ticket');
  if (logado && logado.ehTimeSuporte) tools.push(TOOLS_BASE.find((tool) => tool.name === 'consultar_ticket'));
  if (logado && logado.temMonitor) tools.push(TOOL_CONSULTAR_PEDIDO);
  if (logado && logado.isMaster) tools.push(TOOL_EXECUTAR_ACAO_AGENTE);
  if (!logado || !logado.podeCriarTarefa) {
    const indiceCriarTarefa = tools.findIndex((tool) => tool.name === 'criar_tarefa');
    if (indiceCriarTarefa >= 0) tools.splice(indiceCriarTarefa, 1);
  }
  // quem tem loja no acesso resolve a propria impressora sem esperar humano
  if (logado && ((logado.unidades || []).length || logado.isMaster)) {
    tools.push(TOOL_ESTADO_IMPRESSORA, TOOL_RESETAR_IMPRESSORA);
  }
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

// Quem assina o chamado que o Beniboy abriu. Só a sessão autenticada vale:
// chat.logado é o snapshot de quem tinha token válido ao ABRIR a conversa
// (ver /api/suporte-chat/iniciar). O campo `contato` NÃO serve - ele é
// digitado no formulário do widget, então aceitá-lo deixaria um visitante
// anônimo plantar um chamado na lista de outra pessoa só escrevendo o e-mail
// dela. Sem sessão, o chamado segue sem dono, como era antes.
function donoDoChat(chat, usuarios) {
  const id = chat && chat.logado && chat.logado.id;
  if (!id) return null;
  return (usuarios || []).find((u) => u && u.id === id) || null;
}

function podeCriarTarefaNoChat(usuario) {
  return !!usuario && usuario.active !== false && (usuario.role === 'master' || !!usuario.isAdmin
    || users.ehCargoGerente(usuario.cargo) || (usuario.permissions?.sections || []).includes('tarefas'));
}

function textoNormalizado(valor) {
  return String(valor || '').trim().toLocaleLowerCase('pt-BR')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// É a mesma régua da tela Meu Dia: a pessoa vê a si, Masters, Admin da
// própria empresa e quem compartilha ao menos uma unidade. Não basta o nome
// aparecer no chat para ela virar participante de uma tarefa.
function elegiveisParaTarefaDoChat(solicitante, todos) {
  const minhas = new Set(solicitante.permissions?.unidades || []);
  return (todos || []).filter((pessoa) => {
    if (!pessoa || pessoa.active === false) return false;
    if (pessoa.id === solicitante.id || solicitante.role === 'master' || pessoa.role === 'master') return true;
    if (pessoa.isAdmin && pessoa.empresaId && pessoa.empresaId === solicitante.empresaId) return true;
    return (pessoa.permissions?.unidades || []).some((codigo) => minhas.has(codigo));
  });
}

function encontrarPessoaDaTarefa(termo, elegiveis) {
  const procurado = textoNormalizado(termo);
  if (!procurado) return null;
  const campos = (pessoa) => [pessoa.nome, pessoa.name, pessoa.username, pessoa.email]
    .map(textoNormalizado).filter(Boolean);
  let encontradas = elegiveis.filter((pessoa) => campos(pessoa).includes(procurado));
  if (encontradas.length !== 1) {
    encontradas = elegiveis.filter((pessoa) => campos(pessoa).some((campo) => campo.includes(procurado)));
  }
  return encontradas.length === 1 ? encontradas[0] : null;
}

async function criarTarefaDoChat(input, chat, resultado, unidadesPorCodigo) {
  if (!chat.logado || !chat.logado.id) return 'Para criar uma tarefa, entre no NoPulso e abra o chat novamente.';
  const todos = await users.list();
  // A conta é relida aqui: permissões alteradas depois de abrir o chat entram
  // em vigor antes de qualquer gravação.
  const solicitante = donoDoChat(chat, todos);
  if (!podeCriarTarefaNoChat(solicitante)) return 'Essa conta não tem permissão para criar tarefas. Peça ao responsável para liberar a seção Meu Dia.';

  const titulo = String(input.titulo || '').trim();
  if (!titulo) return 'Informe um título para a tarefa.';
  const unidade = String(input.unidade || '').trim() || null;
  const minhasUnidades = new Set(solicitante.permissions?.unidades || []);
  if (unidade && solicitante.role !== 'master' && !minhasUnidades.has(unidade)) {
    return 'Essa unidade não faz parte do acesso da pessoa que pediu a tarefa.';
  }

  const elegiveis = elegiveisParaTarefaDoChat(solicitante, todos);
  const pedidos = [...new Set((Array.isArray(input.participantes) ? input.participantes : []).map(String).filter(Boolean))].slice(0, 20);
  const participantes = [];
  for (const pedido of pedidos) {
    const pessoa = encontrarPessoaDaTarefa(pedido, elegiveis);
    if (!pessoa) return `Não consegui identificar com segurança o participante "${pedido}" dentro do acesso permitido. Peça o e-mail ou username dele.`;
    if (pessoa.id !== solicitante.id && !participantes.some((x) => x.id === pessoa.id)) participantes.push(pessoa);
  }
  if (unidade) {
    for (const pessoa of participantes) {
      const alcanca = pessoa.role === 'master' || (pessoa.isAdmin && pessoa.empresaId && pessoa.empresaId === solicitante.empresaId)
        || (pessoa.permissions?.unidades || []).includes(unidade);
      if (!alcanca) return `${pessoa.username || pessoa.email} não tem acesso à unidade dessa tarefa.`;
    }
  }

  const dataEntrega = /^\d{4}-\d{2}-\d{2}$/.test(String(input.dataEntrega || '')) ? String(input.dataEntrega) : null;
  const criada = await tarefas.criar({
    titulo, descricao: String(input.descricao || '').trim(), dataInicio: hojeBrasil(), dataEntrega,
    unidade, unidadeNome: unidade ? (unidadesPorCodigo[unidade] || unidade) : null,
    usuario: solicitante, responsavel: solicitante, colaboradores: participantes,
    prioridade: input.prioridade, origem: 'beniboy',
  });
  resultado.tarefas.push(criada);
  return `Tarefa #${criada.numeroTicket} criada: "${criada.titulo}". Responsável: ${criada.responsavelNome}. Participantes: ${participantes.length ? participantes.map((p) => p.nome || p.username || p.email).join(', ') : 'nenhum'}.`;
}

async function executarTool(nome, input, chat, resultado, resolverUnidadesPorIdPulse, resolverUnidadePublica, linkEstornoCliente, unidadesPorCodigo) {
  if (nome === 'criar_tarefa') return criarTarefaDoChat(input, chat, resultado, unidadesPorCodigo || {});
  if (nome === 'criar_ticket') {
    const tipo = TIPOS_TICKET.includes(input.tipo) ? input.tipo : null;
    if (!tipo) return 'Erro: tipo inválido.';
    if (tipo === 'acesso-pessoa') {
      if (!input.nomePessoa || !String(input.nomePessoa).trim()) return 'Erro: informe o nome completo da pessoa antes de criar o ticket.';
      if (!MOTIVOS_ACESSO_TICKET.includes(input.motivoAcesso)) return 'Erro: motivoAcesso precisa ser "desligamento" ou "ferias".';
      if (!input.dataEfetiva) return 'Erro: informe a data efetiva (AAAA-MM-DD).';
      if (input.motivoAcesso === 'ferias' && !input.dataRetornoPrevista) return 'Erro: férias precisa da previsão de retorno (AAAA-MM-DD).';
    }
    const quem = [chat.nome, chat.contato].filter(Boolean).join(' · ');
    // Quem pediu tem de enxergar o próprio chamado. podeVerCard (index.js)
    // libera pelo criadoPorId, e gravar null aqui deixava o ticket invisível
    // JUSTAMENTE para quem abriu: a pessoa pedia no chat, o Beniboy criava, e
    // a Central dela mostrava 0 - parecia que nada tinha acontecido.
    //
    // Só a sessão autenticada vale como identidade: chat.logado é o snapshot
    // de quem tinha token válido ao ABRIR a conversa. O `contato` não serve -
    // ele é DIGITADO no formulário do widget, então aceitá-lo deixaria um
    // visitante anônimo plantar um chamado na lista de outra pessoa só
    // escrevendo o e-mail dela.
    //
    // users.list() é cacheado (60s, liveCache) - não é leitura nova por ticket,
    // e nem chega a ser chamado quando a conversa é de visitante anônimo.
    const dono = chat.logado && chat.logado.id ? donoDoChat(chat, await users.list()) : null;
    // titulo de acesso-pessoa nasce sozinho (mesmo padrao do formulario da
    // Central) - nao depende do modelo escrever certo
    const titulo = tipo === 'acesso-pessoa'
      ? `${input.motivoAcesso === 'ferias' ? 'Férias' : 'Desligamento'} — ${String(input.nomePessoa).trim()}`
      : String(input.titulo || '').trim();
    const destino = await roteamentoTags.destinoDe(tipo).catch(() => ({ pessoas: [], dono: null, tag: null }));
    const registro = await solicitacoes.create({
      tipo,
      unidade: String(input.unidade || '').trim(),
      unidadeNome: String(input.unidade || '').trim(),
      titulo,
      observacao: [String(input.descricao || '').trim(), `Aberto pelo Beniboy (chat de suporte)${quem ? ' — ' + quem : ''}.`].filter(Boolean).join('\n\n'),
      itens: [], anexos: [], ehOrcamento: false,
      prioridade: input.prioridade,
      criadoPorId: dono ? dono.id : null,
      criadoPorEmail: dono ? (dono.email || dono.username) : `Beniboy (chat de suporte)${quem ? ' — ' + quem : ''}`,
      // DIRECIONAMENTO POR TAG (roteamentoTags.js). Pedido do Master: o que o
      // Beniboy não resolve sozinho "é direcionada para quem tem a tag dela".
      // Com UMA pessoa na tag o ticket já nasce no nome dela; com mais de
      // uma fica sem dono e todas são avisadas (ver destinoDe) - e quando
      // ninguém tem a tag, segue pra Central, como sempre foi.
      direcionadoParaId: destino.dono ? destino.dono.id : null,
      direcionadoParaEmail: destino.dono ? (destino.dono.email || destino.dono.username) : null,
      nomePessoa: tipo === 'acesso-pessoa' ? String(input.nomePessoa).trim() : undefined,
      motivoAcesso: tipo === 'acesso-pessoa' ? input.motivoAcesso : undefined,
      dataEfetiva: tipo === 'acesso-pessoa' ? input.dataEfetiva : undefined,
      dataRetornoPrevista: tipo === 'acesso-pessoa' ? input.dataRetornoPrevista : undefined,
      // o ticket herda o MESMO numero do protocolo dessa conversa, em vez de
      // tirar um novo da sequencia - pedido explicito do usuario: "o numero
      // do ticket sempre sera o mesmo do protocolo... o proximo ticket tem
      // que ser na sequencia, nunca repetir"
      numeroTicket: chat.numeroTicket,
    });
    resultado.tickets.push(registro);
    // o index.js avisa quem tem a tag depois da resposta ser entregue (mesmo
    // caminho do agregador) - aqui só viaja o destino já resolvido, pra não
    // pagar a consulta de novo
    resultado.direcionados.push({ ticketId: registro.id, numeroTicket: registro.numeroTicket, titulo, tipo, unidadeNome: registro.unidadeNome, destino });
    await suporteChat.adicionarTicketVinculado(chat.id, { tipo: 'solicitacao', ticketId: registro.id, numero: registro.numeroTicket });
    const paraQuem = destino.dono ? ` Já está no nome de ${destino.dono.nome}.`
      : (destino.pessoas || []).length ? ` A equipe de ${destino.rotulo} já foi avisada.` : '';
    return `Ticket #${registro.numeroTicket} criado com sucesso (tipo ${tipo}, unidade ${registro.unidadeNome}).${paraQuem} Informe esse número à pessoa${paraQuem ? ' e diga que já foi direcionado' : ''}.`;
  }
  if (nome === 'consultar_meu_atendimento') {
    const vinculados = Array.isArray(chat.ticketsVinculados) ? chat.ticketsVinculados : [];
    const todos = vinculados.length ? await solicitacoes.listAll() : [];
    const tickets = vinculados.map((v) => {
      const ticket = todos.find((s) => s.id === v.ticketId || s.numeroTicket === v.numero);
      return ticket ? {
        numero: ticket.numeroTicket,
        tipo: ticket.tipo,
        titulo: ticket.titulo,
        unidade: ticket.unidadeNome || ticket.unidade,
        status: ticket.status,
        andamento: ticket.execucaoStatus || null,
      } : { numero: v.numero, tipo: v.tipo, status: 'vinculado ao atendimento' };
    });
    return JSON.stringify({
      protocolo: chat.numeroTicket,
      atendimento: chat.statusAtendimento || 'PENDENTE',
      tickets,
      mensagem: tickets.length
        ? 'Use apenas estes dados, pois pertencem a esta conversa.'
        : 'Este é o protocolo do chat. Ainda não há uma solicitação da Central vinculada a ele.',
    });
  }
  if (nome === 'consultar_ticket') {
    // A ferramenta nao entra no catalogo de visitante, mas a checagem aqui
    // impede vazamento caso o modelo tente usa-la fora do contexto previsto.
    if (!chat.logado || !chat.logado.ehTimeSuporte) return 'Sem autorização para consultar ticket de outra pessoa. Use consultar_meu_atendimento ou chamar_atendente.';
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
    // O resumo nao pode depender de o modelo lembrar de chamar uma segunda
    // ferramenta. Toda transferencia já deixa para o humano o ultimo pedido,
    // perfil e protocolo - a principal causa de "me explica de novo".
    const ultimaMensagem = [...(chat.mensagens || [])].reverse().find((m) => m.de === 'visitante');
    const motivo = String(input.motivo || '').trim();
    await suporteChat.registrarNotaInterna(chat.id, {
      resumo: `Handoff Beniboy · protocolo #${chat.numeroTicket}. ${motivo || 'Sem motivo informado.'}`,
      situacao: 'PENDENTE',
      pendencia: ultimaMensagem && ultimaMensagem.texto
        ? `Última mensagem da pessoa: ${String(ultimaMensagem.texto).slice(0, 600)}`
        : 'Continuar o atendimento nesta conversa.',
    }).catch(() => {});
    await suporteChat.desativarBot(chat.id);
    resultado.chamouAtendente = true;
    resultado.motivoAtendente = motivo;
    return 'Atendente humano chamado — o time foi notificado e vai responder nessa mesma conversa. Avise a pessoa e se despeça.';
  }
  if (nome === 'bloquear_no_agregador') {
    const acao = ACOES_AGREGADOR.includes(input.acao) ? input.acao : null;
    if (!acao) return 'Diga se é pausar-item ou fechar-loja.';
    const canal = CANAIS_AGREGADOR.includes(input.canal) ? input.canal : null;
    if (!canal) return 'Pergunte em qual app é: iFood, 99food ou os dois.';
    const unidade = String(input.unidade || '').trim();
    if (!unidade) return 'Pergunte de qual loja é antes de chamar - o coordenador precisa saber onde bloquear.';
    const item = String(input.item || '').trim();
    if (acao === 'pausar-item' && !item) return 'Pergunte QUAL item deve ser pausado - sem isso o coordenador não tem o que fazer.';
    const motivo = String(input.motivo || '').trim();
    // fica no resultado pro index.js notificar o coordenador DEPOIS da
    // resposta ja ter sido entregue (mesmo caminho dos tickets/escalacao)
    resultado.agregador = { acao, canal, unidade, item: item || null, motivo: motivo || null };
    // o time tambem enxerga isso no card da conversa, sem depender do push
    const oQue = acao === 'fechar-loja' ? 'Fechar loja' : `Pausar item: ${item}`;
    await suporteChat.registrarNotaInterna(chat.id, {
      resumo: `${oQue} · ${canal === 'ambos' ? 'iFood e 99food' : canal} · ${unidade}${motivo ? ` — ${motivo}` : ''}`,
      situacao: 'PENDENTE',
      pendencia: 'Na fila do Cowork Agregador. Se ele não executar, o coordenador agregador é chamado.',
    }).catch(() => {});
    return 'Pedido na fila do Cowork Agregador — ele faz o bloqueio no painel e a confirmação cai nessa conversa sozinha, em alguns minutos. Diga isso pra pessoa em 1 frase (sem prometer horário) e continue na conversa: você NÃO saiu dela, e NÃO precisa chamar atendente.';
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

      // Confere identidade antes de mexer em QUALQUER acesso: quem está no
      // chat é do time (Master/Admin/seção suporte), OU a sessão autenticada
      // é exatamente do login pedido, OU o contato inicial bate com o e-mail.
      // A sessão é a prova mais forte: antes o bot ignorava esse vínculo e
      // enviava a própria pessoa para humano só porque o campo contato tinha
      // telefone/apelido. Sem nenhuma dessas provas, visitante anônimo nunca
      // consegue mexer em uma conta só sabendo o username.
      const staffAjudando = !!(chat.logado && chat.logado.ehTimeSuporte);
      const propriaSessao = !!(chat.logado?.id && alvo.id && String(chat.logado.id) === String(alvo.id));
      const contatoBate = !!(chat.contato && alvo.email
        && String(chat.contato).trim().toLowerCase() === String(alvo.email).trim().toLowerCase());
      if (!staffAjudando && !propriaSessao && !contatoBate) {
        return 'Para proteger esse acesso, entre no NoPulso com a sua conta e mande a mensagem novamente, ou informe o e-mail cadastrado. Se não conseguir entrar, chame um atendente.';
      }

      if (alvo.active === false) {
        return `O acesso de "${alvo.username || alvo.email}" está desativado. Isso não é bloqueio de senha; chame um atendente para avaliar a reativação.`;
      }
      // Diagnóstico ANTES de qualquer desbloqueio: um horário restrito produz
      // a mesma sensação de "não entra", mas a senha continua válida. O bot
      // não altera essa política; abre handoff auditável para o Master revisar.
      if (!alvo.locked && !auth.dentroDoHorarioPermitido(alvo.horarioPermitido)) {
        const horario = alvo.horarioPermitido || {};
        const janela = horario.inicio && horario.fim ? `${horario.inicio}–${horario.fim}` : 'restrito';
        const motivo = `Horário de acesso de @${alvo.username || alvo.email}: permitido apenas ${janela}. Solicita ao Master revisar/liberar o horário; senha permanece a mesma.`;
        await suporteChat.registrarNotaInterna(chat.id, {
          resumo: `Diagnóstico Beniboy · ${motivo}`,
          situacao: 'PENDENTE',
          pendencia: 'Master deve revisar a política de horário em Usuários; não resetar nem desbloquear a senha.',
        }).catch(() => {});
        await suporteChat.desativarBot(chat.id);
        resultado.chamouAtendente = true;
        resultado.motivoAtendente = motivo;
        return `O acesso de "${alvo.username || alvo.email}" não está bloqueado: ele está fora do horário permitido (${janela}). A senha continua a mesma. O Master foi acionado para revisar/liberar o horário.`;
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

    // nao achou no login principal do NoPulso - tenta o login de operador do
    // Abastecimento do Carrinho (balcao, 4 letras + 4 numeros). Esse login ja
    // fica atras do login normal do NoPulso + secao de abastecimento (nao da
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
    // e avisada sozinha (SSE com o NoPulso aberto + push com fechado), sem
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
  // ---- impressora Zebra: ler o estado, e so entao reiniciar ----
  // A unidade NUNCA vem so do que o modelo escreveu: e sempre cruzada com o
  // acesso de quem esta falando. Pessoa de uma loja so alcanca a dela.
  function unidadeDaConversa(pedida) {
    const minhas = (chat.logado && chat.logado.unidades) || [];
    const escolhida = String(pedida || '').trim();
    if (escolhida) {
      if (!chat.logado.isMaster && !minhas.includes(escolhida)) return { erro: 'Essa loja não está no acesso dessa pessoa. Pergunte de qual loja ela é.' };
      return { unidade: escolhida };
    }
    if (minhas.length === 1) return { unidade: minhas[0] };
    if (!minhas.length) return { erro: 'Essa pessoa não tem loja no acesso - não dá pra saber de qual impressora ela fala. Use chamar_atendente.' };
    return { erro: `Essa pessoa tem acesso a mais de uma loja (${minhas.join(', ')}). Pergunte de qual loja é a impressora antes de continuar.` };
  }

  function descreverImpressora(i) {
    const quando = i.em ? ` (medido ${new Date(i.em).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })})` : '';
    const nome = i.nome || i.ip || i.mac;
    if (i.nivel === 'desconhecido') return `${nome}: não respondeu na última checagem${quando}. Pode estar desligada ou fora da rede.`;
    if (i.nivel === 'ok') return `${nome}: sem problema apontado${quando}.`;
    return `${nome}: ${i.motivos.join(' · ')}${quando}.`;
  }

  if (nome === 'estado_impressora') {
    const alvo = unidadeDaConversa(input.unidade);
    if (alvo.erro) return alvo.erro;
    const lista = await lojaStatus.estadoImpressorasDaUnidade(alvo.unidade);
    if (!lista.length) return 'Essa loja não tem impressora Zebra monitorada no cadastro. Não dá pra ler o estado nem reiniciar por aqui - use chamar_atendente.';
    return lista.map(descreverImpressora).join('\n');
  }

  if (nome === 'resetar_impressora') {
    const alvo = unidadeDaConversa(input.unidade);
    if (alvo.erro) return alvo.erro;
    const lista = await lojaStatus.estadoImpressorasDaUnidade(alvo.unidade);
    if (!lista.length) return 'Essa loja não tem impressora Zebra monitorada no cadastro. Use chamar_atendente.';
    // trava do pedido do Master: tampa aberta (e papel/ribbon) nao se conserta
    // reiniciando - alguem tem que ir ate a impressora. Reiniciar aqui so
    // tiraria ela do ar por 30s e devolveria o mesmo problema.
    const naMao = lista
      .map((i) => ({ i, motivos: lojaStatus.motivosQuePedemMao(i.motivos) }))
      .filter((x) => x.motivos.length);
    if (naMao.length) {
      return 'NÃO reiniciei. ' + naMao.map((x) => `${x.i.nome || x.i.ip || x.i.mac}: ${x.motivos.join(' · ')}`).join('; ')
        + '. Isso não se resolve reiniciando - peça pra pessoa resolver na própria impressora (fechar a tampa, repor papel ou ribbon)'
        + ' e avisar quando terminar. Aí chame estado_impressora de novo e, se estiver liberado, resetar_impressora.';
    }
    const alvos = [...new Map(lista.map((i) => [`${i.computador.codigo}|${i.computador.posto}`, i.computador])).values()]
      .map((c) => ({ codigo: c.codigo, posto: c.posto }));
    const resultados = await lojaStatus.enfileirarComandoEmAlvos(
      alvos,
      async (doc) => lojaStatus.comandoResetZebra(await lojaStatus.impressorasPraSondar(doc.codigo)),
      { acao: 'beniboy.resetarZebra', origem: 'beniboy-chat', porNome: 'Beniboy' },
    );
    const ok = (resultados || []).filter((x) => x.ok).length;
    if (!ok) return 'Não consegui enviar o comando pra loja agora (o computador que fala com a impressora pode estar desligado). Use chamar_atendente.';
    return `Reset enviado pra ${ok} computador(es) da loja. A impressora descarta a fila e volta em cerca de 30 segundos - o computador não é reiniciado.`
      + ' Peça pra pessoa testar de novo em 1 minuto e, se continuar, chame um atendente.';
  }

  if (nome === 'registrar_nota_interna') {
    const resumo = String(input.resumo || '').trim();
    if (!resumo) return 'Escreva o resumo da nota interna.';
    await suporteChat.registrarNotaInterna(chat.id, {
      resumo, situacao: input.situacao, pendencia: input.pendencia,
    });
    return 'Nota interna registrada no atendimento (só o time vê). Continue normalmente com a pessoa.';
  }
  if (nome === 'encerrar_atendimento') {
    // NAO finaliza aqui: se marcasse RESOLVIDO agora, a conversa viraria
    // FINALIZADO e o adicionarMensagem() do fim do responderConversa
    // (que exige status ABERTO) jogaria fora a mensagem de despedida do bot.
    // Entao so sinaliza - o encerramento de fato acontece DEPOIS da despedida
    // ser postada (ver responderConversa).
    resultado.encerrar = { resumo: String(input.resumo || '').trim() };
    return 'Ok - a conversa vai ser marcada como resolvida assim que você responder. Mande agora uma única mensagem curta de despedida (a pessoa não vai mais conseguir escrever depois disso).';
  }
  if (nome === 'executar_acao_agente') {
    // defesa em profundidade: mesmo espirito do recheck de consultar_pedido
    // - so entra em TOOLS quando logado.isMaster, mas confere de novo aqui
    // antes de tocar em qualquer execucao real
    if (!chat.logado || !chat.logado.isMaster) return 'Sem acesso a essa ferramenta - chame um atendente.';
    const acao = await agenteAcoes.obter(input.acaoId);
    if (!acao || !acao.ativo) return 'Essa ação não existe (ou foi desativada) no catálogo NOC-NoPulso - confira o [id] certo.';
    const resumo = String(input.resumo || acao.nome).slice(0, 300);
    // quem age é o MASTER da conversa, gravado pelo SERVIDOR: sobrescreve o
    // que o modelo mandar em porId, pra ação de sistema nunca sair no nome de
    // outra pessoa (ver resolverAtor em agenteAcoes.js). Vai junto no payload
    // da fila, então sobrevive até a aprovação e a um restart.
    const parametros = { ...(input.parametros || {}), porId: chat.logado.id };
    if (acao.requerAprovacao) {
      await qaAprovacoes.criar({
        tipo: 'agente.executarAcao',
        resumo,
        payload: { acaoId: input.acaoId, parametros },
        criadoPorId: chat.logado.id,
        criadoPorEmail: `${chat.logado.username} (via Beniboy)`,
      });
      return `Ação "${acao.nome}" preparada e enviada pra aprovação do Master (fica visível em NOC-NoPulso).`;
    }
    try {
      const resultadoAcao = await agenteAcoes.executarAcaoDoAgente(input.acaoId, parametros);
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

// O limite de conversa existe para evitar um loop caro ou uma triagem que
// nunca termina. Antes ele apenas retornava null: para a pessoa parecia que o
// suporte tinha sumido. Este handoff e' deterministico, auditavel e dispara o
// mesmo alerta usado quando o proprio modelo chama um humano.
async function escalarPorLimite(chat) {
  const ultimaMensagem = [...(chat.mensagens || [])].reverse().find((m) => m.de === 'visitante');
  const motivo = 'Conversa atingiu o limite de tentativas automáticas; precisa de continuidade humana.';
  await suporteChat.registrarNotaInterna(chat.id, {
    resumo: `Handoff automático Beniboy · protocolo #${chat.numeroTicket}. ${motivo}`,
    situacao: 'PENDENTE',
    pendencia: ultimaMensagem && ultimaMensagem.texto
      ? `Última mensagem da pessoa: ${String(ultimaMensagem.texto).slice(0, 600)}`
      : 'Revisar o histórico desta conversa.',
  }).catch(() => {});
  await suporteChat.desativarBot(chat.id);
  const atualizado = await suporteChat.adicionarMensagem(chat.id, {
    de: 'suporte',
    bot: true,
    texto: 'Já organizei o histórico deste atendimento e chamei o time para continuar por aqui. Você não precisa repetir as informações.',
  });
  return { chat: atualizado, tickets: [], direcionados: [], agregador: null, encerrar: null, chamouAtendente: true, motivoAtendente: motivo };
}

// Gera (e grava) a resposta do bot pra conversa. Retorna null quando o bot
// nao deve/nao consegue falar; senao { chat, tickets, chamouAtendente }.
// `unidades` = nomes validos pra abertura de ticket (vem do index.js).
async function responderConversa(chatId, { unidades = [], unidadesPorCodigo = {}, resolverUnidadesPorIdPulse, resolverUnidadePublica, linkEstornoCliente } = {}) {
  if (!ativo() || emAndamento.has(chatId)) return null;
  emAndamento.add(chatId);
  try {
    const chat = await suporteChat.getOne(chatId);
    if (!chat || chat.status !== 'ABERTO') return null;
    if (chat.atendidoPorEmail || chat.botDesativado) return null; // humano assumiu / bot ja se despediu
    const msgs = chat.mensagens || [];
    if (!msgs.length || msgs[msgs.length - 1].de !== 'visitante') return null; // nada novo pra responder
    if (msgs.filter((m) => m.bot).length >= MAX_RESPOSTAS_BOT) return escalarPorLimite(chat);

    const resultado = { tickets: [], tarefas: [], direcionados: [], chamouAtendente: false, motivoAtendente: '', encerrar: null, agregador: null };
    // Conversas abertas antes desta versão não tinham podeCriarTarefa no
    // retrato da sessão. Atualiza só esse sinal para que não seja necessário
    // o colaborador abandonar um atendimento em andamento para criar a tarefa.
    if (chat.logado?.id) {
      const usuarioAtual = donoDoChat(chat, await users.list());
      chat.logado.podeCriarTarefa = podeCriarTarefaNoChat(usuarioAtual);
    }
    const mensagens = montarMensagens(chat);
    const system = await montarSystem(unidades, chat.logado, unidadesPorCodigo);
    const tools = montarTools(chat.logado);
    let resp = await getCliente().messages.create({
      model: MODELO, max_tokens: MAX_TOKENS, system, messages: mensagens,
      tools, output_config: { effort: ESFORCO },
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
          saida = await executarTool(bloco.name, bloco.input || {}, chat, resultado, resolverUnidadesPorIdPulse, resolverUnidadePublica, linkEstornoCliente, unidadesPorCodigo);
        } catch (err) {
          saida = `Erro ao executar: ${err.message}`;
        }
        results.push({ type: 'tool_result', tool_use_id: bloco.id, content: saida });
      }
      mensagens.push({ role: 'user', content: results });
      resp = await getCliente().messages.create({
        model: MODELO, max_tokens: MAX_TOKENS, system, messages: mensagens,
        tools, output_config: { effort: ESFORCO },
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

    let atualizado = await suporteChat.adicionarMensagem(chatId, { de: 'suporte', texto, bot: true });

    // encerramento pedido pela tool encerrar_atendimento: so agora, DEPOIS da
    // despedida ja ter sido postada acima. Registra o resumo como nota interna
    // (relatorio de encerramento) e marca RESOLVIDO no funil (o que tambem
    // finaliza a conversa pro visitante). nivelDestino:1 mantem o card no
    // nivel do bot (ele resolveu sozinho); autor sintetico deixa claro no
    // historicoStatus que foi o Beniboy. Erro aqui nao quebra a resposta - a
    // mensagem ja foi entregue; no pior caso a varredura de ociosos encerra.
    if (resultado.encerrar) {
      try {
        if (resultado.encerrar.resumo) {
          await suporteChat.registrarNotaInterna(chatId, { resumo: resultado.encerrar.resumo, situacao: 'RESOLVIDO' });
        }
        atualizado = await suporteChat.atualizarStatusAtendimento(chatId, {
          statusAtendimento: 'RESOLVIDO', nivelDestino: 1, autor: { nome: 'Beniboy (bot)' },
        });
      } catch (e) {
        console.error('[suporteBot] falha ao encerrar conversa:', e.message);
      }
    }
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

module.exports = { ativo, responderConversa, MODELO, ESFORCO, donoDoChat, escalarPorLimite };
