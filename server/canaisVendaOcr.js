// canaisVendaOcr.js
// Le a foto do relatorio de vendas do PDV (a tela/impressao que a loja ja
// olha no fim do dia) e devolve um RASCUNHO com o valor de cada Canal de
// venda, ja casado com os canais que o Master cadastrou pro grupo daquela
// loja em /grupos.html.
//
// Mesma ideia (e mesmo Claude com visao) da leitura de nota fiscal do
// Estoque - ver inventarioNotaOcr.js. A diferenca e o que se casa: la e o
// catalogo de itens da loja, aqui e a lista de canais do grupo. Cada grupo
// tem os seus (Salao, Delivery, iFood, 99Food...), entao o mesmo print de
// PDV le diferente em cada bandeira, e e por isso que a lista de canais vai
// no prompt em vez de estar fixa no codigo.
//
// NADA aqui grava: devolve o rascunho, o gerente confere campo a campo e so
// entao envia o fechamento (ver lancamento.html). Foto de tela erra - papel
// amassado, brilho, corte - e um numero errado no Faturamento contamina o
// fechamento do dia inteiro. A conferencia humana e a parte que nao sai.
//
// So funciona com ANTHROPIC_API_KEY configurada (mesma regra do Beniboy):
// sem ela ativo() volta false e a tela mostra so o preenchimento manual.
let cliente = null;
function ativo() {
  return !!process.env.ANTHROPIC_API_KEY;
}
function getCliente() {
  if (!cliente) {
    const Anthropic = require('@anthropic-ai/sdk');
    cliente = new Anthropic(); // le ANTHROPIC_API_KEY da env var sozinho
  }
  return cliente;
}

// Mesmo modelo da leitura de nota: relatorio de PDV e texto denso, em
// tabela, com formato diferente por sistema (Domino's, Spoleto, cada PDV
// imprime do seu jeito) - e o numero lido aqui vai direto pro Faturamento
const MODELO = 'claude-sonnet-5';

function montarPrompt(canais) {
  const lista = canais.map((c) => `${c.campo} | ${c.label}`).join('\n');
  return `Você está vendo a foto (ou print) de um relatório de vendas do sistema de PDV de uma loja de comida. Extraia o VALOR TOTAL VENDIDO em cada canal de venda.

Canais de venda cadastrados para esta loja (use o "campo" exatamente como está escrito aqui):
${lista}

Devolva SOMENTE um JSON válido, sem nenhum texto antes ou depois, exatamente neste formato:
{
  "data": "AAAA-MM-DD da data do relatório, ou null se não conseguir ler",
  "canais": [
    { "campo": "campo exato da lista acima", "textoOrigem": "como o canal está escrito no relatório", "valor": numero }
  ],
  "naoIdentificados": [
    { "textoOrigem": "linha do relatório que tem valor mas você não conseguiu casar com nenhum canal da lista", "valor": numero }
  ]
}

Regras:
- Só inclua em "canais" quando tiver bastante certeza de que a linha do relatório é aquele canal da lista. Nome parecido não basta se houver duas opções plausíveis - nesse caso mande pra "naoIdentificados". Um valor no canal errado é pior que um campo vazio: o campo vazio o gerente preenche olhando a foto, o valor errado ele só percebe se conferir tudo de novo.
- Não invente canal: se um canal da lista não aparece no relatório, simplesmente não o inclua no JSON (não mande com valor 0, porque 0 é uma informação diferente de "não apareceu").
- "naoIdentificados" existe pra não perder dinheiro de vista: se o relatório mostra uma linha de venda que não casa com nenhum canal cadastrado, ela vai pra lá e o gerente decide. É melhor mostrar "sobrou R$ 320 que não sei onde colocar" do que ignorar em silêncio.
- Ignore linhas que claramente NÃO são canal de venda: total geral, subtotal, quantidade de pedidos, ticket médio, número de clientes, impostos, desconto. Só valores de venda POR CANAL.
- IMPORTANTE: os números estão em formato brasileiro (ponto separa milhar, vírgula separa decimal - ex: "1.234,56"). Converta todo valor para o padrão JSON: só ponto decimal, sem separador de milhar (ex: 1234.56). Nunca escreva número com vírgula no JSON - isso quebra o formato.
- Datas sempre em AAAA-MM-DD.
- Se a imagem não for um relatório de vendas, devolva {"erro": "descrição curta do que você viu"} em vez do formato acima.`;
}

