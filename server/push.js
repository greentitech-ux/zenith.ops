// push.js
// Notificacoes push (navegador/celular) para eventos criticos: estorno,
// estorno agendado, chargeback e fraude suspeita.
const webpush = require('web-push');
const db = require('./firestore');
const { ehCargoGerente } = require('./users');

const COLLECTION = db.collection('push_subscriptions');

function subDocId(endpoint) {
  return Buffer.from(endpoint).toString('base64').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 400);
}

const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';

if (PUBLIC_KEY && PRIVATE_KEY) {
  webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);
}

// cache em memoria das inscricoes: notificacao e evento frequente (pedido,
// solicitacao, mensagem de chat...) e cada envio relia a colecao INTEIRA do
// Firestore. Com o cache, a releitura acontece no maximo 1x/min - inscricao
// nova/removida invalida na hora, entao ninguem fica de fora por causa dele.
const SUBS_TTL_MS = 60 * 1000;
let SUBS_CACHE = null;
let SUBS_CACHE_EM = 0;
async function loadSubs() {
  if (SUBS_CACHE && Date.now() - SUBS_CACHE_EM < SUBS_TTL_MS) return SUBS_CACHE;
  const snap = await COLLECTION.get();
  SUBS_CACHE = snap.docs.map((d) => d.data());
  SUBS_CACHE_EM = Date.now();
  return SUBS_CACHE;
}
function invalidarSubs() { SUBS_CACHE = null; }

// meta = { userId, isMaster, unidades, sections } - null em unidades/sections
// significa Master (sem restricao). Sem meta (inscricoes antigas, de antes
// dessa checagem existir) e tratado como sem permissao nenhuma, nao como
// acesso total - mais seguro pedir pra re-inscrever do que vazar alerta.
async function addSubscription(sub, meta) {
  await COLLECTION.doc(subDocId(sub.endpoint)).set({ ...sub, meta: meta || null }, { merge: true });
  invalidarSubs();
}

function podeReceber(sub, { unidade, section }) {
  const meta = sub.meta;
  if (!meta) return false; // inscricao antiga sem dono conhecido - nao arrisca
  if (meta.isMaster) return true;
  if (section && !(meta.sections || []).includes(section)) return false;
  if (unidade && !(meta.unidades || []).includes(unidade)) return false;
  return true;
}

// Master/Admin, independente de secao/unidade (mesma checagem que o Painel
// ja usa pra decidir quem ve o toast+som de solicitacao nova - ver
// mostrarNotificacaoSolicitacao em painel.html)
function podeReceberSolicitacao(sub) {
  const meta = sub.meta;
  return !!meta && (meta.isMaster || meta.isAdmin);
}

// alerta critico do Beniboy (bot nao conseguiu resolver e chamou um
// atendente): vai pro Master e pra quem tem a secao/tag "suporte" - nunca
// pro Admin sem essa tag - e um alarme sonoro que segue tocando ate a
// pessoa silenciar (ver alerta-beniboy.html), entao so faz sentido pra
// quem de fato precisa ser acordado por isso. Cobre TODOS os acessos
// logados dessa pessoa (cada dispositivo tem sua propria inscricao push),
// principalmente celular com o app fechado.
function podeReceberCritico(sub) {
  const meta = sub.meta;
  if (!meta) return false;
  if (meta.isMaster) return true;
  return (meta.sections || []).includes('suporte');
}

async function removeSubscription(endpoint) {
  await COLLECTION.doc(subDocId(endpoint)).delete();
  invalidarSubs();
}

// eventos que merecem notificacao push (estorno, estorno agendado,
// chargeback, fraude suspeita)
function isAlertable(tx) {
  if (tx.fraudeSuspeita) return true;
  const alertStatuses = [
    'ESTORNADO',
    'FALHA_ESTORNO',
    'ESTORNO_AGENDADO',
    'CHARGEBACK',
    'CHARGEBACK_REVERTIDO',
    'NOTIFICATION_OF_CHARGEBACK',
  ];
  return alertStatuses.includes(tx.status);
}

function titleFor(tx) {
  if (tx.fraudeSuspeita) return `Fraude suspeita — ${tx.unidade || ''}`;
  const labels = {
    ESTORNADO: 'Estorno realizado',
    FALHA_ESTORNO: 'Falha no estorno',
    ESTORNO_AGENDADO: 'Estorno agendado',
    CHARGEBACK: 'Chargeback',
    CHARGEBACK_REVERTIDO: 'Chargeback revertido',
    NOTIFICATION_OF_CHARGEBACK: 'Aviso de chargeback',
  };
  return `${labels[tx.status] || tx.status} — ${tx.unidade || ''}`;
}

