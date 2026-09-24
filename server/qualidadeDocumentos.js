// qualidadeDocumentos.js
//
// A PASTA DE DOCUMENTOS DA UNIDADE (Master, 24/09/2026).
//
// "as unidades poderão armazenar documentação da unidade, um local para a
// unidade adicionar o nome do documento e anexar ou escanear esses
// documentos, para que na própria visita esses documentos sempre estejam
// atualizados com data de validade, e sempre que tiver próximo da validade
// avisar para ser renovado".
//
// POR QUE ISSO MUDA A VISITA. Hoje o setor "Documentação sanitária" do
// checklist é respondido de cabeça: a nutricionista pergunta, alguém procura
// a pasta, e o que sai é CONFORME ou NÃO CONFORME sem prova nem data. Com a
// pasta viva, a visita chega sabendo - e o vencimento deixa de ser
// descoberto no dia da fiscalização.
//
// O VÍNCULO COM O CHECKLIST é opcional e por id: um documento pode apontar
// pro item `licenca-sanitaria` do setor `documentacao`. Quando aponta, a
// visita mostra a validade ao lado do item. Quando não aponta (o refil do
// filtro de água, que o Master citou e que não está no checklist), ele vive
// na pasta do mesmo jeito - a pasta é da unidade, não do checklist.
//
// CUSTO (CLAUDE.md §3): um documento por registro, lista por unidade com
// createCache. O ARQUIVO vai pro Storage - só o caminho fica no documento,
// pelo mesmo motivo da foto do apontamento (um PDF escaneado tem MBs).
const crypto = require('crypto');
const db = require('./firestore');
const { createCache } = require('./liveCache');
const qualidade = require('./qualidade');

const COLLECTION = db.collection('qualidadeDocumentos');

// Quantos dias antes do vencimento o aviso começa. É POR DOCUMENTO, e não
// uma regra fixa, porque o prazo de renovação muda muito: alvará de bombeiro
// leva semanas, refil de filtro se compra no mesmo dia. 30 é só o padrão de
// quem não quis escolher.
const DIAS_AVISO_PADRAO = 30;
const MAX_DIAS_AVISO = 365;

// As quatro situações. `sem_validade` existe porque nem todo documento
// vence (um manual de boas práticas, por exemplo) - e tratar isso como
// "vencido" encheria a tela de alarme falso.
const SITUACOES = ['valido', 'a_vencer', 'vencido', 'sem_validade'];
const SITUACAO_LABEL = {
  valido: 'Válido',
  a_vencer: 'A vencer',
  vencido: 'Vencido',
  sem_validade: 'Sem validade',
};

// ---------------------------------------------------------------------
// DOIS TIPOS DE PAPEL NA PASTA (Master, 24/09/2026).
//
// "todos os arquivos eles serão atualizados periodicamente. Cada um tem sua
// validade, visitas e avaliações não têm validade mas acontecem no mínimo 1
// vez por ano".
//
// Ou seja: são duas perguntas diferentes.
//   - `validade`  - "esse papel ainda vale?"   A data está impressa nele.
//   - `avaliacao` - "faz quanto tempo?"        Não vence; atrasa.
//
// A AVALIAÇÃO DA FRANQUEADORA não tem data de validade nenhuma: a de 2024
// continua sendo um documento legítimo em 2026, só que velha. Chamá-la de
// "Vencida" seria mentir sobre o papel. Mas ficar calado também seria errado
// - uma loja que não recebe consultor há dois anos é exatamente o que a
// Pasta tem que gritar. Então a avaliação é medida por CADÊNCIA: quanto
// tempo desde a mais recente.
//
// A SEVERIDADE é a mesma nos dois casos (verde / amarelo / vermelho / cinza)
// - é ela que ordena a tela, pinta o selo e decide o push. O que muda é a
// PALAVRA, porque a palavra é que fala com a pessoa. Uma severidade, dois
// vocabulários: assim eu não crio um segundo eixo de estado no código, que é
// como a Central e o NOC acabariam divergindo (CLAUDE.md §5).
const TIPOS = ['validade', 'avaliacao'];
const ROTULO_SITUACAO = {
  validade: SITUACAO_LABEL,
  avaliacao: {
    valido: 'Em dia',
    a_vencer: 'Chegando a hora',
    vencido: 'Atrasada',
    sem_validade: 'Sem registro',
  },
};
// 365 é o PISO que o Master deu ("no mínimo 1 vez por ano"), não uma
// estimativa minha: a periodicidade real do consultor muda por marca e por
// ano. Fica editável em cada documento, e o padrão nunca fica em silêncio -
// no pior caso ele cobra uma vez por ano, que é o combinado.
const CADENCIA_PADRAO_DIAS = 365;
const MAX_CADENCIA_DIAS = 3650;

