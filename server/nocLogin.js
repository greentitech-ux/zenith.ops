'use strict';
// Vínculo do navegador emitido pelo agente autenticado. Não aceita IP/nome
// declarados pelo cliente como prova de NOC. Não concede permissões de usuário.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const alteracoes = new (require('events').EventEmitter)();
const COOKIE = 'nopulsoComputadorNoc';
const DURACAO_MS = 24 * 60 * 60 * 1000;
const hash = v => crypto.createHash('sha256').update(String(v || '')).digest('hex');
const ipDoPedido = req => String(req.headers?.['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
function criarServico({ lerComputador, segredo, agora = Date.now }) {
  const pendentes = new Map();
  const prova = c => hash(c.agentToken);
  async function computador(codigo, posto) {
    const c = await lerComputador(codigo, posto);
    return c?.agentToken && Number(c.agenteVersao) > 0 ? c : null;
  }
  async function emitir(codigo, posto, token, req) {
    const c = await computador(codigo, posto);
    const a = Buffer.from(String(token || '')), b = Buffer.from(String(c?.agentToken || ''));
    if (!c || !a.length || a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('Agente NOC não validado neste computador.');
    for (const [k, v] of pendentes) if (v.expira <= agora()) pendentes.delete(k);
    if (pendentes.size >= 2000) throw new Error('Aguarde para validar este computador.');
    const vinculo = crypto.randomBytes(32).toString('hex');
    pendentes.set(hash(vinculo), { codigo, posto, prova: prova(c), ip: hash(ipDoPedido(req)), expira: agora() + 120000 });
    return vinculo;
  }
  async function consumir(vinculo, req) {
    const k = hash(vinculo), p = pendentes.get(k);
    pendentes.delete(k); // Uso único, inclusive com pedidos concorrentes.
    const c = p && await computador(p.codigo, p.posto);
    if (!p || p.expira <= agora() || !c || prova(c) !== p.prova || p.ip !== hash(ipDoPedido(req))) throw new Error('Validação vencida. Solicite ao TI uma nova validação deste navegador.');
    return jwt.sign({ tipo: 'computador-noc', codigo: p.codigo, posto: p.posto, prova: p.prova, ip: p.ip, navegador: hash(req.headers?.['user-agent']) }, segredo, { audience: 'login-noc', expiresIn: '24h' });
  }
  async function validarPedido(req) {
    const cookie = String(req.headers?.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='));
    if (!cookie) return null;
    try {
      const p = jwt.verify(cookie.slice(COOKIE.length + 1), segredo, { audience: 'login-noc' });
      if (p.tipo !== 'computador-noc' || p.ip !== hash(ipDoPedido(req)) || p.navegador !== hash(req.headers?.['user-agent'])) return null;
      const c = await computador(p.codigo, p.posto);
      return c && prova(c) === p.prova ? { codigo: p.codigo, posto: p.posto, expiraEm: p.exp * 1000 } : null;
    } catch { return null; }
  }
  return { emitir, consumir, validarPedido };
}
function somenteNoc(usuario, tags) {
  return !tags.length || usuario.somenteNoc !== false;
}
let instancia;
function servico() {
  if (!instancia) instancia = criarServico({ lerComputador: (c, p) => require('./lojaStatus').computadorParaLoginNoc(c, p), segredo: process.env.JWT_SECRET });
  return instancia;
}
async function exigir(usuario, req) {
  if (await require('./masterHierarquia').ehPrincipal(usuario)) return;
  const tags = require('./users').tagsDe(usuario);
  if (somenteNoc(usuario, tags) && !await servico().validarPedido(req)) {
    const e = new Error('Este acesso só pode ser usado em computador validado pelo NOC. Solicite ao TI a validação deste navegador na máquina com o agente instalado.');
    e.code = 'COMPUTADOR_NOC_OBRIGATORIO';
    throw e;
  }
}
module.exports = { COOKIE, DURACAO_MS, criarServico, somenteNoc, servico, exigir, alteracoes };
