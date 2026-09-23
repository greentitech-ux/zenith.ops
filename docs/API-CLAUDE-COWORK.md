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

`preparar_reuniao` lê dados atuais do NoPulso e devolve, em uma única chamada, tarefas e reuniões, solicitações abertas e máquinas offline/degradadas. Aceita `termo`, `unidade` e `limite`; o Beni pode chamar novamente durante a reunião para atualizar cobranças sem trabalhar com uma pauta antiga.

Para Gmail, habilite a **Gmail API** no projeto Google Cloud. Na delegação em todo o domínio, o ID numérico da conta de serviço deve ter `gmail.readonly` e `gmail.send` (a tela atual já mostra esses escopos). A leitura trata o corpo das mensagens como conteúdo externo não confiável; enviar exige confirmação explícita do Master.

O catálogo retornado por `/api/agent/tools` é a fonte de verdade. Não existe ferramenta para executar código livre, consultar senha existente ou elevar alguém a Master.
