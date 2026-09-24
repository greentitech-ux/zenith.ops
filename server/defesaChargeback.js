// defesaChargeback.js
// DEFESA DE CHARGEBACK SEM PERDER PRAZO (Master, 24/09/2026).
//
// Os números que motivaram: de 265 chargebacks levantados, 163 venceram o
// prazo SEM resposta e só 6 foram revertidos. O dinheiro se perde por falta
// de processo, não por defesa ruim. Então:
//
//   1. todo evento de disputa que a Adyen manda (aviso de fraude, pedido de
//      informação, aviso de chargeback, chargeback, fim de prazo, reversão)
//      abre ou atualiza um CASO na coleção `disputes` - a mesma do "📎
//      Registrar disputa" do Monitor, com o MESMO vocabulário de status
//      (MONITORANDO, ABERTA, ENVIADA, GANHA, PERDIDA - CLAUDE.md §5);
//   2. caso ABERTO e ainda defensável vira uma TAREFA de defesa no Meu Dia
//      do gerente da unidade (Admin e Master veem junto), com prazo interno,
//      lembrete e escalonamento;
//   3. a tarefa tem um questionário e a lista de evidências; concluída, vira
//      um PDF em português, que o Claude/Cowork anexa na Adyen (decisão do
//      Master: a defesa é feita por gente, não por API - a API fica para
//      depois, se houver credencial).
//
// Sem depender do webhook: uma varredura periódica lê os pedidos que o
// store.js já tem em memória (zero leitura de Firestore pra isso) e só grava
// o que mudou. Pega o que chegou pelo webhook E o que já estava lá antes
// desta versão (as disputas abertas hoje ganham tarefa no primeiro deploy).
const crypto = require('crypto');
const disputes = require('./disputes');
const pagamentosArquivo = require('./pagamentosArquivo');

// ---------------------------------------------------------------------
// eventos de disputa (eventCode cru da Adyen; o normalize.js guarda em
// tx.eventCode e às vezes muda o status)
const ABRE = new Set(['NOTIFICATION_OF_CHARGEBACK', 'CHARGEBACK', 'REQUEST_FOR_INFORMATION']);
const AVISO_FRAUDE = 'NOTIFICATION_OF_FRAUD';
const GANHOU = new Set(['CHARGEBACK_REVERSED', 'PREARBITRATION_WON', 'SCHEME_ARBITRATION_WON', 'ISSUER_RESPONSE_TIMEFRAME_EXPIRED']);
const PERDEU = new Set(['SECOND_CHARGEBACK', 'PREARBITRATION_LOST', 'SCHEME_ARBITRATION_LOST']);
const ENVIOU = new Set(['INFORMATION_SUPPLIED']);
const FIM_DE_PRAZO = 'DISPUTE_DEFENSE_PERIOD_ENDED';
const TODOS = new Set([...ABRE, AVISO_FRAUDE, ...GANHOU, ...PERDEU, ...ENVIOU, FIM_DE_PRAZO]);
const FINAIS = new Set(['GANHA', 'PERDIDA', 'ERRO_SISTEMA']);

function codigoDoEvento(h) {
  // o normalize troca CHARGEBACK_REVERSED por CHARGEBACK_REVERTIDO etc; o
  // eventCode cru fica guardado - e é ele que decide
  if (h.eventCode && TODOS.has(h.eventCode)) return h.eventCode;
  if (h.status === 'DISPUTE_DEFENSE_PERIOD_ENDED') return FIM_DE_PRAZO;
  if (h.status === 'CHARGEBACK_REVERTIDO') return 'CHARGEBACK_REVERSED';
  if (h.status === 'NOTIFICATION_OF_CHARGEBACK') return 'NOTIFICATION_OF_CHARGEBACK';
  return h.eventCode || h.status || '';
}
function ehEventoDeDisputa(h) { return TODOS.has(codigoDoEvento(h)); }
function chaveEvento(h) { return `${codigoDoEvento(h)}|${h.dataHora || ''}|${h.pspReference || ''}`; }

// Uma transição por evento, só pra frente. O status atual do caso é a base:
// quem marcou ENVIADA na mão (o Cowork, depois de anexar na Adyen) não é
// desfeito por um evento velho.
function aplicarEvento(status, codigo) {
  if (FINAIS.has(status) && !PERDEU.has(codigo) && !GANHOU.has(codigo)) return { status };
  if (GANHOU.has(codigo)) return { status: 'GANHA', resultado: codigo === 'ISSUER_RESPONSE_TIMEFRAME_EXPIRED' ? 'o banco não respondeu à defesa no prazo' : 'chargeback revertido a nosso favor' };
  if (PERDEU.has(codigo)) return { status: 'PERDIDA', resultado: codigo === 'SECOND_CHARGEBACK' ? 'o banco recusou a defesa (segundo chargeback)' : 'arbitragem perdida' };
  if (ENVIOU.has(codigo)) return { status: 'ENVIADA' };
  if (codigo === FIM_DE_PRAZO) {
    // prazo acabou: se a defesa não foi enviada, está perdida
    if (status === 'ENVIADA') return { status };
    return { status: 'PERDIDA', resultado: 'prazo de defesa vencido sem resposta' };
  }
  if (ABRE.has(codigo)) return { status: status === 'ENVIADA' ? 'ENVIADA' : 'ABERTA' };
  if (codigo === AVISO_FRAUDE) return { status: status || 'MONITORANDO' };
  return { status };
}

// ---------------------------------------------------------------------
// motivo da bandeira em português simples + o que costuma ganhar
const MOTIVOS = [
  { re: /no cardholder authori[sz]ation/i, pt: 'O titular do cartão diz que não autorizou a compra', fraude: true },
  { re: /card absent|card not present|fraud/i, pt: 'Fraude em compra sem o cartão presente', fraude: true },
  { re: /cardholder dispute/i, pt: 'O cliente contesta a compra (produto ou serviço)', fraude: false },
  { re: /paid by other means/i, pt: 'O cliente diz que pagou por outro meio', fraude: false },
  { re: /not received|non.?receipt/i, pt: 'O cliente diz que não recebeu o pedido', fraude: false },
];
function traduzirMotivo(motivo) {
  const m = MOTIVOS.find((x) => x.re.test(String(motivo || '')));
  return m ? { pt: m.pt, fraude: m.fraude } : { pt: String(motivo || 'Motivo não informado pela Adyen'), fraude: false };
}
function dicaDoMotivo(ehFraude) {
  return ehFraude
    ? 'Em fraude, o que mais pesa é provar que o pedido foi entregue a quem pediu: comprovante de entrega no endereço, contato com o cliente e pedidos anteriores dele sem problema.'
    : 'Em contestação da compra, o que mais pesa é a nota fiscal, o comprovante de entrega e a conversa com o cliente.';
}

// ---------------------------------------------------------------------
// prazos
const DIA = 24 * 60 * 60 * 1000;
// prazo interno: 2 dias antes do prazo da Adyen, e nunca mais que 48h
// depois de a tarefa nascer - folga pro Cowork anexar e pra corrigir falta
function prazoInterno(prazoDefesaIso, criadoEmMs) {
  const limite48 = criadoEmMs + 2 * DIA;
  const adyen = Date.parse(prazoDefesaIso || '');
  if (!Number.isFinite(adyen)) return new Date(limite48).toISOString();
  return new Date(Math.max(criadoEmMs + 2 * 60 * 60 * 1000, Math.min(adyen - 2 * DIA, limite48))).toISOString();
}
function dataSP(iso) { return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }); }
function dataBR(iso) { return iso ? new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '—'; }
function dataHoraBR(iso) { return iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }) : '—'; }
function reais(v) { return 'R$ ' + (Number(v) || 0).toFixed(2).replace('.', ','); }

