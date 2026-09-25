// qualidade.js
//
// VISITA TÉCNICA DE QUALIDADE (BPF) - o checklist que a nutricionista
// preenche ANDANDO pela loja, do celular, de pé, com uma mão.
//
// De onde saiu: das planilhas reais de visita (Dominos Natal 06/08 e Spoleto
// Natal 07/08) e do relatório do São Braz. Os 6 setores e os 38 itens abaixo
// são transcrição daquelas planilhas - não é um checklist que eu inventei.
//
// A NOTA foi conferida contra os dois arquivos, e é só isto:
//   nota = conformes / total de itens do modelo x 10
// Dominos: 28/38 x 10 = 7,36 (a planilha diz 7.36). Spoleto: 29/38 x 10 =
// 7,63 (a planilha diz 7.63). Bate exato nos dois - por isso a conta está
// aqui e não num campo digitado à mão.
//
// O QUE NÃO ENTRA NA NOTA, de propósito: as especificações que ela adiciona
// dentro de um item, e os pontos de check que ela acrescenta no fim de um
// setor. Os dois viram APONTAMENTO no relatório, com foto e ação corretiva,
// mas não mexem no número. Motivo: a nota existe pra comparar loja com loja
// e visita com visita. Se cada observação a mais mudasse o denominador, a
// visita mais atenta daria a nota pior - e duas lojas nunca seriam
// comparáveis. (Master: se preferir que contem, é uma linha aqui.)
//
// CUSTO (CLAUDE.md §3): UM documento por visita, com todas as respostas
// dentro. A lista usa createCache e resumo, nunca o documento inteiro. FOTO
// NUNCA vai pro Firestore - vai pro Storage (ver storage.js) e no documento
// fica só o caminho.
// ---------------------------------------------------------------------
// ARQUITETURA - o que auditoria de verdade pratica, e por que.
//
// 1. MODELO VERSIONADO, E A VISITA GUARDA O RETRATO DELE.
//    Toda visita grava, dentro dela, o modelo que respondeu (`modeloSnap`).
//    Sem isso, corrigir o texto de um item hoje reescreveria em silêncio o
//    que a loja respondeu em agosto - e a regra da casa é que o histórico
//    continue legível exatamente como estava (CLAUDE.md §1). É também o que
//    todo software de auditoria faz: o laudo vale contra a versão do
//    roteiro usada no dia.
//
// 2. CRITICIDADE DO ITEM (ANVISA RDC 275/2002: IMPRESCINDÍVEL, NECESSÁRIO,
//    RECOMENDÁVEL). Um checklist plano trata "funcionário sem touca" igual a
//    "produto vencido na prateleira", e nenhum auditor aceita isso. A
//    estrutura carrega a criticidade de cada item, MAS o peso vem desligado:
//    `pesos: false` faz a conta ficar idêntica à planilha de hoje (7,36 é
//    7,36). Ligar é decisão do Master - e muda nota de loja, por isso não
//    ligo sozinho.
//
// 3. CAPA (ação corretiva e preventiva). O "AÇÃO CORRETIVA / ESPAÇO CLIENTE
//    / CORRIGIDO SIM-NÃO" da planilha já é um ciclo CAPA feito no papel. Aqui
//    ele ganha o que falta pra fechar: responsável, prazo e verificação na
//    visita seguinte. Apontamento sem dono e sem data não vira conserto.
//
// 4. VISITA CONCLUÍDA É IMUTÁVEL. Depois de fechada e assinada, não se
//    edita: o que muda é o ciclo da ação corretiva. Laudo que pode ser
//    reescrito depois não serve de laudo.
//
// 5. A VISITA SEGUINTE ENXERGA A ANTERIOR (`visitaAnteriorId`), que é como a
//    verificação de eficácia acontece de verdade - a pessoa chega na loja
//    já sabendo o que ficou pendente da última vez.
const crypto = require('crypto');
const db = require('./firestore');
const { createCache } = require('./liveCache');

const COLLECTION = db.collection('qualidadeVisitas');
const MODELOS = db.collection('qualidadeModelos');

// ---------------------------------------------------------------------
// CRITICIDADE - vocabulário da RDC 275/2002 da ANVISA, não inventado aqui.
// O peso só é usado quando o modelo liga `pesos`; desligado, todo item vale
// 1 e a nota sai idêntica à da planilha.
const CRITICIDADES = ['imprescindivel', 'necessario', 'recomendavel'];
const CRITICIDADE_LABEL = {
  imprescindivel: 'Imprescindível',
  necessario: 'Necessário',
  recomendavel: 'Recomendável',
};
const PESO_POR_CRITICIDADE = { imprescindivel: 3, necessario: 2, recomendavel: 1 };
function pesoDoItem(item, comPesos) {
  if (!comPesos) return 1;
  return PESO_POR_CRITICIDADE[item && item.criticidade] || 1;
}

// ---------------------------------------------------------------------
// VOCABULÁRIO (CLAUDE.md §5) - as duas respostas são as da planilha, e não
// há uma terceira. "Não se aplica" ficou de fora de propósito: ela mudaria
// o denominador da nota, e nenhuma das visitas enviadas usa isso.
const RESPOSTAS = ['conforme', 'nao-conforme', 'nao-aplica'];
const RESPOSTA_LABEL = { conforme: 'CONFORME', 'nao-conforme': 'NÃO CONFORME', 'nao-aplica': 'NÃO SE APLICA' };
// a visita nasce aberta e só fecha quando ela termina de andar pela loja
const STATUS = ['EM_ANDAMENTO', 'CONCLUIDA'];

// FAIXAS (decisão do Master, 23/09/2026). As cores são as da planilha
// (verde 92D050, amarelo FFFF00, vermelho FF0000); os números não estavam
// em lugar nenhum do arquivo e vieram dele.
const FAIXA_POSITIVA_MIN = 7;
const FAIXA_ATENCAO_MIN = 5;
function faixaDaNota(nota) {
  if (nota === null || nota === undefined) return null;
  if (nota >= FAIXA_POSITIVA_MIN) return 'positiva';
  if (nota >= FAIXA_ATENCAO_MIN) return 'atencao';
  return 'negativa';
}
const FAIXA_LABEL = { positiva: 'Pontuação positiva', atencao: 'Pontuação de atenção', negativa: 'Pontuação negativa' };

