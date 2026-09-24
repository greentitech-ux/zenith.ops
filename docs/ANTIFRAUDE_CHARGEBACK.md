# Antifraude e chargeback — especificação revisada contra o código

**24/09/2026.** Revisão da "Especificação NoPulso — Antifraude Pré-Produção e
Chargeback Automatizado" (Cowork), separando o que o código já tem, o que
é real, o que tem ressalva e o que não existe (regra 6 do CLAUDE.md). Base:
`disputas_historico_2026-09-24.csv` — 265 disputas de 5 contas (DOM19940
100, DOM_19798 67, DOM_19706 47, DOM_19633 35, DOM19911 16).

## 1. O que os números dizem (e o que muda na prioridade)

| Fato do CSV | Consequência |
|---|---|
| 260 de 265 (98%) são motivo de fraude; 4 "Cardholder dispute", 1 "Paid by other means" | Quase tudo é cartão não presente sem autorização do titular. |
| Só 7 de 265 estavam defensáveis; 163 terminaram em `DisputeDefensePeriodEnded` | O dinheiro se perde por **prazo**, não por defesa ruim. |
| 6 `ChargebackReversed` | Ganhar existe, mas é raro. |
| Sem 3D Secure e AVS "Unknown" em todos os casos inspecionados | Contestar fraude sem 3DS perde quase sempre. |

**Ordem de valor, da maior pra menor:**
1. Prevenção na Adyen: 3DS e regras de risco no checkout. Fora do código; recusa o pagamento antes de o pedido existir.
2. Não perder prazo das defensáveis (fase 1 abaixo).
3. Lista de bloqueio: o mesmo fraudador volta (fase 3).
4. Defesa automática pela API (fase 2). Vale para "Cardholder dispute" e para fraude com evidência forte; o resto é aceitar e aprender.

## 2. O que o NoPulso já tem (não reconstruir)

| Peça | Onde | Estado |
|---|---|---|
| Registro de disputa com anexos | `disputes.js`, `relatorios.html`, botão "📎 Registrar disputa" no Monitor | Manual. Status `MONITORANDO → ABERTA → ENVIADA → GANHA / PERDIDA`, mais `ERRO_SISTEMA`. **Esse vocabulário fica** (CLAUDE.md §5); os status da Adyen são mapeados para ele, não inventados. |
| Painel de chargebacks com prazo | `monitor.html` (vermelho ≤ 2 dias), `store.chargebacks()` | Existe. O prazo vem de `defensePeriodEndsAt`. Nenhum lembrete automático. |
| Eventos de chargeback no webhook | `normalize.js` | `CHARGEBACK`, `SECOND_CHARGEBACK`, `CHARGEBACK_REVERSED`, `NOTIFICATION_OF_CHARGEBACK`, `DISPUTE_DEFENSE_PERIOD_ENDED`, `PROCESS_RETRIEVAL`. |
| Detectores de fraude | `cardTesting.js` (3 recusas/10 min), `cardHopping.js` (3 finais/20 min), `pixRepetido.js`, `fraudIdentity.js`, `fraudMarks.js` | Rodam no webhook, em memória, com push. `fraudIdentity` já aprendeu do jeito difícil que regra de nome gera falso positivo: a primeira versão marcou 98,5% dos pedidos legítimos. |
| Raio-X de risco | `monitor.html` | Pontuação na tela do cliente; não alerta nem grava. |
| PDF com anexos juntados | `formularios.js` (`pdf-lib`, `anexarDocumentos`) | Reaproveitável para o dossiê. |
| Link público com upload | `formularios.js` + `preencher.html` | Reaproveitável para o questionário da unidade. |
| Autorização com digital/senha no celular | `autorizacoes.html`, `qaAprovacoes.js` (desde 23/09) | Pronto. Enviar e aceitar defesa entram aí. |

## 3. Correções na especificação

### Ficção: não construir como descrito

- **R2 "nome do titular ≠ nome do cliente" na hora do pedido.** Para cartão, o NoPulso só recebe o nome do titular: o webhook já tem todas as opções de dados do comprador ligadas nas 9 contas (confirmado pelo Cowork em 24/09) e o nome do comprador não vem. O caso citado ("Mateus" × "Karla Garcia Alves") é o comentário do banco, que chega **com o chargeback**, semanas depois.
  - Pra existir: o checkout do site/app mandar `shopperName` e `telephoneNumber` para a Adyen.
  - Até lá, a regra entra desligada e liga sozinha quando o campo começar a chegar.
