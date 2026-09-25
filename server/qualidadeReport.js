// qualidadeReport.js
//
// O LAUDO DA VISITA, em PDF - o que hoje é o PPTX que a nutricionista monta
// à mão depois de voltar da loja (o "RELATÓRIO DE VISITA SÃO BRAZ").
//
// A estrutura é a daquele arquivo, porque é a que o cliente já sabe ler:
// capa, dados da unidade, e daí em diante UM BLOCO POR APONTAMENTO - foto,
// o que foi visto, ação corretiva, e o espaço onde a loja responde.
//
// COR AQUI É HEX PRÓPRIO, e isso é de propósito (CLAUDE.md §2): relatório e
// e-mail não passam pelo CSS do app, então var(--accent) não existe neste
// arquivo. As três cores de faixa são as mesmas do relatorioMV.js, pra dois
// relatórios da casa não usarem verdes diferentes.
const path = require('path');
const PDFDocument = require('pdfkit');
const storage = require('./storage');

const LOGO_GRUPO_BRAVO = path.join(__dirname, 'public', 'grupo-bravo.png');
const LOGO_DOMINOS = path.join(__dirname, 'public', 'branding', 'dominos-pizza.png');
// Vai no header HTTP do PDF. Não é decorativo: permite distinguir, no
// atendimento, um PDF guardado pelo celular de um laudo realmente gerado pelo
// servidor antigo.
const VERSAO_LAUDO = 'QA-2026.09.25.8';

const COR = {
  texto: '#1a1a1a',
  fraco: '#6b7280',
  linha: '#d8dde3',
  positiva: '#1a7f37',
  atencao: '#b8860b',
  negativa: '#c62828',
};
const FAIXA_TITULO = {
  positiva: 'PONTUAÇÃO POSITIVA',
  atencao: 'PONTUAÇÃO DE ATENÇÃO',
  negativa: 'PONTUAÇÃO NEGATIVA',
};

const MARCAS = {
  dominos: { nome: 'DOMINO’S', cor: '#006491', apoio: '#e31837', logo: LOGO_DOMINOS },
  spoleto: { nome: 'SPOLETO', cor: '#9e1b32', apoio: '#f4b400' },
  milkymoo: { nome: 'MILKY MOO', cor: '#5b2a86', apoio: '#f6d743' },
  'milk-moo': { nome: 'MILKY MOO', cor: '#5b2a86', apoio: '#f6d743' },
  'sao-braz': { nome: 'SÃO BRAZ', cor: '#7a3e1d', apoio: '#d6a44a' },
  saobraz: { nome: 'SÃO BRAZ', cor: '#7a3e1d', apoio: '#d6a44a' },
};

function dataBR(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso || '');
}
function horaBR(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
}
function notaBR(nota) {
  return nota === null || nota === undefined ? '—' : Number(nota).toFixed(2).replace('.', ',');
}

// Uma foto de celular em pé tem 3000px de altura: jogada crua no PDF, ocupa
// a página inteira e empurra a ação corretiva pra folha seguinte - que é
// exatamente o que faz um laudo virar 40 páginas. `fit` mantém a proporção
// dentro da caixa.
// Evidência precisa continuar nítida no impresso, mas 150 pt por foto fazia
// até apontamentos curtos ocuparem uma página inteira. A caixa abaixo mantém
// leitura confortável em A4 e permite reunir mais de um apontamento por folha.
const FOTO_ALT = 108;
const FOTOS_POR_LINHA = 4;
async function desenharFotos(doc, fotos, largura) {
  if (!fotos || !fotos.length) return;
  const gap = 6;
  const porLinha = Math.min(fotos.length, FOTOS_POR_LINHA);
  const larguraFoto = (largura - gap * (porLinha - 1)) / porLinha;
  let x = doc.page.margins.left;
  const y = doc.y;
  let desenhou = 0;
  for (const foto of fotos.slice(0, FOTOS_POR_LINHA)) {
    try {
      const buffer = await storage.baixarArquivo(foto.path);
      doc.image(buffer, x, y, { fit: [larguraFoto, FOTO_ALT], align: 'center' });
      desenhou += 1;
    } catch (e) {
      // foto que não abre não pode derrubar o laudo inteiro: o apontamento
      // continua valendo pelo texto
      doc.rect(x, y, larguraFoto, FOTO_ALT).stroke(COR.linha);
      doc.fontSize(8).fillColor(COR.fraco).text('(foto indisponível)', x, y + FOTO_ALT / 2 - 4, { width: larguraFoto, align: 'center' });
    }
    x += larguraFoto + gap;
  }
  doc.y = y + FOTO_ALT + 6;
  doc.x = doc.page.margins.left;
  return desenhou;
}

