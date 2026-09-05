// relatorioMV.js
// Relatorio diario por e-mail das solicitacoes direcionadas ao MV (Grupo
// Bravo) + aprovar/recusar direto no e-mail, sem precisar logar no NoPulso.
//
// PARTE A (relatorio): reaproveita centralCards.listarTodos() - a mesma
// fonte de dados do GET /api/central - filtrando por quem e "do gatilho"
// (ver ehDoMV: mesmo criterio de podeVerCard() em index.js - direcionadoPara
// OU dentro de atribuidosIds/atribuidosEmails, que e o campo que o botao
// "Atribuir Responsavel" preenche quando o ticket tem mais de uma pessoa
// responsavel), agrupado por status. O destinatario dos e-mails e QUEM esta
// configurado (ver getConfig/salvarConfig, editavel em /email.html - pagina
// "Email" do Master) - nao precisa mexer em env var nem redeploy pra trocar.
//
// PARTE B (decidir por e-mail): so pros tickets que nascem em solicitacoes.js
// (compra/manutencao/suporte-ti/pagamento/nota) - Estorno e Ajuste de
// Fechamento aparecem no relatorio mas SEM botao de acao, porque decidir
// esses dois de verdade depende de mais coisa que um simples aprovar/
// recusar (estorno pode chamar a API da Adyen; ajuste de fechamento reaplica
// diffs no lancamento) e nao valeria o risco de fazer isso numa rota publica
// sem login. Cada ticket PENDENTE ganha um token de uso unico (ver
// solicitacoes.gerarTokenAcao) que e RENOVADO a cada envio do relatorio - o
// link de um e-mail de dias atras perde sozinho o poder de decidir (so o
// mais recente decide), mas continua abrindo e mostrando o estado atual do
// card em vez de um erro (ver solicitacoes.buscarEstadoPorToken).
const nodemailer = require('nodemailer');
const dns = require('dns').promises;
const cron = require('node-cron');
const db = require('./firestore');
const centralCards = require('./centralCards');
const solicitacoes = require('./solicitacoes');
const refunds = require('./refunds');
const users = require('./users');
const { createCache } = require('./liveCache');

const FUSO_BR = 'America/Sao_Paulo';
// fallback quando NUNCA foi salva uma config pela pagina Email (primeiro
// boot) OU quando a env var antiga ainda esta configurada - depois da
// primeira gravacao em /email.html, quem manda e sempre o Firestore
const RELATORIO_EMAIL_TO_PADRAO = process.env.RELATORIO_EMAIL_TO || 'mv@grupobravoempresarial.com';
const USUARIO_GATILHO_PADRAO = 'MV';
// sem barra no final, pra concatenar direto nos links (/decidir...)
const APP_BASE_URL = (process.env.APP_BASE_URL || 'https://adyen-monitor.onrender.com').replace(/\/+$/, '');
// unicos tipos com fluxo de decisao por e-mail (ver aviso de escopo acima)
const TIPOS_COM_ACAO_POR_EMAIL = new Set(solicitacoes.TIPOS);
const TIPOS_LABEL = {
  estorno: 'Estorno', 'ajuste-fechamento': 'Ajuste de fechamento',
  compra: 'Compra', manutencao: 'Manutenção', 'suporte-ti': 'Suporte de TI', pagamento: 'Pagamento', nota: 'Nota fiscal',
  'quebra-caixa': 'Quebra de caixa',
};
const STATUS_LABEL = { PENDENTE: 'Pendentes', APROVADO: 'Aprovadas', REJEITADO: 'Recusadas' };
const STATUS_COR = { PENDENTE: '#b8860b', APROVADO: '#1a7f37', REJEITADO: '#c62828' };

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtMoney(v) { return centralCards.fmtMoneyServer(v); }

function dataHojeBR() {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO_BR, day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date());
}
function fmtDataHora(iso) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: FUSO_BR, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(iso));
}

// config editavel em /email.html (pagina "Email" do Master) - QUEM recebe
// os e-mails (emailDestino) e QUAL usuario dispara o envio (usuarioGatilho,
// pelo username). Cache curto (5min) so pra nao bater no Firestore a cada
// card processado; salvarConfig() invalida na hora, entao uma troca feita
// na tela vale no proximo envio, nao precisa esperar o cache vencer.
const CONFIG_DOC = db.collection('relatorioMVConfig').doc('config');
// horario/dias default (usado so ate o Master salvar algo diferente pela
// tela Email) - equivalente ao antigo hardcode '0 8 * * 1-5'. diasSemana usa
// a mesma convencao do campo dow do cron: 0=domingo ... 6=sabado
const HORA_ENVIO_PADRAO = '08:00';
const DIAS_SEMANA_PADRAO = [1, 2, 3, 4, 5]; // seg-sex

