// vigiaScript.js
// Gera o script de "vigia" (NOCZenith) que roda nativo no Windows de cada
// computador cadastrado em loja-status.html - fonte UNICA do conteudo do
// .ps1: tanto o botao "Baixar NOCZenith" (GET /api/loja-status/:codigo/
// computadores/:posto/vigia.ps1, ver index.js) quanto o proprio script
// RODANDO (que se autoatualiza sozinho - ver Verificar-Atualizacao mais
// abaixo) buscam o mesmo texto daqui, garantindo que o que a pessoa baixa
// manualmente e o que o autoupdate espalha sao sempre identicos.
//
// VERSAO_VIGIA precisa ser incrementada TODA VEZ que montarScriptVigia()
// mudar - e o numero que cada copia ja instalada usa pra saber se existe
// uma versao mais nova esperando (ver GET /api/loja-status/vigia-versao).
// Esquecer de bumpar significa que a mudanca nunca chega nos computadores
// que ja tem o vigia rodando (so nos que forem instalados do zero depois
// do deploy).
const VERSAO_VIGIA = 8;

const APP_BASE_URL = (process.env.APP_BASE_URL || 'https://adyen-monitor.onrender.com').replace(/\/+$/, '');

// qual pagina cada tipo de computador abre - mesmo mapeamento client-side
// de loja-status.html (paginaDoTipo), usado so pra montar a URL que o
// vigia reabre quando a janela fecha (tipo != 'interno')
function paginaDoTipo(tipo) {
  if (tipo === 'interno') return '';
  if (tipo === 'abastecimento') return 'abastecimento.html';
  return 'atendimento.html';
}

