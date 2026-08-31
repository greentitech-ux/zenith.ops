// unidades.js
// Unidades (lojas) cadastradas pelo Master em runtime, por cima das listas
// fixas de index.js (FECHAMENTO_UNIDADES_NOMES etc). As fixas continuam
// existindo porque carregam codigos historicos de sistemas externos (Adyen,
// planilhas) que nao podem mudar; esta colecao cobre o resto: loja nova
// abrindo, unidade administrativa (escritorio), qualquer lugar que precise
// aparecer nos seletores (RH, Central, permissoes...) sem esperar deploy.
// O codigo vira o proprio identificador gravado nos documentos (igual as
// fixas), entao ele NUNCA muda depois de criado - so o nome de exibicao.
const db = require('./firestore');
const { createCache } = require('./liveCache');

const COLLECTION = db.collection('unidadesExtras');

// ---------------------------------------------------------------
// PERFIL DA UNIDADE: onde ela aparece e o que ela aceita.
//
// Nem toda unidade opera loja. A MVPar, por exemplo, não tem operação
// nenhuma - existe pra solicitação de pagamento e compra, tem gente (RH) e
// tem computador (NOC), mas não lança fechamento, não tem entrega, estoque
// nem parque. Antes o cadastro só tinha código+nome, então ela apareceria
// em TODOS os seletores e alguém acabaria lançando fechamento de uma
// empresa que não fatura.
//
// Duas listas, as duas com a MESMA regra de compatibilidade: vazio =
// "sem restrição". As unidades que já existem não têm esses campos e
// continuam aparecendo em tudo, exatamente como antes.
// ---------------------------------------------------------------
const AREAS_VALIDAS = ['fechamento', 'entregas', 'estoque', 'parque', 'rh', 'noc', 'solicitacoes', 'monitor', 'formularios'];
const TIPOS_SOLICITACAO_VALIDOS = ['estorno', 'ajuste-fechamento', 'compra', 'manutencao', 'suporte-ti', 'pagamento', 'nota', 'acesso-pessoa', 'adiantamento'];

function sanitizarLista(entrada, validos) {
  if (!Array.isArray(entrada)) return [];
  const vistos = new Set();
  return entrada
    .map((v) => String(v == null ? '' : v).trim().toLowerCase())
    .filter((v) => validos.includes(v) && !vistos.has(v) && vistos.add(v));
}

// vazio = sem restrição (aparece em tudo / aceita todos os tipos)
const listaVaziaOuValida = (lista, validos) => sanitizarLista(lista, validos);

async function listUncached() {
  const snap = await COLLECTION.orderBy('nome', 'asc').get();
  return snap.docs.map((d) => d.data());
}
const cache = createCache(listUncached, 5 * 60 * 1000);
const listAll = cache.cached;

// mapa {codigo: nome} pronto pra mesclar nos UNIDADES_NOMES das paginas e
// no construirUnidadesMapa de index.js
async function mapa() {
  const out = {};
  (await listAll()).forEach((u) => { out[u.codigo] = u.nome; });
  return out;
}

