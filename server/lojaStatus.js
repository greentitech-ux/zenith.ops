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
const redeDiagnostico = require('./redeDiagnostico');
const nocMaquina = require('./nocMaquina');

const COLLECTION = db.collection('lojaStatus');
// fila de comandos do agente (ver agenteAcoes.js) - histórico completo de
// cada comando enviado a um computador tipo 'interno', com resultado. O
// doc do computador guarda só o ponteiro pro comando em aberto
// (comandoPendenteId) - evita precisar de índice composto no Firestore pra
// achar o comando certo: já sabemos o id exato na hora do heartbeat
const COMANDOS_COLLECTION = db.collection('lojaStatusComandos');
const CONFIG_DOC = db.collection('lojaStatusConfig').doc('geral');

// config do NOC. Hoje so o toggle do PUSH de acesso remoto: DESLIGADO por
// padrao (o alerta virava spam do proprio acesso remoto da equipe -
// AnyDesk/TeamViewer/DWService que a TI usa; o evento continua sendo gravado
// no historico de atividades de cada computador, so nao empurra pro celular)
let configCache = null;
let configCacheEm = 0;
async function getConfig() {
  if (configCache && (Date.now() - configCacheEm) < 30 * 1000) return configCache;
  const snap = await CONFIG_DOC.get();
  configCache = snap.exists ? snap.data() : {};
  configCacheEm = Date.now();
  return configCache;
}
async function setConfig(patch) {
  await CONFIG_DOC.set(patch, { merge: true });
  configCache = null;
  return getConfig();
}
async function pushAcessoRemotoAtivo() {
  const c = await getConfig();
  return c.pushAcessoRemoto === true; // default false
}

const TIPOS_COMPUTADOR = ['atendimento', 'interno', 'abastecimento'];
function tipoValido(tipo) { return TIPOS_COMPUTADOR.includes(tipo) ? tipo : 'atendimento'; }

// segredo por computador (agentToken) - fecha a brecha de que o canal do
// NOCZenith (entrega de comando, resultado, chat, IP, alerta de acesso
// remoto) so dependia de codigo+posto, que sao identificadores PUBLICOS
// (ficam no QR/link colado na maquina). Sem isso, qualquer um que soubesse
// codigo+posto conseguia: (1) roubar E consumir o comando PowerShell que o
// Master enfileirou (o heartbeat entrega e marca 'entregue' na mesma
// chamada), (2) forjar o resultado de um comando, (3) injetar alerta/chat/IP
// falso. O token vai assado no proprio .ps1 (gerado so pra Master logado ou
// pra um agente que ja tem o token - ver rota vigia.ps1 em index.js) e volta
// em todo request do agente no cabecalho X-NOC-Token.
function gerarAgentToken() { return crypto.randomBytes(24).toString('hex'); }

// comparacao em tempo constante (evita timing attack) - so bate se os dois
// existem e tem o mesmo tamanho
function tokensBatem(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (!ba.length || ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// nunca deixa o agentToken (segredo) sair numa vista de leitura - o painel
// (loja-status.html) so precisa do resto
function semSegredo(doc) {
  if (!doc) return doc;
  const { agentToken, ...resto } = doc;
  return resto;
}

// heartbeat a cada ~25s (ver atendimento.html) - 90s da margem pra 2
// heartbeats perdidos por jitter de rede antes de considerar offline
const LIMIAR_OFFLINE_MS = 90 * 1000;
// registro de atividades por computador: guarda as ultimas N transicoes
// online<->offline (ver varrerAlertas), pra auditar quedas de conexao sem
// depender de print. Capado pra o documento nao crescer sem limite.
const EVENTOS_MAX = 60;

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
      criadoEm: atual.criadoEm || atual.ultimoHeartbeatEm || Date.now(),
    }, { merge: true });
    await doc.ref.delete();
  }
  return true;
}

// ---- espelho em memoria da colecao ------------------------------------
//
// Por que existe: cada computador bate um heartbeat a cada 25s, e o
// heartbeat precisava LER o documento antes de escrever. Isso dava 3.456
// leituras por dia POR COMPUTADOR - com 15 maquinas, ~1,55 milhao de
// leituras por mes so nisso, praticamente toda a cota gratuita do Firestore,
// pra reler um documento que quase nunca muda. A varredura de 1min e o
// painel aberto reliam a colecao inteira por cima disso.
//
// Por que da pra confiar na memoria: o app roda em UMA instancia (Render,
// plano free - ver render.yaml) e TODA escrita nessa colecao passa por este
// modulo. Entao a memoria e tao autoritativa quanto o Firestore. O TTL
// abaixo e so rede de seguranca (processo reiniciado, escrita feita por
// fora, console do Firebase).
//
// A invalidacao nao precisou ser espalhada por 12 lugares: todo ponto de
// escrita ja chamava cache.invalidar(), entao o espelho pega carona nesse
// mesmo gancho (ver a composicao de `cache` logo abaixo).
const ESPELHO_TTL_MS = 10 * 60 * 1000;
let espelho = null;      // Map docId -> dados
let espelhoEm = 0;

