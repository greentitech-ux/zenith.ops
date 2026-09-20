// nocMaquina.js
// Saúde do HD e varredura da rede local de cada computador do NOC.
//
// Por que existe: o painel sabia dizer se a máquina estava ligada e se o
// link estava lento (ver redeDiagnostico.js), mas não sabia responder as
// duas perguntas que aparecem na hora do problema:
//   1) "o computador vai morrer?" - HD estourando, SMART reprovando,
//      disco cheio. Isso avisa com semanas de antecedência e hoje só era
//      descoberto quando a máquina já tinha parado.
//   2) "quem está na rede da loja?" - quantos aparelhos, quais são novos.
//      Numa loja de shopping isso separa "a internet está ruim" de "tem
//      trinta celulares pendurados no mesmo roteador".
//
// Custo no Firestore: desprezível, e de propósito fora do heartbeat. O
// agente mede raramente (disco a cada ~6h, rede a cada ~1h) e manda numa
// rota própria (registrarTelemetria em lojaStatus.js): ~25 escritas por dia
// por computador, contra as 3.456 batidas do heartbeat. Ficar fora do
// heartbeat também isola o caminho mais crítico do sistema - um erro aqui
// nunca derruba a presença online de todo mundo.
//
// A origem é HOSTIL: a rota é pública (a máquina não tem sessão de usuário,
// só o token do agente). Tudo aqui passa por sanitização antes de encostar
// no documento.

// ---------------------------------------------------------------- limites
//
// Não são chute: são os pontos onde a decisão de quem opera muda.
const LIVRE_CRITICO_PCT = 5;    // abaixo disso o Windows já começa a falhar
const LIVRE_ATENCAO_PCT = 10;   // aqui ainda dá pra agendar uma limpeza
// Memória não é espaço em disco: em uma máquina de 4 GB, chegar a 0,3 GB
// livres já causa paginação constante, mesmo que o SSD ainda tenha espaço.
// O percentual protege máquinas maiores; o piso em GB protege as pequenas.
const RAM_LIVRE_CRITICA_GB = 0.5;
const RAM_LIVRE_ATENCAO_GB = 1;
const RAM_LIVRE_CRITICA_PCT = 10;
const RAM_LIVRE_ATENCAO_PCT = 20;
const TEMPERATURA_ALTA_C = 60;  // acima disso a vida útil despenca
const HORAS_MUITO_USO = 35000;  // ~4 anos ligado direto: disco em fim de vida
// política da casa: computador de loja é reiniciado uma vez por semana.
// Não é sobre o disco - é sobre o Windows: memória vazando, atualização
// pendurada esperando reboot, sessão de impressora travada. Sete dias é o
// ponto em que a máquina começa a "ficar estranha" sem motivo aparente.
const UPTIME_REINICIAR_DIAS = 7;
const DISCOS_MAX = 6;
const VOLUMES_MAX = 8;
// teto de aparelhos guardados por computador. Uma loja de shopping tem
// dezenas de celulares entrando e saindo do wifi - guardar todos incharia o
// documento sem informar mais nada.
const DISPOSITIVOS_MAX = 60;
const MACS_CONHECIDOS_MAX = 250;
// IP muda (DHCP, troca de porta, roteador reiniciado); MAC e' a identidade.
// Guardamos poucas trocas por aparelho para responder "qual era o IP antes?"
// sem transformar o documento de telemetria em um log sem fim.
const IP_HISTORICO_MAX = 12;

const SAUDE_VALIDA = ['saudavel', 'atencao', 'ruim', 'desconhecida'];
const NIVEIS = ['ok', 'atencao', 'critico'];

function texto(v, max) {
  // tira caractere de controle (o WMI as vezes devolve modelo com \0 no
  // fim) sem mexer em espaco/hifen do nome do disco
  const s = String(v == null ? '' : v).replace(/[\x00-\x1f]/g, '').trim();
  return s ? s.slice(0, max) : null;
}
function num(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.round(n * 10) / 10));
}
const pior = (a, b) => (NIVEIS.indexOf(b) > NIVEIS.indexOf(a) ? b : a);

