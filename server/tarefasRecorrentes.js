// tarefasRecorrentes.js
// A SÉRIE: o molde de uma tarefa que se repete ("Pedido da MB, toda segunda").
//
// Pedido do Master: "ter a opção de criar tarefas recorrentes; escolher entre
// dia da semana, 15 em 15 dias".
//
// POR QUE UMA SÉRIE, E NÃO UMA TAREFA QUE SE CLONA
// -----------------------------------------------
// O caminho fácil seria a tarefa se duplicar ao ser concluída (é o que o
// Todoist faz). Não serve aqui: se ninguém concluir o pedido da segunda, o da
// segunda seguinte nunca nasce - e o pedido é justamente o que não pode ser
// esquecido. Asana, ClickUp e Jira resolvem do jeito que está aqui: um molde
// separado, e um relógio que materializa a próxima ocorrência na data certa,
// independente do que aconteceu com a anterior.
//
// UMA POR VEZ, NUNCA UM CALENDÁRIO INTEIRO
// ----------------------------------------
// Só existe a ocorrência de hoje. Não se materializa o ano inteiro à frente:
// 52 tarefas futuras poluiriam o quadro, custariam 52 escritas e virariam lixo
// no dia em que a regra mudasse.
//
// SEM REPESCAGEM DE DIAS PERDIDOS
// -------------------------------
// Se o servidor ficou fora do ar na segunda, a tarefa da segunda não nasce
// atrasada na terça. Preferir o silêncio a inventar uma tarefa com data
// errada: quem cobra o pedido da MB olha o quadro da segunda, não uma tarefa
// de segunda que apareceu na quinta.
const crypto = require('crypto');
const db = require('./firestore');
const { createCache } = require('./liveCache');

const COLLECTION = db.collection('tarefasRecorrentes');

// Nomes que a tela mostra saem daqui: um lugar só decide o vocabulário.
const TIPOS = ['semanal', 'quinzenal', 'mensal'];
const TIPO_LABEL = { semanal: 'Toda semana', quinzenal: 'A cada 15 dias', mensal: 'Todo mês' };
const DIAS_SEMANA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const DIAS_CURTO = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const MAX_SERIES_ATIVAS = 200;

const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;
// Comparação e aritmética de data em UTC, com a data-calendário já resolvida
// pelo chamador. Sem isso, `new Date('2026-09-14')` num servidor a oeste de
// Greenwich volta para o dia 13 e a série inteira anda um dia.
function comoUtc(iso) {
  const [a, m, d] = String(iso).split('-').map(Number);
  return Date.UTC(a, m - 1, d);
}
function isoDe(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}
const UM_DIA = 24 * 60 * 60 * 1000;
function diasEntre(deIso, ateIso) {
  return Math.round((comoUtc(ateIso) - comoUtc(deIso)) / UM_DIA);
}
function diaDaSemana(iso) {
  return new Date(comoUtc(iso)).getUTCDay();
}

