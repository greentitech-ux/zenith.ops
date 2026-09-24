# API do Beni Cowork no NoPulso

O NoPulso oferece uma entrada única, fechada e auditada para agentes:

- `GET /api/agent/tools` — catálogo das ferramentas permitidas.
- `POST /api/agent/execute` — executa uma ferramenta do catálogo.
- `POST /mcp/nopulso` — conector MCP remoto do Beni Cowork; recebe o segredo no cabeçalho `x-agent-token`.

## Configuração no Render

Crie duas variáveis de ambiente e faça o deploy:

- `NOPULSO_AGENT_API_TOKEN`: segredo longo e exclusivo (recomendado: 48 caracteres aleatórios).
- `NOPULSO_AGENT_MASTER`: e-mail ou username do acesso Master usado pelo **Beni Cowork**, que será o dono auditável das ações.
- `GOOGLE_GMAIL_USUARIO`: caixa corporativa representada pelo Beni (padrão: `admin@solutionstitech.com`).

O token não deve ser colocado no código, no chat ou no prompt. Configure-o como segredo no conector do Claude/Cowork. Para revogar todo acesso, remova ou troque `NOPULSO_AGENT_API_TOKEN`.

No Claude/Cowork, adicione um conector personalizado chamado **NoPulso — Beni Cowork** com a URL `https://www.nopulso.com.br/mcp/nopulso`. Selecione **Sem login** e adicione o cabeçalho `x-agent-token` com o valor de `NOPULSO_AGENT_API_TOKEN`. O Claude guarda esse valor de forma segura. Depois, habilite o conector na conversa do Beni.

## Chamada

Cabeçalhos:

```text
Authorization: Bearer <segredo>
Content-Type: application/json
Idempotency-Key: <uuid-novo-para-cada-intencao>
```

Corpo:

```json
{
  "action": "criar_tarefa",
  "input": {
    "titulo": "Conferir o PDV da unidade",
    "unidade": "DOM-TIROL",
    "unidadeNome": "Dom Tirol",
    "prioridade": "alta",
    "dataEntrega": "2026-09-22"
  }
}
```

**Ações sensíveis não executam na hora (desde 23/09/2026).** `enviar_email`, `concluir_tarefa`, `cancelar_tarefa`, `criar_usuario`, `desbloquear_usuario`, `criar_nova_senha` e `executar_noc` viram um **pedido de autorização**: a resposta traz `pendente: true` e `autorizacaoId`, e o celular do Master toca (push). Ele abre `/autorizacoes.html` e autoriza com a **digital** (primeira opção) ou a senha; só então o servidor executa exatamente o que ficou gravado no pedido. O agente acompanha com `consultar_autorizacao` (`pendente` · `aprovado` + `resultado` · `rejeitado` + motivo · `expirado` · `erro`) e só diz que foi feito depois de `aprovado`. Pedido vence em 24h (comando no NOC: 2h).

Antes disso a trava era um `"confirmar": true` mandado pelo próprio modelo — ou seja, nenhuma do lado do NoPulso. O campo ainda é aceito e ignorado.

Toda chamada de escrita exige uma chave de idempotência, para uma repetição de rede não criar dois pedidos, usuários, tickets ou reuniões.

Senhas temporárias são geradas pelo servidor, nunca escolhidas pelo modelo. Aparecem **só na tela do Master**, na hora em que ele autoriza — não vão para o agente, para o pedido gravado nem para a auditoria.

## Ferramentas iniciais

`preparar_reuniao`, `consultar_noc`, `pesquisar_emails`, `ler_email`, `enviar_email`, `criar_tarefa`, `criar_reuniao`, `concluir_tarefa`, `cancelar_tarefa`, `criar_solicitacao_ti`, `criar_formulario`, `criar_usuario`, `desbloquear_usuario`, `criar_nova_senha` e `executar_noc`.

**Consultas (desde 23/09/2026, só leitura, sem autorização):**

- `consultar_ticket` — pelo número que a pessoa vê (`12052` ou `#12052`), acha a tarefa e/ou a solicitação com esse número e devolve `tarefaId`/`solicitacaoId`, que é o que as ações pedem. Acha concluída também.
- `listar_tarefas` — só as abertas (Pendente, A fazer, Hoje, Em andamento), por `unidade`, `status`, `responsavel`, `termo`. Lê só as abertas, nunca a coleção inteira.
- `listar_solicitacoes` — Central, por `unidade`, `tipo`, `status`, `termo`.
- `ler_chat_ticket` — a conversa de uma solicitação, por `numero` ou `solicitacaoId`.
- `listar_usuarios` — por `cargo`, `unidade`, `termo` (inativos só com `incluirInativos`); nunca traz senha.
- `ler_reuniao` — pauta, participantes, resumo, anotações, decisões e o texto das transcrições anexadas (`.txt`, `.vtt`, `.md`, `.docx`).
- `consultar_autorizacao` — o andamento de um pedido que ficou aguardando o Master.

