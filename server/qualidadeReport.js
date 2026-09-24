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

function dataBR(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso || '');
}
function notaBR(nota) {
  return nota === null || nota === undefined ? '—' : Number(nota).toFixed(2).replace('.', ',');
}

// Uma foto de celular em pé tem 3000px de altura: jogada crua no PDF, ocupa
// a página inteira e empurra a ação corretiva pra folha seguinte - que é
// exatamente o que faz um laudo virar 40 páginas. `fit` mantém a proporção
// dentro da caixa.
const FOTO_ALT = 150;
async function desenharFotos(doc, fotos, largura) {
  if (!fotos || !fotos.length) return;
  const gap = 8;
  const porLinha = Math.min(fotos.length, 3);
  const larguraFoto = (largura - gap * (porLinha - 1)) / porLinha;
  let x = doc.page.margins.left;
  const y = doc.y;
  let desenhou = 0;
  for (const foto of fotos.slice(0, 3)) {
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
  doc.y = y + FOTO_ALT + 10;
  doc.x = doc.page.margins.left;
  return desenhou;
}

function cabecalhoDeBloco(doc, texto, cor) {
  doc.moveDown(0.2);
  doc.fontSize(11).fillColor(cor || COR.texto).font('Helvetica-Bold').text(texto, { width: doc.page.width - doc.page.margins.left - doc.page.margins.right });
  doc.moveDown(0.25);
}

function paragrafo(doc, rotulo, valor) {
  if (!valor) return;
  doc.fontSize(8).fillColor(COR.fraco).font('Helvetica-Bold').text(String(rotulo).toUpperCase());
  doc.fontSize(10).fillColor(COR.texto).font('Helvetica').text(String(valor), { width: doc.page.width - doc.page.margins.left - doc.page.margins.right });
  doc.moveDown(0.4);
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
    doc.rect(doc.page.margins.left, y, largura, 34).stroke(COR.linha);
    doc.y = y + 40;
  }
  doc.moveDown(0.3);
}

async function gerarPdf(visita, apontamentos, res, anterior) {
  const doc = new PDFDocument({ margin: 40, size: 'A4' });
  const largura = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.pipe(res);

  // ---------- CAPA ----------
  try {
    doc.image(LOGO_GRUPO_BRAVO, doc.page.margins.left, 60, { fit: [150, 60] });
  } catch (e) { /* sem logo o laudo sai igual */ }
  doc.y = 150;
  doc.fontSize(22).fillColor(COR.texto).font('Helvetica-Bold').text('RELATÓRIO DE VISITA TÉCNICA', { width: largura });
  doc.moveDown(0.4);
  doc.fontSize(15).fillColor(COR.fraco).font('Helvetica').text(visita.loja || visita.unidadeNome || '', { width: largura });
  doc.moveDown(1.5);

  const faixa = visita.faixa;
  const corFaixa = COR[faixa] || COR.fraco;
  doc.fontSize(9).fillColor(COR.fraco).font('Helvetica-Bold').text('NOTA DA VISITA');
  doc.fontSize(46).fillColor(corFaixa).font('Helvetica-Bold').text(notaBR(visita.nota));
  if (faixa) doc.fontSize(11).fillColor(corFaixa).font('Helvetica-Bold').text(FAIXA_TITULO[faixa] || '');
  doc.moveDown(1.2);

  doc.fontSize(10).fillColor(COR.texto).font('Helvetica');
  [
    ['Data', dataBR(visita.data)],
    ['Horário', visita.horario],
    ['Representante da loja', visita.representanteLoja],
    ['Responsável técnico', visita.nutricionista],
    ['Checklist', `${(visita.modeloSnap || {}).nome || 'Padrão'} (versão ${(visita.modeloSnap || {}).versao || 1})`],
    ['Resultado', `${visita.conformes} conforme(s) · ${visita.naoConformes} não conforme(s) de ${visita.total} itens`],
  ].filter(([, v]) => v).forEach(([r, v]) => {
    doc.font('Helvetica-Bold').fillColor(COR.fraco).fontSize(8).text(String(r).toUpperCase(), { continued: false });
    doc.font('Helvetica').fillColor(COR.texto).fontSize(11).text(String(v));
    doc.moveDown(0.3);
  });

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

  // ---------- APONTAMENTOS ----------
  if (!apontamentos.length) {
    doc.addPage();
    doc.fontSize(14).fillColor(COR.positiva).font('Helvetica-Bold').text('Nenhuma não conformidade registrada nesta visita.');
  }

  for (const [i, a] of apontamentos.entries()) {
    doc.addPage();
    doc.fontSize(8).fillColor(COR.fraco).font('Helvetica-Bold').text(`APONTAMENTO ${i + 1} DE ${apontamentos.length}${a.setor ? ' · ' + String(a.setor).toUpperCase() : ''}`);
    doc.moveDown(0.3);
    cabecalhoDeBloco(doc, a.texto, COR.negativa);

    if (a.especificacoes && a.especificacoes.length) {
      doc.fontSize(8).fillColor(COR.fraco).font('Helvetica-Bold').text('DETALHAMENTO');
      a.especificacoes.forEach((e) => {
        doc.fontSize(10).fillColor(COR.texto).font('Helvetica').text(`• ${e.texto}`, { width: largura });
      });
      doc.moveDown(0.4);
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

module.exports = { gerarPdf, COR, FAIXA_TITULO };