const configCache = createCache(async () => {
  const snap = await CONFIG_DOC.get();
  const data = snap.exists ? snap.data() : {};
  const emailDestino = String(data.emailDestino || '').trim() || RELATORIO_EMAIL_TO_PADRAO;
  const emailCopia = String(data.emailCopia || '').trim();
  const usuarioGatilho = String(data.usuarioGatilho || '').trim() || USUARIO_GATILHO_PADRAO;
  const horaEnvio = /^([01]\d|2[0-3]):([0-5]\d)$/.test(data.horaEnvio) ? data.horaEnvio : HORA_ENVIO_PADRAO;
  const diasSemana = Array.isArray(data.diasSemana) && data.diasSemana.length
    ? data.diasSemana.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
    : DIAS_SEMANA_PADRAO;
  const alvo = await users.findByIdentifier(usuarioGatilho);
  // Se o gatilho configurado JA E um e-mail, ele vale como identidade mesmo
  // sem acesso no NoPulso. Quem recebe os tickets nem sempre tem login: o
  // ticket e direcionado pro endereco, e antes disso o relatorio dessa
  // pessoa ficava eternamente zerado porque nao havia usuario pra resolver.
  const emailDoIdentificador = usuarioGatilho.includes('@') ? usuarioGatilho.toLowerCase() : null;
  return {
    emailDestino,
    emailCopia,
    usuarioGatilho,
    horaEnvio,
    diasSemana: diasSemana.length ? diasSemana : DIAS_SEMANA_PADRAO,
    usuarioGatilhoEncontrado: !!alvo,
    gatilhoUserId: alvo ? alvo.id : null,
    gatilhoUserEmail: (alvo && alvo.email ? String(alvo.email).trim().toLowerCase() : null) || emailDoIdentificador,
  };
}, 5 * 60 * 1000);
const getConfig = configCache.cached;

// "HH:MM" - o <input type=time> do email.html ja manda nesse formato
function validarHoraEnvio(valor) {
  const limpo = String(valor || '').trim();
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(limpo)) throw new Error('Informe um horário válido (HH:MM).');
  return limpo;
}