// ---------------------------------------------------------------------
// O MODELO PADRÃO.
//
// `id` de setor e de item NUNCA muda (mesma regra do CLAUDE.md §1): é ele
// que amarra a resposta gravada numa visita de agosto ao item de hoje. O
// TEXTO ao lado pode ser corrigido à vontade - inclusive os erros de
// digitação que vieram da planilha - que o histórico continua legível.
const MODELO_PADRAO = {
  id: 'padrao',
  nome: 'Modelo aberto padrão',
  tipo: 'aberto',
  marca: null,
  bloqueado: false,
  setores: [
    {
      id: 'higiene-manipuladores',
      nome: 'Higiene e Saúde dos Manipuladores',
      itens: [
        { id: 'uniforme-completo', texto: 'Funcionários usam uniforme completo, limpo e de cor clara.' },
        { id: 'touca-cabelos', texto: 'Uso correto de rede ou touca prendendo todos os cabelos.' },
        { id: 'unhas', texto: 'Unhas curtas, limpas, sem esmalte ou base.' },
        { id: 'adornos', texto: 'Ausência de adornos (alianças, anéis, brincos, relógios).' },
        { id: 'higienizacao-maos', texto: 'Higienização correta e frequente das mãos.' },
        { id: 'sem-sintomas', texto: 'Funcionários sem sintomas de doenças (tosse, diarreia, feridas expostas).' },
      ],
    },
    {
      id: 'estrutura-fisica',
      nome: 'Estrutura Física e Instalações',
      itens: [
        { id: 'pisos-paredes-tetos', texto: 'Pisos, paredes e tetos íntegros, lisos e fáceis de limpar.' },
        { id: 'iluminacao', texto: 'Iluminação adequada e com proteção contra quebras.' },
        { id: 'ventilacao', texto: 'Ventilação eficiente e livre de fungos ou odores fortes.' },
        { id: 'janelas-teladas', texto: 'Janelas e aberturas teladas para evitar entrada de insetos.' },
        { id: 'pia-exclusiva-maos', texto: 'Pia exclusiva para lavagem de mãos na área de produção, completa.' },
        { id: 'sanitarios-vestiarios', texto: 'Sanitários e vestiários limpos e distantes da área de produção.' },
      ],
    },
    {
      id: 'recebimento-armazenamento',
      nome: 'Recebimento e Armazenamento',
      itens: [
        { id: 'planilha-recebimento', texto: 'Presença de planilha com os recebimentos de mercadorias preenchidas.' },
        { id: 'temperatura-entrega', texto: 'Conferência de temperatura dos alimentos refrigerados/congelados na entrega.' },
        { id: 'estrados-prateleiras', texto: 'Produtos armazenados em estrados ou prateleiras (nunca no chão).' },
        { id: 'identificacao-alimentos', texto: 'Alimentos identificados com nome, data de validade e manipulação.' },
        { id: 'pvps', texto: 'Controle rigoroso do princípio PVPS (Primeiro que Vence, Primeiro a Sair).' },
        { id: 'sem-vencidos', texto: 'Ausência de produtos vencidos, embalagens danificadas ou caixa de papelão.' },
      ],
    },
    {
      id: 'higienizacao-ambientes',
      nome: 'Higienização de Ambientes, Equipamentos e Utensílios',
      itens: [
        { id: 'superficies-contato', texto: 'Superfícies que entram em contato com alimentos em bom estado de conservação.' },
        { id: 'saneantes', texto: 'Produtos saneantes regularizados pelo Ministério da Saúde e identificados.' },
        { id: 'lixeiras-pedal', texto: 'Lixeiras com tampas acionadas por pedal e devidamente ensacadas.' },
        { id: 'controle-pragas', texto: 'Controle de pragas atualizado e realizado por empresa especializada.' },
      ],
    },
    {
      id: 'preparo-alimentos',
      nome: 'Preparo dos alimentos',
      itens: [
        { id: 'descongelamento', texto: 'Descongelamento dos alimentos realizado sob temperatura de 5 °C.' },
        { id: 'termometros-calibrados', texto: 'A unidade possui termômetros calibrados para aferir a temperatura dos alimentos.' },
        { id: 'conservacao-preparados', texto: 'Os alimentos preparados são conservados sob temperatura adequada.' },
        { id: 'boas-praticas', texto: 'Todos os preparos dos alimentos são realizados em cima das boas práticas.' },
        { id: 'contaminacao-cruzada', texto: 'Existe controle para que não haja contaminação cruzada.' },
      ],
    },
    {
      // fica por último porque é o que ela confere DEPOIS de andar pela loja
      // (Master: "seria no final, né? após a visita")
      id: 'documentacao',
      nome: 'Documentação sanitária e outras',
      itens: [
        { id: 'licenca-sanitaria', texto: 'Licença sanitária' },
        { id: 'alvara-funcionamento', texto: 'Alvará de funcionamento' },
        { id: 'alvara-bombeiro', texto: 'Alvará de bombeiro' },
        { id: 'manual-boas-praticas', texto: 'Manual de boas práticas' },
        { id: 'certificado-detetizacao', texto: 'Certificado de detetização' },
        { id: 'limpeza-caixa-agua', texto: 'Limpeza de caixa de água' },
        { id: 'analise-agua', texto: 'Análise de água' },
        { id: 'programas-aso', texto: 'Programas e ASO' },
        { id: 'certificado-boas-praticas', texto: 'Certificado de boas práticas' },
        { id: 'limpeza-ar-coifa', texto: 'Planilha de limpeza do ar-condicionado e coifa' },
        { id: 'calibracao-termometro-balanca', texto: 'Calibração de termômetro e balança' },
      ],
    },
  ],
};

