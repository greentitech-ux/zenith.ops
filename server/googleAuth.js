// googleAuth.js
// Um lugar só pra falar com o Google como CONTA DE SERVIÇO.
//
// POR QUE EXISTE. Esta troca (monta um JWT RS256 com a chave da conta de
// serviço → troca por access_token em oauth2.googleapis.com) estava escrita
// dentro do sheetsSync.js, amarrada ao escopo de planilha e com um cache de
// UMA posição só. Ao conectar a agenda do Workspace (sala de reunião do
// Google Meet) o caminho seria copiado - e duas cópias da mesma
// autenticação envelhecem separado: uma ganha o retry, a outra não.
//
// A credencial é a MESMA do Firestore (FIREBASE_CLIENT_EMAIL /
// FIREBASE_PRIVATE_KEY). Não há segredo novo pra guardar: o que muda por
// serviço é o ESCOPO, e - pro Workspace - o usuário que a conta de serviço
// representa.
//
// SOBRE REPRESENTAR UM USUÁRIO (comoUsuario). Conta de serviço não tem
// agenda própria e, sozinha, não cria sala do Meet. Pra criar a sala ela
// precisa agir EM NOME de uma pessoa do Workspace, e isso o dono do domínio
// autoriza uma vez no Admin Console (delegação em todo o domínio). Ver
// docs/GOOGLE_WORKSPACE.md.
'use strict';

const jwt = require('jsonwebtoken');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
// 30 s de folga: token que vence no meio do voo vira 401 numa chamada que já
// está em curso, e o erro sai como "erro do Google" sem ninguém entender.
const FOLGA_MS = 30000;

// cache POR CHAVE (escopo + usuário representado). Com uma posição só, pedir
// a agenda invalidava o token da planilha e vice-versa - duas chamadas de
// token a cada troca, e nenhuma das duas errada o bastante pra alguém notar.
const cache = new Map(); // chave -> { token, expiraEm }

function credenciais() {
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  return { clientEmail, privateKey };
}

// dá pra falar com o Google? (as telas perguntam antes de oferecer o botão)
function configurado() {
  const { clientEmail, privateKey } = credenciais();
  return !!(clientEmail && privateKey);
}

function limparCache() {
  cache.clear();
}

/**
 * Devolve um access_token do Google pro escopo pedido.
 * @param {string} scope      escopo OAuth (ex: .../auth/spreadsheets)
 * @param {object} [opcoes]
 * @param {string} [opcoes.comoUsuario] e-mail do Workspace a representar
 *   (delegação em todo o domínio). Sem ele, a conta de serviço fala por si.
 * @param {string} [opcoes.ondeHabilitar] nome da API, só pra mensagem de erro
 */
async function tokenDeAcesso(scope, opcoes = {}) {
  if (!scope) throw new Error('Escopo do Google não informado.');
  const comoUsuario = opcoes.comoUsuario || '';
  const chave = `${scope}|${comoUsuario}`;
  const guardado = cache.get(chave);
  if (guardado && guardado.expiraEm > Date.now() + FOLGA_MS) return guardado.token;

  const { clientEmail, privateKey } = credenciais();
  if (!clientEmail || !privateKey) {
    throw new Error('FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY não configurados (é a mesma conta de serviço do Firestore).');
  }

  const agora = Math.floor(Date.now() / 1000);
  const corpo = { iss: clientEmail, scope, aud: TOKEN_URL, iat: agora, exp: agora + 3600 };
  // `sub` é o que transforma "a conta de serviço" em "a conta de serviço
  // agindo como fulano". Só funciona com a delegação autorizada no Admin
  // Console; sem ela o Google responde unauthorized_client.
  if (comoUsuario) corpo.sub = comoUsuario;
  const assertion = jwt.sign(corpo, privateKey, { algorithm: 'RS256' });

  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    // o erro do Google é curto demais pra quem vai consertar: diz o que fazer
    const detalhe = data.error_description || data.error || resp.status;
    const api = opcoes.ondeHabilitar ? ` (confira se a API do ${opcoes.ondeHabilitar} está habilitada no projeto)` : '';
    const delegacao = comoUsuario && String(detalhe).includes('unauthorized_client')
      ? ` A conta de serviço não está autorizada a agir como ${comoUsuario}: falta liberar a delegação em todo o domínio no Admin Console, com o escopo ${scope}.`
      : '';
    throw new Error(`Erro ao autenticar com o Google${api}: ${detalhe}.${delegacao}`);
  }

  const token = { token: data.access_token, expiraEm: Date.now() + (data.expires_in || 3600) * 1000 };
  cache.set(chave, token);
  return token.token;
}

module.exports = { tokenDeAcesso, configurado, limparCache, TOKEN_URL };
