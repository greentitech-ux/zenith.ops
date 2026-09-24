// normalize.js
// Converte um NotificationRequestItem da Adyen no formato que o dashboard usa.
// Referencia de eventCodes: https://docs.adyen.com/development-resources/webhooks/notification-structure/

// unificacao de codigos de unidade (2026-08-18, ver migracaoUnidades.js) -
// o merchantAccountCode que a Adyen manda ("Mooca", "DOM___19888"...) e
// convertido pro codigo unificado (= codigo do Fechamento) direto na
// ingestao, pra toda transacao NOVA ja nascer sem duplicar cadastro com o
// codigo antigo
const { normalizarCodigoUnidade } = require('./migracaoUnidades');

function centsToReais(amount) {
  if (!amount || typeof amount.value !== 'number') return 0;
  return amount.value / 100;
}

function statusFromEvent(item) {
  const code = item.eventCode;
  const success = item.success === 'true' || item.success === true;
  const reason = item.reason || '';
  const additional = item.additionalData || {};

  if (code === 'AUTHORISATION') {
    return success ? 'APROVADO' : 'RECUSADO';
  }
  if (code === 'REFUND') return success ? 'ESTORNADO' : 'FALHA_ESTORNO';
  if (code === 'REFUND_FAILED') return 'FALHA_ESTORNO';
  if (code === 'POSTPONED_REFUND') return 'ESTORNO_AGENDADO';
  if (code === 'REFUNDED_REVERSED') return 'ESTORNO_REVERTIDO';
  if (code === 'CHARGEBACK') return 'CHARGEBACK';
  if (code === 'CHARGEBACK_REVERSED') return 'CHARGEBACK_REVERTIDO';
  if (code === 'SECOND_CHARGEBACK') return 'CHARGEBACK';
  if (code === 'NOTIFICATION_OF_CHARGEBACK') return 'NOTIFICATION_OF_CHARGEBACK';
  if (code === 'PROCESS_RETRIEVAL') return 'RETRIEVAL_REQUEST';
  // fim do periodo em que o lojista pode contestar a disputa
  if (code === 'DISPUTE_DEFENSE_PERIOD_ENDED' || additional.disputeStatus === 'DefensePeriodEnded') {
    return 'DISPUTE_DEFENSE_PERIOD_ENDED';
  }
  return code || 'DESCONHECIDO';
}

function isFraudSuspect(item) {
  const reason = (item.reason || '').toLowerCase();
  const additional = item.additionalData || {};
  if (reason.includes('fraud')) return true;
  if (additional.fraudResultType && additional.fraudResultType !== 'GREEN') return true;
  if (Number(additional.totalFraudScore) >= 30) return true; // ajuste o limite conforme sua configuracao de risco
  return false;
}