// PowerShell 5.1 serializa array de UM elemento como objeto solto (o
// ConvertTo-Json some com o array). Sem isso, o computador com um disco só -
// que é o caso comum nas lojas - seria justamente o que o painel ignorava.
function comoLista(v) {
  if (Array.isArray(v)) return v;
  return v && typeof v === 'object' ? [v] : [];
}

// ------------------------------------------------------------------ disco

// O agente manda o que o Windows conseguiu ler naquela máquina - nem todo
// campo existe em todo lugar (SMART em disco USB, contador de confiabilidade
// sem permissão de administrador). Campo ausente vira null e simplesmente
// não participa do diagnóstico, em vez de virar zero e mentir.
function sanitizarDisco(disco) {
  if (!disco || typeof disco !== 'object') return null;
  const discos = comoLista(disco.discos).slice(0, DISCOS_MAX).map((d) => ({
    modelo: texto(d && d.modelo, 60),
    tipo: texto(d && d.tipo, 20),                       // SSD / HDD / desconhecido
    tamanhoGb: num(d && d.tamanhoGb, 0, 200000),
    saude: SAUDE_VALIDA.includes(d && d.saude) ? d.saude : 'desconhecida',
    // o SMART do Windows (MSStorageDriver_FailurePredictStatus) responde
    // exatamente isso: o proprio disco acha que vai falhar
    predicaoFalha: (d && d.predicaoFalha) === true,
    temperaturaC: num(d && d.temperaturaC, 0, 150),
    horasLigado: num(d && d.horasLigado, 0, 200000),
    errosLeitura: num(d && d.errosLeitura, 0, 1000000),   // contador do Windows, não é setor realocado do SMART
    desgastePct: num(d && d.desgastePct, 0, 100),       // só SSD
  })).filter((d) => d.modelo || d.tamanhoGb || d.saude !== 'desconhecida');
  const volumes = comoLista(disco.volumes).slice(0, VOLUMES_MAX).map((v) => {
    const totalGb = num(v && v.totalGb, 0, 200000);
    const livreGb = num(v && v.livreGb, 0, 200000);
    return {
      letra: texto(v && v.letra, 4),
      totalGb,
      livreGb,
      livrePct: totalGb ? Math.round((livreGb / totalGb) * 1000) / 10 : null,
    };
  }).filter((v) => v.letra && v.totalGb);
  if (!discos.length && !volumes.length) return null;
  return { discos, volumes, em: Date.now() };
}

// Traduz o bloco cru em "precisa fazer alguma coisa?". Devolve motivos em
// texto porque é isso que vai no push e no card - "crítico" sozinho não
// diz a ninguém o que trocar.
// RAM instalada/livre em GB, como o vigia manda (Medir-Ram). So numeros
// plausiveis: uma maquina de loja tem entre 1 e 512 GB.
function sanitizarRam(ram) {
  if (!ram || typeof ram !== 'object') return null;
  // num() ENCOSTA no limite (99999 viraria 512 GB); aqui fora da faixa e
  // descartado - RAM de mentira no card e pior que card sem RAM
  const plausivel = (v, min, max) => { const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? Math.round(n * 10) / 10 : null; };
  const totalGb = plausivel(ram.totalGb, 0.5, 512);
  if (totalGb == null) return null;
  const out = { totalGb };
  const livreGb = plausivel(ram.livreGb, 0, 512);
  if (livreGb != null) out.livreGb = Math.min(livreGb, totalGb);
  // Só processos de maior consumo quando a máquina está sob pressão. Nome e
  // megabytes são normalizados aqui porque vêm de um agente instalado, não de
  // uma tela autenticada; nunca guardamos linha de comando, usuário ou PID.
  const processos = (Array.isArray(ram.processos) ? ram.processos : [ram.processos])
    .filter(Boolean).map((p) => {
      const nome = String(p.nome || '').trim().replace(/[^a-zA-Z0-9._ -]/g, '').slice(0, 80);
      const mb = Number(p.mb);
      return nome && Number.isFinite(mb) && mb >= 1 && mb <= 262144
        ? { nome, mb: Math.round(mb) } : null;
    }).filter(Boolean).sort((a, b) => b.mb - a.mb).slice(0, 6);
  if (processos.length) out.processos = processos;
  return out;
}

