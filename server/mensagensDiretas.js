// mensagensDiretas.js
// Conversa 1-a-1 entre gente de DENTRO do NoPulso (o time de Suporte/Master
// avisando alguém, e a pessoa respondendo). Não confundir com suporteChat.js,
// que é o chat PÚBLICO do visitante com o Beniboy - lá existe token de
// visitante, funil de triagem e bot; aqui não, são dois acessos logados
// conversando.
//
// Isto substitui o "aviso" que existia antes: a mensagem direta era só um
// broadcast que virava um cartãozinho na tela e sumia sozinho em 20
// segundos, sem ficar gravado em lugar nenhum. Quem não estivesse olhando
// para a tela naquele instante simplesmente perdia o recado, e não havia
// como responder. Decisão do Master: mensagem direcionada é uma CAIXA DE
// DIÁLOGO que a pessoa precisa abrir - fica lá até ela abrir, e ela pode
// responder por dentro.
//
// Uma conversa por PAR de pessoas, com id derivado do par (ver idDoPar):
// mandar de novo pra mesma pessoa continua a mesma conversa em vez de criar
// uma thread nova a cada recado, e achar a conversa existente não precisa de
// query nem de índice composto.
const crypto = require('crypto');
const db = require('./firestore');

const COLLECTION = db.collection('mensagensDiretas');

const MAX_TEXTO = 1000;
// teto por conversa - conversa interna não é histórico eterno, e sem corte
// o documento cresceria até bater no limite de 1MB do Firestore
const MAX_MENSAGENS = 200;

function limpar(texto) {
  return String(texto || '').trim().slice(0, MAX_TEXTO);
}

// id estável a partir do par (ordenado, pra A→B e B→A caírem na MESMA
// conversa). Hash em vez de "idA__idB" porque id de documento do Firestore
// não pode ter barra e tem limite de tamanho - o hash é sempre seguro.
function idDoPar(a, b) {
  const par = [String(a), String(b)].sort();
  return crypto.createHash('sha1').update(par.join('|')).digest('hex');
}

function novaMensagem({ deId, deEmail, texto }) {
  return { de: String(deId), deEmail: deEmail || null, texto: limpar(texto), em: new Date().toISOString() };
}

// manda (ou continua) uma conversa. Devolve a conversa inteira já atualizada,
// pra quem chamou não precisar reler.
async function enviar({ deId, deEmail, paraId, paraEmail, texto }) {
  const corpo = limpar(texto);
  if (!deId || !paraId) throw new Error('Remetente e destinatário são obrigatórios.');
  if (String(deId) === String(paraId)) throw new Error('Não dá pra mandar mensagem pra você mesmo.');
  if (!corpo) throw new Error('Escreva a mensagem.');

  const id = idDoPar(deId, paraId);
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  const agora = new Date().toISOString();
  const msg = novaMensagem({ deId, deEmail, texto: corpo });

  if (!snap.exists) {
    const registro = {
      id,
      participantes: [String(deId), String(paraId)].sort(),
      emails: { [String(deId)]: deEmail || null, [String(paraId)]: paraEmail || null },
      mensagens: [msg],
      // quem escreve já leu o que escreveu - só o outro lado fica devendo
      lidoAte: { [String(deId)]: agora },
      criadoEm: agora,
      atualizadoEm: agora,
    };
    await ref.set(registro);
    return registro;
  }

  const atual = snap.data();
  const mensagens = [...(atual.mensagens || []), msg].slice(-MAX_MENSAGENS);
  const patch = {
    mensagens,
    atualizadoEm: agora,
    // o email pode ter mudado desde a última vez - mantém o mais recente
    emails: { ...(atual.emails || {}), [String(deId)]: deEmail || null, [String(paraId)]: paraEmail || null },
    lidoAte: { ...(atual.lidoAte || {}), [String(deId)]: agora },
  };
  await ref.update(patch);
  return { ...atual, ...patch };
}

// resposta de dentro da conversa. A checagem de participante é o que impede
// alguém de responder numa conversa que não é dele só sabendo o id.
async function responder(id, { deId, deEmail, texto }) {
  const ref = COLLECTION.doc(String(id));
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Conversa não encontrada.');
  const atual = snap.data();
  if (!(atual.participantes || []).includes(String(deId))) throw new Error('Essa conversa não é sua.');
  const corpo = limpar(texto);
  if (!corpo) throw new Error('Escreva a mensagem.');

  const agora = new Date().toISOString();
  const mensagens = [...(atual.mensagens || []), novaMensagem({ deId, deEmail, texto: corpo })].slice(-MAX_MENSAGENS);
  const patch = {
    mensagens,
    atualizadoEm: agora,
    lidoAte: { ...(atual.lidoAte || {}), [String(deId)]: agora },
  };
  await ref.update(patch);
  return { ...atual, ...patch };
}

// quem é o OUTRO lado da conversa, do ponto de vista de quem está olhando
function outroLado(conversa, userId) {
  const outroId = (conversa.participantes || []).find((p) => p !== String(userId)) || null;
  return { id: outroId, email: outroId ? (conversa.emails || {})[outroId] : null };
}

// quantas mensagens do OUTRO lado chegaram depois da última vez que essa
// pessoa abriu a conversa. Mensagem própria nunca conta como não lida.
function naoLidasDe(conversa, userId) {
  const marca = (conversa.lidoAte || {})[String(userId)] || '';
  return (conversa.mensagens || []).filter((m) => m.de !== String(userId) && m.em > marca).length;
}

// a visão que cada lado recebe: já vem com o outro lado resolvido e a
// contagem de não lidas calculada, pra tela não ter que saber dessas regras
function paraUsuario(conversa, userId) {
  return {
    id: conversa.id,
    com: outroLado(conversa, userId),
    mensagens: conversa.mensagens || [],
    naoLidas: naoLidasDe(conversa, userId),
    atualizadoEm: conversa.atualizadoEm,
  };
}

async function listarDoUsuario(userId) {
  const snap = await COLLECTION.where('participantes', 'array-contains', String(userId)).get();
  return snap.docs
    .map((d) => paraUsuario(d.data(), userId))
    .sort((a, b) => String(b.atualizadoEm || '').localeCompare(String(a.atualizadoEm || '')));
}

async function obter(id, userId) {
  const snap = await COLLECTION.doc(String(id)).get();
  if (!snap.exists) return null;
  const conversa = snap.data();
  if (!(conversa.participantes || []).includes(String(userId))) return null;
  return paraUsuario(conversa, userId);
}

// abriu a caixa de diálogo = leu. Marca o instante, e a partir daí só conta
// como não lida o que chegar depois.
async function marcarLida(id, userId) {
  const ref = COLLECTION.doc(String(id));
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Conversa não encontrada.');
  const atual = snap.data();
  if (!(atual.participantes || []).includes(String(userId))) throw new Error('Essa conversa não é sua.');
  await ref.update({ lidoAte: { ...(atual.lidoAte || {}), [String(userId)]: new Date().toISOString() } });
  return { ok: true };
}

module.exports = {
  MAX_TEXTO, idDoPar,
  enviar, responder, listarDoUsuario, obter, marcarLida,
};