// array de inteiros 0-6 (0=domingo), pelo menos 1 dia marcado
function validarDiasSemana(valor) {
  const lista = Array.isArray(valor) ? valor.map((d) => Number(d)) : [];
  const dias = [...new Set(lista.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  if (!dias.length) throw new Error('Marque pelo menos um dia da semana.');
  return dias;
}

function validarEmail(email) {
  const limpo = String(email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(limpo)) throw new Error('Informe um e-mail válido.');
  return limpo;
}

// campo opcional - vazio = sem copia nenhuma. Aceita mais de um endereco
// separado por virgula (mesmo formato que o header "Cc:" e o nodemailer ja
// esperam), cada um validado igual ao destino principal
function validarEmailCopia(valor) {
  const limpo = String(valor || '').trim();
  if (!limpo) return '';
  return limpo.split(',').map((e) => validarEmail(e)).join(', ');
}

// chamada pela rota POST /api/relatorio-config (Master, ver index.js) -
// exige que o usuario gatilho realmente exista, senao a config salva
// nunca casaria com nenhum ticket
async function salvarConfig({ emailDestino, emailCopia, usuarioGatilho, horaEnvio, diasSemana }) {
  const emailLimpo = validarEmail(emailDestino);
  const copiaLimpa = validarEmailCopia(emailCopia);
  const usuarioLimpo = String(usuarioGatilho || '').trim();
  if (!usuarioLimpo) throw new Error('Informe o usuário que vai disparar os e-mails.');
  const alvo = await users.findByIdentifier(usuarioLimpo);
  // e-mail sem acesso no NoPulso e legitimo (ver getConfig) - o que nao pode
  // passar e um APELIDO que nao resolve, que e sempre erro de digitacao e
  // deixaria o relatorio zerado pra sempre sem ninguem entender por que
  if (!alvo && !usuarioLimpo.includes('@')) throw new Error(`Não encontrei nenhum usuário com "${usuarioLimpo}".`);
  const horaLimpa = validarHoraEnvio(horaEnvio);
  const diasLimpos = validarDiasSemana(diasSemana);
  await CONFIG_DOC.set({
    emailDestino: emailLimpo,
    emailCopia: copiaLimpa,
    usuarioGatilho: alvo.username || usuarioLimpo,
    horaEnvio: horaLimpa,
    diasSemana: diasLimpos,
    atualizadoEm: new Date().toISOString(),
  }, { merge: true });
  configCache.invalidar();
  const configNova = await getConfig();
  agendar(configNova); // aplica o novo horario/dias na hora, sem precisar reiniciar o servidor
  return configNova;
}

// "e do gatilho" usa o MESMO criterio de podeVerCard() em index.js (quem
// enxerga o card na Central), senao o relatorio ficaria mais restrito que a
// propria tela: direcionadoParaEmail/Id (campo de 1 pessoa so, preenchido na
// criacao ou pelo botao "Direcionar para") OU dentro de atribuidosIds/
// atribuidosEmails (array, preenchido pelo botao "Atribuir Responsavel" -
// pode ter mais de uma pessoa, e o usuario configurado pode nao ser o
// primeiro da lista). O e-mail gravado no card e so um retrato de quando foi
// direcionado, entao compara pelo e-mail ATUAL do usuario (gatilhoUserEmail)
// - um card antigo com e-mail diferente do atual do usuario tambem conta
function ehDoMV(card, config) {
  if (!card || !config) return false;
  const emailAtual = config.gatilhoUserEmail;
  const idAtual = config.gatilhoUserId;
  if (emailAtual && String(card.direcionadoParaEmail || '').trim().toLowerCase() === emailAtual) return true;
  if (idAtual && card.direcionadoParaId === idAtual) return true;
  if (idAtual && Array.isArray(card.atribuidosIds) && card.atribuidosIds.includes(idAtual)) return true;
  if (emailAtual && Array.isArray(card.atribuidosEmails) && card.atribuidosEmails.some((e) => String(e || '').trim().toLowerCase() === emailAtual)) return true;
  return false;
}

// modulo que sabe gerar o link publico (ticket-publico.html) pra cada tipo -
// mesmo mapeamento do moduloTicket() em index.js. Ajuste de fechamento e
// Quebra de caixa ficam de fora (esse mecanismo nao existe pra eles ainda)
function moduloLinkAcao(tipo) {
  if (tipo === 'estorno') return refunds;
  if (TIPOS_COM_ACAO_POR_EMAIL.has(tipo)) return solicitacoes;
  return null;
}

// prepara UM card pro e-mail: token de decisao de uso unico (so PENDENTE,
// so tipos com fluxo de decisao por e-mail - ver aviso de escopo no topo do
// arquivo) e o link publico de "ver ticket completo" (ticket-publico.html,
// mesmo mecanismo do botao "Enviar link" na Central - fica valido ate o
// ticket chegar num estado terminal, por isso PENDENTE e APROVADO ganham
// link e REJEITADO/FINALIZADO normalmente nao). Usado nos 3 fluxos de envio
// (relatorio diario, aviso instantaneo, envio manual) pra nao duplicar essa
// logica em cada um
async function prepararCardParaEmail(card) {
  const copia = { ...card, tokenAcao: null };
  if (card.status === 'PENDENTE' && TIPOS_COM_ACAO_POR_EMAIL.has(card.tipo)) {
    const { tokenAcao } = await solicitacoes.gerarTokenAcao(card.id);
    copia.tokenAcao = tokenAcao;
  }
  const modulo = moduloLinkAcao(card.tipo);
  if (modulo) {
    try {
      const { linkAcao } = await modulo.gerarLinkAcao(card.id);
      copia.linkAcaoUrl = `${APP_BASE_URL}/ticket-publico.html?tipo=${encodeURIComponent(card.tipo)}&ticket=${encodeURIComponent(card.id)}&link=${encodeURIComponent(linkAcao)}`;
    } catch (e) { /* ticket em estado terminal - sem link possivel, card fica sem o "ver completo" mesmo */ }
  }
  return copia;
}

// junta os cards das 3 filas direcionados ao MV, agrupados por status
async function montarDados() {
  const [todos, config] = await Promise.all([centralCards.listarTodos(), getConfig()]);
  // CONVERTIDO = o ticket virou outro tipo/colecao (ver solicitacoes.js) -
  // quem continua a historia e o registro novo, esse aqui fica de fora
  const doMV = todos.filter((c) => ehDoMV(c, config) && c.status !== 'CONVERTIDO');

  const preparados = [];
  for (const c of doMV) preparados.push(await prepararCardParaEmail(c));

  const grupos = { PENDENTE: [], APROVADO: [], REJEITADO: [] };
  preparados.forEach((c) => { (grupos[c.status] || (grupos[c.status] = [])).push(c); });
  Object.values(grupos).forEach((lista) => lista.sort((a, b) => (b.criadoEm || '').localeCompare(a.criadoEm || '')));
  return { grupos, total: preparados.length };
}

function linkDecisao(card, acao) {
  const params = new URLSearchParams({ ticket: card.id, tipo: card.tipo, acao, token: card.tokenAcao || '' });
  return `${APP_BASE_URL}/decidir.html?${params.toString()}`;
}

function htmlBotoesAcao(card) {
  if (card.status !== 'PENDENTE' || !card.tokenAcao) return '';
  const btn = (texto, cor, acao) =>
    `<a href="${linkDecisao(card, acao)}" style="display:inline-block;padding:8px 18px;margin:8px 8px 0 0;border-radius:6px;background:${cor};color:#fff;text-decoration:none;font-family:Arial,sans-serif;font-size:13px;font-weight:bold;">${texto}</a>`;
  return `<div>${btn('✓ Aprovar', '#1a7f37', 'aprovar')}${btn('✗ Recusar', '#c62828', 'recusar')}</div>`;
}

// link pro card completo (anexos, chat, historico - ver ticket-publico.html)
// so aparece quando prepararCardParaEmail conseguiu gerar (card.linkAcaoUrl)
function htmlLinkCompleto(card) {
  if (!card.linkAcaoUrl) return '';
  return `<div style="margin-top:10px;"><a href="${card.linkAcaoUrl}" style="color:#1a56db;font-size:12.5px;text-decoration:none;">🔗 Ver ticket completo</a></div>`;
}

// pill colorida do status no topo de cada card
const STATUS_LABEL_SINGULAR = { PENDENTE: 'Pendente', APROVADO: 'Aprovada', REJEITADO: 'Recusada' };
function htmlPillStatus(status) {
  const cor = STATUS_COR[status];
  if (!cor) return '';
  return `<span style="display:inline-block;background:${cor};color:#fff;border-radius:20px;padding:2px 10px;font-size:11px;font-weight:bold;vertical-align:middle;">${STATUS_LABEL_SINGULAR[status] || status}</span>`;
}

// lista de itens de uma Compra (descricao + qtd) num bloco proprio, em vez
// de perdida no meio do texto
function htmlItens(card) {
  if (!Array.isArray(card.itens) || !card.itens.length) return '';
  return `
    <div style="margin-top:10px;background:#f6f8fa;border:1px solid #e6e9ee;border-radius:8px;padding:10px 14px;">
      <div style="font-size:10.5px;color:#8a93a2;text-transform:uppercase;letter-spacing:.6px;margin-bottom:5px;">Itens do pedido</div>
      ${card.itens.map((i) => `<div style="font-size:13px;color:#2c3340;padding:2px 0;">• ${escapeHtml(i.descricao)}${i.quantidade != null && i.quantidade !== '' ? ` <span style="color:#8a93a2;">· qtd. ${escapeHtml(String(i.quantidade))}</span>` : ''}</div>`).join('')}
    </div>`;
}

function htmlCard(card) {
  const linhas = [
    `<div style="margin-bottom:4px;">
      <span style="display:inline-block;background:#eef1f5;color:#5b6470;border-radius:5px;padding:2px 8px;font-size:11.5px;font-family:monospace;vertical-align:middle;">#${card.numeroTicket ?? '—'}</span>
      <span style="display:inline-block;background:#e8f0fe;color:#1a56db;border-radius:5px;padding:2px 8px;font-size:11.5px;font-weight:bold;vertical-align:middle;">${escapeHtml(TIPOS_LABEL[card.tipo] || card.tipo)}</span>
      ${htmlPillStatus(card.status)}
    </div>`,
    `<div style="font-size:15px;font-weight:bold;color:#1c212b;">${escapeHtml(card.titulo || '')}</div>`,
    `<div style="color:#8a93a2;font-size:12px;margin-top:3px;">${escapeHtml(card.unidadeNome || card.unidade || '—')} · ${fmtDataHora(card.criadoEm)}</div>`,
  ];
  if (card.valorEstimado != null && card.valorEstimado > 0) linhas.push(`<div style="font-size:13px;color:#2c3340;margin-top:6px;">Valor estimado: <b>${fmtMoney(card.valorEstimado)}</b></div>`);
  if (card.fornecedor) linhas.push(`<div style="font-size:13px;color:#2c3340;margin-top:4px;">Fornecedor: <b>${escapeHtml(card.fornecedor)}</b></div>`);
  linhas.push(htmlItens(card));
  if (card.observacao) linhas.push(`<div style="font-size:12.5px;color:#5b6470;margin-top:8px;white-space:pre-wrap;border-left:3px solid #e6e9ee;padding-left:10px;">${escapeHtml(card.observacao)}</div>`);
  if (card.motivoDecisao) linhas.push(`<div style="font-size:12px;color:#8a93a2;margin-top:6px;">Motivo da decisão: ${escapeHtml(card.motivoDecisao)}</div>`);
  return `<div style="border:1px solid #e6e9ee;border-radius:10px;padding:14px 16px;margin-top:12px;background:#fff;">${linhas.join('')}${htmlBotoesAcao(card)}${htmlLinkCompleto(card)}</div>`;
}

function htmlSecao(status, lista) {
  if (!lista.length) return '';
  return `
    <div style="margin-top:22px;">
      <div style="font-family:Arial,sans-serif;font-size:14px;font-weight:bold;color:${STATUS_COR[status]};border-bottom:2px solid ${STATUS_COR[status]};padding-bottom:6px;">
        ${STATUS_LABEL[status]} (${lista.length})
      </div>
      <div style="font-family:Arial,sans-serif;">${lista.map(htmlCard).join('')}</div>
    </div>`;
}

function montarHtml({ grupos, total }) {
  const resumo = Object.entries(STATUS_LABEL)
    .map(([status, label]) => `<div style="display:inline-block;margin-right:22px;"><div style="font-size:11px;color:#888;text-transform:uppercase;">${label}</div><div style="font-size:20px;font-weight:bold;color:${STATUS_COR[status]};">${grupos[status].length}</div></div>`)
    .join('');
  return `
  <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;">
    <div style="background:#1a56db;color:#fff;padding:18px 22px;border-radius:8px 8px 0 0;">
      <div style="font-size:17px;font-weight:bold;">Relatório de Solicitações · MV</div>
      <div style="font-size:12.5px;opacity:.85;margin-top:2px;">${dataHojeBR()} · ${total} solicitaç${total === 1 ? 'ão' : 'ões'} no total</div>
    </div>
    <div style="border:1px solid #e5e5e5;border-top:none;padding:18px 22px;border-radius:0 0 8px 8px;">
      <div>${resumo}</div>
      ${!total ? '<div style="color:#888;margin-top:18px;">Nenhuma solicitação direcionada ao MV no momento.</div>' : ''}
      ${htmlSecao('PENDENTE', grupos.PENDENTE)}
      ${htmlSecao('APROVADO', grupos.APROVADO)}
      ${htmlSecao('REJEITADO', grupos.REJEITADO)}
    </div>
    <div style="font-family:Arial,sans-serif;font-size:11px;color:#999;text-align:center;margin-top:14px;">
      NoPulso · gerado automaticamente
    </div>
  </div>`;
}

function montarHtmlCardUnico(card, titulo) {
  return `
  <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;">
    <div style="background:#1a56db;color:#fff;padding:18px 22px;border-radius:8px 8px 0 0;">
      <div style="font-size:17px;font-weight:bold;">${escapeHtml(titulo)}</div>
      <div style="font-size:12.5px;opacity:.85;margin-top:2px;">${fmtDataHora(card.criadoEm)}</div>
    </div>
    <div style="border:1px solid #e5e5e5;border-top:none;padding:18px 22px;border-radius:0 0 8px 8px;">
      ${htmlCard(card)}
    </div>
    <div style="font-family:Arial,sans-serif;font-size:11px;color:#999;text-align:center;margin-top:14px;">
      NoPulso · gerado automaticamente
    </div>
  </div>`;
}

// html de N cards (1 ou varios) - usado no envio manual sob demanda (botao
// "enviar por e-mail" no detalhe de um card, ou selecionar varios na lista),
// diferente de notificarCardMV/enviarRelatorio que sao fluxos automaticos
// pro MV
function montarHtmlCards(cards, titulo) {
  return `
  <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;">
    <div style="background:#1a56db;color:#fff;padding:18px 22px;border-radius:10px 10px 0 0;">
      <div style="font-size:17px;font-weight:bold;">${escapeHtml(titulo)}</div>
      <div style="font-size:12.5px;opacity:.85;margin-top:2px;">${dataHojeBR()} · ${cards.length} ticket${cards.length === 1 ? '' : 's'}</div>
    </div>
    <div style="border:1px solid #e6e9ee;border-top:none;padding:8px 18px 18px;border-radius:0 0 10px 10px;background:#f9fafb;">
      ${cards.map(htmlCard).join('')}
    </div>
    <div style="font-family:Arial,sans-serif;font-size:11px;color:#999;text-align:center;margin-top:14px;">
      NoPulso · enviado manualmente
    </div>
  </div>`;
}

// envio manual (Master/Admin escolhe o destinatario na hora) de 1 ou mais
// cards - ver rota POST /api/central/enviar-email em index.js. Tickets
// PENDENTES de tipo com fluxo de decisao por e-mail vao COM os botoes
// Aprovar/Recusar (mesmo token de uso unico do relatorio do MV) - quem envia
// e Master/Admin e escolhe o destinatario de proposito, entao o link de
// decisao e parte do que se espera do envio (pedido do usuario; antes ia
// sem botao nenhum e o destinatario nao tinha como decidir)
async function enviarCardsPorEmail(cards, destinatario) {
  if (!destinatario) throw new Error('Informe o e-mail de destino.');
  if (!cards || !cards.length) throw new Error('Nenhum ticket selecionado.');
  const cardsParaEnvio = [];
  for (const c of cards) cardsParaEnvio.push(await prepararCardParaEmail(c));
  const titulo = cards.length === 1
    ? `Ticket #${cards[0].numeroTicket ?? '—'} · ${cards[0].titulo || ''}`
    : `${cards.length} tickets · NoPulso`;
  await enviarComFallback({
    from: `NoPulso <${process.env.RELATORIO_EMAIL_USER}>`,
    to: destinatario,
    subject: titulo,
    html: montarHtmlCards(cardsParaEnvio, titulo),
  });
}

// e-mail IMEDIATO de UM card assim que ele e direcionado ao MV (na criacao
// ou num redirecionamento depois) - diferente do relatorio diario
// (enviarRelatorio), que manda o resumo de todos de uma vez no horario
// configurado. As duas coisas convivem: o card chega na hora aqui, e
// aparece de novo (se ainda estiver pendente) no resumo do dia seguinte.
// Quem chama decide o que fazer com erro - normalmente so loga, nunca
// derruba a acao que criou/redirecionou o card (ver index.js)
async function notificarCardMV(card) {
  const config = await getConfig();
  if (!ehDoMV(card, config)) return;
  const to = config.emailDestino;

  const cardParaEnviar = await prepararCardParaEmail(card);

  const titulo = `Nova solicitação · MV`;
  await enviarComFallback({
    from: `NoPulso <${process.env.RELATORIO_EMAIL_USER}>`,
    to,
    subject: `${titulo} - #${cardParaEnviar.numeroTicket ?? '—'} - ${cardParaEnviar.titulo || ''}`,
    html: montarHtmlCardUnico(cardParaEnviar, titulo),
  });
}

// o resolvedor de host do nodemailer (lib/shared/index.js) busca IPv4 E
// IPv6 de smtp.gmail.com e sorteia um endereco qualquer dos dois pra
// conectar - nao tem nenhuma opcao (nem "family") pra forcar so IPv4. Em
// ambientes sem rota de saida IPv6 (Render incluso), cair num endereco
// IPv6 da ECONNREFUSED/ENETUNREACH na hora, mesmo com usuario/senha certos.
// Pra contornar, resolvemos o IPv4 nos mesmos com dns.resolve4 e passamos
// o IP literal como host - "servername" garante que a validacao do
// certificado TLS (SNI) continua batendo com smtp.gmail.com normalmente.
//
// ---------- caminho preferido: API HTTPS do Gmail (porta 443) ----------
// Em producao (Render) o SMTP de saida esta bloqueado por completo: timeout
// de conexao na 465 E na 587, em todos os IPs do Gmail - nada a ver com a
// conta/senha. A API REST do Gmail (gmail.googleapis.com, HTTPS/443) passa
// sempre, e a mesma porta que o app ja usa pro Firestore. Requer um refresh
// token OAuth2 da conta remetente (escopo gmail.send) nas envs:
//   GMAIL_OAUTH_CLIENT_ID / GMAIL_OAUTH_CLIENT_SECRET / GMAIL_OAUTH_REFRESH_TOKEN
// (passo a passo no .env.example). Quando as 3 estao presentes, todo envio
// vai por aqui; sem elas, cai no caminho SMTP antigo (util em ambiente que
// nao bloqueia SMTP).
function gmailApiConfigurada() {
  return !!(process.env.GMAIL_OAUTH_CLIENT_ID && process.env.GMAIL_OAUTH_CLIENT_SECRET && process.env.GMAIL_OAUTH_REFRESH_TOKEN);
}

let tokenGmailCache = null; // { accessToken, expiraEm (ms epoch) }
async function accessTokenGmail(forcarNovo) {
  if (!forcarNovo && tokenGmailCache && Date.now() < tokenGmailCache.expiraEm) return tokenGmailCache.accessToken;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GMAIL_OAUTH_CLIENT_ID,
      client_secret: process.env.GMAIL_OAUTH_CLIENT_SECRET,
      refresh_token: process.env.GMAIL_OAUTH_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`Falha ao renovar o token OAuth do Gmail (${body.error || res.status}): ${body.error_description || 'confira GMAIL_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN'}`);
  }
  // renova 60s antes de expirar pra nunca mandar um token no limite
  tokenGmailCache = { accessToken: body.access_token, expiraEm: Date.now() + Math.max((body.expires_in || 3600) - 60, 60) * 1000 };
  return tokenGmailCache.accessToken;
}

