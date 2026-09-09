// tarefaRelatorio.js
// Dois PDFs do Meu Dia, no mesmo desenho do chamadoRelatorio.js:
//
// 1) OCORRENCIA - o PDF de UMA tarefa. Existe porque nem toda situacao vira
//    solicitacao ou formulario: as vezes so aconteceu alguma coisa e alguem
//    precisa REGISTRAR, com data, quem anotou, o que foi feito e a foto. O
//    arquivo e o registro: vale fora do app, pra quem nao tem login.
// 2) CONSOLIDADO - o PDF da LISTA que esta na tela, com os filtros que a
//    pessoa aplicou. Traz o resumo (quantas, por situacao, por unidade, por
//    tipo) e depois a listagem, pra conferir caso a caso.
//
// As FOTOS entram embutidas, nao como link: link exige login e morre se o
// arquivo mudar de lugar, e o PDF tem que continuar valendo daqui a um ano.
// PDF anexado entra so como NOME - pdfkit nao embute PDF dentro de PDF, e
// rasterizar exigiria uma dependencia nova so pra isso.
const PDFDocument = require('pdfkit');
const path = require('path');
const storage = require('./storage');
const redes = require('./redes');
const { nomeArquivoRegistro } = require('./reportUtil');

const LOGO_GRUPO_BRAVO = path.join(__dirname, 'public', 'grupo-bravo.png');

// Teto de fotos por documento: cada print pesa alguns MB e o PDF e montado em
// memoria. O que passar vira uma linha de aviso, igual ao relatorio de
// atendimento.
const MAX_FOTOS = 12;
const MAX_BYTES_FOTO = 8 * 1024 * 1024;

// mesma lista de STATUS que as colunas do quadro usam (tarefas.html)
const STATUS_LABEL = {
  PENDENTE: 'Pendente', A_FAZER: 'A fazer', HOJE: 'Hoje', EM_ANDAMENTO: 'Em andamento',
  CONCLUIDA: 'Concluída', CANCELADA: 'Cancelada', ARQUIVADA: 'Arquivada',
};

function fmtDataHora(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}
function fmtData(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '—';
}

const ehImagem = (a) => /^image\/(png|jpe?g)$/i.test(String((a && a.tipo) || ''));

// pdfkit so le PNG e JPEG. WebP e HEIC entram como NOME, no lugar de virar um
// quadro cinza de "nao pude incluir" - dizer que o arquivo existe e melhor
// que um buraco no documento.
async function baixarFotos(anexos) {
  const alvos = (anexos || []).filter(ehImagem);
  const porCaminho = new Map();
  for (const a of alvos.slice(0, MAX_FOTOS)) {
    const buffer = await storage.baixarArquivo(a.path);
    porCaminho.set(a.path, buffer && buffer.length <= MAX_BYTES_FOTO ? buffer : null);
  }
  return { porCaminho, cortadas: Math.max(0, alvos.length - MAX_FOTOS) };
}