async function sendToAll(data, { unidade, section } = {}) {
  if (!PUBLIC_KEY || !PRIVATE_KEY) return;
  const payload = JSON.stringify(data);
  const subs = await loadSubs();
  for (const sub of subs) {
    if (!podeReceber(sub, { unidade, section })) continue;
    try {
      await webpush.sendNotification(sub, payload);
    } catch (err) {
      // inscricao expirada/invalida - remove
      if (err.statusCode === 404 || err.statusCode === 410) {
        await removeSubscription(sub.endpoint);
      } else {
        console.error('Erro ao enviar push:', err.message);
      }
    }
  }
}

async function notify(tx) {
  if (!isAlertable(tx)) return;
  await sendToAll({
    title: titleFor(tx),
    body: `${tx.nomeCliente || tx.cardHolder || 'Cliente'} · R$ ${(tx.valor || 0).toFixed(2)}${tx.motivo ? ' · ' + tx.motivo : ''}`,
    tag: tx.pspReference,
    url: '/monitor.html',
  }, { unidade: tx.unidade, section: 'monitor' });
}

// alerta generico (ex: teste de cartao clonado) - nao depende de uma
// transacao especifica normalizada
async function notifyRaw(title, body, tag, unidade) {
  await sendToAll({ title, body, tag, url: '/monitor.html' }, { unidade, section: 'monitor' });
}

// solicitacao nova na Central (estorno, ajuste de fechamento, pagamento,
// suporte de TI etc.) - vai so pra Master/Admin, que sao quem decide essas
// filas (mesmo publico do toast+som ja existente no Painel)
async function notifySolicitacao(title, body, tag, url) {
  if (!PUBLIC_KEY || !PRIVATE_KEY) return;
  const payload = JSON.stringify({ title, body, tag, url: url || '/central-historico.html' });
  const subs = await loadSubs();
  for (const sub of subs) {
    if (!podeReceberSolicitacao(sub)) continue;
    try {
      await webpush.sendNotification(sub, payload);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await removeSubscription(sub.endpoint);
      } else {
        console.error('Erro ao enviar push (solicitação):', err.message);
      }
    }
  }
}

// pedidos/envios do Abastecimento do Carrinho: notifica SO quem opera a
// ponta (secao informada) - Master/Admin ficam de fora de proposito, o
// alarme e assunto do balcao, nao da gestao
async function notifyAbastecimento(title, body, tag, secao) {
  if (!PUBLIC_KEY || !PRIVATE_KEY) return;
  const payload = JSON.stringify({ title, body, tag, url: '/abastecimento.html' });
  const subs = await loadSubs();
  for (const sub of subs) {
    const meta = sub.meta;
    if (!meta || meta.isMaster || meta.isAdmin) continue;
    if (!(meta.sections || []).includes(secao)) continue;
    try {
      await webpush.sendNotification(sub, payload);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await removeSubscription(sub.endpoint);
      } else {
        console.error('Erro ao enviar push (abastecimento):', err.message);
      }
    }
  }
}

// Beniboy nao conseguiu resolver sozinho e chamou um atendente: alarme
// sonoro alto pro Master + tag Suporte (ver podeReceberCritico), que continua
// tocando ate silenciar na propria notificacao (alerta-beniboy.html), pra
// nao passar batido mesmo com o celular em outro app
async function notifyBeniboyEscalonamento(chat, motivo) {
  if (!PUBLIC_KEY || !PRIVATE_KEY) return;
  const chatId = chat && chat.id;
  if (!chatId) return;
  const params = new URLSearchParams({ chat: chatId, nome: (chat && chat.nome) || '', motivo: motivo || '' });
  const payload = JSON.stringify({
    title: '🚨 Beniboy precisa de você',
    body: `${(chat && chat.nome) || 'Visitante'}${motivo ? ' · ' + motivo : ''}`.slice(0, 150),
    tag: 'beniboy-' + chatId,
    critical: true,
    url: '/alerta-beniboy.html?' + params.toString(),
  });
  const subs = await loadSubs();
  for (const sub of subs) {
    if (!podeReceberCritico(sub)) continue;
    try {
      await webpush.sendNotification(sub, payload, { urgency: 'high' });
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await removeSubscription(sub.endpoint);
      } else {
        console.error('Erro ao enviar push (alerta Beniboy):', err.message);
      }
    }
  }
}

// alerta pra UMA pessoa especifica (userId), independente de secao/unidade -
// usado pelo "vigia de pedido" do Beniboy (pedidoWatch.js): quando o status
// de um pedido muda depois que o bot ja respondeu, so quem perguntou recebe
// o aviso, mesmo com o Zenith fechado (SSE cobre com o app aberto - ver
// broadcastParaUsuario em index.js; isso aqui cobre com o app fechado)
async function notifyUsuario(userId, title, body, tag, url) {
  if (!PUBLIC_KEY || !PRIVATE_KEY || !userId) return;
  const payload = JSON.stringify({ title, body, tag, url: url || '/' });
  const subs = await loadSubs();
  for (const sub of subs) {
    if (!sub.meta || sub.meta.userId !== userId) continue;
    try {
      await webpush.sendNotification(sub, payload);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await removeSubscription(sub.endpoint);
      } else {
        console.error('Erro ao enviar push (usuário):', err.message);
      }
    }
  }
}

