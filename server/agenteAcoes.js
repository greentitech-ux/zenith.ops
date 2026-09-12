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
const auth = require('./auth');
const tarefas = require('./tarefas');
const suporteChat = require('./suporteChat');
const prioridades = require('./prioridades');

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

// A senha NAO esta aqui: {{SEGREDO:ANYDESK_SENHA}} e' trocado pelo valor da
// variavel de ambiente so na entrega ao NOCZenith (ver substituirSegredos em
// lojaStatus.js). Fica entre aspas simples de proposito - e' assim que o
// escape do valor e' feito. A saida devolve o AnyDesk ID, nunca a senha.
const MODELO_ANYDESK_SENHA = `# AnyDesk: senha de acesso nao supervisionado (NoPulso). Precisa de Administrador.
$senha = '{{SEGREDO:ANYDESK_SENHA}}'
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { "PULADO: precisa de Administrador (o NOCZenith roda como usuario comum nesta maquina)"; return }
$exe = @("\${env:ProgramFiles(x86)}\\AnyDesk\\AnyDesk.exe", "$env:ProgramFiles\\AnyDesk\\AnyDesk.exe", "$env:ProgramData\\AnyDesk\\AnyDesk.exe") | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $exe) {
  $u = Get-ItemProperty 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'AnyDesk*' -and $_.InstallLocation } | Select-Object -First 1
  if ($u) { $c = Join-Path $u.InstallLocation 'AnyDesk.exe'; if (Test-Path $c) { $exe = $c } }
}
if (-not $exe) { "NAO TINHA: AnyDesk nao esta instalado nesta maquina"; return }
if ($senha.Length -lt 12) { "FALHOU: a senha configurada tem menos de 12 caracteres - o AnyDesk recusa. Troque ANYDESK_SENHA no servidor."; return }
$senha | & $exe --set-password 2>&1 | Out-Null
Start-Sleep -Seconds 2
$id = ((& $exe --get-id 2>&1) | Out-String).Trim()
if (-not $id) { "FALHOU: o AnyDesk nao respondeu ao --get-id (servico parado?)"; return }
"OK: senha de acesso definida · AnyDesk ID: $id"`;

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
  {
    id: 'anydesk-senha-acesso',
    nome: 'AnyDesk: definir senha de acesso',
    descricao: 'Define a senha de acesso não supervisionado do AnyDesk na máquina, com o valor da variável ANYDESK_SENHA do servidor (Render → Environment). A senha nunca aparece na ação, no histórico nem na saída: só o AnyDesk ID volta. Precisa de Administrador (sem isso fica PULADO). Máquina sem AnyDesk devolve NAO TINHA. Só rode a mando do Master.',
    requerAprovacao: true,
    comando: MODELO_ANYDESK_SENHA,
  },
];
// lista fechada de propósito - o Master escolhe num <select>, nunca digita
// código; adicionar uma nova ação de sistema exige alterar este arquivo
const EXECUTORES_SISTEMA_VALIDOS = [
  'criar_usuario_zenith',
  // "braços" do Master (12/09/2026): o que ele faria na mão, o Beniboy faz
  // por baixo em poucas frases - propõe, o Master aprova na fila, executa.
  // Cada um chama a MESMA função que a tela chama; nada de rota nova.
  'criar_tarefa', 'marcar_reuniao', 'concluir_tarefa', 'cancelar_tarefa',
  'desbloquear_usuario', 'resetar_senha_usuario', 'criar_usuario_copiando',
  'responder_chat', 'noc_comando',
];

// O que o Beniboy precisa coletar antes de chamar cada ação de sistema -
// vai pro system prompt (ver montarBlocoAgente em suporteBot.js). Sem isso
// ele chutava o nome do campo e a ação falhava só na hora de executar.
const PARAMETROS_EXECUTOR = {
  criar_usuario_zenith: 'email, username, permissions (objeto de permissões)',
  criar_tarefa: 'titulo (obrigatório), descricao, unidade (código) e unidadeNome, prioridade (baixa|media|alta|critica), dataEntrega (AAAA-MM-DD), responsavelEmail (opcional - padrão: o próprio Master)',
  marcar_reuniao: 'titulo (assunto), dataEntrega (dia, AAAA-MM-DD), horaInicio (HH:MM), duracaoMin (15|30|60|90|120), linkReuniao (opcional - sem ele o link é gerado), unidade/unidadeNome (opcional)',
  concluir_tarefa: 'tarefaId (o id da tarefa - se não souber, peça o título e confirme qual é), observacao (opcional)',
  cancelar_tarefa: 'tarefaId, motivo',
  desbloquear_usuario: 'usuario (e-mail ou username do acesso bloqueado), pedirTrocaSenha (true|false)',
  resetar_senha_usuario: 'usuario (e-mail ou username) - a senha nova é gerada aqui e aparece no resultado pro Master repassar',
  criar_usuario_copiando: 'modelo (e-mail ou username do usuário de referência, não pode ser Master), email e username do acesso novo - a senha é gerada aqui',
  responder_chat: 'chatId (id da conversa do suporte), texto (a mensagem, que sai como Suporte)',
  noc_comando: 'tarefa (reiniciar|abortar|anydesk|zebra|rede) e alvos (lista de {codigo, posto} dos computadores tipo interno)',
};

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

