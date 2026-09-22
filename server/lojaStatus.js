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
const net = require('net');
const db = require('./firestore');
const { createCache } = require('./liveCache');
const redeDiagnostico = require('./redeDiagnostico');
const nocMaquina = require('./nocMaquina');
const impressoraStatus = require('./impressoraStatus');
const ouiFabricantes = require('./ouiFabricantes');
const unidades = require('./unidades');
const empresas = require('./empresas');

const COLLECTION = db.collection('lojaStatus');
// fila de comandos do agente (ver agenteAcoes.js) - histórico completo de
// cada comando enviado a um computador tipo 'interno', com resultado. O
// O documento do computador guarda a fila ordenada e também o ponteiro para a
// cabeça (comandoPendenteId). O ponteiro mantém o heartbeat barato; a fila
// permite o Master preparar várias ações sem uma apagar a outra.
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

// Catálogo fechado para a tela de Programas. A tela nunca manda um comando ou
// uma URL: ela escolhe apenas um ID desta lista, e o servidor monta o comando.
// Isso mantém "instalar pelo NOC" útil sem virar um PowerShell remoto aberto.
const CATALOGO_PROGRAMAS_PADRAO = [
  { id: 'google-chrome', nome: 'Google Chrome', wingetId: 'Google.Chrome', descricao: 'Navegador Google Chrome' },
  { id: 'anydesk', nome: 'AnyDesk', wingetId: 'AnyDeskSoftwareGmbH.AnyDesk', descricao: 'Acesso remoto AnyDesk' },
  { id: 'advanced-ip-scanner', nome: 'Advanced IP Scanner', wingetId: 'Famatech.AdvancedIPScanner', descricao: 'Varredura de rede' },
  { id: 'ifood-gestor', nome: 'iFood Gestor', wingetId: 'ifood.ifood', descricao: 'Gestor de Pedidos iFood' },
];

function catalogoProgramasSeguro(lista) {
  const vistos = new Set();
  return (Array.isArray(lista) ? lista : []).map((item) => {
    const nome = String(item?.nome || '').trim().slice(0, 80);
    const wingetId = String(item?.wingetId || '').trim();
    const id = String(item?.id || wingetId.toLowerCase().replace(/[^a-z0-9]+/g, '-')).replace(/^-+|-+$/g, '').slice(0, 80);
    const descricao = String(item?.descricao || '').trim().slice(0, 160);
    if (!id || !nome || !/^[A-Za-z0-9][A-Za-z0-9._-]{1,120}$/.test(wingetId) || vistos.has(id)) return null;
    vistos.add(id);
    return { id, nome, wingetId, descricao };
  }).filter(Boolean);
}

async function listarCatalogoProgramas() {
  const config = await getConfig();
  const salvo = catalogoProgramasSeguro(config.catalogoProgramas);
  return salvo.length ? salvo : CATALOGO_PROGRAMAS_PADRAO;
}

async function salvarCatalogoProgramas(lista) {
  const catalogo = catalogoProgramasSeguro(lista);
  if (!catalogo.length) throw new Error('O catálogo precisa ter ao menos um programa válido.');
  await setConfig({ catalogoProgramas: catalogo });
  return catalogo;
}

function aspasPowerShell(valor) { return `'${String(valor).replace(/'/g, "''")}'`; }

function comandoInstalarCatalogo(item) {
  // item já passou pela validação do catálogo; repetir a validação evita que
  // alguém use esta função no futuro sem passar pela fronteira acima.
  if (!item || !/^[A-Za-z0-9][A-Za-z0-9._-]{1,120}$/.test(item.wingetId || '')) throw new Error('Item de catálogo inválido.');
  return [
    '$winget = (Get-Command winget.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source)',
    'if (-not $winget) { "FALHOU: winget não está disponível nesta máquina. Atualize o App Installer do Windows e tente novamente."; exit 1 }',
    `$id = ${aspasPowerShell(item.wingetId)}`,
    `$nome = ${aspasPowerShell(item.nome)}`,
    'Write-Output ("Instalando " + $nome + " pelo catálogo aprovado...")',
    '& $winget install --id $id --exact --silent --accept-package-agreements --accept-source-agreements --disable-interactivity',
    '$codigo = $LASTEXITCODE',
    'if ($codigo -eq 0) { "OK: instalação concluída. A lista de programas será atualizada na próxima varredura." } else { "FALHOU: winget retornou o código $codigo."; exit $codigo }',
  ].join('\n');
}

function programaPodeSerRemovido(nome) {
  const n = String(nome || '').trim();
  if (!n || n.length > 180) return false;
  // Componentes que costumam quebrar Windows, o próprio agente e runtimes
  // compartilhados ficam fora da remoção remota. Para eles, a intervenção é
  // presencial/assistida e consciente, nunca um clique no painel.
  return !/(nopulso|noczenith|microsoft edge|visual c\+\+|windows update|update for .*windows|microsoft windows)/i.test(n);
}

function comandoRemoverPrograma(nome) {
  if (!programaPodeSerRemovido(nome)) throw new Error('Esse componente é protegido e não pode ser removido remotamente pelo NOC.');
  return [
    `$nome = ${aspasPowerShell(nome)}`,
    '$raizes = @(\'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*\', \'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*\')',
    '$item = @(Get-ItemProperty -Path $raizes -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq $nome -and ($_.QuietUninstallString -or ($_.UninstallString -match \'(?i)msiexec\')) } | Select-Object -First 1)',
    'if (-not $item) { "FALHOU: o programa não tem um desinstalador silencioso registrado no sistema. Para não abrir uma janela invisível ao usuário, ele não pode ser removido remotamente."; exit 1 }',
    '$linha = if ($item[0].QuietUninstallString) { $item[0].QuietUninstallString } else { $item[0].UninstallString }',
    'if ($linha -match \'(?i)msiexec(\\.exe)?\') { $args = "/x $($item[0].PSChildName) /qn /norestart"; $p = Start-Process -FilePath msiexec.exe -ArgumentList $args -Wait -PassThru -WindowStyle Hidden }',
    'else { $p = Start-Process -FilePath cmd.exe -ArgumentList \'/c\', $linha -Wait -PassThru -WindowStyle Hidden }',
    'if ($p.ExitCode -eq 0 -or $p.ExitCode -eq 3010) { "OK: remoção concluída. A lista será atualizada na próxima varredura." } else { "FALHOU: o desinstalador retornou o código $($p.ExitCode)."; exit $p.ExitCode }',
  ].join('\n');
}
// ---- PAPEL DE PAREDE: UMA ARTE POR MARCA, NAO UMA POR MAQUINA ----
//
// O que muda de um PDV pro outro e so o NOME da maquina, e quem carimba o
// nome e o proprio agente, na tela dela (ver Aplicar-PapelDeParede no
// vigiaScript.js). O servidor nunca compoe imagem: nao tem biblioteca de
// imagem no projeto e por em teria custo de deploy pra desenhar uma linha de
// texto que a maquina desenha de graca.
//
// A MARCA sai do perfil da unidade (unidades.js, MARCAS_VALIDAS) - o mesmo
// cadastro que o Master ja preenche. Nao ha campo novo de marca em lugar
// nenhum, e marca NAO se deduz do nome da loja: "Spoleto Domino's Aeroporto"
// tem as duas no nome (o motivo esta escrito no proprio unidades.js).
//
// Sem marca, ou marca sem arte enviada: cai no papel de parede do parque, que
// e exatamente o comportamento de antes desta mudanca.
// A arte carrega DUAS logos: a do grupo e a da marca. Por isso a chave e
// GRUPO x MARCA, e nao so a marca: Domino's existe em mais de um grupo, entao
// arte so por marca poria a logo do grupo errado na tela da loja.
//
// O GRUPO SAI DE empresas.js, E NAO DE redes.js - correcao de 14/09/2026.
// Regra do Master: "maquinas do Grupo Bravo, logo Bravo; maquinas da ARCFOOD,
// logo ARCFOOD; maquinas da ESTACAO, Estacao, e assim vai".
//
// redes.js so conhece DOIS valores (ARCFOOD e GBE) e, pior, GBE e' "o resto":
// uma maquina da Estacao cairia calada no Grupo Bravo e mostraria a logo
// errada na tela da loja. empresas.js e' cadastro de verdade - colecao que o
// Master edita, uma unidade pertence a no maximo uma empresa, e NAO existe
// catch-all: unidade que ninguem listou nao pertence a ninguem. E' exatamente
// o "e assim vai": grupo novo e' um cadastro, nao uma linha de codigo.
//
// Sem empresa, a maquina cai na arte da marca. Nunca se CHUTA um grupo - por
// isso o degrau do meio existe.
//
// Tres degraus, do mais especifico pro mais generico, e cada um so existe se
// alguem tiver enviado a arte:
//   GBE:dominos  ->  dominos  ->  papel de parede do parque
// O degrau do meio e o que ja estava no ar antes desta mudanca; quem so tem
// arte por marca continua funcionando igual.
const chaveArte = (rede, marca) => `${rede}:${marca}`;

// A precedência não é permanente pelo tipo de arte. Quem manda é o último
// envio: uma arte em massa nova substitui as individuais antigas; se o Master
// salvar uma arte individual depois dela, apenas aquela máquina volta a usar
// a arte própria até o próximo envio em massa. `em` é gravado em todos os
// uploads; `versao` mantém compatibilidade com artes antigas.
function momentoDaArte(arte) {
  return Number((arte && (arte.em || arte.versao)) || 0);
}

function maisRecenteEntreArtes(artes) {
  return (artes || []).filter((arte) => arte && arte.caminho).reduce((melhor, arte) => {
    if (!melhor) return arte;
    // Empate preserva a ordem recebida: grupo > marca > parque.
    return momentoDaArte(arte) > momentoDaArte(melhor) ? arte : melhor;
  }, null);
}

async function papelDeParedeDe(codigo, posto) {
  const cfg = await getConfig();
  // A arte individual só ganha enquanto for MAIS NOVA que a massa. Isso evita
  // uma personalização antiga prender uma máquina no visual anterior quando o
  // Master publica uma campanha nova para todo o parque.
  // Sai do espelho em memória, sem custo de leitura (§3).
  let daMaquina = null;
  if (posto) {
    try {
      const doc = (await garantirEspelho()).get(docIdFor(codigo, posto));
      daMaquina = doc && doc.papelDeParedeArte && doc.papelDeParedeArte.caminho ? doc.papelDeParedeArte : null;
    } catch (e) { /* sem espelho: cai no fluxo normal */ }
  }
  const doParque = cfg && cfg.papelDeParede && cfg.papelDeParede.caminho ? cfg.papelDeParede : null;
  // perfil() devolve null pra unidade que nunca foi cadastrada em runtime -
  // nesse caso nao ha marca e a maquina cai no papel de parede do parque
  const perfilUnidade = await unidades.perfil(codigo).catch(() => null);
  const marca = (perfilUnidade && perfilUnidade.marca) || null;
  const empresa = await empresas.empresaDaUnidade(codigo).catch(() => null);
  const rede = empresa && empresa.id ? String(empresa.id) : null;
  const porMarca = (cfg && cfg.papelDeParedePorMarca) || {};
  const temArte = (k) => (k && porMarca[k] && porMarca[k].caminho ? porMarca[k] : null);
  const doGrupo = marca && rede ? temArte(chaveArte(rede, marca)) : null;
  const soMarca = marca ? temArte(marca) : null;
  // Em empate, a ordem preserva a especificidade que já existia: grupo,
  // marca e por último parque. Em envios diferentes, vence sempre o recente.
  const massa = maisRecenteEntreArtes([doGrupo, soMarca, doParque]);
  const massaComOrigem = !massa ? null
    : massa === doGrupo ? { ...massa, marca, rede }
      : massa === soMarca ? { ...massa, marca, rede: null }
        : { ...massa, marca: null, rede: null };
  if (daMaquina && (!massaComOrigem || momentoDaArte(daMaquina) > momentoDaArte(massaComOrigem))) {
    // Arte exclusiva já vem pronta (loja/código/logos), portanto não recebe
    // carimbo adicional. Ela só chega aqui quando foi salva após a massa.
    return { ...daMaquina, marca: null, rede: null, daMaquina: true };
  }
  return massaComOrigem;
}

// Versao que o AGENTE compara pra decidir se reaplica.
//
// O bug que isto conserta: a politica so era reaplicada quando politicaVersao
// mudava, e trocar a IMAGEM nao mexia nessa versao. Na pratica o Master subia
// arte nova e nenhuma maquina trocava - a tela do NOC dizia que trocava.
// Juntando as duas versoes numa so, subir imagem nova ja e motivo de
// reaplicar, sem inventar rota de "forcar".
//
// Fica em campo SEPARADO em vez de bagunçar politicaVersao: aquela e a versao
// da politica, contada de 1 em 1, e tem tela e teste que leem como numero.
function versaoAplicacao(politicaVersao, arte) {
  return `${Number(politicaVersao || 0)}.${(arte && arte.versao) || 0}`;
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
// MARCA da impressora. Existe por um motivo de seguranca, nao de cadastro:
// a sonda manda "~HS" na porta 9100, que e' ZPL. Uma Zebra responde o
// status; uma BEMATECH (ESC/POS) trata byte recebido como coisa PRA
// IMPRIMIR - ela imprimiria "~HS" num cupom a cada ciclo da sonda. Por isso
// so 'zebra' e' sondada, e o padrao (null) NAO sonda: marcar uma impressora
// como monitorada tem que ser seguro mesmo sem escolher a marca.
const MARCAS_IMPRESSORA = new Set(['zebra', 'bematech', 'outra']);
function idDaMarca(v) {
  const m = String(v == null ? '' : v).trim().toLowerCase();
  return MARCAS_IMPRESSORA.has(m) ? m : null;
}

// MEDIDOR DE QUEDAS DA UNIDADE (pedido do Master, 14/09/2026):
// "preciso poder marcar como medidor de quedas da unidade - um equipamento que
// nao tem acesso, como um Modem, para ser o ponto de medicao".
//
// POR QUE ISSO E' MELHOR QUE MEDIR PELO COMPUTADOR
// O NOC ja sabe quando o AGENTE para de bater. So que o computador da loja e'
// desligado ao fechar, cai em atualizacao do Windows, o funcionario puxa da
// tomada - e nada disso e' queda de rede. O modem, nao: ele fica ligado. Um
// equipamento que ninguem mexe e' uma referencia honesta.
//
// O QUE ISSO MEDE, COM PRECISAO (§6 - nao prometer o que o dado nao da)
// Mede o EQUIPAMENTO sumir da rede da loja, nao o link de internet cair. Se o
// modem continua ligado e so a internet do provedor some, ele segue
// respondendo na rede - quem denuncia esse caso e' o heartbeat do agente
// parando de chegar no servidor, que ja existe. Os dois juntos e' que separam:
//   agente parou + medidor sumiu   -> a loja inteira caiu (energia/link)
//   agente parou + medidor de pe   -> foi o computador
//   agente de pe  + medidor sumiu  -> o modem/roteador morreu
// Um so dos dois nunca conta essa historia.
function normalizarEntradaApelido(valor) {
  if (typeof valor === 'string') return { apelido: valor || null, tipo: null, monitorar: false, marca: null, medidorQuedas: false };
  if (valor && typeof valor === 'object') {
    const medidorQuedas = !!valor.medidorQuedas;
    return {
      apelido: typeof valor.apelido === 'string' && valor.apelido ? valor.apelido : null,
      tipo: idDoTipoDispositivo(valor.tipo) || null,
      // medidor SEMPRE monitorado: nao da pra medir queda de um equipamento que
      // a varredura nao esta acompanhando
      monitorar: medidorQuedas || !!valor.monitorar,
      marca: idDaMarca(valor.marca),
      medidorQuedas,
    };
  }
  return { apelido: null, tipo: null, monitorar: false, marca: null, medidorQuedas: false };
}

// O MAC é a identidade do equipamento; IP é apenas o endereço atual. Todo
// aparelho categorizado no NOC entra no histórico/alerta de troca de IP,
// mesmo sem alarme para quando SUMIR da rede. Isso evita que o checkbox de
// queda esconda DHCP de impressora, PULSE, GCOM, VM Host ou tipo criado pelo
// Master, sem transformar aparelho aleatório em notificação.
function acompanhaIpPorMac(cfg) {
  return !!(cfg && cfg.tipo);
}
// quem e' o medidor daquela unidade (ou null)
function medidorDaUnidade(daUnidade) {
  const achado = Object.entries(daUnidade || {}).find(([, v]) => normalizarEntradaApelido(v).medidorQuedas);
  return achado ? achado[0] : null;
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
  const medidorQuedas = corpo.medidorQuedas !== undefined ? !!corpo.medidorQuedas : anterior.medidorQuedas;
  // medidor e' UM por unidade. Dois pontos de medicao dariam duas versoes da
  // mesma queda, e ninguem saberia qual e' a da loja.
  if (medidorQuedas) {
    Object.keys(daUnidade).forEach((outro) => {
      if (outro === macOk) return;
      const cfg = normalizarEntradaApelido(daUnidade[outro]);
      if (cfg.medidorQuedas) daUnidade[outro] = { ...cfg, medidorQuedas: false };
    });
  }
  const monitorar = medidorQuedas || (corpo.monitorar !== undefined ? !!corpo.monitorar : anterior.monitorar);
  const marca = corpo.marca !== undefined ? idDaMarca(corpo.marca) : anterior.marca;
  if (!limpo && !tipo && !monitorar && !medidorQuedas) delete daUnidade[macOk];
  else daUnidade[macOk] = { apelido: limpo || null, tipo, monitorar, marca, medidorQuedas };
  await APELIDOS_DOC.set({ unidades: { ...atuais, [codigo]: daUnidade }, tipos: extrasNovos }, { merge: false });
  apelidosCache = null;
  return { codigo, mac: macOk, apelido: limpo || null, tipo, monitorar, marca, medidorQuedas };
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
// o silêncio passar deste teto. O mínimo de oito minutos é intencional: uma
// ausência menor não permite separar Wi-Fi oscilando de máquina travada.
// O ambiente pode AUMENTAR a janela, mas nunca reduzi-la a ponto de gerar
// falso positivo.
const CONFIRMACAO_QUEDA_MINIMA_MS = 8 * 60 * 1000;
const CONFIRMACAO_QUEDA_CONFIGURADA_MS = Number(process.env.LOJA_STATUS_CONFIRMACAO_QUEDA_MS);
const CONFIRMACAO_QUEDA_MS = Math.max(
  CONFIRMACAO_QUEDA_MINIMA_MS,
  Number.isFinite(CONFIRMACAO_QUEDA_CONFIGURADA_MS) ? CONFIRMACAO_QUEDA_CONFIGURADA_MS : 0,
);
// mesma ideia do CONFIRMACAO_QUEDA_MS acima, mas NÃO pode reusar o valor: a
// varredura de dispositivos de rede (Varrer-RedeLocal, vigiaScript.js) roda
// so 1x por HORA, e mesclarDispositivos ja marca ativo:false no primeiro
// scan em que o MAC nao aparece, sem folga nenhuma - "4 minutos de
// silencio" sempre estaria satisfeito no instante em que a queda e vista,
// nao confirma nada. Exige ~2 ciclos de scan sem aparecer (2h, com folga de
// jitter) antes de considerar queda de verdade - 1 scan perdido e normal
// (cache ARP, DHCP renovando, impressora ociosa).
const DISPOSITIVO_OFFLINE_MINIMO_MS = 2 * 60 * 60 * 1000;
const DISPOSITIVO_OFFLINE_CONFIGURADO_MS = Number(process.env.LOJA_STATUS_DISPOSITIVO_OFFLINE_MS);
const DISPOSITIVO_OFFLINE_LIMIAR_MS = Math.max(
  DISPOSITIVO_OFFLINE_MINIMO_MS,
  Number.isFinite(DISPOSITIVO_OFFLINE_CONFIGURADO_MS) ? DISPOSITIVO_OFFLINE_CONFIGURADO_MS : 0,
);
// registro de atividades por computador: guarda as ultimas N transicoes
// online<->offline (ver varrerAlertas), pra auditar quedas de conexao sem
// depender de print. Capado pra o documento nao crescer sem limite.
// 60 rotacionava rapido demais numa maquina com acesso remoto frequente
// (cada deteccao e 1 evento) - o Master abriu o painel e os registros mais
// antigos ja tinham sido empurrados pra fora. 200 entradas curtas custam
// ~15KB no doc (limite do Firestore e 1MB) e cobrem semanas; alem disso o
// backup diario da colecao guarda 30 dias de retratos completos.
const EVENTOS_MAX = 200;
// comando que exige admin espera a instancia SYSTEM aparecer. A sondagem dela
// e' a cada ~90s; 15min de folga cobre boot lento sem deixar a fila travada.
// Alem disso, a maquina instalada SEM Administrador nunca tera SYSTEM: aqui a
// gente desiste com mensagem clara em vez de segurar a vaga unica de comando.
const COMANDO_ELEVACAO_TIMEOUT_MS = 15 * 60 * 1000;
// Um comando já entregue não pode ficar "executando" para sempre: isso só
// ocupa a vaga da máquina e mascara agente/processo travado. O catálogo não
// usa tarefas longas; 10 min é uma margem ampla inclusive para winget. A
// execução real não é interrompida pelo servidor: apenas fechamos a fila com
// erro para não prometer uma conclusão que nunca voltou ao NOC.
const COMANDO_EXECUCAO_TIMEOUT_MS = Number(process.env.LOJA_STATUS_COMANDO_EXECUCAO_TIMEOUT_MS) >= 60 * 1000
  ? Number(process.env.LOJA_STATUS_COMANDO_EXECUCAO_TIMEOUT_MS)
  : 10 * 60 * 1000;

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
  'bootEm', 'link', 'linkEm', 'desligamentoInesperado', 'anydeskServico',
  // contador de falhas do proprio agente (ver registrarHeartbeat): so o
  // heartbeat escreve, e e' o que separa "a loja caiu" de "so o caminho ate
  // o servidor falhou" na hora que ela volta
  'agenteFalhasSeguidas',
  // prova recente de que a instancia SYSTEM (_Boot) esta viva; sem preservar
  // este campo, uma recarga do espelho poderia esconder o escudo por ate cinco
  // minutos mesmo com a tarefa elevada rodando normalmente.
  'nocElevadoEm',
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

// falhasSeguidas como o agente (vigiaScript.js) e a aba (index.html) mandam:
// contador vivo do lado de la. Fora de faixa vira 0 - e entrada de rede.
function falhasDeQuemBate(rede) {
  const n = Number(rede && rede.falhasSeguidas);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), 100000) : 0;
}

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
// Telemetria de RAM/Zebra pode chegar muito mais rápido do que uma mudança
// real. A sonda continua rápida no computador; no Firestore gravamos o estado
// novo na hora e, se nada mudou, só uma confirmação a cada 15 minutos.
const TELEMETRIA_PERSIST_MS = Number(process.env.NOC_TELEMETRIA_PERSIST_MS) >= 0
  ? Number(process.env.NOC_TELEMETRIA_PERSIST_MS)
  : 15 * 60 * 1000;