// PCD cortesia do parque bateu o limite de 2 criancas por hora-relogio (ver
// criar() em parque.js): aviso SILENCIOSO, sem som/alarme especial - so pro
// Master e pra Gerente DA UNIDADE onde aconteceu (precisa do campo `cargo`
// no meta da inscricao - ver POST /api/push/subscribe em index.js)
function podeReceberPcdCortesia(sub, unidade) {
  const meta = sub.meta;
  if (!meta) return false;
  if (meta.isMaster) return true;
  return ehCargoGerente(meta.cargo) && (meta.unidades || []).includes(unidade);
}
async function notifyParquePcdCortesiaLimite({ unidade, unidadeNome, horaBucket, dataUtilizacao }) {
  if (!PUBLIC_KEY || !PRIVATE_KEY) return;
  const payload = JSON.stringify({
    title: 'PCD cortesia · limite do horário atingido',
    body: `${unidadeNome || unidade} · ${horaBucket}:00–${horaBucket}:59 · já foram usadas as 2 vagas de cortesia PCD.`,
    tag: `parque-pcd-cortesia-${unidade}-${dataUtilizacao}-${horaBucket}`,
    url: '/parque-checkin.html',
  });
  const subs = await loadSubs();
  for (const sub of subs) {
    if (!podeReceberPcdCortesia(sub, unidade)) continue;
    try {
      await webpush.sendNotification(sub, payload);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await removeSubscription(sub.endpoint);
      } else {
        console.error('Erro ao enviar push (PCD cortesia):', err.message);
      }
    }
  }
}

// RH: gerente/ass.gerente DA UNIDADE (mesmo criterio de podeReceberPcdCortesia)
// OU qualquer um com a secao 'rh' - candidatos podem ter sido cadastrados
// pelo proprio time de RH (cross-unidade, ver podeAcessarUnidadeRh em
// index.js), entao o alerta do 5o dia tem que chegar neles tambem, nao so
// no gerente da loja
function podeReceberAlertaRh(sub, unidade) {
  if (podeReceberPcdCortesia(sub, unidade)) return true;
  const meta = sub.meta;
  return !!meta && (meta.sections || []).includes('rh');
}

// RH: funcionario em teste completou os dias limite (ver
// rh.DIAS_TESTE_ALERTA) sem decisao - aviso pro Master, Gerente/Ass.Gerente
// DA UNIDADE e pro time de RH (ver podeReceberAlertaRh)
async function notifyRhTesteVencido(funcionario) {
  if (!PUBLIC_KEY || !PRIVATE_KEY) return;
  const payload = JSON.stringify({
    title: '🧑‍💼 RH · decisão de teste pendente',
    body: `${funcionario.nome} (${funcionario.unidade}) completou o período de teste - defina se segue.`,
    tag: `rh-teste-${funcionario.id}`,
    url: '/rh.html',
  });
  const subs = await loadSubs();
  for (const sub of subs) {
    if (!podeReceberAlertaRh(sub, funcionario.unidade)) continue;
    try {
      await webpush.sendNotification(sub, payload);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await removeSubscription(sub.endpoint);
      } else {
        console.error('Erro ao enviar push (RH teste vencido):', err.message);
      }
    }
  }
}

// aprovacoes do RH (check-in de extra alem do limite semanal, candidato com
// teste vencido, advertencia pendente/prazo vencido) - so pro time de RH de
// verdade (tag "RH todas as unidades"), Admin e Master. NAO vai pro gerente
// comum da loja - ele e justamente quem gerou a pendencia, aprovar teria
// que ser de outra pessoa
function podeReceberAprovacaoRh(sub) {
  const meta = sub.meta;
  if (!meta) return false;
  return !!meta.isMaster || !!meta.isAdmin || !!meta.podeRhTodasUnidades;
}
async function notifyAprovacaoRh(title, body, tag) {
  if (!PUBLIC_KEY || !PRIVATE_KEY) return;
  const payload = JSON.stringify({ title, body, tag, url: '/rh.html' });
  const subs = await loadSubs();
  for (const sub of subs) {
    if (!podeReceberAprovacaoRh(sub)) continue;
    try {
      await webpush.sendNotification(sub, payload);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await removeSubscription(sub.endpoint);
      } else {
        console.error('Erro ao enviar push (aprovação RH):', err.message);
      }
    }
  }
}