// ---------------------------------------------------------------------
// QUESTIONÁRIO. Uma fonte só: a tela desenha a partir disto e o servidor
// valida por isto. `seDelivery`: obrigatório só quando o pedido foi entregue.
const OPCAO_ACEITAR = 'Aceitar o chargeback';
const QUESTOES = [
  { id: 'numeroPedido', secao: 'Pedido', rotulo: 'Número do pedido no sistema da loja', tipo: 'texto', obrigatorio: true },
  { id: 'canal', secao: 'Pedido', rotulo: 'Por onde o pedido chegou', tipo: 'escolha', opcoes: ["Site Domino's", "App Domino's", 'iFood', 'Telefone', 'Balcão', 'Outro'], obrigatorio: true },
  { id: 'tipoPedido', secao: 'Pedido', rotulo: 'Tipo do pedido', tipo: 'escolha', opcoes: ['Delivery', 'Retirada', 'Consumo no local'], obrigatorio: true },
  { id: 'itens', secao: 'Pedido', rotulo: 'O que foi pedido (itens e valor)', tipo: 'textoLongo', obrigatorio: true },
  { id: 'nomeCliente', secao: 'Cliente', rotulo: 'Nome do cliente no pedido', tipo: 'texto', obrigatorio: true },
  { id: 'telefoneCliente', secao: 'Cliente', rotulo: 'Telefone do cliente', tipo: 'texto', ajuda: 'No PDF sai só o final do número.' },
  { id: 'endereco', secao: 'Cliente', rotulo: 'Endereço de entrega completo, com CEP', tipo: 'textoLongo', seDelivery: true },
  { id: 'clienteRecorrente', secao: 'Cliente', rotulo: 'O cliente já tinha pedido antes na loja?', tipo: 'escolha', opcoes: ['Sim', 'Não', 'Não sei'], obrigatorio: true },
  { id: 'historicoCliente', secao: 'Cliente', rotulo: 'Se sim: quantas vezes e desde quando', tipo: 'texto' },
  { id: 'contatoCliente', secao: 'Cliente', rotulo: 'Houve contato com o cliente (ligação, WhatsApp)?', tipo: 'escolha', opcoes: ['Sim', 'Não'], obrigatorio: true },
  { id: 'resumoContato', secao: 'Cliente', rotulo: 'O que foi conversado', tipo: 'textoLongo', seResposta: { contatoCliente: 'Sim' } },
  { id: 'entregador', secao: 'Entrega', rotulo: 'Entregador (nome) e tipo: próprio, terceirizado ou app', tipo: 'texto', seDelivery: true },
  { id: 'horaSaida', secao: 'Entrega', rotulo: 'Hora de saída', tipo: 'hora', seDelivery: true },
  { id: 'horaEntrega', secao: 'Entrega', rotulo: 'Hora da entrega', tipo: 'hora', seDelivery: true },
  { id: 'quemRecebeu', secao: 'Entrega', rotulo: 'Quem recebeu o pedido (nome)', tipo: 'texto', seDelivery: true },
  { id: 'mesmaPessoa', secao: 'Entrega', rotulo: 'Quem recebeu é a mesma pessoa do pedido?', tipo: 'escolha', opcoes: ['Sim', 'Não', 'Não sei'], seDelivery: true },
  { id: 'foraDoNormal', secao: 'Entrega', rotulo: 'Algo fora do normal?', tipo: 'multi', opcoes: ['Pediu para deixar na portaria ou fora de casa', 'Endereço diferente do habitual', 'Recebeu na rua', 'Vários pedidos seguidos', 'Pressa ou insistência', 'Pagamento recusado antes', 'Nada fora do normal'], obrigatorio: true },
  { id: 'foraDoNormalTexto', secao: 'Entrega', rotulo: 'Detalhe do que foi fora do normal', tipo: 'textoLongo' },
  { id: 'decisao', secao: 'Decisão', rotulo: 'Temos como contestar?', tipo: 'escolha', opcoes: ['Contestar', OPCAO_ACEITAR], obrigatorio: true, ajuda: 'Sem comprovante de entrega nem contato com o cliente, contestar fraude quase sempre perde - aceitar evita trabalho à toa e o caso ainda ensina o NoPulso.' },
  { id: 'declaracao', secao: 'Decisão', rotulo: 'Confirmo que as informações acima são verdadeiras', tipo: 'confirma', obrigatorio: true },
];
const EVIDENCIAS = [
  { id: 'nota-fiscal', rotulo: 'Cupom ou nota fiscal do pedido', obrigatorio: true },
  { id: 'print-pedido', rotulo: 'Print do pedido no sistema da loja (data, hora, itens e valor)', obrigatorio: true },
  { id: 'comprovante-entrega', rotulo: 'Comprovante de entrega (foto na porta, assinatura ou print do app do entregador)', seDelivery: true },
  { id: 'conversa', rotulo: 'Prints da conversa com o cliente' },
  { id: 'camera', rotulo: 'Imagem de câmera (retirada ou balcão)' },
  { id: 'historico', rotulo: 'Histórico de pedidos anteriores do cliente' },
];
// quem decide aceitar só precisa registrar o essencial (o caso ainda
// ensina o NoPulso), sem montar evidência que não vai ser usada
const OBRIGATORIAS_AO_ACEITAR = new Set(['numeroPedido', 'nomeCliente', 'decisao', 'declaracao']);
// o que só a unidade responde: contestar ou aceitar, e declarar que é verdade.
// O Claude pode recomendar num comentário, nunca marcar (tarefas.preencherDefesaPeloAgente)
const SO_A_UNIDADE = new Set(['decisao', 'declaracao']);

function vazio(v) { return v == null || (Array.isArray(v) ? !v.length : !String(v).trim()) || v === false; }
function exigida(q, respostas) {
  if (respostas.decisao === OPCAO_ACEITAR) return OBRIGATORIAS_AO_ACEITAR.has(q.id);
  if (q.obrigatorio) return true;
  if (q.seDelivery) return respostas.tipoPedido === 'Delivery';
  if (q.seResposta) return Object.entries(q.seResposta).every(([k, v]) => respostas[k] === v);
  return false;
}
// o que falta pra concluir (rótulos, na ordem da tela)
function faltando(respostas = {}, anexos = []) {
  const r = respostas || {};
  const falta = QUESTOES.filter((q) => exigida(q, r) && vazio(r[q.id])).map((q) => q.rotulo);
  if (r.decisao !== OPCAO_ACEITAR) {
    const tem = new Set((anexos || []).map((a) => a && a.evidencia).filter(Boolean));
    for (const e of EVIDENCIAS) {
      const precisa = e.obrigatorio || (e.seDelivery && r.tipoPedido === 'Delivery');
      if (precisa && !tem.has(e.id)) falta.push(`Anexo: ${e.rotulo}`);
    }
  }
  return falta;
}
// limpa o que a tela mandou: só ids conhecidos, só opções válidas
function limparRespostas(entrada = {}) {
  const saida = {};
  for (const q of QUESTOES) {
    const v = entrada[q.id];
    if (v == null) continue;
    if (q.tipo === 'escolha') { if (q.opcoes.includes(v)) saida[q.id] = v; continue; }
    if (q.tipo === 'multi') { const lista = (Array.isArray(v) ? v : [v]).filter((x) => q.opcoes.includes(x)); if (lista.length) saida[q.id] = lista; continue; }
    if (q.tipo === 'confirma') { saida[q.id] = v === true || v === 'true' || v === 'on'; continue; }
    if (q.tipo === 'hora') { if (/^\d{2}:\d{2}$/.test(String(v))) saida[q.id] = String(v); continue; }
    saida[q.id] = String(v).trim().slice(0, q.tipo === 'textoLongo' ? 2000 : 300);
  }
  return saida;
}

// ---------------------------------------------------------------------
// dado sensível NÃO vai pro PDF: a Adyen recusa documento com CPF ou número
// de cartão, e a defesa não precisa deles
function mascararSensiveis(texto) {
  return String(texto == null ? '' : texto)
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '•••.•••.•••-••')
    .replace(/\b(?:\d[ -]?){13,19}\b/g, (m) => '•••• ' + m.replace(/\D/g, '').slice(-4));
}
function mascararTelefone(t) {
  const d = String(t || '').replace(/\D/g, '');
  return d.length >= 4 ? '•••• ' + d.slice(-4) : (d ? '••••' : '');
}

