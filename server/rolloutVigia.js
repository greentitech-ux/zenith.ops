// rolloutVigia.js
// LIBERACAO EM ONDAS do agente NOCZenith (pedido do Master, 23/09/2026).
//
// Nasceu do incidente da v116: publicada pro parque inteiro de uma vez, ela
// morria ao iniciar nos Server 2012 R2 (Windows antigo) e derrubou o
// DOM-TIROL-HOST01 e o DOM-CG-MAKELINE ate alguem reinstalar na mao.
//
// Agora uma versao nova vai primeiro pra ate 4 maquinas PILOTO online (uma
// "Windows antigo" e um servidor, quando houver - e onde a v116 quebrou). O
// resto do parque so recebe depois que as pilotos rodarem a versao nova por
// 30 minutos. Se uma piloto voltar sozinha pra versao anterior (o agente
// v118+ faz isso quando a nova nao sobe) ou calar logo depois de atualizar,
// a liberacao fica SUSPENSA e o parque segue na versao estavel. O Master ve o
// estado no NOC e pode liberar ou suspender na mao.
//
// So decide a VERSAO OFERECIDA em GET /vigia-versao. O .ps1 servido e sempre
// o mais novo (instalacao e reparo precisam dele); ninguem e rebaixado.
//
// Identidade: so o agente v118+ diz quem e (?codigo=&posto=) ao perguntar a
// versao. Agente sem identidade nunca e piloto - recebe a estavel ate a
// versao ser liberada. Por isso a PRIMEIRA vez (sem estado gravado) ja nasce
// liberada: e a propria versao que traz a identidade.
//
// Funcoes puras: estado entra, estado sai. Quem grava e o lojaStatus.

const PILOTOS_MAX = 4;
const PROMOVER_APOS_MS = 30 * 60 * 1000;   // pilotas rodando a nova
const PILOTOS_PARA_PROMOVER = 2;
// piloto que atualizou e sumiu dentro desta janela = a versao derrubou ela
const CALOU_JANELA_MS = 60 * 60 * 1000;
const VERSAO_QUE_SE_IDENTIFICA = 118;

// o id do documento do computador (lojaStatus.docIdFor); quem chama manda _id
const idDoc = (d) => d._id || `${d.codigo}__${d.posto}`;

// a primeira vez nao tem com o que comparar: a versao que esta indo pro ar
// e a estavel (e ela que traz a identidade que as pilotos precisam)
function estadoInicial(versao, agora) {
  return { versao, estavel: versao, estado: 'liberada', pilotos: [], atualizados: [], iniciadoEm: agora, motivo: 'primeira versão com liberação em ondas', atualizadoEm: agora };
}

// versao nova no ar (deploy): a estavel passa a ser a ultima LIBERADA - se a
// anterior tinha sido suspensa, a estavel dela continua valendo
function novaRodada(anterior, versao, agora) {
  const estavel = anterior.estado === 'liberada' ? anterior.versao : anterior.estavel;
  return { versao, estavel, estado: 'piloto', pilotos: [], atualizados: [], iniciadoEm: agora, motivo: '', atualizadoEm: agora };
}

// Pilotos: maquinas internas, online, que ja se identificam. Uma de cada
// "tipo de risco" primeiro (Windows antigo, servidor), depois as demais por
// ordem estavel de nome - sorteio mudaria a cada avaliacao.
function escolherPilotos(docs, jaEscolhidos = []) {
  const ja = new Set(jaEscolhidos);
  const aptas = (docs || []).filter((d) => d && d.tipo === 'interno' && d.online && d.agentToken
    && Number(d.agenteVersao) >= VERSAO_QUE_SE_IDENTIFICA && !ja.has(idDoc(d)))
    .sort((a, b) => String(a.nome || idDoc(a)).localeCompare(String(b.nome || idDoc(b))));
  const escolhidos = [...jaEscolhidos];
  const pegar = (filtro) => {
    if (escolhidos.length >= PILOTOS_MAX) return;
    const d = aptas.find((x) => filtro(x) && !escolhidos.includes(idDoc(x)));
    if (d) escolhidos.push(idDoc(d));
  };
  if (!jaEscolhidos.some((id) => (docs || []).some((d) => idDoc(d) === id && d.windowsAntigo))) pegar((d) => d.windowsAntigo);
  if (!jaEscolhidos.some((id) => (docs || []).some((d) => idDoc(d) === id && d.ehServidor))) pegar((d) => d.ehServidor);
  while (escolhidos.length < PILOTOS_MAX) {
    const antes = escolhidos.length;
    pegar(() => true);
    if (escolhidos.length === antes) break;
  }
  return escolhidos;
}

