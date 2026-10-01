// entregasSync.js
// Sincroniza o histórico de entregas (motoboys) direto da planilha "MOTOS
// BRAVO" do Google Sheets - a mesma que hoje alimenta o app de entregas no
// AppSheet. Reaproveita a mesma autenticação de conta de serviço do
// sheetsSync.js (fechamentos): a planilha precisa estar compartilhada com
// esse mesmo email (FIREBASE_CLIENT_EMAIL) como leitora.
//
// A aba "BDMotos" fica de fora de propósito: ela não tem a coluna "Data"
// preenchida (só "Dia", o dia da semana) - decisão combinada com o cliente
// em 2026-08-02: essa aba entra depois, quando a data de cada linha puder
// ser resgatada (histórico de versões da planilha ou export do próprio
// AppSheet). As outras 5 abas de entrega têm Data+Mês preenchidos e já
// entram nessa sincronização.
const { buscarAba, buscarLinhasNovas, listarAbas, getAccessToken, parseMoneyBR, criarPersistenciaEstado } = require('./sheetsSync');

const SPREADSHEET_ID = process.env.SHEET_ID_ENTREGAS || '14qb8V0fCqgGFmHDISm4HIArAmDZ0QJN8uD7B6zRIYTk';
// a aba "MMTirol" saiu: era a unica de "MMTirol Natal", unidade que o
// Master excluiu em definitivo (ver CODIGOS_REMOVIDOS em
// migracaoUnidades.js). Sem tirar daqui, cada sync trazia as linhas de
// volta e o codigo reaparecia na montagem do mapa de unidades.
const ABAS = (process.env.SHEET_ABAS_ENTREGAS || 'Garanhuns,Bessa,Caruaru,Tirol')
  .split(',').map((s) => s.trim()).filter(Boolean);

// Campina entrou depois no NoPulso. A fonte pode ter sido nomeada Campina,
// Campina Grande ou Campina Motos; procuramos só abas que contenham Campina
// no nome, sem alterar a planilha e sem misturar com os históricos das lojas.
async function fontesDeLeitura() {
  const fontes = ABAS.map((aba) => ({ aba, unidadePadrao: null, modeloLancamento: null }));
  const configurada = String(process.env.SHEET_ABA_ENTREGAS_CAMPINA || '').trim();
  if (configurada) return [...fontes, { aba: configurada, unidadePadrao: 'Dominos Campina Grande', modeloLancamento: 'total' }];
  try {
    const abas = await listarAbas(SPREADSHEET_ID, await getAccessToken());
    const abaCampina = abas.find((aba) => /campina/i.test(aba));
    if (abaCampina && !fontes.some((f) => f.aba.toLowerCase() === abaCampina.toLowerCase())) {
      fontes.push({ aba: abaCampina, unidadePadrao: 'Dominos Campina Grande', modeloLancamento: 'total' });
    }
  } catch (_) {
    // A leitura normal continua mesmo se a listagem de metadados falhar.
  }
  return fontes;
}

const MESES_PT = { jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6, jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12 };

// a planilha "MOTOS BRAVO" continua com o codigo ANTIGO na coluna "Unidade"
// (Bessa/Caruaru/Garanhuns) - nao dá pra editar a planilha em produção
// daqui, então normaliza pro codigo unificado (= codigo do Fechamento, ver
// ENTREGAS_UNIDADES_NOMES em index.js) direto na leitura, pra toda linha
// nova continuar caindo no mesmo cadastro. Mesmo mapa de migracaoUnidades.js
// (reaproveitado, não duplicado, pra nunca desalinhar os dois)
const { MAPA_CODIGO_ENTREGAS_PARA_FECHAMENTO: CODIGO_ANTIGO_PARA_NOVO } = require('./migracaoUnidades');

