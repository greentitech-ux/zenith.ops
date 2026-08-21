// formularios.js
// Formulários financeiros por unidade (Depósito de Caixa, Pagamento de
// Diárias, Pagamento Avulso, Reembolso) - reprodução dos formulários em
// papel do "BESSA DOM FORMS" (AppSheet), só que com o problema central
// resolvido DENTRO do app: a ASSINATURA. Cada papel que precisa assinar
// (gerente, favorecido, e no caso das diárias cada diarista da
// tabela) ganha um LINK próprio (token de uso pessoal, mesmo espírito do
// linkAcao dos tickets): a pessoa abre no celular onde estiver, desenha a
// assinatura na tela (assinar.html) e ela entra na POSIÇÃO CERTA do PDF
// final - na linha de assinatura do rodapé ou na própria linha da tabela.
//
// A imagem da assinatura fica no próprio documento como data URL (PNG
// pequeno do canvas, capado em ~200KB por assinatura) - simples de embutir
// no PDF e sem dependência do Storage num fluxo que precisa funcionar
// sempre. O PDF é gerado sob demanda (nunca gravado), então uma assinatura
// que chegar depois já aparece no próximo download.
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const db = require('./firestore');
const { createCache } = require('./liveCache');
const ticketCounter = require('./ticketCounter');

const COLLECTION = db.collection('formularios');
// memoria de FAVORECIDO por documento (CPF do favorecido no Reembolso,
// CNPJ do fornecedor no Avulso): todo formulario criado grava/atualiza os
// dados bancarios daquele documento, e a tela preenche sozinha quando o
// mesmo CPF/CNPJ for digitado de novo (pedido do Master: "quando o CPF foi
// inserido ja, deixar salvo")
const FAVORECIDOS = db.collection('formularioFavorecidos');

// Modelo de cada tipo: campos do cabeçalho, colunas da tabela e quem
// assina - transcrição fiel dos 4 PDFs originais enviados pelo Master.
const TIPOS = {
  deposito: {
    rotulo: 'Depósito de Caixa',
    titulo: 'DEPÓSITO DE CAIXA',
    cabecalho: [
      { key: 'cnpj', label: 'CNPJ' },
      { key: 'nomeGerente', label: 'NOME DO GERENTE' },
    ],
    colunas: [
      { key: 'data', label: 'DATA DO DEPÓSITO' },
      { key: 'periodo', label: 'PERÍODO DO CAIXA' },
      { key: 'envelope', label: 'Nº DO ENVELOPE' },
      { key: 'valor', label: 'VALOR (R$)', valor: true },
    ],
    totalRotulo: 'VALOR TOTAL DEPOSITADO (R$)',
    assinantes: [{ papel: 'gerente', rotulo: 'Gerente da unidade' }],
  },
  diarias: {
    rotulo: 'Pagamento de Diárias',
    titulo: 'PAGAMENTO DE DIÁRIA',
    cabecalho: [{ key: 'cnpj', label: 'CNPJ' }],
    colunas: [
      { key: 'nome', label: 'NOME' },
      { key: 'datas', label: 'DATA(S)' },
      { key: 'chavePix', label: 'CHAVE PIX' },
      { key: 'banco', label: 'BANCO' },
      { key: 'valor', label: 'VALOR (R$)', valor: true },
    ],
    // cada diarista assina a PRÓPRIA linha da tabela (coluna ASSINATURA do
    // formulário original) - vira um link de assinatura por linha
    assinaturaPorLinha: true,
    totalRotulo: 'VALOR TOTAL (R$)',
    assinantes: [{ papel: 'gerente', rotulo: 'Gerente da unidade' }],
  },
  avulso: {
    rotulo: 'Pagamento Avulso',
    titulo: 'SOLICITAÇÃO DE PAGAMENTO AVULSO',
    cabecalho: [
      { key: 'cnpj', label: 'CNPJ' },
      { key: 'fornecedor', label: 'FAVORECIDO' },
      { key: 'cnpjFornecedor', label: 'CNPJ DO FAVORECIDO' },
      { key: 'banco', label: 'BANCO' },
      { key: 'agencia', label: 'AGÊNCIA' },
      { key: 'conta', label: 'CONTA COM DÍGITO' },
      { key: 'chavePix', label: 'CHAVE PIX' },
    ],
    colunas: [
      { key: 'data', label: 'DATA' },
      { key: 'descricao', label: 'DESCRIÇÃO', larga: true },
      { key: 'valor', label: 'VALOR (R$)', valor: true },
    ],
    totalRotulo: 'VALOR TOTAL (R$)',
    assinantes: [
      { papel: 'fornecedor', rotulo: 'Favorecido' },
      { papel: 'gerente', rotulo: 'Gerente da unidade' },
    ],
  },
  reembolso: {
    rotulo: 'Reembolso',
    titulo: 'SOLICITAÇÃO DE REEMBOLSO',
    cabecalho: [
      { key: 'cnpj', label: 'CNPJ' },
      { key: 'colaborador', label: 'NOME DO FAVORECIDO' },
      { key: 'cpf', label: 'CPF' },
      { key: 'banco', label: 'BANCO' },
      { key: 'agencia', label: 'AGÊNCIA' },
      { key: 'conta', label: 'CONTA COM DÍGITO' },
      { key: 'chavePix', label: 'CHAVE PIX' },
    ],
    colunas: [
      { key: 'data', label: 'DATA DA DESPESA' },
      // continua FORNECEDOR de propósito: aqui é coluna da tabela - o
      // estabelecimento onde CADA despesa foi feita, não quem recebe o
      // dinheiro. O favorecido do Reembolso é o do cabeçalho acima.
      { key: 'fornecedor', label: 'NOME DO FORNECEDOR' },
      { key: 'descricao', label: 'DESCRIÇÃO', larga: true },
      { key: 'valor', label: 'VALOR (R$)', valor: true },
    ],
    totalRotulo: 'VALOR TOTAL (R$)',
    assinantes: [
      // as CHAVES ('colaborador'/'gestor') ficam como estão de propósito:
      // formulário já gravado guarda campos.colaborador e
      // assinaturas.colaborador/gestor - renomear a chave desligaria o
      // valor e a assinatura dos registros antigos. O que o Master pediu
      // pra trocar é o que aparece na tela e no PDF, e é só isso que muda.
      { papel: 'colaborador', rotulo: 'Favorecido' },
      { papel: 'gestor', rotulo: 'Responsável' },
    ],
    obs: 'OBS.: Todos os comprovantes das despesas devem estar devidamente rubricados e anexados a este formulário.',
  },
};