// Avalia e devolve { estado, mudou, evento }. Chamada a cada varredura (1min),
// sem leitura: os documentos vem do espelho em memoria.
function avaliar(estadoAtual, versaoAtual, docs, agora = Date.now()) {
  if (!estadoAtual || !estadoAtual.versao) {
    return { estado: estadoInicial(versaoAtual, agora), mudou: true, evento: 'inicial' };
  }
  if (estadoAtual.versao !== versaoAtual) {
    const nova = novaRodada(estadoAtual, versaoAtual, agora);
    nova.pilotos = escolherPilotos(docs);
    return { estado: nova, mudou: true, evento: 'nova-rodada' };
  }
  if (estadoAtual.estado !== 'piloto') return { estado: estadoAtual, mudou: false };

  // lista (nao mapa) de proposito: gravar com merge no Firestore mescla mapa
  // chave a chave e nunca apaga - a rodada anterior vazaria pra esta
  const e = { ...estadoAtual, pilotos: [...(estadoAtual.pilotos || [])], atualizados: [...(estadoAtual.atualizados || [])] };
  const quando = (id) => { const a = e.atualizados.find((x) => x.id === id); return a ? a.em : null; };
  let mudou = false;
  // piloto que faltava (ninguem apto online na hora do deploy - de madrugada,
  // por exemplo): completa quando alguem aparecer
  if (e.pilotos.length < PILOTOS_MAX) {
    const completos = escolherPilotos(docs, e.pilotos);
    if (completos.length !== e.pilotos.length) { e.pilotos = completos; mudou = true; }
  }
  const porId = new Map((docs || []).map((d) => [idDoc(d), d]));
  for (const id of e.pilotos) {
    const d = porId.get(id);
    if (!d) continue;
    // a versao nova nao subiu ali e o agente voltou sozinho (v118+)
    if (Number(d.agenteVersaoRuim) === e.versao) {
      return { estado: { ...e, estado: 'suspensa', motivo: `a v${e.versao} não subiu em ${d.nome || id} e o agente voltou sozinho pra versão anterior`, atualizadoEm: agora }, mudou: true, evento: 'suspensa' };
    }
    if (Number(d.agenteVersao) === e.versao && !quando(id)) { e.atualizados.push({ id, em: agora }); mudou = true; }
    // atualizou e calou logo depois: a v116 fez exatamente isso
    if (quando(id) && !d.online && agora - quando(id) < CALOU_JANELA_MS) {
      return { estado: { ...e, estado: 'suspensa', motivo: `${d.nome || id} ficou fora do ar logo depois de atualizar pra v${e.versao}`, atualizadoEm: agora }, mudou: true, evento: 'suspensa' };
    }
  }
  const rodando = e.pilotos.filter((id) => { const d = porId.get(id); return d && d.online && Number(d.agenteVersao) === e.versao; });
  const precisa = Math.min(PILOTOS_PARA_PROMOVER, Math.max(1, e.pilotos.length));
  if (e.pilotos.length && rodando.length >= precisa) {
    const desde = Math.max(...rodando.map((id) => quando(id) || agora));
    if (agora - desde >= PROMOVER_APOS_MS) {
      return { estado: { ...e, estado: 'liberada', motivo: `${rodando.length} piloto(s) rodando a v${e.versao} há ${Math.round((agora - desde) / 60000)}min`, atualizadoEm: agora }, mudou: true, evento: 'liberada' };
    }
  }
  if (mudou) e.atualizadoEm = agora;
  return { estado: e, mudou };
}

// Que versao este agente deve buscar. Sem estado ou liberada: a nova.
function versaoOferecida(estado, versaoAtual, idMaquina) {
  if (!estado || !estado.versao) return versaoAtual;
  // deploy acabou de subir e a varredura (1min) ainda nao abriu a rodada: a
  // nova NAO vaza pro parque nesse intervalo - vale a ultima liberada
  if (estado.versao !== versaoAtual) return estado.estado === 'liberada' ? estado.versao : (estado.estavel || estado.versao);
  if (estado.estado === 'liberada') return versaoAtual;
  if (estado.estado === 'piloto' && idMaquina && (estado.pilotos || []).includes(idMaquina)) return versaoAtual;
  return estado.estavel || versaoAtual;
}

// o Master decide na mao
function decisaoDoMaster(estado, acao, quem, agora = Date.now()) {
  if (!estado || !estado.versao) throw new Error('Não há liberação em andamento.');
  if (acao === 'liberar') return { ...estado, estado: 'liberada', motivo: `liberada por ${quem}`, atualizadoEm: agora };
  if (acao === 'suspender') return { ...estado, estado: 'suspensa', motivo: `suspensa por ${quem}`, atualizadoEm: agora };
  throw new Error('Ação inválida (liberar ou suspender).');
}

module.exports = {
  avaliar, versaoOferecida, escolherPilotos, decisaoDoMaster, estadoInicial,
  PILOTOS_MAX, PROMOVER_APOS_MS, PILOTOS_PARA_PROMOVER, CALOU_JANELA_MS, VERSAO_QUE_SE_IDENTIFICA,
};
