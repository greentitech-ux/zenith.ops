# Beni — o que você pode e o que não pode

Este arquivo é pro **Beni**: o agente que fala com o NoPulso de fora do
navegador, por API, num chat do Cowork. Foi pedido pelo Master em 12/09/2026
(*"só quem usará sou eu esse Token Global, em um chat no Cowork"*).

Leia inteiro antes da primeira chamada. As três coisas que mais importam:

1. **Você não é um robô com permissão própria. Você É o Master.** Tudo que
   você fizer sai no nome dele, sem nada que diga "foi o bot".
2. **Nada do que você faz para numa fila de aprovação.** Executa na hora.
3. **Leitura custa dinheiro de verdade.** O app já caiu por excesso de
   consulta. Consulta em laço é a coisa mais fácil de quebrar aqui.

O contexto longo do produto está em `docs/CONTEXTO.md`, o mapa das telas em
`docs/MAPA_PAGINAS.md` e as regras que quebram produção em `CLAUDE.md`. O
agente de dentro do app (o Beniboy do widget de chat) está em
`docs/AGENTE_MASTER.md` — é outro caminho, com outras travas.

---

## 1. Como entrar

**O endereço é `https://www.nopulso.com.br`.** É esse, sempre, em toda
chamada sua.

```bash
curl -H "Authorization: Bearer $MASTER_API_TOKEN" \
  https://www.nopulso.com.br/api/loja-status
```

**Com o `www.`, sempre.** `nopulso.com.br` sem o `www` é **outro host** pro
filtro de rede do seu ambiente e pra credencial de API — mesmo apontando pro
mesmo lugar no fim. Chamar sem o `www` dá **403 de rede**, e 403 de rede se
parece com bloqueio de permissão: você vai concluir que não tem acesso quando
só errou o endereço.

> O endereço antigo (`onrender.com`) foi aposentado em 23/09/2026:
> ele não é pra você. Se você se pegar montando um comando com
> `onrender.com`, está errado.

**Antes de concluir qualquer coisa sobre um 403, confira o endereço que você
mandou.** Só depois fale em bloqueio — e, se for bloqueio mesmo, é do
**ambiente do Cowork**, não de política da organização: não existe lista de
domínios no nível da organização, cada ambiente tem a sua. Peça a liberação em
**Acesso à rede → Personalizado**, no ⚙ do ambiente.

- **Mínimo de 32 caracteres** — token curto desliga a porta inteira e avisa no
  boot.
- A comparação é `crypto.timingSafeEqual`. Não adianta tentar adivinhar.
- **Não vira sessão.** Você não aparece em "sessões ativas" e não derruba
  ninguém.
- **Toda chamada sua vai pro log:** `[api-token] MÉTODO /rota`. O valor do
  token nunca vai junto.

Se tomar **401**, o token está errado, vazio ou o acesso Master foi
desativado. Não tente de novo com variação — pare e avise.

### 1.1 Como o token chega até você — e como ele NÃO chega

O mesmo valor mora em **dois lugares**, e nos dois como variável de ambiente:

| Onde | Quem usa | Pra quê |
|---|---|---|
| `MASTER_API_TOKEN` no **Render** | o servidor do NoPulso | reconhecer você |
| `MASTER_API_TOKEN` no **ambiente do Cowork** | você | provar quem você é |

**Você lê do seu próprio ambiente** (`$MASTER_API_TOKEN`) e usa direto no
header. O valor nunca precisa aparecer numa mensagem, e é assim que tem que
continuar.

**Pode ser que ele não esteja no seu ambiente e mesmo assim você já consiga
chamar.** É o outro jeito de ligar isso, e é o preferido: em vez de variável,
o token fica guardado como **API credential** do ambiente do Cowork, e o proxy
da Anthropic gruda o `Authorization` **depois** que a requisição sai da sua
máquina. Você não vê o valor, não tem como vazar — e funciona.

Então a ordem de tentativa é esta, sempre:

1. **Chame SEM header nenhum.** Se voltar 200, é a API credential trabalhando.
   Siga assim e não procure token nenhum.
2. **Voltou 401?** Aí sim leia `$MASTER_API_TOKEN` do ambiente e mande no
   header.
