# Como mexer no Zenith sem gastar (e sem quebrar a operação)

## Por que todo deploy custa dinheiro

Toda vez que o Render sobe uma versão nova, o processo Node **começa do
zero**. E "do zero" quer dizer: nenhum cache em memória, nenhum espelho de
dados carregado, nada. Aí o servidor precisa reconstruir tudo lendo o
Firestore — e o Firestore cobra **por documento lido**.

Um boot custava, medido em 23/08/2026, **cerca de 5 mil leituras**:

| O que o boot fazia | Custo |
|---|---|
| `store.init()` — carrega as transações da Adyen | variável (usa snapshot no Storage quando existe) |
| Pré-aquecimento de 8 coleções inteiras | ~5 mil leituras |
| Espelho do NOC (todos os computadores) | 1 por computador |

O pré-aquecimento existia por um motivo legítimo: sem ele, a primeira
pessoa que abrisse o app depois do deploy esperava a leitura acontecer na
frente dela. O problema é que ele pagava esse preço **em toda subida**,
inclusive de madrugada e fim de semana, quando ninguém ia abrir nada.

No dia 23/08 foram **33 eventos de deploy**. Isso é ~165 mil leituras só de
subir versão — e aparecia no gráfico do Firebase como um pico afiado a cada
deploy, com o piso no chão entre eles.

**O que mudou:** o pré-aquecimento agora é opcional (`PRE_AQUECER_CACHES=1`
religa) e o **auto-deploy está desligado**. Cada subida passou a ser uma
decisão sua, não uma consequência automática de um `git push`.

---

## O ambiente local (é aqui que você testa agora)

```bash
cd server
npm install        # só na primeira vez
npm run local
```

Abre **http://localhost:3000** e entra com:

- usuário: `master@local`
- senha: `local123`

É o Zenith **inteiro**: as mesmas telas, as mesmas rotas, o mesmo login, as
mesmas permissões. A única diferença é que o banco vive na memória do seu
computador.

**Não tem como tocar em produção por acidente.** O `local.js` intercepta o
módulo do Firestore antes do app carregar e devolve um banco de mentira.
Não há credencial configurada, então não existe caminho até o banco real.

Já vem com um cenário de exemplo: 6 unidades, 18 computadores no NOC (com
algumas caídas de propósito, pra você ver os alarmes), fechamentos do dia e
algumas solicitações. Fechou o terminal, os dados somem; rodou de novo,
volta o mesmo cenário. É de propósito — você começa sempre do mesmo ponto e
pode quebrar o que quiser.

### Quando o banco de mentira não basta

Ele é uma imitação. Não reproduz índice composto, regra de segurança nem
transação de verdade. Se a mudança mexe nisso, use o **emulador oficial do
Firestore**, que é o Firestore de verdade rodando na sua máquina:

```bash
npm install -g firebase-tools     # uma vez
firebase login                    # uma vez
npm run emulador                  # terminal 1

# terminal 2
export FIRESTORE_EMULATOR_HOST=localhost:8080
npm start
```

Também não gera nenhuma leitura cobrada. Precisa de Java instalado.

---

## A suíte de testes

```bash
cd server && npm run teste
```

Sobe o `index.js` de verdade contra o banco falso e bate em ~90 cenários
reais. **Roda antes de qualquer deploy.** Se ela falhar, não sobe.

---

## Como subir para produção agora

O auto-deploy está **desligado** (`autoDeploy: false` no `render.yaml`).
Push na `master` não sobe mais nada sozinho — o código fica lá esperando.

Para subir:

1. Painel do Render → serviço **zenith-ops**
2. Botão **Manual Deploy** → **Deploy latest commit**
3. Acompanhe em Events até aparecer "Deploy live"

Leva ~2 minutos. O app fica fora do ar por alguns segundos no meio.

### A cadência sugerida

**Rotina — 1 deploy por dia**, no fim do expediente ou de manhã cedo, com
tudo que foi acumulado. Um boot em vez de trinta.

**Emergencial — sim, é possível, e é o mesmo botão.** Se a operação está
parada agora, você clica em Manual Deploy na hora e sobe. Não existe trava,
janela ou espera. A diferença entre "rotina" e "emergencial" não é técnica
— é só a sua decisão de quando apertar.

O que torna isso seguro é a ordem:

1. a mudança é testada no local (`npm run local`),
2. a suíte passa (`npm run teste`),
3. o commit está na `master` esperando,
4. você aperta o botão quando fizer sentido.

Se surgir uma emergência no meio do dia, o passo 4 acontece na hora — e
como os passos 1 a 3 já aconteceram, subir é seguro mesmo com pressa.

### Se der errado depois de subir

No Render, em Events, todo deploy anterior tem a opção **Rollback**. Volta
para a versão que estava rodando antes, em ~2 minutos. Custa outro boot,
mas é o que existe de mais rápido para tirar a operação de um problema.

---

## Como conferir o custo

Console do Firebase → Firestore → aba **Uso**.

O número que importa é **Operações por minuto**, não o custo previsto (esse
é média retroativa e demora dias para refletir qualquer mudança).

Referência medida em 23/08/2026:

| Momento | Leituras/minuto |
|---|---|
| Antes das correções | ~1.500 (piso constante) |
| Depois | ~84 |

Pico isolado logo depois de um deploy é esperado — é o boot. Piso alto e
constante **não** é: aí tem alguma coisa relendo em loop, e é o momento de
investigar.

O app também tem contador próprio, que diz **qual rota** gastou (só Master):

```
https://<seu-app>/api/debug/leituras
```

`?zerar=1` no fim zera o contador. Abra, zere, espere uma hora, abra de
novo: você tem leituras por rota naquela hora.

---

## Chaves para ligar/desligar sem deploy

No Render, em Environment. Mudar uma delas reinicia o serviço (um boot).

| Chave | Padrão | O que faz |
|---|---|---|
| `PRE_AQUECER_CACHES` | desligado | `1` volta a pré-aquecer 8 coleções no boot |
| `NOC_REDE_5MIN` | desligado | `1` volta a coletar telemetria de rede de 5 em 5 min |
| `NOC_VARREDURA_MS` | 120000 | intervalo da varredura de conectividade do NOC |
| `LOJA_STATUS_PERSIST_MS` | 300000 | de quanto em quanto tempo uma batida sem novidade vira gravação |
