# NoPulso — leia antes de mexer

Painel operacional de um grupo de franquias. O produto chama **NoPulso**;
o repositório ainda se chama `adyen-monitor`/`zenith.ops` por motivo
histórico. HTML/CSS/JS inline por página, sem framework e sem build step.

Este arquivo tem só o que quebra produção se for ignorado. O contexto
longo está em:

- **`docs/CONTEXTO.md`** — por que as coisas são como são (convenções,
  permissões, espaços de código de unidade, como testar, fluxo de git)
- **`docs/MAPA_PAGINAS.md`** — onde fica cada tela
- **`server/DESENVOLVIMENTO.md`** — ambiente local, emulador, custo de deploy

---

## 1. Nunca renomear

Cada item abaixo custa trabalho manual em máquina de loja se for mudado.
Rótulo na tela pode mudar; **o identificador não**.

| O quê | Onde | Por quê |
|---|---|---|
| `NOCZenith` | `vigiaScript.js`, `lojaStatus.js` | é o nome da pasta em `%LOCALAPPDATA%` e da tarefa agendada em 52 máquinas — renomear = 52 reinstalações na mão |
| `zenithMonitorFixo`, `zenithAbertoDesde` | `localStorage` | o computador da loja esquece qual unidade monitora e passa a acusar loja offline |
| `authToken`, `zenithTema`, `zenithFonte`, `centralSecao` | `localStorage` | derruba a sessão, a preferência de tema e a aba lembrada da Central |
| ids `nav-*` (42 deles) | `nav-menu.js` | é a chave da permissão em `aplicarRegras()`; o rótulo ao lado pode mudar à vontade |
| `zenith-ops` | `render.yaml` | nome do serviço no Render — mudar cria serviço novo |
| `adyen-monitor.onrender.com` | — | os 52 agentes apontam pra lá e o link já foi mandado pra cliente |
| seção "NOC Zenith" | `loja-status.html` | é nome de seção interna, não marca de produto — fica |
| `start_url: "/"` | `manifest.json` | o heartbeat depende de reabrir a raiz e ler a unidade salva no navegador — `name`/`short_name`/ícones podem mudar |
| `normalizarCodigoUnidade()`, `UNIDADES_APELIDOS`, `merchantAccountCode` | `migracaoUnidades.js`, Adyen | espaços de código de unidade. Rebranding é visual; o dado continua igual — inclui os 3 testes de fold do `testeRotas.js`, que são a prova de que o histórico antigo ainda é encontrado |

### Decisão fechada: mapa da planilha e códigos de unidade

Decisão do Master, **não reabrir**:

- `AdyenV2` da planilha cai no campo `pix` e aparece rotulado **"Adyen"**
  (`bravoImport.js`, `sheetsSync.js`). Está certo assim.
- As colunas de máquina somam em `adyen`, rotulado **"Maquininhas (total)"**
  (`somarMaquininhas`, `bravoImport.js`).
- A unificação dos códigos de unidade está encerrada.

Não mudar mapeamento, rótulo ou destino de campo, e **não escrever migração
nova sobre dado antigo** — o histórico precisa continuar legível exatamente
como está. Um nome de campo que parece errado provavelmente é uma dessas
decisões: pergunte antes de "consertar".

---

## 2. Marca e tema

O acento é **`--accent: #b8ff3c`** (limão) para ação, meta, marca e item
ativo. **`--accent2: #5cc8ff`** (ciano) é só dado técnico de gráfico.

**Nunca escreva `#b8ff3c` direto no CSS.** No tema Claro o `tema.js`
troca o `--accent` por `#5b8c00`, porque limão puro sobre branco é
ilegível — e cor cravada escapa dessa troca. Use `var(--accent)`, ou
`var(--accent,#b8ff3c)` se a página não declarar `:root`
(`alerta-beniboy.html` é a única). Texto sobre o acento é sempre `#0b0d10`.

Isso já quebrou uma vez: 14 ocorrências cravadas no `suporte-chat.js`
deixaram botão e link invisíveis no modo Claro, em toda tela do app.
Hoje o `testeRotas.js` reprova a suíte e aponta arquivo:linha.