function diagnosticoRam(ram) {
  if (!ram || ram.totalGb == null || ram.livreGb == null) return null;
  const processo = (ram.processos || [])[0] || null;
  const causa = processo ? `${processo.nome} usa cerca de ${processo.mb} MB` : null;
  if (ram.totalGb <= 4) {
    return {
      causa,
      acao: 'Capacidade limitada: ampliar para pelo menos 8 GB de RAM. Reiniciar alivia apenas temporariamente.',
    };
  }
  return {
    causa,
    acao: processo ? 'Revise o processo acima antes de encerrar qualquer aplicação de operação.' : 'Colete os processos de maior consumo antes de encerrar qualquer aplicação.',
  };
}

// Plano curto e acionável para o card da máquina. Ele não executa nada: só
// separa o que o NOC pode aliviar com segurança do que é limite físico e exige
// troca/upgrade. Isso evita a falsa promessa de que "limpar" resolve 4 GB de
// RAM ou SSD com falha prevista.
function planoOtimizar(disco, ram, uptimeHoras) {
  const plano = [];
  const volumes = (disco && disco.volumes) || [];
  const volumeApertado = volumes.reduce((piorVolume, volume) => (
    piorVolume == null || (volume.livrePct != null && volume.livrePct < piorVolume.livrePct) ? volume : piorVolume
  ), null);
  if (!disco && !ram && uptimeHoras == null) {
    return [{ prioridade: 'agora', tipo: 'diagnosticar', titulo: 'Coletar diagnóstico de desempenho', detalhe: 'Ainda não há telemetria suficiente para recomendar uma intervenção.' }];
  }
  if (ram && ram.totalGb <= 4) {
    plano.push({ prioridade: 'definitivo', tipo: 'hardware', titulo: 'Ampliar RAM para pelo menos 8 GB', detalhe: `${ram.totalGb} GB instalados limitam o Windows; limpeza e reinício só aliviam temporariamente.` });
  }
  if (ram && ram.livreGb != null && (ram.livreGb < RAM_LIVRE_ATENCAO_GB || (ram.livreGb / ram.totalGb) * 100 < RAM_LIVRE_ATENCAO_PCT)) {
    const principal = (ram.processos || [])[0];
    plano.push({ prioridade: 'agora', tipo: 'diagnosticar', titulo: 'Identificar consumo de memória', detalhe: principal ? `${principal.nome} está entre os maiores consumos; diagnostique antes de fechar aplicações.` : 'Faça um diagnóstico antes de encerrar qualquer aplicação da operação.' });
  }
  if (volumeApertado && volumeApertado.livrePct != null && volumeApertado.livrePct < LIVRE_ATENCAO_PCT) {
    plano.push({ prioridade: 'agora', tipo: 'limpar', titulo: 'Limpar arquivos temporários com segurança', detalhe: `${volumeApertado.letra} tem apenas ${volumeApertado.livrePct}% livre. A limpeza não toca em Downloads, documentos nem programas.` });
  }
  const discoRuim = (disco && disco.discos || []).some((d) => d.predicaoFalha || d.saude === 'ruim');
  if (discoRuim) plano.push({ prioridade: 'definitivo', tipo: 'hardware', titulo: 'Trocar o disco e copiar dados', detalhe: 'O Windows/SMART indica risco de falha; limpeza não corrige defeito físico.' });
  if (ciclosSemReiniciar(uptimeHoras) >= 1) {
    plano.push({ prioridade: 'agora', tipo: 'reiniciar', titulo: 'Programar reinício assistido', detalhe: 'Sete dias ou mais sem reiniciar acumulam atualizações e memória fragmentada.' });
  }
  return plano.length ? plano.slice(0, 4) : [{ prioridade: 'ok', tipo: 'monitorar', titulo: 'Manter monitoramento', detalhe: 'Nenhuma intervenção preventiva é indicada pela última medição.' }];
}

