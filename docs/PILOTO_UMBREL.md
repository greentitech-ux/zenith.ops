# Piloto do NoPulso na Umbrel — requisitos da integração

Documento de **alinhamento**, para ser lido pelo Codex antes de instalar
qualquer serviço na Umbrel. Nada aqui foi executado: é o acordo que precisa
existir primeiro.

Produção não é tocada por nenhum passo deste documento.

- Umbrel: `10.168.10.10` · i5-10500T · 16,5 GB RAM · SSD 1 TB
- Tailscale: `100.101.44.126`
- Backup: HD USB WDC 1 TB, pasta `Backup-Umbrel`, cifrado, de hora em hora
- Dado do NoPulso migrado até agora: **nenhum** — e o piloto mantém assim

---

## 1. O que o piloto é, e o que ele não é

**É** uma cópia do app inteiro — as mesmas 59 telas, o mesmo login, as
mesmas permissões — rodando contra um banco de mentira que vive na memória
do processo.

**Não é** uma segunda produção. Não recebe webhook, não manda e-mail, não
manda push, não serve agente, não fala com a Adyen, não fala com o
Firestore. Se qualquer uma dessas coisas acontecer, o piloto deixou de ser
piloto e virou risco.

---

## 2. Três portões antes de instalar qualquer coisa

### Portão 1 — a restauração do backup não foi testada

Restaurar pasta vazia testa o encanamento, não o backup. Um backup só está
testado quando conteúdo real voltou **íntegro**, em **outro caminho**, e foi
conferido byte a byte.

```bash
# 1. impressão digital da origem
cd <pasta_de_origem> && find . -type f -print0 | sort -z \
  | xargs -0 sha256sum > /tmp/origem.sha
wc -l /tmp/origem.sha        # anote a contagem de arquivos

# 2. restaure Backup-Umbrel para /tmp/restore-teste pelo FLUXO DE
#    RESTAURAÇÃO do Umbrel — não por cp do HD. O que está sob teste é o
#    fluxo, não o disco.

# 3. confira
cd /tmp/restore-teste && sha256sum -c /tmp/origem.sha
```

Passou = **zero** linha `FAILED` e a mesma contagem de arquivos. Qualquer
outra coisa é backup não testado.

**Risco separado, e é o que mais mata:** o backup é cifrado. Onde está a
chave/senha? Se a resposta for "na Umbrel", o backup não existe — o cenário
em que você precisa dele é justamente o cenário em que a Umbrel se foi.
A chave precisa estar guardada **fora** da Umbrel e **fora** do HD USB,
antes do piloto.

### Portão 2 — os agentes do MCP estão aguardando conexão e sem permissão

Isso hoje é um bloqueio, mas **está do lado certo**. Agente sem permissão
sobre aplicativo, pasta e máquina é exatamente o estado em que ele deve
ficar até o item 7 estar acordado. Não conceda nada "pra destravar e ver se
funciona": a máquina que receberia a permissão é a mesma que segura o HD de
backup.

### Portão 3 — o alinhamento do item 7 com o Codex

Enquanto as cinco perguntas do item 7 não tiverem resposta, instalar serviço
é adivinhar.

---

## 3. A forma certa do piloto: `npm run local`

O repositório já tem o piloto pronto, e ele foi construído para não ter
caminho até produção:

```bash
cd server
npm install
npm run local        # http://localhost:3000 — master@local / local123
```

O `local.js` intercepta o módulo do Firestore **antes** do app carregar e
devolve um banco em memória. Não há credencial configurada, então não existe
rota até o banco real nem por acidente. Já sobe com cenário de exemplo: 6
unidades, 18 computadores no NOC (alguns caídos de propósito), fechamentos
do dia, solicitações. Fechou, os dados somem; subiu de novo, volta o mesmo
ponto de partida.

Isto atende sozinho a três das suas restrições: **não altera produção**,
**não precisa de credencial do Firebase** e **não gera leitura cobrada**.

### Requisitos de máquina

| Item | Exigência | Umbrel |
|---|---|---|
| Node | `>= 22` (`engines` do `package.json`) | container `node:22` |
| App em si | ~37 MB de repo, um processo Node | folgado |
| Suíte `testeRotas.js` | só `JWT_SECRET` e `ENCRYPTION_KEY` descartáveis | folgado |
| Emulador do Firestore (nível 2) | Java, ~1–2 GB | folgado |
| `varreduraVisual.js` | Playwright + Chromium, ~1 GB durante a corrida | folgado |

O gargalo do piloto não é CPU nem RAM — é disciplina de isolamento.

### Dois níveis

- **Nível 1 — banco de mentira (`npm run local`).** É onde o piloto começa e
  provavelmente onde ele fica. Não reproduz índice composto, regra de
  segurança nem transação de verdade.
- **Nível 2 — emulador oficial do Firestore.** Só se o piloto precisar
  testar índice/transação/regra. `FIRESTORE_EMULATOR_HOST=localhost:8080` +
  `npm run emulador`. Continua sem leitura cobrada e **continua sem
  credencial de produção**.

