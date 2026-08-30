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
// entrada; 'interno' mostra a tela normal de login do NoPulso (index.html) -
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
const ouiFabricantes = require('./ouiFabricantes');

const COLLECTION = db.collection('lojaStatus');
// fila de comandos do agente (ver agenteAcoes.js) - histórico completo de
// cada comando enviado a um computador tipo 'interno', com resultado. O
// doc do computador guarda só o ponteiro pro comando em aberto
// (comandoPendenteId) - evita precisar de índice composto no Firestore pra
// achar o comando certo: já sabemos o id exato na hora do heartbeat
const COMANDOS_COLLECTION = db.collection('lojaStatusComandos');
const CONFIG_DOC = db.collection('lojaStatusConfig').doc('geral');
// apelidos dos aparelhos da rede da loja, por unidade: { codigo: { mac: nome } }.
// UM doc pra tudo de propósito - o nome que a pessoa dá ("Impressora da
// cozinha") vale pra loja inteira, não pro computador que por acaso enxergou
// aquele MAC primeiro; e um doc pequeno é mais barato que uma coleção nova
// consultada a cada abertura do painel.
const APELIDOS_DOC = db.collection('lojaStatusConfig').doc('apelidosRede');

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

// mesma ideia do configCache: o painel lê isso a cada 30s e quase nunca muda.
// O cache guarda o DOCUMENTO inteiro (unidades + tipos criados na tela), pra
// que listar os tipos não custe uma leitura a mais do Firestore (§3).
let apelidosCache = null;
let apelidosCacheEm = 0;
async function getApelidosDoc() {
  if (apelidosCache && (Date.now() - apelidosCacheEm) < 30 * 1000) return apelidosCache;
  const snap = await APELIDOS_DOC.get();
  const dados = snap.exists ? (snap.data() || {}) : {};
  apelidosCache = {
    unidades: dados.unidades || {},
    tipos: Array.isArray(dados.tipos) ? dados.tipos : [],
  };
  apelidosCacheEm = Date.now();
  return apelidosCache;
}
async function getApelidos() {
  return (await getApelidosDoc()).unidades;
}

// "tipo" decide se o dispositivo pode ser MONITORADO (alarme de rede - ver
// varrerAlertas): pedido do Master pra impressoras (Zebra/Bematech) e VMs
// do servidor local perderem rede sem que ninguém precise ficar rodando um
// scanner externo pra descobrir. Vocabulário do próprio Master, não em
// inglês.
// A lista base sai do vocabulário do próprio Master (o que ele enxerga no
// scanner da loja): impressora, VM Host do servidor, PULSE, GCOM. 'vm' fica
// porque já foi gravado em aparelho de loja - tirar da lista apagaria o tipo
// de quem já estava marcado.
const TIPOS_DISPOSITIVO_BASE = [
  { id: 'impressora', rotulo: 'Impressora', icone: '🖨️' },
  { id: 'vmhost', rotulo: 'VM Host', icone: '🖥️' },
  { id: 'pulse', rotulo: 'PULSE', icone: '🖥️' },
  { id: 'gcom', rotulo: 'GCOM', icone: '🖥️' },
  { id: 'vm', rotulo: 'VM', icone: '🖥️' },
];