// TETO DE VERSÕES. O empilhamento mora DENTRO do documento (ver `versoes`),
// então ele divide o 1MB do registro no Firestore. Só metadado vai aqui - o
// arquivo em si está no Storage - então 120 versões dão ~30KB e sobra
// espaço. Estourando, a gravação é RECUSADA em vez de derrubar a versão mais
// antiga em silêncio: o histórico é o motivo da funcionalidade existir, e
// perder o começo dele calado é o pior desfecho possível.
const MAX_VERSOES = 120;

// SUGESTÕES DE NOME. As 11 primeiras saem do PRÓPRIO checklist (setor
// `documentacao` do modelo padrão) - assim a pasta e a visita falam a mesma
// língua sem eu repetir a lista aqui e as duas divergirem na primeira
// correção (CLAUDE.md §5). As de baixo foram citadas pelo Master e não estão
// no checklist; a pasta aceita qualquer nome, então elas são só atalho.
function sugestoes() {
  const setor = (qualidade.MODELO_PADRAO.setores || []).find((s) => s.id === 'documentacao');
  const doChecklist = (setor ? setor.itens : []).map((i) => ({ itemChecklistId: i.id, nome: i.texto }));
  return [
    ...doChecklist,
    { itemChecklistId: null, nome: 'Troca do refil do filtro de água' },
  ];
}

