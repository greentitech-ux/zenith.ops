// rh.js
// Modulo de RH: ficha de funcionarios (extras e efetivos) por loja, sem
// exigir login no Zenith - a maioria de quem trabalha na loja (extra,
// cozinha, entregador) nunca acessa o sistema, entao esse cadastro e
// independente de users.js. Cobre as frentes pedidas pelo usuario:
// - Cadastro no 1o dia (nome, contato, curriculo), com 2 tipos (tipoCadastro):
//   "extra" (avulso, ja entra direto como ativo - so precisa de visibilidade
//   de quem esta atuando na loja) e "candidato" (vai pro teste de 5 dias -
//   fica em status "candidato", FORA da Ficha de Ativos, ate a decisao).
// - Acompanhamento de teste: quem esta em periodo de experiencia (emTeste)
//   gera um alerta automatico no 5o dia (ver verificarTestesVencidos,
//   chamado por um job periodico em index.js) - decisao "efetivar" promove
//   o candidato pra status "ativo" (entra na Ficha de Ativos); "desligar"
//   marca "inativo".
// - Atestado: funcionario ativo pode ser marcado como afastado (emAtestado)
//   sem contar como desligamento - da visibilidade de quantos estao de
//   atestado agora (card do Painel) e guarda o historico de quando voltou.
// - Experiencia formal (CLT): todo mundo que vira efetivado (direto ou
//   promovido do teste de 5 dias) entra automaticamente numa 1a etapa de 30
//   dias; ao vencer, decide se renova por mais 60 (total 90) ou efetiva/
//   desliga direto. Alerta escalonado em D-5/D-3/D-2/D-1 (ver
//   verificarAlertasExperiencia, chamado por job periodico em index.js) -
//   D-1 tambem avisa o gerente da unidade, nao so RH/Master.
// - Ficha de Funcionarios Ativos + Aniversariante do Dia (calculado sobre a
//   mesma ficha, sem colecao propria).
const crypto = require('crypto');
const db = require('./firestore');
const { createCache } = require('./liveCache');

const COLLECTION = db.collection('rhFuncionarios');

const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;
const DECISOES_VALIDAS = ['efetivar', 'desligar'];

// dias corridos desde a admissao ate a decisao virar exigivel - pedido
// explicito do usuario ("no 5o dia")
const DIAS_TESTE_ALERTA = 5;

// experiencia formal (CLT) em 2 etapas: 30 dias, e se renovar, mais 60
// (total ate 90) - pedido explicito do usuario
const DIAS_EXPERIENCIA = { 30: 30, 60: 60 };
const DECISOES_EXPERIENCIA_30 = ['renovar', 'efetivar', 'desligar'];
const DECISOES_EXPERIENCIA_60 = ['efetivar', 'desligar'];
// avisos escalonados conforme pedido do usuario: 5, 3, 2 e 1 dia antes do
// vencimento - no ultimo (1) o gerente da unidade tambem e avisado, alem
// de RH/Admin/Master; o dia do proprio vencimento (0) fica so como o prazo
// em que a decisao e cobrada, sem alerta novo nele
const ALERTA_EXPERIENCIA_DIAS = [5, 3, 2, 1];

function limpar(v, max) {
  return String(v || '').trim().slice(0, max);
}

