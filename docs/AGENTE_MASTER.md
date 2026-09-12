# Agente "braços do Master" — como usar

Pedido do Master (12/09/2026): *"quero um agente que faça o que eu preciso,
rápido, por baixo, poucas frases — ele mostra como vai ficar e eu aprovo".*

Isso **já existe no NoPulso** — é o Beniboy no modo agente — e agora cobre as
ações do dia a dia. Nada de API nova, token novo nem senha compartilhada: o
agente age **em nome do Master que pediu**, e toda ação sensível passa pela
**fila de aprovação** que o app já tem.

---

## 1. O que é, em uma frase

Você fala com o **Beniboy** (widget de chat, logado como Master). Ele escolhe
uma **ação do catálogo**, monta um resumo de 1 linha ("como vai ficar"), e:

- se a ação **precisa de aprovação** → vira um card em **NOC → 🧪 Aprovações**;
  você aprova ou rejeita; só depois executa;
- se **não precisa** (você marcou assim ao cadastrar) → executa na hora e
  devolve o resultado no chat.

Ele **nunca inventa ação**: só escolhe entre o que o Master cadastrou.

## 2. Como ligar (3 passos, uma vez)

1. **NOC-NoPulso → Ações do agente → Nova ação.** Tipo **Ação de sistema**,
   escolha a ação, dê nome e descrição (é a descrição que o Beniboy lê pra
   decidir *quando* usar), e marque **"Precisa de aprovação"** conforme o risco.
   Cadastre uma por linha da tabela abaixo (ou só as que você usa).
2. **NOC-NoPulso → Contexto do agente:** texto livre com suas orientações
   ("responda curto", "prioridade padrão média", "reunião sempre 30 min"...).
   Vai direto pro cérebro do Beniboy quando quem fala é Master.
3. **Fale com ele pelo widget**, logado como Master. Poucas frases bastam.

## 3. As ações (o que o agente faz por baixo)

| Ação de sistema | O que faz | Em nome de quem |
|---|---|---|
| `criar_tarefa` | Cria tarefa no Meu Dia (título, unidade, prioridade, prazo, responsável) | Master (responsável padrão: o próprio) |
| `marcar_reuniao` | Cria reunião no Meu Dia (dia, hora, duração, link gerado ou colado) | Master |
| `concluir_tarefa` | Conclui uma tarefa em aberto | Master |
| `cancelar_tarefa` | Cancela uma tarefa em aberto, com motivo | Master |
| `desbloquear_usuario` | Destrava um acesso bloqueado (por e-mail ou username) | Master |
| `resetar_senha_usuario` | Gera senha temporária e reseta (nunca Master) | Master |
| `criar_usuario_copiando` | Cria acesso copiando as permissões de um usuário-modelo | Master |
| `responder_chat` | Responde uma conversa do suporte, assinando como Suporte | Master |
| `noc_comando` | Reiniciar / abortar / AnyDesk / Zebra / destravar rede em computadores do NOC | Master |
| `criar_usuario_zenith` | (já existia) cria acesso do zero | Master |

Além dessas, **comando de máquina** (PowerShell fixo via NOCZenith) continua
disponível como antes.

**Vocabulário é o do código** (§5 do CLAUDE.md): prioridade `baixa | media |
alta | critica`; tarefa `A_FAZER | HOJE | EM_ANDAMENTO | CONCLUIDA | CANCELADA`;
comando do NOC `reiniciar | abortar | anydesk | zebra | rede`.

## 4. Exemplos de conversa

> **Você:** cria tarefa "verificar rede da Ilha", alta, pra hoje
> **Beniboy:** Vou criar: *Tarefa "verificar rede da Ilha" · Sao Braz Ilha ·
> prioridade alta · previsão hoje · responsável você.* Mandei pra sua aprovação
> em NOC → Aprovações.
> *(você aprova no card → a tarefa nasce no Meu Dia com origem "agente")*

> **Você:** desbloqueia o acesso da elaine
> **Beniboy:** Vou destravar **elaine@grupobravoempresarial.com** (sem obrigar
> troca de senha). Aprovar?

> **Você:** reinicia o caixa 2 da Ilha
> **Beniboy:** Vou **reiniciar** o computador *SBI/CX2*. Confirma?

> **Você:** marca reunião com o Ramiro amanhã 10h, meia hora
> **Beniboy:** *Reunião "com o Ramiro" · amanhã 10:00 · 30 min · link gerado.*
> Aprovar?

## 5. Segurança — o que está garantido pelo servidor

- **Quem age é você.** O `porId` do Master é gravado pelo **servidor** a partir
  da sessão da conversa — o modelo não consegue apontar outra pessoa. Na hora
  de executar, a pessoa é relida e tem que continuar **Master e ativa**.
- **Nada roda sem cadastro.** Só ações do catálogo; lista fechada de comandos
  do NOC; senha de Master nunca é resetada pelo agente.
