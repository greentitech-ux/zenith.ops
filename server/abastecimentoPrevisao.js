// abastecimentoPrevisao.js
// A MATEMATICA do carrinho num lugar so: ciclo (o que entrou e o que saiu
// entre duas contagens), capacidade (quanto o carrinho aguenta) e sugestao
// de envio (quanto falta pra encher depois da contagem que acabou de sair).
//
// POR QUE ISSO EXISTE: o relatorio de Fluxo so sabia fechar a conta do
// PERIODO INTEIRO (primeira x ultima contagem). Como a operacao conta 2x por
// dia - inicio do turno da manha e inicio do turno da madrugada - cada par
// de contagens consecutivas JA E um ciclo fechado: da pra ver dia a dia, e
// turno a turno, sem inventar nada. E, tendo os ciclos, sai de graca a
// pergunta que interessa na ponta: "acabei de contar, quanto peco/mando?".
//
// Regra que vale pra tudo aqui: SO se afirma o que a contagem sustenta.
// Sem duas contagens nao existe ciclo, e sem ciclo nao existe consumo
// apurado - devolve null em vez de chutar um numero.
'use strict';

const { SABORES } = require('./abastecimentoCarrinho');

const FUSO_BR = 'America/Sao_Paulo';
const diaDe = (iso) => new Date(iso).toLocaleDateString('sv-SE', { timeZone: FUSO_BR });
const horaDe = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { timeZone: FUSO_BR, hour: '2-digit', minute: '2-digit' });