// gera o texto completo do NOCZenith-<posto>.ps1 pra um computador
// especifico. "tipo" decide o comportamento do loop:
// - 'interno' (servidor/PC sem funcao pra alguem usar): manda heartbeat de
//   verdade a cada 25s, sem gerenciar janela nenhuma.
// - outros (atendimento/abastecimento): reabre a tela de monitoramento se
//   fechar + reporta o IP local, a cada ~120s (tick rapido de 20s com
//   contador, pra nao atrasar a deteccao de acesso remoto).
// Os dois tipos, alem disso, TODO tick: (1) checam acesso remoto (AnyDesk/
// TeamViewer/DWService/etc conectado - ver Verificar-AcessoRemoto) e, numa
// cadencia bem mais espacada (~1h), (2) checam se existe uma versao nova
// do proprio script esperando (ver Verificar-Atualizacao) - se sim, baixa
// o conteudo novo, sobrescreve o proprio arquivo e reinicia sozinho.
function montarScriptVigia({ codigo, posto, tipo, agentToken }) {
  const ehInterno = tipo === 'interno';
  // segredo desse computador (ver lojaStatus.js) - vai assado no script e
  // volta no cabecalho X-NOC-Token em todo request pro servidor, provando
  // que quem fala e a maquina certa. Sem ele, o backend nao entrega comando/
  // chat nem aceita resultado/IP/alerta (fecha a brecha de que so codigo+
  // posto, que sao publicos, autorizavam tudo). O `|| ''` e so defensivo -
  // a rota vigia.ps1 sempre passa um token (garantirAgentToken)
  const tokenSeguro = String(agentToken || '').replace(/[^a-f0-9]/gi, '');
  // codigo entra CRU em varias strings PowerShell de aspas duplas (titulo da
  // janela, log, corpo do heartbeat). Dentro de "..." o PowerShell interpola
  // $(...)/$var e trata " como fim da string - entao um codigo com esses
  // caracteres viraria injecao/quebra no script que um admin baixa e roda.
  // Nenhum codigo de unidade legitimo tem `, " ou $ (tem acento, espaco e ate
  // apostrofo, que sao inofensivos em aspas duplas) - entao remover SO esses e
  // as quebras de linha fecha a brecha sem estragar nenhuma unidade real. As
  // URLs continuam usando encodeURIComponent(codigo real), cuja saida ja nao
  // tem ", $ nem crase (fica segura nas aspas duplas por conta propria).
  const codigoTextoPS = String(codigo).replace(/[`"$\r\n]/g, '');
  const urlMonitorar = `${APP_BASE_URL}/${paginaDoTipo(tipo)}?unidade=${encodeURIComponent(codigo)}&posto=${encodeURIComponent(posto)}`;
  const urlReportarIp = `${APP_BASE_URL}/api/loja-status/${encodeURIComponent(codigo)}/computadores/${encodeURIComponent(posto)}/ip-local`;
  const urlHeartbeat = `${APP_BASE_URL}/api/loja-status/heartbeat`;
  const urlAcessoRemoto = `${APP_BASE_URL}/api/loja-status/${encodeURIComponent(codigo)}/computadores/${encodeURIComponent(posto)}/acesso-remoto`;
  const urlComandoResultado = `${APP_BASE_URL}/api/loja-status/${encodeURIComponent(codigo)}/computadores/${encodeURIComponent(posto)}/comando-resultado`;
  const urlChatResponder = `${APP_BASE_URL}/api/loja-status/${encodeURIComponent(codigo)}/computadores/${encodeURIComponent(posto)}/chat-responder`;
  const urlVersao = `${APP_BASE_URL}/api/loja-status/vigia-versao`;
  const urlScriptProprio = `${APP_BASE_URL}/api/loja-status/${encodeURIComponent(codigo)}/computadores/${encodeURIComponent(posto)}/vigia.ps1?tipo=${encodeURIComponent(tipo)}`;
  const nomeTarefa = 'NOCZenith_' + posto;

  const cabecalhoInterno = [
    '# O que isso faz, rodando escondido em segundo plano: manda direto pro',
    '# Zenith o sinal de que esse computador esta ligado e conectado (aparece',
    '# online em Status das Lojas) - sem precisar manter nenhuma janela aberta.',
    '# Continua podendo abrir o app fixado na barra de tarefas quando quiser,',
    '# pra fazer login/usar o Zenith normal - isso nao tem nenhum conflito com',
    '# o NOCZenith rodando por baixo. Tambem avisa SO o Master (nao aparece pro',
    '# resto do time) quando alguem se conecta nessa maquina por AnyDesk,',
    '# TeamViewer, DWService ou qualquer outra ferramenta de acesso remoto.',
    '# Se o Master mandar uma mensagem, abre uma janelinha de chat no canto',
    '# da tela avisando - da pra responder direto por ela.',
    '# Se atualiza sozinho quando sai uma versao nova (sem precisar reinstalar).',
  ];
  const cabecalhoOutros = [
    '# O que isso faz, rodando escondido em segundo plano:',
    '# 1) Reabre a tela de monitoramento sozinho se alguem fechar ela sem querer.',
    '# 2) Manda pro Zenith o IP da rede LOCAL desse computador (pra acesso',
    '#    remoto no dia a dia - aparece em Status das Lojas, no card desse',
    '#    computador).',
    '# 3) Avisa SO o Master (nao aparece pro resto do time) quando alguem se',
    '#    conecta nessa maquina por AnyDesk, TeamViewer, DWService ou',
    '#    qualquer outra ferramenta de acesso remoto.',
    '# 4) Se atualiza sozinho quando sai uma versao nova (sem precisar reinstalar).',
  ];
  const linhasComuns = [
    '# NOCZenith - ' + codigoTextoPS + ' / ' + posto,
    '#',
    ...(ehInterno ? cabecalhoInterno : cabecalhoOutros),
    '#',
    '# COMO INSTALAR:',
    '# Jeito 1 (recomendado, sem bloqueio do Windows): na tela NOC Zenith, no',
    '#   Zenith, clique em "Copiar comando" desse computador, cole no PowerShell',
    '#   da loja e aperte Enter. Pronto.',
    '#',
    '# Jeito 2 (a partir deste arquivo baixado): o Windows 11 (Controle de',
    '#   Aplicativo Inteligente) bloqueia .ps1 baixado da internet. Pra liberar:',
    '#   1) Abra o PowerShell (menu Iniciar > digite PowerShell).',
    '#   2) Cole, trocando pelo caminho onde salvou (mantenha as aspas):',
    '#        Unblock-File "C:\\...\\NOCZenith.ps1"',
    '#      (tira o selo de "veio da internet" que causa o bloqueio)',
    '#   3) Cole:',
    '#        powershell -ExecutionPolicy Bypass -File "C:\\...\\NOCZenith.ps1"',
    '#',
    '# Depois de instalar, o NOCZenith se COPIA sozinho pra uma pasta fixa',
    '# (%LOCALAPPDATA%\\NOCZenith) e passa a rodar de la - entao o arquivo que',
    '# voce baixou pode ser APAGADO. Ele tambem se atualiza sozinho dai pra frente.',
    '',
    'param([switch]$Loop)',
    '',
    '$NomeTarefa = "' + nomeTarefa + '"',
    '$InicioScript = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()',
    '',
    '# segredo desse computador - autentica todo request pro Zenith (cabecalho',
    '# X-NOC-Token). Nao compartilhe esse arquivo: quem tiver esse token fala',
    '# como essa maquina. O NOCZenith se atualiza sozinho carregando o token.',
    '$AgentToken = "' + tokenSeguro + '"',
    '$CabecalhosAgente = @{ "X-NOC-Token" = $AgentToken }',
    '',
    '# ---- log local (arquivo texto do lado do .ps1) - sem isso, todo erro',
    '# ficava mudo (-ErrorAction SilentlyContinue + catch {} em toda chamada de',
    '# rede, de proposito, pra nunca derrubar o loop) e nao tinha como saber,',
    '# olhando so o computador, POR QUE ele nao aparece online no Zenith. So',
    '# grava eventos que importam pro diagnostico (falha, comando, chat,',
    '# atualizacao, inicio) - nao todo heartbeat bem-sucedido, senao o arquivo',
    '# cresce sem parar. Trunca sozinho se passar de ~300KB, mantendo so o',
    '# final (mais recente e mais util pra debugar um problema atual).',
    '$CaminhoLog = Join-Path (Split-Path -Parent $PSCommandPath) "NOCZenith.log"',
    'function Escrever-Log($mensagem) {',
    '  try {',
    '    if ((Test-Path $CaminhoLog) -and ((Get-Item $CaminhoLog).Length -gt 300KB)) {',
    '      $resto = Get-Content $CaminhoLog -Tail 400',
    '      Set-Content -Path $CaminhoLog -Value $resto -Encoding UTF8',
    '    }',
    '    "$([DateTime]::Now.ToString("yyyy-MM-dd HH:mm:ss")) - $mensagem" | Out-File -FilePath $CaminhoLog -Append -Encoding UTF8',
    '  } catch {}',
    '}',
    '',
    '# ---- deteccao de acesso remoto (AnyDesk, TeamViewer, DWService, RustDesk,',
    '# UltraViewer, VNC, Chrome Remote Desktop - ou qualquer outra que rode como',
    '# processo do Windows). Dedup POR PROCESSO: enquanto o processo tem conexao',
    '# estabelecida, alerta so UMA vez (esquece quando o processo some/cai a',
    '# conexao; se reaparecer depois, avisa de novo). Importante: NAO deduplica',
    '# por IP - ferramentas de nuvem (Splashtop/LogMeIn/GoToMyPC) ficam ligadas',
    '# 24h e a nuvem delas (AWS:443) troca de IP toda hora; dedup por IP fazia',
    '# cada troca virar um "acesso novo" e enchia o Master de alertas falsos. Por',
    '# isso essas 3 (que so mantem batimento de nuvem, sem indicar sessao real)',
    '# ficam FORA da lista. Best-effort: cobre os casos comuns, nao e garantia',
    '# absoluta pra toda ferramenta que existe.',
    '$UrlAcessoRemoto = "' + urlAcessoRemoto + '"',
    '# ferramentas de nuvem sempre-ligadas (Splashtop SRServer/SRManager, LogMeIn',
    '# LMIGuardianSvc, GoToMyPC g2mcomm/g2svc) foram REMOVIDAS de proposito: o',
    '# batimento 24h delas nao indica sessao de verdade e so gerava alerta falso.',
    '$ProcessosAcessoRemoto = @(',
    '  "AnyDesk", "TeamViewer", "TeamViewer_Service", "dwagent", "dwagsvc",',
    '  "rustdesk", "UltraViewer_Desktop", "UltraViewer_Service", "remoting_host",',
    '  "Supremo", "vncserver", "winvnc", "tvnserver"',
    ')',
    '$JaAvisados = New-Object System.Collections.Generic.HashSet[string]',
    '',
    'function Verificar-AcessoRemoto {',
    '  $vistosAgora = New-Object System.Collections.Generic.HashSet[string]',
    '  foreach ($nomeProc in $ProcessosAcessoRemoto) {',
    '    $procs = Get-Process -Name $nomeProc -ErrorAction SilentlyContinue',
    '    foreach ($p in $procs) {',
    '      $conexoes = Get-NetTCPConnection -State Established -OwningProcess $p.Id -ErrorAction SilentlyContinue',
    '      foreach ($c in $conexoes) {',
    '        if ($c.RemoteAddress -eq "127.0.0.1" -or $c.RemoteAddress -eq "::1") { continue }',
    '        $chave = "$nomeProc"',
    '        # $vistosAgora.Add devolve $false se a chave ja estava la: garante 1',
    '        # alerta por processo por tick (mesmo com varias conexoes abertas)',
    '        if (-not $vistosAgora.Add($chave)) { continue }',
    '        if (-not $JaAvisados.Contains($chave)) {',
    '          try {',
    '            $detalhe = "$nomeProc ($($c.RemoteAddress):$($c.RemotePort))"',
    '            $corpoAlerta = @{ detalhe = $detalhe } | ConvertTo-Json',
    '            Invoke-RestMethod -Uri $UrlAcessoRemoto -Method Post -ContentType "application/json" -Headers $CabecalhosAgente -Body $corpoAlerta -ErrorAction SilentlyContinue | Out-Null',
    '          } catch {}',
    '        }',
    '      }',
    '    }',
    '  }',
    '  $script:JaAvisados = $vistosAgora',
    '}',
    '',
    '# ---- autoatualizacao: confere de vez em quando (nao a cada tick - e',
    '# barato mas nao precisa ser instantaneo) se o servidor tem uma versao',
    '# mais nova que a que esse arquivo tem gravada. Se tiver, baixa o .ps1',
    '# novo (o MESMO conteudo que o botao "Baixar NOCZenith" gera hoje pra',
    '# esse computador), sobrescreve o proprio arquivo e reinicia rodando a',
    '# versao nova - sem precisar reinstalar na mao. So sobrescreve se o',
    '# conteudo baixado parecer valido (comeca com "# NOCZenith"), pra nunca',
    '# gravar um arquivo vazio/quebrado por causa de uma falha de rede.',
    '$VersaoScript = ' + VERSAO_VIGIA,
    '$UrlVersao = "' + urlVersao + '"',
    '$UrlScriptProprio = "' + urlScriptProprio + '"',
    '',
    'function Verificar-Atualizacao {',
    '  try {',
    '    $respVersao = Invoke-RestMethod -Uri $UrlVersao -Method Get',
    '    if ($respVersao -and $respVersao.versao -and ([int]$respVersao.versao -gt $VersaoScript)) {',
    '      Escrever-Log "Versao nova disponivel ($($respVersao.versao), essa copia e $VersaoScript) - baixando..."',
    '      $novoConteudo = Invoke-RestMethod -Uri $UrlScriptProprio -Method Get -Headers $CabecalhosAgente',
    '      if ($novoConteudo -and ($novoConteudo -is [string]) -and $novoConteudo.StartsWith("# NOCZenith")) {',
    '        Set-Content -Path $PSCommandPath -Value $novoConteudo -Encoding UTF8 -Force',
    '        Escrever-Log "Atualizado para versao $($respVersao.versao) - reiniciando."',
    '        Start-Process powershell.exe -ArgumentList "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Loop"',
    '        Start-Sleep -Seconds 2',
    '        exit',
    '      } else {',
    '        Escrever-Log "Conteudo novo baixado nao parece valido - mantendo versao atual."',
    '      }',
    '    }',
    '  } catch {',
    '    Escrever-Log "Falha ao verificar atualizacao: $($_.Exception.Message)"',
    '  }',
    '}',
    '',
  ];

  const linhasLoopInterno = [
    '$UrlHeartbeat = "' + urlHeartbeat + '"',
    '$UrlComandoResultado = "' + urlComandoResultado + '"',
    '$UrlChatResponder = "' + urlChatResponder + '"',
    '$IntervaloSegundos = 25',
    '# a cada ~144 ticks de 25s (~1h) confere se tem versao nova',
    '$TicksParaVerificarAtualizacao = 144',
    '',
    '# ---- janela de chat flutuante (estilo Splashtop) - roda numa thread',
    '# STA propria (runspace dedicado com sua propria mensagem de janela),',
    '# pra nunca travar o loop principal de heartbeat esperando alguem',
    '# interagir com a janela. A ponte entre as duas threads e por fila',
    '# sincronizada: FilaChatEntrada leva mensagem nova do Master pra',
    '# aparecer na janela; FilaChatSaida leva o que a pessoa digitou de',
    '# volta pro loop principal, que manda pro servidor. Qualquer falha aqui',
    '# (por exemplo, maquina sem sessao grafica) fica presa no try/catch e',
    '# nunca derruba o monitoramento - so fica sem a janela.',
    '$global:FilaChatEntrada = [System.Collections.Queue]::Synchronized((New-Object System.Collections.Queue))',
    '$global:FilaChatSaida = [System.Collections.Queue]::Synchronized((New-Object System.Collections.Queue))',
    '',
    'function Iniciar-JanelaChat {',
    '  $rs = [runspacefactory]::CreateRunspace()',
    '  $rs.ApartmentState = "STA"',
    '  $rs.ThreadOptions = "ReuseThread"',
    '  $rs.Open()',
    '  $rs.SessionStateProxy.SetVariable("FilaChatEntrada", $global:FilaChatEntrada)',
    '  $rs.SessionStateProxy.SetVariable("FilaChatSaida", $global:FilaChatSaida)',
    '  $rs.SessionStateProxy.SetVariable("TituloJanelaChat", "Zenith Ops - ' + codigoTextoPS + ' / ' + posto + '")',
    '  # passa o caminho do log pra DENTRO da thread da janela - sem isso, se o',
    '  # WinForms falhar (maquina sem sessao grafica, .NET incompleto), a janela',
    '  # morria em silencio total e nao dava pra saber por que o chat nao abria',
    '  $rs.SessionStateProxy.SetVariable("CaminhoLogChat", $CaminhoLog)',
    '  $ps = [powershell]::Create()',
    '  $ps.Runspace = $rs',
    '  [void]$ps.AddScript({',
    '    function Log-Chat($m) { try { "$([DateTime]::Now.ToString(\'yyyy-MM-dd HH:mm:ss\')) - [janela] $m" | Out-File -FilePath $CaminhoLogChat -Append -Encoding UTF8 } catch {} }',
    '    try {',
    '    Add-Type -AssemblyName System.Windows.Forms',
    '    Add-Type -AssemblyName System.Drawing',
    '',
    '    $form = New-Object System.Windows.Forms.Form',
    '    $form.Text = $TituloJanelaChat',
    '    $form.Size = New-Object System.Drawing.Size(340, 420)',
    '    $form.FormBorderStyle = "FixedSingle"',
    '    $form.MaximizeBox = $false',
    '    $form.ShowInTaskbar = $false',
    '    $form.TopMost = $true',
    '    $form.StartPosition = "Manual"',
    '    $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea',
    '    $form.Location = New-Object System.Drawing.Point(($area.Width - 360), ($area.Height - 440))',
    '',
    '    $cabecalho = New-Object System.Windows.Forms.Panel',
    '    $cabecalho.Dock = "Top"',
    '    $cabecalho.Height = 40',
    '    $cabecalho.BackColor = [System.Drawing.Color]::FromArgb(0, 120, 215)',
    '    $lblCabecalho = New-Object System.Windows.Forms.Label',
    '    $lblCabecalho.Text = "Suporte Zenith Ops"',
    '    $lblCabecalho.ForeColor = [System.Drawing.Color]::White',
    '    $lblCabecalho.Font = New-Object System.Drawing.Font("Segoe UI", 11, [System.Drawing.FontStyle]::Bold)',
    '    $lblCabecalho.Dock = "Fill"',
    '    $lblCabecalho.TextAlign = "MiddleLeft"',
    '    $lblCabecalho.Padding = New-Object System.Windows.Forms.Padding(10, 0, 0, 0)',
    '    $cabecalho.Controls.Add($lblCabecalho)',
    '',
    '    $historico = New-Object System.Windows.Forms.RichTextBox',
    '    $historico.Dock = "Fill"',
    '    $historico.ReadOnly = $true',
    '    $historico.BackColor = [System.Drawing.Color]::FromArgb(245, 247, 250)',
    '    $historico.BorderStyle = "None"',
    '    $historico.Font = New-Object System.Drawing.Font("Segoe UI", 9)',
    '',
    '    $rodape = New-Object System.Windows.Forms.Panel',
    '    $rodape.Dock = "Bottom"',
    '    $rodape.Height = 44',
    '    $rodape.Padding = New-Object System.Windows.Forms.Padding(6)',
    '',
    '    $txtEntrada = New-Object System.Windows.Forms.TextBox',
    '    $txtEntrada.Dock = "Fill"',
    '    $txtEntrada.Font = New-Object System.Drawing.Font("Segoe UI", 9)',
    '',
    '    $btnEnviar = New-Object System.Windows.Forms.Button',
    '    $btnEnviar.Text = "Enviar"',
    '    $btnEnviar.Dock = "Right"',
    '    $btnEnviar.Width = 68',
    '    $btnEnviar.BackColor = [System.Drawing.Color]::FromArgb(0, 120, 215)',
    '    $btnEnviar.ForeColor = [System.Drawing.Color]::White',
    '    $btnEnviar.FlatStyle = "Flat"',
    '',
    '    $EnviarTexto = {',
    '      $texto = $txtEntrada.Text.Trim()',
    '      if ($texto) {',
    '        $historico.SelectionColor = [System.Drawing.Color]::FromArgb(0, 120, 215)',
    '        $historico.AppendText([Environment]::NewLine + "[$(Get-Date -Format "HH:mm")] Voce: ")',
    '        $historico.SelectionColor = [System.Drawing.Color]::Black',
    '        $historico.AppendText($texto)',
    '        $historico.ScrollToCaret()',
    '        $FilaChatSaida.Enqueue($texto)',
    '        $txtEntrada.Text = ""',
    '      }',
    '    }',
    '    $btnEnviar.Add_Click($EnviarTexto)',
    '    $txtEntrada.Add_KeyDown({',
    '      param($origemEvento, $evento)',
    '      if ($evento.KeyCode -eq "Enter") { & $EnviarTexto; $evento.SuppressKeyPress = $true }',
    '    })',
    '',
    '    $rodape.Controls.Add($txtEntrada)',
    '    $rodape.Controls.Add($btnEnviar)',
    '',
    '    $form.Controls.Add($historico)',
    '    $form.Controls.Add($rodape)',
    '    $form.Controls.Add($cabecalho)',
    '',
    '    $timer = New-Object System.Windows.Forms.Timer',
    '    $timer.Interval = 1000',
    '    $timer.Add_Tick({',
    '      while ($FilaChatEntrada.Count -gt 0) {',
    '        $msg = $FilaChatEntrada.Dequeue()',
    '        $historico.SelectionColor = [System.Drawing.Color]::FromArgb(130, 130, 130)',
    '        $historico.AppendText([Environment]::NewLine + "[$(Get-Date -Format "HH:mm")] Suporte: ")',
    '        $historico.SelectionColor = [System.Drawing.Color]::FromArgb(30, 30, 30)',
    '        $historico.AppendText($msg)',
    '        $historico.ScrollToCaret()',
    '        if (-not $form.Visible) { $form.Show() }',
    '        $form.WindowState = "Normal"',
    '        $form.Activate()',
    '      }',
    '    })',
    '    $timer.Start()',
    '',
    '    $form.Add_FormClosing({',
    '      param($origemEvento, $evento)',
    '      $evento.Cancel = $true',
    '      $form.Hide()',
    '    })',
    '',
    '    Log-Chat "Janela de chat pronta."',
    '    [System.Windows.Forms.Application]::Run()',
    '    } catch { Log-Chat "ERRO ao montar a janela: $($_.Exception.Message)" }',
    '  })',
    '  [void]$ps.BeginInvoke()',
    '  $global:ChatRunspace = $rs',
    '  $global:ChatPowerShell = $ps',
    '}',
    '',
    'function Rodar-Loop {',
    '  Escrever-Log "NOCZenith iniciado (interno) - versao $VersaoScript - ' + codigoTextoPS + '/' + posto + '"',
    '  try { Iniciar-JanelaChat } catch { Escrever-Log "Falha ao abrir janela de chat: $($_.Exception.Message)" }',
    '  $contador = 0',
    '  $FalhasSeguidasHeartbeat = 0',
    '  # baseline do chat vem do TIMESTAMP DO SERVIDOR (em), nao do relogio',
    '  # local - antes usava a hora local do PC, e se o computador estava',
    '  # atrasado (comum), toda mensagem do Master tinha em < hora local e',
    '  # era descartada: a janela NUNCA abria. Agora os dois lados usam a mesma',
    '  # referencia (o em do servidor), entao independe do relogio da maquina',
    '  $UltimoChatEm = -1',
    '  $ChatBaselineFeito = $false',
    '  while ($true) {',
    '    $resp = $null',
    '    try {',
    '      $corpo = @{ unidade = "' + codigoTextoPS + '"; posto = "' + posto + '"; userAgent = "NOCZenith/1.0 (Windows NT; PowerShell)"; abertoDesde = $InicioScript } | ConvertTo-Json',
    '      $resp = Invoke-RestMethod -Uri $UrlHeartbeat -Method Post -ContentType "application/json" -Headers $CabecalhosAgente -Body $corpo',
    '      if ($FalhasSeguidasHeartbeat -gt 0) { Escrever-Log "Heartbeat voltou a funcionar (depois de $FalhasSeguidasHeartbeat falha(s) seguida(s))." }',
    '      $FalhasSeguidasHeartbeat = 0',
    '    } catch {',
    '      $FalhasSeguidasHeartbeat++',
    '      # so loga a 1a falha e depois 1 a cada ~40 tentativas (~17min) - senao',
    '      # uma internet caida por horas enche o log de linhas repetidas',
    '      if ($FalhasSeguidasHeartbeat -eq 1 -or ($FalhasSeguidasHeartbeat % 40 -eq 0)) {',
    '        Escrever-Log "Falha no heartbeat (tentativa $FalhasSeguidasHeartbeat seguida): $($_.Exception.Message)"',
    '      }',
    '    }',
    '    if ($resp) {',
    '      if ($resp.comandoPendente) {',
    '        Escrever-Log "Comando recebido (id=$($resp.comandoPendente.comandoId))"',
    '        try {',
    '          $sb = [scriptblock]::Create($resp.comandoPendente.comando)',
    '          $saidaComando = (& $sb 2>&1 | Out-String)',
    '          $corpoOk = @{ comandoId = $resp.comandoPendente.comandoId; resultado = $saidaComando } | ConvertTo-Json',
    '          Invoke-RestMethod -Uri $UrlComandoResultado -Method Post -ContentType "application/json" -Headers $CabecalhosAgente -Body $corpoOk -ErrorAction SilentlyContinue | Out-Null',
    '          Escrever-Log "Comando executado (id=$($resp.comandoPendente.comandoId))"',
    '        } catch {',
    '          Escrever-Log "Comando falhou (id=$($resp.comandoPendente.comandoId)): $($_.Exception.Message)"',
    '          try {',
    '            $corpoErro = @{ comandoId = $resp.comandoPendente.comandoId; erro = $_.Exception.Message } | ConvertTo-Json',
    '            Invoke-RestMethod -Uri $UrlComandoResultado -Method Post -ContentType "application/json" -Headers $CabecalhosAgente -Body $corpoErro -ErrorAction SilentlyContinue | Out-Null',
    '          } catch {}',
    '        }',
    '      }',
    '      # 1o ciclo: so marca o que ja existe como "visto" (nao repopa o',
    '      # historico), usando o em do servidor como baseline. Dai em diante,',
    '      # so mensagens do Master com em MAIOR que esse baseline abrem a janela',
    '      if (-not $ChatBaselineFeito) {',
    '        foreach ($m in $resp.chatMensagens) { if ($m.em -gt $UltimoChatEm) { $UltimoChatEm = $m.em } }',
    '        $ChatBaselineFeito = $true',
    '        Escrever-Log "Chat pronto (baseline em=$UltimoChatEm, $($resp.chatMensagens.Count) msg no historico)."',
    '      } else {',
    '        foreach ($m in $resp.chatMensagens) {',
    '          if ($m.de -eq "master" -and $m.em -gt $UltimoChatEm) {',
    '            Escrever-Log "Mensagem recebida do Master - abrindo janela."',
    '            try { $global:FilaChatEntrada.Enqueue([string]$m.texto) } catch { Escrever-Log "Falha ao enfileirar msg pra janela: $($_.Exception.Message)" }',
    '          }',
    '          if ($m.em -gt $UltimoChatEm) { $UltimoChatEm = $m.em }',
    '        }',
    '      }',
    '    }',
    '    try {',
    '      while ($global:FilaChatSaida.Count -gt 0) {',
    '        $textoParaEnviar = $global:FilaChatSaida.Dequeue()',
    '        $corpoChat = @{ texto = $textoParaEnviar } | ConvertTo-Json',
    '        Invoke-RestMethod -Uri $UrlChatResponder -Method Post -ContentType "application/json" -Headers $CabecalhosAgente -Body $corpoChat | Out-Null',
    '        Escrever-Log "Resposta enviada pela janela de chat."',
    '      }',
    '    } catch {',
    '      Escrever-Log "Falha ao enviar resposta do chat: $($_.Exception.Message)"',
    '    }',
    '    try { Verificar-AcessoRemoto } catch { Escrever-Log "Falha ao checar acesso remoto: $($_.Exception.Message)" }',
    '    $contador++',
    '    if ($contador % $TicksParaVerificarAtualizacao -eq 0) { Verificar-Atualizacao }',
    '    Start-Sleep -Seconds $IntervaloSegundos',
    '  }',
    '}',
    '',
  ];

  const linhasLoopOutros = [
    '$TituloJanela = "Zenith Ops"',
    '$UrlMonitorar = "' + urlMonitorar + '"',
    '$UrlReportarIp = "' + urlReportarIp + '"',
    '$IntervaloSegundos = 20',
    // a checagem de acesso remoto roda TODO tick (20s); reabrir a janela e
    // reportar o IP local continuam no ritmo de antes (120s = 6 ticks) - so
    // trocou o "relogio" do loop pra dar mais rapidez no alerta de acesso
    // remoto sem mudar a frequencia das outras duas tarefas
    '$TicksParaVerificacaoPesada = 6',
    '# a cada ~180 ticks de 20s (~1h) confere se tem versao nova',
    '$TicksParaVerificarAtualizacao = 180',
    '',
    'function Reabrir-Monitor {',
    '  $candidatos = @(',
    '    "$env:ProgramFiles\\Google\\Chrome\\Application\\chrome.exe",',
    '    "${env:ProgramFiles(x86)}\\Google\\Chrome\\Application\\chrome.exe",',
    '    "$env:ProgramFiles\\Microsoft\\Edge\\Application\\msedge.exe",',
    '    "${env:ProgramFiles(x86)}\\Microsoft\\Edge\\Application\\msedge.exe"',
    '  )',
    '  $navegador = $candidatos | Where-Object { Test-Path $_ } | Select-Object -First 1',
    '  if ($navegador) {',
    '    Start-Process -FilePath $navegador -ArgumentList "--app=$UrlMonitorar" -WindowStyle Minimized',
    '  } else {',
    '    Start-Process $UrlMonitorar',
    '  }',
    '}',
    '',
    'function Rodar-Loop {',
    '  Escrever-Log "NOCZenith iniciado (' + tipo + ') - versao $VersaoScript - ' + codigoTextoPS + '/' + posto + '"',
    '  $contador = 0',
    '  while ($true) {',
    '    try { Verificar-AcessoRemoto } catch { Escrever-Log "Falha ao checar acesso remoto: $($_.Exception.Message)" }',
    '    $contador++',
    '    if ($contador % $TicksParaVerificacaoPesada -eq 0) {',
    '      $aberto = Get-Process | Where-Object { $_.MainWindowTitle -match [regex]::Escape($TituloJanela) } | Select-Object -First 1',
    '      if (-not $aberto) { Escrever-Log "Tela de monitoramento fechada - reabrindo."; Reabrir-Monitor }',
    '      try {',
    '        $ip = (Get-NetIPAddress -AddressFamily IPv4 -AddressState Preferred -ErrorAction SilentlyContinue |',
    '          Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |',
    '          Select-Object -First 1 -ExpandProperty IPAddress)',
    '        if ($ip) {',
    '          Invoke-RestMethod -Uri $UrlReportarIp -Method Post -ContentType "application/json" -Headers $CabecalhosAgente -Body (@{ ip = $ip } | ConvertTo-Json) | Out-Null',
    '        }',
    '      } catch {',
    '        Escrever-Log "Falha ao reportar IP local: $($_.Exception.Message)"',
    '      }',
    '    }',
    '    if ($contador % $TicksParaVerificarAtualizacao -eq 0) { Verificar-Atualizacao }',
    '    Start-Sleep -Seconds $IntervaloSegundos',
    '  }',
    '}',
    '',
  ];

  const linhasFinal = [
    'if ($Loop) {',
    '  Rodar-Loop',
    '} else {',
    '  # instala numa pasta fixa e protegida (%LOCALAPPDATA%\\NOCZenith): assim o',
    '  # arquivo baixado pode ser apagado e o agendamento nunca aponta pra um',
    '  # caminho que alguem vai mover/limpar (ex: Downloads). Se ja estiver',
    '  # rodando dessa pasta (reinstalacao), nao copia de novo.',
    '  $PastaFixa = Join-Path $env:LOCALAPPDATA "NOCZenith"',
    '  $Destino = Join-Path $PastaFixa "NOCZenith.ps1"',
    '  try {',
    '    if (-not (Test-Path $PastaFixa)) { New-Item -ItemType Directory -Path $PastaFixa -Force | Out-Null }',
    '    if ($PSCommandPath -and ($PSCommandPath -ne $Destino) -and (Test-Path $PSCommandPath)) {',
    '      Copy-Item -Path $PSCommandPath -Destination $Destino -Force',
    '      Unblock-File -Path $Destino -ErrorAction SilentlyContinue',
    '    }',
    '  } catch {',
    '    Write-Host "Aviso: nao consegui usar a pasta fixa ($($_.Exception.Message)). Instalando do lugar atual."',
    '    $Destino = $PSCommandPath',
    '  }',
    '  $acao = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Destino`" -Loop"',
    '  $gatilho = New-ScheduledTaskTrigger -AtLogOn',
    '  try {',
    '    Register-ScheduledTask -TaskName $NomeTarefa -Action $acao -Trigger $gatilho -Force | Out-Null',
    '    Escrever-Log "Instalado em $Destino - tarefa agendada \'$NomeTarefa\' criada (roda no proximo login desse usuario)."',
    '    Write-Host "Instalado! O NOCZenith vai rodar sozinho a partir do proximo login."',
    '    Write-Host "Ele agora roda de: $Destino"',
    '    Write-Host "Pode APAGAR o arquivo que voce baixou - nao precisa mais dele."',
    '  } catch {',
    '    Escrever-Log "FALHA ao registrar a tarefa agendada: $($_.Exception.Message)"',
    '    Write-Host "ERRO ao instalar a tarefa agendada: $($_.Exception.Message)"',
    '    Write-Host "Rode o PowerShell como Administrador e tente de novo."',
    '  }',
    '  Write-Host "Iniciando agora tambem, nessa sessao..."',
    '  Start-Process powershell.exe -ArgumentList "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Destino`" -Loop"',
    '  Read-Host "Pronto! Pode fechar essa janela (aperte Enter)"',
    '}',
    '',
  ];

  return [...linhasComuns, ...(ehInterno ? linhasLoopInterno : linhasLoopOutros), ...linhasFinal].join('\n');
}

// comando de UMA LINHA pra colar no PowerShell da loja (botao "Copiar comando"
// na tela NOC Zenith). Baixa o script DIRETO pra pasta fixa
// (%LOCALAPPDATA%\NOCZenith) via Invoke-RestMethod - arquivo baixado assim NAO
// recebe o "Mark of the Web", entao o Controle de Aplicativo Inteligente do
// Windows 11 NAO bloqueia (que e o que trava o clique-direito num .ps1 baixado
// pelo navegador). O X-NOC-Token autentica na rota mesmo em reinstalacao (quando
// o computador ja tem segredo). Depois roda o arquivo (& $f), que se instala
// como tarefa agendada apontando pra essa mesma pasta fixa.
function montarComandoInstalacao({ codigo, posto, tipo, agentToken }) {
  const token = String(agentToken || '').replace(/[^a-f0-9]/gi, '');
  // encodeURIComponent NAO escapa o apostrofo ('), e a URL entra dentro de uma
  // string PowerShell de ASPAS SIMPLES ('...') abaixo - entao um codigo com
  // apostrofo (ex: "Domino's Carrinho...") fecharia a string ali e quebraria/
  // injetaria o comando. Trocar ' por %27 (que o servidor decodifica de volta)
  // mantem a URL correta e blindada dentro das aspas simples.
  const enc = (s) => encodeURIComponent(s).replace(/'/g, '%27');
  const url = `${APP_BASE_URL}/api/loja-status/${enc(codigo)}/computadores/${enc(posto)}/vigia.ps1?tipo=${enc(tipo)}`;
  // o script real (baixa direto pra pasta fixa - sem Mark of the Web, entao o
  // Controle de Aplicativo Inteligente nao bloqueia - e roda de la)
  const script = [
    "$ErrorActionPreference='Stop'",
    "$d=Join-Path $env:LOCALAPPDATA 'NOCZenith'",
    'New-Item -ItemType Directory -Path $d -Force|Out-Null',
    "$f=Join-Path $d 'NOCZenith.ps1'",
    `Invoke-RestMethod -Uri '${url}' -Headers @{'X-NOC-Token'='${token}'} -OutFile $f`,
    'Unblock-File -Path $f -ErrorAction SilentlyContinue',
    '& $f',
  ].join(';');
  // -EncodedCommand (Base64 de UTF-16LE): o comando vira uma string opaca, sem
  // nenhum $ ou aspas soltos. Sem isso, colar `powershell -Command "...$f..."`
  // DENTRO de outro PowerShell fazia o shell de fora expandir $d/$f (que nao
  // existem la) e o comando chegava com -OutFile/-Path/& vazios (erro real da
  // loja). Assim cola e roda igual no PowerShell, no CMD ou no Executar.
  const b64 = Buffer.from(script, 'utf16le').toString('base64');
  return `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${b64}`;
}

module.exports = { montarScriptVigia, montarComandoInstalacao, VERSAO_VIGIA };