// tipo criado pela tela ("+ Novo tipo") vira um id em slug. O id é o que fica
// gravado no aparelho; o rótulo é só o que se lê. Por isso a validação na
// LEITURA é o formato do slug, e não a lista - um tipo removido da lista não
// pode apagar o tipo dos aparelhos que já o usam.
function idDoTipoDispositivo(texto) {
  return String(texto || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
}

// base + os criados na tela, sem duplicar id. Não custa leitura nova: sai do
// mesmo documento já cacheado dos apelidos.
async function listarTiposDispositivo() {
  const { tipos } = await getApelidosDoc();
  const saida = TIPOS_DISPOSITIVO_BASE.map((t) => ({ ...t }));
  const vistos = new Set(saida.map((t) => t.id));
  for (const t of tipos) {
    const id = idDoTipoDispositivo(t && t.id);
    if (!id || vistos.has(id)) continue;
    vistos.add(id);
    saida.push({ id, rotulo: String((t && t.rotulo) || id).slice(0, 24), icone: '📡' });
  }
  return saida;
}

function rotuloDoTipoDispositivo(id, lista) {
  if (!id) return null;
  const achado = (lista || TIPOS_DISPOSITIVO_BASE).find((t) => t.id === id);
  return achado ? achado.rotulo : id;
}

// cada MAC em apelidosRede começou como STRING pura (só o nome). Ganhou
// "tipo"/"monitorar" depois, sem migração em massa: um valor antigo (string)
// continua lendo certo aqui, e só vira o formato novo quando alguém EDITA
// aquele MAC pela tela - o resto do documento fica como estava.
function normalizarEntradaApelido(valor) {
  if (typeof valor === 'string') return { apelido: valor || null, tipo: null, monitorar: false };
  if (valor && typeof valor === 'object') {
    return {
      apelido: typeof valor.apelido === 'string' && valor.apelido ? valor.apelido : null,
      tipo: idDoTipoDispositivo(valor.tipo) || null,
      monitorar: !!valor.monitorar,
    };
  }
  return { apelido: null, tipo: null, monitorar: false };
}

// o nome que a pessoa dá vence o que o DNS respondeu: quem batizou de
// "Impressora da cozinha" sabe melhor que o hostname "BRWA4-2B-B0".
// aceita tanto a chamada antiga (apelido como string solta) quanto a nova
// ({apelido, tipo, monitorar}) - campo omitido = não mexe no que já tinha.
async function definirApelidoDispositivo(codigo, mac, entrada) {
  const macOk = String(mac || '').trim().toLowerCase();
  if (!/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(macOk)) throw new Error('MAC inválido.');
  if (!codigo) throw new Error('Unidade é obrigatória.');
  const corpo = typeof entrada === 'string' ? { apelido: entrada } : (entrada || {});
  const { unidades: atuais, tipos: extras } = await getApelidosDoc();
  const daUnidade = { ...(atuais[codigo] || {}) };
  const anterior = normalizarEntradaApelido(daUnidade[macOk]);
  const limpo = String(corpo.apelido != null ? corpo.apelido : (anterior.apelido || '')).trim().slice(0, 40);
  // "tipoNovo" é o texto do botão "+ Novo tipo" da tela: vence o select, vira
  // slug e passa a existir pra TODA a rede (é assim que o tipo criado numa
  // loja aparece no aparelho da outra) - sem endpoint separado só pra isso.
  let extrasNovos = extras;
  let tipo;
  const rotuloNovo = String(corpo.tipoNovo || '').trim().slice(0, 24);
  if (rotuloNovo) {
    const id = idDoTipoDispositivo(rotuloNovo);
    if (!id) throw new Error('Nome do tipo inválido.');
    tipo = id;
    const conhecidos = new Set([
      ...TIPOS_DISPOSITIVO_BASE.map((t) => t.id),
      ...extras.map((t) => idDoTipoDispositivo(t && t.id)),
    ]);
    if (!conhecidos.has(id)) extrasNovos = [...extras, { id, rotulo: rotuloNovo }];
  } else if (corpo.tipo !== undefined) {
    tipo = idDoTipoDispositivo(corpo.tipo) || null;
  } else {
    tipo = anterior.tipo;
  }
  const monitorar = corpo.monitorar !== undefined ? !!corpo.monitorar : anterior.monitorar;
  if (!limpo && !tipo && !monitorar) delete daUnidade[macOk];
  else daUnidade[macOk] = { apelido: limpo || null, tipo, monitorar };
  await APELIDOS_DOC.set({ unidades: { ...atuais, [codigo]: daUnidade }, tipos: extrasNovos }, { merge: false });
  apelidosCache = null;
  return { codigo, mac: macOk, apelido: limpo || null, tipo, monitorar };
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
// Quanto tempo de silêncio separa "oscilou e voltou" de "caiu de verdade".
// Pedido do usuário: conexão que cai e volta em 1-3 minutos NÃO é queda -
// o painel continua acusando na hora (estado INDISPONÍVEL + evento no
// histórico), mas o push CRÍTICO (o que dispara o alarme sonoro) só sai se
// o silêncio passar deste teto. Env pra ajustar sem deploy.
const CONFIRMACAO_QUEDA_MS = Number(process.env.LOJA_STATUS_CONFIRMACAO_QUEDA_MS) >= 0
  ? Number(process.env.LOJA_STATUS_CONFIRMACAO_QUEDA_MS)
  : 4 * 60 * 1000;
// mesma ideia do CONFIRMACAO_QUEDA_MS acima, mas NÃO pode reusar o valor: a
// varredura de dispositivos de rede (Varrer-RedeLocal, vigiaScript.js) roda
// so 1x por HORA, e mesclarDispositivos ja marca ativo:false no primeiro
// scan em que o MAC nao aparece, sem folga nenhuma - "4 minutos de
// silencio" sempre estaria satisfeito no instante em que a queda e vista,
// nao confirma nada. Exige ~2 ciclos de scan sem aparecer (2h, com folga de
// jitter) antes de considerar queda de verdade - 1 scan perdido e normal
// (cache ARP, DHCP renovando, impressora ociosa).
const DISPOSITIVO_OFFLINE_LIMIAR_MS = Number(process.env.LOJA_STATUS_DISPOSITIVO_OFFLINE_MS) >= 0
  ? Number(process.env.LOJA_STATUS_DISPOSITIVO_OFFLINE_MS)
  : 2 * 60 * 60 * 1000;
// registro de atividades por computador: guarda as ultimas N transicoes
// online<->offline (ver varrerAlertas), pra auditar quedas de conexao sem
// depender de print. Capado pra o documento nao crescer sem limite.
// 60 rotacionava rapido demais numa maquina com acesso remoto frequente
// (cada deteccao e 1 evento) - o Master abriu o painel e os registros mais
// antigos ja tinham sido empurrados pra fora. 200 entradas curtas custam
// ~15KB no doc (limite do Firestore e 1MB) e cobrem semanas; alem disso o
// backup diario da colecao guarda 30 dias de retratos completos.
const EVENTOS_MAX = 200;

// historico de mudancas de IP por computador (pedido do Master: "preciso de
// dados quando o IP da maquina mudar"). Cobre os DOIS IPs que o NOC enxerga:
// 'publico' (visto pelo servidor a cada heartbeat - muda quando o link da
// loja troca: queda do provedor, failover pra 4G, renovacao do CGNAT) e
// 'local' (reportado pelo agente NOCZenith - muda em troca de DHCP/roteador).
// Fica no proprio doc do computador, capado pra nao crescer sem limite; a
// primeira aparicao tambem entra (de: null) pra registrar DESDE QUANDO o IP
// atual vale, nao so as trocas.
const IP_HISTORICO_MAX = 40;
function comMudancaDeIp(historico, tipo, de, para) {
  const lista = Array.isArray(historico) ? historico : [];
  return [...lista, { tipo, de: de || null, para, em: Date.now() }].slice(-IP_HISTORICO_MAX);
}

// ---------------------------------------------------------------------
// ESTADO DO ATIVO NO PARQUE. Antes só existiam dois: online e offline - e
// era exatamente isso que fazia o Master olhar uma máquina "offline" com
// rede boa e não entender nada, porque três situações MUITO diferentes
// pintavam o mesmo ponto vermelho:
//   - a máquina nunca teve o NOCZenith instalado (nunca bateu na vida);
//   - a máquina bate, mas está sem Ethernet (só no Wi-Fi) ou com disco ruim;
//   - a máquina realmente parou de falar.
// Separar os três é o que transforma o painel em NOC de verdade: cada um
// tem uma AÇÃO diferente (instalar o agente / mandar técnico no cabo /
// investigar queda).
const ESTADOS = {
  OPERACIONAL: 'operacional',     // batendo, sem ressalva
  DEGRADADO: 'degradado',         // batendo, mas com defeito conhecido
  INDISPONIVEL: 'indisponivel',   // já bateu antes e parou
  SEM_AGENTE: 'sem-agente',       // nunca bateu: NOCZenith não instalado
};

// Link físico reportado pelo NOCZenith (ver Medir-Link em vigiaScript.js).
// Guardado achatado no doc pra caber no espelho em memória sem peso.
const LINK_TIPOS = ['ethernet', 'wifi', 'outro', 'nenhum'];
function sanitizarLink(bruto) {
  if (!bruto || typeof bruto !== 'object') return null;
  const tipo = LINK_TIPOS.includes(bruto.tipo) ? bruto.tipo : 'outro';
  const mbps = Number(bruto.mbps);
  return {
    tipo,
    nome: String(bruto.nome || '').trim().slice(0, 80) || null,
    mbps: Number.isFinite(mbps) && mbps > 0 ? Math.round(mbps) : null,
    // a máquina tem placa Ethernet mas ela está fora do ar (cabo solto,
    // switch morto) - o caso que o Master pediu pra alertar. Só é
    // observável quando existe OUTRO caminho (Wi-Fi) mantendo ela viva;
    // se a Ethernet era o único caminho, ela some do ar e vira queda.
    ethernetCaida: !!bruto.ethernetCaida,
  };
}
function mesmoLink(a, b) {
  if (!a || !b) return a === b;
  return a.tipo === b.tipo && a.ethernetCaida === b.ethernetCaida && a.mbps === b.mbps;
}

// Reinício: o agente lê o LastBootUpTime UMA vez, quando sobe, e carrega
// esse número em todo heartbeat. Se o número muda, a máquina reiniciou -
// não tem como confundir com queda de rede (numa queda de rede o agente
// nem morre, e quando volta manda o MESMO bootEm). Tolerância de 60s
// porque o relógio da loja não é preciso e o valor é recalculado a cada
// subida do agente.
const TOLERANCIA_BOOT_MS = 60 * 1000;
function reiniciouDesde(anteriorBootEm, novoBootEm) {
  if (!anteriorBootEm || !novoBootEm) return false;
  return Math.abs(novoBootEm - anteriorBootEm) > TOLERANCIA_BOOT_MS;
}

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

// Campos de que o heartbeat e DONO: so ele escreve neles. Como a gravacao
// no Firestore passou a ser espacada (ver PERSIST_MS), a memoria fica mais
// nova que o documento entre uma gravacao e outra - entao numa recarga do
// espelho esses campos NAO podem voltar pro valor velho do banco. Sem isso,
// o ultimoHeartbeatEm rebobinava ate 5min e a varredura anunciava queda de
// uma maquina que nunca parou.
const CAMPOS_DO_HEARTBEAT = [
  'ultimoHeartbeatEm', 'ip', 'userAgent', 'abertoDesde',
  'redeDia', 'redeHoras', 'redeMinutos', 'redeHistorico',
  // boot e link: só o heartbeat escreve. Preservar importa mais aqui que
  // nos outros - se o bootEm rebobinasse pro valor velho do banco, o
  // heartbeat seguinte veria "mudou" e inventaria um reinício que não houve.
  // ('eventos' de propósito FORA desta lista: a varredura também escreve
  // nele, e preservar a cópia da memória apagaria o que ela gravou.)
  'bootEm', 'link', 'linkEm', 'desligamentoInesperado',
];

async function carregarEspelho() {
  const snap = await COLLECTION.get();
  // so relê se a migracao mexeu em alguma coisa (o normal e nao mexer, e
  // relê-la sempre dobrava o custo desta carga)
  const migrou = await migrarLegado(snap.docs);
  const docs = migrou ? (await COLLECTION.get()).docs : snap.docs;
  const mapa = new Map();
  docs.forEach((d) => {
    const doBanco = d.data();
    const emMemoria = espelho && espelho.get(d.id);
    // memoria mais nova que o banco: preserva o que o heartbeat acumulou
    // desde a ultima gravacao, e pega do banco todo o resto (nome, tipo,
    // anydeskId, avisadoOffline... - editados por outros caminhos)
    if (emMemoria && (emMemoria.ultimoHeartbeatEm || 0) > (doBanco.ultimoHeartbeatEm || 0)) {
      const preservado = {};
      CAMPOS_DO_HEARTBEAT.forEach((c) => { if (emMemoria[c] !== undefined) preservado[c] = emMemoria[c]; });
      mapa.set(d.id, { ...doBanco, ...preservado });
      return;
    }
    mapa.set(d.id, doBanco);
  });
  espelho = mapa;
  espelhoEm = Date.now();
  return mapa;
}

async function garantirEspelho() {
  if (espelho && (Date.now() - espelhoEm) < ESPELHO_TTL_MS) return espelho;
  return carregarEspelho();
}

// Zera a validade, mas NAO joga fora o mapa: a proxima carga precisa dele
// pra saber quais campos da memoria estao mais novos que o banco (ver
// carregarEspelho). Descartar aqui fazia uma edicao de nome/tipo derrubar
// junto o ultimoHeartbeatEm ainda nao gravado - e a varredura seguinte
// anunciava uma queda que nunca houve.
function invalidarEspelho() { espelhoEm = 0; }

// ---------------------------------------------------------------------
// POR QUE ISSO EXISTE (custo do Firestore):
//
// invalidarEspelho() zera a validade, e a proxima leitura roda
// carregarEspelho(), que le a COLECAO INTEIRA - hoje 52 documentos. Como
// cache.invalidar() derruba o espelho junto, TODA escrita de UMA maquina
// (uma batida com evento novo, uma amostra de rede, um IP que mudou, uma
// mensagem no chat) obrigava a proxima leitura a reler as 52. Com o painel
// do NOC perguntando de 30 em 30s e maquina escrevendo o tempo todo, isso
// virou a maior fatia da conta de leitura - e piorava a cada computador
// novo instalado, porque o preco da releitura e o parque inteiro.
//
// Estes caminhos ja SABEM o que escreveram e em qual documento. Entao em
// vez de jogar o espelho fora, aplicam o mesmo patch nele e seguem: zero
// leitura no Firestore, e o espelho continua valendo pros outros 51.
//
// Quem NAO usa isto (de proposito): cadastrar/editar/remover/mover
// computador. Essas mudam a FORMA do parque (documento entra ou sai), sao
// raras - algumas vezes por semana - e ali reler tudo e o certo.
// ---------------------------------------------------------------------
function aplicarNoEspelho(id, patch) {
  // sem espelho carregado ainda nao ha o que atualizar - a proxima leitura
  // ja vai buscar tudo do banco de qualquer jeito
  if (!espelho) return;
  const atual = espelho.get(id);
  if (!atual) {
    // documento que o espelho ainda nao conhece (maquina que acabou de
    // aparecer): ai sim precisa reler, pra nao inventar um registro pela
    // metade a partir de um patch parcial
    invalidarEspelho();
    return;
  }
  espelho.set(id, { ...atual, ...patch });
}

// o par certo pra quem chamava cache.invalidar() depois de escrever UM
// documento conhecido: atualiza o espelho na memoria e derruba so a lista
// derivada (que e recalculada a partir do espelho, sem tocar no Firestore)
function espelharEscrita(id, patch) {
  aplicarNoEspelho(id, patch);
  cacheBase.invalidar();
}

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
// coleta da serie de 5 minutos - desligada por padrao (ver metricasDeRede)
const REDE_5MIN_LIGADA = process.env.NOC_REDE_5MIN === '1';

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
    // CAMADA DE 5 MIN: DESLIGADA (23/08/2026). Era o maior array dentro de
    // cada documento do NOC - e o documento inteiro e lido toda vez que o
    // espelho recarrega, entao ela pesava em leitura, escrita e trafego,
    // 24h por dia, multiplicada por computador. Na pratica ninguem usava a
    // janela de 60 minutos: quem investiga rede olha 24h ou 7 dias.
    // A serie por HORA (redeHoras) continua, e e ela que responde "as duas
    // lojas ficaram lentas ao mesmo tempo?".
    // Pra religar: NOC_REDE_5MIN=1 (e devolver o botao "60 min" em
    // noc-rede.html, ver PERIODOS la).
    if (REDE_5MIN_LIGADA) {
      campos.redeMinutos = redeDiagnostico.acumularMinuto(
        (atual && atual.redeMinutos) || [], amostra, Date.now(),
      );
    } else if (atual && atual.redeMinutos !== undefined) {
      // limpeza do que ja esta gravado: sem isso o array antigo ficaria
      // pendurado pra sempre em cada documento, continuando a custar
      // leitura e trafego mesmo com a coleta desligada
      campos.redeMinutos = null;
    }
  }
  return campos;
}

