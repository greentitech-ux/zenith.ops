// push.js
// Notificacoes push (navegador/celular) para eventos criticos: estorno,
// estorno agendado, chargeback e fraude suspeita.
const webpush = require('web-push');
const db = require('./firestore');
const { ehCargoGerente } = require('./users');
const alertasCentral = require('./alertasCentral');

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

// o navegador as vezes troca a inscricao sozinho (endpoint antigo invalidado
// pelo SO/push service) - mais comum depois de MUITO tempo sem interacao,
// exatamente o cenario "preciso que os alertas aconteçam mesmo com o app
// sem interacao por um tempo". Isso dispara o evento pushsubscriptionchange
// DENTRO do service worker (ver sw.js), sem nenhuma aba aberta - e sem
// acesso ao token de login guardado no localStorage da pagina, entao nao da
// pra chamar a rota autenticada de sempre (POST /api/push/subscribe). Em vez
// disso, so migra o META (permissoes) da inscricao antiga pra nova, usando o
// proprio endpoint antigo como prova de posse (so quem ja tinha a inscricao
// valida sabe esse endpoint) - nao concede nada novo, so preserva o que ja
// existia, pra o alerta nao morrer em silencio
async function migrarSubscricao(oldEndpoint, novaSubscricao) {
  if (!oldEndpoint || !novaSubscricao || !novaSubscricao.endpoint) return;
  const antigaRef = COLLECTION.doc(subDocId(oldEndpoint));
  const antigaSnap = await antigaRef.get();
  const meta = antigaSnap.exists ? antigaSnap.data().meta : null;
  await COLLECTION.doc(subDocId(novaSubscricao.endpoint)).set({ ...novaSubscricao, meta: meta || null }, { merge: true });
  if (antigaSnap.exists && oldEndpoint !== novaSubscricao.endpoint) await antigaRef.delete();
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

// so Master DE VERDADE (nao QA Master) - e quem decide a fila de aprovacao
// (ver qaAprovacoes.js/interceptarQaMaster em index.js). Admin fica de fora:
// so o Master aprova/rejeita essas acoes sensiveis.
function podeReceberAprovacaoQa(sub) {
  const meta = sub.meta;
  return !!meta && meta.isMaster && !meta.isQaMaster;
}

// avisa os Masters de verdade que um acesso QA Master tentou uma acao
// sensivel (exclusao/configuracao global) e ela esta parada esperando
// aprovacao (ver EXECUTORES_QA em index.js)
async function notifyQaAprovacaoPendente(resumo, criadoPorEmail) {
  const dados = {
    title: '🧪 QA Master pediu autorização',
    body: `${criadoPorEmail || ''} · ${resumo || ''}`,
    tag: 'qa-aprovacao',
    critical: true,
    url: '/usuarios.html',
  };
  await alertasCentral.registrar({ tipo: 'qa-aprovacao', titulo: dados.title, resumo: dados.body, url: dados.url, critico: true });
  if (!PUBLIC_KEY || !PRIVATE_KEY) return;
  const payload = JSON.stringify(dados);
  const subs = await loadSubs();
  for (const sub of subs) {
    if (!podeReceberAprovacaoQa(sub)) continue;
    try {
      await webpush.sendNotification(sub, payload);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await removeSubscription(sub.endpoint);
      } else {
        console.error('Erro ao enviar push (aprovação QA):', err.message);
      }
    }
  }
}

// alerta critico do Beniboy (bot nao conseguiu resolver e chamou um
// atendente): vai pro Master e pra quem tem a secao/tag "suporte" - nunca
// pro Admin sem essa tag - e um alarme sonoro que segue tocando ate a
// pessoa silenciar (ver alerta-beniboy.html), entao so faz sentido pra
// quem de fato precisa ser acordado por isso. Cobre TODOS os acessos
// logados dessa pessoa (cada dispositivo tem sua propria inscricao push),
// principalmente celular com o app fechado.
// alerta de seguranca do chat de suporte (texto tipo comando/script, ou
// arquivo perigoso bloqueado no upload - ver segurancaChat.js) - SO
// Master, mais restrito que o alarme geral do Beniboy acima (que tambem
// vai pra tag "suporte"): e um incidente de seguranca, nao uma fila de
// atendimento, e a decisao (ex: bloquear IP no provedor) e do Master
function podeReceberAlertaSeguranca(sub) {
  return !!(sub.meta && sub.meta.isMaster);
}

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
  const title = titleFor(tx);
  const body = `${tx.nomeCliente || tx.cardHolder || 'Cliente'} · R$ ${(tx.valor || 0).toFixed(2)}${tx.motivo ? ' · ' + tx.motivo : ''}`;
  // fraude suspeita toca o alarme cheio (mesmo criterio de urgencia dos
  // outros "critico") - estorno/chargeback comum fica so no push normal,
  // senao toda operação de rotina (varias por dia) viraria sirene
  const critico = !!tx.fraudeSuspeita;
  await alertasCentral.registrar({ tipo: critico ? 'fraude' : 'monitor', titulo: title, resumo: body, url: '/monitor.html', critico });
  await sendToAll({ title, body, tag: tx.pspReference, critical: critico, url: '/monitor.html' }, { unidade: tx.unidade, section: 'monitor' });
}

// alerta generico (ex: teste de cartao clonado) - nao depende de uma
// transacao especifica normalizada
async function notifyRaw(title, body, tag, unidade) {
  await alertasCentral.registrar({ tipo: 'monitor', titulo: title, resumo: body, url: '/monitor.html' });
  await sendToAll({ title, body, tag, url: '/monitor.html' }, { unidade, section: 'monitor' });
}

