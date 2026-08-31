// impressoraStatus.js
// LER O ESTADO DA ZEBRA PELA REDE, e decidir o que vira alarme.
//
// POR QUE ISSO EXISTE: o alarme de impressora que existia era "sumiu da
// rede", e demorava ~2h (a varredura ARP do agente e de hora em hora, e a
// carencia e de 2 ciclos - ver DISPOSITIVO_OFFLINE_LIMIAR_MS). Pior: uma
// Zebra sem papel, com a cabeca aberta ou com a fila travada continua
// respondendo na rede. Pra operacao ela parou; pro NOC ela estava "ok".
//
// O PEDIDO ORIGINAL DO MASTER ERA "avisar quando o spooler passar de 3
// arquivos". O Spooler do Windows nao esta no caminho - as impressoras
// imprimem direto por socket na porta 9100. Mas a Zebra tem uma fila
// PROPRIA, e o ~HS devolve quantos formatos estao nela: e exatamente o
// numero que ele queria, so que vindo da impressora em vez do Windows.
//
// ONDE O PARSE MORA, e por que aqui e nao no agente: mudar o agente custa
// bump de VERSAO_VIGIA e re-propagacao pras 52 maquinas (§1 do CLAUDE.md).
// O agente so pergunta e devolve o texto CRU; quem interpreta e' o
// servidor, que muda com um deploy. Se o parse estiver errado num modelo,
// conserta aqui sem tocar em maquina de loja.
//
// O PARSE FOI FEITO EM CIMA DE UMA RESPOSTA REAL, nao do manual: uma Zebra
// 203dpi (832 dots, 8/mm), firmware V89.21.37Z, na Dominos Caruaru. As tres
// linhas vieram assim:
//
//   030,0,0,0394,000,0,0,0,000,0,0,0
//   001,0,0,0,1,2,6,0,00000000,1,000
//   0000,0
//
// e conferem com o ^HH da MESMA impressora em tres pontos independentes:
// LABEL LENGTH 0394 (campo 4 da linha 1), THERMAL-TRANS. (campo 5 da linha
// 2 = 1) e TEAR OFF (campo 6 da linha 2 = 2). E' o que sustenta a leitura
// dos outros campos.
'use strict';

// STX (0x02) abre e ETX (0x03) fecha cada uma das 3 linhas; o par CR+LF
// separa. Nada disso e' texto - por isso o agente manda o cru e a limpeza
// acontece aqui.
const STX = String.fromCharCode(2);
const ETX = String.fromCharCode(3);

// fila propria da impressora acima disso = "acumulando". O Master pediu
// "mais de 3 arquivos"; env pra ajustar sem deploy se a operacao mostrar
// que 3 e' apertado demais num pico normal.
const FILA_LIMITE = Number(process.env.IMPRESSORA_FILA_LIMITE) > 0
  ? Number(process.env.IMPRESSORA_FILA_LIMITE) : 3;

// quantas leituras seguidas com o MESMO problema antes de alarmar. Uma
// leitura isolada e' ruido: a fila enche por 2 segundos no meio de um lote,
// a cabeca fica "aberta" no instante em que o operador troca a bobina.
const LEITURAS_PRA_CONFIRMAR = Number(process.env.IMPRESSORA_LEITURAS_CONFIRMAR) > 0
  ? Number(process.env.IMPRESSORA_LEITURAS_CONFIRMAR) : 2;

function inteiro(v) {
  const n = parseInt(String(v == null ? '' : v).trim(), 10);
  return Number.isFinite(n) ? n : null;
}
const bit = (v) => inteiro(v) === 1;

// ---------------------------------------------------------------
// parse do ~HS
// ---------------------------------------------------------------
// Devolve null quando NAO deu pra entender - e null aqui nunca vira alarme
// (ver avaliar): "nao consegui ler" e' um estado, nao um defeito. Alarmar
// por falha de leitura seria o jeito mais rapido de treinar a operacao a
// ignorar o alarme.
function parseStatusZebra(bruto) {
  const texto = String(bruto == null ? '' : bruto);
  if (!texto.trim()) return null;
  const linhas = texto
    .split(/[\r\n]+/)
    .map((l) => l.split(STX).join('').split(ETX).join('').trim())
    .filter((l) => l.length > 0);
  if (linhas.length < 2) return null;

  const a = linhas[0].split(',');
  const b = linhas[1].split(',');
  // 12 e 11 campos e' o formato do ~HS. Menos que isso nao e' resposta de
  // ~HS - pode ser eco de outro comando, ou um modelo que responde diferente
  if (a.length < 12 || b.length < 11) return null;
  // a linha 1 tem que ser numerica de ponta a ponta; se vier texto no meio,
  // nao e' o ~HS e um parse "na marra" inventaria estado
  if (a.slice(0, 12).some((c) => inteiro(c) === null)) return null;

  const transferencia = bit(b[4]);
  return {
    // --- linha 1: aaa,b,c,dddd,eee,f,g,h,iii,j,k,l ---
    papelAcabou: bit(a[1]),
    pausada: bit(a[2]),
    // dots. Confere com LABEL LENGTH do ^HH - e a ancora que prova o parse
    comprimentoEtiqueta: inteiro(a[3]),
    // a fila DA IMPRESSORA (formatos no buffer de recepcao)
    fila: inteiro(a[4]),
    bufferCheio: bit(a[5]),
    ramCorrompida: bit(a[9]),
    temperaturaBaixa: bit(a[10]),
    temperaturaAlta: bit(a[11]),
    // --- linha 2: mmm,n,o,p,q,r,s,t,uuuuuuuu,v,www ---
    cabecaAberta: bit(b[2]),
    ribbonAcabou: bit(b[3]),
    // 1 = transferencia termica (usa ribbon), 0 = termica direta (nao usa).
    // Sem isso, "ribbon acabou" viraria alarme eterno em impressora que nem
    // ribbon tem.
    transferencia,
    modoImpressao: inteiro(b[5]),
    etiquetasRestantes: inteiro(b[8]),
  };
}

