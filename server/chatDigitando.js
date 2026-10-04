'use strict';
// Presença efêmera por conversa: não importa Firestore, não recebe rascunhos.
const crypto = require('crypto');
function criarServico({ agora = Date.now } = {}) {
  const concessoes = new Map(), chaves = new Map(), clientes = new Set();
  const VALIDADE = 15 * 60 * 1000, PRAZO = 8000, INTERVALO = 4000;
  function estado(id, lado) {
    let ate = 0;
    for (const g of concessoes.values()) if (g.id === id && g.lado !== lado) ate = Math.max(ate, g.ate);
    return { ativo: ate > agora(), prazoMs: Math.max(0, ate - agora()) };
  }
  function pintar(id) {
    for (const c of clientes) if (c.g.id === id && !c.res.destroyed) {
      if (c.res.writableLength > 32768) { clientes.delete(c); c.res.end(); continue; }
      c.res.write(`event: digitando\ndata: ${JSON.stringify(estado(id, c.g.lado))}\n\n`);
    }
  }
  function retirar(token) {
    const g = concessoes.get(token);
    if (!g) return;
    concessoes.delete(token); chaves.delete(g.chave);
    for (const c of [...clientes]) if (c.token === token) { clientes.delete(c); c.res.end(); }
    pintar(g.id);
  }
  function limpar() {
    const mudou = new Set();
    for (const [token, g] of concessoes) {
      if (g.expira <= agora()) { retirar(token); continue; }
      if (g.ate && g.ate <= agora()) { g.ate = 0; mudou.add(g.id); }
    }
    for (const id of mudou) pintar(id);
  }
  function revogar(id) {
    for (const [token, g] of [...concessoes]) if (g.id === id) retirar(token);
  }
  function emitir(chat, lado, ator = 'visitante') {
    if (!chat || chat.status !== 'ABERTO') { if (chat) revogar(chat.id); return null; }
    if (!['visitante', 'suporte'].includes(lado)) return null;
    limpar();
    const chave = JSON.stringify([chat.id, lado, ator]), anterior = chaves.get(chave);
    if (anterior && concessoes.get(anterior)?.expira > agora() + 60000) return anterior;
    if (anterior) retirar(anterior);
    if (concessoes.size >= 3000) return null; // Sem crescimento ilimitado ou impacto no envio normal.
    const token = crypto.randomBytes(24).toString('hex');
    concessoes.set(token, { id: chat.id, lado, chave, expira: agora() + VALIDADE, ate: 0, ultimo: -Infinity });
    chaves.set(chave, token); return token;
  }
  function validar(id, token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{48}$/.test(token)) return null;
    const g = concessoes.get(token);
    return g && g.id === id && g.expira > agora() ? g : null;
  }
  function sinalizar(id, token, ativo) {
    const g = validar(id, token);
    if (!g) return false;
    if (ativo) {
      if (agora() - g.ultimo < INTERVALO) return true;
      g.ultimo = agora(); g.ate = agora() + PRAZO;
    } else { if (!g.ate) return true; g.ate = 0; }
    pintar(id); return true;
  }
  function registrarRotas(app) {
    // A capacidade vem somente da leitura já autorizada da conversa/lista.
    // Não é o token permanente do chat, não abre mensagens e morre no deploy.
    app.post('/api/suporte-chat/:id/digitando', (req, res) => {
      const b = req.body || {};
      if (typeof b.ativo !== 'boolean' || Object.keys(b).some(k => !['token', 'ativo'].includes(k))) return res.sendStatus(400);
      if (!sinalizar(req.params.id, b.token, b.ativo)) return res.sendStatus(404);
      res.json({ ok: true });
    });
    app.get('/api/suporte-chat/:id/digitando-stream', (req, res) => {
      const g = validar(req.params.id, req.query.token);
      if (!g) return res.sendStatus(404);
      if (clientes.size >= 1000 || [...clientes].filter(c => c.token === req.query.token).length >= 3) return res.sendStatus(429);
      res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      const c = { g, token: req.query.token, res }; clientes.add(c);
      pintar(g.id);
      const pulso = setInterval(() => { if (!res.destroyed) res.write(': pulso\n\n'); }, 25000);
      pulso.unref();
      req.on('close', () => { clearInterval(pulso); clientes.delete(c); });
    });
  }
  const limpeza = setInterval(limpar, 1000); limpeza.unref();
  function fechar() { clearInterval(limpeza); for (const c of clientes) c.res.end(); clientes.clear(); }
  return { emitir, validar, sinalizar, estado, limpar, revogar, registrarRotas, fechar };
}
const servico = criarServico();
module.exports = {
  criarServico,
  emitir: servico.emitir,
  validar: servico.validar,
  sinalizar: servico.sinalizar,
  estado: servico.estado,
  limpar: servico.limpar,
  revogar: servico.revogar,
  registrarRotas: servico.registrarRotas,
  fechar: servico.fechar,
};