function avaliarRam(ram) {
  if (!ram || ram.totalGb == null || ram.livreGb == null) return { nivel: 'ok', motivos: [] };
  const livrePct = Math.round((ram.livreGb / ram.totalGb) * 1000) / 10;
  const detalhe = `RAM: só ${ram.livreGb} GB livres de ${ram.totalGb} GB (${livrePct}%)`;
  if (ram.livreGb < RAM_LIVRE_CRITICA_GB || livrePct < RAM_LIVRE_CRITICA_PCT) {
    return { nivel: 'critico', motivos: [detalhe] };
  }
  if (ram.livreGb < RAM_LIVRE_ATENCAO_GB || livrePct < RAM_LIVRE_ATENCAO_PCT) {
    return { nivel: 'atencao', motivos: [detalhe] };
  }
  return { nivel: 'ok', motivos: [] };
}

function avaliarDisco(disco) {
  if (!disco) return { nivel: 'ok', motivos: [] };
  let nivel = 'ok';
  const motivos = [];
  (disco.discos || []).forEach((d) => {
    const nome = d.modelo || d.tipo || 'disco';
    if (d.predicaoFalha) { nivel = pior(nivel, 'critico'); motivos.push(`${nome}: o próprio disco está prevendo falha (SMART)`); }
    if (d.saude === 'ruim') { nivel = pior(nivel, 'critico'); motivos.push(`${nome}: Windows marcou o disco como não saudável`); }
    else if (d.saude === 'atencao') { nivel = pior(nivel, 'atencao'); motivos.push(`${nome}: Windows marcou o disco em alerta`); }
    if (d.errosLeitura > 0) { nivel = pior(nivel, 'atencao'); motivos.push(`${nome}: ${d.errosLeitura} erro(s) de leitura não corrigido(s)`); }
    if (d.temperaturaC != null && d.temperaturaC >= TEMPERATURA_ALTA_C) { nivel = pior(nivel, 'atencao'); motivos.push(`${nome}: ${d.temperaturaC}°C`); }
    if (d.desgastePct != null && d.desgastePct >= 80) { nivel = pior(nivel, 'atencao'); motivos.push(`${nome}: ${d.desgastePct}% de desgaste do SSD`); }
    if (d.horasLigado != null && d.horasLigado >= HORAS_MUITO_USO) { nivel = pior(nivel, 'atencao'); motivos.push(`${nome}: ${Math.round(d.horasLigado / 8760)} anos ligado`); }
  });
  (disco.volumes || []).forEach((v) => {
    if (v.livrePct == null) return;
    if (v.livrePct < LIVRE_CRITICO_PCT) { nivel = pior(nivel, 'critico'); motivos.push(`${v.letra}: só ${v.livrePct}% livre (${v.livreGb} GB)`); }
    else if (v.livrePct < LIVRE_ATENCAO_PCT) { nivel = pior(nivel, 'atencao'); motivos.push(`${v.letra}: ${v.livrePct}% livre (${v.livreGb} GB)`); }
  });
  return { nivel, motivos };
}

// --------------------------------------------------- há quanto tempo ligado

// uptime REAL do Windows (LastBootUpTime), não o tempo que a aba do
// navegador está aberta - `abertoDesde` só existe nos computadores de
// atendimento e zera a cada reload, então nunca serviu pra isso.
const sanitizarUptime = (horas) => num(horas, 0, 200000);

