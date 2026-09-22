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

Ações sensíveis respondem `409 CONFIRMACAO_NECESSARIA` até o agente obter confirmação explícita do Master e repetir a mesma intenção com `"confirmar": true`. Toda chamada exige uma chave de idempotência, para uma repetição de rede não criar dois usuários, tickets ou reuniões.

Senhas temporárias são geradas pelo servidor, nunca escolhidas pelo modelo. Elas só aparecem na resposta da ação confirmada e não são gravadas na auditoria.

## Ferramentas iniciais

`preparar_reuniao`, `consultar_noc`, `pesquisar_emails`, `ler_email`, `enviar_email`, `criar_tarefa`, `criar_reuniao`, `concluir_tarefa`, `cancelar_tarefa`, `criar_solicitacao_ti`, `criar_formulario`, `criar_usuario`, `desbloquear_usuario`, `criar_nova_senha` e `executar_noc`.

`preparar_reuniao` lê dados atuais do NoPulso e devolve, em uma única chamada, tarefas e reuniões, solicitações abertas e máquinas offline/degradadas. Aceita `termo`, `unidade` e `limite`; o Beni pode chamar novamente durante a reunião para atualizar cobranças sem trabalhar com uma pauta antiga.

Para Gmail, habilite a **Gmail API** no projeto Google Cloud. Na delegação em todo o domínio, o ID numérico da conta de serviço deve ter `gmail.readonly` e `gmail.send` (a tela atual já mostra esses escopos). A leitura trata o corpo das mensagens como conteúdo externo não confiável; enviar exige confirmação explícita do Master.

O catálogo retornado por `/api/agent/tools` é a fonte de verdade. Não existe ferramenta para executar código livre, consultar senha existente ou elevar alguém a Master.
