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

1. **Sem porta pública. Sem DNS. Sem proxy reverso.** Acesso só pelo
   Tailscale.
2. **Bind explícito na interface do tailnet**, não em `0.0.0.0`. Em Docker:
   `-p 100.101.44.126:3000:3000` — e **não** `-p 3000:3000`. Com `0.0.0.0` o
   piloto aparece em `10.168.10.10:3000` para a LAN inteira.
3. **Não instalar como aplicativo da loja da Umbrel.** O empacotamento de
   app da Umbrel expõe o serviço na LAN por padrão, que é o oposto do item
   2. Container Docker simples, com o bind acima.
4. **O webhook da Adyen nunca aponta para o piloto.** É a pior configuração
   errada possível neste sistema: no minuto em que o webhook for redirecionado,
   o Monitor de produção para de receber transação. O webhook não se encosta
   neste documento.
5. **Nenhuma máquina de loja conhece o endereço do piloto.** Se um agente
   instalado pedisse a versão ao piloto e visse um número maior, ele baixaria
   o `.ps1` do piloto, se sobrescreveria e reiniciaria apontando para o
   piloto. Em 52 máquinas isso é reinstalação na mão. Tailscale-only já
   resolve — não crie exceção.

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
4. `npm run local` com o bind do item 5.2. Abrir pelo Tailscale e confirmar
   que `10.168.10.10:3000` **não** responde da LAN.
5. Só então as permissões do item 7.5 — o mínimo acordado, nada além.

Nada deste piloto chega perto do `Manual Deploy` do Render. São duas coisas
sem ligação.

---

## 9. A pergunta que precisa de número antes de instalar serviço

O objetivo declarado do piloto é **avaliar se a Umbrel reduz o custo do
NoPulso**. Antes de instalar qualquer coisa, vale olhar de onde o custo vem
hoje — porque boa parte dele a Umbrel não alcança.

| Custo hoje | A Umbrel reduz? |
|---|---|
| Render — `plan: free` no `render.yaml` | **Não.** Já é zero. Auto-hospedar troca zero por consumo de energia e por manutenção sua |
| Firestore — leitura por documento, medido em ~84 leituras/min depois das correções de 23/08 (vinha de ~1.500) | **Só substituindo o Firestore**, o que é migração de banco — exatamente o que está fora de escopo agora |
| Firebase Storage — snapshot do `store`, arquivo de pagamentos de 180 dias, PDFs | **Provavelmente sim.** É volume, é sequencial, não é sensível a latência |
| API da Anthropic — OCR e o Beniboy | **Não.** Modelo local num i5 sem GPU não entrega a qualidade que essas duas funções exigem |
| Gmail, Sheets | Não — já é zero |

Leitura disto: o trabalho de 23/08 já derrubou o custo do Firestore em ~18×.
O que sobra de conta significativa não é o que auto-hospedar resolve, com
**uma** exceção plausível.

### Candidato a primeiro piloto: só o Storage

Hipótese a ser **precificada pelo Codex**, não conclusão:

> Mover para a Umbrel apenas o conteúdo volumoso do Firebase Storage —
> snapshot do `store`, os JSONs de `pagamentos-arquivo/AAAA-MM-DD.json`, os
> PDFs gerados — mantendo o Firestore, o Render e todo o dado operacional
> exatamente onde estão.

Por que este é o candidato certo para começar:

- Não toca no Firestore, logo não toca na parte caríssima e delicada.
- É dado derivado ou histórico: se o piloto cair, nada da operação para.
- Não exige porta pública: o app no Render precisaria alcançar a Umbrel, o
  que é um problema de rede a ser **decidido pelo usuário**, não improvisado
  — e enquanto não for decidido, o piloto é só leitura local.
- Dá um número real para comparar, que é o objetivo do piloto.

O que falta para transformar isso em decisão: o Codex medir quanto o Storage
custa por mês hoje. Se for alguns reais, o piloto correto é **não migrar
nada** e usar a Umbrel para outra coisa — e descobrir isso antes de instalar
é o melhor resultado possível desta etapa.

### Onde a Umbrel provavelmente vale mais que em custo

Vale registrar, porque pode ser o verdadeiro valor dela: ambiente de teste
permanente. Hoje `npm run local` e o `varreduraVisual.js` rodam na sua
máquina. Na Umbrel, pelo Tailscale, viram um piloto sempre disponível —
sem custo de Firestore, sem risco de produção, e resolvendo o problema real
de não ter CI. Isso não reduz a fatura, mas é ganho concreto e **não exige
migrar dado nenhum**.