Fontes (Archivo + JetBrains Mono) são servidas pelo **próprio app**, em
`server/public/fontes/` — não pelo CDN do Google. As lojas têm piso de
latência alto e algumas ficam atrás de rede restrita. São variable fonts:
um `.woff2` por subset cobre a faixa inteira de peso. O `tema.js` injeta
o CSS uma vez, para todas as 53 páginas.

**Cor semântica não é marca.** `--ok` / `--warn` / `--bad` e os marcadores
🟢🟡🔴 do NOC e dos alertas ficam como estão. Repintar status com o limão
apaga a leitura de gravidade — que é exatamente o que a operação usa pra
decidir. `<meta name="theme-color">` continua `#0b0d10` (a exceção é
`alerta-beniboy.html`, vermelho de propósito).

Relatórios e e-mails têm hex próprio e **não** são afetados pelo CSS:
`relatorioMV.js` (`STATUS_COR`), `fechamentosReport.js`, `fraudReport.js`,
`vaultExport.js`. Rebrandeá-los é opcional e independente.

O `tema.js` é carregado por **todas** as páginas. Página nova precisa da
tag `<script src="/tema.js"></script>` no `<head>`.

### O Beniboy

O avatar do assistente é **um desenho só**, servido por
`window.beniboySVG(px, estado)` no `tema.js` — usado no widget de chat, no
`atendimento.html`, na Central, no item `nav-beniboy` do menu, na tela de
alarme e no ícone de push (`beniboy-192.png`). Não copie o SVG pra dentro de
uma página: já houve duas cópias divergentes do robô antigo (login e widget).

A cor é o estado, e sai sempre do token: `var(--accent)` disponível,
`var(--accent2)` verificando, `var(--bad)` chamou um humano, `var(--ok)`
resolvido. Na tela de alarme o traço fica **inteiro** — em 112px sobre fundo
vermelho, um traço que some 250ms por ciclo parece defeito.

**A marca não bate.** A polyline do logotipo (`.auth-marca`, `.nmz-marca`) é
identidade e fica parada; quem pulsa é o Beniboy. O `testeRotas.js` reprova
se alguém animar as duas.

---

## 3. Custo do Firestore

O Firestore cobra **por documento devolvido**. Uma consulta que não acha
nada ainda custa 1 leitura. O app já caiu com `RESOURCE_EXHAUSTED`.

- Toda leitura cara passa por `createCache()` do `liveCache.js`, e **toda
  escrita chama `invalidar()`**.
- No `lojaStatus.js`, escrever um computador **não** pode derrubar o
  espelho inteiro: use `gravarEEspelhar()`, que aplica o patch no espelho
  em memória em vez de forçar releitura dos 52 documentos. Ignorar isso já
  custou ~66 leituras por escrita e quase R$900/mês.
- O pré-aquecimento de cache no boot é opt-in (`PRE_AQUECER_CACHES=1`).
  Cada boot custa ~5 mil leituras — por isso ele não é padrão.

---

## 4. Deploy

**Auto-deploy está DESLIGADO no Render.** Dar push não publica nada; quem
publica é o usuário, no botão Manual Deploy. Ao terminar uma entrega,
diga explicitamente que está *na master, aguardando o deploy dele*.

Não abrir Pull Request sem o usuário pedir.

### Domínio

O endereço público sai de **uma** variável: `APP_BASE_URL` (`index.js`,
`relatorioMV.js`, `vigiaScript.js`), com fallback pro
`adyen-monitor.onrender.com`. Trocar de domínio é trocar essa variável no
Render — não tem URL cravada em lugar nenhum.

Três coisas que quebram se forem ignoradas numa troca de domínio:

1. **O `adyen-monitor.onrender.com` nunca pode ser desligado.** Além dos
   links já enviados a cliente, é por ele que os 52 agentes descobrem que
   existe versão nova e baixam o script novo. Máquina que estava desligada
   migra quando voltar — mas só enquanto o endereço velho responder.