function inteiro(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

// insumo pode ser lancado em CAIXA - a conta so fecha em unidade
function emUnidades(ins, qtd) {
  return ins && ins.embalagem === 'caixa' && ins.qtdPorCaixa ? inteiro(qtd) * ins.qtdPorCaixa : inteiro(qtd);
}

const rotuloSabor = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const chavePizza = (s) => `pizza:${s}`;
const chaveInsumo = (id) => `insumo:${id}`;

// ---------------------------------------------------------------
// itens de UM registro, normalizados em unidades
// ---------------------------------------------------------------
// Devolve [{chave, nome, tipo, qtd}]. Nos ENVIOS, `usarRecebido` troca o
// que foi MANDADO pelo que o carrinho CONFERIU que chegou - so faz sentido
// depois do recebimento confirmado; antes disso o enviado e a melhor
// informacao que existe.
function itensDe(reg, { usarRecebido = false } = {}) {
  const out = [];
  const rec = usarRecebido && reg.recebimento && reg.recebimento.recebido ? reg.recebimento.recebido : null;

  SABORES.forEach((s) => {
    const base = inteiro((reg.pizzas || {})[s]);
    if (!base && reg.tipo !== 'CONTAGEM') return; // contagem zerada e informacao; envio de zero nao e
    const qtd = rec && rec.pizzas && rec.pizzas[s] != null ? inteiro(rec.pizzas[s]) : base;
    out.push({ chave: chavePizza(s), nome: rotuloSabor(s), tipo: 'pizza', qtd });
  });

  (reg.insumos || []).forEach((ins, idx) => {
    if (!ins || !ins.insumoId) return; // texto livre legado nao entra na conta
    const base = inteiro(ins.totalUnidades) || emUnidades(ins, ins.quantidade);
    // quantidadeRecebida vem na MESMA embalagem do lancamento (caixa ou
    // unidade) - converte de novo antes de usar
    const recIns = rec && Array.isArray(rec.insumos) ? rec.insumos[idx] : null;
    const qtd = recIns && recIns.quantidadeRecebida != null ? emUnidades(ins, recIns.quantidadeRecebida) : base;
    out.push({ chave: chaveInsumo(ins.insumoId), nome: ins.nome, tipo: 'insumo', qtd });
  });

  return out;
}

// quanto um ENVIO representa de ENTRADA no carrinho: o conferido quando ja
// houve recebimento, o enviado enquanto nao houve
const entradasDe = (envio) => itensDe(envio, { usarRecebido: !!envio.recebidoEm });

// ---------------------------------------------------------------
// ciclos: cada par de contagens consecutivas
// ---------------------------------------------------------------
// Um ciclo = um turno, na pratica: comeca na contagem que abre o turno e
// fecha na contagem do turno seguinte. Tudo que entrou no meio conta como
// entrada do ciclo; o resto e aritmetica:
//     saida = saldo inicial + entradas - saldo final
function montarCiclos(regs) {
  const ordenados = [...regs].sort((a, b) => String(a.criadoEm).localeCompare(String(b.criadoEm)));
  const contagens = ordenados.filter((r) => r.tipo === 'CONTAGEM');
  const envios = ordenados.filter((r) => r.tipo === 'ENVIO');

  const ciclos = [];
  for (let i = 0; i + 1 < contagens.length; i += 1) {
    const abre = contagens[i];
    const fecha = contagens[i + 1];
    // envio EXATAMENTE na virada conta pro ciclo que fecha (chegou antes de
    // ser contado) - por isso o `<=` do lado de fim
    const dentro = envios.filter((e) => e.criadoEm > abre.criadoEm && e.criadoEm <= fecha.criadoEm);

    const itens = new Map();
    const slot = (it) => {
      if (!itens.has(it.chave)) itens.set(it.chave, { chave: it.chave, nome: it.nome, tipo: it.tipo, saldoInicial: 0, entradas: 0, saldoFinal: 0 });
      return itens.get(it.chave);
    };
    itensDe(abre).forEach((it) => { slot(it).saldoInicial += it.qtd; });
    itensDe(fecha).forEach((it) => { slot(it).saldoFinal += it.qtd; });
    dentro.forEach((e) => entradasDe(e).forEach((it) => { slot(it).entradas += it.qtd; }));

    ciclos.push({
      de: abre.criadoEm,
      ate: fecha.criadoEm,
      // o ciclo pertence ao dia em que FECHOU - e o dia em que a saida foi
      // efetivamente apurada
      dia: diaDe(fecha.criadoEm),
      rotulo: `${diaDe(abre.criadoEm) === diaDe(fecha.criadoEm) ? '' : diaDe(abre.criadoEm).slice(5).split('-').reverse().join('/') + ' '}${horaDe(abre.criadoEm)} → ${horaDe(fecha.criadoEm)}`,
      horas: Math.max(0, (new Date(fecha.criadoEm) - new Date(abre.criadoEm)) / 3600000),
      envios: dentro.length,
      // quem contou/enviou nesse turno - pro relatorio escrito de
      // desvios apontar com QUEM conferir, nao so "o item X deu -8"
      abreOperador: abre.operadorNome || abre.criadoPorNome || null,
      fechaOperador: fecha.operadorNome || fecha.criadoPorNome || null,
      enviosOperadores: [...new Set(dentro.map((e) => e.operadorNome || e.criadoPorNome).filter(Boolean))],
      itens: [...itens.values()].map((i) => ({ ...i, saida: i.saldoInicial + i.entradas - i.saldoFinal })),
    });
  }
  return ciclos;
}

// ---------------------------------------------------------------
// capacidade do carrinho
// ---------------------------------------------------------------
// Nao existe cadastro de "cabe X" - entao a capacidade e ESTIMADA pelo maior
// volume que o carrinho ja segurou num ciclo (o que tinha na contagem + o
// que entrou depois), que e exatamente como a operacao descreve o limite
// das duas geladeiras. Usa o percentil 80 e nao o maximo pra um unico dia
// atipico nao virar a meta de todo dia.
//
// LIMITE HONESTO dessa estimativa: as entradas do ciclo chegam AO LONGO do
// turno, entao o pico real pode ter sido menor que a soma. Por isso o
// Master pode cadastrar a capacidade na mao (capacidadesManuais), e ai ela
// manda - a estimativa e so o ponto de partida de quem ainda nao mediu.
function percentil(valores, p) {
  if (!valores.length) return null;
  const ord = [...valores].sort((a, b) => a - b);
  const pos = (ord.length - 1) * p;
  const baixo = Math.floor(pos);
  const alto = Math.ceil(pos);
  if (baixo === alto) return ord[baixo];
  return ord[baixo] + (ord[alto] - ord[baixo]) * (pos - baixo);
}

function estimarCapacidades(ciclos, capacidadesManuais = {}) {
  const porItem = new Map();
  // o que o Master cadastrou entra ANTES do historico: capacidade na mao tem
  // que valer desde o primeiro dia, inclusive quando ainda nao existe nenhum
  // ciclo fechado pra estimar nada
  Object.keys(capacidadesManuais || {}).forEach((chave) => {
    porItem.set(chave, { chave, nome: null, tipo: chave.startsWith('pizza:') ? 'pizza' : 'insumo', picos: [], saidas: [] });
  });
  ciclos.forEach((c) => {
    c.itens.forEach((i) => {
      if (!porItem.has(i.chave)) porItem.set(i.chave, { chave: i.chave, nome: i.nome, tipo: i.tipo, picos: [], saidas: [] });
      const alvo = porItem.get(i.chave);
      if (i.nome) alvo.nome = i.nome; // nome mais recente vence (item renomeado no catalogo)
      alvo.picos.push(i.saldoInicial + i.entradas);
      alvo.saidas.push(i.saida);
    });
  });

  const saida = new Map();
  porItem.forEach((v, chave) => {
    const manual = Number(capacidadesManuais[chave]);
    const temManual = Number.isFinite(manual) && manual > 0;
    const picos = v.picos.filter((n) => n > 0);
    // com pouca amostra o percentil nao diz nada - usa o maior ja visto
    const estimada = picos.length >= 3 ? Math.ceil(percentil(picos, 0.8)) : (picos.length ? Math.max(...picos) : null);
    // consumo tipico do turno: mediana (resiste a um dia fora da curva
    // melhor que a media) das saidas apuradas
    const consumoTipico = v.saidas.length ? Math.round(percentil(v.saidas.map((n) => Math.max(0, n)), 0.5)) : null;
    saida.set(chave, {
      chave,
      nome: v.nome,
      tipo: v.tipo,
      capacidade: temManual ? Math.round(manual) : estimada,
      origem: temManual ? 'manual' : (estimada == null ? 'sem-base' : 'estimada'),
      capacidadeEstimada: estimada,
      amostras: picos.length,
      maiorPico: picos.length ? Math.max(...picos) : null,
      consumoTipico,
    });
  });
  return saida;
}

// ---------------------------------------------------------------
// sugestao de envio, logo depois da contagem
// ---------------------------------------------------------------
// SO INSUMOS. As pizzas (calabresa/pepperoni/mussarela) ficam de fora de
// proposito: elas nao sao mandadas de uma vez pra encher o carrinho - vao
// FRACIONADAS ao longo do dia, conforme o pedido do carrinho. "Encher ate a
// capacidade" e uma conta que so faz sentido pro que e reposto em bloco
// (bebida, copo, bobina...). Pizza continua aparecendo normalmente no fluxo
// e no dia a dia - o que muda e so a sugestao de pre-envio.
//
// A pergunta da ponta: "contei, e agora?". A conta e simples de proposito,
// pra qualquer pessoa do turno conferir de cabeca:
//
//   ja tem  = contado + o que chegou depois da contagem (ja recebido)
//   a bordo = ja tem + o que esta a caminho (enviado, sem recebimento)
//   sugerir = capacidade - a bordo
//
// O "a caminho" e o detalhe que evita o erro caro: sem ele, a sugestao
// mandaria de novo o que ja esta na rua e o carrinho transbordaria.
// A sugestao e um PONTO DE PARTIDA editavel na tela - nunca um envio
// automatico.
function sugerirEnvio(regs, { capacidadesManuais = {}, ciclos = null } = {}) {
  const ordenados = [...regs].sort((a, b) => String(a.criadoEm).localeCompare(String(b.criadoEm)));
  const contagens = ordenados.filter((r) => r.tipo === 'CONTAGEM');
  const ultima = contagens[contagens.length - 1] || null;
  if (!ultima) {
    return { temBase: false, motivo: 'Nenhuma contagem lançada ainda - a sugestão nasce da contagem.', contagem: null, itens: [] };
  }

  const cap = estimarCapacidades(ciclos || montarCiclos(regs), capacidadesManuais);
  const posteriores = ordenados.filter((r) => r.tipo === 'ENVIO' && r.criadoEm > ultima.criadoEm);

  const itens = new Map();
  const slot = (it) => {
    if (!itens.has(it.chave)) {
      const c = cap.get(it.chave) || {};
      itens.set(it.chave, {
        chave: it.chave,
        nome: it.nome,
        tipo: it.tipo,
        contado: 0,
        chegouDepois: 0,
        aCaminho: 0,
        capacidade: c.capacidade != null ? c.capacidade : null,
        origemCapacidade: c.origem || 'sem-base',
        consumoTipico: c.consumoTipico != null ? c.consumoTipico : null,
      });
    }
    return itens.get(it.chave);
  };

  const soInsumo = (lista) => lista.filter((it) => it.tipo === 'insumo');

  soInsumo(itensDe(ultima)).forEach((it) => { slot(it).contado += it.qtd; });
  posteriores.forEach((e) => {
    const chegou = !!e.recebidoEm;
    soInsumo(entradasDe(e)).forEach((it) => {
      const alvo = slot(it);
      if (chegou) alvo.chegouDepois += it.qtd;
      else alvo.aCaminho += it.qtd;
    });
  });

  // Envios que carregaram INSUMO depois da contagem. E o que "gasta" a
  // sugestao: a partir do primeiro deles, a foto do carrinho que gerou esta
  // conta nao descreve mais o carrinho - o turno ja repos, com ou sem usar o
  // que estava sugerido aqui. Dai em diante a tela para de sugerir e espera a
  // proxima contagem, em vez de continuar mostrando um numero que envelheceu.
  // Envio so de pizza NAO conta: pizza sai fracionada o dia inteiro por
  // pedido do carrinho e nunca entrou nesta conta (ver o topo desta secao).
  const enviosDeInsumo = posteriores.filter((e) => soInsumo(entradasDe(e)).some((it) => it.qtd > 0));

  const lista = [...itens.values()].map((i) => {
    const aBordo = i.contado + i.chegouDepois + i.aCaminho;
    return {
      ...i,
      jaTem: i.contado + i.chegouDepois,
      aBordo,
      sugestao: i.capacidade == null ? null : Math.max(0, i.capacidade - aBordo),
    };
  }).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));

  return {
    temBase: true,
    contagem: {
      id: ultima.id,
      em: ultima.criadoEm,
      por: ultima.operadorNome || ultima.criadoPorNome || ultima.criadoPorEmail || null,
      // quantos envios de insumo ja sairam depois dessa contagem - a tela
      // avisa, senao parece que a sugestao ignorou o que o turno mandou
      enviosDepois: enviosDeInsumo.length,
    },
    // a sugestao ja foi cumprida: saiu envio de insumo depois da contagem.
    // A tela troca a lista pelo aviso de "aguardando a proxima contagem" -
    // sugerir em cima de uma foto vencida e pior que nao sugerir nada.
    atendida: enviosDeInsumo.length > 0,
    atendidaEm: enviosDeInsumo.length ? enviosDeInsumo[enviosDeInsumo.length - 1].criadoEm : null,
    // sem nenhum item com capacidade conhecida a tela mostra a explicacao em
    // vez de uma coluna inteira de "-"
    semCapacidade: lista.every((i) => i.capacidade == null),
    itens: lista,
  };
}

