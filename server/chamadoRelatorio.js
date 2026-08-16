// chamadoRelatorio.js
// Relatorio do atendimento em PDF, a partir de um chamado de chamadosTI.js
// (ou chamadosManutencao.js - o formato do documento e o mesmo).
//
// Existe porque o chamado ja guarda tudo o que prova o atendimento -
// evidencias com foto, o antes/depois do check-in, pecas, cobranca e a
// assinatura de quem recebeu na loja - mas isso so vivia dentro do app. Pra
// mandar pro franqueado, anexar numa cobranca ou guardar como comprovante do
// servico, precisava de um arquivo unico. Este e o arquivo.
//
// As FOTOS entram embutidas no documento, nao como link: um link exige
// login e morre se o arquivo mudar de lugar; o PDF tem que continuar valendo
// como prova daqui a um ano, aberto por quem nao tem acesso ao Zenith.
const PDFDocument = require('pdfkit');
const storage = require('./storage');

// Teto de fotos por relatorio. Cada foto de celular pesa alguns MB e o PDF e
// montado em memoria - sem limite, um chamado com 40 evidencias derrubaria o
// processo. O que passar do teto vira uma linha de aviso no lugar.
const MAX_FOTOS = 30;
// arquivo maior que isso nao entra: quase sempre e video ou foto gigante, e
// o custo de embutir nao compensa
const MAX_BYTES_FOTO = 8 * 1024 * 1024;

const STATUS_LABEL = {
  ABERTO: 'Aberto', INICIADO: 'Em atendimento', CONCLUIDO: 'Concluído', CANCELADO: 'Cancelado',
};
const PRIORIDADE_LABEL = { baixa: 'Baixa', media: 'Média', alta: 'Alta', critica: 'Crítica' };

