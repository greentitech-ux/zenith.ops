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
// imprime do seu jeito) - e o numero lido aqui vai direto pro Faturamento.
// Configuravel por env pra trocar sem deploy de codigo (so redeploy de
// config no Render): OCR_MODELO troca o modelo das 2 leituras normais.
const MODELO = process.env.OCR_MODELO || 'claude-sonnet-5';
// O DESEMPATE usa um modelo mais forte, e SO roda quando as duas leituras
// normais discordaram - o dia normal nao paga por ele. E a versao barata de
// "aumentar o modelo": em vez de pagar 5x em toda leitura, paga so no campo
// e no dia em que o modelo normal tropecou.
const MODELO_DESEMPATE = process.env.OCR_MODELO_DESEMPATE || 'claude-opus-5';

// A chave que vai pro modelo e prefixada pela secao ("canal." / "forma.")
// porque os dois cadastros sao independentes e podem ter o mesmo campo: uma
// loja com "AdyenV2" nos dois lugares mandaria o valor pro campo errado se a
// chave fosse so o campo. Uma string so tambem e mais robusta que um campo
// "secao" separado - o modelo nao tem como acertar metade dela.
const ocrUso = require('./ocrUso');

const chaveDe = (secao, campo) => `${secao}.${campo}`;

// KPI (diferente de canal/forma) nem sempre e dinheiro - moeda/kg/quantidade
// tem unidades diferentes, e o modelo precisa saber qual pra nao confundir
// "12,500" de peso com R$ 12,50, por exemplo. "texto" existe pra metrica que
// o Master nao conseguiu encaixar em nenhum tipo numerico - normalmente
// tempo em minutos DECIMAL (ex: "2,05"), que nao cabe no tipo "Tempo" da
// tela (esse so aceita mm:ss) - mas o relatorio imprime como texto solto
// mesmo assim, entao a resposta pode vir string em vez de numero
function unidadeHintKpi(tipo) {
  if (tipo === 'moeda') return ' (em R$)';
  if (tipo === 'kg') return ' (em Kg)';
  if (tipo === 'texto') return ' (texto livre - copie exatamente como está escrito no relatório, não precisa ser um número redondo)';
  return ' (quantidade, sem unidade/dinheiro)';
}

