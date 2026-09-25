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
const store = require('./store');
const adyenDisputas = require('./adyenDisputas');
const refunds = require('./refunds');
const catalogo = require('./coworkCatalogo');
const suporteChat = require('./suporteChat');

// O index.js liga aqui o broadcast da tela: sem isso, o comentário ou o
// pré-preenchimento do Claude só apareceria na tarefa aberta depois de F5.
let aoAlterarTarefa = () => {};
function configurar(opcoes = {}) {
  if (typeof opcoes.aoAlterarTarefa === 'function') aoAlterarTarefa = opcoes.aoAlterarTarefa;
}

const AUDITORIA = db.collection('coworkApiAuditoria');
const IDEMPOTENCIA = db.collection('coworkApiIdempotencia');

const FERRAMENTAS = Object.freeze({
  // ---- consultas (etapa 2, 23/09/2026): o Claude enxerga antes de agir ----
  consultar_ticket: { descricao: 'Acha pelo NÚMERO que a pessoa vê (ex.: 12052 ou "#12052") a tarefa do Meu Dia e/ou a solicitação da Central com esse número. Devolve o tarefaId/solicitacaoId interno - é ele que as ações pedem, não o número.', risco: 'leitura', obrigatorios: ['numero'] },
  listar_tarefas: { descricao: 'Lista tarefas e reuniões ABERTAS do Meu Dia (Pendente, A fazer, Hoje, Em andamento), filtrando por unidade, status, responsável e texto. Concluída/cancelada: use consultar_ticket com o número.', risco: 'leitura', obrigatorios: [] },
  listar_solicitacoes: { descricao: 'Lista solicitações da Central (compra, suporte de TI, manutenção, pagamento, nota...) por unidade, tipo, status (PENDENTE, APROVADO, REJEITADO, CONVERTIDO) e texto, da mais nova pra mais antiga.', risco: 'leitura', obrigatorios: [] },
  ler_chat_ticket: { descricao: 'Lê a conversa de uma solicitação da Central (a caixa "Escrever uma mensagem..." do ticket). Informe o numero, ou solicitacaoId.', risco: 'leitura', obrigatorios: [] },
  ler_chat_suporte: { descricao: 'Lê um protocolo do Beniboy/Suporte. Devolve conversa, notas internas, pendência, status e responsável. Informe o protocolo que a pessoa vê, ex.: 12113.', risco: 'leitura', obrigatorios: ['protocolo'] },
  listar_usuarios: { descricao: 'Lista acessos por cargo, unidade ou texto (nome, e-mail, username), incluindo seções, unidades, subgrupos do Cofre, tipos de solicitação e flags. Não traz senha nem segredo.', risco: 'leitura', obrigatorios: [] },
  ler_reuniao: { descricao: 'Lê uma reunião do Meu Dia: pauta, participantes, resumo, anotações (comentários), decisões e o TEXTO das transcrições anexadas (.txt, .vtt, .md, .docx). Informe tarefaId ou numero.', risco: 'leitura', obrigatorios: [] },
  // ---- defesa de chargeback (24/09/2026): a unidade responde no Meu Dia, o
  // NoPulso gera o PDF, o Claude anexa na Adyen e registra aqui o que fez ----
  listar_disputas: { descricao: 'Lista os casos de chargeback/aviso de fraude da Adyen com prazo, status (MONITORANDO, ABERTA, ENVIADA, GANHA, PERDIDA), tarefa de defesa e se a defesa já está pronta pra anexar. Filtros: status, unidade, somenteProntas.', risco: 'leitura', obrigatorios: [] },
  obter_disputa: { descricao: 'Um caso completo: dados do pagamento, motivo, prazos, respostas da unidade e LINKS TEMPORÁRIOS (2h) do PDF da defesa e de cada evidência, pra baixar e anexar na Adyen. Informe disputaId, ou numero (ticket da tarefa), ou o PSP do pagamento/disputa.', risco: 'leitura', obrigatorios: [] },
  obter_pagamento_adyen: { descricao: 'O pagamento contestado como a Adyen mandou: comprador (nome), endereço, cartão (bandeira, BIN, final, país e banco emissor), IP, 3DS, AVS/CVC, score de risco, linha do tempo dos eventos, os SINAIS que pesam na defesa e os outros pedidos do mesmo cliente que o Monitor guarda. Telefone e e-mail vêm mascarados: quem copia pra defesa é o servidor (preencher_defesa com usarDadosAdyen). Informe psp, numero (ticket da tarefa) ou disputaId.', risco: 'leitura', obrigatorios: [] },
  preencher_defesa: { descricao: 'Pré-preenche a "Defesa de chargeback" DENTRO da tarefa do Meu Dia. usarDadosAdyen=true copia do pagamento o que a Adyen traz com certeza (nome, telefone, endereço de entrega, delivery, pedidos anteriores do mesmo cliente); campos={id: valor} escreve o que você apurou (ids e opções do questionário, ex.: canal, itens, foraDoNormalTexto) e fontes={id: "de onde veio"}. Só escreve em campo VAZIO, nunca troca resposta da unidade e nunca marca decisao nem declaracao. Cada campo ganha o selo "preenchido pelo Claude" na tela e a tarefa recebe um comentário. Não conclui a tarefa. Informe tarefaId, numero ou disputaId.', risco: 'baixo', obrigatorios: [] },
  comentar_tarefa: { descricao: 'Escreve um comentário na tarefa do Meu Dia, assinado como Claude (Cowork), e avisa no celular o responsável e os participantes (avisar=false pra só registrar). Use pra cobrar o que falta, explicar o que foi preenchido e recomendar contestar ou aceitar. Informe tarefaId ou numero, e texto.', risco: 'baixo', obrigatorios: ['texto'] },
  preparar_defesa_adyen: { descricao: 'Consulta NA ADYEN (Disputes API) os motivos de defesa que a bandeira aceita para esta disputa e os documentos que cada um pede, e lista o que o NoPulso tem pra enviar (PDF da defesa e evidências). Use antes de enviar_defesa_adyen. Informe disputaId, numero ou psp.', risco: 'leitura', obrigatorios: [] },
  enviar_defesa_adyen: { descricao: 'Envia a defesa PELA API da Adyen: sobe os documentos (por padrão o PDF da defesa, no tipo de documento que o motivo pede) e defende com motivoDefesa (código de preparar_defesa_adyen). documentos=[{arquivo:"defesa" ou id da evidência (nota-fiscal, print-pedido...), tipo:"código do documento"}] pra escolher. Só com a defesa da unidade concluída e decisão Contestar. Deu certo, o caso fica ENVIADA sozinho.', risco: 'alto', obrigatorios: ['disputaId', 'motivoDefesa'], autorizar: true },
  aceitar_disputa_adyen: { descricao: 'Aceita o chargeback PELA API da Adyen (o valor fica com o banco) e marca o caso PERDIDA. Use quando a unidade decidiu aceitar ou não há como defender.', risco: 'alto', obrigatorios: ['disputaId'], autorizar: true },
  registrar_defesa_enviada: { descricao: 'Registra no NoPulso que a defesa FOI anexada e enviada na Adyen (status ENVIADA). Use só depois de enviar de fato, com a confirmação do Master na conversa.', risco: 'baixo', obrigatorios: ['disputaId'] },
  registrar_disputa_aceita: { descricao: 'Registra no NoPulso que o chargeback foi ACEITO na Adyen, sem defesa (status PERDIDA). Use só depois de aceitar de fato, com a confirmação do Master na conversa.', risco: 'baixo', obrigatorios: ['disputaId'] },
  consultar_autorizacao: { descricao: 'Consulta se o Master já autorizou (ou recusou) uma ação pedida antes, e o resultado dela.', risco: 'leitura', obrigatorios: ['autorizacaoId'] },
  // ---- preparo pelo Claude, assinatura do Master no celular (24/09/2026) ----
  listar_unidades: { descricao: 'Unidades com código, nome, apelidos aceitos, marca, empresa e o cadastro de formulário (rótulo, razão social, CNPJ). Toda ferramenta que pede unidade aceita código, nome ou apelido, sem diferenciar acento e maiúscula.', risco: 'leitura', obrigatorios: [] },
  listar_modelos_formulario: { descricao: 'Tipos de formulário (estorno, reembolso, avulso...), com os campos do cabeçalho, as colunas da tabela, quem assina, o que é obrigatório pra sair do rascunho e se o tipo só nasce de um ticket.', risco: 'leitura', obrigatorios: [] },
  obter_estorno: { descricao: 'Um estorno pelo número do ticket (ex.: 12029): venda, valor, motivo, cliente e Pix (documento, telefone e chave mascarados - o servidor copia os dados reais pro formulário), status, o formulário já gerado e LINKS TEMPORÁRIOS (2h) dos anexos (comprovante da maquininha).', risco: 'leitura', obrigatorios: [] },
  obter_formulario: { descricao: 'Um formulário: status (RASCUNHO, PENDENTE = aguardando assinatura, ASSINADO, CANCELADO), assinaturas, origem, envio ao Conecta e LINK TEMPORÁRIO (2h) do PDF. Informe formularioId ou numero.', risco: 'leitura', obrigatorios: [] },
  validar_formulario: { descricao: 'Diz o que falta e o que não bate num formulário (campo obrigatório vazio, CPF/CNPJ inválido, data, valor diferente do ticket de origem). Use antes de pedir_assinatura.', risco: 'leitura', obrigatorios: [] },
  pedir_assinatura: { descricao: 'Manda o formulário pra assinatura do Master: valida (se faltar algo, recusa na hora e diz o quê), tira do rascunho e pede a digital dele no celular com a prévia. Aprovado, o Master assina eletronicamente o papel Responsável/Gerente, o PDF assinado fica pronto e o ticket de origem recebe o registro. Informe formularioId ou numero.', risco: 'medio', obrigatorios: [], autorizar: true },
  registrar_envio_conecta: { descricao: 'Registra no NoPulso que o PDF ASSINADO foi enviado no portal do Conecta, com o número de protocolo que o portal deu. Use só depois de enviar de fato. Comenta no ticket de origem.', risco: 'baixo', obrigatorios: ['protocolo'] },
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
  criar_formulario: { descricao: 'Cria um formulário em RASCUNHO (nada é assinado nem enviado). numero = ticket de origem (ex.: o estorno 12029): o servidor copia campos e anexos do ticket e acha a unidade sozinho. Sem numero: tipo + unidade (código, nome ou apelido) + campos/linhas. modo=link gera o link pro solicitante preencher. Tipos e campos: listar_modelos_formulario.', risco: 'baixo', obrigatorios: ['tipo'] },
  criar_usuario: { descricao: 'Cria acesso copiando permissões de um usuário-modelo.', risco: 'alto', obrigatorios: ['modelo', 'email', 'username'], autorizar: true, devolveSegredo: true },
  desbloquear_usuario: { descricao: 'Desbloqueia um acesso existente sem trocar a senha.', risco: 'alto', obrigatorios: ['usuario'], autorizar: true },
  criar_nova_senha: { descricao: 'Gera e aplica senha temporária aleatória; Master precisa repassá-la com segurança.', risco: 'alto', obrigatorios: ['usuario'], autorizar: true, devolveSegredo: true },
  ajustar_permissoes_usuario: { descricao: 'Altera somente os campos de permissão informados de um acesso existente (seções, unidades, subgrupos do Cofre, tipos da Central e cargos). Sempre gera aprovação do Master no celular e devolve o antes/depois.', risco: 'alto', obrigatorios: ['usuario'], autorizar: true },
  responder_chat_suporte: { descricao: 'Envia uma resposta do Cowork pelo Beniboy ao solicitante de um protocolo de suporte aberto.', risco: 'baixo', obrigatorios: ['protocolo', 'texto'] },
  finalizar_chat_suporte: { descricao: 'Registra o resumo interno e finaliza um protocolo de suporte depois que a situação estiver resolvida.', risco: 'baixo', obrigatorios: ['protocolo', 'resumo'] },
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
  tipo: { type: 'string', description: 'Formulário: estorno, reembolso, avulso, deposito, diarias, diariasRh, adiantamento, assBoleto (listar_modelos_formulario). Solicitação: estorno, compra, manutencao, suporte-ti, pagamento, nota...' }, modo: { type: 'string', enum: ['link', 'preenchido'] }, campos: { type: 'object' }, linhas: { type: 'array', items: { type: 'object' } },
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
  usarDadosAdyen: { type: 'boolean', description: 'preencher_defesa: o servidor copia da Adyen o que ela traz com certeza (nome, telefone, endereço de entrega, delivery, histórico do cliente).' },
  fontes: { type: 'object', description: 'preencher_defesa: {campo: "de onde veio"} - aparece no selo do campo.' },
  motivoDefesa: { type: 'string', description: 'enviar_defesa_adyen: defenseReasonCode devolvido por preparar_defesa_adyen.' },
  documentos: { type: 'array', items: { type: 'object', properties: { arquivo: { type: 'string' }, tipo: { type: 'string' } } }, description: 'enviar_defesa_adyen: [{arquivo:"defesa"|id da evidência, tipo:defenseDocumentTypeCode}].' },
  avisar: { type: 'boolean', description: 'comentar_tarefa: false = só registra, sem push pros participantes.' },
  responsavelEmail: { type: 'string', description: 'E-mail ou username do responsável. Sem ele, a tarefa fica com o Master.' },
  formularioId: { type: 'string', description: 'Id interno do formulário (vem de criar_formulario/obter_formulario).' },
  gcom: { type: 'boolean', description: 'consultar_noc: true = só as máquinas marcadas "Possui GCOM" no cadastro; false = só as sem.' },
  estornoId: { type: 'string', description: 'Id interno do estorno (vem de obter_estorno).' },
  protocolo: { type: 'string', description: 'Número do protocolo de suporte/Beniboy ou do portal Conecta, conforme a ferramenta.' },
  resumo: { type: 'string', description: 'Resumo interno objetivo do que foi resolvido no atendimento.' },
  restringirAposConclusao: { type: 'boolean', description: 'finalizar_chat_suporte: true para criação, senha ou outro caso de acesso. Após concluir, o solicitante não relê nem baixa o chat; só Master e Suporte veem.' },
  permissions: { type: 'object', description: 'ajustar_permissoes_usuario: informe apenas os campos a alterar: sections, unidades, vaultSubgroups e/ou tiposSolicitacao.' },
  cargos: { type: 'array', items: { type: 'string' }, description: 'ajustar_permissoes_usuario: cargos finais. Omitido = não altera cargos.' },
  destino: { type: 'string', enum: ['conecta'], description: 'Pra onde o documento vai depois de assinado. Hoje: conecta (portal - o envio lá é feito por você, no navegador).' },
  dataInicio: { type: 'string', description: 'AAAA-MM-DD' },
  idempotencyKey: { type: 'string', description: 'UUID novo por intenção de escrita; reutilize apenas ao repetir a mesma chamada.' },
};

// UM SCHEMA POR FERRAMENTA (pedido do Cowork, 24/09/2026). Antes toda
// ferramenta expunha as ~50 propriedades de PROPRIEDADES_COMUNS: o Claude
// não sabia o que cada uma usa e errava a chamada. E o schema também
// ESCONDIA o que existia: criar_tarefa entende responsavelEmail, mas a
// propriedade não estava na lista e o additionalProperties:false barrava -
// toda tarefa criada pelo Claude caía no Master.
// Cada nome aqui é o que o executor da ferramenta LÊ de verdade.
const PARAMETROS = Object.freeze({
  consultar_ticket: ['numero'],
  listar_tarefas: ['unidade', 'status', 'responsavel', 'termo', 'limite'],
  listar_solicitacoes: ['unidade', 'tipo', 'status', 'termo', 'limite'],
  ler_chat_ticket: ['numero', 'solicitacaoId'],
  ler_chat_suporte: ['protocolo'],
  listar_usuarios: ['cargo', 'unidade', 'termo', 'incluirInativos', 'limite'],
  ler_reuniao: ['tarefaId', 'numero'],
  listar_disputas: ['status', 'unidade', 'somenteProntas', 'limite'],
  obter_disputa: ['disputaId', 'numero', 'psp'],
  obter_pagamento_adyen: ['disputaId', 'numero', 'psp'],
  preencher_defesa: ['tarefaId', 'numero', 'disputaId', 'psp', 'campos', 'fontes', 'usarDadosAdyen'],
  comentar_tarefa: ['tarefaId', 'numero', 'disputaId', 'psp', 'texto', 'avisar'],
  preparar_defesa_adyen: ['disputaId', 'numero', 'psp'],
  enviar_defesa_adyen: ['disputaId', 'motivoDefesa', 'documentos', 'observacao'],
  aceitar_disputa_adyen: ['disputaId', 'observacao'],
  registrar_defesa_enviada: ['disputaId', 'observacao'],
  registrar_disputa_aceita: ['disputaId', 'observacao'],
  consultar_autorizacao: ['autorizacaoId'],
  preparar_reuniao: ['termo', 'unidade', 'limite'],
  consultar_noc: ['unidade', 'gcom'],
  pesquisar_emails: ['consulta', 'limite'],
  ler_email: ['emailId'],
  enviar_email: ['para', 'assunto', 'texto'],
  criar_tarefa: ['titulo', 'descricao', 'unidade', 'unidadeNome', 'prioridade', 'dataInicio', 'dataEntrega', 'responsavelEmail'],
  criar_reuniao: ['titulo', 'descricao', 'dataEntrega', 'horaInicio', 'duracaoMin', 'linkReuniao', 'unidade', 'unidadeNome'],
  concluir_tarefa: ['tarefaId', 'observacao'],
  cancelar_tarefa: ['tarefaId', 'motivo'],
  criar_solicitacao_ti: ['unidade', 'unidadeNome', 'titulo', 'observacao', 'prioridade'],
  criar_formulario: ['tipo', 'unidade', 'modo', 'campos', 'linhas', 'numero'],
  listar_unidades: ['termo'],
  listar_modelos_formulario: ['tipo'],
  obter_estorno: ['numero', 'estornoId'],
  obter_formulario: ['formularioId', 'numero'],
  validar_formulario: ['formularioId', 'numero'],
  pedir_assinatura: ['formularioId', 'numero', 'destino', 'observacao'],
  registrar_envio_conecta: ['formularioId', 'numero', 'protocolo', 'observacao'],
  criar_usuario: ['modelo', 'email', 'username'],
  desbloquear_usuario: ['usuario', 'pedirTrocaSenha'],
  criar_nova_senha: ['usuario'],
  ajustar_permissoes_usuario: ['usuario', 'permissions', 'cargos'],
  responder_chat_suporte: ['protocolo', 'texto'],
  finalizar_chat_suporte: ['protocolo', 'resumo', 'restringirAposConclusao'],
  executar_noc: ['tarefa', 'alvos'],
});
function propriedadesDe(nome, f) {
  const lista = [...(PARAMETROS[nome] || []), ...(f.risco === 'leitura' ? [] : ['idempotencyKey'])];
  return Object.fromEntries(lista.map((k) => [k, PROPRIEDADES_COMUNS[k]]));
}

function ferramentasMcp() {
  return Object.entries(FERRAMENTAS).map(([name, f]) => ({
    name, description: `${f.descricao} Risco: ${f.risco}.${f.autorizar ? ' NÃO executa na hora: vira um pedido de autorização que chega no celular do Master (digital ou senha). A resposta traz pendente=true e autorizacaoId; acompanhe com consultar_autorizacao e só diga que foi feito depois de status aprovado.' : ''}`,
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: propriedadesDe(name, f),
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
  // parâmetro que a ferramenta não lê era ignorado calado - o Claude achava
  // que tinha filtrado/preenchido e não tinha. Agora a resposta diz o quê.
  const aceitos = new Set([...(PARAMETROS[nome] || Object.keys(PROPRIEDADES_COMUNS)), 'idempotencyKey', 'confirmar']);
  const estranhos = Object.keys(entrada || {}).filter((k) => !aceitos.has(k));
  if (estranhos.length) throw new Error(`${nome} não usa: ${estranhos.join(', ')}. Aceita: ${[...(PARAMETROS[nome] || [])].join(', ') || 'nenhum parâmetro'}.`);
  return ferramenta;
}

// O que a tela de autorização mostra. Sai do PAYLOAD (o que vai rodar), com
// rótulo em português - nunca um resumo escrito pelo modelo, que poderia
// dizer uma coisa e pedir outra.
const ROTULOS = {
  para: 'Para', assunto: 'Assunto', texto: 'Texto', tarefaId: 'Tarefa', motivo: 'Motivo',
  modelo: 'Copiar permissões de', email: 'E-mail', username: 'Usuário', usuario: 'Acesso',
  permissions: 'Permissões a alterar', cargos: 'Cargos finais', protocolo: 'Protocolo', resumo: 'Resumo interno',
  pedirTrocaSenha: 'Pedir troca de senha', tarefa: 'Comando', alvos: 'Computadores', unidade: 'Unidade',
  titulo: 'Título', descricao: 'Descrição', observacao: 'Observação',
  disputaId: 'Disputa', motivoDefesa: 'Motivo de defesa', documentos: 'Documentos',
};
const TITULO_ACAO = {
  pedir_assinatura: 'Assinar formulário',
  enviar_email: 'Enviar e-mail', concluir_tarefa: 'Concluir tarefa', cancelar_tarefa: 'Cancelar tarefa',
  criar_usuario: 'Criar acesso', desbloquear_usuario: 'Desbloquear acesso', criar_nova_senha: 'Gerar senha temporária', ajustar_permissoes_usuario: 'Ajustar permissões',
  executar_noc: 'Comando no NOC',
  enviar_defesa_adyen: 'Enviar defesa na Adyen', aceitar_disputa_adyen: 'Aceitar chargeback na Adyen',
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
async function executarAutorizado(payload, aprovacao = null) {
  const nome = String(payload && payload.nome || '');
  const ferramenta = FERRAMENTAS[nome];
  if (!ferramenta || !ferramenta.autorizar) throw new Error('Ação do Claude inválida.');
  const ator = await resolverAtor();
  // quem aprovou, como (digital/senha) e de que aparelho: vem do SERVIDOR
  // (rota de aprovação), por cima de qualquer coisa que estivesse no pedido
  const resultado = await despachar(nome, { ...(payload.entrada || {}), _aprovacao: aprovacao || undefined }, ator);
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
  const [listaTarefas, todasSolicitacoes, todosEstornos, todosFormularios, chatsSuporte] = await Promise.all([
    tarefas.porNumero(n), solicitacoes.listAll(), refunds.listAll(), formularios.listar(), suporteChat.listAll(),
  ]);
  const achadas = todasSolicitacoes.filter((x) => Number(x.numeroTicket) === n);
  // estorno e formulário moram em coleções próprias, mas o número é da MESMA
  // sequência dos tickets: o #12029 do estorno é achado aqui também
  const estornos = todosEstornos.filter((x) => Number(x.numeroTicket) === n);
  const forms = todosFormularios.filter((f) => Number(f.numeroTicket) === n);
  const chats = chatsSuporte.filter((c) => Number(c.numeroTicket) === n).map(chatSuporteCompacto);
  const nada = !listaTarefas.length && !achadas.length && !estornos.length && !forms.length && !chats.length;
  return {
    numero: n,
    tarefas: listaTarefas.map(tarefaCompacta),
    solicitacoes: achadas.map(solicitacaoCompacta),
    estornos: estornos.map(estornoCompacto),
    formularios: forms.map((f) => ({ formularioId: f.id, tipo: f.tipo, status: f.status, unidade: f.unidade, valorTotal: f.valorTotal ?? null })),
    chatsSuporte: chats,
    aviso: nada ? 'Nenhuma tarefa, solicitação, estorno, formulário ou chat de suporte com esse número.' : null,
  };
}

function numeroDoProtocolo(valor) {
  const numero = Number(String(valor == null ? '' : valor).replace(/\D/g, ''));
  if (!numero) throw new Error('Informe o protocolo, ex.: 12113.');
  return numero;
}
function chatSuporteCompacto(chat) {
  return {
    protocolo: chat.numeroTicket || null, chatId: chat.id, assunto: chat.assunto || null,
    nome: chat.nome || null, contato: chat.contato || null, status: chat.status || null,
    statusAtendimento: chat.statusAtendimento || null, nivel: chat.nivel || null,
    responsavel: chat.responsavel || chat.atendidoPorEmail || null,
    pendente: (chat.notasInternas || []).some((n) => n.situacao === 'PENDENTE'),
    criadoEm: chat.criadoEm || null, atualizadoEm: chat.atualizadoEm || null,
  };
}
async function acharChatSuporte(protocolo) {
  const numero = numeroDoProtocolo(protocolo);
  const chat = (await suporteChat.listAll()).find((c) => Number(c.numeroTicket) === numero);
  if (!chat) throw new Error(`Protocolo #${numero} não encontrado no Beniboy.`);
  return chat;
}
async function lerChatSuporte(protocolo) {
  const chat = await acharChatSuporte(protocolo);
  return {
    ...chatSuporteCompacto(chat),
    notasInternas: (chat.notasInternas || []).map((n) => ({ resumo: n.resumo || '', situacao: n.situacao || null, pendencia: n.pendencia || null, por: n.por || null, em: n.em || null })),
    mensagens: (chat.mensagens || []).map((m) => ({ de: m.de, por: m.autorEmail || (m.bot ? 'Beniboy/Cowork' : null), texto: m.texto || '', em: m.em, anexo: m.anexo ? { nome: m.anexo.nome || null, tipo: m.anexo.tipo || null } : null })),
  };
}
async function responderChatSuporte(p) {
  const chat = await acharChatSuporte(p.protocolo);
  if (chat.status !== 'ABERTO') throw new Error('Esse chat já está finalizado; não é possível responder nele.');
  const texto = String(p.texto || '').trim();
  if (!texto) throw new Error('Escreva a resposta para o solicitante.');
  await suporteChat.adicionarMensagem(chat.id, { de: 'suporte', texto, autorEmail: 'Cowork via Beniboy', bot: true });
  return `Resposta enviada no protocolo #${chat.numeroTicket}.`;
}
async function finalizarChatSuporte(p) {
  const chat = await acharChatSuporte(p.protocolo);
  const resumo = String(p.resumo || '').trim();
  if (!resumo) throw new Error('Escreva o resumo do encerramento.');
  if (p.restringirAposConclusao) await suporteChat.restringirAposConclusao(chat.id);
  await suporteChat.registrarNotaInterna(chat.id, { resumo, situacao: 'RESOLVIDO' });
  await suporteChat.finalizar(chat.id, { autorEmail: 'Cowork via Beniboy' });
  return `Protocolo #${chat.numeroTicket} finalizado com resumo interno.`;
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
  let estorno = null;
  if (p.solicitacaoId) alvo = await solicitacoes.getOne(String(p.solicitacaoId));
  else if (p.numero) {
    const n = Number(String(p.numero).replace(/\D/g, ''));
    alvo = (await solicitacoes.listAll()).find((x) => Number(x.numeroTicket) === n) || null;
    // o chat do estorno é o mesmo da Central, com tipo 'estorno'
    if (!alvo) estorno = await estornoPorNumero(n);
  } else throw new Error('Informe o numero ou o solicitacaoId.');
  if (!alvo && !estorno) throw new Error('Solicitação não encontrada.');
  const mensagens = await centralChat.listByCard(alvo ? alvo.tipo : 'estorno', alvo ? alvo.id : estorno.id);
  return {
    ...(alvo ? { solicitacao: solicitacaoCompacta(alvo) } : { estorno: estornoCompacto(estorno) }),
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
      vaultSubgroups: u.permissions ? (u.permissions.vaultSubgroups || []) : 'todos (master)',
      tiposSolicitacao: u.permissions ? (u.permissions.tiposSolicitacao || []) : 'todos (master)',
      flags: u.role === 'master' ? {} : {
        admin: !!u.isAdmin, catalogoEstoque: !!u.podeCatalogoEstoque, catalogoInsumos: !!u.podeCatalogoInsumos,
        cadastrarOperadores: !!u.podeCadastrarOperadores, nopulsoPrint: !!u.podeNoPulsoPrint,
        pedirCorrecaoFechamento: !!u.podePedirCorrecaoFechamento,
        rhTodasUnidades: !!u.podeRhTodasUnidades, rhCadastrarEfetivado: !!u.podeRhCadastrarEfetivado,
        sessaoLonga: !!u.sessaoLonga, qaUser: !!u.qaUser,
      },
    })),
  };
}

// Alteração de acesso é deliberadamente "patch", não substituição: o Cowork
// só toca no que foi informado e a aprovação mostra o antes/depois. Assim um
// lote para Meu Dia não apaga Cofre, unidade ou cargo por acidente.
async function planejarAjustePermissoes(p) {
  const usuario = await users.findByIdentifier(String(p.usuario || '').trim());
  if (!usuario) throw new Error('Usuário não encontrado. Informe e-mail ou username.');
  if (usuario.role === 'master') throw new Error('O acesso Master não usa permissões editáveis.');
  const alteracoes = p.permissions && typeof p.permissions === 'object' ? p.permissions : {};
  const campos = ['sections', 'unidades', 'vaultSubgroups', 'tiposSolicitacao'];
  const informados = campos.filter((campo) => Object.prototype.hasOwnProperty.call(alteracoes, campo));
  const mudaCargos = Array.isArray(p.cargos);
  if (!informados.length && !mudaCargos) throw new Error('Informe ao menos permissions (campos a alterar) ou cargos.');
  for (const campo of informados) {
    if (!Array.isArray(alteracoes[campo])) throw new Error(`${campo} deve ser uma lista.`);
  }
  if (informados.includes('sections')) {
    const invalida = alteracoes.sections.find((s) => !users.VALID_SECTIONS.includes(String(s)));
    if (invalida) throw new Error(`Seção inválida: ${invalida}.`);
  }
  if (informados.includes('tiposSolicitacao')) {
    const invalido = alteracoes.tiposSolicitacao.find((t) => !users.TIPOS_SOLICITACAO.includes(String(t)));
    if (invalido) throw new Error(`Tipo de solicitação inválido: ${invalido}.`);
  }
  if (mudaCargos) {
    const invalido = p.cargos.find((c) => !users.CARGOS_VALIDOS.includes(String(c).toLowerCase()));
    if (invalido) throw new Error(`Cargo inválido: ${invalido}.`);
  }
  const antes = {
    permissions: usuario.permissions || { sections: [], unidades: [], vaultSubgroups: [], tiposSolicitacao: [] },
    cargos: usuario.cargos || (usuario.cargo ? [usuario.cargo] : []),
  };
  const depois = {
    permissions: { ...antes.permissions, ...Object.fromEntries(informados.map((campo) => [campo, alteracoes[campo]])) },
    cargos: mudaCargos ? p.cargos : antes.cargos,
  };
  return {
    usuario: { id: usuario.id, email: usuario.email, username: usuario.username || null },
    alterados: [...informados, ...(mudaCargos ? ['cargos'] : [])], antes, depois,
  };
}
async function ajustarPermissoesUsuario(p) {
  const plano = await planejarAjustePermissoes(p);
  if (plano.alterados.some((campo) => campo !== 'cargos')) await users.updatePermissions(plano.usuario.id, plano.depois.permissions);
  if (plano.alterados.includes('cargos')) await users.updateCargos(plano.usuario.id, plano.depois.cargos);
  return plano;
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
    preenchidoPeloClaude: tarefa && tarefa.defesaChargeback ? Object.entries(tarefa.defesaChargeback.preenchidoPeloClaude || {})
      .map(([k, s]) => ({ campo: (defesaChargeback.QUESTOES.find((q) => q.id === k) || {}).rotulo || k, fonte: s.fonte, em: s.em })) : [],
    comentariosDaTarefa: ((tarefa && tarefa.comentarios) || []).slice(-20).map((m) => ({ por: m.porNome, em: m.em, texto: m.texto, sistema: !!m.sistema })),
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
// ---------- A DEFESA DENTRO DA TAREFA (24/09/2026) ----------
// Pedido do Master: "tudo dentro da tarefa no Meu Dia", sem e-mail e sem
// abrir a Adyen no navegador. O Claude lê o pagamento que o Monitor já tem,
// pré-preenche o que é fato da Adyen, comenta o que falta e cobra a unidade.
function txsDoPedido(pedidoId) {
  const chave = (t) => t.merchantReference || t.originalReference || t.pspReference;
  return store.allTransactions().filter((t) => chave(t) === pedidoId);
}
async function obterPagamentoAdyen(p) {
  const c = await acharCaso(p);
  if (!c) throw new Error('Disputa não encontrada.');
  const txs = txsDoPedido(c.pedidoId);
  if (!txs.length) throw new Error('O Monitor não tem mais os eventos deste pedido (nem o pagamento original).');
  const d = defesaChargeback.dadosDoPagamento(txs);
  const hist = defesaChargeback.mesmoCliente(store.allTransactions(), d, c.pedidoId);
  return {
    disputaId: c.id, tarefaId: c.tarefaId || null, tarefaTicket: c.tarefaNumero || null,
    pagamento: {
      ...d,
      emailCliente: defesaChargeback.mascararEmail(d.emailCliente),
      telefoneCliente: d.telefoneCliente ? defesaChargeback.mascararTelefone(d.telefoneCliente) : null,
      aliasCartao: d.aliasCartao ? 'presente' : null, shopperReference: undefined,
    },
    sinais: defesaChargeback.sinaisDaDefesa(d),
    mesmoCliente: hist,
    oServidorPreencheria: Object.keys(defesaChargeback.sugestoesDaAdyen(d, hist).campos),
  };
}
async function acharTarefaDeDefesa(p) {
  if (p.tarefaId) return tarefas.getOne(String(p.tarefaId));
  if (p.numero) {
    const lista = await tarefas.porNumero(p.numero);
    return lista.find((t) => t.defesaChargeback) || lista[0] || null;
  }
  if (p.disputaId || p.psp) {
    const c = await acharCaso(p);
    return c && c.tarefaId ? tarefas.getOne(c.tarefaId) : null;
  }
  throw new Error('Informe tarefaId, numero ou disputaId.');
}
async function preencherDefesa(p) {
  const t = await acharTarefaDeDefesa(p);
  if (!t) throw new Error('Tarefa não encontrada.');
  if (!t.defesaChargeback) throw new Error('Esta tarefa não é de defesa de chargeback.');
  const campos = {}; const fontes = {};
  if (p.usarDadosAdyen) {
    const c = await disputes.getOne(t.defesaChargeback.disputaId);
    const txs = c ? txsDoPedido(c.pedidoId) : [];
    if (txs.length) {
      const d = defesaChargeback.dadosDoPagamento(txs);
      const s = defesaChargeback.sugestoesDaAdyen(d, defesaChargeback.mesmoCliente(store.allTransactions(), d, c.pedidoId));
      Object.assign(campos, s.campos); Object.assign(fontes, s.fontes);
    }
  }
  // o que o Claude mandou vem por cima do automático (ele pode ter apurado melhor)
  const doClaude = p.campos && typeof p.campos === 'object' ? p.campos : {};
  for (const [k, v] of Object.entries(doClaude)) {
    campos[k] = v;
    fontes[k] = String((p.fontes && p.fontes[k]) || 'Claude');
  }
  if (!Object.keys(campos).length) throw new Error('Nada para preencher: mande campos e/ou usarDadosAdyen=true.');
  const r = await tarefas.preencherDefesaPeloAgente(t.id, campos, { fontes });
  aoAlterarTarefa(r.tarefa);
  const rotulo = (k) => (defesaChargeback.QUESTOES.find((q) => q.id === k) || {}).rotulo || k;
  return {
    tarefaId: t.id, ticket: t.numeroTicket || null,
    preenchidos: r.escritos.map(rotulo),
    jaRespondidosPelaUnidade: r.mantidos.map(rotulo),
    recusados: r.recusados.length ? r.recusados.map((k) => `${rotulo(k)}: só a unidade responde`) : [],
    invalidos: r.invalidos.length ? r.invalidos.map((k) => `${k}: campo ou opção fora do questionário`) : [],
    faltaNaDefesa: r.faltando,
  };
}
async function comentarTarefa(p) {
  const t = await acharTarefaDeDefesa(p);
  if (!t) throw new Error('Tarefa não encontrada.');
  const r = await tarefas.comentarComoAgente(t.id, p.texto);
  aoAlterarTarefa(r.tarefa);
  let avisados = 0;
  if (p.avisar !== false) {
    const ids = [...new Set([t.responsavelId, ...(t.colaboradoresIds || [])].filter(Boolean))];
    const titulo = `💬 Claude comentou: ${String(t.titulo || 'tarefa').slice(0, 60)}`;
    for (const id of ids) {
      await push.notifyUsuario(id, titulo, String(p.texto).slice(0, 140), `tarefa-coment-${t.id}`, `/tarefas?tarefa=${encodeURIComponent(t.id)}`)
        .then(() => { avisados += 1; }).catch(() => {});
    }
  }
  return { tarefaId: t.id, ticket: t.numeroTicket || null, comentarioId: r.comentario.id, avisados };
}

// ---------- A DEFESA PELA API DA ADYEN (adyenDisputas.js) ----------
// Mesmas travas do registrar_*: sem defesa concluída não defende, caso
// encerrado não mexe. E o envio só roda com a digital do Master (autorizar).
function arquivosDoCaso(c) {
  const lista = [];
  if (c.defesaPdf) lista.push({ arquivo: 'defesa', nome: c.defesaPdf.nome, path: c.defesaPdf.path, contentType: 'application/pdf', tamanhoKB: Math.round((c.defesaPdf.tamanho || 0) / 1024), avisos: c.defesaPdf.avisos || [] });
  for (const e of c.evidencias || []) {
    const tipo = /pdf/i.test(e.tipo || '') ? 'application/pdf' : (/png/i.test(e.tipo || '') ? 'image/png' : 'image/jpeg');
    lista.push({ arquivo: e.evidencia, nome: e.nome, path: e.path, contentType: tipo });
  }
  return lista;
}
async function contextoAdyen(c) {
  if (!c) throw new Error('Disputa não encontrada.');
  if (!c.pspDisputa) throw new Error('Esta disputa ainda não tem o PSP da disputa (a Adyen ainda não abriu o chargeback - aviso de fraude sozinho não se defende).');
  const conta = adyenDisputas.contaDoCaso(c, txsDoPedido(c.pedidoId));
  if (!conta) throw new Error(`Não sei o merchantAccountCode da Adyen de ${c.unidade}. Configure ADYEN_MERCHANT_ACCOUNTS no Render (ex.: {"${c.unidade}":"DOM_xxxxx"}).`);
  return { pspDisputa: c.pspDisputa, conta };
}
async function prepararDefesaAdyen(p) {
  const c = await acharCaso(p);
  const cfg = adyenDisputas.configurada();
  const base = { disputaId: c ? c.id : null, status: c ? c.status : null, apiConfigurada: cfg.ok, falta: cfg.falta,
    defesaPronta: !!(c && c.defesaProntaEm), decisaoDaUnidade: c ? c.decisao || null : null,
    arquivosDisponiveis: c ? arquivosDoCaso(c).map(({ path, ...x }) => x) : [] };
  if (!cfg.ok) return { ...base, motivos: [], aviso: `A API de disputas não está configurada no Render. Falta: ${cfg.falta.join(', ')}.` };
  const ctx = await contextoAdyen(c);
  return { ...base, contaAdyen: ctx.conta, pspDisputa: ctx.pspDisputa, motivos: await adyenDisputas.motivosDeDefesa(ctx) };
}
async function agirNaAdyen(nome, p, ator) {
  const c = await disputes.getOne(String(p.disputaId));
  if (!c) throw new Error('Disputa não encontrada.');
  if (['GANHA', 'PERDIDA'].includes(c.status)) throw new Error(`Essa disputa já está encerrada (${c.status}).`);
  const ctx = await contextoAdyen(c);
  const porNome = `Claude (Cowork) via API · ${ator.username || ator.email}`;
  if (nome === 'aceitar_disputa_adyen') {
    await adyenDisputas.aceitar(ctx);
    await disputes.registrarAcao(c.id, { status: 'PERDIDA', porNome, observacao: p.observacao || 'Chargeback aceito pela API da Adyen.', campo: 'aceite' });
    await disputes.salvarCaso(c.id, { resultado: 'chargeback aceito sem defesa' });
    return `Chargeback aceito na Adyen. Disputa ${c.id} registrada como PERDIDA.`;
  }
  if (c.status === 'ENVIADA') throw new Error('A defesa desta disputa já foi enviada.');
  if (!c.defesaProntaEm) throw new Error('A defesa ainda não foi gerada: a tarefa da unidade não foi concluída.');
  if (c.decisao === defesaChargeback.OPCAO_ACEITAR) throw new Error('A unidade decidiu aceitar o chargeback: use aceitar_disputa_adyen.');
  const disponiveis = arquivosDoCaso(c);
  let escolhidos = Array.isArray(p.documentos) && p.documentos.length ? p.documentos : null;
  if (!escolhidos) {
    // padrão: o PDF da defesa no documento que o motivo mais exige
    const motivo = (await adyenDisputas.motivosDeDefesa(ctx)).find((m) => m.codigo === p.motivoDefesa);
    if (!motivo) throw new Error(`O motivo ${p.motivoDefesa} não é aceito pela bandeira nesta disputa. Veja preparar_defesa_adyen.`);
    const tipo = (motivo.documentos.find((d) => /required/i.test(d.exigencia || '')) || motivo.documentos[0] || {}).codigo;
    if (!tipo) throw new Error('A Adyen não informou tipo de documento para esse motivo: mande documentos=[{arquivo, tipo}].');
    escolhidos = [{ arquivo: 'defesa', tipo }];
  }
  const docs = [];
  for (const d of escolhidos) {
    const a = disponiveis.find((x) => x.arquivo === d.arquivo);
    if (!a) throw new Error(`Arquivo "${d.arquivo}" não existe nesta defesa. Disponíveis: ${disponiveis.map((x) => x.arquivo).join(', ')}.`);
    if (!d.tipo) throw new Error(`Falta o tipo de documento da Adyen para "${d.arquivo}".`);
    docs.push({ buffer: await storage.baixarArquivo(a.path), contentType: a.contentType, tipo: String(d.tipo) });
  }
  await adyenDisputas.defender({ ...ctx, motivo: String(p.motivoDefesa), documentos: docs });
  const agora = new Date().toISOString();
  await disputes.registrarAcao(c.id, { status: 'ENVIADA', porNome, observacao: p.observacao || `Defesa enviada pela API: ${p.motivoDefesa}.`, campo: 'envio' });
  await disputes.salvarCaso(c.id, { envioAdyen: { em: agora, motivo: String(p.motivoDefesa), documentos: escolhidos.map((d) => ({ arquivo: d.arquivo, tipo: d.tipo })) } });
  if (c.tarefaId) {
    const r = await tarefas.comentarComoAgente(c.tarefaId, `✅ Defesa enviada na Adyen pela API (motivo ${p.motivoDefesa}, ${docs.length} documento(s)), com autorização do Master. Agora é aguardar o banco: o resultado chega sozinho.`).catch(() => null);
    if (r) aoAlterarTarefa(r.tarefa);
  }
  return `Defesa enviada na Adyen (${p.motivoDefesa}, ${docs.length} documento(s)). Disputa ${c.id} registrada como ENVIADA.`;
}

// ---------- PREPARO PELO CLAUDE, ASSINATURA NO CELULAR (24/09/2026) ----------
// Pedido do Cowork: "o Claude prepara tudo; o Master só assina no celular".
// Níveis: leitura livre; preparo (rascunho, validar) livre e com selo; a
// assinatura passa pela digital do Master (autorizar); o envio ao Conecta
// é feito pelo Claude no portal e só REGISTRADO aqui.
const PAPEIS_DO_MASTER = ['responsavel', 'gerente'];
function baseUrl() { return String(process.env.APP_BASE_URL || 'https://www.nopulso.com.br').replace(/\/$/, ''); }
function linkTemporario(caminho, nome) {
  return `${baseUrl()}/api/defesa-arquivo?t=${encodeURIComponent(defesaChargeback.assinarLink(caminho, nome, process.env.JWT_SECRET || ''))}`;
}
// documento, telefone e chave Pix não vão pro modelo (mesma regra do
// obter_disputa): o formulário recebe os dados reais pelo servidor
function mascararDoc(v) { const d = String(v || '').replace(/\D/g, ''); return d ? `•••${d.slice(-2)}` : null; }
function mascararChavePix(v) {
  const t = String(v || '').trim(); if (!t) return null;
  if (t.includes('@')) return defesaChargeback.mascararEmail(t);
  const d = t.replace(/\D/g, '');
  return d.length >= 8 && d.length === t.replace(/[\s().+-]/g, '').length ? `•••${d.slice(-4)}` : `${t.slice(0, 3)}•••`;
}
const numeroDe = (v) => Number(String(v == null ? '' : v).replace(/\D/g, '')) || 0;

async function estornoPorNumero(n) {
  return (await refunds.listAll()).find((x) => Number(x.numeroTicket) === n) || null;
}
function estornoCompacto(x) {
  return {
    estornoId: x.id, ticket: x.numeroTicket || null, status: x.status, execucaoStatus: x.execucaoStatus || null,
    unidade: x.unidadeNome || x.unidade || null, codigoUnidade: x.unidade || null,
    valorEstornar: x.valorEstornar ?? null, dataVenda: x.dataVenda || null,
    motivo: x.motivoEstorno === 'Outro' ? (x.motivoOutro || 'Outro') : (x.motivoEstorno || null),
    formulario: x.formularioId ? { formularioId: x.formularioId, ticket: x.formularioNumero ?? null } : null,
    criadoEm: x.criadoEm || null,
  };
}
async function obterEstorno(p) {
  let x = null;
  if (p.estornoId) x = await refunds.getOne(String(p.estornoId));
  else if (p.numero) x = await estornoPorNumero(numeroDe(p.numero));
  else throw new Error('Informe o numero do ticket ou o estornoId.');
  if (!x) throw new Error('Estorno não encontrado com esse número.');
  return {
    ...estornoCompacto(x),
    origem: x.origem || null, observacao: x.observacao || null, horaVenda: x.horaVenda || null,
    valorVenda: x.valorVenda ?? null, formaPagamento: x.formaPagamento || null, bandeira: x.bandeira || null, ultimos4: x.ultimos4 || null,
    cliente: { nome: x.nomeCliente || null, documento: mascararDoc(x.cpfCnpjCliente), telefone: x.telefoneCliente ? defesaChargeback.mascararTelefone(x.telefoneCliente) : null },
    pix: { titular: x.pixNomeTitular || null, banco: x.pixBanco || null, chave: mascararChavePix(x.pixChave) },
    anexos: (x.anexos || []).map((a) => ({ nome: a.nome || 'anexo', tipo: a.tipo || null, link: a.path ? linkTemporario(a.path, a.nome || 'anexo') : null })),
    proximoPasso: x.status !== 'APROVADO'
      ? `O estorno está ${x.status}: só estorno APROVADO vira formulário.`
      : (x.formularioId ? 'Já tem formulário: veja com obter_formulario.' : 'Pronto pra criar_formulario tipo=estorno numero=' + x.numeroTicket + ' (nasce em rascunho).'),
  };
}

async function acharFormulario(p) {
  if (p.formularioId) return formularios.getOne(String(p.formularioId));
  const n = numeroDe(p.numero);
  if (!n) throw new Error('Informe formularioId ou numero.');
  const lista = (await formularios.listar()).filter((f) => Number(f.numeroTicket) === n);
  const vivo = lista.find((f) => f.status !== 'CANCELADO') || lista[0];
  return vivo ? formularios.getOne(vivo.id) : null;
}
// documento, contato e dados bancários do favorecido: o Claude vê que estão
// preenchidos, não o valor (validar_formulario confere o formato no servidor)
const CAMPOS_SENSIVEIS = { cpf: mascararDoc, contato: (v) => (v ? defesaChargeback.mascararTelefone(v) : null), chavePix: mascararChavePix, agencia: mascararDoc, conta: mascararDoc };
function camposMascarados(campos) {
  const out = { ...(campos || {}) };
  for (const [k, f] of Object.entries(CAMPOS_SENSIVEIS)) if (out[k]) out[k] = f(out[k]);
  return out;
}
// o que o Claude vê do formulário: NUNCA o token de assinatura (o token é o
// link que assina - na mão do modelo, ele assinaria no lugar de alguém)
function formularioCompacto(f) {
  const r = formularios.resumo(f);
  const modelo = formularios.TIPOS[f.tipo] || {};
  return {
    formularioId: r.id, ticket: r.numeroTicket ?? null, tipo: r.tipo, rotulo: modelo.rotulo || r.tipo,
    unidade: r.unidade, status: r.status, valorTotal: r.valorTotal ?? null,
    campos: camposMascarados(r.campos), linhas: r.linhas, anexos: (r.anexos || []).map((a) => a.nome),
    assinaturas: r.assinaturas.map((a) => ({ papel: a.chave, rotulo: a.rotulo, assinado: a.assinado, eletronica: a.eletronica ? a.eletronica.metodo : null, nome: a.nome, em: a.assinadoEm })),
    origem: r.origem || null, preparadoPor: r.preparadoPor || null,
    enviadoConecta: r.enviadoConecta || null,
    pdf: linkTemporario(`formulario-pdf:${r.id}`, `formulario-${r.numeroTicket || r.id}.pdf`),
  };
}
async function referenciaDe(f) {
  if (f && f.origem && f.origem.tipo === 'estorno' && f.origem.id) {
    const x = await refunds.getOne(f.origem.id);
    if (x) return { valor: x.valorEstornar };
  }
  return null;
}
async function obterFormulario(p) {
  const f = await acharFormulario(p);
  if (!f) throw new Error('Formulário não encontrado.');
  return formularioCompacto(f);
}
async function validarFormulario(p) {
  const f = await acharFormulario(p);
  if (!f) throw new Error('Formulário não encontrado.');
  const v = formularios.validarConteudo(f, { referencia: await referenciaDe(f) });
  return { formularioId: f.id, ticket: f.numeroTicket ?? null, status: f.status, ...v,
    proximoPasso: v.ok ? (f.status === formularios.STATUS_RASCUNHO ? 'Pronto: pedir_assinatura.' : `Já saiu do rascunho (${f.status}).`) : 'Corrija o que falta antes de pedir a assinatura.' };
}

function listarModelosFormulario(p) {
  const tipos = Object.entries(formularios.TIPOS).filter(([k]) => !p.tipo || k === p.tipo);
  if (p.tipo && !tipos.length) throw catalogo.erroComLista('Tipo de formulário', p.tipo, Object.keys(formularios.TIPOS));
  return tipos.map(([tipo, m]) => ({
    tipo, rotulo: m.rotulo,
    somenteDeTicket: !!m.somenteDeTicket, soAnexo: !!m.soAnexo,
    anexo: m.anexoObrigatorio || (formularios.EXIGIDOS[tipo] && formularios.EXIGIDOS[tipo].anexo) ? 'obrigatório' : 'opcional',
    // CNPJ e razão social saem do cadastro da unidade: não se preenchem
    campos: m.cabecalho.filter((c) => c.key !== 'cnpj').map((c) => ({ id: c.key, rotulo: c.label, data: !!c.data, valor: !!c.valor, obrigatorio: !!(formularios.EXIGIDOS[tipo] && formularios.EXIGIDOS[tipo].campos.includes(c.key)) })),
    colunas: (m.colunas || []).map((c) => ({ id: c.key, rotulo: c.label, data: !!c.data, valor: !!c.valor, intervalo: !!c.intervalo })),
    assinam: (m.assinantes || []).map((a) => ({ papel: a.papel, rotulo: a.rotulo, peloMaster: PAPEIS_DO_MASTER.includes(a.papel) })),
    assinaturaPorLinha: !!m.assinaturaPorLinha,
  }));
}

async function criarFormulario(p, ator) {
  const tipos = Object.keys(formularios.TIPOS);
  if (!tipos.includes(String(p.tipo || ''))) throw catalogo.erroComLista('Tipo de formulário', p.tipo, tipos);
  const preparadoPor = { nome: 'Claude (Cowork)', via: ator.email, em: new Date().toISOString() };
  if (p.numero) {
    // a partir do ticket: hoje só o estorno tem o caminho ticket -> formulário
    if (p.tipo !== 'estorno') throw new Error(`Formulário a partir de ticket só existe pro tipo estorno. Pra ${p.tipo}, mande unidade + campos/linhas.`);
    const x = await estornoPorNumero(numeroDe(p.numero));
    if (!x) throw new Error(`Não há estorno com o ticket ${p.numero}. Confira com obter_estorno.`);
    const dados = {};
    if (p.unidade) dados.unidade = (await catalogo.resolverUnidadeDoFormulario(p.unidade)).unidade;
    const f = await refunds.gerarFormulario(x.id, dados, `${ator.email} via Claude/Cowork`, { rascunho: true, preparadoPor });
    const cheio = await formularios.getOne(f.id);
    return { mensagem: `Formulário #${f.numeroTicket} (${formularios.TIPOS.estorno.rotulo}) criado em RASCUNHO a partir do estorno #${x.numeroTicket}, com ${(cheio.anexos || []).length} anexo(s) copiado(s).`,
      ...formularioCompacto(cheio), validacao: formularios.validarConteudo(cheio, { referencia: { valor: x.valorEstornar } }) };
  }
  if (formularios.TIPOS[p.tipo].somenteDeTicket) throw new Error(`${formularios.TIPOS[p.tipo].rotulo} só nasce de um ticket: mande numero (o ticket de origem).`);
  if (!p.unidade) throw new Error('Informe a unidade (código, nome ou apelido) - ou numero, pra criar a partir de um ticket.');
  const cadastro = await catalogo.resolverUnidadeDoFormulario(p.unidade);
  const base = { tipo: p.tipo, unidade: cadastro.unidade, criadoPorId: ator.id, criadoPorEmail: `${ator.email} via Claude/Cowork` };
  if (p.modo === 'link') {
    const r = await formularios.criarParaPreenchimento(base);
    return { mensagem: `Formulário #${r.numeroTicket} criado pra preenchimento por link.`, id: r.id, linkPreenchimento: r.tokenPreenchimento ? `${baseUrl()}/formulario-preencher?token=${encodeURIComponent(r.tokenPreenchimento)}` : null };
  }
  const r = await formularios.criar({ ...base, campos: p.campos || {}, linhas: p.linhas || [], anexos: [], rascunho: true, preparadoPor });
  const cheio = await formularios.getOne(r.id);
  return { mensagem: `Formulário #${r.numeroTicket} criado em RASCUNHO.`, ...formularioCompacto(cheio), validacao: formularios.validarConteudo(cheio) };
}

// ANTES do pedido chegar no celular: valida e tira do rascunho. Faltando
// algo, recusa na hora - sem isso o Master receberia pra assinar um
// documento que nem poderia ser pago.
async function antesDePedirAssinatura(p) {
  const f = await acharFormulario(p);
  if (!f) throw new Error('Formulário não encontrado.');
  const papel = PAPEIS_DO_MASTER.find((k) => f.assinaturas && f.assinaturas[k]);
  if (!papel) throw new Error('Esse formulário não tem papel Responsável/Gerente pro Master assinar - quem assina são os links de cada pessoa.');
  if (formularios.slotAssinado(f.assinaturas[papel])) throw new Error('O Master já assinou esse formulário.');
  await formularios.liberarParaAssinatura(f.id, { referencia: await referenciaDe(f) });
  const modelo = formularios.TIPOS[f.tipo] || {};
  const reais = (v) => `R$ ${(Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return {
    // o pedido guarda o id: numero pode achar outro formulário amanhã
    entrada: { formularioId: f.id, destino: p.destino || null, observacao: p.observacao || null },
    resumo: `Assinar ${modelo.rotulo || f.tipo} #${f.numeroTicket} · ${f.unidade} · ${reais(f.valorTotal)}`,
    detalhes: [
      { rotulo: 'Documento', valor: `${modelo.rotulo || f.tipo} #${f.numeroTicket}` },
      { rotulo: 'Unidade', valor: f.unidade },
      { rotulo: 'Valor', valor: reais(f.valorTotal) },
      ...(f.campos && f.campos.favorecido ? [{ rotulo: 'Favorecido', valor: f.campos.favorecido }] : []),
      ...(f.campos && f.campos.cliente ? [{ rotulo: 'Cliente', valor: f.campos.cliente }] : []),
      { rotulo: 'Você assina como', valor: (f.assinaturas[papel].rotulo || papel) },
      ...(p.destino ? [{ rotulo: 'Depois vai para', valor: p.destino === 'conecta' ? 'Conecta (o Claude envia no portal)' : p.destino }] : []),
      { rotulo: 'Prévia do PDF', valor: `${baseUrl()}/api/formularios/${f.id}/pdf?inline=1` },
    ],
  };
}
async function comentarNoTicketDeOrigem(f, texto) {
  if (!f || !f.origem || f.origem.tipo !== 'estorno' || !f.origem.id) return false;
  await centralChat.addMessage({ tipo: 'estorno', cardId: f.origem.id, autorId: null, autorEmail: 'Claude (Cowork)', autorUsername: 'Claude (Cowork)', texto });
  return true;
}
async function pedirAssinatura(p) {
  // só chega aqui pelo executor da autorização, com o Master conferido
  const ap = p._aprovacao;
  if (!ap) throw new Error('Assinatura só com a autorização do Master.');
  const f = await formularios.getOne(String(p.formularioId || ''));
  if (!f) throw new Error('Formulário não encontrado.');
  const papel = PAPEIS_DO_MASTER.find((k) => f.assinaturas && f.assinaturas[k]);
  const r = await formularios.assinarEletronicamente(f.id, {
    papel, nome: ap.nome, metodo: ap.metodo, dispositivo: ap.dispositivo, autorizacaoId: ap.autorizacaoId,
  });
  const depois = await formularios.getOne(f.id);
  const quem = ap.nome || 'Master';
  await comentarNoTicketDeOrigem(depois, `✍️ ${quem} assinou eletronicamente o formulário #${depois.numeroTicket} (${ap.metodo === 'digital' ? 'digital' : 'senha'}).${r.completo ? ' Documento ASSINADO.' : ` Falta: ${r.faltam.join(', ')}.`}${p.destino === 'conecta' && r.completo ? ' Próximo passo: envio ao Conecta.' : ''}`).catch(() => false);
  return {
    mensagem: r.completo ? `Formulário #${depois.numeroTicket} ASSINADO.` : `Assinatura do Master registrada. Ainda falta: ${r.faltam.join(', ')}.`,
    ...formularioCompacto(depois),
    proximoPasso: r.completo && p.destino === 'conecta' ? 'Baixe o PDF (link em pdf), envie no portal do Conecta e registre com registrar_envio_conecta + protocolo.' : null,
  };
}
async function registrarEnvioConectaDoCowork(p) {
  const f = await acharFormulario(p);
  if (!f) throw new Error('Formulário não encontrado.');
  const envio = await formularios.registrarEnvioConecta(f.id, { protocolo: p.protocolo, porNome: 'Claude (Cowork)', observacao: p.observacao });
  await comentarNoTicketDeOrigem(f, `📤 Formulário #${f.numeroTicket} enviado ao Conecta pelo Claude (Cowork). Protocolo: ${envio.protocolo || '—'}.`).catch(() => false);
  return { mensagem: `Envio ao Conecta registrado (protocolo ${envio.protocolo || '—'}).`, formularioId: f.id, ticket: f.numeroTicket ?? null, enviadoConecta: envio };
}
async function antesDeAjustarPermissoes(entrada) {
  const plano = await planejarAjustePermissoes(entrada);
  return {
    resumo: `Ajustar permissões · ${plano.usuario.username || plano.usuario.email}`,
    detalhes: [
      { rotulo: 'Acesso', valor: plano.usuario.email },
      { rotulo: 'Campos alterados', valor: plano.alterados.join(', ') },
      { rotulo: 'Antes', valor: valorLegivel(plano.antes) },
      { rotulo: 'Depois', valor: valorLegivel(plano.depois) },
    ],
  };
}
const ANTES_DE_AUTORIZAR = { pedir_assinatura: antesDePedirAssinatura, ajustar_permissoes_usuario: antesDeAjustarPermissoes };

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
  if (nome === 'obter_pagamento_adyen') return obterPagamentoAdyen(p);
  if (nome === 'preencher_defesa') return preencherDefesa(p);
  if (nome === 'comentar_tarefa') return comentarTarefa(p);
  if (nome === 'preparar_defesa_adyen') return prepararDefesaAdyen(p);
  if (nome === 'enviar_defesa_adyen' || nome === 'aceitar_disputa_adyen') return agirNaAdyen(nome, p, ator);
  if (nome === 'registrar_defesa_enviada' || nome === 'registrar_disputa_aceita') return registrarNaDisputa(nome, p, ator);
  if (nome === 'consultar_ticket') return consultarTicket(p.numero);
  if (nome === 'ler_chat_suporte') return lerChatSuporte(p.protocolo);
  if (nome === 'responder_chat_suporte') return responderChatSuporte(p);
  if (nome === 'finalizar_chat_suporte') return finalizarChatSuporte(p);
  if (nome === 'listar_unidades') {
    const termo = catalogo.normalizar(p.termo);
    return (await catalogo.listarUnidades()).filter((u) => !termo || catalogo.normalizar(JSON.stringify([u.codigo, u.nome, u.apelidos, u.marca, u.empresa])).includes(termo));
  }
  if (nome === 'listar_modelos_formulario') return listarModelosFormulario(p);
  if (nome === 'obter_estorno') return obterEstorno(p);
  if (nome === 'obter_formulario') return obterFormulario(p);
  if (nome === 'validar_formulario') return validarFormulario(p);
  if (nome === 'pedir_assinatura') return pedirAssinatura(p);
  if (nome === 'registrar_envio_conecta') return registrarEnvioConectaDoCowork(p);
  if (nome === 'listar_tarefas') return listarTarefas(p);
  if (nome === 'listar_solicitacoes') return listarSolicitacoes(p);
  if (nome === 'ler_chat_ticket') return lerChatTicket(p);
  if (nome === 'listar_usuarios') return listarUsuarios(p);
  if (nome === 'ajustar_permissoes_usuario') return ajustarPermissoesUsuario(p);
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
    // "Possui GCOM" é o checkbox do cadastro da máquina (temGcom)
    const soGcom = typeof p.gcom === 'boolean' ? p.gcom : null;
    return (await lojaStatus.listarResumo())
      .filter((m) => !unidade || String(m.codigo || '').toLocaleLowerCase('pt-BR').includes(unidade) || String(m.nomeUnidade || '').toLocaleLowerCase('pt-BR').includes(unidade))
      .filter((m) => soGcom === null || !!m.temGcom === soGcom)
      .slice(0, 200).map((m) => ({
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
      gcom: !!m.temGcom,
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
  if (nome === 'criar_formulario') return criarFormulario(p, ator);
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
      let entradaLimpa = { ...(entrada || {}) }; delete entradaLimpa.confirmar; delete entradaLimpa.idempotencyKey; delete entradaLimpa._aprovacao;
      // preparo antes do celular tocar (ex.: pedir_assinatura valida e tira
      // do rascunho - faltando algo, recusa aqui mesmo)
      const preparo = ANTES_DE_AUTORIZAR[nome] ? await ANTES_DE_AUTORIZAR[nome](entradaLimpa, ator) : null;
      if (preparo && preparo.entrada) entradaLimpa = preparo.entrada;
      const resumo = (preparo && preparo.resumo) || resumoDoPedido(nome, entradaLimpa);
      const pedido = await qaAprovacoes.criar({
        tipo: 'cowork.executar', resumo, origem: 'cowork',
        detalhes: (preparo && preparo.detalhes) || detalhesDoPedido(nome, entradaLimpa),
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

module.exports = { PARAMETROS, listarFerramentas, ferramentasMcp, tokenValido, executar, executarAutorizado, configurar };
