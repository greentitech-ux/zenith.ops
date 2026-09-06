// agenteAcoes.js
// Catálogo de ações que o Beniboy (bot de IA, ver suporteBot.js) pode
// executar como agente - pedido explícito do usuário: "quero uma caixa
// onde iríamos inserir os códigos (ensinar) o que ele pode fazer" +
// "quero uma caixa de prompt ou contexto pra ensinarmos ao Beniboy como
// resolver as coisas". Master cadastra cada AÇÃO aqui (nunca o Beniboy -
// ele só ESCOLHE entre o que já está cadastrado, nunca escreve o comando
// em si) e um texto livre de contexto/orientação geral.
//
// Duas coisas nesse módulo:
// 1) o catálogo (collection 'agenteAcoes') - cada ação é 'comando_maquina'
//    (PowerShell fixo, roda via NOCZenith num computador tipo 'interno' -
//    ver lojaStatus.js enfileirarComando/comandoPendenteId) ou
//    'acao_sistema' (uma função pré-pronta e revisada, nunca código livre -
//    ver EXECUTORES_ACAO_SISTEMA abaixo).
// 2) o contexto (doc singleton 'agenteContexto/principal') - texto livre
//    injetado no system prompt do Beniboy quando quem conversa é Master
//    (ver montarSystem em suporteBot.js).
//
// `requerAprovacao` é por AÇÃO, default true (pedido explícito: "quero que
// tudo que ele execute passe por aprovação do master exceto algumas coisas
// mais óbvias" - a exceção é escolhida pelo Master ao cadastrar, nunca uma
// lista fixa no código). Quando true, a execução de verdade passa pela
// MESMA fila de aprovação que o QA Master já usa (qaAprovacoes.js) - ver
// EXECUTORES_QA['agente.executarAcao'] em index.js.
const crypto = require('crypto');
const db = require('./firestore');
const { createCache } = require('./liveCache');
const users = require('./users');
const lojaStatus = require('./lojaStatus');

const COLLECTION = db.collection('agenteAcoes');
const CONTEXTO_REF = db.collection('agenteContexto').doc('principal');

const TIPOS_ACAO = ['comando_maquina', 'acao_sistema'];

// MODELOS de comando: acoes prontas que o Master usa como ponto de partida
// na tela (NOC -> Acoes do agente -> "Comecar de um modelo"). Nao sao acoes
// cadastradas - so preenchem o formulario; quem salva, com que nome e com
// que aprovacao, continua sendo o Master. Pedido (06/09/2026): "quero fazer
// uma limpa em todos os programas basicos do Windows que nao usamos no dia a
// dia - Paint, Copilot, TeamViewer, Apresentacoes, AteraAgent, OneDrive,
// Planilhas, Textos, YouTube". Dois modelos: o INVENTARIO (so le - roda
// antes, pra saber o nome exato em cada maquina) e a LIMPEZA com essa lista.
//
// A limpeza roda como o usuario logado (ver vigiaScript.js): app da Loja,
// atalho-app do Chrome e OneDrive saem sem Administrador; TeamViewer e
// AteraAgent sao instalacao de maquina e ficam PULADOS quando o NOCZenith
// nao e' admin - a saida diz isso, maquina por maquina. Mexe SO nos nomes da
// lista: Chrome, Drive, Gmail e PDV nao aparecem aqui de proposito.
// Teto do comando: 4000 caracteres (ver validarDados).
const MODELO_INVENTARIO = `# Inventario de programas instalados (NoPulso) - so LE, nao muda nada.
$k = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
$p = @(Get-ItemProperty $k -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -and -not $_.SystemComponent } | Sort-Object DisplayName -Unique | ForEach-Object { '{0} | {1} | {2}' -f $_.DisplayName, $_.DisplayVersion, $_.Publisher })
$a = @(Get-AppxPackage -ErrorAction SilentlyContinue | Where-Object { -not $_.IsFramework -and $_.SignatureKind -ne 'System' } | Sort-Object Name | ForEach-Object { '{0} | {1} | app da Loja' -f $_.Name, $_.Version })
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
"Administrador: $admin"; "PROGRAMAS ($($p.Count)):"; $p | Select-Object -First 300; ''; "APPS DA LOJA ($($a.Count)):"; $a | Select-Object -First 200`;

