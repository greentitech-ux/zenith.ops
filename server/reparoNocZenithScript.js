// Script publico e generico de resgate do NOCZenith.
//
// Ele NAO contem token, unidade nem posto. A identidade e lida somente da
// copia ja instalada na propria maquina e nunca e impressa. O download do
// agente autenticado e reconstruido em uma origem fixa do NoPulso, depois de
// validar caminho, tipo e token local.
const { VERSAO_VIGIA } = require('./vigiaScript');

const MODELO_REPARO = String.raw`# Reparo seguro do NOCZenith - NoPulso
# Pode ser publicado: nao contem token, unidade, posto nem credencial.
#requires -version 3
[CmdletBinding()]
param([int]$VersaoMinima = __VERSAO_MINIMA__)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$OrigemOficial = [Uri]'https://www.nopulso.com.br'
$HostsLegadosPermitidos = @('www.nopulso.com.br', 'nopulso.com.br', 'adyen-monitor.onrender.com')
$mutex = $null
$mutexAdquirido = $false

function Normalizar-Caminho([string]$Caminho) {
  if ([string]::IsNullOrWhiteSpace($Caminho)) { return $null }
  try {
    return [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($Caminho.Trim().Trim('"')))
  } catch { return $null }
}

function Caminhos-Da-Tarefa($Tarefa) {
  $achados = @{}
  foreach ($acao in @($Tarefa.Actions)) {
    $argumentos = [Environment]::ExpandEnvironmentVariables([string]$acao.Arguments)
    foreach ($m in [regex]::Matches($argumentos, '(?i)"([^"\r\n]*\\NOCZenith\.ps1)"')) {
      $p = Normalizar-Caminho $m.Groups[1].Value
      if ($p) { $achados[$p] = $p }
    }
    $m = [regex]::Match($argumentos, '(?i)-File\s+([A-Za-z]:\\.*?\\NOCZenith\.ps1)(?=\s+-[A-Za-z]|$)')
    if ($m.Success) {
      $p = Normalizar-Caminho $m.Groups[1].Value
      if ($p) { $achados[$p] = $p }
    }
  }
  return @($achados.Values)
}

function Identidade-Do-Agente([string]$Caminho) {
  $texto = [IO.File]::ReadAllText($Caminho)
  if (-not $texto.StartsWith('# NOCZenith')) { throw 'Arquivo sem a identidade NOCZenith.' }

  $mt = [regex]::Match($texto, '(?m)^\s*\$AgentToken\s*=\s*"([a-fA-F0-9]{48})"\s*$')
  $mu = [regex]::Match($texto, '(?m)^\s*\$UrlScriptProprio\s*=\s*"([^"]+)"\s*$')
  $mn = [regex]::Match($texto, '(?m)^\s*\$NomeTarefa\s*=\s*"([^"]+)"\s*$')
  $mv = [regex]::Match($texto, '(?m)^\s*\$VersaoScript\s*=\s*(\d+)\s*$')
  if (-not ($mt.Success -and $mu.Success -and $mn.Success)) { throw 'Identidade local incompleta.' }
  if ($mn.Groups[1].Value -notmatch '^NOCZenith_[A-Za-z0-9_-]+$') { throw 'Nome de tarefa local invalido.' }

  $uri = [Uri]$mu.Groups[1].Value
  $hostSeguro = $HostsLegadosPermitidos -contains $uri.DnsSafeHost.ToLowerInvariant()
  $rotaSegura = $uri.AbsolutePath -match '^/api/loja-status/[^/?#]+/computadores/[^/?#]+/vigia\.ps1$'
  $tipoSeguro = $uri.Query -match '^\?tipo=(atendimento|interno|abastecimento)$'
  if ($uri.Scheme -ne 'https' -or -not $hostSeguro -or -not $rotaSegura -or -not $tipoSeguro -or
      ((-not $uri.IsDefaultPort) -and $uri.Port -ne 443) -or $uri.UserInfo) {
    throw 'URL local fora da lista segura.'
  }

  return [pscustomobject]@{
    Token = $mt.Groups[1].Value
    UriLocal = $uri
    UriDownload = New-Object Uri($OrigemOficial, $uri.PathAndQuery)
    NomeTarefa = $mn.Groups[1].Value
    Versao = $(if ($mv.Success) { [int]$mv.Groups[1].Value } else { 0 })
  }
}

function Hash-SHA256([string]$Caminho) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($Caminho)))).Replace('-', '') }
  finally { $sha.Dispose() }
}

function Testar-Sintaxe([string]$Caminho) {
  $tokensParser = $null
  $errosParser = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($Caminho, [ref]$tokensParser, [ref]$errosParser)
  if ($errosParser -and $errosParser.Count -gt 0) {
    throw ('Arquivo recusado pelo parser: ' + $errosParser[0].Message)
  }
}

try {
  $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
  )
  # O mesmo arquivo pode ser executado por um operador num PowerShell comum:
  # ele se relanca com UAC, espera o fim e nao faz nenhuma alteracao antes da
  # confirmacao. Isso mantem o caminho de campo simples sem burlar elevacao.
  if (-not $admin) {
    if ([string]::IsNullOrWhiteSpace($PSCommandPath)) { throw 'Salve o reparo em arquivo antes de executar.' }
    $argsElevados = '-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath.Replace('"', '""') + '"'
    try {
      $procElevado = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $argsElevados -PassThru -Wait -ErrorAction Stop
      exit [int]$procElevado.ExitCode
    } catch {
      throw 'Reparo NOCZenith nao foi autorizado no UAC. Nenhuma alteracao foi feita.'
    }
  }

  try {
    $mutex = New-Object Threading.Mutex($false, 'Global\NoPulso-NOCZenith-Reparo')
    $mutexAdquirido = $mutex.WaitOne(0, $false)
  } catch [Threading.AbandonedMutexException] { $mutexAdquirido = $true }
  if (-not $mutexAdquirido) { Write-Warning 'Outro reparo do NOCZenith ja esta em andamento.'; exit 5 }

  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072 } catch {}

  # So aceitamos os caminhos canonicos derivados dos perfis reais do Windows.
  # Uma tarefa adulterada nao pode apontar o reparador para um .ps1 arbitrario.
  $perfis = @($env:USERPROFILE, (Join-Path $env:SystemRoot 'System32\config\systemprofile'))
  try { $perfis += @(Get-CimInstance Win32_UserProfile -ErrorAction Stop | ForEach-Object { $_.LocalPath }) } catch {}
  try {
    $perfis += @(Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\*' -ErrorAction SilentlyContinue |
      ForEach-Object { $_.ProfileImagePath })
  } catch {}

  $permitidos = @{}
  foreach ($perfil in @($perfis | Where-Object { $_ } | Select-Object -Unique)) {
    $raiz = Normalizar-Caminho ([Environment]::ExpandEnvironmentVariables([string]$perfil))
    if (-not $raiz) { continue }
    $p = Normalizar-Caminho (Join-Path -Path $raiz -ChildPath 'AppData\Local\NOCZenith\NOCZenith.ps1')
    if ($p) { $permitidos[$p] = $p }
  }

  $tarefas = @()
  if (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue) {
    $tarefas = @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -like 'NOCZenith_*' })
  }
  $registros = @()
  $candidatos = @{}
  foreach ($t in $tarefas) {
    $paths = @(Caminhos-Da-Tarefa $t | Where-Object { $permitidos.ContainsKey($_) })
    $registros += [pscustomobject]@{ Tarefa = $t; Caminhos = $paths }
    foreach ($p in $paths) { if (Test-Path -LiteralPath $p) { $candidatos[$p] = $p } }
  }
  foreach ($p in @($permitidos.Values)) {
    if (Test-Path -LiteralPath $p) { $candidatos[$p] = $p }
  }

  if ($candidatos.Count -eq 0) {
    Write-Warning 'Nenhuma copia instalada do NOCZenith foi localizada. Use o comando individual da ficha da maquina.'
    exit 2
  }
  Write-Host ('Copias encontradas: {0}. Tokens nao serao exibidos.' -f $candidatos.Count)

  $saudaveis = @{}
  foreach ($caminho in @($candidatos.Values)) {
    $tmp = Join-Path (Split-Path -Parent $caminho) ('NOCZenith.resgate.' + [Guid]::NewGuid().ToString('N') + '.tmp')
    $id = $null
    $novoId = $null
    $cabecalhos = $null
    try {
      $id = Identidade-Do-Agente $caminho
      $cabecalhos = @{ 'X-NOC-Token' = $id.Token }
      $parametrosWeb = @{
        Uri = $id.UriDownload.AbsoluteUri
        Method = 'Get'
        Headers = $cabecalhos
        ErrorAction = 'Stop'
        MaximumRedirection = 0
        TimeoutSec = 30
      }
      if ((Get-Command Invoke-WebRequest).Parameters.ContainsKey('UseBasicParsing')) {
        $parametrosWeb.UseBasicParsing = $true
      }
      $resposta = Invoke-WebRequest @parametrosWeb
      if ([int]$resposta.StatusCode -ne 200) { throw 'O servidor nao devolveu HTTP 200.' }
      $tipoConteudo = [string]$resposta.Headers['Content-Type']
      if ($tipoConteudo -notmatch '^text/plain(?:;|$)') { throw 'O servidor nao devolveu texto PowerShell.' }
      $conteudo = [string]$resposta.Content
      if ($conteudo.Length -lt 5000 -or $conteudo.Length -gt 2097152 -or -not $conteudo.StartsWith('# NOCZenith')) {
        throw 'Resposta fora do formato/tamanho esperado.'
      }
      Set-Content -LiteralPath $tmp -Value $conteudo -Encoding UTF8 -Force
      Testar-Sintaxe $tmp
      $novoId = Identidade-Do-Agente $tmp
      if ($novoId.Versao -lt $VersaoMinima) { throw 'A versao segura ainda nao esta publicada.' }
      if (-not [string]::Equals($id.Token, $novoId.Token, [System.StringComparison]::Ordinal)) { throw 'Token divergente.' }
      if (-not [string]::Equals($id.NomeTarefa, $novoId.NomeTarefa, [System.StringComparison]::Ordinal)) { throw 'Tarefa divergente.' }
      if ($id.UriLocal.PathAndQuery -ne $novoId.UriLocal.PathAndQuery) { throw 'Destino divergente.' }

      $hashAntigo = Hash-SHA256 $caminho
      $hashNovo = Hash-SHA256 $tmp
      if ($hashAntigo -ne $hashNovo) {
        $backup = $caminho + '.pre-resgate-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' +
          [Guid]::NewGuid().ToString('N').Substring(0, 6) + '.bak'
        try {
          [IO.File]::Replace($tmp, $caminho, $backup, $true)
        } catch {
          [IO.File]::Copy($caminho, $backup, $false)
          [IO.File]::Copy($tmp, $caminho, $true)
        }
        if ((Hash-SHA256 $caminho) -ne $hashNovo) { throw 'Falha ao confirmar a substituicao.' }
        Write-Host ('[OK] Atualizado; backup preservado ao lado do agente: {0}' -f $caminho)
      } else {
        Write-Host ('[OK] Ja estava na versao segura: {0}' -f $caminho)
      }
      $ultimaValida = $caminho + '.ultima-valida'
      if (-not (Test-Path -LiteralPath $ultimaValida)) {
        Copy-Item -LiteralPath $caminho -Destination $ultimaValida -Force
      }
      $saudaveis[(Normalizar-Caminho $caminho)] = $true
    } catch {
      Write-Warning ('Nao foi possivel reparar {0}: {1}. O arquivo original foi mantido e nenhum token foi exibido.' -f
        $caminho, $_.Exception.Message)
    } finally {
      if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
      if ($cabecalhos) { $cabecalhos.Clear() }
      $cabecalhos = $null
      $id = $null
      $novoId = $null
    }
  }

  if ($saudaveis.Count -eq 0) { Write-Warning 'Nenhuma copia passou por todas as validacoes.'; exit 4 }

  $reiniciar = @()
  foreach ($r in $registros) {
    $ligadaACopiaSaudavel = $false
    foreach ($p in $r.Caminhos) {
      $n = Normalizar-Caminho $p
      if ($n -and $saudaveis.ContainsKey($n)) { $ligadaACopiaSaudavel = $true; break }
    }
    if ($ligadaACopiaSaudavel) { $reiniciar += $r.Tarefa }
  }
  if ($reiniciar.Count -eq 0) {
    Write-Warning 'A copia foi reparada, mas nenhuma tarefa instalada aponta para ela. Use o comando individual da ficha para reinstalar.'
    exit 3
  }

  foreach ($t in $reiniciar) {
    try { Stop-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath -ErrorAction SilentlyContinue } catch {}
  }
  Start-Sleep -Seconds 2
  foreach ($proc in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessId -ne $PID -and $_.Name -match '^(powershell|pwsh)\.exe$' -and $_.CommandLine -and $_.CommandLine -match '-Loop'
  })) {
    foreach ($p in $saudaveis.Keys) {
      if ($proc.CommandLine.IndexOf($p, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
        try { Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop } catch {}
        break
      }
    }
  }
  foreach ($t in $reiniciar) {
    try {
      Start-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath -ErrorAction Stop
      Write-Host ('[OK] Tarefa reiniciada: {0}' -f $t.TaskName)
    } catch { Write-Warning ('Falha ao iniciar tarefa: {0}' -f $t.TaskName) }
  }

  # v93 pode ter deixado um rename pendente. O reparo apenas avisa; nunca muda
  # nem reinicia o computador.
  try {
    $ativo = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\ComputerName\ActiveComputerName').ComputerName
    $configurado = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\ComputerName\ComputerName').ComputerName
    if ($ativo -ne $configurado) {
      Write-Warning ('HOSTNAME PENDENTE: atual={0}; apos reboot={1}. Nada foi alterado.' -f $ativo, $configurado)
    }
  } catch {}

  Start-Sleep -Seconds 5
  $ativos = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -match '^(powershell|pwsh)\.exe$' -and $_.CommandLine -match 'NOCZenith\.ps1' -and $_.CommandLine -match '-Loop'
  }).Count
  Write-Host ('RESUMO: {0} copia(s) segura(s), {1} tarefa(s) reiniciada(s), {2} processo(s) ativo(s).' -f
    $saudaveis.Count, $reiniciar.Count, $ativos)
} finally {
  if ($mutexAdquirido -and $mutex) { try { $mutex.ReleaseMutex() } catch {} }
  if ($mutex) { try { $mutex.Dispose() } catch {} }
}
`;

