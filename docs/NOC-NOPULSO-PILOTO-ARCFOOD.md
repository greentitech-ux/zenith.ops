# Piloto NOC-NoPulso - ARCFOOD

## Objetivo

Validar em duas máquinas de teste a base de gestão segura antes de qualquer
alteração no parque produtivo. O escopo foi derivado do resumo do Caixa 02:
acesso privado da TI, inventário, menor privilégio, softwares permitidos,
proteção do Windows e auditoria.

## Fase 1 - sem impacto operacional

1. Instalar o Tailscale somente nas duas máquinas piloto e associá-las ao
   tailnet corporativo.
2. Validar que apenas o técnico autorizado alcança RDP/AnyDesk pelo endereço
   Tailscale. Não expor RDP ou portas da loja na internet.
3. Confirmar no NOC-NoPulso o estado, IP e versão do Tailscale. O agente só
   inventaria o cliente local; não guarda chave de autenticação nem pares da
   VPN.
4. Registrar nome, unidade, posto, responsável, horário de teste e como
   reverter a instalação para cada piloto.

## Fase 2 - observação antes de bloquear

1. Levantar softwares, versões, conta Windows, proteção, updates, USB e
   inicialização automática.
2. Montar a lista de programas necessários à operação ARCFOOD com aprovação
   do responsável da loja.
3. Testar wallpaper e nomenclatura padrão somente nas duas máquinas piloto.

## Fase 3 - controles que exigem aprovação específica

Esses controles podem interromper vendas ou periféricos se aplicados sem uma
janela de mudança e plano de retorno. Por isso só entram após a Fase 2:

- bloqueio de execução por lista permitida;
- remoção/bloqueio de aplicativos e contas;
- bloqueio de USB;
- alterações de firewall, energia, atualizações ou login automático;
- instalação/remoção de software em massa.

Cada ação deve ter: alvo explícito, responsável, motivo, evidência de sucesso,
janela de execução e comando de reversão testado no piloto.

## Critério para expansão

Expandir somente depois que as duas máquinas permanecerem acessíveis pelo
Tailscale por sete dias, sem impacto no Pulse/PDV, impressora, rede local ou
rotina de balcão, e após a aprovação do responsável ARCFOOD.
