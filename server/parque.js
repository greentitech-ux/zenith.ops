// parque.js
// Controle de entrada do parque de trampolins (Saltiverso Patteo) - um
// registro por check-in de um responsavel trazendo N criancas pra pular.
// Mesmo padrao de sangrias.js: colecao Firestore propria, cache curto via
// liveCache.js, CRUD simples (criar/listAll/listByUnidades/atualizar/
// remover).
const db = require('./firestore');
const { createCache } = require('./liveCache');

const COLLECTION = db.collection('parqueCheckins');
// depois de enviado, o check-in nao pode ser excluido direto - qualquer
// exclusao passa por um pedido de correcao (parqueEdicoes) que so e
// aplicado quando o Master aprova, mesmo fluxo do fechamento de caixa
// (fechamentosLive.js) e das entregas (entregasLive.js)
const EDITS = db.collection('parqueEdicoes');
// checkout antecipado (emergencia) guarda o tempo que sobrou como credito
// pro mesmo CPF usar numa proxima visita - um doc por CPF, ver checkout()/
// registrarCredito()/creditoPorCpf()/usarCredito() mais abaixo
const CREDITOS = db.collection('parqueCreditos');

// venda normal vai de 30 a 120 minutos por padrao - tempos maiores sairam da
// tabela; quem quiser ficar mais usa o "adicionar tempo" durante a vigencia
// (ver adicionarTempo abaixo). Registros antigos com 150-240 continuam
// validos, so nao da mais pra vender/editar pra esses buckets.
//
// A LISTA de tempos (quantos botoes, quais minutos, nome e preco de cada um)
// e' editavel pelo Master em "Editar tabela de precos" (ver
// getConfigPrecos/salvarConfigPrecos abaixo) - os valores fixos aqui embaixo
// sao so o SEED do 1o boot (antes de existir configuracao salva) e o
// FALLBACK usado por valorDoCheckin() pra recalcular visitas antigas que nao
// tem `valor` gravado (tempoMinutos fora da tabela atual, ex: 150-240min) -
// nesses dois casos nao faz sentido usar o preco de HOJE pra algo que foi
// vendido antes da tabela existir
const PRECO_MEIA_HORA = 40;
const PRECO_HORA = 50;
const TEMPOS_PADRAO = [
  { minutos: 30, label: '30min', preco: 40, visivel: true },
  { minutos: 60, label: '60min', preco: 50, visivel: true },
  { minutos: 90, label: '90min', preco: 90, visivel: true },
  { minutos: 120, label: '120min', preco: 100, visivel: true },
];
const PCD_PADRAO = [
  { chave: 'pcd30', label: 'PCD30', minutos: 30, preco: 32, visivel: true },
  { chave: 'pcd60', label: 'PCD60', minutos: 60, preco: 32, visivel: true },
];
const PCD_CORTESIA_LABEL_PADRAO = '5%CP';
const PCD_CORTESIA_MINUTOS_PADRAO = 60;
// desconto de aniversariante em PERCENTUAL (0-100), nao em fracao - mesmo
// padrao de "10 = 10%" ja usado no desconto simples de festas.js. So um dos
// dois modos (niverValorCheio OU niverDesconto) fica ativo por vez - ver
// valorEntradaCriancas e a validacao em salvarConfigPrecos
const NIVER_DESCONTO_PADRAO = 50;

const PRECO_CONFIG_DOC = db.collection('parqueConfig').doc('tabela');
const precoConfigCache = createCache(async () => {
  const snap = await PRECO_CONFIG_DOC.get();
  const data = snap.exists ? snap.data() : {};
  // .map(...visivel!==false) cobre tanto o default (ja vem true) quanto
  // configuracao salva antes desse campo existir (documento antigo sem a
  // chave `visivel` em cada item - trata ausencia como "visivel")
  return {
    tempos: (Array.isArray(data.tempos) && data.tempos.length ? data.tempos : TEMPOS_PADRAO)
      .map((t) => ({ ...t, visivel: t.visivel !== false })),
    pcd: (Array.isArray(data.pcd) && data.pcd.length === 2 ? data.pcd : PCD_PADRAO)
      .map((p) => ({ ...p, visivel: p.visivel !== false })),
    pcdCortesiaLabel: data.pcdCortesiaLabel || PCD_CORTESIA_LABEL_PADRAO,
    pcdCortesiaMinutos: Number.isFinite(data.pcdCortesiaMinutos) && data.pcdCortesiaMinutos > 0 ? data.pcdCortesiaMinutos : PCD_CORTESIA_MINUTOS_PADRAO,
    pcdCortesiaVisivel: data.pcdCortesiaVisivel !== false,
    niverDesconto: Number.isFinite(data.niverDesconto) ? data.niverDesconto : NIVER_DESCONTO_PADRAO,
    niverValorCheio: Number.isFinite(data.niverValorCheio) && data.niverValorCheio > 0 ? data.niverValorCheio : 0,
    niverAplicar30: data.niverAplicar30 === true,
  };
}, 5 * 60 * 1000);
const getConfigPrecos = precoConfigCache.cached;

function sanitizarTempos(lista) {
  const candidatos = (Array.isArray(lista) ? lista : []).map((t) => ({
    minutos: Math.round(num(t && t.minutos)),
    label: String((t && t.label) || '').trim().slice(0, 30),
    preco: Math.round(num(t && t.preco) * 100) / 100,
    visivel: (t && t.visivel) !== false,
  }));
  const vistos = new Set();
  const validos = [];
  for (const t of candidatos.sort((a, b) => a.minutos - b.minutos)) {
    if (t.minutos <= 0 || !t.label || t.preco <= 0 || vistos.has(t.minutos)) continue;
    vistos.add(t.minutos);
    validos.push(t);
  }
  if (validos.length < 1) throw new Error('Informe pelo menos um tempo contratado.');
  if (validos.length > 8) throw new Error('No máximo 8 tempos contratados.');
  return validos;
}

// so 2 categorias PCD (pcd30/pcd60) - chave fixa (identifica o "bucket" nas
// visitas ja salvas), label/minutos/preco/visivel editaveis pelo Master
function sanitizarPcd(lista) {
  const arr = Array.isArray(lista) ? lista : [];
  return PCD_PADRAO.map((padrao) => {
    const item = arr.find((p) => p && p.chave === padrao.chave) || {};
    const label = String(item.label || '').trim().slice(0, 30) || padrao.label;
    const minutos = Math.round(num(item.minutos)) || padrao.minutos;
    const preco = Math.round(num(item.preco) * 100) / 100;
    if (preco <= 0) throw new Error(`Preço inválido em "${label}".`);
    return { chave: padrao.chave, label, minutos, preco, visivel: item.visivel !== false };
  });
}

async function salvarConfigPrecos({
  tempos, pcd, pcdCortesiaLabel, pcdCortesiaMinutos, pcdCortesiaVisivel,
  niverDesconto, niverValorCheio, niverAplicar30,
} = {}) {
  const temposOk = sanitizarTempos(tempos);
  const pcdOk = sanitizarPcd(pcd);
  const cortesiaLabelOk = String(pcdCortesiaLabel || '').trim().slice(0, 30) || PCD_CORTESIA_LABEL_PADRAO;
  const cortesiaMinutosOk = Math.round(num(pcdCortesiaMinutos)) || PCD_CORTESIA_MINUTOS_PADRAO;
  const cortesiaVisivelOk = pcdCortesiaVisivel !== false;
  const descontoOk = Math.max(0, Math.min(100, num(niverDesconto)));
  const valorCheioOk = Math.max(0, Math.round(num(niverValorCheio) * 100) / 100);
  // ou valor cheio ou percentual - nunca os dois ao mesmo tempo (ver
  // valorEntradaCriancas: valor cheio, quando preenchido, sempre manda)
  if (descontoOk > 0 && valorCheioOk > 0) {
    throw new Error('Aniversariante: preencha só "valor cheio" OU "porcentagem de desconto", não os dois.');
  }
  const aplicar30Ok = niverAplicar30 === true;
  await PRECO_CONFIG_DOC.set({
    tempos: temposOk, pcd: pcdOk, pcdCortesiaLabel: cortesiaLabelOk, pcdCortesiaMinutos: cortesiaMinutosOk,
    pcdCortesiaVisivel: cortesiaVisivelOk, niverDesconto: descontoOk, niverValorCheio: valorCheioOk,
    niverAplicar30: aplicar30Ok, atualizadoEm: new Date().toISOString(),
  }, { merge: true });
  precoConfigCache.invalidar();
  return getConfigPrecos();
}

