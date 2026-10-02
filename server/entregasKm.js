// Controle de jornada dos entregadores pagos por faixa de distância.
// A entrada cria um turno aberto; somente a saída gera o lançamento financeiro
// definitivo em entregasLive, usando as tarifas atuais da regra da unidade.
const db = require('./firestore');
const entregasRegras = require('./entregasRegras');
const entregadoresEntregas = require('./entregadoresEntregas');

const TURNOS = db.collection('entregasTurnosKm');
const ENTREGAS = db.collection('entregasLive');

function validarHora(hora) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(hora || ''));
}

function quantidade(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

async function listarPorUnidades(unidades) {
  const snap = await TURNOS.orderBy('criadoEm', 'desc').get();
  const todos = snap.docs.map((doc) => doc.data());
  if (unidades == null) return todos;
  if (!Array.isArray(unidades) || !unidades.length) return [];
  const permitidas = new Set(unidades);
  return todos.filter((turno) => permitidas.has(turno.unidade));
}

async function darEntrada({ unidade, unidadeNome, data, entregador, horaEntrada, criadoPorId, criadoPorEmail }) {
  if (!unidade) throw new Error('Unidade é obrigatória.');
  if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(data)) throw new Error('Data inválida.');
  const nome = String(entregador || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  if (!nome) throw new Error('Informe o nome do entregador.');
  if (!validarHora(horaEntrada)) throw new Error('Hora de entrada inválida.');

  const regra = await entregasRegras.getPara(unidade);
  if (!regra.regraKm?.ativo) throw new Error('A regra por KM não está ativa nessa unidade.');
  const cadastrado = await entregadoresEntregas.encontrarAtivo(unidade, nome);
  if (!cadastrado) throw new Error('Selecione um entregador ativo cadastrado nesta unidade.');

  const abertos = await TURNOS.where('status', '==', 'ABERTO').get();
  const duplicado = abertos.docs.some((doc) => {
    const turno = doc.data();
    return turno.unidade === unidade && turno.entregador.toLocaleLowerCase('pt-BR') === cadastrado.nome.toLocaleLowerCase('pt-BR');
  });
  if (duplicado) throw new Error('Esse entregador já possui uma entrada aberta nessa unidade.');

  const ref = TURNOS.doc();
  const agora = new Date().toISOString();
  const turno = {
    id: ref.id,
    unidade,
    unidadeNome: unidadeNome || unidade,
    data,
    entregador: cadastrado.nome,
    horaEntrada,
    horaSaida: null,
    status: 'ABERTO',
    criadoPorId,
    criadoPorEmail,
    criadoEm: agora,
    atualizadoEm: agora,
  };
  await ref.set(turno);
  return turno;
}

async function darSaida({ id, horaSaida, quantidades, observacao, unidadesPermitidas, finalizadoPorId, finalizadoPorEmail }) {
  if (!id) throw new Error('Turno não informado.');
  if (!validarHora(horaSaida)) throw new Error('Hora de saída inválida.');

  const turnoRef = TURNOS.doc(id);
  const turnoSnap = await turnoRef.get();
  if (!turnoSnap.exists) throw new Error('Turno não encontrado.');
  const turnoAtual = turnoSnap.data();
  if (Array.isArray(unidadesPermitidas) && !unidadesPermitidas.includes(turnoAtual.unidade)) {
    const erro = new Error('Você não tem acesso a essa unidade.');
    erro.statusCode = 403;
    throw erro;
  }
  const regra = await entregasRegras.getPara(turnoAtual.unidade);
  if (!regra.regraKm?.ativo) throw new Error('A regra por KM não está ativa nessa unidade.');

  const faixas = (regra.regraKm.faixas || []).map((faixa) => {
    const qtd = quantidade(quantidades?.[faixa.id]);
    const taxa = Math.max(0, Number(faixa.valor) || 0);
    return { id: faixa.id, label: faixa.label, limiteKm: faixa.limiteKm, quantidade: qtd, taxa, valor: +(qtd * taxa).toFixed(2) };
  });
  const totalEntregas = faixas.reduce((total, faixa) => total + faixa.quantidade, 0);
  if (totalEntregas <= 0) throw new Error('Informe ao menos uma entrega em uma faixa de KM.');
  const totalValor = +faixas.reduce((total, faixa) => total + faixa.valor, 0).toFixed(2);
  const agora = new Date().toISOString();
  const entregaId = `km-${id}`;
  const entregaRef = ENTREGAS.doc(entregaId);
  const obs = String(observacao || '').trim().slice(0, 1000) || null;

  const resultado = await db.runTransaction(async (tx) => {
    const snap = await tx.get(turnoRef);
    if (!snap.exists) throw new Error('Turno não encontrado.');
    const turno = snap.data();
    if (turno.status !== 'ABERTO') throw new Error('A saída desse entregador já foi registrada.');

    const lancamento = {
      id: entregaId,
      unidade: turno.unidade,
      unidadeNome: turno.unidadeNome || turno.unidade,
      data: turno.data,
      entregador: turno.entregador,
      tipoRecebedor: 'km',
      horaEntrada: turno.horaEntrada,
      horaSaida,
      faixasKm: faixas,
      entrega: totalEntregas,
      retorno: 0,
      extra: 0,
      bonus: 0,
      pos00hs: 0,
      foraDeArea: 0,
      ajudaCusto: 0,
      valor: totalValor,
      coopRecebe: entregasRegras.calcularCoop(regra,totalEntregas),
      regraCoop: entregasRegras.configuracaoCoop(regra),
      quantTotal: totalEntregas,
      detalhesValor: faixas.map((faixa) => ({
        campo: faixa.id, label: faixa.label, base: 'faixaKm', quantidade: faixa.quantidade,
        taxa: faixa.taxa, valor: faixa.valor,
      })),
      camposRemovidos: [],
      motivoRemocaoCampos: null,
      obsRetorno: null,
      obsExtra: null,
      observacao: obs,
      etiquetaPath: null,
      criadoPorId: turno.criadoPorId,
      criadoPorEmail: turno.criadoPorEmail,
      criadoEm: turno.criadoEm,
      atualizadoEm: agora,
      finalizadoPorId,
      finalizadoPorEmail,
      historico: [],
    };
    const turnoFinalizado = {
      ...turno,
      horaSaida,
      faixasKm: faixas,
      totalEntregas,
      totalValor,
      observacao: obs,
      status: 'FINALIZADO',
      entregaId,
      finalizadoPorId,
      finalizadoPorEmail,
      finalizadoEm: agora,
      atualizadoEm: agora,
    };
    tx.set(entregaRef, lancamento);
    tx.set(turnoRef, turnoFinalizado);
    return { turno: turnoFinalizado, lancamento };
  });
  return resultado;
}

module.exports = { listarPorUnidades, darEntrada, darSaida };