function fmtDataHora(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function fmtData(iso) {
  if (!iso) return '—';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

// com separador de milhar: e um documento sobre dinheiro, "R$ 1250,00" e
// "R$ 1.250,00" se leem diferente na pressa
const fmtReal = (v) => `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Duracao do atendimento em texto humano. E o numero que o franqueado
// pergunta ("quanto tempo o tecnico ficou?") e que ninguem quer calcular na
// mao a partir de dois timestamps.
function duracao(inicio, fim) {
  if (!inicio || !fim) return null;
  const ms = new Date(fim).getTime() - new Date(inicio).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h}h${String(min % 60).padStart(2, '0')}`;
}

// Junta TODAS as fotos do chamado numa lista unica antes de desenhar
// qualquer coisa: o pdfkit e sincrono, entao os bytes precisam estar em
// memoria na hora de montar a pagina. Uma foto que falhou vira null e o
// relatorio segue - documento incompleto e melhor que documento nenhum.
async function baixarFotos(chamado) {
  const caminhos = [];
  const juntar = (f) => { if (f && f.path && !caminhos.includes(f.path)) caminhos.push(f.path); };
  (chamado.evidencias || []).forEach((e) => (e.fotos || []).forEach(juntar));
  (chamado.itensAntes || []).forEach((i) => juntar(i.foto));
  (chamado.itensDepois || []).forEach((i) => juntar(i.foto));
  juntar(chamado.assinatura);

  const porCaminho = new Map();
  for (const caminho of caminhos.slice(0, MAX_FOTOS)) {
    const buffer = await storage.baixarArquivo(caminho);
    porCaminho.set(caminho, buffer && buffer.length <= MAX_BYTES_FOTO ? buffer : null);
  }
  return { porCaminho, cortadas: Math.max(0, caminhos.length - MAX_FOTOS) };
}

function gerarPDF(res, chamado, { fotos, geradoPor, nomeArquivo }) {
  const doc = new PDFDocument({ margin: 42, size: 'A4', bufferPages: true });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}"`);
  doc.pipe(res);

  const x = doc.page.margins.left;
  const largura = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const rodape = doc.page.height - doc.page.margins.bottom;

  // quebra de pagina manual: o pdfkit quebra sozinho no texto, mas nao ao
  // desenhar imagem em coordenada fixa - a foto sairia por cima do rodape
  const garantirEspaco = (altura) => {
    if (doc.y + altura > rodape) doc.addPage();
  };

  function titulo(texto) {
    garantirEspaco(46);
    doc.moveDown(0.6);
    doc.fontSize(11).fillColor('#111').font('Helvetica-Bold').text(texto.toUpperCase(), x, doc.y, { characterSpacing: 0.6 });
    doc.moveDown(0.25);
    doc.rect(x, doc.y, largura, 1).fill('#dde3ea');
    doc.moveDown(0.5);
    doc.font('Helvetica');
  }

  function campo(label, valor) {
    garantirEspaco(28);
    doc.fontSize(8).fillColor('#7a838f').font('Helvetica').text(String(label).toUpperCase(), x, doc.y, { characterSpacing: 0.5 });
    doc.fontSize(10.5).fillColor('#111').text(valor == null || valor === '' ? '—' : String(valor), x, doc.y, { width: largura });
    doc.moveDown(0.45);
  }

  function paragrafo(texto) {
    garantirEspaco(30);
    doc.fontSize(10).fillColor('#333').font('Helvetica')
      .text(texto || '—', x, doc.y, { width: largura, align: 'left', lineGap: 2 });
    doc.moveDown(0.4);
  }

  // fotos lado a lado, 3 por linha - tamanho de "prova visual": grande o
  // bastante pra dar pra ver o cabo/tela, pequeno o bastante pra caber
  function grade(listaFotos) {
    const validas = (listaFotos || []).filter((f) => f && f.path);
    if (!validas.length) return;
    const porLinha = 3;
    const vao = 8;
    const larguraFoto = (largura - vao * (porLinha - 1)) / porLinha;
    const alturaFoto = larguraFoto * 0.75;
    for (let i = 0; i < validas.length; i += porLinha) {
      const linha = validas.slice(i, i + porLinha);
      garantirEspaco(alturaFoto + 10);
      const topo = doc.y;
      linha.forEach((f, j) => {
        const px = x + j * (larguraFoto + vao);
        const buffer = fotos.porCaminho.get(f.path);
        if (buffer) {
          try {
            doc.image(buffer, px, topo, { fit: [larguraFoto, alturaFoto], align: 'center', valign: 'center' });
            return;
          } catch (err) {
            // formato que o pdfkit nao le (HEIC, webp...) - o quadro de
            // aviso abaixo diz isso em vez de estourar o relatorio
          }
        }
        doc.rect(px, topo, larguraFoto, alturaFoto).fillAndStroke('#f4f6f8', '#dde3ea');
        doc.fontSize(7.5).fillColor('#7a838f')
          .text('foto não pôde ser\nincluída no PDF', px + 4, topo + alturaFoto / 2 - 10, { width: larguraFoto - 8, align: 'center' });
      });
      doc.y = topo + alturaFoto + 10;
    }
  }

  function tabela(colunas, linhas) {
    const larguras = colunas.map((c) => c.largura);
    garantirEspaco(24);
    doc.fontSize(8).fillColor('#7a838f').font('Helvetica-Bold');
    let cx = x;
    colunas.forEach((c, i) => {
      doc.text(c.titulo.toUpperCase(), cx, doc.y, { width: larguras[i], align: c.align || 'left', characterSpacing: 0.4, continued: i < colunas.length - 1 });
      cx += larguras[i];
    });
    doc.moveDown(0.3);
    doc.font('Helvetica');
    linhas.forEach((linha) => {
      garantirEspaco(20);
      const topo = doc.y;
      let px = x;
      let maiorY = topo;
      linha.forEach((celula, i) => {
        doc.fontSize(9.5).fillColor('#111').text(String(celula == null ? '—' : celula), px, topo, { width: larguras[i], align: colunas[i].align || 'left' });
        maiorY = Math.max(maiorY, doc.y);
        px += larguras[i];
      });
      doc.y = maiorY + 3;
      doc.rect(x, doc.y, largura, 0.5).fill('#eef1f4');
      doc.moveDown(0.3);
    });
  }

  // ---------- cabecalho ----------
  doc.fontSize(8).fillColor('#5b6470').font('Helvetica-Bold')
    .text('ZENITH OPS', x, doc.y, { continued: true, characterSpacing: 0.6 });
  doc.font('Helvetica').text(`  ·  ${chamado.unidadeNome || chamado.unidade || ''}`, { characterSpacing: 0.6 });
  doc.moveDown(0.4);
  doc.fontSize(18).fillColor('#111').font('Helvetica-Bold').text('Relatório de Atendimento', x, doc.y);
  doc.font('Helvetica').fontSize(11).fillColor('#444').text(chamado.titulo || '(sem título)', x, doc.y, { width: largura });
  doc.moveDown(0.5);

  const modalidade = chamado.modalidade === 'presencial' ? 'Presencial' : 'Remoto';
  const etiqueta = [
    chamado.numeroTicket != null ? `Ticket #${chamado.numeroTicket}` : null,
    STATUS_LABEL[chamado.status] || chamado.status,
    modalidade,
    PRIORIDADE_LABEL[chamado.prioridade] ? `Prioridade ${PRIORIDADE_LABEL[chamado.prioridade]}` : null,
  ].filter(Boolean).join('   ·   ');
  doc.fontSize(9.5).fillColor('#5b6470').text(etiqueta, x, doc.y);
  doc.moveDown(0.5);
  doc.rect(x, doc.y, largura, 2).fill('#111');
  doc.moveDown(0.6);

  // ---------- o atendimento ----------
  titulo('Dados do atendimento');
  campo('Unidade', chamado.unidadeNome || chamado.unidade);
  campo('Aberto em', `${fmtDataHora(chamado.criadoEm)}${chamado.criadoPorEmail ? ` · por ${chamado.criadoPorEmail}` : ''}`);
  campo('Responsável pelo atendimento', chamado.tecnicoEmail || chamado.tecnicoNome || '—');
  if (chamado.dataExecucao) campo('Data combinada de execução', fmtData(chamado.dataExecucao));
  if (chamado.iniciadoEm) campo('Check-in na loja', fmtDataHora(chamado.iniciadoEm));
  if (chamado.concluidoEm) {
    const tempo = duracao(chamado.iniciadoEm, chamado.concluidoEm);
    campo('Concluído em', `${fmtDataHora(chamado.concluidoEm)}${tempo ? ` · duração ${tempo}` : ''}`);
  }
  if (chamado.status === 'CANCELADO') campo('Motivo do cancelamento', chamado.motivoCancelamento);

  titulo('O que foi solicitado');
  paragrafo(chamado.descricao || chamado.titulo);

  // escalacao: por que um chamado que nasceu remoto virou visita. E a
  // justificativa que sustenta a cobranca do deslocamento
  if ((chamado.escalacoes || []).length) {
    titulo('Escalado para presencial');
    // aqui NAO uso campo(): ele bota o rotulo em caixa alta, e o rotulo
    // dessa linha carrega o e-mail de quem escalou
    (chamado.escalacoes || []).forEach((e) => {
      garantirEspaco(30);
      doc.fontSize(8.5).fillColor('#7a838f').font('Helvetica')
        .text(`${fmtDataHora(e.em)}${e.porEmail ? ` · ${e.porEmail}` : ''}`, x, doc.y, { width: largura });
      doc.fontSize(10.5).fillColor('#111').text(e.motivo || '—', x, doc.y, { width: largura });
      doc.moveDown(0.45);
    });
  }

  // ---------- evidencias ----------
  const evidencias = chamado.evidencias || [];
  if (evidencias.length) {
    titulo(`Evidências (${evidencias.length})`);
    evidencias.forEach((ev, i) => {
      garantirEspaco(40);
      doc.fontSize(10.5).fillColor('#111').font('Helvetica-Bold')
        .text(`${i + 1}. ${ev.descricao || '(sem observação)'}`, x, doc.y, { width: largura });
      doc.font('Helvetica').fontSize(8).fillColor('#7a838f')
        .text(`${ev.autorNome || ev.autorEmail || '—'} · ${fmtDataHora(ev.em)}`, x, doc.y);
      doc.moveDown(0.35);
      grade(ev.fotos);
      doc.moveDown(0.3);
    });
  }

  // ---------- antes / depois (so presencial com check-in) ----------
  const bloco = (rotulo, itens) => {
    if (!(itens || []).length) return;
    titulo(rotulo);
    itens.forEach((item, i) => {
      garantirEspaco(30);
      doc.fontSize(10).fillColor('#111').text(`${i + 1}. ${item.descricao || '(sem descrição)'}`, x, doc.y, { width: largura });
      doc.moveDown(0.3);
      grade(item.foto ? [item.foto] : []);
      doc.moveDown(0.2);
    });
  };
  bloco('Como estava (check-in)', chamado.itensAntes);
  bloco('Como ficou (checkout)', chamado.itensDepois);

  if (chamado.observacaoTecnico) {
    titulo('O que foi feito');
    paragrafo(chamado.observacaoTecnico);
  }

  // ---------- pecas e dinheiro ----------
  if ((chamado.pecas || []).length) {
    titulo('Peças utilizadas');
    const total = (chamado.pecas || []).reduce((s, p) => s + Number(p.valor || 0), 0);
    tabela(
      [{ titulo: 'Peça', largura: largura * 0.45 }, { titulo: 'Observação', largura: largura * 0.35 }, { titulo: 'Valor', largura: largura * 0.2, align: 'right' }],
      (chamado.pecas || []).map((p) => [p.descricao, p.observacao || '—', fmtReal(p.valor)]),
    );
    doc.fontSize(10).fillColor('#111').font('Helvetica-Bold').text(`Total em peças: ${fmtReal(total)}`, x, doc.y, { width: largura, align: 'right' });
    doc.font('Helvetica');
    doc.moveDown(0.3);
  }

  if ((chamado.orcamentoPecas || []).length) {
    titulo('Orçamento de peças');
    const total = (chamado.orcamentoPecas || []).reduce((s, p) => s + Number(p.valor || 0), 0);
    tabela(
      [{ titulo: 'Item', largura: largura * 0.45 }, { titulo: 'Observação', largura: largura * 0.35 }, { titulo: 'Valor', largura: largura * 0.2, align: 'right' }],
      (chamado.orcamentoPecas || []).map((p) => [p.descricao, p.observacao || '—', fmtReal(p.valor)]),
    );
    doc.fontSize(10).fillColor('#111').font('Helvetica-Bold').text(`Total orçado: ${fmtReal(total)}`, x, doc.y, { width: largura, align: 'right' });
    doc.font('Helvetica');
    doc.moveDown(0.3);
  }

  if (chamado.cobranca && (chamado.cobranca.valor || chamado.cobranca.descricao)) {
    titulo('Cobrança do atendimento');
    campo('Valor', fmtReal(chamado.cobranca.valor));
    if (chamado.cobranca.descricao) campo('Descrição', chamado.cobranca.descricao);
    campo('Situação', chamado.cobranca.enviadaEm
      ? `Enviada para pagamento em ${fmtDataHora(chamado.cobranca.enviadaEm)}`
      : 'Ainda não enviada para pagamento');
  }

  // ---------- aceite da loja ----------
  if (chamado.assinatura || chamado.assinaturaNomeLoja) {
    titulo('Aceite da loja');
    campo('Recebido por', chamado.assinaturaNomeLoja);
    const assinatura = chamado.assinatura && fotos.porCaminho.get(chamado.assinatura.path);
    if (assinatura) {
      garantirEspaco(110);
      try {
        doc.image(assinatura, x, doc.y, { fit: [220, 80] });
        doc.y += 84;
      } catch (err) { /* assinatura ilegivel nao invalida o resto do relatorio */ }
    }
    doc.rect(x, doc.y, 240, 0.7).fill('#111');
    doc.moveDown(0.3);
    doc.fontSize(8).fillColor('#7a838f').text('Assinatura de quem recebeu o serviço na loja', x, doc.y);
  }

  if (fotos.cortadas) {
    doc.moveDown(0.8);
    doc.fontSize(8.5).fillColor('#a0522d')
      .text(`Obs.: este chamado tem mais fotos do que cabe num relatório (${fotos.cortadas} não incluída(s)). As demais continuam no chamado, dentro do Zenith.`, x, doc.y, { width: largura });
  }

  // ---------- rodape em todas as paginas ----------
  const total = doc.bufferedPageRange().count;
  for (let i = 0; i < total; i += 1) {
    doc.switchToPage(i);
    // o rodape mora ABAIXO da margem inferior. Sem zerar a margem, o pdfkit
    // entende "passou do fim da pagina" e abre uma pagina nova pra cada
    // rodape - o relatorio de 3 paginas saía com 9, metade em branco.
    doc.page.margins.bottom = 0;
    doc.fontSize(7.5).fillColor('#9aa3ad').font('Helvetica')
      .text(
        `Ticket #${chamado.numeroTicket ?? '—'} · ${chamado.unidadeNome || chamado.unidade || ''} · gerado em ${fmtDataHora(new Date().toISOString())}${geradoPor ? ` por ${geradoPor}` : ''}`,
        x, rodape + 12, { width: largura - 40, lineBreak: false },
      );
    doc.text(`${i + 1}/${total}`, x + largura - 40, rodape + 12, { width: 40, align: 'right', lineBreak: false });
  }

  doc.end();
}

// entrada unica: baixa as fotos (async) e so entao desenha (sincrono)
async function gerarRelatorioPDF(res, chamado, { geradoPor } = {}) {
  const fotos = await baixarFotos(chamado);
  const nomeArquivo = `atendimento-${chamado.numeroTicket ?? chamado.id}.pdf`;
  gerarPDF(res, chamado, { fotos, geradoPor, nomeArquivo });
}

module.exports = { gerarRelatorioPDF, MAX_FOTOS };