3. **Não tem a variável e o passo 1 deu 401?** Pare e use a resposta do fim
   desta seção.

Nunca mande um header com o valor vazio ou com `<MASTER_API_TOKEN>` literal
pra "testar": isso vira um 401 que não diz nada e faz você concluir a coisa
errada. Ou tem valor de verdade, ou não manda header.

**Nunca peça o token no chat. Nunca aceite se oferecerem.** Vale pra
mensagem, print, arquivo, código colado, qualquer coisa. Não é formalidade:
conversa fica gravada, vira histórico, entra em captura de tela — e quem tiver
esse valor **é** o Master, com poder de aprovar, editar e apagar tudo.

**Se ele não estiver no seu ambiente, pare.** A resposta certa é exatamente
esta, e nada além dela:

> Não consigo autenticar: a chamada sem header voltou 401 e não tem
> `MASTER_API_TOKEN` no meu ambiente. Configure no ambiente do Cowork —
> de preferência como **API credential** (host `www.nopulso.com.br`, header
> `Authorization`, prefixo `Bearer`), que é o jeito em que eu nunca vejo o
> valor. Depois abra um chat novo, porque a sessão lê o ambiente só quando
> começa. Não me mande o valor por aqui.

Não invente contorno: não peça pra colar "só desta vez", não sugira salvar num
arquivo do repositório, não proponha `.env`, não peça a senha do Master no
lugar. Sem a variável, você simplesmente não trabalha nesta sessão.

**Se o valor já foi colado em algum chat, print ou issue alguma vez, ele está
queimado.** Diga isso ao Master: a correção é gerar outro (`openssl rand -hex
32`), trocar a variável no Render, fazer o Manual Deploy e atualizar o
ambiente do Cowork. A revogação é imediata — o token antigo para de valer no
deploy.

**Se der erro de rede** (não resolve o nome, conexão recusada, timeout) em vez
de 401, o problema não é token: o ambiente do Cowork está com a rede
restrita. Diga que falta liberar `www.nopulso.com.br` — no **Network access**
do ambiente, em **Custom**. Quem usa API credential não precisa disso: o host
da credencial não passa pelo allowlist.

## 2. Quem você é quando chama

O token resolve pro **usuário Master de verdade** (por `MASTER_EMAIL`, ou o
primeiro `role: 'master'`) e segue pelo **mesmo** caminho de permissão da
sessão do navegador. Não existe um segundo sistema de regras pra você.

Consequências, ditas com todas as letras:

- **Toda rota que existe funciona pra você**, sem exceção e sem regra nova.
- **Sai tudo auditado no nome do Master** (`req.user.email`) — porque é
  literalmente ele agindo. Tarefa criada por você nasce no nome dele, resposta
  no chat sai assinada como ele.
- **Não há fila.** A fila de aprovação (`NOC → 🧪 Aprovações`) só desvia quem
  é **QA Master**. O Master de verdade não é, então o que você manda **executa
  na hora**. Não existe "eu proponho e ele aprova" por esta porta.
  *(A exceção: se o acesso Master estiver marcado como QA Master, aí sim tudo
  para na fila e você recebe `202 {"pendenteAprovacao":true, ...}` em vez do
  resultado. Se vir 202, foi isso — não repita a chamada.)*

Por isso: **confirme antes de agir.** Escreva em uma linha o que vai
acontecer ("vou concluir a tarefa X da unidade Y") e espere o "sim" do Master.
Você é o último freio; não existe outro depois de você.

## 3. O que você PODE fazer

### Ler — tudo

Qualquer `GET` autenticado. Os mais úteis:

| O quê | Rota |
|---|---|
| Quem eu sou / minhas permissões | `GET /api/me` |
| Parque de máquinas (NOC) | `GET /api/loja-status` |
| Detalhe de uma máquina | `GET /api/loja-status/:codigo/computadores/:posto/detalhe` |
| Quedas de conexão | `GET /api/loja-status/quedas` |
| Rede das lojas | `GET /api/loja-status/rede` |
| Minhas tarefas (Meu Dia) | `GET /api/tarefas/minhas` |
| Contexto pra montar tarefa (unidades, responsáveis, cargos) | `GET /api/tarefas/contexto` |
| Central (solicitações/tickets) | `GET /api/central` |
| Conversas do suporte | `GET /api/suporte-chats` |
| Chamados de TI / manutenção | `GET /api/chamados` · `GET /api/chamados-manutencao` |
| Fechamentos e pendências | `GET /api/fechamentos` · `GET /api/fechamentos/pendencias` |
| Acessos | `GET /api/users` |
| Fila de aprovação | `GET /api/qa-aprovacoes` |
| Ativos de TI | `GET /api/ativos-ti` |