const diasLigado = (horas) => (horas == null ? null : Math.floor(horas / 24));

// Quantas semanas inteiras a máquina passou sem reiniciar. É esse número - e
// não "já passou de 7 dias" - que decide o aviso: assim quem ignorou o
// primeiro é lembrado de novo na semana seguinte, sem ser lembrado todo dia.
const ciclosSemReiniciar = (horas) => {
  const d = diasLigado(horas);
  return d == null ? 0 : Math.floor(d / UPTIME_REINICIAR_DIAS);
};

// avisa quando entra numa semana nova sem reboot. Reiniciou? o ciclo volta a
// zero sozinho e o próximo aviso só sai daqui a 7 dias.
function avaliarUptime(horas, cicloAvisado) {
  const ciclo = ciclosSemReiniciar(horas);
  const dias = diasLigado(horas);
  return {
    dias,
    ciclo,
    precisaReiniciar: ciclo >= 1,
    avisarAgora: ciclo >= 1 && ciclo > (Number(cicloAvisado) || 0),
  };
}

// máquinas que passaram do prazo de reboot, a mais esquecida primeiro
function maquinasParaReiniciar(docs) {
  return docs
    .filter((d) => ciclosSemReiniciar(d.uptimeHoras) >= 1)
    .map((d) => ({ codigo: d.codigo, posto: d.posto, nome: d.nome, dias: diasLigado(d.uptimeHoras), em: d.uptimeEm || null }))
    .sort((a, b) => b.dias - a.dias);
}

// --------------------------------------------------------------- rede LAN

const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

function normalizarMac(v) {
  const limpo = String(v == null ? '' : v).trim().toLowerCase().replace(/-/g, ':');
  return MAC_RE.test(limpo) ? limpo : null;
}

// A varredura lê a tabela ARP que o Windows já mantém (quem esse computador
// conversou na rede da loja). Pra descobrir o NOME, o agente ainda faz uma
// consulta de DNS reverso / NetBIOS por aparelho - então ela não é 100%
// passiva como antes, mas continua sendo tráfego que qualquer máquina da
// rede faz o tempo todo: nada de varredura de portas, nada que acorde IDS
// de shopping.
function sanitizarDispositivos(entrada) {
  const lista = comoLista(entrada);
  if (!lista.length) return null;
  const vistos = new Set();
  const out = [];
  for (const d of lista) {
    const mac = normalizarMac(d && d.mac);
    const ip = d && IPV4_RE.test(String(d.ip || '').trim()) ? String(d.ip).trim() : null;
    if (!mac || !ip || vistos.has(mac)) continue;
    vistos.add(mac);
    out.push({ mac, ip, nome: texto(d && d.nome, 40) });
    if (out.length >= DISPOSITIVOS_MAX) break;
  }
  return out.length ? out : null;
}

// MAC "localmente administrado": o 2º dígito hexadecimal é 2, 6, A ou E.
// Não é chute nem tabela de fabricante - está no próprio endereço. Quem usa
// isso: celular com privacidade de MAC ligada (iPhone/Android modernos
// sorteiam um MAC por rede) e placa virtual (Hyper-V, VPN, container). Serve
// pra não perder tempo procurando "que aparelho é esse" numa coisa que muda
// de MAC sozinha na semana que vem.
function macAleatorio(mac) {
  const segundo = String(mac || '').charAt(1).toLowerCase();
  return ['2', '6', 'a', 'e'].includes(segundo);
}