// Duas unidades com o MESMO NOME e codigos diferentes eram aceitas ate
// aqui, e o resultado aparecia no seletor do RH: "Dom Bessa" tres vezes,
// sem jeito de saber qual e' qual. O guard de codigo (abaixo) nunca pegou
// isso porque os codigos ERAM diferentes - o que se repetia era o rotulo.
//
// O codigo continua sendo a identidade (ja esta gravado em funcionario do
// RH, permissao de usuario, fechamento), e por isso NAO se funde nada aqui:
// o que este guard faz e' impedir que NASCA duplicata nova. As que ja
// existem o Master resolve na tela, apagando o cadastro extra que sobrou -
// ver diagnosticarNomesRepetidos.
function nomeNormalizado(v) {
  return String(v == null ? '' : v)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

// grupos de codigos que compartilham o MESMO nome. `fixas` e' o mapa
// {codigo: nome} das listas fixas do index.js - a duplicata mais comum e'
// justamente entre uma fixa e um cadastro extra, entao olhar so a colecao
// nao acharia nada.
function agruparPorNome(fixas, extras) {
  const porNome = new Map();
  const juntar = (codigo, nome, origem) => {
    const chave = nomeNormalizado(nome);
    if (!chave) return;
    if (!porNome.has(chave)) porNome.set(chave, { nome, codigos: [] });
    porNome.get(chave).codigos.push({ codigo, origem });
  };
  Object.entries(fixas || {}).forEach(([c, n]) => juntar(c, n, 'fixa'));
  (extras || []).forEach((u) => juntar(u.codigo, u.nome, 'cadastrada'));
  return porNome;
}

// o que o Master ve na tela: so os nomes que aparecem mais de uma vez, com
// os codigos de cada um e de onde vem (fixa nao da pra apagar; cadastrada
// da). Nao decide nada - quem escolhe qual codigo fica e' ele, porque so
// ele sabe qual tem lancamento gravado.
async function diagnosticarNomesRepetidos(fixas) {
  const grupos = agruparPorNome(fixas, await listAll());
  return [...grupos.values()]
    .filter((g) => g.codigos.length > 1)
    .sort((a, b) => String(a.nome).localeCompare(String(b.nome), 'pt-BR'));
}

// "codigosReservados" vem de index.js (uniao das listas fixas) - um codigo
// que ja existe fixo nao pode ser recadastrado aqui, senao viravam duas
// fontes de verdade pro mesmo lugar
async function criar({ codigo, nome, areas, tiposSolicitacao, porEmail }, codigosReservados, nomesReservados) {
  const nomeLimpo = String(nome || '').trim().slice(0, 60);
  if (!nomeLimpo) throw new Error('Informe o nome da unidade.');
  const codigoLimpo = String(codigo || nomeLimpo).trim().slice(0, 60);
  if (!codigoLimpo) throw new Error('Informe o código da unidade.');
  if (codigosReservados && codigosReservados.has(codigoLimpo)) {
    throw new Error('Esse código já existe nas unidades fixas do sistema.');
  }
  const existentes = await listAll();
  if (existentes.some((u) => u.codigo === codigoLimpo)) {
    throw new Error('Já existe uma unidade cadastrada com esse código.');
  }
  // nome repetido vira duas linhas iguais em TODO seletor do sistema, e
  // quem escolhe não tem como saber qual é qual
  const alvo = nomeNormalizado(nomeLimpo);
  if (nomesReservados && nomesReservados.has(alvo)) {
    throw new Error(`Já existe uma unidade chamada "${nomeLimpo}" nas unidades fixas do sistema. Use outro nome, ou edite o nome da unidade existente.`);
  }
  const mesmoNome = existentes.find((u) => nomeNormalizado(u.nome) === alvo);
  if (mesmoNome) {
    throw new Error(`Já existe uma unidade cadastrada com o nome "${nomeLimpo}" (código ${mesmoNome.codigo}). Dois nomes iguais ficam impossíveis de diferenciar no seletor.`);
  }
  const ref = COLLECTION.doc();
  const registro = {
    id: ref.id,
    codigo: codigoLimpo,
    nome: nomeLimpo,
    areas: listaVaziaOuValida(areas, AREAS_VALIDAS),
    tiposSolicitacao: listaVaziaOuValida(tiposSolicitacao, TIPOS_SOLICITACAO_VALIDOS),
    criadoPorEmail: porEmail || null,
    criadoEm: new Date().toISOString(),
  };
  await ref.set(registro);
  cache.invalidar();
  return registro;
}

// so o NOME e editavel - o codigo e identidade (ja pode estar gravado em
// funcionarios do RH, permissoes de usuario, fechamentos...)
async function atualizar(id, { nome, areas, tiposSolicitacao }, nomesReservados) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Unidade não encontrada.');
  const nomeLimpo = String(nome || '').trim().slice(0, 60);
  if (!nomeLimpo) throw new Error('Informe o nome da unidade.');
  // mesma regra do criar - senão a duplicata que o criar barra entra por
  // uma renomeação
  const alvoNome = nomeNormalizado(nomeLimpo);
  if (nomesReservados && nomesReservados.has(alvoNome)) {
    throw new Error(`Já existe uma unidade chamada "${nomeLimpo}" nas unidades fixas do sistema. Use outro nome.`);
  }
  const outroIgual = (await listAll()).find((u) => u.id !== id && nomeNormalizado(u.nome) === alvoNome);
  if (outroIgual) {
    throw new Error(`Já existe outra unidade com o nome "${nomeLimpo}" (código ${outroIgual.codigo}).`);
  }
  const patch = { nome: nomeLimpo, atualizadoEm: new Date().toISOString() };
  // undefined = não mexeu; array (mesmo vazio) = está definindo
  if (areas !== undefined) patch.areas = listaVaziaOuValida(areas, AREAS_VALIDAS);
  if (tiposSolicitacao !== undefined) patch.tiposSolicitacao = listaVaziaOuValida(tiposSolicitacao, TIPOS_SOLICITACAO_VALIDOS);
  await ref.update(patch);
  cache.invalidar();
  return { ...snap.data(), ...patch };
}

// upsert de PERFIL por codigo - diferente de criar()/atualizar(), que tratam
// o registro inteiro (nome+codigo) de uma unidade nova cadastrada aqui. Esta
// funcao existe pra deixar QUALQUER unidade (inclusive as fixas de index.js,
// tipo loja Adyen/planilha, cujo codigo nunca muda) ganhar o mesmo perfil de
// areas/tiposSolicitacao que a MVPar tem - sem recriar nem tocar no codigo,
// que ja pode estar gravado em fechamentos/RH/permissoes antigos. Por isso
// NAO passa pelo check de codigosReservados de criar(): aqui a intencao e
// exatamente anexar o perfil a um codigo que ja existe em outro lugar.
async function upsertPerfil(codigo, { nome, areas, tiposSolicitacao, porEmail }) {
  const codigoLimpo = String(codigo || '').trim().slice(0, 60);
  if (!codigoLimpo) throw new Error('Código da unidade inválido.');
  const existentes = await listAll();
  const atual = existentes.find((u) => u.codigo === codigoLimpo);
  const nomeLimpo = String(nome || (atual && atual.nome) || codigoLimpo).trim().slice(0, 60);
  const agora = new Date().toISOString();
  const registro = {
    id: atual ? atual.id : COLLECTION.doc().id,
    codigo: codigoLimpo,
    nome: nomeLimpo,
    areas: listaVaziaOuValida(areas, AREAS_VALIDAS),
    tiposSolicitacao: listaVaziaOuValida(tiposSolicitacao, TIPOS_SOLICITACAO_VALIDOS),
    criadoPorEmail: (atual && atual.criadoPorEmail) || porEmail || null,
    criadoEm: (atual && atual.criadoEm) || agora,
    atualizadoEm: agora,
  };
  await COLLECTION.doc(registro.id).set(registro);
  cache.invalidar();
  return registro;
}