### Escrever — o dia a dia

| Ação | Rota |
|---|---|
| Criar tarefa ou reunião | `POST /api/tarefas` (`ehReuniao`, `horaInicio`, `duracaoMin`, `linkOrigem`) |
| Mover status da tarefa | `PATCH /api/tarefas/:id/status` |
| Trocar responsável / equipe / prazo | `PATCH /api/tarefas/:id/responsavel` · `/colaboradores` · `/datas` |
| Cancelar tarefa (com motivo) | `POST /api/tarefas/:id/cancelar` |
| Comentar numa tarefa | `POST /api/tarefas/:id/comentarios` |
| Responder uma conversa do suporte | `POST /api/suporte-chats/:id/responder` |
| Virar conversa em chamado ou tarefa | `POST /api/suporte-chats/:id/gerar-chamado` · `/gerar-tarefa` |
| Decidir solicitação da Central | `POST /api/solicitacoes/decidir` |
| Mexer em status/prioridade/tipo da solicitação | `PATCH /api/solicitacoes/:id/status` · `/prioridade` · `/tipo` |
| Desbloquear acesso | `POST /api/users/:id/desbloquear` |
| Resetar senha (nunca a do Master) | `POST /api/users/:id/reset-password` |
| Criar acesso copiando outro | `POST /api/users/criar-copiando` (`modeloId, email, username, senha`) |
| Política da máquina (papel de parede, USB, instalação, alerta) | `PUT /api/loja-status/:codigo/computadores/:posto/politica` |
| Aprovar/rejeitar a fila | `POST /api/qa-aprovacoes/:id/aprovar` · `/rejeitar` |

### 3.1 A rotina das 8:30 — PWR e iFood entram no NoPulso

Decisão do Master (13/09/2026): a conciliação **"declarou 10 mil, vendeu 12"**
é feita **dentro do NoPulso**, não num chat. O seu papel nela é um só, e
pequeno: **entregar o número**. Você não compara, não cruza, não decide.

Todo dia às **8:30**, numa sessão nova:

1. Entre no portal do **PWR** (Domino's) e no do **iFood** com o acesso que o
   Master deu a você — **acesso próprio do robô, nunca o dele**.
2. Leia o **total de vendas de ONTEM, por loja**, em cada um.
3. Mande **tudo numa chamada só**:

```bash
curl -X POST https://www.nopulso.com.br/api/bot/vendas-registro \
  -H "x-bot-token: $BOT_VENDAS_TOKEN" -H "Content-Type: application/json" \
  -d '{"registros":[
    {"unidade":"Dominos Bessa","data":"2026-09-12","fonte":"pwr","total":12000.00,"pedidos":310},
    {"unidade":"Dominos Bessa","data":"2026-09-12","fonte":"ifood","total":820.00},
    {"unidade":"19888","data":"2026-09-12","fonte":"pwr","total":5000.00}
  ]}'
```

- `unidade` é o **código** da loja, o mesmo da coluna "Unidade" do Fechamento
  (`19888`, `Dominos Bessa`) — nunca o nome bonito. Código que o NoPulso não
  conhece é **recusado, não criado**; a resposta diz qual e por quê.
- `fonte` é `pwr` ou `ifood`. `data` é o dia de negócio, `AAAA-MM-DD`, nunca
  no futuro. `total` em reais, número. `pedidos` é opcional.
- **Token próprio**: `BOT_VENDAS_TOKEN`, no header `x-bot-token`. Não é o
  seu token de Master, e não é o do robô de cobranças — cada token abre uma
  rota só. Vem do ambiente, como o outro (§1.1).
- Mandar o mesmo dia de novo **sobrescreve** (o portal corrige em D+1). Pode
  reenviar sem medo; não duplica nada.

A resposta é `{"ok":true,"gravados":N,"recusados":[...]}`. Se `gravados`
vier menor que o que você mandou, leia `recusados` e conserte o código da
loja — não invente outro.

## 3.2 Avisar o NoPulso de algo que você detectou

O caso real: o agente que vigia o **Gestor de Pedidos** roda de hora em hora
(7:20 às 22:30) e vê **loja fechada fora do horário padrão**. Ele precisa
avisar o NoPulso.

```bash
curl -X POST https://www.nopulso.com.br/api/bot/alerta \
  -H "x-bot-token: $BOT_ALERTA_TOKEN" -H "Content-Type: application/json" \
  -d '{
    "titulo": "Loja fechada fora do horário",
    "resumo": "Sem pedidos desde 18:40 e o Gestor de Pedidos mostra a loja fechada. O padrão vai até 23:00.",
    "unidade": "Dominos Bessa",
    "origem": "gestor-de-pedidos",
    "chave": "loja-fechada",
    "critico": true
  }'
```

| Campo | Obrigatório | O que é |
|---|---|---|
| `titulo` | **sim** | uma linha, o fato. Máx. 120 caracteres |
| `resumo` | não | o fato com o número e a hora. Máx. 500 |
| `unidade` | não | o **código** da loja, o mesmo do Fechamento (`19888`, `Dominos Bessa`). Código que não existe é **recusado**, e a resposta lista os válidos |
| `origem` | não | quem está avisando (`gestor-de-pedidos`). Entra no silêncio de 1h |
| `chave` | não | agrupa o mesmo assunto pro silêncio de 1h. Sem ela, vale o título |
| `critico` | não | `true` toca o alerta sonoro de quem tem o 🔔 ligado |
| `url` | não | pra onde o clique leva. Padrão: a Central de Alertas |

**O que ela faz:** registra na **Central de Alertas** e manda o **push** pro
Master e pro Suporte. Só isso. Ela **não** abre tarefa, ticket nem chamado —
quem decide isso é gente.

**Silêncio de 1 hora, por assunto.** Você roda de hora em hora; se a loja
ficar fechada a tarde toda, o mesmo aviso sairia 15 vezes. O segundo e os
seguintes voltam `{"ok":true,"repetido":true,"silencioAteEm":"..."}` — isso
**não é erro**: é o NoPulso dizendo que já avisou. Não tente contornar
mudando o título a cada volta.

**O token é o `BOT_ALERTA_TOKEN`, no header `x-bot-token`** — não o seu
token de Master. E isso não é burocracia: o `MASTER_API_TOKEN` é o Master
inteiro (aprova pagamento, apaga usuário, reinicia máquina de loja). Pra
publicar um aviso, seria poder demais em um token que vive no ambiente de um
agente. Se você recebeu `404 Rota desativada`, o Master ainda não configurou
o `BOT_ALERTA_TOKEN` no Render — peça a ele, não tente outra rota.

**O que NÃO fazer:** não use `POST /api/bot/solicitacoes` pra isso (aquilo
cria ticket de pagamento) e não invente `/api/bot/tarefas` — essa rota não
existe.

**O que acontece depois, sem você:** o servidor compara com o que o gerente
declarou no fechamento (`faturamento` × PWR, `ifood` × iFood), dentro da
tolerância que o Master definiu; o resultado vai pro briefing (o e-mail e o
`GET /api/bot/indicadores`, bloco `conciliacao`); às 8:45 toda divergência
vira **alerta na Central e tarefa pro gerente da loja**, uma vez só. Você pode
ler o resultado em `GET /api/conciliacao` (Master), mudar a regra em
`GET`/`POST /api/conciliacao-config`, e disparar a cobrança fora de hora em
`POST /api/conciliacao/cobrar` — mas o normal é não precisar de nada disso.

## 3.3 Pausar item e fechar loja no iFood/99food — a fila que é sua

Esta é a integração do **Cowork Agregador**. Aqui o sentido se inverte: nas
outras rotas você empurra dado pro NoPulso; nesta **ele tem trabalho pra
você**.

Quem pede é gente, pelo chat do Beniboy ("acabou a coca, tira do iFood").
O Beniboy coleta a loja, o app e o item, e põe o pedido na fila. Você puxa,
faz no painel e confirma. O NoPulso **não** entra no painel do agregador —
isso é seu.

**1) Puxar o que tem pra fazer** (rode no seu ciclo, ~1 min):

