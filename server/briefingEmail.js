// briefingEmail.js
// E-mail diario de INDICADORES pro assistente do gestor de operacoes - o
// mesmo objeto de GET /api/bot/indicadores?dias=7&compacto=1, empurrado por
// e-mail em vez de puxado pela rota (o ambiente em nuvem do assistente nao
// alcanca o NoPulso por rede, mas le a caixa do Gmail). O JSON integral vai
// dentro de <pre id="indicadores-json"> (ver botIndicadores.montarEmailHtml).
//
// Mesmo desenho do relatorio MV (relatorioMV.js), que ficou ocioso quando o
// relatorio pro MV foi descontinuado: config editavel na tela /email.html
// (horario, dias, destino, copia, ligado/desligado), agendamento com
// node-cron recriado a cada salvar, historico dos ultimos envios, preview
// sem mandar. Reusa de la a saida de e-mail (enviarComFallback: Gmail API ou
// SMTP) e os validadores - nenhuma credencial nova, nenhuma chamada a API da
// Anthropic (o NoPulso so entrega o dado; quem escreve o briefing e o
// assistente, na assinatura do gestor).
//
// Custo Firestore: config em cache (5min, invalidado ao salvar), 1 leitura do
// doc por reidratacao; 1 write por envio (historico); a montagem dos
// indicadores usa os caches que as telas ja usam.
const cron = require('node-cron');
const db = require('./firestore');
const { createCache } = require('./liveCache');
const relatorioMV = require('./relatorioMV');
const botIndicadores = require('./botIndicadores');

const FUSO_BR = 'America/Sao_Paulo';
const CONFIG_DOC = db.collection('briefingEmailConfig').doc('config');
const ENVIOS = db.collection('briefingEmailEnvios');

// de madrugada as lojas ja fecharam e lancaram; seg-sab porque domingo o
// gestor nao abre briefing (o de segunda cobre o fim de semana no periodo)
const HORA_ENVIO_PADRAO = '06:30';
const DIAS_SEMANA_PADRAO = [1, 2, 3, 4, 5, 6];
const DIAS_PERIODO = 7;

// quem monta o objeto de indicadores mora no index.js (precisa das fontes
// de la) - e injetado no boot via iniciar(). Assim este modulo nao depende
// do index.js e o teste consegue trocar por um fake.
let montarIndicadores = null;

const configCache = createCache(async () => {
  const snap = await CONFIG_DOC.get();
  const data = snap.exists ? snap.data() : {};
  const horaEnvio = /^([01]\d|2[0-3]):([0-5]\d)$/.test(data.horaEnvio) ? data.horaEnvio : HORA_ENVIO_PADRAO;
  const diasSemana = Array.isArray(data.diasSemana) && data.diasSemana.length
    ? data.diasSemana.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
    : DIAS_SEMANA_PADRAO;
  return {
    // desligado ate o Master ligar pela tela: nao existe destino padrao
    ativo: !!data.ativo && !!String(data.emailDestino || '').trim(),
    emailDestino: String(data.emailDestino || '').trim(),
    emailCopia: String(data.emailCopia || '').trim(),
    horaEnvio,
    diasSemana: diasSemana.length ? diasSemana : DIAS_SEMANA_PADRAO,
    atualizadoEm: data.atualizadoEm || null,
  };
}, 5 * 60 * 1000);
const getConfig = configCache.cached;

async function salvarConfig({ ativo, emailDestino, emailCopia, horaEnvio, diasSemana }) {
  const ligado = ativo === true || ativo === 'true' || ativo === 1 || ativo === '1';
  // destino so e obrigatorio quando ligado - desligar com o campo vazio e
  // um jeito legitimo de "parar tudo" sem perder o resto da config
  const destinoLimpo = ligado ? relatorioMV.validarEmail(emailDestino) : String(emailDestino || '').trim();
  const copiaLimpa = relatorioMV.validarEmailCopia(emailCopia);
  const horaLimpa = relatorioMV.validarHoraEnvio(horaEnvio);
  const diasLimpos = relatorioMV.validarDiasSemana(diasSemana);
  await CONFIG_DOC.set({
    ativo: ligado,
    emailDestino: destinoLimpo,
    emailCopia: copiaLimpa,
    horaEnvio: horaLimpa,
    diasSemana: diasLimpos,
    atualizadoEm: new Date().toISOString(),
  }, { merge: true });
  configCache.invalidar();
  const nova = await getConfig();
  agendar(nova);
  return nova;
}

