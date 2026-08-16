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
// 35 dias fechados: o filtro de "últimos 30 dias" precisa de 30 + folga pra
// virada. Guardar dia fechado é barato (um resumo de ~14 números por dia).
const HISTORICO_DIAS_MAX = 35;

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

// ---- serie por hora ----------------------------------------------------
//
// O agregado do dia responde "quem esta ruim", mas nao responde "ruim QUANDO"
// - e sem isso nao da pra saber se duas lojas ficaram lentas ao MESMO tempo
// (servidor) ou em horas diferentes (cada uma por um motivo). Essa e a
// pergunta que separa culpa de verdade, entao precisa de eixo do tempo.
//
// Cabe no mesmo documento e na mesma escrita do heartbeat: 48 baldes de 6
// numeros. Nao ha custo novo de Firestore.
const HORAS_MAX = 48;

// ---- camada de 5 minutos (para a janela de "últimos 60 min") -------------
//
// Três camadas, não uma: é assim que ferramenta de monitoração séria faz
// (Datadog, Grafana, New Relic). Ninguém plota 30 dias de pontos de 5 em 5
// minutos - some a informação e o navegador engasga. O que muda junto com o
// período é a GRANULARIDADE:
//
//   últimos 60 min  -> 1 ponto a cada 5 min   (esta camada)
//   últimas 24h     -> 1 ponto por hora       (redeHoras)
//   7 / 15 / 30 dias-> 1 ponto por dia        (redeHistorico + redeDia)
//
// A tela DIZ qual granularidade está mostrando - um gráfico que muda de
// resolução sem avisar faz o leitor comparar coisas diferentes achando que
// são iguais.
//
// 36 baldes = 3h. Dá folga pra janela de 60min sem inchar o documento.
const MINUTO_BUCKET_MS = 5 * 60 * 1000;
const MINUTOS_MAX = 36;

// chave por epoch (não por texto local): imune a fuso e horário de verão, e o
// cliente formata na hora de exibir
const baldeMinuto = (ts) => Math.floor(ts / MINUTO_BUCKET_MS) * MINUTO_BUCKET_MS;

function acumularMinuto(lista, amostra, agora) {
  const arr = Array.isArray(lista) ? [...lista] : [];
  if (!amostra || amostra.latenciaMs === null) return arr.slice(-MINUTOS_MAX);
  const t = baldeMinuto(agora);
  let balde = arr.length && arr[arr.length - 1].t === t ? { ...arr[arr.length - 1] } : null;
  if (balde) arr[arr.length - 1] = balde;
  else { balde = { t, n: 0, soma: 0, max: 0, lentas: 0 }; arr.push(balde); }
  balde.n += 1;
  balde.soma += amostra.latenciaMs;
  if (amostra.latenciaMs > balde.max) balde.max = amostra.latenciaMs;
  if (amostra.latenciaMs > LATENCIA_LENTA_MS) balde.lentas += 1;
  return arr.slice(-MINUTOS_MAX);
}

function serieMinutos(lista) {
  return (Array.isArray(lista) ? lista : [])
    .filter((b) => b && b.n > 0)
    .map((b) => ({ t: b.t, media: Math.round(b.soma / b.n), max: b.max || null, amostras: b.n, lentas: b.lentas || 0 }));
}

// Série diária: os dias já fechados (redeHistorico) mais o dia corrente, que
// ainda está sendo acumulado. Sem juntar os dois, "últimos 7 dias" mostraria
// tudo menos hoje - justo o dia que mais interessa num incidente.
function serieDias(doc, diaHoje) {
  const fechados = (doc && doc.redeHistorico ? doc.redeHistorico : [])
    .filter((d) => d && d.dia && !d.semDados && d.latenciaMedia !== null && d.latenciaMedia !== undefined)
    .map((d) => ({ dia: d.dia, media: d.latenciaMedia, max: d.latenciaMax || null, amostras: d.amostras, lentas: null }));
  const hoje = (doc && doc.redeDia && doc.redeDia.dia === diaHoje) ? resumir(doc.redeDia) : null;
  if (hoje && !hoje.semDados && hoje.latenciaMedia !== null) {
    fechados.push({ dia: hoje.dia, media: hoje.latenciaMedia, max: hoje.latenciaMax, amostras: hoje.amostras, lentas: null });
  }
  return fechados;
}

function horaDe(ts, tz = 'America/Sao_Paulo') {
  const d = new Date(ts);
  const dia = d.toLocaleDateString('sv-SE', { timeZone: tz });
  const h = d.toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', hour12: false });
  return `${dia}T${h.slice(0, 2)}`;
}

function acumularHora(horas, amostra, horaAtual) {
  const lista = Array.isArray(horas) ? [...horas] : [];
  if (!amostra) return lista.slice(-HORAS_MAX);
  let balde = lista.length && lista[lista.length - 1].h === horaAtual ? { ...lista[lista.length - 1] } : null;
  if (balde) lista[lista.length - 1] = balde;
  else { balde = { h: horaAtual, n: 0, soma: 0, max: 0, lentas: 0, falhas: 0 }; lista.push(balde); }

  if (amostra.latenciaMs !== null) {
    balde.n += 1;
    balde.soma += amostra.latenciaMs;
    if (amostra.latenciaMs > balde.max) balde.max = amostra.latenciaMs;
    if (amostra.latenciaMs > LATENCIA_LENTA_MS) balde.lentas += 1;
  }
  return lista.slice(-HORAS_MAX);
}

