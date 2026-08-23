// suporteChatPDF.js
// PDF da conversa do chat de suporte (widget flutuante, ver suporteChat.js) -
// pedido explicito do usuario: "preciso ter um botao de gerar pdf da
// conversa". Layout retrato simples (cabecalho com protocolo + dados de
// contato, depois a thread mensagem a mensagem), no mesmo espirito de
// termoResponsabilidade.js - um modulo dedicado por tipo de PDF, sem tentar
// forcar isso dentro do reportUtil.js genérico (que é para tabelas, não
// para uma conversa de tamanho variável).
const PDFDocument = require('pdfkit');
const { fmtDataHoraBR, nomeArquivoComData } = require('./reportUtil');

function rotuloAutor(chat, m) {
  if (m.de === 'visitante') return chat.nome || 'Visitante';
  if (m.bot) return 'Beniboy (assistente virtual)';
  return 'Suporte';
}

function gerarChatPDF(res, chat) {
  const doc = new PDFDocument({ margin: 48, size: 'A4' });
  const nomeArquivo = nomeArquivoComData(`chat-suporte-${chat.numeroTicket || chat.id}`);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}.pdf"`);
  doc.pipe(res);

  const x = doc.page.margins.left;
  const largura = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  doc.fontSize(8).fillColor('#5b6470').text('NoPulso · Solutions TI Tech', x, doc.y, { characterSpacing: 0.5 });
  doc.moveDown(0.3);
  doc.fontSize(17).fillColor('#111').text('Conversa de Suporte', x, doc.y);
  doc.fontSize(12).fillColor('#666').text(`Protocolo #${chat.numeroTicket || '—'}`, x, doc.y);
  doc.moveDown(0.8);

  function linhaCampo(label, valor) {
    doc.fontSize(9).fillColor('#666').text(label.toUpperCase(), x, doc.y, { characterSpacing: 0.5 });
    doc.fontSize(11).fillColor('#111').text(valor || '—', x, doc.y);
    doc.moveDown(0.5);
  }

  doc.rect(x, doc.y, largura, 1).fill('#dde3ea');
  doc.moveDown(0.7);

  linhaCampo('Nome', chat.nome);
  linhaCampo('Contato', chat.contato);
  linhaCampo('Assunto', chat.assunto);
  linhaCampo('Aberta em', fmtDataHoraBR(chat.criadoEm));
  linhaCampo('Status', chat.status === 'ABERTO' ? 'Em aberto' : `Finalizada${chat.finalizadoEm ? ' em ' + fmtDataHoraBR(chat.finalizadoEm) : ''}`);

  doc.moveDown(0.3);
  doc.rect(x, doc.y, largura, 1).fill('#dde3ea');
  doc.moveDown(0.8);

  doc.fontSize(9).fillColor('#666').text('HISTÓRICO DA CONVERSA', x, doc.y, { characterSpacing: 0.5 });
  doc.moveDown(0.5);

  (chat.mensagens || []).forEach((m) => {
    doc.fontSize(9).fillColor('#666').text(`${rotuloAutor(chat, m)} · ${fmtDataHoraBR(m.em)}`, x, doc.y, { characterSpacing: 0.3 });
    doc.fontSize(11).fillColor('#111').text(m.texto || '', x, doc.y, { width: largura, lineGap: 2 });
    doc.moveDown(0.6);
  });
  if (!(chat.mensagens || []).length) {
    doc.fontSize(11).fillColor('#666').text('Nenhuma mensagem nessa conversa.', x, doc.y);
  }

  doc.end();
}

module.exports = { gerarChatPDF };