// ---------------------------------------------------------------
// visao DIA A DIA (o que entrou e o que saiu por dia)
// ---------------------------------------------------------------
// entradas: pelos ENVIOS do dia (todo envio tem dia proprio).
// saida: so dos ciclos que FECHARAM naquele dia - dia sem segunda contagem
// fica com saida null, e a tela diz "sem contagem de fechamento" em vez de
// mostrar zero, que seria mentira.
// ORDEM DO RELATORIO. Pedido do Master: "o item que tiver diferenca positiva
// ou negativa aparece no inicio, assim ele nao precisa PROCURAR onde esta o
// erro; os demais seguem a ordem que ja existe".
//
// Sao dois blocos, nao uma ordenacao por tamanho: primeiro tudo que tem
// divergencia, depois todo o resto na ordem de sempre. O que manda pro topo
// e' TER divergencia, nao o tamanho dela - um item que sobrou 1 un e' tao
// erro quanto um que sobrou 51, e o Master quer os dois na primeira tela.
//
// A divergencia sobe ACIMA ATE DAS PIZZAS: o exemplo do proprio Master e' a
// Fanta Laranja Zero (insumo, sobrou 6) tendo que aparecer antes da
// Calabresa. Por isso o bloco quebra o agrupamento pizza/insumo de proposito
// - dentro de cada bloco o agrupamento volta a valer.
// ---------------------------------------------------------------
// itens que NAO entram em relatorio de divergencia
// ---------------------------------------------------------------
// Pedido do Master: "mostarda, ketchup, maionese, guardanapo, talheres,
// saco de lixo, bobina pequena, bobina grande, perflex - esses itens nao
// tem muito bem uma quantidade especifica, entao POR HORA fica fora,
// sempre que for relatorio de divergencia".
//
// A razao e' real: sache e guardanapo saem por punhado, ninguem conta um a
// um. Cobrar divergencia deles enche o relatorio de linha vermelha que
// ninguem vai investigar - e relatorio que todo mundo ignora nao serve.
//
// Eles CONTINUAM aparecendo no "Dia a dia" (que e' movimento, nao
// divergencia) - so nunca sao marcados como divergencia nem entram no
// relatorio "so divergencias".
//
// A lista sai por env (ITENS_SEM_DIVERGENCIA, separados por virgula) sem
// deploy. Se ela comecar a mudar toda semana, o lugar certo passa a ser um
// campo no cadastro do insumo - ai e por item, sem depender de nome.
const ITENS_SEM_DIVERGENCIA_PADRAO = [
  'mostarda', 'ketchup', 'maionese', 'guardanapo', 'talheres',
  'saco de lixo', 'bobina pequena', 'bobina grande', 'perflex',
];
const semAcento = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const ITENS_SEM_DIVERGENCIA = (process.env.ITENS_SEM_DIVERGENCIA
  ? String(process.env.ITENS_SEM_DIVERGENCIA).split(',')
  : ITENS_SEM_DIVERGENCIA_PADRAO
).map(semAcento).filter(Boolean);

