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
  const usados = new Map();
  const prova = c => hash(c.agentToken);
  async function computador(codigo, posto) {
    const c = await lerComputador(codigo, posto);
    return c?.agentToken && !c.windowsAntigo && Number(c.agenteVersao) > 0 ? c : null;
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
  function desafio(req) {
    for (const [k, em] of usados) if (em <= agora()) usados.delete(k);
    if (usados.size >= 2000) throw new Error('Aguarde para validar este computador.');
    return jwt.sign({ jti: crypto.randomBytes(24).toString('hex'), ip: hash(ipDoPedido(req)), navegador: hash(req.headers?.['user-agent']) }, segredo, { audience:'noc-local', expiresIn:60 });
  }
  async function automatico({ desafio: d, codigo, posto, assinatura }, req, origem) {
    const p = jwt.verify(String(d || ''), segredo, { audience:'noc-local' });
    if (!p.jti || p.ip !== hash(ipDoPedido(req)) || p.navegador !== hash(req.headers?.['user-agent']) || usados.has(p.jti)) throw new Error('Validação local inválida ou já utilizada.');
    const c = await computador(codigo, posto);
    if (!c) throw new Error('Computador não cadastrado no NOC.');
    const esperado = crypto.createHmac('sha256', String(c.agentToken)).update('noc-local\n'+origem+'\n'+d).digest('hex');
    if (!/^[a-f0-9]{64}$/.test(String(assinatura)) || !crypto.timingSafeEqual(Buffer.from(esperado), Buffer.from(assinatura))) throw new Error('O agente desta máquina não confirmou o acesso.');
    // Sem await entre conferir e consumir: dois pedidos não reutilizam a prova.
    if (usados.has(p.jti) || usados.size >= 2000) throw new Error('Validação local já utilizada.');
    usados.set(p.jti, agora()+60000);
    return jwt.sign({tipo:'computador-noc',codigo,posto,prova:prova(c),ip:p.ip,navegador:p.navegador}, segredo, {audience:'login-noc',expiresIn:'24h'});
  }
  return { emitir, consumir, validarPedido, desafio, automatico };
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
  if (!somenteNoc(usuario, tags)) return;
  const maquina = await servico().validarPedido(req);
  if (!maquina) {
    const e = new Error('Seu acesso exige uma máquina NOC da unidade autorizada. Confira se o agente está atualizado e permita ao NoPulso comunicar-se com o agente local, se o navegador solicitar.');
    e.code = 'COMPUTADOR_NOC_OBRIGATORIO';
    throw e;
  }
  if (!await unidadePermitida(usuario, maquina.codigo)) {
    const e = new Error('Seu acesso não é permitido neste computador: a unidade dele não está autorizada no seu cadastro. Solicite ao responsável a conferência das unidades permitidas.');
    e.code = 'UNIDADE_NOC_NAO_AUTORIZADA';
    throw e;
  }
  req.computadorNocValidado = maquina; // Metadado do servidor, não recebido do formulário.
}
async function unidadePermitida(usuario, codigo) {
  if (usuario.role === 'master') return true; // O Master secundário continua exigindo máquina NOC.
  const normalizar = require('./migracaoUnidades').normalizarCodigoUnidade;
  let unidades = (usuario.permissions?.unidades || []).map(normalizar);
  if (usuario.empresaId) {
    const empresa = new Set((await require('./empresas').unidadesDaEmpresa(usuario.empresaId)).map(normalizar));
    unidades = unidades.filter(u => empresa.has(u));
  }
  return unidades.includes(normalizar(codigo));
}
module.exports = { COOKIE, DURACAO_MS, criarServico, somenteNoc, servico, exigir, alteracoes, unidadePermitida };