// ---------------------------------------------------------------------
// o caso a partir do pedido que o store.js já tem em memória
function eventosDoPedido(txs) {
  return (txs || []).filter(ehEventoDeDisputa)
    .sort((a, b) => String(a.dataHora || '').localeCompare(String(b.dataHora || '')));
}
function idDoCaso(pedidoId) {
  return 'adyen_' + String(pedidoId || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);
}

// Estado novo do caso a partir do atual + eventos ainda não vistos. Puro:
// o teste roda a sequência da Adyen e confere o status final.
function evoluirCaso(atual, txs, agoraMs = Date.now()) {
  const eventos = eventosDoPedido(txs);
  const vistos = new Set((atual && atual.eventosVistos) || []);
  let status = (atual && atual.status) || null;
  let resultado = (atual && atual.resultado) || null;
  const novos = [];
  for (const ev of eventos) {
    const k = chaveEvento(ev);
    if (vistos.has(k)) continue;
    vistos.add(k); novos.push(ev);
    const r = aplicarEvento(status, codigoDoEvento(ev));
    status = r.status; if (r.resultado) resultado = r.resultado;
  }
  const todos = eventos;
  const comPrazo = [...todos].reverse().find((e) => e.prazoDefesa);
  const comMotivo = [...todos].reverse().find((e) => ABRE.has(codigoDoEvento(e)) && e.motivo) || [...todos].reverse().find((e) => e.motivo);
  // o que o BANCO escreveu, palavra por palavra - o `motivoAdyen` vira frase
  // pronta em `traduzirMotivo()` e perde o que é específico deste caso (na
  // #12084, um terceiro nome: "KARLA GARCIA ALVES")
  // `todos` já são SÓ eventos de disputa (eventosDoPedido filtra por
  // ehEventoDeDisputa), e é isso que impede o `reason` de uma AUTORIZAÇÃO
  // RECUSADA - que o normalize também guarda em `comentarioEmissor` - entrar
  // na tarefa como "o banco escreveu: Do not honor". Cheguei a repetir esse
  // filtro aqui e tirei: era código que nunca mudava nada, e um guarda que
  // não guarda é pior que nenhum, porque a próxima pessoa confia nele.
  const comEmissor = [...todos].reverse().find((e) => ABRE.has(codigoDoEvento(e)) && e.comentarioEmissor)
    || [...todos].reverse().find((e) => e.comentarioEmissor);
  const abertura = todos.find((e) => ABRE.has(codigoDoEvento(e)));
  const aviso = todos.find((e) => codigoDoEvento(e) === AVISO_FRAUDE);
  return {
    status: status || 'MONITORANDO', resultado, novos,
    eventosVistos: [...vistos].slice(-60),
    prazoDefesa: comPrazo ? comPrazo.prazoDefesa : ((atual && atual.prazoDefesa) || null),
    motivoAdyen: comMotivo ? comMotivo.motivo : ((atual && atual.motivoAdyen) || null),
    comentarioEmissor: comEmissor ? comEmissor.comentarioEmissor : ((atual && atual.comentarioEmissor) || null),
    pspDisputa: abertura ? abertura.pspReference : ((atual && atual.pspDisputa) || null),
    abertoEm: abertura ? abertura.dataHora : ((atual && atual.abertoEm) || null),
    avisoFraudeEm: aviso ? aviso.dataHora : ((atual && atual.avisoFraudeEm) || null),
    ultimoEvento: todos.length ? codigoDoEvento(todos[todos.length - 1]) : ((atual && atual.ultimoEvento) || null),
    // defensável agora: aberto, sem defesa enviada, e o prazo da Adyen não passou
    defensavel: status === 'ABERTA' && (!comPrazo || Date.parse(comPrazo.prazoDefesa) > agoraMs),
  };
}

// ---------------------------------------------------------------------
// QUEM RESPONDE: o gerente da unidade (Admin e outros gerentes da unidade
// entram como participantes; o Master vê tudo). Sem gerente cadastrado na
// unidade, a tarefa cai no Master - nunca fica sem dono.
function temCargo(u, cargo) { return u.cargo === cargo || (u.cargos || []).includes(cargo); }
function daUnidade(u, unidade) { return !!(u.permissions && (u.permissions.unidades || []).includes(unidade)); }
function equipeDaUnidade(lista, unidade, masterPreferido) {
  const ativos = (lista || []).filter((u) => u && u.active !== false && u.role !== 'master');
  const porNome = (a, b) => String(a.username || a.email).localeCompare(String(b.username || b.email));
  const gerentes = ativos.filter((u) => temCargo(u, 'gerente') && daUnidade(u, unidade)).sort(porNome);
  const apoio = ativos.filter((u) => (temCargo(u, 'assistente-gerente') || u.isAdmin) && daUnidade(u, unidade)).sort(porNome);
  const masters = (lista || []).filter((u) => u && u.active !== false && u.role === 'master')
    .sort((a, b) => (String(b.email).toLowerCase() === masterPreferido) - (String(a.email).toLowerCase() === masterPreferido) || porNome(a, b));
  const responsavel = gerentes[0] || masters[0] || null;
  const colaboradores = [...gerentes.slice(1), ...apoio].filter((u) => !responsavel || u.id !== responsavel.id);
  return { responsavel, colaboradores, criador: masters[0] || responsavel, masters };
}

function textoDaTarefa(caso, pedido, prazoInt) {
  const m = traduzirMotivo(caso.motivoAdyen);
  // SEM DATA, A TAREFA DIZ QUE NÃO ACHOU - e não inventa.
  //
  // Até 24/09 a data do chargeback entrava aqui como se fosse a da compra
  // (#12084: compra de 01/09 descrita como 06/09). A loja procurava no
  // sistema dela um pedido que não existia naquele dia, não achava, e a
  // defesa morria. Dizer "não encontrada" manda a pessoa procurar pelo valor
  // e pelo nome, que é o que funciona.
  const linhaPagamento = pedido.dataCompra
    ? `Pagamento: ${reais(pedido.valor)} em ${dataHoraBR(pedido.dataCompra)}${pedido.last4 ? `, cartão final ${pedido.last4}` : ''}${pedido.metodo ? ` (${String(pedido.metodo).toUpperCase()})` : ''}.`
    : `Pagamento: ${reais(pedido.valor)}${pedido.last4 ? `, cartão final ${pedido.last4}` : ''}${pedido.metodo ? ` (${String(pedido.metodo).toUpperCase()})` : ''} - data da compra não encontrada. Procure no sistema da loja pelo valor e pelo nome do cliente.`;
  const linhas = [
    `A Adyen avisou de um chargeback: ${m.pt}.`,
    linhaPagamento,
    ...(caso.comentarioEmissor && caso.comentarioEmissor.trim().toLowerCase() !== String(m.pt).trim().toLowerCase()
      ? [`O banco escreveu: "${caso.comentarioEmissor}".`] : []),
    `Prazo da Adyen: ${dataBR(caso.prazoDefesa)}. Responda até ${dataHoraBR(prazoInt)} - sem resposta, o valor fica com o banco.`,
    'Preencha a "Defesa de chargeback" abaixo e anexe as evidências. Ao concluir, o NoPulso gera o PDF e o Claude anexa na Adyen.',
    dicaDoMotivo(m.fraude),
  ];
  return linhas.join('\n');
}

