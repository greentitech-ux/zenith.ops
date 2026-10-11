'use strict';
// Uma sessão, dois apps. O cookie nunca autentica APIs de negócio: serve só
// para recuperar o Bearer na mesma origem, depois de validar conta e sessão.
const jwt = require('jsonwebtoken');
const COOKIE = '__Secure-nopulsoSessao';
const OPCOES = { domain: 'nopulso.com.br', path: '/api/auth', httpOnly: true, secure: true, sameSite: 'strict' };
const HOSTS = new Set(['nopulso.com.br', 'www.nopulso.com.br', 'atendimento.nopulso.com.br']);

function mesmaOrigem(req) {
  const host = String(req.headers.host || '').toLowerCase();
  // Não confiar em X-Forwarded-Host nem aceitar qualquer subdomínio irmão.
  return HOSTS.has(host) && req.headers.origin === 'https://' + host
    && (!req.headers['sec-fetch-site'] || req.headers['sec-fetch-site'] === 'same-origin');
}
function lerCookie(req) {
  const valores = String(req.headers.cookie || '').split(';').map(v => v.trim()).filter(v => v.startsWith(COOKIE + '='));
  if (valores.length !== 1) return null; // cookie ambíguo não escolhe identidade
  try { return decodeURIComponent(valores[0].slice(COOKIE.length + 1)); } catch (_) { return null; }
}
function payloadSessao(token) {
  try {
    const p = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    return p.sub && p.sid && Number.isFinite(p.exp) ? p : null;
  } catch (_) { return null; }
}
function limpar(res) { res.clearCookie(COOKIE, OPCOES); }
function gravar(req, res, token) {
  const p = payloadSessao(token);
  if (!mesmaOrigem(req) || !p) return;
  // Não prorroga a validade nem cria uma segunda sessão no outro app.
  res.cookie(COOKIE, token, { ...OPCOES, maxAge: Math.max(0, p.exp * 1000 - Date.now()) });
}
function registrar(app, { auth, sessions }) {
  app.post('/api/auth/sessao-apps', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!mesmaOrigem(req)) return res.status(403).json({ error: 'Origem não autorizada.' });
    const cookie = lerCookie(req);
    // Migração de quem já estava logado antes do deploy. Um cookie vencido
    // não pode ressuscitar outra conta antiga guardada no localStorage.
    const tinhaCookie = String(req.headers.cookie || '').includes(COOKIE + '=');
    const token = tinhaCookie ? cookie : req.body?.migrar === true ? String(req.headers.authorization || '').replace(/^Bearer /, '') : null;
    const p = payloadSessao(token);
    if (!p || !await auth.usuarioOpcionalDoToken(token, req)) {
      limpar(res);
      return res.status(401).json({ error: 'Sessão ausente ou encerrada.' });
    }
    gravar(req, res, token);
    return res.json({ token });
  });
  app.post('/api/auth/sair', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const navegador = mesmaOrigem(req);
    // Clientes de API já existentes podem encerrar o Bearer que possuem,
    // mas nunca usar cookies sem a prova de mesma origem do navegador.
    const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization || ''))?.[1];
    if (!navegador && (req.headers.origin || req.headers.cookie || !bearer)) return res.status(403).json({ error: 'Origem não autorizada.' });
    try {
      const tokens = new Set([navegador ? lerCookie(req) : null, bearer]);
      for (const token of tokens) {
        const p = payloadSessao(token);
        if (p) await sessions.encerrar(p.sid);
      }
      if (navegador) limpar(res);
      res.json({ ok: true });
    } catch (_) { res.status(503).json({ error: 'Não foi possível encerrar a sessão. Tente novamente.' }); }
  });
}
module.exports = { registrar, gravar, mesmaOrigem, COOKIE, OPCOES };