// nome "achatado" so pra comparar (case/espacos nao contam) - usado pra
// travar cadastro duplicado da mesma pessoa na mesma loja
function normalizarNome(v) {
  return String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function validarDataOuNull(v, campo) {
  if (v == null || v === '') return null;
  if (!DATA_RE.test(v)) throw new Error(`${campo} inválida. Use o formato AAAA-MM-DD.`);
  return v;
}

// ancora no meio-dia de proposito: com T00:00:00 o toISOString() volta um
// dia se o processo rodar num fuso a leste de UTC (hoje o servidor e UTC e
// nao faz diferenca, mas soma de datas nao deve depender do fuso da maquina)
function calcularPrazoExperiencia(inicioIso, etapa) {
  const d = new Date(`${inicioIso}T12:00:00`);
  d.setDate(d.getDate() + (DIAS_EXPERIENCIA[etapa] || 30));
  return d.toISOString().slice(0, 10);
}

function iniciarExperiencia(inicioIso) {
  return { etapa: '30', inicioEtapa: inicioIso, prazoEtapaAte: calcularPrazoExperiencia(inicioIso, '30'), alertasEnviados: [] };
}

// coloca a experiencia formal na etapa CERTA pra quando a admissao ja nao e
// hoje (contratacao direta de alguem que ja esta trabalhando ha alguns dias,
// ou backfill) - sem isso, todo mundo sempre entrava na etapa 30 com prazo
// admissao+30, que podia nascer ja vencido se a admissao fosse antiga:
// - menos de 30 dias corridos desde a admissao: etapa 30 normal, prazo
//   admissao+30 (continua a contagem de onde ela esta, nao reinicia)
// - de 30 a 89 dias: ja passou da 1a etapa - entra direto na etapa 60, com
//   inicio em admissao+30 e prazo em admissao+90 (30 + 60 = janela total da
//   experiencia formal), como se tivesse sido renovada no prazo certo
// - 90 dias ou mais: a janela toda (90 dias) ja passou antes do cadastro -
//   nao da pra cobrar um prazo que ja passou, entao fica sem experiencia
//   automatica (usar definirExperiencia se precisar registrar manualmente)
// semExperiencia (checkbox do cadastro) sempre vence: contratacao direta sem
// passar pelo periodo de experiencia
function calcularExperienciaInicial(dataAdmissaoIso, semExperiencia) {
  if (semExperiencia) return null;
  const dias = diasDesde(dataAdmissaoIso);
  if (dias < 30) return iniciarExperiencia(dataAdmissaoIso);
  if (dias < 90) {
    const inicioEtapa60 = calcularPrazoExperiencia(dataAdmissaoIso, '30');
    return { etapa: '60', inicioEtapa: inicioEtapa60, prazoEtapaAte: calcularPrazoExperiencia(inicioEtapa60, '60'), alertasEnviados: [] };
  }
  return null;
}

// inverso de calcularPrazoExperiencia - a partir do PRAZO (termino), calcula
// o inicio da etapa. Usado no ajuste manual (definirExperiencia): quem esta
// corrigindo ja sabe o termino de cor (vem do relatorio da folha de
// pagamento/contabilidade) - pedir pra calcular o inicio de cabeca seria
// entregar conta pro usuario fazer
function calcularInicioAPartirDoPrazo(prazoIso, etapa) {
  const d = new Date(`${prazoIso}T12:00:00`); // meio-dia - mesmo motivo de calcularPrazoExperiencia
  d.setDate(d.getDate() - (DIAS_EXPERIENCIA[etapa] || 30));
  return d.toISOString().slice(0, 10);
}

// "efetivado" e restrito: so Master/Admin/quem tem a tag podeRhCadastrarEfetivado
// pode usar (ver podeCadastrarEfetivado em index.js) - a loja (gerente comum,
// so com a secao 'rh') cadastra Extra ou Candidato, nunca pula direto pra
// "ja efetivado"
const TIPOS_CADASTRO = ['extra', 'candidato', 'efetivado'];

async function criar({
  unidade, nome, contato, cargoFuncao, dataNascimento, dataAdmissao, tipoCadastro, semExperiencia,
  curriculo, cadastradoPorId, cadastradoPorEmail, precisaAprovacao, exigirCurriculo = true,
}) {
  if (!unidade) throw new Error('Unidade é obrigatória.');
  const nomeOk = limpar(nome, 150);
  if (!nomeOk) throw new Error('Informe o nome completo.');
  // curriculo obrigatorio no cadastro novo (pedido explicito do usuario) -
  // exceto na importacao em lote (importarLote), que e backfill de gente que
  // ja trabalha ha tempo, sem anexo pra exigir retroativamente
  if (exigirCurriculo && !curriculo) throw new Error('Anexe o currículo (obrigatório).');
  // trava cadastro duplicado (2 cliques no botao, ou reenvio do mesmo
  // formulario) - mesmo nome (sem diferenciar espaco/maiuscula) numa ficha
  // ainda ativa na MESMA loja nao entra de novo; alguem desligado pode ser
  // recadastrado sem problema (nao e mais o "mesmo" cadastro em uso)
  const nomeNormalizado = normalizarNome(nomeOk);
  const jaExiste = (await listAll()).some((f) => (
    f.unidade === unidade && f.status !== 'inativo' && normalizarNome(f.nome) === nomeNormalizado
  ));
  if (jaExiste) throw new Error(`"${nomeOk}" já está cadastrado nessa loja - confira na lista antes de cadastrar de novo.`);
  const tipo = TIPOS_CADASTRO.includes(tipoCadastro) ? tipoCadastro : 'extra';
  // extra (avulso) e efetivado (contratacao direta) ja entram como ativo -
  // nao passam por decisao de contratacao. candidato (teste de 5 dias) so
  // vira "ativo" quando efetivado (ver registrarDecisaoTeste) - ate la fica
  // de fora da Ficha de Ativos, so aparece em Acompanhamento de Teste
  // precisaAprovacao (calculado por quem chama, ver index.js): cadastro feito
  // por quem NAO e Master/Admin/RH fica "pendente_aprovacao" ate o RH/Admin/
  // Master decidir (ver aprovarCadastro/reprovarCadastro) - so entao segue
  // pro status que teria desde o inicio (ativo ou candidato+emTeste)
  const aguardandoAprovacao = !!precisaAprovacao;
  const emTeste = !aguardandoAprovacao && tipo === 'candidato';
  const status = aguardandoAprovacao ? 'pendente_aprovacao' : (tipo === 'candidato' ? 'candidato' : 'ativo');
  const semExperienciaOk = !!semExperiencia;

  const ref = COLLECTION.doc();
  const agora = new Date().toISOString();
  const dataAdmissaoOk = validarDataOuNull(dataAdmissao, 'Data de admissão') || agora.slice(0, 10);
  const registro = {
    id: ref.id,
    unidade,
    nome: nomeOk,
    contato: limpar(contato, 40),
    cargoFuncao: limpar(cargoFuncao, 60),
    dataNascimento: validarDataOuNull(dataNascimento, 'Data de nascimento'),
    dataAdmissao: dataAdmissaoOk,
    curriculo: curriculo || null,
    tipoCadastro: tipo,
    emTeste,
    status,
    feedbackTeste: null,
    alertaTesteEnviadoEm: null,
    desligadoEm: null,
    emAtestado: false,
    atestadoAtual: null,
    atestados: [],
    // efetivado direto ja entra na experiencia formal, na etapa certa pra
    // idade da admissao (calcularExperienciaInicial); candidato so entra
    // nisso quando efetivado no fim do teste de 5 dias (ver
    // registrarDecisaoTeste) - extra nunca entra, nao tem esse vinculo.
    // semExperiencia (checkbox do cadastro) pula tudo isso - contratacao
    // direta sem periodo de experiencia
    semExperiencia: semExperienciaOk,
    experiencia: tipo === 'efetivado' ? calcularExperienciaInicial(dataAdmissaoOk, semExperienciaOk) : null,
    historicoExperiencia: [],
    // token permanente do link de auto-atendimento (rh-colaborador.html) -
    // a pessoa bate ponto sem precisar de login no Zenith (ver
    // buscarPorToken); nao expira sozinho, so quem tem acesso a unidade
    // pode regenerar (ver regenerarLink) se o link vazar
    linkToken: crypto.randomBytes(24).toString('hex'),
    cadastradoPorId: cadastradoPorId || null,
    cadastradoPorEmail: cadastradoPorEmail || null,
    // preenchido so quando o cadastro passou pelo gate de aprovacao (ver
    // aprovarCadastro/reprovarCadastro) - null pra quem nunca precisou
    aprovacaoCadastro: null,
    criadoEm: agora,
    atualizadoEm: agora,
  };
  await ref.set(registro);
  rhCache.invalidar();
  return registro;
}

// cadastros feitos pela loja ou pelo link publico, ainda aguardando o RH/
// Admin/Master decidir (ver POST /api/rh/funcionarios em index.js pra saber
// quando um cadastro entra nesse estado) - usado na aba Aprovacoes
async function listPendentesAprovacaoCadastro() {
  return (await listAll()).filter((f) => f.status === 'pendente_aprovacao');
}

// aprova um cadastro pendente - promove pro status que o tipo de cadastro ja
// preveria desde o inicio (candidato entra no teste de 5 dias, extra/
// efetivado ja fica ativo), exatamente como se nao tivesse passado pelo gate
async function aprovarCadastro(id, { porEmail }) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Funcionário não encontrado.');
  const atual = snap.data();
  if (atual.status !== 'pendente_aprovacao') throw new Error('Esse cadastro já foi decidido.');
  const agora = new Date().toISOString();
  await ref.update({
    status: atual.tipoCadastro === 'candidato' ? 'candidato' : 'ativo',
    emTeste: atual.tipoCadastro === 'candidato',
    aprovacaoCadastro: { aprovado: true, porEmail: porEmail || null, decididoEm: agora },
    atualizadoEm: agora,
  });
  rhCache.invalidar();
  return getOne(id);
}