// ---------------------------------------------------------------------
// O COMENTÁRIO QUE O NOPULSO DEIXA NA TAREFA (Master, 24/09/2026).
//
// "nada de Chrome": a tarefa tem que chegar com tudo que é FATO da Adyen já
// escrito, pra loja não precisar abrir a Customer Area nem esperar o Claude.
//
// É TEXTO DE REGRA, NÃO DE MODELO. Nenhuma frase aqui é gerada por IA - a
// leitura ("defesa forte/fraca") sai de duas condições fixas sobre 3DS e
// endereço de entrega. Um parágrafo bonito que o modelo escrevesse sobre a
// chance de ganhar seria exatamente o número inventado que o CLAUDE.md §6
// proíbe: a loja decide contestar ou aceitar em cima disso.
//
// TELEFONE E E-MAIL NÃO ENTRAM NO TEXTO. Eles vão pro CAMPO da defesa, pelo
// servidor (sugestoesDaAdyen). O comentário é lido pelo Claude quando ele
// abre a tarefa - mesma regra do `obter_pagamento_adyen`.
function textoDoComentarioAutomatico({ dados, historico, caso, pedido, prazoInt }) {
  const m = traduzirMotivo(caso.motivoAdyen);
  const d = dados || {};
  const sim = (v) => /^(true|sim|yes|y|1)$/i.test(String(v || ''));
  const ou = (v, alt) => (v == null || v === '' ? (alt || '—') : v);
  const linhas = [];

  linhas.push('🤖 NoPulso preencheu o que é fato da Adyen. Confira antes de concluir.');
  linhas.push('');
  linhas.push('PEDIDO');
  linhas.push(`· Referência: ${ou(d.merchantReference || caso.pedidoId)}`);
  linhas.push(`· Conta Adyen: ${ou(d.merchantAccountCode)}`);
  linhas.push(pedido.dataCompra
    ? `· Pagamento: ${dataHoraBR(pedido.dataCompra)} · ${reais(pedido.valor)}`
    : `· Pagamento: ${reais(pedido.valor)} · DATA NÃO ENCONTRADA (o Monitor já tinha apagado a venda quando o chargeback chegou)`);
  linhas.push(`· PSP do pagamento: ${ou(d.pspPagamento || caso.pspPagamento)}`);
  linhas.push(`· PSP da disputa: ${ou(caso.pspDisputa)}`);
  linhas.push('');
  linhas.push('CLIENTE');
  linhas.push(`· Nome no pedido: ${ou(d.nomeCliente)}`);
  linhas.push(`· Titular do cartão: ${ou(d.nomeNoCartao || pedido.cardHolder)}`);
  linhas.push(`· Cartão: ${ou(pedido.metodo && String(pedido.metodo).toUpperCase())}${pedido.last4 ? ` final ${pedido.last4}` : ''}${d.bin ? ` · BIN ${d.bin}` : ''}`);
  linhas.push(`· Banco emissor: ${ou(d.bancoEmissor)}${d.paisEmissor ? ` (${d.paisEmissor})` : ''}`);
  linhas.push(`· Cartão salvo na conta: ${d.aliasCartao ? 'sim' : 'não'}`);
  linhas.push('');
  linhas.push('RISCO');
  const sinais = sinaisDaDefesa(d);
  if (sinais.length) for (const s of sinais) linhas.push(`· ${s.sinal} — ${s.leitura}`);
  else linhas.push('· A Adyen não mandou sinal de risco neste pagamento.');
  if (historico && historico.pedidos && historico.pedidos.length) {
    linhas.push(`· Mesmo cliente: pelo menos ${historico.aprovadosSemDisputa} pedido(s) aprovado(s) sem disputa${historico.comDisputa ? ` e ${historico.comDisputa} com disputa` : ''} no que o Monitor guarda.`);
  }
  linhas.push('');
  linhas.push('MOTIVO DA CONTESTAÇÃO');
  linhas.push(`· ${ou(caso.motivoAdyen)} — ${m.pt}`);
  if (caso.comentarioEmissor) linhas.push(`· O banco escreveu: "${caso.comentarioEmissor}"`);
  linhas.push('');
  linhas.push('PARA A LOJA BUSCAR');
  const quando = pedido.dataCompra ? dataHoraBR(pedido.dataCompra) : 'na data que bater com o valor';
  linhas.push(`· Localize no sistema o pedido de ${quando}, em nome de ${ou(d.nomeCliente, 'cliente não informado')}, ${reais(pedido.valor)}.`);
  linhas.push('· Dele saem: número do pedido, endereço, telefone, itens e entregador.');
  linhas.push('· Anexe o print do pedido no sistema e o cupom ou nota fiscal.');
  linhas.push('');
  // LEITURA: duas condições fixas, e só. Sem 3DS e sem endereço de entrega, a
  // defesa depende de prova que a loja pode não ter - dizer isso antes evita
  // a unidade gastar o prazo montando uma defesa que já nasce perdida.
  const tem3DS = sim(d.threeDAutenticado);
  const temEntrega = d.enderecoTipo === 'entrega';
  linhas.push('LEITURA');
  if (tem3DS) linhas.push('· Defesa forte: o 3DS foi autenticado, e isso costuma transferir a responsabilidade ao banco emissor.');
  else if (!temEntrega) linhas.push('· Defesa fraca: sem 3DS e sem endereço de entrega. Só conteste com prova de entrega ao titular ou com pedidos anteriores do mesmo cliente sem contestação.');
  else linhas.push('· Sem 3DS: a defesa depende de provar a entrega no endereço do pedido. O comprovante de entrega é a peça principal.');
  linhas.push(`· Responda até ${dataHoraBR(prazoInt)} - sem resposta, o valor fica com o banco.`);
  return linhas.join('\n');
}

// ---------------------------------------------------------------------
// A VARREDURA. Deps injetadas: o teste passa as de mentira e confere.
const JANELA_HISTORICO_MS = 60 * DIA; // disputa mais velha que isso sem caso: não abre caso novo
let rodando = false;
function chaveDoPedido(tx) { return tx.merchantReference || tx.originalReference || tx.pspReference; }

