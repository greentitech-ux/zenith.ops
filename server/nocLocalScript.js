'use strict';
// TCP loopback não exige URL ACL/admin, funciona no PowerShell 3+ e não abre UI.
const PORTA = 17841;
const script = String.raw`param([string]$Origem,[string]$Codigo,[string]$Posto,[string]$Segredo,[int]$Porta=17841)
$ErrorActionPreference='Stop'
$listener=New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback,$Porta)
try { $listener.Start() } catch { return }
try {
  while ($true) {
    if (-not $listener.Pending()) { Start-Sleep -Milliseconds 100; continue }
    $cliente=$listener.AcceptTcpClient()
    try {
      $cliente.ReceiveTimeout=2500; $cliente.SendTimeout=2500
      $stream=$cliente.GetStream()
      $leitor=New-Object IO.StreamReader($stream,[Text.Encoding]::ASCII,$false,1024,$true)
      # Leitura limitada antes de criar strings: não aceitar corpo/cabeçalhos ilimitados.
      $linha={
        $b=New-Object Text.StringBuilder
        while ($b.Length -lt 2048) {
          $n=$leitor.Read(); if($n -lt 0){throw 'Fim da conexão'}
          if($n -eq 10){return $b.ToString().TrimEnd([char]13)}
          [void]$b.Append([char]$n)
        }
        throw 'Linha muito longa'
      }
      $pedido=& $linha
      $cab=@{}; $total=0
      do {
        $l=& $linha; $total+=$l.Length
        if($total -gt 8192){throw 'Cabeçalhos muito longos'}
        if($l -match '^([^:]+):\s*(.*)$'){$cab[$matches[1].ToLowerInvariant()]=$matches[2]}
      } while($l.Length)
      $status='403 Forbidden'; $corpo='{}'; $cors=''
      if($cab['origin'] -ceq $Origem -and $cab['host'] -ceq ('127.0.0.1:'+$Porta)) {
        $cors="Access-Control-Allow-Origin: $Origem\r\nAccess-Control-Allow-Methods: POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\nAccess-Control-Allow-Private-Network: true\r\n"
        if($pedido -ceq 'OPTIONS /validar HTTP/1.1') { $status='204 No Content'; $corpo='' }
        elseif($pedido -ceq 'POST /validar HTTP/1.1' -and $cab['content-type'] -like 'application/json*' -and -not $cab['transfer-encoding']) {
          $tam=0
          if(-not [int]::TryParse([string]$cab['content-length'],[ref]$tam) -or $tam -lt 1 -or $tam -gt 4096){throw 'Corpo inválido'}
          $chars=New-Object char[] $tam; $lidos=0
          while($lidos -lt $tam){$n=$leitor.Read($chars,$lidos,$tam-$lidos);if($n -lt 1){throw 'Corpo incompleto'};$lidos+=$n}
          $d=(-join $chars | ConvertFrom-Json).desafio
          if([string]$d -notmatch '^[A-Za-z0-9_.-]{32,2048}$'){throw 'Desafio inválido'}
          $h=New-Object Security.Cryptography.HMACSHA256
          try {
            $h.Key=[Text.Encoding]::UTF8.GetBytes($Segredo)
            $dados=[Text.Encoding]::UTF8.GetBytes("noc-local\n$Origem\n$d")
            $assinatura=([BitConverter]::ToString($h.ComputeHash($dados))).Replace('-','').ToLowerInvariant()
          } finally {$h.Dispose()}
          $corpo=@{codigo=$Codigo;posto=$Posto;assinatura=$assinatura} | ConvertTo-Json -Compress
          $status='200 OK'
        }
      }
      $bytes=[Text.Encoding]::UTF8.GetBytes($corpo)
      $head="HTTP/1.1 $status\r\n$cors"+"Cache-Control: no-store\r\nContent-Type: application/json\r\nContent-Length: "+$bytes.Length+"\r\nConnection: close\r\n\r\n"
      # PowerShell usa crase para escapes; convertemos só os marcadores do protocolo.
      $head=$head.Replace('\r\n',([string][char]13+[char]10))
      $dados=[Text.Encoding]::ASCII.GetBytes($head);$stream.Write($dados,0,$dados.Length);$stream.Write($bytes,0,$bytes.Length)
    } catch { } finally {$cliente.Close()}
  }
} finally {$listener.Stop()}
`;
// String.raw preserva escapes; para o material assinado precisamos de LF real.
const SCRIPT = script.replace('"noc-local\\n$Origem\\n$d"', '"noc-local`n$Origem`n$d"');
module.exports = { SCRIPT, PORTA };