// De quanto em quanto tempo uma batida "sem novidade" ainda assim vira
// gravacao. Serve so pra sobreviver a um restart: enquanto o processo vive,
// quem responde online/offline e o espelho em memoria. Menor que o TTL do
// espelho (10min) de proposito - assim uma recarga nunca acha um documento
// mais velho que uma gravacao pendente.
const PERSIST_MS = Number(process.env.LOJA_STATUS_PERSIST_MS) >= 0
  ? Number(process.env.LOJA_STATUS_PERSIST_MS)
  : 5 * 60 * 1000;
const ultimaGravacaoEm = new Map(); // docId -> quando foi gravado de verdade

// Depois de um restart, o ultimoHeartbeatEm gravado pode estar ate PERSIST_MS
// atrasado - e a varredura anunciaria queda de maquina que nunca parou. Este
// e o tempo que damos pra cada maquina viva bater pelo menos uma vez (a
// batida e a cada 20-25s) antes de confiar no que veio do banco.
const CARENCIA_POS_BOOT_MS = Number(process.env.LOJA_STATUS_CARENCIA_BOOT_MS) >= 0
  ? Number(process.env.LOJA_STATUS_CARENCIA_BOOT_MS)
  : 2 * 60 * 1000;
const processoIniciadoEm = Date.now();

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

  // ---- boot e link físico (NOCZenith v16+). Máquina com agente antigo não
  // manda nada disso: os campos ficam como estavam, e o painel mostra
  // "sem dado" em vez de inventar.
  const bootEm = Number(dados.bootEm) > 0 ? Number(dados.bootEm) : null;
  const linkNovo = sanitizarLink(dados.link);
  const linkAntes = (atual && atual.link) || null;
  let eventosNovos = [];
  if (bootEm) {
    patch.bootEm = bootEm;
    if (reiniciouDesde(atual && atual.bootEm, bootEm)) {
      // desligamentoInesperado vem do log de eventos do Windows (6008) e é
      // o que separa "reiniciaram a máquina" de "faltou luz / travou"
      patch.reinicioAvisoPendente = {
        em: bootEm,
        inesperado: !!dados.desligamentoInesperado,
      };
      eventosNovos.push({
        tipo: 'reiniciou', em: Date.now(), bootEm,
        inesperado: !!dados.desligamentoInesperado,
      });
    }
  }
  if (dados.desligamentoInesperado !== undefined) patch.desligamentoInesperado = !!dados.desligamentoInesperado;
  if (linkNovo) {
    patch.link = linkNovo;
    patch.linkEm = Date.now();
    if (!mesmoLink(linkAntes, linkNovo)) {
      eventosNovos.push({
        tipo: 'link', em: Date.now(),
        de: linkAntes ? linkAntes.tipo : null, para: linkNovo.tipo,
        ethernetCaida: linkNovo.ethernetCaida, mbps: linkNovo.mbps,
      });
      // só vira ALERTA quando piora: cair a Ethernet, ou trocar de cabo pra
      // Wi-Fi. Voltar pro cabo é boa notícia e entra no registro sem push.
      const piorou = (linkNovo.ethernetCaida && !(linkAntes && linkAntes.ethernetCaida))
        || (linkNovo.tipo === 'wifi' && linkAntes && linkAntes.tipo === 'ethernet');
      if (piorou) patch.linkAvisoPendente = { tipo: linkNovo.tipo, ethernetCaida: linkNovo.ethernetCaida, mbps: linkNovo.mbps };
    }
  }
  if (eventosNovos.length) {
    patch.eventos = [...((atual && atual.eventos) || []), ...eventosNovos].slice(-EVENTOS_MAX);
  }
  // so limpa a mensagem quando havia uma pra entregar. Zerar o campo em toda
  // batida abria uma janela pra perder mensagem: se enviarMensagem() gravasse
  // entre a leitura e esta escrita, o null apagava a mensagem que nunca
  // chegou a ser mostrada.
  if (mensagemPendente) patch.mensagemPendente = null;

  // IP publico mudou (ou apareceu pela primeira vez): entra no historico. A
  // mudanca de ip ja forca gravacao imediata (ver mudouAlgoQueImporta), entao
  // o historico nunca fica so na memoria - por isso nao precisa entrar em
  // CAMPOS_DO_HEARTBEAT.
  if (patch.ip && patch.ip !== ((atual && atual.ip) || null)) {
    patch.ipHistorico = comMudancaDeIp(atual && atual.ipHistorico, 'publico', atual && atual.ip, patch.ip);
  }

  // ---- decide se ESTA batida vira gravacao no Firestore ----
  // A leitura ja tinha sido resolvida (espelho em memoria); a ESCRITA nao.
  // Gravar toda batida dava, com ~40 maquinas a cada 25s, ~138 mil escritas
  // POR DIA (4,1 milhoes/mes) pra registrar, na esmagadora maioria das
  // vezes, so "continuo vivo". Escrita no Firestore custa 3x uma leitura -
  // era esse o gasto.
  //
  // Agora a memoria e atualizada SEMPRE (de graca) e o banco so recebe
  // quando ha o que contar: mudou algo que outra parte do sistema le, ou
  // passou tempo demais desde a ultima gravacao (pra um restart nao perder
  // o rastro). Quem decide online/offline e o espelho, entao espacar a
  // gravacao nao atrasa a deteccao de queda enquanto o processo vive.
  const anterior = atual || {};
  const mudouAlgoQueImporta = mensagemPendente
    || !anterior.ultimoHeartbeatEm            // primeira batida deste posto
    || patch.ip !== anterior.ip
    || patch.userAgent !== anterior.userAgent
    || patch.abertoDesde !== anterior.abertoDesde
    || patch.redeHistorico !== undefined      // virada de dia da rede
    // reinício e mudança de link são eventos: não podem esperar o
    // PERSIST_MS, senão um restart do servidor apagaria o rastro
    || eventosNovos.length > 0;
  const desdeUltimaGravacao = Date.now() - (ultimaGravacaoEm.get(id) || 0);
  const precisaPersistir = mudouAlgoQueImporta || desdeUltimaGravacao >= PERSIST_MS;

  if (precisaPersistir) {
    await ref.set(patch, { merge: true });
    ultimaGravacaoEm.set(id, Date.now());
  }
  // O heartbeat de propósito NÃO invalida o cache de listar() - fazer isso a
  // cada 25s por máquina multiplicaria as leituras à toa (ver o comentário
  // no fim desta função). Mas quando ele grava um EVENTO (queda de Ethernet,
  // reinício), o painel precisa mostrar na hora: são justamente os dois
  // casos em que o operador está olhando a tela esperando a mudança
  // aparecer. Raro por natureza, então não recria o custo que a decisão
  // original evitou.
  // mantem o espelho em dia sem reler: o heartbeat sabe exatamente o que
  // acabou de gravar (ou o que gravaria). É isso que faz a proxima batida
  // nao custar leitura - e agora, na maioria das vezes, nem escrita.
  memoria.set(id, { ...anterior, ...patch });
  // Evento novo (queda de Ethernet, reinício) tem que aparecer no painel na
  // hora. ANTES isso era cache.invalidar(), que derruba o espelho junto - e
  // o espelho é a coleção INTEIRA: um evento numa máquina obrigava a próxima
  // leitura a reler as 52. Como o espelho acabou de ser atualizado na linha
  // acima com o que esta batida gravou, basta derrubar a LISTA derivada:
  // ela é recalculada a partir da memória, sem tocar no Firestore.
  if (eventosNovos.length) cacheBase.invalidar();
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