function marcaDaVisita(visita) {
  const modelo = visita.modeloSnap || {};
  const chave = String(modelo.marca || visita.marca || '').trim().toLowerCase();
  return MARCAS[chave] || { nome: chave ? chave.toUpperCase() : 'NO PULSO', cor: '#1f2937', apoio: '#b6ff36' };
}

// Não depende de imagem externa: o laudo não perde a identidade da franquia
// quando é aberto sem internet ou depois de uma troca de servidor. Para a
// Domino's, o símbolo de dominó é desenhado junto do nome; nas demais marcas,
// a assinatura tipográfica usa as cores da identidade cadastrada.
function desenharMarca(doc, marca, x, y, largura) {
  const altura = marca.logo ? 64 : 48;
  if (marca.logo) {
    // A logo oficial é fornecida pela operação e fica local ao projeto: o PDF
    // mantém a marca certa mesmo sem acesso à internet.
    doc.roundedRect(x, y, largura, altura, 8).fillAndStroke('#ffffff', COR.linha);
    try {
      doc.image(marca.logo, x + 10, y + 7, { fit: [largura - 20, altura - 14], align: 'center', valign: 'center' });
      return;
    } catch (e) { /* usa a marca desenhada abaixo se o arquivo não abrir */ }
  }
  doc.roundedRect(x, y, largura, altura, 8).fill(marca.cor);
  if (marca.nome === 'DOMINO’S') {
    const meio = x + 27;
    doc.roundedRect(x + 10, y + 9, 17, 30, 3).fill('#e31837');
    doc.roundedRect(x + 28, y + 9, 17, 30, 3).fill('#006491');
    doc.circle(x + 18.5, y + 17, 2.2).fill('#ffffff');
    doc.circle(x + 18.5, y + 31, 2.2).fill('#ffffff');
    doc.circle(x + 36.5, y + 24, 2.2).fill('#ffffff');
    doc.font('Helvetica-Bold').fontSize(16).fillColor('#ffffff').text(marca.nome, meio + 8, y + 15, { width: largura - 72 });
  } else {
    doc.rect(x, y, 7, altura).fill(marca.apoio);
    doc.font('Helvetica-Bold').fontSize(16).fillColor('#ffffff').text(marca.nome, x + 18, y + 15, { width: largura - 24 });
  }
}

function desenharFundoDaCapa(doc, marca) {
  const pagina = doc.page;
  // Cor de marca entra como acabamento, não como fundo pesado: a capa continua
  // legível quando impressa, mas deixa de parecer uma folha administrativa.
  doc.save();
  doc.rect(0, 0, pagina.width, 9).fill(marca.cor);
  doc.opacity(0.055).circle(pagina.width - 26, 176, 150).fill(marca.cor);
  doc.opacity(0.035).circle(pagina.width - 116, 255, 210).fill(marca.apoio);
  doc.opacity(1);
  doc.rect(0, pagina.height - 100, pagina.width, 100).fill(marca.cor);
  doc.opacity(0.18).circle(pagina.width - 28, pagina.height - 16, 118).fill(marca.apoio);
  doc.restore();
}

function rodapeDaCapa(doc, visita, marca) {
  const y = doc.page.height - 72;
  const largura = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#ffffff')
    .text('VISTORIA Q.A. · RELATÓRIO OFICIAL', doc.page.margins.left, y, { width: largura });
  doc.font('Helvetica').fontSize(9).fillColor('#ffffff')
    .text(`${visita.loja || visita.unidadeNome || 'Unidade'}  •  ${dataBR(visita.data)}  •  ${marca.nome}`, doc.page.margins.left, y + 16, { width: largura });
}

