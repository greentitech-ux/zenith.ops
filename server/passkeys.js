// passkeys.js
//
// ENTRAR COM A DIGITAL OU O ROSTO, no celular (Master, 22/09/2026: "para
// acessar o app, em caso de mobile habilitar acessar com a biometria ou
// facial").
//
// O que é, em uma frase: o aparelho guarda uma CHAVE PRIVADA que nunca sai
// dele, e a digital/rosto é o que destranca o uso dessa chave. O servidor
// guarda só a chave PÚBLICA e confere a assinatura a cada entrada. Não há
// senha viajando, não há segredo guardado aqui que sirva pra entrar em
// lugar nenhum - e por isso a biometria em si nunca chega ao NoPulso: quem
// confere o dedo é o próprio aparelho, como no desbloqueio dele.
//
// POR QUE ISSO E NÃO "GUARDAR A SENHA NO CELULAR". A sessão do app dura 8h
// (30 dias só pra quem tem a tag de terminal, ver auth.js), então o gerente
// digita senha todo dia. Guardar o token no aparelho e destrancar com o dedo
// não resolveria: o que estaria sendo destrancado é um token que já venceu.
// Com passkey, a entrada é nova a cada vez e sai pelo MESMO caminho do login
// normal - mesma sessão, mesmo JWT, mesmo horário permitido, mesma trava de
// acesso desativado (ver auth.loginComPasskey).
//
// DOIS ENDEREÇOS, DUAS CREDENCIAIS. A credencial é amarrada ao domínio
// (rpId) pelo próprio navegador - é isso que impede um site falso de usá-la.
// Como o app responde por mais de um endereço, o rpId viaja GRAVADO em cada
// credencial: quem cadastrar em www.nopulso.com.br e um dia entrar pelo
// endereço antigo simplesmente não vê o botão da biometria e usa a senha,
// em vez de ver um erro que ninguém entende.
//
// CUSTO (CLAUDE.md §3): o desafio de cada tentativa vive em MEMÓRIA, com
// validade curta - são dois por entrada, e gravá-los no Firestore custaria
// leitura e escrita em todo login, todo dia, por pessoa. Se a instância
// reiniciar no meio da tentativa, a pessoa toca de novo. A credencial em si
// é um documento, lido por id na hora de entrar.
const crypto = require('crypto');
const db = require('./firestore');

const CREDENCIAIS = db.collection('passkeys');

// o desafio precisa ser imprevisível e valer por pouco tempo: é ele que
// impede alguém de reaproveitar uma assinatura capturada antes
const VALIDADE_DESAFIO_MS = 5 * 60 * 1000;
const MAX_POR_USUARIO = 10; // aparelhos por pessoa - o suficiente sem virar lista sem fim
const desafios = new Map(); // chave -> { desafio, userId, expiraEm }

function limparVencidos() {
  const agora = Date.now();
  for (const [k, v] of desafios) if (v.expiraEm <= agora) desafios.delete(k);
}
function guardarDesafio(chave, desafio, userId) {
  limparVencidos();
  desafios.set(chave, { desafio, userId: userId || null, expiraEm: Date.now() + VALIDADE_DESAFIO_MS });
}
// pega E CONSOME: um desafio serve pra uma tentativa só, senão a mesma
// assinatura entraria duas vezes
function consumirDesafio(chave) {
  limparVencidos();
  const achado = desafios.get(chave);
  desafios.delete(chave);
  return achado || null;
}
function novaChaveDeSessao() {
  return crypto.randomBytes(24).toString('base64url');
}

// O NOME que aparece na lista de aparelhos da pessoa. Vem do próprio
// navegador (User-Agent): não é identidade, é só "qual celular é esse" pra
// ela saber qual remover quando trocar de aparelho.
function apelidoDoAparelho(userAgent) {
  const ua = String(userAgent || '');
  const sistema = /iPhone|iPad|iOS/i.test(ua) ? 'iPhone/iPad'
    : /Android/i.test(ua) ? 'Android'
      : /Macintosh|Mac OS X/i.test(ua) ? 'Mac'
        : /Windows/i.test(ua) ? 'Windows'
          : 'Aparelho';
  const navegador = /Edg\//i.test(ua) ? 'Edge'
    : /OPR\//i.test(ua) ? 'Opera'
      : /Chrome\//i.test(ua) ? 'Chrome'
        : /Safari\//i.test(ua) ? 'Safari'
          : /Firefox\//i.test(ua) ? 'Firefox'
            : '';
  return navegador ? `${sistema} · ${navegador}` : sistema;
}