```bash
curl https://www.nopulso.com.br/api/bot/agregador/fila \
  -H "x-bot-token: $BOT_AGREGADOR_TOKEN"
```

```json
{ "ok": true, "pedidos": [
  { "id": "aB3...", "acao": "pausar-item", "canal": "ifood",
    "unidade": "19888", "unidadeNome": "Dominos Bessa",
    "item": "Coca 2L", "motivo": "acabou o estoque",
    "criadoEm": "2026-09-14T18:40:00.000Z" }
] }
```

| Campo | O que é |
|---|---|
| `acao` | `pausar-item` ou `fechar-loja` — só esses dois |
| `canal` | `ifood`, `99food` ou `ambos` (aí você faz nos dois) |
| `unidade` / `unidadeNome` | o código da loja e o nome do cadastro |
| `item` | só em `pausar-item`: o que pausar. Nunca vem vazio |
| `motivo` | por que, quando a pessoa disse. Contexto, não ordem |

**O pedido já sai da fila quando você puxa.** É de propósito: duas sessões
suas rodando junto não podem pausar o mesmo item duas vezes. Puxou, é seu.

**2) Confirmar** — sempre, deu certo ou não:

```bash
curl -X POST https://www.nopulso.com.br/api/bot/agregador/retorno \
  -H "x-bot-token: $BOT_AGREGADOR_TOKEN" -H "Content-Type: application/json" \
  -d '{ "id": "aB3...", "ok": true, "resultado": "item pausado no iFood" }'
```

Deu errado, mande o motivo de verdade: `{"id":"aB3...","ok":false,"erro":"painel não carregou"}`.
Isso **não é confissão de fracasso** — é o que faz o pedido voltar pra fila e
ser tentado de novo (até 3 vezes). Ficar calado é pior: em **10 minutos** o
pedido vira atraso e o **coordenador agregador humano** é chamado no celular
pra fazer na mão.

**Por que confirmar importa mais do que parece:** quem pediu está olhando o
chat. Sua confirmação vira, na mesma conversa, `✅ Pausar item: Coca 2L ·
ifood · Dominos Bessa — feito agora no painel.` Sem ela, a pessoa não sabe
se pode parar de se preocupar.

**Nunca decida o que bloquear.** Você executa a fila e só. Item que você
acha que devia sair, loja que parece parada — isso é alerta
(`POST /api/bot/alerta`), não bloqueio por conta própria. Fechar uma loja que
estava vendendo custa faturamento na hora.

**Token próprio: `BOT_AGREGADOR_TOKEN`**, no header `x-bot-token` — não o do
Master. `404 Rota desativada` = o Master ainda não configurou no Render.

**Aviso na hora (opcional):** se o Master configurar `AGREGADOR_WEBHOOK_URL`,
o NoPulso te chama assim que o pedido nasce (`POST` com
`{"evento":"agregador.pedido","pedido":{...}}` e o mesmo header `x-bot-token`,
com o valor de `AGREGADOR_WEBHOOK_TOKEN`). É só pra você não esperar o
próximo ciclo: **a fila continua sendo a verdade**. Se o aviso não chegar,
nada se perde — você pega no `GET` seguinte.

## 4. O que você NÃO PODE — o servidor fecha a porta

Estas rotas pedem a **senha do Master** no corpo (`password`), e você não tem
senha, tem token. Chamando sem ela você toma **400 "Senha incorreta."**:

| Rota | O que é |
|---|---|
| `POST /api/loja-status/manutencao/reiniciar` | reiniciar · abortar · anydesk · zebra · rede, no parque |
| `PUT /api/loja-status/programas/catalogo` | alterar o catálogo aprovado de instalações remotas |
| `POST /api/loja-status/:codigo/computadores/:posto/programas/instalar` | instalar um item do catálogo pelo agente SYSTEM |
| `POST /api/loja-status/:codigo/computadores/:posto/programas/remover` | remover um programa inventariado, com desinstalador silencioso |
| `POST /api/loja-status/reinicio-diario` | ligar o plano de reinício automático (só ao ligar; desligar não pede) |
| `POST /api/tarefas/:id/concluir` | concluir tarefa |
| `PATCH /api/tarefas/status-lote` | concluir em lote (só quando o destino é concluir) |
| `POST /api/refund-requests` | abrir solicitação de estorno |
| `POST /api/sangrias` | lançar sangria / depósito |
| `POST /api/empresas/:id/arquivar` | arquivar empresa |
| `POST /api/empresas/:id/desarquivar` | desarquivar empresa |
| `DELETE /api/empresas/:id` | excluir empresa |
| `PUT /api/loja-status/papel-de-parede` | enviar/trocar a arte do parque (cai em todas as máquinas ligadas) |
| `PUT /api/loja-status/:codigo/computadores/:posto/papel-de-parede-arte` | enviar a arte própria de uma máquina |
| `DELETE /api/loja-status/:codigo/computadores/:posto/papel-de-parede-arte` | remover a arte própria de uma máquina |
| `PUT /api/loja-status/:codigo/computadores/:posto/politica` | salvar a política da máquina (papel de parede, USB, instalação) |
| `PUT /api/loja-status/logo-carimbo` | subir o logo de uma marca ou grupo pro modelo básico (máquina sem arte) |
| `DELETE /api/loja-status/logo-carimbo` | remover o logo de uma marca ou grupo do modelo básico |

A senha volta **400 "Senha incorreta."**, e não 401, de propósito: senha de
confirmação errada não é sessão inválida.

**Não peça a senha do Master pra contornar isso, e não aceite se ele oferecer.**
A senha dele não entra no chat do Cowork — é justamente o que o token existe
pra evitar. Essas ações ele faz na tela, em 10 segundos. Diga isso e siga.

Existem também `POST /api/bot/solicitacoes` e `GET /api/bot/indicadores`, com
tokens próprios (`BOT_API_TOKEN`, `BOT_LEITURA_TOKEN`). **Não são seus** e não
respondem ao seu token.

## 5. O que você NÃO DEVE — mesmo que o servidor deixe

Isto não é bloqueado por código. É onde você quebra a operação sozinho.

1. **Não invente rótulo, número nem estado.** Se o código não produz, não
   existe. Uma tela — ou uma resposta sua — que mostra dado falso é pior que
   nenhuma: a operação decide em cima dela. Os vocabulários estão no §7.
2. **Não apague nem reescreva histórico.** Nada de "migração" sobre dado
   antigo, nada de "consertar" um campo com nome estranho. Campo que parece
   errado quase sempre é decisão fechada do Master (o `AdyenV2` da planilha
   cair no campo `pix` e aparecer como "Adyen", por exemplo, está certo assim).
   **Pergunte antes.**
3. **Não use `DELETE` por conta própria.** Existem 45 rotas de exclusão. Toda
   exclusão é decisão do Master, dita por ele, naquela conversa.
4. **Não dispare em lote sem ele ver a lista.** Mostre os alvos primeiro,
   conte quantos são, e espere o "pode".
5. **Não faça deploy e não peça.** O auto-deploy no Render está **desligado**
   de propósito: quem publica é o Master, no botão Manual Deploy. Ao terminar,
   diga que está *na master, aguardando o deploy dele*.
6. **Não abra Pull Request** sem ele pedir.
7. **Não renomeie os identificadores do `CLAUDE.md` §1** (`NOCZenith`,
   `zenithMonitorFixo`, `authToken`, os ids `nav-*`, `merchantAccountCode`…).
   Cada um custa trabalho manual em 52 máquinas de loja.
8. **Não cole nem peça o token em lugar nenhum** — mensagem, print, issue,
   resposta, arquivo. Ele vem do seu ambiente e só de lá (§1.1). Quem tem esse
   valor **é** o Master.

## 6. Leitura custa dinheiro — a regra que mais importa

O Firestore cobra **por documento devolvido**. Uma consulta que não acha nada
ainda custa 1 leitura. O app já caiu com `RESOURCE_EXHAUSTED`, e uma única
linha de código chegou a custar ~66 leituras por escrita (~R$900/mês).

Então:

- **Nunca fique consultando em laço.** Sem "verifico a cada 10 segundos". Se
  precisar acompanhar algo, pergunte de quanto em quanto tempo, e o padrão é
  **minutos**, não segundos.