// motivos que rebaixam uma máquina VIVA pra 'degradado'. Lista, não
// booleano: o painel mostra o porquê, que é o que decide a ação.
function motivosDeDegradacao(doc) {
  const motivos = [];
  const link = doc.link || null;
  if (link && link.ethernetCaida) motivos.push('Ethernet caída');
  if (link && link.tipo === 'wifi' && !link.ethernetCaida) motivos.push('só no Wi-Fi');
  if (doc.discoNivel === 'critico') motivos.push('disco crítico');
  else if (doc.discoNivel === 'atencao') motivos.push('disco em atenção');
  return motivos;
}

function estadoDe(doc) {
  // nunca bateu na vida = NOCZenith não instalado. Isto NÃO é queda: pintar
  // de vermelho junto com queda real foi o que fez o Master procurar
  // problema de rede numa máquina que nunca teve agente.
  if (!doc.ultimoHeartbeatEm) return ESTADOS.SEM_AGENTE;
  const online = (Date.now() - doc.ultimoHeartbeatEm) < LIMIAR_OFFLINE_MS;
  if (!online) return ESTADOS.INDISPONIVEL;
  return motivosDeDegradacao(doc).length ? ESTADOS.DEGRADADO : ESTADOS.OPERACIONAL;
}

function comOnline(doc) {
  const online = !!doc.ultimoHeartbeatEm && (Date.now() - doc.ultimoHeartbeatEm) < LIMIAR_OFFLINE_MS;
  // 'online' continua saindo igual (várias telas e rotas leem esse campo);
  // 'estado'/'degradacao' são a leitura nova, mais fina
  return { ...doc, online, estado: estadoDe(doc), degradacao: online ? motivosDeDegradacao(doc) : [] };
}

// lista achatada, 1 item por computador (varios por unidade) - quem chama
// (index.js/loja-status.html) agrupa por codigo pra exibir por unidade
async function listar() {
  const [docs, apelidos, tipos] = await Promise.all([cache.cached(), getApelidos(), listarTiposDispositivo()]);
  return docs.map(comOnline).map(semSegredo).map((d) => {
    // apelido é por UNIDADE, não por computador: se dois computadores da loja
    // enxergam a mesma impressora, ela tem o mesmo nome nos dois
    const daUnidade = apelidos[d.codigo] || {};
    if (!d.dispositivos || !d.dispositivos.length) return d;
    // fabricante resolvido na hora pelo prefixo do MAC (ver ouiFabricantes) -
    // nao e gravado no doc de proposito: a tabela pode ser atualizada e o
    // dado ja existente ganha o nome novo sem migracao nenhuma
    return {
      ...d,
      dispositivos: d.dispositivos.map((x) => {
        const cfg = normalizarEntradaApelido(daUnidade[x.mac]);
        return {
          ...x,
          apelido: cfg.apelido, tipo: cfg.tipo, tipoRotulo: rotuloDoTipoDispositivo(cfg.tipo, tipos),
          monitorar: cfg.monitorar, fabricante: ouiFabricantes.fabricanteDe(x.mac),
        };
      }),
    };
  });
}

// Campos pesados que so o DETALHE de um computador usa (modal do NOC):
// historicos, listas e saidas longas de comando. A lista geral viajava com
// tudo isso pra TODAS as ~dezenas de maquinas a cada poll de 30s do painel -
// era a maior fatia da banda do servico (a que estourou os 5 GB do Render em
// 20/08). O painel agora recebe o resumo e busca o detalhe so da maquina
// cujo modal esta aberto (ver GET .../detalhe em index.js).
const CAMPOS_SO_DO_DETALHE = [
  'eventos', 'ipHistorico', 'chatMensagens', 'dispositivos',
  'redeDia', 'redeHoras', 'redeMinutos', 'redeHistorico',
  'ultimoComandoTexto', 'ultimoComandoResultado', 'ultimoComandoErro',
];
function resumoDe(doc) {
  const copia = { ...doc };
  CAMPOS_SO_DO_DETALHE.forEach((campo) => { delete copia[campo]; });
  return copia;
}
async function listarResumo() {
  return (await listar()).map(resumoDe);
}