// Subject pode ter acento (Relatório, solicitação...) - RFC 2047 obriga
// codificar header nao-ASCII
function encodeHeaderUtf8(texto) {
  return /^[\x20-\x7e]*$/.test(texto) ? texto : `=?UTF-8?B?${Buffer.from(texto, 'utf8').toString('base64')}?=`;
}

async function enviarViaGmailApi({ from, to, cc, subject, html }) {
  const mime = [
    `From: ${from}`,
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    `Subject: ${encodeHeaderUtf8(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(html, 'utf8').toString('base64'),
  ].join('\r\n');
  const raw = Buffer.from(mime, 'utf8').toString('base64url');

  const mandar = async (token) => fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });

  let res = await mandar(await accessTokenGmail());
  if (res.status === 401) res = await mandar(await accessTokenGmail(true)); // token velho em cache - renova e tenta 1x
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Gmail API recusou o envio (${res.status}): ${body.error?.message || 'erro desconhecido'}`);
  }
}

// ---------- caminho SMTP (so quando a API nao esta configurada) ----------
// Um endereco IPv4 especifico do Gmail pode ficar temporariamente
// inalcancavel (blackhole de rede, throttling) sem que a conta tenha nada
// de errado - por isso NAO cacheamos o transportador/IP escolhido: um
// primeiro pick ruim ficava memorizado pra sempre (so um restart do
// processo resolvia), travando literalmente TODO envio de e-mail dali em
// diante. Em vez disso, tenta cada endereco resolvido, em ordem aleatoria,
// e so desiste se TODOS falharem.
//
// Alem do IP, a PORTA tambem pode ser o problema: em producao (Render) a
// conexao na 465 (TLS direto) chegou a dar timeout em todos os IPs - rede
// da plataforma dropando/estrangulando a porta, nada a ver com a conta.
// Por isso cada IP e tentado nas duas portas oficiais do Gmail: 465 (TLS
// direto) e 587 (STARTTLS, a porta padrao de submissao, que as politicas
// de rede costumam tratar melhor). Cada tentativa que falha e logada com
// ip:porta pra ficar obvio nos logs do Render o que esta acontecendo.
async function enviarComFallback(opcoesEmail) {
  if (gmailApiConfigurada()) return enviarViaGmailApi(opcoesEmail);
  const user = process.env.RELATORIO_EMAIL_USER;
  // senha de app do Google e exibida em grupos de 4 ("xxxx xxxx xxxx xxxx")
  // mas a senha real sao os 16 caracteres sem espaco - tira qualquer espaco
  // que tenha vindo colado na env var, funciona dos dois jeitos
  const pass = (process.env.RELATORIO_EMAIL_PASS || '').replace(/\s+/g, '');
  if (!user || !pass) throw new Error('RELATORIO_EMAIL_USER/RELATORIO_EMAIL_PASS não configurados.');
  const enderecos = await dns.resolve4('smtp.gmail.com');
  for (let i = enderecos.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [enderecos[i], enderecos[j]] = [enderecos[j], enderecos[i]];
  }
  // no maximo 2 IPs x 2 portas = 4 tentativas, com timeouts curtos, pra
  // nunca segurar a requisicao alem de ~35s mesmo no pior caso
  const tentativas = [];
  for (const ip of enderecos.slice(0, 2)) {
    tentativas.push({ ip, port: 465, secure: true });
    tentativas.push({ ip, port: 587, secure: false });
  }
  let ultimoErro;
  for (const t of tentativas) {
    const transporter = nodemailer.createTransport({
      host: t.ip,
      servername: 'smtp.gmail.com',
      port: t.port,
      secure: t.secure,
      requireTLS: !t.secure, // na 587 o STARTTLS e obrigatorio, nunca manda credencial em claro
      auth: { user, pass },
      connectionTimeout: 8000,
      greetingTimeout: 8000,
      socketTimeout: 15000,
    });
    try {
      await transporter.sendMail(opcoesEmail);
      return;
    } catch (err) {
      console.error(`[email] falha em ${t.ip}:${t.port} (${t.secure ? 'TLS' : 'STARTTLS'}): ${err.message}`);
      ultimoErro = err;
    }
  }
  throw new Error(`Falha ao conectar no Gmail em todas as portas/IPs (último erro: ${ultimoErro.message}). Veja os logs do servidor.`);
}

