// inventarioNotaOcr.js
// Le a foto/PDF da nota fiscal de recebimento de mercadoria e devolve um
// RASCUNHO de lancamento (data, fornecedor, numero da nota + uma linha por
// item, ja tentando casar cada linha com o item certo do catalogo da loja) -
// reaproveita o mesmo Claude com visao que ja existe pro Beniboy
// (suporteBot.js), so que aqui e uma chamada avulsa, sem conversa.
//
// NADA aqui grava no banco - so devolve o rascunho pro gerente conferir e
// confirmar linha por linha (ver POST /api/inventario/recebimentos/ler-nota
// em index.js e o fluxo de revisao em estoque.html). Leitura de nota em foto
// erra as vezes (borrado, letra ruim, formato diferente por fornecedor) e um
// erro silencioso ali contamina Diferencas/CMV - por isso sempre com
// conferencia humana antes de virar recebimento de verdade.
//
// So funciona se ANTHROPIC_API_KEY estiver configurada (mesma regra do
// Beniboy) - sem ela, ativo() volta false e a tela mostra o formulario
// manual normal, sem quebrar nada.
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

const MODELO = 'claude-opus-5';

function montarPrompt(catalogo) {
  const catalogoTexto = catalogo.map((i) => `${i.id} | ${i.nome} | unidade: ${i.unidadeMedida}`).join('\n') || '(catálogo vazio)';
  return `Você está vendo a foto ou o PDF de uma nota fiscal de recebimento de mercadoria de uma loja de comida/bebidas. Extraia os dados em JSON.

Catálogo de itens desta loja (para casar cada linha da nota com o item certo, quando der para ter certeza):
${catalogoTexto}

Devolva SOMENTE um JSON válido, sem nenhum texto antes ou depois, exatamente neste formato:
{
  "data": "AAAA-MM-DD ou null se não conseguir ler a data de emissão/recebimento",
  "fornecedor": "nome do fornecedor/emitente ou null",
  "numeroNota": "número da nota ou null",
  "itens": [
    {
      "produtoTexto": "como está escrito na nota",
      "quantidade": numero,
      "valorUnitario": numero ou null,
      "valorTotal": numero ou null,
      "itemIdSugerido": "id do catálogo acima, ou null se não tiver certeza"
    }
  ]
}

Regras:
- Se a linha da nota só tiver o valor total (sem unitário) ou vice-versa, preencha o que tiver e deixe o outro null.
- Quantidade é sempre o número escrito na nota, sem converter unidade.
- Só preencha itemIdSugerido quando tiver bastante certeza de que é o mesmo produto do catálogo (nome parecido, mesma unidade) - errar a sugestão é pior que deixar null, porque quem confere só repara num erro sutil, mas um campo vazio ela preenche na hora olhando a nota.
- Datas sempre em AAAA-MM-DD.
- IMPORTANTE: os números na nota estão em formato brasileiro (ponto separa milhar, vírgula separa decimal - ex: "1.234,56"). Converta todo campo numérico (quantidade, valorUnitario, valorTotal) para o padrão JSON: só ponto decimal, sem separador de milhar, sem vírgula (ex: 1234.56). Nunca escreva um número com vírgula no JSON - isso quebra o formato.
- Se a imagem não for uma nota fiscal/comprovante de recebimento, devolva {"erro": "descrição curta do que você viu"} em vez do formato acima.`;
}

function extrairJson(texto) {
  const limpo = String(texto || '').trim().replace(/^```(json)?/i, '').replace(/```\s*$/i, '').trim();
  return JSON.parse(limpo);
}

async function lerNota({ buffer, mimeType, catalogo }) {
  if (!ativo()) throw new Error('Leitura automática de nota não está configurada neste servidor.');
  const ehPdf = mimeType === 'application/pdf';
  const bloco = ehPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } }
    : { type: 'image', source: { type: 'base64', media_type: mimeType, data: buffer.toString('base64') } };
  const resp = await getCliente().messages.create({
    model: MODELO,
    max_tokens: 8000,
    messages: [{ role: 'user', content: [bloco, { type: 'text', text: montarPrompt(catalogo) }] }],
  });
  const texto = (resp.content || []).map((b) => b.text || '').join('');
  let dados;
  try {
    dados = extrairJson(texto);
  } catch (e) {
    // guarda o texto bruto no log do servidor - sem isso, um erro de
    // formatação do modelo (ex: numero com virgula, corte por max_tokens)
    // fica impossivel de diagnosticar so pela mensagem generica que o
    // gerente ve na tela
    console.error('inventarioNotaOcr: falha ao parsear JSON da nota. stop_reason=%s texto=%s', resp.stop_reason, texto.slice(0, 2000));
    throw new Error('Não consegui entender essa nota. Tente uma foto mais nítida, com a nota inteira enquadrada.');
  }
  if (dados.erro) throw new Error(dados.erro);

  const catalogoPorId = new Map(catalogo.map((i) => [i.id, i]));
  const itens = (Array.isArray(dados.itens) ? dados.itens : []).map((it) => {
    const item = it.itemIdSugerido ? catalogoPorId.get(it.itemIdSugerido) : null;
    return {
      produtoTexto: String(it.produtoTexto || '').slice(0, 160),
      quantidade: Number.isFinite(Number(it.quantidade)) ? Number(it.quantidade) : null,
      valorUnitario: it.valorUnitario != null && Number.isFinite(Number(it.valorUnitario)) ? Number(it.valorUnitario) : null,
      valorTotal: it.valorTotal != null && Number.isFinite(Number(it.valorTotal)) ? Number(it.valorTotal) : null,
      itemId: item ? item.id : null,
      itemNome: item ? item.nome : null,
      itemUnidadeMedida: item ? item.unidadeMedida : null,
    };
  });

  return {
    data: /^\d{4}-\d{2}-\d{2}$/.test(dados.data) ? dados.data : null,
    fornecedor: dados.fornecedor ? String(dados.fornecedor).trim().slice(0, 80) : null,
    numeroNota: dados.numeroNota ? String(dados.numeroNota).trim().slice(0, 60) : null,
    itens,
  };
}

module.exports = { ativo, lerNota };