// solicitacao nova na Central (estorno, ajuste de fechamento, pagamento,
// suporte de TI etc.) - vai so pra Master/Admin, que sao quem decide essas
// filas (mesmo publico do toast+som ja existente no Painel)
async function notifySolicitacao(title, body, tag, url) {
  const destino = url || '/central-historico.html';
  await alertasCentral.registrar({ tipo: 'solicitacao', titulo: title, resumo: body, url: destino });
  if (!PUBLIC_KEY || !PRIVATE_KEY) return;
  const payload = JSON.stringify({ title, body, tag, url: destino });
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
// nao passar batido mesmo com o celular em outro app.
//
// opts.lojaOffline (calculado em index.js via lojaContextoEstaOffline, cruzando
// chat.lojaContexto com o NOC Zenith): quando a loja de onde a conversa veio
// esta sem internet/computador desligado, a conversa trava por causa disso,
// nao porque o bot "nao conseguiu resolver" - nesse caso troca o alarme
// critico (sirene + tela cheia pedindo pra "atender") por um push normal
// explicando a causa real, e manda pro NOC Zenith em vez da tela de
// atendimento (nao ha nada pra "atender" ali - o problema e' conectividade)
async function notifyBeniboyEscalonamento(chat, motivo, opts) {
  const chatId = chat && chat.id;
  if (!chatId) return;
  const lojaOffline = !!(opts && opts.lojaOffline);
  // chat vai junto na URL do alarme (alerta-beniboy.html) e o "Atender agora"
  // de lá manda pra /beniboy.html?chat=<id>, que abre essa conversa
  // especifica direto (ver abrirDetalhePorId em beniboy.html) - em vez de
  // so cair no kanban geral e a pessoa ter que procurar qual conversa era
  const params = new URLSearchParams({ chat: chatId, nome: (chat && chat.nome) || '', motivo: motivo || '' });
  const dados = lojaOffline ? {
    title: '🔴 Loja sem conexão · conversa travada',
    body: `${(chat && chat.lojaContexto) || 'A loja'} está sem internet/computador desligado - a conversa com ${(chat && chat.nome) || 'o visitante'} parou por causa disso, não porque o Beniboy não resolveu.`.slice(0, 150),
    tag: 'beniboy-' + chatId,
    url: '/loja-status.html',
  } : {
    title: '🚨 Beniboy precisa de você',
    icone: '/beniboy-192.png',
    body: `${(chat && chat.nome) || 'Visitante'}${motivo ? ' · ' + motivo : ''}`.slice(0, 150),
    tag: 'beniboy-' + chatId,
    critical: true,
    url: '/alerta-beniboy.html?' + params.toString(),
  };
  await alertasCentral.registrar({ tipo: lojaOffline ? 'noc-loja-offline-conversa' : 'beniboy', titulo: dados.title, resumo: dados.body, url: dados.url, critico: !lojaOffline });
  if (!PUBLIC_KEY || !PRIVATE_KEY) return;
  const payload = JSON.stringify(dados);
  const subs = await loadSubs();
  for (const sub of subs) {
    if (!podeReceberCritico(sub)) continue;
    try {
      await webpush.sendNotification(sub, payload, { urgency: lojaOffline ? 'normal' : 'high' });
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await removeSubscription(sub.endpoint);
      } else {
        console.error('Erro ao enviar push (alerta Beniboy):', err.message);
      }
    }
  }
}

// alerta de seguranca do chat de suporte: texto tipo comando/script, ou
// arquivo perigoso bloqueado no upload (ver segurancaChat.js/index.js) - SO
// Master (podeReceberAlertaSeguranca acima). Reusa a mesma pagina de alarme
// do Beniboy (alerta-beniboy.html), com tipo=seguranca na URL pra ela trocar
// o texto/destino - nao e o Beniboy pedindo ajuda, e uma tentativa de
// invasao, e a decisao (ex: bloquear IP no provedor) e humana, do Master
async function notifySegurancaChat(chat, detalhe) {
  const chatId = chat && chat.id;
  if (!chatId) return;
  const params = new URLSearchParams({ tipo: 'seguranca', chat: chatId, nome: (chat && chat.nome) || '', motivo: detalhe || '' });
  const dados = {
    title: '🛡️ Alerta de segurança — chat de suporte',
    body: `${(chat && chat.nome) || 'Visitante'}${detalhe ? ' · ' + detalhe : ''}`.slice(0, 150),
    tag: 'seguranca-' + chatId + '-' + Date.now(),
    critical: true,
    url: '/alerta-beniboy.html?' + params.toString(),
  };
  await alertasCentral.registrar({ tipo: 'seguranca', titulo: dados.title, resumo: dados.body, url: dados.url, critico: true });
  if (!PUBLIC_KEY || !PRIVATE_KEY) return;
  const payload = JSON.stringify(dados);
  const subs = await loadSubs();
  for (const sub of subs) {
    if (!podeReceberAlertaSeguranca(sub)) continue;
    try {
      await webpush.sendNotification(sub, payload, { urgency: 'high' });
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await removeSubscription(sub.endpoint);
      } else {
        console.error('Erro ao enviar push (alerta segurança):', err.message);
      }
    }
  }
}

// alerta pra UMA pessoa especifica (userId), independente de secao/unidade -
// usado pelo "vigia de pedido" do Beniboy (pedidoWatch.js): quando o status
// de um pedido muda depois que o bot ja respondeu, so quem perguntou recebe
// o aviso, mesmo com o NoPulso fechado (SSE cobre com o app aberto - ver
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

