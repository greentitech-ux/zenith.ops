// estacaoMesasQr.js
// Folha de impressão dos QR Codes das mesas da Estação da Comida.
//
// Cada mesa tem um QR colado nela, e o garçom lê esse QR pra abrir a conta
// da mesa (estacao-salao.html, lerQrCode). Até aqui o adesivo não existia:
// o leitor estava pronto, mas ninguém tinha como GERAR o QR. Esta folha é
// isso - um PDF em A4 com um adesivo por mesa, pra imprimir, recortar e
// colar.
//
// O QR NÃO GUARDA VALOR. Ele só diz QUAL mesa é (decisão do Master: "cada
// mesa terá um QR Code"; o valor vem da consulta ao servidor na hora da
// leitura, ver estacaoComida.js). O conteúdo é a URL do salão com ?mesa=N,
// e não o número puro, de propósito: quem ler com a câmera comum do
// celular cai na tela certa, e o mesaDoQr() do salão aceita as duas formas.
//
// O QR é desenhado como VETOR (um retângulo por módulo), não como imagem:
// sai nítido em qualquer impressora e não precisa de canvas/PNG no servidor.
// A biblioteca `qrcode` só faz a conta da matriz.
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');

// limites da folha: mesa é número curto (o salão aceita até 4 dígitos), e
// uma folha de 200 mesas já é mais do que qualquer salão da rede
const MAX_MESA = 9999;
const MAX_MESAS_POR_FOLHA = 200;

// grade A4: 3 colunas x 4 linhas = 12 adesivos por página, de ~63mm
const COLUNAS = 3;
const LINHAS = 4;
const MARGEM = 28;

function faixaDeMesas(de, ate) {
  const a = Math.max(1, Math.floor(Number(de) || 1));
  const b = Math.floor(Number(ate) || a);
  if (!(a <= MAX_MESA) || !(b <= MAX_MESA)) throw new Error(`A mesa vai até ${MAX_MESA}.`);
  if (b < a) throw new Error('A mesa final tem que ser maior ou igual à inicial.');
  if (b - a + 1 > MAX_MESAS_POR_FOLHA) throw new Error(`No máximo ${MAX_MESAS_POR_FOLHA} mesas por folha - imprima em partes.`);
  const mesas = [];
  for (let m = a; m <= b; m += 1) mesas.push(m);
  return mesas;
}

function urlDaMesa(baseUrl, unidade, mesa) {
  // URL curta e oficial: o adesivo fica meses na mesa e não deve carregar
  // extensão de arquivo. O servidor também redireciona links antigos, mas o
  // QR novo já nasce no endereço canônico.
  return `${baseUrl}/estacao-salao?unidade=${encodeURIComponent(unidade)}&mesa=${mesa}`;
}

// desenha a matriz do QR num quadrado de lado `tam`, com a margem branca
// (quiet zone) que o leitor precisa pra achar o código
function desenharQr(doc, texto, x, y, tam) {
  const qr = QRCode.create(texto, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const dados = qr.modules.data;
  const quiet = 4; // módulos de margem, padrão da norma
  const modulo = tam / (n + quiet * 2);
  const x0 = x + quiet * modulo;
  const y0 = y + quiet * modulo;
  doc.save().fillColor('#000');
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n; c += 1) {
      if (dados[r * n + c]) doc.rect(x0 + c * modulo, y0 + r * modulo, modulo + 0.2, modulo + 0.2).fill();
    }
  }
  doc.restore();
}

function writePDF(res, { unidade, unidadeNome, mesas, baseUrl, nomeArquivo }) {
  const doc = new PDFDocument({ margin: MARGEM, size: 'A4' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${nomeArquivo}"`);
  doc.pipe(res);

  const largUtil = doc.page.width - MARGEM * 2;
  const altUtil = doc.page.height - MARGEM * 2;
  const celW = largUtil / COLUNAS;
  const celH = altUtil / LINHAS;
  const porPagina = COLUNAS * LINHAS;

  mesas.forEach((mesa, i) => {
    if (i > 0 && i % porPagina === 0) doc.addPage();
    const k = i % porPagina;
    const cx = MARGEM + (k % COLUNAS) * celW;
    const cy = MARGEM + Math.floor(k / COLUNAS) * celH;

    // linha de corte, cinza clara: guia pra tesoura, some na parede
    doc.save().lineWidth(0.5).strokeColor('#bbb').dash(3, { space: 3 })
      .rect(cx + 4, cy + 4, celW - 8, celH - 8).stroke().undash().restore();

    // "MESA 12" grande em cima: é o que a pessoa lê de longe; o QR é pro
    // celular do garçom
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#666')
      .text('MESA', cx, cy + 16, { width: celW, align: 'center', characterSpacing: 2 });
    doc.font('Helvetica-Bold').fontSize(34).fillColor('#000')
      .text(String(mesa), cx, cy + 28, { width: celW, align: 'center' });

    const tamQr = Math.min(celW, celH) * 0.6;
    desenharQr(doc, urlDaMesa(baseUrl, unidade, mesa), cx + (celW - tamQr) / 2, cy + 70, tamQr);

    doc.font('Helvetica').fontSize(8.5).fillColor('#666')
      .text(unidadeNome || unidade, cx, cy + celH - 22, { width: celW, align: 'center' });
  });

  doc.end();
}

module.exports = { faixaDeMesas, urlDaMesa, writePDF, MAX_MESAS_POR_FOLHA };