Nunca existe nível 3. Piloto apontado para o Firestore real está fora de
escopo e fora deste documento.

---

## 4. Variáveis de ambiente: as que entram e as que não podem entrar

O app lê cerca de 100 variáveis. O piloto precisa de **cinco**, todas com
valor descartável, geradas na hora:

```
PORT=3000
JWT_SECRET=<aleatório descartável>
ENCRYPTION_KEY=<32 bytes hex aleatórios>
MASTER_EMAIL=<e-mail de teste>
MASTER_PASSWORD=<senha de teste>
APP_BASE_URL=http://100.101.44.126:3000
```

`ENCRYPTION_KEY` do piloto:
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

### Ausentes de propósito — e precisa ser ausência, não valor falso

`FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`,
`FIREBASE_STORAGE_BUCKET`, todas as `ADYEN_*`, `GMAIL_*`, `VAPID_*`,
`SHEET_ID_*`, `BOT_*_TOKEN`, `MASTER_API_TOKEN`, `NOPULSO_AGENT_API_TOKEN`,
`AGREGADOR_WEBHOOK_*`, `ANTHROPIC_API_KEY`, `RELATORIO_EMAIL_*`.

Ausência é o estado seguro: o `local.js` já troca o Firestore, e sem as
outras chaves cada integração externa simplesmente não liga.

### A armadilha do `APP_BASE_URL`

`APP_BASE_URL` tem **fallback para `www.nopulso.com.br`**. Se o piloto subir
sem ela definida e gerar um link, um QR, um e-mail ou um `.ps1` de agente,
esse artefato aponta para **produção**. Defina explicitamente para o
endereço do piloto. Esta é a variável mais importante do arquivo.

---

## 5. As cinco travas de isolamento

1. **Sem porta pública. Sem DNS. Sem proxy reverso.**
2. **Política de rede (proposta, aguardando aprovação): acesso somente pelo
   IP Tailscale `100.101.44.126`; LAN bloqueada.** O que se exige é um
   *resultado*, não um método: do lado da LAN, `10.168.10.10:<porta>` não
   pode responder. Duas camadas, porque nenhuma sozinha garante:
   - **Bind** na interface do tailnet. Em Docker: `-p 100.101.44.126:3000:3000`,
     e não `-p 3000:3000` (que escuta em `0.0.0.0` e aparece na LAN).
   - **Firewall do host** negando a LAN para essa porta. Quem desenha a
     regra é o Codex; **eu não verifiquei o firewall nem o estado real da
     rede** — o texto acima é critério de aceitação, não constatação.
   Aprovada a política, a verificação é externa: de **um aparelho da LAN
   que não esteja no tailnet**, a porta tem que recusar; de **um aparelho no
   tailnet**, tem que responder. Teste só de dentro da Umbrel não prova nada.
3. **Não instalar como aplicativo da loja da Umbrel** — presumivelmente
   expõe o serviço na LAN, o que contradiria o item 2. *Isso é inferência
   minha sobre o comportamento do umbrelOS 2.0, não verificado; o Codex
   confirma no painel/compose antes de depender dela.*
4. **O webhook da Adyen nunca aponta para o piloto.** É a pior configuração
   errada possível neste sistema: no minuto em que o webhook for redirecionado,
   o Monitor de produção para de receber transação. O webhook não se encosta
   neste documento.
5. **Nenhuma máquina de loja conhece o endereço do piloto.** Se um agente
   instalado pedisse a versão ao piloto e visse um número maior, ele baixaria
   o `.ps1` do piloto, se sobrescreveria e reiniciaria apontando para o
   piloto. Em 52 máquinas isso é reinstalação na mão. A política de rede do item 2
   é o que protege contra isso — não crie exceção.

---

## 6. Backup: o que o piloto muda nele

O piloto não produz dado de operação. O que ele acrescenta ao
`Backup-Umbrel` é configuração: `docker-compose`, o arquivo de variáveis do
piloto e, se existir, o volume do emulador.

Duas consequências:

- O arquivo de variáveis do piloto **entra no backup**. Como ele só tem
  segredo descartável, isso é inofensivo — e é mais um motivo para nunca
  colocar credencial de produção nele.
- O backup de hora em hora não precisa ser ampliado para o piloto. O piloto
  é reproduzível a partir do repositório; ele não é dado, é ambiente.

---

## 7. Pauta de alinhamento com o Codex

Cinco perguntas. Instalar serviço antes de respondê-las é trabalho a ser
desfeito.

1. **A integração precisa de entrada de fora do tailnet?** Se a resposta for
   sim, o pedido entra em conflito com "sem portas públicas" e a conversa
   volta para você antes de qualquer configuração. Não há meio-termo a ser
   improvisado aqui.
2. **Qual é a direção do dado?** O Codex espera *ler dado de produção* do
   NoPulso, ou só operar sobre o cenário de mentira do piloto? Se a resposta
   envolve produção, o piloto não é o lugar — e o acesso a produção é uma
   decisão sua, separada, não um detalhe de instalação.