function campoDeCapa(doc, x, y, largura, rotulo, valor) {
  doc.roundedRect(x, y, largura, 43, 5).fillAndStroke('#f7f8fa', COR.linha);
  doc.font('Helvetica-Bold').fontSize(6.5).fillColor(COR.fraco).text(String(rotulo).toUpperCase(), x + 9, y + 7, { width: largura - 18 });
  doc.font('Helvetica').fontSize(9).fillColor(COR.texto).text(String(valor || '—'), x + 9, y + 19, { width: largura - 18, height: 17, ellipsis: true });
}

function precisaNovaPagina(doc, altura) {
  return doc.y + altura > doc.page.height - doc.page.margins.bottom;
}

function alturaApontamento(a) {
  const texto = [a.texto, a.observacao, a.acaoCorretiva, a.espacoCliente, a.revisao && a.revisao.motivo, a.revisao && a.revisao.parecer]
    .filter(Boolean).join(' ');
  const linhas = Math.min(8, Math.max(2, Math.ceil(texto.length / 90)));
  const fotos = a.fotos && a.fotos.length ? FOTO_ALT + 12 : 0;
  return 104 + linhas * 12 + fotos + (a.especificacoes && a.especificacoes.length ? 36 : 0) + (a.revisao ? 54 : 0);
}

function conformesPorSetor(visita) {
  const respostas = visita.respostas || {};
  const setores = (visita.modeloSnap && visita.modeloSnap.setores) || [];
  return setores.map((setor) => {
    const extras = (visita.extras || {})[setor.id] || [];
    const itens = [...(setor.itens || []), ...extras]
      .filter((item) => respostas[item.id] && respostas[item.id].resposta === 'conforme')
      .map((item) => item.texto || item.id);
    return { nome: setor.nome || 'Sem setor', itens };
  }).filter((setor) => setor.itens.length);
}