function extrairJson(texto) {
  const limpo = String(texto || '').trim().replace(/^```(json)?/i, '').replace(/```\s*$/i, '').trim();
  return JSON.parse(limpo);
}

const numeroOuNull = (v) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);

async function lerCanais({ buffer, mimeType, canais }) {
  if (!ativo()) throw new Error('Leitura automática por imagem não está configurada neste servidor.');
  if (!Array.isArray(canais) || !canais.length) {
    throw new Error('Essa loja ainda não tem Canais de venda cadastrados - peça pro Master configurar em Grupos.');
  }
  const ehPdf = mimeType === 'application/pdf';
  const bloco = ehPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } }
    : { type: 'image', source: { type: 'base64', media_type: mimeType, data: buffer.toString('base64') } };
  const resp = await getCliente().messages.create({
    model: MODELO,
    max_tokens: 4000,
    messages: [{ role: 'user', content: [bloco, { type: 'text', text: montarPrompt(canais) }] }],
  });
  const texto = (resp.content || []).map((b) => b.text || '').join('');
  let dados;
  try {
    dados = extrairJson(texto);
  } catch (e) {
    // sem o texto bruto no log, erro de formatacao do modelo (numero com
    // virgula, corte por max_tokens) fica impossivel de diagnosticar pela
    // mensagem generica que o gerente ve
    console.error('canaisVendaOcr: falha ao parsear JSON. stop_reason=%s texto=%s', resp.stop_reason, texto.slice(0, 2000));
    throw new Error('Não consegui entender essa imagem. Tente uma foto mais nítida, com o relatório inteiro enquadrado.');
  }
  if (dados.erro) throw new Error(String(dados.erro).slice(0, 200));

  // so aceita campo que existe MESMO no grupo: o modelo pode devolver um
  // campo inventado ou de outra loja, e ai o valor entraria num campo que
  // a tela nem mostra - sumindo silenciosamente do fechamento
  const porCampo = new Map(canais.map((c) => [c.campo, c]));
  const vistos = new Set();
  const itens = [];
  (Array.isArray(dados.canais) ? dados.canais : []).forEach((c) => {
    const def = porCampo.get(String(c && c.campo));
    const valor = numeroOuNull(c && c.valor);
    if (!def || valor == null || vistos.has(def.campo)) return;
    vistos.add(def.campo);
    itens.push({
      campo: def.campo,
      label: def.label,
      valor,
      textoOrigem: c.textoOrigem ? String(c.textoOrigem).slice(0, 80) : null,
    });
  });

  const naoIdentificados = (Array.isArray(dados.naoIdentificados) ? dados.naoIdentificados : [])
    .map((n) => ({ textoOrigem: String((n && n.textoOrigem) || '').slice(0, 80), valor: numeroOuNull(n && n.valor) }))
    .filter((n) => n.textoOrigem && n.valor != null);

  return {
    data: /^\d{4}-\d{2}-\d{2}$/.test(dados.data) ? dados.data : null,
    itens,
    naoIdentificados,
    // canais que a loja tem mas nao apareceram na imagem: a tela avisa quais
    // continuam pra preencher na mao, em vez de deixar o gerente descobrir
    // no erro de fechamento
    faltando: canais.filter((c) => !vistos.has(c.campo)).map((c) => ({ campo: c.campo, label: c.label })),
  };
}

module.exports = { ativo, lerCanais };