const ultimaTelemetriaGravacaoEm = new Map();

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
    // Quantas batidas seguidas quem bate TENTOU e nao conseguiu entregar
    // antes desta. Quem conta e o proprio agente/aba (ele incrementa a cada
    // falha e manda o contador na primeira batida que passa), entao a batida
    // que ENCERRA um silencio ja chega dizendo se a maquina esteve viva
    // tentando o tempo todo. E' o unico jeito de saber isso: durante o
    // silencio, por definicao, nada chega aqui.
    agenteFalhasSeguidas: falhasDeQuemBate(dados.rede),
  };

  // A instancia _Boot so existe quando a instalacao conseguiu criar a tarefa
  // agendada SYSTEM. Guardamos a ultima prova positiva, em vez de usar a
  // versao do agente como chute: v87 pode ter sido autoatualizada numa maquina
  // que ainda nao recebeu a reinstalacao com UAC.
  //
  // A instancia de login manda false e nao apaga esta prova. A de SYSTEM faz
  // sua sondagem a cada 90s; o heartbeat ja e persistido no maximo a cada
  // cinco minutos, portanto nao acrescenta escrita ao custo do NOC.
  if (dados.souAdmin === true) patch.nocElevadoEm = Date.now();

  if (dados.tailscale !== undefined) {
    const tailscale = sanitizarTailscale(dados.tailscale);
    if (tailscale && !mesmoTailscale(tailscale, atual && atual.tailscale)) {
      patch.tailscale = { ...tailscale, em: Date.now() };
    }
  }

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
  // estado do servico do AnyDesk (NOCZenith v21+). Lista fechada: o agente
  // manda o Status do Windows, e o que nao for reconhecido nao vira
  // degradacao - dado de fora nunca decide sozinho a cor do card.
  const anydeskOk = sanitizarEstadoAnydesk(dados.anydeskServico);
  if (anydeskOk) patch.anydeskServico = anydeskOk;
  // O vigia interno inclui o ID que acabou de ler do executável AnyDesk na
  // própria batida. Aceitamos a mesma regra da telemetria: máquina moderna
  // precisa provar o token; legado sem token continua compatível até atualizar.
  const anydeskIdHeartbeat = sanitizarAnydeskId(dados.anydeskId);
  const leituraAnydeskAutenticada = !(atual && atual.agentToken) || tokensBatem(token, atual.agentToken);
  if (anydeskIdHeartbeat && leituraAnydeskAutenticada
    && (anydeskIdHeartbeat !== (atual && atual.anydeskId) || (atual && atual.anydeskIdFonte) !== 'maquina')) {
    patch.anydeskId = anydeskIdHeartbeat;
    patch.anydeskIdEm = Date.now();
    patch.anydeskIdFonte = 'maquina';
  }
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
  // "Capturar agora" (ver pedirCaptura) - one-shot igual a mensagem: entregue
  // nesta batida e apagado junto, forcando a gravacao
  const capturarAgora = capturaPendente(atual);
  if (atual && atual.noPulsoPrintCapturarEm) patch.noPulsoPrintCapturarEm = null;

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
    || patch.noPulsoPrintCapturarEm === null  // gatilho de captura consumido
    || !anterior.ultimoHeartbeatEm            // primeira batida deste posto
    || patch.ip !== anterior.ip
    || patch.userAgent !== anterior.userAgent
    || patch.abertoDesde !== anterior.abertoDesde
    || (patch.tailscale !== undefined && !mesmoTailscale(patch.tailscale, anterior.tailscale || null))
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
  if (eventosNovos.length || patch.tailscale !== undefined) cacheBase.invalidar();
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
    // souAdmin: o agente diz se esta rodando elevado (a instancia SYSTEM diz
    // true; a de login, usuario comum, false). soComandoAdmin: a sondagem da
    // instancia SYSTEM enquanto cede a vez - "so me de comando que exige admin,
    // deixa o resto pra instancia de login".
    comandoPendente = await entregarComandoPendente(codigo, posto || 'principal', {
      souAdmin: !!dados.souAdmin, soComandoAdmin: !!dados.soComandoAdmin,
    });
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
  // A VERSAO DA POLITICA VAI NO HEARTBEAT, e isso conserta um defeito de
  // verdade: o laco do tipo 'interno' so chamava Sincronizar-Politica UMA VEZ,
  // ao subir. Na pratica, ligar "papel de parede" (ou qualquer outra trava)
  // numa maquina interna nao acontecia ate o agente reiniciar - a tela dizia
  // "aplica na proxima consulta (~25s)" e nao aplicava nunca.
  //
  // Nao custa leitura: `atual` ja veio do espelho em memoria, getConfig tem
  // cache de 30s e o perfil da unidade sai do cache do unidades.js. O agente
  // so busca a configuracao inteira (1 leitura) QUANDO este numero muda -
  // pesquisar de tempos em tempos custaria milhares de leituras por dia (§3).
  const politicaLigada = !!(atual && atual.politica && atual.politica.papelDeParedeAtivo);
  const arteDaMaquina = politicaLigada ? await papelDeParedeDe(codigo, posto || 'principal') : null;
  return {
    mensagemPendente,
    comandoPendente,
    chatMensagens,
    // Também vai no heartbeat para o agente interno aplicar a mudança sem
    // precisar baixar/reinstalar o NOCZenith.
    noPulsoPrint: !!(atual && atual.noPulsoPrint),
    capturarAgora,
    versaoAplicacao: versaoAplicacao(atual && atual.politicaVersao, arteDaMaquina),
    // Pedido one-shot também viaja no heartbeat. A versão da política é o
    // gatilho normal, mas um marcador local antigo ou uma corrida entre as
    // instâncias de login/SYSTEM não pode deixar a leitura presa para sempre.
    inventarioAtalhosPendenteEm: Number(atual && atual.inventarioAtalhosPendenteEm || 0) || null,
  };
}

// motivos que rebaixam uma máquina VIVA pra 'degradado'. Lista, não
// booleano: o painel mostra o porquê, que é o que decide a ação.
// Status que o Windows devolve pra um servico. Fora dessa lista vira null:
// campo desconhecido nao pode pintar card nem "consertar" sozinho um
// AnyDesk parado.
const ESTADOS_SERVICO = ['Running', 'Stopped', 'Paused', 'StartPending', 'StopPending', 'PausePending', 'ContinuePending'];
function sanitizarEstadoAnydesk(v) {
  const t = String(v == null ? '' : v).trim();
  return ESTADOS_SERVICO.includes(t) ? t : null;
}

// Tailscale é inventário de conexão, nunca uma fonte de autorização. A lista
// fechada impede que o endpoint público grave objetos grandes/arbitrários no
// Firestore. Dados ausentes permanecem ausentes para os agentes antigos.
function sanitizarTailscale(bruto) {
  if (!bruto || typeof bruto !== 'object') return null;
  const estados = ['Running', 'Stopped', 'NeedsLogin', 'NoState', 'desconhecido', 'erro'];
  const estado = String(bruto.estado || '').trim();
  const ip = String(bruto.ip || '').trim();
  return {
    instalado: !!bruto.instalado,
    estado: estados.includes(estado) ? estado : 'desconhecido',
    ip: net.isIP(ip) ? ip : null,
    nome: String(bruto.nome || '').trim().slice(0, 253) || null,
    versao: String(bruto.versao || '').trim().slice(0, 40) || null,
  };
}
function mesmoTailscale(a, b) {
  if (!a || !b) return a === b;
  return a.instalado === b.instalado && a.estado === b.estado && a.ip === b.ip
    && a.nome === b.nome && a.versao === b.versao;
}