// Saida NEGATIVA apurada no fechamento de um turno do carrinho: sobrou mais
// do que entrou - contagem errada ou envio nao lancado (ver
// verificarDivergenciaAbastecimento em index.js). Antes isso so aparecia pra
// quem abrisse Relatorios do Carrinho; agora vira push na hora pro
// Master/Admin (mesmo publico do toast de solicitacao) e fica registrado na
// Central de Alertas.
async function notifyAbastecimentoDivergencia(rotuloTurno, resumo, turnoAte) {
  const dados = {
    title: '⚠ Divergência no carrinho',
    body: `Turno ${rotuloTurno}: saída negativa em ${resumo}`,
    tag: 'abastecimento-divergencia',
    critical: true,
    // com o "ate" do ciclo, o clique abre direto na explicacao daquele
    // turno (ver /api/abastecimento/turno/:ate em index.js) em vez de cair
    // na tela geral - sem ele (chamada antiga/defensiva), cai na tela geral
    url: turnoAte ? `/abastecimento-relatorios.html?turno=${encodeURIComponent(turnoAte)}` : '/abastecimento-relatorios.html',
  };
  await alertasCentral.registrar({ tipo: 'abastecimento-divergencia', titulo: dados.title, resumo: dados.body, url: dados.url, critico: true });
  if (!PUBLIC_KEY || !PRIVATE_KEY) return;
  const payload = JSON.stringify(dados);
  const subs = await loadSubs();
  for (const sub of subs) {
    if (!podeReceberSolicitacao(sub)) continue;
    try {
      await webpush.sendNotification(sub, payload, { urgency: 'high' });
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await removeSubscription(sub.endpoint);
      } else {
        console.error('Erro ao enviar push (divergência abastecimento):', err.message);
      }
    }
  }
}

// Teste de ponta a ponta pedido pelo proprio usuario (rota POST
// /api/push/testar): dispara uma notificacao real pra TODOS os aparelhos
// dele e devolve o que aconteceu com cada envio. Existe porque "nao chega
// alerta no celular" era indiagnosticavel: a inscricao pode ter morrido no
// push service (410, removida aqui), nunca ter chegado ao servidor, ou ser
// antiga sem meta (que nao recebe nada de proposito) - e nenhum desses
// casos dava sinal de vida pro usuario.
async function testarPush(userId) {
  if (!PUBLIC_KEY || !PRIVATE_KEY) return { configurado: false, dispositivos: 0, enviados: 0, expiradasRemovidas: 0 };
  const subs = await loadSubs();
  const minhas = subs.filter((s) => s.meta && s.meta.userId === userId);
  const payload = JSON.stringify({
    title: '🔔 Teste de notificação',
    body: 'Se você está vendo isso, os alertas estão chegando neste aparelho.',
    tag: 'teste-push',
    url: '/painel.html',
  });
  let enviados = 0;
  let expiradasRemovidas = 0;
  const erros = [];
  for (const sub of minhas) {
    try {
      await webpush.sendNotification(sub, payload, { urgency: 'high' });
      enviados += 1;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await removeSubscription(sub.endpoint);
        expiradasRemovidas += 1;
      } else {
        erros.push(err.message);
      }
    }
  }
  return { configurado: true, dispositivos: minhas.length, enviados, expiradasRemovidas, erros };
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
// Termo impresso e a venda nunca fechou. Vai pro Master e pro Gerente da
// unidade (mesmo publico do alerta de PCD-cortesia) - e dinheiro que pode
// ter entrado sem ser lancado, entao nao pode depender de alguem lembrar
// de abrir o painel.
async function notifyParqueTermoPendente({ unidade, unidadeNome, responsavelNome, valorPrevisto, horas, emitidoPorEmail, id }) {
  const valor = Number(valorPrevisto) || 0;
  const dados = {
    title: '🧾 Termo emitido sem venda',
    body: `${unidadeNome || unidade} · ${responsavelNome || 'sem nome'} · aberto há ${horas}h`
      + `${valor ? ` · previsto R$ ${valor.toFixed(2)}` : ''} · emitido por ${emitidoPorEmail || '—'}`,
    // tag com o id da emissao: cada atendimento avisa uma vez so, e um
    // aviso novo nao substitui o anterior na bandeja
    tag: `parque-termo-pendente-${id}`,
    url: '/parque.html',
  };
  await alertasCentral.registrar({ tipo: 'parque-termo', titulo: dados.title, resumo: dados.body, url: dados.url });
  if (!PUBLIC_KEY || !PRIVATE_KEY) return;
  const payload = JSON.stringify(dados);
  const subs = await loadSubs();
  for (const sub of subs) {
    if (!podeReceberPcdCortesia(sub, unidade)) continue; // Master + Gerente da unidade
    try {
      await webpush.sendNotification(sub, payload);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) await removeSubscription(sub.endpoint);
      else console.error('Erro no push de termo pendente:', err.message);
    }
  }
}