// tempoMinutos > preco: primeiro tenta a tabela ATUAL (editavel); sem tabela
// (ou minutos fora dela - visita antiga com bucket que saiu de linha), cai
// no calculo aditivo antigo (30min=R$40, 60min=R$50, 90=50+40...) - so pra
// nao reprecificar pelo valor de HOJE algo vendido antes da tabela existir
function valorPorTempo(tempoMinutos, tabela) {
  const t = Number(tempoMinutos) || 0;
  const entrada = tabela && Array.isArray(tabela.tempos) ? tabela.tempos.find((e) => e.minutos === t) : null;
  if (entrada) return entrada.preco;
  return Math.floor(t / 60) * PRECO_HORA + (t % 60 >= 30 ? PRECO_MEIA_HORA : 0);
}

// par de meia antiderrapante: R$25 por crianca. TODA crianca entra por
// padrao com a meia cobrada (meia: true) - o atendente desmarca quando a
// crianca ja chegou com a propria meia. Alem disso da pra vender pares
// extras (meiasExtras) alem da quantidade de criancas
const PRECO_MEIA = 25;
function valorMeias(criancas, meiasExtras) {
  const optantes = (criancas || []).filter((c) => c.meia !== false).length;
  return PRECO_MEIA * (optantes + Math.max(0, num(meiasExtras)));
}

// aniversariante: desconto/preco especial AUTOMATICO na entrada so daquela
// crianca (as demais do mesmo check-in pagam normal) quando a data de
// utilizacao do check-in (o dia que a entrada vale, nao a data em que foi
// comprada) cai ate NIVER_JANELA_DIAS antes ou depois do aniversario da
// crianca (mes/dia da dataNascimento - o ano nao importa). Nao precisa
// marcar nada, nao afeta o par de meia, e NAO se aplica as categorias PCD
// (pcd30/pcd60/pcd-cortesia = 5%CP), que ja tem preco fixo proprio - ver
// aplicarNiverAutomatico.
// A REGRA em si (ver valorEntradaCriancas abaixo) e' editavel pelo Master no
// mesmo lugar da tabela de tempos/PCD (getConfigPrecos/salvarConfigPrecos):
//   - so vale pra tempo contratado de 60min por padrao; 30min so entra se
//     tabela.niverAplicar30 estiver marcado. 90/120min nunca tem niver.
//   - dentro da janela de tempo elegivel, e' OU valor cheio fixo
//     (tabela.niverValorCheio, quando > 0) OU desconto percentual
//     (tabela.niverDesconto) - nunca os dois ao mesmo tempo (ver validacao
//     em salvarConfigPrecos). Valor cheio manda quando preenchido.
const NIVER_JANELA_DIAS = 7;
function ehNiver(dataNascimento, dataUtilizacao) {
  if (!dataNascimento || !dataUtilizacao) return false;
  const nasc = new Date(`${dataNascimento}T00:00:00`);
  const uso = new Date(`${dataUtilizacao}T00:00:00`);
  if (Number.isNaN(nasc.getTime()) || Number.isNaN(uso.getTime())) return false;
  // compara contra o aniversario no ano anterior/atual/seguinte pra cobrir a
  // virada do ano (ex: nasc 28/12, uso 02/01)
  for (const deltaAno of [-1, 0, 1]) {
    const aniversario = new Date(uso.getFullYear() + deltaAno, nasc.getMonth(), nasc.getDate());
    const diffDias = Math.abs((uso - aniversario) / 86400000);
    if (diffDias <= NIVER_JANELA_DIAS) return true;
  }
  return false;
}
// categoriaPcd presente = pcd30/pcd60/pcd-cortesia: niver nunca se aplica
function aplicarNiverAutomatico(criancas, dataUtilizacao, categoriaPcd) {
  return (criancas || []).map((c) => ({ ...c, niver: !categoriaPcd && ehNiver(c.dataNascimento, dataUtilizacao) }));
}
// tempoMinutos: tempo contratado desse check-in (define se o niver esta
// elegivel - ver comentario acima). tabela: opcional, pra chamador antigo
// sem tabela cair no comportamento anterior (50% em qualquer tempo)
function valorEntradaCriancas(criancas, unitario, tempoMinutos, tabela) {
  const t = tabela || {};
  const elegivel = !tabela || tempoMinutos === 60 || (tempoMinutos === 30 && t.niverAplicar30 === true);
  const valorCheio = Number.isFinite(t.niverValorCheio) && t.niverValorCheio > 0 ? t.niverValorCheio : null;
  const desconto = Math.max(0, Math.min(100, Number.isFinite(t.niverDesconto) ? t.niverDesconto : NIVER_DESCONTO_PADRAO)) / 100;
  return (criancas || []).reduce((soma, c) => {
    if (c.niver && elegivel) return soma + (valorCheio != null ? valorCheio : unitario * (1 - desconto));
    return soma + unitario;
  }, 0);
}

// forma de pagamento registrada na entrada - alimenta o relatorio
// financeiro. 'cortesia' zera o valor (entrada liberada sem cobranca).
// 'misto' e' so um rotulo (ver metodoPagamento em criar()) pra quando a
// entrada foi dividida entre mais de uma forma - ver pagamentos abaixo
const METODOS_PAGAMENTO = ['dinheiro', 'pix', 'debito', 'credito', 'voucher', 'gratuidade', 'cortesia', 'misto'];
function sanitizarMetodoPagamento(m) {
  return METODOS_PAGAMENTO.includes(m) ? m : null;
}

// divisao da entrada entre mais de uma forma de pagamento (ex: metade
// dinheiro, metade pix) - cada entrada tem forma + valor; a soma tem que
// bater exatamente com o valor total da entrada (ver validacao em criar()).
// Cortesia nunca entra aqui - e' o metodoPagamento==='cortesia' de sempre.
const FORMAS_PAGAMENTO_SPLIT = ['dinheiro', 'pix', 'debito', 'credito', 'voucher'];
function sanitizarPagamentos(lista) {
  if (!Array.isArray(lista)) return [];
  return lista
    .map((p) => ({
      forma: FORMAS_PAGAMENTO_SPLIT.includes(p && p.forma) ? p.forma : null,
      valor: Math.round(Math.max(0, num(p && p.valor)) * 100) / 100,
    }))
    .filter((p) => p.forma && p.valor > 0)
    .slice(0, 10);
}

// ---------- PCD: categoria de tempo/preco a parte da tabela normal ----------
// pcd30/pcd60 cobram preco fixo por crianca (editavel, ver getConfigPrecos),
// independente da tabela normal de tempos e da forma de pagamento.
// pcd-cortesia (5%CP) e entrada gratuita, mas NAO passa pelo fluxo pesado de
// aprovacao Gerente/Master usado pela cortesia normal (metodoPagamento===
// 'cortesia') - e uma trava leve, automatica: no maximo 2 criancas por
// hora-relogio (ex: 14:00-14:59) por unidade. Na 3a tentativa a venda e
// recusada e dispara um aviso SILENCIOSO (sem alarme/som) so pra Gerente da
// unidade + Master (ver push.js)
const CATEGORIAS_PCD = ['pcd30', 'pcd60', 'pcd-cortesia'];
const PCD_CORTESIA_LIMITE_HORA = 2;
function tempoDaCategoriaPcd(categoria, tabela) {
  if (categoria === 'pcd-cortesia') return (tabela && tabela.pcdCortesiaMinutos) || PCD_CORTESIA_MINUTOS_PADRAO;
  const entrada = tabela && Array.isArray(tabela.pcd) ? tabela.pcd.find((e) => e.chave === categoria) : null;
  if (entrada) return entrada.minutos;
  return categoria === 'pcd30' ? 30 : (categoria === 'pcd60' ? 60 : null);
}
function valorUnitarioPcd(categoria, tabela) {
  if (categoria === 'pcd-cortesia') return 0;
  const entrada = tabela && Array.isArray(tabela.pcd) ? tabela.pcd.find((e) => e.chave === categoria) : null;
  return entrada ? entrada.preco : PCD_PADRAO.find((e) => e.chave === categoria).preco;
}
// categoria oculta (ver "visivel"/pcdCortesiaVisivel em getConfigPrecos) nao
// pode nascer numa venda NOVA - so importa em criar(), nunca em correcao
// (categoriaTempo nao e editavel por correcao, ver atualizar())
function categoriaPcdDisponivel(categoria, tabela) {
  if (!tabela) return true;
  if (categoria === 'pcd-cortesia') return tabela.pcdCortesiaVisivel !== false;
  const entrada = Array.isArray(tabela.pcd) ? tabela.pcd.find((e) => e.chave === categoria) : null;
  return entrada ? entrada.visivel !== false : true;
}

