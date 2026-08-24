// termoResponsabilidade.js
// Termo de responsabilidade (uso do parque de trampolins) gerado em PDF a
// partir de um check-in de server/parque.js - impresso e assinado
// fisicamente pelo responsavel antes da entrada no parque. Layout retrato,
// texto corrido, diferente do padrao de tabela de reportUtil.js.
const PDFDocument = require('pdfkit');

// ---------- identidade da operadora do parque - troque so aqui quando o
// nome/CNPJ/endereco oficial mudar de novo ----------
const EMPRESA_NOME = 'Saltiverso Patteo';
const EMPRESA_NOME_MAIUSCULO = EMPRESA_NOME.toUpperCase();
const EMPRESA_CNPJ = '66.644.523/0001-89';
const EMPRESA_ENDERECO = 'Shopping Patteo Olinda';
const EMPRESA_CIDADE = 'Olinda';

function fmtDataBR(iso) {
  if (!iso) return '';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso);
}

function fmtHora(hhmmss) {
  return hhmmss ? String(hhmmss).slice(0, 5) : '';
}

const MESES_PT = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
function dataPorExtenso(d) {
  return `${EMPRESA_CIDADE}, ${d.getDate()} de ${MESES_PT[d.getMonth()]} de ${d.getFullYear()}.`;
}

// divide o texto legal nos pontos onde "WOW PARK" aparecia - cada posicao
// vira um trecho de negrito/maiusculo (EMPRESA_NOME_MAIUSCULO) quando
// renderizado (ver renderTextoComEmpresa) - assim trocar o nome/CNPJ/
// endereco no topo do arquivo atualiza tudo (cabecalho, corpo do termo,
// assinatura) de uma vez so, mantendo o destaque visual pedido pelo usuario
function partesDoTermo() {
  return TEXTO_TERMO.split('WOW PARK');
}

// desenha o paragrafo do termo com o nome da operadora em negrito/maiusculo
// no meio do texto corrido - usa o recurso "continued" do pdfkit pra
// encadear trechos com fontes diferentes dentro do MESMO paragrafo
// justificado (senao cada trecho quebraria linha/paragrafo por conta propria)
function renderTextoComEmpresa(doc, x, largura) {
  const partes = partesDoTermo();
  doc.fontSize(10).fillColor('#333');
  partes.forEach((parte, i) => {
    const primeira = i === 0;
    const ultima = i === partes.length - 1;
    // o pdfkit COME o espaco inicial de um trecho "continued" - saia
    // "SALTIVERSO PATTEOa fazer uso", "SALTIVERSO PATTEOnao se responsabiliza".
    // A correcao e mover o espaco pro fim do trecho em negrito, que o pdfkit
    // preserva. So quando o proximo trecho realmente comeca com espaco: em
    // "... PARK (parque de trampolins)" e "... PARK," nao pode entrar espaco.
    const texto = primeira || !parte.startsWith(' ') ? parte : parte.slice(1);
    doc.font('Helvetica').text(texto, ...(primeira ? [x, doc.y] : []), {
      width: largura, align: 'justify', lineGap: 3, continued: !ultima,
    });
    if (!ultima) {
      const proximo = partes[i + 1] || '';
      const emenda = proximo.startsWith(' ') ? EMPRESA_NOME_MAIUSCULO + ' ' : EMPRESA_NOME_MAIUSCULO;
      doc.font('Helvetica-Bold').text(emenda, { continued: true });
    }
  });
  doc.font('Helvetica');
}