async function carregarEspelho() {
  const snap = await COLLECTION.get();
  // so relê se a migracao mexeu em alguma coisa (o normal e nao mexer, e
  // relê-la sempre dobrava o custo desta carga)
  const migrou = await migrarLegado(snap.docs);
  const docs = migrou ? (await COLLECTION.get()).docs : snap.docs;
  const mapa = new Map();
  docs.forEach((d) => mapa.set(d.id, d.data()));
  espelho = mapa;
  espelhoEm = Date.now();
  return mapa;
}

async function garantirEspelho() {
  if (espelho && (Date.now() - espelhoEm) < ESPELHO_TTL_MS) return espelho;
  return carregarEspelho();
}

function invalidarEspelho() { espelho = null; espelhoEm = 0; }

async function listUncached() {
  return [...(await garantirEspelho()).values()];
}
const cacheBase = createCache(listUncached, 10 * 1000);
// invalidar() derruba o espelho JUNTO - assim os pontos de escrita que ja
// chamavam cache.invalidar() continuam corretos sem nenhuma mudanca neles
const cache = {
  cached: cacheBase.cached,
  invalidar: () => { invalidarEspelho(); cacheBase.invalidar(); },
};

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
// Monta os campos de diagnostico de link que vao junto na escrita do
// heartbeat. Devolve {} quando nao ha nada novo, pra nao reescrever campo a
// toa (nem apagar o acumulado do dia quando chega um beat sem medicao - o
// caso do computador que ainda esta com a versao velha do agente).
function metricasDeRede(atual, rede) {
  const amostra = redeDiagnostico.sanitizarAmostra(rede);
  const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
  const bucketAtual = (atual && atual.redeDia) || null;
  const viraDia = !!(bucketAtual && bucketAtual.dia && bucketAtual.dia !== hoje);
  if (!amostra && !viraDia) return {};
  const campos = {};
  if (viraDia) {
    // fecha o dia anterior no historico antes de zerar o acumulador
    campos.redeHistorico = redeDiagnostico.virarDia(bucketAtual, (atual && atual.redeHistorico) || [], hoje);
  }
  campos.redeDia = redeDiagnostico.acumular(viraDia ? null : bucketAtual, amostra, hoje);
  // serie por hora (ver redeDiagnostico): e o que permite ver se duas lojas
  // ficaram lentas ao MESMO tempo. Vai na mesma escrita, sem custo novo.
  if (amostra) {
    campos.redeHoras = redeDiagnostico.acumularHora(
      (atual && atual.redeHoras) || [], amostra, redeDiagnostico.horaDe(Date.now()),
    );
    // camada de 5min, pra janela de "últimos 60 minutos" (ver redeDiagnostico)
    campos.redeMinutos = redeDiagnostico.acumularMinuto(
      (atual && atual.redeMinutos) || [], amostra, Date.now(),
    );
  }
  return campos;
}