async function notifyParquePcdCortesiaLimite({ unidade, unidadeNome, horaBucket, dataUtilizacao }) {
  const dados = {
    title: 'PCD cortesia · limite do horário atingido',
    body: `${unidadeNome || unidade} · ${horaBucket}:00–${horaBucket}:59 · já foram usadas as 2 vagas de cortesia PCD.`,
    tag: `parque-pcd-cortesia-${unidade}-${dataUtilizacao}-${horaBucket}`,
    url: '/parque-checkin.html',
  };
  await alertasCentral.registrar({ tipo: 'parque-pcd', titulo: dados.title, resumo: dados.body, url: dados.url });
  if (!PUBLIC_KEY || !PRIVATE_KEY) return;
  const payload = JSON.stringify(dados);
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
  const dados = {
    title: '🧑‍💼 RH · decisão de teste pendente',
    body: `${funcionario.nome} (${funcionario.unidade}) completou o período de teste - defina se segue.`,
    tag: `rh-teste-${funcionario.id}`,
    critical: true,
    url: '/rh.html',
  };
  await alertasCentral.registrar({ tipo: 'rh-teste-vencido', titulo: dados.title, resumo: dados.body, url: dados.url, critico: true });
  if (!PUBLIC_KEY || !PRIVATE_KEY) return;
  const payload = JSON.stringify(dados);
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
async function notifyAprovacaoRh(title, body, tag, tipo, critico) {
  const dados = { title, body, tag, url: '/rh.html', critical: !!critico };
  await alertasCentral.registrar({ tipo: tipo || 'rh', titulo: title, resumo: body, url: '/rh.html', critico: !!critico });
  if (!PUBLIC_KEY || !PRIVATE_KEY) return;
  const payload = JSON.stringify(dados);
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
// RH: alguém está com o ponto aberto há mais tempo que a jornada esperada
// (ver LIMITE_CHECKOUT_HORAS em rhCheckin.js) e não bateu o check-out. Mesmo
// público do alerta de teste: Master, Gerente/Ass.Gerente DA UNIDADE e o
// time de RH. Não é crítico: ninguém está em risco, é cobrança de registro -
// marcar como crítico aqui gastaria a atenção que os alertas críticos têm.
async function notifyRhCheckoutAtrasado(checkin, horas) {
  const h = Math.floor(horas);
  const dados = {
    title: '⏰ RH · check-out não registrado',
    body: `${checkin.funcionarioNome} (${checkin.unidade}) está com o ponto aberto há ${h}h - precisa bater o check-out.`,
    tag: `rh-checkout-${checkin.id}`,
    critical: false,
    url: '/rh.html',
  };
  await alertasCentral.registrar({ tipo: 'rh-checkout-atrasado', titulo: dados.title, resumo: dados.body, url: dados.url, critico: false });
  if (!PUBLIC_KEY || !PRIVATE_KEY) return;
  const payload = JSON.stringify(dados);
  const subs = await loadSubs();
  for (const sub of subs) {
    if (!podeReceberAlertaRh(sub, checkin.unidade)) continue;
    try {
      await webpush.sendNotification(sub, payload);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await removeSubscription(sub.endpoint);
      }
    }
  }
}

async function notifyRhAprovacaoPendente(funcionarioNome, unidade, motivoPendencia) {
  await notifyAprovacaoRh(
    '🧑‍💼 RH · check-in aguardando aprovação',
    `${funcionarioNome} (${unidade}) - ${MOTIVO_PENDENCIA_LABEL[motivoPendencia] || 'precisa de aprovação'}.`,
    `rh-checkin-pendente-${funcionarioNome}-${unidade}-${Date.now()}`,
    'rh-checkin-pendente', true,
  );
}

// pedido de advertencia novo - precisa de aprovacao do RH/Admin/Master antes
// de seguir (ver rhAdvertencias.js)
async function notifyRhAdvertenciaPendente(advertencia) {
  await notifyAprovacaoRh(
    '📋 RH · solicitação de advertência',
    `${advertencia.funcionarioNome} (${advertencia.unidade}) - aguardando aprovação.`,
    `rh-advertencia-pendente-${advertencia.id}`,
    'rh-advertencia-pendente', true,
  );
}

// cadastro novo (feito pela unidade ou pelo link publico) precisa de
// aprovacao do RH/Admin/Master antes de virar ativo/candidato (ver rh.js
// criar()/aprovarCadastro/reprovarCadastro)
async function notifyRhCadastroPendente(funcionarioNome, unidade) {
  await notifyAprovacaoRh(
    '🧑‍💼 RH · cadastro aguardando aprovação',
    `${funcionarioNome} (${unidade}) - novo cadastro aguardando aprovação.`,
    `rh-cadastro-pendente-${funcionarioNome}-${unidade}-${Date.now()}`,
    'rh-cadastro-pendente', true,
  );
}

// cadastro reprovado - fica Inativo, RH/Admin/Master sao avisados
async function notifyRhCadastroReprovado(funcionarioNome, unidade, motivo) {
  await notifyAprovacaoRh(
    '❌ RH · cadastro reprovado',
    `${funcionarioNome} (${unidade}) foi reprovado${motivo ? ` - ${motivo}` : ''}.`,
    `rh-cadastro-reprovado-${funcionarioNome}-${unidade}-${Date.now()}`,
    'rh-cadastro-reprovado', false,
  );
}

// advertencia aprovada e passou das 48h sem o RH anexar o documento pro
// colaborador assinar (ver rodarAlertaAdvertenciaVencida em index.js)
async function notifyRhAdvertenciaPrazoVencido(advertencia) {
  await notifyAprovacaoRh(
    '⏰ RH · advertência com prazo vencido',
    `${advertencia.funcionarioNome} (${advertencia.unidade}) - passou das 48h sem anexar o documento.`,
    `rh-advertencia-prazo-${advertencia.id}`,
    'rh-advertencia-prazo', true,
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
    'rh-experiencia-prazo', diasRestantes <= 1,
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
  const etapaLabel = funcionario.experiencia && funcionario.experiencia.etapa === '60' ? '60 dias (total 90)' : '30 dias';
  const dados = {
    title: `🗓️ Experiência vence HOJE`,
    body: `${funcionario.nome} - prazo da etapa de ${etapaLabel} vence hoje. Registre a decisão.`,
    tag: `rh-experiencia-gerente-${funcionario.id}`,
    url: '/rh.html',
  };
  await alertasCentral.registrar({ tipo: 'rh-experiencia-gerente', titulo: dados.title, resumo: dados.body, url: dados.url });
  if (!PUBLIC_KEY || !PRIVATE_KEY) return;
  const payload = JSON.stringify(dados);
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

// um computador da loja parou de mandar heartbeat (ver
// rodarVarreduraLojaStatus em index.js) - mesmo publico do alerta critico do
// Beniboy (Master + tag Suporte), ja que e quem cuida de infra/conectividade
// das lojas; alarme "alto" (critical), no espirito de alerta de RMM (Atera
// etc) que o usuario pediu. tag inclui o posto (nao so a unidade) porque
// agora uma loja pode ter varios computadores caindo/voltando de forma
// independente - com tag so por unidade, o segundo aviso substituiria o
// primeiro em vez de aparecer como notificacao separada
// HD de um computador piorou (SMART reprovando, setor realocado, disco
// enchendo - ver nocMaquina.js). Mesmo publico do alerta de loja offline
// (Master + Suporte), mas NAO e critico: e um aviso pra AGENDAR a troca,
// com semanas de antecedencia. Marcar como critico aqui faria o alarme alto
// tocar de madrugada por um disco que vai durar mais um mes.
async function notifyDiscoAlerta(unidadeNome, codigo, computadorNome, posto, nivel, motivos) {
  const prefixo = computadorNome ? `${computadorNome} · ` : '';
  const lista = (motivos || []).slice(0, 3).join(' · ') || 'verifique o disco';
  const dados = {
    title: nivel === 'critico' ? '💽 HD em estado crítico' : '💽 HD pedindo atenção',
    body: `${prefixo}${unidadeNome || codigo}: ${lista}`,
    tag: `noc-disco-${codigo}-${posto || 'principal'}`,
    url: '/loja-status.html',
  };
  await alertasCentral.registrar({ tipo: 'noc-disco', titulo: dados.title, resumo: dados.body, url: dados.url, critico: false });
  if (!PUBLIC_KEY || !PRIVATE_KEY) return;
  const payload = JSON.stringify(dados);
  const subs = await loadSubs();
  for (const sub of subs) {
    if (!podeReceberCritico(sub)) continue;
    try {
      await webpush.sendNotification(sub, payload);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await removeSubscription(sub.endpoint);
      } else {
        console.error('Erro ao enviar push (alerta de disco):', err.message);
      }
    }
  }
}

// máquina passou de mais uma semana sem reiniciar. Mesmo público e mesmo
// espírito do alerta de disco: não é crítico, é lembrete de manutenção -
// alguém precisa reiniciar aquele computador quando a loja fechar.
// máquina reiniciou/desligou (pedido do Master). Separa os dois casos que
// importam pra quem opera: reinício NORMAL (alguém reiniciou, manutenção,
// update do Windows) e reinício INESPERADO (o Windows registrou queda
// anormal - falta de luz, travamento, botão segurado). O segundo é o que
// merece alguém ir olhar a loja.
async function notifyMaquinaReiniciou(unidadeNome, codigo, computadorNome, posto, inesperado) {
  const prefixo = computadorNome ? `${computadorNome} · ` : '';
  const dados = {
    title: inesperado ? '⚡ Desligamento inesperado' : '🔄 Computador reiniciou',
    body: inesperado
      ? `${prefixo}${unidadeNome || codigo}: voltou depois de um desligamento anormal (queda de energia ou travamento).`
      : `${prefixo}${unidadeNome || codigo}: reiniciou e voltou ao ar.`,
    tag: `noc-reiniciou-${codigo}-${posto || 'principal'}`,
    url: '/loja-status.html',
  };
  await alertasCentral.registrar({ tipo: 'noc-reiniciou', titulo: dados.title, resumo: dados.body, url: dados.url, critico: !!inesperado });
  if (!PUBLIC_KEY || !PRIVATE_KEY) return;
  const payload = JSON.stringify(dados);
  const subs = await loadSubs();
  for (const sub of subs) {
    if (!podeReceberCritico(sub)) continue;
    try {
      await webpush.sendNotification(sub, payload);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) await removeSubscription(sub.endpoint);
      else console.error('Erro ao enviar push (máquina reiniciou):', err.message);
    }
  }
}

// caiu a Ethernet, mas a máquina continua no ar (pelo Wi-Fi). Não é queda -
// é DEGRADAÇÃO, e sem esse aviso ninguém descobria até a loja reclamar de
// lentidão, porque o painel continuava verde.
async function notifyLinkDegradado(unidadeNome, codigo, computadorNome, posto, linkTipo, ethernetCaida) {
  const prefixo = computadorNome ? `${computadorNome} · ` : '';
  const dados = {
    title: ethernetCaida ? '🔌 Ethernet caiu' : '📶 Caiu para o Wi-Fi',
    body: ethernetCaida
      ? `${prefixo}${unidadeNome || codigo}: a placa de rede está sem link (cabo solto, switch ou porta). Segue no ar por ${linkTipo === 'wifi' ? 'Wi-Fi' : 'outro caminho'}.`
      : `${prefixo}${unidadeNome || codigo}: saiu do cabo e está no Wi-Fi.`,
    tag: `noc-link-${codigo}-${posto || 'principal'}`,
    url: '/loja-status.html',
  };
  await alertasCentral.registrar({ tipo: 'noc-link', titulo: dados.title, resumo: dados.body, url: dados.url, critico: false });
  if (!PUBLIC_KEY || !PRIVATE_KEY) return;
  const payload = JSON.stringify(dados);
  const subs = await loadSubs();
  for (const sub of subs) {
    if (!podeReceberCritico(sub)) continue;
    try {
      await webpush.sendNotification(sub, payload);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) await removeSubscription(sub.endpoint);
      else console.error('Erro ao enviar push (link degradado):', err.message);
    }
  }
}

