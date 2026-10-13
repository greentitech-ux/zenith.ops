'use strict';
// Vínculo tipado: o número sozinho pode existir na tarefa e na solicitação.
// Notas, anexos e marcadores são escritos juntos; repetir não duplica eventos.
const crypto = require('node:crypto');
const { Writable } = require('node:stream');
const db = require('./firestore');
const colecoes = { chat: 'suporteChats', solicitacao: 'solicitacoes', tarefa: 'tarefas', estorno: 'refundRequests' };
const digest = v => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');

async function resolver(origem, unidade) {
  if (!origem || !['chat','solicitacao','tarefa'].includes(origem.tipo)) throw new Error('Origem deve informar tipo chat, solicitacao ou tarefa e numero.');
  const numero = Number(String(origem.numero || '').replace(/^#/, ''));
  if (!Number.isSafeInteger(numero) || numero <= 0) throw new Error('Número de origem inválido.');
  const snap = await db.collection(colecoes[origem.tipo]).where('numeroTicket','==',numero).get();
  if (snap.docs.length !== 1) throw new Error('Origem não encontrada ou ambígua. Informe o tipo e número corretos.');
  const registro = { ...snap.docs[0].data(), id: snap.docs[0].id };
  const declarada = registro.unidade || registro.unidadeContexto || registro.lojaContexto;
  const catalogo = require('./coworkCatalogo');
  const cadastro = await catalogo.resolverUnidadeDoFormulario(declarada || unidade);
  if (unidade && (await catalogo.resolverUnidadeDoFormulario(unidade)).unidade !== cadastro.unidade) throw new Error('A unidade do formulário deve ser a mesma da origem.');
  return { origem: { tipo: origem.tipo, id: registro.id, numero, unidade: cadastro.unidade }, registro, cadastro };
}

async function vincular(id, origem, porEmail) {
  const mod = require('./formularios'), f = await mod.getOne(id);
  if (!f) throw new Error('Formulário não encontrado.');
  const alvo = await resolver(origem, f.unidade);
  await db.runTransaction(async tx => {
    const ref = db.collection('formularios').doc(id), s = await tx.get(ref), atual = s.data();
    if (atual.status === 'CANCELADO') throw new Error('Formulário cancelado não pode ser vinculado.');
    // Estorno preserva sua referência financeira aprovada; o chat/tarefa é
    // um vínculo adicional, não uma substituição daquele documento.
    const campo = atual.origem?.tipo === 'estorno' ? 'origemAtendimento' : 'origem';
    if (atual[campo] && (atual[campo].tipo !== alvo.origem.tipo || atual[campo].id !== alvo.origem.id)) throw new Error('Formulário já pertence a outro atendimento. A transferência exige revisão manual do histórico.');
    tx.update(ref, { [campo]: alvo.origem, origemVinculadaPor: porEmail, origemSincronizacaoPendente: true });
  });
  mod.invalidar();
  return mod.sincronizarOrigem(id);
}

function versaoAssinada(f) {
  return digest([require('./formularios').hashDoConteudo(f), Object.entries(f.assinaturas || {}).map(([k,a]) => [k,a.assinadoEm,a.nome,a.eletronica?.hash || a.imagem])]);
}
async function pdfAssinado(f) {
  const hash = versaoAssinada(f);
  if (f.origemPdf?.hash === hash) return f.origemPdf;
  const partes = [], res = new Writable({ write(p, _, fim) { partes.push(Buffer.from(p)); fim(); } });
  res.setHeader = res.set = () => res;
  const pronto = new Promise((ok, erro) => { res.once('finish', ok); res.once('error', erro); });
  await require('./formularios').gerarPdf(f, res, {});
  await pronto;
  const nome = `formulario-${f.numeroTicket}-assinado.pdf`, tipo = 'application/pdf';
  const path = await require('./storage').salvarArquivo(f.id, { originalname: nome, mimetype: tipo, buffer: Buffer.concat(partes) }, 'formularios-origem');
  const pdf = { hash, nome, tipo, path, formularioId: f.id };
  await db.runTransaction(async tx => {
    const ref = db.collection('formularios').doc(f.id), s = await tx.get(ref), atual = s.data();
    if (atual.status !== 'ASSINADO' || versaoAssinada(atual) !== hash) throw new Error('O formulário mudou durante a geração do PDF. Consulte novamente.');
    tx.update(ref, { origemPdf: pdf });
  });
  return pdf;
}

async function sincronizar(id) {
  const mod = require('./formularios'), f = await mod.getOne(id);
  const origens = [f?.origem, f?.origemAtendimento].filter(o => o?.id && colecoes[o.tipo]);
  if (!origens.length) return { semOrigem: true };
  if (f.origemSincronizacaoPendente === false) return { ok: true };
  const pdf = f.status === 'ASSINADO' ? await pdfAssinado(f) : null;
  for (const origem of origens) {
  const base = `Formulário #${f.numeroTicket}`;
  const eventos = [{ chave: 'criado', texto: `${base} criado e vinculado a este atendimento.${f.pagamentoOrigemPix ? ' Forma de pagamento alterada para Pix; boleto anterior preservado apenas no histórico.' : ''}` }];
  for (const [papel,a] of Object.entries(f.assinaturas || {})) {
    if (mod.slotAssinado(a)) eventos.push({ chave: `assinatura:${papel}:${a.assinadoEm}`, texto: `${base}: assinatura de ${a.rotulo || papel} registrada. Ainda não significa pagamento.` });
  }
  if (pdf) eventos.push({ chave: `assinado:${pdf.hash}`, texto: `${base} ASSINADO. PDF anexado; pronto para o fluxo de pagamento. Não é comprovante de pagamento.`, pdf });
  if (f.enviadoConecta) eventos.push({ chave: `conecta:${f.enviadoConecta.em}`, texto: `${base} enviado ao Conecta. Protocolo: ${f.enviadoConecta.protocolo || '—'}.`, conecta: f.enviadoConecta });
  if (f.status === 'CANCELADO') eventos.push({ chave: 'cancelado', texto: `${base} cancelado: ${f.motivoCancelamento || 'sem motivo'}. Histórico preservado.` });
  await db.runTransaction(async tx => {
    const fr = db.collection('formularios').doc(id), or = db.collection(colecoes[origem.tipo]).doc(origem.id);
    const [sf, so] = await Promise.all([tx.get(fr),tx.get(or)]);
    if (!sf.exists || !so.exists) throw new Error('Formulário ou origem não encontrados.');
    const atual = sf.data(), alvo = so.data();
    if (JSON.stringify([atual.origem, atual.origemAtendimento]) !== JSON.stringify([f.origem, f.origemAtendimento]) || atual.status !== f.status
      || versaoAssinada(atual) !== versaoAssinada(f)) throw new Error('Formulário mudou durante a sincronização. Tente novamente.');
    const feitos = atual.eventosOrigem || {}, em = new Date().toISOString();
    const patch = {}, notas = [...(alvo.notasInternas || [])], comentarios = [...(alvo.comentarios || [])];
    const anexos = [...(alvo.anexos || [])];
    for (const ev of eventos) {
      const chave = digest([id, origem.tipo, origem.id, ev.chave]);
      if (feitos[chave]) continue;
      if (origem.tipo === 'chat') notas.push({ resumo: ev.texto, situacao: 'EM_ANDAMENTO', por: 'NoPulso · Formulários', em, formularioId: id, pdf: ev.pdf || null });
      else if (origem.tipo === 'tarefa') comentarios.push({ id: chave, texto: ev.texto, porId: null, porNome: 'NoPulso · Formulários', viaAgente: true, em, anexo: ev.pdf || null });
      else {
        const tipo = origem.tipo === 'estorno' ? 'estorno' : alvo.tipo;
        tx.set(db.collection('centralChat').doc(chave), { id: chave, cardKey: `${tipo}:${origem.id}`, tipo, cardId: origem.id,
          autorId: null, autorEmail: 'NoPulso · Formulários', autorUsername: 'NoPulso · Formulários', texto: ev.texto, imagem: ev.pdf || null, criadoEm: em });
      }
      if (ev.pdf && !anexos.some(a => a.path === ev.pdf.path)) anexos.push(ev.pdf);
      feitos[chave] = em;
    }
    if (origem.tipo === 'chat') patch.notasInternas = notas.slice(-20);
    if (origem.tipo === 'tarefa') patch.comentarios = comentarios.slice(-100);
    // PDF financeiro fica só na nota interna do chat, nunca no payload público.
    if (origem.tipo !== 'chat') patch.anexos = anexos;
    patch.formulariosVinculados = [...new Set([...(alvo.formulariosVinculados || []), id])];
    if (f.pagamentoOrigemPix && origem.tipo === 'solicitacao') {
      if (alvo.tipo !== 'pagamento') throw new Error('Origem não é solicitação de pagamento.');
      patch.formaPagamento = 'pix';
      patch.formularioPixId = id;
      patch.formaPagamentoAlteradaEm = alvo.formaPagamentoAlteradaEm || em;
      // Assinado é pronto para processamento, nunca "pago"/FINALIZADO.
      if (pdf && alvo.status === 'APROVADO' && alvo.execucaoStatus !== 'FINALIZADO') patch.execucaoStatus = 'EM_ANDAMENTO';
    }
    if (f.enviadoConecta) patch.formulariosConecta = { ...(alvo.formulariosConecta || {}), [id]: f.enviadoConecta };
    tx.update(or, patch);
    tx.update(fr, { eventosOrigem: feitos, origemSincronizacaoPendente: false,
      // O pagamento já existe. Impede "Enviar como pagamento" de gerar
      // uma segunda solicitação depois da assinatura.
      ...(pdf && f.pagamentoOrigemPix && origem.tipo === 'solicitacao'
        ? { enviadoPagamento: atual.enviadoPagamento || { em, pagamentoId: origem.id } } : {}) });
  });
  }
  mod.invalidar();
  require('./solicitacoes').invalidar();
  require('./suporteChat').invalidar();
  require('./centralChat').invalidar();
  return { ok: true };
}
module.exports = { resolver, vincular, sincronizar, versaoAssinada };
