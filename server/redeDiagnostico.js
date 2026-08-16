// Diagnostico de qualidade de link por computador.
//
// Por que isso existe: as "quedas" do NOC vinham sendo tratadas como falha da
// maquina, quando na pratica quase sempre e o link. So que "acho que a
// internet da loja e ruim" nao aciona ninguem - operadora pede numero. Esse
// modulo transforma o heartbeat, que ja acontece de qualquer jeito, em uma
// medicao continua de latencia/perda, e separa a culpa entre rede interna
// (cabo/switch/wifi da loja) e link externo (operadora).
//
// Custo: ZERO leitura/escrita extra no Firestore. O heartbeat ja le e
// reescreve o doc do computador a cada 25s (ver lojaStatus.heartbeat); as
// metricas entram nessa mesma escrita, e o acumulado do dia e recalculado em
// memoria a partir do que ja foi lido. Isso e proposital: o projeto ja teve
// RESOURCE_EXHAUSTED antes, entao telemetria nova nao pode multiplicar
// operacao.
//
// IMPORTANTE - a origem e HOSTIL: /api/loja-status/heartbeat e publica (sem
// login, de proposito, pra maquina legada nao sumir do painel). Entao tudo
// que chega em `rede` vem de fora sem autenticacao e passa por
// sanitizarAmostra() antes de encostar em qualquer conta.

// Faixas de referencia. Nao sao chute: sao os pontos onde o comportamento
// muda pra quem usa o sistema.
const LATENCIA_BOA_MS = 150;      // abaixo disso ninguem percebe nada
const LATENCIA_RUIM_MS = 1500;    // aqui a tela ja "trava" de forma obvia
const LATENCIA_LENTA_MS = 1000;   // amostra acima disso conta como lentidao
const SINAL_WIFI_BAIXO = 60;      // % - abaixo disso o wifi comeca a perder pacote
const HISTORICO_DIAS_MAX = 14;    // dias fechados guardados no doc

const CONEXOES = ['cabo', 'wifi'];

// ---------------------------------------------------------------- entrada