// casa por SUBSTRING nos dois sentidos: o catalogo tem "Saco de lixo 100L"
// e "Bobina Pequena 57mm", entao comparar nome exato nao pegaria nenhum dos
// dois. Pizza nunca entra aqui.
function foraDaDivergencia(nome) {
  const n = semAcento(nome);
  if (!n) return false;
  return ITENS_SEM_DIVERGENCIA.some((termo) => n.includes(termo) || termo.includes(n));
}

function ordemNormal(a, b) {
  if (a.tipo !== b.tipo) return a.tipo === 'pizza' ? -1 : 1;
  return String(a.nome || '').localeCompare(String(b.nome || ''), 'pt-BR');
}
// O que conta como divergencia e' o que a tela ja marca de vermelho:
// - saida NEGATIVA: sobrou mais do que entrou (contagem ou envio nao lancado)
// - perda em transito POSITIVA: saiu mais do que chegou
// Avaria NAO entra: ela e' declarada de proposito por quem enviou, entao nao
// e' erro pra procurar - e' informacao que ja veio explicada.
// Item sem conta fechada (saida null, periodo nao reconciliavel) tambem nao
// entra: nao da pra afirmar que ha divergencia, so que nao deu pra apurar.
function temDivergencia(item, campoSaida) {
  // item da lista de fora nunca e' divergencia, por mais torta que a conta
  // fique - ver ITENS_SEM_DIVERGENCIA acima
  if (item && item.tipo !== 'pizza' && foraDaDivergencia(item.nome)) return false;
  const saida = item[campoSaida];
  if (Number.isFinite(saida) && saida < 0) return true;
  if (Number.isFinite(item.perdaTransito) && item.perdaTransito > 0) return true;
  return false;
}
// campoSaida: 'saida' no dia a dia, 'saidaApurada' no fluxo do periodo - o
// mesmo numero com nome diferente em cada montagem
function ordenarDivergenciaPrimeiro(campoSaida) {
  return (a, b) => {
    const da = temDivergencia(a, campoSaida);
    const db = temDivergencia(b, campoSaida);
    if (da !== db) return da ? -1 : 1;
    return ordemNormal(a, b);
  };
}