// reprova - entra direto como inativo (nunca chega a ficar ativo/em teste),
// pedido explicito do usuario
async function reprovarCadastro(id, { porEmail, motivo }) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Funcionário não encontrado.');
  const atual = snap.data();
  if (atual.status !== 'pendente_aprovacao') throw new Error('Esse cadastro já foi decidido.');
  const agora = new Date().toISOString();
  await ref.update({
    status: 'inativo',
    emTeste: false,
    desligadoEm: agora,
    aprovacaoCadastro: { aprovado: false, motivo: limpar(motivo, 500), porEmail: porEmail || null, decididoEm: agora },
    atualizadoEm: agora,
  });
  rhCache.invalidar();
  return getOne(id);
}

async function listAllUncached() {
  const snap = await COLLECTION.orderBy('criadoEm', 'desc').get();
  return snap.docs.map((d) => d.data());
}
const rhCache = createCache(listAllUncached, 60 * 1000);
const listAll = rhCache.cached;

// mesmo padrao de festas.js: filtra em memoria sobre o cache compartilhado -
// evita uma query direta por unidade (where in) que passaria por fora do
// cache e viraria leitura completa no Firestore a cada chamada
async function listByUnidades(unidades) {
  if (!unidades || !unidades.length) return [];
  const alvo = new Set(unidades);
  return (await listAll()).filter((r) => alvo.has(r.unidade));
}