// devolve pronto pro grafico: media por hora, sem os somatorios crus
function serieHoraria(horas) {
  return (Array.isArray(horas) ? horas : [])
    .filter((b) => b && b.n > 0)
    .map((b) => ({
      hora: b.h,
      media: Math.round(b.soma / b.n),
      max: b.max || null,
      amostras: b.n,
      lentas: b.lentas || 0,
    }));
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
// `frota` = { baselineMs, medidos } - a mediana de latencia das OUTRAS
// maquinas. Sem isso nao da pra separar "o servidor esta lento" de "esta
// maquina esta lenta": os dois aparecem igual num card sozinho. Se metade da
// frota responde em 120ms pelo mesmo servidor, o servidor nao e o culpado da
// maquina que esta em 1457ms - por mais que o ping dela pareca bom.
function veredito(resumo, frota) {
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
  const baseline = frota && frota.baselineMs !== null && frota.baselineMs !== undefined ? frota.baselineMs : null;
  const temComparacao = baseline !== null && frota.medidos >= 3;
  // "muito pior que os colegas": o mesmo servidor atende todo mundo, entao
  // uma maquina fora da curva denuncia a si mesma
  const foraDaCurva = temComparacao && baseline > 0 && resumo.latenciaMedia > baseline * 2.5;
  const frotaLenta = temComparacao && baseline > 600;

  if (appLento && foraDaCurva) {
    return {
      culpa: 'local',
      titulo: 'Só este computador está lento',
      detalhe: `A resposta do Zenith aqui está em ${resumo.latenciaMedia}ms, mas o resto da frota está em `
        + `${baseline}ms pelo MESMO servidor. Então o problema é deste ponto, não do Zenith. `
        + 'O ping parece bom porque são 2 pacotes a cada 5 minutos — ele não pega os momentos ruins; '
        + 'já a conexão do sistema acontece a cada 25s e pega. Link intermitente (4G/5G, wi-fi oscilando '
        + 'ou cabo com mau contato) se comporta exatamente assim.',
    };
  }
  if (appLento && frotaLenta) {
    return {
      culpa: 'servidor',
      titulo: 'A frota inteira está lenta — é o Zenith',
      detalhe: `Esta máquina está em ${resumo.latenciaMedia}ms e a mediana da frota em ${baseline}ms — `
        + 'lojas diferentes, links independentes, todas lentas ao mesmo tempo. O que elas têm em comum é o servidor. '
        + 'Não abra chamado na operadora.',
    };
  }
  if (appLento && temWan && !lanRuim && !wanRuim && !temComparacao) {
    // ainda nao ha frota suficiente pra comparar - diz o que se sabe e o que
    // ainda nao se sabe, em vez de escolher um culpado no chute
    return {
      culpa: 'indefinido',
      titulo: 'Lento, mas ainda sem base de comparação',
      detalhe: `A loja alcança a internet em ${resumo.wanMedia}ms`
        + `${temLan ? ` e o roteador em ${resumo.gatewayMedia}ms` : ''}, mas o Zenith responde em `
        + `${resumo.latenciaMedia}ms. Com menos de 3 computadores medindo não dá pra dizer se é este ponto ou o `
        + 'servidor — assim que mais máquinas reportarem, a comparação resolve isso sozinha.',
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
      culpa: 'indefinido',
      titulo: 'Lento, e o link não explica',
      detalhe: `A rede da loja responde bem, mas o Zenith está levando ${resumo.latenciaMedia}ms. `
        + 'O ping é uma amostra de 2 pacotes a cada 5 minutos e não pega oscilação curta — compare com as outras '
        + 'unidades na lista para saber se é só aqui ou geral.',
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
function analisarComputador(doc, dia, frota) {
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
    veredito: veredito(resumo, frota),
    historico: (doc.redeHistorico || []).slice(-HISTORICO_DIAS_MAX),
    // as três camadas vão juntas: o filtro da tela escolhe qual usar sem
    // precisar de outra ida ao servidor
    serie: serieHoraria(doc.redeHoras),
    serieMin: serieMinutos(doc.redeMinutos),
    serieDia: serieDias(doc, dia),
    quedas: quedas.slice(0, HISTORICO_DIAS_MAX),
  };
}

// Ranking: pior link primeiro. Quem nao tem medicao vai pro fim - nao e "bom"
// nem "ruim", so nao sabemos, e misturar os dois esconderia problema real.
// A mediana (nao a media) e de proposito: uma unica maquina em 1457ms puxaria
// a media pra cima e faria ela "provar" que a frota esta lenta - justamente o
// erro que essa comparacao existe pra evitar.
function baselineDaFrota(docs, dia) {
  const lat = docs
    .map((d) => resumir((d && d.redeDia && d.redeDia.dia === dia) ? d.redeDia : null))
    .filter((r) => !r.semDados && r.latenciaMedia !== null)
    .map((r) => r.latenciaMedia)
    .sort((a, b) => a - b);
  if (!lat.length) return { baselineMs: null, medidos: 0 };
  return { baselineMs: lat[Math.floor(lat.length / 2)], medidos: lat.length };
}

function ranking(docs, dia) {
  const frota = baselineDaFrota(docs, dia);
  return docs
    .map((d) => analisarComputador(d, dia, frota))
    .sort((a, b) => {
      if (a.nota === null && b.nota === null) return 0;
      if (a.nota === null) return 1;
      if (b.nota === null) return -1;
      return a.nota - b.nota;
    });
}

module.exports = {
  sanitizarAmostra, acumular, virarDia, resumir, pontuar, veredito,
  quedasPorDia, analisarComputador, ranking, baselineDaFrota,
  acumularHora, serieHoraria, horaDe, HORAS_MAX,
  acumularMinuto, serieMinutos, serieDias, baldeMinuto, MINUTOS_MAX,
  LATENCIA_BOA_MS, LATENCIA_RUIM_MS, LATENCIA_LENTA_MS, SINAL_WIFI_BAIXO, HISTORICO_DIAS_MAX,
};