// Cadastro FIXO unidade -> razão social + CNPJ (lista enviada pelo Master
// em 20/08/2026). O formulário nasce com esses dados já preenchidos e SEM
// edição: quem cria só escolhe a unidade - o CNPJ que o navegador mandar é
// IGNORADO de propósito (a fonte é este cadastro, não o formulário).
const UNIDADES_FORM = [
  { unidade: 'Spoleto Shopping Recife', razaoSocial: 'Trigo Recife', cnpj: '50.625.368/0001-13' },
  { unidade: "Domino's Caruaru", razaoSocial: 'America Caruaru', cnpj: '50.724.770/0001-55' },
  { unidade: 'São Braz Ilha do Leite', razaoSocial: 'Cafe SBI', cnpj: '50.929.548/0001-99' },
  { unidade: "Domino's Garanhuns", razaoSocial: 'America Restaurante', cnpj: '43.675.465/0001-55' },
  { unidade: 'Spoleto Tacaruna', razaoSocial: 'Grano Tacaruna', cnpj: '49.942.203/0001-96' },
  { unidade: "Spoleto Domino's Aeroporto Recife", razaoSocial: 'Grande Fratello', cnpj: '20.182.750/0001-39' },
  { unidade: "Domino's Tirol - Natal", razaoSocial: 'America Partners RN', cnpj: '47.677.381/0001-01' },
  { unidade: 'Milky Moo Tirol - Natal', razaoSocial: 'Milky Moo Tirol - Natal', cnpj: '48.049.478/0001-32' },
  { unidade: "Domino's Bessa - João Pessoa", razaoSocial: 'America Bessa', cnpj: '59.449.391/0001-79' },
  { unidade: 'Big Brother - Recife', razaoSocial: 'Big Brother Serviços Combinados LTDA.', cnpj: '36.196.587/0001-01' },
  { unidade: 'Grupo Bravo Empresarial', razaoSocial: 'MvPar', cnpj: '41.051.829/0001-09' },
];

const MAX_LINHAS = 20;
// PNG do canvas de assinatura fica em torno de 5-30KB; o cap é folga, não
// meta - acima disso é foto/arquivo indevido, não um traço de caneta
const MAX_IMAGEM_CHARS = 300000;

function limpar(v, max = 120) { return String(v == null ? '' : v).trim().slice(0, max); }
function soDigitos(v) { return String(v || '').replace(/\D/g, ''); }

// nunca derruba a criacao do formulario: aprender o favorecido e bonus
async function salvarFavorecido(campos) {
  try {
    const cpf = soDigitos(campos.cpf);
    const cnpj = soDigitos(campos.cnpjFornecedor);
    const chave = cpf.length === 11 ? cpf : (cnpj.length === 14 ? cnpj : null);
    if (!chave) return;
    const dados = {
      doc: chave,
      nome: campos.colaborador || campos.fornecedor || null,
      cpf: campos.cpf || null, cnpjFornecedor: campos.cnpjFornecedor || null,
      banco: campos.banco || null, agencia: campos.agencia || null, conta: campos.conta || null,
      chavePix: campos.chavePix || null,
      atualizadoEm: new Date().toISOString(),
    };
    await FAVORECIDOS.doc(chave).set(dados, { merge: true });
  } catch (e) { /* memoria de favorecido e best-effort */ }
}

