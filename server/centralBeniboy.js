'use strict';
// Permissão exclusiva do atendimento, sem conceder Admin ou acesso ao NOC.
function podeAtender(ctx) {
  const u = ctx?.user || ctx;
  if (!u || u.active === false) return false;
  if (ctx?.isMaster || u.role === 'master') return true;
  const tags = [...(Array.isArray(u.cargos) ? u.cargos : []), u.cargo];
  return tags.some(c => c === 'suporte' || c === 'tecnico');
}
module.exports = { podeAtender };
