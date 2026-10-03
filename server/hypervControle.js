// Controle fechado de UMA VM, sempre pelo agente elevado do host.
const ACOES = new Set(['ligar', 'desligar', 'reiniciar']);
function preparar(host, nome, acao, agora = Date.now()) {
  if (!ACOES.has(acao)) throw new Error('Ação de VM inválida.');
  if (!host || host.tipo !== 'interno' || !host.agentToken) throw new Error('Escolha um host interno com agente autenticado.');
  if (!host.ultimoHeartbeatEm || agora - host.ultimoHeartbeatEm > 5 * 60 * 1000) throw new Error('Host sem contato recente. Aguarde o agente voltar.');
  if (typeof nome !== 'string' || !nome || !Array.isArray(host.vms) || !host.vms.some(v => v.nome === nome)) throw new Error('VM não encontrada no inventário deste host.');
  const alvo = Buffer.from(nome, 'utf8').toString('base64');
  const vence = new Date(agora + 5 * 60 * 1000).toISOString();
  const comando = [
    "$ErrorActionPreference = 'Stop'",
    `if ([DateTime]::UtcNow -gt [DateTime]::Parse('${vence}').ToUniversalTime()) { throw 'Pedido vencido. Confira a VM e solicite novamente.' }`,
    "Import-Module Hyper-V -ErrorAction Stop",
    `$nome = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${alvo}'))`,
    "$lista = @(Get-VM -ErrorAction Stop | Where-Object { [string]::Equals($_.Name, $nome, [StringComparison]::Ordinal) })",
    "if ($lista.Count -ne 1) { throw 'VM ausente ou ambígua no host. Nenhuma ação executada.' }",
    '$vm = $lista[0]; $idVm = $vm.Id',
    ...(acao === 'ligar' ? [
      "if ($vm.State -ne 'Off') { throw 'Ligar exige VM desligada. Confira o estado atual.' }",
      'Start-VM -VM $vm -Confirm:$false -ErrorAction Stop',
    ] : [
      "if ($vm.State -ne 'Running') { throw 'Desligar ou reiniciar exige VM executando. Confira o estado atual.' }",
      '# Nunca usar Force, TurnOff ou Restart-VM: não cortar energia.',
      '$job = Stop-VM -VM $vm -AsJob -Confirm:$false -ErrorAction Stop',
      'try {',
      "  if (-not (Wait-Job -Job $job -Timeout 120)) { throw 'VM não confirmou desligamento em 120 segundos. Pode ainda estar encerrando; confira antes de tentar novamente. Não foi forçada nem religada.' }",
      '  Receive-Job -Job $job -ErrorAction Stop | Out-Null',
      "  $vm = Get-VM -Id $idVm -ErrorAction Stop",
      "  if ($vm.State -ne 'Off') { throw 'Desligamento não confirmado. Não foi forçado nem religado.' }",
      ...(acao === 'reiniciar' ? ['  Start-VM -VM $vm -Confirm:$false -ErrorAction Stop'] : []),
      '} finally {',
      "  if ($job.State -eq 'Running') { Stop-Job -Job $job -ErrorAction SilentlyContinue }",
      '  Remove-Job -Job $job -ErrorAction SilentlyContinue',
      '}',
    ]),
    '$atual = Get-VM -Id $idVm -ErrorAction Stop',
    `Write-Output ('VM: ' + $atual.Name + ' | Ação: ${acao} | Estado observado: ' + $atual.State)`,
  ].join('\n');
  return { comando, origem: `noc-hyperv-${acao}`, requerAdmin: true };
}
module.exports = { preparar };
