# Conectar a sala de reunião ao Google Workspace

Ao escolher **Criar no Google Meet**, o NoPulso cria um evento na agenda da
empresa com **sala do Google Meet** e convida os participantes: o compromisso
cai no calendário deles.

> **Sem fallback.** Se o Workspace não estiver configurado, ou a chamada ao
> Google falhar (rede, cota ou delegação), a reunião não é criada. Isso garante
> que todo link gerado pelo NoPulso seja um `meet.google.com` da empresa, e
> evita avisar uma equipe sobre uma sala alternativa sem agenda.

---

## O que o NoPulso já tem

Nada de segredo novo. A credencial é a **mesma conta de serviço do Firestore**
(`FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY`), a mesma que já lê as
planilhas. O que muda por serviço é o **escopo** — e, no caso do Workspace, a
**pessoa que a conta de serviço representa**.

Conta de serviço **não tem agenda própria** e, sozinha, **não cria sala do
Meet**. Pra criar a sala ela precisa agir **em nome de** alguém do Workspace.
Isso o dono do domínio autoriza uma vez, no Admin Console.

---

## Passo 1 — habilitar a API (Google Cloud)

No projeto do Google Cloud onde vive a conta de serviço:

1. **APIs e serviços → Biblioteca**
2. Habilite **Google Calendar API**

(A Google Sheets API já está habilitada aí — é o mesmo projeto.)

## Passo 2 — pegar o Client ID da conta de serviço

1. **IAM e administrador → Contas de serviço**
2. Abra a conta cujo e-mail está em `FIREBASE_CLIENT_EMAIL`
3. Copie o **ID exclusivo / Unique ID** (um número longo, ~21 dígitos)

## Passo 3 — autorizar a delegação (Admin Console)

Em `admin.google.com`, com a conta de administrador do domínio
(`admin@solutionstitech.com`):

1. **Segurança → Controle de acesso e dados → Controles de API**
2. **Gerenciar delegação em todo o domínio → Adicionar novo**
3. **ID do cliente**: o número do passo 2
4. **Escopos OAuth**, exatamente isto:

```
https://www.googleapis.com/auth/calendar.events
```

5. **Autorizar**

> Só esse escopo. Ele permite criar e apagar **eventos** — não dá acesso a
> e-mail, arquivos, nem ao resto da agenda da empresa.

## Passo 4 — as variáveis no Render

| Variável | Valor | Obrigatória |
|---|---|---|
| `GOOGLE_MEET_USUARIO` | o e-mail do Workspace que a conta de serviço representa (ex.: `admin@solutionstitech.com`) | **sim** — é o que liga a integração |
| `GOOGLE_MEET_AGENDA` | id da agenda onde o evento nasce. Em branco = a agenda da própria pessoa (`primary`) | não |
| `GOOGLE_MEET_FUSO` | em branco = `America/Sao_Paulo` | não |

> Mudar variável de ambiente no Render **dispara deploy sozinho** — diferente
> do push, que espera o seu Manual Deploy.

---

## Como saber que funcionou

Crie uma reunião com "Gerar link automaticamente". O bloco da reunião deve
mostrar:

- **📹 Reunião · Google Meet** no topo (em vez de só "Reunião")
- um link `https://meet.google.com/...` (em vez de `meet.jit.si`)
- o aviso "O compromisso foi pra agenda de quem participa"

Se a criação falhar, a própria tela mostra a resposta do Google. Os dois erros
comuns são:

| No log | O que falta |
|---|---|
| `unauthorized_client` | o passo 3 — a delegação não foi autorizada, ou o escopo está diferente |
| `Calendar API has not been used` | o passo 1 |

---

## O que o NoPulso faz na agenda

| Quando | O que acontece |
|---|---|
| Reunião criada | evento com sala do Meet, participantes convidados (`sendUpdates=all`) |
| Reunião **cancelada** no NoPulso | o evento é apagado da agenda de todo mundo |
| Reunião **vira tarefa** | o evento é apagado — não vai mais acontecer como reunião |

O link da sala **não sai em PDF nem em relatório**:
quem tem o link entra, então ele é credencial.