async function sincronizar({ store, users, tarefas, push, nomeUnidade = (c) => c, agora = Date.now(), masterPreferido = '', aoAlterarTarefa = null }) {
  if (rodando) return { pulou: true };
  rodando = true;
  const r = { casosNovos: 0, casosAtualizados: 0, tarefasCriadas: 0, avisosFraude: 0, lembretes: 0, escalonados: 0, vencidos: 0 };
  try {
    const txs = store.allTransactions();
    const comDisputa = new Set();
    for (const t of txs) if (ehEventoDeDisputa(t)) comDisputa.add(chaveDoPedido(t));
    const porPedido = new Map();
    for (const t of txs) { const k = chaveDoPedido(t); if (comDisputa.has(k)) { if (!porPedido.has(k)) porPedido.set(k, []); porPedido.get(k).push(t); } }

    const casos = await disputes.listAll();
    const casoDoPedido = new Map();
    // o caso aberto pela Adyen ganha do registro manual do mesmo pedido; se só
    // existe o manual, ele É o caso (não duplica o que a pessoa já registrou)
    for (const c of casos) {
      const atual = casoDoPedido.get(c.pedidoId);
      if (!atual || (c.origem === 'adyen' && atual.origem !== 'adyen')) casoDoPedido.set(c.pedidoId, c);
    }
    let equipeCache = null;
    const equipe = async (unidade) => {
      if (!equipeCache) equipeCache = await users.list();
      return equipeDaUnidade(equipeCache, unidade, masterPreferido);
    };

    for (const [pedidoId, lista] of porPedido) {
      const caso = casoDoPedido.get(pedidoId) || null;
      const evo = evoluirCaso(caso, lista, agora);
      const eventos = eventosDoPedido(lista);
      const ultimo = eventos[eventos.length - 1];
      if (!caso && ultimo && agora - Date.parse(ultimo.dataHora || 0) > JANELA_HISTORICO_MS) continue;
      const precisaTarefa = evo.defensavel && !(caso && caso.tarefaId);
      if (caso && !evo.novos.length && !precisaTarefa) continue;

      const ordenados = [...lista].sort((a, b) => String(a.dataHora || '').localeCompare(String(b.dataHora || '')));
      // O PAGAMENTO, DE VERDADE (Master, 24/09/2026).
      //
      // Aqui morava o erro da #12084. Era `find(APROVADO) || ordenados[0]`, e
      // quando a autorização já tinha sido apagada pela retenção de 2 dias do
      // Monitor, `ordenados[0]` era o PRÓPRIO evento de disputa: a tarefa
      // saiu dizendo que a compra foi 06/09 (a data do chargeback) e gravou o
      // PSP da disputa como se fosse o do pagamento.
      //
      // Agora: memória primeiro; não achando, o arquivo de 180 dias
      // (pagamentosArquivo). A ficha entra COMO SE fosse o evento aprovado,
      // pra `dadosDoPagamento`, `sugestoesDaAdyen` e `mesmoCliente` seguirem
      // funcionando igual.
      //
      // E não achando em lugar nenhum, fica NULO. Uma data errada é pior que
      // uma data faltando: a loja procura no sistema dela um pedido que não
      // existe naquele dia, não acha, e a defesa morre aí.
      let pagamento = ordenados.find((t) => t.status === 'APROVADO') || null;
      let doArquivo = null;
      if (!pagamento) {
        try {
          doArquivo = await pagamentosArquivo.buscar(pedidoId, (ultimo && ultimo.dataHora) || null);
        } catch (err) {
          console.error('[defesa] não consegui ler o arquivo de pagamentos:', err.message);
        }
        if (doArquivo) pagamento = { ...doArquivo, status: 'APROVADO' };
      }
      const pedido = {
        valor: (pagamento && pagamento.valor) || (ultimo && ultimo.valor) || 0,
        dataCompra: pagamento ? pagamento.dataHora : null,
        last4: (pagamento && pagamento.last4) || (ordenados.find((t) => t.last4) || {}).last4 || null,
        metodo: (pagamento && pagamento.metodo) || (ordenados.find((t) => t.metodo) || {}).metodo || null,
        cardHolder: (pagamento && pagamento.cardHolder) || (ordenados.find((t) => t.cardHolder) || {}).cardHolder || null,
        unidade: (pagamento && pagamento.unidade) || (ordenados.find((t) => t.unidade) || {}).unidade || null,
      };
      const id = caso ? caso.id : idDoCaso(pedidoId);
      const patch = {
        pedidoId, origem: caso && caso.origem !== 'adyen' && !caso.pspPagamento ? (caso.origem || 'manual') : 'adyen',
        unidade: (caso && caso.unidade) || pedido.unidade,
        status: evo.status, resultado: evo.resultado, eventosVistos: evo.eventosVistos,
        prazoDefesa: evo.prazoDefesa, motivoAdyen: evo.motivoAdyen, comentarioEmissor: evo.comentarioEmissor, pspDisputa: evo.pspDisputa,
        // nulo quando não achei o pagamento: o PSP da disputa NÃO entra aqui
        pspPagamento: pagamento ? (pagamento.pspReference || null) : null,
        pagamentoDoArquivo: !!doArquivo,
        abertoEm: evo.abertoEm, avisoFraudeEm: evo.avisoFraudeEm, ultimoEvento: evo.ultimoEvento,
        valor: pedido.valor, dataCompra: pedido.dataCompra, last4: pedido.last4, metodo: pedido.metodo,
      };
      if (!caso) Object.assign(patch, { criadoEm: new Date(agora).toISOString(), notas: '', anexos: [], nomeContato: '', telefoneContato: '' });

      // aviso de fraude: alarme cheio - o pedido já foi, o próximo não pode ir
      // só aviso das últimas 24h: no primeiro deploy a varredura vê como
      // "novos" todos os avisos guardados, e cada um tocaria a sirene
      if (evo.novos.some((e) => codigoDoEvento(e) === AVISO_FRAUDE && agora - Date.parse(e.dataHora || 0) < DIA)) {
        r.avisosFraude++;
        await push.notifyCritico(`🚨 Aviso de fraude da Adyen — ${nomeUnidade(pedido.unidade)}`,
          `${reais(pedido.valor)}${pedido.last4 ? ` · cartão final ${pedido.last4}` : ''} · ${dataHoraBR(pedido.dataCompra)}. O chargeback costuma vir em dias.`,
          `aviso-fraude-${pedidoId}`, pedido.unidade).catch(() => {});
      }

      if (precisaTarefa) {
        const eq = await equipe(pedido.unidade);
        if (eq.responsavel) {
          const prazoInt = prazoInterno(evo.prazoDefesa, agora);
          const motivo = traduzirMotivo(evo.motivoAdyen);
          const tarefa = await tarefas.criar({
            titulo: `⚖️ Defesa de chargeback · ${reais(pedido.valor)} · ${nomeUnidade(pedido.unidade)} · até ${dataBR(prazoInt)}`,
            descricao: textoDaTarefa({ ...patch }, pedido, prazoInt),
            dataInicio: dataSP(new Date(agora).toISOString()), dataEntrega: dataSP(prazoInt),
            unidade: pedido.unidade, unidadeNome: nomeUnidade(pedido.unidade),
            usuario: eq.criador, responsavel: eq.responsavel, colaboradores: eq.colaboradores,
            prioridade: 'critica', origem: 'chargeback',
            defesaChargeback: { disputaId: id, pedidoId, prazoDefesa: evo.prazoDefesa, prazoInterno: prazoInt, motivo: motivo.pt },
          });
          Object.assign(patch, { tarefaId: tarefa.id, tarefaNumero: tarefa.numeroTicket || null, tarefaCriadaEm: new Date(agora).toISOString(), prazoInterno: prazoInt, responsavelId: eq.responsavel.id, responsavelNome: eq.responsavel.username || eq.responsavel.email });
          r.tarefasCriadas++;

          // A TAREFA JÁ NASCE PREENCHIDA (Master, 24/09/2026: "nada de
          // Chrome"). O que é fato da Adyen o servidor escreve sozinho; o que
          // depende de olhar o sistema da loja fica pra unidade. Decisão e
          // declaração NUNCA - contestar ou aceitar, e jurar que é verdade, é
          // dela (preencherDefesaPeloAgente recusa por SO_A_UNIDADE).
          //
          // TUDO AQUI É BEST-EFFORT: se o arquivo do Storage estiver fora, ou
          // o pré-preenchimento falhar, a tarefa nasce do mesmo jeito. Uma
          // defesa sem os campos preenchidos ainda dá pra responder na mão;
          // uma defesa que não nasceu perde o prazo.
          try {
            const doPedido = pagamento ? [...ordenados.filter((t) => t !== pagamento), pagamento] : ordenados;
            const d = dadosDoPagamento(doPedido);
            const hist = mesmoCliente(store.allTransactions(), d, pedidoId);
            const s = sugestoesDaAdyen(d, hist);
            if (Object.keys(s.campos).length) {
              await tarefas.preencherDefesaPeloAgente(tarefa.id, s.campos, { fontes: s.fontes, porNome: 'NoPulso (automático)' });
            }
            const texto = textoDoComentarioAutomatico({
              dados: { ...d, pspPagamento: patch.pspPagamento }, historico: hist,
              caso: { ...patch, motivoAdyen: evo.motivoAdyen }, pedido, prazoInt,
            });
            const res = await tarefas.comentarComoAgente(tarefa.id, texto, { porNome: 'NoPulso (automático)' });
            // a tela aberta atualiza sem F5 (ver zenithAoVivo no tema.js)
            if (res && res.tarefa && typeof aoAlterarTarefa === 'function') aoAlterarTarefa(res.tarefa);
          } catch (err) {
            console.error(`[defesa] tarefa ${tarefa.id} nasceu, mas o pré-preenchimento falhou:`, err.message);
          }

          push.notifyUsuario(eq.responsavel.id, `⚖️ Chargeback de ${reais(pedido.valor)} para defender`,
            `${nomeUnidade(pedido.unidade)} · responda até ${dataHoraBR(prazoInt)} no Meu Dia`, `defesa-${id}`, `/tarefas?tarefa=${encodeURIComponent(tarefa.id)}`).catch(() => {});
        }
      }
      await disputes.salvarCaso(id, patch);
      if (caso) r.casosAtualizados++; else r.casosNovos++;
    }

    // PRAZO VENCIDO SEM DEFESA = PERDIDA (Master, 24/09/2026).
    //
    // 24 casos estavam ABERTA com o prazo da Adyen vencido - alguns desde
    // 29/07. Eles ficavam na lista como se ainda desse pra fazer algo, e
    // empurravam pra baixo os que de fato ainda dá. A Adyen nem sempre manda
    // o DISPUTE_DEFENSE_PERIOD_ENDED, então esperar o evento deixa o caso
    // preso pra sempre.
    //
    // SÓ MUDA O STATUS. Mesmo texto que o evento da Adyen já gravava
    // ("prazo de defesa vencido sem resposta"), nada de histórico reescrito -
    // CLAUDE.md §1: não escrever migração nova sobre dado antigo. E não toca
    // em quem já mandou a defesa (ENVIADA, ou defesaProntaEm): esse espera o
    // veredito da bandeira, não venceu nada.
    // ...e o LEMBRETE e o ESCALONAMENTO, na MESMA passada - sobre o que já
    // está gravado, sem ler tarefa: a conclusão marca `defesaProntaEm` no
    // caso (aoConcluirTarefa).
    //
    // UMA passada, não duas. A primeira versão disto tinha um `listAll()` só
    // pro prazo vencido e outro pros lembretes. Parecia de graça porque
    // `listAll` é cacheado - mas `salvarCaso` invalida o cache, e o laço de
    // cima grava. O segundo `listAll` relia a coleção INTEIRA, a cada 3
    // minutos, todo dia (CLAUDE.md §3). Junto, custa zero a mais.
    for (const c of await disputes.listAll()) {
      // PRAZO VENCIDO SEM DEFESA = PERDIDA (Master, 24/09/2026).
      //
      // 24 casos estavam ABERTA com o prazo da Adyen vencido - alguns desde
      // 29/07. Ficavam na lista como se ainda desse pra fazer algo e
      // empurravam pra baixo os que de fato dá. A Adyen nem sempre manda o
      // DISPUTE_DEFENSE_PERIOD_ENDED, então esperar o evento deixa o caso
      // preso pra sempre. Vem ANTES do filtro de lembrete de propósito: os
      // presos não têm tarefa, e o filtro de baixo exige `tarefaId`.
      //
      // SÓ MUDA O STATUS, com o mesmo texto que o evento da Adyen já gravava
      // - nada de migração nova sobre dado antigo (CLAUDE.md §1). E não toca
      // em quem já mandou a defesa: esse espera o veredito da bandeira.
      if (c.status === 'ABERTA' && !c.defesaProntaEm && !c.envioAdyen) {
        const prazo = Date.parse(c.prazoDefesa || '');
        if (Number.isFinite(prazo) && prazo <= agora) {
          await disputes.salvarCaso(c.id, { status: 'PERDIDA', resultado: 'prazo de defesa vencido sem resposta', fechadoPorPrazoEm: new Date(agora).toISOString() });
          r.vencidos = (r.vencidos || 0) + 1;
          continue; // acabou: não cobra lembrete de quem já foi fechado
        }
      }
      if (c.status !== 'ABERTA' || !c.tarefaId || c.defesaProntaEm) continue;
      const criada = Date.parse(c.tarefaCriadaEm || 0);
      const limite = Date.parse(c.prazoInterno || 0);
      if (!c.lembreteEm && Number.isFinite(criada) && agora - criada >= DIA) {
        await push.notifyUsuario(c.responsavelId, '⚖️ Defesa de chargeback ainda sem resposta',
          `${nomeUnidade(c.unidade)} · ${reais(c.valor)} · prazo ${dataHoraBR(c.prazoInterno)}`, `defesa-${c.id}`, `/tarefas?tarefa=${encodeURIComponent(c.tarefaId)}`).catch(() => {});
        await disputes.salvarCaso(c.id, { lembreteEm: new Date(agora).toISOString() });
        r.lembretes++;
      }
      if (!c.escalonadoEm && Number.isFinite(limite) && agora >= limite - 12 * 60 * 60 * 1000) {
        const eq = await equipe(c.unidade);
        for (const m of eq.masters) {
          await push.notifyUsuario(m.id, `⏰ Chargeback sem defesa: ${reais(c.valor)} · ${nomeUnidade(c.unidade)}`,
            `A unidade não respondeu e o prazo interno vence ${dataHoraBR(c.prazoInterno)}.`, `defesa-escala-${c.id}`, `/tarefas?tarefa=${encodeURIComponent(c.tarefaId)}`).catch(() => {});
        }
        await disputes.salvarCaso(c.id, { escalonadoEm: new Date(agora).toISOString() });
        r.escalonados++;
      }
    }
    return r;
  } finally {
    rodando = false;
  }
}