// Modelos oficiais são deliberadamente separados dos modelos abertos.  O
// conteúdo de uma auditoria contratual não pode ganhar um "outro ponto" no
// meio da visita, pois isto altera o formulário contra o qual a loja será
// cobrada.  A lista completa é publicada como versão bloqueada pelo Master;
// estas definições dão ao sistema um identificador estável e uma régua de
// pontuação que nunca cai no modelo aberto por engano.
const MODELOS_OFICIAIS = [
  {
    id: 'dominos-brasil-qa-2026', nome: 'Domino’s Brasil · Avaliação de Qualidade 2026',
    tipo: 'oficial', marca: 'dominos', bloqueado: true, versaoFonte: 'Março/2026',
    pontuacaoOficial: 150,
    setores: [
      { id: 'risco-alimentos', nome: 'Fatores de risco à segurança dos alimentos', itens: [
        ['1.01', 'Produtos identificados e dentro da validade.', 4], ['1.02', 'Temperaturas de produtos refrigerados e congelados dentro do padrão.', 4], ['1.03', 'Produtos cozidos a 74 °C ou mais.', 4], ['1.06', 'Proteção contra contaminação cruzada.', 4], ['1.09', 'Ausência de pragas ou indícios.', 3], ['1.11', 'Pia exclusiva e abastecida para lavagem de mãos.', 4], ['1.14', 'Sanitizante corretamente diluído e identificado.', 3],
      ].map(([id,texto,pontos]) => ({ id, texto, pontos })) },
      { id: 'limpeza', nome: 'Limpeza', itens: [
        ['2.01', 'Makeline limpa.', 2], ['2.02', 'Walk-in limpo.', 2], ['2.05', 'Forno e exaustor limpos.', 1], ['2.07', 'Área de lavagem de louça limpa.', 1], ['2.09', 'Pisos e ralos limpos.', 1], ['2.18', 'Banheiros limpos e higienizados.', 2],
      ].map(([id,texto,pontos]) => ({ id, texto, pontos })) },
      { id: 'manutencao', nome: 'Manutenção e instalações', itens: [
        ['3.01', 'Makeline em bom estado de conservação.', 2], ['3.02', 'Walk-in em bom estado de conservação.', 2], ['3.09', 'Pisos e ralos em bom estado.', 1], ['3.21', 'Caixa de gordura e esgoto vedados.', 2],
      ].map(([id,texto,pontos]) => ({ id, texto, pontos })) },
      { id: 'armazenamento', nome: 'Armazenamento', itens: [
        ['4.01', 'PVPS sendo realizado.', 2], ['4.03', 'Alimentos e embalagens protegidos e fora do chão.', 2], ['4.07', 'Alergênicos armazenados separadamente.', 2],
      ].map(([id,texto,pontos]) => ({ id, texto, pontos })) },
      { id: 'conhecimento', nome: 'Conhecimento e adequação', itens: [
        ['5.02', 'Certificados de calibração disponíveis.', 2], ['5.06', 'Licenças de alimentos e comerciais vigentes.', 2], ['5.07', 'Registros da qualidade da água vigentes.', 3], ['5.08', 'Registros de temperatura e recebimento preenchidos.', 2], ['5.12', 'Manual de boas práticas atualizado.', 2],
      ].map(([id,texto,pontos]) => ({ id, texto, pontos })) },
      { id: 'violacoes-extremas', nome: 'Violações extremas', itens: [
        ['6.01', 'Prevenção de pragas.', 5], ['6.02', 'Infraestrutura em padrão operacional.', 5], ['6.03', 'Proteção dos clientes.', 5], ['6.04', 'Integridade e segurança dos alimentos.', 5],
      ].map(([id,texto,pontos]) => ({ id, texto, pontos, criticidade: 'imprescindivel' })) },
    ],
  },
  {
    id: 'dominos-dpi-fse-2026', nome: 'Domino’s DPI/FSE · Padrão Global 2026',
    tipo: 'oficial', marca: 'dominos', bloqueado: true, versaoFonte: 'DPI 2026',
    pontuacaoOficial: 150,
    setores: [
      { id: 'risco-alimentos', nome: 'Fatores de risco à segurança dos alimentos', itens: [
        ['5.1', 'Produtos datados e dentro da validade.', 4], ['5.2', 'Termômetros calibrados em uso.', 3], ['5.3', 'Produtos cozidos a 74 °C ou mais.', 4], ['5.4', 'Produtos refrigerados a 5 °C ou menos.', 4], ['5.6', 'Proteção contra contaminação cruzada.', 3], ['5.8', 'Sem evidência de pragas.', 3], ['5.11', 'Lavagem e higienização das mãos.', 4], ['5.15', 'Sanitizante na concentração adequada.', 3],
      ].map(([id,texto,pontos]) => ({ id, texto, pontos })) },
      { id: 'limpeza', nome: 'Limpeza', itens: [['6.1','Makeline limpa.',2],['6.2','Walk-in limpo.',1],['6.6','Forno e coifa limpos.',1],['6.11','Pisos e ralos limpos.',1],['6.18','Banheiros limpos e sanitizados.',3]].map(([id,texto,pontos]) => ({ id,texto,pontos })) },
      { id: 'manutencao', nome: 'Manutenção e instalações', itens: [['7.1','Makeline em bom estado.',2],['7.2','Walk-in em bom estado.',1],['7.11','Pisos e ralos em bom estado.',1],['7.20','Ralos e canos com sistema anti-refluxo.',2]].map(([id,texto,pontos]) => ({ id,texto,pontos })) },
      { id: 'armazenamento', nome: 'Armazenamento', itens: [['8.1','Alimentos preparados em recipientes separados.',1],['8.3','Itens protegidos e não armazenados no chão.',2],['8.5','Produtos químicos rotulados e usados corretamente.',2]].map(([id,texto,pontos]) => ({ id,texto,pontos })) },
      { id: 'conhecimento', nome: 'Conhecimento e conformidade', itens: [['9.3','Conhecimento da política de saúde dos funcionários.',2],['9.4','Registros de temperatura completos.',1],['9.7','Plano de higienização implementado.',1],['9.10','Política de alergênicos disponível.',2]].map(([id,texto,pontos]) => ({ id,texto,pontos })) },
      { id: 'violacoes-criticas', nome: 'Violações críticas', itens: [['10.1','Prevenção e erradicação de pragas.',5],['10.2','Instalações e utensílios no padrão exigido.',5],['10.3','Público adequadamente protegido.',5],['10.4','Integridade e segurança do produto.',5]].map(([id,texto,pontos]) => ({ id,texto,pontos,criticidade:'imprescindivel' })) },
    ],
  },
];