- **Aprovação sobrevive a restart.** O card guarda tipo + parâmetros, não
  código. Aprovou → executa; rejeitou → nada acontece.
- **Auditoria natural.** Tarefa nasce com `origem: "agente"` no seu nome; chat
  sai assinado com o seu e-mail; o card diz *"seu-usuário (via Beniboy)"*.
- **Revogar** = desativar a ação (ou o acesso). Sem token extra pra vazar.

## 6. Sobre o "print de como vai ficar"

O que o app produz hoje é o **resumo de 1 linha** no card de aprovação (é isso
que o Beniboy escreve antes de pedir o seu "sim"). Ele **não gera imagem** —
uma captura de tela renderizada é coisa de um agente com navegador (Cowork
com browser), não do servidor. Se você quiser o print real depois de cada
ação, esse agente externo pode logar com **um acesso próprio** (crie um
usuário pra ele, marcado **QA Master** — 100% do acesso, mas exclusões e
configuração global ficam presas na mesma fila pra você aprovar) e tirar o
print da tela após a aprovação. Nunca use a sua senha nele.

## 6.1 Token de API do Master (o chat "Beni" no Cowork)

Decidido em 12/09/2026: *"só quem usará sou eu esse Token Global, em um chat no
Cowork"*. Existe um token pessoal pro Master chamar a API de fora do navegador.

**Como ligar (uma vez):**

1. Gere: `openssl rand -hex 32`
2. No Render → Environment: `MASTER_API_TOKEN=<o valor gerado>` → Manual Deploy
3. No chat do Cowork, use em toda chamada: `Authorization: Bearer <token>`

**O que ele é — e o que ele não é.** Ele **não** é um escopo de permissão
separado (era isso que a especificação pedia, com `BOT_ACAO_TOKEN` e regras
próprias por rota). Ele resolve pro **usuário Master de verdade** e segue pelo
**mesmo** `aplicarUsuarioNoReq` da sessão do navegador. Consequências:

- toda rota que já existe funciona, sem exceção e sem regra nova;
- tudo que ele fizer já sai auditado **no nome do Master** (`req.user.email`),
  porque é literalmente o Master agindo;
- não há dois sistemas de permissão pra manter em sincronia — e é aí que
  nascem as brechas.

**As travas que ele tem:**

| Trava | O que faz |
|---|---|
| Mínimo de 32 caracteres | Token curto **desliga** a porta e avisa no boot |
| `crypto.timingSafeEqual` | Comparação em tempo constante (não vaza por timing) |
| Sem sessão (`sid` nulo) | Não vira sessão de navegador nem aparece em "sessões ativas" |
| Log de toda chamada | `[api-token] MÉTODO /rota` — o valor do token **nunca** vai pro log |

**O risco, dito com todas as letras:** quem tiver esse valor **é** o Master —
pode aprovar, editar e excluir tudo. Trate como a sua senha. Não cole em
mensagem, print ou issue. Se desconfiar de vazamento, troque a variável no
Render e faça o deploy: a revogação é imediata.

## 7. Opção "por baixo", sem chat (API, para um agente externo)

Tudo que o Beniboy faz sai de rotas que já existem, autenticadas pelo login
normal (`POST /api/auth/login` → `token` → header `Authorization: Bearer`).
Um agente externo com **acesso próprio** pode usar direto:

| Ação | Rota | Observação |
|---|---|---|
| Criar tarefa / reunião | `POST /api/tarefas` | `ehReuniao`, `horaInicio`, `duracaoMin`, `linkOrigem` |
| Concluir | `POST /api/tarefas/:id/concluir` | exige `password` (a do próprio acesso, reautenticação) |
| Cancelar | `POST /api/tarefas/:id/cancelar` | `motivo` |
| Desbloquear | `POST /api/users/:id/desbloquear` | Master; QA Master → fila |
| Resetar senha | `POST /api/users/:id/reset-password` | Master; QA Master → fila |
| Criar copiando | `POST /api/users/criar-copiando` | `modeloId, email, username, senha`; QA Master → fila |
| Responder chat | `POST /api/suporte-chats/:id/responder` | `texto` |
| NOC | `POST /api/loja-status/manutencao/reiniciar` | `tarefa` + `alvos:[{codigo,posto}]`; exige `password`; QA Master → fila |
| Aprovar/rejeitar a fila | `POST /api/qa-aprovacoes/:id/aprovar` · `/rejeitar` | só Master de verdade |

A especificação externa recebida (12/09) pedia um `BOT_ACAO_TOKEN` global de
escrita e rotas novas. **Não foi implementada de propósito**: um token que
aprova e apaga sem sessão recria exatamente o risco que o app evitou (o robô
de cobranças "só cria, nunca decide"), e as entidades que ela descrevia
(fila genérica de "aprovações", formulário em rascunho, status `aberta`,
prioridade `média`) não existem no código. O caminho acima entrega o mesmo
resultado com o que já está pronto e auditado.