const MODELO_LIMPEZA = `# Limpeza de programas basicos (NoPulso). Roda como o usuario logado.
# Lista do Master (06/09/2026). Mexe SO nestes nomes; o resto da maquina fica como esta.
$ErrorActionPreference = 'Continue'
$R = New-Object System.Collections.Generic.List[string]
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
function Rodar-Desinstalador($s, $extra) {
  if ($s -match '^\\s*"([^"]+)"\\s*(.*)$') { $exe = $Matches[1]; $a = $Matches[2] }
  elseif ($s -match '^\\s*(\\S+)\\s*(.*)$') { $exe = $Matches[1]; $a = $Matches[2] } else { throw "desinstalador ilegivel: $s" }
  $a = ("$a $extra").Trim()
  if ($a) { Start-Process -FilePath $exe -ArgumentList $a -Wait -WindowStyle Hidden } else { Start-Process -FilePath $exe -Wait -WindowStyle Hidden }
}
# 1) apps da Loja do Windows (por usuario, sem Administrador): Paint e Copilot
foreach ($n in 'Microsoft.Paint','Microsoft.MSPaint','Microsoft.Copilot','Microsoft.Windows.Ai.Copilot.Provider') {
  $p = Get-AppxPackage -Name $n -ErrorAction SilentlyContinue
  if (-not $p) { $R.Add("NAO TINHA: $n"); continue }
  try { $p | Remove-AppxPackage -ErrorAction Stop; $R.Add("OK: $n (app da Loja)") } catch { $R.Add("FALHOU: $n - $($_.Exception.Message)") }
}
# 2) atalhos-app do Chrome (por usuario): Apresentacoes, Planilhas, Textos, YouTube
$hkcu = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue
foreach ($n in 'Apresentações','Planilhas','Textos','YouTube') {
  $e = @($hkcu | Where-Object { $_.DisplayName -eq $n -and $_.UninstallString -like '*chrome*' })
  if (-not $e.Count) { $R.Add("NAO TINHA: $n (app do Chrome)"); continue }
  foreach ($x in $e) { try { Rodar-Desinstalador $x.UninstallString ''; $R.Add("OK: $n (app do Chrome)") } catch { $R.Add("FALHOU: $n - $($_.Exception.Message)") } }
}
# 3) OneDrive (por usuario)
Get-Process OneDrive -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
$od = @("$env:LOCALAPPDATA\\Microsoft\\OneDrive\\OneDriveSetup.exe","$env:SystemRoot\\SysWOW64\\OneDriveSetup.exe","$env:SystemRoot\\System32\\OneDriveSetup.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($od) { try { Start-Process -FilePath $od -ArgumentList '/uninstall' -Wait -WindowStyle Hidden; $R.Add('OK: Microsoft OneDrive') } catch { $R.Add("FALHOU: OneDrive - $($_.Exception.Message)") } } else { $R.Add('NAO TINHA: Microsoft OneDrive') }
# 4) programas de maquina (precisam de Administrador): TeamViewer, AteraAgent
$hklm = Get-ItemProperty 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue
foreach ($n in 'TeamViewer','AteraAgent') {
  $e = @($hklm | Where-Object { $_.DisplayName -like "$n*" -and $_.UninstallString })
  if (-not $e.Count) { $R.Add("NAO TINHA: $n"); continue }
  if (-not $admin) { $R.Add("PULADO: $n - precisa de Administrador (o NOCZenith roda como usuario comum nesta maquina)"); continue }
  foreach ($x in $e) {
    try {
      if ($x.UninstallString -match 'msiexec') { Start-Process msiexec.exe -ArgumentList "/x $($x.PSChildName) /qn /norestart" -Wait }
      else { Rodar-Desinstalador $x.UninstallString '/S /silent /verysilent /norestart' }
      $R.Add("OK: $($x.DisplayName) $($x.DisplayVersion)")
    } catch { $R.Add("FALHOU: $($x.DisplayName) - $($_.Exception.Message)") }
  }
}
"Administrador: $admin"; $R -join "\`n"`;