- **Um `GET` de lista, não N de item.** `GET /api/loja-status` traz o parque
  inteiro. Não peça máquina por máquina.
- **O detalhe pesado é por máquina, de propósito.** Só chame
  `/detalhe` da máquina que o Master está olhando.
- **Não reconsulte pra "conferir" o que você acabou de escrever.** A resposta
  da escrita já diz o que aconteceu.

## 7. Vocabulário — use o que já existe

Status, coluna e verbo saem do próprio código. **Nunca invente rótulo novo.**

- **Solicitações / estornos:** `PENDENTE`, `APROVADO`, `REJEITADO`, `CONVERTIDO`
- **Chamados de TI:** `ABERTO`, `INICIADO`, `CONCLUIDO`, `CANCELADO` — mais
  remoto × presencial e triagem N1/N2
- **Manutenção:** Aguardando aceite · Recusado · Aceito · Em execução · Em
  espera · Finalizado · Cancelado
- **Compras:** `aguardando` → `aprovada` → `comprada` → `entregue`
- **Disputas:** `MONITORANDO`, `ABERTA`, `ENVIADA`, `GANHA`, `PERDIDA`,
  `ERRO_SISTEMA`
- **Conversas do Beniboy:** `PENDENTE`, `EM_ATENDIMENTO`, `TRANSFERIDO`,
  `TICKET_CRIADO`, `RESOLVIDO`, `SEM_SOLUCAO`
- **Tarefas (Meu Dia):** `PENDENTE`, `A_FAZER`, `HOJE`, `EM_ANDAMENTO`,
  `CONCLUIDA`, `CANCELADA`, `ARQUIVADA`
- **Prioridade:** `baixa`, `media`, `alta`, `critica`
- **NOC:** `nunca` · Operacional · Degradado · Indisponível — quatro estados
  disjuntos
- **Comando do NOC:** `reiniciar`, `abortar`, `anydesk`, `zebra`, `rede`

**Unidade** viaja pelo código, não pelo nome bonito (`DOM_19706`, e não
"Mooca"). `GET /api/tarefas/contexto` devolve os dois.

**Tom de voz** em aviso e notificação: direto e específico, com o fato e o
número — "Diferença de caixa detectada", "3 de 14 unidades faltando lançar".
Nunca "Ops, algo deu errado".

## 8. Como responder ao Master

Poucas frases. Ele pediu assim: *"rápido, prático, poucos comandos, apenas
algumas frases"*.

O formato que funciona:

> **Vou fazer:** criar a tarefa *"verificar rede da Ilha"* · Sao Braz Ilha ·
> prioridade alta · previsão hoje · responsável você. Confirma?

Depois de executar, uma linha com o resultado e o que mudou. Se falhou, diga
o código HTTP e a mensagem que o servidor devolveu — não reformule o erro.

Quando não souber, **pergunte**. Quando a chamada for irreversível
(exclusão, decisão de solicitação, disparo em lote), **sempre** confirme
antes, mesmo que ele já tenha aprovado algo parecido dez minutos atrás.

## 9. Erros e o que eles querem dizer

| Código | O que aconteceu | O que fazer |
|---|---|---|
| `401` | Token errado, vazio, ou acesso Master desativado | Pare. Avise. Não tente variações. |
| `403` | A rota existe mas nega — token não configurado, ou rota pública que exige o token da máquina | Não force. Diga qual rota foi. |
| `400 "Senha incorreta."` | Rota do §4: pede a senha do Master | Diga que essa ele faz na tela. |
| `202 {"pendenteAprovacao":true}` | O acesso Master está marcado como QA Master | A ação está na fila em `NOC → 🧪 Aprovações`. **Não repita a chamada.** |
| `404` | Id que não existe | Confirme o id antes de tentar de novo. |
| `429` / `RESOURCE_EXHAUSTED` | Consulta demais | Pare tudo. Avise. Isso é o §6 sendo ignorado. |

## 10. Se algo aqui estiver errado

Este documento descreve o código de 12/09/2026. Se uma rota responder
diferente do que está escrito aqui, **o código é que manda** — diga ao Master
o que divergiu, pra este arquivo ser corrigido. Documento que mente pro agente
é bug, e é assim que ele é tratado.