// ---------- direito de NAO autorizar o uso de imagem ----------
// O corpo do termo diz "autorizo o ... a fazer uso das imagens". Sozinho,
// isso e consentimento sem saida: quem nao quer aparecer em foto nao tinha
// onde dizer isso, e assinar o termo era condicao pra entrar no parque. A
// LGPD (Lei 13.709) trata consentimento como manifestacao LIVRE - e nao ha
// escolha livre quando so existe a opcao de concordar.
//
// O termo IMPRESSO que o parque ja usa tem esse quadrado; o PDF gerado aqui
// nao tinha. Este bloco repoe a mesma redacao do impresso, logo acima da
// assinatura - a pessoa marca com caneta ANTES de assinar, entao a recusa
// fica coberta pela mesma assinatura que valida o resto do documento.
//
// ATENCAO: marcar aqui e so o registro em PAPEL. Enquanto a escolha nao for
// gravada no check-in (parque.js), o sistema NAO sabe quem recusou - pra
// achar, alguem tem que procurar no termo assinado. Ver a conversa sobre
// registrar o campo.
const TEXTO_NAO_AUTORIZO = 'Não autorizo o WOW PARK a fazer uso da minha imagem em filmagens, gravações ou '
  + 'fotografias captadas dentro do seu ambiente, para fins de direito ou de divulgação publicitária, '
  + 'sem que caracterize uso indevido de imagem ou qualquer violação de direitos.';

function renderOpcaoImagem(doc, x, largura) {
  doc.moveDown(1);

  // quadrado de marcar: desenhado como retangulo de verdade (nao o caractere
  // "( )"), pra sair do mesmo tamanho em qualquer visualizador de PDF e
  // sobrar espaco real pra caneta
  const lado = 11;
  const yTopo = doc.y;
  doc.rect(x, yTopo + 1, lado, lado).strokeColor('#333').lineWidth(1).stroke();

  const recuo = lado + 8;
  const [antes, depois] = TEXTO_NAO_AUTORIZO.split('WOW PARK');
  // mesmo cuidado com o espaco comido do renderTextoComEmpresa
  const emenda = depois.startsWith(' ') ? EMPRESA_NOME_MAIUSCULO + ' ' : EMPRESA_NOME_MAIUSCULO;
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#111')
    .text(antes, x + recuo, yTopo, {
      width: largura - recuo, align: 'justify', lineGap: 3, continued: true,
    });
  doc.font('Helvetica-Bold').text(emenda, { continued: true });
  doc.font('Helvetica-Bold').text(depois.startsWith(' ') ? depois.slice(1) : depois, {
    width: largura - recuo, align: 'justify', lineGap: 3,
  });

  doc.moveDown(0.4);
  doc.font('Helvetica-Oblique').fontSize(8.5).fillColor('#666')
    .text('Marque o quadrado acima apenas se NÃO autorizar o uso de imagem. Deixar em branco '
      + 'mantém a autorização descrita no texto acima. A escolha vale para o responsável e para '
      + 'os beneficiários listados neste termo.', x, doc.y, { width: largura, align: 'left', lineGap: 2 });
  doc.font('Helvetica');
}

