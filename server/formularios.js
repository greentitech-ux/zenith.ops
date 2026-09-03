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
const formulariosUnidades = require('./formulariosUnidades');
const { createCache } = require('./liveCache');
const ticketCounter = require('./ticketCounter');
const storage = require('./storage');

const COLLECTION = db.collection('formularios');
// memoria de FAVORECIDO por documento (CPF do favorecido no Reembolso,
// CNPJ do favorecido no Avulso): todo formulario criado grava/atualiza os
// dados bancarios daquele documento, e a tela preenche sozinha quando o
// mesmo CPF/CNPJ for digitado de novo (pedido do Master: "quando o CPF foi
// inserido ja, deixar salvo")
const FAVORECIDOS = db.collection('formularioFavorecidos');

// Modelo de cada tipo: campos do cabeçalho, colunas da tabela e quem
// assina - transcrição fiel dos 4 PDFs originais enviados pelo Master.
// `data: true` marca um campo/coluna como data de verdade (uma data só,
// não texto livre) - é o que faz formularios.html/preencher.html trocarem
// o input por um seletor de calendário de verdade em vez de caixa de
// texto. "DATA(S)" das diárias fica de fora de propósito: aceita mais de
// uma data junto (ex: "12/08, 13/08"), não dá pra representar num só
// calendário. `intervalo: true` é a variante de 2 datas (De/Até, ex: o
// Período do caixa do Depósito) - a tela troca por 2 seletores e junta num
// valor só antes de mandar. Os dois flags sempre chegam e saem daqui em
// DD/MM/AAAA (ou "DD/MM/AAAA a DD/MM/AAAA" no intervalo) - é o navegador
// que converte de/pra ISO, o servidor nunca vê o formato ISO.
const TIPOS = {
  deposito: {
    rotulo: 'Depósito de Caixa',
    titulo: 'DEPÓSITO DE CAIXA',
    cabecalho: [
      { key: 'cnpj', label: 'CNPJ' },
      { key: 'nomeGerente', label: 'NOME DO GERENTE' },
      // Quem levou o dinheiro ao banco, quando NAO foi o gerente. Opcional
      // de proposito: na maioria dos depositos e' o proprio gerente, e
      // exigir o nome ali criaria assinatura sobrando. Preenchido e
      // diferente do gerente, vira um segundo assinante - e' ele quem tem o
      // comprovante na mao (ver assinantesDe/comprovanteObrigatorio)
      { key: 'depositante', label: 'QUEM FEZ O DEPÓSITO (se não foi o gerente)' },
    ],
    colunas: [
      { key: 'data', label: 'DATA DO DEPÓSITO', data: true },
      // intervalo: true = 2 datas (De/Até) em vez de texto livre - a tela
      // troca por 2 seletores de calendário e junta como "DD/MM/AAAA a
      // DD/MM/AAAA" antes de mandar pro servidor (mesma convenção DD/MM/AAAA
      // dos campos `data`, o servidor nunca vê ISO nem sabe que são 2 inputs)
      { key: 'periodo', label: 'PERÍODO DO CAIXA', intervalo: true },
      { key: 'envelope', label: 'Nº DO ENVELOPE' },
      { key: 'valor', label: 'VALOR (R$)', valor: true },
    ],
    totalRotulo: 'VALOR TOTAL DEPOSITADO (R$)',
    assinantes: [{ papel: 'gerente', rotulo: 'Responsável' }],
    // preenchedorAssina: quem abre o link de PREENCHIMENTO é a MESMA pessoa
    // que assina esse papel - a tela pública (preencher.html) já mostra o
    // quadro de assinatura na sequência do envio, em vez de mandar um
    // segundo link de assinatura pro mesmo destinatário (pedido do Master:
    // "no link de preenchimento já aparecer também a opção de assinatura").
    // Só marca quando isso é verdade estruturalmente: no Depósito só existe
    // UM assinante (o gerente) e é ele quem preenche.
    preenchedorAssina: 'gerente',
    // liga a regra do depositante (ver assinantesDe): so o Deposito tem
    // "outra pessoa que levou o dinheiro ao banco"
    papelDepositante: true,
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
    assinantes: [{ papel: 'gerente', rotulo: 'Responsável' }],
  },
  // Variante das diárias gerada pelo RH a partir dos CHECK-INS de um extra/
  // candidato em teste (1 check-in = 1 diária = 1 linha). Difere do "diarias"
  // de papel em dois pontos, os dois de propósito:
  // - o favorecido é UMA pessoa só (a do cadastro RH), então os dados de
  //   pagamento (CPF/PIX/banco) moram no cabeçalho, não por linha;
  // - assina o par Favorecido + Responsável (pedido do Master: "gerando só o
  //   link de assinatura do responsável e do Favorecido"), em vez de uma
  //   assinatura por linha + gerente.
  diariasRh: {
    rotulo: 'Diárias por check-in (RH)',
    titulo: 'PAGAMENTO DE DIÁRIA',
    cabecalho: [
      { key: 'cnpj', label: 'CNPJ' },
      { key: 'favorecido', label: 'FAVORECIDO' },
      { key: 'cpf', label: 'CPF' },
      { key: 'banco', label: 'BANCO' },
      { key: 'chavePix', label: 'CHAVE PIX' },
    ],
    colunas: [
      { key: 'data', label: 'DATA DA DIÁRIA', data: true },
      { key: 'nome', label: 'NOME' },
      { key: 'valor', label: 'VALOR (R$)', valor: true },
    ],
    totalRotulo: 'VALOR TOTAL (R$)',
    assinantes: [
      { papel: 'favorecido', rotulo: 'Favorecido' },
      { papel: 'responsavel', rotulo: 'Responsável' },
    ],
    // quem preenche por link é o próprio favorecido (é dele o CPF/PIX/banco
    // do cabeçalho) - o Responsável continua recebendo o link de assinatura
    // dele à parte, esse não muda
    preenchedorAssina: 'favorecido',
  },
  avulso: {
    rotulo: 'Pagamento Avulso',
    titulo: 'SOLICITAÇÃO DE PAGAMENTO AVULSO',
    cabecalho: [
      { key: 'cnpj', label: 'CNPJ' },
      { key: 'favorecido', label: 'FAVORECIDO' },
      { key: 'cnpjFavorecido', label: 'CNPJ DO FAVORECIDO' },
      { key: 'banco', label: 'BANCO' },
      { key: 'agencia', label: 'AGÊNCIA' },
      { key: 'conta', label: 'CONTA COM DÍGITO' },
      { key: 'chavePix', label: 'CHAVE PIX' },
    ],
    colunas: [
      { key: 'data', label: 'DATA', data: true },
      { key: 'descricao', label: 'DESCRIÇÃO', larga: true },
      { key: 'valor', label: 'VALOR (R$)', valor: true },
    ],
    totalRotulo: 'VALOR TOTAL (R$)',
    assinantes: [
      { papel: 'favorecido', rotulo: 'Favorecido' },
      { papel: 'gerente', rotulo: 'Responsável' },
    ],
    // idem diariasRh: o link de preenchimento vai pro favorecido (dados
    // bancários dele no cabeçalho) - o Gerente continua com o link dele
    preenchedorAssina: 'favorecido',
  },
  // Pedido de adiantamento (compra emergencial ou qualquer pagamento cujo
  // valor exato só se sabe depois) - o formulário/assinatura autorizam o
  // valor a sair, mas o ticket que nasce dele na Central (ver
  // enviar-pagamento em index.js, que manda esse tipo pra
  // solicitacoes.js em vez de 'pagamento') só fecha depois que alguém
  // anexa a nota e informa o valor GASTO de verdade - ver
  // solicitacoes.registrarPrestacaoContas. O formulário em si é idêntico
  // ao Avulso (mesmos dados bancários, mesma dupla de assinantes); a
  // diferença inteira mora do lado da Central, não aqui.
  adiantamento: {
    rotulo: 'Adiantamento',
    titulo: 'SOLICITAÇÃO DE ADIANTAMENTO',
    cabecalho: [
      { key: 'cnpj', label: 'CNPJ' },
      { key: 'favorecido', label: 'FAVORECIDO' },
      { key: 'cnpjFavorecido', label: 'CNPJ DO FAVORECIDO' },
      { key: 'banco', label: 'BANCO' },
      { key: 'agencia', label: 'AGÊNCIA' },
      { key: 'conta', label: 'CONTA COM DÍGITO' },
      { key: 'chavePix', label: 'CHAVE PIX' },
    ],
    colunas: [
      { key: 'data', label: 'DATA', data: true },
      { key: 'descricao', label: 'DESCRIÇÃO', larga: true },
      { key: 'valor', label: 'VALOR (R$)', valor: true },
    ],
    totalRotulo: 'VALOR ADIANTADO (R$)',
    assinantes: [
      { papel: 'favorecido', rotulo: 'Favorecido' },
      { papel: 'gerente', rotulo: 'Responsável' },
    ],
    preenchedorAssina: 'favorecido',
  },
  reembolso: {
    rotulo: 'Reembolso',
    titulo: 'SOLICITAÇÃO DE REEMBOLSO',
    cabecalho: [
      { key: 'cnpj', label: 'CNPJ' },
      { key: 'favorecido', label: 'NOME DO FAVORECIDO' },
      { key: 'cpf', label: 'CPF' },
      { key: 'banco', label: 'BANCO' },
      { key: 'agencia', label: 'AGÊNCIA' },
      { key: 'conta', label: 'CONTA COM DÍGITO' },
      { key: 'chavePix', label: 'CHAVE PIX' },
    ],
    colunas: [
      { key: 'data', label: 'DATA DA DESPESA', data: true },
      // continua FORNECEDOR de propósito: aqui é coluna da tabela - o
      // estabelecimento onde CADA despesa foi feita, não quem recebe o
      // dinheiro. O favorecido do Reembolso é o do cabeçalho acima.
      { key: 'fornecedor', label: 'NOME DO FORNECEDOR' },
      { key: 'descricao', label: 'DESCRIÇÃO', larga: true },
      { key: 'valor', label: 'VALOR (R$)', valor: true },
    ],
    totalRotulo: 'VALOR TOTAL (R$)',
    assinantes: [
      // a CHAVE acompanha o rótulo ('favorecido'/'responsavel'). Isso foi
      // adiado uma vez porque renomear a chave desliga o valor e a
      // assinatura dos formulários JÁ gravados (que guardam
      // campos.colaborador e assinaturas.colaborador/gestor); o Master
      // liberou depois - "pode mudar, os registros antigos foram testes".
      // Registro velho que sobre não quebra: rotuloDoSlot() cai no rótulo
      // gravado quando o papel não existe mais no modelo.
      { papel: 'favorecido', rotulo: 'Favorecido' },
      { papel: 'responsavel', rotulo: 'Responsável' },
    ],
    obs: 'OBS.: Todos os comprovantes das despesas devem estar devidamente rubricados e anexados a este formulário.',
    preenchedorAssina: 'favorecido',
  },
  // ESTORNO AO CLIENTE. Nasce SO de um ticket de estorno ja aprovado (ver
  // gerarFormulario em refunds.js) - por isso `somenteDeTicket`: um botao
  // "Estorno" em branco na tela seria redigitar na mao o favorecido e a
  // chave Pix, que e exatamente o que este caminho existe pra evitar (e
  // onde o dinheiro sai pro lugar errado).
  //
  // POR QUE NAO REUSAR O REEMBOLSO, que foi a primeira tentativa: o
  // Reembolso tem DOIS assinantes, Favorecido e Responsavel, e um
  // formulario so vira ASSINADO quando TODOS os slots tem assinatura (ver
  // todasAssinadas em registrarAssinatura). Num estorno o "favorecido" e' o
  // CLIENTE - ou o titular do Pix, que pode ser outra empresa - gente de
  // fora, que nunca vai assinar documento interno. O formulario ficaria
  // PENDENTE pra sempre. Aqui assina UMA pessoa, e ela e de dentro: quem se
  // responsabiliza pelo estorno. Pedido do Master, nas palavras dele:
  // "precisa de uma assinatura do Responsavel, alguem que se responsabiliza
  // por esse estorno".
  estorno: {
    rotulo: 'Estorno ao cliente',
    titulo: 'SOLICITAÇÃO DE ESTORNO AO CLIENTE',
    somenteDeTicket: true,
    cabecalho: [
      { key: 'cnpj', label: 'CNPJ' },
      // o favorecido do estorno e quem RECEBE o Pix, que nem sempre e quem
      // comprou - por isso os dois nomes aparecem, em campos separados
      { key: 'favorecido', label: 'FAVORECIDO (QUEM RECEBE)' },
      { key: 'cpf', label: 'CPF/CNPJ DO FAVORECIDO' },
      { key: 'banco', label: 'BANCO' },
      { key: 'chavePix', label: 'CHAVE PIX' },
      { key: 'cliente', label: 'CLIENTE' },
      // CONTATO, e nao numero de pedido: estorno aberto pelo cliente final
      // nao tem pedidoId (esse campo so existe no estorno interno), entao a
      // linha saia sempre vazia no PDF. O telefone e' o que o financeiro
      // precisa pra confirmar um dado antes de pagar - e o cliente ja
      // preenche, agora obrigatorio.
      { key: 'contato', label: 'CONTATO DO CLIENTE' },
    ],
    colunas: [
      { key: 'data', label: 'DATA DA VENDA', data: true },
      { key: 'descricao', label: 'MOTIVO DO ESTORNO', larga: true },
      { key: 'valor', label: 'VALOR A ESTORNAR (R$)', valor: true },
    ],
    totalRotulo: 'VALOR TOTAL (R$)',
    assinantes: [{ papel: 'responsavel', rotulo: 'Responsável' }],
    preenchedorAssina: 'responsavel',
    obs: 'OBS.: O comprovante da venda enviado pelo cliente segue anexo. A devolução deve ser feita para a chave Pix informada acima.',
  },
  // O único tipo que NÃO é um formulário de papel transcrito: aqui o
  // documento é o arquivo anexado (um boleto, em geral), e o que a gente
  // produz é esse mesmo arquivo com a assinatura CARIMBADA dentro dele -
  // não um formulário separado que "fala sobre" o boleto. Por isso
  // soAnexo: sem tabela de itens, sem total somado de linha, e o anexo é
  // obrigatório - sem ele não existe o que assinar.
  assBoleto: {
    rotulo: 'Ass. Boleto',
    titulo: 'VALIDAÇÃO DE BOLETO / DOCUMENTO',
    soAnexo: true,
    anexoObrigatorio: true,
    cabecalho: [
      { key: 'cnpj', label: 'CNPJ' },
      { key: 'favorecido', label: 'FAVORECIDO' },
      { key: 'descricao', label: 'DESCRIÇÃO' },
      { key: 'vencimento', label: 'VENCIMENTO', data: true },
      // o valor vem daqui em vez de somar linha - ver montarConteudo
      { key: 'valor', label: 'VALOR (R$)', valor: true },
    ],
    colunas: [],
    assinantes: [{ papel: 'responsavel', rotulo: 'Responsável' }],
  },
};