2. **`VERSAO_VIGIA` tem que subir junto** (`vigiaScript.js`). O agente
   instalado pergunta a versão no endereço velho, vê um número maior, baixa
   o `.ps1` (que o servidor gera já com o `APP_BASE_URL` novo), se
   sobrescreve e reinicia no endereço novo. Sem subir a versão, ninguém
   migra. E o script baixado **precisa começar com `# NOCZenith`** — é a
   trava que impede gravar arquivo quebrado por falha de rede.
3. **`localStorage` é por origem.** Domínio novo = armazenamento vazio, o
   mesmo efeito de renomear `zenithMonitorFixo`: a máquina esquece a
   unidade e a loja passa a acusar offline. Vale pras duas telas que fazem
   heartbeat pelo navegador — `index.html` (PC interno) e
   `abastecimento.html`. Não troque a URL da máquina de loja na mão; deixe
   o vigia migrar (ele carrega a unidade dentro do próprio script). Se
   precisar abrir manualmente, use o link com `?unidade=&posto=`.

Notificação push também é por origem: quem já tinha continua recebendo,
mas precisa reativar o 🔔 uma vez ao entrar pelo endereço novo.

---

## 5. Vocabulário: usar o que já existe no código

Ao mexer em qualquer tela, status, coluna e verbo vêm do próprio código —
**nunca inventar rótulo novo**:

- **Solicitações/estornos**: `PENDENTE`, `APROVADO`, `REJEITADO`,
  `CONVERTIDO` (`solicitacoes.js`, `refunds.js`)
- **Chamados de TI**: `ABERTO`, `INICIADO`, `CONCLUIDO`, `CANCELADO`, mais
  remoto × presencial e triagem N1/N2 (`chamadosTI.js`, `tecnico.html`)
- **Manutenção**: Aguardando aceite / Recusado / Aceito / Em execução / Em
  espera / Finalizado / Cancelado (`manutencao.html`, `STATUS_LABEL`)
- **Compras**: `aguardando` → `aprovada` → `comprada` → `entregue`
  (`compras.html`)
- **Disputas**: `MONITORANDO`, `ABERTA`, `ENVIADA`, `GANHA`, `PERDIDA`,
  `ERRO_SISTEMA` (`disputes.js`)
- **Beniboy**: `PENDENTE`, `EM_ATENDIMENTO`, `TRANSFERIDO`,
  `TICKET_CRIADO`, `RESOLVIDO`, `SEM_SOLUCAO` (`suporteChat.js`)
- **NOC**: `nunca` / Operacional / Degradado / Indisponível — quatro
  estados disjuntos (`loja-status.html`, `statusDe()`)
- **Fechamento**: campos de `NOMES_CAMPOS_FECHAMENTO`. Correção só por
  Central → Histórico → 🧾 Fechamentos → Pedir correção
- **Monitor**: colunas de `reportExport.js`; unidade no espaço Adyen
  (`DOM_19706`, `Mooca`)
- **Tipos de solicitação** com ícone: `usuarios.html`, `TIPOS_SOLICITACAO`.
  Áreas: `grupos.html`, `AREAS_LABEL`

**Tom de voz** em notificação e alerta: direto e específico, sempre com o
fato e o número — "Diferença de caixa detectada", "3 de 14 unidades
faltando lançar", "Latência acima de 1000ms em 8 máquinas". Nunca "Ops,
algo deu errado".

O pacote de design completo (tokens, as 28 telas em mockup e o mapa
tela → arquivo) está em **`docs/rebranding/`**.

---

## 6. Antes de qualquer merge

```bash
cd server && JWT_SECRET=t \
  ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
  node testeRotas.js
```

Sem CI, esse teste é a única rede. Ele sobe o `index.js` de verdade contra
um Firestore falso e bate nas rotas por HTTP — pega função inexistente,
que o `node --check` não pega.

`node --check` não lê `.html`: extraia o `<script>` inline e cheque o
bloco isolado.

Teste novo tem que ser **verificado por sabotagem** — quebre de propósito
o que ele deveria pegar e confirme que ele reprova. Teste que passa dos
dois jeitos não é teste.
