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

function hojeISO() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}
function diasEntre(deISO, ateISO) {
  const a = Date.parse(deISO + 'T00:00:00Z');
  const b = Date.parse(ateISO + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

// A SITUAÇÃO É SEMPRE CALCULADA, nunca gravada.
//
// Gravar "vencido" num campo significaria que um documento vence só quando
// alguma varredura roda - e um documento que venceu ontem apareceria válido
// até o próximo ciclo. A data é o dado; o resto é leitura dela.
function situacaoDe(doc, hoje) {
  const ref = hoje || hojeISO();
  if (!doc || !doc.validade) return { situacao: 'sem_validade', dias: null };
  const dias = diasEntre(ref, doc.validade);
  if (dias === null) return { situacao: 'sem_validade', dias: null };
  if (dias < 0) return { situacao: 'vencido', dias };
  const aviso = Number(doc.avisarDiasAntes) > 0 ? Number(doc.avisarDiasAntes) : DIAS_AVISO_PADRAO;
  if (dias <= aviso) return { situacao: 'a_vencer', dias };
  return { situacao: 'valido', dias };
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

async function salvar({ id, unidade, unidadeNome, nome, validade, avisarDiasAntes, itemChecklistId, observacao, arquivo }, email) {
  const nomeLimpo = String(nome || '').trim().slice(0, 160);
  if (!nomeLimpo) throw new Error('Dê um nome ao documento.');
  const uni = String(unidade || '').trim();
  if (!uni) throw new Error('Diga de qual unidade é o documento.');
  const val = String(validade || '').trim();
  if (val && !/^\d{4}-\d{2}-\d{2}$/.test(val)) throw new Error('Validade inválida - use o seletor de data.');
  const anterior = id ? (await COLLECTION.doc(String(id)).get()).data() : null;
  const registro = {
    id: (anterior && anterior.id) || String(id || '').trim() || crypto.randomBytes(10).toString('hex'),
    unidade: uni,
    unidadeNome: String(unidadeNome || '').trim() || (anterior && anterior.unidadeNome) || null,
    nome: nomeLimpo,
    validade: val || null,
    avisarDiasAntes: Math.min(Math.max(Number(avisarDiasAntes) || DIAS_AVISO_PADRAO, 1), MAX_DIAS_AVISO),
    itemChecklistId: String(itemChecklistId || '').trim() || null,
    observacao: String(observacao || '').trim().slice(0, 600) || null,
    arquivo: arquivo || (anterior && anterior.arquivo) || null,
    criadoEm: (anterior && anterior.criadoEm) || new Date().toISOString(),
    criadoPorEmail: (anterior && anterior.criadoPorEmail) || email || null,
    atualizadoEm: new Date().toISOString(),
    atualizadoPorEmail: email || null,
  };
  // VALIDADE NOVA REARMA O AVISO. Sem isto, renovar a licença deixaria o
  // documento mudo pra sempre - ele já tinha avisado uma vez.
  const mudouValidade = !anterior || anterior.validade !== registro.validade;
  registro.avisadoSituacao = mudouValidade ? null : ((anterior && anterior.avisadoSituacao) || null);
  registro.avisadoEm = mudouValidade ? null : ((anterior && anterior.avisadoEm) || null);
  await COLLECTION.doc(registro.id).set(registro);
  cache.invalidar();
  return comSituacao(registro, hojeISO());
}

async function anexar(id, arquivo) {
  const snap = await COLLECTION.doc(String(id)).get();
  if (!snap.exists) throw new Error('Documento não encontrado.');
  await COLLECTION.doc(String(id)).set({
    arquivo: { nome: String(arquivo.nome || 'documento').slice(0, 160), path: String(arquivo.path || ''), tipo: String(arquivo.tipo || '') },
    atualizadoEm: new Date().toISOString(),
  }, { merge: true });
  cache.invalidar();
  return obter(id);
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
  sugestoes, situacaoDe, comSituacao, hojeISO, diasEntre,
  listar, obter, salvar, anexar, remover, varrerVencimentos, marcarAvisado,
};