// ---- consultas de perfil (usadas pelas rotas e pelos seletores) ----
async function perfil(codigo) {
  const u = (await listAll()).find((x) => x.codigo === codigo);
  return u || null;
}

// Unidade que NÃO está cadastrada aqui (as fixas de index.js) nunca é
// restringida - o perfil só existe pra quem foi cadastrado em runtime.
async function apareceEm(codigo, area) {
  const u = await perfil(codigo);
  if (!u || !Array.isArray(u.areas) || !u.areas.length) return true;
  return u.areas.includes(area);
}

async function aceitaTipo(codigo, tipo) {
  const u = await perfil(codigo);
  if (!u || !Array.isArray(u.tiposSolicitacao) || !u.tiposSolicitacao.length) return true;
  return u.tiposSolicitacao.includes(tipo);
}

// codigos com perfil que EXCLUI a area dada - usado pelas telas que montam
// o seletor de unidade a partir de uma lista fixa pre-populada (ex:
// lancamento.html, ARCFOOD/BRAVO fixos) e so DEPOIS mesclam unidadesExtras
// por cima: mesclar nunca remove chave, entao uma unidade FIXA (ex: MVPar
// registrada nas listas fixas) que ganhou perfil restrito continua na lista
// se ninguem tirar ela explicitamente - e o que essas telas fazem com isto
async function codigosRestritosDe(area) {
  return (await listAll())
    .filter((u) => Array.isArray(u.areas) && u.areas.length && !u.areas.includes(area))
    .map((u) => u.codigo);
}

// filtra um mapa {codigo: nome} deixando só quem aparece na área - é o que
// os seletores de fechamento/entregas/estoque usam
async function filtrarMapaPorArea(mapa, area) {
  const cadastradas = await listAll();
  const restritas = new Map(cadastradas.filter((u) => Array.isArray(u.areas) && u.areas.length).map((u) => [u.codigo, u.areas]));
  const out = {};
  Object.entries(mapa || {}).forEach(([codigo, nome]) => {
    const areas = restritas.get(codigo);
    if (!areas || areas.includes(area)) out[codigo] = nome;
  });
  return out;
}

// APAGAR UNIDADE E' A ACAO MAIS CARA DE ERRAR AQUI. O Master pediu pra tirar
// a "Dom Bessa" que aparece zerada no painel - mas existem DUAS com esse
// rotulo, e a outra tem R$175 mil e 761 TC de historico. O codigo e a
// identidade (ja esta gravado em fechamento, funcionario do RH, permissao de
// usuario), entao apagar o codigo errado nao "some com uma linha da tela":
// desliga o historico da loja de verdade.
//
// Por isso quem chama passa um contador: se o codigo tiver QUALQUER
// lancamento, a exclusao e recusada com o numero na mensagem. So sai da
// frente o cadastro que de fato nao tem nada - que e' exatamente o que ele
// descreveu ("sempre esta ZERADA pois ela nao existe").
//
// Nao ha "forcar": um codigo com lancamento nao e duplicata sobrando, e a
// uniao de codigos de unidade esta encerrada (secao 1 do CLAUDE.md) - o
// caminho pra esse caso e conversa, nao um parametro.
async function remover(id, contarRegistros) {
  const snap = await COLLECTION.doc(id).get();
  if (!snap.exists) throw new Error('Unidade não encontrada.');
  const dados = snap.data();
  if (typeof contarRegistros === 'function') {
    const quantos = await contarRegistros(dados.codigo);
    if (quantos > 0) {
      throw new Error(`"${dados.nome}" (${dados.codigo}) tem ${quantos} lançamento(s) no histórico `
        + '- essa não é a duplicata vazia. Confira o código na lista de nomes repetidos antes de excluir.');
    }
  }
  await COLLECTION.doc(id).delete();
  cache.invalidar();
  return dados;
}

module.exports = {
  AREAS_VALIDAS, TIPOS_SOLICITACAO_VALIDOS,
  listAll, mapa, criar, atualizar, remover, upsertPerfil,
  nomeNormalizado, agruparPorNome, diagnosticarNomesRepetidos,
  perfil, apareceEm, aceitaTipo, filtrarMapaPorArea, codigosRestritosDe,
  invalidar: () => cache.invalidar(),
};