// ---- desenho compartilhado pelos dois documentos ----
// inline = abre no visualizador do navegador em vez de baixar direto. E o
// padrao aqui de proposito: documento que vai virar registro se CONFERE antes
// de guardar, e o proprio visualizador ja tem o botao de baixar.
function abrir(res, nomeArquivo, inline = true) {
  const doc = new PDFDocument({ margin: 42, size: 'A4', bufferPages: true });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${nomeArquivo}"`);
  doc.pipe(res);
  const x = doc.page.margins.left;
  const largura = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const rodape = doc.page.height - doc.page.margins.bottom;
  // o pdfkit quebra sozinho no texto, mas nao ao desenhar imagem em
  // coordenada fixa - a foto sairia por cima do rodape
  const garantirEspaco = (altura) => { if (doc.y + altura > rodape) doc.addPage(); };

  const titulo = (texto) => {
    garantirEspaco(46);
    doc.moveDown(0.6);
    doc.fontSize(11).fillColor('#111').font('Helvetica-Bold').text(String(texto).toUpperCase(), x, doc.y, { characterSpacing: 0.6 });
    doc.moveDown(0.25);
    doc.rect(x, doc.y, largura, 1).fill('#dde3ea');
    doc.moveDown(0.5);
    doc.font('Helvetica');
  };
  const campo = (label, valor) => {
    garantirEspaco(28);
    doc.fontSize(8).fillColor('#7a838f').font('Helvetica').text(String(label).toUpperCase(), x, doc.y, { characterSpacing: 0.5 });
    doc.fontSize(10.5).fillColor('#111').text(valor == null || valor === '' ? '—' : String(valor), x, doc.y, { width: largura });
    doc.moveDown(0.45);
  };
  const paragrafo = (texto) => {
    garantirEspaco(30);
    doc.fontSize(10).fillColor('#333').font('Helvetica').text(texto || '—', x, doc.y, { width: largura, lineGap: 2 });
    doc.moveDown(0.4);
  };
  const tabela = (colunas, linhas) => {
    garantirEspaco(24);
    doc.fontSize(8).fillColor('#7a838f').font('Helvetica-Bold');
    let cx = x;
    colunas.forEach((c, i) => {
      doc.text(c.titulo.toUpperCase(), cx, doc.y, { width: c.largura, align: c.align || 'left', characterSpacing: 0.4, continued: i < colunas.length - 1 });
      cx += c.largura;
    });
    doc.moveDown(0.3);
    doc.font('Helvetica');
    linhas.forEach((linha) => {
      garantirEspaco(20);
      const topo = doc.y;
      let px = x; let maiorY = topo;
      linha.forEach((celula, i) => {
        doc.fontSize(9).fillColor('#111').text(String(celula == null || celula === '' ? '—' : celula), px, topo, { width: colunas[i].largura - 4, align: colunas[i].align || 'left' });
        maiorY = Math.max(maiorY, doc.y);
        px += colunas[i].largura;
      });
      doc.y = maiorY + 3;
      doc.rect(x, doc.y, largura, 0.5).fill('#eef1f4');
      doc.moveDown(0.3);
    });
  };
  // A marca do cliente mora no documento da UNIDADE. Nao usamos uma imagem
  // enviada em tempo de execucao: PDF precisa continuar abrindo daqui a anos
  // e a marca institucional esta versionada junto do app.
  const desenharMarca = (rede, topo) => {
    const direita = x + largura;
    if (rede === redes.ARCFOOD) {
      const w = 64, h = 48, px = direita - w;
      doc.roundedRect(px, topo, w, h, 8).fill('#2b2320');
      doc.font('Helvetica-Bold').fontSize(15).fillColor('#faf7f2').text('ARC', px, topo + 8, { width: w, align: 'center', characterSpacing: 1 });
      doc.rect(px + 14, topo + 28, w - 28, 2.5).fill('#e8a33d');
      doc.font('Helvetica').fontSize(8.5).fillColor('#e8a33d').text('F O O D', px, topo + 33, { width: w, align: 'center', characterSpacing: .2 });
      return;
    }
    if (rede === redes.GBE) {
      try { doc.image(LOGO_GRUPO_BRAVO, direita - 94, topo, { fit: [94, 48], align: 'right', valign: 'center' }); } catch (e) { /* cabecalho textual continua legivel */ }
    }
  };
  const cabecalho = (chapeu, tituloGrande, subtitulo, etiqueta, rede) => {
    const topoMarca = doc.y;
    desenharMarca(rede, topoMarca);
    // Reserva a faixa da marca. Sem a largura explícita, um título grande
    // poderia atravessar a logo no canto direito em vez de quebrar antes.
    const larguraTexto = rede ? largura - 112 : largura;
    doc.fontSize(8).fillColor('#5b6470').font('Helvetica-Bold').text('NOPULSO · SOLUTIONS TI TECH', x, doc.y, { continued: true, characterSpacing: 0.6 });
    doc.font('Helvetica').text(`  ·  ${chapeu || ''}`, { characterSpacing: 0.6 });
    doc.moveDown(0.4);
    doc.fontSize(18).fillColor('#111').font('Helvetica-Bold').text(tituloGrande, x, doc.y, { width: larguraTexto });
    if (subtitulo) doc.font('Helvetica').fontSize(11).fillColor('#444').text(subtitulo, x, doc.y, { width: larguraTexto });
    doc.moveDown(0.5);
    if (etiqueta) { doc.fontSize(9.5).fillColor('#5b6470').font('Helvetica').text(etiqueta, x, doc.y, { width: larguraTexto }); doc.moveDown(0.5); }
    doc.rect(x, doc.y, largura, 2).fill('#111');
    doc.moveDown(0.6);
  };
  // o rodape mora ABAIXO da margem inferior. Sem zerar a margem, o pdfkit
  // entende "passou do fim da pagina" e abre uma pagina nova por rodape.
  const fechar = (linhaRodape) => {
    const total = doc.bufferedPageRange().count;
    for (let i = 0; i < total; i += 1) {
      doc.switchToPage(i);
      doc.page.margins.bottom = 0;
      doc.fontSize(7.5).fillColor('#9aa3ad').font('Helvetica')
        .text(linhaRodape, x, rodape + 12, { width: largura - 40, lineBreak: false });
      doc.text(`${i + 1}/${total}`, x + largura - 40, rodape + 12, { width: 40, align: 'right', lineBreak: false });
    }
    doc.end();
  };
  return { doc, x, largura, garantirEspaco, titulo, campo, paragrafo, tabela, cabecalho, fechar };
}