async function getOne(id) {
  const doc = await COLLECTION.doc(id).get();
  return doc.exists ? doc.data() : null;
}

// resolve o funcionario a partir do token do link de auto-atendimento
// (rh-colaborador.html) - filtra em memoria sobre o cache compartilhado,
// mesmo padrao das outras buscas desse modulo; nao expoe MOTIVO nenhum de
// falha (token errado e funcionario inexistente devolvem a mesma coisa: null)
async function buscarPorToken(token) {
  if (!token) return null;
  const todos = await listAll();
  return todos.find((f) => f.linkToken === token) || null;
}

async function atualizar(id, patch) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Funcionário não encontrado.');
  const merge = { atualizadoEm: new Date().toISOString() };

  if (patch.nome !== undefined) {
    const nomeOk = limpar(patch.nome, 150);
    if (!nomeOk) throw new Error('Informe o nome completo.');
    merge.nome = nomeOk;
  }
  if (patch.contato !== undefined) merge.contato = limpar(patch.contato, 40);
  if (patch.cargoFuncao !== undefined) merge.cargoFuncao = limpar(patch.cargoFuncao, 60);
  if (patch.dataNascimento !== undefined) merge.dataNascimento = validarDataOuNull(patch.dataNascimento, 'Data de nascimento');
  if (patch.dataAdmissao !== undefined) merge.dataAdmissao = validarDataOuNull(patch.dataAdmissao, 'Data de admissão');
  if (patch.curriculo !== undefined) merge.curriculo = patch.curriculo;

  if (patch.status !== undefined) {
    if (!['candidato', 'ativo', 'inativo'].includes(patch.status)) throw new Error('Status inválido.');
    merge.status = patch.status;
    merge.desligadoEm = patch.status === 'inativo' ? new Date().toISOString() : null;
    // desligado nao esta em teste nem em experiencia - sem essa limpeza o
    // documento carregava esses estados pra sempre (e reativar a pessoa
    // depois voltava com um teste/experiencia fantasma de meses atras)
    if (patch.status === 'inativo') {
      merge.emTeste = false;
      merge.experiencia = null;
    }
  }

  // conversao de "extra" pra "efetivado" - so faz sentido nesse sentido (loja
  // as vezes esquece de trocar a aba no cadastro e a pessoa entra como avulso
  // quando na verdade e um contratado direto); ao converter, entra na
  // experiencia formal na etapa certa pra idade da admissao (mesma regra de
  // calcularExperienciaInicial usada no cadastro direto)
  if (patch.tipoCadastro !== undefined && patch.tipoCadastro !== snap.data().tipoCadastro) {
    if (snap.data().tipoCadastro !== 'extra' || patch.tipoCadastro !== 'efetivado') {
      throw new Error('Só é possível converter um cadastro "extra" em "efetivado".');
    }
    merge.tipoCadastro = 'efetivado';
    const inicio = merge.dataAdmissao || snap.data().dataAdmissao || new Date().toISOString().slice(0, 10);
    const semExp = patch.semExperiencia !== undefined ? !!patch.semExperiencia : !!snap.data().semExperiencia;
    merge.semExperiencia = semExp;
    merge.experiencia = calcularExperienciaInicial(inicio, semExp);
  }

  // ajuste isolado do checkbox "sem período de experiência" (sem trocar
  // tipoCadastro) - o gerente marcou errado no cadastro e o Master corrige
  // depois; recalcula a experiencia na hora, pra nao deixar uma etapa antiga
  // pendurada quando a pessoa vira "sem experiencia" (ou vice-versa)
  if (patch.semExperiencia !== undefined && merge.tipoCadastro === undefined) {
    const semExp = !!patch.semExperiencia;
    merge.semExperiencia = semExp;
    const atual = snap.data();
    if (atual.tipoCadastro === 'efetivado' && atual.status === 'ativo' && patch.status !== 'inativo') {
      const admissaoFinal = merge.dataAdmissao || atual.dataAdmissao;
      merge.experiencia = calcularExperienciaInicial(admissaoFinal, semExp);
    }
  }

  await ref.update(merge);
  rhCache.invalidar();
  return getOne(id);
}

