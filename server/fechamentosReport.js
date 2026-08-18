// fechamentosReport.js
// Relatorio (CSV/PDF) dos Fechamentos de caixa no periodo filtrado - mesma
// tabela mostrada no painel "Fechamentos" de fechamentos.html, pra levar
// pra fora do sistema (ex: apresentar caixa/quebra do periodo pra alguem
// que nao acessa o dashboard).
//
// As colunas sao montadas do MESMO jeito da tabela da tela (ver
// tabelaFechamentosHtml/colunasExtras em fechamentos.html): alem das fixas
// (Data/Unidade/Responsavel/Faturamento/Total declarado/Diferenca/Quebra/
// Observacao), os campos do schema antigo (Adyen/Ifood/99Food/Pix/Loja) e
// os Canais de venda/Formas de pagamento definidos por grupo em /grupos.html
// SO entram se pelo menos um fechamento do resultado de fato preencheu
// aquele campo - o relatorio sai exatamente com as colunas preenchidas,
// sem colunas fantasmas de R$ 0,00 nem campos lancados ficando de fora.
//
// DIVIDIDO POR REDE (ver redes.js): as linhas saem em duas secoes - Grupo
// Bravo (GBE) e ARCFOOD - cada uma com SUBTOTAL proprio, e um TOTAL GERAL no
// fim. Sao duas operacoes com contabilidade separada; a lista unica obrigava
// quem le a somar na mao pra chegar no numero de cada uma, e era exatamente
// isso que se fazia toda vez que o relatorio era usado.
const PDFDocument = require('pdfkit');
const redes = require('./redes');

function slugify(text) {
  return String(text || 'relatorio-fechamentos')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'relatorio-fechamentos';
}

function fmtData(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).split('-');
  return y && m && d ? `${d}/${m}/${y}` : iso;
}

