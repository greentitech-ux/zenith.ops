'use strict';
// Aviso efêmero no SSE já aberto. Não consulta nem grava banco/push/histórico.
const crypto=require('crypto');
function avisarEntrada(clientes, usuario, {metodo, computador, nomeUnidade}={}) {
  if (!usuario?.id || !['senha','biometria'].includes(metodo)) return 0;
  const dados={id:crypto.randomUUID(),nome:usuario.username || usuario.email || 'Usuário',em:Date.now(),
    unidade:computador?.codigo ? (nomeUnidade || computador.codigo) : null,
    computador:computador?.posto || null};
  const payload='event: usuario-entrou\ndata: '+JSON.stringify(dados)+'\n\n';
  let enviados=0;
  for(const cliente of clientes) {
    if (cliente.isMasterPrincipal!==true || cliente.userId===usuario.id || cliente.res.destroyed || cliente.res.writableEnded) continue;
    try {cliente.res.write(payload);enviados++;} catch { /* Notificação não pode impedir login. */ }
  }
  return enviados;
}
module.exports={avisarEntrada};