async function registrarEnvio(dados) {
  try {
    const ref = ENVIOS.doc();
    await ref.set({ id: ref.id, em: new Date().toISOString(), ...dados });
  } catch (err) {
    console.error('[briefing] não foi possível registrar o envio:', err.message);
  }
}

async function listarEnvios(limite = 20) {
  const snap = await ENVIOS.orderBy('em', 'desc').limit(Math.min(Number(limite) || 20, 100)).get();
  return snap.docs.map((d) => d.data());
}

function resumoParaLog(ind) {
  const r = ind.resumo || {};
  return {
    ate: ind.ontem,
    faturamentoOntem: r.faturamentoOntem,
    lojasLancaramOntem: r.lojasLancaramOntem,
    lojasTotal: r.lojasTotal,
    faturamentoPeriodo: r.faturamentoPeriodo,
  };
}

// origem: 'agendado' | 'manual'. paraOverride manda pra OUTRO endereco sem
// mexer na config (conferir na propria caixa) - nesse caso sem copia
async function enviar({ origem = 'agendado', porEmail = null, paraOverride = null } = {}) {
  if (!montarIndicadores) throw new Error('briefingEmail não inicializado (iniciar() não foi chamado).');
  const config = await getConfig();
  const para = String(paraOverride || '').trim() || config.emailDestino;
  if (!para) throw new Error('Informe o e-mail de destino na tela E-mail antes de enviar.');
  const copia = paraOverride ? '' : config.emailCopia;
  let ind;
  try {
    ind = await montarIndicadores({ dias: DIAS_PERIODO, compacto: true });
    await relatorioMV.enviarComFallback({
      from: `NoPulso <${process.env.RELATORIO_EMAIL_USER}>`,
      to: para,
      cc: copia || undefined,
      subject: `NoPulso indicadores ${ind.ontem}`,
      html: botIndicadores.montarEmailHtml(ind),
    });
  } catch (err) {
    await registrarEnvio({ ok: false, origem, porEmail, para, copia, erro: err.message, ...(ind ? resumoParaLog(ind) : {}) });
    throw err;
  }
  const registro = { ok: true, origem, porEmail, para, copia, ...resumoParaLog(ind) };
  await registrarEnvio(registro);
  console.log(`[briefing] indicadores até ${ind.ontem} enviados para ${para} (${origem}).`);
  return registro;
}

// mesmo conteudo que sairia agora, sem mandar - botao "Pre-visualizar"
async function previewHtml() {
  if (!montarIndicadores) throw new Error('briefingEmail não inicializado (iniciar() não foi chamado).');
  const ind = await montarIndicadores({ dias: DIAS_PERIODO, compacto: true });
  return { html: botIndicadores.montarEmailHtml(ind), ...resumoParaLog(ind) };
}

let tarefaAtual = null;
function agendar(config) {
  if (tarefaAtual) { tarefaAtual.stop(); tarefaAtual = null; }
  if (!config.ativo) { console.log('[briefing] e-mail diário de indicadores DESLIGADO (ligue na tela E-mail).'); return; }
  const [hora, minuto] = config.horaEnvio.split(':');
  const expressao = `${Number(minuto)} ${Number(hora)} * * ${config.diasSemana.join(',')}`;
  if (!cron.validate(expressao)) {
    console.error(`[briefing] agendamento inválido ("${expressao}") - desativado até a próxima config válida.`);
    return;
  }
  tarefaAtual = cron.schedule(expressao, () => {
    enviar({ origem: 'agendado' }).catch((err) => console.error('[briefing] falha no envio diário:', err.message));
  }, { timezone: FUSO_BR });
  console.log(`[briefing] e-mail diário de indicadores agendado (${expressao}, ${FUSO_BR}) para ${config.emailDestino}.`);
}

// chamado uma vez no boot pelo index.js
async function iniciar({ montar }) {
  if (typeof montar !== 'function') throw new Error('briefingEmail.iniciar precisa de { montar }.');
  montarIndicadores = montar;
  agendar(await getConfig());
}

module.exports = { iniciar, getConfig, salvarConfig, enviar, previewHtml, listarEnvios, HORA_ENVIO_PADRAO, DIAS_SEMANA_PADRAO };