// Junta a varredura de agora com o que já era conhecido. É isso que dá
// STATUS por aparelho: quem veio na varredura está `ativo`; quem estava na
// lista e não veio some da rede mas continua listado como inativo, com a
// hora em que foi visto pela última vez - é assim que se percebe que a
// impressora sumiu, e não só que "tem 6 aparelhos".
//
// A primeira varredura NÃO gera novidade nenhuma: ela vira a linha de base,
// senão o primeiro dia depois do deploy alertaria a rede inteira de uma vez
// e ninguém olharia o alerta de novo.
function mesclarDispositivos(anteriores, atuais, agora) {
  // formato antigo (só uma lista de MACs conhecidos) vira linha de base sem
  // detalhe nenhum, em vez de ser jogado fora
  const lista = comoLista(anteriores).map((d) => (typeof d === 'string' ? { mac: d } : d));
  const primeiraVez = !Array.isArray(anteriores) || !anteriores.length;
  const porMac = new Map(lista.filter((d) => d && d.mac).map((d) => [d.mac, { ...d, ativo: false }]));
  const novos = [];
  const mudaramIp = [];
  atuais.forEach((d) => {
    const antes = porMac.get(d.mac);
    if (!antes) {
      const registro = { mac: d.mac, ip: d.ip, nome: d.nome || null, desde: agora, visto: agora, ativo: true };
      porMac.set(d.mac, registro);
      if (!primeiraVez) novos.push(registro);
      return;
    }
    const ipAntes = antes.ip || null;
    const mudouIp = !!ipAntes && ipAntes !== d.ip;
    const ipHistorico = mudouIp
      ? [...(Array.isArray(antes.ipHistorico) ? antes.ipHistorico : []), { de: ipAntes, para: d.ip, em: agora }].slice(-IP_HISTORICO_MAX)
      : (Array.isArray(antes.ipHistorico) ? antes.ipHistorico : []);
    const atualizado = {
      ...antes,
      ip: d.ip,
      // nome só é sobrescrito quando a resolução DEU certo - senão um DNS
      // que falhou uma vez apagaria o nome que já tínhamos
      nome: d.nome || antes.nome || null,
      visto: agora,
      ativo: true,
      desde: antes.desde || agora,
      ipHistorico,
    };
    porMac.set(d.mac, atualizado);
    if (mudouIp) mudaramIp.push(atualizado);
  });
  // ativos primeiro, e dentro de cada grupo o visto mais recente na frente
  const todos = [...porMac.values()].sort((a, b) => (b.ativo ? 1 : 0) - (a.ativo ? 1 : 0) || (b.visto || 0) - (a.visto || 0));
  return { dispositivos: todos.slice(0, MACS_CONHECIDOS_MAX), novos, mudaramIp, primeiraVez };
}

// resumo por unidade pro painel: quantos aparelhos a loja enxerga e quantos
// computadores nossos estão entre eles (o resto é celular/impressora/TV)
function resumoDispositivos(docs) {
  const porUnidade = new Map();
  docs.forEach((d) => {
    if (!d.dispositivos || !d.dispositivos.length) return;
    if (!porUnidade.has(d.codigo)) porUnidade.set(d.codigo, { codigo: d.codigo, macs: new Set(), em: 0 });
    const u = porUnidade.get(d.codigo);
    // só os ATIVOS entram na conta: a lista guarda também quem sumiu, e
    // "12 aparelhos" contando os que já foram embora não é a rede da loja
    d.dispositivos.filter((x) => x.ativo !== false).forEach((x) => u.macs.add(x.mac));
    u.em = Math.max(u.em, d.dispositivosEm || 0);
  });
  return [...porUnidade.values()]
    .map((u) => ({ codigo: u.codigo, aparelhos: u.macs.size, em: u.em }))
    .sort((a, b) => b.aparelhos - a.aparelhos);
}