// ---------------------------------------------------------------------
// DADOS DA ADYEN PRO CLAUDE (coworkApi `obter_pagamento_adyen` e
// `preencher_defesa`, 24/09/2026). Tudo sai do que o store.js já tem em
// memória: zero leitura de Firestore e nenhuma chamada à Adyen. O pedido com
// disputa fica guardado inteiro (EVENTOS_PROTEGIDOS no store.js), então o
// pagamento original está aqui mesmo semanas depois.
//
// Telefone e e-mail do cliente NÃO vão pro Claude (mesma regra do
// obter_disputa): quando precisam entrar na defesa, o próprio servidor copia
// da Adyen pro campo (sugestoesDaAdyen), sem passar pelo modelo.
function mascararEmail(v) {
  const s = String(v || ''); const i = s.indexOf('@');
  return i > 0 ? `${s[0]}•••${s.slice(i)}` : (s ? '•••' : null);
}
function primeiroCom(txs, campo) { const t = (txs || []).find((x) => x && x[campo] != null && x[campo] !== ''); return t ? t[campo] : null; }

// o retrato do pagamento, a partir de TODOS os eventos do pedido (a Adyen nem
// sempre repete o dado do cliente nos eventos de disputa)
function dadosDoPagamento(txs) {
  const ordenados = [...(txs || [])].sort((a, b) => String(a.dataHora || '').localeCompare(String(b.dataHora || '')));
  const pagamento = ordenados.find((t) => t.status === 'APROVADO') || ordenados[0] || {};
  const doPedido = [pagamento, ...ordenados];
  const c = (campo) => primeiroCom(doPedido, campo);
  return {
    pspPagamento: pagamento.pspReference || null, merchantReference: c('merchantReference'),
    unidade: c('unidade'), valor: pagamento.valor ?? c('valor'), dataCompra: pagamento.dataHora || null,
    metodo: c('metodo'), last4: c('last4'), bin: c('bin'), aliasCartao: c('aliasCartao'),
    nomeCliente: c('nomeCliente'), nomeNoCartao: c('cardHolder'),
    emailCliente: c('emailCliente'), telefoneCliente: c('telefoneCliente'),
    enderecoCliente: c('enderecoCliente'), enderecoTipo: c('enderecoTipo'),
    shopperIp: c('shopperIp'), paisCliente: c('paisCliente'), paisEmissor: c('paisEmissor'),
    bancoEmissor: c('bancoEmissor'), fonteCartao: c('fonteCartao'),
    threeDOferecido: c('threeDOferecido'), threeDAutenticado: c('threeDAutenticado'),
    resultadoAvs: c('resultadoAvs'), resultadoCvc: c('resultadoCvc'),
    scoreRiscoAdyen: c('scoreRiscoAdyen'), resultadoRiscoAdyen: c('resultadoRiscoAdyen'),
    dispositivo: c('dispositivo'), navegador: c('navegador'),
    shopperReference: c('shopperReference'),
    eventos: ordenados.map((t) => ({ evento: t.eventCode || t.status, status: t.status, em: t.dataHora || null, valor: t.valor ?? null, motivo: t.motivo || null })),
  };
}

// o que o banco olha numa fraude sem cartão presente, em fato - não em veredito
function sinaisDaDefesa(d) {
  const sim = (v) => /^(true|sim|yes|y|1)$/i.test(String(v || ''));
  const s = [];
  if (sim(d.threeDAutenticado)) s.push({ sinal: '3DS autenticado', peso: 'forte', leitura: 'O titular passou pela autenticação do banco: em fraude, costuma transferir a responsabilidade para o emissor.' });
  else if (d.threeDAutenticado != null) s.push({ sinal: 'Sem autenticação 3DS', peso: 'contra', leitura: 'Sem 3DS, a defesa depende de provar a entrega a quem pediu.' });
  if (d.enderecoTipo === 'entrega') s.push({ sinal: 'Endereço de entrega informado', peso: 'apoio', leitura: 'Comprovante de entrega nesse endereço é a prova principal.' });
  if (d.paisEmissor && d.paisCliente && String(d.paisEmissor).toUpperCase() !== String(d.paisCliente).toUpperCase()) s.push({ sinal: `País do cartão (${d.paisEmissor}) diferente do país do cliente (${d.paisCliente})`, peso: 'contra', leitura: 'Padrão comum em cartão clonado.' });
  if (/^[CN]/i.test(String(d.resultadoCvc || '')) || /no match|não confere/i.test(String(d.resultadoCvc || ''))) s.push({ sinal: `CVC: ${d.resultadoCvc}`, peso: 'contra', leitura: 'O código de segurança não conferiu.' });
  if (Number.isFinite(Number(d.scoreRiscoAdyen)) && d.scoreRiscoAdyen != null && Number(d.scoreRiscoAdyen) >= 50) s.push({ sinal: `Score de risco da Adyen ${d.scoreRiscoAdyen}`, peso: 'contra', leitura: 'A própria Adyen viu risco alto na hora da compra.' });
  return s;
}