function desenharOcorrencia(res, tarefa, { fichaCampos = [], fotos, geradoPor, nomeArquivo, inline = true }) {
  const p = abrir(res, nomeArquivo, inline);
  const { doc, x, largura } = p;
  const ehOcorrencia = !!tarefa.ehOcorrencia;
  const redeDaTarefa = redes.redeDaUnidade(tarefa.unidade || tarefa.unidadeNome);

  p.cabecalho(
    tarefa.unidadeNome || tarefa.unidade || 'Sem unidade',
    ehOcorrencia ? 'Registro de Ocorrência' : 'Registro de Tarefa',
    tarefa.titulo || '(sem título)',
    [
      (tarefa.numeroTicket != null || tarefa.vinculo?.numeroTicket != null) ? `Ticket #${tarefa.numeroTicket ?? tarefa.vinculo.numeroTicket}` : null,
      STATUS_LABEL[tarefa.status] || tarefa.status,
      `Registrada em ${fmtDataHora(tarefa.criadaEm)}`,
    ].filter(Boolean).join('   ·   '),
    redeDaTarefa,
  );

  p.titulo('Identificação');
  p.campo('Unidade', tarefa.unidadeNome || tarefa.unidade || 'Tarefa pessoal');
  p.campo('Responsável', tarefa.responsavelNome);
  p.campo('Participam', (tarefa.colaboradores || []).map((c) => c.nome).join(', ') || 'ninguém além do responsável');
  p.campo('Registrada por', `${tarefa.criadoPorNome || 'Usuário'} em ${fmtDataHora(tarefa.criadaEm)}`);
  p.campo('Início / previsão de conclusão', `${fmtData(tarefa.dataInicio)} → ${tarefa.dataEntrega ? fmtData(tarefa.dataEntrega) : 'sem prazo'}`);
  if (tarefa.concluidaEm) p.campo('Concluída', `${tarefa.concluidaPorNome || 'Usuário'} em ${fmtDataHora(tarefa.concluidaEm)}`);

  if (String(tarefa.descricao || '').trim()) { p.titulo('O que aconteceu'); p.paragrafo(tarefa.descricao); }

  if (fichaCampos.length) {
    p.titulo('Solicitação vinculada');
    fichaCampos.forEach((c) => p.campo(c.rotulo, c.valor));
  }

  if ((tarefa.gerou || []).length) {
    p.titulo('Documentos gerados');
    tarefa.gerou.forEach((g) => p.campo(
      g.tipo === 'formulario' ? 'Formulário' : 'Solicitação',
      `${g.rotulo || g.tipo}${g.numeroTicket ? ` · Ticket #${g.numeroTicket}` : ''} · registrado por ${g.porNome || '—'} em ${fmtDataHora(g.em)}`,
    ));
  }

  const comentarios = tarefa.comentarios || [];
  p.titulo(`Histórico (${comentarios.length})`);
  if (!comentarios.length) p.paragrafo('Sem registros no histórico.');
  else {
    p.tabela(
      [{ titulo: 'Quando', largura: 110 }, { titulo: 'Quem', largura: 95 }, { titulo: 'Registro', largura: largura - 205 }],
      comentarios.map((c) => [fmtDataHora(c.em), c.porNome || 'Usuário', c.texto]),
    );
  }

  const anexos = tarefa.anexos || [];
  p.titulo(`Anexos (${anexos.length})`);
  if (!anexos.length) p.paragrafo('Sem anexos.');
  else {
    // 2 por linha: print de tela e mais largo que alto e precisa dar pra ler
    const porLinha = 2; const vao = 10;
    const larguraFoto = (largura - vao * (porLinha - 1)) / porLinha;
    const alturaFoto = larguraFoto * 0.7;
    const comFoto = anexos.filter((a) => ehImagem(a) && fotos.porCaminho.get(a.path));
    for (let i = 0; i < comFoto.length; i += porLinha) {
      const linha = comFoto.slice(i, i + porLinha);
      p.garantirEspaco(alturaFoto + 14);
      const topo = doc.y;
      linha.forEach((a, j) => {
        const px = x + j * (larguraFoto + vao);
        try {
          doc.image(fotos.porCaminho.get(a.path), px, topo, { fit: [larguraFoto, alturaFoto], align: 'center', valign: 'center' });
        } catch (err) {
          // formato que o pdfkit nao le - o nome abaixo ja diz qual arquivo e
          doc.rect(px, topo, larguraFoto, alturaFoto).fillAndStroke('#f4f6f8', '#dde3ea');
        }
        doc.fontSize(7.5).fillColor('#7a838f').text(String(a.nome || 'anexo'), px, topo + alturaFoto + 2, { width: larguraFoto, align: 'center' });
      });
      doc.y = topo + alturaFoto + 14;
    }
    const soNome = anexos.filter((a) => !comFoto.includes(a));
    if (soNome.length) {
      doc.moveDown(0.4);
      p.paragrafo(`Também anexado (não exibido neste PDF): ${soNome.map((a) => a.nome || 'anexo').join(', ')}.`);
    }
    if (fotos.cortadas) {
      doc.moveDown(0.4);
      doc.fontSize(8.5).fillColor('#a0522d')
        .text(`Obs.: esta tarefa tem mais imagens do que cabe num registro (${fotos.cortadas} não incluída(s)). As demais continuam na tarefa, dentro do NoPulso.`, x, doc.y, { width: largura });
    }
  }

  p.fechar(`${ehOcorrencia ? 'Ocorrência' : 'Tarefa'} · ${tarefa.unidadeNome || tarefa.unidade || 'sem unidade'} · gerado em ${fmtDataHora(new Date().toISOString())}${geradoPor ? ` por ${geradoPor}` : ''}`);
}