// a Adyen manda o shopperName como uma string no formato
// "[first name=Paulo, infix=null, last name=Hiram, gender=null]" - extrai
// so o nome, removendo "null" e espacos duplicados (mesma limpeza da formula
// MAP/REGEXREPLACE que ja era usada na planilha)
function cleanShopperNameString(str) {
  return str
    .replace(/\[first name=([^,]*), infix=[^,]*,,? ?last name=([^,]*), gender=.*\]/, '$1 $2')
    .replace(/\bnull\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// nome de quem fez o pedido (shopper) - separado do nome impresso no cartao,
// igual a planilha de referencia (colunas NOME_Cliente / NOME_Cartao).
// mesma logica do Apps Script antigo: shopperName -> shopperEmail -> null.
// shopperName pode chegar como objeto {firstName,lastName}, como string
// "[first name=..., last name=...]" ou como chaves separadas em formato de
// string "shopperName.firstName"/"shopperName.lastName" - tratamos os tres.
function shopperName(additional) {
  const sn = additional.shopperName;
  if (sn && typeof sn === 'object') {
    const full = `${sn.firstName || ''} ${sn.lastName || ''}`.trim();
    if (full) return full;
  } else if (typeof sn === 'string' && sn.trim()) {
    const cleaned = cleanShopperNameString(sn.trim());
    if (cleaned) return cleaned;
  }

  const first = additional['shopperName.firstName'] || '';
  const last = additional['shopperName.lastName'] || '';
  const full = `${first} ${last}`.trim();
  if (full) return full;

  if (additional.shopperEmail) return additional.shopperEmail;
  return null;
}

// nome do PAGADOR do Pix. A Adyen so manda se "Include Pix Payer info" estiver
// ligado nas configuracoes adicionais do webhook (Customer Area -> webhook ->
// Additional settings -> Payment). A chave vem no namespace "pix." do
// additionalData; como a grafia exata nao esta fixada na nossa integracao,
// aceita qualquer chave "pix.*" que termine em name/nome (ex:
// pix.payerName), sem depender de uma so
function pixPagador(additional) {
  for (const [k, v] of Object.entries(additional || {})) {
    if (/^pix\..*(name|nome)$/i.test(k) && typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

// Dados de contato enviados pela Adyen no webhook. Mantemos a leitura
// tolerante a nomes legados, mas `shopperEmail` e `shopperTelephone` sao as
// chaves configuradas pela integracao atual.
function contatoTexto(...valores) {
  for (const valor of valores) {
    if (typeof valor === 'string' && valor.trim()) return valor.trim().slice(0, 180);
  }
  return null;
}

// O webhook padrao achata enderecos no additionalData, com chaves como
// "deliveryAddress.street". Preferimos entrega (onde o pedido realmente vai)
// e caimos pra cobranca quando ela for a unica enviada. Integracoes que
// entregam o objeto direto no NotificationRequestItem tambem sao aceitas.
function enderecoDoWebhook(additional, item) {
  const ler = (prefixo, objeto) => {
    const campo = (nome) => contatoTexto(
      additional[`${prefixo}.${nome}`],
      objeto && objeto[nome]
    );
    const street = campo('street');
    const numero = campo('houseNumberOrName');
    const complemento = campo('apartmentSuite');
    const cidade = campo('city');
    const estado = campo('stateOrProvince');
    const cep = campo('postalCode');
    const pais = campo('country');
    const linha = [street, numero].filter(Boolean).join(', ');
    const local = [cidade, estado].filter(Boolean).join(' - ');
    const partes = [linha, complemento, local, cep, pais].filter(Boolean);
    return partes.length ? partes.join(' · ').slice(0, 300) : null;
  };
  const entrega = ler('deliveryAddress', item.deliveryAddress);
  if (entrega) return { enderecoCliente: entrega, enderecoTipo: 'entrega' };
  const cobranca = ler('billingAddress', item.billingAddress);
  if (cobranca) return { enderecoCliente: cobranca, enderecoTipo: 'cobranca' };
  return { enderecoCliente: null, enderecoTipo: null };
}

// ver `comentarioEmissor` no retorno do normalize
const CAMPOS_EMISSOR = ['chargebackReasonCode', 'disputeReason', 'issuerComment', 'chargebackComment', 'notes'];
function comentarioDoEmissor(additional, item) {
  for (const c of CAMPOS_EMISSOR) {
    const v = String((additional && additional[c]) || '').trim();
    // só texto de gente: um código isolado ("10.4") já vira a tradução do
    // motivo, e repetir ele aqui só encheria a tarefa
    if (v && /[a-zA-Z]{4}/.test(v)) return v.slice(0, 400);
  }
  const cru = String((item && item.reason) || '').trim();
  return cru && /[a-zA-Z]{4}/.test(cru) ? cru.slice(0, 400) : null;
}

function normalize(item) {
  const additional = item.additionalData || {};
  const status = statusFromEvent(item);
  // mesma logica do Apps Script antigo: cardHolderName -> cardSummary -> null
  const cardHolder = additional.cardHolderName || additional.cardSummary || null;
  const emailCliente = contatoTexto(additional.shopperEmail, item.shopperEmail);
  const telefoneCliente = contatoTexto(
    additional.shopperTelephone,
    additional.shopperTelephoneNumber,
    additional.telephoneNumber,
    item.shopperTelephone,
    item.shopperTelephoneNumber
  );
  const endereco = enderecoDoWebhook(additional, item);
  const scoreRisco = Number(additional.totalFraudScore);

  return {
    pspReference: item.pspReference,
    merchantReference: item.merchantReference,
    originalReference: item.originalReference || null,
    eventCode: item.eventCode,
    status,
    fraudeSuspeita: isFraudSuspect(item),
    motivo: item.reason || additional.refusalReasonRaw || '',
    // O QUE O BANCO ESCREVEU (Master, 24/09/2026).
    //
    // Na #12084 a Adyen mandou "KARLA GARCIA ALVES - Card Holder don't
    // recognize this purchase" - um TERCEIRO nome, diferente do titular e do
    // nome no pedido. Isso é ouro na defesa, e sumia: `traduzirMotivo()` casa
    // o texto num padrão conhecido e devolve a frase pronta em português,
    // então o nome ia embora antes de chegar na tarefa.
    //
    // A Adyen não tem UM campo documentado de "comentário do emissor" nas
    // notificações de disputa - o texto costuma vir no próprio `reason`. Por
    // isso a leitura é: os campos de additionalData que já vi carregarem
    // isso, e o `reason` cru como fonte final. Se a Adyen passar a mandar
    // noutro campo, entra na lista.
    comentarioEmissor: comentarioDoEmissor(additional, item),
    valor: centsToReais(item.amount),
    moeda: item.amount?.currency || 'BRL',
    metodo: item.paymentMethod || '?',
    last4: additional.cardSummary || null,
    bin: additional.cardBin || (additional.cardSummary ? null : null),
    cardHolder, // nome do cartao (impresso no cartao)
    nomeCliente: shopperName(additional) || pixPagador(additional) || cardHolder, // nome do cliente que fez o pedido
    emailCliente,
    telefoneCliente,
    enderecoCliente: endereco.enderecoCliente,
    enderecoTipo: endereco.enderecoTipo,
    // Sinais usados no Raio-X de risco do Monitor. Sao fatos vindos da
    // Adyen, nunca uma sentenca isolada de fraude.
    scoreRiscoAdyen: Number.isFinite(scoreRisco) ? scoreRisco : null,
    resultadoRiscoAdyen: contatoTexto(additional.fraudResultType),
    shopperIp: contatoTexto(additional.shopperIP, additional.shopperIp),
    paisCliente: contatoTexto(additional.shopperCountry),
    paisEmissor: contatoTexto(additional.issuerCountry, additional.issuerCountryAlpha2),
    fonteCartao: contatoTexto(additional.fundingSource),
    resultadoAvs: contatoTexto(additional.avsResult, additional.avsResultRaw),
    resultadoCvc: contatoTexto(additional.cvcResult, additional.cvcResultRaw),
    threeDOferecido: contatoTexto(additional.threeDOffered),
    threeDAutenticado: contatoTexto(additional.threeDAuthenticated),
    dispositivo: contatoTexto(additional.deviceType),
    navegador: contatoTexto(additional.browserCode),
    aliasCartao: contatoTexto(additional.alias),
    shopperReference: additional.shopperReference || item.merchantAccountCode + ':' + (additional.shopperEmail || ''),
    unidade: normalizarCodigoUnidade(item.merchantAccountCode),
    // o código cru da conta na Adyen: a API de disputas pede ele, e o
    // `unidade` acima já vem normalizado (adyenDisputas.js, 24/09/2026)
    merchantAccountCode: item.merchantAccountCode || null,
    dataHora: new Date().toISOString(), // Adyen nao manda timestamp do evento; usamos hora de recebimento
    disputeStatus: additional.disputeStatus || null,
    // prazo final pra enviar defesa/recorrer do chargeback - a Adyen manda
    // esse campo nos eventos CHARGEBACK/NOTIFICATION_OF_CHARGEBACK
    prazoDefesa: additional.defensePeriodEndsAt || additional.defenseperiodendsat || null,
    bancoEmissor: null, // preenchido depois via BIN lookup (assincrono)
  };
}

module.exports = { normalize };