// gera um token novo pro link de auto-atendimento, invalidando o antigo -
// usado se o link vazar (a pessoa perdeu o celular, mandou pro grupo errado
// etc): quem tinha o link velho perde o acesso, o gerente manda o novo
async function regenerarLink(id) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Funcionário não encontrado.');
  const linkToken = crypto.randomBytes(24).toString('hex');
  await ref.update({ linkToken, atualizadoEm: new Date().toISOString() });
  rhCache.invalidar();
  return getOne(id);
}

// registra a decisao do periodo de teste (efetivar/desligar) - tira
// emTeste (o card some da aba de Acompanhamento) e muda o status: efetivar
// promove o candidato pra "ativo" (agora entra na Ficha de Funcionarios
// Ativos); desligar marca "inativo" direto (evita passo duplicado)
async function registrarDecisaoTeste(id, { decisao, observacao, porEmail }) {
  if (!DECISOES_VALIDAS.includes(decisao)) throw new Error('Decisão inválida. Use "efetivar" ou "desligar".');
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Funcionário não encontrado.');
  // decisao e uma so - sem essa guarda, decidir de novo sobrescreveria o
  // feedback original em silencio (e um "efetivar" tardio reativaria quem
  // ja foi desligado)
  if (!snap.data().emTeste) throw new Error('Esse funcionário não está mais em período de teste.');
  const agora = new Date().toISOString();
  const merge = {
    emTeste: false,
    feedbackTeste: { decisao, observacao: limpar(observacao, 500), decididoPorEmail: porEmail || null, decididoEm: agora },
    atualizadoEm: agora,
  };
  if (decisao === 'efetivar') {
    merge.status = 'ativo';
    // aprovado no teste de 5 dias -> entra na 1a etapa da experiencia
    // formal de 30 dias, mesmo tratamento de quem foi cadastrado direto
    // como efetivado
    merge.experiencia = iniciarExperiencia(agora.slice(0, 10));
  } else {
    merge.status = 'inativo';
    merge.desligadoEm = agora;
  }
  await ref.update(merge);
  rhCache.invalidar();
  return getOne(id);
}

// registra a decisao da etapa atual de experiencia formal (30 ou 60 dias):
// - "renovar" (so vale na etapa de 30): fecha a etapa e abre a de 60 (total
//   90 dias corridos desde o inicio da 1a etapa)
// - "efetivar": fecha a experiencia, o colaborador segue "ativo" normal
// - "desligar": fecha a experiencia e desliga (status "inativo")
async function registrarDecisaoExperiencia(id, { decisao, observacao, porEmail }) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Funcionário não encontrado.');
  const atual = snap.data();
  if (!atual.experiencia || !atual.experiencia.etapa) throw new Error('Esse colaborador não está em período de experiência.');
  const etapa = atual.experiencia.etapa;
  const validas = etapa === '30' ? DECISOES_EXPERIENCIA_30 : DECISOES_EXPERIENCIA_60;
  if (!validas.includes(decisao)) throw new Error(`Decisão inválida pra etapa de ${etapa} dias. Use: ${validas.join(', ')}.`);
  const agora = new Date().toISOString();
  const historicoEntry = {
    etapa,
    inicioEtapa: atual.experiencia.inicioEtapa,
    prazoEtapaAte: atual.experiencia.prazoEtapaAte,
    decisao,
    observacao: limpar(observacao, 500),
    porEmail: porEmail || null,
    decididoEm: agora,
  };
  const merge = {
    historicoExperiencia: [...(atual.historicoExperiencia || []), historicoEntry],
    atualizadoEm: agora,
  };
  if (decisao === 'renovar') {
    merge.experiencia = { etapa: '60', inicioEtapa: agora.slice(0, 10), prazoEtapaAte: calcularPrazoExperiencia(agora.slice(0, 10), '60'), alertasEnviados: [] };
  } else if (decisao === 'efetivar') {
    merge.experiencia = null;
  } else {
    merge.experiencia = null;
    merge.status = 'inativo';
    merge.desligadoEm = agora;
  }
  await ref.update(merge);
  rhCache.invalidar();
  return getOne(id);
}