// texto oficial fornecido pelo usuario (contrato "PASSAPORTE MENSAL PATTEO
// OLINDA" da WOW PARK PATTEO LTDA - operadora do parque em nome da
// Saltiverso Patteo) - reproduzido verbatim; se a versao correta/atualizada
// for enviada depois, so trocar este texto
const TEXTO_TERMO = `Estou ciente que o uso de meia antiderrapante é obrigatório. O WOW PARK, em todas as unidades, esclarece e alerta seus usuários que as atividades desenvolvidas em seus parques de trampolins (complexo de camas elásticas) se tratam de atividades esportivas de grande impacto físico, que, quando não respeitadas as orientações de segurança na sua utilização, poderão causar ao usuário ou a terceiros: entorses, ferimentos, fraturas, rupturas, arranhões, luxações, contusões, sem prejuízo de outras lesões ou até mesmo a morte. Também estou ciente que, mesmo utilizando adequadamente os equipamentos, em razão de características pessoais do usuário, existem riscos decorrentes de movimentos inadequados ou falta de coordenação motora. Dessa forma, eu, acima qualificado, declaro absoluta ciência de que a atividade desenvolvida no WOW PARK (parque de trampolins) envolve os riscos supracitados e, consciente e livremente, assumo toda e qualquer responsabilidade inerente a essa atividade, conhecida ou desconhecida, comprometendo-me a respeitar e cumprir rigorosamente as regras e orientações do estabelecimento e de seus prepostos. Ratifico e declaro que me encontro em perfeitas condições físicas para a prática dessa modalidade de diversão, assumindo o risco exclusivo por tal declaração. Ciente dos riscos inerentes à atividade (parque de trampolins), desde já, afasto e isento o WOW PARK de qualquer responsabilidade em caso de acidente, e autorizo o estabelecimento a reprimir e até mesmo proibir minha permanência em suas dependências, na hipótese de ser constatada qualquer alteração comportamental que ponha em risco a minha integridade física ou a de terceiros, assumindo integral responsabilidade pela reparação dos danos que der causa, sejam eles pessoais, materiais ou morais. Clientes que utilizam próteses ou que possuam qualquer limitação física, com ou sem comprometimento de equilíbrio, e/ou que apresentam histórico de condições médicas que envolvam risco potencial (cardiopatias, instabilidade cervical, epilepsia, síndrome de Down, etc.), somente poderão acessar a área de trampolins mediante apresentação de laudo médico atualizado (emitido há no máximo 6 meses), que autorize expressamente a prática de atividade física de alto impacto sem risco à própria integridade física ou à de terceiros. A autorização está condicionada ao cumprimento integral das normas de segurança do parque e à obrigatória presença de um acompanhante maior de idade que também esteja utilizando a atração. Declaro, pelo presente Termo de Responsabilidade, que, como usuário e/ou na qualidade de responsável pelo menor, estou ciente de que o WOW PARK não se responsabiliza, em hipótese alguma, pela saída e destino de seus frequentadores, cabendo aos responsáveis acompanhar a entrada, permanência e saída dos menores do parque. Não haverá a aceitação do encargo de guarda dos menores e portadores de necessidade especiais, cabendo aos pais e/ou tutores e curadores a manutenção do encargo de guarda e zelo pelas pessoas que se encontrem nessa condição. Os pais e responsáveis por pessoas portadoras de necessidades especiais que reduzam o discernimento ou gerem comportamentos agressivos e/ou incompatíveis com ambientes agitados deverão comunicar o fato aos responsáveis pelo WOW PARK, cientes da responsabilidade civil pela prestação de informações autênticas em documentos particulares. O WOW PARK não se responsabiliza por quaisquer objetos deixados nas áreas comuns do parque, incluindo perdas, extravios ou danos de qualquer natureza. Ressaltamos que são disponibilizados armários, individuais, com código de acesso, através de senha, chaves ou similar, para a guarda de pertences pessoais e itens de valor. Além disso, autorizo o WOW PARK a fazer uso das imagens, gravações ou fotografias captadas dentro do seu ambiente, para fins de direito ou de divulgação publicitária, sem que isso caracterize uso indevido de imagem ou qualquer violação de direitos. PORTANTO, DECLARO QUE LI, COMPREENDI E PREENCHI ESTE FORMULÁRIO DE TERMO DE RESPONSABILIDADE E CONCORDO EXPRESSAMENTE COM TODOS OS SEUS TERMOS E CONDIÇÕES, ASSUMINDO CIVIL E CRIMINALMENTE PELA VERACIDADE DAS INFORMAÇÕES PRESTADAS. Ao assinar este termo, também concordo com o Regulamento e autorizo o tratamento de meus dados pessoais para finalidade específica pelo WOW PARK, em conformidade com a Lei nº 13.709 – Lei Geral de Proteção de Dados Pessoais (LGPD). POR FIM, DECLARO QUE NÃO SOLICITEI EVENTUAIS ALTERAÇÕES NO DOCUMENTO E NÃO INCLUI QUALQUER INFORMAÇÃO ADICIONAL, MESMO APÓS A LEITURA DO PRESENTE DOCUMENTO. O presente Termo de Responsabilidade tem validade por tempo indeterminado.`;

