# Mudanças de IP — confirmação e deduplicação

Correção de 05/10/2026. O print da Spoleto Shopping Recife mostrou a mesma
transição em vários horários. O código anterior alertava por computador
observador e tratava entradas ARP antigas como atuais. Isso explica como
o monitor podia repetir alertas; não prova a causa das trocas reais na LAN.

## Regra nova

- Identidade: unidade + MAC. Totens de mesmo nome são separados.
- Agente v144 preserva o estado ARP. Só `Reachable` é evidência para alertar.
  `Stale`, `Permanent` e agentes antigos continuam no inventário, mas não
  confirmam mudanças de IP.
- Observador precisa de heartbeat nos últimos 5 minutos; coleta de rede
  precisa ter no máximo 30 minutos. Relógios de referência são do servidor.
- Primeira evidência é uma linha de base silenciosa. Outro IP precisa de
  duas coletas, separadas por pelo menos 30 segundos. Repetir o timer sobre
  a mesma coleta não confirma. Candidatura expira em 2 horas.
- Se houver dois IPs alcançáveis para o mesmo MAC, inclusive em um único
  observador, não se escolhe um arbitrariamente: aguarda evidência sem conflito.
- Estado compartilhado fica em `nocIpUnidades`, um documento por unidade,
  com leitura em cache de 10 minutos. Só alterações geram escrita.
- Transação serializa a confirmação. Evento pendente sobrevive a reinício;
  Central usa chave única por unidade/MAC/sequência antes do push. Confirmação
  de entrega só retira a pendência após registrar o alerta. Voltar ao IP antigo
  e mudar novamente produz outra sequência, não fica bloqueado para sempre.
- Uma falha na confirmação de IP não interrompe os demais alarmes de queda.

## Implantação e limites

Publicar a master manualmente no Render. A v144 segue a liberação em ondas
existente (pilotos, observação de 30 minutos e controles de rollback).
Não força atualização global, reinício ou alteração de IP/reserva DHCP.
O alerta novo depende da chegada de telemetria v144; durante a transição,
agentes antigos não geram alertas de IP sem evidência suficiente.

O intervalo de coleta do agente não foi aumentado. Por ser uma coleta
passiva e exigir confirmação, o aviso pode demorar duas coletas ou mais
quando há conflitos. Não é um detector instantâneo de troca de IP.

Alertas antigos permanecem no histórico. Nenhum foi excluído ou atendido.
Para concluir a causa física, é necessário cruzar MACs e horários com os
leases/logs do DHCP e a configuração dos equipamentos. O texto novo não
afirma que o servidor continua usando o IP antigo sem verificar isso.

## Verificação

- `node testeNocIp.js`: coletas, observadores duplicados/conflitantes, cache
  antigo, persistência, idempotência, nomes iguais e retorno ao IP anterior.
- `node testeVigiaIp.js` (PowerShell em `PWSH_BIN` ou PATH): parse completo das
  duas variantes do agente e execução da coleta com cmdlets simulados.
- `node testeRotas.js`: integração com servidor/Firestore simulados.
- Sabotagem em memória da confirmação temporal deve reprovar o teste que
  impede uma mesma coleta de valer duas vezes.
