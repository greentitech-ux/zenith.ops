'use strict';
// Resumo factual, sem IA, contato, identidade do atendente ou notas internas.
const ROTULOS = { PENDENTE:'Pendente', EM_ATENDIMENTO:'Em atendimento', EM_AGUARDO:'Em aguardo', TRANSFERIDO:'Transferido', TICKET_CRIADO:'Ticket criado', RESOLVIDO:'Resolvido', SEM_SOLUCAO:'Sem solução' };
function referenciaTicket(texto) {
  const valor = String(texto || '').trim();
  const m = valor.match(/\b(?:ticket|protocolo|chamado)\s*(?:n[º°o.]?\s*)?#?\s*(\d{1,12})\b/i)
    || valor.match(/^#(\d{1,12})[?.!]?$/);
  return m ? Number(m[1]) : null;
}
function podeConsultar(chat, atual, logado) {
  if (!chat) return false;
  if (logado?.ehTimeSuporte) return true;
  if (chat.status !== 'ABERTO' && (chat.desbloqueio || chat.restritoAposConclusao)) return false;
  return chat.id === atual?.id || !!(logado?.id && chat.logado?.id === logado.id);
}
function resumo(chat) {
  const mensagens = chat.mensagens || [];
  return {
    numeroTicket: chat.numeroTicket,
    situacao: ROTULOS[chat.statusAtendimento] || (chat.status === 'FINALIZADO' ? 'Finalizado' : 'Pendente'),
    assunto: String(chat.assunto || 'Atendimento').slice(0, 80),
    pedido: String(mensagens.find(m => m.de === 'visitante')?.texto || 'Solicitação com anexo.').slice(0, 180),
    respostas: mensagens.filter(m => m.de === 'suporte' && !m.bot && !m.automatica && m.texto).slice(-2).map(m => ({ texto:String(m.texto).slice(0, 220), em:m.em || null })),
  };
}
function resumoTexto(chat) {
  const r = resumo(chat);
  const respostas = r.respostas.map(m => {
    const data = new Date(m.em || NaN);
    const quando = Number.isNaN(data.getTime()) ? '' : ` (${data.toLocaleString('pt-BR', { timeZone:'America/Sao_Paulo' })})`;
    return `Suporte${quando}: ${m.texto}`;
  });
  return [`Ticket #${r.numeroTicket} · ${r.situacao}`, `Resumo: ${r.pedido}`, ...respostas, ...(respostas.length ? [] : ['Ainda não há resposta humana registrada.']), ...(chat.statusAtendimento === 'EM_AGUARDO' ? ['Continua aberto, aguardando solução. Você pode falar novamente nesta conversa.'] : [])].join('\n');
}
module.exports = { referenciaTicket, podeConsultar, resumo, resumoTexto };