// origem: 'agendado' (cron) | 'manual' (botao Reenviar agora)
// paraOverride: manda pra OUTRO endereco sem mexer na config - serve pro
// Master conferir na propria caixa antes de mandar pro destinatario real
async function enviarRelatorio({ origem = 'agendado', porEmail = null, paraOverride = null } = {}) {
  const [config, dados] = await Promise.all([getConfig(), montarDados()]);
  const to = paraOverride || config.emailDestino;
  // a copia so vale no envio normal: um reenvio de conferencia pra outro
  // endereco nao deve encher a caixa de quem esta em copia
  const cc = paraOverride ? undefined : (config.emailCopia || undefined);
  const resumo = {
    total: dados.total,
    pendentes: dados.grupos.PENDENTE.length,
    aprovados: dados.grupos.APROVADO.length,
    rejeitados: dados.grupos.REJEITADO.length,
  };
  try {
    await enviarComFallback({
      from: `NoPulso <${process.env.RELATORIO_EMAIL_USER}>`,
      to,
      cc,
      subject: `Relatório de Solicitações - MV - ${dataHojeBR()}`,
      html: montarHtml(dados),
    });
  } catch (err) {
    // registra a FALHA tambem: sem isso, um envio que estourou no SMTP era
    // indistinguivel de um envio que nunca foi tentado - e o Master so
    // descobria quando alguem reclamava que nao recebeu
    await registrarEnvio({ ...resumo, para: to, copia: cc || null, origem, porEmail, ok: false, erro: err.message });
    throw err;
  }
  await registrarEnvio({ ...resumo, para: to, copia: cc || null, origem, porEmail, ok: true, erro: null });
  return resumo;
}

