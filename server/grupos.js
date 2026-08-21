// grupos.js
// Cada franquia/rede lança fechamento de um jeito diferente. Essa coleção
// deixa o Master montar, por grupo, campos extras em três frentes do
// fechamento - Canais de venda (somam no Faturamento), Formas de pagamento
// (somam no Total Declarado) e KPI's (não somam em nada, só informativos) -
// sem precisar de código novo a cada franquia diferente. Os campos fixos de
// cada seção (Delivery/Carryout/... e Adyen/Ifood/... e TC/Cancelados)
// continuam os mesmos pra todo mundo; os extras daqui são um acréscimo por
// cima, nunca uma substituição (ver recomputarTotais em fechamentosLive.js).
const db = require('./firestore');
const { createCache } = require('./liveCache');

const COLLECTION = db.collection('grupos');

// vira um identificador estavel (campo) a partir do nome digitado (label) -
// ex "Taxa de entrega" -> "taxaDeEntrega". Assim o Master só digita o nome
// bonito e a gente cuida da chave usada pra gravar o valor.
function slugify(s) {
  const limpo = String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim();
  if (!limpo) return '';
  // JA e um campo (saiu de um slugify anterior): devolve intacto. Sem isto a
  // funcao nao e idempotente - ela baixa a PRIMEIRA PALAVRA inteira, entao
  // "TEF Credito" -> "tefCredito" -> "tefcredito" -> ... A cada regravacao do
  // grupo mandando de volta o campo que ele mesmo tinha lido, a chave mudava
  // e os valores ja gravados naquele campo viravam orfaos.
  if (/^[a-z][a-zA-Z0-9]*$/.test(limpo)) return limpo;
  return limpo
    .split(' ')
    .map((palavra, i) => (i === 0 ? palavra.toLowerCase() : palavra.charAt(0).toUpperCase() + palavra.slice(1).toLowerCase()))
    .join('');
}

// unidades de medida de um KPI extra - so faz sentido pra kpisExtras (Canais
// de venda/Formas de pagamento sempre somam em R$, entao nem mostram esse
// seletor em grupos.html). "quantidade" e o padrao pra KPI sem tipo definido
// (grupo criado antes dessa feature). "tempo" guarda o valor em SEGUNDOS
// (o Master digita min:seg em grupos.html/lancamento.html, ja convertido
// antes de chegar aqui - ver sanitizarMapaExtras em fechamentosLive.js).
const TIPOS_KPI_VALIDOS = new Set(['quantidade', 'moeda', 'kg', 'tempo', 'arquivo', 'texto']);

// pra ONDE um KPI extra soma, alem de so ficar registrado - "nao" (padrao,
// mesmo comportamento de sempre: so capta o dado, nunca some em nada) ou um
// dos totais do fechamento. So faz sentido pra KPI tipo "moeda" (somar
// Quantidade/Kg/Tempo/Texto num total em R$ corromperia o valor) - quem
// aplica essa regra de fato e recomputarTotais em fechamentosLive.js; aqui
// so valida o valor gravado.
const SOMA_EM_VALIDAS = new Set(['nao', 'faturamento', 'totalDeclarado']);

// sinal de um campo extra (soma no proprio total, ou subtrai dele) - so faz
// sentido pra canaisVendaExtras/formasPagamentoExtras (kpisExtras nao soma
// em nada). "tambemNoOutroTotal": alem do proprio total, o valor tambem
// conta no total "cruzado" - um Canal com isso marcado tambem soma no Total
// Declarado, e uma Forma de pagamento tambem soma no Faturamento. Existe
// pra casos como TEF: e um Canal de venda, mas ja e forma de pagamento
// validada, entao precisa contar nos dois (senao sobra "falta no caixa" -
// o valor apareceria no Faturamento mas nunca no Total Declarado). Ver
// recomputarTotais em fechamentosLive.js, que e quem realmente aplica isso.
const OPERACOES_VALIDAS = new Set(['soma', 'subtrai']);