async function heartbeat(codigo, posto, info, token) {
  const id = docIdFor(codigo, posto || 'principal');
  const ref = COLLECTION.doc(id);
  // ANTES: um ref.get() por batida. Como a batida e a cada 25s, isso dava
  // 3.456 leituras/dia POR COMPUTADOR pra reler um documento que o proprio
  // servidor acabou de escrever. Agora sai do espelho em memoria (ver
  // garantirEspelho) - e qualquer escrita vinda de outro caminho
  // (mensagem, comando, edicao) derruba o espelho pelo cache.invalidar()
  // que aqueles caminhos ja chamavam.
  const memoria = await garantirEspelho();
  const atual = memoria.get(id) || null;
  const mensagemPendente = (atual && atual.mensagemPendente) || null;
  const dados = info || {};
  // presenca (online/offline, IP, userAgent) continua SEM exigir token - e
  // telemetria de baixo risco e nao pode deixar maquina legada (que ainda
  // nao atualizou o NOCZenith, entao nao manda token) sumir do painel. Ja o
  // comando e a thread de chat (dados sensiveis) so saem com token valido.
  const patch = {
    codigo,
    posto: posto || 'principal',
    nome: (atual && atual.nome) || null,
    tipo: tipoValido((atual && atual.tipo) || 'atendimento'),
    // so grava na primeira vez (posto novo/fantasma) - usado pra detectar
    // "fantasma provavelmente e' a versao velha de tal computador" no painel
    // (ver adivinharDuplicado em loja-status.html): compara com o abertoDesde
    // dessa mesma aba, que fica fixo desde que ela carregou
    criadoEm: (atual && atual.criadoEm) || Date.now(),
    ultimoHeartbeatEm: Date.now(),
    anydeskId: (atual && atual.anydeskId) || null,
    // avisadoOffline/offlineDesde NAO entram aqui de proposito: sao da
    // varredura (ver varrerAlertas). O heartbeat le o doc e escreve depois;
    // se a varredura marcasse offline NESSA janela, o heartbeat regravava o
    // valor velho que leu e a marcacao se perdia - a varredura seguinte
    // marcava "Caiu" de novo, inventando queda que nao houve. Com
    // { merge: true }, nao citar o campo preserva o que estiver la.
    ip: dados.ip || (atual && atual.ip) || null,
    userAgent: dados.userAgent || (atual && atual.userAgent) || null,
    abertoDesde: dados.abertoDesde || (atual && atual.abertoDesde) || null,
    // diagnostico de link (ver redeDiagnostico.js). Entra nesta MESMA escrita
    // de proposito: o heartbeat ja grava a cada 25s, entao medir a rede nao
    // custa nenhuma operacao a mais no Firestore. redeDia/redeHistorico sao
    // donos do heartbeat (so ele escreve), entao o read-then-write aqui nao
    // repete a corrida que avisadoOffline teve com a varredura.
    ...metricasDeRede(atual, dados.rede),
  };
  // so limpa a mensagem quando havia uma pra entregar. Zerar o campo em toda
  // batida abria uma janela pra perder mensagem: se enviarMensagem() gravasse
  // entre a leitura e esta escrita, o null apagava a mensagem que nunca
  // chegou a ser mostrada.
  if (mensagemPendente) patch.mensagemPendente = null;
  await ref.set(patch, { merge: true });
  // mantem o espelho em dia sem reler: o heartbeat sabe exatamente o que
  // acabou de gravar. É isso que faz a proxima batida nao custar leitura.
  memoria.set(id, { ...(atual || {}), ...patch });
  // token confere? (maquina legada sem token cadastrado nunca passa aqui -
  // recebe comando/chat vazios ate reinstalar o NOCZenith com o token assado)
  const tokenOk = !!(atual && atual.agentToken && tokensBatem(token, atual.agentToken));
  // só computador 'interno' processa comando do agente (ver agenteAcoes.js)
  // - é o único tipo onde a tela nao é a propria funcionalidade, entao roda
  // o NOCZenith sem gerenciar janela nenhuma - E só entrega o comando pra
  // quem provou o token (senao um terceiro que soubesse codigo+posto roubava
  // o comando PowerShell do Master e ainda o consumia, deixando a maquina de
  // verdade sem receber)
  let comandoPendente = null;
  if (tokenOk && atual.tipo === 'interno' && atual.comandoPendenteId) {
    comandoPendente = await entregarComandoPendente(codigo, posto || 'principal');
  }
  // thread de chat (ver enviarMensagem/responderChat) - manda sempre a
  // lista inteira (capada, pequena), o NOCZenith que guarda localmente
  // qual "em" ja mostrou pra so empurrar as mensagens novas na janela
  // flutuante (so tipo 'interno' processa isso hoje - ver vigiaScript.js).
  // So sai com token valido (a conversa pode ter dado sensivel)
  const chatMensagens = tokenOk ? ((atual && atual.chatMensagens) || []) : [];
  // NAO invalida o cache de listar() aqui: cada heartbeat (a cada 25s, de
  // ~30-50 computadores) forcava um refetch da colecao inteira a cada
  // chamada, multiplicando leituras sem necessidade - o TTL de 10s do cache
  // (ver `cache` acima) ja fica bem abaixo do LIMIAR_OFFLINE_MS (90s), entao
  // o status online/offline calculado por comOnline() nunca fica visivelmente
  // desatualizado mesmo sem invalidar na hora
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
  return docs.map(comOnline).map(semSegredo);
}

// get-or-create do segredo do computador - chamado ao gerar o .ps1 (ver rota
// vigia.ps1 em index.js), pra que o token va assado no script daquele posto.
// Idempotente: uma vez criado, sempre devolve o mesmo. Nao invalida o cache
// a toa quando ja existe
async function garantirAgentToken(codigo, posto) {
  const id = docIdFor(codigo, posto);
  const snap = await COLLECTION.doc(id).get();
  if (!snap.exists) throw new Error('Computador não encontrado.');
  const atual = snap.data();
  if (atual.agentToken) return atual.agentToken;
  const token = gerarAgentToken();
  await COLLECTION.doc(id).set({ agentToken: token }, { merge: true });
  cache.invalidar();
  return token;
}