// ---------------------------------------------------------------
// o que vira alarme
// ---------------------------------------------------------------
// nivel: 'critico' (parou de imprimir), 'atencao' (vai parar / ja esta
// atrasando), 'ok', ou 'desconhecido' (nao deu pra checar - NAO alarma).
// Cada motivo sai em texto pronto pra notificacao, com o fato e o numero
// (tom de voz do §5): "Fila com 7 trabalhos", nao "algo deu errado".
function avaliar(status) {
  if (!status) return { nivel: 'desconhecido', motivos: [], chave: 'desconhecido' };
  const criticos = [];
  const atencao = [];

  if (status.papelAcabou) criticos.push('Sem papel');
  if (status.cabecaAberta) criticos.push('Cabeça aberta');
  if (status.transferencia && status.ribbonAcabou) criticos.push('Sem ribbon');
  if (status.ramCorrompida) criticos.push('Memória corrompida');
  if (status.pausada) atencao.push('Impressora pausada');
  if (status.bufferCheio) atencao.push('Buffer cheio');
  if (status.fila != null && status.fila > FILA_LIMITE) {
    atencao.push(`Fila com ${status.fila} trabalho(s) parados`);
  }
  if (status.temperaturaAlta) atencao.push('Cabeça superaquecida');
  if (status.temperaturaBaixa) atencao.push('Cabeça fria demais pra imprimir');

  const motivos = [...criticos, ...atencao];
  const nivel = criticos.length ? 'critico' : (atencao.length ? 'atencao' : 'ok');
  // a chave e' o que decide se o problema e' o MESMO da leitura anterior -
  // por isso inclui os motivos, e nao so o nivel. Papel acabando depois de
  // uma fila travada sao dois problemas, e os dois merecem aviso.
  return { nivel, motivos, chave: `${nivel}:${motivos.join('|')}` };
}

// ---------------------------------------------------------------
// confirmacao por repeticao
// ---------------------------------------------------------------
// Recebe o estado guardado (streak anterior) e o de agora; devolve o novo
// estado e se e' hora de avisar. Avisa UMA vez por problema: enquanto a
// chave nao mudar, nao repete - senao o alarme vira paisagem.
function decidirAviso(anterior, agora) {
  const ant = anterior || {};
  const mesmaChave = ant.chave === agora.chave;
  const repeticoes = mesmaChave ? (Number(ant.repeticoes) || 0) + 1 : 1;
  const problema = agora.nivel === 'critico' || agora.nivel === 'atencao';

  // voltou ao normal depois de ter avisado: avisa a volta e limpa
  if (!problema && ant.avisado) {
    return {
      estado: { chave: agora.chave, nivel: agora.nivel, repeticoes, avisado: false },
      avisar: null,
      normalizou: { de: ant.motivos || [] },
    };
  }
  const confirmado = problema && repeticoes >= LEITURAS_PRA_CONFIRMAR;
  const jaAvisado = mesmaChave && ant.avisado;
  return {
    estado: {
      chave: agora.chave,
      nivel: agora.nivel,
      motivos: agora.motivos,
      repeticoes,
      avisado: jaAvisado || (confirmado && !jaAvisado),
    },
    avisar: confirmado && !jaAvisado ? { nivel: agora.nivel, motivos: agora.motivos } : null,
    normalizou: null,
  };
}

// ---------------------------------------------------------------
// o que o agente manda
// ---------------------------------------------------------------
// [{ mac, ip, bruto }] - `bruto` e' a resposta do ~HS como veio, ou vazio
// quando nao respondeu. Corta tamanho e quantidade: e' entrada de rede,
// nao pode inchar o documento nem virar vetor de payload gigante.
const MAX_IMPRESSORAS = 8;
const MAX_BRUTO = 2000;
function sanitizarStatusImpressoras(lista) {
  if (!Array.isArray(lista)) return null;
  const out = [];
  for (const item of lista.slice(0, MAX_IMPRESSORAS)) {
    const mac = String((item && item.mac) || '').trim().toLowerCase();
    if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac)) continue;
    out.push({
      mac,
      ip: String((item && item.ip) || '').trim().slice(0, 45) || null,
      bruto: String((item && item.bruto) || '').slice(0, MAX_BRUTO),
    });
  }
  return out.length ? out : null;
}

module.exports = {
  parseStatusZebra, avaliar, decidirAviso, sanitizarStatusImpressoras,
  FILA_LIMITE, LEITURAS_PRA_CONFIRMAR,
};