function resumoDaCapa(doc, visita, largura) {
  const x = doc.page.margins.left;
  const y = doc.y + 10;
  const gap = 8;
  const card = (largura - gap * 2) / 3;
  doc.moveTo(x, y).lineTo(x + largura, y).stroke(COR.linha);
  doc.x = x;
  doc.font('Helvetica-Bold').fontSize(8).fillColor(COR.fraco).text('RESUMO EXECUTIVO', x, y + 13);
  const dados = [
    ['CONFORMES', visita.conformes || 0, COR.positiva],
    ['NÃO CONFORMES', visita.naoConformes || 0, COR.negativa],
    ['ITENS AVALIADOS', visita.total || 0, COR.texto],
  ];
  dados.forEach(([rotulo, valor, cor], i) => {
    const cx = x + i * (card + gap);
    doc.roundedRect(cx, y + 29, card, 53, 5).fillAndStroke('#f7f8fa', COR.linha);
    doc.font('Helvetica-Bold').fontSize(18).fillColor(cor).text(String(valor), cx + 10, y + 37, { width: card - 20, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(6.5).fillColor(COR.fraco).text(rotulo, cx + 6, y + 64, { width: card - 12, align: 'center' });
  });
  doc.y = y + 98;
  doc.x = x;
}

function paginaDeConformes(doc, visita, largura) {
  const porSetor = conformesPorSetor(visita);
  doc.addPage();
  doc.font('Helvetica-Bold').fontSize(18).fillColor(COR.positiva).text('ITENS CONFORMES', { width: largura });
  doc.font('Helvetica').fontSize(10).fillColor(COR.fraco)
    .text(`${visita.conformes || 0} item(ns) em conformidade, agrupado(s) por setor.`);
  doc.moveDown(0.8);

  if (!porSetor.length) {
    doc.font('Helvetica').fontSize(11).fillColor(COR.fraco).text('Nenhum item conforme foi registrado nesta vistoria.');
    return;
  }

  // A capa fica limpa, a segunda página traz a visão positiva completa e só
  // depois começam os apontamentos. Agrupar por setor registra TODOS os
  // conformes sem transformar cada resposta em uma página individual.
  doc.font('Helvetica-Bold').fontSize(8).fillColor(COR.positiva)
    .text(`ITENS CONFORMES · ${visita.conformes || 0}`, { width: largura });
  porSetor.forEach((setor) => {
    doc.font('Helvetica-Bold').fontSize(7.2).fillColor(COR.fraco)
      .text(`${setor.nome.toUpperCase()} · ${setor.itens.length}`, { width: largura });
    doc.font('Helvetica').fontSize(7.5).fillColor(COR.texto)
      .text(setor.itens.join('  •  '), { width: largura });
    doc.moveDown(0.12);
  });
}

function cabecalhoDeBloco(doc, texto, cor) {
  doc.moveDown(0.12);
  doc.fontSize(10).fillColor(cor || COR.texto).font('Helvetica-Bold').text(texto, { width: doc.page.width - doc.page.margins.left - doc.page.margins.right });
  doc.moveDown(0.15);
}

function paragrafo(doc, rotulo, valor) {
  if (!valor) return;
  doc.fontSize(8).fillColor(COR.fraco).font('Helvetica-Bold').text(String(rotulo).toUpperCase());
  doc.fontSize(9).fillColor(COR.texto).font('Helvetica').text(String(valor), { width: doc.page.width - doc.page.margins.left - doc.page.margins.right });
  doc.moveDown(0.22);
}

// espaço EM BRANCO onde a loja escreve à mão quando o laudo é impresso - é o
// "ESPAÇO CLIENTE" da planilha, e ele existe no papel mesmo quando ninguém
// preencheu no app
function espacoDoCliente(doc, texto, largura) {
  doc.fontSize(8).fillColor(COR.fraco).font('Helvetica-Bold').text('ESPAÇO CLIENTE');
  doc.moveDown(0.2);
  if (texto) {
    doc.fontSize(10).fillColor(COR.texto).font('Helvetica').text(texto, { width: largura });
  } else {
    const y = doc.y;
    doc.rect(doc.page.margins.left, y, largura, 24).stroke(COR.linha);
    doc.y = y + 29;
  }
  doc.moveDown(0.16);
}

async function gerarPdf(visita, apontamentos, res, anterior) {
  const doc = new PDFDocument({ margin: 34, size: 'A4' });
  const largura = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.pipe(res);

  // ---------- CAPA ----------
  const marca = marcaDaVisita(visita);
  desenharFundoDaCapa(doc, marca);
  desenharMarca(doc, marca, doc.page.margins.left, 34, 260);
  try {
    // As duas marcas ocupam a mesma faixa visual (50 pt de altura). `fit`
    // preserva a proporção original de cada arquivo, sem alargar o Grupo.
    doc.image(LOGO_GRUPO_BRAVO, doc.page.width - doc.page.margins.right - 130, 41, { fit: [130, 50], align: 'right', valign: 'center' });
  } catch (e) { /* sem logo o laudo sai igual */ }
  doc.y = 116;
  doc.fontSize(8).fillColor(marca.cor).font('Helvetica-Bold').text('Q.A.  •  VISITA TÉCNICA', { width: largura });
  doc.moveDown(0.25);
  doc.fontSize(20).fillColor(COR.texto).font('Helvetica-Bold').text('RELATÓRIO DE VISTORIA', { width: largura });
  doc.fontSize(12).fillColor(COR.fraco).font('Helvetica').text(visita.loja || visita.unidadeNome || 'Unidade não informada', { width: largura });
  doc.moveDown(0.7);

  const faixa = visita.faixa;
  const corFaixa = COR[faixa] || COR.fraco;
  const notaY = doc.y;
  doc.roundedRect(doc.page.margins.left, notaY, 126, 104, 8).fillAndStroke('#f7f8fa', COR.linha);
  doc.rect(doc.page.margins.left, notaY + 9, 5, 86).fill(corFaixa);
  doc.fontSize(7).fillColor(COR.fraco).font('Helvetica-Bold').text('NOTA DA VISITA', doc.page.margins.left + 12, notaY + 13);
  doc.fontSize(36).fillColor(corFaixa).font('Helvetica-Bold').text(notaBR(visita.nota), doc.page.margins.left + 12, notaY + 26);
  if (faixa) doc.fontSize(8).fillColor(corFaixa).font('Helvetica-Bold').text(FAIXA_TITULO[faixa] || '', doc.page.margins.left + 12, notaY + 78, { width: 102 });

  const campos = [
    ['Data', dataBR(visita.data)],
    ['Hora inicial', horaBR(visita.iniciadaEm || visita.criadoEm) || visita.horario],
    ['Hora final', horaBR(visita.concluidaEm)],
    ['Representante da loja', visita.representanteLoja],
    ['Responsável técnico', visita.nutricionista],
    ['Checklist', `${(visita.modeloSnap || {}).nome || 'Padrão'} (versão ${(visita.modeloSnap || {}).versao || 1})`],
    ['Resultado', `${visita.conformes} conforme(s) · ${visita.naoConformes} não conforme(s) de ${visita.total} itens`],
  ].filter(([, v]) => v);
  const infoX = doc.page.margins.left + 138;
  const infoLargura = largura - 138;
  campos.forEach(([rotulo, valor], i) => {
    const coluna = i % 2;
    const linha = Math.floor(i / 2);
    campoDeCapa(doc, infoX + coluna * ((infoLargura - 8) / 2 + 8), notaY + linha * 50, (infoLargura - 8) / 2, rotulo, valor);
  });
  doc.y = notaY + Math.max(104, Math.ceil(campos.length / 2) * 50) + 8;

  // COMPARAÇÃO COM A VISITA ANTERIOR DA MESMA LOJA. É pra isso que a nota
  // existe: número solto não diz nada, número contra o da última vez diz se
  // a loja está melhorando. Só aparece quando existe visita anterior - sem
  // ela, nada é inventado.
  if (anterior && anterior.nota !== null && anterior.nota !== undefined && visita.nota !== null) {
    const delta = Math.round((visita.nota - anterior.nota) * 100) / 100;
    const subiu = delta > 0;
    const corDelta = delta === 0 ? COR.fraco : (subiu ? COR.positiva : COR.negativa);
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').fillColor(COR.fraco).fontSize(8).text('COMPARADO COM A VISITA ANTERIOR');
    doc.font('Helvetica').fillColor(COR.texto).fontSize(11)
      .text(`${notaBR(anterior.nota)} em ${dataBR(anterior.data)}`, { continued: true })
      .fillColor(corDelta).font('Helvetica-Bold')
      .text(`   ${delta === 0 ? 'sem mudança' : (subiu ? '▲ +' : '▼ ') + notaBR(Math.abs(delta))}`);
    if (anterior.pendentes && anterior.pendentes.length) {
      doc.moveDown(0.2);
      doc.font('Helvetica').fillColor(COR.negativa).fontSize(10)
        .text(`${anterior.pendentes.length} apontamento(s) da visita anterior ainda sem confirmação de correção.`);
    }
  }

  resumoDaCapa(doc, visita, largura);
  rodapeDaCapa(doc, visita, marca);
  paginaDeConformes(doc, visita, largura);

  // ---------- APONTAMENTOS ----------
  if (!apontamentos.length) {
    doc.addPage();
    doc.fontSize(14).fillColor(COR.positiva).font('Helvetica-Bold').text('Nenhuma não conformidade registrada nesta visita.');
  }

  for (const [i, a] of apontamentos.entries()) {
    // Não abre página por padrão: só vira quando o próximo bloco inteiro não
    // cabe. Assim duas ou mais não conformidades curtas ocupam a mesma folha.
    if (i === 0 || precisaNovaPagina(doc, alturaApontamento(a))) doc.addPage();
    doc.fontSize(8).fillColor(COR.fraco).font('Helvetica-Bold').text(`APONTAMENTO ${i + 1} DE ${apontamentos.length}${a.setor ? ' · ' + String(a.setor).toUpperCase() : ''}`);
    doc.moveDown(0.18);
    cabecalhoDeBloco(doc, a.texto, COR.negativa);

    if (a.especificacoes && a.especificacoes.length) {
      doc.fontSize(8).fillColor(COR.fraco).font('Helvetica-Bold').text('DETALHAMENTO');
      a.especificacoes.forEach((e) => {
        doc.fontSize(10).fillColor(COR.texto).font('Helvetica').text(`• ${e.texto}`, { width: largura });
      });
      doc.moveDown(0.2);
    }

    paragrafo(doc, 'O que foi visto', a.observacao);
    await desenharFotos(doc, a.fotos, largura);
    paragrafo(doc, 'Ação corretiva', a.acaoCorretiva);

    const prazoLinha = [a.responsavel && `Responsável: ${a.responsavel}`, a.prazo && `Prazo: ${dataBR(a.prazo)}`].filter(Boolean).join('   ·   ');
    if (prazoLinha) {
      doc.fontSize(10).fillColor(COR.texto).font('Helvetica-Bold').text(prazoLinha);
      doc.moveDown(0.5);
    }

    espacoDoCliente(doc, a.espacoCliente, largura);

    // A contestação não troca o laudo original: entra abaixo dele, com a
    // decisão técnica. Assim quem lê o PDF entende o ciclo completo mesmo
    // sem abrir o sistema.
    if (a.revisao) {
      const r = a.revisao;
      const titulo = r.status === 'PENDENTE' ? 'REVISÃO SOLICITADA PELA UNIDADE'
        : r.status === 'ACEITA' ? 'CORREÇÃO ACEITA PELO AVALIADOR'
          : 'APONTAMENTO MANTIDO PELO AVALIADOR';
      doc.moveDown(0.25);
      doc.fontSize(8).fillColor(COR.fraco).font('Helvetica-Bold').text(titulo);
      paragrafo(doc, 'Defesa / correção informada', r.motivo);
      if (r.evidencia && r.evidencia.nome) {
        doc.fontSize(9).fillColor(COR.fraco).font('Helvetica').text(`Evidência anexada: ${r.evidencia.nome}`);
        doc.moveDown(0.3);
      }
      paragrafo(doc, 'Parecer técnico', r.parecer);
    }

    // CORRIGIDO SIM/NÃO, como na planilha - e marcado, se já foi verificado
    const sim = a.corrigido === true ? 'X' : ' ';
    const nao = a.corrigido === false ? 'X' : ' ';
    doc.fontSize(10).fillColor(COR.texto).font('Helvetica-Bold')
      .text(`CORRIGIDO:    SIM (  ${sim}  )      NÃO (  ${nao}  )`);
  }

  // ---------- ASSINATURAS ----------
  // Só sai a página quando alguém assinou. Linha de assinatura em branco num
  // laudo entregue sugere que faltou alguém - e não é isso: é que a
  // assinatura é opcional, feita na loja quando dá.
  const assin = visita.assinaturas || {};
  const assinados = ['loja', 'responsavel'].filter((k) => assin[k] && assin[k].imagem);
  if (assinados.length) {
    doc.addPage();
    doc.fontSize(8).fillColor(COR.fraco).font('Helvetica-Bold').text('ASSINATURAS');
    doc.moveDown(0.6);
    for (const chave of assinados) {
      const a = assin[chave];
      const y = doc.y;
      try {
        doc.image(Buffer.from(String(a.imagem).split(',')[1], 'base64'), doc.page.margins.left, y, { fit: [largura, 90] });
      } catch (e) { /* assinatura ilegível não derruba o laudo */ }
      doc.y = y + 95;
      doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.margins.left + largura * 0.7, doc.y).stroke(COR.linha);
      doc.moveDown(0.3);
      doc.fontSize(10).fillColor(COR.texto).font('Helvetica-Bold').text(a.nome || '—');
      doc.fontSize(8).fillColor(COR.fraco).font('Helvetica')
        .text(`${chave === 'loja' ? 'Representante da loja' : 'Responsável técnico'} · ${dataBR(String(a.assinadoEm || '').slice(0, 10))}`);
      doc.moveDown(1.2);
    }
  }

  doc.end();
}

module.exports = { gerarPdf, COR, FAIXA_TITULO, VERSAO_LAUDO };