const MODELOS_COMANDO = [
  {
    id: 'inventario-programas',
    nome: 'Inventário de programas instalados',
    descricao: 'Só LÊ: lista os programas e apps da Loja instalados na máquina, com versão e fabricante, e diz se o NOCZenith está rodando como Administrador. Rode em massa antes de qualquer limpeza, pra saber o nome exato em cada máquina. Não muda nada.',
    requerAprovacao: false,
    comando: MODELO_INVENTARIO,
  },
  {
    id: 'limpeza-programas-basicos',
    nome: 'Limpeza: programas básicos que não usamos',
    descricao: 'REMOVE da máquina: Paint, Copilot, os atalhos-app do Chrome (Apresentações, Planilhas, Textos, YouTube), Microsoft OneDrive, TeamViewer e AteraAgent. Só rode a mando do Master. TeamViewer e AteraAgent precisam de Administrador (sem isso ficam PULADOS na saída). AteraAgent é agente de gestão remota: se for o da própria equipe, NÃO remova. Rode o inventário antes.',
    requerAprovacao: true,
    comando: MODELO_LIMPEZA,
  },
];
// lista fechada de propósito - o Master escolhe num <select>, nunca digita
// código; adicionar uma nova ação de sistema exige alterar este arquivo
const EXECUTORES_SISTEMA_VALIDOS = ['criar_usuario_zenith'];

async function listUncached() {
  const snap = await COLLECTION.orderBy('nome').get();
  return snap.docs.map((d) => d.data());
}
const cache = createCache(listUncached, 10 * 1000);

async function listar() {
  return cache.cached();
}

// só as ativas, com os campos que o Beniboy precisa pra decidir - usada
// pelo system prompt (ver montarSystem em suporteBot.js)
async function listarAtivas() {
  const todas = await listar();
  return todas.filter((a) => a.ativo);
}

async function obter(id) {
  const snap = await COLLECTION.doc(id).get();
  return snap.exists ? snap.data() : null;
}

function validarDados(dados) {
  const nome = String(dados.nome || '').trim().slice(0, 80);
  if (!nome) throw new Error('Dê um nome pra ação.');
  const descricao = String(dados.descricao || '').trim().slice(0, 600);
  if (!descricao) throw new Error('Descreva quando/por que usar essa ação - é o que o Beniboy lê pra decidir.');
  const tipo = TIPOS_ACAO.includes(dados.tipo) ? dados.tipo : null;
  if (!tipo) throw new Error('Tipo inválido.');
  const registro = {
    nome, descricao, tipo,
    requerAprovacao: dados.requerAprovacao !== false,
    ativo: dados.ativo !== false,
  };
  if (tipo === 'comando_maquina') {
    const comando = String(dados.comando || '').trim().slice(0, 4000);
    if (!comando) throw new Error('Escreva o comando PowerShell dessa ação.');
    registro.comando = comando;
    registro.executorSistema = null;
  } else {
    const executorSistema = EXECUTORES_SISTEMA_VALIDOS.includes(dados.executorSistema) ? dados.executorSistema : null;
    if (!executorSistema) throw new Error('Escolha uma ação de sistema válida.');
    registro.executorSistema = executorSistema;
    registro.comando = null;
  }
  return registro;
}

async function criar(dados) {
  const registro = validarDados(dados);
  const ref = COLLECTION.doc();
  const completo = {
    id: ref.id,
    ...registro,
    criadoEm: new Date().toISOString(),
    atualizadoEm: new Date().toISOString(),
    criadoPorEmail: dados.criadoPorEmail || null,
    atualizadoPorEmail: dados.criadoPorEmail || null,
  };
  await ref.set(completo);
  cache.invalidar();
  return completo;
}

