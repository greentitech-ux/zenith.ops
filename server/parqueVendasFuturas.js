'use strict';
// Pagamento confirmado manualmente: venda e reserva são gravadas juntas.
// O financeiro usa dataVenda; a operação do parque usa dataUtilizacao.
const db = require('./firestore');
const parque = require('./parque');
const { createCache } = require('./liveCache');
const { createHash } = require('node:crypto');
const VENDAS = db.collection('parqueVendasFuturas');
const CHECKINS = db.collection('parqueCheckins');
const REVISOES = db.collection('saltiversoMovimentosDia');
const FORMAS = ['linkCredito', 'linkDebito', 'linkPix'];
const hoje = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const chaveDia = (u, d) => `${u}__${d}`.replace(/[^a-zA-Z0-9_.-]/g, '_');
const hash = s => createHash('sha256').update(s).digest('hex');
const texto = (s, n) => String(s || '').trim().slice(0, n);
function dataValida(d) {
  return /^\d{4}-\d{2}-\d{2}$/.test(d || '') && Number.isFinite(Date.parse(d)) && new Date(d).toISOString().slice(0, 10) === d;
}
function normalizar(d) {
  if (!d || !texto(d.unidade, 100)) throw new Error('Selecione a unidade.');
  if (!dataValida(d.dataUtilizacao)) throw new Error('Informe uma data de utilização válida.');
  if (!Array.isArray(d.criancas) || !d.criancas.length || d.criancas.length > 30) throw new Error('Cadastre de 1 a 30 crianças.');
  const criancas = d.criancas.map(c => {
    if (!texto(c.nome, 120) || !/^normal:\d+$/.test(c.plano || '')) throw new Error('Informe nome e ingresso para cada criança. Cortesias seguem o fluxo de autorização existente.');
    if (c.dataNascimento && (!dataValida(c.dataNascimento) || c.dataNascimento > hoje())) throw new Error('Data de nascimento inválida.');
    return { nome: texto(c.nome, 120), dataNascimento: c.dataNascimento || null, plano: c.plano, meia: c.meia === true };
  });
  return { unidade: texto(d.unidade, 100), dataUtilizacao: d.dataUtilizacao,
    responsavel: { nome: texto(d.responsavel?.nome, 150), contato: texto(d.responsavel?.contato, 30), cpf: texto(d.responsavel?.cpf, 20), email: texto(d.responsavel?.email, 150) },
    criancas, observacao: texto(d.observacao, 300) };
}
async function previa(d) {
  const dados = normalizar(d);
  if (dados.dataUtilizacao <= hoje()) throw new Error('Vendas futuras exigem utilização após hoje. Para hoje, use o Check-in do Parque.');
  const registro = await parque.prepararVendaFutura({ ...dados, criadoPorId: null, criadoPorEmail: null, termoAssinado: false, usou: false });
  return registro;
}
const cache = createCache(async () => (await VENDAS.get()).docs.map(d => d.data()), 5 * 60 * 1000);
async function listar(unidades) { return (await cache.cached()).filter(v => !unidades || unidades.includes(v.unidade)); }
async function movimentosDoDia(unidade, data) {
  // Cancelar a visita não apaga dinheiro recebido. Devolução é outro movimento.
  // Fechamento exige leitura consistente entre instâncias, sem stale-while-revalidate.
  // Consulta só o dia financeiro (índice simples), não a coleção inteira da agenda.
  const snap = await VENDAS.where('dataVenda', '==', data).get();
  return snap.docs.map(d => d.data()).filter(v => v.unidade === unidade && v.dataVenda === data)
    .map(v => ({ valor: v.valor, forma: v.forma, porId: v.criadoPorId, porEmail: v.criadoPorEmail, vendaFuturaId: v.id }));
}
async function revisaoDia(unidade, data) {
  const snap = await REVISOES.doc(chaveDia(unidade, data)).get();
  return snap.exists ? Number(snap.data().versao) || 0 : 0;
}
function replay(atual, impressao, chave, porId) {
  if (atual.impressao !== impressao || atual.chaveRequisicao !== chave || atual.criadoPorId !== porId) throw new Error('Referência de pagamento já lançada. Consulte a venda existente; não registre novamente.');
  return atual;
}
async function criar(d, ator) {
  const dados = normalizar(d), referencia = texto(d.referenciaPagamento, 120).toUpperCase().replace(/\s+/g, ' ');
  if (d.pagamentoConfirmado !== true || !FORMAS.includes(d.forma)) throw new Error('Confirme o recebimento e selecione Link Crédito, Link Débito ou Link Pix.');
  if (referencia.length < 4) throw new Error('Informe a referência única do comprovante (provedor + transação).');
  if (!/^[a-zA-Z0-9-]{16,80}$/.test(d.chaveRequisicao || '')) throw new Error('Chave de envio inválida. Atualize a tela.');
  const valor = Number(d.valorConfirmado);
  if (!Number.isFinite(valor) || valor <= 0) throw new Error('Informe o valor confirmado.');
  const impressao = hash(JSON.stringify({ dados, referencia, forma: d.forma, valor }));
  const id = 'vf_' + hash(dados.unidade + '|' + referencia), ref = VENDAS.doc(id);
  const existente = await ref.get();
  if (existente.exists) return replay(existente.data(), impressao, d.chaveRequisicao, ator.porId);
  const preparado = await previa(dados);
  if (Math.round(valor * 100) !== Math.round(preparado.valor * 100)) throw new Error('O valor confirmado difere do ingresso calculado. Confira os dados e o pagamento antes de lançar.');
  const dataVenda = hoje(), agora = new Date().toISOString();
  const diaId = chaveDia(dados.unidade, dataVenda);
  const venda = { id, checkinId: id, ...dados, valor: preparado.valor, forma: d.forma, referenciaPagamento: referencia,
    dataVenda, pagamentoConfirmado: true, pagamentoConfirmadoEm: agora, status: 'AGENDADO',
    criadoPorId: ator.porId, criadoPorEmail: ator.porEmail, criadoEm: agora, atualizadoEm: agora,
    historico: [], impressao, chaveRequisicao: d.chaveRequisicao };
  const checkin = { ...preparado, id, vendaFuturaId: id, dataVenda, pagamentoAntecipado: true,
    valor: preparado.valor, valorAntecipado: preparado.valor, pagamentos: [{ forma: d.forma, valor: preparado.valor }], metodoPagamento: d.forma,
    iniciado: false, autoCheckin: false, horarioPrevisto: null, timeInicial: null, timeFinal: null, termoAssinado: false, usou: false,
    criadoPorId: ator.porId, criadoPorEmail: ator.porEmail, colaboradorId: ator.porId, colaboradorNome: ator.porEmail, criadoEm: agora };
  const resultado = await db.runTransaction(async tx => {
    const repetida = await tx.get(ref);
    if (repetida.exists) return replay(repetida.data(), impressao, d.chaveRequisicao, ator.porId);
    const dia = await tx.get(db.collection('saltiversoFechamentos').doc(diaId));
    const caixaId = `${dados.unidade}__${dataVenda}__${ator.porId}`.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const caixa = await tx.get(db.collection('saltiversoCaixas').doc(caixaId));
    const revRef = REVISOES.doc(diaId), rev = await tx.get(revRef);
    if (dia.exists || caixa.exists) throw new Error('O caixa do dia da venda já está fechado. Regularize o fechamento antes de lançar; não transfira a venda para outra data.');
    if (hoje() !== dataVenda) throw new Error('O dia mudou durante o lançamento. Confira e tente novamente.');
    tx.set(ref, venda); tx.set(CHECKINS.doc(id), checkin);
    tx.set(revRef, { versao: (rev.exists ? Number(rev.data().versao) || 0 : 0) + 1 });
    return venda;
  });
  cache.invalidar(); parque.invalidar();
  return resultado;
}
async function alterar(id, { acao, dataUtilizacao, motivo, versaoEsperada }, ator) {
  const justificativa = texto(motivo, 500);
  if (!justificativa) throw new Error('Informe o motivo.');
  if (!['reagendar', 'cancelar'].includes(acao)) throw new Error('Ação inválida.');
  if (acao === 'cancelar' && !ator.master) throw new Error('Somente o Master pode cancelar a utilização.');
  if (acao === 'reagendar' && (!dataValida(dataUtilizacao) || dataUtilizacao < hoje())) throw new Error('Escolha hoje ou uma data futura.');
  const resultado = await db.runTransaction(async tx => {
    const ref = VENDAS.doc(id), snap = await tx.get(ref), cRef = CHECKINS.doc(id), cs = await tx.get(cRef);
    if (!snap.exists || !cs.exists) throw new Error('Venda não encontrada.');
    const v = snap.data(), c = cs.data();
    if (!ator.master && !(ator.unidades || []).includes(v.unidade)) throw new Error('Sem acesso à unidade.');
    if (v.atualizadoEm !== versaoEsperada) throw new Error('A venda mudou. Atualize a tela.');
    if (c.iniciado || v.status !== 'AGENDADO') throw new Error('Somente uma reserva não utilizada e ativa pode ser alterada.');
    const agora = new Date(Math.max(Date.now(), Date.parse(v.atualizadoEm) + 1)).toISOString();
    const patch = { atualizadoEm: agora, ...(acao === 'reagendar' ? { dataUtilizacao } : { status: 'CANCELADO' }),
      historico: [...(v.historico || []), { acao, motivo: justificativa, em: agora, porId: ator.porId, porEmail: ator.porEmail, antes: v.dataUtilizacao, depois: acao === 'reagendar' ? dataUtilizacao : null }] };
    tx.update(ref, patch);
    tx.update(cRef, acao === 'reagendar' ? { dataUtilizacao, corPulseira: null, pulseirasInfo: [], atualizadoEm: agora } : { vendaFuturaCancelada: true, atualizadoEm: agora });
    return { ...v, ...patch };
  });
  cache.invalidar(); parque.invalidar(); return resultado;
}
async function checkin(id) {
  const tabela = await parque.getConfigPrecos();
  const resultado = await db.runTransaction(async tx => {
    const ref = CHECKINS.doc(id), snap = await tx.get(ref), vendaRef = VENDAS.doc(id), venda = await tx.get(vendaRef);
    if (!snap.exists || !venda.exists) throw new Error('Reserva não encontrada.');
    const c = snap.data(), v = venda.data();
    if (v.status === 'CANCELADO' || c.vendaFuturaCancelada) throw new Error('Utilização cancelada.');
    if (c.iniciado) return c; // replay não reinicia o relógio
    if (c.dataUtilizacao !== hoje()) throw new Error('O check-in só pode ser realizado na data agendada. Solicite reagendamento à gerente.');
    if (!c.termoAssinado) throw new Error('Confirme o termo assinado antes da entrada.');
    const inicio = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
    const [h, m] = inicio.split(':').map(Number);
    const fim = minutos => { const n = h * 60 + m + minutos; if (n >= 1440) throw new Error('O período ultrapassa o dia de utilização. Confira o horário do parque.'); return String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0'); };
    const criancas = c.criancas.map(cr => ({ ...cr, timeInicial: inicio, timeFinal: fim(cr.tempoMinutos), checkoutEm: null }));
    const pulseirasInfo = criancas.map((cr, i) => ({ ...parque.resolverPulseira({ dataUtilizacao: c.dataUtilizacao, horarioPrevisto: inicio, tempoMinutos: cr.tempoMinutos }, tabela), criancaIndice: i, criancaNome: cr.nome })).filter(p => p.id);
    const agora = new Date().toISOString(), patch = { iniciado: true, usou: true, autoCheckin: false, checkinEm: agora,
      timeInicial: inicio, timeFinal: criancas.map(cr => cr.timeFinal).sort().at(-1), criancas, pulseirasInfo,
      corPulseira: pulseirasInfo.length && new Set(pulseirasInfo.map(p => p.id)).size === 1 ? pulseirasInfo[0] : null };
    tx.update(ref, patch); tx.update(vendaRef, { status: 'UTILIZADO', utilizadoEm: agora, atualizadoEm: agora });
    return { ...c, ...patch };
  });
  cache.invalidar(); parque.invalidar(); return resultado;
}
module.exports = { previa, criar, listar, movimentosDoDia, alterar, checkin, revisaoDia, chaveDia, hoje, FORMAS };