function montarPrompt(canais, formas, kpis, dica, qtdImagens) {
  const linhas = (lista) => lista.map((c) => `${chaveDe(c.secao, c.campo)} | ${c.label}`).join('\n');
  const blocoCanais = canais.length ? `
CANAIS DE VENDA (de onde veio a venda: salão, delivery, retirada, apps...):
${linhas(canais)}
` : '';
  const blocoFormas = formas.length ? `
FORMAS DE PAGAMENTO (com o que o cliente pagou: cartão, pix, voucher...):
${linhas(formas)}
` : '';
  // entram aqui os KPI's numericos (quantidade/moeda/kg) e os de texto livre
  // (esses respondem com "valor" em string, nao numero) - tipo tempo (mm:ss)
  // e arquivo continuam de fora (ver filtro em index.js antes de chamar
  // lerCanais)
  const blocoKpis = kpis.length ? `
KPI'S (outras informações que também podem aparecer no relatório - nem sempre é dinheiro; a unidade de cada uma está indicada):
${kpis.map((c) => `${chaveDe(c.secao, c.campo)} | ${c.label}${unidadeHintKpi(c.tipo)}`).join('\n')}
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
  return `Você está vendo a foto (ou print) de um relatório de fechamento do sistema de PDV de uma loja de comida. Extraia o valor de cada campo listado abaixo - a maioria é dinheiro, mas alguns KPI's podem ser quantidade ou peso (a unidade de cada campo está indicada quando não for dinheiro).${blocoMultiplas}

Campos cadastrados para esta loja (use a "chave" exatamente como está escrita aqui, com o prefixo):
${blocoCanais}${blocoFormas}${blocoKpis}
Devolva SOMENTE um JSON válido, sem nenhum texto antes ou depois, exatamente neste formato:
{
  "data": "AAAA-MM-DD da data do relatório, ou null se não conseguir ler",
  "campos": [
    { "chave": "chave exata da lista acima, com prefixo", "textoOrigem": "como a linha está escrita no relatório", "valor": numero (ou texto, só pra chave marcada "texto livre" na lista de KPI's) }
  ],
  "conferencias": [
    { "titulo": "nome do quadro (ex: Resumo de Pedidos)", "totalTexto": "linha do total como está impressa", "totalValor": numero,
      "partes": [ { "textoOrigem": "linha da parte como está impressa", "valor": numero, "chave": "chave da lista acima se essa parte for um campo cadastrado, senão null" } ] }
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
- Ignore linhas que claramente não são canal, forma de pagamento nem KPI cadastrado: total geral, subtotal, vendas totais/líquidas/royalty, imposto, número de clientes, mão de obra, cupom, fundo de caixa. EXCEÇÃO: se uma dessas linhas (ex: "quantidade de pedidos", "ticket médio", "quilometragem") tiver o mesmo nome/sentido de um KPI cadastrado na lista de KPI's acima, ela NÃO é ruído - extraia normalmente pra chave daquele KPI. Só ignore o que não está em nenhuma das 3 listas.
- TAXA NÃO É QUANTIDADE. Linha de "Per 1000", "por mil", "a cada 1000" e QUALQUER coluna de % são TAXA, não contagem. Um mesmo quadro costuma imprimir as duas (o "Extreme Late Deliveries" lista as faixas com a contagem na coluna "#" e, na última linha, a taxa por mil). Se o campo cadastrado pede quantidade, o valor é a CONTAGEM - some a coluna "#" das faixas do quadro - e nunca a linha da taxa. Só mande a taxa se o próprio nome do campo falar em "por mil"/"per 1000"/"%".
- "conferencias": quando o relatório imprime um TOTAL com as parcelas dele logo acima (ex: o quadro "Resumo de Pedidos" imprime Delivery, Carry Out, Pick Up, Dine In, Cancelado, Retornado e depois "Total"), transcreva esse quadro aqui: o total e TODAS as parcelas dele, com o valor de cada uma, na ordem impressa. Inclua a parcela mesmo que valha 0 e mesmo que ela não seja um campo cadastrado (nesse caso "chave": null) - o servidor SOMA as parcelas e compara com o total pra saber se a leitura desalinhou. Só transcreva quadro em que o total impresso é de fato a soma das parcelas listadas; se for total de dinheiro de um quadro e as parcelas de outro, não invente relação, deixe "conferencias" vazio. E só transcreva quadro que contém PELO MENOS UM campo da lista cadastrada — quadro sem nenhum campo cadastrado não confere nada, transcrever ele é só resposta maior. No máximo 4 quadros, e o "textoOrigem" das partes segue a mesma regra do curto.
- LAYOUT EM DUAS COLUNAS: é comum o relatório imprimir DOIS pares "nome valor" lado a lado na mesma linha (ex: "Delivery 46    Delivery Agendado 1"). O valor de um nome é o número IMEDIATAMENTE à direita DELE — nunca o último número da linha, nunca o da coluna vizinha. Antes de responder, confira nome por nome: se o número que você ia mandar pertence ao nome do lado, você desalinhou as colunas.
- ZERO NÃO SE PULA: linha que vale 0 é informação, e omitir ela desalinha tudo que vem depois. Se "Pick Up" está impresso valendo 0, mande 0 nesse campo — não deixe o 0 de fora e não passe pra ele o valor da linha de baixo.
- "textoOrigem" tem que ser a linha REAL de onde o número saiu, copiada como está impressa, COM o nome junto (ex: "Dine In 6"). O servidor confere o nome do campo contra esse texto pra detectar troca de coluna, então textoOrigem que não bate com o campo faz a leitura ser recusada — copiar a linha certa é parte da resposta, não enfeite. Mantenha CURTO: só o par nome+valor daquela linha (máx ~50 caracteres), nunca a linha vizinha junto.
- PORCENTAGEM NUNCA É O VALOR. É comum a linha ter o nome, depois a participação em % e só então o valor em dinheiro (ex: "CarryOut 17,7% R$515,20" → o valor é 515.20, nunca 17.7). Qualquer número acompanhado de "%" deve ser ignorado.
- DUAS LINHAS PARECIDAS: o mesmo canal pode aparecer em mais de uma linha, variantes do mesmo nome (ex: dois tipos de Delivery, um por tipo de entregador), e normalmente só uma delas é usada - a outra fica zerada o tempo todo. Quando duas linhas parecidas disputam a mesma chave da lista e só uma tem valor, mande a que tem valor. Se as duas tiverem valor, não escolha no chute: mande as duas pra "naoIdentificados" com o texto de origem de cada uma, pro gerente decidir.
- IMPORTANTE: os números estão em formato brasileiro (ponto separa milhar, vírgula separa decimal - ex: "1.234,56"). Converta todo valor para o padrão JSON: só ponto decimal, sem separador de milhar (ex: 1234.56). Nunca escreva número com vírgula no JSON - isso quebra o formato.
- Datas sempre em AAAA-MM-DD. Se o relatório mostrar data e hora juntas, use só a data.
- Se a imagem não for um relatório de fechamento/vendas, devolva {"erro": "descrição curta do que você viu"} em vez do formato acima.${blocoDica}`;
}

// A mensagem generica "Nao consegui entender essa imagem" que a tela mostra
// nao quer dizer foto ruim - ela dispara sempre que o modelo devolve algo
// que nao e JSON valido, o que acontece por dois motivos comuns mesmo com a
// foto perfeitamente legivel:
//  1) o modelo escreve uma frase antes/depois do JSON, apesar da instrucao
//     "SOMENTE JSON" no prompt;
//  2) um numero fica em formato BR (virgula decimal, ex: "3.636,40") na
//     posicao de VALOR, apesar da regra explicita no prompt pra converter -
//     JSON.parse('{"a":3.636,40}') estoura porque depois do "," o parser
//     espera a proxima chave (entre aspas), nao outro digito solto.
// As duas correcoes abaixo sao best-effort: nao mudam o resultado quando o
// texto ja vem certo (o caso comum), so evitam refazer a foto por um
// tropeco de formatacao do modelo que nao tem nada a ver com a imagem.
function extrairJson(texto) {
  let limpo = String(texto || '').trim().replace(/^```(json)?/i, '').replace(/```\s*$/i, '').trim();
  // corta qualquer coisa fora do primeiro "{" e do ultimo "}" - o corpo do
  // JSON em si nunca tem chave desbalanceada por fora dele
  const inicio = limpo.indexOf('{');
  const fim = limpo.lastIndexOf('}');
  if (inicio >= 0 && fim > inicio) limpo = limpo.slice(inicio, fim + 1);
  // so mexe em numero que aparece logo depois de ":" (posicao de valor -
  // chave de objeto sempre vem entre aspas, nunca cai aqui) e antes de "," /
  // "}" / "]" (fim do valor) - nao arrisca tocar em nenhum outro lugar do JSON
  limpo = limpo.replace(/:(\s*)(-?)((?:\d{1,3}(?:\.\d{3})+|\d+)),(\d{1,2})(?=\s*[,}\]])/g,
    (m, esp, sinal, inteiro, dec) => `:${esp}${sinal}${inteiro.replace(/\./g, '')}.${dec}`);
  return JSON.parse(limpo);
}

// ---------------------------------------------- conferência da leitura
//
// O caso real que motivou isto: num "Resumo de Pedidos" impresso em DUAS
// colunas, o modelo devolveu Cancelado=6 (que era o valor de Dine In),
// PickUp=4 (valor de "Editado", a coluna da direita) e Retornado=1 - com
// Dine In vazio. Os três campos errados eram justamente os que valiam 0 no
// relatório. Reler a mesma foto deu um resultado DIFERENTE, também errado:
// não é foto ruim, é desalinhamento de coluna, e ele não é estável.
//
// O que salva sem custar nada: o modelo já devolve `textoOrigem`, a linha de
// onde tirou o número. Se o nome do campo não aparece nessa linha, o par
// nome↔valor está trocado - e isso dá pra conferir aqui, de forma
// determinística, sem uma segunda chamada ao modelo.
//
// Conservador de propósito: só acusa quando NÃO HÁ nenhuma correspondência.
// Alarme falso é pior que silêncio aqui - ele treina quem lança a ignorar o
// aviso, e aí o aviso não serve pra nada no dia em que estiver certo.
function normalizarTexto(txt) {
  return String(txt == null ? '' : txt)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // tira acento
    .toLowerCase()
    .replace(/\((?:r\$|kg|calc|otd|un|min)\)/g, ' ')     // sufixo de unidade do cadastro
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// "Per 1000" / "por mil" / "a cada 1000": a linha é uma TAXA. O quadro imprime
// a contagem e a taxa lado a lado, então pegar a linha errada troca "2
// pedidos" por "43,48" no mesmo campo - dois números que não se parecem, mas
// que ninguém percebe trocados olhando só o formulário.
// A exceção é o campo que PEDE a taxa: se o nome dele fala em por mil/%, a
// linha da taxa é a certa e não há o que acusar.
const MARCA_DE_TAXA = /(per\s*1000|por\s*mil|a\s*cada\s*(?:1000|mil)|\/\s*1000|per\s*thousand)/i;
const pareceTaxa = (txt) => MARCA_DE_TAXA.test(String(txt == null ? '' : txt));

function valorDeTaxaEmCampoDeContagem(label, textoOrigem) {
  return pareceTaxa(textoOrigem) && !pareceTaxa(label);
}

function rotuloBateComOrigem(label, textoOrigem) {
  const orig = normalizarTexto(textoOrigem);
  const rot = normalizarTexto(label);
  // sem letra pra comparar (origem só com o número, ou vazia) não dá pra
  // conferir - não acusa, porque não saber não é o mesmo que estar errado
  if (!/[a-z]/.test(orig) || !/[a-z]/.test(rot)) return true;
  const semEspaco = (t) => t.replace(/ /g, '');
  const cr = semEspaco(rot);
  const co = semEspaco(orig);
  if (!cr) return true;
  // "PickUp" (cadastro) x "Pick Up 0" (relatório): o nome é o mesmo, o
  // espaço é que muda - comparar sem espaço resolve os dois sentidos
  if (co.includes(cr) || cr.includes(co.replace(/[0-9]+/g, ''))) return true;
  // rótulo composto casa por palavra: "Media Saida de Loja (OTD)" contra uma
  // linha que imprime só parte do nome
  return rot.split(' ').filter((p) => p.length >= 4).some((p) => co.includes(p));
}

// ------------------------------------------------ conferência pela soma
//
// O relatório já traz a prova: o quadro "Resumo de Pedidos" imprime as
// parcelas e o Total. No dia do erro a leitura deu Delivery 46, Carry Out 12,
// PickUp 4, Dine In 0, Cancelado 6, Retornado 1 - que somam 69, e o relatório
// dizia Total 64. A conta não fechava, e ninguém fazia a conta.
//
// A divisão de trabalho aqui é de propósito: o MODELO transcreve o quadro
// (ler layout é o que ele faz bem) e o SERVIDOR soma (aritmética é onde ele
// erra). Somar aqui não custa chamada nenhuma e não depende de o Master
// cadastrar o que soma com o quê - o quadro impresso já diz.
//
// A soma usa os valores TRANSCRITOS, inclusive de parcela que não é campo
// cadastrado: senão um quadro com uma linha a mais nunca fecharia e o aviso
// viraria ruído permanente.
const TOLERANCIA_SOMA = 0.011; // centavo de arredondamento, não erro de leitura

function conferirSomas(conferencias) {
  const blocos = [];
  (Array.isArray(conferencias) ? conferencias : []).slice(0, 6).forEach((c) => {
    const total = numeroOuNull(c && c.totalValor);
    const partes = (Array.isArray(c && c.partes) ? c.partes : [])
      .map((p) => ({
        chave: p && p.chave ? String(p.chave) : null,
        valor: numeroOuNull(p && p.valor),
        textoOrigem: p && p.textoOrigem ? String(p.textoOrigem).slice(0, 60) : null,
      }))
      .filter((p) => p.valor != null);
    // quadro sem total ou com uma parcela só não prova nada
    if (total == null || partes.length < 2) return;
    const soma = partes.reduce((t, p) => t + p.valor, 0);
    if (Math.abs(soma - total) <= TOLERANCIA_SOMA) return;
    blocos.push({
      titulo: c && c.titulo ? String(c.titulo).slice(0, 60) : 'quadro do relatório',
      total, soma: Math.round(soma * 100) / 100,
      chaves: partes.map((p) => p.chave).filter(Boolean),
      partes,
    });
  });
  return blocos;
}

const numeroOuNull = (v) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);
// pro KPI "texto livre" - aceita a string exatamente como o modelo devolveu
// (pode ser um numero decimal que nao serve pro tipo "Tempo" da tela, ex:
// "2,05" minutos), sem forcar conversao numerica
const textoOuNull = (v) => { const s = String(v == null ? '' : v).trim().slice(0, 200); return s || null; };

// ------------------------------------------------- consenso de 2 leituras
//
// Regra unica: um valor so entra sozinho no formulario se as DUAS leituras o
// trouxeram como item confiavel, com o MESMO valor. Qualquer outra situacao
// (divergiu, so apareceu numa, uma das duas marcou suspeito) vira suspeito,
// com o motivo dito em portugues - o campo fica liberado e quem lanca decide
// olhando o relatorio. Concordancia por acaso existe, mas exige as duas
// leituras errarem IGUAL; o deslocamento de linha que motivou isto e
// instavel justamente por natureza, entao errar igual duas vezes e raro.
const chaveDoItem = (x) => `${x.secao}.${x.campo}`;
const valoresIguais = (a, b) => (
  typeof a === 'string' || typeof b === 'string'
    ? String(a).trim() === String(b).trim()
    : Number(a) === Number(b)
);

function reconciliarLeituras(a, b) {
  const iA = new Map((a.itens || []).map((x) => [chaveDoItem(x), x]));
  const iB = new Map((b.itens || []).map((x) => [chaveDoItem(x), x]));
  const itens = [];
  const suspeitos = [];
  const decididos = new Set();

  for (const [k, xa] of iA) {
    const xb = iB.get(k);
    if (xb && valoresIguais(xa.valor, xb.valor)) {
      itens.push(xa);
    } else if (xb) {
      // `candidatos` guarda os valores em disputa como DADO - e o que permite
      // o desempate decidir por maioria sem interpretar texto de motivo
      suspeitos.push({ ...xa, candidatos: [xa.valor, xb.valor], motivo: `li duas vezes e os valores não bateram (1ª leitura: ${xa.valor} · 2ª: ${xb.valor})` });
    } else {
      suspeitos.push({ ...xa, candidatos: [xa.valor], motivo: `só apareceu numa das duas leituras (valor lido: ${xa.valor})` });
    }
    decididos.add(k);
  }
  for (const [k, xb] of iB) {
    if (decididos.has(k)) continue;
    suspeitos.push({ ...xb, candidatos: [xb.valor], motivo: `só apareceu numa das duas leituras (valor lido: ${xb.valor})` });
    decididos.add(k);
  }
  // suspeito de QUALQUER uma das leituras continua suspeito - inclusive se a
  // outra trouxe o campo como item: uma leitura desconfiar ja basta
  [...(a.suspeitos || []), ...(b.suspeitos || [])].forEach((sp) => {
    const k = chaveDoItem(sp);
    const idx = itens.findIndex((x) => chaveDoItem(x) === k);
    if (idx >= 0) {
      suspeitos.push({ ...itens[idx], motivo: sp.motivo || 'uma das leituras marcou este campo como suspeito' });
      itens.splice(idx, 1);
      return;
    }
    if (!decididos.has(k)) { suspeitos.push(sp); decididos.add(k); }
  });

  // universo de campos = particao de qualquer leitura individual
  const defs = new Map();
  [...(a.itens || []), ...(a.suspeitos || []), ...(a.faltando || [])]
    .forEach((c) => defs.set(chaveDoItem(c), { secao: c.secao, campo: c.campo, label: c.label }));
  const cobertos = new Set([...itens, ...suspeitos].map(chaveDoItem));
  const faltando = [...defs.values()].filter((c) => !cobertos.has(chaveDoItem(c)));

  const somasRuins = [];
  [...(a.somasRuins || []), ...(b.somasRuins || [])].forEach((sr) => {
    if (!somasRuins.some((x) => x.titulo === sr.titulo && x.total === sr.total && x.soma === sr.soma)) somasRuins.push(sr);
  });
  const naoIdentificados = [];
  [...(a.naoIdentificados || []), ...(b.naoIdentificados || [])].forEach((n) => {
    if (!naoIdentificados.some((x) => x.textoOrigem === n.textoOrigem)) naoIdentificados.push(n);
  });

  return {
    data: a.data === b.data ? a.data : null,
    itens, suspeitos, somasRuins, naoIdentificados, faltando,
  };
}

// ------------------------------------------------------------- desempate
//
// Terceira leitura, com modelo mais forte, SOBRE os campos em que as duas
// primeiras discordaram. Melhor de 3: o valor do desempate so vence se
// coincidir com um dos candidatos (2 votos em 3). Um TERCEIRO valor
// diferente nao decide nada - tres leituras, tres numeros, e o campo fica
// pra pessoa, com os tres a mostra.
//
// Suspeito SEM candidatos nao entra aqui de proposito: ele foi recusado por
// uma regra deterministica (rotulo nao bate com a linha, taxa em campo de
// quantidade, soma que nao fecha) - maioria de leituras nao revoga regra.
function desempatar(consenso, leituraDesempate) {
  const cItens = new Map((leituraDesempate.itens || []).map((x) => [chaveDoItem(x), x]));
  const itens = [...consenso.itens];
  const suspeitos = [];
  (consenso.suspeitos || []).forEach((sp) => {
    if (!Array.isArray(sp.candidatos)) { suspeitos.push(sp); return; }
    const c = cItens.get(chaveDoItem(sp));
    if (c && sp.candidatos.some((v) => valoresIguais(v, c.valor))) {
      // 2 de 3 concordam: entra com o valor vencedor
      const { candidatos, motivo, ...base } = sp;
      itens.push({ ...base, valor: c.valor, textoOrigem: c.textoOrigem || sp.textoOrigem });
      return;
    }
    suspeitos.push({
      ...sp,
      motivo: c
        ? `${sp.motivo} · a 3ª leitura (desempate) trouxe um TERCEIRO valor (${c.valor}) - três leituras, três números`
        : `${sp.motivo} · a 3ª leitura (desempate) também não deu certeza`,
    });
  });
  return { ...consenso, itens, suspeitos };
}

const MAX_ARQUIVOS = 5;

async function lerCanais({ arquivos, canais, formas, kpis, dica, unidade, usuarioId, usuarioEmail }) {
  if (!ativo()) throw new Error('Leitura automática por imagem não está configurada neste servidor.');
  const fotos = (Array.isArray(arquivos) ? arquivos : []).filter((a) => a && a.buffer);
  if (!fotos.length) throw new Error('Anexe a foto do relatório de vendas.');
  if (fotos.length > MAX_ARQUIVOS) throw new Error(`Envie no máximo ${MAX_ARQUIVOS} fotos por leitura.`);
  const listaCanais = (Array.isArray(canais) ? canais : []).map((c) => ({ ...c, secao: 'canal' }));
  const listaFormas = (Array.isArray(formas) ? formas : []).map((c) => ({ ...c, secao: 'forma' }));
  // so os KPI's numericos (quantidade/moeda/kg) chegam aqui - tempo/texto/
  // arquivo ja saem filtrados de index.js, antes de chamar essa funcao
  const listaKpis = (Array.isArray(kpis) ? kpis : []).map((c) => ({ ...c, secao: 'kpi' }));
  const todos = [...listaCanais, ...listaFormas, ...listaKpis];
  if (!todos.length) {
    throw new Error('Essa loja ainda não tem Canais de venda, Formas de pagamento nem KPI\'s cadastrados - peça pro Master configurar em Grupos.');
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
  blocos.push({ type: 'text', text: montarPrompt(listaCanais, listaFormas, listaKpis, dica, fotos.length) });

  // Uma passada completa: chamada, parse e as conferencias. Fica numa funcao
  // porque a leitura roda DUAS vezes (ver o consenso no fim de lerCanais).
  async function umaLeitura(modelo = MODELO) {
  // .stream() em vez de .create(): com max_tokens alto o SDK RECUSA a chamada
  // sem streaming ("Streaming is required for operations that may take longer
  // than 10 minutes") - uma resposta desse tamanho poderia demorar mais que
  // uma conexao HTTP parada aguenta. O streaming entrega em pedacos e o
  // finalMessage() remonta: mesmo objeto de resposta, mesmo custo, so muda o
  // transporte. Nada abaixo desta chamada percebe a diferenca.
  const resp = await getCliente().messages.stream({
    model: modelo,
    // relatorio com muito KPI cadastrado (Service Times Summary do PDV da
    // Domino's, por exemplo, passa de 15 metricas) gera um JSON grande - com
    // textoOrigem de cada campo, o array de "campos" sozinho ja pode passar
    // de 4000 tokens e cortar a resposta no meio (stop_reason:'max_tokens'),
    // o que quebra o JSON.parse do mesmo jeito que foto ruim quebraria, mas
    // por um motivo que reenviar a MESMA foto nunca resolve
    // Teto de RESPOSTA, nao de custo: so se paga pelo que o modelo de fato
    // escreve, entao um teto alto com resposta curta custa exatamente igual.
    // 8000 parecia folgado ate a resposta ganhar o textoOrigem de cada campo
    // e a transcricao dos quadros de conferencia ("conferencias") - com 5
    // fotos do fechamento completo (cartao, resumo de pedidos, service
    // times, taxa...) o JSON estourava o teto e a loja via "campos demais
    // pra processar" num relatorio de tamanho normal, sendo mandada fazer
    // leituras separadas por um limite NOSSO, nao do relatorio dela.
    max_tokens: 32000,
    messages: [{ role: 'user', content: blocos }],
  }).finalMessage();
  // medicao: o custo desta tela nasce aqui, e sao 2 chamadas por clique (3
  // com desempate). Registrar por CHAMADA, nao por clique, e' o que deixa
  // ver que o desempate no modelo forte pesa mais que as duas leituras.
  try {
    ocrUso.registrarChamada({
      fluxo: modelo === MODELO_DESEMPATE ? 'fechamento-desempate' : 'fechamento',
      modelo, usage: resp.usage, unidade, usuarioId, usuarioEmail,
      fotos: fotos.length,
      bytes: fotos.reduce((t, f) => t + (f.buffer ? f.buffer.length : 0), 0),
    });
  } catch (e) { console.error('ocrUso: falha ao registrar (leitura segue). %s', e.message); }
  const texto = (resp.content || []).map((b) => b.text || '').join('');
  let dados;
  try {
    dados = extrairJson(texto);
  } catch (e) {
    // sem o texto bruto no log, erro de formatacao do modelo (numero com
    // virgula, corte por max_tokens) fica impossivel de diagnosticar pela
    // mensagem generica que o gerente ve
    console.error('canaisVendaOcr: falha ao parsear JSON. stop_reason=%s texto=%s', resp.stop_reason, texto.slice(0, 2000));
    // "tire uma foto mais nitida" e um conselho ERRADO quando o problema foi
    // a resposta cortada no meio (relatorio com muitos campos cadastrados) -
    // mandar refazer a MESMA foto nunca resolve isso, so confunde quem usa
    if (resp.stop_reason === 'max_tokens') {
      throw new Error('A resposta da leitura foi cortada no meio mesmo com o limite alto - não é problema da foto, tirar de novo não resolve. Faça em LEITURAS SEPARADAS: clique em "Preencher por foto" de novo pra cada parte (ex: uma leitura só com a foto de Canais/Formas, outra leitura só com a foto dos indicadores de tempo) - o que uma leitura já preencheu não se perde na próxima.');
    }
    throw new Error('Não consegui entender essa imagem. Tente uma foto mais nítida, com o relatório inteiro enquadrado.');
  }
  if (dados.erro) throw new Error(String(dados.erro).slice(0, 200));

  // so aceita chave que existe MESMO no grupo: o modelo pode devolver uma
  // chave inventada ou de outra loja, e ai o valor entraria num campo que
  // a tela nem mostra - sumindo silenciosamente do fechamento
  const porChave = new Map(todos.map((c) => [chaveDe(c.secao, c.campo), c]));
  const vistos = new Set();
  const itens = [];
  const suspeitos = [];
  (Array.isArray(dados.campos) ? dados.campos : []).forEach((c) => {
    const chave = String((c && c.chave) || '');
    const def = porChave.get(chave);
    if (!def) return;
    // KPI "texto livre" aceita a resposta como string (ex: "2,05") - os
    // outros (canal/forma/kpi numerico) continuam exigindo numero de verdade
    const valor = (def.secao === 'kpi' && def.tipo === 'texto') ? textoOuNull(c && c.valor) : numeroOuNull(c && c.valor);
    if (valor == null || vistos.has(chave)) return;
    vistos.add(chave);
    const textoOrigem = c.textoOrigem ? String(c.textoOrigem).slice(0, 80) : null;
    const item = { secao: def.secao, campo: def.campo, label: def.label, valor, textoOrigem };
    // valor cuja linha de origem não menciona o campo: NÃO preenche sozinho.
    // Um campo vazio quem lança preenche olhando a foto; um valor errado só
    // é notado por quem conferir tudo de novo - e o fechamento do dia já foi.
    const confiavel = rotuloBateComOrigem(def.label, textoOrigem)
      && !valorDeTaxaEmCampoDeContagem(def.label, textoOrigem);
    if (confiavel) itens.push(item);
    else suspeitos.push(item);
  });

  // quadro cuja soma não bate com o total impresso: TODO campo dele vira
  // suspeito, mesmo o que passou na conferência de rótulo. Quando a conta não
  // fecha não dá pra dizer QUAL parcela está errada - só que uma está, e
  // preencher as outras seria fingir precisão que a leitura não tem.
  const somasRuins = conferirSomas(dados.conferencias);
  if (somasRuins.length) {
    const suspeitas = new Set();
    somasRuins.forEach((b) => b.chaves.forEach((k) => suspeitas.add(k)));
    for (let i = itens.length - 1; i >= 0; i -= 1) {
      if (suspeitas.has(chaveDe(itens[i].secao, itens[i].campo))) suspeitos.push(...itens.splice(i, 1));
    }
  }

  const naoIdentificados = (Array.isArray(dados.naoIdentificados) ? dados.naoIdentificados : [])
    .map((n) => ({ textoOrigem: String((n && n.textoOrigem) || '').slice(0, 80), valor: numeroOuNull(n && n.valor) }))
    .filter((n) => n.textoOrigem && n.valor != null);

  return {
    data: /^\d{4}-\d{2}-\d{2}$/.test(dados.data) ? dados.data : null,
    itens,
    // leitura recusada pela conferência: a tela mostra campo x linha de
    // origem e deixa quem lança digitar, em vez de preencher errado calado
    suspeitos,
    // quadros do relatório em que a soma das parcelas não fechou com o total
    // impresso - a tela mostra a conta, que é a explicação mais curta possível
    somasRuins,
    naoIdentificados,
    // campos que a loja tem mas nao apareceram na imagem: a tela avisa quais
    // continuam pra preencher na mao, em vez de deixar o gerente descobrir
    // no erro de fechamento
    faltando: todos
      .filter((c) => !vistos.has(chaveDe(c.secao, c.campo)))
      .map((c) => ({ secao: c.secao, campo: c.campo, label: c.label })),
  };
  }

  // LEITURA DUPLA. O caso que forcou isso: o Service Times Summary foi lido
  // com tudo deslocado uma linha (Leg Time recebeu o valor do Run Time, Tempo
  // de Espera o do Leg Time...) e NENHUMA das outras travas alcancou - o
  // quadro nao imprime total (a soma nao confere nada) e o modelo escreveu
  // textoOrigem coerente com o proprio erro (o rotulo confere e passa). So
  // que reler a mesma foto dava outro resultado: o desalinhamento nao e
  // estavel, e essa instabilidade e um sinal que da pra medir. Duas leituras
  // independentes em PARALELO (a latencia nao dobra); so entra sozinho no
  // formulario o valor em que as DUAS concordaram - o resto fica liberado
  // pra digitar, com as duas leituras a mostra. Custa duas chamadas por
  // clique, de proposito: um numero errado num KPI que a rede cobra vale
  // mais caro que a segunda chamada.
  const [ra, rb] = await Promise.allSettled([umaLeitura(), umaLeitura()]);
  if (ra.status === 'rejected' && rb.status === 'rejected') throw ra.reason;
  // uma das duas falhou (rede, corte...): a que sobrou vale sozinha - sem
  // consenso, mas melhor que jogar fora uma leitura boa por azar da outra
  if (ra.status === 'rejected') return rb.value;
  if (rb.status === 'rejected') return ra.value;
  const consenso = reconciliarLeituras(ra.value, rb.value);
  // desempate SO quando houve divergencia de consenso (campo com candidatos):
  // o dia em que as duas leituras batem nao paga a terceira chamada
  const pendentes = (consenso.suspeitos || []).filter((sp) => Array.isArray(sp.candidatos));
  if (!pendentes.length) return consenso;
  try {
    return desempatar(consenso, await umaLeitura(MODELO_DESEMPATE));
  } catch (e) {
    // desempate falhou (rede, corte): o consenso ja e um resultado seguro -
    // os divergentes ficam liberados pra digitar, como estavam
    console.error('canaisVendaOcr: desempate falhou, mantendo o consenso. %s', e.message);
    return consenso;
  }
}

module.exports = { ativo, lerCanais, extrairJson, rotuloBateComOrigem, normalizarTexto, conferirSomas, valorDeTaxaEmCampoDeContagem, reconciliarLeituras, desempatar };