// ---------------------------------------------------------------
// HISTORICO DE ENVIOS
// ---------------------------------------------------------------
// Antes nao havia registro nenhum: nao dava pra saber se o relatorio das 8h
// saiu, pra quem foi, com quantos tickets - nem se falhou. Foi exatamente
// isso que deixou passar dias de relatorio vazio sem ninguem perceber. Agora
// todo envio (agendado ou manual, sucesso ou erro) deixa rastro, e o
// historico e a resposta pra "ja mandei hoje?" antes de reenviar.
const ENVIOS = db.collection('relatorioMVEnvios');

async function registrarEnvio(dados) {
  try {
    const ref = ENVIOS.doc();
    await ref.set({ id: ref.id, em: new Date().toISOString(), ...dados });
  } catch (err) {
    // registro e diagnostico, nao a entrega: falhar aqui nao pode derrubar
    // (nem "desfazer") um e-mail que ja saiu
    console.error('Não foi possível registrar o envio do relatório MV:', err.message);
  }
}

// os N mais recentes, do mais novo pro mais antigo. Sem paginacao de
// proposito: o que responde "ja mandei hoje? deu certo?" sao os ultimos
// envios, nao o arquivo historico inteiro.
async function listarEnvios(limite = 20) {
  const snap = await ENVIOS.orderBy('em', 'desc').limit(Math.min(Number(limite) || 20, 100)).get();
  return snap.docs.map((d) => d.data());
}