function num(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// Limpa e limita a amostra que veio do agente/navegador. Todo campo e
// opcional: o navegador so consegue medir latencia, o NOCZenith mede o resto.
// Os tetos existem pra que um cliente forjado nao consiga envenenar a media
// com um numero absurdo.
function sanitizarAmostra(rede) {
  if (!rede || typeof rede !== 'object') return null;
  const conexao = CONEXOES.includes(rede.conexao) ? rede.conexao : null;
  const amostra = {
    latenciaMs: num(rede.latenciaMs, 0, 120000),
    falhasSeguidas: num(rede.falhasSeguidas, 0, 100000),
    gatewayMs: num(rede.gatewayMs, 0, 60000),
    gatewayPerdaPct: num(rede.gatewayPerdaPct, 0, 100),
    wanMs: num(rede.wanMs, 0, 60000),
    wanPerdaPct: num(rede.wanPerdaPct, 0, 100),
    sinalWifi: num(rede.sinalWifi, 0, 100),
    conexao,
  };
  // amostra sem nenhum dado util nao vira acumulo (evita inflar o contador
  // de amostras com beat vazio e diluir a media)
  const temAlgo = Object.keys(amostra).some((k) => k !== 'conexao' && amostra[k] !== null);
  return temAlgo || conexao ? amostra : null;
}

// ------------------------------------------------------------- acumulacao

function bucketVazio(dia) {
  return {
    dia,
    amostras: 0,
    somaLatencia: 0,
    maxLatencia: 0,
    lentas: 0,        // amostras acima de LATENCIA_LENTA_MS
    falhas: 0,        // beats que o agente reportou como perdidos
    somaGateway: 0,
    amostrasGateway: 0,
    somaPerdaGateway: 0,
    somaWan: 0,
    amostrasWan: 0,
    somaPerdaWan: 0,
    somaSinal: 0,
    amostrasSinal: 0,
    minSinal: null,
    conexao: null,
  };
}

// Soma uma amostra no bucket do dia. Puro: devolve bucket novo, nunca muda o
// que recebeu - assim da pra testar sem Firestore e o chamador decide gravar.
function acumular(bucket, amostra, dia) {
  const b = (bucket && bucket.dia === dia) ? { ...bucket } : bucketVazio(dia);
  if (!amostra) return b;

  if (amostra.latenciaMs !== null) {
    b.amostras += 1;
    b.somaLatencia += amostra.latenciaMs;
    if (amostra.latenciaMs > b.maxLatencia) b.maxLatencia = amostra.latenciaMs;
    if (amostra.latenciaMs > LATENCIA_LENTA_MS) b.lentas += 1;
  }
  // falhasSeguidas e um contador VIVO do agente (quantas falhas seguidas ele
  // acumulou ate agora), nao um delta. So conta como falha nova quando ele
  // subiu em relacao ao que ja vimos - senao um agente parado em "3 falhas"
  // somaria 3 a cada beat.
  if (amostra.falhasSeguidas !== null) {
    const anterior = Number(b.ultimaFalhaSeguida) || 0;
    if (amostra.falhasSeguidas > anterior) b.falhas += (amostra.falhasSeguidas - anterior);
    b.ultimaFalhaSeguida = amostra.falhasSeguidas;
  }
  if (amostra.gatewayMs !== null) {
    b.amostrasGateway += 1;
    b.somaGateway += amostra.gatewayMs;
    b.somaPerdaGateway += (amostra.gatewayPerdaPct || 0);
  }
  if (amostra.wanMs !== null) {
    b.amostrasWan += 1;
    b.somaWan += amostra.wanMs;
    b.somaPerdaWan += (amostra.wanPerdaPct || 0);
  }
  if (amostra.sinalWifi !== null) {
    b.amostrasSinal += 1;
    b.somaSinal += amostra.sinalWifi;
    b.minSinal = b.minSinal === null ? amostra.sinalWifi : Math.min(b.minSinal, amostra.sinalWifi);
  }
  if (amostra.conexao) b.conexao = amostra.conexao;
  return b;
}

// Vira o dia: fecha o bucket atual no historico e comeca um novo. Chamado
// pelo heartbeat quando percebe que o dia mudou.
function virarDia(bucketAtual, historico, dia) {
  const hist = Array.isArray(historico) ? [...historico] : [];
  if (bucketAtual && bucketAtual.dia && bucketAtual.dia !== dia && bucketAtual.amostras > 0) {
    hist.push(resumir(bucketAtual));
  }
  return hist.slice(-HISTORICO_DIAS_MAX);
}

// ---------------------------------------------------------------- leitura

const media = (soma, n) => (n > 0 ? Math.round(soma / n) : null);
const pct = (parte, total) => (total > 0 ? Math.round((parte / total) * 1000) / 10 : null);

// Condensa o bucket cru em numeros que fazem sentido pra um humano.
function resumir(bucket) {
  // "tem dado" nao e so ter latencia: um bucket pode ter so os pings (o
  // navegador nao mede ping, mas o agente pode reportar uma volta de
  // diagnostico sem latencia nova) ou so falhas - e falha e justamente o
  // sinal mais grave. Olhar so `amostras` fazia esse caso ser descartado
  // como "sem medicao" e o veredito devolvia 'indefinido'.
  const temDado = !!bucket && !!(bucket.amostras || bucket.amostrasGateway || bucket.amostrasWan || bucket.falhas);
  if (!temDado) {
    return { dia: bucket ? bucket.dia : null, amostras: 0, semDados: true };
  }
  // beats esperados = os que chegaram + os que o agente contou como falha.
  // Falha aqui e beat que o agente TENTOU e nao conseguiu - e a metrica mais
  // dura que existe, porque e exatamente o que faz o sistema parar de
  // responder pro operador.
  const esperados = bucket.amostras + bucket.falhas;
  return {
    dia: bucket.dia,
    amostras: bucket.amostras,
    semDados: false,
    latenciaMedia: media(bucket.somaLatencia, bucket.amostras),
    latenciaMax: bucket.maxLatencia || null,
    pctLenta: pct(bucket.lentas, bucket.amostras),
    falhas: bucket.falhas,
    pctFalha: pct(bucket.falhas, esperados),
    gatewayMedia: media(bucket.somaGateway, bucket.amostrasGateway),
    gatewayPerda: media(bucket.somaPerdaGateway, bucket.amostrasGateway),
    wanMedia: media(bucket.somaWan, bucket.amostrasWan),
    wanPerda: media(bucket.somaPerdaWan, bucket.amostrasWan),
    sinalWifiMedio: media(bucket.somaSinal, bucket.amostrasSinal),
    sinalWifiMin: bucket.minSinal,
    conexao: bucket.conexao,
  };
}

// ---------------------------------------------------------------- nota

// Escala linear de penalidade: `de` nao tira ponto nenhum, `ate` tira o
// maximo, e no meio e proporcional.
function penal(valor, de, ate, maximo) {
  if (valor === null || valor === undefined) return 0;
  if (valor <= de) return 0;
  if (valor >= ate) return maximo;
  return Math.round(((valor - de) / (ate - de)) * maximo);
}

// Nota 0-100. Os pesos seguem o impacto real no uso: beat perdido derruba o
// sistema (peso maior que latencia alta, que so deixa lento).
function pontuar(resumo, quedasNoDia) {
  if (!resumo || resumo.semDados) {
    return { nota: null, classe: 'sem-dados', rotulo: 'Sem dados', penalidades: [] };
  }
  const p = [];
  const add = (pontos, motivo) => { if (pontos > 0) p.push({ pontos, motivo }); };

  add(penal(resumo.latenciaMedia, LATENCIA_BOA_MS, LATENCIA_RUIM_MS, 30),
    `latência média de ${resumo.latenciaMedia}ms`);
  add(penal(resumo.pctLenta, 2, 30, 15),
    `${resumo.pctLenta}% das respostas acima de ${LATENCIA_LENTA_MS}ms`);
  add(penal(resumo.pctFalha, 0.5, 15, 30),
    `${resumo.pctFalha}% dos batimentos falharam`);
  // perda de pacote pesa mais que latencia: latencia alta deixa lento, perda
  // trava e faz o sistema repetir a requisicao do zero
  add(penal(resumo.wanPerda, 1, 20, 20),
    `${resumo.wanPerda}% de perda de pacote no link externo`);
  // problema de rede INTERNA tambem tem que derrubar a nota. Sem isso, uma
  // loja perdendo pacote pro proprio roteador ficava com nota boa e so o
  // veredito denunciava - exatamente o tipo de caso que essa tela existe
  // pra achar. Perda ate o roteador nunca e normal, entao entra pesado.
  add(penal(resumo.gatewayPerda, 0.5, 10, 20),
    `${resumo.gatewayPerda}% de perda de pacote até o roteador da loja`);
  add(penal(resumo.gatewayMedia, 15, 150, 10),
    `${resumo.gatewayMedia}ms de resposta do roteador da loja`);
  add(penal(quedasNoDia, 1, 6, 20),
    `${quedasNoDia} queda(s) registradas no dia`);
  if (resumo.conexao === 'wifi' && resumo.sinalWifiMin !== null && resumo.sinalWifiMin < SINAL_WIFI_BAIXO) {
    add(penal(SINAL_WIFI_BAIXO - resumo.sinalWifiMin, 0, 40, 10),
      `sinal de wi-fi caiu para ${resumo.sinalWifiMin}%`);
  }

  const nota = Math.max(0, 100 - p.reduce((s, x) => s + x.pontos, 0));
  let classe = 'bom'; let rotulo = 'Bom';
  if (nota < 40) { classe = 'critico'; rotulo = 'Crítico'; }
  else if (nota < 65) { classe = 'instavel'; rotulo = 'Instável'; }
  else if (nota < 85) { classe = 'aceitavel'; rotulo = 'Aceitável'; }
  return { nota, classe, rotulo, penalidades: p.sort((a, b) => b.pontos - a.pontos) };
}

// ---------------------------------------------------------------- veredito

// A parte que vira acao. Uma nota baixa sozinha nao diz com quem reclamar;
// o que decide isso e comparar o salto ate o gateway (rede da loja) com o
// salto ate a internet (operadora).
function veredito(resumo) {
  if (!resumo || resumo.semDados) {
    return { culpa: 'indefinido', titulo: 'Sem medição ainda', detalhe: 'O computador ainda não reportou dados de rede.' };
  }
  const temLan = resumo.gatewayMedia !== null;
  const temWan = resumo.wanMedia !== null;

  const lanRuim = temLan && (resumo.gatewayMedia > 30 || (resumo.gatewayPerda || 0) > 2);
  const wanRuim = temWan && (resumo.wanMedia > 120 || (resumo.wanPerda || 0) > 2);
  const wifiFraco = resumo.conexao === 'wifi' && resumo.sinalWifiMin !== null && resumo.sinalWifiMin < SINAL_WIFI_BAIXO;

  // O caso que a primeira versao errava: a loja pinga a internet em 33ms mas
  // a resposta do Zenith leva 1457ms. Os dois numeros estao certos - eles
  // medem coisas diferentes. O ping mede o caminho ate a operadora; a
  // latencia mede o caminho INTEIRO, incluindo o servidor da aplicacao. Se o
  // ping esta bom e a latencia nao, o gargalo esta depois do link: e o
  // servidor, nao a loja. Sem esta checagem o painel dizia "rede saudavel"
  // com nota critica na mesma tela - contraditorio e, pior, mandava olhar o
  // lugar errado.
  const appLento = resumo.latenciaMedia !== null && resumo.latenciaMedia > 600;
  if (appLento && temWan && !lanRuim && !wanRuim) {
    return {
      culpa: 'servidor',
      titulo: 'O link está bom — o lento é o Zenith',
      detalhe: `A loja alcança a internet em ${resumo.wanMedia}ms`
        + `${temLan ? ` e o roteador em ${resumo.gatewayMedia}ms` : ''}, mas a resposta do Zenith está em `
        + `${resumo.latenciaMedia}ms. Como o caminho até a operadora está limpo, o atraso está do servidor para cá: `
        + 'não adianta mexer na rede desta loja nem abrir chamado na operadora.',
    };
  }

  if (wifiFraco && lanRuim) {
    return {
      culpa: 'wifi',
      titulo: 'Wi-Fi fraco dentro da loja',
      detalhe: `O sinal chegou a ${resumo.sinalWifiMin}% e a resposta do roteador está em ${resumo.gatewayMedia}ms. `
        + 'O problema é antes da operadora: aproximar o computador do roteador, trocar por cabo ou instalar um ponto de acesso resolve.',
    };
  }
  if (lanRuim && !wanRuim) {
    return {
      culpa: 'lan',
      titulo: 'Problema na rede interna',
      detalhe: `Até o roteador da loja já está ruim (${resumo.gatewayMedia}ms, ${resumo.gatewayPerda || 0}% de perda), `
        + 'e o link externo está bom. Não adianta acionar a operadora: olhar cabo, switch, roteador ou wi-fi da loja.',
    };
  }
  if (wanRuim && !lanRuim) {
    return {
      culpa: 'wan',
      titulo: 'Problema no link da operadora',
      detalhe: `A rede interna está boa (${resumo.gatewayMedia}ms até o roteador), mas a saída para a internet está em `
        + `${resumo.wanMedia}ms com ${resumo.wanPerda || 0}% de perda. Esse é o número para abrir chamado na operadora.`,
    };
  }
  if (lanRuim && wanRuim) {
    return {
      culpa: 'ambos',
      titulo: 'Rede interna e link, os dois',
      detalhe: `Roteador em ${resumo.gatewayMedia}ms e internet em ${resumo.wanMedia}ms. `
        + 'Vale arrumar a rede interna primeiro — ela pode estar sendo a causa da leitura ruim do link.',
    };
  }
  if (!temLan && !temWan) {
    return {
      culpa: 'indefinido',
      titulo: appLento ? 'Resposta lenta, origem não isolada' : 'Só temos latência do sistema',
      detalhe: (appLento
        ? `A resposta do Zenith está em ${resumo.latenciaMedia}ms. `
        : '')
        + 'Esse computador reporta pelo navegador, então mede o tempo de resposta do Zenith mas não separa rede interna, '
        + 'link e servidor. Instalar o NOCZenith nele destrava a medição completa.',
    };
  }
  if (appLento) {
    return {
      culpa: 'servidor',
      titulo: 'O link está bom — o lento é o Zenith',
      detalhe: `A rede da loja responde bem, mas o Zenith está levando ${resumo.latenciaMedia}ms. O atraso não está no link.`,
    };
  }
  return {
    culpa: 'ok',
    titulo: 'Rede saudável',
    detalhe: `Roteador em ${resumo.gatewayMedia}ms e internet em ${resumo.wanMedia}ms — dentro do esperado. `
      + 'Se algum sistema falha nesse computador, a causa provavelmente não é o link.',
  };
}

// ---------------------------------------------------------------- quedas

// Reaproveita o historico de eventos que o NOC ja guarda (ver varrerAlertas)
// pra contar quantas vezes o computador caiu e quanto tempo ficou fora, por
// dia. Isso funciona pra TODA maquina desde ja, sem depender do agente novo.
function quedasPorDia(eventos, tz = 'America/Sao_Paulo') {
  const porDia = new Map();
  const diaDe = (ts) => new Date(ts).toLocaleDateString('sv-SE', { timeZone: tz });
  (eventos || []).forEach((ev) => {
    if (!ev || !ev.em) return;
    const dia = diaDe(ev.em);
    if (!porDia.has(dia)) porDia.set(dia, { dia, quedas: 0, msFora: 0 });
    const alvo = porDia.get(dia);
    if (ev.tipo === 'offline') alvo.quedas += 1;
    // a duracao vem carimbada no evento de volta (online); somamos no dia em
    // que a queda TERMINOU, que e onde o evento esta
    if (ev.tipo === 'online' && ev.duracaoMs) alvo.msFora += ev.duracaoMs;
  });
  return [...porDia.values()].sort((a, b) => (a.dia < b.dia ? 1 : -1));
}

// ---------------------------------------------------------------- fachada

// Junta tudo pro painel: pega o doc cru do computador e devolve o diagnostico
// pronto pra renderizar.
function analisarComputador(doc, dia) {
  const bucket = (doc && doc.redeDia && doc.redeDia.dia === dia) ? doc.redeDia : null;
  const resumo = resumir(bucket);
  const quedas = quedasPorDia(doc && doc.eventos);
  const doDia = quedas.find((q) => q.dia === dia);
  const quedasNoDia = doDia ? doDia.quedas : 0;
  return {
    codigo: doc.codigo,
    posto: doc.posto,
    nome: doc.nome || doc.posto,
    tipo: doc.tipo,
    online: doc.online,
    resumo,
    quedasNoDia,
    msForaNoDia: doDia ? doDia.msFora : 0,
    ...pontuar(resumo, quedasNoDia),
    veredito: veredito(resumo),
    historico: (doc.redeHistorico || []).slice(-HISTORICO_DIAS_MAX),
    quedas: quedas.slice(0, HISTORICO_DIAS_MAX),
  };
}

// Ranking: pior link primeiro. Quem nao tem medicao vai pro fim - nao e "bom"
// nem "ruim", so nao sabemos, e misturar os dois esconderia problema real.
function ranking(docs, dia) {
  return docs
    .map((d) => analisarComputador(d, dia))
    .sort((a, b) => {
      if (a.nota === null && b.nota === null) return 0;
      if (a.nota === null) return 1;
      if (b.nota === null) return -1;
      return a.nota - b.nota;
    });
}

module.exports = {
  sanitizarAmostra, acumular, virarDia, resumir, pontuar, veredito,
  quedasPorDia, analisarComputador, ranking,
  LATENCIA_BOA_MS, LATENCIA_RUIM_MS, LATENCIA_LENTA_MS, SINAL_WIFI_BAIXO, HISTORICO_DIAS_MAX,
};
