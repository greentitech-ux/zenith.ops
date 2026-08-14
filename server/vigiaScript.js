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
const VERSAO_VIGIA = 1;

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
function montarScriptVigia({ codigo, posto, tipo }) {
  const ehInterno = tipo === 'interno';
  const urlMonitorar = `${APP_BASE_URL}/${paginaDoTipo(tipo)}?unidade=${encodeURIComponent(codigo)}&posto=${encodeURIComponent(posto)}`;
  const urlReportarIp = `${APP_BASE_URL}/api/loja-status/${encodeURIComponent(codigo)}/computadores/${encodeURIComponent(posto)}/ip-local`;
  const urlHeartbeat = `${APP_BASE_URL}/api/loja-status/heartbeat`;
  const urlAcessoRemoto = `${APP_BASE_URL}/api/loja-status/${encodeURIComponent(codigo)}/computadores/${encodeURIComponent(posto)}/acesso-remoto`;
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
    '# NOCZenith - ' + codigo + ' / ' + posto,
    '#',
    ...(ehInterno ? cabecalhoInterno : cabecalhoOutros),
    '#',
    '# COMO INSTALAR (um passo so):',
    '# 1) Salve esse arquivo numa pasta fixa e definitiva (ex: Documentos\\NOCZenith)',
    '#    - nao mova depois, o agendamento vai apontar pra esse caminho.',
    '# 2) Clique com o botao DIREITO no arquivo > "Executar com o PowerShell".',
    '#    Uma janela preta abre rapido, instala e some sozinha.',
    '#',
    '# Se aparecer um erro falando de "execution policy" / "nao pode ser',
    '# carregado": abra o PowerShell normal (menu Iniciar > digite PowerShell),',
    '# rode uma vez so: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned -Force',
    '# e tente o passo 2 de novo.',
    '',
    'param([switch]$Loop)',
    '',
    '$NomeTarefa = "' + nomeTarefa + '"',
    '$InicioScript = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()',
    '',
    '# ---- deteccao de acesso remoto (AnyDesk, TeamViewer, DWService, RustDesk,',
    '# UltraViewer, VNC, Splashtop, LogMeIn, GoToAssist, Chrome Remote Desktop -',
    '# ou qualquer outra que rode como processo do Windows). So alerta quando',
    '# uma conexao NOVA aparece (guarda as ja avisadas em $JaAvisados, esquece',
    '# quando a conexao cai - se reconectar depois, avisa de novo). Best-effort:',
    '# depende da ferramenta manter uma conexao TCP estabelecida direta com',
    '# quem esta controlando - cobre os casos comuns, mas nao e garantia',
    '# absoluta pra toda ferramenta que existe.',
    '$UrlAcessoRemoto = "' + urlAcessoRemoto + '"',
    '$ProcessosAcessoRemoto = @(',
    '  "AnyDesk", "TeamViewer", "TeamViewer_Service", "dwagent", "dwagsvc",',
    '  "rustdesk", "UltraViewer_Desktop", "UltraViewer_Service", "remoting_host",',
    '  "Supremo", "LogMeIn", "LMIGuardianSvc", "vncserver", "winvnc", "tvnserver",',
    '  "SRServer", "SRManager", "g2mcomm", "g2svc"',
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
    '        $chave = "$nomeProc|$($c.RemoteAddress)|$($c.RemotePort)"',
    '        [void]$vistosAgora.Add($chave)',
    '        if (-not $JaAvisados.Contains($chave)) {',
    '          try {',
    '            $detalhe = "$nomeProc ($($c.RemoteAddress):$($c.RemotePort))"',
    '            $corpoAlerta = @{ detalhe = $detalhe } | ConvertTo-Json',
    '            Invoke-RestMethod -Uri $UrlAcessoRemoto -Method Post -ContentType "application/json" -Body $corpoAlerta -ErrorAction SilentlyContinue | Out-Null',
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
    '    $respVersao = Invoke-RestMethod -Uri $UrlVersao -Method Get -ErrorAction SilentlyContinue',
    '    if ($respVersao -and $respVersao.versao -and ([int]$respVersao.versao -gt $VersaoScript)) {',
    '      $novoConteudo = Invoke-RestMethod -Uri $UrlScriptProprio -Method Get -ErrorAction SilentlyContinue',
    '      if ($novoConteudo -and ($novoConteudo -is [string]) -and $novoConteudo.StartsWith("# NOCZenith")) {',
    '        Set-Content -Path $PSCommandPath -Value $novoConteudo -Encoding UTF8 -Force',
    '        Start-Process powershell.exe -ArgumentList "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Loop"',
    '        Start-Sleep -Seconds 2',
    '        exit',
    '      }',
    '    }',
    '  } catch {}',
    '}',
    '',
  ];

  const linhasLoopInterno = [
    '$UrlHeartbeat = "' + urlHeartbeat + '"',
    '$IntervaloSegundos = 25',
    '# a cada ~144 ticks de 25s (~1h) confere se tem versao nova',
    '$TicksParaVerificarAtualizacao = 144',
    '',
    'function Rodar-Loop {',
    '  $contador = 0',
    '  while ($true) {',
    '    try {',
    '      $corpo = @{ unidade = "' + codigo + '"; posto = "' + posto + '"; userAgent = "NOCZenith/1.0 (Windows NT; PowerShell)"; abertoDesde = $InicioScript } | ConvertTo-Json',
    '      Invoke-RestMethod -Uri $UrlHeartbeat -Method Post -ContentType "application/json" -Body $corpo -ErrorAction SilentlyContinue | Out-Null',
    '    } catch {}',
    '    try { Verificar-AcessoRemoto } catch {}',
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
    '  $contador = 0',
    '  while ($true) {',
    '    try { Verificar-AcessoRemoto } catch {}',
    '    $contador++',
    '    if ($contador % $TicksParaVerificacaoPesada -eq 0) {',
    '      $aberto = Get-Process | Where-Object { $_.MainWindowTitle -match [regex]::Escape($TituloJanela) } | Select-Object -First 1',
    '      if (-not $aberto) { Reabrir-Monitor }',
    '      try {',
    '        $ip = (Get-NetIPAddress -AddressFamily IPv4 -AddressState Preferred -ErrorAction SilentlyContinue |',
    '          Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |',
    '          Select-Object -First 1 -ExpandProperty IPAddress)',
    '        if ($ip) {',
    '          Invoke-RestMethod -Uri $UrlReportarIp -Method Post -ContentType "application/json" -Body (@{ ip = $ip } | ConvertTo-Json) -ErrorAction SilentlyContinue | Out-Null',
    '        }',
    '      } catch {}',
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
    '  $caminho = $PSCommandPath',
    '  $acao = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$caminho`" -Loop"',
    '  $gatilho = New-ScheduledTaskTrigger -AtLogOn',
    '  Register-ScheduledTask -TaskName $NomeTarefa -Action $acao -Trigger $gatilho -Force | Out-Null',
    '  Write-Host "Instalado! O NOCZenith vai rodar sozinho a partir do proximo login."',
    '  Write-Host "Iniciando agora tambem, nessa sessao..."',
    '  Start-Process powershell.exe -ArgumentList "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$caminho`" -Loop"',
    '  Read-Host "Pronto! Pode fechar essa janela (aperte Enter)"',
    '}',
    '',
  ];

  return [...linhasComuns, ...(ehInterno ? linhasLoopInterno : linhasLoopOutros), ...linhasFinal].join('\n');
}

module.exports = { montarScriptVigia, VERSAO_VIGIA };