// pra que lado esse KPI é RUIM. Sem isso, "indicador mais ofensivo" não
// tem como ser calculado: cancelamento alto é problema, OTD alto é ótimo, e
// o sistema não tem como adivinhar qual é qual pelo nome. 'neutro' (padrão,
// e o que todo KPI já cadastrado tem) significa "não sei a direção" - aí o
// ranking de ofensores cai pra um critério que não depende dela: qual loja
// está mais longe da mediana do grupo.
const DIRECOES_VALIDAS = new Set(['neutro', 'maior-melhor', 'menor-melhor']);

// usado pras 3 listas de campos extras (kpisExtras, canaisVendaExtras,
// formasPagamentoExtras) - mesmo formato, mesma validacao. "tipo" so e
// gravado quando informado (canais/formas nunca mandam, entao continuam sem
// esse campo no documento); "operacao"/"tambemNoOutroTotal" so fazem
// sentido pra canais/formas (kpis nao mandam, entao tambem ficam de fora).
// "somaEm" so faz sentido pra kpis tipo "moeda" - qualquer outro tipo (ou
// ausencia de tipo) forca 'nao', mesmo que o cliente mande outra coisa
// (defesa em profundidade - a UI em grupos.html ja desabilita esse seletor
// pra tipo != moeda, mas o backend nao pode confiar so nisso).
function sanitizarCamposExtras(lista) {
  if (!Array.isArray(lista)) return [];
  const usados = new Set();
  return lista
    .map((k) => {
      const label = String(k?.label || '').trim().slice(0, 60);
      if (!label) return null;
      let campo = slugify(k?.campo) || slugify(label);
      if (!campo) return null;
      let base = campo;
      let n = 2;
      while (usados.has(campo)) { campo = base + n; n += 1; }
      usados.add(campo);
      const item = { campo, label };
      if (k?.tipo != null) item.tipo = TIPOS_KPI_VALIDOS.has(k.tipo) ? k.tipo : 'quantidade';
      if (k?.direcao != null) item.direcao = DIRECOES_VALIDAS.has(k.direcao) ? k.direcao : 'neutro';
      if (k?.operacao != null) item.operacao = OPERACOES_VALIDAS.has(k.operacao) ? k.operacao : 'soma';
      if (k?.tambemNoOutroTotal != null) item.tambemNoOutroTotal = !!k.tambemNoOutroTotal;
      // campo que NAO sai no relatorio do PDV (Pix CNPJ, Outros...): mesmo na
      // loja que lanca por foto, continua digitado na mao. Sem essa marca ele
      // ficaria travado e vazio pra sempre - e ainda entraria na lista mandada
      // pro modelo, convidando a inventar um valor pra ele.
      if (k?.manual != null) item.manual = !!k.manual;
      if (k?.somaEm != null) {
        const valido = SOMA_EM_VALIDAS.has(k.somaEm) ? k.somaEm : 'nao';
        item.somaEm = item.tipo === 'moeda' ? valido : 'nao';
      }
      return item;
    })
    .filter(Boolean)
    .slice(0, 40);
}

// Dica de leitura do relatorio do PDV, usada no prompt do canaisVendaOcr.
// Existe porque cada PDV imprime de um jeito e as regras que so quem opera
// sabe ("o Delivery e o SEGUNDO numero da linha; o primeiro e sempre zero e
// nao vale") nao cabem num codigo generico - se cada bandeira precisasse de
// um `if` aqui, o modulo viraria uma colcha de retalhos e cada loja nova
// exigiria deploy. Texto livre, curto de proposito: e instrucao pontual, nao
// manual.
function sanitizarDicaLeitura(s) {
  return String(s || '').trim().slice(0, 600);
}

// nome padrao das maquininhas (ex: "Maquininha 1", "Maquininha 2"...) -
// franquia que usa uma maquinha especifica pode trocar o prefixo (ex:
// "Getnet" -> "Getnet 1", "Getnet 2"...), ver lancamento.html
function sanitizarPrefixo(s) {
  const limpo = String(s || '').trim().slice(0, 30);
  return limpo || 'Maquininha';
}
function sanitizarPrefixoPos(s) {
  const limpo = String(s || '').trim().slice(0, 30);
  return limpo || 'Maquininha POS';
}

async function listUncached() {
  const snap = await COLLECTION.orderBy('nome', 'asc').get();
  return snap.docs.map((d) => d.data());
}
const gruposCache = createCache(listUncached, 5 * 60 * 1000);
const list = gruposCache.cached;