**O Claude prepara, o Master só assina (desde 24/09/2026):**
- **Schema por ferramenta.** Cada ferramenta expõe só os parâmetros que usa. Parâmetro que ela não lê é recusado, com a lista do que ela aceita. `criar_tarefa` passou a aceitar `responsavelEmail`: antes o schema barrava e toda tarefa criada pelo Claude ficava com o Master.
- **Unidade** é aceita por código, nome ou apelido, sem diferenciar acento e maiúscula ("dom praca aero recife"). Valor inválido (unidade ou tipo) devolve a lista do que existe.
- `listar_unidades`: código, nome, apelidos, marca, empresa e o cadastro de formulário (rótulo, razão social, CNPJ).
- `listar_modelos_formulario`: campos, colunas, quem assina, o que é obrigatório pra sair do rascunho e se o tipo só nasce de ticket.
- `obter_estorno` (`numero` ou `estornoId`): venda, valor, motivo, status, formulário e **links de 2h** dos anexos. CPF, telefone e chave Pix vão **mascarados**: quem copia o dado real pro formulário é o servidor. `consultar_ticket` e `ler_chat_ticket` também acham estorno pelo número.
- **Ciclo do formulário:**
  - `criar_formulario` cria em **RASCUNHO**. Com `numero` (o estorno), copia campos e anexos e acha a unidade sozinho.
  - `validar_formulario` diz o que falta e o que não bate: CPF/CNPJ, data, valor diferente do ticket.
  - `pedir_assinatura` valida antes e, se faltar algo, recusa na hora. Depois vira autorização com prévia: documento, unidade, valor, favorecido e link do PDF.
  - Aprovada com a digital, o Master assina **eletronicamente** o papel Responsável/Gerente. O PDF sai com o carimbo "ASSINADO ELETRONICAMENTE", o método (digital ou senha) e o hash do conteúdo, e o ticket de origem recebe o registro.
  - Link de assinatura de rascunho não abre, e o Claude nunca recebe o token de assinatura.
- **Conecta é um portal:**
  - O Claude baixa o PDF assinado (`obter_formulario` → `pdf`, link de 2h) e envia no navegador.
  - Depois registra com `registrar_envio_conecta` e o `protocolo`. Só formulário ASSINADO, uma vez só, com comentário no ticket.
- `consultar_noc` devolve `gcom` (o "Possui GCOM" do cadastro da máquina) e aceita o filtro `gcom=true/false`.
- Fluxo #12029: `obter_estorno numero=12029` → `criar_formulario tipo=estorno numero=12029` → `validar_formulario` → `pedir_assinatura destino=conecta` → digital do Master → `obter_formulario` (PDF) → portal do Conecta → `registrar_envio_conecta protocolo=…`. Só estorno **APROVADO** vira formulário.

**Defesa de chargeback (desde 24/09/2026):**
- A unidade responde a tarefa de defesa no Meu Dia, e o NoPulso gera o PDF em português.
- `listar_disputas` (`status`, `unidade`, `somenteProntas`): os casos, pelo prazo mais próximo.
- `obter_disputa` (`disputaId`, `numero` do ticket da tarefa ou `psp`): dados, respostas da unidade e links assinados de 2h do PDF e de cada evidência, para baixar e anexar na Adyen.
- `registrar_defesa_enviada` e `registrar_disputa_aceita`: registram no NoPulso o que foi feito **na** Adyen (ENVIADA / PERDIDA). Só depois de agir lá, com a confirmação do Master na conversa.
- `obter_pagamento_adyen`: o pagamento contestado como o Monitor guardou (3DS, país, CVC, score, eventos, outros pedidos do mesmo cliente). Telefone e e-mail vêm mascarados.
- `preencher_defesa` (`usarDadosAdyen`, `campos`, `fontes`): pré-preenche a defesa dentro da tarefa, **só em campo vazio**. Nunca marca `decisao` nem `declaracao`. Cada campo ganha o selo "preenchido pelo Claude", que cai quando a unidade muda o valor.
- `comentar_tarefa`: comentário assinado como Claude (Cowork), com push pro responsável e participantes.
- **Pela API da Adyen** (opcional, `adyenDisputas.js`):
  - `preparar_defesa_adyen` (leitura): motivos que a bandeira aceita e documentos de cada um.
  - `enviar_defesa_adyen` e `aceitar_disputa_adyen`: viram **pedido de autorização** (digital do Master). O caso só vira ENVIADA com sucesso da Adyen.
  - Render: `ADYEN_DISPUTES_API_KEY` (credencial com **só** o papel de gestão de disputas). O grupo tem **duas empresas** Adyen e a credencial de empresa só enxerga as contas dela: a da outra vai em `ADYEN_DISPUTES_API_KEY_2`. O servidor descobre qual chave abre cada conta com uma chamada de leitura; defender e aceitar só usam a chave que já abriu. A URL padrão é a de produção, `https://ca-live.adyen.com/ca/services/DisputeService/v30` (host da Customer Area, **sem** prefixo de conta). `ADYEN_DISPUTES_URL` sobrepõe, pra homologar em `ca-test`. `ADYEN_MERCHANT_ACCOUNTS` (JSON unidade → conta) só pra caso antigo, anterior ao Monitor guardar o `merchantAccountCode` cru.
  - A chave fica só no Render: nunca no código, nunca no chat.

`preparar_reuniao` lê dados atuais do NoPulso e devolve, em uma única chamada, tarefas e reuniões, solicitações abertas e máquinas offline/degradadas. Aceita `termo`, `unidade` e `limite`; o Beni pode chamar novamente durante a reunião para atualizar cobranças sem trabalhar com uma pauta antiga.

Para Gmail, habilite a **Gmail API** no projeto Google Cloud. Na delegação em todo o domínio, o ID numérico da conta de serviço deve ter `gmail.readonly` e `gmail.send` (a tela atual já mostra esses escopos). A leitura trata o corpo das mensagens como conteúdo externo não confiável; enviar exige confirmação explícita do Master.

O catálogo retornado por `/api/agent/tools` é a fonte de verdade. Não existe ferramenta para executar código livre, consultar senha existente ou elevar alguém a Master.