function sanitizarRegra(bruta) {
  const r = bruta && typeof bruta === 'object' ? bruta : {};
  const tipo = TIPOS.includes(String(r.tipo)) ? String(r.tipo) : null;
  if (!tipo) throw new Error('Escolha com que frequência a tarefa se repete.');
  const inicio = DATA_RE.test(String(r.inicio || '')) ? String(r.inicio) : null;
  if (!inicio) throw new Error('Informe a data em que a repetição começa.');
  const ate = DATA_RE.test(String(r.ate || '')) ? String(r.ate) : null;
  if (ate && ate < inicio) throw new Error('A data final da repetição é anterior ao início.');
  if (tipo === 'semanal') {
    const dias = [...new Set((Array.isArray(r.diasSemana) ? r.diasSemana : [])
      .map((d) => parseInt(d, 10)).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
    if (!dias.length) throw new Error('Marque pelo menos um dia da semana.');
    return { tipo, inicio, ate, diasSemana: dias, diaDoMes: null };
  }
  if (tipo === 'mensal') {
    // O dia sai do INÍCIO, não é digitado à parte: dois campos que precisam
    // concordar viram dois campos que discordam.
    return { tipo, inicio, ate, diasSemana: [], diaDoMes: Number(inicio.slice(8, 10)) };
  }
  return { tipo, inicio, ate, diasSemana: [], diaDoMes: null };
}

// Cai neste dia? É a única regra de calendário do módulo - tudo que decide
// "hoje tem ou não tem" passa por aqui, e por isso é testável sozinha.
function ocorreEm(regra, dataIso) {
  if (!regra || !DATA_RE.test(String(dataIso))) return false;
  if (dataIso < regra.inicio) return false;
  if (regra.ate && dataIso > regra.ate) return false;
  if (regra.tipo === 'semanal') return (regra.diasSemana || []).includes(diaDaSemana(dataIso));
  if (regra.tipo === 'quinzenal') return diasEntre(regra.inicio, dataIso) % 14 === 0;
  // mensal: dia 31 em mês de 30 cai no ÚLTIMO dia do mês, não pula o mês nem
  // vaza pro dia 1º do seguinte (o mesmo estouro de setMonth que já mordeu o
  // filtro de período do Estoque).
  const [ano, mes] = dataIso.split('-').map(Number);
  const ultimoDia = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
  return Number(dataIso.slice(8, 10)) === Math.min(regra.diaDoMes, ultimoDia);
}

function resumoDaRegra(regra) {
  if (!regra) return '';
  if (regra.tipo === 'semanal') {
    const dias = (regra.diasSemana || []).map((d) => DIAS_SEMANA[d]);
    if (dias.length === 7) return 'todo dia';
    if (dias.length === 1) return `toda ${dias[0]}`;
    return `toda ${dias.slice(0, -1).join(', ')} e ${dias[dias.length - 1]}`;
  }
  if (regra.tipo === 'quinzenal') return `a cada 15 dias, a partir de ${regra.inicio.split('-').reverse().join('/')}`;
  return `todo dia ${regra.diaDoMes} do mês`;
}

// 60s de TTL: o relogio le esta colecao algumas vezes por dia e a tela le a
// cada abertura. Sem cache, cada leitura custaria N documentos (§3).
const cache = createCache(async () => {
  const snap = await COLLECTION.get();
  return snap.docs.map((d) => d.data());
}, 60 * 1000);

async function listar() { return cache.cached(); }
async function listarDoUsuario(acesso) {
  const todas = await listar();
  if (acesso.isMaster) return todas;
  return todas.filter((s) => s.criadoPorId === acesso.usuario.id || s.responsavelId === acesso.usuario.id);
}

async function criar(dados, acesso) {
  const titulo = String(dados.titulo || '').trim().slice(0, 200);
  if (!titulo) throw new Error('Informe o título da tarefa que vai se repetir.');
  const regra = sanitizarRegra(dados.regra);
  const atuais = await listar();
  if (atuais.filter((s) => s.ativa).length >= MAX_SERIES_ATIVAS) throw new Error('Limite de repetições ativas atingido.');
  const ref = COLLECTION.doc();
  const serie = {
    id: ref.id,
    titulo,
    descricao: String(dados.descricao || '').trim().slice(0, 2000),
    prioridade: dados.prioridade || 'media',
    unidade: dados.unidade || null,
    unidadeNome: dados.unidadeNome || dados.unidade || null,
    responsavelId: dados.responsavelId || acesso.usuario.id,
    responsavelNome: String(dados.responsavelNome || '').slice(0, 80) || null,
    colaboradores: (Array.isArray(dados.colaboradores) ? dados.colaboradores : []).slice(0, 20),
    participantesApenasAcompanham: !!dados.participantesApenasAcompanham,
    // a checklist volta inteira e DESMARCADA a cada ocorrência: é o roteiro do
    // pedido, não o que a semana passada conseguiu fazer
    subtarefas: (Array.isArray(dados.subtarefas) ? dados.subtarefas : [])
      .map((x) => String((x && x.titulo) || x || '').trim().slice(0, 200)).filter(Boolean).slice(0, 50),
    // quantos dias a ocorrência tem de prazo, contados do dia em que nasce
    prazoDias: Math.max(0, Math.min(365, parseInt(dados.prazoDias, 10) || 0)),
    regra,
    ativa: true,
    ultimaGeradaData: null,
    criadaEm: new Date().toISOString(),
    criadoPorId: acesso.usuario.id,
    criadoPorNome: String(acesso.usuario.nome || acesso.usuario.username || 'Usuário').slice(0, 80),
  };
  await ref.set(serie);
  cache.invalidar();
  return serie;
}

function podeMexer(serie, acesso) {
  return !!acesso.isMaster || serie.criadoPorId === acesso.usuario.id || serie.responsavelId === acesso.usuario.id;
}

// Parar de repetir NÃO apaga a série nem as tarefas já criadas: as ocorrências
// passadas são histórico e o molde é a explicação de por que elas existem.
async function definirAtiva(id, acesso, ativa) {
  const ref = COLLECTION.doc(String(id)); const snap = await ref.get();
  if (!snap.exists) throw new Error('Repetição não encontrada.');
  if (!podeMexer(snap.data(), acesso)) throw new Error('Você não pode mexer nesta repetição.');
  await ref.update({ ativa: !!ativa, atualizadoEm: new Date().toISOString() });
  cache.invalidar();
  return { ...snap.data(), ativa: !!ativa };
}

async function remover(id, acesso) {
  const ref = COLLECTION.doc(String(id)); const snap = await ref.get();
  if (!snap.exists) throw new Error('Repetição não encontrada.');
  if (!podeMexer(snap.data(), acesso)) throw new Error('Você não pode remover esta repetição.');
  await ref.delete();
  cache.invalidar();
  return snap.data();
}

// A tarefa de HOJE já foi criada na mão (é a que o Master acabou de salvar):
// marcar o dia como gerado impede o relógio de criar uma segunda igual daqui a
// algumas horas. A série passa a valer da próxima data em diante.
async function marcarGeradaHoje(id, dataIso, tarefaId) {
  await COLLECTION.doc(String(id)).update({ ultimaGeradaData: String(dataIso), ultimaTarefaId: tarefaId || null });
  cache.invalidar();
}

// O RELÓGIO. Roda algumas vezes por dia; `ultimaGeradaData` é o que impede a
// segunda passagem do mesmo dia de criar a tarefa de novo - sem isso, quatro
// passagens dariam quatro "Pedido da MB" na segunda-feira.
async function materializar(hojeIso, criarTarefa) {
  const series = await listar();
  const criadas = [];
  for (const serie of series) {
    if (!serie.ativa) continue;
    if (serie.ultimaGeradaData === hojeIso) continue;
    if (!ocorreEm(serie.regra, hojeIso)) continue;
    try {
      const entrega = serie.prazoDias ? isoDe(comoUtc(hojeIso) + serie.prazoDias * UM_DIA) : hojeIso;
      const tarefa = await criarTarefa({
        titulo: serie.titulo,
        descricao: serie.descricao,
        dataInicio: hojeIso,
        dataEntrega: entrega,
        unidade: serie.unidade,
        unidadeNome: serie.unidadeNome,
        prioridade: serie.prioridade,
        subtarefas: serie.subtarefas,
        colaboradores: serie.colaboradores,
        participantesApenasAcompanham: serie.participantesApenasAcompanham,
        origem: 'recorrente',
        serie: { id: serie.id, data: hojeIso },
        responsavel: { id: serie.responsavelId, nome: serie.responsavelNome },
        usuario: { id: serie.criadoPorId, nome: serie.criadoPorNome },
      });
      // marca DEPOIS de criar: se a criação falhar, a próxima passagem tenta de
      // novo hoje mesmo, em vez de pular o dia calado
      await COLLECTION.doc(serie.id).update({ ultimaGeradaData: hojeIso, ultimaTarefaId: tarefa.id });
      criadas.push({ serieId: serie.id, tarefaId: tarefa.id, titulo: serie.titulo });
    } catch (err) {
      console.error(`[tarefas] repetição "${serie.titulo}" falhou em ${hojeIso}: ${err.message}`);
    }
  }
  if (criadas.length) cache.invalidar();
  return criadas;
}

module.exports = {
  TIPOS, TIPO_LABEL, DIAS_SEMANA, DIAS_CURTO,
  sanitizarRegra, ocorreEm, resumoDaRegra,
  listar, listarDoUsuario, criar, definirAtiva, remover, materializar, marcarGeradaHoje,
  invalidar: () => cache.invalidar(),
};