// outros pedidos do MESMO cliente no que o Monitor guarda. Só liga por chave
// forte (e-mail, telefone ou cartão tokenizado) - nome não identifica ninguém
// (ver fraudIdentity.js). O Monitor guarda poucos dias de venda comum, então
// "nada achado" NÃO quer dizer cliente novo: a resposta diz a janela.
function digitos(v) { return String(v || '').replace(/\D/g, ''); }
function mesmoCliente(todas, dados, pedidoId, chave = (t) => t.merchantReference || t.originalReference || t.pspReference) {
  const email = String(dados.emailCliente || '').toLowerCase();
  const tel = digitos(dados.telefoneCliente);
  const alias = dados.aliasCartao || null;
  const bate = (t) => (email && String(t.emailCliente || '').toLowerCase() === email)
    || (tel.length >= 8 && digitos(t.telefoneCliente) === tel)
    || (alias && t.aliasCartao === alias);
  const porPedido = new Map();
  for (const t of todas || []) {
    const k = chave(t);
    if (!k || k === pedidoId || !bate(t)) continue;
    if (!porPedido.has(k)) porPedido.set(k, []);
    porPedido.get(k).push(t);
  }
  const pedidos = [...porPedido.entries()].map(([k, lista]) => {
    const aprovado = lista.find((t) => t.status === 'APROVADO');
    return {
      unidade: primeiroCom(lista, 'unidade'), valor: (aprovado || lista[0]).valor ?? null,
      em: (aprovado || lista[0]).dataHora || null, aprovado: !!aprovado,
      teveDisputa: lista.some(ehEventoDeDisputa),
      ligadoPor: [email && lista.some((t) => String(t.emailCliente || '').toLowerCase() === email) ? 'e-mail' : null,
        tel.length >= 8 && lista.some((t) => digitos(t.telefoneCliente) === tel) ? 'telefone' : null,
        alias && lista.some((t) => t.aliasCartao === alias) ? 'cartão' : null].filter(Boolean),
    };
  }).sort((a, b) => String(a.em || '').localeCompare(String(b.em || '')));
  return {
    pedidos, aprovadosSemDisputa: pedidos.filter((p) => p.aprovado && !p.teveDisputa).length,
    comDisputa: pedidos.filter((p) => p.teveDisputa).length,
    janela: 'O Monitor guarda os últimos dias de venda e todo pedido com disputa. Não achar nada aqui NÃO prova que o cliente é novo: quem sabe é o sistema da loja.',
  };
}

// o que o SERVIDOR preenche sozinho a partir da Adyen. Só fato que a Adyen
// traz com certeza; o resto (número do pedido na loja, itens, contato,
// entrega) é da unidade. `merchantReference` é o id do pedido na Adyen, não o
// número do sistema da loja - por isso não vira `numeroPedido`.
function sugestoesDaAdyen(dados, historico) {
  const campos = {}; const fontes = {};
  const por = (id, valor, fonte) => { if (!vazio(valor)) { campos[id] = valor; fontes[id] = fonte; } };
  por('nomeCliente', dados.nomeCliente || dados.nomeNoCartao, dados.nomeCliente ? 'Adyen (nome do comprador)' : 'Adyen (nome no cartão)');
  por('telefoneCliente', dados.telefoneCliente, 'Adyen');
  if (dados.enderecoTipo === 'entrega') {
    por('endereco', dados.enderecoCliente, 'Adyen (endereço de entrega)');
    por('tipoPedido', 'Delivery', 'Adyen (pedido com endereço de entrega)');
  }
  if (historico && historico.aprovadosSemDisputa > 0) {
    const antes = historico.pedidos.filter((p) => p.aprovado && !p.teveDisputa && (!dados.dataCompra || String(p.em || '') < String(dados.dataCompra)));
    if (antes.length) {
      por('clienteRecorrente', 'Sim', 'Adyen (pedidos anteriores do mesmo cliente)');
      // "PELO MENOS", e não o número seco. O Monitor guarda poucos dias de
      // venda comum (só o pedido COM disputa fica inteiro), então esta conta
      // é um PISO, não o histórico do cliente. Num documento que vai pro
      // banco, o número seco afirmaria mais do que o dado sustenta. E a
      // loja, que sabe o total de verdade, leria "1 pedido" de um cliente de
      // 50 e concluiria que o sistema errou - em vez de corrigir pra cima,
      // que é o que a defesa precisa.
      por('historicoCliente', `Pelo menos ${antes.length} pedido(s) aprovado(s) sem disputa desde ${dataBR(antes[0].em)}, pelo mesmo ${[...new Set(antes.flatMap((p) => p.ligadoPor))].join('/')} (conferido no Monitor - a loja pode ter mais).`, 'Adyen');
    }
  }
  return { campos, fontes };
}

// ---------------------------------------------------------------------
// PDF DA DEFESA (português, decisão do Master). A4. A Adyen recusa PDF acima
// de 2 MB e, na Mastercard, acima de 19 páginas: o PDF sai do mesmo jeito,
// e o aviso vai no caso pro Claude anexar as evidências em arquivos
// separados quando passar.
const LIMITE_ADYEN_BYTES = 2 * 1024 * 1024;
const LIMITE_PAGINAS_MASTERCARD = 19;

function textoDaResposta(q, v) {
  if (v == null || v === '' || (Array.isArray(v) && !v.length)) return '—';
  if (q.tipo === 'confirma') return v ? 'Sim' : 'Não';
  if (Array.isArray(v)) return v.join('; ');
  if (q.id === 'telefoneCliente') return mascararTelefone(v);
  return mascararSensiveis(v);
}

