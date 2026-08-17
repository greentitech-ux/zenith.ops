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

// A chave que vai pro modelo e prefixada pela secao ("canal." / "forma.")
// porque os dois cadastros sao independentes e podem ter o mesmo campo: uma
// loja com "AdyenV2" nos dois lugares mandaria o valor pro campo errado se a
// chave fosse so o campo. Uma string so tambem e mais robusta que um campo
// "secao" separado - o modelo nao tem como acertar metade dela.
const chaveDe = (secao, campo) => `${secao}.${campo}`;

function montarPrompt(canais, formas, dica, qtdImagens) {
  const linhas = (lista) => lista.map((c) => `${chaveDe(c.secao, c.campo)} | ${c.label}`).join('\n');
  const blocoCanais = canais.length ? `
CANAIS DE VENDA (de onde veio a venda: salão, delivery, retirada, apps...):
${linhas(canais)}
` : '';
  const blocoFormas = formas.length ? `
FORMAS DE PAGAMENTO (com o que o cliente pagou: cartão, pix, voucher...):
${linhas(formas)}
` : '';
  // A dica vem do cadastro do grupo (Master), entao e texto confiavel - mas
  // entra DEPOIS das regras e delimitada, pra ser leitura de relatorio e nao
  // um jeito de reescrever o formato de saida.
  const blocoDica = dica ? `

Instruções específicas do relatório desta loja (escritas por quem opera - siga-as quando conflitarem com a leitura visual óbvia):
"""
${dica}
"""` : '';
  // com mais de uma imagem o modelo precisa saber que sao PARTES do mesmo
  // relatorio - senao trata cada uma como um relatorio independente e a
  // segunda "corrige" a primeira, perdendo metade dos valores
  const blocoMultiplas = qtdImagens > 1 ? `

Você recebeu ${qtdImagens} imagens. Elas são PARTES DO MESMO relatório, do mesmo dia - fotografadas separadamente porque não coubessem numa tela só. Junte tudo numa resposta única:
- Um campo que aparece em mais de uma imagem entra UMA vez só no JSON.
- Se o mesmo campo aparecer com valores DIFERENTES em duas imagens, não escolha: mande as duas leituras pra "naoIdentificados" com o texto de origem de cada uma. Pode ser foto de dias diferentes misturada, e nesse caso o gerente precisa ver.
- Se as imagens claramente forem de DIAS diferentes (datas diferentes impressas), devolva {"erro": "as fotos são de dias diferentes"} em vez de somar.
- Imagem que não for relatório de vendas (foto tremida, tela de outro sistema): simplesmente ignore, desde que pelo menos uma sirva.` : '';
  return `Você está vendo a foto (ou print) de um relatório de fechamento do sistema de PDV de uma loja de comida. Extraia os valores em dinheiro dos campos listados abaixo.${blocoMultiplas}

Campos cadastrados para esta loja (use a "chave" exatamente como está escrita aqui, com o prefixo):
${blocoCanais}${blocoFormas}
Devolva SOMENTE um JSON válido, sem nenhum texto antes ou depois, exatamente neste formato:
{
  "data": "AAAA-MM-DD da data do relatório, ou null se não conseguir ler",
  "campos": [
    { "chave": "chave exata da lista acima, com prefixo", "textoOrigem": "como a linha está escrita no relatório", "valor": numero }
  ],
  "naoIdentificados": [
    { "textoOrigem": "linha do relatório que tem valor mas você não conseguiu casar com nenhuma chave da lista", "valor": numero }
  ]
}

Regras:
- Só inclua em "campos" quando tiver bastante certeza de que a linha do relatório é aquela chave da lista. Nome parecido não basta se houver duas opções plausíveis - nesse caso mande pra "naoIdentificados". Um valor no campo errado é pior que um campo vazio: o campo vazio o gerente preenche olhando a foto, o valor errado ele só percebe se conferir tudo de novo.
- Não confunda as duas seções: canal de venda é de ONDE veio a venda, forma de pagamento é COM O QUE o cliente pagou. A mesma venda aparece nas duas, então os dois blocos costumam somar o mesmo total - isso é esperado, não é erro nem duplicidade.
- Não invente campo: se um campo da lista não aparece no relatório, simplesmente não o inclua no JSON (não mande com valor 0, porque 0 é uma informação diferente de "não apareceu"). Se ele aparece no relatório valendo 0,00 de verdade, aí sim mande 0.
- "naoIdentificados" existe pra não perder dinheiro de vista: se o relatório mostra uma linha com valor que não casa com nenhuma chave cadastrada, ela vai pra lá e o gerente decide. É melhor mostrar "sobrou R$ 320 que não sei onde colocar" do que ignorar em silêncio.
- Ignore linhas que claramente não são nem canal nem forma de pagamento: total geral, subtotal, vendas totais/líquidas/royalty, imposto, quantidade de pedidos, ticket médio, número de clientes, mão de obra, cupom, quilometragem, fundo de caixa. Só os campos da lista.
- PORCENTAGEM NUNCA É O VALOR. É comum a linha ter o nome, depois a participação em % e só então o valor em dinheiro (ex: "CarryOut 17,7% R$515,20" → o valor é 515.20, nunca 17.7). Qualquer número acompanhado de "%" deve ser ignorado.
- DUAS LINHAS PARECIDAS: o mesmo canal pode aparecer em mais de uma linha, variantes do mesmo nome (ex: dois tipos de Delivery, um por tipo de entregador), e normalmente só uma delas é usada - a outra fica zerada o tempo todo. Quando duas linhas parecidas disputam a mesma chave da lista e só uma tem valor, mande a que tem valor. Se as duas tiverem valor, não escolha no chute: mande as duas pra "naoIdentificados" com o texto de origem de cada uma, pro gerente decidir.
- IMPORTANTE: os números estão em formato brasileiro (ponto separa milhar, vírgula separa decimal - ex: "1.234,56"). Converta todo valor para o padrão JSON: só ponto decimal, sem separador de milhar (ex: 1234.56). Nunca escreva número com vírgula no JSON - isso quebra o formato.
- Datas sempre em AAAA-MM-DD. Se o relatório mostrar data e hora juntas, use só a data.
- Se a imagem não for um relatório de fechamento/vendas, devolva {"erro": "descrição curta do que você viu"} em vez do formato acima.${blocoDica}`;
}