async function notifyReinicioPendente(unidadeNome, codigo, computadorNome, posto, dias) {
  const prefixo = computadorNome ? `${computadorNome} · ` : '';
  const dados = {
    title: '🔁 Reiniciar computador',
    // o lembrete carrega o aviso que faltou em agosto: reiniciar máquina com
    // NOCZenith instalado sem Administrador derruba o monitoramento até
    // alguém logar de novo (a tarefa antiga só dispara no login)
    body: `${prefixo}${unidadeNome || codigo}: ligado há ${dias} dias sem reiniciar. Após reiniciar, faça um login na máquina (ou reinstale o NOCZenith como Administrador pra ele voltar sozinho).`,
    tag: `noc-reiniciar-${codigo}-${posto || 'principal'}`,
    url: '/loja-status.html',
  };
  await alertasCentral.registrar({ tipo: 'noc-reiniciar', titulo: dados.title, resumo: dados.body, url: dados.url, critico: false });
  if (!PUBLIC_KEY || !PRIVATE_KEY) return;
  const payload = JSON.stringify(dados);
  const subs = await loadSubs();
  for (const sub of subs) {
    if (!podeReceberCritico(sub)) continue;
    try {
      await webpush.sendNotification(sub, payload);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await removeSubscription(sub.endpoint);
      } else {
        console.error('Erro ao enviar push (reinício pendente):', err.message);
      }
    }
  }
}