// ajuste manual (Master) do estagio de experiencia - pra backfill de quem
// ja estava em experiencia formal antes dessa feature existir no Zenith
// (ex: importar de um relatorio da folha de pagamento) ou pra corrigir um
// prazo lancado errado. Sobrescreve a experiencia atual direto, sem passar
// pelo fluxo normal de decisao - fica registrado no historico com
// tipo:'ajuste_manual' pra distinguir de uma decisao de verdade
async function definirExperiencia(id, { etapa, prazoEtapaAte, porEmail }) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Funcionário não encontrado.');
  const atual = snap.data();
  if (atual.status !== 'ativo' || atual.tipoCadastro === 'extra') throw new Error('Experiência formal é só pra colaborador efetivado.');
  const etapaOk = etapa === '60' ? '60' : '30';
  const prazoOk = validarDataOuNull(prazoEtapaAte, 'Prazo da etapa');
  if (!prazoOk) throw new Error('Informe o prazo (data de término) dessa etapa.');
  const agora = new Date().toISOString();
  const inicioEtapa = calcularInicioAPartirDoPrazo(prazoOk, etapaOk);
  const merge = {
    experiencia: { etapa: etapaOk, inicioEtapa, prazoEtapaAte: prazoOk, alertasEnviados: [] },
    historicoExperiencia: [...(atual.historicoExperiencia || []), {
      tipo: 'ajuste_manual', etapa: etapaOk, inicioEtapa, prazoEtapaAte: prazoOk, porEmail: porEmail || null, decididoEm: agora,
    }],
    atualizadoEm: agora,
  };
  await ref.update(merge);
  rhCache.invalidar();
  return getOne(id);
}

// importacao em lote (Master) - backfill de gente que ja trabalha na loja
// ha tempo mas nunca foi cadastrada no RH; cada linha vira 1 funcionario
// "efetivado" ja na etapa/prazo de experiencia informados (evita ter que
// cadastrar e depois ajustar a experiencia pessoa por pessoa na UI)
async function importarLote(linhas, { porEmail }) {
  const resultados = [];
  for (const linha of linhas || []) {
    const { unidade, nome, cargoFuncao, etapa, prazoEtapaAte, dataAdmissao, dataNascimento } = linha;
    try {
      const nomeOk = limpar(nome, 150);
      if (!nomeOk) throw new Error('nome vazio.');
      if (!unidade) throw new Error('unidade não reconhecida.');

      // modo "backfill simples" (sem etapa): a pessoa entra como efetivado JA
      // definitivo (semExperiencia) - NAO passa pela Experiencia formal de
      // 30+60 dias nem gera alerta de prazo. E o caminho pra cadastrar quem ja
      // trabalha ha tempo (a maior parte de um backfill de quadro existente).
      // admissao, nascimento e cargo sao opcionais - o que faltar fica em
      // branco (admissao cai no default de hoje, ver criar()).
      if (!etapa) {
        const registro = await criar({
          unidade, nome: nomeOk, cargoFuncao,
          dataAdmissao: dataAdmissao || null,
          dataNascimento: dataNascimento || null,
          tipoCadastro: 'efetivado', semExperiencia: true,
          cadastradoPorEmail: porEmail, exigirCurriculo: false,
        });
        resultados.push({ ok: true, nome: nomeOk, id: registro.id });
        continue;
      }

      // modo "em experiencia": entra na etapa/prazo informados (30 ou 60 dias)
      const etapaOk = etapa === '60' ? '60' : etapa === '30' ? '30' : null;
      if (!etapaOk) throw new Error('etapa inválida (use 30 ou 60).');
      const prazoOk = validarDataOuNull(prazoEtapaAte, 'prazo');
      if (!prazoOk) throw new Error('prazo inválido (use AAAA-MM-DD).');
      const inicioEtapa = calcularInicioAPartirDoPrazo(prazoOk, etapaOk);
      const registro = await criar({
        unidade, nome: nomeOk, cargoFuncao, tipoCadastro: 'efetivado',
        dataAdmissao: etapaOk === '30' ? inicioEtapa : (dataAdmissao || null),
        dataNascimento: dataNascimento || null,
        cadastradoPorEmail: porEmail, exigirCurriculo: false,
      });
      const merge = {
        experiencia: { etapa: etapaOk, inicioEtapa, prazoEtapaAte: prazoOk, alertasEnviados: [] },
        historicoExperiencia: [{ tipo: 'importacao_lote', etapa: etapaOk, inicioEtapa, prazoEtapaAte: prazoOk, porEmail: porEmail || null, decididoEm: new Date().toISOString() }],
      };
      await COLLECTION.doc(registro.id).update(merge);
      resultados.push({ ok: true, nome: nomeOk, id: registro.id });
    } catch (err) {
      resultados.push({ ok: false, nome: nome || '(sem nome)', erro: err.message });
    }
  }
  rhCache.invalidar();
  return resultados;
}