// "24/12" (Data) + "dez./25" ou "DEZ./2025" (Mes, ano com 2 ou 4 dígitos) -> "2025-12-24"
function parseData(dataStr, mesStr) {
  const completa = String(dataStr || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (completa) {
    const ano = completa[3].length === 2 ? `20${completa[3]}` : completa[3];
    const iso = `${ano}-${String(completa[2]).padStart(2, '0')}-${String(completa[1]).padStart(2, '0')}`;
    const d = new Date(`${iso}T00:00:00Z`);
    if (!Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso) return iso;
  }
  const dia = parseInt(String(dataStr || '').split('/')[0], 10);
  const m = String(mesStr || '').toLowerCase().match(/([a-z]{3})\.?\/(\d{2,4})/);
  if (!dia || !m || !MESES_PT[m[1]]) return null;
  const ano = m[2].length === 2 ? `20${m[2]}` : m[2];
  return `${ano}-${String(MESES_PT[m[1]]).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// algumas colunas mudam de nome de aba pra aba (mesmo dado, rótulo
// diferente) - pega o primeiro nome que existir e tiver valor na linha
function chave(s) { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9]+/g, '').toLowerCase(); }
function getPrimeiro(header, linha, nomes) {
  for (const nome of nomes) {
    const i = header.findIndex((h) => chave(h) === chave(nome));
    if (i >= 0 && linha[i] !== undefined && linha[i] !== '') return linha[i];
  }
  return undefined;
}

// Evita que uma aba de fechamento com "Campina" no nome seja tratada como
// histórico de entregas. A fonte de Campina só é aceita quando possui data,
// quantidade e valor total (os três dados mínimos do novo modelo).
function cabecalhoCampinaValido(header) {
  const chaves = new Set((header || []).map(chave));
  const tem = (nomes) => nomes.some((nome) => chaves.has(chave(nome)));
  return tem(['Data'])
    && tem(['Entrega', 'Entregas', 'Quantidade de Entregas', 'Quantidade', 'Qtd.', 'Quant.'])
    && tem(['Valor', 'Valor Total', 'Total', 'Valor a Pagar']);
}

function linhaParaEntrega(aba, header, linha, { unidadePadrao = null, modeloLancamento = null, linhaNumero = null } = {}) {
  const get = (nome) => {
    return getPrimeiro(header, linha, [nome]);
  };

  const id = get('ID') || (linhaNumero != null ? `linha-${linhaNumero}` : null);
  if (!id) return null; // linha vazia/separadora

  const data = parseData(get('Data'), get('Mes'));
  if (!data) return null; // sem data nao da pra mostrar no dashboard por periodo

  // A aba exclusiva de Campina é sempre da própria unidade. Assim, uma coluna
  // legada/errada não fragmenta o histórico em outro código de unidade.
  const unidadeBruta = unidadePadrao || get('Unidade');
  if (!unidadeBruta) return null;
  const unidade = CODIGO_ANTIGO_PARA_NOVO[unidadeBruta] || unidadeBruta;

  return {
    id: `${aba.toLowerCase()}-${id}`,
    unidade,
    // unidadeNome fica de fora de proposito - se viesse igual ao codigo
    // (unidade) aqui, ele "envenenava" o nome bonito exibido em outras telas
    // (ver nomeCanonicoUnidade em index.js, que so usa esse campo de
    // fallback pra codigo que ainda nao tem apelido cadastrado)
    data,
    entregador: getPrimeiro(header, linha, ['Nome', 'Entregador', 'Motoboy', 'Tipo de Entregador']) || '',
    tipoEntregador: getPrimeiro(header, linha, ['Tipo de Entregador', 'Tipo', 'Modalidade']) || null,
    entrega: num(getPrimeiro(header, linha, ['Entrega', 'Entregas', 'Quantidade de Entregas', 'Quantidade', 'Qtd.', 'Quant.'])),
    retorno: num(get('Retorno')),
    obsRetorno: get('Obs. Retorno') || null,
    extra: num(get('Extra')),
    obsExtra: get('Obs. Extra') || null,
    bonus: parseMoneyBR(getPrimeiro(header, linha, ['Valor Gami', 'Valor NEXT'])),
    pos00hs: num(get('Pos 00hs')),
    foraDeArea: num(get('Fora de Area')),
    ajudaCusto: parseMoneyBR(getPrimeiro(header, linha, ['Ajuda de Custo', 'Encosta', 'ac'])),
    valor: parseMoneyBR(getPrimeiro(header, linha, ['Valor', 'Valor Total', 'Total', 'Valor a Pagar'])),
    coopRecebe: parseMoneyBR(get('COOP Recebe')),
    quantTotal: num(getPrimeiro(header, linha, ['Quant.', 'Quantidade', 'Quantidade de Entregas', 'Entrega', 'Entregas'])),
    observacao: getPrimeiro(header, linha, ['Obs.', 'Obs']) || null,
    // referência ao arquivo original no Drive do AppSheet - ainda não
    // migrado pro nosso Storage (fica só como referência de texto por ora)
    etiquetaOrigem: get('Etiquetas') || null,
    modeloLancamento: modeloLancamento || 'detalhado',
    historico: true, // vem direto da planilha - somente leitura, não passa por solicitação de edição
  };
}

// lê as abas configuradas e devolve a lista combinada de entregas históricas,
// no mesmo formato usado pelos lançamentos ao vivo (entregasLive).
//
// Leitura INCREMENTAL, mesmo esquema do sheetsSync.sincronizar: primeira
// leitura (boot ou completa=true) traz a aba inteira e guarda o ponto onde
// parou; as seguintes leem so as linhas novas do fim em diante. Linha antiga
// editada so entra com completa=true.
const estadoSyncEntregas = new Map(); // aba -> { header, linhasLidas, brutos }
// estado persistido no Storage, igual ao dos fechamentos: o ponto da ultima
// leitura sobrevive a reinicio, e ate o boot le so as linhas novas
const persistenciaEntregas = criarPersistenciaEstado('sync-estado/entregas.json', estadoSyncEntregas, 'entregasSync');

async function sincronizar({ completa = false } = {}) {
  if (!completa) await persistenciaEntregas.carregar();
  const resultado = [];
  let linhasNovas = 0;
  const fontes = await fontesDeLeitura();
  for (const fonte of fontes) {
    const { aba } = fonte;
    let estado = completa ? null : estadoSyncEntregas.get(aba);
    if (!estado) {
      const valores = await buscarAba(SPREADSHEET_ID, aba);
      if (!valores.length) { estadoSyncEntregas.delete(aba); continue; }
      const header = valores[0];
      if (fonte.modeloLancamento === 'total' && !cabecalhoCampinaValido(header)) {
        estadoSyncEntregas.delete(aba);
        continue;
      }
      const brutos = [];
      for (let i = 1; i < valores.length; i++) {
        const entrega = linhaParaEntrega(aba, header, valores[i], { ...fonte, linhaNumero: i + 1 });
        if (entrega) brutos.push(entrega);
      }
      estado = { header, linhasLidas: valores.length, brutos };
      estadoSyncEntregas.set(aba, estado);
      linhasNovas += valores.length - 1;
    } else {
      const novas = await buscarLinhasNovas(SPREADSHEET_ID, aba, estado.linhasLidas + 1);
      for (let i = 0; i < novas.length; i++) {
        const entrega = linhaParaEntrega(aba, estado.header, novas[i], { ...fonte, linhaNumero: estado.linhasLidas + i + 1 });
        if (entrega) estado.brutos.push(entrega);
      }
      estado.linhasLidas += novas.length;
      linhasNovas += novas.length;
    }
    resultado.push(...estado.brutos);
  }
  if (linhasNovas > 0) await persistenciaEntregas.salvar();
  resultado.linhasNovas = linhasNovas;
  resultado.fontes = fontes.map((fonte) => fonte.aba);
  return resultado;
}

module.exports = { sincronizar, parseData };