// contagem por chave, ja ordenada do maior pro menor - e a leitura que a
// operacao faz ("qual unidade esta com mais coisa parada")
function contar(lista, chave) {
  const mapa = new Map();
  lista.forEach((t) => {
    const k = chave(t) || '—';
    mapa.set(k, (mapa.get(k) || 0) + 1);
  });
  return [...mapa].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), 'pt-BR'));
}

function desenharConsolidado(res, lista, { filtro = '', geradoPor, nomeArquivo, rotuloTipo = () => '', inline = true }) {
  const p = abrir(res, nomeArquivo, inline);
  const { largura } = p;
  const abertas = lista.filter((t) => t.status !== 'CONCLUIDA');

  p.cabecalho(
    'Meu Dia',
    'Relatório de Tarefas',
    filtro || 'Todas as tarefas do seu acesso',
    `${lista.length} tarefa(s)   ·   ${abertas.length} em aberto   ·   ${lista.length - abertas.length} concluída(s)`,
  );

  p.titulo('Por situação');
  p.tabela(
    [{ titulo: 'Situação', largura: largura - 70 }, { titulo: 'Tarefas', largura: 70, align: 'right' }],
    contar(lista, (t) => STATUS_LABEL[t.status] || t.status).map(([k, n]) => [k, n]),
  );

  p.titulo('Por unidade');
  p.tabela(
    [{ titulo: 'Unidade', largura: largura - 70 }, { titulo: 'Tarefas', largura: 70, align: 'right' }],
    contar(lista, (t) => t.unidadeNome || t.unidade || 'Tarefa pessoal').map(([k, n]) => [k, n]),
  );

  p.titulo('Por tipo');
  p.tabela(
    [{ titulo: 'Tipo', largura: largura - 70 }, { titulo: 'Tarefas', largura: 70, align: 'right' }],
    contar(lista, (t) => (t.ehOcorrencia ? 'Ocorrência' : (rotuloTipo(t.vinculo) || 'Sem ticket'))).map(([k, n]) => [k, n]),
  );

  p.titulo(`Tarefas (${lista.length})`);
  if (!lista.length) p.paragrafo('Nenhuma tarefa no filtro.');
  else {
    p.tabela(
      [
        { titulo: 'Unidade', largura: 88 },
        { titulo: 'Tarefa', largura: 168 },
        { titulo: 'Ticket', largura: 46 },
        { titulo: 'Responsável', largura: 80 },
        { titulo: 'Situação', largura: 74 },
        { titulo: 'Criada', largura: largura - 456 },
      ],
      lista.map((t) => [
        t.unidadeNome || t.unidade || 'Pessoal',
        `${t.ehOcorrencia ? '[Ocorrência] ' : ''}${t.titulo || '(sem título)'}`,
        t.vinculo && t.vinculo.numeroTicket != null ? `#${t.vinculo.numeroTicket}` : '',
        t.responsavelNome || '',
        STATUS_LABEL[t.status] || t.status,
        fmtData(t.criadaEm),
      ]),
    );
  }

  p.fechar(`Meu Dia · ${filtro || 'sem filtro'} · gerado em ${fmtDataHora(new Date().toISOString())}${geradoPor ? ` por ${geradoPor}` : ''}`);
}

async function gerarOcorrenciaPDF(res, tarefa, { fichaCampos, geradoPor, inline = true } = {}) {
  const fotos = await baixarFotos(tarefa.anexos);
  const nome = `${nomeArquivoRegistro(tarefa.ehOcorrencia ? 'ocorrencia' : 'tarefa', {
    unidade: tarefa.unidadeNome || tarefa.unidade,
    ticket: tarefa.numeroTicket ?? tarefa.vinculo?.numeroTicket,
    criadoEm: tarefa.criadaEm,
    id: tarefa.id,
  })}.pdf`;
  desenharOcorrencia(res, tarefa, { fichaCampos, fotos, geradoPor, nomeArquivo: nome, inline });
}

function gerarConsolidadoPDF(res, lista, opcoes = {}) {
  desenharConsolidado(res, lista, { ...opcoes, nomeArquivo: opcoes.nomeArquivo || 'meu-dia-relatorio.pdf' });
}

module.exports = { gerarOcorrenciaPDF, gerarConsolidadoPDF, STATUS_LABEL, contar, MAX_FOTOS };