// UMA linha por computador com tudo que a central de saúde precisa mostrar,
// pior primeiro. Diferente das listas acima (que são filas de trabalho: só
// quem tem problema), aqui entra a frota inteira - inclusive quem ainda não
// mediu nada, que é uma informação em si ("o agente desse não subiu ainda").
function panorama(docs) {
  const linhas = docs.map((d) => {
    const disco = d.disco || null;
    const av = avaliarDisco(disco);
    const ram = sanitizarRam(d.ram);
    const ar = avaliarRam(ram);
    const dias = diasLigado(d.uptimeHoras);
    const precisaReiniciar = ciclosSemReiniciar(d.uptimeHoras) >= 1;
    // o pior entre disco e reboot vira o nível do CARD - quem olha no celular
    // decide pela cor da borda, não lendo cada campo
    let nivel = pior(av.nivel, ar.nivel);
    if (precisaReiniciar) nivel = pior(nivel, 'atencao');
    const motivos = [...av.motivos, ...ar.motivos];
    if (precisaReiniciar) motivos.push(`ligado há ${dias} dias sem reiniciar`);
    // o volume mais apertado é o que decide se a máquina vai travar
    const volumes = (disco && disco.volumes) || [];
    const volumeCritico = volumes.reduce((pi, v) => (
      pi == null || (v.livrePct != null && v.livrePct < pi.livrePct) ? v : pi), null);
    const temperatura = ((disco && disco.discos) || [])
      .reduce((max, x) => (x.temperaturaC != null && (max == null || x.temperaturaC > max) ? x.temperaturaC : max), null);
    return {
      codigo: d.codigo,
      posto: d.posto,
      nome: d.nome || d.posto,
      tipo: d.tipo || null,
      online: !!d.online,
      ultimoHeartbeatEm: d.ultimoHeartbeatEm || null,
      nivel,
      motivos,
      disco,
      volumeCritico,
      temperatura,
      // sem medição ainda: a central mostra isso como estado próprio em vez
      // de fingir que está tudo bem
      temMedicao: !!disco || !!ram || d.uptimeHoras != null,
      uptimeHoras: d.uptimeHoras != null ? d.uptimeHoras : null,
      uptimeDias: dias,
      precisaReiniciar,
      aparelhosRede: (d.dispositivos || []).filter((x) => x.ativo !== false).length,
      dispositivosEm: d.dispositivosEm || null,
      // ---- o resto do que a maquina ja reporta ----
      // Pedido do Master (13/09/2026): "também precisa aparecer todos os
      // dados do computador que já temos". Estava tudo no doc e so' a ficha
      // do NOC mostrava: quem abria a Saude via o disco e tinha que sair da
      // tela pra descobrir o IP ou a versao do agente da MESMA maquina.
      //
      // Nao custa leitura nova (e o mesmo documento ja lido) e nao inventa
      // campo nenhum: cada um destes ja existe e ja e' mostrado em
      // loja-status.html - aqui so' viaja junto.
      ram,
      ramDiagnostico: diagnosticoRam(ram),
      planoOtimizar: planoOtimizar(disco, ram, d.uptimeHoras),
      ramMedidaEm: d.ramMedidaEm || null,
      ipLocal: d.ipLocal || null,
      ip: d.ip || null,
      abertoDesde: d.abertoDesde || null,
      agenteVersao: d.agenteVersao || null,
      agenteNoPulsoPrint: d.agenteNoPulsoPrint || null,
      tailscale: d.tailscale || null,
      // o plano vem PRONTO ("todo dia as 04:00" / "seg a sex as 03:30"): a
      // regra de montar isso a partir de reinicioSemanal/reinicioDiario ja
      // existe no servidor (resumoDoPlano), e reimplementar no navegador
      // seria a segunda copia dela
      reinicioResumo: d.reinicioResumo || null,
      reinicioTolerancia: d.reinicioTolerancia != null ? d.reinicioTolerancia : null,
      ehServidor: !!d.ehServidor,
      ehNotebook: !!d.ehNotebook,
      anydeskId: d.anydeskId || null,
      // Resultado curto da última ação do NOC. A tela de saúde mostra só um
      // resumo, para confirmar a melhoria sem transformá-la em console.
      ultimoComandoEm: d.ultimoComandoEm || null,
      ultimoComandoResultado: d.ultimoComandoResultado || null,
      ultimoComandoErro: d.ultimoComandoErro || null,
    };
  });
  const peso = (l) => (l.nivel === 'critico' ? 0 : (l.nivel === 'atencao' ? 1 : (l.temMedicao ? 3 : 2)));
  return linhas.sort((a, b) => peso(a) - peso(b)
    || String(a.codigo).localeCompare(String(b.codigo))
    || String(a.nome).localeCompare(String(b.nome)));
}