async function buscarFavorecido(docBruto) {
  const chave = soDigitos(docBruto);
  if (chave.length !== 11 && chave.length !== 14) return null;
  const snap = await FAVORECIDOS.doc(chave).get();
  return snap.exists ? snap.data() : null;
}

// aceita número ou texto pt-BR ("1.234,56", "R$ 237,72")
function parseValor(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const s = String(v || '').replace(/[R$\s]/g, '');
  if (!s) return 0;
  const n = Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s);
  return Number.isFinite(n) ? n : 0;
}

function fmtMoney(v) {
  return (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function listAllUncached() {
  const snap = await COLLECTION.orderBy('criadoEm', 'desc').get();
  return snap.docs.map((d) => d.data());
}
const cache = createCache(listAllUncached, 60 * 1000);

async function getOne(id) {
  const doc = await COLLECTION.doc(id).get();
  return doc.exists ? doc.data() : null;
}

// vista SEM segredo nem peso: tokens nunca saem numa listagem, e as imagens
// das assinaturas (base64) só viajam dentro do PDF
// O rótulo de cada papel vem do MODELO na hora de ler, não do que ficou
// gravado quando o formulário nasceu. Motivo prático: quando o Master
// renomeia um papel (foi o caso de "Colaborador" -> "Favorecido" e "Gestor
// imediato" -> "Responsável"), os formulários que já existiam continuariam
// exibindo o nome velho pra sempre, inclusive na tela de assinatura e no
// PDF. Assim o nome novo vale pra todo mundo, sem migração.
// Exceção: slot por linha (diárias) tem rótulo próprio, montado com o nome
// da pessoa daquela linha - esse não existe no modelo e continua vindo do
// registro.
function rotuloDoSlot(tipo, chave, rotuloGravado) {
  const modelo = TIPOS[tipo];
  const doModelo = modelo && (modelo.assinantes || []).find((a) => a.papel === chave);
  return doModelo ? doModelo.rotulo : rotuloGravado;
}

function resumo(r) {
  const assinaturas = Object.entries(r.assinaturas || {}).map(([chave, a]) => ({
    chave, rotulo: rotuloDoSlot(r.tipo, chave, a.rotulo), assinado: !!a.imagem, nome: a.nome || null, assinadoEm: a.assinadoEm || null,
  }));
  const { assinaturas: _, ...resto } = r;
  return { ...resto, assinaturas };
}

async function listar() {
  return (await cache.cached()).map(resumo);
}

// detalhe pra quem criou (tela formularios.html): inclui o TOKEN de cada
// assinatura pendente, pra montar o link que vai por WhatsApp - por isso a
// rota que chama isso é autenticada (seção formularios)
async function detalhar(id) {
  const r = await getOne(id);
  if (!r) return null;
  const base = resumo(r);
  base.assinaturas = base.assinaturas.map((a) => ({ ...a, token: r.assinaturas[a.chave].token }));
  return base;
}

// valida/normaliza o conteúdo do formulário. Extraído de criar() porque o
// preenchimento por LINK (ver salvarPreenchimento) tem que passar pelas
// MESMAS regras - se as duas portas de entrada validassem cada uma do seu
// jeito, o que entra pelo link acabaria diferente do que a unidade digita.
function montarConteudo(modelo, cadastro, campos, linhas) {
  const camposOk = {};
  modelo.cabecalho.forEach((c) => { camposOk[c.key] = limpar((campos || {})[c.key], 160); });
  // Nome/CNPJ vem do cadastro fixo, nunca do formulário (pedido do Master:
  // "já preenchido e sem edição")
  camposOk.cnpj = cadastro.cnpj;

  const linhasOk = (Array.isArray(linhas) ? linhas : []).slice(0, MAX_LINHAS)
    .map((l) => {
      const linha = {};
      modelo.colunas.forEach((c) => {
        linha[c.key] = c.valor ? parseValor((l || {})[c.key]) : limpar((l || {})[c.key], 160);
      });
      return linha;
    })
    .filter((l) => modelo.colunas.some((c) => (c.valor ? l[c.key] : l[c.key] !== '')));
  if (!linhasOk.length) throw new Error('Preencha ao menos uma linha da tabela.');

  const colunaValor = modelo.colunas.find((c) => c.valor);
  const valorTotal = linhasOk.reduce((s, l) => s + (colunaValor ? l[colunaValor.key] : 0), 0);
  return { camposOk, linhasOk, valorTotal };
}

// um slot de assinatura por papel do modelo + (nas diárias) um por linha,
// cada um com um token próprio - o token é o link daquela pessoa. Só dá pra
// montar DEPOIS de existirem linhas, e é por isso que o formulário criado
// pra preenchimento por link nasce sem assinatura nenhuma: os slots saem no
// momento em que o solicitante envia o preenchimento.
function montarAssinaturas(modelo, linhasOk) {
  const assinaturas = {};
  const slot = (chave, rotulo) => {
    assinaturas[chave] = { rotulo, token: crypto.randomBytes(18).toString('hex'), nome: null, imagem: null, assinadoEm: null };
  };
  if (modelo.assinaturaPorLinha) {
    linhasOk.forEach((l, i) => slot(`linha-${i}`, `Assinatura · ${l.nome || `linha ${i + 1}`}`));
  }
  modelo.assinantes.forEach((a) => slot(a.papel, a.rotulo));
  return assinaturas;
}

// numeroTicket: aceita um número pronto de fora pelo MESMO motivo que
// solicitacoes.js/refunds.js aceitam - quando um registro vira outro, ele
// carrega o número em vez de tirar outro da fila (ver ticketCounter.js).
async function criar({ tipo, unidade, campos, linhas, anexos, criadoPorId, criadoPorEmail, numeroTicket }) {
  const modelo = TIPOS[tipo];
  if (!modelo) throw new Error('Tipo de formulário inválido.');
  const unidadeOk = limpar(unidade, 80);
  if (!unidadeOk) throw new Error('Informe a unidade.');
  const cadastro = UNIDADES_FORM.find((u) => u.unidade === unidadeOk);
  if (!cadastro) throw new Error('Unidade inválida - escolha uma das unidades cadastradas.');

  const { camposOk, linhasOk, valorTotal } = montarConteudo(modelo, cadastro, campos, linhas);
  const assinaturas = montarAssinaturas(modelo, linhasOk);

  // comprovantes da solicitacao (PDF/imagem) - ja salvos no Storage pela
  // rota, aqui entra so a referencia
  const anexosOk = (Array.isArray(anexos) ? anexos : []).slice(0, 5)
    .map((a) => ({ nome: limpar(a.nome, 120) || 'anexo', path: String(a.path || ''), tipo: limpar(a.tipo, 80) }))
    .filter((a) => a.path);

  const doc = COLLECTION.doc();
  const registro = {
    id: doc.id, tipo, unidade: unidadeOk, razaoSocial: cadastro.razaoSocial,
    campos: camposOk, linhas: linhasOk, valorTotal, anexos: anexosOk,
    assinaturas, status: 'PENDENTE',
    // MESMA sequência dos tickets da Central (#10000+), não um contador
    // próprio: o formulário vira uma solicitação de Pagamento depois de
    // assinado, e tem que chegar lá com o número que já nasceu com ele -
    // é a mesma razão pela qual o contador é compartilhado entre os outros
    // módulos (ver ticketCounter.js).
    numeroTicket: numeroTicket != null ? numeroTicket : await ticketCounter.proximoTicket(),
    criadoEm: new Date().toISOString(), criadoPorId: criadoPorId || null, criadoPorEmail: criadoPorEmail || null,
  };
  await doc.set(registro);
  cache.invalidar();
  await salvarFavorecido(camposOk);
  return detalhar(doc.id);
}

// ---------------------------------------------------------------------
// PREENCHIMENTO POR LINK. Pedido do Master: duas portas de entrada, não
// uma - ou a unidade preenche tudo (criar, acima), ou manda o link pro
// próprio solicitante preencher os dados dele. Faz diferença real no
// Reembolso: quem sabe o CPF, o banco, a agência, a conta e a chave PIX é
// o favorecido, não a loja - hoje a loja tem que perguntar tudo por fora
// e digitar no lugar dele, e é aí que entra dado errado.
//
// O formulário nasce aqui já com Ticket # e já com a unidade travada (o
// solicitante não escolhe de qual unidade é, senão o link viraria uma
// porta pra lançar em qualquer loja). O que falta - cabeçalho e linhas -
// é o que ele preenche.
const STATUS_AGUARDANDO = 'AGUARDANDO_PREENCHIMENTO';

// O link é ÚNICO por tipo+unidade+quem gerou, enquanto não for preenchido:
// clicar no botão de novo devolve O MESMO link e O MESMO Ticket #, em vez
// de criar outro formulário. Sem isso, cada clique nascia com número de
// ticket próprio - quem clicasse duas vezes (ou gerasse o link e não
// mandasse) deixava formulário fantasma na lista e queimava número da
// sequência da Central pra sempre.
//
// Pra mandar DOIS links ao mesmo tempo pro mesmo tipo/unidade (duas
// pessoas diferentes), cancele o pendente primeiro (cancelarPreenchimento)
// - assim continua valendo "um link vivo de cada vez", que é o que evita
// dois destinatários brigando pelo mesmo formulário.
async function criarParaPreenchimento({ tipo, unidade, criadoPorId, criadoPorEmail, numeroTicket }) {
  const modelo = TIPOS[tipo];
  if (!modelo) throw new Error('Tipo de formulário inválido.');
  const unidadeOk = limpar(unidade, 80);
  const cadastro = UNIDADES_FORM.find((u) => u.unidade === unidadeOk);
  if (!cadastro) throw new Error('Unidade inválida - escolha uma das unidades cadastradas.');

  const jaExiste = (await cache.cached()).find((r) => r.status === STATUS_AGUARDANDO
    && r.tipo === tipo && r.unidade === unidadeOk
    && (r.criadoPorId || null) === (criadoPorId || null));
  if (jaExiste) return { ...(await detalhar(jaExiste.id)), reaproveitado: true };

  const doc = COLLECTION.doc();
  const registro = {
    id: doc.id, tipo, unidade: unidadeOk, razaoSocial: cadastro.razaoSocial,
    campos: { cnpj: cadastro.cnpj }, linhas: [], valorTotal: 0, anexos: [],
    // sem slot de assinatura ainda - só dá pra montar quando houver linhas
    assinaturas: {}, status: STATUS_AGUARDANDO,
    tokenPreenchimento: crypto.randomBytes(18).toString('hex'),
    numeroTicket: numeroTicket != null ? numeroTicket : await ticketCounter.proximoTicket(),
    criadoEm: new Date().toISOString(), criadoPorId: criadoPorId || null, criadoPorEmail: criadoPorEmail || null,
  };
  await doc.set(registro);
  cache.invalidar();
  return detalhar(doc.id);
}

// desiste do link antes de alguém preencher. O formulário é apagado (não
// vira histórico de nada - nunca teve conteúdo), e com ele some o número
// de ticket reservado. Só vale enquanto está aguardando: depois de
// preenchido, ele já é um formulário de verdade e sai pelo caminho normal
// (remover, que é Master).
async function cancelarPreenchimento(id) {
  const r = await getOne(id);
  if (!r) throw new Error('Formulário não encontrado.');
  if (r.status !== STATUS_AGUARDANDO) throw new Error('Esse formulário já foi preenchido - não dá mais pra cancelar o link.');
  await COLLECTION.doc(id).delete();
  cache.invalidar();
  return { id };
}

async function porTokenPreenchimento(token) {
  if (!token) return null;
  const todos = await cache.cached();
  return todos.find((r) => r.tokenPreenchimento && r.tokenPreenchimento === token) || null;
}

// o que a página pública de preenchimento enxerga: o modelo (pra montar os
// campos), a unidade JÁ definida e nada de token de assinatura - quem
// preenche não é necessariamente quem assina.
async function vistaPreenchimento(token) {
  const r = await porTokenPreenchimento(token);
  if (!r) return null;
  const modelo = TIPOS[r.tipo];
  return {
    id: r.id, tipo: r.tipo, rotulo: modelo.rotulo, titulo: modelo.titulo,
    unidade: r.unidade, razaoSocial: r.razaoSocial, cnpj: r.campos.cnpj,
    numeroTicket: r.numeroTicket,
    cabecalho: modelo.cabecalho, colunas: modelo.colunas,
    jaPreenchido: r.status !== STATUS_AGUARDANDO,
    campos: r.campos, linhas: r.linhas,
  };
}

// o solicitante enviou: valida pelas MESMAS regras da unidade, cria os
// slots de assinatura (agora que existem linhas) e o formulário entra no
// fluxo normal, como se tivesse sido preenchido na loja.
async function salvarPreenchimento(token, { campos, linhas }) {
  const r = await porTokenPreenchimento(token);
  if (!r) throw new Error('Link de preenchimento inválido.');
  if (r.status !== STATUS_AGUARDANDO) throw new Error('Esse formulário já foi preenchido.');
  const modelo = TIPOS[r.tipo];
  const cadastro = UNIDADES_FORM.find((u) => u.unidade === r.unidade);

  const { camposOk, linhasOk, valorTotal } = montarConteudo(modelo, cadastro, campos, linhas);
  await COLLECTION.doc(r.id).update({
    campos: camposOk, linhas: linhasOk, valorTotal,
    assinaturas: montarAssinaturas(modelo, linhasOk),
    status: 'PENDENTE', preenchidoEm: new Date().toISOString(),
  });
  cache.invalidar();
  await salvarFavorecido(camposOk);
  return { ok: true, id: r.id };
}

// acha a qual slot um token pertence (ou null) - é a autorização inteira do
// fluxo público: só quem recebeu o link daquele papel sabe o token dele
function chaveDoToken(r, token) {
  if (!r || !token) return null;
  const achado = Object.entries(r.assinaturas || {}).find(([, a]) => a.token === token);
  return achado ? achado[0] : null;
}

// o que a página pública de assinatura (assinar.html) enxerga: o formulário
// inteiro pra conferência, o papel de QUEM abriu (pelo token) e o andamento
// dos outros papéis (sem tokens - um assinante não vê o link dos outros)
async function vistaPublica(id, token) {
  const r = await getOne(id);
  const chave = chaveDoToken(r, token);
  if (!chave) return null;
  const a = r.assinaturas[chave];
  return {
    id: r.id, tipo: r.tipo, rotuloTipo: TIPOS[r.tipo].rotulo, titulo: TIPOS[r.tipo].titulo,
    unidade: r.unidade, razaoSocial: r.razaoSocial || null, campos: r.campos, linhas: r.linhas, valorTotal: r.valorTotal,
    colunas: TIPOS[r.tipo].colunas, cabecalho: TIPOS[r.tipo].cabecalho,
    status: r.status, criadoEm: r.criadoEm,
    anexos: (r.anexos || []).map((an, i) => ({ nome: an.nome, indice: i })),
    meuPapel: chave, meuRotulo: rotuloDoSlot(r.tipo, chave, a.rotulo), jaAssinei: !!a.imagem,
    assinaturas: Object.entries(r.assinaturas).map(([k, s]) => ({ rotulo: rotuloDoSlot(r.tipo, k, s.rotulo), assinado: !!s.imagem })),
  };
}

async function assinar(id, token, { nome, imagem } = {}) {
  const r = await getOne(id);
  const chave = chaveDoToken(r, token);
  if (!chave) throw new Error('Link de assinatura inválido ou revogado.');
  const a = r.assinaturas[chave];
  if (a.imagem) throw new Error('Essa assinatura já foi registrada.');
  const img = String(imagem || '');
  if (!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(img)) throw new Error('Assinatura inválida - desenhe no quadro e tente de novo.');
  if (img.length > MAX_IMAGEM_CHARS) throw new Error('Assinatura grande demais - limpe o quadro e assine de novo.');

  const assinaturas = { ...r.assinaturas, [chave]: { ...a, imagem: img, nome: limpar(nome, 80) || null, assinadoEm: new Date().toISOString() } };
  const completo = Object.values(assinaturas).every((s) => !!s.imagem);
  await COLLECTION.doc(id).update({ assinaturas, status: completo ? 'ASSINADO' : 'PENDENTE' });
  cache.invalidar();
  return { ok: true, chave, completo };
}

// só Master apaga (formulário financeiro é registro - apagar é exceção)
async function remover(id) {
  await COLLECTION.doc(id).delete();
  cache.invalidar();
  return { id };
}

// ---------------------------------------------------------------
// PDF: reproduz o layout do formulário em papel, com cada assinatura já
// desenhada NA POSIÇÃO dela (rodapé por papel; nas diárias, dentro da
// própria linha da tabela).
// ---------------------------------------------------------------
function imagemBuffer(dataUrl) {
  try { return Buffer.from(String(dataUrl).split(',')[1], 'base64'); } catch (e) { return null; }
}

// cores fiéis ao papel original do Grupo Bravo Empresarial (a holding
// administrativa por trás de todas as unidades - por isso o bloco de
// identidade no canto é sempre o mesmo, independente de qual unidade foi
// escolhida): faixa azul-escura nos rótulos/título, azul-clara no
// cabeçalho da tabela e na linha de total, grade em azul-acinzentado
const AZUL_ESCURO = '#1F4E79';
const AZUL_CLARO = '#DCE6F1';
const BORDA = '#8EA9C7';

function gerarPdf(r, res) {
  const modelo = TIPOS[r.tipo];
  const doc = new PDFDocument({ margin: 40, size: 'A4' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${r.tipo}-${r.unidade.replace(/[^a-zA-Z0-9-]+/g, '_')}.pdf"`);
  doc.pipe(res);

  const X = doc.page.margins.left;
  const LARGURA = doc.page.width - X * 2;
  let y = doc.page.margins.top;

  // bloco de cabeçalho: faixa de campos (rótulo azul + valor) à esquerda,
  // logo do grupo à direita - mesma diagramação do papel original
  const LOGO_W = 130;
  const CAMPOS_W = LARGURA - LOGO_W;
  const LABEL_W = CAMPOS_W * 0.28;
  const VALUE_W = CAMPOS_W - LABEL_W;
  const ROW_H = 24;
  const ROW_H_COMBO = 30;

  // Banco/Agência/Conta viram UMA linha "DADOS BANCÁRIOS" com 3 sub-campos
  // lado a lado (igual ao papel), em vez de 3 linhas separadas
  const linhasCabecalho = [{ label: 'UNIDADE', valor: r.unidade, h: ROW_H }];
  if (r.razaoSocial && r.razaoSocial !== r.unidade) linhasCabecalho.push({ label: 'RAZÃO SOCIAL', valor: r.razaoSocial, h: ROW_H });
  const campos = [...modelo.cabecalho];
  for (let i = 0; i < campos.length; i++) {
    const c = campos[i];
    if (c.key === 'banco' && campos[i + 1] && campos[i + 1].key === 'agencia' && campos[i + 2] && campos[i + 2].key === 'conta') {
      linhasCabecalho.push({
        label: 'DADOS BANCÁRIOS', h: ROW_H_COMBO,
        combo: [
          { label: 'Banco:', valor: r.campos.banco },
          { label: 'Agência:', valor: r.campos.agencia },
          { label: 'Conta com dígito:', valor: r.campos.conta },
        ],
      });
      i += 2;
      continue;
    }
    linhasCabecalho.push({ label: c.label, valor: r.campos[c.key], h: ROW_H });
  }

  let ry = y;
  linhasCabecalho.forEach((linha) => {
    doc.rect(X, ry, LABEL_W, linha.h).fillAndStroke(AZUL_ESCURO, AZUL_ESCURO);
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#fff').text(linha.label, X + 6, ry + linha.h / 2 - 4, { width: LABEL_W - 10, ellipsis: true });
    if (linha.combo) {
      const subW = VALUE_W / linha.combo.length;
      linha.combo.forEach((s, i) => {
        const sx = X + LABEL_W + subW * i;
        doc.rect(sx, ry, subW, linha.h).stroke(BORDA);
        doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#555').text(s.label, sx + 5, ry + 5, { width: subW - 10, ellipsis: true });
        doc.font('Helvetica').fontSize(8.5).fillColor('#000').text(s.valor || '', sx + 5, ry + 16, { width: subW - 10, ellipsis: true });
      });
    } else {
      doc.rect(X + LABEL_W, ry, VALUE_W, linha.h).stroke(BORDA);
      doc.font('Helvetica').fontSize(9).fillColor('#000').text(linha.valor || '', X + LABEL_W + 6, ry + linha.h / 2 - 4, { width: VALUE_W - 12, ellipsis: true });
    }
    ry += linha.h;
  });

  // logo/identidade do grupo (fixa, não muda por unidade)
  const alturaHeader = ry - y;
  const logoX = X + CAMPOS_W;
  doc.rect(logoX, y, LOGO_W, alturaHeader).stroke(AZUL_ESCURO);
  const cy = y + alturaHeader / 2;
  doc.font('Helvetica').fontSize(7).fillColor('#8a8a8a').text('GRUPO', logoX, cy - 20, { width: LOGO_W, align: 'center', characterSpacing: 2 });
  doc.font('Helvetica-Bold').fontSize(17).fillColor('#1a1a1a').text('BRAVO', logoX, cy - 11, { width: LOGO_W, align: 'center' });
  doc.font('Helvetica').fontSize(6).fillColor('#8a8a8a').text('EMPRESARIAL', logoX, cy + 10, { width: LOGO_W, align: 'center', characterSpacing: 1.5 });

  y = ry + 10;

  // barra de título, largura cheia, igual ao papel
  doc.rect(X, y, LARGURA, 22).fillAndStroke(AZUL_ESCURO, AZUL_ESCURO);
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#fff').text(modelo.titulo, X, y + 6, { width: LARGURA, align: 'center' });
  // Ticket # encostado à direita DENTRO da mesma barra: o título continua
  // centralizado na largura cheia, igual ao papel original, e o número não
  // empurra nada. É o mesmo número que a solicitação de Pagamento vai ter.
  if (r.numeroTicket != null) {
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#cfe3ff')
      .text(`Ticket #${r.numeroTicket}`, X, y + 7.5, { width: LARGURA - 8, align: 'right' });
  }
  y += 22;

  // larguras das colunas: VALOR fixa, ASSINATURA (diárias) fixa, DESCRIÇÃO
  // ganha o dobro do peso, o resto divide por igual
  const colunas = [...modelo.colunas];
  if (modelo.assinaturaPorLinha) colunas.push({ key: '_assinatura', label: 'ASSINATURA' });
  const fixas = { valor: 70, _assinatura: 110 };
  const larguraFixa = colunas.reduce((s, c) => s + (fixas[c.valor ? 'valor' : c.key] || 0), 0);
  const pesoTotal = colunas.reduce((s, c) => s + (fixas[c.valor ? 'valor' : c.key] ? 0 : (c.larga ? 2 : 1)), 0);
  const larguras = colunas.map((c) => fixas[c.valor ? 'valor' : c.key] || ((LARGURA - larguraFixa) / pesoTotal) * (c.larga ? 2 : 1));

  const alturaLinha = modelo.assinaturaPorLinha ? 40 : 26;
  const celula = (texto, x, yy, w, h, opts = {}) => {
    if (opts.fill) doc.rect(x, yy, w, h).fillAndStroke(opts.fill, BORDA);
    else doc.rect(x, yy, w, h).stroke(BORDA);
    doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor('#000')
      .text(String(texto == null ? '' : texto), x + 4, yy + (opts.meio ? (h - 9) / 2 : 5), { width: w - 8, height: h - 8, ellipsis: true, align: opts.align || 'left' });
  };

  // cabeçalho da tabela
  let x = X;
  colunas.forEach((c, i) => {
    doc.rect(x, y, larguras[i], 22).fillAndStroke(AZUL_CLARO, BORDA);
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#000').text(c.label, x + 3, y + 7, { width: larguras[i] - 6, align: 'center', height: 14, ellipsis: true });
    x += larguras[i];
  });
  y += 22;

  // linhas (com a assinatura do diarista dentro da célula, quando houver)
  r.linhas.forEach((l, idx) => {
    x = X;
    colunas.forEach((c, i) => {
      if (c.key === '_assinatura') {
        doc.rect(x, y, larguras[i], alturaLinha).stroke('#444');
        const ass = (r.assinaturas || {})[`linha-${idx}`];
        const buf = ass && ass.imagem ? imagemBuffer(ass.imagem) : null;
        if (buf) { try { doc.image(buf, x + 4, y + 3, { fit: [larguras[i] - 8, alturaLinha - 6], align: 'center', valign: 'center' }); } catch (e) { /* imagem corrompida não derruba o PDF */ } }
      } else {
        celula(c.valor ? fmtMoney(l[c.key]) : l[c.key], x, y, larguras[i], alturaLinha, { meio: true, align: c.valor ? 'right' : 'left' });
      }
      x += larguras[i];
    });
    y += alturaLinha;
  });

  // total
  const larguraValor = larguras[colunas.findIndex((c) => c.valor)];
  const larguraRotulo = 200;
  const xValor = X + larguras.slice(0, colunas.findIndex((c) => c.valor)).reduce((s, w) => s + w, 0);
  celula(modelo.totalRotulo, xValor - larguraRotulo, y, larguraRotulo, 24, { bold: true, meio: true, align: 'right', fill: AZUL_CLARO });
  celula(fmtMoney(r.valorTotal), xValor, y, larguraValor, 24, { bold: true, meio: true, align: 'right', fill: AZUL_CLARO });
  y += 60;

  // assinaturas do rodapé: 1 centralizada ou 2 lado a lado, imagem em cima
  // da linha e o rótulo embaixo - a posição que o formulário em papel usa
  const papeis = modelo.assinantes;
  const larguraBloco = 210;
  const posicoes = papeis.length === 1
    ? [X + (LARGURA - larguraBloco) / 2]
    : [X + 20, X + LARGURA - larguraBloco - 20];
  const yAssin = Math.max(y + 40, 620);
  papeis.forEach((p, i) => {
    const bx = posicoes[i];
    const ass = (r.assinaturas || {})[p.papel];
    const buf = ass && ass.imagem ? imagemBuffer(ass.imagem) : null;
    if (buf) { try { doc.image(buf, bx + 15, yAssin - 52, { fit: [larguraBloco - 30, 50] }); } catch (e) { /* segue sem a imagem */ } }
    doc.moveTo(bx, yAssin).lineTo(bx + larguraBloco, yAssin).lineWidth(0.8).stroke('#000');
    doc.font('Helvetica').fontSize(9).fillColor('#000').text(p.rotulo, bx, yAssin + 5, { width: larguraBloco, align: 'center' });
    if (ass && ass.nome) doc.fontSize(7.5).fillColor('#555').text(`${ass.nome}${ass.assinadoEm ? ' · ' + new Date(ass.assinadoEm).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : ''}`, bx, yAssin + 17, { width: larguraBloco, align: 'center' });
  });

  if (modelo.obs) {
    doc.font('Helvetica-Oblique').fontSize(8).fillColor('#333').text(modelo.obs, X, yAssin + 40, { width: LARGURA });
  }
  if ((r.anexos || []).length) {
    doc.font('Helvetica').fontSize(8).fillColor('#333')
      .text(`Anexos (${r.anexos.length}): ${r.anexos.map((a) => a.nome).join(' · ')}`, X, yAssin + (modelo.obs ? 62 : 40), { width: LARGURA });
  }

  doc.end();
}

module.exports = { TIPOS, UNIDADES_FORM, buscarFavorecido, criar, listar, detalhar, getOne, vistaPublica, assinar, remover, gerarPdf, chaveDoToken, parseValor,
  criarParaPreenchimento, vistaPreenchimento, salvarPreenchimento, cancelarPreenchimento,
};