async function create({ nome, unidades, kpisExtras, canaisVendaExtras, formasPagamentoExtras, responsaveis, caixaHabilitado, maquininhasHabilitado, maquininhaPrefixo, maquininhaPosHabilitado, maquininhaPosPrefixo, saidasHabilitado, lerCanaisPorImagem, dicaLeituraCanais, quebraHabilitada }) {
  const nomeLimpo = String(nome || '').trim();
  if (!nomeLimpo) throw new Error('Informe o nome do grupo.');
  const ref = COLLECTION.doc();
  const registro = {
    id: ref.id,
    nome: nomeLimpo,
    unidades: Array.isArray(unidades) ? unidades.map(String) : [],
    kpisExtras: sanitizarCamposExtras(kpisExtras),
    canaisVendaExtras: sanitizarCamposExtras(canaisVendaExtras),
    formasPagamentoExtras: sanitizarCamposExtras(formasPagamentoExtras),
    // ids dos usuarios Master/Admin responsaveis por esse grupo - usado pra
    // deixar quem lanca uma solicitacao direcionar pra um deles (ver
    // GET /api/grupos/responsaveis em index.js)
    responsaveis: Array.isArray(responsaveis) ? responsaveis.map(String) : [],
    // secoes fixas do lancamento (Caixa/Maquininhas/Outras saidas) que a
    // franquia pode nao usar - todas habilitadas por padrao (comportamento
    // de sempre, pra grupo criado antes dessa feature nao mudar nada)
    // Ler os Canais de venda de uma foto do relatorio do PDV (ver
    // canaisVendaOcr.js). Nasce DESLIGADO, diferente dos toggles acima: o
    // formato do relatorio muda de PDV pra PDV, entao cada loja precisa ser
    // testada antes de confiar no numero que sai da foto.
    lerCanaisPorImagem: lerCanaisPorImagem === true,
    dicaLeituraCanais: sanitizarDicaLeitura(dicaLeituraCanais),
    caixaHabilitado: caixaHabilitado !== false,
    maquininhasHabilitado: maquininhasHabilitado !== false,
    maquininhaPrefixo: sanitizarPrefixo(maquininhaPrefixo),
    // secao extra pra loja que vende depois da meia-noite na maquininha - ao
    // contrario das outras secoes, comeca DESABILITADA (so faz sentido pra
    // quem realmente precisa, ver adyenPos/ajustePosAnterior em
    // fechamentosLive.js)
    maquininhaPosHabilitado: maquininhaPosHabilitado === true,
    maquininhaPosPrefixo: sanitizarPrefixoPos(maquininhaPosPrefixo),
    saidasHabilitado: saidasHabilitado !== false,
    // "Quebra de caixa" e o unico campo fixo do schema antigo (planilha
    // importada) que uma franquia pode querer desligar de vez - nasce
    // habilitado (comportamento de sempre) pra nao mudar nada em grupo ja
    // existente. Desligado: some da tela/relatorio E do modal de edicao do
    // Master (ver fechamentos.html), nao so escondido por preferencia
    // pessoal como o seletor 🧩 Colunas
    quebraHabilitada: quebraHabilitada !== false,
    criadoEm: new Date().toISOString(),
  };
  await ref.set(registro);
  gruposCache.invalidar();
  return registro;
}

