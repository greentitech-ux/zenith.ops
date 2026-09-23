// socorroRedeScript.js
// SOCORRO DE REDE/DNS - pra COLAR na maquina, nao pra o agente rodar.
//
// Pedido do Master (22/09/2026), depois da MMTIROL-PDV01: ela ficou 10h fora
// do NOC porque o DNS configurado nela parou de responder. A placa estava Up,
// o gateway respondia, o AnyDesk chegava - so nao havia quem traduzisse nome
// em endereco, entao TODA chamada do agente morria em timeout.
//
// POR QUE NAO E UM COMANDO DO NOC: maquina sem DNS nao recebe comando nenhum.
// O agente dela nao alcanca o servidor - e exatamente esse o problema. E pelo
// mesmo motivo ele NAO baixa nada de URL, como o reparo faz: o script precisa
// vir dentro do proprio comando.
//
// ELE SE ELEVA SOZINHO. O Master perdeu meia hora colando num PowerShell
// comum e batendo em "Acesso a um recurso CIM nao estava disponivel para o
// cliente" - que e permissao, nao rede. Configuracao de placa passa por
// CIM/WMI privilegiado. Se ja estiver elevado, roda ali mesmo.
const DIAGNOSTICO = [
  "$ErrorActionPreference = 'Continue'",
  "Write-Host ''",
  "Write-Host '=== NoPulso - socorro de rede e DNS ===' -ForegroundColor Cyan",
  // a placa que REALMENTE carrega a rede e a que tem rota de saida
  '$cfg = @(Get-NetIPConfiguration -ErrorAction SilentlyContinue | Where-Object { $_.IPv4DefaultGateway })[0]',
  'if (-not $cfg) {',
  "  Write-Host 'Nenhuma placa com rota de saida - a maquina esta sem rede fisica.' -ForegroundColor Red",
  "  Write-Host 'Confira cabo, porta do switch e se a placa esta habilitada (Get-NetAdapter). DNS nao tem a ver com isso.'",
  '  return',
  '}',
  '$alias = [string]$cfg.InterfaceAlias',
  '$gw = [string]$cfg.IPv4DefaultGateway.NextHop',
  // sem o filtro de familia vem o IPv6 junto e a lista fica ilegivel
  '$dnsAntes = @(($cfg.DNSServer | Where-Object { $_.AddressFamily -eq 2 }).ServerAddresses)',
  '$dhcp = try { [string](Get-NetIPInterface -InterfaceAlias $alias -AddressFamily IPv4 -ErrorAction Stop).Dhcp } catch { "?" }',
  'Write-Host ("Placa: {0} | IP: {1} | Gateway: {2} | DHCP: {3}" -f $alias, [string]$cfg.IPv4Address.IPAddress, $gw, $dhcp)',
  'Write-Host ("DNS atual: {0}" -f $(if ($dnsAntes.Count) { $dnsAntes -join ", " } else { "(nenhum)" }))',
  "Write-Host ''",
  // o gateway responde? se nao, o problema e ANTES do DNS e trocar DNS so
  // gasta tempo - foi a hipotese que eu levantei errado uma vez
  '$gwOk = $false',
  'try { $gwOk = [bool](Test-Connection -ComputerName $gw -Count 2 -Quiet -ErrorAction SilentlyContinue) } catch {}',
  'if (-not $gwOk) { Write-Host ("AVISO: o gateway {0} nao respondeu ao ping. Pode ser so ICMP bloqueado - mas se nada funcionar depois disto, o problema esta na rede da loja." -f $gw) -ForegroundColor Yellow }',
  // se o DNS de agora resolve, NAO MEXE: trocar de graca quebra nome interno
  '$dnsOk = $false',
  "try { Resolve-DnsName 'google.com' -QuickTimeout -ErrorAction Stop | Out-Null; $dnsOk = $true } catch {}",
  'if ($dnsOk) {',
  "  Write-Host 'O DNS atual esta resolvendo. NADA foi alterado nesta maquina.' -ForegroundColor Green",
  "  Write-Host 'Se o computador segue fora do NOC, o problema nao e DNS.'",
  '  return',
  '}',
  "Write-Host 'O DNS atual nao resolve. Trocando para 1.1.1.1 e 8.8.8.8...' -ForegroundColor Yellow",
  'Set-DnsClientServerAddress -InterfaceAlias $alias -ServerAddresses 1.1.1.1,8.8.8.8',
  'Clear-DnsClientCache',
  'try {',
  "  Resolve-DnsName 'google.com' -QuickTimeout -ErrorAction Stop | Out-Null",
  "  Write-Host ''",
  "  Write-Host 'RESOLVEU. O NOCZenith volta ao NOC em ate 5 minutos.' -ForegroundColor Green",
  "  Write-Host 'ATENCAO: com DNS publico, nome INTERNO da loja pode parar de resolver' -ForegroundColor Yellow",
  "  Write-Host '(servidor, impressora por nome, pasta compartilhada). Confira se o PDV abre.'",
  '  if ($dnsAntes.Count) { Write-Host ("Pra voltar como estava: Set-DnsClientServerAddress -InterfaceAlias {0} -ServerAddresses {1}" -f $alias, ($dnsAntes -join ",")) }',
  '  else { Write-Host ("Pra voltar ao automatico: Set-DnsClientServerAddress -InterfaceAlias {0} -ResetServerAddresses" -f $alias) }',
  '} catch {',
  "  Write-Host ''",
  "  Write-Host 'AINDA NAO RESOLVE, mesmo com DNS publico.' -ForegroundColor Red",
  "  Write-Host 'O problema esta ANTES do DNS: gateway, firewall ou o link da loja.'",
  '  if ($dnsAntes.Count) { Write-Host ("O DNS que estava aqui era: {0}" -f ($dnsAntes -join ", ")) }',
  '}',
].join('\n');

// TAMANHO IMPORTA: o console do Windows nao aceita linha gigante (limite
// pratico ~8191 caracteres). Duplo -EncodedCommand em UTF-16 inflava o script
// 7x e passava de 23 mil - nao colava em lugar nenhum. Um nivel so, base64 de
// UTF-8, da 1,33x.
function montarComandoSocorroRede() {
  const corpo = [
    "$d = @'",
    DIAGNOSTICO,
    "'@",
    '$eAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    'if ($eAdmin) { & ([scriptblock]::Create($d)); return }',
    // senao grava e reabre pelo UAC. -NoExit porque o resultado E a entrega:
    // sem ele a janela fecha e ninguem ve o que aconteceu
    '$f = Join-Path $env:TEMP ("NoPulso-socorro-rede-" + [Guid]::NewGuid().ToString("N") + ".ps1")',
    'Set-Content -LiteralPath $f -Value $d -Encoding UTF8',
    'try { Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList ("-NoExit -NoProfile -ExecutionPolicy Bypass -File " + [char]34 + $f + [char]34) -ErrorAction Stop }',
    'catch { Write-Host "O socorro de rede nao foi autorizado no UAC. Nada foi alterado." -ForegroundColor Red }',
  ].join('\n');
  const b64 = Buffer.from(corpo, 'utf8').toString('base64');
  return 'powershell -NoProfile -ExecutionPolicy Bypass -Command "iex ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(\'' + b64 + '\')))"';
}

module.exports = { montarComandoSocorroRede, DIAGNOSTICO };
