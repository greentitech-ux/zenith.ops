# Formulários públicos e estornos — 08/10/2026

O conector gera `/preencher?token=...`. As rotas antigas
`/formulario-preencher` e `/formulario-preencher.html` servem a mesma página,
sem login e preservando o token. O token continua sendo validado pela API.

Antes de devolver um link, inclusive numa repetição pela chave de
idempotência, o conector consulta a página e a API pública sem sessão.
Recusa redirecionamento, erro HTTP, HTML de login, token inválido, formulário
divergente e timeout. O erro não expõe o token. Após corrigir deploy ou
APP_BASE_URL, uma nova chave de idempotência reaproveita o formulário pendente.

O formulário público de estorno grava tarefa e registro `refundRequests`
num único lote do Firestore, com o mesmo número de protocolo e referências
nos dois sentidos. O estorno nasce PENDENTE; gerar o documento financeiro
continua exigindo aprovação. A falha no lote não deixa tarefa sem estorno.
Arquivos enviados ao Storage e a reserva do contador precedem o lote.

## Registros já existentes

- Links antigos, como o do formulário #12382, passam a abrir pela rota
  compatível depois do deploy, desde que o token ainda seja válido.
- Tarefas antigas sem estorno, como a #12378 relatada, precisam da ação
  autenticada de criar estorno a partir da tarefa. Essa conversão agora
  preserva também os anexos, além do protocolo e dados da triagem.
- Esta entrega não altera registros de produção nem aprova estornos.
- Envio automático por WhatsApp/SMS não foi incluído.

## Verificação

`TESTE_FORMULARIO_PUBLICO=1 node testeRotas.js` executa o fluxo dedicado
contra o servidor real e Firestore falso. Acrescentar
`TESTE_FORMULARIO_DASHBOARD=1` ativa a proteção do dashboard e verifica
que o fluxo público continua dispensando login.

Cobertura: link do conector e sua repetição, aliases, token inválido,
erro/redirect/login/timeout, reaproveitamento após falha, submissão pública,
vínculos, protocolo, dados Pix, anexos, aprovação obrigatória, rejeição de
dados incompletos, falha de commit e conversão de triagem antiga.

Quatro sabotagens foram detectadas: retirar a liberação pública, desativar
a validação do link, gravar a tarefa fora do lote e perder os anexos na
conversão antiga. Os arquivos foram restaurados após cada cenário.

A suíte completa apresentou 66 falhas também reproduzidas na base
`c7c150c`, com os mesmos cenários reprovados. O teste específico passou.
Os logs de comparação foram mantidos no workspace do chat.

O projeto usa deploy manual no Render; push na master não publica o serviço.