// ---------------------------------------------------------------------
// EXIGÊNCIAS POR MARCA.
//
// Transcrição do BOLETIM DE QUALIDADE · DOCUMENTAÇÃO DOMINO'S (2025), que o
// Master anexou - a própria franqueadora dizendo o que a loja tem que ter em
// mãos e de quanto em quanto tempo. Não é lista que eu montei.
//
// A periodicidade vem do boletim e serve pra DUAS coisas: mostrar na tela de
// quanto em quanto tempo renova, e sugerir com quantos dias de antecedência
// avisar (`avisarDiasAntes`) - alvará anual precisa de mais aviso que troca
// de filtro. O número continua editável em cada documento.
//
// "documento único" vira SEM VALIDADE: AVCB e alvará de funcionamento não
// renovam periodicamente, e tratá-los como vencíveis encheria a tela de
// alarme falso.
const DIAS_POR_PERIODICIDADE = {
  diario: 1, mensal: 7, semestral: 30, anual: 45, cinco_anos: 90, unico: null, conforme_documento: 30,
};
const EXIGENCIAS = {
  dominos: {
    nome: "Domino's",
    fonte: 'Boletim de Qualidade · Documentação Domino’s (2025)',
    itens: [
      { nome: 'Certificado de calibração dos termômetros', periodicidade: 'anual' },
      { nome: 'Certificado de calibração da balança', periodicidade: 'anual' },
      { nome: 'Placas de visitação', periodicidade: 'unico' },
      { nome: 'Tabela nutricional', periodicidade: 'unico' },
      { nome: 'Planilhas de temperatura', periodicidade: 'diario' },
      { nome: 'Planilhas de recebimento de mercadorias', periodicidade: 'conforme_documento' },
      { nome: 'Cronograma de limpeza', periodicidade: 'diario' },
      { nome: 'Manual de Boas Práticas, POPs e FISPQs', periodicidade: 'conforme_documento' },
      { nome: 'Certificado de limpeza das caixas d’água', periodicidade: 'semestral' },
      { nome: 'Potabilidade da água', periodicidade: 'semestral' },
      { nome: 'Certificado de troca de filtro', periodicidade: 'semestral' },
      { nome: 'AVCB', periodicidade: 'unico' },
      { nome: 'Alvará de funcionamento', periodicidade: 'unico' },
      { nome: 'PPRA/PGR', periodicidade: 'anual' },
      { nome: 'PCMSO', periodicidade: 'anual' },
      { nome: 'ASOs', periodicidade: 'anual' },
      { nome: 'Controle de pragas', periodicidade: 'mensal' },
      { nome: 'Certificado de inspeção sanitária', periodicidade: 'conforme_documento' },
      { nome: 'Certificado ServSafe', periodicidade: 'cinco_anos' },
      { nome: 'Código de defesa do consumidor', periodicidade: 'unico' },
      { nome: 'Guia de Segurança dos Alimentos', periodicidade: 'anual' },
      // ---- AVALIAÇÕES DA FRANQUEADORA (Master, 24/09/2026) ----
      // "no caso da Domino's tem a Avaliação do Consultor, avaliação e
      // relatório que ele faz periodicamente, e tem a avaliação da Domino's
      // Internacional (NFS)".
      //
      // Não têm validade: entram como `avaliacao` e são cobradas por
      // cadência. A do consultor é "periodicamente" - o Master não disse de
      // quanto em quanto, e eu NÃO vou inventar um número que a tela
      // mostraria como se fosse regra da marca. Fica no piso de 1 por ano,
      // que foi o que ele disse valer pra todas, e é editável por unidade.
      { nome: 'Avaliação do Consultor', tipo: 'avaliacao', periodicidade: 'anual' },
      { nome: "Avaliação Domino's Internacional (NFS)", tipo: 'avaliacao', periodicidade: 'anual' },
    ],
  },
  // SPOLETO E SÃO BRAZ: eu só tenho a AVALIAÇÃO, e é só ela que entra.
  //
  // O Master citou as três marcas pedindo "um local para anexar a avaliação
  // da Franqueadora", e disse que busca a documentação das outras unidades.
  // Copiar a lista da Domino's pra cá seria inventar exigência de outra
  // franqueadora - a loja semearia 21 papéis que talvez ninguém peça, e a
  // Pasta passaria a cobrar documento que não existe (CLAUDE.md §6). Quando
  // o boletim de cada uma chegar, entra aqui na mesma estrutura.
  spoleto: {
    nome: 'Spoleto',
    fonte: 'Avaliação da franqueadora (lista de documentos ainda não recebida)',
    itens: [
      { nome: 'Avaliação da Franqueadora', tipo: 'avaliacao', periodicidade: 'anual' },
    ],
  },
  saobraz: {
    nome: 'São Braz',
    fonte: 'Avaliação da franqueadora (lista de documentos ainda não recebida)',
    itens: [
      { nome: 'Avaliação da Franqueadora', tipo: 'avaliacao', periodicidade: 'anual' },
    ],
  },
};
const PERIODICIDADE_LABEL = {
  diario: 'diário', mensal: 'mensal', semestral: 'semestral', anual: 'anual',
  cinco_anos: 'a cada 5 anos', unico: 'documento único', conforme_documento: 'conforme o documento',
};

// Quantos dias a periodicidade vale como CADÊNCIA de avaliação - a conta
// "faz quanto tempo desde a última". Só o que a franqueadora usa de verdade
// está aqui; periodicidade que não é de avaliação cai no padrão de 1 ano.
const DIAS_CADENCIA = { mensal: 30, trimestral: 91, semestral: 182, anual: 365, cinco_anos: 1825 };