// mesma montagem do relatorio (montarDados+montarHtml) mas SEM mandar e-mail -
// usado pelo botao "Pre-visualizar agora" em /email.html pra conferir o
// conteudo na hora, sem precisar mandar de verdade e ir checar a caixa de
// entrada. Continua gerando tokenAcao/linkAcao de verdade pros cards (mesmo
// efeito colateral que o envio real ja tem), entao o preview mostra links que
// realmente funcionam se clicados
async function previewHtml() {
  const dados = await montarDados();
  return {
    html: montarHtml(dados),
    total: dados.total,
    pendentes: dados.grupos.PENDENTE.length,
    aprovados: dados.grupos.APROVADO.length,
    rejeitados: dados.grupos.REJEITADO.length,
    // vai SEMPRE junto: relatorio vazio e um resultado legitimo (ninguem
    // direcionou nada hoje) e tambem o sintoma de config errada. Sem o
    // diagnostico do lado, os dois casos sao a mesma tela de zeros.
    diagnostico: await diagnostico(),
  };
}

// ---------------------------------------------------------------
// POR QUE O RELATORIO VEIO VAZIO
// ---------------------------------------------------------------
// O filtro do relatorio (ehDoMV) depende de duas pontas casarem: o usuario
// GATILHO configurado em /email.html precisa existir, e os tickets precisam
// estar direcionados/atribuidos a ELE. Qualquer uma das duas falhando da o
// mesmo resultado na tela - zero - e nada dizia qual das duas foi.
//
// Esta funcao abre a caixa preta: quantos tickets existem, quantos casaram
// por cada criterio, quantos nao tem direcionamento nenhum e - o que mais
// resolve na pratica - PRA QUEM os tickets estao indo, quando nao e pro
// gatilho. E a diferenca entre "esta certo, nao ha nada hoje" e "a config
// aponta pra uma pessoa e os tickets vao pra outra".
async function diagnostico() {
  const [todos, config] = await Promise.all([centralCards.listarTodos(), getConfig()]);
  const ativos = todos.filter((c) => c.status !== 'CONVERTIDO');

  const emailAtual = config.gatilhoUserEmail;
  const idAtual = config.gatilhoUserId;
  const criterios = { direcionadoEmail: 0, direcionadoId: 0, atribuidoId: 0, atribuidoEmail: 0 };
  const norm = (e) => String(e || '').trim().toLowerCase();

  let semDirecionamento = 0;
  const outrosDestinos = new Map();

  ativos.forEach((c) => {
    if (emailAtual && norm(c.direcionadoParaEmail) === emailAtual) criterios.direcionadoEmail += 1;
    if (idAtual && c.direcionadoParaId === idAtual) criterios.direcionadoId += 1;
    if (idAtual && Array.isArray(c.atribuidosIds) && c.atribuidosIds.includes(idAtual)) criterios.atribuidoId += 1;
    if (emailAtual && Array.isArray(c.atribuidosEmails) && c.atribuidosEmails.some((e) => norm(e) === emailAtual)) criterios.atribuidoEmail += 1;

    const destinos = [c.direcionadoParaEmail, ...(c.atribuidosEmails || [])].map(norm).filter(Boolean);
    // ticket sem direcionamento nenhum nunca entra no relatorio de ninguem -
    // e a causa mais comum de "tenho ticket e o relatorio veio zerado"
    if (!destinos.length && !c.direcionadoParaId && !(c.atribuidosIds || []).length) {
      semDirecionamento += 1;
      return;
    }
    if (ehDoMV(c, config)) return;
    destinos.forEach((d) => outrosDestinos.set(d, (outrosDestinos.get(d) || 0) + 1));
  });

  return {
    usuarioGatilho: config.usuarioGatilho,
    usuarioGatilhoEncontrado: config.usuarioGatilhoEncontrado,
    gatilhoUserEmail: emailAtual,
    totalCards: todos.length,
    convertidos: todos.length - ativos.length,
    ativos: ativos.length,
    doGatilho: ativos.filter((c) => ehDoMV(c, config)).length,
    criterios,
    semDirecionamento,
    // top 8 destinos concorrentes: o suficiente pra ver o padrão sem virar
    // um despejo de e-mails no meio de uma tela de configuração
    outrosDestinos: [...outrosDestinos.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([email, qtd]) => ({ email, qtd })),
  };
}