// limpeza pontual dos cadastros duplicados que existiam ANTES da trava em
// criar() (ver normalizarNome ali) - agrupa quem esta ativo por loja+nome e,
// pra cada grupo com mais de 1 ficha, mantem so uma: prioridade pra quem tem
// check-in FECHADO (entrada+saida completas - sinal de que e o cadastro que
// realmente foi usado no dia a dia); empate ou ninguem com check-in fechado,
// mantem o mais antigo (criadoEm). Os outros sao removidos junto com todos
// os check-ins deles (senao ficariam check-ins orfaos, principalmente um
// "aberto" que nunca mais fecharia por ninguem)
async function mesclarDuplicados(rhCheckin) {
  const todos = await listAll();
  const grupos = new Map();
  for (const f of todos) {
    if (f.status === 'inativo') continue;
    const chave = `${f.unidade}|${normalizarNome(f.nome)}`;
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(f);
  }
  const relatorio = [];
  for (const lista of grupos.values()) {
    if (lista.length < 2) continue;
    const comCheckins = await Promise.all(lista.map(async (funcionario) => ({
      funcionario,
      checkins: rhCheckin ? await rhCheckin.listPorFuncionario(funcionario.id) : [],
    })));
    comCheckins.sort((a, b) => {
      const aFechado = a.checkins.some((c) => c.status === 'fechado') ? 1 : 0;
      const bFechado = b.checkins.some((c) => c.status === 'fechado') ? 1 : 0;
      if (aFechado !== bFechado) return bFechado - aFechado;
      return String(a.funcionario.criadoEm).localeCompare(String(b.funcionario.criadoEm));
    });
    const [manter, ...remover] = comCheckins;
    for (const { funcionario, checkins } of remover) {
      for (const c of checkins) await rhCheckin.remover(c.id);
      await COLLECTION.doc(funcionario.id).delete();
    }
    relatorio.push({
      unidade: manter.funcionario.unidade,
      nome: manter.funcionario.nome,
      mantidoId: manter.funcionario.id,
      removidos: remover.map((r) => ({ id: r.funcionario.id, checkinsRemovidos: r.checkins.length })),
    });
  }
  if (relatorio.length) rhCache.invalidar();
  return relatorio;
}

async function remover(id) {
  const snap = await COLLECTION.doc(id).get();
  if (!snap.exists) throw new Error('Funcionário não encontrado.');
  await COLLECTION.doc(id).delete();
  rhCache.invalidar();
}

// atestado medico: o funcionario continua "ativo" (nao e desligamento), so
// fica marcado como afastado - da visibilidade de quantas pessoas estao de
// atestado agora (card do Painel) e guarda o historico pra quando ela voltar.
// So vale pra quem foi efetivado de verdade - extra (avulso) e candidato em
// teste de 5 dias nao tem vinculo pra isso. "efetivado" aqui cobre tanto
// quem foi cadastrado direto como efetivado quanto quem era candidato e foi
// aprovado no teste (tipoCadastro continua "candidato", so o status muda pra
// "ativo") - por isso o corte e por tipoCadastro !== 'extra', nao so status
async function registrarAtestado(id, { inicio, previsaoRetorno, porEmail }) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Funcionário não encontrado.');
  const atual = snap.data();
  if (atual.status !== 'ativo' || atual.tipoCadastro === 'extra') throw new Error('Atestado é só pra funcionário efetivado - não vale pra extra nem candidato em teste.');
  if (atual.emAtestado) throw new Error('Esse funcionário já está com atestado em aberto.');
  const inicioOk = validarDataOuNull(inicio, 'Data de início') || new Date().toISOString().slice(0, 10);
  const agora = new Date().toISOString();
  await ref.update({
    emAtestado: true,
    atestadoAtual: {
      inicio: inicioOk,
      previsaoRetorno: validarDataOuNull(previsaoRetorno, 'Previsão de retorno'),
      registradoPorEmail: porEmail || null,
      registradoEm: agora,
    },
    atualizadoEm: agora,
  });
  rhCache.invalidar();
  return getOne(id);
}