function extrairJson(texto) {
  const limpo = String(texto || '').trim().replace(/^```(json)?/i, '').replace(/```\s*$/i, '').trim();
  return JSON.parse(limpo);
}

const numeroOuNull = (v) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);

const MAX_ARQUIVOS = 5;

async function lerCanais({ arquivos, canais, formas, dica }) {
  if (!ativo()) throw new Error('Leitura automática por imagem não está configurada neste servidor.');
  const fotos = (Array.isArray(arquivos) ? arquivos : []).filter((a) => a && a.buffer);
  if (!fotos.length) throw new Error('Anexe a foto do relatório de vendas.');
  if (fotos.length > MAX_ARQUIVOS) throw new Error(`Envie no máximo ${MAX_ARQUIVOS} fotos por leitura.`);
  const listaCanais = (Array.isArray(canais) ? canais : []).map((c) => ({ ...c, secao: 'canal' }));
  const listaFormas = (Array.isArray(formas) ? formas : []).map((c) => ({ ...c, secao: 'forma' }));
  const todos = [...listaCanais, ...listaFormas];
  if (!todos.length) {
    throw new Error('Essa loja ainda não tem Canais de venda nem Formas de pagamento cadastrados - peça pro Master configurar em Grupos.');
  }
  // com varias fotos vale numerar: sem o rotulo, o "textoOrigem" de uma
  // divergencia nao diz de QUAL foto veio, e o gerente nao sabe qual refazer
  const blocos = [];
  fotos.forEach((f, i) => {
    if (fotos.length > 1) blocos.push({ type: 'text', text: `Foto ${i + 1} de ${fotos.length}:` });
    blocos.push(f.mimeType === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.buffer.toString('base64') } }
      : { type: 'image', source: { type: 'base64', media_type: f.mimeType, data: f.buffer.toString('base64') } });
  });
  blocos.push({ type: 'text', text: montarPrompt(listaCanais, listaFormas, dica, fotos.length) });
  const resp = await getCliente().messages.create({
    model: MODELO,
    max_tokens: 4000,
    messages: [{ role: 'user', content: blocos }],
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

  // so aceita chave que existe MESMO no grupo: o modelo pode devolver uma
  // chave inventada ou de outra loja, e ai o valor entraria num campo que
  // a tela nem mostra - sumindo silenciosamente do fechamento
  const porChave = new Map(todos.map((c) => [chaveDe(c.secao, c.campo), c]));
  const vistos = new Set();
  const itens = [];
  (Array.isArray(dados.campos) ? dados.campos : []).forEach((c) => {
    const chave = String((c && c.chave) || '');
    const def = porChave.get(chave);
    const valor = numeroOuNull(c && c.valor);
    if (!def || valor == null || vistos.has(chave)) return;
    vistos.add(chave);
    itens.push({
      secao: def.secao,
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
    // campos que a loja tem mas nao apareceram na imagem: a tela avisa quais
    // continuam pra preencher na mao, em vez de deixar o gerente descobrir
    // no erro de fechamento
    faltando: todos
      .filter((c) => !vistos.has(chaveDe(c.secao, c.campo)))
      .map((c) => ({ secao: c.secao, campo: c.campo, label: c.label })),
  };
}

module.exports = { ativo, lerCanais };