// Cadastro FIXO unidade -> razão social + CNPJ (lista enviada pelo Master
// em 20/08/2026). O formulário nasce com esses dados já preenchidos e SEM
// edição: quem cria só escolhe a unidade - o CNPJ que o navegador mandar é
// IGNORADO de propósito (a fonte é este cadastro, não o formulário).
// MOVIDO PARA CADASTRO. A razão social e o CNPJ de cada unidade agora ficam
// em formulariosUnidades.js (Firestore, editável pelo Master) - trocar um
// CNPJ é decisão de contabilidade, não deploy. Esta constante ficou só como
// a semente daquela migração e não é mais consultada em runtime; quem manda
// é o cadastro. Ver o comentário no topo de formulariosUnidades.js.
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

// TETO DO TEXTO DE UMA LINHA DA TABELA. Era 160 e cortava CALADO: quem
// descrevia o serviço inteiro num campo sem maxlength perdia o que passava
// disso, e só descobria olhando o PDF. Subiu junto com a quebra de linha no
// PDF (a linha agora cresce e a tabela passa de folha quando precisa), que é
// o que torna um texto desse tamanho legível no papel. A tela ganhou o
// maxlength igual, pra o limite ser visível em vez de silencioso.
const MAX_TEXTO_LINHA = 400;

const MAX_LINHAS = 20;
// PNG do canvas de assinatura fica em torno de 5-30KB; o cap é folga, não
// meta - acima disso é foto/arquivo indevido, não um traço de caneta
const MAX_IMAGEM_CHARS = 300000;
// teto de anexos por formulario. Era 5 e travava boleto de fornecedor que vem
// partido em dezenas de arquivos - o Master nao conseguia nem mandar pra
// assinatura. O limite real nao e a contagem, e o TAMANHO: todo anexo vira
// pagina dentro do PDF final (ver anexarDocumentos), e o pdf-lib segura tudo
// em memoria. Por isso o index.js confere o peso do conjunto na entrada, e
// aqui fica so a contagem. Exportado pra que a rota use ESTE numero - dois
// tetos diferentes deixariam o arquivo entrar e sumir depois, calado.
const MAX_ANEXOS = 20;

function limpar(v, max = 120) { return String(v == null ? '' : v).trim().slice(0, max); }
function soDigitos(v) { return String(v || '').replace(/\D/g, ''); }