// token atual do computador (ou null se legado/inexistente) - usado pela rota
// vigia.ps1 pra decidir se um download sem sessao de Master pode prosseguir
async function tokenDoComputador(codigo, posto) {
  const snap = await COLLECTION.doc(docIdFor(codigo, posto)).get();
  return snap.exists ? (snap.data().agentToken || null) : null;
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
    criadoEm: Date.now(),
    ultimoHeartbeatEm: null, avisadoOffline: false, offlineDesde: null, mensagemPendente: null,
    ip: null, userAgent: null, abertoDesde: null, ipLocal: null, ipLocalEm: null,
    comandoPendenteId: null,
    // segredo do agente - vai assado no .ps1 desse computador (ver
    // garantirAgentToken/vigiaScript.js), nunca sai numa vista de leitura
    agentToken: gerarAgentToken(),
  };
  await COLLECTION.doc(id).set(registro);
  cache.invalidar();
  return semSegredo(registro);
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

// move um computador ja cadastrado pra outra unidade, mantendo o mesmo
// "posto" (id do link/QR) - o docId embute o codigo (ver docIdFor), entao
// "mover" e cria+apaga por baixo dos panos, preservando nome/tipo/anydesk/
// token/historico de eventos. O link/QR ja distribuido pro dispositivo
// fisico manda unidade+posto no heartbeat (ver POST /api/loja-status/
// heartbeat) - depois de mover, esse link antigo aponta pra um registro que
// nao existe mais aqui, entao quem mover precisa gerar/repassar um link novo
// pro dispositivo (mesmo fluxo de "Novo computador")
async function moverComputador(codigoAtual, posto, codigoNovo) {
  const idAtual = docIdFor(codigoAtual, posto);
  const idNovo = docIdFor(codigoNovo, posto);
  if (idAtual === idNovo) throw new Error('Já está nessa unidade.');
  const snap = await COLLECTION.doc(idAtual).get();
  if (!snap.exists) throw new Error('Computador não encontrado.');
  const novoSnap = await COLLECTION.doc(idNovo).get();
  if (novoSnap.exists) throw new Error('Já existe um computador com esse mesmo id na unidade de destino.');
  const atual = snap.data();
  const registro = { ...atual, codigo: codigoNovo, posto };
  await COLLECTION.doc(idNovo).set(registro);
  await COLLECTION.doc(idAtual).delete();
  cache.invalidar();
  return semSegredo(registro);
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
// so aceita a escrita do agente autenticado quando o computador ja tem token
// (NOCZenith atualizado) - impede terceiro que saiba codigo+posto de
// envenenar o IP/alerta/chat mostrado pro Master. Computador legado (sem
// token) segue aceito por compatibilidade, ate reinstalar
function exigirTokenSeTiver(atual, token) {
  if (atual && atual.agentToken && !tokensBatem(token, atual.agentToken)) {
    throw new Error('Token do agente inválido.');
  }
}

async function atualizarIpLocal(codigo, posto, ip, token) {
  const id = docIdFor(codigo, posto);
  const limpo = String(ip || '').trim().slice(0, 45);
  if (!limpo) throw new Error('IP inválido.');
  const snap = await COLLECTION.doc(id).get();
  exigirTokenSeTiver(snap.exists ? snap.data() : null, token);
  await COLLECTION.doc(id).set({ codigo, posto, ipLocal: limpo, ipLocalEm: Date.now() }, { merge: true });
  cache.invalidar();
  return { codigo, posto, ipLocal: limpo };
}

// telemetria pesada do NOCZenith: saude do HD (SMART/espaco) e a varredura
// PASSIVA da rede local (tabela ARP - quem o computador enxerga na LAN da
// loja). Ver nocMaquina.js pro que cada campo significa e pros limites.
//
// Por que NAO vai de carona no heartbeat (como o diagnostico de link vai):
// o heartbeat e o caminho mais quente do sistema (a cada 25s por maquina) e
// tambem o mais critico - qualquer erro novo ali derruba a presenca de todo
// mundo. Isso aqui chega a cada ~1h (rede) / ~6h (disco), ou seja ~25
// escritas por dia por computador: irrelevante perto das 3.456 batidas, e
// isolado do que nao pode quebrar.
async function registrarTelemetria(codigo, posto, dados, token) {
  const id = docIdFor(codigo, posto);
  const snap = await COLLECTION.doc(id).get();
  const atual = snap.exists ? snap.data() : null;
  if (!atual) throw new Error('Computador não encontrado.');
  exigirTokenSeTiver(atual, token);
  const agora = Date.now();
  const patch = {};
  let eventos = atual.eventos || [];

  const disco = nocMaquina.sanitizarDisco(dados && dados.disco);
  if (disco) {
    const antes = nocMaquina.avaliarDisco(atual.disco);
    const depois = nocMaquina.avaliarDisco(disco);
    patch.disco = disco;
    patch.discoNivel = depois.nivel;
    patch.discoMotivos = depois.motivos;
    // so vira evento/alerta quando o estado PIORA. Um HD com setor realocado
    // continua com setor realocado pra sempre - avisar a cada 6h treinaria
    // todo mundo a ignorar o aviso, que e exatamente o oposto do objetivo.
    if (depois.nivel !== 'ok' && depois.nivel !== antes.nivel) {
      eventos = [...eventos, { tipo: 'disco', em: agora, detalhe: `${depois.nivel}: ${depois.motivos.join(' · ')}`.slice(0, 200) }];
      patch.eventos = eventos.slice(-EVENTOS_MAX);
      // a varredura periodica e quem manda o push (ver varrerAlertas) - aqui
      // e caminho de agente, nao pode depender de push funcionar
      patch.discoAlertaPendente = depois.nivel;
    }
  }

  // há quanto tempo o Windows está sem reiniciar. Regra da casa: reboot 1x
  // por semana (ver UPTIME_REINICIAR_DIAS)
  const uptimeHoras = nocMaquina.sanitizarUptime(dados && dados.uptimeHoras);
  if (uptimeHoras != null) {
    patch.uptimeHoras = uptimeHoras;
    patch.uptimeEm = agora;
    const u = nocMaquina.avaliarUptime(uptimeHoras, atual.uptimeCicloAvisado);
    // grava o ciclo SEMPRE (não só quando avisa): é o que faz o contador
    // voltar a zero sozinho quando a máquina finalmente reinicia
    patch.uptimeCicloAvisado = u.ciclo;
    if (u.avisarAgora) {
      eventos = [...eventos, { tipo: 'reiniciar', em: agora, detalhe: `ligado há ${u.dias} dias sem reiniciar` }];
      patch.eventos = eventos.slice(-EVENTOS_MAX);
      patch.reinicioAlertaPendente = u.dias;
    }
  }

  const dispositivos = nocMaquina.sanitizarDispositivos(dados && dados.dispositivos);
  if (dispositivos) {
    patch.dispositivos = dispositivos;
    patch.dispositivosEm = agora;
    const diff = nocMaquina.diffDispositivos(atual.dispositivosConhecidos, dispositivos);
    patch.dispositivosConhecidos = diff.conhecidos;
    if (diff.novos.length) {
      const resumo = diff.novos.slice(0, 5).map((d) => `${d.ip} (${d.mac})`).join(', ');
      eventos = [...eventos, { tipo: 'dispositivo-novo', em: agora, detalhe: `${diff.novos.length} novo(s) na rede: ${resumo}`.slice(0, 200) }];
      patch.eventos = eventos.slice(-EVENTOS_MAX);
    }
  }

  if (!Object.keys(patch).length) return { ok: false, motivo: 'nada útil na telemetria' };
  await COLLECTION.doc(id).set(patch, { merge: true });
  cache.invalidar();
  return {
    ok: true,
    disco: patch.discoNivel || null,
    dispositivos: dispositivos ? dispositivos.length : 0,
    uptimeHoras: uptimeHoras != null ? uptimeHoras : null,
  };
}

// o vigia detecta (via processos/conexoes de rede conhecidas - AnyDesk,
// TeamViewer, DWService ou qualquer outra ferramenta de acesso remoto - ver
// loja-status.html "Baixar vigia") quando alguem se conecta no computador e
// reporta aqui. Guarda so o ULTIMO evento (pra mostrar no detalhe do card em
// /loja-status.html) - quem realmente avisa cada conexao nova e o push pro
// Master (ver POST .../acesso-remoto em index.js + push.notifyAcessoRemotoDetectado),
// disparado toda vez que essa funcao roda, nao so na primeira. "detalhe" e
// texto livre tipo "AnyDesk (203.0.113.5:7070)", montado pelo proprio script
async function registrarAcessoRemoto(codigo, posto, detalhe, token) {
  const id = docIdFor(codigo, posto);
  const limpo = String(detalhe || '').trim().slice(0, 200);
  if (!limpo) throw new Error('Detalhe do acesso remoto é obrigatório.');
  const snap = await COLLECTION.doc(id).get();
  const atual = snap.exists ? snap.data() : null;
  exigirTokenSeTiver(atual, token);
  const agora = Date.now();
  // registra no historico de atividades do computador (aparece no detalhe),
  // pra ficar auditavel mesmo com o push desligado. Nao repete o mesmo detalhe
  // se ja foi o ultimo evento em menos de 10min (evita encher com o mesmo
  // batimento de nuvem da ferramenta)
  const eventosAtuais = (atual && atual.eventos) || [];
  const ultimo = eventosAtuais[eventosAtuais.length - 1];
  const repetido = ultimo && ultimo.tipo === 'acesso-remoto' && ultimo.detalhe === limpo && (agora - ultimo.em) < 10 * 60 * 1000;
  const patch = { codigo, posto, ultimoAcessoRemotoEm: agora, ultimoAcessoRemotoDetalhe: limpo };
  if (!repetido) patch.eventos = [...eventosAtuais, { tipo: 'acesso-remoto', em: agora, detalhe: limpo }].slice(-EVENTOS_MAX);
  await COLLECTION.doc(id).set(patch, { merge: true });
  cache.invalidar();
  return { codigo, posto, nome: atual && atual.nome, ultimoAcessoRemotoDetalhe: limpo };
}

// enfileira um comando (ver agenteAcoes.js executarAcaoDoAgente) pro
// computador buscar no proximo heartbeat. So aceita computador tipo
// 'interno' (unico que processa comando - ver heartbeat() acima) e so um
// comando pendente/entregue por vez (evita perder o rastro de um
// resultado se um segundo comando chegasse por cima)
// Comando de INCIDENTE, fixo no código de propósito. Ele mata qualquer
// processo NOCZenith órfão que tenha sobrado na máquina - é o que segura a
// caixa "Ocorreu uma exceção sem tratamento" na tela da loja (ver a correção
// da janela de chat em vigiaScript.js).
//
// Duas travas dentro do próprio comando:
//   - exclui $PID: quem executa isto É o vigia saudável; sem isso ele se
//     mataria e a loja ficaria sem monitoramento.
//   - filtra por CommandLine contendo NOCZenith: não encosta em nenhum outro
//     PowerShell que a loja porventura tenha aberto. CommandLine nulo (sem
//     permissão de leitura) não casa no -like, então fica de fora.
const COMANDO_LIMPAR_TRAVADOS = [
  '$mortos = 0',
  "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" -ErrorAction SilentlyContinue |",
  "  Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*NOCZenith*' } |",
  '  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; $mortos++ } catch {} }',
  '"Processos NOCZenith orfaos encerrados: $mortos"',
].join('\n');

// Dispara o MESMO comando pra todos os computadores 'interno' de uma vez.
// Não recebe o comando de fora: quem chama escolhe entre os comandos fixos
// acima. Abrir isso pra texto livre seria criar um "executar qualquer coisa
// em toda a rede" numa rota HTTP - não vale o risco nem num incidente.
async function enfileirarComandoEmTodos(comando, opcoes) {
  const docs = (await listUncached()).filter((d) => d.tipo === 'interno');
  // EM PARALELO, e isso não é micro-otimização: cada enfileirarComando faz 3
  // idas e voltas ao Firestore (1 leitura + 2 escritas). Em série, com algumas
  // dezenas de computadores, a requisição HTTP passava de 20-30s numa
  // instância free e o navegador desistia antes ("Failed to fetch"), deixando
  // parte da frota comandada e parte não. Em paralelo vira ~3 rodadas.
  const resultados = await Promise.all(docs.map(async (doc) => {
    const base = { codigo: doc.codigo, posto: doc.posto, nome: doc.nome };
    try {
      await enfileirarComando(doc.codigo, doc.posto, comando, opcoes);
      return { ...base, ok: true };
    } catch (err) {
      // "já existe comando pendente" NÃO é falha pro nosso caso: significa
      // que a máquina já tem um comando esperando (provavelmente desta mesma
      // tentativa, que estourou no meio). Marcar como erro faria o operador
      // sair atrás de loja que já está resolvida.
      const jaTinha = /comando pendente/i.test(err.message || '');
      return { ...base, ok: jaTinha, jaTinha, motivo: jaTinha ? null : err.message };
    }
  }));
  return resultados;
}

async function enfileirarComando(codigo, posto, comando, opcoes) {
  const id = docIdFor(codigo, posto);
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Computador não encontrado.');
  const atual = snap.data();
  if (atual.tipo !== 'interno') throw new Error('Só computadores tipo "interno" processam comandos do agente.');
  // comando só sai pra computador que tem o token cadastrado (NOCZenith
  // atualizado) - assim a entrega e a confirmacao andam autenticadas de ponta
  // a ponta. Maquina legada precisa reinstalar o NOCZenith uma vez pra
  // "entrar" no canal seguro antes de aceitar comando
  if (!atual.agentToken) throw new Error('Esse computador precisa reinstalar o NOCZenith (baixar de novo) pra habilitar comandos com segurança.');
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
async function marcarComandoExecutado(comandoId, dados, contexto) {
  const d = dados || {};
  const ctx = contexto || {};
  const comandoRef = COMANDOS_COLLECTION.doc(comandoId);
  const snap = await comandoRef.get();
  if (!snap.exists) throw new Error('Comando não encontrado.');
  const comando = snap.data();
  // o resultado tem que vir DO computador certo (codigo/posto do comando) e
  // com o token dele - senao qualquer um que adivinhasse um comandoId forjava
  // o resultado (marcava 'executado' com saida falsa, escondendo se rodou de
  // verdade). A rota passa codigo/posto da URL + token do cabecalho
  if (ctx.codigo != null && (ctx.codigo !== comando.codigo || ctx.posto !== comando.posto)) {
    throw new Error('Comando não pertence a esse computador.');
  }
  const compSnap = await COLLECTION.doc(docIdFor(comando.codigo, comando.posto)).get();
  const agentToken = compSnap.exists ? compSnap.data().agentToken : null;
  if (agentToken && !tokensBatem(ctx.token, agentToken)) throw new Error('Token do agente inválido.');
  const patch = {
    status: d.erro ? 'erro' : 'executado',
    executadoEm: new Date().toISOString(),
    resultado: d.resultado || null,
    erro: d.erro || null,
  };
  await comandoRef.update(patch);
  // carimba o ultimo resultado no doc do computador (alem de liberar a fila),
  // pra aparecer no detalhe do computador no NOC - quem mandou o comando ve o
  // que voltou sem precisar entrar na maquina
  await COLLECTION.doc(docIdFor(comando.codigo, comando.posto)).set({
    comandoPendenteId: null,
    ultimoComandoEm: patch.executadoEm,
    ultimoComandoTexto: String(comando.comando || '').slice(0, 200),
    ultimoComandoResultado: patch.resultado ? String(patch.resultado).slice(0, 2000) : null,
    ultimoComandoErro: patch.erro ? String(patch.erro).slice(0, 500) : null,
  }, { merge: true });
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
  // explicito de proposito: sem isso o heartbeat seguiria lendo o espelho
  // antigo (sem a mensagem) e ela nunca seria entregue. Hoje o
  // adicionarNoChat abaixo tambem invalida, mas depender do efeito colateral
  // dele deixaria uma falha silenciosa esperando alguem mexer naquela funcao.
  cache.invalidar();
  await adicionarNoChat(codigo, posto, { de: 'master', texto: textoLimpo, deEmail: deEmail || null, em: Date.now() });
  return { codigo, posto, texto: textoLimpo };
}

// o NOCZenith reporta o que a pessoa digitou na janela flutuante de chat
// (ver rota publica .../chat-responder em index.js - sem sessao, quem
// chama e a maquina) - so entra na thread, o Master ve no mesmo modal de
// mensagem em loja-status.html no proximo poll (30s)
async function responderChat(codigo, posto, texto, token) {
  const textoLimpo = String(texto || '').trim().slice(0, 500);
  if (!textoLimpo) throw new Error('Mensagem vazia.');
  const snap = await COLLECTION.doc(docIdFor(codigo, posto)).get();
  exigirTokenSeTiver(snap.exists ? snap.data() : null, token);
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
  for (const candidato of docs) {
    // alerta de HD: quem detecta e a telemetria do agente (registrarTelemetria),
    // que so marca a flag; quem avisa e aqui, junto com o resto - assim o push
    // sai de UM lugar so e uma falha de push nunca derruba o caminho do agente
    if (candidato.discoAlertaPendente) {
      await COLLECTION.doc(docIdFor(candidato.codigo, candidato.posto)).update({ discoAlertaPendente: null });
      transicoes.push({
        codigo: candidato.codigo, posto: candidato.posto, nome: candidato.nome,
        tipo: 'disco', nivel: candidato.discoAlertaPendente,
        motivos: candidato.discoMotivos || [],
      });
    }
    // passou de mais uma semana sem reiniciar (ver UPTIME_REINICIAR_DIAS)
    if (candidato.reinicioAlertaPendente) {
      await COLLECTION.doc(docIdFor(candidato.codigo, candidato.posto)).update({ reinicioAlertaPendente: null });
      transicoes.push({
        codigo: candidato.codigo, posto: candidato.posto, nome: candidato.nome,
        tipo: 'reiniciar', dias: candidato.reinicioAlertaPendente,
      });
    }
    if (!candidato.ultimoHeartbeatEm) continue;
    let doc = candidato;
    // A lista acima vem do espelho em memoria. Ele e confiavel porque o
    // proprio heartbeat o mantem em dia, mas marcar uma loja como CAIDA e a
    // acao mais cara de errar aqui (push no celular de todo mundo de
    // madrugada). Entao antes de disparar, confere o documento de verdade -
    // uma leitura, e so quando a queda esta prestes a ser anunciada, o que
    // acontece pouquissimas vezes por dia. Se um dia o app rodar em mais de
    // uma instancia, e essa checagem que impede alarme falso em massa.
    if ((Date.now() - candidato.ultimoHeartbeatEm) >= LIMIAR_OFFLINE_MS && !candidato.avisadoOffline) {
      const snap = await COLLECTION.doc(docIdFor(candidato.codigo, candidato.posto)).get();
      if (!snap.exists) continue;
      doc = snap.data();
      if (espelho) espelho.set(docIdFor(doc.codigo, doc.posto), doc);
      if (!doc.ultimoHeartbeatEm) continue;
    }
    const online = (Date.now() - doc.ultimoHeartbeatEm) < LIMIAR_OFFLINE_MS;
    if (!online && !doc.avisadoOffline) {
      // 'em' = ultimo heartbeat real (quando de fato silenciou), nao a hora da
      // deteccao - fica mais fiel no registro
      const evento = { tipo: 'offline', em: doc.ultimoHeartbeatEm };
      await COLLECTION.doc(docIdFor(doc.codigo, doc.posto)).update({
        avisadoOffline: true,
        // offlineDesde = quando de fato SILENCIOU, nao a hora da deteccao.
        // A deteccao chega ate ~2,5min depois (limiar de 90s + tick de 1min),
        // e como o "ficou fora" abaixo mede a partir daqui, usar Date.now()
        // fazia o painel subnotificar toda queda nesse tanto - dava "7min"
        // numa parada real de 9min.
        offlineDesde: doc.ultimoHeartbeatEm,
        eventos: [...(doc.eventos || []), evento].slice(-EVENTOS_MAX),
      });
      transicoes.push({ codigo: doc.codigo, posto: doc.posto, nome: doc.nome, tipo: 'offline' });
    } else if (online && doc.avisadoOffline) {
      const evento = { tipo: 'online', em: Date.now(), duracaoMs: doc.offlineDesde ? (Date.now() - doc.offlineDesde) : null };
      await COLLECTION.doc(docIdFor(doc.codigo, doc.posto)).update({
        avisadoOffline: false, offlineDesde: null,
        eventos: [...(doc.eventos || []), evento].slice(-EVENTOS_MAX),
      });
      transicoes.push({ codigo: doc.codigo, posto: doc.posto, nome: doc.nome, tipo: 'online' });
    }
  }
  if (transicoes.length) cache.invalidar();
  return transicoes;
}

// Saude da FROTA: discos com problema (pior primeiro) + quantos aparelhos
// cada loja enxerga na propria rede. Igual ao diagnosticoRede, sai do MESMO
// cache de listar() - nao gera leitura extra no Firestore.
async function saudeMaquinas() {
  const docs = (await cache.cached()).map(semSegredo);
  return {
    discos: nocMaquina.discosComProblema(docs),
    reiniciar: nocMaquina.maquinasParaReiniciar(docs),
    redes: nocMaquina.resumoDispositivos(docs),
    // quantos ja reportaram: separa "está tudo bem" de "ninguém mediu ainda"
    comDisco: docs.filter((d) => d.disco).length,
    comVarredura: docs.filter((d) => d.dispositivos && d.dispositivos.length).length,
    total: docs.length,
  };
}

// Diagnostico de link de todos os computadores, pior primeiro (ver
// redeDiagnostico.js). Usa o MESMO cache de listar() - nao gera leitura extra
// no Firestore, so reinterpreta o que ja esta carregado.
async function diagnosticoRede(dia) {
  const alvo = dia || new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
  const docs = (await cache.cached()).map(comOnline).map(semSegredo);
  return {
    dia: alvo,
    // a mediana da frota vai junto: e a referencia que o painel usa pra dizer
    // "esta maquina esta fora da curva" em vez de acusar o servidor
    frota: redeDiagnostico.baselineDaFrota(docs, alvo),
    computadores: redeDiagnostico.ranking(docs, alvo),
  };
}

module.exports = {
  heartbeat, listar, diagnosticoRede, cadastrarComputador, editarComputador, removerComputador, moverComputador,
  definirAnydeskId, enviarMensagem, varrerAlertas, atualizarIpLocal, TIPOS_COMPUTADOR,
  getConfig, setConfig, pushAcessoRemotoAtivo,
  enfileirarComando, enfileirarComandoEmTodos, COMANDO_LIMPAR_TRAVADOS,
  marcarComandoExecutado, registrarAcessoRemoto, responderChat, registrarTelemetria,
  saudeMaquinas,
  garantirAgentToken, tokenDoComputador,
};