function montarScriptReparoNocZenith() {
  return MODELO_REPARO.replace('__VERSAO_MINIMA__', String(VERSAO_VIGIA));
}

// Comando curto, próprio para colar numa máquina atendida por AnyDesk. Ele
// sempre abre o UAC e só então baixa o resgate. Não carrega token, código da
// loja ou nome do computador: o resgate encontra uma instalação já existente
// e preserva a identidade dela. O -EncodedCommand evita que $env:TEMP ou
// outras variáveis sejam expandidas pelo PowerShell/CMD de fora.
function montarComandoReparoNocZenith() {
  const url = 'https://www.nopulso.com.br/api/loja-status/reparo-noczenith.ps1';
  const interno = [
    "$ErrorActionPreference='Stop'",
    "$u='" + url + "'",
    "$f=Join-Path $env:TEMP ('Reparar-NOCZenith-'+[Guid]::NewGuid().ToString('N')+'.ps1')",
    "try { Invoke-WebRequest -UseBasicParsing -Uri $u -MaximumRedirection 0 -OutFile $f; & $f } finally { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue }",
  ].join(';');
  const b64Interno = Buffer.from(interno, 'utf16le').toString('base64');
  const elevador = [
    "$ErrorActionPreference='Stop'",
    "try { $p=Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -EncodedCommand " + b64Interno + "' -PassThru -Wait -ErrorAction Stop; exit [int]$p.ExitCode }",
    "catch { [Console]::Error.WriteLine('Reparo NOCZenith nao foi autorizado no UAC. Nenhuma alteracao foi feita.'); exit 1 }",
  ].join('; ');
  return 'powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ' + Buffer.from(elevador, 'utf16le').toString('base64');
}

module.exports = { montarScriptReparoNocZenith, montarComandoReparoNocZenith };