async function atualizar(id, dados, atualizadoPorEmail) {
  const snap = await COLLECTION.doc(id).get();
  if (!snap.exists) throw new Error('Ação não encontrada.');
  const registro = validarDados(dados);
  const patch = { ...registro, atualizadoEm: new Date().toISOString(), atualizadoPorEmail: atualizadoPorEmail || null };
  await COLLECTION.doc(id).update(patch);
  cache.invalidar();
  return { ...snap.data(), ...patch };
}

async function remover(id) {
  await COLLECTION.doc(id).delete();
  cache.invalidar();
  return { id };
}

async function obterContexto() {
  const snap = await CONTEXTO_REF.get();
  return snap.exists ? snap.data() : { texto: '', atualizadoEm: null, atualizadoPorEmail: null };
}

async function salvarContexto(texto, atualizadoPorEmail) {
  const registro = {
    texto: String(texto || '').slice(0, 12000),
    atualizadoEm: new Date().toISOString(),
    atualizadoPorEmail: atualizadoPorEmail || null,
  };
  await CONTEXTO_REF.set(registro);
  return registro;
}

// gera a senha que o Beniboy nunca vê nem escolhe - mesmo espírito do
// SENHA_PADRAO_BOT em suporteBot.js, mas aleatória de verdade (isso é
// CRIAÇÃO de acesso, não reset de senha existente). O próprio users.create
// já força precisaTrocarSenha:true - o Master vê a senha no card de
// aprovação e repassa por fora do app, igual já faz hoje quando cadastra
// um acesso na mão (ver comentário em users.js:102-104)
function gerarSenhaAleatoria() {
  return crypto.randomBytes(6).toString('base64url');
}

async function criarUsuarioZenith(params) {
  const p = params || {};
  const senha = gerarSenhaAleatoria();
  const criado = await users.create({
    email: p.email, username: p.username, password: senha, permissions: p.permissions || {},
  });
  return `Usuário criado: ${criado.email} (username: ${criado.username || '-'}). Senha temporária: ${senha} (precisa trocar no primeiro login) - repasse pra pessoa por fora do app.`;
}

const EXECUTORES_SISTEMA = {
  criar_usuario_zenith: criarUsuarioZenith,
};

// dispatcher genérico - chamado tanto pela aprovação (EXECUTORES_QA em
// index.js) quanto pelo caminho direto (ação com requerAprovacao:false).
// Busca a ação FRESCA (não do cache) porque pode ter passado tempo entre o
// Beniboy pedir e o Master aprovar, e o Master pode ter editado/desativado
// nesse meio tempo - defesa em profundidade, mesmo espírito do recheck de
// consultar_pedido em suporteBot.js
async function executarAcaoDoAgente(acaoId, parametros) {
  const acao = await obter(acaoId);
  if (!acao || !acao.ativo) throw new Error('Ação não encontrada ou desativada.');
  const params = parametros || {};
  if (acao.tipo === 'comando_maquina') {
    if (!params.codigo || !params.posto) throw new Error('Faltou dizer qual computador (codigo/posto) vai rodar o comando.');
    await lojaStatus.enfileirarComando(params.codigo, params.posto, acao.comando, { origem: 'agente', acaoId });
    return `Comando "${acao.nome}" enfileirado pro computador ${params.codigo}/${params.posto} - executa no próximo contato do NOCZenith.`;
  }
  const executor = EXECUTORES_SISTEMA[acao.executorSistema];
  if (!executor) throw new Error(`Ação de sistema desconhecida: ${acao.executorSistema}`);
  return executor(params);
}

module.exports = {
  TIPOS_ACAO, EXECUTORES_SISTEMA_VALIDOS, MODELOS_COMANDO, validarDados,
  listar, listarAtivas, obter, criar, atualizar, remover,
  obterContexto, salvarContexto, executarAcaoDoAgente,
};