function motivosDeDegradacao(doc) {
  const motivos = [];
  const link = doc.link || null;
  if (link && link.ethernetCaida) motivos.push('Ethernet caída');
  if (link && link.tipo === 'wifi' && !link.ethernetCaida) motivos.push('só no Wi-Fi');
  if (doc.discoNivel === 'critico') motivos.push('disco crítico');
  else if (doc.discoNivel === 'atencao') motivos.push('disco em atenção');
  // MAQUINA VIVA COM ACESSO REMOTO MORTO. O NOC sabia dizer que ela esta no
  // ar e sabia avisar quando alguem SE CONECTA - mas nao que o AnyDesk tinha
  // parado. O card ficava verde e isso so era descoberto na hora de precisar
  // entrar (STC-Servidor: offline no AnyDesk, online no NOCZenith, Windows
  // rodando normal).
  //
  // So degrada quando o servico EXISTE e nao esta rodando. Maquina sem
  // AnyDesk manda null e nao entra aqui - a maioria das maquinas de loja nao
  // tem, e pintar todas de amarelo por algo que nao existe ali seria o jeito
  // mais rapido de a operacao parar de olhar pro amarelo.
  // sanitiza na LEITURA tambem, nao so na escrita: o documento e antigo e
  // pode ter qualquer coisa nesse campo, e "qualquer coisa" nao pode pintar
  // o card de amarelo - isso e' o que o Master usa pra decidir onde olhar
  const svcAnydesk = sanitizarEstadoAnydesk(doc.anydeskServico);
  if (svcAnydesk && svcAnydesk !== 'Running') motivos.push('AnyDesk parado');
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
          monitorar: cfg.monitorar, medidorQuedas: cfg.medidorQuedas, marca: cfg.marca, fabricante: ouiFabricantes.fabricanteDe(x.mac),
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
  'atalhosDesktop', 'atalhosBarraTarefas',
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

// DIAGNOSTICO DO PAPEL DE PAREDE (pedido do Master: "por que não subiu em
// todos?"). Pra cada computador diz se a arte VAI aplicar e, quando não, por
// quê — sem o Master ter que abrir máquina por máquina. Motivos:
//   desligado      - a trava 🖼️ do card está off (nada aplica sem ela)
//   sem-marca      - a unidade não tem marca no perfil, então não casa arte de
//                    grupo+marca nem de marca (cai só na padrão, se houver)
//   sem-arte       - tem marca, mas não há arte pra ela (nem do grupo, nem da
//                    marca, nem padrão) - ver papelDeParedeDe
//   offline        - vai aplicar quando a máquina voltar
//   ok             - ligado, com arte e no ar; aplica na próxima batida. Só a
//                    instância logada aplica (SYSTEM não tem área de trabalho),
//                    então máquina sem ninguém logado no Windows aplica quando
//                    alguém logar.
// Custa leitura só quando o Master abre o painel — fora do poll de 30s.
async function diagnosticoPapelDeParede() {
  const docs = await listar();
  const linhas = [];
  for (const d of docs) {
    const ativo = !!(d.politica && d.politica.papelDeParedeAtivo);
    let arte = null;
    if (ativo) arte = await papelDeParedeDe(d.codigo, d.posto).catch(() => null);
    let motivo;
    if (!ativo) motivo = 'desligado';
    else if (!arte) {
      const perf = await unidades.perfil(d.codigo).catch(() => null);
      motivo = (perf && perf.marca) ? 'sem-arte' : 'sem-marca';
    } else if (!d.online) motivo = 'offline';
    else motivo = 'ok';
    const tipoArte = arte ? (arte.daMaquina ? 'maquina' : (arte.rede ? 'grupo+marca' : (arte.marca ? 'marca' : 'padrao'))) : null;
    linhas.push({
      codigo: d.codigo, posto: d.posto, nome: d.nome || d.posto,
      online: !!d.online, ativo, temArte: !!arte, tipoArte,
      agenteVersao: d.agenteVersao || null, motivo,
    });
  }
  return linhas;
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

// Configuração mínima que o agente consulta com seu token. O print continua
// exclusivamente local: esta rota só informa se o atalho está habilitado.
// ---- POLITICA DA MAQUINA (pedido do Master, 12/09/2026) ----
// Quatro travas de endpoint, LIGADAS UMA A UMA por computador no NOC:
//   papelDeParede  - imagem fixa da rede na area de trabalho (HKCU)
//   bloquearUsbStorage - so PENDRIVE/HD externo (USBSTOR). Pin pad, impressora
//                    termica, Zebra, leitor e teclado/mouse continuam ligados:
//                    bloquear "USB inteiro" pararia a loja.
//   bloquearInstalacao - instalar passa a exigir Administrador (UAC nega a
//                    elevacao pro usuario comum). Atualizacao de Chrome/PDV,
//                    que roda por servico ja elevado, nao passa por ai.
//   alertarInstalacao  - o agente manda a lista de programas e o servidor
//                    avisa quando aparece um que nao estava la antes.
//   estacao            - perfil declarativo da Área de Trabalho. Ao aplicar,
//                    o agente salva uma cópia dos atalhos que sairão antes de
//                    remover os que não foram aprovados. Uma nova alteração
//                    sobe a versão e é aplicada automaticamente pelo agente.
// Tudo REVERSIVEL: desligar a chave devolve a maquina ao estado anterior.
// Catálogo mantido pelo Master. São chaves, nunca caminhos ou comandos.
const ITENS_ESTACAO_APROVAVEIS = [
  'nopulso', 'anydesk', 'rdp-dominos', 'degust', 'gestor-pedidos-ifood',
  'gestor-pedidos-99food', 'gerenciadorlinxfood', 'advancedip', 'teamviewer',
  'suporte-linx-whatsapp', 'google-chrome', 'gcom',
];
function normalizarNomeAtalho(valor) {
  const nome = String(valor || '').trim().toLocaleLowerCase('pt-BR')
    .replace(/\.(lnk|url|rdp)$/i, '').replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ');
  // É uma chave de comparação, não um caminho nem um comando. O conjunto
  // permitido inclui nomes comuns de aplicativos como "Linx", mas nunca
  // barras, aspas ou curingas que alterariam o comportamento do PowerShell.
  return /^[\p{L}\p{N} ._()\-]{1,80}$/u.test(nome) ? nome : null;
}
function sanitizarEstacao(entrada) {
  const e = entrada && typeof entrada === 'object' ? entrada : {};
  const ativo = e.ativa === true;
  const aplicar = ativo && e.aplicar === true;
  const perfil = e.perfil === 'gerencia' ? 'gerencia' : 'nenhum';
  const permitidos = Array.isArray(e.atalhosAprovados) ? e.atalhosAprovados : [];
  const atalhosAprovados = [...new Set(permitidos.map((x) => String(x).trim().toLowerCase()))]
    .filter((x) => ITENS_ESTACAO_APROVAVEIS.includes(x));
  const personalizados = Array.isArray(e.atalhosPersonalizados) ? e.atalhosPersonalizados : [];
  const atalhosPersonalizados = [...new Set(personalizados.map(normalizarNomeAtalho).filter(Boolean))].slice(0, 40);
  const barraEntrada = Array.isArray(e.barraTarefasAprovada) ? e.barraTarefasAprovada : [];
  const barraTarefasAprovada = [...new Set(barraEntrada.map(normalizarNomeAtalho).filter(Boolean))].slice(0, 40);
  return {
    ativa: ativo,
    perfil: ativo ? perfil : 'nenhum',
    // O modo só muda com a confirmação explícita do Master. Isso impede que
    // uma tela antiga, que não conhece `aplicar`, limpe atalhos por acidente.
    modo: aplicar ? 'aplicar' : 'inventario',
    aplicar,
    backupAntesDeLimpar: aplicar && e.backupAntesDeLimpar !== false,
    atualizarAutomaticamente: ativo,
    ocultarLixeira: ativo && e.ocultarLixeira === true,
    protegerAnydesk: ativo && e.protegerAnydesk !== false,
    rdpDominosObrigatorio: ativo && e.rdpDominosObrigatorio === true,
    atalhosAprovados,
    atalhosPersonalizados,
    barraTarefasAprovada,
    // Só quem salvou pela tela nova habilita a alteração da barra. Políticas
    // antigas continuam sem tocar nos itens fixados.
    gerenciarBarraTarefas: aplicar && e.gerenciarBarraTarefas === true,
    // Arquivamento pesado e' opt-in por máquina: nunca herda para o parque.
    arquivarDados: aplicar && e.arquivarDados === true,
    compactarBackup: aplicar && e.arquivarDados === true && e.compactarBackup !== false,
  };
}
function sanitizarPolitica(entrada) {
  const p = entrada && typeof entrada === 'object' ? entrada : {};
  return {
    papelDeParedeAtivo: !!p.papelDeParedeAtivo,
    bloquearUsbStorage: !!p.bloquearUsbStorage,
    bloquearInstalacao: !!p.bloquearInstalacao,
    alertarInstalacao: !!p.alertarInstalacao,
    estacao: sanitizarEstacao(p.estacao),
  };
}

// ARTE DE PAPEL DE PAREDE DESTA MAQUINA (pedido do Master, 15/09/2026: "cada
// computador tem sua arte"). Guardada no doc do computador. Sobe a versao da
// aplicacao (via politicaVersao) pra o agente rebaixar a imagem nova na
// proxima consulta - mesmo motivo do versaoAplicacao. A precedência final é
// temporal: a arte individual vence somente até um envio em massa mais novo.
async function definirArteDaMaquina(codigo, posto, arte) {
  const atual = (await COLLECTION.doc(docIdFor(codigo, posto)).get()).data();
  if (!atual) throw new Error('Computador não encontrado.');
  const politicaVersao = Number(atual.politicaVersao || 0) + 1;
  await gravarEEspelhar(codigo, posto, { papelDeParedeArte: arte, politicaVersao });
  return { ...arte, politicaVersao };
}
async function removerArteDaMaquina(codigo, posto) {
  const atual = (await COLLECTION.doc(docIdFor(codigo, posto)).get()).data();
  if (!atual) throw new Error('Computador não encontrado.');
  const politicaVersao = Number(atual.politicaVersao || 0) + 1;
  // null (nao delete) pra o merge do gravarEEspelhar limpar o campo; a maquina
  // volta pra arte do grupo/marca na proxima consulta
  await gravarEEspelhar(codigo, posto, { papelDeParedeArte: null, politicaVersao });
  return { politicaVersao };
}

async function definirPolitica(codigo, posto, entrada) {
  // a versao sobe a cada mudanca: e assim que o agente sabe que tem politica
  // nova pra aplicar sem precisar comparar campo a campo na maquina
  const atual = (await COLLECTION.doc(docIdFor(codigo, posto)).get()).data() || {};
  // As telas antigas de política ainda mandam só as quatro travas. Preservar
  // o perfil de estação nesse caso evita que ajustar USB apague a aprovação
  // de atalhos que o Master já registrou.
  const temEstacao = entrada && typeof entrada === 'object' && Object.prototype.hasOwnProperty.call(entrada, 'estacao');
  const politica = sanitizarPolitica({ ...(entrada || {}), estacao: temEstacao ? entrada.estacao : atual.politica?.estacao });
  const politicaVersao = Number(atual.politicaVersao || 0) + 1;
  await gravarEEspelhar(codigo, posto, { politica, politicaVersao });
  return { ...politica, politicaVersao };
}

// O perfil da estação tem rota própria para não zerar por engano as quatro
// travas já existentes quando o Master só estiver organizando a Área de
// Trabalho. É uma configuração, não uma execução remota.
async function definirPerfilEstacao(codigo, posto, entrada) {
  const atual = (await COLLECTION.doc(docIdFor(codigo, posto)).get()).data();
  if (!atual) throw new Error('Computador não encontrado.');
  const politica = sanitizarPolitica(atual.politica);
  politica.estacao = sanitizarEstacao(entrada);
  const politicaVersao = Number(atual.politicaVersao || 0) + 1;
  // Salvar a regra e deixar a lista da tela antiga era enganoso: o Master
  // acabava de escolher os atalhos, mas ainda precisava descobrir e apertar
  // outro botão para ver o que realmente existe no perfil da loja. A mudança
  // de política passa a pedir a leitura não destrutiva automaticamente. O
  // agente só a responde quando houver uma sessão de operador acessível.
  const inventarioAtalhosPendenteEm = politica.estacao.ativa ? Date.now() : null;
  await gravarEEspelhar(codigo, posto, { politica, politicaVersao, inventarioAtalhosPendenteEm });
  return { ...politica.estacao, politicaVersao, inventarioAtalhosPendenteEm };
}

// programas instalados: o agente manda a lista, o servidor guarda e diz o que
// mudou em relacao a ultima - o que APARECEU (instalaram) e o que SUMIU
// (desinstalaram). A comparacao mora aqui (e nao na maquina) pra um agente
// adulterado nao conseguir esconder nem o que instalou nem o que apagou.
function programasNovos(anteriores, atuais) {
  const antes = new Set((anteriores || []).map((x) => String(x)));
  return (atuais || []).map((x) => String(x)).filter((x) => x && !antes.has(x));
}
// o mesmo diff ao contrario: quem estava na lista anterior e nao esta mais
function programasSumidos(anteriores, atuais) {
  return programasNovos(atuais, anteriores);
}

// Leitura truncada NAO e desinstalacao. O inventario le tres chaves do
// registro (duas HKLM + uma HKCU); se a HKCU nao vier - hive de outro
// usuario, chave sem permissao, registro ocupado - a lista encolhe de uma vez
// sem ninguem ter apagado nada. Sem esta trava o Master receberia "40
// programas desinstalados" e, na leitura seguinte, "40 programas instalados",
// pra sempre.
//
// O corte tem piso E proporcao: sumir 3 de 6 e faxina de verdade e tem que
// avisar; sumir 40 de 78 de uma vez nao e faxina, e leitura ruim.
const SUMICO_SUSPEITO_MIN = 10;
function leituraSuspeita(anteriores, sumidos) {
  const antes = (anteriores || []).length;
  const fora = (sumidos || []).length;
  return fora >= SUMICO_SUSPEITO_MIN && fora * 2 > antes;
}

// 60 entradas: historico de sobra pra responder "o que entrou nessa maquina e
// quando", sem inchar um documento que e' lido a cada abertura de ficha.
const PROGRAMAS_HISTORICO_MAX = 60;
async function registrarProgramas(codigo, posto, lista, token) {
  const ref = COLLECTION.doc(docIdFor(codigo, posto));
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Computador não encontrado.');
  const atual = snap.data();
  exigirTokenSeTiver(atual, token);
  const limpa = (Array.isArray(lista) ? lista : []).slice(0, 400)
    .map((x) => String(x || '').trim().slice(0, 120)).filter(Boolean);
  if (!limpa.length) return { novos: [] };
  // primeira coleta e so a FOTO inicial - a maquina ja chega com 80 programas
  // e avisar todos eles seria ruido, nao alerta
  const primeira = !Array.isArray(atual.programas);
  // alerta so onde o Master ligou a chave; a lista e guardada de qualquer
  // jeito, pra quando ele ligar ja existir base de comparacao
  const alerta = !!(atual.politica && atual.politica.alertarInstalacao);
  const novos = (primeira || !alerta) ? [] : programasNovos(atual.programas, limpa);
  const sumidos = primeira ? [] : programasSumidos(atual.programas, limpa);
  const nome = atual.nome || `${codigo}/${posto}`;
  // lista encolheu demais de uma vez: guarda a lista ANTERIOR (nao grava
  // nada) pra base de comparacao continuar inteira. Gravar a truncada
  // trocaria um alerta falso de desinstalacao por um alerta falso de
  // instalacao na leitura seguinte.
  if (leituraSuspeita(atual.programas, sumidos)) {
    return { novos: [], sumidos: [], nome, primeira, suspeita: sumidos.length };
  }
  const agora = Date.now();
  const patch = { programas: limpa, programasEm: agora };
  // ---- HISTORICO DE PROGRAMAS, EM LISTA PROPRIA ----
  //
  // Pedido do Master (14/09): "quando um programa novo instalado, quando um
  // programa e desinstalado, ter um icone ao clicar abrir uma aba mostrando -
  // para nao poluir nem ficar baguncado os registros".
  //
  // Antes isto ia pro array `eventos`, que e' o Registro de atividades - o
  // mesmo lugar de online/offline, comando, acesso remoto. Uma maquina que
  // atualiza Chrome toda semana empurrava queda de rede pra fora da tela, e a
  // linha do tempo que serve pra investigar incidente virava lista de
  // instalador. Agora e' um array separado, com aba propria na ficha.
  //
  // Cabe no MESMO documento e na MESMA escrita que ja acontece: nao custa
  // leitura nem escrita a mais (§3). 60 entradas e' historico de sobra pra
  // responder "quem instalou isso e quando", e cada entrada e' pequena.
  const sumidosAlerta = alerta ? sumidos : [];
  if (novos.length) {
    patch.ultimoProgramaNovoEm = agora;
    patch.ultimoProgramaNovoDetalhe = novos.slice(0, 10).join(' · ');
  }
  if (sumidosAlerta.length) {
    patch.ultimoProgramaSumidoEm = agora;
    patch.ultimoProgramaSumidoDetalhe = sumidosAlerta.slice(0, 10).join(' · ');
  }
  if (novos.length || sumidosAlerta.length) {
    // entrou e saiu na MESMA entrada quando acontecem na mesma leitura: uma
    // atualizacao de programa e' isso - o nome velho sai e o novo entra, e
    // separar em duas linhas faria parecer que sao dois acontecimentos
    patch.programasHistorico = [
      ...(Array.isArray(atual.programasHistorico) ? atual.programasHistorico : []),
      { em: agora, entrou: novos.slice(0, 20), saiu: sumidosAlerta.slice(0, 20) },
    ].slice(-PROGRAMAS_HISTORICO_MAX);
  }
  await gravarEEspelhar(codigo, posto, patch);
  return { novos, sumidos: sumidosAlerta, nome, primeira };
}

async function configuracaoAgente(codigo, posto, token) {
  const snap = await COLLECTION.doc(docIdFor(codigo, posto)).get();
  if (!snap.exists) throw new Error('Computador não encontrado.');
  const atual = snap.data();
  exigirTokenSeTiver(atual, token);
  // "Capturar agora" e one-shot: entregue uma vez, apagado na hora. Os tipos
  // que nao batem heartbeat pelo agente (caixa, quiosque...) so tem esta
  // rota - por isso o gatilho viaja aqui e nao pela fila de comandos, que
  // so o interno recebe.
  const capturarAgora = capturaPendente(atual);
  if (atual.noPulsoPrintCapturarEm) await gravarEEspelhar(codigo, posto, { noPulsoPrintCapturarEm: null });
  const politica = sanitizarPolitica(atual.politica);
  // Pedido one-shot do Master: a instância do USUÁRIO logado lê a Área de
  // Trabalho e a barra de tarefas. O serviço SYSTEM não consegue enxergá-las.
  if (Number(atual.inventarioAtalhosPendenteEm || 0) > 0) politica.estacao.inventarioPendenteEm = Number(atual.inventarioAtalhosPendenteEm);
  // so resolve a arte quando a maquina de fato aplica papel de parede: quem
  // esta com a chave desligada nao paga leitura de config nem de unidades
  const arte = politica.papelDeParedeAtivo ? await papelDeParedeDe(codigo, posto) : null;
  return {
    noPulsoPrint: !!atual.noPulsoPrint,
    capturarAgora,
    politica,
    politicaVersao: Number(atual.politicaVersao || 0),
    versaoAplicacao: versaoAplicacao(atual.politicaVersao, arte),
  };
}

function sanitizarItensVisuais(entrada, limite = 100) {
  const tipos = ['atalho', 'link', 'rdp', 'app', 'pasta', 'arquivo'];
  const origens = ['usuario', 'publica', 'barra-tarefas'];
  return (Array.isArray(entrada) ? entrada : []).map((item) => {
    const nome = String(item && item.nome || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 120);
    const tipo = String(item && item.tipo || '').toLowerCase();
    const origem = String(item && item.origem || '').toLowerCase();
    return nome && tipos.includes(tipo) && origens.includes(origem) ? { nome, tipo, origem } : null;
  }).filter(Boolean).slice(0, limite);
}

async function pedirInventarioAtalhos(codigo, posto) {
  const atual = (await COLLECTION.doc(docIdFor(codigo, posto)).get()).data();
  if (!atual) throw new Error('Computador não encontrado.');
  const politicaVersao = Number(atual.politicaVersao || 0) + 1;
  await gravarEEspelhar(codigo, posto, { inventarioAtalhosPendenteEm: Date.now(), politicaVersao });
  return { codigo, posto, politicaVersao };
}

async function registrarInventarioAtalhos(codigo, posto, dados, token) {
  const ref = COLLECTION.doc(docIdFor(codigo, posto));
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Computador não encontrado.');
  exigirTokenSeTiver(snap.data(), token);
  const areaTrabalho = sanitizarItensVisuais(dados && dados.areaTrabalho);
  const barraTarefas = sanitizarItensVisuais(dados && dados.barraTarefas);
  await gravarEEspelhar(codigo, posto, { atalhosDesktop: areaTrabalho, atalhosBarraTarefas: barraTarefas, atalhosDesktopEm: Date.now(), inventarioAtalhosPendenteEm: null });
  return { ok: true, areaTrabalho: areaTrabalho.length, barraTarefas: barraTarefas.length };
}

// pedido de captura do Master vale 5 minutos: tempo de sobra pro agente
// buscar (interno ~25s, os outros ate ~2min) sem deixar um pedido velho
// abrir o overlay do nada dias depois
const CAPTURA_VALE_MS = 5 * 60 * 1000;
function capturaPendente(atual) {
  return !!(atual && atual.noPulsoPrintCapturarEm && Date.now() - atual.noPulsoPrintCapturarEm < CAPTURA_VALE_MS);
}

// Master aperta "📸 Capturar agora" no card: o agente abre o overlay de
// selecao na tela da loja na proxima consulta, sem depender do Ctrl+Q. E
// tambem a prova dos nove: overlay abrindo pelo botao e nao pelo atalho =
// a tecla nao esta chegando (teste remoto, integridade, layout).
async function pedirCaptura(codigo, posto) {
  const snap = await COLLECTION.doc(docIdFor(codigo, posto)).get();
  if (!snap.exists) throw new Error('Computador não encontrado.');
  await gravarEEspelhar(codigo, posto, { noPulsoPrintCapturarEm: Date.now() });
  return { codigo, posto, pedidoEm: Date.now() };
}

// O agente conta em que pe esta (ver Reportar-EstadoAgente no vigiaScript.js):
// versao do script que roda de fato e o estado do NoPulsoPrint. O agente so
// manda quando muda, entao isto escreve pouco - mas escreve pelo caminho do
// espelho, como o ip-local, pra nao derrubar o cache dos 52 documentos.
// `endereco` (v51+): por QUAL endereco base aquele agente fala. E o unico jeito
// de saber quando o dominio antigo pode ser aposentado - enquanto uma maquina
// ainda reportar o endereco velho (ou nao reportar nada, por estar numa versao
// anterior a 51), desligar o velho deixa ELA orfa pra sempre: o agente so
// descobre versao nova pelo endereco assado no proprio script (ver CLAUDE.md §4).
// Quantas maquinas ja falam pelo endereco oficial e quantas ainda nao. Uma
// maquina so conta como MIGRADA quando ela mesma reportou o endereco oficial -
// versao antiga (que nem sabe reportar) conta como pendente, que e o lado
// seguro do erro.
function resumoEnderecoAgentes(docs, oficial) {
  const alvo = String(oficial || '').replace(/\/+$/, '').toLowerCase();
  const migradas = [];
  const pendentes = [];
  (docs || []).forEach((d) => {
    if (!d || !d.agentToken) return;   // computador sem agente nao entra na conta
    const dela = String(d.agenteEndereco || '').replace(/\/+$/, '').toLowerCase();
    const nome = d.nome || `${d.codigo}/${d.posto}`;
    const item = { codigo: d.codigo, posto: d.posto, nome, endereco: d.agenteEndereco || null, versao: d.agenteVersao || null, ultimoEstadoEm: d.agenteEstadoEm || null };
    if (alvo && dela === alvo) migradas.push(item); else pendentes.push(item);
  });
  return { oficial: alvo, total: migradas.length + pendentes.length, migradas: migradas.length, pendentes, podeAposentar: !!alvo && pendentes.length === 0 };
}

async function reportarEstadoAgente(codigo, posto, { versao, noPulsoPrint, endereco }, token) {
  const id = docIdFor(codigo, posto);
  const snap = await COLLECTION.doc(id).get();
  if (!snap.exists) throw new Error('Computador não encontrado.');
  const atual = snap.data();
  exigirTokenSeTiver(atual, token);
  const versaoNum = Number(versao);
  const patch = {
    agenteVersao: Number.isFinite(versaoNum) && versaoNum > 0 ? versaoNum : null,
    agenteNoPulsoPrint: String(noPulsoPrint || '').trim().slice(0, 200) || null,
    agenteEstadoEm: Date.now(),
  };
  const end = String(endereco || '').trim().slice(0, 200);
  if (end) patch.agenteEndereco = end;
  await COLLECTION.doc(id).set(patch, { merge: true });
  espelharEscrita(id, patch);
  return { codigo, posto, ...patch };
}

async function noPulsoPrintDoComputador(codigo, posto) {
  const snap = await COLLECTION.doc(docIdFor(codigo, posto)).get();
  return snap.exists && !!snap.data().noPulsoPrint;
}

// "Windows antigo" (Server 2012 R2 / 7 / 8): o agente desta maquina sai na
// versao especifica (ver adaptarParaWindowsAntigo no vigiaScript.js). Lido
// pela rota vigia.ps1 e pelo comando de instalacao - a autoatualizacao
// continua na versao certa sem a maquina precisar saber de nada.
async function windowsAntigoDoComputador(codigo, posto) {
  const snap = await COLLECTION.doc(docIdFor(codigo, posto)).get();
  return snap.exists && !!snap.data().windowsAntigo;
}

// A marca e administrada explicitamente na ficha do computador. O agente usa
// isso para nunca instalar PWA/atalho automaticamente em um servidor.
async function ehServidorDoComputador(codigo, posto) {
  const snap = await COLLECTION.doc(docIdFor(codigo, posto)).get();
  return snap.exists && !!snap.data().ehServidor;
}

// nome que o Master deu ao computador no NOC ("Caixa 1", "DOM-CR-ATM01") - vai
// assado no .ps1 pro carimbo do papel de parede. Sem cadastro, cai no posto
// (id interno) so pra nao carimbar vazio, mas o certo e o computador ter nome.
async function nomeDoComputador(codigo, posto) {
  const snap = await COLLECTION.doc(docIdFor(codigo, posto)).get();
  const nome = snap.exists ? String(snap.data().nome || '').trim() : '';
  return nome || posto;
}

// Master cadastra um novo computador pra uma unidade - gera um id curto e
// estavel (nunca muda, mesmo se o nome/tipo forem editados depois) que vira
// parte do link/QR code fixado naquele computador (ver POST /api/loja-status/
// :codigo/computadores em index.js, que devolve a URL pronta)
async function cadastrarComputador(codigo, nome, tipo, ehServidor, temGcom, medeQuedas, noPulsoPrint, windowsAntigo) {
  const nomeOk = String(nome || '').trim().slice(0, 60);
  if (!nomeOk) throw new Error('Dê um nome pro computador (ex: Caixa 1, PDV Entrega).');
  const posto = crypto.randomBytes(4).toString('hex');
  const id = docIdFor(codigo, posto);
  const registro = {
    codigo, posto, nome: nomeOk, tipo: tipoValido(tipo), anydeskId: null,
    // Características operacionais declaradas no cadastro. Não inferimos pelo
    // nome: "Servidor" e "GCOM" precisam ser visíveis e confiáveis no NOC.
    ehServidor: !!ehServidor, temGcom: !!temGcom, medeQuedas: !!medeQuedas,
    // Captura local opt-in: o arquivo nunca passa pelo NoPulso nem pelo servidor.
    noPulsoPrint: !!noPulsoPrint,
    // Server 2012 R2 / 7 / 8: agente na versao especifica (ver vigiaScript.js)
    windowsAntigo: !!windowsAntigo,
    criadoEm: Date.now(),
    ultimoHeartbeatEm: null, avisadoOffline: false, offlineDesde: null, mensagemPendente: null,
    ip: null, userAgent: null, abertoDesde: null, ipLocal: null, ipLocalEm: null,
    comandoPendenteId: null, comandosFilaIds: [],
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
async function editarComputador(codigo, posto, nome, tipo, ehNotebook, ehServidor, temGcom, medeQuedas, noPulsoPrint, windowsAntigo) {
  const nomeOk = String(nome || '').trim().slice(0, 60);
  if (!nomeOk) throw new Error('Dê um nome pro computador.');
  const id = docIdFor(codigo, posto);
  const snap = await COLLECTION.doc(id).get();
  if (!snap.exists) throw new Error('Computador não encontrado.');
  // notebook hiberna/dorme fora de hora - a "queda" dele aparece no painel,
  // mas nunca vira push crítico (ver rodarVarreduraLojaStatus em index.js)
  const registro = {
    nome: nomeOk,
    tipo: tipoValido(tipo),
    ehNotebook: !!ehNotebook,
    ehServidor: !!ehServidor,
    temGcom: !!temGcom,
    // Ponto de medição da unidade: só esta máquina entra no relatório de
    // quedas. Pode haver mais de uma por redundância; o relatório consolida
    // ocorrências simultâneas em uma única queda da loja.
    medeQuedas: !!medeQuedas,
    noPulsoPrint: !!noPulsoPrint,
    windowsAntigo: !!windowsAntigo,
  };
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

// O valor digitado pelo Master fica apenas como referência de cadastro. Quando
// a própria máquina já confirmou seu ID, uma edição manual jamais a substitui:
// o botão de acesso deve apontar para o número que o AnyDesk local devolveu.
async function definirAnydeskId(codigo, posto, anydeskId) {
  const id = docIdFor(codigo, posto);
  const limpo = sanitizarAnydeskId(anydeskId);
  const snap = await COLLECTION.doc(id).get();
  const atual = snap.exists ? snap.data() : null;
  const patchAnydesk = { codigo, posto, anydeskIdManual: limpo || null, anydeskIdManualEm: Date.now() };
  // Mantém compatibilidade para máquinas que ainda nunca falaram com o agente.
  // Assim que o vigia fizer a leitura local, registrarTelemetria prevalece.
  if (!atual || atual.anydeskIdFonte !== 'maquina') {
    patchAnydesk.anydeskId = limpo || null;
    patchAnydesk.anydeskIdFonte = limpo ? 'cadastro' : null;
  }
  await COLLECTION.doc(id).set(patchAnydesk, { merge: true });
  espelharEscrita(id, patchAnydesk);
  return { codigo, posto, anydeskId: (atual && atual.anydeskIdFonte === 'maquina') ? atual.anydeskId : (limpo || null), fonte: (atual && atual.anydeskIdFonte === 'maquina') ? 'maquina' : 'cadastro' };
}

// AnyDesk exibe um identificador público numérico. Aceitar somente esse
// formato impede que uma telemetria/edição acabe gravando texto arbitrário
// como link de acesso remoto. Senha nunca passa por este campo.
function sanitizarAnydeskId(valor) {
  const limpo = String(valor || '').replace(/\D/g, '').slice(0, 16);
  return /^\d{6,16}$/.test(limpo) ? limpo : null;
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
  // A telemetria rápida não pode reler o mesmo documento em toda sonda Zebra.
  // O espelho é atualizado por cada escrita deste módulo; em caso de restart,
  // garantirEspelho faz uma única leitura da coleção, não uma por equipamento.
  const memoria = await garantirEspelho();
  const atual = memoria.get(id) || null;
  if (!atual) throw new Error('Computador não encontrado.');
  exigirTokenSeTiver(atual, token);
  const agora = Date.now();
  const confirmacaoDevida = agora - (ultimaTelemetriaGravacaoEm.get(id) || 0) >= TELEMETRIA_PERSIST_MS;
  // Telemetria autenticada e prova de vida do NOCZenith. Sem isso, uma
  // escrita atual de disco/rede podia coexistir com um ultimoHeartbeatEm
  // antigo por causa do intervalo de persistencia do heartbeat e o painel
  // mostrava falsamente "indisponível". Mantemos o mesmo campo que define o
  // estado para que qualquer sinal válido do agente recupere a presença.
  const patch = { ultimoHeartbeatEm: agora };
  let eventos = atual.eventos || [];

  const ram = nocMaquina.sanitizarRam(dados && dados.ram);
  if (ram) {
    const antes = atual.ramNivel || 'ok';
    const depois = nocMaquina.avaliarRam(ram);
    const mudouRam = JSON.stringify(ram) !== JSON.stringify(atual.ram || null)
      || antes !== depois.nivel || JSON.stringify(atual.ramMotivos || []) !== JSON.stringify(depois.motivos);
    if (mudouRam || !atual.ramMedidaEm || confirmacaoDevida) {
      patch.ram = ram;
      patch.ramMedidaEm = agora;
      patch.ramNivel = depois.nivel;
      patch.ramMotivos = depois.motivos;
    }
    // Primeiro alerta também vale: versões antigas já guardavam a leitura de
    // RAM, mas ainda não tinham ramNivel. Assim um PC já estrangulado não
    // fica silencioso até piorar mais uma vez.
    if (depois.nivel !== 'ok' && depois.nivel !== antes) {
      eventos = [...eventos, { tipo: 'ram', em: agora, detalhe: depois.motivos.join(' · ').slice(0, 200) }];
      patch.eventos = eventos.slice(-EVENTOS_MAX);
      patch.ramAlertaPendente = depois.nivel;
    }
  }
  const disco = nocMaquina.sanitizarDisco(dados && dados.disco);
  if (disco) {
    const antes = nocMaquina.avaliarDisco(atual.disco);
    const depois = nocMaquina.avaliarDisco(disco);
    const mudouDisco = JSON.stringify(disco) !== JSON.stringify(atual.disco || null)
      || depois.nivel !== antes.nivel || JSON.stringify(atual.discoMotivos || []) !== JSON.stringify(depois.motivos);
    if (mudouDisco || !atual.disco) {
      patch.disco = disco;
      patch.discoNivel = depois.nivel;
      patch.discoMotivos = depois.motivos;
    }
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
    if (bootTelemetria !== atual.bootEm) patch.bootEm = bootTelemetria;
    if (reiniciouDesde(atual.bootEm, bootTelemetria)) {
      patch.reinicioAvisoPendente = { em: bootTelemetria, inesperado: !!(dados && dados.desligamentoInesperado) };
      eventos = [...eventos, { tipo: 'reiniciou', em: agora, bootEm: bootTelemetria, inesperado: !!(dados && dados.desligamentoInesperado) }];
      patch.eventos = eventos.slice(-EVENTOS_MAX);
    }
  }
  // em maquina de atendimento quem bate o heartbeat e o navegador, entao a
  // telemetria e o unico canal que o agente tem pra contar isso
  const anydeskTelemetria = sanitizarEstadoAnydesk(dados && dados.anydeskServico);
  if (anydeskTelemetria && JSON.stringify(anydeskTelemetria) !== JSON.stringify(atual.anydeskServico || null)) patch.anydeskServico = anydeskTelemetria;
  const anydeskIdTelemetria = sanitizarAnydeskId(dados && dados.anydeskId);
  if (anydeskIdTelemetria && (anydeskIdTelemetria !== atual.anydeskId || atual.anydeskIdFonte !== 'maquina')) {
    patch.anydeskId = anydeskIdTelemetria;
    patch.anydeskIdEm = agora;
    patch.anydeskIdFonte = 'maquina';
  }
  const linkTelemetria = sanitizarLink(dados && dados.link);
  if (linkTelemetria) {
    if (!mesmoLink(atual.link, linkTelemetria)) {
      patch.link = linkTelemetria;
      patch.linkEm = agora;
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
    const atualizarUptime = atual.uptimeHoras == null || !atual.uptimeEm
      || (agora - atual.uptimeEm) >= TELEMETRIA_PERSIST_MS;
    if (atualizarUptime) {
      patch.uptimeHoras = uptimeHoras;
      patch.uptimeEm = agora;
    }
    const u = nocMaquina.avaliarUptime(uptimeHoras, atual.uptimeCicloAvisado);
    // grava o ciclo SEMPRE (não só quando avisa): é o que faz o contador
    // voltar a zero sozinho quando a máquina finalmente reinicia
    if (u.ciclo !== atual.uptimeCicloAvisado) patch.uptimeCicloAvisado = u.ciclo;
    if (u.avisarAgora) {
      eventos = [...eventos, { tipo: 'reiniciar', em: agora, detalhe: `ligado há ${u.dias} dias sem reiniciar` }];
      patch.eventos = eventos.slice(-EVENTOS_MAX);
      patch.reinicioAlertaPendente = u.dias;
    }
  }

  // STATUS DAS IMPRESSORAS. O agente pergunta ~HS na porta 9100 e devolve o
  // texto CRU; quem interpreta e' o servidor (ver impressoraStatus.js) - assim
  // um parse errado se conserta com deploy, e nao com bump de VERSAO_VIGIA nas
  // 52 maquinas. So alarma problema RECONHECIDO e REPETIDO: leitura que nao
  // deu pra entender vira 'desconhecido' e nunca notifica.
  const statusImp = impressoraStatus.sanitizarStatusImpressoras(dados && dados.statusImpressoras);
  if (statusImp) {
    const antes = atual.impressoras || {};
    const depois = { ...antes };
    const pendentes = [];
    for (const item of statusImp) {
      const lido = impressoraStatus.parseStatusZebra(item.bruto);
      const aval = impressoraStatus.avaliar(lido);
      const anterior = antes[item.mac] || null;
      // 'desconhecido' NAO entra na maquina de estados: nao confirma problema
      // nem cancela um que ja estava valendo. Mantem a ÚLTIMA leitura válida
      // em vez de pintar uma Zebra antes OK como "off" depois de uma tentativa
      // isolada sem resposta; a tentativa fica registrada separadamente.
      if (aval.nivel === 'desconhecido') {
        const tinhaLeituraValida = anterior && anterior.nivel && anterior.nivel !== 'desconhecido';
        depois[item.mac] = {
          ...(anterior || {}), ip: item.ip,
          ...(tinhaLeituraValida ? {} : { nivel: 'desconhecido', em: agora }),
          tentativaSemRespostaEm: agora, semRespostaEm: (anterior && anterior.semRespostaEm) || agora,
        };
        continue;
      }
      const d = impressoraStatus.decidirAviso(anterior && anterior.estado, aval);
      depois[item.mac] = {
        ip: item.ip, em: agora, nivel: aval.nivel, motivos: aval.motivos,
        fila: lido.fila, estado: d.estado, semRespostaEm: null, tentativaSemRespostaEm: null,
      };
      if (d.avisar) pendentes.push({ mac: item.mac, ip: item.ip, nivel: d.avisar.nivel, motivos: d.avisar.motivos });
      if (d.normalizou) pendentes.push({ mac: item.mac, ip: item.ip, nivel: 'ok', motivos: [], de: d.normalizou.de });
    }
    // `em` e a hora da tentativa nao são estado operacional. Ignorá-los na
    // comparação mantém a sonda a cada 50s, mas não cobra uma escrita a cada
    // 50s enquanto Zebra, fila e papel seguem iguais.
    const estadoImpressoras = (lista) => Object.fromEntries(Object.entries(lista || {}).map(([mac, item]) => [mac, {
      ip: item.ip || null, nivel: item.nivel || null, motivos: item.motivos || [], fila: item.fila || null,
      estado: item.estado || null, semRespostaEm: item.semRespostaEm || null,
    }]));
    const mudouImpressora = JSON.stringify(estadoImpressoras(depois)) !== JSON.stringify(estadoImpressoras(antes));
    if (mudouImpressora || !atual.impressorasEm || confirmacaoDevida) {
      patch.impressoras = depois;
      patch.impressorasEm = agora;
    }
    if (pendentes.length) {
      // igual disco/link: quem notifica e' a varredura periodica, num lugar
      // so - uma falha de push nunca pode derrubar o caminho do agente
      patch.impressoraAlertaPendente = pendentes;
      eventos = [...eventos, ...pendentes.map((p) => ({
        tipo: 'impressora', em: agora,
        detalhe: `${p.ip || p.mac}: ${p.nivel === 'ok' ? 'normalizou' : p.motivos.join(' · ')}`.slice(0, 200),
      }))];
      patch.eventos = eventos.slice(-EVENTOS_MAX);
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
    // O MAC e' a identidade do aparelho. Se ele reaparece com outro IP, nao
    // tratamos como equipamento novo: registramos a troca para a operacao
    // conseguir seguir impressora, PDV ou roteador depois de um DHCP.
    if (merge.mudaramIp && merge.mudaramIp.length) {
      const resumo = merge.mudaramIp.slice(0, 5).map((d) => `${d.nome || d.mac}: ${d.ipHistorico[d.ipHistorico.length - 1].de} → ${d.ip}`).join(', ');
      eventos = [...eventos, { tipo: 'dispositivo-ip-mudou', em: agora, detalhe: `${merge.mudaramIp.length} IP(s) alterado(s): ${resumo}`.slice(0, 200) }];
      // A Zebra merece um aviso próprio na ficha: a operação precisa saber que
      // foi ELA (e não qualquer outro aparelho DHCP) que ganhou outro IP.
      const zebras = merge.mudaramIp.filter((d) => d.marca === 'zebra');
      eventos = [...eventos, ...zebras.map((d) => {
        const h = d.ipHistorico[d.ipHistorico.length - 1] || {};
        return { tipo: 'impressora-ip-mudou', em: agora, detalhe: `${d.ip}: IP mudou de ${h.de || '?'} para ${d.ip}`.slice(0, 200) };
      })];
      patch.eventos = eventos.slice(-EVENTOS_MAX);
    }
  }

  // ESTADO DAS VMs (so o HOST Hyper-V reporta - ver Medir-VMs no agente).
  // E' o unico jeito honesto de saber que uma VM caiu: VM desligada nao
  // reporta nada de si mesma, entao quem enxerga e' o host, sempre ligado.
  // So grava quando MUDA: a telemetria chega a cada ~5min, mas o disco do
  // Firestore nao pode levar uma escrita a cada 5min por host sem motivo.
  const vms = nocMaquina.sanitizarVms(dados && dados.vms);
  if (vms && JSON.stringify(vms) !== JSON.stringify(atual.vms || null)) {
    const caidas = nocMaquina.quedasDeVm(atual.vms, vms);
    patch.vms = vms;
    patch.vmsEm = agora;
    if (caidas.length) {
      eventos = [...eventos, { tipo: 'vm', em: agora, detalhe: `VM caiu: ${caidas.map((c) => `${c.nome} (${c.estado})`).join(', ')}`.slice(0, 200) }];
      patch.eventos = eventos.slice(-EVENTOS_MAX);
      // igual disco/link: o agente marca, a varredura periodica notifica - uma
      // falha de push nunca pode derrubar o caminho do agente
      patch.vmAlertaPendente = caidas;
    }
  }

  // `ultimoHeartbeatEm` mantém a presença viva no espelho, mas não deve ser
  // sozinho motivo de cobrança. Todo outro campo acima só entra quando mudou.
  const temMudancaReal = Object.keys(patch).some((campo) => campo !== 'ultimoHeartbeatEm');
  if (temMudancaReal || confirmacaoDevida) {
    await COLLECTION.doc(id).set(patch, { merge: true });
    ultimaTelemetriaGravacaoEm.set(id, agora);
    espelharEscrita(id, patch);
  } else {
    aplicarNoEspelho(id, patch);
  }
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
// SESSÃO x SERVIÇO CONECTADO. Pergunta do Master (09/09/2026): "conseguimos
// fazer com que esse tipo de conexão que não é uma pessoa se conectando de
// fato apareça quando realmente alguma conexão for estabelecida?".
//
// O que ele viu: 20 linhas de "Acesso remoto · TeamViewer" num fim de tarde,
// de 20 em 20 minutos, todas pra 20.206.176.18:443 e 5938 - endereços da
// própria TeamViewer. Não era ninguém entrando: era o serviço se anunciando
// pra nuvem dele. A checagem antiga olha conexão TCP estabelecida, e serviço
// parado e pessoa controlando a máquina parecem iguais por essa lente (foi
// por isso que Splashtop/LogMeIn/GoToMyPC já tinham saído da lista).
//
// O sinal que separa os dois é o LOG DE SESSÃO da própria ferramenta, que só
// escreve quando alguém entra de verdade - com quem, quando e por quanto
// tempo (ver Verificar-SessaoRemota em vigiaScript.js). Então agora são dois
// eventos diferentes:
//   'sessao-remota'  alguém entrou (vem do log da ferramenta) - é o que
//                    interessa, e o único que vira push
//   'acesso-remoto'  o serviço está conectado à nuvem dele (conexão TCP) -
//                    continua registrado, porque é assim que se descobre que
//                    a máquina tem uma porta de acesso remoto aberta 24h
// ---- a hora do log da ferramenta vem em UTC ----
//
// Pergunta do Master, olhando o alarme: "por que a hora que mostra e
// diferente da hora real?". O alarme trazia "2026-09-12 21:56:32" com o
// relogio dele marcando 18:56 - 3h, exatamente o fuso de Brasilia.
//
// A hora nao e nossa: o agente manda a LINHA CRUA do ad_svc.trace (ver
// Verificar-SessaoRemota no vigiaScript.js) e o AnyDesk grava esse arquivo
// em UTC. O nosso carimbo (evento.em) sempre esteve certo; quem mentia era o
// texto colado ao lado dele - e no alarme, onde so o texto aparece, nao
// havia como perceber.
//
// NAO da pra cravar "e sempre UTC": o formato do trace muda entre versoes do
// AnyDesk, e o proprio vigiaScript.js ja avisa disso. Entao a escolha se
// VERIFICA sozinha: das duas leituras possiveis da mesma marca - UTC ou hora
// de Brasilia - vale a que cair MAIS PERTO do instante em que nos detectamos.
// Linha que ja venha em hora local fica intacta; linha em UTC vira local.
// Nao ha como o conserto piorar o que ja estava certo.
const MARCA_DE_HORA_RE = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/;
function deslocamentoBrasiliaMs(instante) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(instante)).reduce((acc, x) => { acc[x.type] = x.value; return acc; }, {});
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - instante;
}
function emBrasilia(instante) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(instante)).reduce((acc, x) => { acc[x.type] = x.value; return acc; }, {});
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}
function horaDoLogEmBrasilia(texto, agoraMs) {
  const m = MARCA_DE_HORA_RE.exec(String(texto || ''));
  if (!m) return texto;
  const agora = agoraMs == null ? Date.now() : agoraMs;
  const comoUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  // o instante que, mostrado em Brasilia, daria esses mesmos digitos
  const comoLocal = comoUtc - deslocamentoBrasiliaMs(comoUtc);
  const escolhido = Math.abs(comoUtc - agora) <= Math.abs(comoLocal - agora) ? comoUtc : comoLocal;
  return String(texto).replace(m[0], emBrasilia(escolhido));
}

const EVENTO_SESSAO_REMOTA = 'sessao-remota';
async function registrarAcessoRemoto(codigo, posto, detalhe, token, ehSessao) {
  const id = docIdFor(codigo, posto);
  // a marca de hora da ferramenta vem em UTC; vira hora de Brasilia ANTES de
  // ser guardada, pra o alarme e o historico dizerem a mesma coisa
  const limpo = horaDoLogEmBrasilia(String(detalhe || '').trim(), Date.now()).slice(0, 200);
  if (!limpo) throw new Error('Detalhe do acesso remoto é obrigatório.');
  const snap = await COLLECTION.doc(id).get();
  const atual = snap.exists ? snap.data() : null;
  exigirTokenSeTiver(atual, token);
  const agora = Date.now();
  const tipo = ehSessao ? EVENTO_SESSAO_REMOTA : 'acesso-remoto';
  // registra no historico de atividades do computador (aparece no detalhe),
  // pra ficar auditavel mesmo com o push desligado. Nao repete o mesmo detalhe
  // se ja foi o ultimo evento em menos de 10min (evita encher com o mesmo
  // batimento de nuvem da ferramenta). Sessao NAO passa por esse filtro: duas
  // entradas seguidas da mesma pessoa sao dois acessos, e sumir com o segundo
  // seria esconder justamente o que se quer ver
  const eventosAtuais = (atual && atual.eventos) || [];
  const ultimo = eventosAtuais[eventosAtuais.length - 1];
  const repetido = !ehSessao && ultimo && ultimo.tipo === 'acesso-remoto' && ultimo.detalhe === limpo && (agora - ultimo.em) < 10 * 60 * 1000;
  // A checagem de acesso remoto só roda dentro do ciclo saudável do agente e
  // o endpoint exige o token da máquina. Portanto também é um batimento
  // válido: não deixar um acesso detectado agora ao lado de um status antigo
  // de "calada" no painel.
  const patch = { codigo, posto, ultimoHeartbeatEm: agora, ultimoAcessoRemotoEm: agora, ultimoAcessoRemotoDetalhe: limpo };
  if (ehSessao) { patch.ultimaSessaoRemotaEm = agora; patch.ultimaSessaoRemotaDetalhe = limpo; }
  if (!repetido) patch.eventos = [...eventosAtuais, { tipo, em: agora, detalhe: limpo }].slice(-EVENTOS_MAX);
  await COLLECTION.doc(id).set(patch, { merge: true });
  espelharEscrita(id, patch);
  return { codigo, posto, nome: atual && atual.nome, ultimoAcessoRemotoDetalhe: limpo, ehSessao: !!ehSessao };
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

// Diagnóstico fechado de desempenho e reinício inesperado: apenas lê
// indicadores que ajudam a separar disco cheio, falha de hardware, tela azul
// e queda de energia. Não coleta linha de comando, arquivos do usuário ou
// dados pessoais; também não reinicia, encerra ou altera nada na máquina.
const COMANDO_DIAGNOSTICO_DESEMPENHO = [
  '$linhas = New-Object System.Collections.Generic.List[string]',
  '$linhas.Add("DIAGNÓSTICO SOMENTE-LEITURA: nenhuma alteração será feita.")',
  '$os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue',
  'if ($os) { $livre = [math]::Round($os.FreePhysicalMemory / 1MB, 2); $total = [math]::Round($os.TotalVisibleMemorySize / 1MB, 2); $linhas.Add("RAM: $livre GB livres de $total GB") }',
  '$cpu = Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | Measure-Object -Property LoadPercentage -Average',
  'if ($cpu.Count -gt 0 -and $null -ne $cpu.Average) { $linhas.Add("CPU agora: $([math]::Round($cpu.Average))%") }',
  '$volumes = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" -ErrorAction SilentlyContinue | ForEach-Object { if ($_.Size) { "DISCO $($_.DeviceID): $([math]::Round($_.FreeSpace/1GB,1)) GB livres de $([math]::Round($_.Size/1GB,1)) GB" } }',
  '$linhas.AddRange(@($volumes))',
  '$fisicos = @(Get-PhysicalDisk -ErrorAction SilentlyContinue | ForEach-Object { "DISCO FÍSICO: $($_.FriendlyName) · saúde $($_.HealthStatus) · operacional $($_.OperationalStatus)" })',
  'if ($fisicos) { $linhas.AddRange($fisicos) }',
  '$top = Get-Process -ErrorAction SilentlyContinue | Sort-Object WorkingSet64 -Descending | Select-Object -First 6 | ForEach-Object { "$($_.ProcessName): $([math]::Round($_.WorkingSet64/1MB)) MB" }',
  'if ($top) { $linhas.Add("MAIORES CONSUMOS:"); $linhas.AddRange(@($top)) }',
  '$desde = (Get-Date).AddDays(-7)',
  '$linhas.Add("EVENTOS CRÍTICOS DOS ÚLTIMOS 7 DIAS:")',
  'try {',
  '  $eventos = @(Get-WinEvent -FilterHashtable @{ LogName = "System"; StartTime = $desde } -MaxEvents 300 -ErrorAction Stop | Where-Object { $_.Id -in @(41, 6008, 1001, 7, 51, 55, 129, 153) -or "$($_.ProviderName)" -match "WHEA" } | Select-Object -First 10)',
  '  if (-not $eventos) { $linhas.Add("Nenhum BugCheck, Kernel-Power, disco/NTFS ou WHEA recente no log System.") }',
  '  foreach ($ev in $eventos) { $msg = ("$($ev.Message)" -replace "\\s+", " ").Trim(); if ($msg.Length -gt 420) { $msg = $msg.Substring(0,420) + "…" }; $linhas.Add("[$($ev.TimeCreated.ToString(\"yyyy-MM-dd HH:mm\"))] ID $($ev.Id) · $($ev.ProviderName): $msg") }',
  '} catch { $linhas.Add("Não consegui ler o log System: $($_.Exception.Message)") }',
  'try {',
  '  $dumps = @(Get-ChildItem -LiteralPath (Join-Path $env:WINDIR "Minidump") -Filter "*.dmp" -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 3 | ForEach-Object { "$($_.Name) · $($_.LastWriteTime.ToString(\"yyyy-MM-dd HH:mm\")) · $([math]::Round($_.Length/1MB,1)) MB" })',
  '  $linhas.Add($(if ($dumps) { "MINIDUMPS (indício de tela azul): " + ($dumps -join " | ") } else { "MINIDUMPS: nenhum localizado." }))',
  '} catch { $linhas.Add("MINIDUMPS: não foi possível verificar.") }',
  '$linhas -join "`n"',
].join('\n');

// Inventário inicial do perfil de estação. Devolve SOMENTE os nomes dos
// atalhos (.lnk/.url/.rdp), sem caminhos nem documentos do usuário. É assim
// que o Master consegue aprovar o "Linx" de uma máquina específica sem
// adivinhar seu nome ou liberar esse aplicativo nas demais. Não altera nada.
const COMANDO_INVENTARIO_ESTACAO = [
  '$linhas = New-Object System.Collections.Generic.List[string]',
  '$areas = @($env:USERPROFILE + "\\Desktop", $env:PUBLIC + "\\Desktop") | Select-Object -Unique',
  '$lnk=0; $url=0; $rdp=0; $outros=0; $atalhos = New-Object System.Collections.Generic.List[object]',
  'foreach ($area in $areas) {',
  '  if (-not (Test-Path -LiteralPath $area)) { continue }',
  '  foreach ($i in @(Get-ChildItem -LiteralPath $area -Force -ErrorAction SilentlyContinue)) {',
  '    if ($i.PSIsContainer) { $outros++; continue }',
  '    switch ($i.Extension.ToLowerInvariant()) { ".lnk" {$lnk++; [void]$atalhos.Add([PSCustomObject]@{ nome=$i.BaseName; extensao=".lnk"; origem=$(if ($area -eq ($env:PUBLIC + "\\Desktop")) { "publica" } else { "usuario" }) }) }; ".url" {$url++; [void]$atalhos.Add([PSCustomObject]@{ nome=$i.BaseName; extensao=".url"; origem=$(if ($area -eq ($env:PUBLIC + "\\Desktop")) { "publica" } else { "usuario" }) }) }; ".rdp" {$rdp++; [void]$atalhos.Add([PSCustomObject]@{ nome=$i.BaseName; extensao=".rdp"; origem=$(if ($area -eq ($env:PUBLIC + "\\Desktop")) { "publica" } else { "usuario" }) }) }; default {$outros++} }',
  '  }',
  '}',
  '$linhas.Add("AREA DE TRABALHO: $lnk atalho(s), $url link(s) web, $rdp arquivo(s) RDP e $outros outro(s) item(ns).")',
  '$anydesk = Get-ItemProperty "HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*","HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*" -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like "AnyDesk*" } | Select-Object -First 1',
  '$linhas.Add("ANYDESK: " + $(if ($anydesk) { "instalado" } else { "nao encontrado" }))',
  '$mstsc = Get-Command mstsc.exe -ErrorAction SilentlyContinue',
  '$linhas.Add("RDP: " + $(if ($mstsc) { "cliente Windows disponivel" } else { "cliente Windows nao encontrado" }))',
  '$np = @(Get-Item ($env:USERPROFILE + "\\Desktop\\NoPulso*.lnk"), ($env:APPDATA + "\\Microsoft\\Windows\\Start Menu\\Programs\\NoPulso*.lnk") -Force -ErrorAction SilentlyContinue).Count',
  '$linhas.Add("NOPULSO: " + $(if ($np -gt 0) { "$np atalho(s) localizado(s)" } else { "atalho nao localizado" }))',
  '$atalhosJson = @($atalhos | Select-Object -First 80) | ConvertTo-Json -Compress',
  '$linhas.Add("NOC_ATALHOS_JSON:$atalhosJson")',
  '$linhas.Add("RESULTADO: inventario somente-leitura; nenhuma alteracao foi feita.")',
  '$linhas -join "`n"',
].join('\n');

// Limpeza conservadora: só temporários do usuário e do Windows, mais Lixeira.
// Não toca em Downloads, Documentos, aplicações da loja ou serviços. Arquivo
// bloqueado é registrado como pulado e não faz o restante falhar.
const COMANDO_LIMPEZA_SEGURA = [
  '$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
  'if (-not $admin) { throw "Otimização segura exige o NOCZenith elevado (SYSTEM)." }',
  '$espacoLivre = { @(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" -ErrorAction SilentlyContinue | ForEach-Object { "$($_.DeviceID) $([math]::Round($_.FreeSpace / 1GB, 2)) GB livre" }) -join ", " }',
  '$antes = & $espacoLivre',
  '$apagados = 0; $falhas = 0; $pastas = @($env:TEMP, (Join-Path $env:WINDIR "Temp")) | Select-Object -Unique',
  'foreach ($pasta in $pastas) {',
  '  if (-not $pasta -or -not (Test-Path -LiteralPath $pasta)) { continue }',
  '  Get-ChildItem -LiteralPath $pasta -Force -ErrorAction SilentlyContinue | ForEach-Object {',
  '    try { Remove-Item -LiteralPath $_.FullName -Force -Recurse -ErrorAction Stop; $apagados++ } catch { $falhas++ }',
  '  }',
  '}',
  'try { Clear-RecycleBin -Force -ErrorAction Stop; $lixeira = "limpa" } catch { $lixeira = "não disponível/contém itens em uso" }',
  '$depois = & $espacoLivre',
  '"OTIMIZAÇÃO SEGURA: $apagados item(ns) temporário(s) removido(s) · $falhas pulado(s) por uso/permissão · Lixeira: $lixeira. Espaço livre antes: $antes · depois: $depois. Nenhum programa, documento ou download foi removido."',
].join('\n');

// Corrige SOMENTE limites deixados no carregamento do Windows (por exemplo,
// "Memória máxima" no msconfig). Não tenta "forçar" RAM que um Windows de
// 32 bits ou o hardware reservado para vídeo não pode entregar. Assim o
// resultado explica a causa real antes de uma alteração e só pede reinício
// quando um limite BCD foi realmente removido.
const COMANDO_CORRIGIR_MEMORIA_LIMITADA = [
  '$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
  'if (-not $admin) { throw "A correção de memória exige o NOCZenith elevado (SYSTEM)." }',
  '$os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop',
  '$pc = Get-CimInstance Win32_ComputerSystem -ErrorAction Stop',
  '$instalada = [math]::Round([double]$pc.TotalPhysicalMemory / 1GB, 2)',
  '$utilizavel = [math]::Round([double]$os.TotalVisibleMemorySize / 1MB, 2)',
  '$reservada = [math]::Max(0, [math]::Round($instalada - $utilizavel, 2))',
  '$arquitetura = [string]$os.OSArchitecture',
  '"MEMÓRIA: instalada $instalada GB · utilizável $utilizavel GB · diferença/reserva $reservada GB · Windows $arquitetura."',
  'if ($arquitetura -notmatch "64") { "NÃO ALTERADO: este é um Windows 32 bits, que usa cerca de 3,5 GB no máximo. Para usar toda a RAM, instale Windows 64 bits."; exit 0 }',
  '$bcdAntes = (& bcdedit /enum "{current}" 2>&1 | Out-String)',
  '$temRemover = $bcdAntes -match "(?im)^\\s*removememory\\s+"',
  '$temTruncar = $bcdAntes -match "(?im)^\\s*truncatememory\\s+"',
  'if (-not $temRemover -and -not $temTruncar) { "NÃO ALTERADO: não há limite de memória no boot do Windows. A diferença exibida é reserva de hardware/BIOS ou módulo de RAM; verifique vídeo integrado, encaixe e diagnóstico da memória."; exit 0 }',
  'if ($temRemover) { & bcdedit /deletevalue "{current}" removememory; if ($LASTEXITCODE -ne 0) { throw "Não foi possível remover o limite removememory." } }',
  'if ($temTruncar) { & bcdedit /deletevalue "{current}" truncatememory; if ($LASTEXITCODE -ne 0) { throw "Não foi possível remover o limite truncatememory." } }',
  '"CORRIGIDO: limite de inicialização removido. Reinicie a máquina para o Windows recalcular a memória utilizável."',
].join('\n');

// Remove suites e aplicativos do Office usando SOMENTE os desinstaladores
// registrados pelo Windows. Cobre MSI (Office antigo), Click-to-Run (Office
// moderno/Microsoft 365) e o pacote Microsoft Store. Não apaga pastas à mão,
// documentos do usuário nem runtimes compartilhados como Access Database
// Engine e Visual C++. Reinício, quando necessário, fica para a manutenção.
const COMANDO_REMOVER_OFFICE = [
  '$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
  'if (-not $admin) { throw "A remoção do Office exige o NOCZenith elevado (SYSTEM)." }',
  '$raizes = @("HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*", "HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*")',
  '$todos = @(Get-ItemProperty -Path $raizes -ErrorAction SilentlyContinue)',
  '$padrao = "(?i)^(Microsoft 365 Apps|Microsoft Office(?!.*(?:Database Engine|Shared|Proof|Language Pack|Telemetry|Click-to-Run Extensibility))|Microsoft (?:Word|Excel|PowerPoint|Outlook|Access|Publisher|OneNote|Project|Visio)\\b|Update for Microsoft Office)"',
  '$alvos = @($todos | Where-Object { $_.DisplayName -match $padrao } | Sort-Object @{Expression={ if ($_.DisplayName -match "(?i)^Update for") { 1 } else { 0 } }}, DisplayName)',
  '$removidos = New-Object System.Collections.Generic.List[string]',
  '$pulados = New-Object System.Collections.Generic.List[string]',
  '$falhas = New-Object System.Collections.Generic.List[string]',
  'foreach ($item in $alvos) {',
  '  $nome = [string]$item.DisplayName',
  '  try {',
  '    if ($item.UninstallString -match "(?i)msiexec(?:\\.exe)?") {',
  '      $args = "/x $($item.PSChildName) /qn /norestart"',
  '      $p = Start-Process -FilePath msiexec.exe -ArgumentList $args -Wait -PassThru -WindowStyle Hidden',
  '    } elseif ($item.QuietUninstallString) {',
  '      $p = Start-Process -FilePath cmd.exe -ArgumentList "/d", "/s", "/c", ([string]$item.QuietUninstallString) -Wait -PassThru -WindowStyle Hidden',
  '    } else { $pulados.Add("$nome (sem modo silencioso)"); continue }',
  '    if ($p.ExitCode -in @(0, 1641, 3010)) { $removidos.Add($nome) } else { $falhas.Add("$nome (código $($p.ExitCode))") }',
  '  } catch { $falhas.Add("$nome ($($_.Exception.Message))") }',
  '}',
  '$store = @(Get-AppxPackage -AllUsers -Name Microsoft.Office.Desktop -ErrorAction SilentlyContinue)',
  'foreach ($pacote in $store) { try { Remove-AppxPackage -Package $pacote.PackageFullName -AllUsers -ErrorAction Stop; $removidos.Add("Microsoft Office (Microsoft Store)") } catch { $falhas.Add("Microsoft Store ($($_.Exception.Message))") } }',
  '$provisionados = @(Get-AppxProvisionedPackage -Online -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq "Microsoft.Office.Desktop" })',
  'foreach ($pacote in $provisionados) { try { Remove-AppxProvisionedPackage -Online -PackageName $pacote.PackageName -AllUsers -ErrorAction Stop | Out-Null } catch { $falhas.Add("Office provisionado ($($_.Exception.Message))") } }',
  'if (-not $alvos.Count -and -not $store.Count -and -not $provisionados.Count) { "OK: nenhum Microsoft Office instalado foi encontrado."; exit 0 }',
  '"OFFICE: $($removidos.Count) componente(s) removido(s), $($pulados.Count) pulado(s), $($falhas.Count) falha(s). Documentos do usuário não foram apagados. Reinicie a máquina depois da manutenção."',
  'if ($removidos.Count) { "REMOVIDOS: " + ($removidos -join " | ") }',
  'if ($pulados.Count) { "PULADOS: " + ($pulados -join " | ") }',
  'if ($falhas.Count) { "FALHAS: " + ($falhas -join " | "); exit 1 }',
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

// REINICIAR O SERVICO DO ANYDESK, sem reiniciar a maquina. Pedido do
// Master: quando o AnyDesk cai, o acesso remoto some e a unica saida era
// reiniciar o computador inteiro - o que derruba o caixa junto, por causa de
// um servico so. Reiniciar o servico leva segundos e nao interrompe ninguem.
//
// Fixo no codigo como os outros, pelo mesmo motivo: rota que aceitasse texto
// livre seria "rodar qualquer coisa em toda a rede".
//
// Procura por PADRAO em vez do nome cravado: dependendo da versao e do tipo
// de instalacao o servico se chama AnyDesk, AnyDeskService ou traz o ID do
// cliente no nome. Cravar um nome so faria o comando "nao achar" numa parte
// do parque e ninguem saber por que.
//
// E DEVOLVE O ESTADO DEPOIS, nao um "ok": o Master precisa ver que o
// servico voltou a Running, senao o comando so prova que foi tentado.
// Reiniciar servico exige Administrador - a instancia de BOOT do NOCZenith
// roda como SYSTEM e da conta; se so existir a instancia de login sem
// privilegio, a mensagem de erro do Windows volta inteira em vez de um
// fracasso silencioso.
// DESTRAVAR A REDE DA MAQUINA, do mais leve pro mais pesado.
//
// A PERGUNTA DO MASTER ERA "como reiniciar a rede remotamente", pensando no
// TP-Link Load Balance da loja. Reiniciar o ROTEADOR daqui nao da: quando a
// internet cai, nada chega no agente - o comando so existiria pra um
// problema que ja impede o comando de chegar. O que DA pra fazer, e resolve
// boa parte do "a maquina perdeu a rede" com o link ainda de pe, e destravar
// a pilha de rede do proprio computador.
//
// A ORDEM E' A PARTE IMPORTANTE, e ela e' de propósito do mais leve pro mais
// pesado. Reiniciar a placa de rede derruba a UNICA via que temos ate essa
// maquina: se ela nao voltar, o computador some do NOC e so alguem indo na
// loja resolve. Entao a placa so e' tocada se o resto nao resolveu:
//   1. limpa o cache de DNS (custo zero, resolve "so nao abre site")
//   2. renova o DHCP (resolve IP perdido/conflito)
//   3. TESTA - se voltou, para aqui e nao mexe na placa
//   4. so entao reinicia a placa, espera e testa de novo
//
// Mexe so no adaptador que esta REALMENTE em uso (Up, com gateway): num
// servidor com varias placas, derrubar todas de uma vez pra consertar uma e
// o jeito de transformar um problema em tres.
const COMANDO_REDE_DESTRAVAR = [
  'function Rede-Ok {',
  '  try {',
  '    $r = Test-NetConnection -ComputerName "1.1.1.1" -Port 443 -WarningAction SilentlyContinue',
  '    return $r.TcpTestSucceeded',
  '  } catch { return $false }',
  '}',
  '$log = @()',
  '# 1) DNS: mais barato de tudo, e resolve o caso "pinga mas nao abre site"',
  'try { Clear-DnsClientCache; $log += "cache de DNS limpo" } catch { $log += "DNS: $($_.Exception.Message)" }',
  '# o adaptador que esta REALMENTE carregando a rede: Up e com gateway',
  '$ativo = Get-NetIPConfiguration -ErrorAction SilentlyContinue |',
  '  Where-Object { $_.NetAdapter.Status -eq "Up" -and $_.IPv4DefaultGateway } | Select-Object -First 1',
  'if (-not $ativo) { $log += "nenhum adaptador ativo com gateway - a maquina esta sem rede fisica" }',
  'else {',
  '  $nome = $ativo.InterfaceAlias',
  '  $log += "adaptador em uso: $nome"',
  '  # 2) DHCP: resolve IP perdido ou conflito, sem derrubar a placa',
  '  try { ipconfig /release "$nome" | Out-Null; ipconfig /renew "$nome" | Out-Null; $log += "DHCP renovado" }',
  '  catch { $log += "DHCP: $($_.Exception.Message)" }',
  '  Start-Sleep -Seconds 5',
  '  if (Rede-Ok) { $log += "rede respondeu - a placa NAO foi reiniciada" }',
  '  else {',
  '    # 3) ultimo recurso: derruba e sobe a placa. E a unica via ate esta',
  '    # maquina, entao so chega aqui quem ja tentou o resto',
  '    $log += "ainda sem internet - reiniciando a placa"',
  '    try { Restart-NetAdapter -Name $nome -Confirm:$false -ErrorAction Stop; $log += "placa reiniciada" }',
  '    catch {',
  '      $m = $_.Exception.Message',
  '      if ($m -match "Access is denied" -or $m -match "Acesso negado") { $m = "o NOCZenith desta maquina nao esta como Administrador - reinstale pelo botao Copiar comando num PowerShell como Administrador" }',
  '      $log += "placa: FALHOU - $m"',
  '    }',
  '    Start-Sleep -Seconds 20',
  '    if (Rede-Ok) { $log += "voltou" } else { $log += "AINDA SEM INTERNET - o problema esta fora do computador (link/roteador da loja)" }',
  '  }',
  '}',
  '$log -join " | "',
].join('\n');

const COMANDO_REINICIAR_ANYDESK = [
  '$svcs = @(Get-Service -ErrorAction SilentlyContinue |',
  "  Where-Object { $_.Name -like 'AnyDesk*' -or $_.DisplayName -like 'AnyDesk*' })",
  'if (-not $svcs) {',
  '  "Nenhum servico do AnyDesk encontrado nesta maquina."',
  '} else {',
  '  $saida = @()',
  '  $semAdmin = $false',
  '  foreach ($s in $svcs) {',
  '    try {',
  '      Restart-Service -InputObject $s -Force -ErrorAction Stop',
  '      $saida += "$($s.Name): reiniciado"',
  '    } catch {',
  // "Nao e possivel abrir o servico X no computador '.'" e como o Windows
  // diz ACESSO NEGADO. Foi o que voltou da STC-Servidor: o comando ACHOU o
  // servico e nao teve direito de mexer. Sem traduzir, o Master le uma frase
  // que parece defeito da maquina e nao tem o que fazer com ela - a acao
  // concreta e reinstalar o agente como Administrador (v17+ cria a tarefa de
  // boot, que roda como SYSTEM e tem o direito).
  '      $msg = $_.Exception.Message',
  '      if ($msg -match "abrir o servi" -or $msg -match "cannot open .* service" -or $msg -match "Access is denied" -or $msg -match "Acesso negado") {',
  '        $msg = "o NOCZenith desta maquina nao esta como Administrador - reinstale pelo botao Copiar comando num PowerShell como Administrador"',
  '        $semAdmin = $true',
  '      }',
  '      $saida += "$($s.Name): FALHOU - $msg"',
  '    }',
  '  }',
  // SAIDA SEM ADMINISTRADOR. Mexer no SERVICO exige elevacao; matar e
  // reabrir o PROCESSO do AnyDesk na sessao do usuario, nao. Foi o caso da
  // STC-Servidor: o comando achou o servico, levou acesso negado, e o
  // Master ficou sem nenhuma via ate a maquina.
  //
  // O QUE ISSO DEVOLVE, E O QUE NAO DEVOLVE: sem o servico de pe, o AnyDesk
  // roda em modo usuario - a maquina volta a aparecer online e aceita
  // conexao, mas o acesso NAO ASSISTIDO (entrar sem ninguem confirmar)
  // continua dependendo do servico. E' um paliativo pra recuperar o acesso
  // hoje, nao substituto de reinstalar o agente como Administrador - e a
  // mensagem diz isso, pra ninguem achar que resolveu de vez.
  //
  // So roda quando faltou privilegio: se o servico reiniciou, mexer no
  // processo por cima so atrapalharia.
  '  if ($semAdmin) {',
  '    try {',
  '      $proc = @(Get-Process -Name "AnyDesk" -ErrorAction SilentlyContinue)',
  '      $exe = $null',
  '      foreach ($p in $proc) { try { if ($p.Path) { $exe = $p.Path } } catch {} }',
  '      if (-not $exe) {',
  '        foreach ($c in @("$env:ProgramFiles\\AnyDesk\\AnyDesk.exe", "${env:ProgramFiles(x86)}\\AnyDesk\\AnyDesk.exe", "$env:APPDATA\\AnyDesk\\AnyDesk.exe")) {',
  '          if (Test-Path $c) { $exe = $c; break }',
  '        }',
  '      }',
  '      if (-not $exe) { $saida += "sem Administrador e nao achei o AnyDesk.exe pra reabrir" }',
  '      else {',
  '        foreach ($p in $proc) { try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {} }',
  '        Start-Sleep -Seconds 2',
  '        Start-Process -FilePath $exe -ErrorAction Stop',
  '        $saida += "AnyDesk reaberto na sessao do usuario (acesso nao assistido so volta com o servico - reinstale o NOCZenith como Administrador)"',
  '      }',
  '    } catch { $saida += "tentativa sem Administrador falhou: $($_.Exception.Message)" }',
  '  }',
  '  Start-Sleep -Seconds 4',
  '  $depois = @(Get-Service -ErrorAction SilentlyContinue |',
  "    Where-Object { $_.Name -like 'AnyDesk*' } | ForEach-Object { \"$($_.Name)=$($_.Status)\" })",
  '  ($saida + ("Estado agora: " + ($depois -join ", "))) -join " | "',
  '}',
].join('\n');

// Serviço do TEF mostrado como "GSurfRSA Listener". A lista é fechada: não
// aceitamos nome de serviço vindo da tela, pois isso transformaria a manutenção
// em execução remota arbitrária. Só as máquinas escolhidas pelo Master recebem
// este comando, pela mesma fila elevada usada pelo AnyDesk.
const COMANDO_REINICIAR_GSURF_RSA = [
  '$svc = @(Get-Service -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq "GSurfRSA Listener" -or $_.DisplayName -eq "GSurfRSA Listener" }) | Select-Object -First 1',
  'if (-not $svc) {',
  '  "Serviço GSurfRSA Listener não foi encontrado nesta máquina."',
  '} else {',
  '  try {',
  '    Restart-Service -InputObject $svc -Force -ErrorAction Stop',
  '    Start-Sleep -Seconds 3',
  '    $depois = Get-Service -Name $svc.Name -ErrorAction SilentlyContinue',
  '    "$($svc.Name): reiniciado · estado agora: $($depois.Status)"',
  '  } catch {',
  '    $msg = $_.Exception.Message',
  '    if ($msg -match "abrir o servi" -or $msg -match "cannot open .* service" -or $msg -match "Access is denied" -or $msg -match "Acesso negado") {',
  '      $msg = "o NOCZenith desta maquina nao esta como Administrador - reinstale pelo botao Copiar comando num PowerShell como Administrador"',
  '    }',
  '    "GSurfRSA Listener: FALHOU - $msg"',
  '  }',
  '}',
].join('\n');

// GcomClient.WCF e o cliente da GCOM que roda nas VMs marcadas como GCOM no
// NOC. Em algumas delas ele fica travado, mas o proprio ambiente da VM ja tem
// o mecanismo que o sobe de novo. Portanto esta manutencao NAO tenta iniciar
// executavel, reiniciar servico ou reiniciar o Windows: encerra somente o
// processo exato e devolve ao NOC se ele realmente saiu.
//
// O nome e fechado no codigo (nao vem da tela), para a acao nunca virar um
// "encerrar qualquer processo" remoto.
const COMANDO_ENCERRAR_GCOM_WCF = [
  '$nome = "GcomClient.WCF"',
  '$processos = @(Get-Process -Name $nome -ErrorAction SilentlyContinue)',
  'if (-not $processos) {',
  '  "GcomClient.WCF.exe não estava em execução nesta VM."',
  '} else {',
  '  $pids = @($processos | ForEach-Object { $_.Id })',
  '  foreach ($p in $processos) {',
  '    try { Stop-Process -Id $p.Id -Force -ErrorAction Stop }',
  '    catch { "GcomClient.WCF.exe: FALHOU ao encerrar PID $($p.Id) - $($_.Exception.Message)"; exit 1 }',
  '  }',
  '  Start-Sleep -Milliseconds 800',
  '  $restantes = @(Get-Process -Name $nome -ErrorAction SilentlyContinue)',
  '  if ($restantes) {',
  '    "GcomClient.WCF.exe: FALHOU - ainda em execução (PID(s): $(@($restantes | ForEach-Object { $_.Id }) -join \", \"))."',
  '  } else {',
  '    "GcomClient.WCF.exe encerrado (PID(s): $($pids -join \", \")). A reinicialização automática da VM assumirá daqui."',
  '  }',
  '}',
].join('\n');

function comandoEncerrarGcomWcf(doc) {
  if (!doc || !doc.temGcom) {
    throw new Error('esta máquina não está marcada como “Possui GCOM”; marque a VM antes de usar esta ação.');
  }
  return COMANDO_ENCERRAR_GCOM_WCF;
}

// RESET DA ZEBRA POR ZPL, sem ir na loja. Pedido do Master: "o mesmo botao
// do AnyDesk, mas que faz o reset da impressora Zebra pelo ZPL - o codigo
// executaria de acordo com a impressora Zebra que esteja com a tag que foi
// criada".
//
// A TAG E A TRAVA, e e a mesma de sempre: os IPs saem de
// impressorasPraSondar(), que so devolve dispositivo com monitorar +
// tipo 'impressora' + marca 'zebra'. Nao ha caminho pra um IP entrar aqui
// sem o Master ter marcado a impressora como Zebra na tela - e mandar ZPL
// numa Bematech faria ela IMPRIMIR "~JA~JR" num cupom, que e' exatamente o
// defeito que ja aconteceu uma vez com o ~HS.
//
// O IP e' o UNICO pedaco variavel, e ele nao vem do navegador: vem do
// cadastro do proprio servidor. Ainda assim passa por validacao estrita
// antes de entrar na string do PowerShell - IP e' dado que o agente
// reportou, e dado reportado nunca entra cru num comando.
//
// DOIS COMANDOS ZPL, nesta ordem:
//   ~JA = Cancel All - descarta o que estiver preso na fila da impressora.
//         Vem antes pra que o trabalho travado nao volte a imprimir depois.
//   ~JR = Power On Reset - reinicia a impressora como se tivesse sido
//         desligada na tomada. Ela cai da rede e leva ~30s pra voltar.
// Por isso a resposta nao pode ser lida depois do ~JR: a conexao morre
// junto. O comando espera e tenta reconectar, so pra dizer se ela voltou.
const RESET_ZEBRA_MAX = 8;
function ipValido(ip) {
  const partes = String(ip || '').trim().split('.');
  return partes.length === 4 && partes.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255);
}
function comandoResetZebra(impressoras) {
  const ips = [...new Set((impressoras || []).map((i) => String((i && i.ip) || '').trim()))]
    .filter(ipValido).slice(0, RESET_ZEBRA_MAX);
  // sem Zebra marcada nao ha o que resetar - devolve null pra quem chamou
  // recusar o alvo com motivo, em vez de mandar um comando que nao faz nada
  if (!ips.length) return null;
  const lista = ips.map((ip) => `'${ip}'`).join(',');
  return [
    `$alvos = @(${lista})`,
    '$log = @()',
    '# FILA DO WINDOWS. O ~JA/~JR abaixo limpa o buffer DA IMPRESSORA, nao a',
    '# fila do spooler da maquina - e e ela que o Master viu com 14 "Pulse',
    '# Label 1" presos, um deles em "Erro - Impressao" (13/09). Enquanto',
    '# houver trabalho ali, o Windows reenvia tudo assim que a Zebra volta e o',
    '# reset nao resolve nada. Entao a fila vai junto, e ANTES do reset: limpar',
    '# depois deixaria a impressora recem-reiniciada receber a enxurrada.',
    '#',
    '# So as impressoras cujo PORTA aponta pro IP que estamos resetando - a',
    '# fila da termica da cozinha e a da fiscal nao podem ser tocadas por',
    '# tabela.',
    'function Limpar-FilaDoIp($ip) {',
    '  try {',
    '    $portas = @(Get-CimInstance Win32_TCPIpPrinterPort -ErrorAction Stop | Where-Object { $_.HostAddress -eq $ip } | Select-Object -ExpandProperty Name)',
    '    if (-not $portas) { return "sem fila no Windows" }',
    '    $impressoras = @(Get-CimInstance Win32_Printer -ErrorAction Stop | Where-Object { $portas -contains $_.PortName })',
    '    if (-not $impressoras) { return "sem fila no Windows" }',
    '    $antes = 0; $nomes = @()',
    '    foreach ($imp in $impressoras) {',
    '      $nomes += $imp.Name',
    '      $antes += @(Get-CimInstance Win32_PrintJob -ErrorAction SilentlyContinue | Where-Object { $_.Name -like ($imp.Name + ",*") }).Count',
    '      try { Invoke-CimMethod -InputObject $imp -MethodName CancelAllJobs -ErrorAction Stop | Out-Null } catch {}',
    '    }',
    '    if ($antes -eq 0) { return "fila do Windows ja estava vazia" }',
    '    Start-Sleep -Milliseconds 800',
    '    $resta = 0',
    '    foreach ($imp in $impressoras) { $resta += @(Get-CimInstance Win32_PrintJob -ErrorAction SilentlyContinue | Where-Object { $_.Name -like ($imp.Name + ",*") }).Count }',
    '    # Trabalho que nao sai nem com CancelAllJobs esta travado no proprio',
    '    # spooler (o caso do "Erro - Impressao"). Soltar exigiria reiniciar o',
    '    # servico, e ESTE comando nao mexe em servico da maquina - e a garantia',
    '    # que o teste do reset da Zebra crava, porque o spooler e compartilhado',
    '    # com a termica da cozinha e a fiscal. Entao aqui so' + "\u0027" + ' RELATA: quem le o',
    '    # resultado no NOC ve o numero e decide.',
    '    if ($resta -gt 0) { return "$antes na fila do Windows, $resta travado(s) no spooler - esses nao saem sem reiniciar o servico de impressao da maquina" }',
    '    return "$antes trabalho(s) apagado(s) da fila do Windows"',
    '  } catch { return "fila do Windows nao pode ser lida: $($_.Exception.Message)" }',
    '}',
    'function Zpl-Enviar($ip, $texto) {',
    '  $cli = New-Object System.Net.Sockets.TcpClient',
    '  try {',
    '    $c = $cli.BeginConnect($ip, 9100, $null, $null)',
    '    if (-not $c.AsyncWaitHandle.WaitOne(2000, $false)) { return "sem resposta na 9100" }',
    '    $cli.EndConnect($c)',
    '    $cli.SendTimeout = 2000',
    '    $st = $cli.GetStream()',
    '    $b = [System.Text.Encoding]::ASCII.GetBytes($texto)',
    '    $st.Write($b, 0, $b.Length); $st.Flush()',
    '    Start-Sleep -Milliseconds 300',
    '    return $null',
    '  } catch { return $_.Exception.Message } finally { try { $cli.Close() } catch {} }',
    '}',
    'foreach ($ip in $alvos) {',
    '  $log += "${ip}: " + (Limpar-FilaDoIp $ip)',
    '  $erro = Zpl-Enviar $ip "~JA"',
    '  if ($erro) { $log += "${ip}: FALHOU - $erro"; continue }',
    // o ~JR derruba a conexao: nao da pra confirmar aqui, so mais adiante
    '  $erro = Zpl-Enviar $ip "~JR"',
    '  if ($erro) { $log += "${ip}: fila limpa, mas o reset falhou - $erro" }',
    '  else { $log += "${ip}: fila limpa e reset enviado" }',
    '}',
    '# a Zebra leva ~30s pra voltar; a espera fica FORA do laco pra nao',
    '# multiplicar por impressora',
    'Start-Sleep -Seconds 25',
    'foreach ($ip in $alvos) {',
    '  $cli = New-Object System.Net.Sockets.TcpClient',
    '  try {',
    '    $c = $cli.BeginConnect($ip, 9100, $null, $null)',
    '    if ($c.AsyncWaitHandle.WaitOne(2500, $false)) { $cli.EndConnect($c); $log += "${ip}: voltou" }',
    '    else { $log += "${ip}: ainda subindo" }',
    '  } catch { $log += "${ip}: ainda subindo" } finally { try { $cli.Close() } catch {} }',
    '}',
    '$log -join " | "',
  ].join('\n');
}

// janela de arrependimento: cancela um reinício que ainda está na contagem
const COMANDO_ABORTAR_REINICIO = [
  'try { shutdown /a; "Reinicio abortado." } catch { "Nao havia reinicio em contagem." }',
].join('\n');

// Nome tratado como dado literal: nunca interpolar em codigo PowerShell executavel.
function comandoResetSenha(nomeConta) {
  if (typeof nomeConta !== 'string' || !nomeConta.trim() || nomeConta.trim().length > 20 || /[\x00-\x1f\x7f"/\\[\]:;|=,+*?<>@]/.test(nomeConta)) {
    throw new Error('Informe um nome de conta local válido (até 20 caracteres).');
  }
  const literal = nomeConta.trim().replace(/'/g, "''");
  return [
    "$usuario = '" + literal + "'",
    'try {',
    '  $conta = @(Get-LocalUser -ErrorAction Stop | Where-Object { $_.Name -eq $usuario })',
    '  if ($conta.Count -ne 1) { throw "Conta local nao encontrada: $usuario" }',
    '  if ($conta[0].SID.Value -match "-(500|501|503|504)$") { throw "Conta interna do Windows protegida." }',
    '  if (-not $conta[0].Enabled) { throw "A conta esta desabilitada." }',
    '  $pass = New-Object System.Security.SecureString',
    '  Set-LocalUser -Name $conta[0].Name -Password $pass -ErrorAction Stop',
    '  "Senha removida da conta $usuario."',
    '} catch {',
    '  "Erro ao remover a senha de ${usuario}: $_"',
    '  exit 1',
    '}',
  ].join('\n');
}

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
      // `comando` pode ser uma FUNCAO: o reset da Zebra muda de unidade pra
      // unidade, porque leva os IPs das impressoras daquela loja. Continua
      // sem aceitar texto de fora - quem chama passa uma funcao do codigo.
      const texto = typeof comando === 'function' ? await comando(doc) : comando;
      if (!texto) throw new Error('nenhuma impressora Zebra marcada nesta unidade');
      await enfileirarComando(doc.codigo, doc.posto, texto, opcoes);
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

// ---------------------------------------------------------------------
// REINICIO AUTOMATICO PROGRAMADO
//
// Pedido do Master: "local para configurar um horario para reiniciar o
// computador de forma automatica - escolho qual reinicia todos os dias as
// 4h", e depois "horario pode variar": dia da semana escolhido, hora
// diferente por dia e tolerancia no horario.
//
// Por isso o plano e SEMANAL, e nao "uma hora": reinicioSemanal e um mapa
// dia -> 'HH:MM' (ou null, que significa "nesse dia nao reinicia"). Um so
// campo cobre as tres coisas - "todo dia as 4h" e o mapa com os 7 iguais,
// "so de segunda a sexta" e o mapa com sabado e domingo em null, e "domingo
// as 3h" e um valor diferente num dia so. Dois campos (um pra hora, outro
// pros dias) dariam duas fontes de verdade pro mesmo agendamento.
//
// QUEM DISPARA e o servidor, num timer de 1 minuto (ver index.js). Ele le o
// ESPELHO em memoria, entao perguntar "tem alguem marcado pra agora?" a cada
// minuto NAO custa leitura no Firestore. So quando uma maquina bate o
// horario e que ha escrita - a mesma que o reinicio manual ja fazia.
//
// A HORA, O DIA E O DIA DA SEMANA SAO DE BRASILIA. O servidor roda em UTC:
// "4h" cravado em UTC vira 1h da manha aqui, e "domingo" vira sabado pra
// qualquer horario antes das 21h. Por isso tudo passa por agoraBrasilia().
//
// TOLERANCIA e ate quanto tempo depois da hora marcada ainda vale reiniciar.
// Ela existe porque o disparo depende do servidor estar de pe naquele
// minuto: um deploy ou um reinicio do servico as 4h em ponto, sem folga,
// pulava a noite inteira em silencio. O padrao de 6 min cobre um deploy;
// quem quiser cobrir uma queda mais longa sobe pra 30, 60 ou 120.
//
// TRAVA por ocorrencia ("dia|hora"), e nao por dia: dentro da tolerancia a
// maquina reiniciaria de novo a cada volta do timer. Guardar a HORA junto faz
// a troca de horario valer no mesmo dia - mudou de 04:00 pra 22:00 as 10h da
// manha, reinicia hoje as 22:00, sem precisar zerar nada na mao.
const DIAS_SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
const REINICIO_TOLERANCIA_PADRAO_MIN = 6;
const REINICIO_TOLERANCIA_MAX_MIN = 240;
const REINICIO_DIARIO_ORIGEM = 'reinicio-diario';
const HORA_DIARIA_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
function horaDiariaValida(v) { return typeof v === 'string' && HORA_DIARIA_RE.test(v); }
function minutosDaHora(hhmm) { const [h, m] = String(hhmm).split(':'); return (Number(h) * 60) + Number(m); }

// normaliza o que vem da tela: so os 7 dias conhecidos, so 'HH:MM' valido,
// e devolve null se nao sobrou nenhum dia (que e o mesmo que desligar).
// Hora invalida em QUALQUER dia derruba o plano inteiro em vez de gravar
// meio agendamento: metade dos dias valendo e metade nao e pior do que
// recusar e dizer por que.
function planoSemanalValido(entrada) {
  if (!entrada || typeof entrada !== 'object') return null;
  const plano = {};
  let algum = false;
  for (const dia of DIAS_SEMANA) {
    const v = entrada[dia];
    if (v === undefined || v === null || v === '') { plano[dia] = null; continue; }
    if (!horaDiariaValida(v)) throw new Error('Horário inválido - use HH:MM, de 00:00 a 23:59.');
    plano[dia] = v;
    algum = true;
  }
  return algum ? plano : null;
}

// COMPAT de leitura (nao migracao): a primeira versao deste recurso guardava
// UMA hora em reinicioDiario, valendo pra todo dia. Se um documento ainda
// estiver assim, ele e lido como os 7 dias naquela hora. Quem grava sempre
// grava o plano semanal - ninguem reescreve documento antigo por conta.
function planoSemanalDe(doc) {
  if (doc && doc.reinicioSemanal && typeof doc.reinicioSemanal === 'object') return doc.reinicioSemanal;
  if (doc && horaDiariaValida(doc.reinicioDiario)) {
    return DIAS_SEMANA.reduce((acc, d) => { acc[d] = doc.reinicioDiario; return acc; }, {});
  }
  return null;
}
function toleranciaDe(doc) {
  const n = Number(doc && doc.reinicioTolerancia);
  if (!Number.isFinite(n) || n < 1) return REINICIO_TOLERANCIA_PADRAO_MIN;
  return Math.min(Math.round(n), REINICIO_TOLERANCIA_MAX_MIN);
}
function toleranciaValida(v) {
  if (v === undefined || v === null || v === '') return REINICIO_TOLERANCIA_PADRAO_MIN;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1 || n > REINICIO_TOLERANCIA_MAX_MIN) {
    throw new Error(`Tolerância inválida - use de 1 a ${REINICIO_TOLERANCIA_MAX_MIN} minutos.`);
  }
  return Math.round(n);
}

function agoraBrasilia(ms) {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms == null ? Date.now() : ms))
    .reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const dia = `${partes.year}-${partes.month}-${partes.day}`;
  return {
    dia,
    minutos: (Number(partes.hour) * 60) + Number(partes.minute),
    // dia da semana a partir da DATA de Brasilia, ao meio-dia UTC: nao passa
    // perto de nenhuma virada, entao nunca escorrega um dia
    diaSemana: new Date(`${dia}T12:00:00Z`).getUTCDay(),
  };
}
function diaAnterior(dia) {
  const d = new Date(`${dia}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// A ocorrencia que esta acontecendo AGORA pra um computador marcado, ou null.
// Devolve a chave "dia|hora" que vai pra trava.
//
// Olha DUAS candidatas, a de hoje e a de ontem, porque um horario perto da
// meia-noite (ou uma tolerancia grande) atravessa a virada do dia: as 00:10
// de segunda, o que esta atrasado 12 min e o agendamento de DOMINGO as
// 23:58 - e o dia da semana a consultar e o de ontem, nao o de hoje.
function ocorrenciaDoReinicioDiario(doc, ms) {
  if (!doc || doc.tipo !== 'interno') return null;
  const plano = planoSemanalDe(doc);
  if (!plano) return null;
  const tolerancia = toleranciaDe(doc);
  const agora = agoraBrasilia(ms);
  const candidatas = [
    { dia: agora.dia, hora: plano[DIAS_SEMANA[agora.diaSemana]], base: agora.minutos },
    { dia: diaAnterior(agora.dia), hora: plano[DIAS_SEMANA[(agora.diaSemana + 6) % 7]], base: agora.minutos + (24 * 60) },
  ];
  for (const c of candidatas) {
    if (!horaDiariaValida(c.hora)) continue;
    const atraso = c.base - minutosDaHora(c.hora);
    if (atraso < 0 || atraso >= tolerancia) continue;
    const chave = `${c.dia}|${c.hora}`;
    if (doc.reinicioDiarioUltima === chave) continue;
    return chave;
  }
  return null;
}

// resumo curto pro historico e pros logs ("seg, ter, qua, qui, sex às 04:00"
// / "dom às 03:00 · seg a sex às 04:00")
const DIAS_ROTULO = { dom: 'dom', seg: 'seg', ter: 'ter', qua: 'qua', qui: 'qui', sex: 'sex', sab: 'sáb' };
function resumoDoPlano(plano) {
  if (!plano) return 'desligado';
  const porHora = new Map();
  for (const dia of DIAS_SEMANA) {
    const h = plano[dia];
    if (!horaDiariaValida(h)) continue;
    if (!porHora.has(h)) porHora.set(h, []);
    porHora.get(h).push(DIAS_ROTULO[dia]);
  }
  if (!porHora.size) return 'desligado';
  return [...porHora.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([h, dias]) => `${dias.length === 7 ? 'todo dia' : dias.join(', ')} às ${h}`)
    .join(' · ');
}

// liga/desliga em LOTE (a tela manda a lista marcada). Espelha o formato de
// enfileirarComandoEmAlvos de proposito: alvo que nao e computador interno
// volta recusado, com o motivo, em vez de sumir em silencio.
async function definirReinicioDiario(alvos, semanal, tolerancia, porEmail) {
  const plano = planoSemanalValido(semanal);
  const tol = toleranciaValida(tolerancia);
  const docs = await listUncached();
  const querido = new Set((alvos || []).map((a) => `${a.codigo}|${a.posto}`));
  const escolhidos = docs.filter((d) => d.tipo === 'interno' && querido.has(`${d.codigo}|${d.posto}`));
  const feitos = [];
  for (const doc of escolhidos) {
    const em = Date.now();
    // fica no historico do computador: quem ligou, quando e pra quando.
    // Uma maquina que reinicia sozinha as 4h sem rastro vira chamado de TI.
    const detalhe = plano
      ? `reinício automático: ${resumoDoPlano(plano)} (tolerância ${tol} min, por ${porEmail || '—'})`
      : `reinício automático desligado (${porEmail || '—'})`;
    await gravarEEspelhar(doc.codigo, doc.posto, {
      reinicioSemanal: plano,
      // zera o campo da primeira versao: com os dois gravados, um documento
      // antigo continuaria valendo por baixo do plano novo
      reinicioDiario: null,
      reinicioTolerancia: plano ? tol : null,
      reinicioDiarioPorEmail: porEmail || null,
      reinicioDiarioEm: em,
      eventos: [...(doc.eventos || []), { tipo: 'reinicio-diario-config', em, detalhe }].slice(-EVENTOS_MAX),
    });
    feitos.push({ codigo: doc.codigo, posto: doc.posto, nome: doc.nome, ok: true });
  }
  const naoElegiveis = (alvos || [])
    .filter((a) => !escolhidos.some((d) => d.codigo === a.codigo && d.posto === a.posto))
    .map((a) => ({ ...a, ok: false, motivo: 'não é um computador interno com NOCZenith' }));
  return [...feitos, ...naoElegiveis];
}

async function marcarOcorrenciaFeita(doc, chave, detalhe) {
  const em = Date.now();
  await gravarEEspelhar(doc.codigo, doc.posto, {
    reinicioDiarioUltima: chave,
    reinicioDiarioUltimoEm: em,
    eventos: [...(doc.eventos || []), { tipo: REINICIO_DIARIO_ORIGEM, em, detalhe }].slice(-EVENTOS_MAX),
  });
}

// Roda no timer de 1 minuto. Em serie de proposito: sao poucas maquinas por
// minuto e cada enfileirarComando ja faz 3 idas ao Firestore - disparar o
// parque inteiro em paralelo as 4h nao ganha nada e so concentra escrita.
async function varrerReinicioDiario(ms) {
  const docs = await listUncached();
  const feitos = [];
  for (const doc of docs) {
    const chave = ocorrenciaDoReinicioDiario(doc, ms);
    if (!chave) continue;
    const hora = chave.split('|')[1];
    const detalhe = `reinício automático das ${hora}`;
    try {
      await enfileirarComando(doc.codigo, doc.posto, COMANDO_REINICIAR, { origem: REINICIO_DIARIO_ORIGEM });
      // o NOC precisa saber que o sumico da maquina foi ELE que pediu - senao
      // o push de queda afirma "verifique a internet da loja" as 4h da manha
      await marcarReinicioComandado(doc.codigo, doc.posto);
      await marcarOcorrenciaFeita(doc, chave, detalhe);
      feitos.push({ codigo: doc.codigo, posto: doc.posto, nome: doc.nome, hora });
    } catch (err) {
      // ja tem comando na fila: a maquina ja vai reiniciar por outro caminho.
      // Marcar evita o timer insistir a cada minuto da tolerancia.
      if (/comando pendente/i.test(err.message || '')) {
        await marcarOcorrenciaFeita(doc, chave, `${detalhe} - já havia comando na fila`);
        continue;
      }
      // qualquer outra falha fica SEM marcar: sobra o resto da tolerancia pra
      // tentar de novo, e depois disso o dia passa (melhor do que insistir
      // pra sempre numa maquina que nao aceita comando)
      console.error(`[NOC] reinício automático de ${doc.nome || doc.posto} falhou: ${err.message}`);
    }
  }
  return feitos;
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
  // QUAL endereco, quando ha mais de uma leitura. O caso real (Dom Bessa,
  // 13/09/2026): a impressora trocou de .54 pra .52 e o reset foi parar no
  // .54 - "FALHOU - sem resposta na 9100". A regra antiga pegava a PRIMEIRA
  // leitura da primeira maquina, e leitura velha ganhava da leitura de agora.
  //
  // Agora e' por FRESCOR, em duas chaves: quem esta ativo vence quem nao esta,
  // e entre iguais vence quem foi visto por ultimo. O computador que vai rodar
  // o comando continua tendo preferencia, mas so' como desempate - a rede dele
  // e' a que precisa alcancar a impressora, e isso nao vale mais do que estar
  // olhando pro endereco certo.
  // mesma tradução MAC -> endereco de agora usada pelo reset (uma regra so').
  // Entre impressoras diferentes, vence a leitura mais fresca; o computador
  // que vai rodar o comando so' desempata - a rede dele e' a que precisa
  // alcancar a impressora, mas isso nao vale mais do que olhar pro endereco
  // certo.
  const candidatos = [...macsImpressora]
    .map((mac) => enderecoAtualDoMac(docs, codigo, mac))
    .filter(Boolean)
    .sort((a, b) => (b.ativo ? 1 : 0) - (a.ativo ? 1 : 0)
      || (b.visto || 0) - (a.visto || 0)
      || ((b.doc.posto === posto) ? 1 : 0) - ((a.doc.posto === posto) ? 1 : 0));
  if (candidatos.length) return candidatos[0].ip;
  throw new Error('A impressora dessa unidade esta marcada, mas nenhum computador da loja viu o IP dela na ultima varredura de rede. Confira se ela esta ligada na rede.');
}

const LIMITE_COMANDOS_POR_MAQUINA = 20;
function filaDeComandos(doc) {
  const fila = Array.isArray(doc && doc.comandosFilaIds) ? doc.comandosFilaIds : [];
  const atual = doc && doc.comandoPendenteId ? [doc.comandoPendenteId] : [];
  return [...new Set([...fila, ...atual].map((id) => String(id || '').trim()).filter(Boolean))];
}
function proximoDaFila(fila, concluido) {
  return fila.find((id) => id !== String(concluido || '')) || null;
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
  const filaAtual = filaDeComandos(atual);
  if (filaAtual.length >= LIMITE_COMANDOS_POR_MAQUINA) throw new Error(`Esta máquina já tem ${LIMITE_COMANDOS_POR_MAQUINA} comandos na fila. Aguarde executar ou cancele algum pendente.`);
  const op = opcoes || {};
  // troca o placeholder ANTES de gravar: o que fica registrado (e o que o
  // Master ve no historico) e o comando de verdade que a maquina rodou
  const comandoFinal = comando.includes(PLACEHOLDER_IP_IMPRESSORA)
    ? comando.split(PLACEHOLDER_IP_IMPRESSORA).join(await resolverIpImpressora(codigo, posto))
    : comando;
  // Alguns comandos operacionais precisam de uma camada de execução (por
  // exemplo, limite de tempo), mas o histórico deve manter o texto que o
  // Master escreveu. `comandoEntrega` é privado do canal servidor→agente;
  // nunca é devolvido à tela nem sobrescreve a trilha de auditoria.
  const comandoEntrega = op.comandoEntrega ? String(op.comandoEntrega) : null;
  const comandoRef = COMANDOS_COLLECTION.doc();
  const registro = {
    id: comandoRef.id, codigo, posto, comando: comandoFinal,
    comandoEntrega,
    // A fila de monitoramento precisa identificar o alvo sem consultar toda a
    // coleção de computadores. É só nome/unidade já visível ao Master, nunca
    // o conteúdo do PowerShell nem resultado que possa conter dado sensível.
    nomeComputador: atual.nome || posto,
    unidadeCodigo: codigo,
    origem: op.origem || 'agente', acaoId: op.acaoId || null, aprovacaoId: op.aprovacaoId || null,
    solicitadoPor: op.solicitadoPor || null,
    // requerAdmin: comando que so roda elevado (instalar/desinstalar). O
    // servidor SO entrega pra um heartbeat que provou ser Administrador (a
    // instancia SYSTEM do NOCZenith) - ver entregarComandoPendente/heartbeat.
    // Sem isso, a instancia de LOGIN (usuario comum) pegava o comando e ele
    // "pulava" na maquina, exatamente o problema que esta entrega resolve.
    requerAdmin: !!op.requerAdmin,
    status: 'pendente', criadoEm: new Date().toISOString(),
    entregueEm: null, executadoEm: null, resultado: null, erro: null,
  };
  await comandoRef.set(registro);
  await db.runTransaction(async (tx) => {
    const comp = await tx.get(ref);
    if (!comp.exists) throw new Error('Computador não encontrado.');
    const fila = filaDeComandos(comp.data());
    if (fila.length >= LIMITE_COMANDOS_POR_MAQUINA) throw new Error(`Esta máquina já tem ${LIMITE_COMANDOS_POR_MAQUINA} comandos na fila.`);
    fila.push(comandoRef.id);
    tx.update(ref, { comandosFilaIds: fila, comandoPendenteId: comp.data().comandoPendenteId || fila[0] });
  });
  cache.invalidar();
  return registro;
}

// A tela de diagnóstico mostra o andamento do ping sem expor o texto do
// PowerShell. Só o resultado que o agente devolveu é necessário para operação.
async function detalharComando(comandoId) {
  const snap = await COMANDOS_COLLECTION.doc(String(comandoId || '')).get();
  if (!snap.exists) return null;
  const c = snap.data();
  return {
    id: snap.id, codigo: c.codigo, posto: c.posto, origem: c.origem || null,
    status: c.status || 'pendente', criadoEm: c.criadoEm || null,
    entregueEm: c.entregueEm || null, executadoEm: c.executadoEm || null,
    canceladoEm: c.canceladoEm || null, canceladoPor: c.canceladoPor || null,
    resultado: c.resultado || null, erro: c.erro || null,
  };
}

// Cancela antes da entrega OU arquiva como cancelado um comando que já fechou
// em erro. Depois que o agente recebe um PowerShell ainda em execução, não há
// forma genérica e segura de "desexecutá-lo"; fingir que o X parou algo seria
// perigoso. O erro original permanece no documento para auditoria.
async function cancelarComandoPendente(comandoId, porEmail) {
  const id = String(comandoId || '').trim();
  if (!id) throw new Error('Comando inválido.');
  const comandoRef = COMANDOS_COLLECTION.doc(id);
  let retorno = null;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(comandoRef);
    if (!snap.exists) throw new Error('Comando não encontrado.');
    const comando = snap.data();
    if (!['pendente', 'erro'].includes(comando.status)) {
      throw new Error(comando.status === 'entregue'
        ? 'Este comando já foi entregue à máquina e não pode ser cancelado por aqui.'
        : 'Este comando já foi finalizado.');
    }
    const agora = new Date().toISOString();
    const computadorRef = COLLECTION.doc(docIdFor(comando.codigo, comando.posto));
    const computador = await tx.get(computadorRef);
    // Retira só este item. Se ele era a cabeça, promove o próximo sem perder
    // os demais comandos que o Master já deixou preparados.
    if (computador.exists) {
      const fila = filaDeComandos(computador.data()).filter((item) => item !== id);
      const eraCabeca = computador.data().comandoPendenteId === id;
      tx.update(computadorRef, {
        comandosFilaIds: fila,
        comandoPendenteId: eraCabeca ? (fila[0] || null) : computador.data().comandoPendenteId || (fila[0] || null),
        ...(eraCabeca ? { comandoAguardandoElevacaoDesde: null } : {}),
      });
    }
    const patch = {
      status: 'cancelado', canceladoEm: agora,
      canceladoPor: String(porEmail || '').slice(0, 160) || null,
      canceladoAposErro: comando.status === 'erro',
    };
    tx.update(comandoRef, patch);
    retorno = { id, ...patch, codigo: comando.codigo, posto: comando.posto };
  });
  cache.invalidar();
  return retorno;
}

// chamado de dentro do heartbeat() - transacao sobre 1 documento so (nao
// precisa de indice composto: o comandoPendenteId ja diz exatamente qual
// comando buscar). Marca 'entregue' e devolve o texto do comando pro
// NOCZenith rodar; se ja tiver sido entregue antes (heartbeat duplicado),
// nao entrega de novo
// comando-admin que ninguem elevado veio buscar (maquina sem Administrador):
// marca o comando como erro e libera a vaga unica de comando do computador.
async function marcarComandoExpiradoSemAdmin(comandoId, codigo, posto, msg) {
  const comandoRef = COMANDOS_COLLECTION.doc(String(comandoId || ''));
  const ref = COLLECTION.doc(docIdFor(codigo, posto));
  await db.runTransaction(async (tx) => {
    const cs = await tx.get(comandoRef);
    // so mexe se ainda for ESTE o pendente e ainda estiver pendente: entre a
    // leitura da varredura e aqui, a instancia SYSTEM pode ter chegado
    const rs = await tx.get(ref);
    if (rs.exists && rs.data().comandoPendenteId === comandoId) {
      const fila = filaDeComandos(rs.data()).filter((id) => id !== String(comandoId));
      tx.update(ref, { comandosFilaIds: fila, comandoPendenteId: fila[0] || null, comandoAguardandoElevacaoDesde: null });
    }
    if (cs.exists && cs.data().status === 'pendente') {
      tx.update(comandoRef, { status: 'erro', erro: msg, executadoEm: new Date().toISOString() });
    }
  });
  cache.invalidar();
}

// Não há como cancelar com segurança um PowerShell que já chegou à máquina.
// Mas, se ela não devolve resultado dentro do teto, o estado "entregue" deixa
// de ser honesto. Fecha como erro e libera SOMENTE a vaga que ainda pertence
// a este comando; uma resposta tardia é descartada por marcarComandoExecutado.
async function marcarComandoTravado(comandoId, codigo, posto) {
  const comandoRef = COMANDOS_COLLECTION.doc(String(comandoId || ''));
  const computadorRef = COLLECTION.doc(docIdFor(codigo, posto));
  let travou = false;
  await db.runTransaction(async (tx) => {
    const comandoSnap = await tx.get(comandoRef);
    if (!comandoSnap.exists) return;
    const comando = comandoSnap.data();
    const entregueEm = new Date(comando.entregueEm || 0).getTime();
    if (comando.status !== 'entregue' || !Number.isFinite(entregueEm) || Date.now() - entregueEm < COMANDO_EXECUCAO_TIMEOUT_MS) return;
    const computadorSnap = await tx.get(computadorRef);
    const agora = new Date().toISOString();
    const erro = 'Tempo limite de execução atingido: o agente não devolveu resultado em 10 minutos. Verifique a máquina e envie novamente se necessário.';
    tx.update(comandoRef, { status: 'erro', erro, executadoEm: agora });
    if (computadorSnap.exists && computadorSnap.data().comandoPendenteId === String(comandoId)) {
      const fila = filaDeComandos(computadorSnap.data()).filter((id) => id !== String(comandoId));
      tx.update(computadorRef, { comandosFilaIds: fila, comandoPendenteId: fila[0] || null, comandoAguardandoElevacaoDesde: null });
    }
    travou = true;
  });
  if (travou) cache.invalidar();
  return travou;
}

async function entregarComandoPendente(codigo, posto, opcoes) {
  const id = docIdFor(codigo, posto);
  const ref = COLLECTION.doc(id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const comandoPendenteId = snap.data().comandoPendenteId;
    if (!comandoPendenteId) return null;
    const comandoRef = COMANDOS_COLLECTION.doc(comandoPendenteId);
    const comandoSnap = await tx.get(comandoRef);
    if (!comandoSnap.exists) {
      const fila = filaDeComandos(snap.data()).filter((item) => item !== String(comandoPendenteId));
      tx.update(ref, { comandosFilaIds: fila, comandoPendenteId: fila[0] || null, comandoAguardandoElevacaoDesde: null });
      return null;
    }
    const comando = comandoSnap.data();
    if (comando.status !== 'pendente') return null;
    const opts = opcoes || {};
    // ---- ELEVACAO ----
    // comando que exige admin so vai pra um heartbeat que provou ser admin (a
    // instancia SYSTEM). Pro heartbeat comum (login), fica pendente e marca
    // desde quando espera elevacao - a varredura desiste com mensagem clara se
    // a maquina nao tiver NOCZenith elevado (instalado sem Administrador).
    if (comando.requerAdmin && !opts.souAdmin) {
      if (!snap.data().comandoAguardandoElevacaoDesde) {
        tx.update(ref, { comandoAguardandoElevacaoDesde: new Date().toISOString() });
      }
      return null;
    }
    // a sondagem da instancia SYSTEM (soComandoAdmin) so quer comando-admin:
    // comando comum continua com a instancia de login, sem disputa
    if (opts.soComandoAdmin && !comando.requerAdmin) return null;
    // segredo entra SO aqui, na entrega: o registro do comando (o que o Master
    // ve no historico) fica com o marcador, nunca com a senha
    let texto;
    try {
      texto = substituirSegredos(comando.comandoEntrega || comando.comando);
    } catch (e) {
      tx.update(comandoRef, { status: 'erro', erro: e.message, executadoEm: new Date().toISOString() });
      const fila = filaDeComandos(snap.data()).filter((item) => item !== String(comandoPendenteId));
      tx.update(ref, { comandosFilaIds: fila, comandoPendenteId: fila[0] || null, comandoAguardandoElevacaoDesde: null });
      return null;
    }
    const patchEntrega = { status: 'entregue', entregueEm: new Date().toISOString() };
    tx.update(comandoRef, patchEntrega);
    if (snap.data().comandoAguardandoElevacaoDesde) tx.update(ref, { comandoAguardandoElevacaoDesde: null });
    return { comandoId: comando.id, comando: texto };
  });
}

// SEGREDO NO COMANDO. Pedido do Master (07/09/2026): "colocar uma senha de
// acesso no AnyDesk de todos os computadores". A senha nao pode ficar no
// catalogo de acoes (Firestore, visivel na tela), nem no registro do comando
// (historico), nem na saida que a maquina devolve. Entao o comando carrega um
// MARCADOR - {{SEGREDO:ANYDESK_SENHA}} - e o valor so e' colocado no texto no
// momento da entrega ao NOCZenith (entregarComandoPendente), lido de uma
// variavel de ambiente do Render. Lista fechada de nomes: um comando nao pode
// pedir {{SEGREDO:JWT_SECRET}} e levar a chave do servidor. O valor e'
// escapado pra ir dentro de aspas SIMPLES do PowerShell ('' = ').
const SEGREDOS_PERMITIDOS = ['ANYDESK_SENHA'];
function substituirSegredos(texto, env = process.env) {
  return String(texto || '').replace(/\{\{SEGREDO:([A-Z0-9_]+)\}\}/g, (_, nome) => {
    if (!SEGREDOS_PERMITIDOS.includes(nome)) throw new Error(`Segredo "${nome}" não é permitido em comando (só ${SEGREDOS_PERMITIDOS.join(', ')}).`);
    const valor = env[nome];
    if (!valor) throw new Error(`Variável ${nome} não está configurada no servidor (Render → Environment). O comando não foi entregue.`);
    return String(valor).replace(/'/g, "''");
  });
}

// O inventário manda uma linha JSON delimitada dentro da saída normal do
// comando. Persistimos apenas o nome, extensão e se veio da Área Pública ou
// do usuário — nunca caminhos locais, parâmetros do atalho ou documentos.
function atalhosDoInventario(resultado) {
  const encontrado = String(resultado || '').match(/(?:^|\r?\n)NOC_ATALHOS_JSON:(.+?)(?:\r?\n|$)/);
  if (!encontrado) return null;
  try {
    const bruto = JSON.parse(encontrado[1]);
    const lista = Array.isArray(bruto) ? bruto : [bruto];
    return lista.map((item) => {
      const nome = normalizarNomeAtalho(item && item.nome);
      const extensao = String(item && item.extensao || '').toLowerCase();
      const origem = item && item.origem === 'publica' ? 'publica' : 'usuario';
      return nome && ['.lnk', '.url', '.rdp'].includes(extensao) ? { nome, extensao, origem } : null;
    }).filter(Boolean).slice(0, 80);
  } catch (_) { return null; }
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
  // Resultado atrasado de uma execução que o servidor já classificou como
  // travada não pode "ressuscitar" o comando nem liberar uma nova vaga da
  // máquina. O agente recebe 409 e registra no log, sem expor saída na tela.
  if (comando.status !== 'entregue') {
    throw new Error(comando.status === 'erro'
      ? 'O resultado chegou depois do limite e o comando já foi fechado como erro.'
      : 'Este comando não está aguardando resultado.');
  }
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
  const foiComandoZebra = /~JR|Zpl-Enviar|zebra/i.test(String(comando.comando || ''));
  await comandoRef.update(patch);
  // carimba o ultimo resultado no doc do computador (alem de liberar a fila),
  // pra aparecer no detalhe do computador no NOC - quem mandou o comando ve o
  // que voltou sem precisar entrar na maquina
  const eventoZebra = foiComandoZebra ? {
    tipo: 'impressora-comando', em: Date.now(),
    detalhe: String(patch.erro || patch.resultado || 'reset enviado').slice(0, 200),
  } : null;
  const inventarioAtalhos = /inventario-estacao|noc-inventario-atalhos/.test(String(comando.origem || ''))
    ? atalhosDoInventario(patch.resultado) : null;
  const filaRestante = filaDeComandos(compSnap.data() || {}).filter((id) => id !== String(comandoId));
  await COLLECTION.doc(docIdFor(comando.codigo, comando.posto)).set({
    comandosFilaIds: filaRestante,
    comandoPendenteId: filaRestante[0] || null,
    comandoAguardandoElevacaoDesde: null,
    ultimoComandoEm: patch.executadoEm,
    ultimoComandoTexto: String(comando.comando || '').slice(0, 200),
    ultimoComandoResultado: patch.resultado ? String(patch.resultado).slice(0, 2000) : null,
    ultimoComandoErro: patch.erro ? String(patch.erro).slice(0, 500) : null,
    ...(inventarioAtalhos ? { atalhosDesktop: inventarioAtalhos, atalhosDesktopEm: Date.now() } : {}),
    ...(eventoZebra ? { eventos: [...((compSnap.data() || {}).eventos || []), eventoZebra].slice(-EVENTOS_MAX) } : {}),
  }, { merge: true });
  cache.invalidar();
  return { ...comando, ...patch };
}

// Lista a fila operacional sem expor PowerShell, resultado ou erro. O painel
// serve para responder "qual máquina está aguardando e há quanto tempo", não
// para virar outro console. A consulta já nasce limitada no Firestore: não lê
// o histórico inteiro a cada atualização do NOC.
function nomeSeguroDoComando(c) {
  if (c.origem === 'noc-console-operacional') return 'Console operacional';
  if (c.acaoId) return 'Ação aprovada do catálogo';
  if (c.origem === 'diagnostico-rede') return 'Diagnóstico de rede';
  if (c.origem === 'manutencao') return 'Manutenção programada';
  return 'Comando operacional';
}

async function listarComandosPendentes(consulta) {
  const entrada = typeof consulta === 'object' && consulta ? consulta : { limite: consulta };
  const limite = Math.max(20, Math.min(200, Number(entrada.limite) || 100));
  const dataValida = (valor) => {
    const data = new Date(String(valor || ''));
    return Number.isFinite(data.getTime()) ? data.toISOString() : null;
  };
  const inicio = dataValida(entrada.inicio) || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const fim = dataValida(entrada.fim);
  let query = COMANDOS_COLLECTION.where('criadoEm', '>=', inicio);
  if (fim) query = query.where('criadoEm', '<=', fim);
  const snap = await query
    .orderBy('criadoEm', 'desc')
    .limit(limite)
    .get();
  return snap.docs
    .map((doc) => {
      const c = doc.data();
      return {
        id: doc.id,
        codigo: c.codigo,
        posto: c.posto,
        nomeComputador: c.nomeComputador || c.posto,
        unidadeCodigo: c.unidadeCodigo || c.codigo,
        status: c.status || 'pendente',
        criadoEm: c.criadoEm || null,
        entregueEm: c.entregueEm || null,
        executadoEm: c.executadoEm || null,
        canceladoEm: c.canceladoEm || null,
        requerAdmin: c.requerAdmin === true,
        nomeComando: nomeSeguroDoComando(c),
      };
    })
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

// Quem ja esta em alerta de internet, por unidade (ver o bloco no fim de
// varrerAlertas). Map(codigo -> { ruim, desde, confirmacoes, ultimoAvisoEm }).
let estadoInternetUnidade = new Map();
// pro teste conseguir partir de um estado limpo entre cenarios
function _resetarEstadoInternet() { estadoInternetUnidade = new Map(); }

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
        const acompanharIp = acompanhaIpPorMac(cfg);
        // "Monitorar" é o alarme de SUMIU da rede. Troca de IP é outra
        // preocupação: qualquer equipamento categorizado acompanha pelo MAC.
        if (!cfg.monitorar && !acompanharIp) continue;
        const estado = alarmeAtual[disp.mac] || null;
        const semVerHaMs = Date.now() - (disp.visto || 0);
        if (cfg.monitorar && !disp.ativo && semVerHaMs >= DISPOSITIVO_OFFLINE_LIMIAR_MS && !(estado && estado.avisadoOffline)) {
          alarmePatch = { ...(alarmePatch || alarmeAtual), [disp.mac]: { ...(estado || {}), avisadoOffline: true, offlineDesde: disp.visto } };
          transicoes.push({
            codigo: candidato.codigo, posto: candidato.posto, nome: candidato.nome,
            // o medidor caindo e' a QUEDA DA LOJA, nao "sumiu um aparelho":
            // quem le o alerta precisa saber qual dos dois aconteceu
            tipo: cfg.medidorQuedas ? 'rede-unidade-offline' : 'dispositivo-offline', mac: disp.mac,
            apelido: cfg.apelido, tipoDispositivo: cfg.tipo, medidorQuedas: cfg.medidorQuedas,
            // o agente estar vivo ou nao e' o que separa "caiu a loja" de "caiu
            // so o modem" - vai junto pra quem le nao ter que adivinhar
            agenteVivo: Date.now() - (candidato.ultimoHeartbeatEm || 0) < LIMIAR_OFFLINE_MS,
            tipoRotulo: rotuloDoTipoDispositivo(cfg.tipo, tiposDispositivo),
          });
        }
        // TROCOU DE IP. Pedido do Master (13/09): "ela perde muito IP, muda
        // muito de IP, precisa atualizar no Servidor e isso só manualmente -
        // ao menos ter alerta". O DHCP da loja devolve outro endereço, o
        // servidor continua apontando pro antigo e a impressão para sem que
        // nada no NOC pisque: pro monitor a impressora está ativa, só que
        // noutro lugar.
        //
        // Para todo EQUIPAMENTO CATEGORIZADO, identificado pelo MAC. Celular
        // ou aparelho aleatório sem tipo continua fora: DHCP deles muda o dia
        // inteiro e alertar tudo seria ruído puro.
        //
        // ipAvisado guarda o ÚLTIMO endereço que já apareceu num alerta (ou o
        // primeiro que vimos). Primeira vez não avisa: não há "de" nenhum, e
        // anunciar o IP inicial de cada impressora marcada seria um alerta
        // por dispositivo no dia em que isto subir.
        if (acompanharIp && disp.ativo && disp.ip && estado && estado.ipAvisado && estado.ipAvisado !== disp.ip) {
          alarmePatch = { ...(alarmePatch || alarmeAtual), [disp.mac]: { ...estado, ipAvisado: disp.ip, ipMudouEm: Date.now() } };
          transicoes.push({
            codigo: candidato.codigo, posto: candidato.posto, nome: candidato.nome,
            tipo: 'dispositivo-ip-mudou', mac: disp.mac,
            de: estado.ipAvisado, para: disp.ip,
            apelido: cfg.apelido, tipoDispositivo: cfg.tipo,
            tipoRotulo: rotuloDoTipoDispositivo(cfg.tipo, tiposDispositivo),
          });
        } else if (acompanharIp && disp.ativo && disp.ip && (!estado || !estado.ipAvisado)) {
          // linha de base, em silêncio: a partir daqui qualquer troca aparece
          alarmePatch = { ...(alarmePatch || alarmeAtual), [disp.mac]: { ...(estado || {}), ipAvisado: disp.ip } };
        }
        if (cfg.monitorar && disp.ativo && estado && estado.avisadoOffline) {
          // preserva o que ja estava na entrada (ipAvisado, inclusive o que a
          // checagem de IP acabou de gravar) - antes isto reescrevia a entrada
          // inteira e a linha de base do IP se perdia a cada volta
          const base = (alarmePatch || alarmeAtual)[disp.mac] || estado;
          alarmePatch = { ...(alarmePatch || alarmeAtual), [disp.mac]: { ...base, avisadoOffline: false, offlineDesde: null } };
          transicoes.push({
            codigo: candidato.codigo, posto: candidato.posto, nome: candidato.nome,
            tipo: cfg.medidorQuedas ? 'rede-unidade-online' : 'dispositivo-online', mac: disp.mac,
            apelido: cfg.apelido, tipoDispositivo: cfg.tipo, medidorQuedas: cfg.medidorQuedas,
            // quanto tempo a loja passou fora: o alerta de volta so serve se
            // disser o tamanho da queda
            foraMs: estado && estado.offlineDesde ? Date.now() - estado.offlineDesde : null,
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
    // RAM continua registrada na telemetria e visível no NOC, mas não gera
    // push. Memória baixa sozinha é um sinal ruidoso em PDVs e não comprova
    // travamento; o Master pediu que deixe de interromper o celular.
    if (candidato.ramAlertaPendente) {
      await gravarEEspelhar(candidato.codigo, candidato.posto, { ramAlertaPendente: null });
    }
    // VM DO HOST caiu (Executando -> Desligada/Salva). Quem detecta e' a
    // telemetria do host (registrarTelemetria); aqui e' so o aviso, de um
    // lugar so, junto com o resto.
    if (Array.isArray(candidato.vmAlertaPendente) && candidato.vmAlertaPendente.length) {
      const caidas = candidato.vmAlertaPendente;
      await gravarEEspelhar(candidato.codigo, candidato.posto, { vmAlertaPendente: null });
      transicoes.push({
        codigo: candidato.codigo, posto: candidato.posto, nome: candidato.nome,
        tipo: 'vm-caiu', vms: caidas,
      });
    }
    // COMANDO-ADMIN sem executor elevado: fica esperando desde
    // comandoAguardandoElevacaoDesde. Passou do teto -> desiste, libera a vaga
    // unica de comando e avisa (a maquina foi instalada sem Administrador).
    if (candidato.comandoPendenteId && candidato.comandoAguardandoElevacaoDesde) {
      const espera = Date.now() - new Date(candidato.comandoAguardandoElevacaoDesde).getTime();
      if (espera >= COMANDO_ELEVACAO_TIMEOUT_MS) {
        const msg = 'Este computador nao tem o NOCZenith elevado (SYSTEM). Reinstale como Administrador para instalar/desinstalar programas.';
        try { await marcarComandoExpiradoSemAdmin(candidato.comandoPendenteId, candidato.codigo, candidato.posto, msg); } catch (e) { /* proximo giro tenta de novo */ }
        transicoes.push({
          codigo: candidato.codigo, posto: candidato.posto, nome: candidato.nome,
          tipo: 'comando-sem-admin', motivo: msg,
        });
      }
    }
    // Comando que chegou ao agente mas não retornou: fecha a fila em vez de
    // mantê-la indefinidamente em "executando". A função confirma o status e
    // o horário no documento do comando dentro de transação antes de alterar.
    if (candidato.comandoPendenteId && !candidato.comandoAguardandoElevacaoDesde) {
      try {
        const travou = await marcarComandoTravado(candidato.comandoPendenteId, candidato.codigo, candidato.posto);
        if (travou) {
          transicoes.push({
            codigo: candidato.codigo, posto: candidato.posto, nome: candidato.nome,
            tipo: 'comando-travado',
            motivo: 'O agente não devolveu resultado em 10 minutos; a fila foi liberada com erro.',
          });
        }
      } catch (e) { /* a próxima varredura tenta novamente */ }
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
    // impressora com problema confirmado (ver registrarTelemetria) - mesmo
    // padrao do disco: o agente marca, a varredura notifica
    if (Array.isArray(candidato.impressoraAlertaPendente) && candidato.impressoraAlertaPendente.length) {
      const pend = candidato.impressoraAlertaPendente;
      await gravarEEspelhar(candidato.codigo, candidato.posto, { impressoraAlertaPendente: null });
      const daUnidade = apelidosTodos[candidato.codigo] || {};
      for (const p of pend) {
        const cfg = normalizarEntradaApelido(daUnidade[p.mac]);
        transicoes.push({
          codigo: candidato.codigo, posto: candidato.posto, nome: candidato.nome,
          tipo: p.nivel === 'ok' ? 'impressora-normalizou' : 'impressora-problema',
          mac: p.mac, ip: p.ip, nivel: p.nivel, motivos: p.motivos, de: p.de || [],
          apelido: cfg.apelido,
        });
      }
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
        semSinalMs: Date.now() - doc.ultimoHeartbeatEm,
      });
    } else if (!online && doc.avisadoOffline && doc.quedaPushPendente
        && (Date.now() - (doc.offlineDesde || doc.ultimoHeartbeatEm)) >= CONFIRMACAO_QUEDA_MS) {
      // continuou fora depois da janela de oscilação: AGORA é queda de
      // verdade - o push crítico sai daqui, uma vez só
      await gravarEEspelhar(doc.codigo, doc.posto, { quedaPushPendente: false });
      transicoes.push({
        codigo: doc.codigo, posto: doc.posto, nome: doc.nome, tipo: 'offline-confirmada',
        celular: quedaDeCelular(doc), ehNotebook: !!doc.ehNotebook,
        semSinalMs: Date.now() - (doc.offlineDesde || doc.ultimoHeartbeatEm),
      });
    } else if (online && doc.avisadoOffline) {
      // no retorno o doc ja tem o IP NOVO (o heartbeat que provou que voltou
      // tambem gravou o ip) - junto com o retrato do evento 'offline', o
      // registro mostra se a maquina voltou com outro IP depois da queda
      // FOI A MAQUINA OU FOI A CONEXAO? Ate aqui o registro dizia so "ficou
      // fora 5min", e quem estava com AnyDesk aberto na mesma maquina nao
      // tinha como saber se o alarme fazia sentido. A batida que encerra o
      // silencio responde as duas metades:
      //   - agenteTentou: o contador de falhas que o agente trazia. > 0
      //     significa que ele estava rodando e batendo na porta o tempo todo
      //     - a maquina nunca parou, o que falhou foi o caminho ate o
      //     servidor. Zerado significa que ninguem tentou: agente parado,
      //     reiniciando ou se atualizando.
      //   - reiniciou: o Windows subiu de novo durante o silencio. Nao e
      //     deduzido por tempo - registrarHeartbeat ja grava o evento quando
      //     o bootEm muda, entao aqui e so procurar dentro da janela.
      const agenteTentou = Number(doc.agenteFalhasSeguidas) || 0;
      const reiniciouNoSilencio = !!doc.offlineDesde && (doc.eventos || [])
        .some((ev) => ev && ev.tipo === 'reiniciou' && Number(ev.em) >= doc.offlineDesde);
      const evento = {
        tipo: 'online', em: Date.now(), duracaoMs: doc.offlineDesde ? (Date.now() - doc.offlineDesde) : null,
        ...(agenteTentou > 0 ? { agenteTentou } : {}),
        ...(reiniciouNoSilencio ? { reiniciou: true } : {}),
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
  // Internet da UNIDADE (ver avaliarInternetUnidades em redeDiagnostico.js).
  // Entra na MESMA varredura porque os documentos ja estao lidos aqui - avaliar
  // link nao custa uma leitura a mais no Firestore.
  //
  // O estado vive em memoria, de proposito: gravar seria uma escrita por
  // unidade a cada transicao, e a unica coisa que se perde num deploy e' a
  // lembranca de "ja avisei". Loja que continuar ruim depois de um deploy
  // recebe um aviso novo - o que, num deploy manual e raro, e' o lado certo
  // pra errar: melhor repetir do que calar.
  try {
    const dia = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
    const r = redeDiagnostico.avaliarInternetUnidades(docs, { dia, agora: Date.now(), estado: estadoInternetUnidade });
    estadoInternetUnidade = r.estado;
    transicoes.push(...r.transicoes);
  } catch (e) { console.error('varrerAlertas: falha ao avaliar internet das unidades. %s', e.message); }
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

// `ate` fecha a janela pelo outro lado. Só "Ontem" precisa disso: 7/30/90
// dias e "Hoje" terminam agora, mas ontem termina à meia-noite de hoje -
// sem esse limite, "Ontem" mostraria ontem MAIS o dia de hoje.
function quedasDeUmComputador(doc, desde, ate = Infinity) {
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
    if (!ev.duracaoMs || ev.em < desde || ev.em > ate) continue;
    fora.push({ inicio, fim: ev.em, ms: ev.duracaoMs, comandado, link });
  }
  // queda que comecou e ainda nao fechou: a loja pode estar fora AGORA. Numa
  // janela que ja terminou (Ontem), "fora agora" nao faz sentido - o que
  // estiver aberto pertence ao dia de hoje
  const emAberto = ate === Infinity && aberta && aberta.em >= desde && aberta.motivo !== 'reinicio-comandado'
    ? { inicio: aberta.em, ms: Date.now() - aberta.em }
    : null;
  return { fora, emAberto };
}

// início do dia em Brasília, N dias atrás (0 = hoje, 1 = ontem) - o painel
// fala em "Hoje"/"Ontem", que é dia de calendário da loja, não janela
// rolante de 24h contada de agora
function meiaNoiteBrasilia(diasAtras = 0) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date());
  const o = {};
  p.forEach((x) => { if (x.type !== 'literal') o[x.type] = x.value; });
  const d = new Date(`${o.year}-${o.month}-${o.day}T00:00:00-03:00`);
  d.setDate(d.getDate() - diasAtras);
  return d.getTime();
}

// Intervalo escolhido na tela (De/Até). Datas de calendário precisam abrir e
// fechar no fuso da operação, não no UTC do servidor Render; caso contrário
// uma queda perto da meia-noite apareceria no dia vizinho no relatório.
function limiteDataBrasilia(iso, fimDoDia = false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''))) return null;
  const d = new Date(`${iso}T${fimDoDia ? '23:59:59.999' : '00:00:00.000'}-03:00`);
  return Number.isFinite(d.getTime()) ? d.getTime() : null;
}

async function relatorioQuedas(opcoes) {
  const periodo = String((opcoes || {}).periodo || '');
  // Hoje/Ontem são dias de calendário; o resto continua janela rolante
  let desde;
  let ate = Infinity;
  let dias;
  const inicioPersonalizado = String((opcoes || {}).inicio || '');
  const fimPersonalizado = String((opcoes || {}).fim || '');
  if (inicioPersonalizado || fimPersonalizado) {
    if (!inicioPersonalizado || !fimPersonalizado || inicioPersonalizado > fimPersonalizado) {
      throw new Error('Informe um período válido: De e Até.');
    }
    desde = limiteDataBrasilia(inicioPersonalizado);
    ate = limiteDataBrasilia(fimPersonalizado, true);
    if (desde === null || ate === null) throw new Error('Informe datas válidas para o período.');
    dias = 'personalizado';
  } else if (periodo === 'hoje') { desde = meiaNoiteBrasilia(0); dias = 'hoje'; }
  else if (periodo === 'ontem') { desde = meiaNoiteBrasilia(1); ate = meiaNoiteBrasilia(0); dias = 'ontem'; }
  else {
    dias = Math.max(1, Math.min(365, Number((opcoes || {}).dias) || QUEDAS_JANELA_PADRAO_DIAS));
    desde = Date.now() - dias * 24 * 60 * 60 * 1000;
  }
  const docs = (await cache.cached()).map(semSegredo);
  const porUnidade = new Map();
  for (const doc of docs) {
    // O retroativo não pode continuar somando PC a PC, nem pode ficar vazio
    // até alguém editar todo o parque. Primeiro usamos os pontos marcados
    // explicitamente; quando uma unidade ainda não tem nenhum, seus
    // computadores fixos viram pontos automáticos de correlação. Notebook
    // segue fora porque sai da rede da loja e geraria falso positivo.
    if (doc.ehNotebook) continue;
    const { fora, emAberto } = quedasDeUmComputador(doc, desde, ate);
    const reais = fora.filter((q) => !q.comandado);
    const u = porUnidade.get(doc.codigo) || { codigo: doc.codigo, pontos: new Map() };
    const ponto = u.pontos.get(doc.posto) || { marcado: false, eventos: [] };
    // Não soma PC por PC: cada ponto entra na correlação da unidade abaixo.
    reais.forEach((q) => ponto.eventos.push({ inicio: q.inicio, fim: q.fim }));
    // Infinity preserva que o ponto continua fora AGORA; só na apresentação
    // ela vira Date.now(). Assim a interseção sabe reconhecer a queda aberta.
    if (emAberto) ponto.eventos.push({ inicio: emAberto.inicio, fim: Infinity, aberta: true });
    ponto.marcado = ponto.marcado || !!doc.medeQuedas;
    u.pontos.set(doc.posto, ponto);
    porUnidade.set(doc.codigo, u);
  }
  const unidades = [...porUnidade.values()]
    .map((u) => {
      const todosPontos = [...u.pontos.values()];
      const pontosMarcados = todosPontos.filter((ponto) => ponto.marcado);
      // Uma marcação é uma decisão operacional e sempre vence a inferência.
      // Sem marcação, a correlação dos equipamentos fixos torna possível ler
      // corretamente o histórico antigo imediatamente após o deploy.
      const fonteMedicao = pontosMarcados.length ? 'marcados' : 'automatico';
      const porPonto = (pontosMarcados.length ? pontosMarcados : todosPontos).map((ponto) => ponto.eventos
        .sort((a, b) => a.inicio - b.inicio)
        .reduce((acc, e) => {
          const anterior = acc[acc.length - 1];
          if (anterior && e.inicio <= anterior.fim) anterior.fim = Math.max(anterior.fim, e.fim);
          else acc.push({ ...e });
          return acc;
        }, []));
      const pontos = porPonto.length;
      let agrupadas;
      if (pontos === 1) {
        // Um ponto serve como sinal operacional, mas não confirma sozinho que
        // a causa foi o link; a tela deixa essa condição explícita.
        agrupadas = porPonto[0];
      } else {
        // Interseção estrita: só é queda de LINK quando TODOS os pontos
        // marcados estão fora no mesmo intervalo. 9 de 10 fora, por exemplo,
        // vira falha de máquinas, nunca uma queda somada da unidade.
        const bordas = [];
        porPonto.forEach((intervalos, ponto) => intervalos.forEach((e) => {
          bordas.push({ em: e.inicio, ponto, delta: 1 });
          if (Number.isFinite(e.fim)) bordas.push({ em: e.fim, ponto, delta: -1 });
        }));
        bordas.sort((a, b) => a.em - b.em);
        const fora = new Set(); agrupadas = []; let inicioComum = null;
        for (let i = 0; i < bordas.length;) {
          const em = bordas[i].em;
          while (i < bordas.length && bordas[i].em === em) {
            if (bordas[i].delta > 0) fora.add(bordas[i].ponto); else fora.delete(bordas[i].ponto);
            i += 1;
          }
          if (fora.size === pontos && inicioComum === null) inicioComum = em;
          if (fora.size < pontos && inicioComum !== null) { agrupadas.push({ inicio: inicioComum, fim: em }); inicioComum = null; }
        }
        if (inicioComum !== null) agrupadas.push({ inicio: inicioComum, fim: Infinity, aberta: true });
      }
      const duracoes = agrupadas.map((e) => Math.max(0, (Number.isFinite(e.fim) ? e.fim : Date.now()) - e.inicio));
      const foraMs = duracoes.reduce((s, ms) => s + ms, 0);
      return {
        codigo: u.codigo, computadores: pontos, pontosMarcados: pontosMarcados.length, fonteMedicao, medicaoRedundante: pontos > 1, quedas: agrupadas.length, foraMs,
        maiorMs: Math.max(...duracoes, 0), oscilacoes: duracoes.filter((ms) => ms < CONFIRMACAO_QUEDA_MS).length,
        confirmadas: duracoes.filter((ms) => ms >= CONFIRMACAO_QUEDA_MS).length,
        foraAgora: agrupadas.filter((e) => e.aberta).length,
        horasFora: +(foraMs / 3600000).toFixed(1), maiorMin: Math.round(Math.max(...duracoes, 0) / 60000),
        // O resumo é suficiente para 7/30/90 dias. Para o filtro "Hoje" a
        // tela usa esta trilha para mostrar exatamente quando a queda de link
        // começou e terminou, sem recorrer ao histórico bruto da máquina.
        eventos: agrupadas.map((e) => ({
          inicio: e.inicio,
          fim: Number.isFinite(e.fim) ? e.fim : null,
          aberta: !!e.aberta,
        })),
      };
    })
    .sort((a, b) => b.foraMs - a.foraMs);
  return {
    dias,
    periodo: inicioPersonalizado && fimPersonalizado
      ? { inicio: inicioPersonalizado, fim: fimPersonalizado, rotulo: `${inicioPersonalizado} a ${fimPersonalizado}` }
      : null,
    // o historico por computador e' capado em EVENTOS_MAX: numa maquina que
    // oscila muito, queda antiga JA SAIU da lista. O numero e' piso, nao
    // teto - dizer isso na tela evita concluir "melhorou" de um corte.
    eventosMaximoPorComputador: EVENTOS_MAX,
    totalPontosMedicao: unidades.reduce((s, u) => s + u.computadores, 0),
    totalQuedas: unidades.reduce((s, u) => s + u.quedas, 0),
    totalConfirmadas: unidades.reduce((s, u) => s + u.confirmadas, 0),
    totalHorasFora: +(unidades.reduce((s, u) => s + u.foraMs, 0) / 3600000).toFixed(1),
    unidades,
  };
}

async function saudeMaquinas() {
  const docs = (await cache.cached()).map(comOnline).map(semSegredo)
    // resumo do reinicio automatico ja pronto ("todo dia as 04:00"): a regra
    // de montar isso a partir de reinicioSemanal/reinicioDiario mora aqui
    // (resumoDoPlano), e reimplementa-la no navegador seria a segunda copia
    .map((d) => {
      const plano = planoSemanalDe(d);
      return plano ? { ...d, reinicioResumo: resumoDoPlano(plano), reinicioTolerancia: toleranciaDe(d) } : d;
    });
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

// QUAIS IMPRESSORAS O AGENTE DAQUELA UNIDADE DEVE SONDAR. Vai na RESPOSTA
// da telemetria (que o agente ja manda de hora em hora) - sem rota nova e
// sem requisicao extra. So entra quem o Master marcou na tela como
// tipo:'impressora' + monitorar:true: ninguem e sondado por padrao, e uma
// impressora que ninguem marcou nunca recebe um pacote a mais.
// Estado mais recente das Zebras de uma unidade, lido do espelho em memoria
// (custo zero de leitura no Firestore - ver §3 do CLAUDE.md).
//
// Existe pro Beniboy decidir ANTES de reiniciar: tampa aberta, papel acabado ou
// ribbon no fim nao se conserta reiniciando - alguem tem que ir ate a
// impressora. Reiniciar nesses casos so tira ela do ar por ~30s e devolve o
// mesmo problema, com a pessoa achando que o suporte tentou algo.
//
// Mesma trava de impressorasPraSondar: so entra o que o Master marcou como
// impressora ZEBRA monitorada. Sem marca, nao aparece.
async function estadoImpressorasDaUnidade(codigo) {
  const daUnidade = (await getApelidos())[codigo] || {};
  const espelho = [...(await garantirEspelho()).values()];
  // mesma ideia do enderecoAtualDoMac: a sondagem acontece em cada computador
  // da loja, e a leitura que vale e' a mais RECENTE daquele MAC - a primeira
  // que aparecer pode ser de horas atras, e o painel mostraria a impressora
  // "sem papel" muito depois de alguem ter reposto
  const melhorPorMac = new Map();
  for (const doc of espelho) {
    if (doc.codigo !== codigo) continue;
    for (const [mac, est] of Object.entries(doc.impressoras || {})) {
      const cad = normalizarEntradaApelido(daUnidade[mac]);
      if (!cad.monitorar || cad.tipo !== 'impressora' || cad.marca !== 'zebra') continue;
      const atual = melhorPorMac.get(mac);
      if (atual && ((atual.est && atual.est.em) || 0) >= ((est && est.em) || 0)) continue;
      melhorPorMac.set(mac, { est, doc, cad });
    }
  }
  const out = [];
  for (const [mac, { est, doc, cad }] of melhorPorMac) {
    out.push({
      mac,
      ip: (est && est.ip) || null,
      nome: cad.apelido || null,
      nivel: (est && est.nivel) || 'desconhecido',
      motivos: (est && est.motivos) || [],
      fila: est && est.fila != null ? est.fila : null,
      em: (est && est.em) || null,
      computador: { codigo: doc.codigo, posto: doc.posto, nome: doc.nome || null },
    });
  }
  return out;
}

// motivos que NAO se resolvem com reset - a pessoa precisa ir ate a impressora.
// Os textos sao os que impressoraStatus.avaliar() ja produz; nao invente outros
// (§5 do CLAUDE.md: status vem do proprio codigo).
const MOTIVOS_QUE_PEDEM_MAO = ['Cabeça aberta', 'Sem papel', 'Sem ribbon'];
function motivosQuePedemMao(motivos) {
  return (motivos || []).filter((m) => MOTIVOS_QUE_PEDEM_MAO.includes(m));
}

// O MAC E' A IDENTIDADE; o IP e' so' o endereco de AGORA.
//
// Pergunta do Master (13/09/2026): "o IP e' um identificador, porem o MAC
// acredito que seja mais seguro - ja que temos o MAC, nao seria mais prudente
// pegar sempre por padrao pelo MAC?". Sim, e e' assim que o cadastro ja
// funciona: apelido, tipo, marca e o alarme sao gravados POR MAC
// (definirApelidoDispositivo), pra VMPULSE, VMGCOM, HOST, Bematech fiscal e
// Zebra igual. O IP nunca foi o cadastro - mas nao da pra mandar ZPL, ping ou
// impressao pra um MAC: em algum momento ele precisa virar endereco.
//
// O furo estava EXATAMENTE nessa tradução. Cada computador da loja mantem a
// sua propria varredura ARP, e a regra antiga era "pega o primeiro
// computador que tiver esse MAC" - leitura de 3h atras ganhava da leitura de
// agora. Foi o que mandou o reset da Zebra pro 10.161.124.54 quando ela ja
// estava no .52 ("FALHOU - sem resposta na 9100", print do Master).
//
// Esta funcao e' a tradução, num lugar so: entre todas as leituras daquele
// MAC na unidade, vale a mais fresca - ativo vence inativo, visto mais
// recente vence mais velho.
function enderecoAtualDoMac(docs, codigo, mac) {
  const leituras = [];
  for (const doc of docs) {
    if (doc.codigo !== codigo) continue;
    for (const d of doc.dispositivos || []) {
      if (d.mac !== mac || !d.ip) continue;
      leituras.push({ ip: d.ip, ativo: d.ativo !== false, visto: d.visto || 0, doc });
    }
  }
  if (!leituras.length) return null;
  leituras.sort((a, b) => (b.ativo ? 1 : 0) - (a.ativo ? 1 : 0) || (b.visto || 0) - (a.visto || 0));
  return leituras[0];
}

async function impressorasPraSondar(codigo) {
  const daUnidade = (await getApelidos())[codigo] || {};
  const marcados = new Set(
    Object.entries(daUnidade)
      // marca === 'zebra' e a trava: mandar ~HS numa Bematech faria ela
      // IMPRIMIR "~HS" num cupom a cada ciclo. Sem marca escolhida, nao sonda.
      .filter(([, v]) => { const c = normalizarEntradaApelido(v); return c.monitorar && c.tipo === 'impressora' && c.marca === 'zebra'; })
      .map(([mac]) => mac)
  );
  if (!marcados.size) return [];
  const espelho = [...(await garantirEspelho()).values()];
  // um endereco por MAC, sempre o mais fresco (ver enderecoAtualDoMac). A
  // regra antiga pegava o primeiro computador que tivesse o MAC, e era por
  // aqui que o reset da Zebra ia pro IP velho - esta e' a funcao que alimenta
  // o comandoResetZebra.
  const out = [];
  for (const mac of marcados) {
    const atual = enderecoAtualDoMac(espelho, codigo, mac);
    if (atual) out.push({ mac, ip: atual.ip });
  }
  return out;
}

module.exports = {
  substituirSegredos, SEGREDOS_PERMITIDOS,
  impressorasPraSondar,
  flushHeartbeatsPendentes,
  heartbeat, listar, listarResumo, detalhar, diagnosticoPapelDeParede, diagnosticoRede, cadastrarComputador, editarComputador, removerComputador, moverComputador,
  definirAnydeskId, enviarMensagem, enviarMensagemMuitos, varrerAlertas, atualizarIpLocal, TIPOS_COMPUTADOR, ehCelular,
  // alerta de internet por unidade: o estado vive em memoria, e o teste
  // precisa comecar cada cenario do zero
  _resetarEstadoInternet,
  getConfig, setConfig, pushAcessoRemotoAtivo, definirApelidoDispositivo,
  listarCatalogoProgramas, salvarCatalogoProgramas, comandoInstalarCatalogo, comandoRemoverPrograma, programaPodeSerRemovido,
  definirArteDaMaquina, removerArteDaMaquina,
  listarTiposDispositivo, idDoTipoDispositivo, TIPOS_DISPOSITIVO_BASE,
  // SÓ pra testeRotas: DESCARTA o espelho em vez de só vencer a validade.
  // invalidarEspelho() de propósito guarda o mapa (o comentário lá explica:
  // é o que impede uma edição de nome derrubar um heartbeat ainda não
  // gravado). O teste precisa do contrário - escrever direto no Firestore
  // falso e ser levado a sério, inclusive pra ENVELHECER a última batida,
  // que é como se simula uma máquina que saiu do ar.
  descartarEspelhoTeste: () => { espelho = null; espelhoEm = 0; cache.invalidar(); },
  enfileirarComando, enfileirarComandoEmTodos, enfileirarComandoEmAlvos, detalharComando, cancelarComandoPendente, listarComandosPendentes, marcarComandoTravado,
  definirReinicioDiario, varrerReinicioDiario, ocorrenciaDoReinicioDiario,
  planoSemanalValido, planoSemanalDe, resumoDoPlano, toleranciaDe, toleranciaValida,
  horaDiariaValida, DIAS_SEMANA, REINICIO_TOLERANCIA_PADRAO_MIN, REINICIO_TOLERANCIA_MAX_MIN, REINICIO_DIARIO_ORIGEM,
  PLACEHOLDER_IP_IMPRESSORA, resolverIpImpressora, medidorDaUnidade, normalizarEntradaApelido, enderecoAtualDoMac,
  relatorioQuedas, quedasDeUmComputador,
  estadoImpressorasDaUnidade, motivosQuePedemMao, MOTIVOS_QUE_PEDEM_MAO,
  COMANDO_LIMPAR_TRAVADOS, COMANDO_DIAGNOSTICO_DESEMPENHO, COMANDO_INVENTARIO_ESTACAO, COMANDO_LIMPEZA_SEGURA, COMANDO_CORRIGIR_MEMORIA_LIMITADA, COMANDO_REMOVER_OFFICE, COMANDO_REINICIAR, COMANDO_ABORTAR_REINICIO, COMANDO_REINICIAR_ANYDESK, COMANDO_REINICIAR_GSURF_RSA, COMANDO_ENCERRAR_GCOM_WCF,
  COMANDO_REDE_DESTRAVAR, comandoResetSenha,
  comandoResetZebra, comandoEncerrarGcomWcf,
  ESTADOS, estadoDe, motivosDeDegradacao,
  marcarComandoExecutado, registrarAcessoRemoto, horaDoLogEmBrasilia, responderChat, registrarTelemetria,
  sanitizarPolitica, sanitizarEstacao, definirPolitica, definirPerfilEstacao, papelDeParedeDe, versaoAplicacao, chaveArte, momentoDaArte, maisRecenteEntreArtes, programasNovos, programasSumidos, leituraSuspeita, registrarProgramas,
  resumoEnderecoAgentes,
  saudeMaquinas,
  garantirAgentToken, tokenDoComputador, tokensBatem, configuracaoAgente, pedirInventarioAtalhos, registrarInventarioAtalhos, noPulsoPrintDoComputador, windowsAntigoDoComputador, ehServidorDoComputador, nomeDoComputador, reportarEstadoAgente, pedirCaptura,
};