// nunca derruba a criacao do formulario: aprender o favorecido e bonus
async function salvarFavorecido(campos) {
  try {
    const cpf = soDigitos(campos.cpf);
    const cnpj = soDigitos(campos.cnpjFavorecido);
    const chave = cpf.length === 11 ? cpf : (cnpj.length === 14 ? cnpj : null);
    if (!chave) return;
    const dados = {
      doc: chave,
      nome: campos.favorecido || null,
      cpf: campos.cpf || null, cnpjFavorecido: campos.cnpjFavorecido || null,
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
  const doModelo = modelo && (modelo.assinantes || []).concat([{ papel: 'depositante', rotulo: 'Quem fez o depósito' }])
    .find((a) => a.papel === chave);
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

  // tipo só-anexo (Ass. Boleto): não existe tabela de itens - exigir linha
  // aqui deixaria o formulário impossível de criar. O valor, quando o
  // modelo marca um campo do cabeçalho como valor, sai dali.
  if (modelo.soAnexo) {
    const campoValor = modelo.cabecalho.find((c) => c.valor);
    return { camposOk, linhasOk: [], valorTotal: campoValor ? parseValor(camposOk[campoValor.key]) : 0 };
  }

  const linhasOk = (Array.isArray(linhas) ? linhas : []).slice(0, MAX_LINHAS)
    .map((l) => {
      const linha = {};
      modelo.colunas.forEach((c) => {
        linha[c.key] = c.valor ? parseValor((l || {})[c.key]) : limpar((l || {})[c.key], MAX_TEXTO_LINHA);
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
// Regra do Master: "quando for deposito e for outra pessoa quem fez o
// deposito, diferente do gerente, preciso que assine e anexe o comprovante".
// Duas pessoas conferem coisas diferentes e por isso sao dois papeis: o
// gerente atesta o que saiu do caixa (datas, envelope, valores) e o
// depositante atesta que o dinheiro entrou no banco - e so ele tem o
// comprovante.
//
// Comparacao por nome normalizado (sem caixa, sem acento, espaco unico):
// "João" e "joao " sao a mesma pessoa, e criar assinatura sobrando pra
// diferenca de digitacao seria pior do que nao ter a regra.
function nomeIgual(a, b) {
  const limpo = (v) => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
  return !!limpo(a) && limpo(a) === limpo(b);
}
function temDepositanteProprio(modelo, campos) {
  if (!modelo || !modelo.papelDepositante) return false;
  const quem = limpar((campos || {}).depositante, 160);
  return !!quem && !nomeIgual(quem, (campos || {}).nomeGerente);
}
// os assinantes do modelo + o depositante, quando o conteudo pede um. Fica
// separado de `modelo.assinantes` porque aquilo e' fixo por tipo e isto
// depende do que foi preenchido
function assinantesDe(modelo, campos) {
  const base = modelo.assinantes || [];
  if (!temDepositanteProprio(modelo, campos)) return base;
  return [...base, { papel: 'depositante', rotulo: 'Quem fez o depósito' }];
}
// com depositante proprio, o formulario NAO fecha sem o comprovante: e' a
// prova de que o dinheiro chegou ao banco, e o pedido do Master era
// exatamente que ela viesse junto da assinatura dele
function comprovanteObrigatorio(r) {
  return temDepositanteProprio(TIPOS[r.tipo], r.campos);
}

function montarAssinaturas(modelo, linhasOk, campos) {
  const assinaturas = {};
  const slot = (chave, rotulo) => {
    assinaturas[chave] = { rotulo, token: crypto.randomBytes(18).toString('hex'), nome: null, imagem: null, assinadoEm: null };
  };
  if (modelo.assinaturaPorLinha) {
    linhasOk.forEach((l, i) => slot(`linha-${i}`, `Assinatura · ${l.nome || `linha ${i + 1}`}`));
  }
  assinantesDe(modelo, campos).forEach((a) => slot(a.papel, a.rotulo));
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
  const cadastro = await formulariosUnidades.obterPorUnidade(unidadeOk);
  if (!cadastro) throw new Error('Unidade inválida - escolha uma das unidades cadastradas.');

  const { camposOk, linhasOk, valorTotal } = montarConteudo(modelo, cadastro, campos, linhas);
  const assinaturas = montarAssinaturas(modelo, linhasOk, camposOk);

  // comprovantes da solicitacao (PDF/imagem) - ja salvos no Storage pela
  // rota, aqui entra so a referencia
  const anexosOk = (Array.isArray(anexos) ? anexos : []).slice(0, MAX_ANEXOS)
    .map((a) => ({ nome: limpar(a.nome, 120) || 'anexo', path: String(a.path || ''), tipo: limpar(a.tipo, 80) }))
    .filter((a) => a.path);

  if (modelo.anexoObrigatorio && !anexosOk.length) {
    throw new Error('Anexe o boleto (PDF ou imagem) - é ele que vai ser assinado.');
  }

  const doc = COLLECTION.doc();
  const registro = {
    id: doc.id, tipo, unidade: unidadeOk, unidadeCodigo: cadastro.codigo || null,
    razaoSocial: cadastro.razaoSocial,
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
//
// No Ass. Boleto (soAnexo) o mesmo link também serve pra isso: o
// "preenchimento" ali é o favorecido anexar o boleto e digitar
// favorecido/descrição/vencimento/valor (tudo cabeçalho, sem tabela -
// montarConteudo já trata soAnexo sem exigir linha). O ponto importante é
// a ORDEM que isso garante de graça: como montarAssinaturas só roda
// dentro de salvarPreenchimento (abaixo), o slot do Responsável nem
// EXISTE enquanto o favorecido não manda o anexo - não tem como gerar o
// link de assinatura cedo demais, porque não tem link nenhum até lá.
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
  const cadastro = await formulariosUnidades.obterPorUnidade(unidadeOk);
  if (!cadastro) throw new Error('Unidade inválida - escolha uma das unidades cadastradas.');

  const jaExiste = (await cache.cached()).find((r) => r.status === STATUS_AGUARDANDO
    && r.tipo === tipo && r.unidade === unidadeOk
    && (r.criadoPorId || null) === (criadoPorId || null));
  if (jaExiste) return { ...(await detalhar(jaExiste.id)), reaproveitado: true };

  const doc = COLLECTION.doc();
  const registro = {
    id: doc.id, tipo, unidade: unidadeOk, unidadeCodigo: cadastro.codigo || null,
    razaoSocial: cadastro.razaoSocial,
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
    // soAnexo (Ass. Boleto): sem tabela de itens - o preenchimento inclui
    // anexar o próprio documento, e essa é a informação que a tela pública
    // usa pra trocar a lista de "Itens" por um campo de arquivo
    soAnexo: !!modelo.soAnexo, anexoObrigatorio: !!modelo.anexoObrigatorio,
    jaPreenchido: r.status !== STATUS_AGUARDANDO,
    campos: r.campos, linhas: r.linhas,
    // avisa a tela pública se, ao enviar, ela deve seguir direto pra
    // assinatura (ver salvarPreenchimento) em vez de mostrar só "recebemos
    // seus dados" - null quando esse tipo não tem preenchedor=assinante
    preenchedorAssina: modelo.preenchedorAssina || null,
  };
}

// o solicitante enviou: valida pelas MESMAS regras da unidade, cria os
// slots de assinatura (agora que existem linhas) e o formulário entra no
// fluxo normal, como se tivesse sido preenchido na loja.
// anexos: só usado pelo soAnexo (Ass. Boleto) - nos outros tipos vem vazio
// e o formulário segue sem anexo nenhum, igual sempre foi.
async function salvarPreenchimento(token, { campos, linhas, anexos } = {}) {
  const r = await porTokenPreenchimento(token);
  if (!r) throw new Error('Link de preenchimento inválido.');
  if (r.status !== STATUS_AGUARDANDO) throw new Error('Esse formulário já foi preenchido.');
  const modelo = TIPOS[r.tipo];
  const cadastro = await formulariosUnidades.obterPorUnidade(r.unidade);

  const { camposOk, linhasOk, valorTotal } = montarConteudo(modelo, cadastro, campos, linhas);

  const anexosOk = (Array.isArray(anexos) ? anexos : []).slice(0, MAX_ANEXOS)
    .map((a) => ({ nome: limpar(a.nome, 120) || 'anexo', path: String(a.path || ''), tipo: limpar(a.tipo, 80) }))
    .filter((a) => a.path);
  if (modelo.anexoObrigatorio && !anexosOk.length) {
    throw new Error('Anexe o boleto (PDF ou imagem) - é ele que vai ser assinado.');
  }

  const assinaturas = montarAssinaturas(modelo, linhasOk, camposOk);
  await COLLECTION.doc(r.id).update({
    campos: camposOk, linhas: linhasOk, valorTotal, anexos: anexosOk,
    // as assinaturas só nascem AQUI - é o que garante que o Responsável não
    // tem link nenhum antes do favorecido mandar o anexo (ver comentário
    // acima de STATUS_AGUARDANDO)
    assinaturas,
    status: 'PENDENTE', preenchidoEm: new Date().toISOString(),
  });
  cache.invalidar();
  await salvarFavorecido(camposOk);
  const resultado = { ok: true, id: r.id };
  // quem preencheu é o mesmo papel que assina esse tipo (ver
  // TIPOS.*.preenchedorAssina): devolve o token do slot dele pra
  // preencher.html seguir direto pro quadro de assinatura, sem precisar de
  // um segundo link mandado por fora
  if (modelo.preenchedorAssina && assinaturas[modelo.preenchedorAssina]) {
    resultado.meuPapel = modelo.preenchedorAssina;
    resultado.meuToken = assinaturas[modelo.preenchedorAssina].token;
    resultado.meuRotulo = assinaturas[modelo.preenchedorAssina].rotulo;
  }
  return resultado;
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
    // liga o campo de arquivo na pagina publica: quem depositou anexa o
    // comprovante no mesmo passo da assinatura (ver assinar). Se o
    // comprovante ja veio de outro jeito, nao pede de novo
    exigeComprovante: chave === 'depositante' && !(r.anexos || []).length,
    assinaturas: Object.entries(r.assinaturas).map(([k, s]) => ({ rotulo: rotuloDoSlot(r.tipo, k, s.rotulo), assinado: !!s.imagem })),
  };
}

// anexos: quem assina como 'depositante' manda o COMPROVANTE junto (a rota
// publica ja salvou no Storage e passa so a referencia, igual
// salvarPreenchimento). Assinatura e comprovante entram na mesma operacao
// de proposito: sao a mesma prova, e separar em dois passos deixaria o
// formulario meio fechado - assinado, sem comprovante, e ninguem sabendo de
// quem cobrar.
async function assinar(id, token, { nome, imagem, anexos } = {}) {
  const r = await getOne(id);
  const chave = chaveDoToken(r, token);
  if (!chave) throw new Error('Link de assinatura inválido ou revogado.');
  const a = r.assinaturas[chave];
  if (a.imagem) throw new Error('Essa assinatura já foi registrada.');
  const img = String(imagem || '');
  if (!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(img)) throw new Error('Assinatura inválida - desenhe no quadro e tente de novo.');
  if (img.length > MAX_IMAGEM_CHARS) throw new Error('Assinatura grande demais - limpe o quadro e assine de novo.');

  const novos = (Array.isArray(anexos) ? anexos : [])
    .map((an) => ({ nome: limpar(an.nome, 120) || 'comprovante', path: String(an.path || ''), tipo: limpar(an.tipo, 80) }))
    .filter((an) => an.path);
  const anexosFinais = [...(r.anexos || []), ...novos].slice(0, MAX_ANEXOS);
  // o depositante nao assina sem comprovante: e' o unico que tem o
  // documento do banco na mao, e depois de assinado nao ha mais quem cobrar
  if (chave === 'depositante' && !anexosFinais.length) {
    throw new Error('Anexe o comprovante do depósito antes de assinar.');
  }

  const assinaturas = { ...r.assinaturas, [chave]: { ...a, imagem: img, nome: limpar(nome, 80) || null, assinadoEm: new Date().toISOString() } };
  // faltando comprovante num deposito com depositante proprio, o formulario
  // NAO fecha mesmo com todas as assinaturas: e' o que impede seguir pro
  // pagamento sem a prova de que o dinheiro entrou no banco
  const todasAssinadas = Object.values(assinaturas).every((s) => !!s.imagem);
  const completo = todasAssinadas
    && (!comprovanteObrigatorio(r) || anexosFinais.length > 0);
  await COLLECTION.doc(id).update({
    assinaturas, anexos: anexosFinais, status: completo ? 'ASSINADO' : 'PENDENTE',
  });
  cache.invalidar();
  return { ok: true, chave, completo, faltaComprovante: todasAssinadas && !completo };
}

// ---------------------------------------------------------------------
// CORREÇÃO E CANCELAMENTO (só Master). Antes disso, formulário lançado
// errado não tinha saída nenhuma pela tela: o jeito era deixar lá parado
// pra sempre ou apagar por fora. As duas ações abaixo são diferentes de
// propósito - editar CORRIGE o conteúdo, cancelar TIRA DE CIRCULAÇÃO sem
// apagar o registro (o Ticket # continua existindo e continua ligado a
// esse formulário; um número de ticket que some vira buraco na sequência
// da Central).
const STATUS_CANCELADO = 'CANCELADO';

// A regra que manda aqui: assinatura vale pelo conteúdo que a pessoa VIU
// na hora de assinar. Se o Master muda valor, favorecido ou linha depois,
// a assinatura que já estava lá passaria a cobrir um documento diferente
// do que foi assinado - o que é justamente o que um formulário de
// pagamento não pode fazer. Então mudança de conteúdo DESCARTA as
// assinaturas e gera links novos; quem já assinou assina de novo.
// Salvar sem mudar nada não mexe em assinatura nenhuma (senão abrir pra
// conferir e fechar já custaria as assinaturas coletadas).
async function editar(id, { campos, linhas, porEmail } = {}) {
  const r = await getOne(id);
  if (!r) throw new Error('Formulário não encontrado.');
  if (r.status === STATUS_AGUARDANDO) throw new Error('Esse formulário ainda está esperando o solicitante preencher - não há conteúdo pra editar. Cancele o link se precisar refazer.');
  if (r.status === STATUS_CANCELADO) throw new Error('Formulário cancelado não pode ser editado.');
  const modelo = TIPOS[r.tipo];
  if (!modelo) throw new Error('Tipo de formulário inválido.');
  const cadastro = await formulariosUnidades.obterPorUnidade(r.unidade);
  if (!cadastro) throw new Error('A unidade desse formulário não está mais cadastrada.');

  const { camposOk, linhasOk, valorTotal } = montarConteudo(modelo, cadastro, campos, linhas);
  const mudou = JSON.stringify([camposOk, linhasOk]) !== JSON.stringify([r.campos, r.linhas]);
  if (!mudou) return { ...(await detalhar(id)), assinaturasDescartadas: 0, semMudanca: true };

  const descartadas = Object.values(r.assinaturas || {}).filter((a) => a.imagem).length;
  await COLLECTION.doc(id).update({
    campos: camposOk, linhas: linhasOk, valorTotal,
    assinaturas: montarAssinaturas(modelo, linhasOk, camposOk),
    status: 'PENDENTE',
    editadoEm: new Date().toISOString(), editadoPorEmail: porEmail || null,
  });
  cache.invalidar();
  await salvarFavorecido(camposOk);
  return { ...(await detalhar(id)), assinaturasDescartadas: descartadas, semMudanca: false };
}

// REMOVER UMA ASSINATURA JA COLETADA (so Master). Pedido do Master: "preciso
// da opcao de remover assinatura, mas so o master consegue fazer isso".
//
// POR QUE E' CIRURGICO e nao reaproveita o editarDireto: aquele descarta
// TODAS as assinaturas, porque o CONTEUDO mudou e ninguem assinou o
// documento novo. Aqui o documento continua o mesmo - o que esta errado e
// UMA assinatura (assinou a pessoa errada, assinou sem querer, o traco saiu
// ilegivel). Derrubar as outras junto obrigaria a recolher assinatura de
// gente que fez tudo certo.
//
// O TOKEN E' TROCADO, e isso e de proposito: o motivo mais comum pra apagar
// e' "quem assinou nao era pra ter assinado", e essa pessoa esta com o link
// antigo na mao. Mantendo o token, ela assina de novo no minuto seguinte. O
// link novo sai na tela, pra o Master mandar pra pessoa certa.
//
// E FICA REGISTRADO: assinatura e' o que faz o documento valer. Apagar sem
// deixar rastro transformaria o formulario em algo que muda sozinho - o
// historico guarda quem apagou, qual slot, e o nome/data de quem tinha
// assinado.
const HISTORICO_ASSINATURAS_MAX = 40;

async function removerAssinatura(id, chave, porEmail) {
  const r = await getOne(id);
  if (!r) throw new Error('Formulário não encontrado.');
  if (r.status === 'CANCELADO') throw new Error('Formulário cancelado - não há o que remover.');
  const atual = (r.assinaturas || {})[chave];
  if (!atual) throw new Error('Esse formulário não tem essa assinatura.');
  if (!atual.imagem) throw new Error('Essa assinatura ainda não foi coletada - não há o que remover.');

  const rotulo = rotuloDoSlot(r.tipo, chave, atual.rotulo);
  const assinaturas = {
    ...r.assinaturas,
    [chave]: {
      rotulo: atual.rotulo,
      // token NOVO: o link antigo para de funcionar (ver o comentario acima)
      token: crypto.randomBytes(18).toString('hex'),
      nome: null, imagem: null, assinadoEm: null,
    },
  };
  const historico = [...(r.historicoAssinaturas || []), {
    acao: 'removida', chave, rotulo,
    nome: atual.nome || null, assinadoEm: atual.assinadoEm || null,
    removidoEm: new Date().toISOString(), removidoPorEmail: porEmail || null,
  }].slice(-HISTORICO_ASSINATURAS_MAX);

  await COLLECTION.doc(id).update({
    assinaturas,
    // volta pra PENDENTE sempre: faltando uma assinatura o documento nao
    // esta mais assinado, mesmo que estivesse ha um segundo
    status: 'PENDENTE',
    historicoAssinaturas: historico,
  });
  cache.invalidar();
  return { ...(await detalhar(id)), removida: { chave, rotulo, nome: atual.nome || null } };
}

// O caso mais comum na pratica, descrito pelo Master: "as vezes lanca
// primeiro e depois a outra pessoa vai fazer o deposito e pega o comprovante
// depois e assinaria". Na hora de lancar ninguem sabe ainda quem vai ao
// banco, entao o formulario nasce so com o gerente. Isto acrescenta o
// depositante DEPOIS, sem refazer nada.
//
// NAO descarta as assinaturas ja colhidas, e essa e' a diferenca proposital
// em relacao a editar(): la o conteudo muda (valor, linha, favorecido) e a
// assinatura do gerente passaria a cobrir um documento diferente do que ele
// viu. Aqui nao muda nada do que ele atestou - datas, envelope e valores
// continuam iguais. O que entra e' PROVA A MAIS: o nome de quem levou o
// dinheiro e, junto com a assinatura dele, o comprovante do banco.
async function pedirComprovanteDeposito(id, { nome, porEmail } = {}) {
  const r = await getOne(id);
  if (!r) throw new Error('Formulário não encontrado.');
  const modelo = TIPOS[r.tipo];
  if (!modelo || !modelo.papelDepositante) throw new Error('Só o Depósito de Caixa tem "quem fez o depósito".');
  if (r.status === STATUS_AGUARDANDO) throw new Error('Esse formulário ainda está esperando o preenchimento - mande o link de preenchimento primeiro.');
  if (r.status === STATUS_CANCELADO) throw new Error('Formulário cancelado não pode receber assinatura - lance outro.');
  const quem = limpar(nome, 160);
  if (!quem) throw new Error('Informe o nome de quem fez o depósito.');
  if (nomeIgual(quem, r.campos.nomeGerente)) {
    throw new Error('Esse é o próprio gerente - a assinatura dele já está no formulário.');
  }
  const jaAssinou = r.assinaturas && r.assinaturas.depositante && r.assinaturas.depositante.imagem;
  if (jaAssinou) throw new Error('O depósito já foi assinado por quem depositou - para trocar, use Corrigir ou Cancelar.');

  const campos = { ...r.campos, depositante: quem };
  // slot ja aberto (so trocando o nome) MANTEM o token: o link pode ja ter
  // ido pro WhatsApp de alguem, e trocar o token quebraria ele sem motivo
  const atual = (r.assinaturas || {}).depositante;
  const assinaturas = {
    ...r.assinaturas,
    depositante: atual || {
      rotulo: 'Quem fez o depósito', token: crypto.randomBytes(18).toString('hex'),
      nome: null, imagem: null, assinadoEm: null,
    },
  };
  await COLLECTION.doc(id).update({
    campos, assinaturas, status: 'PENDENTE',
    depositantePedidoEm: new Date().toISOString(), depositantePedidoPorEmail: porEmail || null,
  });
  cache.invalidar();
  return detalhar(id);
}

// reabre o preenchimento do Ass. Boleto (soAnexo) pra trocar um anexo
// errado (foto borrada, boleto de outra unidade) - pedido do Master: hoje
// a única saída era Cancelar e lançar outro, o que queima o Ticket # e
// perde o histórico. Volta pro estado "aguardando" com o MESMO link
// (tokenPreenchimento) e o MESMO Ticket #: zera só o anexo e as
// assinaturas já colhidas (elas valiam pro documento errado, não fazem
// mais sentido pro novo) - campos (favorecido/descrição/vencimento/valor)
// ficam como estavam, então quem reenviar só precisa trocar o arquivo, não
// redigitar tudo (preencher.html pré-preenche a partir de MODELO.campos
// independente do formulário estar "aguardando" de novo ou não).
// tokenPreenchimento: um Ass. Boleto criado direto pela unidade (upload na
// hora, sem passar por link) nunca teve um - gera um novo AQUI pra sempre
// existir um link pra mandar depois de reabrir, mesmo quando não tinha
// nenhum antes. Se já existia (criado por link), preserva o mesmo - é o
// que já estava na mão do favorecido, não precisa mandar de novo.
async function reabrirAnexo(id, { porEmail } = {}) {
  const r = await getOne(id);
  if (!r) throw new Error('Formulário não encontrado.');
  const modelo = TIPOS[r.tipo];
  if (!modelo || !modelo.soAnexo) throw new Error('Só dá pra reabrir o anexo de formulários do tipo Ass. Boleto.');
  if (r.status === STATUS_AGUARDANDO) throw new Error('Esse link já está aguardando o anexo - não precisa reabrir.');
  if (r.status === 'CANCELADO') throw new Error('Formulário cancelado não pode ser reaberto - lance outro.');
  await COLLECTION.doc(id).update({
    anexos: [], assinaturas: {}, status: STATUS_AGUARDANDO,
    tokenPreenchimento: r.tokenPreenchimento || crypto.randomBytes(18).toString('hex'),
    anexoReabertoEm: new Date().toISOString(), anexoReabertoPorEmail: porEmail || null,
  });
  cache.invalidar();
  return detalhar(id);
}

// Anexo acrescentado DEPOIS, em formulário de qualquer tipo - pedido do
// Master: "preciso que todos os formularios tenham a opcao de adicionar
// ANEXO ... so o master tem essa opcao". Até aqui só dava pra anexar na
// criação; o comprovante que chega no dia seguinte não tinha onde entrar.
//
// NÃO descarta assinatura, e essa é a diferença proposital em relação a
// editar(): lá o conteúdo muda (valor, favorecido, linha) e a assinatura
// passaria a cobrir um documento diferente do que a pessoa viu. Aqui não
// muda nada do que foi atestado - entra PROVA A MAIS, do mesmo jeito que o
// comprovante do depositante entra junto da assinatura dele (ver assinar).
//
// Quem anexou e quando ficam gravados no próprio anexo: num documento
// financeiro, "de onde veio esse arquivo" é pergunta que aparece depois.
async function adicionarAnexos(id, anexos, { porEmail } = {}) {
  const r = await getOne(id);
  if (!r) throw new Error('Formulário não encontrado.');
  if (r.status === STATUS_CANCELADO) throw new Error('Formulário cancelado não recebe anexo - lance outro.');
  const agora = new Date().toISOString();
  const novos = (Array.isArray(anexos) ? anexos : [])
    .map((a) => ({
      nome: limpar(a.nome, 120) || 'anexo', path: String(a.path || ''), tipo: limpar(a.tipo, 80),
      anexadoEm: agora, anexadoPorEmail: porEmail || null,
    }))
    .filter((a) => a.path);
  if (!novos.length) throw new Error('Escolha o arquivo (PDF ou imagem).');
  const atuais = r.anexos || [];
  if (atuais.length >= MAX_ANEXOS) {
    throw new Error(`Esse formulário já tem ${MAX_ANEXOS} anexos - o limite do PDF.`);
  }
  const finais = [...atuais, ...novos].slice(0, MAX_ANEXOS);
  const patch = { anexos: finais, anexoAdicionadoEm: agora, anexoAdicionadoPorEmail: porEmail || null };
  // um Depósito que estava travado esperando o comprovante (ver assinar)
  // FECHA aqui, se as assinaturas já estiverem todas colhidas - o
  // comprovante era a única coisa que faltava
  const todasAssinadas = Object.values(r.assinaturas || {}).length > 0
    && Object.values(r.assinaturas || {}).every((a) => !!a.imagem);
  if (todasAssinadas && r.status === 'PENDENTE' && comprovanteObrigatorio(r)) patch.status = 'ASSINADO';
  await COLLECTION.doc(id).update(patch);
  cache.invalidar();
  return detalhar(id);
}

// cancelar não apaga: o registro fica, com motivo e autor, e some do
// caminho de quem ia assinar. Zerar o token de cada slot é o que mata o
// link que já foi pro WhatsApp de alguém - sem token, chaveDoToken não
// acha o slot e a página pública devolve "link inválido ou revogado",
// exatamente como um formulário que nunca existiu.
async function cancelar(id, { motivo, porEmail } = {}) {
  const r = await getOne(id);
  if (!r) throw new Error('Formulário não encontrado.');
  if (r.status === STATUS_AGUARDANDO) throw new Error('Esse é um link de preenchimento - use "Cancelar link".');
  if (r.status === STATUS_CANCELADO) throw new Error('Esse formulário já está cancelado.');
  const assinaturas = {};
  Object.entries(r.assinaturas || {}).forEach(([chave, a]) => { assinaturas[chave] = { ...a, token: null }; });
  await COLLECTION.doc(id).update({
    assinaturas, status: STATUS_CANCELADO,
    canceladoEm: new Date().toISOString(), canceladoPorEmail: porEmail || null,
    motivoCancelamento: limpar(motivo, 200) || null,
  });
  cache.invalidar();
  return { id, status: STATUS_CANCELADO };
}

// ---------------------------------------------------------------------
// ENVIAR COMO TICKET DE PAGAMENTO. O formulário já nasce com Ticket # da
// MESMA sequência da Central (ver criar()/criarParaPreenchimento acima) -
// esta função é o que faz esse número virar de fato uma solicitação de
// Pagamento, levando junto os anexos do formulário (comprovantes, ou o
// próprio boleto no Ass. Boleto). Quem chama isso (index.js) já garante
// que só roda com o formulário ASSINADO - marcarEnviadoPagamento só
// registra o vínculo pra não deixar mandar duas vezes.
async function marcarEnviadoPagamento(id, { pagamentoId } = {}) {
  const r = await getOne(id);
  if (!r) throw new Error('Formulário não encontrado.');
  if (r.enviadoPagamento) throw new Error('Esse formulário já foi enviado como Pagamento.');
  await COLLECTION.doc(id).update({ enviadoPagamento: { em: new Date().toISOString(), pagamentoId: pagamentoId || null } });
  cache.invalidar();
  return detalhar(id);
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

// ---------------------------------------------------------------
// Ass. Boleto: o PDF não é um formulário "sobre" o documento - é o PRÓPRIO
// arquivo anexado com a assinatura carimbada dentro dele. É isso que
// valida o boleto pra quem receber o arquivo por fora do sistema.
//
// pdfkit não sabe abrir um PDF que já existe (só cria do zero), então aqui
// entra o pdf-lib, que copia as páginas do anexo. A assinatura é desenhada
// numa FAIXA no rodapé, nunca por cima do miolo: carimbar no meio de um
// boleto poderia cobrir o código de barras ou a linha digitável.
// ---------------------------------------------------------------
const FAIXA_H = 74; // altura da faixa de assinatura no rodapé

function assinaturasAssinadas(r) {
  return Object.entries(r.assinaturas || {})
    .filter(([, a]) => a.imagem)
    .map(([chave, a]) => ({ chave, rotulo: rotuloDoSlot(r.tipo, chave, a.rotulo), nome: a.nome, assinadoEm: a.assinadoEm, imagem: a.imagem }));
}

async function desenharFaixa(out, pagina, r, fonte, negrito, assinadas, comAssinatura) {
  const { rgb } = require('pdf-lib');
  const { width } = pagina.getSize();
  const alt = comAssinatura ? FAIXA_H : 20;
  // fundo branco: sem ele o texto cairia em cima do que já está desenhado
  pagina.drawRectangle({ x: 0, y: 0, width, height: alt, color: rgb(1, 1, 1) });
  pagina.drawLine({ start: { x: 0, y: alt }, end: { x: width, y: alt }, thickness: 0.8, color: rgb(0.15, 0.3, 0.5) });

  const rodape = `NoPulso · ${r.unidade} · Ticket #${r.numeroTicket ?? '—'}`
    + (r.status === 'CANCELADO' ? ' · CANCELADO' : (assinadas.length ? '' : ' · AGUARDANDO ASSINATURA'));
  pagina.drawText(rodape, { x: 14, y: 7, size: 7.5, font: fonte, color: rgb(0.25, 0.25, 0.25) });

  if (!comAssinatura || !assinadas.length) return;
  let x = 14;
  for (const a of assinadas) {
    let img = null;
    try {
      const bruto = Buffer.from(String(a.imagem).split(',')[1] || '', 'base64');
      img = /^data:image\/png/.test(a.imagem) ? await out.embedPng(bruto) : await out.embedJpg(bruto);
    } catch (e) { img = null; }
    if (img) {
      const escala = Math.min(150 / img.width, 34 / img.height);
      pagina.drawImage(img, { x, y: 26, width: img.width * escala, height: img.height * escala });
    }
    pagina.drawLine({ start: { x, y: 24 }, end: { x: x + 150, y: 24 }, thickness: 0.6, color: rgb(0.3, 0.3, 0.3) });
    pagina.drawText(`${a.rotulo}${a.nome ? ` · ${a.nome}` : ''}`, { x, y: 16, size: 7, font: negrito, color: rgb(0.1, 0.1, 0.1) });
    x += 168;
    if (x + 150 > width) break;
  }
}

// disposicao: 'inline' abre no visualizador do navegador, 'attachment' baixa.
// Ver e baixar sao coisas diferentes: quem so quer conferir nao devia acabar
// com uma pasta de Downloads cheia de PDF que olhou uma vez.
// ---------------------------------------------------------------------
// NOME DO ARQUIVO. Pedido do Master: "sempre que salvar um Formulario,
// seja ele qual for, apareca o nome do beneficiario/data/hora ... precisa
// ter um padrao claro e objetivo facil de identificar". Antes saia
// "deposito-Spoleto_Tacaruna.pdf": dois depositos da mesma loja geravam o
// MESMO nome, e o navegador ia empilhando (1), (2) - impossivel saber qual
// era qual sem abrir.
//
// O padrao, na ordem em que se le:
//
//   Deposito_Spoleto-Tacaruna_Carlos-Souza_2026-08-28_14h32_Ticket-10042.pdf
//   \_______/ \_____________/ \__________/ \_____________/ \____________/
//     o que        onde         de quem        quando          qual
//
// Cada pedaco existe por um motivo:
//   - TIPO e UNIDADE: e' o que ja tinha, e continua sendo o primeiro corte
//     na hora de procurar (e agrupa sozinho na ordem alfabetica da pasta).
//   - BENEFICIARIO: o pedido em si. Some quando o formulario nao tem um -
//     "sem-nome" no meio do arquivo seria pior que nada (regra do
//     CLAUDE.md §6: dado que nao existe nao vira texto).
//   - DATA e HORA de CRIACAO (nao do download): e' um dado DO documento.
//     Usar a hora do download faria o mesmo formulario baixar com nomes
//     diferentes a cada vez, que e' exatamente a duplicata que ele quer
//     evitar. Em Brasilia, pra bater com o que a tela mostra.
//   - TICKET: o desambiguador final. Dois lancamentos iguais no mesmo
//     minuto ainda sao arquivos distintos, e o numero e' a chave que liga
//     o PDF ao registro na Central.
const FUSO_BR_ARQUIVO = 'America/Sao_Paulo';

// pedaco seguro de nome de arquivo: sem acento, sem espaco, sem simbolo -
// so o que qualquer sistema de arquivos e qualquer navegador aceitam
function pedacoDoNome(v, max = 40) {
  const limpo = String(v == null ? '' : v)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return limpo.slice(0, max).replace(/-+$/g, '');
}

// quem é o beneficiário DESTE formulário. Cada tipo guarda isso num campo
// diferente, e a ordem abaixo é da pessoa mais específica pra menos:
// favorecido (avulso/RH/boleto) > quem fez o depósito > gerente da unidade.
function beneficiarioDoFormulario(r) {
  const c = (r && r.campos) || {};
  return c.favorecido || c.depositante || c.nomeGerente || '';
}

function dataHoraDoNome(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return [];
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: FUSO_BR_ARQUIVO, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const o = {};
  partes.forEach((x) => { if (x.type !== 'literal') o[x.type] = x.value; });
  if (!o.year) return [];
  return [`${o.year}-${o.month}-${o.day}`, `${o.hour}h${o.minute}`];
}

// UM nome pros dois caminhos de PDF (formulário desenhado e Ass. Boleto):
// padrão único era o pedido, e dois montadores separados viravam dois
// padrões na primeira vez que alguém mexesse em um só
function nomeArquivoPdf(r) {
  const modelo = TIPOS[r.tipo] || {};
  const pedacos = [
    pedacoDoNome(modelo.rotulo || r.tipo, 28),
    pedacoDoNome(r.unidade, 32),
    pedacoDoNome(beneficiarioDoFormulario(r), 32),
    ...dataHoraDoNome(r.criadoEm),
    r.numeroTicket != null ? `Ticket-${r.numeroTicket}` : pedacoDoNome(r.id, 12),
  ];
  return pedacos.filter(Boolean).join('_');
}

function dispPdf(res, nome, inline) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${nome}.pdf"`);
}

// A4 retrato, sempre. Foi o pedido do Master depois de ver o boleto e a
// DANFE saindo deitados: "anexo do formulario de boleto continuam ficando
// na horizontal, preciso que mantenham a vertical formato A4, podendo
// [en]colher um pouco o anexo para caber sem perder qualidade".
const A4_L = 595.28;
const A4_A = 841.89;

// onde e como desenhar um conteudo (pagina de PDF ou imagem) de origW x
// origH dentro de uma A4 retrato, aproveitando o maximo da folha.
//
// Conteudo DEITADO (mais largo que alto) e' girado 90 graus em vez de ser
// encolhido pra caber na largura: sem girar, um boleto na horizontal vira
// uma tirinha no meio da folha - "cabe", mas ninguem le. Girado, ele usa a
// folha inteira, e a escala fica muito maior. E' onde a qualidade e'
// ganha, nao perdida.
//
// Rotacao no pdf-lib gira em torno do ponto (x, y) do desenho: com 90
// graus, o que crescia pra direita passa a crescer pra cima, e o que
// crescia pra cima cresce pra esquerda. Por isso o x de destino leva a
// ALTURA final somada - senao o conteudo sai pra fora da folha, do lado
// esquerdo.
function encaixeNaA4(origW, origH, reservarRodape) {
  const margem = 30;
  const larguraUtil = A4_L - margem * 2;
  const alturaUtil = A4_A - margem * 2 - (reservarRodape || 0);
  const deitado = origW > origH;
  // girado, o conteudo ocupa origH de largura e origW de altura
  const escala = deitado
    ? Math.min(larguraUtil / origH, alturaUtil / origW)
    : Math.min(larguraUtil / origW, alturaUtil / origH);
  const w = origW * escala;
  const h = origH * escala;
  const larguraFinal = deitado ? h : w;
  const alturaFinal = deitado ? w : h;
  const x0 = (A4_L - larguraFinal) / 2;
  const y0 = (reservarRodape || 0) + margem + (alturaUtil - alturaFinal) / 2;
  return {
    girar: deitado,
    width: w,
    height: h,
    x: deitado ? x0 + larguraFinal : x0,
    y: y0,
  };
}

// Cola os anexos como paginas de um documento pdf-lib. Usada por DOIS
// caminhos: o tipo so-anexo (o anexo E' o documento) e o formulario comum,
// onde os anexos entram DEPOIS do formulario desenhado - pedido do Master:
// "quando tiver anexo, juntar os anexos ao PDF do formulario".
//
// Nunca lanca: anexo que sumiu do storage, PDF corrompido ou formato que nem
// e' imagem viram uma pagina dizendo o que houve, em vez de derrubar o PDF
// inteiro. Um formulario assinado nao pode ficar impossivel de baixar por
// causa de um arquivo ruim que alguem anexou.
//
// reservarRodape: altura (pt) que o conteudo deve evitar embaixo, pra faixa
// de assinatura carimbada depois nao cobrir o documento.
//
// As paginas do PDF anexado NAO sao mais copiadas como estao (copyPages):
// pagina deitada entrava deitada, e era exatamente o que o Master via. Agora
// cada uma e' EMBUTIDA e redesenhada numa A4 retrato (ver encaixeNaA4), o
// que padroniza o arquivo inteiro - varias folhas de tamanhos diferentes
// saem todas do mesmo tamanho, na mesma orientacao.
async function anexarDocumentos(out, anexos, negrito, opts) {
  const { PDFDocument, rgb, degrees } = require('pdf-lib');
  const rodape = (opts && opts.reservarRodape) || 0;
  const desenhar = (pagina, alvo, encaixe) => {
    const comum = { x: encaixe.x, y: encaixe.y, width: encaixe.width, height: encaixe.height };
    const args = encaixe.girar ? { ...comum, rotate: degrees(90) } : comum;
    if (alvo.embutida) pagina.drawPage(alvo.embutida, args);
    else pagina.drawImage(alvo.imagem, args);
  };
  for (const anexo of anexos || []) {
    let bytes = null;
    try { bytes = await storage.baixarArquivo(anexo.path); } catch (e) { bytes = null; }
    if (!bytes) {
      const p = out.addPage([A4_L, A4_A]);
      p.drawText(`Anexo indisponível: ${anexo.nome}`, { x: 40, y: A4_A - 60, size: 12, font: negrito, color: rgb(0.6, 0.1, 0.1) });
      continue;
    }
    if ((anexo.tipo || '').includes('pdf')) {
      try {
        // ignoreEncryption: boleto de banco costuma vir com dono/senha vazia
        const origem = await PDFDocument.load(bytes, { ignoreEncryption: true });
        // pagina SEM /Contents (folha em branco - o verso nao impresso de um
        // scan, por exemplo) e' aceita pelo embedPages e so estoura no
        // save(), com "Can't embed page with missing Contents". O PDF inteiro
        // ia embora por causa dela, sem erro nenhum no caminho: os anexos
        // simplesmente nao apareciam. Ela vira uma folha em branco, que e'
        // exatamente o que ela e' - a contagem de paginas do documento
        // original continua batendo.
        const paginas = origem.getPages();
        const comConteudo = paginas.filter((pg) => !!pg.node.Contents());
        const embutidas = comConteudo.length ? await out.embedPages(comConteudo) : [];
        let i = 0;
        for (const pg of paginas) {
          const p = out.addPage([A4_L, A4_A]);
          if (!pg.node.Contents()) continue;
          const embutida = embutidas[i]; i += 1;
          desenhar(p, { embutida }, encaixeNaA4(embutida.width, embutida.height, rodape));
        }
      } catch (e) {
        const p = out.addPage([A4_L, A4_A]);
        p.drawText(`Não consegui abrir o PDF anexado (${anexo.nome}).`, { x: 40, y: A4_A - 60, size: 11, font: negrito, color: rgb(0.6, 0.1, 0.1) });
      }
    } else {
      let img = null;
      try { img = (anexo.tipo || '').includes('png') ? await out.embedPng(bytes) : await out.embedJpg(bytes); } catch (e) { img = null; }
      const p = out.addPage([A4_L, A4_A]);
      if (img) desenhar(p, { imagem: img }, encaixeNaA4(img.width, img.height, rodape));
      else p.drawText(`Arquivo anexado em formato que não entra no PDF: ${anexo.nome}`, { x: 40, y: 800, size: 11, font: negrito, color: rgb(0.6, 0.1, 0.1) });
    }
  }
}

async function gerarPdfAnexoAssinado(r, res, opcoes) {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const out = await PDFDocument.create();
  const fonte = await out.embedFont(StandardFonts.Helvetica);
  const negrito = await out.embedFont(StandardFonts.HelveticaBold);
  const assinadas = assinaturasAssinadas(r);
  const modelo = TIPOS[r.tipo];

  await anexarDocumentos(out, r.anexos, negrito, { reservarRodape: FAIXA_H });

  if (!out.getPageCount()) {
    const p = out.addPage();
    p.drawText(modelo.titulo, { x: 40, y: p.getSize().height - 60, size: 13, font: negrito });
    p.drawText('Nenhum anexo neste formulário.', { x: 40, y: p.getSize().height - 84, size: 11, font: fonte });
  }

  const paginas = out.getPages();
  for (let i = 0; i < paginas.length; i++) {
    // a assinatura vai em TODAS as páginas/fotos - com mais de uma, uma
    // folha ou imagem solta não pode circular sem a assinatura carimbada
    await desenharFaixa(out, paginas[i], r, fonte, negrito, assinadas, true);
  }

  const bytes = Buffer.from(await out.save());
  dispPdf(res, nomeArquivoPdf(r), opcoes && opcoes.inline);
  res.end(bytes);
}

async function gerarPdf(r, res, opcoes) {
  const modelo = TIPOS[r.tipo];
  // tipo só-anexo sai por outro caminho: o documento é o arquivo anexado,
  // não um formulário desenhado aqui
  if (modelo && modelo.soAnexo) return gerarPdfAnexoAssinado(r, res, opcoes);
  const doc = new PDFDocument({ margin: 40, size: 'A4' });
  dispPdf(res, nomeArquivoPdf(r), opcoes && opcoes.inline);
  // SEM anexo: streaming direto pro navegador, como sempre foi - nao ha
  // motivo pra segurar o PDF inteiro na memoria.
  // COM anexo: precisa juntar as paginas depois (pdfkit so escreve, quem
  // cola documento e' o pdf-lib), entao o formulario e' montado num buffer
  // primeiro. Pedido do Master: "quando tiver anexo, juntar os anexos ao PDF
  // do formulario" - antes o PDF so listava os nomes no rodape e quem ia
  // pagar tinha que baixar cada arquivo por fora.
  const comAnexos = (r.anexos || []).length > 0;
  const pedacos = [];
  if (comAnexos) doc.on('data', (c) => pedacos.push(c));
  else doc.pipe(res);

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

  // formulário cancelado sai carimbado: o PDF circula por fora do sistema
  // (WhatsApp, email, impresso), então quem receber uma cópia antiga tem
  // que enxergar na cara que aquele documento não vale mais
  if (r.status === STATUS_CANCELADO) {
    doc.rect(X, y, LARGURA, 16).fillAndStroke('#7a1d1d', '#7a1d1d');
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#fff')
      .text(`CANCELADO${r.motivoCancelamento ? ` · ${r.motivoCancelamento}` : ''}`, X, y + 4, { width: LARGURA, align: 'center' });
    y += 16;
  }

  // larguras das colunas: VALOR fixa, ASSINATURA (diárias) fixa, DESCRIÇÃO
  // ganha o dobro do peso, o resto divide por igual
  const colunas = [...modelo.colunas];
  if (modelo.assinaturaPorLinha) colunas.push({ key: '_assinatura', label: 'ASSINATURA' });
  const fixas = { valor: 70, _assinatura: 110 };
  const larguraFixa = colunas.reduce((s, c) => s + (fixas[c.valor ? 'valor' : c.key] || 0), 0);
  const pesoTotal = colunas.reduce((s, c) => s + (fixas[c.valor ? 'valor' : c.key] ? 0 : (c.larga ? 2 : 1)), 0);
  const larguras = colunas.map((c) => fixas[c.valor ? 'valor' : c.key] || ((LARGURA - larguraFixa) / pesoTotal) * (c.larga ? 2 : 1));

  const alturaMinima = modelo.assinaturaPorLinha ? 40 : 26;
  const FONTE_CELULA = 8.5;
  // altura que o texto OCUPA na largura da coluna, contando as linhas em que
  // ele vai quebrar. E' o que permite a linha crescer em vez de cortar.
  const alturaDoTexto = (texto, w) => {
    doc.font('Helvetica').fontSize(FONTE_CELULA);
    return doc.heightOfString(String(texto == null ? '' : texto), { width: w - 8 });
  };
  // DESCRICAO COMPRIDA QUEBRA E A LINHA CRESCE. Pedido do Master: "quando
  // tiver descrição maior que o tamanho da coluna, que seja quebrada para
  // baixo e aumente a altura da linha - não tem problema, mas que toda a
  // descrição fique à mostra". Antes a célula tinha altura fixa e
  // `ellipsis: true`: o texto era cortado com "..." e o resto do serviço
  // simplesmente não ia no papel que vai pro banco.
  //
  // `opts.quebrar` liga isso: sem ellipsis, sem height (o pdfkit escreve
  // quantas linhas precisar) e a altura da célula já vem calculada pra caber.
  // Cabeçalho e total seguem com ellipsis - são rótulos curtos e fixos.
  const celula = (texto, x, yy, w, h, opts = {}) => {
    if (opts.fill) doc.rect(x, yy, w, h).fillAndStroke(opts.fill, BORDA);
    else doc.rect(x, yy, w, h).stroke(BORDA);
    const txt = String(texto == null ? '' : texto);
    doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(FONTE_CELULA).fillColor('#000');
    if (opts.quebrar) {
      // centraliza pela altura REAL do texto: com (h-9)/2 um texto de 3
      // linhas comecaria no meio da celula e vazaria pra fora dela
      const alt = doc.heightOfString(txt, { width: w - 8 });
      const topo = opts.meio ? yy + Math.max(4, (h - alt) / 2) : yy + 5;
      doc.text(txt, x + 4, topo, { width: w - 8, align: opts.align || 'left' });
      return;
    }
    doc.text(txt, x + 4, yy + (opts.meio ? (h - 9) / 2 : 5), { width: w - 8, height: h - 8, ellipsis: true, align: opts.align || 'left' });
  };

  // cabeçalho da tabela - virou função porque agora ele se REPETE quando a
  // tabela passa pra outra folha; sem repetir, a segunda folha traz valores
  // em colunas sem nome
  const cabecalhoTabela = () => {
    let cx = X;
    colunas.forEach((c, i) => {
      doc.rect(cx, y, larguras[i], 22).fillAndStroke(AZUL_CLARO, BORDA);
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#000').text(c.label, cx + 3, y + 7, { width: larguras[i] - 6, align: 'center', height: 14, ellipsis: true });
      cx += larguras[i];
    });
    y += 22;
  };
  // linha que cresce pode não caber na folha - antes isso não existia (altura
  // fixa e poucas linhas), e sem tratar o desenho sairia por baixo da margem,
  // invisível
  const LIMITE_Y = doc.page.height - doc.page.margins.bottom;
  const quebrarPaginaSePreciso = (altura, repetirCabecalho) => {
    if (y + altura <= LIMITE_Y) return;
    doc.addPage();
    y = doc.page.margins.top;
    if (repetirCabecalho) cabecalhoTabela();
  };

  let x = X;
  cabecalhoTabela();

  // linhas (com a assinatura do diarista dentro da célula, quando houver)
  r.linhas.forEach((l, idx) => {
    // a linha toda tem a altura do texto MAIS ALTO dela: as células vizinhas
    // acompanham, senão a grade fica com degrau
    const alturas = colunas.map((c, i) => (c.key === '_assinatura'
      ? 0
      : alturaDoTexto(c.valor ? fmtMoney(l[c.key]) : l[c.key], larguras[i])));
    const alturaLinha = Math.max(alturaMinima, Math.ceil(Math.max(0, ...alturas)) + 10);
    quebrarPaginaSePreciso(alturaLinha, true);
    x = X;
    colunas.forEach((c, i) => {
      if (c.key === '_assinatura') {
        doc.rect(x, y, larguras[i], alturaLinha).stroke('#444');
        const ass = (r.assinaturas || {})[`linha-${idx}`];
        const buf = ass && ass.imagem ? imagemBuffer(ass.imagem) : null;
        if (buf) { try { doc.image(buf, x + 4, y + 3, { fit: [larguras[i] - 8, alturaLinha - 6], align: 'center', valign: 'center' }); } catch (e) { /* imagem corrompida não derruba o PDF */ } }
      } else {
        celula(c.valor ? fmtMoney(l[c.key]) : l[c.key], x, y, larguras[i], alturaLinha, { meio: true, quebrar: true, align: c.valor ? 'right' : 'left' });
      }
      x += larguras[i];
    });
    y += alturaLinha;
  });

  // total
  const larguraValor = larguras[colunas.findIndex((c) => c.valor)];
  const larguraRotulo = 200;
  const xValor = X + larguras.slice(0, colunas.findIndex((c) => c.valor)).reduce((s, w) => s + w, 0);
  quebrarPaginaSePreciso(24, false);
  celula(modelo.totalRotulo, xValor - larguraRotulo, y, larguraRotulo, 24, { bold: true, meio: true, align: 'right', fill: AZUL_CLARO });
  celula(fmtMoney(r.valorTotal), xValor, y, larguraValor, 24, { bold: true, meio: true, align: 'right', fill: AZUL_CLARO });
  y += 60;

  // assinaturas do rodapé: 1 centralizada ou N lado a lado, imagem em cima
  // da linha e o rótulo embaixo - a posição que o formulário em papel usa.
  //
  // assinantesDe, e NÃO modelo.assinantes: o "quem fez o depósito" nasce do
  // que foi preenchido (ver assinantesDe), não da lista fixa do tipo. Com a
  // lista fixa aqui, ele assinava, aparecia assinado na tela e travava o
  // fechamento do formulário - mas a assinatura não saía no PDF, que é
  // justamente o papel que vai pro banco e pra prestação de contas.
  const papeis = assinantesDe(modelo, r.campos);
  const larguraBloco = 210;
  // distribuídos: o primeiro colado na esquerda, o último na direita. Hoje
  // isso é sempre 1 ou 2 blocos (o Depósito é o único tipo com assinante
  // variável, e vai a 2 no máximo); um tipo com 3 caberia na conta mas
  // encostaria os blocos - aí a largura precisa cair junto
  const posicoes = papeis.length === 1
    ? [X + (LARGURA - larguraBloco) / 2]
    : papeis.map((_, i) => X + 20 + i * ((LARGURA - 40 - larguraBloco) / (papeis.length - 1)));
  // o bloco de assinatura ocupa da imagem (52 acima da linha) ao rodapé de
  // obs/anexos - com a tabela crescendo, ele pode não caber mais na folha
  const ALTURA_ASSINATURAS = 145;
  quebrarPaginaSePreciso(40 + ALTURA_ASSINATURAS, false);
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
      .text(`Anexos (${r.anexos.length}) nas páginas seguintes: ${r.anexos.map((a) => a.nome).join(' · ')}`, X, yAssin + (modelo.obs ? 62 : 40), { width: LARGURA });
  }

  doc.end();
  if (!comAnexos) return;

  // espera o pdfkit fechar antes de abrir o resultado com o pdf-lib
  await new Promise((ok, falhou) => { doc.on('end', ok); doc.on('error', falhou); });
  const formulario = Buffer.concat(pedacos);
  try {
    const { PDFDocument, StandardFonts } = require('pdf-lib');
    const out = await PDFDocument.load(formulario);
    const negrito = await out.embedFont(StandardFonts.HelveticaBold);
    // rodape 0: aqui nao ha faixa de assinatura carimbada (as assinaturas ja
    // estao desenhadas na pagina do formulario), entao o anexo usa a folha
    // inteira
    await anexarDocumentos(out, r.anexos, negrito, { reservarRodape: 0 });
    return res.end(Buffer.from(await out.save()));
  } catch (e) {
    // juntar falhou (PDF de origem estranho, storage fora): entrega o
    // formulario sozinho. Perder o anexo e' ruim; perder o formulario
    // assinado por causa do anexo seria pior - a loja ficaria sem o
    // documento que ela precisa pra pagar.
    console.error('formularios: não consegui juntar os anexos ao PDF (%s) - enviando só o formulário. %s', r.id, e.message);
    return res.end(formulario);
  }
}

module.exports = {
  MAX_ANEXOS,
  encaixeNaA4, TIPOS, UNIDADES_FORM, buscarFavorecido, criar, listar, detalhar, getOne, vistaPublica, assinar, editar, cancelar, remover, gerarPdf, chaveDoToken, parseValor,
  nomeArquivoPdf, beneficiarioDoFormulario,
  pedirComprovanteDeposito, comprovanteObrigatorio, temDepositanteProprio,
  adicionarAnexos,
  criarParaPreenchimento, vistaPreenchimento, salvarPreenchimento, cancelarPreenchimento, marcarEnviadoPagamento,
  reabrirAnexo, removerAssinatura,
  // mesma saida que parque.js expoe: quem escreve o documento por fora do
  // modulo (teste, restauracao de backup) precisa poder derrubar o cache de
  // 60s, senao a leitura seguinte devolve o estado velho
  invalidar: () => cache.invalidar(),
};