// O DOMÍNIO da credencial. O navegador exige que o rpId seja o host ou um
// sufixo dele; usar o host da própria requisição faz a coisa funcionar em
// qualquer endereço por onde o app responda, sem nada cravado em código.
function rpIdDoPedido(req) {
  const host = String((req && req.headers && req.headers.host) || '').split(':')[0].trim().toLowerCase();
  return host || null;
}

async function listarDoUsuario(userId) {
  if (!userId) return [];
  const snap = await CREDENCIAIS.where('userId', '==', String(userId)).get();
  return snap.docs.map((d) => d.data()).sort((a, b) => String(a.criadoEm).localeCompare(String(b.criadoEm)));
}

// id do documento = id da credencial. É assim que o login acha a chave
// pública em UMA leitura, sem varrer a coleção.
function docIdDaCredencial(credentialID) {
  const limpo = String(credentialID || '').replace(/\//g, '_').slice(0, 300);
  if (!limpo) throw new Error('Credencial inválida.');
  return limpo;
}

async function acharPorCredentialID(credentialID) {
  const snap = await CREDENCIAIS.doc(docIdDaCredencial(credentialID)).get();
  return snap.exists ? snap.data() : null;
}

async function salvar({ credentialID, publicKey, counter, userId, rpId, origem, transports, userAgent }) {
  const id = docIdDaCredencial(credentialID);
  const jaTem = await listarDoUsuario(userId);
  if (jaTem.length >= MAX_POR_USUARIO) {
    throw new Error(`Limite de ${MAX_POR_USUARIO} aparelhos por acesso. Remova um antes de cadastrar outro.`);
  }
  const registro = {
    id,
    credentialID: String(credentialID),
    publicKey: String(publicKey),
    // contador do autenticador: serve pra detectar credencial CLONADA (se o
    // número voltar pra trás, algo está errado). Nem todo aparelho usa - os
    // que não usam mandam 0 sempre, e aí a checagem não se aplica.
    counter: Number(counter) || 0,
    userId: String(userId),
    rpId: String(rpId || ''),
    origem: String(origem || ''),
    transports: Array.isArray(transports) ? transports : [],
    aparelho: apelidoDoAparelho(userAgent),
    criadoEm: new Date().toISOString(),
    ultimoUsoEm: null,
  };
  await CREDENCIAIS.doc(id).set(registro);
  return registro;
}

// depois de cada entrada: guarda o contador novo e quando foi usada. O
// `ultimoUsoEm` é o que deixa a pessoa reconhecer o aparelho na lista - e
// perceber um que ela não usa há meses.
async function registrarUso(credentialID, counter) {
  await CREDENCIAIS.doc(docIdDaCredencial(credentialID)).set({
    counter: Number(counter) || 0,
    ultimoUsoEm: new Date().toISOString(),
  }, { merge: true });
}

// só o dono remove, e é por isso que o userId entra na conferência: o id da
// credencial não é segredo (ele viaja na tela), então sem isso qualquer
// pessoa logada apagaria o aparelho de outra
async function remover(id, userId) {
  const ref = CREDENCIAIS.doc(docIdDaCredencial(id));
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Aparelho não encontrado.');
  if (String(snap.data().userId) !== String(userId)) throw new Error('Esse aparelho é de outro acesso.');
  await ref.delete();
  return { ok: true };
}

// quando o Master desativa ou exclui alguém, as passkeys dela têm de ir
// junto - senão o aparelho continuaria entrando com o acesso "desligado"
async function removerTodasDoUsuario(userId) {
  const lista = await listarDoUsuario(userId);
  await Promise.all(lista.map((c) => CREDENCIAIS.doc(docIdDaCredencial(c.id)).delete()));
  return lista.length;
}

module.exports = {
  VALIDADE_DESAFIO_MS, MAX_POR_USUARIO,
  guardarDesafio, consumirDesafio, novaChaveDeSessao,
  apelidoDoAparelho, rpIdDoPedido,
  listarDoUsuario, acharPorCredentialID, salvar, registrarUso, remover, removerTodasDoUsuario,
};
