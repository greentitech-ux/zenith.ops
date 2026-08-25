// saidasPainel.js
// Junta as duas fontes de "dinheiro que saiu do caixa" (pedido do usuario:
// "Painel das Saidas, Sangrias/Depositos") numa lista so, cada item com uma
// "chave" estavel e um estado de verificacao (conferencia contra
// extrato/comprovante, feita por Master ou Admin - ver index.js):
//
//   - Sangria/Deposito: coleção própria (sangrias.js), já tem id e já
//     guarda o próprio estado de verificação.
//   - "Outras saídas" avulsas do Fechamento (detalhesSaidas, ver
//     fechamentosLive.js): array sem id próprio - o estado de verificação
//     mora em verificacoesSaida.js, referenciado por chave
//     `${fechamentoId}::${indice}`.
//
// So leitura (listar/filtrar) + o dispatch de marcarVerificada pra cada
// fonte - a validacao/gravacao de verdade continua em cada modulo dono do
// dado (sangrias.js / verificacoesSaida.js), este arquivo so junta e roteia.
const fechamentosLive = require('./fechamentosLive');
const sangrias = require('./sangrias');
const verificacoesSaida = require('./verificacoesSaida');

function linhaDeSangria(s) {
  return {
    chave: `sangria::${s.id}`,
    origem: 'sangria',
    unidade: s.unidade,
    unidadeNome: s.unidadeNome,
    grupo: s.grupo,
    data: s.data,
    descricao: s.descricao || 'Sangria/Depósito',
    valor: s.valor,
    criadoPorEmail: s.criadoPorEmail,
    criadoEm: s.criadoEm,
    verificada: !!s.verificada,
    verificadaPorEmail: s.verificadaPorEmail || null,
    verificadaEm: s.verificadaEm || null,
    extra: { periodoInicio: s.periodoInicio, periodoFim: s.periodoFim, nomeDepositante: s.nomeDepositante },
  };
}

function linhasDeFechamento(f, mapaVerif) {
  return (f.detalhesSaidas || []).map((item, idx) => {
    const chave = `${f.id}::${idx}`;
    const v = mapaVerif[chave];
    return {
      chave,
      origem: 'saida',
      unidade: f.unidade,
      unidadeNome: f.unidadeNome,
      grupo: f.grupo,
      data: f.data,
      descricao: item.descricao || 'Saída avulsa',
      valor: item.valor,
      criadoPorEmail: f.gerente || f.criadoPorEmail,
      criadoEm: f.criadoEm,
      verificada: !!(v && v.verificada),
      verificadaPorEmail: (v && v.verificadaPorEmail) || null,
      verificadaEm: (v && v.verificadaEm) || null,
      extra: null,
    };
  });
}

// extrasFechamentos: fechamentos que NÃO moram na coleção fechamentosLive -
// hoje só um caso, o snapshot em memória sincronizado da planilha ARCFOOD
// (ver sheetsSync.js/index.js, fechamentosData). Sem isso, o painel só
// mostrava a saída avulsa lançada direto no app - a itemizada que veio da
// planilha (mesmo já convertida em detalhesSaidas, ver sheetsSync.js)
// nunca aparecia, porque fechamentosLive.listAll() só lê o Firestore.
async function listar(extrasFechamentos = []) {
  const [fechamentos, listaSangrias, mapaVerif] = await Promise.all([
    fechamentosLive.listAll(),
    sangrias.listAll(),
    verificacoesSaida.mapaDeChaves(),
  ]);
  const deSangria = listaSangrias.map(linhaDeSangria);
  const todosFechamentos = [...fechamentos, ...(Array.isArray(extrasFechamentos) ? extrasFechamentos : [])];
  const deFechamento = todosFechamentos.flatMap((f) => linhasDeFechamento(f, mapaVerif));
  return [...deSangria, ...deFechamento];
}

// mesmo formato de filtro usado em fechamentosFiltrados (index.js): unidades
// (array de codigos, vazio/null = todas), grupo (ARCFOOD|BRAVO, vazio =
// os dois), inicio/fim (AAAA-MM-DD, vazio = sem limite daquele lado)
function filtrar(itens, { unidades, grupo, inicio, fim } = {}) {
  const unidadesSet = unidades && unidades.length ? new Set(unidades) : null;
  return itens.filter((it) =>
    (!unidadesSet || unidadesSet.has(it.unidade)) &&
    (!grupo || it.grupo === grupo) &&
    (!inicio || (it.data || '') >= inicio) &&
    (!fim || (it.data || '') <= fim));
}

// resolve a chave pra sangria (id proprio na colecao sangrias) ou pra saida
// avulsa (indice dentro de um fechamento) e despacha pro modulo dono -
// valida que a chave aponta pra algo que existe de verdade (sem isso,
// qualquer chave inventada criaria um registro orfao em
// verificacoesSaidasFechamento)
async function marcarVerificada(chave, { verificada, porId, porEmail }, extrasFechamentos = []) {
  if (typeof chave !== 'string' || !chave) throw new Error('Chave inválida.');
  if (chave.startsWith('sangria::')) {
    const id = chave.slice('sangria::'.length);
    const s = await sangrias.marcarVerificada(id, { verificada, porId, porEmail });
    return { chave, verificada: !!s.verificada, verificadaPorEmail: s.verificadaPorEmail || null, verificadaEm: s.verificadaEm || null };
  }
  const partes = chave.split('::');
  const idx = Number(partes.pop());
  const fechamentoId = partes.join('::');
  // o fechamento pode não estar no Firestore (fechamentosLive) - é o caso do
  // snapshot sincronizado da planilha ARCFOOD, que só existe em memória (ver
  // listar() acima) - cai pra ele antes de recusar como "não encontrado"
  const f = (await fechamentosLive.getOne(fechamentoId))
    || (Array.isArray(extrasFechamentos) ? extrasFechamentos : []).find((x) => x.id === fechamentoId)
    || null;
  if (!f || !Number.isInteger(idx) || !(f.detalhesSaidas || [])[idx]) {
    throw new Error('Saída não encontrada nesse fechamento.');
  }
  const r = await verificacoesSaida.marcar(chave, { verificada, porId, porEmail });
  return { chave, verificada: r.verificada, verificadaPorEmail: r.verificadaPorEmail, verificadaEm: r.verificadaEm };
}

module.exports = { listar, filtrar, marcarVerificada };