function resumoPorDia(regs, { inicio, fim, ciclos = null }) {
  const dentro = (iso) => { const d = diaDe(iso); return d >= inicio && d <= fim; };
  const envios = regs.filter((r) => r.tipo === 'ENVIO' && dentro(r.criadoEm));
  const contagens = regs.filter((r) => r.tipo === 'CONTAGEM' && dentro(r.criadoEm));
  const todosCiclos = (ciclos || montarCiclos(regs)).filter((c) => c.dia >= inicio && c.dia <= fim);

  const dias = new Map();
  const dia = (d) => {
    if (!dias.has(d)) dias.set(d, { dia: d, contagens: 0, envios: 0, ciclosFechados: 0, itens: new Map() });
    return dias.get(d);
  };
  const slot = (d, it) => {
    if (!d.itens.has(it.chave)) d.itens.set(it.chave, { chave: it.chave, nome: it.nome, tipo: it.tipo, entradas: 0, saida: null });
    const s = d.itens.get(it.chave);
    s.nome = it.nome;
    return s;
  };

  contagens.forEach((c) => { dia(diaDe(c.criadoEm)).contagens += 1; });
  envios.forEach((e) => {
    const d = dia(diaDe(e.criadoEm));
    d.envios += 1;
    entradasDe(e).forEach((it) => { slot(d, it).entradas += it.qtd; });
  });
  todosCiclos.forEach((c) => {
    const d = dia(c.dia);
    d.ciclosFechados += 1;
    c.itens.forEach((i) => { const s = slot(d, i); s.saida = (s.saida || 0) + i.saida; });
  });

  return [...dias.values()]
    .sort((a, b) => b.dia.localeCompare(a.dia))
    .map((d) => ({
      ...d,
      itens: [...d.itens.values()]
        .filter((i) => i.entradas || i.saida != null)
        .sort(ordenarDivergenciaPrimeiro('saida')),
    }));
}

module.exports = {
  diaDe, horaDe, inteiro, emUnidades, itensDe, entradasDe,
  montarCiclos, estimarCapacidades, sugerirEnvio, resumoPorDia,
  ordemNormal, temDivergencia, ordenarDivergenciaPrimeiro,
  foraDaDivergencia, ITENS_SEM_DIVERGENCIA,
};
