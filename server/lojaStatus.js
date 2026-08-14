// lojaStatus.js
// Presenca/conectividade por COMPUTADOR de cada loja: a tela publica
// atendimento.html, quando aberta em modo quiosque num computador especifico
// (?unidade=<codigo>&posto=<id>), manda um heartbeat periodico pra essa
// colecao. Se um computador para de mandar heartbeat por mais tempo que o
// esperado, e sinal de que a tela/maquina caiu OU perdeu internet - a
// varredura periodica (ver rodarVarreduraLojaStatus em index.js) detecta
// essa transicao e avisa Master/Suporte, no mesmo espirito de ferramentas de
// RMM (Atera etc) que o usuario pediu, so que sem precisar de um agente
// instalado - o proprio navegador aberto na loja e o "sentinela". NAO
// GARANTE deteccao 100% (uma aba fechada por engano parece igual a uma
// internet caida), mas cobre o caso real: quiosque sempre ligado, silencio
// prolongado quase sempre significa "algo errado por la".
//
// Cada unidade pode ter VARIOS computadores cadastrados (pedido explicito do
// usuario: "cada unidade tem varios computadores e eu tenho todos cadastrados
// no Anydesk") - por isso 1 documento por PAR unidade+posto, nao 1 por
// unidade. "posto" e um id curto e estavel gerado no cadastro (cadastrarComputador),
// nunca muda mesmo se o nome for editado depois - e o que entra no link/QR
// code que fica colado/salvo naquele computador especifico. Reaproveita esse
// mesmo documento pra guardar o ID do AnyDesk daquele computador (acesso
// remoto rapido, ja que o usuario possui a licenca) e uma mensagem pendente
// que o Master/Suporte quer empurrar pra ele - a mesma resposta do heartbeat
// entrega essa mensagem na proxima vez que o quiosque perguntar (nao existe
// canal de push pra visitante anonimo, so o polling do proprio heartbeat).
//
// "tipo" decide QUAL tela o link/QR daquele computador abre (ver
// POST /api/loja-status/:codigo/computadores em index.js): 'atendimento'
// mostra o chat publico do Beniboy (pro cliente falar com a loja, ver
// atendimento.html) - o caso original, pensado pra tablet/quiosque na
// entrada; 'interno' mostra a tela normal de login do Zenith (index.html) -
// pra computador de escritorio/servidor que so precisa ficar "vivo" pro
// monitoramento; 'abastecimento' mostra a tela do Abastecimento Carrinho
// (abastecimento.html, Dom Aeroporto) - pro tablet do carrinho/loja que
// fica ligado o dia todo nessa tela e nao na de atendimento/login. Os tres
// mandam heartbeat do mesmo jeito.
const crypto = require('crypto');
const db = require('./firestore');
const { createCache } = require('./liveCache');

const COLLECTION = db.collection('lojaStatus');
// fila de comandos do agente (ver agenteAcoes.js) - histórico completo de
// cada comando enviado a um computador tipo 'interno', com resultado. O
// doc do computador guarda só o ponteiro pro comando em aberto
// (comandoPendenteId) - evita precisar de índice composto no Firestore pra
// achar o comando certo: já sabemos o id exato na hora do heartbeat
const COMANDOS_COLLECTION = db.collection('lojaStatusComandos');

const TIPOS_COMPUTADOR = ['atendimento', 'interno', 'abastecimento'];
function tipoValido(tipo) { return TIPOS_COMPUTADOR.includes(tipo) ? tipo : 'atendimento'; }

// heartbeat a cada ~25s (ver atendimento.html) - 90s da margem pra 2
// heartbeats perdidos por jitter de rede antes de considerar offline
const LIMIAR_OFFLINE_MS = 90 * 1000;

