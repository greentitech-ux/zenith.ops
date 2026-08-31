// abastecimentoDivergencias.js
// O HISTORICO DE DIVERGENCIAS DO CARRINHO, turno a turno, com nome.
//
// POR QUE ISSO EXISTE: ja havia tres relatorios de divergencia (o "Dia a
// dia" com ?divergencias=1, o escrito de desvios e o de UM turno), mas
// nenhum respondia as duas perguntas que o Master faz na hora de cobrar:
// "quem falha mais no envio?" e "isso e desde sempre ou foi um mes ruim?".
// O escrito nao ranqueia ninguem e todos eles nascem olhando so os ultimos
// 7 dias.
//
// E FALTAVA METADE DA DIVERGENCIA. Os tres relatorios existentes so olham
// SAIDA NEGATIVA (sobrou mais do que entrou no ciclo). A outra divergencia,
// que e a que o Master chama de "falta de envio", nunca entrou em relatorio
// nenhum: a loja lancou que mandou 10, o carrinho conferiu e chegaram 8
// (recebimento.faltas). Ela e a UNICA que tem dono - o envio e assinado pelo
// operador que o lancou.
//
// A DIFERENCA ENTRE AS DUAS, e por que elas nao se somam num numero so:
//
//   - FALTA NO RECEBIMENTO: tem responsavel. Um envio especifico, assinado
//     por uma pessoa, conferido por outra. Da pra ranquear.
//   - SAIDA NEGATIVA: NAO tem responsavel. Pode ser a contagem de abertura,
//     a de fechamento, ou um envio que ninguem lancou - o dado nao separa.
//     Atribuir isso a uma pessoa seria inventar culpado. Por isso o ranking
//     de contagem abaixo conta PARTICIPACAO em turno com divergencia, e o
//     campo se chama `turnosComDivergencia`, nao "erros".
//
// Regra de sempre: so se afirma o que o dado sustenta.
'use strict';

const previsao = require('./abastecimentoPrevisao');
const { SABORES } = require('./abastecimentoCarrinho');

const { diaDe, inteiro, emUnidades } = previsao;

// nome que assina um lancamento, na ordem em que a operacao reconhece:
// o operador do balcao primeiro (login local de 4 letras), depois quem
// estava logado no app
function quemLancou(reg) {
  return (reg && (reg.operadorNome || reg.criadoPorNome || reg.criadoPorEmail)) || 'não identificado';
}

// As faltas de UM envio, em unidades. O registro guarda `recebimento.faltas`
// pronto (ver confirmarRecebimento), mas ali o insumo esta na embalagem do
// lancamento - uma "falta de 1" pode ser 1 caixa de 12. Aqui tudo vira
// unidade, senao o ranking soma caixa com lata.
function faltasDe(envio) {
  const rec = envio && envio.recebimento;
  if (!rec || !Array.isArray(rec.faltas) || !rec.faltas.length) return [];
  const porSabor = new Map(SABORES.map((s) => [s, null]));
  const out = [];
  for (const f of rec.faltas) {
    const enviada = Number(f.enviada) || 0;
    const recebida = Number(f.recebida) || 0;
    if (recebida >= enviada) continue;
    if (porSabor.has(f.item)) {
      out.push({ nome: f.item.charAt(0).toUpperCase() + f.item.slice(1), tipo: 'pizza', enviada, recebida, faltou: enviada - recebida });
      continue;
    }
    // insumo: reencontra o lancamento pelo nome pra saber a embalagem
    const ins = (envio.insumos || []).find((i) => i && i.nome === f.item) || null;
    const conv = (v) => (ins ? emUnidades(ins, v) : inteiro(v));
    const env = conv(enviada);
    const receb = conv(recebida);
    out.push({ nome: f.item, tipo: 'insumo', enviada: env, recebida: receb, faltou: Math.max(0, env - receb) });
  }
  return out.filter((f) => f.faltou > 0 && !(f.tipo !== 'pizza' && previsao.foraDaDivergencia(f.nome)));
}

