# Diagnostico fechado do NOC. Apenas coleta; nao altera configuracao.
# PS 5.1/Server 2012: fontes indisponiveis permanecem nulas.
$ErrorActionPreference = 'SilentlyContinue'
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if(-not $admin) { throw 'Diagnostico completo exige execucao elevada pelo agente NOC.' }
$falhas = New-Object 'System.Collections.Generic.List[string]'
$alertas = New-Object 'System.Collections.Generic.List[string]'
function Ler-Noc($nome, [scriptblock]$acao) {
  try { & $acao } catch { $falhas.Add($nome) }
}
$os = Ler-Noc 'Sistema' { Get-CimInstance Win32_OperatingSystem -ErrorAction Stop }
$cs = Ler-Noc 'Computador' { Get-CimInstance Win32_ComputerSystem -ErrorAction Stop }
$cpu = Ler-Noc 'CPU' { Get-CimInstance Win32_Processor -ErrorAction Stop | Select-Object -First 1 }
$dimms = @(Ler-Noc 'Memoria' { Get-CimInstance Win32_PhysicalMemory -ErrorAction Stop })
$discos = @(Ler-Noc 'Discos' { Get-PhysicalDisk -ErrorAction Stop })
$vol = Ler-Noc 'Volume sistema' { Get-Volume -DriveLetter ($env:SystemDrive.TrimEnd(':')) -ErrorAction Stop }
$smart = @(Ler-Noc 'SMART' { Get-PhysicalDisk -ErrorAction Stop | Get-StorageReliabilityCounter -ErrorAction Stop })
$gpu = @(Ler-Noc 'GPU' { Get-CimInstance Win32_VideoController -ErrorAction Stop })
$av = @(Ler-Noc 'Antivirus (fonte pode nao existir no Windows Server)' { Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct -ErrorAction Stop })
$fw = @(Ler-Noc 'Firewall' { Get-NetFirewallProfile -ErrorAction Stop })
$startup = @(Ler-Noc 'Inicializacao' { Get-CimInstance Win32_StartupCommand -ErrorAction Stop })
$eventos = @(try { Get-WinEvent -FilterHashtable @{LogName='System';Level=1,2;StartTime=(Get-Date).AddDays(-7)} -MaxEvents 200 -ErrorAction Stop } catch {
  if($_.FullyQualifiedErrorId -notmatch 'NoMatchingEventsFound') { $falhas.Add('Eventos System dos ultimos sete dias') }
})
$remotos = @(Get-Process | Where-Object { $_.ProcessName -match '^(AnyDesk|TeamViewer|dwag|rustdesk|ultraviewer|supremo)' } | Select-Object -ExpandProperty ProcessName -Unique)
$ram = if($cs.TotalPhysicalMemory) { [math]::Round($cs.TotalPhysicalMemory/1GB,1) } else { $null }
$uptime = if($os.LastBootUpTime) { [math]::Round(((Get-Date)-$os.LastBootUpTime).TotalDays,1) } else { $null }
$livre = if($vol.Size -gt 0) { [math]::Round(100*$vol.SizeRemaining/$vol.Size,1) } else { $null }
$plano = (powercfg /getactivescheme | Out-String).Trim()
$procMax = @(powercfg /q SCHEME_CURRENT SUB_PROCESSOR PROCTHROTTLEMAX | Select-String '0x[0-9a-fA-F]+\s*$' | ForEach-Object { if($_ -match '(0x[0-9a-fA-F]+)\s*$') { [Convert]::ToInt32($Matches[1],16) } } | Select-Object -Last 2)
$inicio = @{}; Get-Process | ForEach-Object { $inicio[$_.Id] = $_.TotalProcessorTime.TotalSeconds }
$relogio = [Diagnostics.Stopwatch]::StartNew()
Start-Sleep -Seconds 5
$segundos = $relogio.Elapsed.TotalSeconds
$nucleos = [math]::Max(1,[int]$cpu.NumberOfLogicalProcessors)
$top = @(Get-Process | ForEach-Object {
  if($inicio.ContainsKey($_.Id)) {
    [pscustomobject]@{proc=$_.ProcessName;pct=[math]::Round([math]::Max(0,100*($_.TotalProcessorTime.TotalSeconds-$inicio[$_.Id])/$segundos/$nucleos),1)}
  }
} | Sort-Object pct -Descending | Select-Object -First 5)
if($ram -and $ram -lt 8) { $alertas.Add('Menos de 8 GB de RAM; avaliar capacidade conforme a carga.') }
if($dimms.Count -eq 1) { $alertas.Add('Um modulo de RAM detectado; confirmar canais suportados antes de recomendar expansao.') }
if($dimms.Count -eq 3) { $alertas.Add('Tres modulos de RAM; verificar configuracao assimetrica.') }
foreach($d in $dimms) {
  if($d.ConfiguredClockSpeed -gt 0 -and $d.Speed -gt $d.ConfiguredClockSpeed) { $alertas.Add('RAM abaixo da velocidade informada pelo modulo; verificar compatibilidade, sem alterar BIOS automaticamente.') }
  if($d.ConfiguredClockSpeed -gt 0 -and $d.ConfiguredClockSpeed -le 2400 -and $cpu.Name -match 'Ryzen') { $alertas.Add('Ryzen com RAM ate 2400 MHz; avaliar impacto na carga real.') }
}
if($null -ne $livre -and $livre -lt 15) { $alertas.Add('Volume do sistema com menos de 15% livre.') }
elseif($null -ne $livre -and $livre -lt 25) { $alertas.Add('Volume do sistema com menos de 25% livre.') }
foreach($d in $discos) { if($d.HealthStatus -and $d.HealthStatus -ne 'Healthy') { $alertas.Add('Disco com saude diferente de Healthy; conferir backup e diagnostico do fabricante.') } }
foreach($s in $smart) {
  if($null -ne $s.Wear -and $s.Wear -ge 80) { $alertas.Add('SMART informa desgaste igual ou superior a 80%.') }
  if($s.Temperature -ge 60) { $alertas.Add('Disco a 60 graus ou mais.') }
}
foreach($p in $top) { if($p.pct -ge 25) { $alertas.Add("CPU elevada na amostra: $($p.proc), $($p.pct)%. Nao comprova repouso.") } }
if($startup.Count -gt 10) { $alertas.Add('Mais de 10 programas na inicializacao; revisar necessidade sem desabilitar automaticamente.') }
if($av.Count -gt 1) { $alertas.Add('Mais de um produto antivirus registrado; conferir se ambos estao ativos.') }
if(@($fw | Where-Object { $_.Enabled -eq $false }).Count) { $alertas.Add('Firewall desligado em pelo menos um perfil.') }
if($remotos.Count -gt 1) { $alertas.Add('Mais de uma ferramenta de acesso remoto ativa; conferir com o suporte.') }
if($uptime -ge 7) { $alertas.Add('Uptime de pelo menos sete dias; avaliar reinicio em janela autorizada.') }
$quedas = @($eventos | Where-Object { $_.Id -eq 41 -or $_.Id -eq 6008 }).Count
if($quedas) { $alertas.Add('Eventos de desligamento inesperado na amostra dos ultimos sete dias.') }
if(@($eventos | Where-Object { $_.ProviderName -match 'disk|ntfs|storahci|stornvme' }).Count) { $alertas.Add('Erros de armazenamento na amostra de eventos.') }
foreach($g in $gpu) { if($g.DriverDate -and $g.DriverDate -lt (Get-Date).AddYears(-2)) { $alertas.Add('Driver de video com data superior a dois anos; conferir versao homologada.') } }
if(Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired') { $alertas.Add('Windows Update indica reinicio pendente.') }
$r = [ordered]@{
  versaoScript='1.0-nopulso';geradoEm=(Get-Date).ToUniversalTime().ToString('o');admin=$admin
  resumo=[ordered]@{
    tipo=$(if($cs) { switch($cs.PCSystemType){1{'Desktop'} 2{'Notebook'} 3{'Estacao de trabalho'} 4{'Servidor'} 5{'Servidor'} default{'Outro'}} }else{$null})
    fabricante=$cs.Manufacturer;modelo=$cs.Model;cpu=$cpu.Name;nucleos=$cpu.NumberOfCores
    ramGB=$ram;ramPentes=$dimms.Count;ramMHz=@($dimms | ForEach-Object {$_.ConfiguredClockSpeed})
    discos=@($discos | Select-Object -First 8 | ForEach-Object {[ordered]@{modelo=$_.FriendlyName;tipo=[string]$_.MediaType;saude=[string]$_.HealthStatus}})
    livreSistemaPct=$livre;gpu=@($gpu | ForEach-Object {$_.Name});planoEnergia=$plano;procMax=$procMax
    uptimeDias=$uptime;startupCount=$startup.Count;antivirus=@($av | ForEach-Object {$_.displayName})
    firewallOff=$(if($fw.Count){[bool]@($fw | Where-Object {$_.Enabled -eq $false}).Count}else{$null})
    remotos=$remotos;topCpu=$top;erros7dAmostra=$eventos.Count;desligamentosInesperadosAmostra=$quedas
  }
  alertas=@($alertas | Select-Object -Unique);fontesIndisponiveis=$falhas.ToArray();limiteEventos=200
}
$json = $r | ConvertTo-Json -Depth 8 -Compress
$pasta = 'C:\Diagnostico'
try {
  if(-not(Test-Path -LiteralPath $pasta)){ New-Item -ItemType Directory -Path $pasta -ErrorAction Stop | Out-Null }
  $arquivo = Join-Path $pasta ('{0}_{1}.txt' -f $env:COMPUTERNAME,(Get-Date -Format 'yyyy-MM-dd_HHmmss'))
  $r | ConvertTo-Json -Depth 8 | Out-File -LiteralPath $arquivo -Encoding UTF8 -ErrorAction Stop
} catch { }
Write-Output ('NOC_DIAGNOSTICO_JSON:'+$json)