// lista de discos com problema, pior primeiro - é a fila de trabalho da TI
function discosComProblema(docs) {
  return docs
    .map((d) => ({ codigo: d.codigo, posto: d.posto, nome: d.nome, disco: d.disco, ...avaliarDisco(d.disco) }))
    .filter((d) => d.nivel !== 'ok')
    .sort((a, b) => NIVEIS.indexOf(b.nivel) - NIVEIS.indexOf(a.nivel));
}

// ------------------------------------------------------------------ VMs
//
// So o HOST Hyper-V reporta isto (o agente devolve $null onde Get-VM nao
// existe). E' assim que se sabe que uma VM caiu: VM desligada nao consegue
// falar de si mesma - quem enxerga o estado real e' o host, que esta sempre
// ligado. Estados normalizados pra portugues, pra tela e pro alerta lerem
// igual (o Windows devolve Running/Off/Saved/Paused).
function normalizarEstadoVm(e) {
  const t = String(e == null ? '' : e).toLowerCase();
  if (/run|execu/.test(t)) return 'Executando';
  if (/off|deslig/.test(t)) return 'Desligada';
  if (/save|salv/.test(t)) return 'Salva';
  if (/paus/.test(t)) return 'Pausada';
  return texto(e, 20) || 'Desconhecido';
}
// null = o agente NAO reportou VMs (maquina comum, sem Hyper-V) -> nao mexe em
// nada. [] = host Hyper-V que hoje nao tem VM nenhuma. Ordenado por nome pra
// comparacao estavel (senao a ordem do Get-VM faria parecer "mudou" sem mudar).
function sanitizarVms(vms) {
  if (!Array.isArray(vms)) return null;
  const out = vms
    .map((v) => ({ nome: texto(v && v.nome, 80), estado: normalizarEstadoVm(v && v.estado) }))
    .filter((v) => v.nome)
    .slice(0, 200)
    .sort((a, b) => a.nome.localeCompare(b.nome));
  return out;
}
// VM que estava Executando e agora NAO esta = queda inesperada. VM que ja
// estava desligada (voce a deixou assim de proposito) nao gera nada: sem
// transicao a partir de Executando, sem alarme - foi a decisao do Master
// ("so avisar quando cair").
function quedasDeVm(antesArr, depoisArr) {
  const antes = {};
  (Array.isArray(antesArr) ? antesArr : []).forEach((v) => { if (v && v.nome) antes[v.nome] = v.estado; });
  const caidas = [];
  for (const v of (Array.isArray(depoisArr) ? depoisArr : [])) {
    if (antes[v.nome] === 'Executando' && v.estado !== 'Executando') {
      caidas.push({ nome: v.nome, estado: v.estado });
    }
  }
  return caidas;
}

module.exports = {
  LIVRE_CRITICO_PCT, LIVRE_ATENCAO_PCT, RAM_LIVRE_CRITICA_GB, RAM_LIVRE_ATENCAO_GB, RAM_LIVRE_CRITICA_PCT, RAM_LIVRE_ATENCAO_PCT, TEMPERATURA_ALTA_C, DISPOSITIVOS_MAX,
  UPTIME_REINICIAR_DIAS,
  sanitizarDisco, avaliarDisco, sanitizarRam, avaliarRam, diagnosticoRam, planoOtimizar, sanitizarVms, quedasDeVm, normalizarEstadoVm, sanitizarDispositivos, mesclarDispositivos, macAleatorio,
  sanitizarUptime, avaliarUptime, maquinasParaReiniciar,
  resumoDispositivos, discosComProblema, panorama,
};