// ---- quem está agindo ----
// Toda ação de sistema roda em nome do MASTER que pediu no chat - nunca "do
// bot". O `porId` é gravado pelo servidor (ver executar_acao_agente em
// suporteBot.js, que sobrescreve o que o modelo mandar com chat.logado.id),
// então o modelo não consegue apontar outra pessoa. A pessoa é relida aqui
// na hora de executar (pode ter passado tempo entre pedir e aprovar) e tem
// que continuar sendo Master e ativa. O `acesso` que sai daqui é o MESMO
// objeto que acessoDasTarefas(req) monta pras rotas - uma regra só.
async function resolverAtor(params) {
  const id = String((params || {}).porId || '').trim();
  if (!id) throw new Error('Ação sem dono: faltou quem pediu (porId).');
  const usuario = await auth.getUserById(id);
  if (!usuario || usuario.active === false) throw new Error('Quem pediu a ação não está mais ativo.');
  if (usuario.role !== 'master') throw new Error('Só um Master pode executar ações de sistema pelo agente.');
  return { usuario: { id, ...usuario }, acesso: { usuario: { id, ...usuario }, isMaster: true, isAdmin: false, unidades: [] } };
}

async function usuarioPorIdentificador(valor, rotulo) {
  const achado = await users.findByIdentifier(valor);
  if (!achado) throw new Error(`${rotulo} não encontrado: ${valor}`);
  return achado;
}

const soData = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);

async function criarTarefa(params) {
  const p = params || {};
  const { usuario } = await resolverAtor(p);
  const responsavel = p.responsavelEmail ? await usuarioPorIdentificador(p.responsavelEmail, 'Responsável') : usuario;
  const unidade = String(p.unidade || '').trim() || null;
  const criada = await tarefas.criar({
    titulo: p.titulo, descricao: p.descricao,
    dataInicio: soData(p.dataInicio), dataEntrega: soData(p.dataEntrega),
    unidade, unidadeNome: unidade ? (String(p.unidadeNome || '').trim() || unidade) : null,
    usuario, responsavel, prioridade: prioridades.sanitizarPrioridade(p.prioridade),
    origem: 'agente',
  });
  return `Tarefa criada: #${criada.numeroTicket} "${criada.titulo}" (${criada.unidadeNome || 'pessoal'}, prioridade ${criada.prioridade}, responsável ${responsavel.username || responsavel.email}).`;
}

async function marcarReuniao(params) {
  const p = params || {};
  const { usuario } = await resolverAtor(p);
  const dia = soData(p.dataEntrega);
  if (!dia) throw new Error('Diga o dia da reunião (AAAA-MM-DD).');
  const unidade = String(p.unidade || '').trim() || null;
  const colado = String(p.linkReuniao || '').trim();
  const criada = await tarefas.criar({
    titulo: p.titulo, descricao: p.descricao, dataInicio: dia, dataEntrega: dia,
    unidade, unidadeNome: unidade ? (String(p.unidadeNome || '').trim() || unidade) : null,
    usuario, responsavel: usuario, prioridade: prioridades.sanitizarPrioridade(p.prioridade),
    ehReuniao: true, horaInicio: p.horaInicio, duracaoMin: p.duracaoMin,
    linkOrigem: colado ? 'colado' : 'gerado', linkReuniao: colado || null,
    origem: 'agente',
  });
  return `Reunião marcada: "${criada.titulo}" em ${dia} às ${criada.horaInicio} (${criada.duracaoMin} min). Link: ${criada.linkReuniao || '(gerado na tarefa)'}.`;
}

async function concluirTarefa(params) {
  const p = params || {};
  const { acesso } = await resolverAtor(p);
  const id = String(p.tarefaId || '').trim();
  if (!id) throw new Error('Diga qual tarefa concluir (tarefaId).');
  const feita = await tarefas.concluir(id, { ...acesso, observacao: p.observacao });
  return `Tarefa #${feita.numeroTicket} "${feita.titulo}" concluída.`;
}

async function cancelarTarefa(params) {
  const p = params || {};
  const { acesso } = await resolverAtor(p);
  const id = String(p.tarefaId || '').trim();
  if (!id) throw new Error('Diga qual tarefa cancelar (tarefaId).');
  const cancelada = await tarefas.cancelar(id, acesso, p.motivo);
  return `Tarefa #${cancelada.numeroTicket} "${cancelada.titulo}" cancelada.`;
}

async function desbloquearUsuario(params) {
  const p = params || {};
  await resolverAtor(p);
  const alvo = await usuarioPorIdentificador(p.usuario, 'Acesso');
  await users.desbloquear(alvo.id, { pedirTrocaSenha: p.pedirTrocaSenha === true, viaBot: true });
  return `Acesso ${alvo.email} desbloqueado${p.pedirTrocaSenha === true ? ' (vai trocar a senha no próximo login)' : ''}.`;
}