// detalhe completo de UM computador, com o mesmo enriquecimento (online,
// apelidos, fabricante) da listar() - sai do mesmo cache, sem leitura extra
async function detalhar(codigo, posto) {
  const alvo = docIdFor(codigo, posto);
  return (await listar()).find((d) => docIdFor(d.codigo, d.posto) === alvo) || null;
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
async function editarComputador(codigo, posto, nome, tipo, ehNotebook) {
  const nomeOk = String(nome || '').trim().slice(0, 60);
  if (!nomeOk) throw new Error('Dê um nome pro computador.');
  const id = docIdFor(codigo, posto);
  const snap = await COLLECTION.doc(id).get();
  if (!snap.exists) throw new Error('Computador não encontrado.');
  // notebook hiberna/dorme fora de hora - a "queda" dele aparece no painel,
  // mas nunca vira push crítico (ver rodarVarreduraLojaStatus em index.js)
  const registro = { nome: nomeOk, tipo: tipoValido(tipo), ehNotebook: !!ehNotebook };
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
  const patchAnydesk = { codigo, posto, anydeskId: limpo || null };
  await COLLECTION.doc(id).set(patchAnydesk, { merge: true });
  espelharEscrita(id, patchAnydesk);
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
  const atual = snap.exists ? snap.data() : null;
  exigirTokenSeTiver(atual, token);
  const patch = { codigo, posto, ipLocal: limpo, ipLocalEm: Date.now() };
  // IP local mudou: entra no mesmo historico do IP publico (tipo 'local')
  if (limpo !== ((atual && atual.ipLocal) || null)) {
    patch.ipHistorico = comMudancaDeIp(atual && atual.ipHistorico, 'local', atual && atual.ipLocal, limpo);
  }
  await COLLECTION.doc(id).set(patch, { merge: true });
  espelharEscrita(id, patch);
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

  // boot e link também chegam por aqui, e não só pelo heartbeat. Motivo:
  // em computador tipo 'atendimento'/'abastecimento' quem bate o heartbeat
  // é o NAVEGADOR, não o NOCZenith - então o único canal que o agente tem
  // pra contar que a Ethernet caiu ou que a máquina reiniciou é a
  // telemetria. Cadência menor (~1h) que no 'interno' (~100s), mas cobre a
  // frota inteira em vez de uma fatia dela.
  const bootTelemetria = Number(dados && dados.bootEm) > 0 ? Number(dados.bootEm) : null;
  if (bootTelemetria) {
    patch.bootEm = bootTelemetria;
    if (reiniciouDesde(atual.bootEm, bootTelemetria)) {
      patch.reinicioAvisoPendente = { em: bootTelemetria, inesperado: !!(dados && dados.desligamentoInesperado) };
      eventos = [...eventos, { tipo: 'reiniciou', em: agora, bootEm: bootTelemetria, inesperado: !!(dados && dados.desligamentoInesperado) }];
      patch.eventos = eventos.slice(-EVENTOS_MAX);
    }
  }
  const linkTelemetria = sanitizarLink(dados && dados.link);
  if (linkTelemetria) {
    patch.link = linkTelemetria;
    patch.linkEm = agora;
    if (!mesmoLink(atual.link, linkTelemetria)) {
      eventos = [...eventos, {
        tipo: 'link', em: agora,
        de: atual.link ? atual.link.tipo : null, para: linkTelemetria.tipo,
        ethernetCaida: linkTelemetria.ethernetCaida, mbps: linkTelemetria.mbps,
      }];
      patch.eventos = eventos.slice(-EVENTOS_MAX);
      const piorou = (linkTelemetria.ethernetCaida && !(atual.link && atual.link.ethernetCaida))
        || (linkTelemetria.tipo === 'wifi' && atual.link && atual.link.tipo === 'ethernet');
      if (piorou) patch.linkAvisoPendente = { tipo: linkTelemetria.tipo, ethernetCaida: linkTelemetria.ethernetCaida, mbps: linkTelemetria.mbps };
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
    // a lista guardada acumula histórico: quem veio agora fica `ativo`, quem
    // não veio continua listado com a última vez que apareceu. É o que dá
    // STATUS por aparelho em vez de só uma contagem
    const merge = nocMaquina.mesclarDispositivos(atual.dispositivos || atual.dispositivosConhecidos, dispositivos, agora);
    patch.dispositivos = merge.dispositivos;
    patch.dispositivosEm = agora;
    // campo do formato antigo (só MACs): some depois da primeira mesclagem
    if (atual.dispositivosConhecidos) patch.dispositivosConhecidos = null;
    if (merge.novos.length) {
      const resumo = merge.novos.slice(0, 5).map((d) => `${d.nome || d.ip} (${d.mac})`).join(', ');
      eventos = [...eventos, { tipo: 'dispositivo-novo', em: agora, detalhe: `${merge.novos.length} novo(s) na rede: ${resumo}`.slice(0, 200) }];
      patch.eventos = eventos.slice(-EVENTOS_MAX);
    }
  }

  if (!Object.keys(patch).length) return { ok: false, motivo: 'nada útil na telemetria' };
  await COLLECTION.doc(id).set(patch, { merge: true });
  espelharEscrita(id, patch);
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
  espelharEscrita(id, patch);
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

// REINICIAR a máquina. Fixo no código pelo mesmo motivo dos outros: uma
// rota que aceitasse texto livre seria "rodar qualquer coisa em toda a
// rede". O /t 120 não é enfeite - dá 2 minutos de aviso NA TELA DA LOJA
// antes de reiniciar, tempo pra quem está no caixa fechar o que estiver
// aberto e pro NOC abortar se disparou no alvo errado (ver
// COMANDO_ABORTAR_REINICIO). Com /t > 0 o Windows já força o fechamento no
// fim da contagem, então /f seria redundante.
const COMANDO_REINICIAR = [
  'shutdown /r /t 120 /c "NoPulso NOC: manutencao programada. O computador vai reiniciar em 2 minutos. Salve o que estiver aberto."',
  '"Reinicio agendado para daqui a 2 minutos."',
].join('\n');

// janela de arrependimento: cancela um reinício que ainda está na contagem
const COMANDO_ABORTAR_REINICIO = [
  'try { shutdown /a; "Reinicio abortado." } catch { "Nao havia reinicio em contagem." }',
].join('\n');

// Dispara um comando fixo numa LISTA de alvos escolhida pelo painel (1
// máquina, uma unidade inteira, ou várias unidades de uma vez). Mesma
// mecânica do enfileirarComandoEmTodos - e em paralelo pelo mesmo motivo:
// em série, algumas dezenas de máquinas estouravam o tempo do navegador e
// metade da frota ficava sem o comando.
// Quanto tempo uma máquina pode ficar fora depois de NÓS mandarmos
// reiniciar antes de virar problema de verdade. 2 min de aviso na tela +
// desligar + subir o Windows + o agente subir e bater: 8 min é folgado pra
// uma máquina saudável e curto o bastante pra não esconder uma que não
// voltou.
const JANELA_REINICIO_MS = 8 * 60 * 1000;

// O NOC sabe quando ele mesmo mandou reiniciar - e usar isso muda o que o
// alerta diz. Antes, a máquina sumia e o push mandava "verifique a
// internet/computador da loja" mesmo tendo sido o próprio NOC quem pediu o
// reinício: afirmava como causa justamente o que a gente sabia ser falso.
async function marcarReinicioComandado(codigo, posto) {
  await COLLECTION.doc(docIdFor(codigo, posto)).set({
    reinicioComandadoEm: Date.now(), reinicioNaoVoltouAvisado: false,
  }, { merge: true });
  invalidarEspelho();
  cache.invalidar();
}

async function enfileirarComandoEmAlvos(alvos, comando, opcoes) {
  const docs = await listUncached();
  const querido = new Set((alvos || []).map((a) => `${a.codigo}|${a.posto}`));
  const escolhidos = docs.filter((d) => d.tipo === 'interno' && querido.has(`${d.codigo}|${d.posto}`));
  const resultados = await Promise.all(escolhidos.map(async (doc) => {
    const base = { codigo: doc.codigo, posto: doc.posto, nome: doc.nome };
    try {
      await enfileirarComando(doc.codigo, doc.posto, comando, opcoes);
      if ((opcoes || {}).origem === 'manutencao-reiniciar') await marcarReinicioComandado(doc.codigo, doc.posto);
      return { ...base, ok: true };
    } catch (err) {
      const jaTinha = /comando pendente/i.test(err.message || '');
      return { ...base, ok: jaTinha, jaTinha, motivo: jaTinha ? null : err.message };
    }
  }));
  // alvo pedido que não existe (ou não é 'interno') volta como recusado, em
  // vez de sumir em silêncio - senão o painel diz "10 de 10" tendo mandado 7
  const naoElegiveis = (alvos || [])
    .filter((a) => !escolhidos.some((d) => d.codigo === a.codigo && d.posto === a.posto))
    .map((a) => ({ ...a, ok: false, motivo: 'não é um computador interno com NOCZenith' }));
  return [...resultados, ...naoElegiveis];
}

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

// ---------------------------------------------------------------------
// IP DA IMPRESSORA NO COMANDO
//
// Cada loja tem a impressora num IP diferente, e so as Dominos tem Zebra -
// entao cravar o IP no comando obrigaria uma acao cadastrada POR LOJA, e
// deixaria a acao rodar no vazio numa loja que nem impressora tem.
//
// O comando cadastrado guarda {{IP_IMPRESSORA}}, e aqui isso vira o IP do
// dispositivo que o Master marcou como tipo 'impressora' NAQUELA unidade
// (ver definirApelidoDispositivo). Uma acao so, servindo as 14.
//
// Unidade sem impressora marcada NAO roda: recusa dizendo o porque, em vez
// de disparar um comando que ia falhar de um jeito silencioso na loja.
const PLACEHOLDER_IP_IMPRESSORA = '{{IP_IMPRESSORA}}';

async function resolverIpImpressora(codigo, posto) {
  const [docs, apelidos] = await Promise.all([cache.cached(), getApelidos()]);
  const daUnidade = apelidos[codigo] || {};
  const macsImpressora = new Set(
    Object.keys(daUnidade).filter((mac) => normalizarEntradaApelido(daUnidade[mac]).tipo === 'impressora')
  );
  if (!macsImpressora.size) {
    throw new Error('Nenhum dispositivo dessa unidade esta marcado como impressora. Abra o Status das Lojas, clique no ✏️ da impressora e marque o tipo antes de rodar essa acao.');
  }
  // procura primeiro na lista do PROPRIO computador que vai rodar: e a rede
  // dele que precisa alcancar a impressora. So depois cai pros outros
  // computadores da mesma unidade (mesma LAN, e a varredura ARP de um pode
  // ter pego o que a do outro perdeu).
  const daMaquina = docs.filter((d) => d.codigo === codigo && d.posto === posto);
  const outros = docs.filter((d) => d.codigo === codigo && d.posto !== posto);
  for (const d of [...daMaquina, ...outros]) {
    for (const disp of d.dispositivos || []) {
      if (macsImpressora.has(disp.mac) && disp.ip) return disp.ip;
    }
  }
  throw new Error('A impressora dessa unidade esta marcada, mas nenhum computador da loja viu o IP dela na ultima varredura de rede. Confira se ela esta ligada na rede.');
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
  // troca o placeholder ANTES de gravar: o que fica registrado (e o que o
  // Master ve no historico) e o comando de verdade que a maquina rodou
  const comandoFinal = comando.includes(PLACEHOLDER_IP_IMPRESSORA)
    ? comando.split(PLACEHOLDER_IP_IMPRESSORA).join(await resolverIpImpressora(codigo, posto))
    : comando;
  const comandoRef = COMANDOS_COLLECTION.doc();
  const registro = {
    id: comandoRef.id, codigo, posto, comando: comandoFinal,
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
  // ordena por 'em' ANTES de cortar: a thread ja apareceu fora de ordem no
  // painel (bolha de 09:56 embaixo da de 09:58), porque a ordem do array era
  // a ordem de chegada da escrita, nao a do relogio. Duas escritas
  // concorrentes (Master enviando enquanto a maquina responde) bastam pra
  // inverter. Ordenar aqui conserta o que ja esta gravado tambem, porque a
  // proxima mensagem reordena a thread inteira
  const thread = [...((atual && atual.chatMensagens) || []), entrada]
    .sort((a, b) => (Number(a && a.em) || 0) - (Number(b && b.em) || 0))
    .slice(-CHAT_MAX_MENSAGENS);
  const patchChat = { codigo, posto, chatMensagens: thread };
  await COLLECTION.doc(id).set(patchChat, { merge: true });
  espelharEscrita(id, patchChat);
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
  espelharEscrita(id, { codigo, posto, mensagemPendente: { texto: textoLimpo, deEmail: deEmail || null, em: Date.now() } });
  // o espelho e' atualizado na linha acima (espelharEscrita), nao invalidado:
  // sem isso o heartbeat seguiria lendo o espelho antigo (sem a mensagem) e
  // ela nunca seria entregue - mas jogar a coleção inteira fora pra entregar
  // UMA mensagem era o que custava caro. O adicionarNoChat logo abaixo faz o
  // mesmo pela thread; os dois sao explicitos de proposito, pra ninguem
  // depender do efeito colateral do outro.
  await adicionarNoChat(codigo, posto, { de: 'master', texto: textoLimpo, deEmail: deEmail || null, em: Date.now() });
  return { codigo, posto, texto: textoLimpo };
}

// teto de destinos por envio. Nao e' limite de tela: cada destino custa 1
// leitura + 2 escritas no Firestore (ver enviarMensagem/adicionarNoChat), e
// um "manda pra todo mundo" sem teto vira conta cara sem ninguem perceber
const CHAT_MAX_DESTINOS = 60;

// mesma mensagem para varios computadores de uma vez - pedido do Master:
// avisar o parque inteiro (ou uma unidade) sem reabrir a janela computador a
// computador. Nao existe "thread coletiva": cada computador recebe a
// mensagem na SUA thread, exatamente como se tivesse sido enviada sozinha,
// entao o historico de cada maquina continua legivel do jeito que sempre foi
async function enviarMensagemMuitos(destinos, texto, deEmail) {
  const textoLimpo = String(texto || '').trim().slice(0, 500);
  if (!textoLimpo) throw new Error('Escreva a mensagem.');
  const vistos = new Set();
  const lista = [];
  for (const d of Array.isArray(destinos) ? destinos : []) {
    const codigo = d && d.codigo ? String(d.codigo) : '';
    const posto = d && d.posto ? String(d.posto) : '';
    if (!codigo || !posto) continue;
    const chave = `${codigo}|${posto}`;
    // o mesmo computador escolhido duas vezes geraria duas bolhas iguais na
    // thread dele - o Master ve isso como bug, nao como envio duplo
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    lista.push({ codigo, posto });
  }
  if (!lista.length) throw new Error('Escolha pelo menos um computador.');
  if (lista.length > CHAT_MAX_DESTINOS) {
    throw new Error(`Escolha no maximo ${CHAT_MAX_DESTINOS} computadores por envio.`);
  }
  const enviados = [];
  const falhas = [];
  // sequencial de proposito: 60 enviarMensagem em paralelo e' pico de
  // escrita no Firestore sem ganho nenhum pra quem esta olhando o modal
  for (const alvo of lista) {
    try {
      await enviarMensagem(alvo.codigo, alvo.posto, textoLimpo, deEmail);
      enviados.push(alvo);
    } catch (err) {
      falhas.push({ ...alvo, erro: err.message });
    }
  }
  // falha parcial NAO derruba o envio: quem recebeu, recebeu. So quando
  // ninguem recebeu e' que vira erro, senao o painel diria "erro" depois de
  // ter entregue a mensagem em 59 dos 60 computadores
  if (!enviados.length) throw new Error(falhas.length ? falhas[0].erro : 'Nenhuma mensagem enviada.');
  return { texto: textoLimpo, enviados, falhas };
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
// Celular navegando não é máquina de loja. Num posto 'interno', a batida
// certa vem do computador de verdade (navegador desktop) ou do vigia
// ("NOCZenith/1.0 (Windows NT; PowerShell)") - se a ÚLTIMA batida veio de um
// navegador de CELULAR, foi alguém abrindo o NoPulso no telefone com o
// monitoramento fixo gravado, e a "queda" é só a pessoa fechando o navegador
// ou bloqueando a tela. Registra o evento normalmente (fica no histórico do
// NOC), mas a transição sai marcada pra NÃO virar push de "Loja sem conexão".
// A tela de login (index.html) também parou de mandar heartbeat de celular,
// mas isso só vale depois que cada aparelho recarregar a página - este filtro
// cobre a janela e qualquer celular antigo com a página em cache.
function ehCelular(userAgent) {
  return /Android|iPhone|iPod|IEMobile|Opera Mini|Mobile/i.test(String(userAgent || ''));
}
function quedaDeCelular(doc) {
  return doc.tipo === 'interno' && ehCelular(doc.userAgent);
}

// grava um patch num computador E aplica o mesmo patch no espelho.
//
// POR QUE (custo): a varredura monta a lista de candidatos a partir do
// espelho e, quando decidia "esta caida", gravava avisadoOffline:true SO no
// Firestore. O espelho seguia sem o campo - entao no minuto seguinte a
// mesma maquina aparecia como "caida e ainda nao avisada" de novo, e o
// codigo relia o documento dela pra confirmar. De novo. E de novo. Uma
// maquina fora do ar custava uma leitura + uma escrita POR MINUTO, pra
// sempre. Com 22 maquinas fora (o cenario real de 23/08), isso sozinho dava
// ~32 mil leituras e ~32 mil escritas por dia sem servir pra nada.
async function gravarEEspelhar(codigo, posto, patch) {
  const id = docIdFor(codigo, posto);
  await COLLECTION.doc(id).update(patch);
  aplicarNoEspelho(id, patch);
  cacheBase.invalidar();
}

async function varrerAlertas() {
  const docs = await listUncached();
  const apelidosTodos = await getApelidos();
  const tiposDispositivo = await listarTiposDispositivo();
  const transicoes = [];
  for (const candidato of docs) {
    // dispositivo de rede marcado como MONITORADO (impressora/VM - pedido do
    // Master: "perdeu rede, precisa alarmar"). Reaproveita a varredura ARP
    // passiva que ja existe (Varrer-RedeLocal -> mesclarDispositivos) - so
    // acrescenta o alarme por cima de quem foi marcado explicitamente pela
    // tela, nunca por padrao (ver definirApelidoDispositivo).
    if (candidato.dispositivos && candidato.dispositivos.length) {
      const daUnidade = apelidosTodos[candidato.codigo] || {};
      const alarmeAtual = candidato.dispositivosAlarme || {};
      let alarmePatch = null;
      for (const disp of candidato.dispositivos) {
        const cfg = normalizarEntradaApelido(daUnidade[disp.mac]);
        if (!cfg.monitorar) continue;
        const estado = alarmeAtual[disp.mac] || null;
        const semVerHaMs = Date.now() - (disp.visto || 0);
        if (!disp.ativo && semVerHaMs >= DISPOSITIVO_OFFLINE_LIMIAR_MS && !(estado && estado.avisadoOffline)) {
          alarmePatch = { ...(alarmePatch || alarmeAtual), [disp.mac]: { avisadoOffline: true, offlineDesde: disp.visto } };
          transicoes.push({
            codigo: candidato.codigo, posto: candidato.posto, nome: candidato.nome,
            tipo: 'dispositivo-offline', mac: disp.mac,
            apelido: cfg.apelido, tipoDispositivo: cfg.tipo,
            tipoRotulo: rotuloDoTipoDispositivo(cfg.tipo, tiposDispositivo),
          });
        } else if (disp.ativo && estado && estado.avisadoOffline) {
          alarmePatch = { ...(alarmePatch || alarmeAtual), [disp.mac]: { avisadoOffline: false, offlineDesde: null } };
          transicoes.push({
            codigo: candidato.codigo, posto: candidato.posto, nome: candidato.nome,
            tipo: 'dispositivo-online', mac: disp.mac,
            apelido: cfg.apelido, tipoDispositivo: cfg.tipo,
            tipoRotulo: rotuloDoTipoDispositivo(cfg.tipo, tiposDispositivo),
          });
        }
      }
      if (alarmePatch) await gravarEEspelhar(candidato.codigo, candidato.posto, { dispositivosAlarme: alarmePatch });
    }
    // alerta de HD: quem detecta e a telemetria do agente (registrarTelemetria),
    // que so marca a flag; quem avisa e aqui, junto com o resto - assim o push
    // sai de UM lugar so e uma falha de push nunca derruba o caminho do agente
    if (candidato.discoAlertaPendente) {
      await gravarEEspelhar(candidato.codigo, candidato.posto, { discoAlertaPendente: null });
      transicoes.push({
        codigo: candidato.codigo, posto: candidato.posto, nome: candidato.nome,
        tipo: 'disco', nivel: candidato.discoAlertaPendente,
        motivos: candidato.discoMotivos || [],
      });
    }
    // máquina reiniciou/desligou (pedido do Master: "se ele foi reiniciado
    // ou desligado esse deve ser os alertas"). Quem detecta é o heartbeat,
    // comparando o LastBootUpTime; aqui é só o aviso, junto com o resto.
    if (candidato.reinicioAvisoPendente) {
      await gravarEEspelhar(candidato.codigo, candidato.posto, { reinicioAvisoPendente: null });
      transicoes.push({
        codigo: candidato.codigo, posto: candidato.posto, nome: candidato.nome,
        tipo: 'reiniciou',
        inesperado: !!candidato.reinicioAvisoPendente.inesperado,
        bootEm: candidato.reinicioAvisoPendente.em,
      });
    }
    // caiu a Ethernet (ou trocou cabo por Wi-Fi) SEM a máquina sair do ar
    if (candidato.linkAvisoPendente) {
      await gravarEEspelhar(candidato.codigo, candidato.posto, { linkAvisoPendente: null });
      transicoes.push({
        codigo: candidato.codigo, posto: candidato.posto, nome: candidato.nome,
        tipo: 'link',
        linkTipo: candidato.linkAvisoPendente.tipo,
        ethernetCaida: !!candidato.linkAvisoPendente.ethernetCaida,
        mbps: candidato.linkAvisoPendente.mbps || null,
      });
    }
    // passou de mais uma semana sem reiniciar (ver UPTIME_REINICIAR_DIAS)
    if (candidato.reinicioAlertaPendente) {
      await gravarEEspelhar(candidato.codigo, candidato.posto, { reinicioAlertaPendente: null });
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
      // MAX, nao substituicao: a memoria e sempre igual ou mais NOVA que o
      // banco (o heartbeat grava espacado, ver PERSIST_MS), entao trocar uma
      // pela outra rebobinaria o relogio e inventaria queda. O get() aqui
      // serve pra enxergar batida recebida por OUTRA instancia - some com
      // a memoria, nao a sobrescreve.
      doc = { ...snap.data(), ultimoHeartbeatEm: Math.max(candidato.ultimoHeartbeatEm || 0, snap.data().ultimoHeartbeatEm || 0) };
      if (espelho) espelho.set(docIdFor(doc.codigo, doc.posto), doc);
      if (!doc.ultimoHeartbeatEm) continue;
    }
    const online = (Date.now() - doc.ultimoHeartbeatEm) < LIMIAR_OFFLINE_MS;
    // logo depois de subir, "offline" pode ser so um timestamp gravado antes
    // do restart - nao uma queda. So vale pra maquina cuja ultima batida
    // CONHECIDA e anterior ao boot: se ela ja bateu neste processo e parou,
    // isso e queda de verdade e vai pro alerta na hora. Maquina viva bate em
    // ate 25s e se corrige sozinha dentro da carencia; maquina caida continua
    // caida e e avisada no tick seguinte.
    if (!online && doc.ultimoHeartbeatEm < processoIniciadoEm
        && (Date.now() - processoIniciadoEm) < CARENCIA_POS_BOOT_MS) continue;
    if (!online && !doc.avisadoOffline) {
      // 'em' = ultimo heartbeat real (quando de fato silenciou), nao a hora da
      // deteccao - fica mais fiel no registro. ip/ipLocal sao um retrato de
      // QUANDO CAIU (pedido do Master: "qual era o IP quando perdeu conexao")
      // - se a maquina voltar com IP novo, o evento preserva o antigo mesmo
      // que o campo vivo do doc seja sobrescrito
      // foi o NOC que mandou reiniciar há pouco? Então isto NÃO é "loja sem
      // conexão" - é a máquina cumprindo o que a gente pediu. Dizer
      // "verifique a internet" aqui seria afirmar como causa justamente o
      // que o sistema sabe ser falso.
      const reiniciandoPorNos = !!doc.reinicioComandadoEm
        && (Date.now() - doc.reinicioComandadoEm) < JANELA_REINICIO_MS;
      const evento = {
        tipo: 'offline', em: doc.ultimoHeartbeatEm,
        ...(doc.ip ? { ip: doc.ip } : {}), ...(doc.ipLocal ? { ipLocal: doc.ipLocal } : {}),
        // por qual meio ela estava falando quando silenciou: é o que
        // separa "arrancaram o cabo" de "o provedor caiu" na hora de
        // olhar o registro depois
        ...(doc.link ? { link: doc.link.tipo } : {}),
        ...(reiniciandoPorNos ? { motivo: 'reinicio-comandado' } : {}),
      };
      // queda CONFIRMADA x oscilação: o painel acusa nas duas (esta
      // transição + evento no histórico), mas o push crítico (sonoro) só sai
      // com o silêncio já passado de CONFIRMACAO_QUEDA_MS. Se ainda não
      // passou, fica pendente e o tick seguinte decide (ver o ramo
      // 'offline-confirmada' abaixo). Reinício comandado não espera - a
      // causa é conhecida e o aviso dele nem é crítico.
      const confirmada = reiniciandoPorNos
        || (Date.now() - doc.ultimoHeartbeatEm) >= CONFIRMACAO_QUEDA_MS;
      await gravarEEspelhar(doc.codigo, doc.posto, {
        avisadoOffline: true,
        // offlineDesde = quando de fato SILENCIOU, nao a hora da deteccao.
        // A deteccao chega ate ~2,5min depois (limiar de 90s + tick de 1min),
        // e como o "ficou fora" abaixo mede a partir daqui, usar Date.now()
        // fazia o painel subnotificar toda queda nesse tanto - dava "7min"
        // numa parada real de 9min.
        offlineDesde: doc.ultimoHeartbeatEm,
        quedaPushPendente: !confirmada,
        eventos: [...(doc.eventos || []), evento].slice(-EVENTOS_MAX),
      });
      transicoes.push({
        codigo: doc.codigo, posto: doc.posto, nome: doc.nome, tipo: 'offline',
        celular: quedaDeCelular(doc), ehNotebook: !!doc.ehNotebook,
        reiniciando: reiniciandoPorNos, confirmada,
      });
    } else if (!online && doc.avisadoOffline && doc.quedaPushPendente
        && (Date.now() - (doc.offlineDesde || doc.ultimoHeartbeatEm)) >= CONFIRMACAO_QUEDA_MS) {
      // continuou fora depois da janela de oscilação: AGORA é queda de
      // verdade - o push crítico sai daqui, uma vez só
      await gravarEEspelhar(doc.codigo, doc.posto, { quedaPushPendente: false });
      transicoes.push({
        codigo: doc.codigo, posto: doc.posto, nome: doc.nome, tipo: 'offline-confirmada',
        celular: quedaDeCelular(doc), ehNotebook: !!doc.ehNotebook,
      });
    } else if (online && doc.avisadoOffline) {
      // no retorno o doc ja tem o IP NOVO (o heartbeat que provou que voltou
      // tambem gravou o ip) - junto com o retrato do evento 'offline', o
      // registro mostra se a maquina voltou com outro IP depois da queda
      const evento = {
        tipo: 'online', em: Date.now(), duracaoMs: doc.offlineDesde ? (Date.now() - doc.offlineDesde) : null,
        ...(doc.ip ? { ip: doc.ip } : {}), ...(doc.ipLocal ? { ipLocal: doc.ipLocal } : {}),
      };
      // voltou: a janela de reinício comandado se encerra aqui, tenha ela
      // sido usada ou não. Sem isso, uma queda de verdade horas depois
      // ainda seria contada como "estava reiniciando".
      const voltouDeReinicio = !!doc.reinicioComandadoEm;
      // voltou ANTES do push crítico sair = oscilação (caiu e voltou em
      // poucos minutos). Fica no histórico do painel como qualquer
      // queda/volta, mas nenhum push é disparado - nem o de "voltou",
      // senão o celular do Master apitava justamente pelo que pedimos
      // pra ignorar
      const quedaCurta = !!doc.quedaPushPendente;
      await gravarEEspelhar(doc.codigo, doc.posto, {
        avisadoOffline: false, offlineDesde: null, quedaPushPendente: false,
        reinicioComandadoEm: null, reinicioNaoVoltouAvisado: false,
        eventos: [...(doc.eventos || []), evento].slice(-EVENTOS_MAX),
      });
      transicoes.push({
        codigo: doc.codigo, posto: doc.posto, nome: doc.nome, tipo: 'online',
        celular: quedaDeCelular(doc), ehNotebook: !!doc.ehNotebook,
        voltouDeReinicio, quedaCurta,
      });
    } else if (!online && doc.reinicioComandadoEm && !doc.reinicioNaoVoltouAvisado
        && (Date.now() - doc.reinicioComandadoEm) >= JANELA_REINICIO_MS) {
      // mandamos reiniciar e ela não voltou na janela. ISSO é problema - e
      // é um alerta diferente do "caiu", porque aqui a gente sabe a causa
      // provável (o reinício não completou: travou no boot, desligou de
      // vez, ou perdeu a rede ao subir).
      await gravarEEspelhar(doc.codigo, doc.posto, { reinicioNaoVoltouAvisado: true });
      transicoes.push({
        codigo: doc.codigo, posto: doc.posto, nome: doc.nome, tipo: 'reinicio-nao-voltou',
        minutos: Math.round((Date.now() - doc.reinicioComandadoEm) / 60000),
      });
    }
  }
  if (transicoes.length) cache.invalidar();
  return transicoes;
}

// Saude da FROTA: discos com problema (pior primeiro) + quantos aparelhos
// cada loja enxerga na propria rede. Igual ao diagnosticoRede, sai do MESMO
// cache de listar() - nao gera leitura extra no Firestore.
// ---------------------------------------------------------------------
// QUANTAS VEZES CADA LOJA FICOU SEM CONEXAO, E POR QUANTO TEMPO.
//
// Pedido do Master, pra decidir com numero se vale fazer o app funcionar
// offline: "a queda e frequente ou foi um episodio?". A materia-prima ja
// existia - varrerAlertas grava um evento 'offline' quando a maquina
// silencia e um 'online' quando volta, com duracaoMs. So faltava somar.
//
// Nao custa leitura nova: le do espelho em memoria, como o resto da tela.
//
// Duas coisas que este relatorio NAO conta de proposito, porque contar
// inflaria o numero e levaria a decisao errada:
//
// 1. Reinicio que NOS mandamos (motivo 'reinicio-comandado' no evento de
//    queda). A maquina sumiu porque pedimos - nao e' problema de link.
// 2. Notebook (ehNotebook). Ele sai da loja e volta; "ficou fora" ali e'
//    alguem levando pra casa, nao internet caindo.
//
// O par e' feito na ORDEM dos eventos: guarda a queda aberta e fecha no
// 'online' seguinte. E' o que permite herdar o motivo da queda, que so
// existe no evento de abertura.
const QUEDAS_JANELA_PADRAO_DIAS = 30;

function quedasDeUmComputador(doc, desde) {
  const fora = [];
  let aberta = null;
  for (const ev of doc.eventos || []) {
    if (ev.tipo === 'offline') { aberta = ev; continue; }
    if (ev.tipo !== 'online') continue;
    const inicio = aberta ? aberta.em : (ev.em - (ev.duracaoMs || 0));
    const comandado = !!(aberta && aberta.motivo === 'reinicio-comandado');
    // por qual meio ela falava quando caiu (cabo/wifi) - so existe no evento
    // de ABERTURA, entao tem que sair daqui antes de zerar o par
    const link = (aberta && aberta.link) || null;
    aberta = null;
    if (!ev.duracaoMs || ev.em < desde) continue;
    fora.push({ inicio, fim: ev.em, ms: ev.duracaoMs, comandado, link });
  }
  // queda que comecou e ainda nao fechou: a loja pode estar fora AGORA
  const emAberto = aberta && aberta.em >= desde && aberta.motivo !== 'reinicio-comandado'
    ? { inicio: aberta.em, ms: Date.now() - aberta.em }
    : null;
  return { fora, emAberto };
}

async function relatorioQuedas(opcoes) {
  const dias = Math.max(1, Math.min(365, Number((opcoes || {}).dias) || QUEDAS_JANELA_PADRAO_DIAS));
  const desde = Date.now() - dias * 24 * 60 * 60 * 1000;
  const docs = (await cache.cached()).map(semSegredo);
  const porUnidade = new Map();
  for (const doc of docs) {
    if (doc.ehNotebook) continue;
    const { fora, emAberto } = quedasDeUmComputador(doc, desde);
    const reais = fora.filter((q) => !q.comandado);
    const u = porUnidade.get(doc.codigo) || {
      codigo: doc.codigo, computadores: 0, quedas: 0, foraMs: 0,
      maiorMs: 0, oscilacoes: 0, confirmadas: 0, foraAgora: 0,
    };
    u.computadores += 1;
    u.quedas += reais.length;
    u.foraMs += reais.reduce((s, q) => s + q.ms, 0);
    u.maiorMs = Math.max(u.maiorMs, ...reais.map((q) => q.ms), 0);
    // oscilacao x queda de verdade: e a MESMA regra que decide se o push
    // critico sai (CONFIRMACAO_QUEDA_MS). Separar importa: 30 piscadas de
    // 40s nao pedem app offline; 3 quedas de 2h pedem.
    u.oscilacoes += reais.filter((q) => q.ms < CONFIRMACAO_QUEDA_MS).length;
    u.confirmadas += reais.filter((q) => q.ms >= CONFIRMACAO_QUEDA_MS).length;
    if (emAberto) u.foraAgora += 1;
    porUnidade.set(doc.codigo, u);
  }
  const unidades = [...porUnidade.values()]
    .map((u) => ({ ...u, horasFora: +(u.foraMs / 3600000).toFixed(1), maiorMin: Math.round(u.maiorMs / 60000) }))
    .sort((a, b) => b.foraMs - a.foraMs);
  return {
    dias,
    // o historico por computador e' capado em EVENTOS_MAX: numa maquina que
    // oscila muito, queda antiga JA SAIU da lista. O numero e' piso, nao
    // teto - dizer isso na tela evita concluir "melhorou" de um corte.
    eventosMaximoPorComputador: EVENTOS_MAX,
    totalQuedas: unidades.reduce((s, u) => s + u.quedas, 0),
    totalConfirmadas: unidades.reduce((s, u) => s + u.confirmadas, 0),
    totalHorasFora: +(unidades.reduce((s, u) => s + u.foraMs, 0) / 3600000).toFixed(1),
    unidades,
  };
}

async function saudeMaquinas() {
  const docs = (await cache.cached()).map(comOnline).map(semSegredo);
  return {
    computadores: nocMaquina.panorama(docs),
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

// Grava o que ainda nao foi persistido das batidas (ver PERSIST_MS) - o
// Render manda SIGTERM antes de trocar a instancia num deploy, e sem isso
// a instancia nova subiria enxergando timestamps ate 5min velhos: pior que
// perder o dado, isso disparava alerta de queda em massa logo apos deploy.
async function flushHeartbeatsPendentes() {
  if (!espelho) return 0;
  const alvos = [];
  for (const [id, doc] of espelho) {
    if (!doc || !doc.ultimoHeartbeatEm) continue;
    if (doc.ultimoHeartbeatEm <= (ultimaGravacaoEm.get(id) || 0)) continue;
    // grava TODOS os campos do heartbeat, nao so o carimbo: as medicoes de
    // rede do dia (redeDia) tambem so existem em memoria entre uma gravacao
    // e outra, e sao o dado que o diagnostico de link usa
    const patch = {};
    CAMPOS_DO_HEARTBEAT.forEach((c) => { if (doc[c] !== undefined) patch[c] = doc[c]; });
    alvos.push([id, patch]);
  }
  if (!alvos.length) return 0;
  const r = await Promise.allSettled(alvos.map(([id, patch]) => COLLECTION.doc(id)
    .set(patch, { merge: true })));
  // so conta como gravado o que de fato foi: chamar duas vezes (SIGTERM
  // seguido de SIGINT, ou o teste) nao pode regravar o que ja passou, mas
  // tambem nao pode dar por gravado o que falhou
  r.forEach((x, i) => { if (x.status === 'fulfilled') ultimaGravacaoEm.set(alvos[i][0], Date.now()); });
  return r.filter((x) => x.status === 'fulfilled').length;
}

module.exports = {
  flushHeartbeatsPendentes,
  heartbeat, listar, listarResumo, detalhar, diagnosticoRede, cadastrarComputador, editarComputador, removerComputador, moverComputador,
  definirAnydeskId, enviarMensagem, enviarMensagemMuitos, varrerAlertas, atualizarIpLocal, TIPOS_COMPUTADOR, ehCelular,
  getConfig, setConfig, pushAcessoRemotoAtivo, definirApelidoDispositivo,
  listarTiposDispositivo, idDoTipoDispositivo, TIPOS_DISPOSITIVO_BASE,
  // SÓ pra testeRotas: DESCARTA o espelho em vez de só vencer a validade.
  // invalidarEspelho() de propósito guarda o mapa (o comentário lá explica:
  // é o que impede uma edição de nome derrubar um heartbeat ainda não
  // gravado). O teste precisa do contrário - escrever direto no Firestore
  // falso e ser levado a sério, inclusive pra ENVELHECER a última batida,
  // que é como se simula uma máquina que saiu do ar.
  descartarEspelhoTeste: () => { espelho = null; espelhoEm = 0; cache.invalidar(); },
  enfileirarComando, enfileirarComandoEmTodos, enfileirarComandoEmAlvos,
  PLACEHOLDER_IP_IMPRESSORA, resolverIpImpressora,
  relatorioQuedas, quedasDeUmComputador,
  COMANDO_LIMPAR_TRAVADOS, COMANDO_REINICIAR, COMANDO_ABORTAR_REINICIO,
  ESTADOS, estadoDe, motivosDeDegradacao,
  marcarComandoExecutado, registrarAcessoRemoto, responderChat, registrarTelemetria,
  saudeMaquinas,
  garantirAgentToken, tokenDoComputador,
};
