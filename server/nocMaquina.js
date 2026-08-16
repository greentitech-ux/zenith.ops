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
const TEMPERATURA_ALTA_C = 60;  // acima disso a vida útil despenca
const HORAS_MUITO_USO = 35000;  // ~4 anos ligado direto: disco em fim de vida
const DISCOS_MAX = 6;
const VOLUMES_MAX = 8;
// teto de aparelhos guardados por computador. Uma loja de shopping tem
// dezenas de celulares entrando e saindo do wifi - guardar todos incharia o
// documento sem informar mais nada.
const DISPOSITIVOS_MAX = 60;
const MACS_CONHECIDOS_MAX = 250;

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

// --------------------------------------------------------------- rede LAN

const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

function normalizarMac(v) {
  const limpo = String(v == null ? '' : v).trim().toLowerCase().replace(/-/g, ':');
  return MAC_RE.test(limpo) ? limpo : null;
}

// A varredura é PASSIVA de propósito: o agente só lê a tabela ARP que o
// Windows já mantém (quem o computador conversou na rede local). Não dispara
// pacote nenhum, então não acorda IDS de shopping nem é confundida com
// scanner hostil - e não custa banda numa loja que já está com link ruim.
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
    out.push({ mac, ip });
    if (out.length >= DISPOSITIVOS_MAX) break;
  }
  return out.length ? out : null;
}

// Aparelho "novo" = MAC que esse computador nunca tinha visto. A primeira
// varredura NÃO gera novidade nenhuma: ela vira a linha de base, senão o
// primeiro dia depois do deploy alertaria a rede inteira de uma vez e
// ninguém olharia o alerta de novo.
function diffDispositivos(conhecidos, atuais) {
  const base = Array.isArray(conhecidos) ? conhecidos : null;
  const macsAtuais = atuais.map((d) => d.mac);
  const novaBase = [...new Set([...(base || []), ...macsAtuais])].slice(-MACS_CONHECIDOS_MAX);
  if (!base) return { novos: [], conhecidos: novaBase, primeiraVez: true };
  const jaConhecido = new Set(base);
  return { novos: atuais.filter((d) => !jaConhecido.has(d.mac)), conhecidos: novaBase, primeiraVez: false };
}

// resumo por unidade pro painel: quantos aparelhos a loja enxerga e quantos
// computadores nossos estão entre eles (o resto é celular/impressora/TV)
function resumoDispositivos(docs) {
  const porUnidade = new Map();
  docs.forEach((d) => {
    if (!d.dispositivos || !d.dispositivos.length) return;
    if (!porUnidade.has(d.codigo)) porUnidade.set(d.codigo, { codigo: d.codigo, macs: new Set(), em: 0 });
    const u = porUnidade.get(d.codigo);
    d.dispositivos.forEach((x) => u.macs.add(x.mac));
    u.em = Math.max(u.em, d.dispositivosEm || 0);
  });
  return [...porUnidade.values()]
    .map((u) => ({ codigo: u.codigo, aparelhos: u.macs.size, em: u.em }))
    .sort((a, b) => b.aparelhos - a.aparelhos);
}

// lista de discos com problema, pior primeiro - é a fila de trabalho da TI
function discosComProblema(docs) {
  return docs
    .map((d) => ({ codigo: d.codigo, posto: d.posto, nome: d.nome, disco: d.disco, ...avaliarDisco(d.disco) }))
    .filter((d) => d.nivel !== 'ok')
    .sort((a, b) => NIVEIS.indexOf(b.nivel) - NIVEIS.indexOf(a.nivel));
}

module.exports = {
  LIVRE_CRITICO_PCT, LIVRE_ATENCAO_PCT, TEMPERATURA_ALTA_C, DISPOSITIVOS_MAX,
  sanitizarDisco, avaliarDisco, sanitizarDispositivos, diffDispositivos,
  resumoDispositivos, discosComProblema,
};