async function registrarRetornoAtestado(id, { porEmail }) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Funcionário não encontrado.');
  const atual = snap.data();
  if (!atual.emAtestado || !atual.atestadoAtual) throw new Error('Esse funcionário não está de atestado.');
  const agora = new Date().toISOString();
  const registroFechado = {
    ...atual.atestadoAtual,
    retorno: agora.slice(0, 10),
    marcadoRetornoPorEmail: porEmail || null,
  };
  await ref.update({
    emAtestado: false,
    atestadoAtual: null,
    atestados: [...(atual.atestados || []), registroFechado],
    atualizadoEm: agora,
  });
  rhCache.invalidar();
  return getOne(id);
}

function diasDesde(dataIso) {
  if (!dataIso) return 0;
  const inicio = new Date(`${dataIso}T00:00:00`);
  const hoje = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  hoje.setHours(0, 0, 0, 0);
  return Math.floor((hoje - inicio) / 86400000);
}

// quem completou (ou passou) os DIAS_TESTE_ALERTA desde a admissao, ainda
// em teste, sem decisao e sem alerta ja enviado - usado pelo job diario
// (ver rodarAlertaTesteRh em index.js) pra disparar o push uma unica vez
async function verificarTestesVencidos() {
  const todos = await listAllUncached();
  return todos.filter((f) => (
    f.status !== 'inativo' && f.emTeste && !f.feedbackTeste && !f.alertaTesteEnviadoEm
    && diasDesde(f.dataAdmissao) >= DIAS_TESTE_ALERTA
  ));
}

async function marcarAlertaTesteEnviado(id) {
  await COLLECTION.doc(id).update({ alertaTesteEnviadoEm: new Date().toISOString() });
  rhCache.invalidar();
}

// dias corridos ATE uma data (negativo = ja passou) - inverso de diasDesde,
// usado pro prazo de experiencia contar "quantos dias faltam"
function diasRestantesAte(dataIso) {
  if (!dataIso) return null;
  const alvo = new Date(`${dataIso}T00:00:00`);
  const hoje = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  hoje.setHours(0, 0, 0, 0);
  return Math.round((alvo - hoje) / 86400000);
}

// quem esta numa etapa de experiencia (30 ou 60 dias) com algum limite de
// aviso (5/3/2/1 dias antes do prazo) ja vencido e ainda nao notificado -
// pode retornar mais de 1 pendencia por pessoa se o job ficou parado (ex:
// servidor fora do ar) e mais de 1 limite foi ultrapassado de uma vez
async function verificarAlertasExperiencia() {
  const todos = await listAllUncached();
  const pendencias = [];
  for (const f of todos) {
    if (f.status !== 'ativo' || !f.experiencia || !f.experiencia.etapa) continue;
    const restantes = diasRestantesAte(f.experiencia.prazoEtapaAte);
    if (restantes == null) continue;
    const jaEnviados = f.experiencia.alertasEnviados || [];
    for (const limite of ALERTA_EXPERIENCIA_DIAS) {
      if (restantes <= limite && !jaEnviados.includes(limite)) {
        pendencias.push({ funcionario: f, diasRestantes: restantes, limite });
      }
    }
  }
  return pendencias;
}

async function marcarAlertaExperienciaEnviado(id, limite) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) return;
  const atual = snap.data();
  const jaEnviados = (atual.experiencia && atual.experiencia.alertasEnviados) || [];
  if (jaEnviados.includes(limite)) return;
  await ref.update({ 'experiencia.alertasEnviados': [...jaEnviados, limite] });
  rhCache.invalidar();
}

// aniversariantes: so compara mes/dia (sem janela de tolerancia, ao
// contrario do niver do Parque) - recebe a lista ja carregada pelo chamador
// pra nao repetir leitura do Firestore
function aniversariantesHoje(lista, dataRef) {
  const hoje = dataRef || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const [, mes, dia] = hoje.split('-');
  return (lista || []).filter((f) => {
    if (f.status !== 'ativo' || !f.dataNascimento) return false;
    const [, m, d] = f.dataNascimento.split('-');
    return m === mes && d === dia;
  });
}

module.exports = {
  DIAS_TESTE_ALERTA, TIPOS_CADASTRO, ALERTA_EXPERIENCIA_DIAS,
  criar, listAll, listByUnidades, getOne, atualizar, remover, mesclarDuplicados,
  buscarPorToken, regenerarLink,
  listPendentesAprovacaoCadastro, aprovarCadastro, reprovarCadastro,
  registrarDecisaoTeste, verificarTestesVencidos, marcarAlertaTesteEnviado,
  registrarAtestado, registrarRetornoAtestado,
  registrarDecisaoExperiencia, verificarAlertasExperiencia, marcarAlertaExperienciaEnviado, definirExperiencia,
  importarLote,
  diasDesde, diasRestantesAte, aniversariantesHoje,
  invalidar: () => rhCache.invalidar(),
};