// ---------- cortesia: alcada dupla com escalonamento ----------
// Cortesia e renuncia de receita, entao nunca passa sozinha: nasce como um
// card PENDENTE com justificativa obrigatoria e segue o fluxo:
//   PENDENTE -> Gerente da unidade aprova = APROVADA_GERENTE (entrada
//     liberada pra agilizar o balcao, MAS o card continua aberto
//     aguardando a palavra final do Master - prestacao de contas)
//   PENDENTE -> Master aprova direto = CONCLUIDA (encerrada)
//   APROVADA_GERENTE -> Master aprova = CONCLUIDA
//   APROVADA_GERENTE -> Master REJEITA a justificativa = ESCALADA_ADMIN
//     (o card e atribuido ao Admin responsavel - MV - pra tomar ciencia e
//     decidir, encerrando o card com um parecer)
//   PENDENTE -> negada (Gerente ou Master) = NEGADA (entrada bloqueada;
//     troca a forma de pagamento pra liberar)
// Cada passo grava quem decidiu, quando e o motivo - trilha de auditoria
// completa. Registros antigos de cortesia (sem cortesiaStatus) nao entram
// no fluxo.
const ADMIN_CORTESIA = { username: 'mv', emailPrefixo: 'mv@grupobravoempresarial' };
const ADMIN_CORTESIA_LABEL = 'MV (mv@grupobravoempresarial)';
function ehAdminCortesia(user) {
  const u = String((user && user.username) || '').toLowerCase();
  const e = String((user && user.email) || '').toLowerCase();
  return u === ADMIN_CORTESIA.username || e.startsWith(ADMIN_CORTESIA.emailPrefixo);
}

// bloqueia o check-in fisico enquanto a cortesia nao foi aprovada (ou foi
// negada). Depois que o Gerente aprovou, a entrada esta liberada mesmo que
// o card ainda esteja com o Master/Admin - a alcada seguinte e prestacao
// de contas, nao trava a operacao
function cortesiaBloqueiaEntrada(c) {
  return c.metodoPagamento === 'cortesia' && !!c.cortesiaStatus
    && ['PENDENTE', 'NEGADA'].includes(c.cortesiaStatus);
}

async function decidirCortesia(id, { nivel, aprovado, motivo, porEmail }) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Check-in não encontrado.');
  const atual = snap.data();
  if (atual.metodoPagamento !== 'cortesia' || !atual.cortesiaStatus) {
    throw new Error('Esse check-in não tem cortesia pra decidir.');
  }
  const agora = new Date().toISOString();
  const motivoOk = String(motivo || '').trim().slice(0, 300);
  let merge;
  if (nivel === 'gerente') {
    if (atual.cortesiaStatus !== 'PENDENTE') throw new Error('Essa cortesia já foi decidida.');
    merge = aprovado
      ? { cortesiaStatus: 'APROVADA_GERENTE', cortesiaAprovadaPorEmail: porEmail, cortesiaAprovadaEm: agora }
      : { cortesiaStatus: 'NEGADA', cortesiaNegadaPorEmail: porEmail, cortesiaNegadaEm: agora, cortesiaMotivoNegativa: motivoOk || null };
  } else {
    if (!['PENDENTE', 'APROVADA_GERENTE'].includes(atual.cortesiaStatus)) throw new Error('Essa cortesia já foi concluída.');
    if (aprovado) {
      merge = { cortesiaStatus: 'CONCLUIDA', cortesiaMasterEmail: porEmail, cortesiaMasterEm: agora };
    } else if (atual.cortesiaStatus === 'APROVADA_GERENTE') {
      // a entrada JA foi liberada pela Gerente - rejeitar aqui nao desfaz a
      // entrada, escala a prestacao de contas pro Admin responsavel decidir
      if (!motivoOk) throw new Error('Explique por que a justificativa do Gerente foi rejeitada.');
      merge = {
        cortesiaStatus: 'ESCALADA_ADMIN', cortesiaMasterEmail: porEmail, cortesiaMasterEm: agora,
        cortesiaMotivoRejeicao: motivoOk, cortesiaEscaladaPara: ADMIN_CORTESIA_LABEL,
      };
    } else {
      merge = { cortesiaStatus: 'NEGADA', cortesiaNegadaPorEmail: porEmail, cortesiaNegadaEm: agora, cortesiaMotivoNegativa: motivoOk || null };
    }
  }
  await ref.update({ ...merge, atualizadoEm: agora });
  parqueCache.invalidar();
  return getOne(id);
}

// palavra final do Admin responsavel (MV) num card escalado: toma ciencia
// da divergencia Gerente x Master e encerra com um parecer registrado
async function encerrarCortesia(id, { porEmail, parecer }) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Check-in não encontrado.');
  const atual = snap.data();
  if (atual.cortesiaStatus !== 'ESCALADA_ADMIN') throw new Error('Essa cortesia não está escalada pro Admin.');
  if (!String(parecer || '').trim()) throw new Error('Registre o parecer final (o que foi decidido).');
  await ref.update({
    cortesiaStatus: 'ENCERRADA',
    cortesiaEncerradaPorEmail: porEmail,
    cortesiaEncerradaEm: new Date().toISOString(),
    cortesiaParecerFinal: String(parecer).trim().slice(0, 300),
    atualizadoEm: new Date().toISOString(),
  });
  parqueCache.invalidar();
  return getOne(id);
}