function itensDoModelo(modelo) {
  return (modelo.setores || []).flatMap((s) => (s.itens || []).map((i) => ({ ...i, setorId: s.id })));
}
function totalDeItens(modelo) {
  return itensDoModelo(modelo).length;
}

// ---------------------------------------------------------------------
// A NOTA. Só os itens DO MODELO entram - ver o cabeçalho do arquivo.
function calcularNota(modelo, respostas) {
  const itens = itensDoModelo(modelo);
  if (!itens.length) return { nota: null, conformes: 0, naoConformes: 0, respondidos: 0, total: 0, faixa: null, criticasAbertas: 0 };
  const oficial = modelo && modelo.tipo === 'oficial';
  const comPesos = !!(modelo && modelo.pesos);
  const porId = new Map(itens.map((i) => [i.id, i]));
  let pontosPossiveis = 0;
  let pontosObtidos = 0;
  let conformes = 0;
  let naoConformes = 0;
  let naoAplicaveis = 0;
  let criticasAbertas = 0;
  for (const item of itens) pontosPossiveis += oficial ? Number(item.pontos || 0) : pesoDoItem(item, comPesos);
  for (const [id, r] of Object.entries(respostas || {})) {
    const item = porId.get(id);
    if (!item || !r) continue;
    if (r.resposta === 'nao-aplica') {
      naoAplicaveis += 1;
      pontosPossiveis -= oficial ? Number(item.pontos || 0) : pesoDoItem(item, comPesos);
      continue;
    } else if (r.resposta === 'conforme') {
      conformes += 1;
      pontosObtidos += oficial ? Number(item.pontos || 0) : pesoDoItem(item, comPesos);
    } else if (r.resposta === 'nao-conforme') {
      naoConformes += 1;
      // não conformidade em item imprescindível é o que o relatório precisa
      // destacar mesmo quando a nota final ficou boa
      if (item.criticidade === 'imprescindivel') criticasAbertas += 1;
    }
  }
  const respondidos = conformes + naoConformes + naoAplicaveis;
  // A nota é sobre o modelo INTEIRO, não sobre o que já foi respondido: meia
  // visita não pode parecer nota 10 porque só os conformes foram marcados.
  //
  // TRUNCA, não arredonda: 28/38 x 10 = 7,3684, e a planilha do Dominos
  // mostra 7,36. Arredondar viraria 7,37 e a mesma visita passaria a ter
  // duas notas diferentes conforme onde fosse lida.
  const bruta = pontosPossiveis > 0 ? (pontosObtidos / pontosPossiveis) * (oficial ? 100 : 10) : 0;
  const nota = Math.floor(bruta * 100) / 100;
  return { nota, conformes, naoConformes, naoAplicaveis, respondidos, total: itens.length, faixa: faixaDaNota(nota), criticasAbertas };
}

// ---------------------------------------------------------------------
// MODELOS. O padrão vive em código (é o que a planilha provou); modelo por
// marca - Dominos, Spoleto, São Braz, Milk Moo - nasce como CÓPIA dele e é
// gravado no Firestore. Foi o que o Master descreveu: monta a primeira vez,
// e aquilo vira um modelo pra reusar.
async function listarModelos() {
  const snap = await MODELOS.get();
  const salvos = snap.docs.map((d) => d.data());
  const porId = new Map(salvos.map((m) => [m.id, m]));
  // Um documento com o mesmo id é a versão oficial mais nova aprovada. Assim
  // a atualização substitui o modelo vigente, sem criar cópias concorrentes.
  return [MODELO_PADRAO, ...MODELOS_OFICIAIS.map((m) => porId.get(m.id) || m), ...salvos.filter((m) => !MODELOS_OFICIAIS.some((o) => o.id === m.id))];
}
const cacheModelos = createCache(listarModelos, 60 * 1000);

async function modeloPorId(id) {
  if (!id || id === MODELO_PADRAO.id) return MODELO_PADRAO;
  const snap = await MODELOS.doc(String(id)).get();
  if (snap.exists) return snap.data();
  const oficial = MODELOS_OFICIAIS.find((m) => m.id === String(id));
  if (oficial) return oficial;
  throw new Error('Modelo de checklist não encontrado. Atualize a tela e escolha um modelo válido.');
}

// Limites de um modelo. Não é paranoia: o modelo inteiro viaja DENTRO de
// cada visita (o retrato, ver ARQUITETURA) e o Firestore tem teto de 1 MiB
// por documento. Um checklist de mil itens inviabilizaria a visita toda.
const MAX_SETORES = 30;
const MAX_ITENS_POR_SETOR = 80;