// `reiniciando` = foi o PRÓPRIO NOC quem mandou reiniciar essa máquina há
// pouco (ver JANELA_REINICIO_MS em lojaStatus.js). Nesse caso ela sumir do
// ar é o esperado, não um incidente - e mandar "verifique a internet"
// afirmaria como causa exatamente o que o sistema sabe ser falso, além de
// fazer alguém sair atrás de um problema que não existe. Some com o alarme
// crítico também: ninguém precisa ser acordado por um reinício que nós
// mesmos agendamos.
async function notifyLojaOffline(unidadeNome, codigo, computadorNome, posto, reiniciando) {
  const prefixo = computadorNome ? `${computadorNome} · ` : '';
  const dados = reiniciando ? {
    title: '🔄 Reiniciando (manutenção)',
    body: `${prefixo}${unidadeNome || codigo} saiu do ar pra reiniciar - foi o NOC que mandou. Volta em ~2 min; se não voltar, você é avisado.`,
    tag: `loja-status-${codigo}-${posto || 'principal'}`,
    critical: false,
    url: '/loja-status.html',
  } : {
    title: '🔴 Loja sem conexão',
    body: `${prefixo}${unidadeNome || codigo} parou de responder - verifique a internet/computador da loja.`,
    tag: `loja-status-${codigo}-${posto || 'principal'}`,
    critical: true,
    url: '/loja-status.html',
  };
  await alertasCentral.registrar({
    tipo: reiniciando ? 'noc-reiniciando' : 'noc-offline',
    titulo: dados.title, resumo: dados.body, url: dados.url, critico: !reiniciando,
  });
  if (!PUBLIC_KEY || !PRIVATE_KEY) return;
  const payload = JSON.stringify(dados);
  const subs = await loadSubs();
  for (const sub of subs) {
    if (!podeReceberCritico(sub)) continue;
    try {
      await webpush.sendNotification(sub, payload, { urgency: 'high' });
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await removeSubscription(sub.endpoint);
      } else {
        console.error('Erro ao enviar push (loja offline):', err.message);
      }
    }
  }
}

// Diferenca de caixa apurada na hora da sangria (ver sangrias.js). Pedido do
// Master: quer saber na hora, no celular. Mesmo publico e mesma urgencia dos
// outros alarmes criticos. Tom do §5: o fato e o numero, nunca "algo deu
// errado" - e quando ha fechamento pendente isso vai junto, porque e' o que
// explica a maior parte das sobras.
async function notifyDivergenciaCaixa(unidadeNome, sangria) {
  const dif = Number(sangria.divergencia) || 0;
  const abs = Math.abs(dif).toFixed(2).replace('.', ',');
  const pendentes = Number(sangria.diasSemFechamento) || 0;
  const dados = {
    title: dif < 0 ? '💸 Falta dinheiro no caixa' : '💰 Sobra de dinheiro no caixa',
    body: `${unidadeNome} · R$ ${abs} ${dif < 0 ? 'a menos' : 'a mais'} na sangria de ${sangria.nomeDepositante || 'quem lançou'}`
      + (pendentes ? ` · ${pendentes} dia(s) sem fechamento lançado` : '')
      + (sangria.motivoDivergencia ? ` · motivo: ${sangria.motivoDivergencia}` : ''),
    tag: `caixa-divergencia-${sangria.id}`,
    url: '/saidas.html',
  };
  await alertasCentral.registrar({ tipo: 'caixa-divergencia', titulo: dados.title, resumo: dados.body, url: dados.url, critico: true });
  if (!PUBLIC_KEY || !PRIVATE_KEY) return;
  const payload = JSON.stringify(dados);
  const subs = await loadSubs();
  for (const sub of subs) {
    if (!podeReceberCritico(sub)) continue;
    try {
      await webpush.sendNotification(sub, payload, { urgency: 'high' });
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await removeSubscription(sub.endpoint);
      } else {
        console.error('Erro ao enviar push (divergência de caixa):', err.message);
      }
    }
  }
}

// o tipo do aparelho e' aberto (a tela cria tipo novo - ver
// listarTiposDispositivo em lojaStatus.js), entao o titulo vem do ROTULO que
// a pessoa deu ("GCOM sem rede", "VM Host sem rede") em vez de uma lista
// fechada aqui dentro. So o icone continua sendo decidido por tipo.
function rotuloTipoDispositivo(tipoDispositivo, tipoRotulo) {
  const icone = tipoDispositivo === 'impressora' ? '🖨️' : (tipoDispositivo ? '🖥️' : '📡');
  return { icone, rotulo: tipoRotulo || 'Aparelho' };
}