function fmtMoney(v) {
  return 'R$ ' + (v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const COLUNAS_BASE = [
  { key: 'data', label: 'Data', largura: 58 },
  { key: 'unidadeNome', label: 'Unidade', largura: 58 },
  { key: 'gerente', label: 'Responsável', largura: 46 },
  { key: 'faturamento', label: 'Faturamento', moeda: true, largura: 64 },
  { key: 'totalDeclarado', label: 'Total declarado', moeda: true, largura: 64 },
  { key: 'diferenca', label: 'Diferença', moeda: true, largura: 58 },
  { key: 'quebra', label: 'Quebra', moeda: true, largura: 56 },
  { key: 'entradaDinheiro', label: 'Entrada em dinheiro', moeda: true, largura: 62 },
  { key: 'totalSaida', label: 'Total de saída', moeda: true, largura: 58 },
];
// schema antigo (planilha importada) - MAS "adyen" tambem e a soma da secao
// "Maquininhas (cartao)" de todo lancamento do sistema, por isso o label nao
// pode ser "Adyen" (colidia com a forma de pagamento "Adyen" definida pelo
// grupo, saindo duas colunas "Adyen" no relatorio - ver mesmo fix em
// fechamentos.html). Mesma regra da tela: so aparece se alguma linha usa
const CAMPOS_FIXOS = [
  { key: 'adyen', label: 'Maquininhas (cartão)' }, { key: 'ifood', label: 'Ifood' }, { key: 'food99', label: '99Food' },
  { key: 'pix', label: 'Pix' }, { key: 'loja', label: 'Loja' },
];
const COLUNA_OBSERVACAO = { key: 'observacao', label: 'Observação', largura: 75 };

// colunas extras (Canais de venda / Formas de pagamento) preenchidas em pelo
// menos uma linha - label vem da definicao do grupo da unidade (grupos.js),
// com fallback pro nome do campo (mesma logica de colunasExtras na tela)
function colunasExtrasUsadas(fechamentos, grupos, chave, prefixo) {
  const grupoDe = (u) => (grupos || []).find((g) => (g.unidades || []).includes(u)) || null;
  const vistas = new Map(); // campo -> label
  fechamentos.forEach((f) => {
    const mapa = f[chave] || {};
    if (!Object.keys(mapa).length) return;
    const grupo = grupoDe(f.unidade);
    const defs = grupo ? (grupo[chave] || []) : [];
    Object.keys(mapa).forEach((campo) => {
      if (!vistas.has(campo)) vistas.set(campo, (defs.find((k) => k.campo === campo) || {}).label || campo);
    });
  });
  return [...vistas.entries()].map(([campo, label]) => ({ key: prefixo + campo, label, moeda: true, largura: 58, origem: chave, campo }));
}

// ---------- colunas de valor unificadas por NOME ----------
// A MESMA coisa do mundo real pode estar gravada em dois lugares, conforme a
// origem da linha: "Ifood" de um fechamento antigo esta no campo fixo `ifood`
// (schema da planilha), e o de um lançamento do sistema esta em
// canaisVendaExtras.ifood (canal que o Master cadastrou em /grupos.html).
// Sem unificar, saiam DUAS colunas "Ifood" no CSV/PDF - uma preenchida e a
// outra zerada. Mesma logica (e mesmos comentarios) de colunasValores em
// public/fechamentos.html: as duas precisam concordar, senao a coluna que a
// pessoa esconde/reordena na tela nao bate com a do relatorio.
function chaveLabel(label) {
  return String(label || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
// a key vem sempre da PRIMEIRA fonte na ordem em que as listas chegam
// (fixo > canal > forma) - nunca da ordem dos dados, senao a mesma coluna
// mudaria de key conforme o filtro e a preferencia salva na tela pararia de
// casar com a do relatorio
function unificarPorNome(colunas) {
  const porNome = new Map();
  colunas.forEach((c) => {
    const k = chaveLabel(c.label);
    if (!porNome.has(k)) porNome.set(k, { ...c, fontes: [] });
    porNome.get(k).fontes.push({ origem: c.origem, campo: c.campo, key: c.key });
  });
  return [...porNome.values()];
}
// soma as fontes em vez de pegar a primeira: uma linha so grava em UMA
// delas, entao na pratica e um "pega onde tiver" - mas se as duas vierem
// preenchidas, somar e a leitura honesta em vez de esconder uma
function valorColuna(f, col) {
  return col.fontes.reduce((soma, fonte) => soma + Number(
    fonte.origem ? ((f[fonte.origem] || {})[fonte.campo] || 0) : (f[fonte.key] || 0),
  ), 0);
}

// aplica a ordem escolhida no seletor 🧩 Colunas de fechamentos.html (chega
// via ?ordem=, lista de keys separada por virgula - mesmo array lido da
// ordem literal das divs no seletor, ver salvarColunas). Data/Unidade
// sempre ficam primeiro (ancora de leitura, nunca reordenam - mesma regra
// do filtro de ocultas acima); colunas que a lista nao menciona (novas, ou
// de outro grupo que nao passou pelo seletor ainda) mantem a ordem padrao,
// no fim - Array.prototype.sort e estavel, entao a ordem relativa entre
// colunas nao mencionadas se preserva
function ordenarColunas(colunas, ordem) {
  const indice = new Map(ordem.map((k, i) => [k, i]));
  const fixas = colunas.filter((c) => c.key === 'data' || c.key === 'unidadeNome');
  const resto = colunas.filter((c) => c.key !== 'data' && c.key !== 'unidadeNome');
  resto.sort((a, b) => {
    const ia = indice.has(a.key) ? indice.get(a.key) : Number.MAX_SAFE_INTEGER;
    const ib = indice.has(b.key) ? indice.get(b.key) : Number.MAX_SAFE_INTEGER;
    return ia - ib;
  });
  return [...fixas, ...resto];
}

// monta colunas (na ordem da tela) + linhas ja com todos os valores
// achatados por key - "grupos" e a lista de grupos.list() (pros labels).
// "ocultas" (Set de keys, opcional) sao as colunas que o usuario escondeu
// no seletor 🧩 Colunas de fechamentos.html (chegam via ?ocultas=) - mesmas
// keys da tela, entao a escolha vale igual na tabela e no CSV/PDF;
// Data/Unidade nunca saem (ancora de leitura do relatorio). "ordem" (array
// de keys, opcional) e a reordenacao escolhida no mesmo seletor.
function prepararRelatorio(fechamentos, grupos, ocultas, ordem) {
  const rows = [...fechamentos].sort((a, b) => (b.data || '').localeCompare(a.data || ''));
  const fixasUsadas = CAMPOS_FIXOS
    .filter((c) => rows.some((f) => Math.abs(f[c.key] || 0) > 0.001))
    .map((c) => ({ ...c, moeda: true, largura: 58 }));
  const canais = colunasExtrasUsadas(rows, grupos, 'canaisVendaExtras', 'canal:');
  const formas = colunasExtrasUsadas(rows, grupos, 'formasPagamentoExtras', 'forma:');
  const colunasDeValor = unificarPorNome([...fixasUsadas, ...canais, ...formas]);
  let colunas = [...COLUNAS_BASE, ...colunasDeValor, COLUNA_OBSERVACAO];
  if (ocultas && ocultas.size) {
    colunas = colunas.filter((c) => c.key === 'data' || c.key === 'unidadeNome' || !ocultas.has(c.key));
  }
  if (ordem && ordem.length) {
    colunas = ordenarColunas(colunas, ordem);
  }

  const linhas = rows.map((f) => {
    const linha = {
      // codigo da unidade fica na linha (sem virar coluna) so pra dividir
      // por rede - o relatorio mostra o NOME, nao o codigo
      _unidade: f.unidade,
      data: f.data,
      unidadeNome: f.unidadeNome || f.unidade,
      gerente: f.gerente || '—',
      faturamento: f.faturamento || 0,
      totalDeclarado: f.totalDeclarado || 0,
      diferenca: f.diferenca || 0,
      quebra: f.quebra || 0,
      entradaDinheiro: f.entradaDinheiro || 0,
      totalSaida: f.totalSaida || 0,
      observacao: f.observacao || f.obsDif || '—',
    };
    colunasDeValor.forEach((c) => { linha[c.key] = valorColuna(f, c); });
    return linha;
  });
  return { colunas, linhas, secoes: dividirPorRede(colunas, linhas) };
}

// ---------------------------------------------------------------
// divisao por rede + subtotais
// ---------------------------------------------------------------
// Subtotal soma TODA coluna de dinheiro, inclusive os canais/formas extras
// que aparecerem - somar so faturamento deixaria as demais colunas sem
// fechamento no fim da secao, que e onde a pessoa procura o numero.
function somar(colunas, linhas) {
  const soma = {};
  colunas.filter((c) => c.moeda).forEach((c) => {
    soma[c.key] = linhas.reduce((s, l) => s + (Number(l[c.key]) || 0), 0);
  });
  return soma;
}

// [{ id, nome, linhas, subtotal, qtd }] - rede sem linha nenhuma fica de
// fora (ver agruparPorRede em redes.js)
function dividirPorRede(colunas, linhas) {
  return redes.agruparPorRede(linhas, '_unidade').map((g) => ({
    id: g.id,
    nome: g.nome,
    linhas: g.itens,
    qtd: g.itens.length,
    subtotal: somar(colunas, g.itens),
  }));
}

function formatarCelula(coluna, valor) {
  if (coluna.key === 'data') return fmtData(valor);
  if (coluna.moeda) return fmtMoney(valor);
  return valor ?? '';
}

function toCSV(colunas, linhas, secoes) {
  const escape = (v) => {
    let s = String(v ?? '');
    // neutraliza injecao de formula: uma celula que comeca com = + - @ (ou
    // tab/CR) e executada como formula pelo Excel/Sheets ao abrir o CSV, e
    // parte desses valores vem de fora (nome digitado pelo cliente, descricao
    // de ticket) - prefixa com apostrofo pra forcar leitura como texto puro
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const linhaCsv = (l) => colunas.map((c) => escape(formatarCelula(c, l[c.key]))).join(',');
  // linha de soma: 1a coluna vira o rotulo, so as de dinheiro trazem numero
  // (repetir data/unidade numa linha de soma seria mentira) - mesma regra do PDF
  const linhaSoma = (soma, rotulo) => colunas
    .map((c, i) => escape(i === 0 ? rotulo : (c.moeda ? fmtMoney(soma[c.key] || 0) : '')))
    .join(',');

  const out = [colunas.map((c) => escape(c.label)).join(',')];
  if (secoes && secoes.length) {
    secoes.forEach((sec) => {
      // titulo da secao ocupa so a 1a coluna - abrir no Excel e ver a faixa
      // do mesmo jeito que no PDF
      out.push(escape(`${sec.nome} · ${sec.qtd} fechamento(s)`) + ','.repeat(Math.max(0, colunas.length - 1)));
      sec.linhas.forEach((l) => out.push(linhaCsv(l)));
      out.push(linhaSoma(sec.subtotal, `SUBTOTAL ${sec.nome}`));
      out.push('');
    });
    // com uma rede so, o total geral seria a repeticao literal do subtotal
    if (secoes.length > 1) out.push(linhaSoma(somar(colunas, linhas), 'TOTAL GERAL'));
  } else {
    linhas.forEach((l) => out.push(linhaCsv(l)));
  }
  // BOM no inicio - sem isso o Excel/Sheets as vezes le acentos errado num CSV UTF-8
  return '﻿' + out.join('\r\n');
}

// larguras: cada coluna tem a sua (ver defs acima); quando o total passa da
// area util do A4 paisagem (~761pt, ja descontadas as margens), todas
// encolhem na mesma proporcao pra caber - com muitos canais/formas extras as
// colunas ficam mais apertadas, mas nenhuma fica de fora
const AREA_UTIL_PT = 761;
function largurasAjustadas(colunas) {
  const total = colunas.reduce((s, c) => s + (c.largura || 58), 0);
  const fator = total > AREA_UTIL_PT ? AREA_UTIL_PT / total : 1;
  const larg = {};
  colunas.forEach((c) => { larg[c.key] = Math.floor((c.largura || 58) * fator); });
  return larg;
}

function writePDF(res, { titulo, subtitulo, colunas, linhas, secoes, nomeArquivo }) {
  const doc = new PDFDocument({ margin: 36, size: 'A4', layout: 'landscape' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${slugify(nomeArquivo || titulo)}.pdf"`);
  doc.pipe(res);

  const tableX = doc.page.margins.left;
  const larg = largurasAjustadas(colunas);
  const tableWidth = colunas.reduce((s, c) => s + larg[c.key], 0);
  // quando as colunas encolheram pra caber (muitos canais/formas), a fonte
  // encolhe junto - senao "R$ 1.771,94" nao cabe e vira "..."
  const totalDesejado = colunas.reduce((s, c) => s + (c.largura || 58), 0);
  const fonteTabela = totalDesejado > AREA_UTIL_PT ? Math.max(6, Math.floor(8 * AREA_UTIL_PT / totalDesejado)) : 8;

  const totalFechamentos = linhas.length;
  const faturamentoTotal = linhas.reduce((s, l) => s + l.faturamento, 0);
  const declaradoTotal = linhas.reduce((s, l) => s + l.totalDeclarado, 0);
  const diferencaTotal = linhas.reduce((s, l) => s + l.diferenca, 0);

  function cabecalhoPagina() {
    doc.fontSize(8).fillColor('#5b6470').text('SOLUTIONS TI TECH · ZENITH OPS · RELATÓRIO DE FECHAMENTOS', tableX, 30, { characterSpacing: 1 });
    doc.fontSize(16).fillColor('#111').text(titulo, tableX, 42);
    doc.fontSize(9).fillColor('#666').text(subtitulo, tableX, 64);
  }

  function resumo(y) {
    const itens = [
      [String(totalFechamentos), 'fechamentos no período'],
      [fmtMoney(faturamentoTotal), 'faturamento total'],
      [fmtMoney(declaradoTotal), 'total declarado'],
      [fmtMoney(diferencaTotal), 'diferença de caixa'],
    ];
    let x = tableX;
    itens.forEach(([val, lbl]) => {
      doc.fontSize(16).fillColor('#111').text(val, x, y);
      doc.fontSize(8).fillColor('#666').text(lbl.toUpperCase(), x, y + 20, { width: 160, characterSpacing: 0.5 });
      x += 165;
    });
    return y + 46;
  }

  function linhaCabecalhoTabela(y) {
    doc.rect(tableX, y, tableWidth, 20).fill('#eef1f4');
    doc.fillColor('#333').fontSize(fonteTabela);
    let x = tableX;
    for (const c of colunas) {
      doc.text(c.label.toUpperCase(), x + 4, y + 6, { width: larg[c.key] - 8 });
      x += larg[c.key];
    }
    return y + 20;
  }

  const alturaLinha = 18;
  // cursor vertical compartilhado por todos os helpers abaixo (faixa de
  // secao, linha e quebra de pagina leem e avancam o MESMO y)
  let y = doc.page.margins.top;
  const cabeNaPagina = (altura) => y + altura <= doc.page.height - doc.page.margins.bottom;
  function novaPagina() {
    doc.addPage();
    y = linhaCabecalhoTabela(doc.page.margins.top);
    doc.fontSize(fonteTabela).fillColor('#222');
  }

  // faixa com o nome da rede - e o que faz as duas operacoes se lerem
  // separadas de relance, sem precisar conferir unidade por unidade
  function faixaSecao(nome, qtd) {
    if (!cabeNaPagina(24 + alturaLinha)) novaPagina();  // faixa orfa no pe da pagina nao ajuda ninguem
    doc.rect(tableX, y, tableWidth, 20).fill('#dfe6ee');
    doc.fillColor('#1b2733').fontSize(Math.max(7, fonteTabela + 1))
      .text(`${nome} · ${qtd} fechamento(s)`, tableX + 4, y + 6, { width: tableWidth - 8 });
    doc.fontSize(fonteTabela).fillColor('#222');
    y += 20;
  }

  function linhaValores(linha, { negrito = false, fundo = null, rotulo = null } = {}) {
    if (!cabeNaPagina(alturaLinha)) novaPagina();
    if (fundo) doc.rect(tableX, y, tableWidth, alturaLinha).fill(fundo);
    doc.fillColor(negrito ? '#111' : '#222').fontSize(fonteTabela);
    let x = tableX;
    colunas.forEach((c, i) => {
      // no subtotal, a 1a coluna vira o rotulo e so as de dinheiro trazem
      // numero - repetir data/unidade numa linha de soma seria mentira
      const texto = rotulo != null
        ? (i === 0 ? rotulo : (c.moeda ? fmtMoney(linha[c.key] || 0) : ''))
        : String(formatarCelula(c, linha[c.key]) ?? '');
      doc.text(texto, x + 4, y + 5, { width: larg[c.key] - 8, height: alturaLinha - 4, ellipsis: true });
      x += larg[c.key];
    });
    doc.moveTo(tableX, y + alturaLinha).lineTo(tableX + tableWidth, y + alturaLinha)
      .strokeColor(negrito ? '#98a4b3' : '#ddd').lineWidth(negrito ? 1 : 0.5).stroke();
    y += alturaLinha;
  }

  cabecalhoPagina();
  y = resumo(90);
  y = linhaCabecalhoTabela(y);

  if (!linhas.length) {
    doc.fontSize(10).fillColor('#888').text('Nenhum fechamento encontrado nesse período.', tableX, y + 12);
    doc.end();
    return;
  }

  doc.fontSize(fonteTabela).fillColor('#222');
  if (secoes && secoes.length) {
    secoes.forEach((sec, i) => {
      // cada rede comeca numa PAGINA nova: o relatorio e entregue por
      // operacao (imprime/manda so as folhas do GBE, so as da ARCFOOD), e
      // com as duas na mesma folha isso nao da pra fazer
      if (i > 0) novaPagina();
      faixaSecao(sec.nome, sec.qtd);
      sec.linhas.forEach((l) => linhaValores(l));
      linhaValores(sec.subtotal, { negrito: true, fundo: '#f4f7fa', rotulo: `SUBTOTAL ${sec.nome}` });
    });
    // com uma rede so, o total geral seria a repeticao literal do subtotal
    if (secoes.length > 1) {
      // consolidado tambem em folha propria - se ficasse no pe da ultima
      // secao, seria lido como se fosse total da ARCFOOD
      novaPagina();
      faixaSecao('CONSOLIDADO · todas as redes', linhas.length);
      linhaValores(somar(colunas, linhas), { negrito: true, fundo: '#e6ecf3', rotulo: 'TOTAL GERAL' });
    }
  } else {
    linhas.forEach((l) => linhaValores(l));
  }

  doc.end();
}

module.exports = { slugify, prepararRelatorio, dividirPorRede, somar, toCSV, writePDF };
