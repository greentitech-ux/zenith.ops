'use strict';
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const COOKIE = 'nopulsoUnidade';
const INATIVIDADE_MINUTOS = Math.min(60, Math.max(1, Number(process.env.ACESSO_UNIDADE_INATIVIDADE_MINUTOS) || 5));
const DURACAO_COOKIE_MS = 365 * 24 * 60 * 60 * 1000;

// Credencial separada da conta pessoal: só identifica a unidade no chat.
// O segredo do agente nunca entra numa URL nem é entregue ao navegador.
function criarServico({ lerComputador, nomeUnidade, segredo }) {
  const vinculos = new Map();
  const hash = valor => crypto.createHash('sha256').update(String(valor)).digest('hex');
  const prova = computador => hash(`${computador.agentToken}|${computador.chatUnidadeVersao || 0}`);
  async function validar(codigo, posto, assinatura) {
    const c = await lerComputador(codigo, posto);
    if(!c || !c.acessoChatUnidade || !c.agentToken || (assinatura && prova(c) !== assinatura)) return null;
    return c;
  }
  async function emitirVinculo(codigo, posto, tokenAgente) {
    const c = await validar(codigo, posto);
    const a=Buffer.from(String(tokenAgente || '')), b=Buffer.from(String(c?.agentToken || ''));
    if(!c || !a.length || a.length !== b.length || !crypto.timingSafeEqual(a,b)) throw new Error('Computador não autorizado para o chat da unidade.');
    const agora=Date.now();
    for(const [chave, valor] of vinculos) if(valor.expiraEm <= agora) vinculos.delete(chave);
    const token=crypto.randomBytes(32).toString('hex');
    vinculos.set(hash(token),{codigo,posto,prova:prova(c),expiraEm:agora+2*60*1000});
    return token;
  }
  async function consumirVinculo(token) {
    const chave=hash(token), vinculo=vinculos.get(chave);
    vinculos.delete(chave); // consumo único, antes de qualquer await
    if(!vinculo || vinculo.expiraEm <= Date.now() || !await validar(vinculo.codigo,vinculo.posto,vinculo.prova)) throw new Error('Vínculo vencido ou desativado. Abra novamente o atalho NoPulso.');
    return jwt.sign({tipo:'chat-unidade',codigo:vinculo.codigo,posto:vinculo.posto,prova:vinculo.prova},segredo,{expiresIn:'365d',audience:'chat-unidade'});
  }
  async function contextoDoPedido(req) {
    const cookies=String(req.headers?.cookie || '').split(';').map(x=>x.trim());
    const cookie=cookies.find(x=>x.startsWith(COOKIE+'='));
    if(!cookie) return null;
    try {
      const p=jwt.verify(cookie.slice(COOKIE.length+1),segredo,{audience:'chat-unidade'});
      if(p.tipo!=='chat-unidade') return null;
      const c=await validar(p.codigo,p.posto,p.prova);
      if(!c) return null;
      const nome=await nomeUnidade(p.codigo);
      return {codigo:p.codigo,unidade:p.codigo,posto:p.posto,nome,nomeComputador:c.nome || p.posto,acessoUnidade:true,inatividadeMinutos:INATIVIDADE_MINUTOS};
    } catch {return null;}
  }
  return {emitirVinculo,consumirVinculo,contextoDoPedido};
}
module.exports={criarServico,COOKIE,DURACAO_COOKIE_MS,INATIVIDADE_MINUTOS};