// dispositivo de rede MARCADO (impressora Zebra/Bematech, VM do servidor -
// ver definirApelidoDispositivo em lojaStatus.js) sumiu da varredura ARP
// por tempo demais (ver DISPOSITIVO_OFFLINE_LIMIAR_MS). Mesmo publico e
// mesma urgencia do alerta de loja offline: pedido explicito do Master pra
// esse equipamento especifico ("caso esses equipamentos percam rede
// precisa alarmar").
async function notifyDispositivoOffline(unidadeNome, codigo, apelido, tipoDispositivo, mac, tipoRotulo) {
  const nome = apelido || mac;
  const { icone, rotulo } = rotuloTipoDispositivo(tipoDispositivo, tipoRotulo);
  const dados = {
    title: `${icone} ${rotulo} sem rede`,
    body: `${nome} (${unidadeNome || codigo}) sumiu da rede - verifique cabo/energia do equipamento.`,
    tag: `noc-dispositivo-${codigo}-${mac}`,
    url: '/loja-status.html',
  };
  await alertasCentral.registrar({ tipo: 'noc-dispositivo-offline', titulo: dados.title, resumo: dados.body, url: dados.url, critico: true });
  if (!PUBLIC_KEY || !PRIVATE_KEY) return;
  const payload = JSON.stringify(dados);
  const subs = await loadSubs();
  for (const sub of subs) {
    if (!podeReceberCritico(sub)) continue;
    try {
      await webpush.sendNotification(sub, payload, { urgency: 'high' });
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await removeSubscription(sub.endpoint);
      } else {
        console.error('Erro ao enviar push (dispositivo offline):', err.message);
      }
    }
  }
}

// dispositivo monitorado voltou a aparecer na varredura - aviso tranquilo
// (sem alarme sonoro), mesmo publico do alerta de queda
async function notifyDispositivoOnline(unidadeNome, codigo, apelido, tipoDispositivo, mac, tipoRotulo) {
  const nome = apelido || mac;
  const { icone } = rotuloTipoDispositivo(tipoDispositivo, tipoRotulo);
  const dados = {
    title: `${icone} Voltou à rede`,
    body: `${nome} (${unidadeNome || codigo}) voltou a responder na rede.`,
    tag: `noc-dispositivo-${codigo}-${mac}`,
    url: '/loja-status.html',
  };
  await alertasCentral.registrar({ tipo: 'noc-dispositivo-online', titulo: dados.title, resumo: dados.body, url: dados.url, critico: false });
  if (!PUBLIC_KEY || !PRIVATE_KEY) return;
  const payload = JSON.stringify(dados);
  const subs = await loadSubs();
  for (const sub of subs) {
    if (!podeReceberCritico(sub)) continue;
    try {
      await webpush.sendNotification(sub, payload);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await removeSubscription(sub.endpoint);
      } else {
        console.error('Erro ao enviar push (dispositivo voltou):', err.message);
      }
    }
  }
}

// computador da loja voltou a responder depois de ter caido - aviso
// tranquilo (sem alarme), mesmo publico do alerta de queda
// mandamos reiniciar e a máquina NÃO voltou na janela. Isso sim é
// incidente, e com uma causa provável já conhecida - o que é bem mais útil
// pra quem vai atender do que um "sem conexão" genérico.
async function notifyReinicioNaoVoltou(unidadeNome, codigo, computadorNome, posto, minutos) {
  const prefixo = computadorNome ? `${computadorNome} · ` : '';
  const dados = {
    title: '⚠️ Não voltou do reinício',
    body: `${prefixo}${unidadeNome || codigo}: reiniciada pelo NOC há ${minutos} min e ainda não subiu. Pode ter travado no boot, desligado de vez ou perdido a rede ao subir.`,
    tag: `noc-reinicio-falhou-${codigo}-${posto || 'principal'}`,
    critical: true,
    url: '/loja-status.html',
  };
  await alertasCentral.registrar({ tipo: 'noc-reinicio-falhou', titulo: dados.title, resumo: dados.body, url: dados.url, critico: true });
  if (!PUBLIC_KEY || !PRIVATE_KEY) return;
  const payload = JSON.stringify(dados);
  const subs = await loadSubs();
  for (const sub of subs) {
    if (!podeReceberCritico(sub)) continue;
    try {
      await webpush.sendNotification(sub, payload, { urgency: 'high' });
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) await removeSubscription(sub.endpoint);
      else console.error('Erro ao enviar push (reinício não voltou):', err.message);
    }
  }
}

async function notifyLojaVoltou(unidadeNome, codigo, computadorNome, posto, voltouDeReinicio) {
  const prefixo = computadorNome ? `${computadorNome} · ` : '';
  const dados = {
    title: voltouDeReinicio ? '🟢 Voltou do reinício' : '🟢 Loja reconectou',
    body: voltouDeReinicio
      ? `${prefixo}${unidadeNome || codigo} reiniciou e já está no ar de novo.`
      : `${prefixo}${unidadeNome || codigo} voltou a responder.`,
    tag: `loja-status-${codigo}-${posto || 'principal'}`,
    url: '/loja-status.html',
  };
  await alertasCentral.registrar({ tipo: 'noc-online', titulo: dados.title, resumo: dados.body, url: dados.url });
  if (!PUBLIC_KEY || !PRIVATE_KEY) return;
  const payload = JSON.stringify(dados);
  const subs = await loadSubs();
  for (const sub of subs) {
    if (!podeReceberCritico(sub)) continue;
    try {
      await webpush.sendNotification(sub, payload);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await removeSubscription(sub.endpoint);
      } else {
        console.error('Erro ao enviar push (loja voltou):', err.message);
      }
    }
  }
}