const MOTIVO_PENDENCIA_LABEL = {
  limite_semanal_extra: 'já bateu o limite de 3 check-ins na semana',
  teste_vencido_sem_decisao: 'teste de 5 dias vencido, sem decisão',
};

// extra alem do limite semanal OU candidato com teste vencido tentou fazer
// check-in - fica pendente ate alguem aprovar (ver rhCheckin.js)
async function notifyRhAprovacaoPendente(funcionarioNome, unidade, motivoPendencia) {
  await notifyAprovacaoRh(
    '🧑‍💼 RH · check-in aguardando aprovação',
    `${funcionarioNome} (${unidade}) - ${MOTIVO_PENDENCIA_LABEL[motivoPendencia] || 'precisa de aprovação'}.`,
    `rh-checkin-pendente-${funcionarioNome}-${unidade}-${Date.now()}`,
  );
}

// pedido de advertencia novo - precisa de aprovacao do RH/Admin/Master antes
// de seguir (ver rhAdvertencias.js)
async function notifyRhAdvertenciaPendente(advertencia) {
  await notifyAprovacaoRh(
    '📋 RH · solicitação de advertência',
    `${advertencia.funcionarioNome} (${advertencia.unidade}) - aguardando aprovação.`,
    `rh-advertencia-pendente-${advertencia.id}`,
  );
}

// advertencia aprovada e passou das 48h sem o RH anexar o documento pro
// colaborador assinar (ver rodarAlertaAdvertenciaVencida em index.js)
async function notifyRhAdvertenciaPrazoVencido(advertencia) {
  await notifyAprovacaoRh(
    '⏰ RH · advertência com prazo vencido',
    `${advertencia.funcionarioNome} (${advertencia.unidade}) - passou das 48h sem anexar o documento.`,
    `rh-advertencia-prazo-${advertencia.id}`,
  );
}

// experiencia formal (CLT, 30+60 dias) perto do prazo - avisos "quietos"
// (D-5/D-3/D-2) vao so pro time de RH de verdade (tag "RH todas as
// unidades")/Admin/Master, igual as outras aprovacoes do RH; NAO pro
// gerente da loja, pra nao gerar alarme falso cedo demais
async function notifyExperienciaPrazo(funcionario, diasRestantes) {
  const etapaLabel = funcionario.experiencia && funcionario.experiencia.etapa === '60' ? '60 dias (total 90)' : '30 dias';
  const prazoTexto = diasRestantes <= 0 ? 'vence HOJE' : `vence em ${diasRestantes} dia${diasRestantes === 1 ? '' : 's'}`;
  await notifyAprovacaoRh(
    `🗓️ RH · experiência (${etapaLabel}) ${prazoTexto}`,
    `${funcionario.nome} (${funcionario.unidade}) - registre a decisão antes do prazo.`,
    `rh-experiencia-${funcionario.id}-${diasRestantes}`,
  );
}

// so no ultimo alerta antes do prazo (D-1) o gerente/ass.gerente DA UNIDADE
// tambem e avisado, alem do RH/Admin/Master (ja cobertos por
// notifyExperienciaPrazo) - pedido explicito do usuario
function podeReceberAlertaExperienciaGerente(sub, unidade) {
  const meta = sub.meta;
  return !!meta && ehCargoGerente(meta.cargo) && (meta.unidades || []).includes(unidade);
}
async function notifyExperienciaPrazoGerente(funcionario) {
  if (!PUBLIC_KEY || !PRIVATE_KEY) return;
  const etapaLabel = funcionario.experiencia && funcionario.experiencia.etapa === '60' ? '60 dias (total 90)' : '30 dias';
  const payload = JSON.stringify({
    title: `🗓️ Experiência vence HOJE`,
    body: `${funcionario.nome} - prazo da etapa de ${etapaLabel} vence hoje. Registre a decisão.`,
    tag: `rh-experiencia-gerente-${funcionario.id}`,
    url: '/rh.html',
  });
  const subs = await loadSubs();
  for (const sub of subs) {
    if (!podeReceberAlertaExperienciaGerente(sub, funcionario.unidade)) continue;
    try {
      await webpush.sendNotification(sub, payload);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await removeSubscription(sub.endpoint);
      } else {
        console.error('Erro ao enviar push (experiência - gerente):', err.message);
      }
    }
  }
}

module.exports = {
  addSubscription, removeSubscription, notify, notifyRaw, notifySolicitacao, notifyAbastecimento,
  notifyBeniboyEscalonamento, notifyUsuario, notifyParquePcdCortesiaLimite, notifyRhTesteVencido,
  notifyRhAprovacaoPendente, notifyRhAdvertenciaPendente, notifyRhAdvertenciaPrazoVencido,
  notifyExperienciaPrazo, notifyExperienciaPrazoGerente, PUBLIC_KEY,
};