// agenda o envio diario (cron.schedule ja roda em cima do timezone
// informado, sem precisar converter hora local -> UTC na mao). Horario e
// dias da semana agora vem do Firestore (editaveis em /email.html, sem
// redeploy) em vez de fixos no codigo/env var - guarda a tarefa atual pra
// poder parar e recriar toda vez que a config mudar (ver salvarConfig)
let tarefaAtual = null;
function agendar(config) {
  if (tarefaAtual) { tarefaAtual.stop(); tarefaAtual = null; }
  const [hora, minuto] = config.horaEnvio.split(':');
  const cronExpressao = `${Number(minuto)} ${Number(hora)} * * ${config.diasSemana.join(',')}`;
  if (!cron.validate(cronExpressao)) {
    console.error(`Agendamento do relatório diário MV inválido ("${cronExpressao}") - desativado até a próxima config válida.`);
    return;
  }
  tarefaAtual = cron.schedule(cronExpressao, () => {
    enviarRelatorio({ origem: 'agendado' }).catch((err) => console.error('Erro ao enviar relatório diário MV:', err.message));
  }, { timezone: FUSO_BR });
}

async function iniciarAgendamento() {
  agendar(await getConfig());
}

module.exports = { enviarRelatorio, previewHtml, diagnostico, listarEnvios, iniciarAgendamento, montarDados, montarHtml, notificarCardMV, enviarCardsPorEmail, enviarComFallback, validarHoraEnvio, validarDiasSemana, validarEmail, validarEmailCopia, getConfig, salvarConfig, TIPOS_COM_ACAO_POR_EMAIL };