// valor total de um check-in ja gravado - registros antigos (de antes do
// financeiro existir) nao tem `valor` salvo, entao recalcula pela tabela
function valorDoCheckin(c) {
  if (c.valor != null) return c.valor;
  if (c.metodoPagamento === 'cortesia') return 0;
  const qtd = (c.criancas || []).length || c.pulseiras || 0;
  return valorPorTempo(c.tempoMinutos) * qtd;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function validarHora(hora, label) {
  if (!hora || !/^\d{2}:\d{2}(:\d{2})?$/.test(hora)) throw new Error(`Informe ${label} válido.`);
  return hora.length === 5 ? `${hora}:00` : hora;
}

// soma minutos a um horario HH:MM(:SS) e devolve no mesmo formato HH:MM:SS
function somarMinutos(hora, minutos) {
  const [h, m] = hora.split(':').map(Number);
  const total = h * 60 + m + minutos;
  const hh = Math.floor((total % 1440) / 60);
  const mm = total % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`;
}

function paraMinutos(hora) {
  const [h, m] = hora.split(':').map(Number);
  return h * 60 + m;
}

// horario previsto de entrada sempre em janelas de 30 em 30 minutos
// (10:00, 10:30, 11:00...) - 10:31/10:40 nao existem na venda. O relogio
// REAL continua livre: o botao de check-in inicia na hora exata em que o
// grupo entrou (10:15, 10:22...) e o tempo contratado conta a partir dali
function validarHorarioPrevisto(hora) {
  const h = validarHora(hora, 'o horário previsto');
  const mm = h.slice(3, 5);
  if (mm !== '00' && mm !== '30') {
    throw new Error('O horário previsto vai de 30 em 30 minutos (ex: 10:00, 10:30, 11:00).');
  }
  return h;
}

const FUSO_BR = 'America/Sao_Paulo';
// hora atual em Brasilia, no formato HH:MM:SS - usada pelo botao de
// check-in (o horario que realmente conta pra pulseira e o do check-in
// fisico, nao o cadastro/pagamento que pode ter acontecido bem antes)
function horaAgoraBrasilia() {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: FUSO_BR, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const o = {};
  partes.forEach((p) => { if (p.type !== 'literal') o[p.type] = p.value; });
  const hora = o.hour === '24' ? '00' : o.hour;
  return `${hora}:${o.minute}:${o.second}`;
}

// data de hoje em Brasilia, no formato YYYY-MM-DD - usada pela varredura de
// auto check-in pra so mexer em registros do dia
function hojeBrasiliaISO() {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: FUSO_BR, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const o = {};
  partes.forEach((p) => { if (p.type !== 'literal') o[p.type] = p.value; });
  return `${o.year}-${o.month}-${o.day}`;
}

function sanitizarCriancas(lista) {
  if (!Array.isArray(lista)) return [];
  return lista
    .map((c) => ({
      nome: String((c && c.nome) || '').trim().slice(0, 120),
      dataNascimento: (c && c.dataNascimento) || null,
      // meia: true por padrao (toda crianca paga o par de R$25) - so fica
      // false quando o atendente desmarca porque a crianca ja tem a meia
      meia: !(c && c.meia === false),
      // niver NAO entra aqui - e' calculado automaticamente por data (ver
      // aplicarNiverAutomatico), nunca aceito direto do cliente
    }))
    .filter((c) => c.nome)
    .slice(0, 30);
}

// lista de minutos validos pra uma venda NOVA (check-in ou "adicionar
// tempo") - fora das categorias PCD, que tem tempoDaCategoriaPcd proprio.
// So os tempos VISIVEIS (nao ocultados pelo Master, ver "visivel" em
// getConfigPrecos) - ocultar um tempo tira ele de circulacao pra venda nova
function temposValidos(tabela) {
  return (tabela && Array.isArray(tabela.tempos) ? tabela.tempos : TEMPOS_PADRAO)
    .filter((t) => t.visivel !== false)
    .map((t) => t.minutos);
}
// lista de minutos conhecidos (visiveis OU ocultos) - usada pra EDITAR um
// check-in ja existente (atualizar()/validarPropostaEdicao()): ocultar um
// botao impede vender de novo, mas nao pode travar a correcao de uma venda
// que ja usava aquele tempo antes de ser ocultado
function temposConhecidos(tabela) {
  return (tabela && Array.isArray(tabela.tempos) ? tabela.tempos : TEMPOS_PADRAO).map((t) => t.minutos);
}

// timeInicial NAO faz mais parte do cadastro - a compra/cadastro de acesso
// costuma acontecer bem antes da pessoa efetivamente entrar (minutos ou ate
// horas depois), entao o horario que realmente conta e definido no momento
// do check-in (ver funcao checkin() abaixo), nao aqui
function validarPayload({ unidade, responsavel, dataUtilizacao, tempoMinutos, criancas }, tabela) {
  if (!unidade) throw new Error('Unidade é obrigatória.');
  if (!responsavel || !String(responsavel.nome || '').trim()) throw new Error('Informe o nome do responsável.');
  if (!responsavel.contato || !String(responsavel.contato).trim()) throw new Error('Informe o contato do responsável.');
  if (!dataUtilizacao || !/^\d{4}-\d{2}-\d{2}$/.test(dataUtilizacao)) throw new Error('Data de utilização inválida.');
  const tempo = Number(tempoMinutos);
  if (!temposValidos(tabela).includes(tempo)) throw new Error('Escolha um tempo válido.');
  const criancasOk = sanitizarCriancas(criancas);
  if (!criancasOk.length) throw new Error('Cadastre pelo menos uma criança.');
  return { tempo, criancasOk };
}

async function criar({
  unidade, unidadeNome, colaboradorId, colaboradorNome,
  responsavel, dataUtilizacao, tempoMinutos, timeInicial, horarioPrevisto,
  observacao, adultoCortesia, quantAC, criancas, usou, minutosExtras,
  metodoPagamento, pagamentos, meiasExtras, motivoCortesia, categoriaTempo, criadoPorId, criadoPorEmail,
  termoAssinado,
}) {
  const tabela = await getConfigPrecos();
  const categoriaPcd = CATEGORIAS_PCD.includes(categoriaTempo) ? categoriaTempo : null;
  // categoria oculta (Master desligou o botao) nao pode nascer numa venda
  // nova - mesma logica do tempo normal, ver temposValidos/validarPayload
  if (categoriaPcd && !categoriaPcdDisponivel(categoriaPcd, tabela)) {
    throw new Error('Essa opção não está mais disponível.');
  }
  const tempoParaValidar = categoriaPcd ? tempoDaCategoriaPcd(categoriaPcd, tabela) : tempoMinutos;
  const { tempo, criancasOk: criancasSemNiver } = validarPayload({ unidade, responsavel, dataUtilizacao, tempoMinutos: tempoParaValidar, criancas }, tabela);
  const criancasOk = aplicarNiverAutomatico(criancasSemNiver, dataUtilizacao, categoriaPcd);
  // cortesia so nasce com justificativa - e o que alimenta o card de
  // aprovacao (Gerente/Master) e a trilha de auditoria
  const ehCortesia = sanitizarMetodoPagamento(metodoPagamento) === 'cortesia';
  if (ehCortesia && !String(motivoCortesia || '').trim()) {
    throw new Error('Cortesia exige justificativa: explique o motivo da entrada sem cobrança.');
  }
  const meiasExtrasOk = Math.max(0, Math.min(30, num(meiasExtras)));
  const valorMeiasCalc = categoriaPcd === 'pcd-cortesia' ? 0 : valorMeias(criancasOk, meiasExtrasOk);
  const valorUnitario = categoriaPcd ? valorUnitarioPcd(categoriaPcd, tabela) : valorPorTempo(tempo, tabela);
  const valorFinal = (categoriaPcd === 'pcd-cortesia' || ehCortesia)
    ? 0
    : valorEntradaCriancas(criancasOk, valorUnitario, tempo, tabela) + valorMeiasCalc;
  // divide o valor entre mais de uma forma de pagamento - servidor sempre
  // revalida a soma (o front so ajuda o atendente a nao errar): tem que
  // bater exatamente com valorFinal, nunca menos nem mais
  let pagamentosOk = [];
  if (valorFinal > 0) {
    pagamentosOk = sanitizarPagamentos(pagamentos);
    if (!pagamentosOk.length) throw new Error('Informe pelo menos uma forma de pagamento.');
    const somaPagamentos = Math.round(pagamentosOk.reduce((s, p) => s + p.valor, 0) * 100) / 100;
    if (Math.abs(somaPagamentos - valorFinal) > 0.01) {
      throw new Error(`A soma das formas de pagamento (R$${somaPagamentos.toFixed(2)}) precisa bater com o valor total (R$${valorFinal.toFixed(2)}).`);
    }
  }
  // minutosExtras: credito de tempo guardado de um checkout antecipado
  // anterior (ver checkout()/usarCredito() abaixo) - soma por cima do
  // tempo contratado normal, nao muda o "bucket" escolhido (temposValidos)
  const extras = Math.max(0, Math.min(240, num(minutosExtras)));
  // timeInicial e opcional na criacao (usado so pela importacao da planilha
  // antiga, que ja tem o horario real de visitas que ja aconteceram) - no
  // fluxo normal do formulario isso fica em branco ate o check-in
  const inicio = timeInicial ? validarHora(timeInicial, 'o horário inicial') : null;
  // horario previsto: definido na hora da venda ("a pessoa pretende entrar
  // as X"). Se o check-in manual (botao "Fazer check-in") acontecer antes
  // desse horario, tudo bem, o relogio comeca no horario real do check-in
  // normalmente. Se ninguem fizer o check-in ate esse horario, o sistema
  // inicia sozinho NESSE horario e avisa a equipe (ver rodarAutoCheckins)
  const previsto = horarioPrevisto ? validarHorarioPrevisto(horarioPrevisto) : null;

  // PCD cortesia: no maximo 2 criancas por hora-relogio, por unidade - nao
  // bloqueia via card de aprovacao, so recusa a venda e avisa Gerente+Master
  if (categoriaPcd === 'pcd-cortesia') {
    if (!previsto) throw new Error('Informe o horário previsto de entrada para aplicar a cortesia PCD.');
    const horaBucket = previsto.slice(0, 2);
    const existentes = await listAll();
    const usadosNaHora = existentes
      .filter((c) => c.unidade === unidade && c.dataUtilizacao === dataUtilizacao
        && c.categoriaTempo === 'pcd-cortesia' && String(c.horarioPrevisto || '').slice(0, 2) === horaBucket)
      .reduce((soma, c) => soma + (c.criancas || []).length, 0);
    if (usadosNaHora + criancasOk.length > PCD_CORTESIA_LIMITE_HORA) {
      require('./push').notifyParquePcdCortesiaLimite({
        unidade, unidadeNome: unidadeNome || unidade, horaBucket, dataUtilizacao,
      }).catch(() => {});
      throw new Error(`As ${PCD_CORTESIA_LIMITE_HORA} vagas de cortesia PCD desse horário (${horaBucket}:00–${horaBucket}:59) já foram usadas.`);
    }
  }

  const ref = COLLECTION.doc();
  const registro = {
    id: ref.id,
    unidade,
    unidadeNome: unidadeNome || unidade,
    colaboradorId: colaboradorId || criadoPorId,
    colaboradorNome: colaboradorNome || criadoPorEmail,
    responsavel: {
      nome: String(responsavel.nome).trim().slice(0, 150),
      cpf: String(responsavel.cpf || '').trim().slice(0, 20),
      contato: String(responsavel.contato).trim().slice(0, 30),
      email: String(responsavel.email || '').trim().slice(0, 150),
      // separa CEP/endereco caso venha tudo junto no campo CEP (padrao do
      // app antigo - ver separarCepEndereco)
      cep: separarCepEndereco(responsavel.cep, responsavel.endereco).cep.slice(0, 20),
      endereco: separarCepEndereco(responsavel.cep, responsavel.endereco).endereco.slice(0, 300),
      numero: String(responsavel.numero || '').trim().slice(0, 20),
      complemento: String(responsavel.complemento || '').trim().slice(0, 100),
    },
    dataUtilizacao,
    tempoMinutos: tempo,
    minutosExtras: extras,
    timeInicial: inicio,
    timeFinal: inicio ? somarMinutos(inicio, tempo + extras) : null,
    iniciado: !!inicio,
    horarioPrevisto: previsto,
    autoCheckin: false, // vira true so se o check-in for disparado pela varredura (ver rodarAutoCheckins)
    observacao: String(observacao || '').slice(0, 300),
    adultoCortesia: adultoCortesia === true,
    quantAC: adultoCortesia === true ? Math.max(0, Math.min(10, num(quantAC) || 1)) : 0,
    criancas: criancasOk,
    pulseiras: criancasOk.length,
    // financeiro: valor pela tabela (por pulseira) + meias (R$25 por crianca
    // optante + pares extras) + forma de pagamento - 'cortesia' registra a
    // entrada com valor zero. PCD-cortesia (botao "5%CP") e' gratuidade
    // automatica, sem alcada - forcado no servidor pra nunca virar 'misto'
    // (sem pagamentos pra somar) nem se confundir com a cortesia normal
    // (que exige aprovacao Gerente/Master, ver bloco acima)
    metodoPagamento: categoriaPcd === 'pcd-cortesia' ? 'gratuidade' : sanitizarMetodoPagamento(metodoPagamento),
    // divisao entre formas de pagamento (ver sanitizarPagamentos acima) -
    // so fica vazio quando a entrada e' gratis (cortesia ou pcd-cortesia)
    pagamentos: pagamentosOk,
    // categoriaTempo: pcd30/pcd60/pcd-cortesia (ver bloco PCD acima) - override
    // de preco independente do metodoPagamento escolhido; null = tabela normal
    categoriaTempo: categoriaPcd,
    valorPulseira: valorUnitario,
    meiasExtras: meiasExtrasOk,
    valorMeias: valorMeiasCalc,
    valor: valorFinal,
    // tempo comprado DEPOIS da entrada, durante a vigencia (ver
    // adicionarTempo) - nao muda o bucket contratado, soma por cima
    minutosAdicionados: 0,
    acrescimos: [],
    // cortesia entra em fluxo de aprovacao (ver decidirCortesia acima)
    cortesiaStatus: ehCortesia ? 'PENDENTE' : null,
    motivoCortesia: ehCortesia ? String(motivoCortesia).trim().slice(0, 300) : null,
    usou: usou !== false,
    // O termo agora e assinado ANTES de efetivar a venda (o atendente
    // imprime pela previa, colhe a assinatura e clica em "Aplicar" - ver
    // parque-checkin.html). Quando isso acontece a venda ja nasce com o
    // termo assinado. Continua aceitando false pro caminho antigo, em que
    // o termo era impresso depois e marcado pelo botao "Confirmar termo
    // assinado" - os dois convivem.
    termoAssinado: termoAssinado === true,
    criadoPorId,
    criadoPorEmail,
    criadoEm: new Date().toISOString(),
  };
  await ref.set(registro);
  parqueCache.invalidar();
  return registro;
}

// aciona o relogio de verdade: a pulseira/tempo contratado passa a valer a
// partir de AGORA, nao do horario em que a compra/cadastro foi feita
async function checkin(id) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Check-in não encontrado.');
  const atual = snap.data();
  if (cortesiaBloqueiaEntrada(atual)) {
    throw new Error(atual.cortesiaStatus === 'NEGADA'
      ? 'Cortesia negada - troque a forma de pagamento pra liberar a entrada.'
      : 'Cortesia aguardando aprovação do Gerente da unidade ou do Master.');
  }
  const inicio = horaAgoraBrasilia();
  const merge = {
    timeInicial: inicio,
    timeFinal: somarMinutos(inicio, atual.tempoMinutos + (atual.minutosExtras || 0) + (atual.minutosAdicionados || 0)),
    iniciado: true,
    checkinEm: new Date().toISOString(),
  };
  await ref.update(merge);
  parqueCache.invalidar();
  return getOne(id);
}

// compra de tempo extra DURANTE a vigencia: o grupo ja esta dentro e quer
// ficar mais. Cobra so o tempo adicional pela tabela (x criancas) - as
// meias NAO sao cobradas de novo (ja estao com as do check-in original,
// compradas ou proprias). Estende o timeFinal na hora e registra o
// acrescimo em separado pro financeiro
async function adicionarTempo(id, { minutos, metodoPagamento, porEmail }) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Check-in não encontrado.');
  const atual = snap.data();
  const tabela = await getConfigPrecos();
  const min = Number(minutos);
  if (!temposValidos(tabela).includes(min)) throw new Error('Escolha um tempo válido pra adicionar.');
  if (!atual.iniciado || !atual.timeFinal) throw new Error('Esse check-in ainda não teve o check-in físico feito.');
  if (atual.checkoutEm) throw new Error('Esse check-in já teve check-out.');
  const hoje = hojeBrasiliaISO();
  const agora = horaAgoraBrasilia();
  const vigente = atual.dataUtilizacao === hoje && atual.timeFinal > agora;
  if (!vigente) throw new Error('O tempo desse check-in já acabou. Use o Relançar (mesmo dia) pra uma nova entrada.');

  const metodo = sanitizarMetodoPagamento(metodoPagamento) || atual.metodoPagamento || null;
  const qtd = (atual.criancas || []).length || atual.pulseiras || 0;
  const valorAcrescimo = metodo === 'cortesia' ? 0 : valorPorTempo(min, tabela) * qtd;
  const acrescimo = {
    minutos: min,
    valor: valorAcrescimo,
    metodoPagamento: metodo,
    porEmail: porEmail || null,
    em: new Date().toISOString(),
  };
  await ref.update({
    minutosAdicionados: (atual.minutosAdicionados || 0) + min,
    timeFinal: somarMinutos(atual.timeFinal, min),
    acrescimos: [...(atual.acrescimos || []), acrescimo],
    valor: (valorDoCheckin(atual) || 0) + valorAcrescimo,
    atualizadoEm: new Date().toISOString(),
  });
  parqueCache.invalidar();
  return getOne(id);
}

// o tempo ja ACABOU mas ainda e o mesmo dia e a familia quer voltar a
// brincar: relanca tudo como uma NOVA compra (paga de novo pela tabela),
// reaproveitando o Termo de Responsabilidade assinado na compra anterior -
// valido SO pra compras no mesmo dia. As meias nao entram na nova conta:
// as criancas ja estao com as meias da primeira entrada (compradas ou
// proprias)
async function relancar(idOrigem, { tempoMinutos, metodoPagamento, horarioPrevisto, criadoPorId, criadoPorEmail }) {
  const origem = await getOne(idOrigem);
  if (!origem) throw new Error('Check-in não encontrado.');
  const hoje = hojeBrasiliaISO();
  if (origem.dataUtilizacao !== hoje) {
    throw new Error('O Relançar só vale pra visitas do MESMO dia. Pra outro dia é um cadastro novo, com termo novo.');
  }
  const novo = await criar({
    unidade: origem.unidade,
    unidadeNome: origem.unidadeNome,
    responsavel: origem.responsavel,
    dataUtilizacao: hoje,
    tempoMinutos,
    horarioPrevisto,
    observacao: origem.observacao,
    adultoCortesia: origem.adultoCortesia,
    quantAC: origem.quantAC,
    criancas: (origem.criancas || []).map((c) => ({ ...c, meia: false })),
    meiasExtras: 0,
    metodoPagamento,
    colaboradorId: criadoPorId,
    colaboradorNome: criadoPorEmail,
    criadoPorId,
    criadoPorEmail,
  });
  await COLLECTION.doc(novo.id).update({
    relancadoDe: idOrigem,
    // o termo so e reaproveitado se a compra original realmente teve o
    // termo assinado - senao o novo registro segue o fluxo normal
    termoAssinado: origem.termoAssinado === true,
    termoReaproveitado: origem.termoAssinado === true,
  });
  parqueCache.invalidar();
  return getOne(novo.id);
}

// pro fluxo do Relançar no balcao: o atendente digita o CPF e o sistema ja
// avisa se esse responsavel teve visita HOJE (e se o tempo dela ja acabou)
async function visitaHojePorCpf(cpf) {
  const alvo = soDigitos(cpf);
  if (!alvo) return null;
  const hoje = hojeBrasiliaISO();
  const todos = await listAll();
  const deHoje = todos.filter((c) => c.dataUtilizacao === hoje && soDigitos(c.responsavel?.cpf) === alvo);
  if (!deHoje.length) return null;
  deHoje.sort((a, b) => (b.criadoEm || '').localeCompare(a.criadoEm || ''));
  const v = deHoje[0];
  const agora = horaAgoraBrasilia();
  return {
    id: v.id,
    responsavelNome: v.responsavel?.nome || '',
    unidade: v.unidade,
    timeInicial: v.timeInicial,
    timeFinal: v.timeFinal,
    iniciado: !!v.iniciado,
    criancas: (v.criancas || []).length,
    termoAssinado: v.termoAssinado === true,
    tempoEsgotado: !!(v.iniciado && v.timeFinal && v.timeFinal <= agora),
  };
}

async function listAllUncached() {
  const snap = await COLLECTION.orderBy('dataUtilizacao', 'desc').get();
  return snap.docs.map((d) => d.data());
}
// TTL de 5 min: o balcao do parque consulta essa lista a cada 30s (relogio
// regressivo + popup de tempo esgotado), e cada refresh do cache rele a
// COLECAO INTEIRA (historico importado incluso). Com 20s de TTL isso virava
// milhoes de leituras/dia no Firestore. Toda mutacao daqui invalida o cache
// na hora (servidor de instancia unica), entao o TTL so limita releitura de
// dado que NAO mudou - pode ser folgado sem atrasar nada nas telas
const parqueCache = createCache(listAllUncached, 5 * 60 * 1000);
const listAll = parqueCache.cached;

// filtra EM MEMORIA sobre o cache compartilhado - antes era uma query direta
// no Firestore (where unidade in ...) SEM cache, disparada a cada poll de
// 30s do balcao: sozinha, foi a principal fonte do estouro de leituras
async function listByUnidades(unidades) {
  if (!unidades || !unidades.length) return [];
  const alvo = new Set(unidades);
  return (await listAll()).filter((c) => alvo.has(c.unidade));
}

// soma o faturamento do parque num dia: total (ja inclui acrescimos de tempo
// extra, ver adicionarTempo - o `valor` do check-in ja soma tudo) + o
// breakdown por forma de pagamento, juntando o `pagamentos[]` de cada
// check-in (split da entrada) com o `metodoPagamento` de cada acrescimo (nao
// e dividido, e' uma forma so por acrescimo). Cortesia (valor 0) nao
// contribui em nada, entao nem precisa de tratamento especial. Usado pelo
// fechamento dedicado do Saltiverso - ver saltiversoFechamento.js
async function resumoDoDia(unidade, data) {
  const checkins = (await listAll()).filter((c) => c.unidade === unidade && c.dataUtilizacao === data);
  const porForma = {};
  FORMAS_PAGAMENTO_SPLIT.forEach((f) => { porForma[f] = 0; });
  let total = 0;
  checkins.forEach((c) => {
    total += num(c.valor);
    (c.pagamentos || []).forEach((p) => {
      if (porForma[p.forma] != null) porForma[p.forma] += num(p.valor);
    });
    (c.acrescimos || []).forEach((a) => {
      if (a.metodoPagamento && porForma[a.metodoPagamento] != null) porForma[a.metodoPagamento] += num(a.valor);
    });
  });
  Object.keys(porForma).forEach((f) => { porForma[f] = Math.round(porForma[f] * 100) / 100; });
  return { total: Math.round(total * 100) / 100, porForma };
}

async function getOne(id) {
  const doc = await COLLECTION.doc(id).get();
  return doc.exists ? doc.data() : null;
}

async function atualizar(id, patch) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Check-in não encontrado.');
  const atual = snap.data();
  const tabela = await getConfigPrecos();
  const merge = {};

  if (patch.responsavel) {
    merge.responsavel = { ...atual.responsavel, ...patch.responsavel };
  }
  if (patch.dataUtilizacao !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(patch.dataUtilizacao)) throw new Error('Data inválida.');
    merge.dataUtilizacao = patch.dataUtilizacao;
  }
  const tempo = patch.tempoMinutos !== undefined ? Number(patch.tempoMinutos) : atual.tempoMinutos;
  if (patch.tempoMinutos !== undefined) {
    // correcao de um registro ja existente - aceita tempo oculto (ver
    // temposConhecidos), diferente da venda nova (criar()/adicionarTempo())
    if (!temposConhecidos(tabela).includes(tempo)) throw new Error('Escolha um tempo válido.');
    merge.tempoMinutos = tempo;
  }
  if (patch.timeInicial !== undefined) {
    merge.timeInicial = validarHora(patch.timeInicial, 'o horário inicial');
    merge.iniciado = true; // ajuste manual do Master tambem conta como check-in feito
  }
  const extras = patch.minutosExtras !== undefined ? Math.max(0, Math.min(240, num(patch.minutosExtras))) : (atual.minutosExtras || 0);
  if (patch.minutosExtras !== undefined) merge.minutosExtras = extras;
  if (patch.timeInicial !== undefined || patch.tempoMinutos !== undefined || patch.minutosExtras !== undefined) {
    const inicioBase = merge.timeInicial || atual.timeInicial;
    if (inicioBase) merge.timeFinal = somarMinutos(inicioBase, tempo + extras + (atual.minutosAdicionados || 0));
  }
  if (patch.observacao !== undefined) merge.observacao = String(patch.observacao).slice(0, 300);
  if (patch.adultoCortesia !== undefined) {
    merge.adultoCortesia = patch.adultoCortesia === true;
    merge.quantAC = merge.adultoCortesia ? Math.max(0, Math.min(10, num(patch.quantAC) || 1)) : 0;
  }
  if (patch.criancas !== undefined) {
    const criancasOk = sanitizarCriancas(patch.criancas);
    if (!criancasOk.length) throw new Error('Cadastre pelo menos uma criança.');
    merge.criancas = criancasOk;
    merge.pulseiras = criancasOk.length;
  }
  if (patch.metodoPagamento !== undefined) {
    merge.metodoPagamento = sanitizarMetodoPagamento(patch.metodoPagamento);
    // virou cortesia numa correcao: entra no fluxo de aprovacao do zero;
    // deixou de ser cortesia: o card morre junto
    if (merge.metodoPagamento === 'cortesia' && atual.metodoPagamento !== 'cortesia') {
      merge.cortesiaStatus = 'PENDENTE';
      merge.motivoCortesia = String(patch.motivoCortesia || '').trim().slice(0, 300) || 'alterado pra cortesia via correção';
    } else if (merge.metodoPagamento !== 'cortesia' && atual.metodoPagamento === 'cortesia') {
      merge.cortesiaStatus = null;
    }
  }
  if (patch.meiasExtras !== undefined) merge.meiasExtras = Math.max(0, Math.min(30, num(patch.meiasExtras)));
  // o valor acompanha a tabela: recalcula sempre que tempo, criancas, meias,
  // forma de pagamento OU a data de utilizacao mudarem (cortesia zera; a
  // data entra porque o niver automatico depende dela - ver
  // aplicarNiverAutomatico). Registros de antes das meias existirem (sem
  // valorMeias salvo) continuam sem cobranca de meia - uma correcao de
  // dados nao pode inflar um valor que ja foi pago. categoriaTempo (PCD) nao
  // e editavel por correcao, entao usa sempre o que ja estava salvo.
  if (patch.tempoMinutos !== undefined || patch.criancas !== undefined || patch.metodoPagamento !== undefined || patch.meiasExtras !== undefined || patch.dataUtilizacao !== undefined) {
    const metodoFinal = patch.metodoPagamento !== undefined ? merge.metodoPagamento : (atual.metodoPagamento || null);
    const dataUtilizacaoFinal = merge.dataUtilizacao !== undefined ? merge.dataUtilizacao : atual.dataUtilizacao;
    const criancasFinais = aplicarNiverAutomatico(merge.criancas || atual.criancas || [], dataUtilizacaoFinal, atual.categoriaTempo);
    merge.criancas = criancasFinais;
    const cobraMeias = atual.valorMeias != null || patch.meiasExtras !== undefined;
    const meiasExtrasFinais = merge.meiasExtras !== undefined ? merge.meiasExtras : (atual.meiasExtras || 0);
    merge.valorPulseira = valorPorTempo(tempo, tabela);
    merge.valorMeias = cobraMeias ? valorMeias(criancasFinais, meiasExtrasFinais) : (atual.valorMeias || 0);
    const somaAcrescimos = (atual.acrescimos || []).reduce((s, a) => s + (Number(a.valor) || 0), 0);
    merge.valor = metodoFinal === 'cortesia' ? 0 : valorEntradaCriancas(criancasFinais, merge.valorPulseira, tempo, tabela) + merge.valorMeias + somaAcrescimos;
  }
  if (patch.usou !== undefined) merge.usou = patch.usou === true;
  if (patch.termoAssinado !== undefined) merge.termoAssinado = patch.termoAssinado === true;
  if (patch.horarioPrevisto !== undefined) {
    merge.horarioPrevisto = patch.horarioPrevisto ? validarHorarioPrevisto(patch.horarioPrevisto) : null;
  }

  merge.atualizadoEm = new Date().toISOString();
  await ref.update(merge);
  parqueCache.invalidar();
  return getOne(id);
}

// varredura periodica (ver index.js): pra cada check-in do dia que ainda nao
// foi feito manualmente e ja passou do horarioPrevisto, inicia o relogio
// sozinha NESSE horario (nao no horario em que a varredura rodou, pra nao
// prejudicar o tempo contratado por atraso do job) e marca autoCheckin=true
// pra equipe saber que ninguem confirmou a entrada fisica
async function rodarAutoCheckins() {
  const hoje = hojeBrasiliaISO();
  const agora = horaAgoraBrasilia();
  // filtra o DIA ja na query: cadastro antigo que nunca iniciou ficava sendo
  // relido a cada varredura (1x/min) pra sempre - com o filtro de data a
  // leitura fica no tamanho do dia, nao do acumulado
  const snap = await COLLECTION.where('iniciado', '==', false).where('dataUtilizacao', '==', hoje).get();
  const feitos = [];
  for (const doc of snap.docs) {
    const c = doc.data();
    if (!c.horarioPrevisto || c.dataUtilizacao !== hoje) continue;
    if (c.horarioPrevisto > agora) continue;
    // cortesia sem aprovacao nao entra sozinha - o relogio so pode iniciar
    // depois que o Gerente/Master liberar
    if (cortesiaBloqueiaEntrada(c)) continue;
    const merge = {
      timeInicial: c.horarioPrevisto,
      timeFinal: somarMinutos(c.horarioPrevisto, c.tempoMinutos + (c.minutosExtras || 0) + (c.minutosAdicionados || 0)),
      iniciado: true,
      autoCheckin: true,
      checkinEm: new Date().toISOString(),
    };
    // eslint-disable-next-line no-await-in-loop
    await doc.ref.update(merge);
    feitos.push({ ...c, ...merge });
  }
  if (feitos.length) parqueCache.invalidar();
  return feitos;
}

async function remover(id) {
  const snap = await COLLECTION.doc(id).get();
  if (!snap.exists) throw new Error('Check-in não encontrado.');
  await COLLECTION.doc(id).delete();
  parqueCache.invalidar();
}

// monta a proposta de alteracao com os mesmos criterios de atualizar() -
// validar aqui (na hora do pedido) evita aprovar uma proposta que depois
// falharia na aplicacao. Devolve so os campos que a proposta realmente muda
function validarPropostaEdicao(proposta, tabela) {
  if (!proposta || typeof proposta !== 'object') throw new Error('Preencha a proposta de alteração.');
  const p = {};
  if (proposta.responsavel && typeof proposta.responsavel === 'object') {
    const r = {};
    if (proposta.responsavel.nome !== undefined) {
      const nome = String(proposta.responsavel.nome).trim().slice(0, 150);
      if (!nome) throw new Error('Informe o nome do responsável.');
      r.nome = nome;
    }
    if (proposta.responsavel.contato !== undefined) r.contato = String(proposta.responsavel.contato).trim().slice(0, 30);
    if (Object.keys(r).length) p.responsavel = r;
  }
  if (proposta.dataUtilizacao !== undefined && proposta.dataUtilizacao !== null && proposta.dataUtilizacao !== '') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(proposta.dataUtilizacao)) throw new Error('Data inválida.');
    p.dataUtilizacao = proposta.dataUtilizacao;
  }
  if (proposta.tempoMinutos !== undefined && proposta.tempoMinutos !== null && proposta.tempoMinutos !== '') {
    const tempo = Number(proposta.tempoMinutos);
    // proposta de correcao, nao venda nova - aceita tempo oculto (ver
    // temposConhecidos/atualizar)
    if (!temposConhecidos(tabela).includes(tempo)) throw new Error('Escolha um tempo válido.');
    p.tempoMinutos = tempo;
  }
  if (proposta.horarioPrevisto !== undefined) {
    p.horarioPrevisto = proposta.horarioPrevisto ? validarHorarioPrevisto(proposta.horarioPrevisto) : null;
  }
  if (proposta.metodoPagamento !== undefined) p.metodoPagamento = sanitizarMetodoPagamento(proposta.metodoPagamento);
  if (proposta.observacao !== undefined) p.observacao = String(proposta.observacao).slice(0, 300);
  if (proposta.adultoCortesia !== undefined) {
    p.adultoCortesia = proposta.adultoCortesia === true;
    p.quantAC = p.adultoCortesia ? Math.max(0, Math.min(10, num(proposta.quantAC) || 1)) : 0;
  }
  if (proposta.criancas !== undefined) {
    const criancasOk = sanitizarCriancas(proposta.criancas);
    if (!criancasOk.length) throw new Error('Cadastre pelo menos uma criança.');
    p.criancas = criancasOk;
  }
  if (!Object.keys(p).length) throw new Error('A proposta não altera nada.');
  return p;
}

// pedido de correcao: 'alterar' (aplica a proposta de mudanca nos dados,
// nas criancas etc.) ou 'excluir' (remove o registro inteiro). Nada muda
// ate alguem aprovar em decidirEdicao() - quem decide e o Gerente da
// unidade ou o Master/Admin (checado no index.js). Todo pedido tambem vira
// um Ticket na Central pro Master dar a palavra final (prestacao de
// contas), mesmo quando o Gerente ja aprovou pra agilizar
async function solicitarEdicao({ checkinId, tipoCorrecao, proposta, motivo, numeroTicket, ticketId, solicitadoPorId, solicitadoPorEmail }) {
  const atual = await getOne(checkinId);
  if (!atual) throw new Error('Check-in não encontrado.');
  if (!motivo || !String(motivo).trim()) throw new Error('Descreva o motivo da correção.');
  const tipo = tipoCorrecao === 'alterar' ? 'alterar' : 'excluir';
  const propostaOk = tipo === 'alterar' ? validarPropostaEdicao(proposta, await getConfigPrecos()) : null;
  const pendentes = await listarEdicoes();
  if (pendentes.some((p) => p.checkinId === checkinId && p.status === 'PENDENTE')) {
    throw new Error('Já existe um pedido de correção pendente para esse check-in.');
  }

  const ref = EDITS.doc();
  const pedido = {
    id: ref.id,
    checkinId,
    tipoCorrecao: tipo,
    proposta: propostaOk,
    unidade: atual.unidade,
    unidadeNome: atual.unidadeNome,
    responsavelNome: atual.responsavel?.nome || '',
    dataUtilizacao: atual.dataUtilizacao,
    motivo: String(motivo).trim(),
    numeroTicket: numeroTicket || null,
    ticketId: ticketId || null,
    status: 'PENDENTE',
    solicitadoPorId,
    solicitadoPorEmail,
    criadoEm: new Date().toISOString(),
    decididoPorEmail: null,
    decididoPorGerente: false,
    decididoEm: null,
    motivoDecisao: null,
  };
  await ref.set(pedido);
  edicoesParqueCache.invalidar();
  return pedido;
}

async function listarEdicoesUncached() {
  const snap = await EDITS.orderBy('criadoEm', 'desc').get();
  return snap.docs.map((d) => d.data());
}
const edicoesParqueCache = createCache(listarEdicoesUncached, 5 * 60 * 1000);
const listarEdicoes = edicoesParqueCache.cached;

// decididoPorGerente marca quando quem aprovou foi um Gerente da unidade
// (nao Master/Admin) - a mudanca aplica na hora pra agilizar a operacao,
// mas o Gerente presta contas: o Ticket do pedido fica com o Master pra
// palavra final (ver rota de decisao no index.js)
async function decidirEdicao(id, status, { decididoPorEmail, motivoDecisao, decididoPorGerente }) {
  if (!['APROVADO', 'REJEITADO'].includes(status)) throw new Error('Status inválido.');
  const ref = EDITS.doc(id);
  const doc = await ref.get();
  if (!doc.exists) throw new Error('Pedido não encontrado.');
  const pedido = doc.data();
  if (pedido.status !== 'PENDENTE') throw new Error('Esse pedido já foi decidido.');

  await ref.update({
    status,
    decididoPorEmail,
    decididoPorGerente: decididoPorGerente === true,
    motivoDecisao: motivoDecisao || null,
    decididoEm: new Date().toISOString(),
  });
  edicoesParqueCache.invalidar();

  let checkinAtualizado = null;
  if (status === 'APROVADO') {
    if (pedido.tipoCorrecao === 'alterar') {
      checkinAtualizado = await atualizar(pedido.checkinId, pedido.proposta || {});
    } else {
      await remover(pedido.checkinId);
    }
  }
  return { ...pedido, status, decididoPorEmail, decididoPorGerente: decididoPorGerente === true, checkinAtualizado };
}

function soDigitos(v) {
  return String(v || '').replace(/\D/g, '');
}

// checkout antecipado (emergencia): a familia precisa sair antes do tempo
// contratado acabar. Para o relogio NESSE momento (a crianca ja nao conta
// mais como "no parque agora"), mas o credito do tempo que sobrou so vira
// de verdade quando um Gerente da unidade (ou Master/Admin) aprova - ver
// aprovarCheckout() (quem aprova e checado no index.js, na camada de
// permissao). Enquanto pendente, da pra desfazer com retomarCheckout() se
// a crianca voltar a brincar antes de alguem decidir
async function checkout(id, { motivo } = {}) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Check-in não encontrado.');
  const atual = snap.data();
  if (!atual.iniciado) throw new Error('Esse check-in ainda não teve o check-in físico feito.');
  if (atual.checkoutEm) throw new Error('Esse check-in já teve o check-out registrado.');
  const agora = horaAgoraBrasilia();
  // PCD cortesia (5%CP): o check-out so encerra a visita, nunca guarda o
  // tempo que sobrou como credito (a entrada foi gratuita, nao ha "compra"
  // pra reaproveitar depois) - por isso nao entra na fila de aprovacao do
  // Gerente, ja fecha aprovado direto
  const ehPcdCortesia = atual.categoriaTempo === 'pcd-cortesia';
  const restanteMin = ehPcdCortesia ? 0 : Math.max(0, paraMinutos(atual.timeFinal) - paraMinutos(agora));
  const merge = {
    checkoutEm: new Date().toISOString(),
    checkoutAntecipado: !ehPcdCortesia && restanteMin > 0,
    tempoRestanteMin: restanteMin,
    motivoCheckout: String(motivo || '').trim().slice(0, 300),
    checkoutAprovado: ehPcdCortesia,
    checkoutAprovadoPorEmail: ehPcdCortesia ? 'sistema (PCD cortesia · sem crédito)' : null,
    checkoutAprovadoEm: ehPcdCortesia ? new Date().toISOString() : null,
  };
  await ref.update(merge);
  parqueCache.invalidar();
  return getOne(id);
}

// Gerente da unidade (ou Master/Admin) confirma a saida antecipada - so ai
// o tempo que sobrou vira credito de fato pro CPF (registrarCredito)
async function aprovarCheckout(id, { aprovadoPorEmail }) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Check-in não encontrado.');
  const atual = snap.data();
  if (!atual.checkoutEm) throw new Error('Esse check-in não tem check-out pendente.');
  if (atual.checkoutAprovado) throw new Error('Esse check-out já foi aprovado.');
  await ref.update({
    checkoutAprovado: true,
    checkoutAprovadoPorEmail: aprovadoPorEmail,
    checkoutAprovadoEm: new Date().toISOString(),
  });
  parqueCache.invalidar();
  if (atual.tempoRestanteMin > 0 && atual.responsavel?.cpf) {
    await registrarCredito(atual.responsavel.cpf, atual.tempoRestanteMin, id);
  }
  return getOne(id);
}

// a crianca voltou a brincar antes do checkout ser aprovado - desfaz o
// checkout e retoma o relogio com EXATAMENTE o tempo que sobrava no
// momento da saida (a pausa nao conta contra o tempo contratado)
async function retomarCheckout(id) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Check-in não encontrado.');
  const atual = snap.data();
  if (!atual.checkoutEm) throw new Error('Esse check-in não está com check-out pendente.');
  if (atual.checkoutAprovado) throw new Error('Esse check-out já foi aprovado e não pode mais ser desfeito.');
  const agora = horaAgoraBrasilia();
  await ref.update({
    timeFinal: somarMinutos(agora, atual.tempoRestanteMin || 0),
    checkoutEm: null,
    checkoutAntecipado: false,
    tempoRestanteMin: null,
    motivoCheckout: null,
    checkoutAprovado: false,
    checkoutAprovadoPorEmail: null,
    checkoutAprovadoEm: null,
  });
  parqueCache.invalidar();
  return getOne(id);
}

async function registrarCredito(cpf, minutos, origemCheckinId) {
  const chave = soDigitos(cpf);
  if (!chave || minutos <= 0) return;
  const ref = CREDITOS.doc(chave);
  const snap = await ref.get();
  const atual = snap.exists ? snap.data() : { cpf: chave, minutosDisponiveis: 0, historico: [] };
  await ref.set({
    cpf: chave,
    minutosDisponiveis: (atual.minutosDisponiveis || 0) + minutos,
    historico: [...(atual.historico || []), { minutos, origemCheckinId, criadoEm: new Date().toISOString() }].slice(-30),
    atualizadoEm: new Date().toISOString(),
  });
}

async function creditoPorCpf(cpf) {
  const chave = soDigitos(cpf);
  if (!chave) return null;
  const doc = await CREDITOS.doc(chave).get();
  if (!doc.exists || !(doc.data().minutosDisponiveis > 0)) return null;
  return doc.data();
}

// consome (parte d)o credito guardado - chamado quando um novo check-in
// aplica esse tempo (ver minutosExtras em criar()); minutos e sempre o que
// realmente vai ser aplicado, nunca mais do que o disponivel
async function usarCredito(cpf, minutos) {
  const chave = soDigitos(cpf);
  if (!chave) throw new Error('CPF inválido.');
  const ref = CREDITOS.doc(chave);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Esse cliente não tem crédito de tempo guardado.');
  const atual = snap.data();
  const usar = Math.max(0, Math.min(Number(minutos) || 0, atual.minutosDisponiveis || 0));
  if (usar <= 0) throw new Error('Nenhum crédito de tempo disponível pra esse CPF.');
  await ref.update({ minutosDisponiveis: atual.minutosDisponiveis - usar, atualizadoEm: new Date().toISOString() });
  return usar;
}

// o app antigo (AppSheet) guardava o ENDERECO INTEIRO no campo CEP
// ("R. Três - Janga, Paulista - PE, 53439-520, Brasil") - separa: o codigo
// vai pro CEP e o resto vira o endereco (sem o "Brasil" do final). CEP ja
// limpo passa direto, e um endereco ja preenchido nunca e sobrescrito.
function separarCepEndereco(cepBruto, enderecoAtual) {
  const bruto = String(cepBruto || '').trim();
  const endereco = String(enderecoAtual || '').trim();
  if (!bruto || /^\d{5}-?\d{3}$/.test(bruto)) return { cep: bruto, endereco };
  const m = bruto.match(/(\d{5})-?(\d{3})/);
  const cep = m ? `${m[1]}-${m[2]}` : '';
  const resto = bruto.replace(m ? m[0] : '', '')
    .split(',').map((p) => p.trim()).filter((p) => p && !/^brasil\.?$/i.test(p))
    .join(', ');
  return { cep, endereco: endereco || resto };
}

// pra autopreenchimento do formulario de check-in: acha o cadastro mais
// recente com o mesmo CPF (comparando so os digitos, ja que a planilha
// importada tem CPF as vezes com pontuacao e as vezes sem)
async function buscarPorCpf(cpf) {
  const alvo = soDigitos(cpf);
  if (!alvo) return null;
  const todos = await listAll();
  const encontrados = todos.filter((c) => soDigitos(c.responsavel?.cpf) === alvo);
  if (!encontrados.length) return null;
  encontrados.sort((a, b) => (b.criadoEm || '').localeCompare(a.criadoEm || ''));
  // registros importados do app antigo podem ter o endereco inteiro dentro
  // do CEP - normaliza aqui pra cada campo cair no lugar certo do formulario
  const achado = encontrados[0];
  const sep = separarCepEndereco(achado.responsavel?.cep, achado.responsavel?.endereco);
  return { ...achado, responsavel: { ...achado.responsavel, ...sep } };
}

module.exports = {
  METODOS_PAGAMENTO, FORMAS_PAGAMENTO_SPLIT, PRECO_MEIA, valorPorTempo, valorDoCheckin,
  getConfigPrecos, salvarConfigPrecos,
  criar, checkin, listAll, listByUnidades, resumoDoDia, getOne, atualizar, buscarPorCpf, separarCepEndereco, rodarAutoCheckins,
  adicionarTempo, relancar, visitaHojePorCpf, remover,
  decidirCortesia, encerrarCortesia, ehAdminCortesia,
  solicitarEdicao, listarEdicoes, decidirEdicao, validarPropostaEdicao,
  checkout, aprovarCheckout, retomarCheckout, creditoPorCpf, usarCredito,
  invalidar: () => parqueCache.invalidar(),
};