// ---------------------------------------------------------------
// o relatorio
// ---------------------------------------------------------------
// inicio/fim em 'YYYY-MM-DD'. Omitir `inicio` significa DESDE O PRIMEIRO
// registro que existe - o pedido do Master e "desde o inicio ate hoje", e
// cravar 7 dias como os outros relatorios fazem entregaria outra coisa.
function relatorioDivergencias(regs, { inicio = null, fim = null } = {}) {
  const todos = [...(regs || [])].sort((a, b) => String(a.criadoEm).localeCompare(String(b.criadoEm)));
  const primeiroDia = todos.length ? diaDe(todos[0].criadoEm) : null;
  const de = inicio || primeiroDia || '0000-01-01';
  const ate = fim || (todos.length ? diaDe(todos[todos.length - 1].criadoEm) : '9999-12-31');
  const noPeriodo = todos.filter((r) => { const d = diaDe(r.criadoEm); return d >= de && d <= ate; });

  const envios = noPeriodo.filter((r) => r.tipo === 'ENVIO');
  const ciclos = previsao.montarCiclos(noPeriodo);

  // --- turnos: cada ciclo com pelo menos uma das duas divergencias --------
  const turnos = [];
  const enviosEmTurno = new Set();
  for (const c of ciclos) {
    // mesma janela do montarCiclos: envio na virada pertence ao ciclo que fecha
    const doTurno = envios.filter((e) => e.criadoEm > c.de && e.criadoEm <= c.ate);
    doTurno.forEach((e) => enviosEmTurno.add(e.id));

    const negativos = c.itens
      // item sem quantidade exata (sache, guardanapo, bobina...) fica fora de
      // TODO relatorio de divergencia - ver ITENS_SEM_DIVERGENCIA
      .filter((i) => Number.isFinite(i.saida) && i.saida < 0
        && !(i.tipo !== 'pizza' && previsao.foraDaDivergencia(i.nome)))
      .map((i) => ({ nome: i.nome, tipo: i.tipo, sobrou: Math.abs(i.saida) }));

    const faltas = [];
    let semConferencia = 0;
    for (const e of doTurno) {
      if (!e.recebidoEm) { semConferencia += 1; continue; }
      const f = faltasDe(e);
      if (f.length) faltas.push({ envioId: e.id, em: e.criadoEm, enviadoPor: quemLancou(e), conferidoPor: (e.recebimento && e.recebimento.porNome) || 'não identificado', itens: f });
    }
    if (!negativos.length && !faltas.length && !semConferencia) continue;

    turnos.push({
      de: c.de,
      ate: c.ate,
      dia: c.dia,
      rotulo: c.rotulo,
      horas: c.horas,
      contouAbertura: c.abreOperador || 'não identificado',
      contouFechamento: c.fechaOperador || 'não identificado',
      enviaram: c.enviosOperadores,
      envios: doTurno.length,
      negativos,
      faltas,
      // envio do turno que ninguem conferiu: nao da pra afirmar que faltou
      // alguma coisa, so que a conferencia nao foi feita. Fica separado.
      enviosSemConferencia: semConferencia,
      itensFaltando: faltas.reduce((s, f) => s + f.itens.reduce((t, i) => t + i.faltou, 0), 0),
      itensSobrando: negativos.reduce((s, n) => s + n.sobrou, 0),
    });
  }
  turnos.sort((a, b) => b.de.localeCompare(a.de));

  // --- ranking de quem ENVIA ---------------------------------------------
  // Roda sobre TODOS os envios do periodo, nao so os que cairam dentro de um
  // turno: envio antes da primeira contagem ou depois da ultima nao pertence
  // a ciclo nenhum, e deixar ele de fora sumiria com falta real do ranking.
  const porEnviador = new Map();
  const slotEnv = (nome) => {
    if (!porEnviador.has(nome)) porEnviador.set(nome, { nome, envios: 0, conferidos: 0, enviosComFalta: 0, itensFaltando: 0, semConferencia: 0 });
    return porEnviador.get(nome);
  };
  for (const e of envios) {
    const s = slotEnv(quemLancou(e));
    s.envios += 1;
    if (!e.recebidoEm) { s.semConferencia += 1; continue; }
    s.conferidos += 1;
    const f = faltasDe(e);
    if (f.length) {
      s.enviosComFalta += 1;
      s.itensFaltando += f.reduce((t, i) => t + i.faltou, 0);
    }
  }
  const ofensores = [...porEnviador.values()]
    .map((s) => ({
      ...s,
      // % dos envios CONFERIDOS que vieram com falta. Fica ao lado do numero
      // absoluto de proposito: sem ela, quem envia todo dia sempre aparece
      // pior que quem envia uma vez por semana, e a apresentacao mente.
      taxaFalta: s.conferidos ? Math.round((s.enviosComFalta / s.conferidos) * 1000) / 10 : null,
    }))
    .sort((a, b) => b.itensFaltando - a.itensFaltando || b.enviosComFalta - a.enviosComFalta || String(a.nome).localeCompare(String(b.nome), 'pt-BR'));

  // --- ranking de quem CONTA ---------------------------------------------
  // PARTICIPACAO, nao culpa: o dado nao diz se a saida negativa veio da
  // contagem de abertura, da de fechamento ou de um envio nao lancado.
  const porContador = new Map();
  const slotCont = (nome) => {
    if (!porContador.has(nome)) porContador.set(nome, { nome, turnosComDivergencia: 0, comoAbertura: 0, comoFechamento: 0, itensSobrando: 0 });
    return porContador.get(nome);
  };
  for (const t of turnos) {
    if (!t.negativos.length) continue; // saida negativa e o que envolve contagem
    const abre = slotCont(t.contouAbertura);
    abre.comoAbertura += 1;
    abre.turnosComDivergencia += 1;
    abre.itensSobrando += t.itensSobrando;
    if (t.contouFechamento !== t.contouAbertura) {
      const fecha = slotCont(t.contouFechamento);
      fecha.comoFechamento += 1;
      fecha.turnosComDivergencia += 1;
      fecha.itensSobrando += t.itensSobrando;
    } else {
      abre.comoFechamento += 1;
    }
  }
  const contadores = [...porContador.values()]
    .sort((a, b) => b.turnosComDivergencia - a.turnosComDivergencia || b.itensSobrando - a.itensSobrando || String(a.nome).localeCompare(String(b.nome), 'pt-BR'));

  const enviosForaDeTurno = envios.filter((e) => !enviosEmTurno.has(e.id)).length;

  return {
    periodo: { inicio: de, fim: ate, primeiroRegistro: primeiroDia },
    turnos,
    ofensores,
    contadores,
    indicadores: {
      turnosFechados: ciclos.length,
      turnosComDivergencia: turnos.length,
      turnosComFalta: turnos.filter((t) => t.faltas.length).length,
      turnosComSobra: turnos.filter((t) => t.negativos.length).length,
      envios: envios.length,
      enviosComFalta: ofensores.reduce((s, o) => s + o.enviosComFalta, 0),
      enviosSemConferencia: ofensores.reduce((s, o) => s + o.semConferencia, 0),
      itensFaltando: ofensores.reduce((s, o) => s + o.itensFaltando, 0),
      itensSobrando: turnos.reduce((s, t) => s + t.itensSobrando, 0),
      // envio que nao caiu em turno nenhum (antes da 1a contagem ou depois
      // da ultima): entra no ranking, mas nao aparece na lista por turno
      enviosForaDeTurno,
    },
  };
}

module.exports = { relatorioDivergencias, faltasDe, quemLancou };