function idDeTexto(texto, usados, prefixo) {
  const base = String(texto || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || prefixo;
  let id = base;
  let n = 2;
  while (usados.has(id)) { id = `${base}-${n}`; n += 1; }
  usados.add(id);
  return id;
}

// O QUE A TELA MANDA, tratado como dado a conferir.
//
// O ID DE UM ITEM NUNCA É REGERADO quando ele já vem: é ele que amarra a
// resposta gravada numa visita de agosto ao item de hoje (CLAUDE.md §1).
// Item novo (sem id) ganha um id derivado do texto, único dentro do modelo.
// Corrigir o TEXTO de um item existente é livre e não mexe no id - que é
// exatamente a regra "rótulo muda, identificador não".
function normalizarSetores(bruto) {
  if (!Array.isArray(bruto) || !bruto.length) throw new Error('O modelo precisa de pelo menos um setor.');
  const idsSetor = new Set();
  const setores = bruto.slice(0, MAX_SETORES).map((s, iS) => {
    const nome = String((s && s.nome) || '').trim().slice(0, 120);
    if (!nome) throw new Error(`O setor ${iS + 1} precisa de um nome.`);
    const idSetor = String((s && s.id) || '').trim() || idDeTexto(nome, idsSetor, `setor-${iS + 1}`);
    idsSetor.add(idSetor);
    const idsItem = new Set();
    const itens = (Array.isArray(s.itens) ? s.itens : []).slice(0, MAX_ITENS_POR_SETOR).map((i, iI) => {
      const texto = String((i && i.texto) || '').trim().slice(0, 400);
      if (!texto) throw new Error(`Um item do setor "${nome}" está sem texto.`);
      const idItem = String((i && i.id) || '').trim() || idDeTexto(texto, idsItem, `item-${iI + 1}`);
      idsItem.add(idItem);
      return {
        id: idItem,
        texto,
      criticidade: CRITICIDADES.includes(i && i.criticidade) ? i.criticidade : null,
      pontos: Math.max(0, Math.min(20, Number(i && i.pontos) || 0)),
      };
    });
    if (!itens.length) throw new Error(`O setor "${nome}" precisa de pelo menos um item.`);
    return { id: idSetor, nome, itens };
  });
  return setores;
}

async function salvarModelo({ id, nome, setores, pesos, marca }, email) {
  const limpo = String(nome || '').trim();
  if (!limpo) throw new Error('O modelo precisa de um nome.');
  const setoresLimpos = normalizarSetores(setores);
  const idFinal = String(id || '').trim() || limpo.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  if (!idFinal || idFinal === MODELO_PADRAO.id || MODELOS_OFICIAIS.some((m) => m.id === idFinal)) throw new Error('Esse identificador de modelo não pode ser usado.');
  const anterior = (await MODELOS.doc(idFinal).get()).data();
  const registro = {
    id: idFinal,
    nome: limpo,
    // VERSÃO SOBE A CADA EDIÇÃO. A visita guarda a versão que respondeu,
    // então mexer no modelo hoje nunca reescreve o que foi respondido antes.
    versao: Number(anterior && anterior.versao ? anterior.versao : 0) + 1,
    pesos: pesos === true,
    tipo: 'aberto', bloqueado: false,
    marca: String(marca || '').trim().slice(0, 80) || null,
    setores: setoresLimpos,
    criadoEm: (anterior && anterior.criadoEm) || new Date().toISOString(),
    atualizadoEm: new Date().toISOString(),
    atualizadoPorEmail: email || null,
  };
  await MODELOS.doc(idFinal).set(registro);
  cacheModelos.invalidar();
  return registro;
}

// Atualização controlada de uma fonte oficial. Não aceita alterar o id nem
// transformar o formulário em aberto; a visita antiga continua usando seu
// modeloSnap e a próxima já recebe a versão nova.
async function atualizarModeloOficial({ id, nome, setores, versaoFonte, fonte }, email) {
  const base = MODELOS_OFICIAIS.find((m) => m.id === String(id));
  if (!base) throw new Error('Este não é um modelo oficial reconhecido.');
  const fonteLimpa = String(fonte || '').trim().slice(0, 240);
  const versaoLimpa = String(versaoFonte || '').trim().slice(0, 80);
  if (!fonteLimpa || !versaoLimpa) throw new Error('Informe o arquivo-fonte e a versão/data divulgada pela Domino’s.');
  const anterior = (await MODELOS.doc(base.id).get()).data() || base;
  const registro = {
    id: base.id,
    nome: String(nome || base.nome).trim() || base.nome,
    tipo: 'oficial', marca: 'dominos', bloqueado: true,
    pontuacaoOficial: Number(base.pontuacaoOficial || 150), pesos: false,
    setores: normalizarSetores(setores),
    versao: Number(anterior.versao || 1) + 1,
    versaoFonte: versaoLimpa, fonte: fonteLimpa,
    atualizadoEm: new Date().toISOString(), atualizadoPorEmail: email || null,
    criadoEm: anterior.criadoEm || new Date().toISOString(),
  };
  await MODELOS.doc(base.id).set(registro);
  cacheModelos.invalidar();
  return registro;
}

// ---------------------------------------------------------------------
// A VISITA.
function novoId() {
  return crypto.randomBytes(12).toString('hex');
}

// o retrato do modelo que viaja DENTRO da visita (ver ARQUITETURA, item 1).
// Só o que o relatório precisa reler: id, texto e criticidade.
function retratoDoModelo(modelo) {
  return {
    id: modelo.id,
    nome: modelo.nome,
    versao: Number(modelo.versao || 1),
    pesos: !!modelo.pesos,
    tipo: modelo.tipo || 'aberto', marca: modelo.marca || null, bloqueado: !!modelo.bloqueado,
    pontuacaoOficial: Number(modelo.pontuacaoOficial || 0) || null,
    setores: (modelo.setores || []).map((s) => ({
      id: s.id,
      nome: s.nome,
      itens: (s.itens || []).map((i) => ({ id: i.id, texto: i.texto, criticidade: i.criticidade || null, pontos: Number(i.pontos || 0) })),
    })),
  };
}

async function criarVisita({ modeloId, unidade, unidadeNome, loja, data, representanteLoja, nutricionista, visitaAnteriorId, gps }, email) {
  const modelo = await modeloPorId(modeloId);
  const registro = {
    id: novoId(),
    status: 'EM_ANDAMENTO',
    modeloSnap: retratoDoModelo(modelo),
    unidade: String(unidade || '').trim() || null,
    unidadeNome: String(unidadeNome || '').trim() || null,
    loja: String(loja || '').trim() || null,
    data: String(data || '').trim() || new Date().toISOString().slice(0, 10),
    // Horas são geradas pelo servidor: campo digitável permitiria dizer que a
    // visita começou/terminou em outro momento que não o registrado.
    iniciadaEm: new Date().toISOString(),
    horario: null,
    representanteLoja: String(representanteLoja || '').trim() || null,
    nutricionista: String(nutricionista || '').trim() || null,
    visitaAnteriorId: String(visitaAnteriorId || '').trim() || null,
    gps: gps && Number.isFinite(Number(gps.latitude)) && Number.isFinite(Number(gps.longitude)) ? {
      latitude: Number(gps.latitude), longitude: Number(gps.longitude), accuracy: Number(gps.accuracy) || null,
      registradoEm: String(gps.registradoEm || new Date().toISOString()),
    } : null,
    respostas: {},
    extras: {},
    criadoEm: new Date().toISOString(),
    criadoPorEmail: email || null,
    concluidaEm: null,
  };
  await COLLECTION.doc(registro.id).set(registro);
  cacheLista.invalidar();
  return registro;
}

async function obterVisita(id) {
  const snap = await COLLECTION.doc(String(id || '')).get();
  if (!snap.exists) throw new Error('Visita não encontrada.');
  const visita = snap.data();
  return { ...visita, ...calcularNota(visita.modeloSnap, visita.respostas) };
}

// visita CONCLUÍDA não aceita mais resposta (ver ARQUITETURA, item 4) - o
// que continua aberto depois de fechar é só o ciclo da ação corretiva
function travarSeConcluida(visita) {
  if (visita.status === 'CONCLUIDA') {
    throw new Error('Visita concluída não pode ser alterada. Abra uma visita nova.');
  }
}

// ESCREVE O MAPA INTEIRO de respostas, e não só a chave que mudou.
//
// O Firestore de verdade faz merge PROFUNDO - set({respostas:{x:1}},{merge})
// preserva respostas.y. Mas essa é uma semântica sutil pra apoiar o dado que
// vira laudo assinado, e ela não é óbvia pra quem lê o código depois. Como
// estas funções JÁ leram o documento (precisam do estado anterior de
// qualquer jeito), reescrever o mapa não custa leitura nenhuma e o
// comportamento fica explícito - igual em qualquer implementação.
//
// O preço: duas pessoas respondendo A MESMA visita ao mesmo tempo, a última
// escrita ganha. Uma visita tem uma responsável técnica andando pela loja,
// então isso não acontece hoje; se um dia a loja responder o "espaço
// cliente" em paralelo, aqui é onde isso precisa virar transação.
async function gravarResposta(id, visita, itemId, valor) {
  const respostas = { ...(visita.respostas || {}), [itemId]: valor };
  await COLLECTION.doc(String(id)).set({ respostas }, { merge: true });
}

async function responderItem(id, itemId, { resposta, observacao, especificacoes }, email) {
  const snap = await COLLECTION.doc(String(id)).get();
  if (!snap.exists) throw new Error('Visita não encontrada.');
  const visita = snap.data();
  travarSeConcluida(visita);
  if (resposta !== null && !RESPOSTAS.includes(resposta)) throw new Error('Resposta inválida.');
  const itens = new Set(itensDoModelo(visita.modeloSnap).map((i) => i.id));
  const extrasIds = new Set(Object.values(visita.extras || {}).flat().map((e) => e.id));
  if (!itens.has(itemId) && !extrasIds.has(itemId)) throw new Error('Esse item não existe nesta visita.');
  const atual = (visita.respostas || {})[itemId] || {};
  const nova = {
    ...atual,
    resposta: resposta || null,
    observacao: observacao === undefined ? (atual.observacao || null) : (String(observacao || '').trim().slice(0, 2000) || null),
    // as especificações que ela acrescenta DENTRO do item (pedido do Master).
    // Não entram na nota - viram apontamento no relatório.
    especificacoes: Array.isArray(especificacoes)
      ? especificacoes.map((e) => ({
        texto: String((e && e.texto) || '').trim().slice(0, 500),
        resposta: RESPOSTAS.includes(e && e.resposta) ? e.resposta : null,
      })).filter((e) => e.texto).slice(0, 30)
      : (atual.especificacoes || []),
    respondidoEm: new Date().toISOString(),
    respondidoPorEmail: email || null,
  };
  await gravarResposta(id, visita, itemId, nova);
  cacheLista.invalidar();
  return nova;
}

// PONTO DE CHECK NOVO, no fim de um setor (pedido do Master: "ao término de
// todas as opções do checklist daquele setor, ter a opção de adicionar mais
// pontos de check"). Fica na visita, não no modelo: é o que ela viu HOJE
// naquela loja. Virar item fixo do modelo é outra decisão, e é por isso que
// existe salvarModelo.
async function adicionarPontoDeCheck(id, setorId, texto, email) {
  const snap = await COLLECTION.doc(String(id)).get();
  if (!snap.exists) throw new Error('Visita não encontrada.');
  const visita = snap.data();
  travarSeConcluida(visita);
  if ((visita.modeloSnap || {}).bloqueado || (visita.modeloSnap || {}).tipo === 'oficial') {
    throw new Error('O checklist oficial é bloqueado. Duplique-o como modelo aberto antes de acrescentar pontos.');
  }
  const limpo = String(texto || '').trim().slice(0, 500);
  if (!limpo) throw new Error('Escreva o ponto de check.');
  const setores = new Set((visita.modeloSnap.setores || []).map((s) => s.id));
  if (!setores.has(setorId)) throw new Error('Esse setor não existe nesta visita.');
  const lista = (visita.extras || {})[setorId] || [];
  if (lista.length >= 30) throw new Error('Limite de pontos de check extras neste setor.');
  const ponto = { id: `extra-${novoId().slice(0, 8)}`, texto: limpo, criadoEm: new Date().toISOString(), criadoPorEmail: email || null };
  await COLLECTION.doc(String(id)).set({ extras: { ...(visita.extras || {}), [setorId]: [...lista, ponto] } }, { merge: true });
  cacheLista.invalidar();
  return ponto;
}

// ---------------------------------------------------------------------
// CAPA - a ação corretiva de um apontamento (ver ARQUITETURA, item 3).
// Continua editável DEPOIS de concluída a visita, de propósito: é o ciclo
// que segue vivo até a loja corrigir e alguém verificar.
async function salvarAcaoCorretiva(id, itemId, { acaoCorretiva, responsavel, prazo, espacoCliente, corrigido }, email) {
  const snap = await COLLECTION.doc(String(id)).get();
  if (!snap.exists) throw new Error('Visita não encontrada.');
  const visita = snap.data();
  const atual = (visita.respostas || {})[itemId] || {};
  const patch = {
    ...atual,
    acaoCorretiva: acaoCorretiva === undefined ? (atual.acaoCorretiva || null) : (String(acaoCorretiva || '').trim().slice(0, 4000) || null),
    responsavel: responsavel === undefined ? (atual.responsavel || null) : (String(responsavel || '').trim().slice(0, 120) || null),
    prazo: prazo === undefined ? (atual.prazo || null) : (String(prazo || '').trim().slice(0, 10) || null),
    // "ESPAÇO CLIENTE" da planilha: o que a loja responde
    espacoCliente: espacoCliente === undefined ? (atual.espacoCliente || null) : (String(espacoCliente || '').trim().slice(0, 4000) || null),
  };
  if (corrigido !== undefined) {
    patch.corrigido = corrigido === null ? null : !!corrigido;
    patch.verificadoEm = corrigido === null ? null : new Date().toISOString();
    patch.verificadoPorEmail = corrigido === null ? null : (email || null);
  }
  await gravarResposta(id, visita, itemId, patch);
  cacheLista.invalidar();
  return patch;
}

// ---------------------------------------------------------------------
// FOTO DO APONTAMENTO.
//
// O relatório do São Braz é, na prática, um álbum: a foto é a prova do que
// foi visto, e é ela que faz a loja reconhecer o problema sem discussão.
//
// A foto NUNCA entra no Firestore (CLAUDE.md §3) - vai pro Storage e no
// documento fica só o caminho. Uma foto de celular tem 3-5 MB; seis delas
// num documento estourariam o teto de 1 MiB do Firestore e, pior, seriam
// relidas a cada abertura da visita.
const MAX_FOTOS_POR_ITEM = 6;

// ASSINATURA. Mesmo mecanismo do formularios.js: PNG do canvas como data
// URL dentro do próprio documento. Não vai pro Storage de propósito - o
// laudo precisa fechar mesmo se o Storage estiver fora, e 300 mil
// caracteres de base64 (~220 KB) cabem folgado no teto de 1 MiB.
const MAX_IMAGEM_CHARS = 300000;
const QUEM_ASSINA = ['loja', 'responsavel'];
const QUEM_ASSINA_LABEL = { loja: 'Representante da loja', responsavel: 'Responsável técnico' };

async function anexarFoto(id, itemId, foto) {
  const snap = await COLLECTION.doc(String(id)).get();
  if (!snap.exists) throw new Error('Visita não encontrada.');
  const visita = snap.data();
  const atual = (visita.respostas || {})[itemId] || {};
  const fotos = atual.fotos || [];
  if (fotos.length >= MAX_FOTOS_POR_ITEM) {
    throw new Error(`Limite de ${MAX_FOTOS_POR_ITEM} fotos por apontamento.`);
  }
  const nova = {
    nome: String(foto.nome || 'foto').slice(0, 120),
    path: String(foto.path || ''),
    tipo: String(foto.tipo || 'image/jpeg'),
    em: new Date().toISOString(),
  };
  if (!nova.path) throw new Error('Falha ao guardar a foto.');
  await gravarResposta(id, visita, itemId, { ...atual, fotos: [...fotos, nova] });
  cacheLista.invalidar();
  return nova;
}

async function fotoDe(id, itemId, indice) {
  const snap = await COLLECTION.doc(String(id)).get();
  if (!snap.exists) throw new Error('Visita não encontrada.');
  const fotos = ((snap.data().respostas || {})[itemId] || {}).fotos || [];
  const foto = fotos[Number(indice)];
  if (!foto) throw new Error('Foto não encontrada.');
  return foto;
}

// ASSINATURA DA VISITA (Master, 24/09/2026).
//
// Quem assina está NA LOJA, com a pessoa do lado - por isso assina no
// próprio aparelho, e não por link como no formularios.js. Link faz sentido
// quando o assinante está longe; aqui ele está a um braço de distância, e
// mandar link seria inventar uma espera que não existe.
//
// Continua valendo DEPOIS de concluída: a visita fecha o checklist, mas a
// assinatura pode vir logo em seguida, enquanto a gerente lê o resumo.
async function assinarVisita(id, { quem, nome, imagem }) {
  if (!QUEM_ASSINA.includes(quem)) throw new Error('Assinatura inválida.');
  const img = String(imagem || '');
  if (!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(img)) {
    throw new Error('Assinatura inválida - desenhe no quadro e tente de novo.');
  }
  if (img.length > MAX_IMAGEM_CHARS) throw new Error('Assinatura grande demais - limpe o quadro e assine de novo.');
  const snap = await COLLECTION.doc(String(id)).get();
  if (!snap.exists) throw new Error('Visita não encontrada.');
  const visita = snap.data();
  const assinaturas = {
    ...(visita.assinaturas || {}),
    [quem]: {
      imagem: img,
      nome: String(nome || '').trim().slice(0, 80) || null,
      assinadoEm: new Date().toISOString(),
    },
  };
  await COLLECTION.doc(String(id)).set({ assinaturas }, { merge: true });
  cacheLista.invalidar();
  return assinaturas[quem];
}

// A VISITA ANTERIOR DA MESMA LOJA.
//
// É o que fecha o ciclo da ação corretiva: quem chega na loja precisa saber
// o que ficou pendente da última vez, e o laudo precisa dizer se a nota
// subiu ou caiu. Sai da lista JÁ EM CACHE (createCache), então não custa
// leitura nova no Firestore (CLAUDE.md §3).
function mesmaLoja(a, b) {
  const chave = (v) => String(v.unidade || v.loja || '').trim().toLowerCase();
  return !!chave(a) && chave(a) === chave(b);
}
async function visitaAnteriorDe(visita) {
  const lista = await listarVisitas();
  const anteriores = lista
    .filter((v) => v.id !== visita.id && v.status === 'CONCLUIDA' && mesmaLoja(v, visita))
    .filter((v) => String(v.concluidaEm || '') < String(visita.concluidaEm || visita.criadoEm || ''))
    .sort((a, b) => String(b.concluidaEm).localeCompare(String(a.concluidaEm)));
  return anteriores[0] || null;
}

// O que ficou pendente na visita anterior - com foto e ação corretiva, pra
// ela conferir item por item se a loja corrigiu.
async function pendenciasDaAnterior(visita) {
  const anterior = await visitaAnteriorDe(visita);
  if (!anterior) return null;
  const snap = await COLLECTION.doc(String(anterior.id)).get();
  if (!snap.exists) return null;
  const doc = snap.data();
  const apontamentos = apontamentosDe(doc).filter((a) => a.corrigido !== true);
  return {
    id: anterior.id,
    data: anterior.data,
    nota: anterior.nota,
    faixa: anterior.faixa,
    pendentes: apontamentos,
  };
}

async function concluirVisita(id, email, gpsFim) {
  const snap = await COLLECTION.doc(String(id)).get();
  if (!snap.exists) throw new Error('Visita não encontrada.');
  const visita = snap.data();
  travarSeConcluida(visita);
  const conta = calcularNota(visita.modeloSnap, visita.respostas);
  // fechar visita pela metade produziria nota baixa que não é a realidade da
  // loja - e nota errada em laudo é pior que laudo atrasado
  if (conta.respondidos < conta.total) {
    throw new Error(`Faltam ${conta.total - conta.respondidos} item(ns) para concluir.`);
  }
  // FOTO OBRIGATÓRIA NO QUE ESTÁ NÃO CONFORME (Master, 24/09/2026).
  //
  // O relatório do São Braz é um álbum: a foto é o que faz a loja reconhecer
  // o problema sem discussão, e o que sustenta a cobrança na visita
  // seguinte. Apontamento sem foto vira a palavra de um contra a do outro.
  //
  // A mensagem NOMEIA os itens - "faltam 3 fotos" faria ela caçar quais na
  // mão, com a loja esperando.
  const semFoto = apontamentosDe({ ...visita, respostas: visita.respostas })
    .filter((a) => !(a.fotos || []).length)
    .map((a) => a.texto);
  if (semFoto.length) {
    throw new Error(`Falta foto em ${semFoto.length} apontamento(s): ${semFoto.slice(0, 3).join(' · ')}${semFoto.length > 3 ? ` · e mais ${semFoto.length - 3}` : ''}`);
  }
  const patch = {
    status: 'CONCLUIDA',
    concluidaEm: new Date().toISOString(),
    concluidaPorEmail: email || null,
    gpsFim: gpsFim && Number.isFinite(Number(gpsFim.latitude)) && Number.isFinite(Number(gpsFim.longitude)) ? {
      latitude: Number(gpsFim.latitude), longitude: Number(gpsFim.longitude), accuracy: Number(gpsFim.accuracy) || null,
      registradoEm: String(gpsFim.registradoEm || new Date().toISOString()),
    } : null,
    // a nota vai CONGELADA no documento: é o que o laudo mostrou no dia.
    // Recalcular na leitura faria uma correção futura no modelo mudar a nota
    // de uma visita já entregue ao cliente.
    nota: conta.nota,
    faixa: conta.faixa,
    conformes: conta.conformes,
    naoConformes: conta.naoConformes,
    totalItens: conta.total,
  };
  await COLLECTION.doc(String(id)).set(patch, { merge: true });
  cacheLista.invalidar();
  return { ...visita, ...patch };
}

// ---------------------------------------------------------------------
// LISTA. Resumo, nunca o documento inteiro (CLAUDE.md §3).
async function listarUncached() {
  const snap = await COLLECTION.orderBy('criadoEm', 'desc').limit(300).get();
  return snap.docs.map((d) => {
    const v = d.data();
    const conta = v.status === 'CONCLUIDA'
      ? { nota: v.nota, faixa: v.faixa, conformes: v.conformes, naoConformes: v.naoConformes, total: v.totalItens }
      : calcularNota(v.modeloSnap, v.respostas);
    return {
      id: v.id, status: v.status, data: v.data, horario: v.horario, iniciadaEm: v.iniciadaEm,
      unidade: v.unidade, unidadeNome: v.unidadeNome, loja: v.loja,
      modeloNome: (v.modeloSnap || {}).nome || null,
      representanteLoja: v.representanteLoja, nutricionista: v.nutricionista,
      criadoEm: v.criadoEm, concluidaEm: v.concluidaEm,
      nota: conta.nota, faixa: conta.faixa,
      conformes: conta.conformes, naoConformes: conta.naoConformes, total: conta.total,
    };
  });
}
const cacheLista = createCache(listarUncached, 20 * 1000);
async function listarVisitas() { return cacheLista.cached(); }

// APONTAMENTOS: tudo que ficou NÃO CONFORME, já no formato que o relatório
// e a tela de pendências usam. Sai do documento que já foi lido - não custa
// leitura nova.
function apontamentosDe(visita) {
  const porId = new Map(itensDoModelo(visita.modeloSnap || {}).map((i) => [i.id, i]));
  for (const [setorId, lista] of Object.entries(visita.extras || {})) {
    for (const e of lista) porId.set(e.id, { ...e, setorId, extra: true });
  }
  const setorNome = new Map((visita.modeloSnap && visita.modeloSnap.setores || []).map((s) => [s.id, s.nome]));
  return Object.entries(visita.respostas || {})
    .filter(([, r]) => r && r.resposta === 'nao-conforme')
    .map(([id, r]) => {
      const item = porId.get(id) || {};
      return {
        itemId: id,
        texto: item.texto || id,
        extra: !!item.extra,
        criticidade: item.criticidade || null,
        setor: setorNome.get(item.setorId) || null,
        observacao: r.observacao || null,
        especificacoes: r.especificacoes || [],
        fotos: r.fotos || [],
        acaoCorretiva: r.acaoCorretiva || null,
        responsavel: r.responsavel || null,
        prazo: r.prazo || null,
        espacoCliente: r.espacoCliente || null,
        corrigido: r.corrigido === undefined ? null : r.corrigido,
      };
    });
}

module.exports = {
  MODELO_PADRAO, RESPOSTAS, RESPOSTA_LABEL, STATUS,
  CRITICIDADES, CRITICIDADE_LABEL, PESO_POR_CRITICIDADE, pesoDoItem,
  FAIXA_POSITIVA_MIN, FAIXA_ATENCAO_MIN, FAIXA_LABEL,
  faixaDaNota, calcularNota, itensDoModelo, totalDeItens,
  MODELOS_OFICIAIS, listarModelos, modeloPorId, salvarModelo, atualizarModeloOficial, retratoDoModelo, normalizarSetores,
  MAX_SETORES, MAX_ITENS_POR_SETOR,
  criarVisita, obterVisita, responderItem, adicionarPontoDeCheck,
  salvarAcaoCorretiva, concluirVisita, listarVisitas, apontamentosDe,
  MAX_FOTOS_POR_ITEM, anexarFoto, fotoDe,
  QUEM_ASSINA, QUEM_ASSINA_LABEL, MAX_IMAGEM_CHARS, assinarVisita,
  visitaAnteriorDe, pendenciasDaAnterior,
};