- **R5 `NOTIFICATION_OF_FRAUD` como alerta pré-produção.** O aviso chega **dias depois** do pagamento: aquele pedido já foi entregue. Serve para:
  - bloquear o cartão e o cliente nos próximos pedidos (R4);
  - abrir a disputa antes do chargeback;
  - não deixar a limpeza de 2 dias apagar o pedido.
- **"Travar a produção" e "10 minutos para confirmar com o cliente".** O NoPulso não sabe quando o pedido entra na cozinha. O `merchantReference` (UUID da Adyen) também não está ligado ao número do pedido no PDV.
  - O alerta existe, mas diz "pagamento suspeito de R$ 89,90, cartão final 1234, 20:14, Dom Tirol". A loja localiza o pedido por valor e hora.
  - Travar de verdade depende de uma integração com o sistema de pedidos que não existe.
- **Coleções `pagamentos/{psp}` e `idx_*` gravadas a cada autorização.** Duplica o que o `store.js` já guarda (um documento por evento, tudo em memória) e soma 3–4 escritas por pagamento no Firestore (CLAUDE.md §3). A velocidade (1h/24h) é calculada em memória, como os detectores atuais fazem.
- **Status novos (`Undefended`, `Pending`, `Responded`…).** Mapear para `ABERTA`, `ENVIADA`, `GANHA`, `PERDIDA`, e mostrar o status da Adyen como detalhe.

### Real com ressalva

- **R1 "mesmo cartão em várias contas".** Usa `alias`, que já é gravado (`aliasCartao`) e não é usado por nenhuma regra. Cai para `bin+final` quando não vier alias.
  - Ressalva 1: depende de `shopperReference` chegar no webhook. Conferir num pagamento real depois do deploy.
  - Ressalva 2: a janela de 7 dias não cabe na retenção de 2 dias. Fica 24h em memória, e o histórico longo vem da lista de bloqueio.
- **Backfill dos 265.** O CSV não tem cartão nem cliente, só o `ref_psp_pagamento`.
  - O NoPulso só tem os dados de autorização dos pedidos que **ainda estão guardados**. Pedido com chargeback não é apagado, mas só se o chargeback chegou pelo webhook.
  - O critério "≥ 60% dos 265 teriam alertado" só pode ser medido sobre esse subconjunto. O número real sai na fase 3.
- **Retenção.** Hoje a limpeza de 2 dias protege pedidos com chargeback e com a marca de fraude da Adyen, mas **não** protege os marcados pelos nossos detectores nem os que receberam `NOTIFICATION_OF_FRAUD`. Precisa proteger, senão o aprendizado some.
- **Formulário tipado na tarefa.** A tarefa não tem campo tipado, e o `formularios.js` só tem texto, data e valor.
  - Em vez de reescrever a tarefa: a tarefa do Meu Dia leva a um **questionário de chargeback próprio**, com seleção, sim/não, hora e anexo por pergunta, gravado na própria disputa.
- **Webhook responde mais devagar.** Hoje o `fraudMarks.marcar` é aguardado antes do `[accepted]`. Motor novo roda em memória e grava depois de responder: a Adyen desiste em 10s e reenvia.

### Real: fazer

- Disputa aberta **sozinha** pelo webhook no `disputes` existente (hoje só manual), com prazo interno = o menor entre `defensePeriodEndsAt − 2 dias` e 48h.
- `NOTIFICATION_OF_FRAUD` e `REQUEST_FOR_INFORMATION` tratados: push crítico, disputa aberta, pedido protegido da limpeza.
- Tarefa no Meu Dia do gerente da unidade, com prazo, lembrete em 24h e escalonamento 12h antes do prazo interno para o Master.
- Lista de bloqueio: cartão (alias ou bin+final), `shopperReference`, e-mail, IP. Telefone e endereço entram quando vierem. Alimentada automaticamente por chargeback de fraude e manualmente pelo Master.
- Dossiê em PDF (A4, inglês, ≤ 2 MB, dados sensíveis mascarados) juntando carta + anexos com o `pdf-lib` que já existe.
- Envio e aceite pela Disputes API **só** pela tela de Autorizações (digital primeiro, senha como alternativa).
- Ferramentas do Cowork: `listar_disputas`, `obter_disputa` (com anexos por link temporário), `registrar_parecer_disputa`, `solicitar_complemento_disputa`, `gerar_dossie_disputa`, `enviar_defesa_disputa` e `aceitar_disputa` (as duas últimas viram pedido de autorização), `listar_alertas_fraude`, `gerenciar_lista_bloqueio`.