function gerarTermoPDF(res, checkin) {
  const doc = new PDFDocument({ margin: 48, size: 'A4' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="termo-${checkin.id}.pdf"`);
  doc.pipe(res);

  const x = doc.page.margins.left;
  const largura = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  doc.fontSize(8).fillColor('#5b6470');
  doc.font('Helvetica-Bold').text(EMPRESA_NOME_MAIUSCULO, x, doc.y, { continued: true, characterSpacing: 0.5 });
  doc.font('Helvetica').text(` · CNPJ ${EMPRESA_CNPJ} · ${EMPRESA_ENDERECO}`, { characterSpacing: 0.5 });
  doc.moveDown(0.3);
  doc.fontSize(17).fillColor('#111').text('Termo de Ciência e Responsabilidade', x, doc.y);
  doc.fontSize(10).fillColor('#666').text('Acesso ao espaço de trampolins/jump', x, doc.y);
  doc.moveDown(1);

  function linhaCampo(label, valor) {
    doc.fontSize(9).fillColor('#666').text(label.toUpperCase(), x, doc.y, { characterSpacing: 0.5 });
    doc.fontSize(11).fillColor('#111').text(valor || '—', x, doc.y);
    doc.moveDown(0.6);
  }

  doc.rect(x, doc.y, largura, 1).fill('#dde3ea');
  doc.moveDown(0.8);

  linhaCampo('Contratante (responsável)', checkin.responsavel?.nome);
  linhaCampo('CPF', checkin.responsavel?.cpf);
  linhaCampo('Contato', checkin.responsavel?.contato);
  linhaCampo('Endereço', [checkin.responsavel?.endereco || checkin.responsavel?.cep, checkin.responsavel?.numero, checkin.responsavel?.complemento].filter(Boolean).join(', '));
  const horarioTexto = checkin.iniciado
    ? `${fmtHora(checkin.timeInicial)} às ${fmtHora(checkin.timeFinal)}`
    : 'horário definido no check-in';
  // sem tempo definido, NAO escreve "(undefined min)" - isso ja saiu impresso
  // num documento que a pessoa assina. Campo que nao existe simplesmente nao
  // aparece; e melhor faltar do que sair lixo num termo com valor legal.
  const tempoTexto = Number(checkin.tempoMinutos) > 0 ? ` (${Number(checkin.tempoMinutos)} min)` : '';
  linhaCampo('Data de utilização', `${fmtDataBR(checkin.dataUtilizacao)} · ${horarioTexto}${tempoTexto}`);
  if (checkin.adultoCortesia) {
    linhaCampo('Adulto cortesia (A.C.)', `Sim — ${checkin.quantAC || 1} adulto(s) com entrada permitida`);
  }

  doc.moveDown(0.3);
  doc.fontSize(9).fillColor('#666').text('BENEFICIÁRIO(S) — CRIANÇAS QUE VÃO UTILIZAR O PARQUE', x, doc.y, { characterSpacing: 0.5 });
  doc.moveDown(0.3);
  (checkin.criancas || []).forEach((c, i) => {
    doc.fontSize(11).fillColor('#111').text(`${i + 1}. ${c.nome}${c.dataNascimento ? '  ·  nascimento: ' + fmtDataBR(c.dataNascimento) : ''}`, x, doc.y);
    doc.moveDown(0.3);
  });

  doc.moveDown(0.8);
  doc.rect(x, doc.y, largura, 1).fill('#dde3ea');
  doc.moveDown(0.8);

  renderTextoComEmpresa(doc, x, largura);

  renderOpcaoImagem(doc, x, largura);

  doc.moveDown(1.5);
  doc.fontSize(10).fillColor('#333').text(dataPorExtenso(new Date()), x, doc.y);

  doc.moveDown(2.5);
  const yAssinatura = doc.y;
  doc.moveTo(x, yAssinatura).lineTo(x + 240, yAssinatura).strokeColor('#333').lineWidth(1).stroke();
  doc.moveTo(x + 300, yAssinatura).lineTo(x + largura, yAssinatura).strokeColor('#333').lineWidth(1).stroke();
  doc.font('Helvetica').fontSize(9).fillColor('#666').text('Contratante (responsável)', x, yAssinatura + 4);
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#666').text(EMPRESA_NOME_MAIUSCULO, x + 300, yAssinatura + 4);
  doc.font('Helvetica');

  doc.end();
}

module.exports = { gerarTermoPDF };