function docIdFor(codigo, posto) {
  const limpoCodigo = String(codigo || '').trim().replace(/\//g, '_').slice(0, 200);
  if (!limpoCodigo) throw new Error('Código da unidade é obrigatório.');
  const limpoPosto = String(posto || '').trim().replace(/\//g, '_').slice(0, 60);
  if (!limpoPosto) throw new Error('Computador é obrigatório.');
  return `${limpoCodigo}__${limpoPosto}`;
}

// migra documentos do formato antigo (1 por unidade, docId == codigo, sem
// campo "posto") pro formato novo (1 por unidade+posto) - roda sozinho na
// primeira listagem depois do deploy dessa mudanca, sem precisar de
// intervencao manual. Preserva anydeskId/heartbeat/mensagem ja existentes,
// so passa a chamar esse computador de "Computador 1"
async function migrarLegado(docs) {
  const legados = docs.filter((d) => !d.data().posto);
  if (!legados.length) return false;
  for (const doc of legados) {
    const atual = doc.data();
    await COLLECTION.doc(docIdFor(atual.codigo, 'principal')).set({
      ...atual, posto: 'principal', nome: atual.nome || 'Computador 1', tipo: tipoValido(atual.tipo),
    }, { merge: true });
    await doc.ref.delete();
  }
  return true;
}

async function listUncached() {
  const snap = await COLLECTION.get();
  const migrou = await migrarLegado(snap.docs);
  if (!migrou) return snap.docs.map((d) => d.data());
  const snap2 = await COLLECTION.get();
  return snap2.docs.map((d) => d.data());
}
const cache = createCache(listUncached, 10 * 1000);

// registra o heartbeat de um computador especifico e devolve a mensagem
// pendente (se houver), ja limpando ela na mesma escrita - entrega "de uso
// unico", igual ao padrao forcarChat que o widget de suporte ja usa pro
// auto-abrir. posto ausente (link antigo, de antes dessa mudanca, ainda nao
// atualizado no navegador da loja) cai no computador "principal" da unidade.
//
// info = { ip, userAgent, abertoDesde } - dados de diagnostico capturados a
// cada heartbeat (pedido explicito do usuario: "puxar o maximo de
// informacao do computador"). ip vem do servidor (ver index.js, cabecalho
// x-forwarded-for), nunca do cliente. userAgent/abertoDesde vem do proprio
// navegador (atendimento.html/index.html) - abertoDesde e o timestamp de
// quando ESSA ABA foi carregada pela primeira vez (guardado em
// sessionStorage no cliente, sobrevive a reloads mas reseta se a aba fechar)
// - e o mais perto que da pra chegar de "ha quanto tempo esta ligado" sem
// instalar um agente de verdade na maquina, que e exatamente o que essa
// ferramenta foi feita pra evitar
async function heartbeat(codigo, posto, info) {
  const id = docIdFor(codigo, posto || 'principal');
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  const atual = snap.exists ? snap.data() : null;
  const mensagemPendente = (atual && atual.mensagemPendente) || null;
  const dados = info || {};
  await ref.set({
    codigo,
    posto: posto || 'principal',
    nome: (atual && atual.nome) || null,
    tipo: tipoValido((atual && atual.tipo) || 'atendimento'),
    ultimoHeartbeatEm: Date.now(),
    anydeskId: (atual && atual.anydeskId) || null,
    avisadoOffline: (atual && atual.avisadoOffline) || false,
    offlineDesde: (atual && atual.offlineDesde) || null,
    mensagemPendente: null,
    ip: dados.ip || (atual && atual.ip) || null,
    userAgent: dados.userAgent || (atual && atual.userAgent) || null,
    abertoDesde: dados.abertoDesde || (atual && atual.abertoDesde) || null,
  }, { merge: true });
  // só computador 'interno' processa comando do agente (ver
  // agenteAcoes.js) - é o único tipo onde a tela nao é a propria
  // funcionalidade, entao roda o NOCZenith sem gerenciar janela nenhuma
  let comandoPendente = null;
  if (atual && atual.tipo === 'interno' && atual.comandoPendenteId) {
    comandoPendente = await entregarComandoPendente(codigo, posto || 'principal');
  }
  // thread de chat (ver enviarMensagem/responderChat) - manda sempre a
  // lista inteira (capada, pequena), o NOCZenith que guarda localmente
  // qual "em" ja mostrou pra so empurrar as mensagens novas na janela
  // flutuante (so tipo 'interno' processa isso hoje - ver vigiaScript.js)
  const chatMensagens = (atual && atual.chatMensagens) || [];
  cache.invalidar();
  return { mensagemPendente, comandoPendente, chatMensagens };
}

function comOnline(doc) {
  const online = !!doc.ultimoHeartbeatEm && (Date.now() - doc.ultimoHeartbeatEm) < LIMIAR_OFFLINE_MS;
  return { ...doc, online };
}

// lista achatada, 1 item por computador (varios por unidade) - quem chama
// (index.js/loja-status.html) agrupa por codigo pra exibir por unidade
async function listar() {
  const docs = await cache.cached();
  return docs.map(comOnline);
}

// Master cadastra um novo computador pra uma unidade - gera um id curto e
// estavel (nunca muda, mesmo se o nome/tipo forem editados depois) que vira
// parte do link/QR code fixado naquele computador (ver POST /api/loja-status/
// :codigo/computadores em index.js, que devolve a URL pronta)
async function cadastrarComputador(codigo, nome, tipo) {
  const nomeOk = String(nome || '').trim().slice(0, 60);
  if (!nomeOk) throw new Error('Dê um nome pro computador (ex: Caixa 1, PDV Entrega).');
  const posto = crypto.randomBytes(4).toString('hex');
  const id = docIdFor(codigo, posto);
  const registro = {
    codigo, posto, nome: nomeOk, tipo: tipoValido(tipo), anydeskId: null,
    ultimoHeartbeatEm: null, avisadoOffline: false, offlineDesde: null, mensagemPendente: null,
    ip: null, userAgent: null, abertoDesde: null, ipLocal: null, ipLocalEm: null,
    comandoPendenteId: null,
  };
  await COLLECTION.doc(id).set(registro);
  cache.invalidar();
  return registro;
}

// edita nome e/ou tipo de um computador ja cadastrado - o "posto" (id do
// link/QR) nunca muda, so o que aparece na tela e qual tela o link abre
async function editarComputador(codigo, posto, nome, tipo) {
  const nomeOk = String(nome || '').trim().slice(0, 60);
  if (!nomeOk) throw new Error('Dê um nome pro computador.');
  const id = docIdFor(codigo, posto);
  const snap = await COLLECTION.doc(id).get();
  if (!snap.exists) throw new Error('Computador não encontrado.');
  const registro = { nome: nomeOk, tipo: tipoValido(tipo) };
  await COLLECTION.doc(id).update(registro);
  cache.invalidar();
  return { codigo, posto, ...registro };
}

async function removerComputador(codigo, posto) {
  const id = docIdFor(codigo, posto);
  await COLLECTION.doc(id).delete();
  cache.invalidar();
  return { codigo, posto };
}

// Master configura o ID do AnyDesk daquele computador pra acesso remoto
// rapido - funciona mesmo se o computador nunca mandou heartbeat ainda, por
// isso o merge:true (nao exige ja existir)
async function definirAnydeskId(codigo, posto, anydeskId) {
  const id = docIdFor(codigo, posto);
  const limpo = String(anydeskId || '').trim().slice(0, 40);
  await COLLECTION.doc(id).set({ codigo, posto, anydeskId: limpo || null }, { merge: true });
  cache.invalidar();
  return { codigo, posto, anydeskId: limpo || null };
}

// o script de vigia (roda nativo no Windows, fora do navegador - ver
// loja-status.html "Baixar vigia") reporta o IP da rede LOCAL da maquina
// direto pro servidor, sem depender de nenhuma aba estar aberta (pedido
// explicito do usuario: precisa do IP local pra acesso remoto no dia a dia,
// o IP publico que o heartbeat ja capturava nao serve pra isso). De
// proposito NAO mexe em ultimoHeartbeatEm/avisadoOffline: o vigia estar
// rodando nao prova que a tela de monitoramento esta aberta, entao nao pode
// mascarar uma loja de verdade offline pro alerta de suporte
async function atualizarIpLocal(codigo, posto, ip) {
  const id = docIdFor(codigo, posto);
  const limpo = String(ip || '').trim().slice(0, 45);
  if (!limpo) throw new Error('IP inválido.');
  await COLLECTION.doc(id).set({ codigo, posto, ipLocal: limpo, ipLocalEm: Date.now() }, { merge: true });
  cache.invalidar();
  return { codigo, posto, ipLocal: limpo };
}

// o vigia detecta (via processos/conexoes de rede conhecidas - AnyDesk,
// TeamViewer, DWService ou qualquer outra ferramenta de acesso remoto - ver
// loja-status.html "Baixar vigia") quando alguem se conecta no computador e
// reporta aqui. Guarda so o ULTIMO evento (pra mostrar no detalhe do card em
// /loja-status.html) - quem realmente avisa cada conexao nova e o push pro
// Master (ver POST .../acesso-remoto em index.js + push.notifyAcessoRemotoDetectado),
// disparado toda vez que essa funcao roda, nao so na primeira. "detalhe" e
// texto livre tipo "AnyDesk (203.0.113.5:7070)", montado pelo proprio script
async function registrarAcessoRemoto(codigo, posto, detalhe) {
  const id = docIdFor(codigo, posto);
  const limpo = String(detalhe || '').trim().slice(0, 200);
  if (!limpo) throw new Error('Detalhe do acesso remoto é obrigatório.');
  const snap = await COLLECTION.doc(id).get();
  const atual = snap.exists ? snap.data() : null;
  await COLLECTION.doc(id).set({
    codigo, posto, ultimoAcessoRemotoEm: Date.now(), ultimoAcessoRemotoDetalhe: limpo,
  }, { merge: true });
  cache.invalidar();
  return { codigo, posto, nome: atual && atual.nome, ultimoAcessoRemotoDetalhe: limpo };
}

// enfileira um comando (ver agenteAcoes.js executarAcaoDoAgente) pro
// computador buscar no proximo heartbeat. So aceita computador tipo
// 'interno' (unico que processa comando - ver heartbeat() acima) e so um
// comando pendente/entregue por vez (evita perder o rastro de um
// resultado se um segundo comando chegasse por cima)
async function enfileirarComando(codigo, posto, comando, opcoes) {
  const id = docIdFor(codigo, posto);
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Computador não encontrado.');
  const atual = snap.data();
  if (atual.tipo !== 'interno') throw new Error('Só computadores tipo "interno" processam comandos do agente.');
  if (atual.comandoPendenteId) throw new Error('Já existe um comando pendente/entregue pra esse computador - aguarde terminar antes de mandar outro.');
  const op = opcoes || {};
  const comandoRef = COMANDOS_COLLECTION.doc();
  const registro = {
    id: comandoRef.id, codigo, posto, comando,
    origem: op.origem || 'agente', acaoId: op.acaoId || null, aprovacaoId: op.aprovacaoId || null,
    status: 'pendente', criadoEm: new Date().toISOString(),
    entregueEm: null, executadoEm: null, resultado: null, erro: null,
  };
  await comandoRef.set(registro);
  await ref.set({ comandoPendenteId: comandoRef.id }, { merge: true });
  cache.invalidar();
  return registro;
}

// chamado de dentro do heartbeat() - transacao sobre 1 documento so (nao
// precisa de indice composto: o comandoPendenteId ja diz exatamente qual
// comando buscar). Marca 'entregue' e devolve o texto do comando pro
// NOCZenith rodar; se ja tiver sido entregue antes (heartbeat duplicado),
// nao entrega de novo
async function entregarComandoPendente(codigo, posto) {
  const id = docIdFor(codigo, posto);
  const ref = COLLECTION.doc(id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const comandoPendenteId = snap.data().comandoPendenteId;
    if (!comandoPendenteId) return null;
    const comandoRef = COMANDOS_COLLECTION.doc(comandoPendenteId);
    const comandoSnap = await tx.get(comandoRef);
    if (!comandoSnap.exists) { tx.update(ref, { comandoPendenteId: null }); return null; }
    const comando = comandoSnap.data();
    if (comando.status !== 'pendente') return null;
    tx.update(comandoRef, { status: 'entregue', entregueEm: new Date().toISOString() });
    return { comandoId: comando.id, comando: comando.comando };
  });
}

// o NOCZenith reporta o resultado (ver rota publica .../comando-resultado
// em index.js) - fecha o ciclo e libera o computador pra aceitar um novo
// comando
async function marcarComandoExecutado(comandoId, dados) {
  const d = dados || {};
  const comandoRef = COMANDOS_COLLECTION.doc(comandoId);
  const snap = await comandoRef.get();
  if (!snap.exists) throw new Error('Comando não encontrado.');
  const comando = snap.data();
  const patch = {
    status: d.erro ? 'erro' : 'executado',
    executadoEm: new Date().toISOString(),
    resultado: d.resultado || null,
    erro: d.erro || null,
  };
  await comandoRef.update(patch);
  await COLLECTION.doc(docIdFor(comando.codigo, comando.posto)).set({ comandoPendenteId: null }, { merge: true });
  cache.invalidar();
  return { ...comando, ...patch };
}

// tamanho maximo da thread guardada por computador - so o suficiente pra
// dar contexto na janela de chat, sem o documento crescer sem limite
const CHAT_MAX_MENSAGENS = 30;

// acrescenta uma entrada na thread de chat desse computador (mantendo so
// as ultimas CHAT_MAX_MENSAGENS) - usado tanto pelo lado do Master
// (enviarMensagem) quanto pela resposta digitada na janela flutuante do
// NOCZenith (responderChat)
async function adicionarNoChat(codigo, posto, entrada) {
  const id = docIdFor(codigo, posto);
  const snap = await COLLECTION.doc(id).get();
  const atual = snap.exists ? snap.data() : null;
  const thread = [...((atual && atual.chatMensagens) || []), entrada].slice(-CHAT_MAX_MENSAGENS);
  await COLLECTION.doc(id).set({ codigo, posto, chatMensagens: thread }, { merge: true });
  cache.invalidar();
  return thread;
}

// fica esperando pro proximo heartbeat DESSE computador entregar (ver
// heartbeat() acima) - nao exige o computador estar online agora. Alem do
// aviso "de uso unico" (mensagemPendente, ja existia - o banner que
// atendimento.html mostra), agora tambem entra na thread de chat
// (chatMensagens) - pedido explicito do usuario: uma caixa de dialogo
// flutuante estilo Splashtop na tela do computador ('interno' - ver
// vigiaScript.js), com ida e volta de verdade, nao so um aviso de uma via
async function enviarMensagem(codigo, posto, texto, deEmail) {
  const id = docIdFor(codigo, posto);
  const textoLimpo = String(texto || '').trim().slice(0, 500);
  if (!textoLimpo) throw new Error('Escreva a mensagem.');
  await COLLECTION.doc(id).set({
    codigo, posto,
    mensagemPendente: { texto: textoLimpo, deEmail: deEmail || null, em: Date.now() },
  }, { merge: true });
  await adicionarNoChat(codigo, posto, { de: 'master', texto: textoLimpo, deEmail: deEmail || null, em: Date.now() });
  return { codigo, posto, texto: textoLimpo };
}

// o NOCZenith reporta o que a pessoa digitou na janela flutuante de chat
// (ver rota publica .../chat-responder em index.js - sem sessao, quem
// chama e a maquina) - so entra na thread, o Master ve no mesmo modal de
// mensagem em loja-status.html no proximo poll (30s)
async function responderChat(codigo, posto, texto) {
  const textoLimpo = String(texto || '').trim().slice(0, 500);
  if (!textoLimpo) throw new Error('Mensagem vazia.');
  const thread = await adicionarNoChat(codigo, posto, { de: 'computador', texto: textoLimpo, em: Date.now() });
  return { codigo, posto, texto: textoLimpo, chatMensagens: thread };
}

// varredura periodica (ver rodarVarreduraLojaStatus em index.js): detecta
// computadores que ACABARAM de cair (pra avisar uma vez so - nao repete a
// cada tick, controlado por avisadoOffline) e os que voltaram - so
// considera computadores que ja mandaram heartbeat alguma vez, senao todo
// computador cadastrado mas ainda nao aberto no navegador da loja apareceria
// como "caido" desde sempre
async function varrerAlertas() {
  const docs = await listUncached();
  const transicoes = [];
  for (const doc of docs) {
    if (!doc.ultimoHeartbeatEm) continue;
    const online = (Date.now() - doc.ultimoHeartbeatEm) < LIMIAR_OFFLINE_MS;
    if (!online && !doc.avisadoOffline) {
      await COLLECTION.doc(docIdFor(doc.codigo, doc.posto)).update({ avisadoOffline: true, offlineDesde: Date.now() });
      transicoes.push({ codigo: doc.codigo, posto: doc.posto, nome: doc.nome, tipo: 'offline' });
    } else if (online && doc.avisadoOffline) {
      await COLLECTION.doc(docIdFor(doc.codigo, doc.posto)).update({ avisadoOffline: false, offlineDesde: null });
      transicoes.push({ codigo: doc.codigo, posto: doc.posto, nome: doc.nome, tipo: 'online' });
    }
  }
  if (transicoes.length) cache.invalidar();
  return transicoes;
}

module.exports = {
  heartbeat, listar, cadastrarComputador, editarComputador, removerComputador,
  definirAnydeskId, enviarMensagem, varrerAlertas, atualizarIpLocal, TIPOS_COMPUTADOR,
  enfileirarComando, marcarComandoExecutado, registrarAcessoRemoto, responderChat,
};