async function update(id, { nome, unidades, kpisExtras, canaisVendaExtras, formasPagamentoExtras, responsaveis, caixaHabilitado, maquininhasHabilitado, maquininhaPrefixo, maquininhaPosHabilitado, maquininhaPosPrefixo, saidasHabilitado, lerCanaisPorImagem, dicaLeituraCanais, quebraHabilitada }) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Grupo não encontrado.');
  const patch = {};
  if (nome != null) {
    const nomeLimpo = String(nome).trim();
    if (!nomeLimpo) throw new Error('Informe o nome do grupo.');
    patch.nome = nomeLimpo;
  }
  if (unidades != null) patch.unidades = Array.isArray(unidades) ? unidades.map(String) : [];
  if (kpisExtras != null) patch.kpisExtras = sanitizarCamposExtras(kpisExtras);
  if (canaisVendaExtras != null) patch.canaisVendaExtras = sanitizarCamposExtras(canaisVendaExtras);
  if (formasPagamentoExtras != null) patch.formasPagamentoExtras = sanitizarCamposExtras(formasPagamentoExtras);
  if (responsaveis != null) patch.responsaveis = Array.isArray(responsaveis) ? responsaveis.map(String) : [];
  if (lerCanaisPorImagem != null) patch.lerCanaisPorImagem = lerCanaisPorImagem === true;
  if (dicaLeituraCanais != null) patch.dicaLeituraCanais = sanitizarDicaLeitura(dicaLeituraCanais);
  if (caixaHabilitado != null) patch.caixaHabilitado = caixaHabilitado !== false;
  if (maquininhasHabilitado != null) patch.maquininhasHabilitado = maquininhasHabilitado !== false;
  if (maquininhaPrefixo != null) patch.maquininhaPrefixo = sanitizarPrefixo(maquininhaPrefixo);
  if (maquininhaPosHabilitado != null) patch.maquininhaPosHabilitado = maquininhaPosHabilitado === true;
  if (maquininhaPosPrefixo != null) patch.maquininhaPosPrefixo = sanitizarPrefixoPos(maquininhaPosPrefixo);
  if (saidasHabilitado != null) patch.saidasHabilitado = saidasHabilitado !== false;
  if (quebraHabilitada != null) patch.quebraHabilitada = quebraHabilitada !== false;
  await ref.update(patch);
  gruposCache.invalidar();
  return { ...snap.data(), ...patch };
}

async function remove(id) {
  await COLLECTION.doc(id).delete();
  gruposCache.invalidar();
}

// acha o grupo (com os kpisExtras dele) de uma unidade especifica - usado
// pelo formulario de fechamento pra saber quais campos extras mostrar. Uma
// unidade sem grupo cadastrado simplesmente nao tem KPI extra nenhum (so os
// campos fixos TC/Cancelados).
async function grupoDaUnidade(unidade) {
  const grupos = await list();
  return grupos.find((g) => (g.unidades || []).includes(unidade)) || null;
}

// bootstrap idempotente (chamado no boot, ver index.js): garante que a
// unidade 'Saltiverso Patteo' tem um grupo cadastrado com as 4 formas de
// pagamento do balcao (maquininha/dinheiro/pix/outros, mesmos BUCKETS de
// saltiversoFechamento.js). Sem isso o fechamento do Saltiverso caia no
// bloco "Sem grupo definido" da tabela de Fechamentos, com as colunas
// erradas (Adyen/Ifood/99Food - que nao existem pra ele) e nunca aparecia
// separado por rede (GBE). So cria se NENHUM grupo ja cobre essa unidade -
// o Master continua livre pra editar/renomear depois em /grupos.html, isso
// so garante que ela nao nasce sem grupo nenhum.
async function ensureGrupoSaltiverso() {
  const todos = await list();
  if (todos.some((g) => (g.unidades || []).includes('Saltiverso Patteo'))) return;
  await create({
    nome: 'Saltiverso Patteo',
    unidades: ['Saltiverso Patteo'],
    formasPagamentoExtras: [
      { label: 'Maquininha' }, { label: 'Dinheiro' }, { label: 'Pix' }, { label: 'Outros' },
    ],
    // Saltiverso nao conta caixa fisico nem tem maquininha Adyen integrada
    // (ver saltiversoFechamento.js) - as secoes fixas de sempre nao se
    // aplicam, so os 4 baldes acima
    caixaHabilitado: false,
    maquininhasHabilitado: false,
    saidasHabilitado: false,
  });
}

// slugify sai daqui pro importador do Grupo Bravo (bravoImport.js) gerar
// EXATAMENTE o mesmo 'campo' que este cadastro geraria pro mesmo label -
// se as duas pontas divergirem, o valor importado nao casa com a definicao
// do grupo e some da tela
// invalidarCache exportado pro teste conseguir trocar os grupos em memoria
// entre as conferencias (o cache e de 5 min - sem isto o teste media sempre
// o mesmo estado e passava sem provar nada)
module.exports = { list, create, update, remove, grupoDaUnidade, ensureGrupoSaltiverso, slugify, invalidarCache: gruposCache.invalidar };