// diferente do alerta de loja offline (Master + Suporte), acesso remoto
// detectado no computador so vai pro Master de verdade - e um alerta de
// seguranca (quem entrou na maquina), nao um aviso operacional de infra
function podeReceberAcessoRemoto(sub) {
  const meta = sub.meta;
  return !!meta && meta.isMaster;
}

// o vigia (NOCZenith) detectou alguem conectado por acesso remoto (AnyDesk,
// TeamViewer, DWService ou qualquer outro - ver lojaStatus.js
// registrarAcessoRemoto) no computador onde esta instalado. Tag inclui um
// timestamp (nao so codigo/posto): cada conexao e um evento de seguranca
// proprio, entao uma nova NAO deve substituir/esconder um aviso anterior
// ainda nao visto (diferente do offline/online, onde so o estado mais
// recente importa)
async function notifyAcessoRemotoDetectado(unidadeNome, codigo, computadorNome, posto, detalhe) {
  const prefixo = computadorNome ? `${computadorNome} · ` : '';
  const dados = {
    title: '🛑 Acesso remoto detectado',
    body: `${prefixo}${unidadeNome || codigo} · ${detalhe || 'conexão de acesso remoto'}`,
    tag: `acesso-remoto-${codigo}-${posto || 'principal'}-${Date.now()}`,
    critical: true,
    url: '/loja-status.html',
  };
  await alertasCentral.registrar({ tipo: 'noc-acesso-remoto', titulo: dados.title, resumo: dados.body, url: dados.url, critico: true });
  if (!PUBLIC_KEY || !PRIVATE_KEY) return;
  const payload = JSON.stringify(dados);
  const subs = await loadSubs();
  for (const sub of subs) {
    if (!podeReceberAcessoRemoto(sub)) continue;
    try {
      await webpush.sendNotification(sub, payload, { urgency: 'high' });
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await removeSubscription(sub.endpoint);
      } else {
        console.error('Erro ao enviar push (acesso remoto):', err.message);
      }
    }
  }
}

// fechamento do dia lançado por uma loja (POST /api/fechamentos/lancar) -
// pedido do Master: "quero receber notificação quando os fechamentos forem
// realizados". E AVISO DE ROTINA, nunca alarme: chega um por loja por dia, e
// sirene em coisa esperada so ensina a ignorar sirene.
//
// Publico pelo mesmo criterio do resto do dia a dia (podeReceber): o Master
// ve tudo; quem tem a secao "fechamentos" recebe das unidades que ja enxerga
// - assim um supervisor regional so e' avisado das lojas dele.
//
// A diferenca de caixa vai no corpo porque e' ela que decide se vale abrir
// agora ou so olhar depois. Quando passa do limite, o ticket de Quebra de
// caixa continua avisando em separado (ver create em fechamentosLive.js) -
// aquilo pede acao, isto so informa que o dia fechou.
function fmtMoedaFech(v) {
  return (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

async function notifyFechamentoLancado(registro, { exceptUserId } = {}) {
  if (!registro) return;
  const dataBr = /^\d{4}-\d{2}-\d{2}$/.test(String(registro.data || ''))
    ? `${registro.data.slice(8, 10)}/${registro.data.slice(5, 7)}`
    : String(registro.data || '');
  const diferenca = Number(registro.diferenca) || 0;
  // menos de 1 centavo e' arredondamento, nao divergencia
  const resumoCaixa = Math.abs(diferenca) < 0.01
    ? 'caixa bateu certinho'
    : `diferença de ${fmtMoedaFech(diferenca)}`;
  const title = '🧾 Fechamento lançado';
  const body = `${registro.unidadeNome || registro.unidade} · ${dataBr} · faturamento ${fmtMoedaFech(registro.faturamento)} · ${resumoCaixa}${registro.gerente ? ` · por ${registro.gerente}` : ''}`;
  const url = '/fechamentos.html';
  await alertasCentral.registrar({ tipo: 'fechamento', titulo: title, resumo: body, url });
  if (!PUBLIC_KEY || !PRIVATE_KEY) return;
  const payload = JSON.stringify({ title, body, tag: `fechamento-${registro.id}`, url });
  const subs = await loadSubs();
  for (const sub of subs) {
    if (!podeReceber(sub, { unidade: registro.unidade, section: 'fechamentos' })) continue;
    // quem acabou de lançar nao precisa de push do proprio lançamento - ele
    // ja viu a tela de confirmacao
    if (exceptUserId && sub.meta && String(sub.meta.userId) === String(exceptUserId)) continue;
    try {
      await webpush.sendNotification(sub, payload);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) await removeSubscription(sub.endpoint);
      else console.error('Erro ao enviar push (fechamento lançado):', err.message);
    }
  }
}

module.exports = {
  addSubscription, migrarSubscricao, removeSubscription, notify, notifyRaw, notifySolicitacao, notifyAbastecimento,
  notifyBeniboyEscalonamento, notifyUsuario, notifyParquePcdCortesiaLimite, notifyParqueTermoPendente, notifyRhTesteVencido,
  notifyRhAprovacaoPendente, notifyRhAdvertenciaPendente, notifyRhAdvertenciaPrazoVencido,
  notifyRhCadastroPendente, notifyRhCadastroReprovado, notifyRhCheckoutAtrasado,
  notifyExperienciaPrazo, notifyExperienciaPrazoGerente, notifyLojaOffline, notifyLojaVoltou, notifyDiscoAlerta, notifyReinicioPendente, notifyMaquinaReiniciou, notifyLinkDegradado, notifyReinicioNaoVoltou,
  notifyDispositivoOffline,
  notifyDivergenciaCaixa, notifyDispositivoOnline,
  notifyQaAprovacaoPendente, notifyAcessoRemotoDetectado, notifySegurancaChat, testarPush,
  notifyAbastecimentoDivergencia, notifyFechamentoLancado, PUBLIC_KEY,
};