async function gerarPdf({ caso, tarefa, nomeUnidade = (c) => c, anexosDeEvidencia = [], baixar }) {
  const PDFKit = require('pdfkit');
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const respostas = (tarefa.defesaChargeback && tarefa.defesaChargeback.respostas) || {};
  const motivo = traduzirMotivo(caso.motivoAdyen);

  // 1) as páginas de texto (pdfkit)
  const doc = new PDFKit({ size: 'A4', margin: 48 });
  const partes = [];
  doc.on('data', (b) => partes.push(b));
  const fim = new Promise((ok) => doc.on('end', ok));
  const titulo = (t) => { doc.moveDown(0.6).font('Helvetica-Bold').fontSize(12).fillColor('#111111').text(t); doc.moveDown(0.2); };
  const linha = (r, v) => { doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#444444').text(r); doc.font('Helvetica').fontSize(10.5).fillColor('#111111').text(v || '—'); doc.moveDown(0.25); };

  doc.font('Helvetica-Bold').fontSize(17).fillColor('#111111').text('Defesa de chargeback');
  doc.font('Helvetica').fontSize(10).fillColor('#444444').text(`${nomeUnidade(caso.unidade)} · gerado em ${dataHoraBR(new Date().toISOString())}`);
  titulo('Transação contestada');
  linha('Valor', reais(caso.valor));
  linha('Data e hora do pagamento', dataHoraBR(caso.dataCompra));
  linha('Cartão', `${caso.metodo ? String(caso.metodo).toUpperCase() + ' ' : ''}${caso.last4 ? 'final ' + caso.last4 : ''}`.trim() || '—');
  linha('Referência do pagamento (PSP)', caso.pspPagamento || '—');
  linha('Referência da disputa (PSP)', caso.pspDisputa || '—');
  linha('Referência do pedido na Adyen', caso.pedidoId || '—');
  linha('Motivo informado pelo banco', `${motivo.pt}${caso.motivoAdyen ? ` (${caso.motivoAdyen})` : ''}`);
  linha('Prazo da Adyen', dataBR(caso.prazoDefesa));

  let secao = '';
  for (const q of QUESTOES) {
    if (q.id === 'declaracao') continue;
    if (q.secao !== secao) { secao = q.secao; titulo(secao === 'Decisão' ? 'Decisão da unidade' : `Informações da unidade — ${secao}`); }
    linha(q.rotulo, textoDaResposta(q, respostas[q.id]));
  }
  titulo('Evidências anexadas');
  if (!anexosDeEvidencia.length) doc.font('Helvetica').fontSize(10.5).text('Nenhuma.');
  for (const a of anexosDeEvidencia) {
    const e = EVIDENCIAS.find((x) => x.id === a.evidencia);
    doc.font('Helvetica').fontSize(10.5).fillColor('#111111').text(`• ${e ? e.rotulo : a.evidencia}: ${a.nome}`);
  }
  titulo('Declaração');
  doc.font('Helvetica').fontSize(10.5).fillColor('#111111')
    .text(`${respostas.declaracao ? 'Declarado como verdadeiro' : 'NÃO declarado'} por ${tarefa.defesaChargeback.respondidoPorNome || tarefa.concluidaPorNome || '—'}, em ${dataHoraBR(tarefa.defesaChargeback.respondidoEm || tarefa.concluidaEm)}.`);
  doc.end();
  await fim;

  // 2) as evidências junto (mesmo encaixe em A4 dos formulários), com o
  //    rótulo de cada uma no topo da primeira página dela
  const out = await PDFDocument.load(Buffer.concat(partes));
  const negrito = await out.embedFont(StandardFonts.HelveticaBold);
  const { anexarDocumentos } = require('./formularios');
  for (const a of anexosDeEvidencia) {
    const antes = out.getPageCount();
    const e = EVIDENCIAS.find((x) => x.id === a.evidencia);
    await anexarDocumentos(out, [a], negrito, { reservarRodape: 24 });
    if (out.getPageCount() > antes) {
      out.getPage(antes).drawText(`Evidência: ${e ? e.rotulo : a.evidencia}`.slice(0, 110), { x: 30, y: 16, size: 9, font: negrito, color: rgb(0.2, 0.2, 0.2) });
    }
  }
  const bytes = Buffer.from(await out.save());
  const avisos = [];
  if (bytes.length > LIMITE_ADYEN_BYTES) avisos.push(`O PDF tem ${(bytes.length / 1048576).toFixed(1)} MB e a Adyen aceita até 2 MB: anexe as páginas de texto e as evidências em arquivos separados.`);
  if (/^mc$|master/i.test(String(caso.metodo || '')) && out.getPageCount() > LIMITE_PAGINAS_MASTERCARD) avisos.push(`O PDF tem ${out.getPageCount()} páginas e a Mastercard aceita até 19.`);
  return { bytes, paginas: out.getPageCount(), avisos };
}

// Chamado quando a tarefa de defesa é concluída (index.js): gera o PDF,
// guarda no Storage e marca o caso como pronto pro Claude anexar na Adyen.
async function aoConcluirTarefa({ tarefa, storage, push, masters = [], nomeUnidade = (c) => c }) {
  if (!tarefa || !tarefa.defesaChargeback) return null;
  const caso = await disputes.getOne(tarefa.defesaChargeback.disputaId);
  if (!caso) return null;
  const respostas = tarefa.defesaChargeback.respostas || {};
  const evidencias = (tarefa.anexos || []).filter((a) => a && a.evidencia && /pdf|png|jpe?g/i.test(a.tipo || ''));
  const agora = new Date().toISOString();
  try {
    const pdf = await gerarPdf({ caso, tarefa, nomeUnidade, anexosDeEvidencia: evidencias });
    const nome = `defesa-chargeback-${String(caso.pedidoId || caso.id).slice(0, 40)}.pdf`;
    const caminho = await storage.salvarArquivo(caso.id, { buffer: pdf.bytes, originalname: nome, mimetype: 'application/pdf' }, 'defesas-chargeback');
    await disputes.salvarCaso(caso.id, {
      defesaProntaEm: agora, decisao: respostas.decisao || null, erroPdf: null,
      defesaPdf: { path: caminho, nome, tamanho: pdf.bytes.length, paginas: pdf.paginas, avisos: pdf.avisos, geradoEm: agora, porNome: tarefa.concluidaPorNome || null },
      evidencias: evidencias.map((a) => ({ evidencia: a.evidencia, nome: a.nome, path: a.path, tipo: a.tipo })),
    });
    const aceitar = respostas.decisao === OPCAO_ACEITAR;
    for (const m of masters) {
      push.notifyUsuario(m.id, aceitar ? `⚖️ Unidade decidiu aceitar o chargeback · ${reais(caso.valor)}` : `⚖️ Defesa pronta para anexar na Adyen · ${reais(caso.valor)}`,
        `${nomeUnidade(caso.unidade)} · prazo da Adyen ${dataBR(caso.prazoDefesa)}`, `defesa-pronta-${caso.id}`, `/tarefas?tarefa=${encodeURIComponent(tarefa.id)}`).catch(() => {});
    }
    return { ok: true, pdf: { paginas: pdf.paginas, tamanho: pdf.bytes.length, avisos: pdf.avisos } };
  } catch (err) {
    await disputes.salvarCaso(caso.id, { erroPdf: String(err.message || err).slice(0, 300), defesaProntaEm: null });
    throw err;
  }
}

// ---------------------------------------------------------------------
// LINK TEMPORÁRIO pro Claude baixar o PDF e as evidências e anexar na Adyen
// (ele usa o navegador, sem sessão do NoPulso). Assinado com o JWT_SECRET,
// vale 2 horas, e só abre o arquivo daquele caso - sem nada gravado.
const VALIDADE_LINK_MS = 2 * 60 * 60 * 1000;
function assinarLink(caminho, nome, segredo, agora = Date.now()) {
  const dados = Buffer.from(JSON.stringify({ p: caminho, n: nome, e: agora + VALIDADE_LINK_MS })).toString('base64url');
  const sig = crypto.createHmac('sha256', String(segredo)).update(dados).digest('base64url');
  return `${dados}.${sig}`;
}
function lerLink(token, segredo, agora = Date.now()) {
  const [dados, sig] = String(token || '').split('.');
  if (!dados || !sig) return null;
  const esperado = crypto.createHmac('sha256', String(segredo)).update(dados).digest('base64url');
  const a = Buffer.from(sig); const b = Buffer.from(esperado);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let v; try { v = JSON.parse(Buffer.from(dados, 'base64url').toString('utf8')); } catch (e) { return null; }
  if (!v || !v.p || !(v.e > agora)) return null;
  // só arquivo de defesa ou evidência de tarefa - nunca um caminho qualquer
  if (!/^(defesas-chargeback|tarefas)\//.test(String(v.p))) return null;
  return { caminho: v.p, nome: v.n || 'arquivo' };
}

module.exports = {
  gerarPdf, aoConcluirTarefa, assinarLink, lerLink, VALIDADE_LINK_MS, LIMITE_ADYEN_BYTES,
  sincronizar, equipeDaUnidade, textoDaTarefa, textoDoComentarioAutomatico, JANELA_HISTORICO_MS,
  // eventos
  ABRE, AVISO_FRAUDE, GANHOU, PERDEU, FIM_DE_PRAZO, codigoDoEvento, ehEventoDeDisputa, aplicarEvento, evoluirCaso, idDoCaso, eventosDoPedido,
  // textos e prazos
  traduzirMotivo, dicaDoMotivo, prazoInterno, dataSP, dataBR, dataHoraBR, reais,
  // questionário
  QUESTOES, EVIDENCIAS, OPCAO_ACEITAR, OBRIGATORIAS_AO_ACEITAR, SO_A_UNIDADE, vazio, faltando, limparRespostas, exigida,
  mascararSensiveis, mascararTelefone, mascararEmail,
  // dados da Adyen pro Claude
  dadosDoPagamento, sinaisDaDefesa, mesmoCliente, sugestoesDaAdyen,
  _crypto: crypto, _disputes: disputes,
};