3. **O servidor MCP roda na própria Umbrel ou fora dela, e em qual
   transporte** (stdio, SSE, HTTP)? Isso define se existe porta, em qual
   interface ela escuta, e se o item 5.2 se aplica a ela também.
4. **Com qual identidade o agente se autentica no app do piloto?** Precisa
   ser um usuário de teste do próprio piloto. **Não** o `MASTER_API_TOKEN`,
   **não** o `NOPULSO_AGENT_API_TOKEN`, e nenhum token que exista em
   produção.
5. **Qual é o escopo mínimo de permissão que a integração realmente exige?**
   A pergunta certa não é "o que destrava os agentes", é "qual é o menor
   conjunto que faz o caso de uso funcionar". Proposta de ponto de partida,
   a ser contestada com caso de uso concreto:

   | Escopo | Piloto |
   |---|---|
   | Pastas | leitura, numa pasta só, a do piloto |
   | Aplicativos | nenhum controle (sem start/stop/instalar) |
   | Máquinas | nenhum |
   | HD de backup | nenhum acesso, em nenhuma hipótese |

   O HD de backup fora do alcance do agente não é excesso de zelo: é a
   propriedade que faz o backup continuar sendo backup.

---

## 8. Ordem de execução, depois do alinhamento

1. Portão 1 — restauração com conteúdo real conferida por `sha256sum`, e a
   chave de cifra guardada fora da Umbrel.
2. Item 7 respondido pelo Codex.
3. Container `node:22`, repositório clonado, `npm install`, `npm run teste`
   passando.
4. `npm run local` com o bind do item 5.2. Confirmar, de aparelhos reais,
   que responde pelo Tailscale e que `10.168.10.10:3000` **não** responde da
   LAN. Só depois da aprovação da política de rede.
   **Este passo só acontece depois de decidido que haverá piloto.**
5. Só então as permissões do item 7.5 — o mínimo acordado, nada além.

Nada deste piloto chega perto do `Manual Deploy` do Render. São duas coisas
sem ligação.

---

## 9. Custo: o que está comprovado e o que não está

**Estado: nenhuma instalação por enquanto.** A pergunta "a Umbrel reduz
custo?" será respondida pelo Codex, com código e métricas atuais. Esta seção
só separa o que tem prova do que não tem.

### Dados de outubro (informados pelo usuário; não os vi, não os verifiquei)

- O principal custo comprovado é **transferência de dados do Firestore**.
- **Cloud Storage apareceu zerado** no relatório fornecido.

### O que *não* conta como evidência da situação atual

- A queda de ~1.500 para ~84 leituras/min, de 23/08, é medição **de agosto**,
  em **leituras**. Não diz nada sobre transferência de saída em outubro, e
  uma coisa não implica a outra.
- `plan: free` no `render.yaml` é o que está **no repositório**, não o que
  está contratado hoje. Não prova o plano real do serviço.

Uma versão anterior deste documento tratava essas duas coisas como prova de
que o Render custava zero e de que o Firestore já estava resolvido. Estava
errada: não eram verificação, eram leitura do arquivo e de um registro
antigo.

### Consequência para o desenho do piloto

A hipótese anterior ("mover só o Storage") **cai**: se o Storage está zerado,
não há o que economizar ali. O candidato óbvio agora seria o que gera
transferência no Firestore — mas isso significa tocar o banco de produção,
que é o que o piloto não pode fazer e o que o usuário ainda não autorizou
sequer a *discutir* como migração.

Então, nesta etapa, o que existe é uma lista de perguntas, não de respostas:

| Pergunta | Quem responde |
|---|---|
| Qual coleção/rota gera a transferência? (`/api/debug/leituras` do app dá leitura por rota; transferência é outra grandeza e vem do console do Firebase) | Codex |
| Dá para reduzir **sem migrar nada** — cache, `Cache-Control`, compressão, payload menor? | Codex |
| Se só migrar resolve, qual parte, e o que acontece com o NoPulso se a Umbrel cair? | Codex, com decisão do usuário |
| Qual é o plano real do Render hoje? | usuário, pelo painel |

Registro de uma observação de código para o Codex avaliar, **sem tê-la
medido**: o app serve as telas e usa SSE, e `compression` já está nas
dependências do servidor. Se a transferência medida no Firestore for de
*dados lidos*, ela vem das leituras, não do tráfego HTTP do Render — e aí a
alavanca é ler menos documento ou menor, não hospedar em outro lugar.

### Onde a Umbrel pode valer algo independente do custo

Ambiente de teste permanente: `npm run local` e o `varreduraVisual.js`,
acessíveis pelo Tailscale, sem Firestore e sem risco de produção — o que
atenuaria a falta de CI. Não reduz fatura, e é **hipótese**: só vale se
alguém realmente for usá-lo, e continua condicionado a haver piloto.