async function resetarSenhaUsuario(params) {
  const p = params || {};
  await resolverAtor(p);
  const alvo = await usuarioPorIdentificador(p.usuario, 'Acesso');
  if (alvo.role === 'master') throw new Error('Senha de Master não se reseta pelo agente.');
  const senha = gerarSenhaAleatoria();
  await users.resetPassword(alvo.id, senha);
  return `Senha de ${alvo.email} resetada. Senha temporária: ${senha} (troca no primeiro login) - repasse pra pessoa por fora do app.`;
}

async function criarUsuarioCopiando(params) {
  const p = params || {};
  await resolverAtor(p);
  const modelo = await usuarioPorIdentificador(p.modelo, 'Usuário-modelo');
  const senha = gerarSenhaAleatoria();
  const r = await users.criarCopiandoDe({ modeloId: modelo.id, email: p.email, username: p.username, senha });
  return `Usuário criado: ${r.usuario.email} (username: ${r.usuario.username || '-'}), copiando as permissões de ${r.copiadoDe.username || r.copiadoDe.email}. Senha temporária: ${senha} (troca no primeiro login) - repasse por fora do app.`;
}

async function responderChat(params) {
  const p = params || {};
  const { usuario } = await resolverAtor(p);
  const id = String(p.chatId || '').trim();
  if (!id) throw new Error('Diga qual conversa responder (chatId).');
  await suporteChat.adicionarMensagem(id, { de: 'suporte', texto: p.texto, autorEmail: usuario.email });
  return `Mensagem enviada como Suporte na conversa ${id}.`;
}

// mesma lista fechada da rota /api/loja-status/manutencao/reiniciar: o
// comando em si nunca vem de fora, só o NOME da tarefa
const TAREFAS_NOC = {
  reiniciar: { verbo: 'Reiniciar', comando: lojaStatus.COMANDO_REINICIAR, origem: 'manutencao-reiniciar' },
  abortar: { verbo: 'Abortar o reinício de', comando: lojaStatus.COMANDO_ABORTAR_REINICIO, origem: 'manutencao-abortar' },
  anydesk: { verbo: 'Reiniciar o AnyDesk de', comando: lojaStatus.COMANDO_REINICIAR_ANYDESK, origem: 'manutencao-anydesk' },
  rede: { verbo: 'Destravar a rede de', comando: lojaStatus.COMANDO_REDE_DESTRAVAR, origem: 'manutencao-rede' },
  zebra: { verbo: 'Resetar as Zebras de', comando: async (doc) => lojaStatus.comandoResetZebra(await lojaStatus.impressorasPraSondar(doc.codigo)), origem: 'manutencao-zebra' },
};

async function nocComando(params) {
  const p = params || {};
  await resolverAtor(p);
  const t = TAREFAS_NOC[String(p.tarefa || '')];
  if (!t) throw new Error('Tarefa do NOC inválida - use reiniciar, abortar, anydesk, zebra ou rede.');
  const alvos = Array.isArray(p.alvos) ? p.alvos.filter((a) => a && a.codigo && a.posto) : [];
  if (!alvos.length) throw new Error('Diga quais computadores (lista de {codigo, posto}).');
  if (alvos.length > 200) throw new Error('Muitos alvos de uma vez - divida em lotes.');
  const resultados = await lojaStatus.enfileirarComandoEmAlvos(alvos, t.comando, { origem: t.origem });
  const ok = resultados.filter((r) => r.ok).length;
  // quem NÃO entrou diz por quê (sem agentToken, já tem comando pendente...)
  // - senão "0 de 1" vira adivinhação
  const falhas = resultados.filter((r) => !r.ok && r.motivo).map((r) => `${r.codigo}/${r.posto}: ${r.motivo}`);
  return `${t.verbo} ${alvos.length} computador(es): ${ok} enfileirado(s) de ${resultados.length} encontrado(s) - executa no próximo contato do NOCZenith.${falhas.length ? ' Não entrou: ' + falhas.join(' · ') : ''}`;
}

const EXECUTORES_SISTEMA = {
  criar_usuario_zenith: criarUsuarioZenith,
  criar_tarefa: criarTarefa,
  marcar_reuniao: marcarReuniao,
  concluir_tarefa: concluirTarefa,
  cancelar_tarefa: cancelarTarefa,
  desbloquear_usuario: desbloquearUsuario,
  resetar_senha_usuario: resetarSenhaUsuario,
  criar_usuario_copiando: criarUsuarioCopiando,
  responder_chat: responderChat,
  noc_comando: nocComando,
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
  TIPOS_ACAO, EXECUTORES_SISTEMA_VALIDOS, PARAMETROS_EXECUTOR, MODELOS_COMANDO, validarDados,
  listar, listarAtivas, obter, criar, atualizar, remover,
  obterContexto, salvarContexto, executarAcaoDoAgente,
};