function exigenciasDe(marca) {
  const pacote = EXIGENCIAS[String(marca || '').toLowerCase()];
  if (!pacote) return null;
  return {
    ...pacote,
    itens: pacote.itens.map((i) => ({
      ...i,
      tipo: i.tipo === 'avaliacao' ? 'avaliacao' : 'validade',
      periodicidadeLabel: PERIODICIDADE_LABEL[i.periodicidade] || i.periodicidade,
      avisarDiasAntes: DIAS_POR_PERIODICIDADE[i.periodicidade] || DIAS_AVISO_PADRAO,
      cadenciaDias: DIAS_CADENCIA[i.periodicidade] || CADENCIA_PADRAO_DIAS,
    })),
  };
}

// Quais marcas eu já sei atender. A tela pergunta antes de oferecer o botão,
// pra nao prometer uma lista que nao existe.
function marcasComExigencias() {
  return Object.keys(EXIGENCIAS).map((k) => ({ marca: k, nome: EXIGENCIAS[k].nome, itens: EXIGENCIAS[k].itens.length }));
}

function hojeISO() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}
function diasEntre(deISO, ateISO) {
  const a = Date.parse(deISO + 'T00:00:00Z');
  const b = Date.parse(ateISO + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}
function somarDias(iso, dias) {
  const t = Date.parse(String(iso) + 'T00:00:00Z');
  if (!Number.isFinite(t)) return null;
  return new Date(t + dias * 86400000).toISOString().slice(0, 10);
}
const ehData = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

// ---------------------------------------------------------------------
// O EMPILHAMENTO (Master, 24/09/2026).
//
// "precisa ser algo que vá anexando e criando o empilhamento, sempre o que
// estará válido será o mais recente mesmo que vencido, e o que estará sempre
// à frente, mas podendo escolher os anteriores até para efeito de comparação
// e evolução".
//
// A REGRA, em uma linha: **a versão é o registro, o topo é a leitura.**
//
// Cada envio vira uma VERSÃO dentro do mesmo documento. A do topo é a que
// vale - e vale mesmo estando vencida, que é o ponto: um alvará vencido
// continua sendo o alvará da loja até chegar o novo, e escondê-lo deixaria a
// pasta vazia justamente no dia da fiscalização. As anteriores continuam
// abertas pra comparar a evolução.
//
// POR QUE DENTRO DO DOCUMENTO e não numa subcoleção: o Firestore cobra POR
// DOCUMENTO DEVOLVIDO (CLAUDE.md §3). Subcoleção custaria uma leitura por
// versão toda vez que a Pasta abre - com 21 documentos e 5 versões cada,
// seriam 105 leituras por abertura, por unidade. Dentro do registro, o
// histórico inteiro vem junto na leitura que já acontecia: custo zero.
//
// A ORDEM é pela data do documento (`data`), não pela do envio: quem escaneia
// em outubro a avaliação de março quer ela no lugar de março. Sem `data`, o
// envio serve de data - é o melhor palpite honesto, não um chute.
function dataDaVersao(v) {
  return (v && ehData(v.data) ? v.data : String((v && v.enviadoEm) || '').slice(0, 10)) || '';
}
function ordenarVersoes(lista) {
  return (Array.isArray(lista) ? lista.slice() : []).sort((a, b) => {
    const d = String(dataDaVersao(b)).localeCompare(String(dataDaVersao(a)));
    // empate na data do documento: desempata pelo envio, também do mais novo
    // pro mais velho - duas fotos da mesma avaliação mantêm a última na frente
    return d || String(b.enviadoEm || '').localeCompare(String(a.enviadoEm || ''));
  });
}
function topoDe(doc) {
  const v = ordenarVersoes(doc && doc.versoes);
  return v.length ? v[0] : null;
}

// O TOPO ESPELHADO NO REGISTRO. `validade`, `arquivo` e `ultimaEm` no nível
// de cima são LEITURA do topo da pilha, não um segundo lugar onde o dado
// mora. Quem já lia `doc.arquivo` (a rota de download, a tela da visita)
// continua lendo, sem saber que existe pilha.
//
// Enquanto NÃO há versão nenhuma, valem os campos digitados direto no
// documento - é o caso do item recém-semeado, que ainda não recebeu o papel:
// a loja consegue anotar a validade antes de ter o escaneado em mãos.
function sincronizarComTopo(registro) {
  const topo = topoDe(registro);
  registro.versoes = ordenarVersoes(registro.versoes);
  if (topo) {
    registro.validade = topo.validade || null;
    registro.arquivo = topo.arquivo || null;
    registro.origem = topo.origem || null;
    registro.ultimaEm = dataDaVersao(topo) || null;
    registro.versaoAtualId = topo.id;
  } else {
    registro.ultimaEm = null;
    registro.versaoAtualId = null;
  }
  return registro;
}

function cadenciaDe(doc) {
  const n = Number(doc && doc.cadenciaDias);
  return n > 0 ? Math.min(n, MAX_CADENCIA_DIAS) : CADENCIA_PADRAO_DIAS;
}

// A SITUAÇÃO É SEMPRE CALCULADA, nunca gravada.
//
// Gravar "vencido" num campo significaria que um documento vence só quando
// alguma varredura roda - e um documento que venceu ontem apareceria válido
// até o próximo ciclo. A data é o dado; o resto é leitura dela.
//
// Os dois tipos caem na MESMA escala de severidade, por dois caminhos:
//   validade  -> a data impressa no papel é o prazo.
//   avaliacao -> o prazo é a última + a cadência ("faz quanto tempo?").
function situacaoDe(doc, hoje) {
  const ref = hoje || hojeISO();
  const tipo = doc && doc.tipo === 'avaliacao' ? 'avaliacao' : 'validade';
  let prazo = null;
  if (tipo === 'avaliacao') {
    // a última avaliação é a do topo da pilha; sem nenhuma, não há o que medir
    const ultima = doc && doc.ultimaEm ? doc.ultimaEm : dataDaVersao(topoDe(doc));
    if (!ehData(ultima)) return { situacao: 'sem_validade', dias: null, tipo, prazo: null, situacaoLabel: ROTULO_SITUACAO[tipo].sem_validade };
    prazo = somarDias(ultima, cadenciaDe(doc));
  } else {
    if (!doc || !doc.validade) return { situacao: 'sem_validade', dias: null, tipo, prazo: null, situacaoLabel: ROTULO_SITUACAO[tipo].sem_validade };
    prazo = doc.validade;
  }
  const dias = prazo === null ? null : diasEntre(ref, prazo);
  if (dias === null) return { situacao: 'sem_validade', dias: null, tipo, prazo: null, situacaoLabel: ROTULO_SITUACAO[tipo].sem_validade };
  const aviso = Number(doc.avisarDiasAntes) > 0 ? Number(doc.avisarDiasAntes) : DIAS_AVISO_PADRAO;
  const situacao = dias < 0 ? 'vencido' : (dias <= aviso ? 'a_vencer' : 'valido');
  return { situacao, dias, tipo, prazo, situacaoLabel: ROTULO_SITUACAO[tipo][situacao] };
}

function comSituacao(doc, hoje) {
  return { ...doc, ...situacaoDe(doc, hoje) };
}

// ---------------------------------------------------------------------
async function listarUncached() {
  const snap = await COLLECTION.orderBy('unidade').limit(2000).get();
  return snap.docs.map((d) => d.data());
}
const cache = createCache(listarUncached, 30 * 1000);

async function listar(unidade) {
  const todos = await cache.cached();
  const hoje = hojeISO();
  const lista = unidade ? todos.filter((d) => String(d.unidade) === String(unidade)) : todos;
  return lista.map((d) => comSituacao(d, hoje));
}

async function obter(id) {
  const snap = await COLLECTION.doc(String(id || '')).get();
  if (!snap.exists) throw new Error('Documento não encontrado.');
  return comSituacao(snap.data(), hojeISO());
}

async function salvar({ id, unidade, unidadeNome, nome, tipo, cadenciaDias, validade, avisarDiasAntes, itemChecklistId, observacao, arquivo, origem }, email) {
  const nomeLimpo = String(nome || '').trim().slice(0, 160);
  if (!nomeLimpo) throw new Error('Dê um nome ao documento.');
  const uni = String(unidade || '').trim();
  if (!uni) throw new Error('Diga de qual unidade é o documento.');
  const val = String(validade || '').trim();
  if (val && !ehData(val)) throw new Error('Validade inválida - use o seletor de data.');
  const anterior = id ? (await COLLECTION.doc(String(id)).get()).data() : null;
  const tipoLimpo = TIPOS.includes(String(tipo || '')) ? String(tipo) : ((anterior && anterior.tipo) || 'validade');
  const registro = {
    id: (anterior && anterior.id) || String(id || '').trim() || crypto.randomBytes(10).toString('hex'),
    unidade: uni,
    unidadeNome: String(unidadeNome || '').trim() || (anterior && anterior.unidadeNome) || null,
    nome: nomeLimpo,
    tipo: tipoLimpo,
    // só faz sentido em `avaliacao`, e guardar nos dois casos deixaria um
    // número mudo no registro de validade convidando a ser lido errado
    cadenciaDias: tipoLimpo === 'avaliacao'
      ? Math.min(Math.max(Number(cadenciaDias) || CADENCIA_PADRAO_DIAS, 1), MAX_CADENCIA_DIAS)
      : null,
    validade: val || null,
    avisarDiasAntes: Math.min(Math.max(Number(avisarDiasAntes) || DIAS_AVISO_PADRAO, 1), MAX_DIAS_AVISO),
    itemChecklistId: String(itemChecklistId || '').trim() || null,
    observacao: String(observacao || '').trim().slice(0, 600) || null,
    arquivo: arquivo || (anterior && anterior.arquivo) || null,
    // A PILHA (ver o bloco do empilhamento). Editar o documento nunca mexe
    // no histórico - quem empilha é `empilhar`.
    versoes: (anterior && Array.isArray(anterior.versoes)) ? anterior.versoes : [],
    // DE ONDE ESSE DOCUMENTO VEIO. O laudo de uma visita entra na pasta
    // apontando pra visita ({ tipo:'visita', visitaId }), e NÃO como arquivo
    // no Storage: o PDF é gerado sob demanda de propósito (uma ação
    // corretiva respondida hoje já sai na próxima abertura). Congelar um PDF
    // aqui faria a pasta guardar a versão velha pra sempre.
    origem: origem || (anterior && anterior.origem) || null,
    criadoEm: (anterior && anterior.criadoEm) || new Date().toISOString(),
    criadoPorEmail: (anterior && anterior.criadoPorEmail) || email || null,
    atualizadoEm: new Date().toISOString(),
    atualizadoPorEmail: email || null,
  };
  // EDITAR A VALIDADE DE UM DOCUMENTO QUE JÁ TEM PILHA edita a validade da
  // VERSÃO DO TOPO - é ela que está valendo. Gravar a data só no nível de
  // cima criaria dois lugares com a mesma verdade, e a próxima sincronização
  // com o topo apagaria a correção que a loja acabou de fazer.
  if (registro.versoes.length && val) {
    const topoAtual = topoDe(registro);
    registro.versoes = registro.versoes.map((v) => (v.id === topoAtual.id ? { ...v, validade: val } : v));
  }
  sincronizarComTopo(registro);
  // PRAZO NOVO REARMA O AVISO. Sem isto, renovar a licença (ou empilhar a
  // avaliação deste ano) deixaria o documento mudo pra sempre - ele já tinha
  // avisado uma vez. Comparo o PRAZO e não a validade porque na avaliação o
  // prazo vem da pilha, não de um campo digitado.
  const prazoAntes = anterior ? situacaoDe(anterior, hojeISO()).prazo : null;
  const prazoAgora = situacaoDe(registro, hojeISO()).prazo;
  const mudouPrazo = !anterior || prazoAntes !== prazoAgora;
  registro.avisadoSituacao = mudouPrazo ? null : ((anterior && anterior.avisadoSituacao) || null);
  registro.avisadoEm = mudouPrazo ? null : ((anterior && anterior.avisadoEm) || null);
  await COLLECTION.doc(registro.id).set(registro);
  cache.invalidar();
  return comSituacao(registro, hojeISO());
}

// EMPILHAR: anexar/escanear cria uma VERSÃO, nunca substitui a anterior.
//
// Era `anexar` e trocava o arquivo no lugar - o que apagava o papel do ano
// passado no momento em que chegava o deste ano. A avaliação do consultor de
// 2025 não é lixo quando a de 2026 entra: é com ela que se vê a evolução.
async function empilhar(id, { arquivo, origem, data, validade, observacao }, email) {
  const snap = await COLLECTION.doc(String(id)).get();
  if (!snap.exists) throw new Error('Documento não encontrado.');
  const registro = snap.data();
  const val = String(validade || '').trim();
  if (val && !ehData(val)) throw new Error('Validade inválida - use o seletor de data.');
  const dt = String(data || '').trim();
  if (dt && !ehData(dt)) throw new Error('Data do documento inválida - use o seletor de data.');
  const versoes = Array.isArray(registro.versoes) ? registro.versoes.slice() : [];
  if (versoes.length >= MAX_VERSOES) {
    throw new Error(`Esse documento já tem ${MAX_VERSOES} versões guardadas. Remova alguma antiga antes de subir outra.`);
  }
  // UMA VERSÃO É OU UM ARQUIVO OU UM APONTAMENTO, nunca os dois. O laudo da
  // visita entra apontando pra VISITA porque o PDF é gerado sob demanda -
  // uma ação corretiva respondida hoje já sai na próxima abertura. Congelar
  // o PDF aqui faria a pilha guardar a versão velha pra sempre.
  versoes.push({
    id: crypto.randomBytes(8).toString('hex'),
    arquivo: origem ? null : {
      nome: String((arquivo && arquivo.nome) || 'documento').slice(0, 160),
      path: String((arquivo && arquivo.path) || ''),
      tipo: String((arquivo && arquivo.tipo) || ''),
    },
    origem: origem || null,
    data: dt || null,
    validade: val || null,
    observacao: String(observacao || '').trim().slice(0, 300) || null,
    enviadoEm: new Date().toISOString(),
    enviadoPorEmail: email || null,
  });
  registro.versoes = versoes;
  sincronizarComTopo(registro);
  registro.atualizadoEm = new Date().toISOString();
  registro.atualizadoPorEmail = email || null;
  // versão nova = prazo novo = o aviso volta a poder falar
  registro.avisadoSituacao = null;
  registro.avisadoEm = null;
  await COLLECTION.doc(registro.id).set(registro);
  cache.invalidar();
  return comSituacao(registro, hojeISO());
}

// ACHAR OU CRIAR O LUGAR de um documento que o sistema alimenta sozinho (o
// laudo da visita). Sem isto, cada visita criaria uma ENTRADA NOVA na pasta
// e depois de três anos a loja teria 3 laudos soltos em vez de uma pilha com
// o mais recente na frente - que é exatamente o que o Master pediu.
//
// A chave é (unidade, nome): nome é o que a pessoa lê, e duas entradas com o
// mesmo nome na mesma unidade seriam a duplicata que isto evita.
async function garantirSlot({ unidade, unidadeNome, nome, tipo, cadenciaDias, avisarDiasAntes }, email) {
  const daUnidade = await listar(unidade);
  const achado = daUnidade.find((d) => String(d.nome).toLowerCase() === String(nome).toLowerCase());
  if (achado) return achado;
  return salvar({ unidade, unidadeNome, nome, tipo, cadenciaDias, avisarDiasAntes, validade: null }, email);
}

// Tirar UMA versão da pilha (envio errado, arquivo trocado). Se a que sai é
// a do topo, a de baixo volta a valer - é por isso que o registro é
// sincronizado de novo em vez de só filtrar a lista.
async function removerVersao(id, versaoId, email) {
  const snap = await COLLECTION.doc(String(id)).get();
  if (!snap.exists) throw new Error('Documento não encontrado.');
  const registro = snap.data();
  const antes = Array.isArray(registro.versoes) ? registro.versoes : [];
  const depois = antes.filter((v) => v.id !== String(versaoId));
  if (depois.length === antes.length) throw new Error('Essa versão não está na pilha.');
  registro.versoes = depois;
  // o documento sem nenhuma versão volta a ser um registro sem papel - a
  // validade digitada à mão continua valendo, que é como ele nasceu
  if (!depois.length) { registro.arquivo = null; registro.validade = null; }
  sincronizarComTopo(registro);
  registro.atualizadoEm = new Date().toISOString();
  registro.atualizadoPorEmail = email || null;
  await COLLECTION.doc(registro.id).set(registro);
  cache.invalidar();
  return comSituacao(registro, hojeISO());
}

async function remover(id) {
  const snap = await COLLECTION.doc(String(id || '')).get();
  if (!snap.exists) throw new Error('Documento não encontrado.');
  await COLLECTION.doc(String(id)).delete();
  cache.invalidar();
  return { ok: true };
}

// ---------------------------------------------------------------------
// A VARREDURA DE VENCIMENTO.
//
// Devolve quem PRECISA de aviso agora: entrou em `a_vencer` ou em `vencido`
// e ainda não avisou NESSA situação. Avisar por situação (e não uma vez só)
// é o que faz o documento cobrar duas vezes - quando falta pouco, e de novo
// quando venceu de fato, que é quando vira risco de fiscalização.
async function varrerVencimentos() {
  const hoje = hojeISO();
  const todos = await cache.cached();
  const precisam = [];
  for (const bruto of todos) {
    const doc = comSituacao(bruto, hoje);
    if (doc.situacao !== 'a_vencer' && doc.situacao !== 'vencido') continue;
    if (doc.avisadoSituacao === doc.situacao) continue;
    precisam.push(doc);
  }
  return precisam;
}

async function marcarAvisado(id, situacao) {
  await COLLECTION.doc(String(id)).set({
    avisadoSituacao: situacao,
    avisadoEm: new Date().toISOString(),
  }, { merge: true });
  cache.invalidar();
}

module.exports = {
  DIAS_AVISO_PADRAO, MAX_DIAS_AVISO, SITUACOES, SITUACAO_LABEL,
  TIPOS, ROTULO_SITUACAO, CADENCIA_PADRAO_DIAS, MAX_CADENCIA_DIAS, MAX_VERSOES,
  sugestoes, situacaoDe, comSituacao, hojeISO, diasEntre, somarDias,
  ordenarVersoes, dataDaVersao, topoDe,
  EXIGENCIAS, PERIODICIDADE_LABEL, DIAS_POR_PERIODICIDADE, DIAS_CADENCIA,
  exigenciasDe, marcasComExigencias,
  listar, obter, salvar, garantirSlot, empilhar, removerVersao, remover, varrerVencimentos, marcarAvisado,
};