## 4. Uma defesa que o CSV sugere e a especificação não cita

Para Visa por fraude (10.4), a Visa aceita como prova duas compras anteriores sem contestação, do mesmo cartão e cliente, feitas de 120 a 365 dias antes, com dados batendo (IP, aparelho, endereço, conta). É o "Compelling Evidence 3.0"; **confirmar as regras exatas na documentação da Visa/Adyen antes de construir**.

Hoje isso é impossível: o NoPulso apaga transação em 2 dias. Para usar, seria preciso guardar um resumo por cartão/cliente por 365 dias:
- só o `alias`, a data e o IP de pedidos **aprovados e sem disputa**;
- em um documento por cartão, atualizado no máximo uma vez por dia.

É uma decisão de custo e de LGPD. Fica na fase 4, se as fases anteriores mostrarem que vale.

## 5. Respostas às 6 perguntas para o dev

1. **`merchantReference` ↔ pedido do PDV:** não existe no NoPulso. Nenhum módulo liga uma coisa à outra.
2. **Pedido em produção:** o NoPulso não sabe.
3. **Captura automática ou manual:** não está no código; é configuração da conta Adyen (o Cowork confere em *Account → Settings → Capture delay*). Se for manual, segurar a captura do pedido crítico vira possível.
4. **Dono do checkout (3DS, AVS, nome e telefone do comprador):** fora do NoPulso. É quem integrou o site/app à Adyen.
5. **Meu Dia com formulário e upload:** anexo sim (10 MB por arquivo, até 20); campo tipado não. Ver "questionário de chargeback próprio" acima.
6. **Anexos:** Firebase Storage. Limites atuais: tarefa 10 MB por arquivo, formulário 15 MB, disputa 50 MB por arquivo e até 8 por envio.

## 6. Fases revisadas

| Fase | Entrega | Depende de | Aceite |
|---|---|---|---|
| **1** | Disputa aberta sozinha pelo webhook (inclui `NOTIFICATION_OF_FRAUD`), pedido protegido da limpeza, tarefa na unidade com prazo interno, lembretes e escalonamento, questionário próprio com anexos, `listar_disputas`/`obter_disputa` no Cowork | nada fora do código | chargeback real vira tarefa na unidade certa em ≤ 5 min, com prazo interno certo |
| **2** | Dossiê PDF em inglês, parecer do Claude, envio/aceite pela Disputes API via Autorizações, resultado de volta pelo webhook | credencial de API com "dispute management" nas **duas** empresas, guardada no Render | uma disputa real enviada ponta a ponta |
| **3** | Motor de risco em memória (R1, R3, R4, R7; R2 desligada até o nome do comprador chegar), lista de bloqueio, fila "Pagamentos suspeitos" no Monitor com som e push para a unidade, medição sobre os pedidos guardados | nada | medição publicada: quantos dos chargebacks guardados teriam alertado |
| **4** | Acerto por regra (precisão/recall), pesos na tela Master, relatório semanal, decisão sobre o histórico de 365 dias | fases 1–3 rodando por algumas semanas | painel com acerto por regra e valor recuperado |

## 7. Fora do código (Sidney)

- **Para a fase 2:** credencial de API "dispute management" nas duas empresas Adyen.
- **Maior efeito de todos:** 3DS e regras de risco da Adyen no checkout do site/app.
- **Para a R2:** o checkout do site/app mandar nome e telefone do comprador para a Adyen.
- **Eventos do webhook:** o Cowork confere nas 9 contas os eventos de disputa listados na especificação original, item 1.1.
