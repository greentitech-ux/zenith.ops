# NoPulso — contexto do projeto

Documento de partida pra quem (pessoa ou IA) vai mexer no código sem ter
acompanhado o histórico. Diz o que o sistema é, como ele foi construído,
quais decisões já estão tomadas e quais armadilhas já custaram caro.

Companheiro de `MAPA_PAGINAS.md` (que diz **onde** fica cada tela). Este
aqui diz **por que** as coisas são do jeito que são.

---

## 1. O que é

Painel operacional multi-empresa de um grupo de franquias. Nasceu como
monitor de transações da Adyen (daí o nome do repositório,
`adyen-monitor`) e virou o sistema que a operação inteira usa. O nome do
produto é **NoPulso**.

O grupo opera em frentes bem diferentes, e o sistema cobre todas:

| Frente | Do que trata |
|---|---|
| **Monitor / Fraude / Estornos** | transações Adyen ao vivo, chargebacks, disputas, detecção de fraude, fila de estorno |
| **Fechamentos** | fechamento de caixa diário por loja, importado de planilha e lançado no sistema |
| **Entregas / iFood** | corridas, entregadores, integração iFood |
| **Central / Chamados** | solicitações (compra, pagamento, nota), chamados de TI e manutenção |
| **RH / BigBrother** | colaboradores, ponto por foto, experiência CLT, advertências |
| **NOC Zenith** | saúde dos computadores das lojas (vigia PowerShell + diagnóstico de rede) |
| **Estoque / Abastecimento** | inventário, contagem, recebimento, carrinho de abastecimento |
| **Parque / Festas / Saltiverso** | parque infantil: check-in, mensalistas, reservas, caixa |
| **Cofre de senhas** | credenciais por grupo/subgrupo, com exportação |
| **Beniboy** | bot de suporte (Claude) que atende no chat, abre ticket e desbloqueia login |

Escala: ~795 commits, 95 módulos no backend, 49 páginas, ~35 mil linhas de
JS no servidor (só o `index.js` tem ~9,9 mil).

---

## 2. Stack e execução

- **Node + Express 4**, CommonJS, sem TypeScript
- **Firestore** como banco (`firebase-admin`), **Cloud Storage** pra
  anexos e snapshots
- **Frontend sem framework e sem build**: cada página é um `.html` com
  CSS e JS inline. Não existe bundler, não existe `npm run build`
- Deploy no **Render** (`render.yaml`, plano free, `rootDir: server`)
- Autenticação por **JWT** no `localStorage` (`authToken`), mandado como
  `Authorization: Bearer` em todo `fetch`

Rodar local precisa no mínimo de `JWT_SECRET` e `ENCRYPTION_KEY`; o resto
das variáveis está em `server/.env.example` (Firebase, Adyen HMAC, VAPID
pra push, Google Sheets, iFood, Gmail).

---

## 3. Convenções que valem pra todo o código

### Módulo de domínio
Todo módulo (`rh.js`, `parque.js`, `grupos.js`…) segue o mesmo formato:
coleção própria no Firestore + `createCache()` do `liveCache.js` +
funções `criar/listAll/getOne/atualizar/remover`. **As rotas HTTP não
ficam no módulo** — ficam centralizadas em `index.js`.

### Cache é obrigatório, não otimização
`liveCache.js` existe porque o app **já caiu em produção** com
`RESOURCE_EXHAUSTED` (cota de leitura do Firestore estourada). Toda tela
relê a coleção inteira a cada render. Regra: leitura cara passa por
`createCache()`, e **toda escrita chama `invalidar()`**.

### Comentários explicam o *porquê*
O código é densamente comentado, e os comentários contam a decisão e o
bug que a motivou — não o que a linha faz. Quem escrever código novo
segue esse tom. Exemplos reais no repo: por que `migracaoUnidades.js`
ainda existe, por que o PUT de preferência usa `keepalive`, por que o
seletor de colunas unifica por rótulo.

### Idioma
Tudo em português: UI, comentários, mensagens de commit, nomes de função
e variável (`salvarColunas`, `unidadeNome`, `foraRelatorio`).

---

## 4. Permissões

Quatro eixos, que se somam:

1. **`role`** — `master` é o dono do sistema
2. **`sections`** — lista de áreas liberadas (`monitor`, `fechamento`,
   `rh`, `suporte`, `inventario`…)
3. **flags booleanas por usuário** — `isAdmin`, `podeCatalogoEstoque`,
   `podeRhTodasUnidades`, `podeCadastrarOperadores`…
4. **unidades** — quais lojas a pessoa enxerga

No servidor: `auth.requireAuth`, `requireSection('x')`, `auth.requireMaster`.
Tudo abaixo de `app.use('/api', auth.requireAuth)` exige login — rotas
públicas (links de ticket, estorno do cliente, heartbeat do vigia,
auto-cadastro RH) são declaradas **acima** dessa linha, por regex.

No navegador: **`server/public/nav-gate.js` é a fonte única da verdade**
de quais links do menu aparecem. Página nova = entrada nova ali.

Existe ainda o par **QA Master / QA User**: um QA Master não executa ações
sensíveis direto — elas viram pedido na fila do `qaAprovacoes.js` pra um
Master de verdade aprovar (`desviarSeQaMaster` + `EXECUTORES_QA` no
`index.js`).

---

## 5. O conceito que mais confunde: os espaços de código de unidade

**A mesma loja física tinha códigos diferentes em cada subsistema.** Esse
foi o problema mais caro do projeto e ainda é onde é mais fácil errar.

| Espaço | Formato | De onde vem |
|---|---|---|
| **Fechamento** | `19888`, `Dominos Bessa` | ARCFOOD (numérico) ou nome GBE |
| **Entregas** | `Bessa`, `MMTirol Natal` | nomes de aba do AppSheet "MOTOS BRAVO" |
| **Monitor/Adyen** | `DOM_19706`, `Mooca` | `merchantAccountCode` da Adyen — formato fora do nosso controle |
| **iFood** | próprio | API do iFood |

**Decisão do Master, já executada:** o código de **Fechamento** é o
principal, porque é o dado mais importante do sistema. Os outros morrem e
tudo passa a usar o de Fechamento. Exceção única: `Tirol Natal` →
`MMTirol Natal`, porque essa loja não tem código de Fechamento — ali o
destino é o de Entregas.

`migracaoUnidades.js` guarda os mapas. **O nome do arquivo é histórico** —
os scripts de migração já rodaram em produção (2026-08-18) e foram
removidos. O que sobrou é tabela de runtime permanente, e existem **duas
defesas que valem pra sempre**:

1. **Na ingestão** (`normalize.js`, `reportImport.js`, `entregasSync.js`) —
   `normalizarCodigoUnidade()` faz todo dado novo já nascer certo
2. **Na exibição** (o "fold" em `construirUnidadesMapa()`, no `index.js`) —
   qualquer código antigo que reapareça por qualquer caminho é fundido na
   hora de mostrar

Os 3 testes de fold no `testeRotas.js` são a rede de segurança disso. Não
remover.

Separado disso: `UNIDADES_APELIDOS` (no `index.js`) é **só nome de
exibição**, não unifica cadastro nenhum. Não confundir os dois.

---

## 6. Como testar (não existe CI)

### `server/testeRotas.js` — a rede principal
Sobe o `index.js` **de verdade** contra um Firestore falso (um `Map`),
faz login como Master e bate nas rotas por HTTP.

```bash
cd server && JWT_SECRET=teste1234567890abcdefghijklmnopqrstuv \
  ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  node testeRotas.js
```

Ele existe porque `node --check` só pega erro de **sintaxe**. Uma função
inexistente passa batido e, se a chamada estiver fora do try/catch de uma
rota async, o Express 4 **nem devolve 500** — a requisição fica pendurada
e a tela some sem erro nenhum no console. Foi exatamente isso que derrubou
o pré-envio uma vez.

Ele também tem uma trava que varre todos os `.html` e falha se alguma
página autenticada esquecer de mandar o token (já aconteceu duas vezes).

### Sintaxe de página
`node --check` não lê `.html`. É preciso extrair o `<script>` inline com
um script e checar o bloco isolado.

### Navegador de verdade
Playwright-core está em `/tmp/node_modules`, Chromium em
`/opt/pw-browsers/chromium-1194/chrome-linux/chrome` (caminho exato — não
existe `/opt/pw-browsers/chromium/`). Com `page.route()` dá pra simular a
API inteira e testar fluxo real.

Duas armadilhas conhecidas:
- `file://` quebra `<script src="/...">` — pra testar página que usa JS
  compartilhado, subir um servidor HTTP estático mínimo
- `addInitScript` roda também no `about:blank`, onde `localStorage` lança
  "Access is denied" — é ruído do harness, não da página

---

## 7. Fluxo de trabalho

Branch de desenvolvimento: **`claude/claude-md-docs-7tl9dg`**.

Depois de cada entrega verificada:

```bash
git push -u origin claude/claude-md-docs-7tl9dg
git fetch origin master && git checkout master && git pull origin master
git merge --no-edit claude/claude-md-docs-7tl9dg
# roda testeRotas.js de novo, já na master
git push origin master && git checkout claude/claude-md-docs-7tl9dg
```

O repositório mudou de nome (`adyen-monitor` → `zenith.ops`); o `git push`
avisa isso e funciona normalmente. Não abrir PR sem o usuário pedir.

---

## 8. Trabalho recente (agosto/2026)

### Unificação dos códigos de unidade
Entregas→Fechamento e Monitor/Adyen→Fechamento, cobrindo transações (com
o cache em memória e o snapshot no Storage, não só o Firestore), marcas de
fraude, disputas, pedidos de estorno e permissões de usuário. Depois, com
as migrações confirmadas rodadas, os painéis e scripts de migração foram
removidos — sobraram os mapas e as duas defesas de runtime.

Bug encontrado antes de ir pra produção: migrar um código de cada vez
relia a mesma lista velha de usuários, e a 2ª escrita desfazia a 1ª quando
alguém tinha permissão pra dois códigos antigos. Corrigido com passe único
sobre o mapa inteiro.

### Fechamentos — resolvido "em definitivo"
A tela dividia os dados em duas tabelas (sistema × planilha) e repetia
colunas IFOOD/99FOOD/LOJA. Causa real: campos legados achatados e campos
configurados por grupo são **o mesmo conceito guardado em dois lugares** —
resíduo de migração. Solução: unificar coluna **por rótulo normalizado**,
o que matou as duplicatas e tornou a divisão desnecessária. Voltou a ser
uma tabela por grupo.

Junto disso: apareceram 5 campos que a planilha importava e a tela nunca
mostrava (Delivery, Carryout, Pick-up, Pix CNPJ, Outros) — agora são 10
colunas. O seletor 🧩 Colunas ganhou **dois checks independentes** (Tela e
Relatório), e a preferência passou a ser gravada **no servidor, por
usuário** (`preferencias.js` + `/api/preferencias/:chave`), então a ordem
confirmada sobrevive a atualizar a página, fechar o app, limpar o cache e
trocar de aparelho. O `localStorage` virou só espelho pra primeira pintura.

### Limpeza
−1788 linhas de menu antigo morto (o `initNavDrawerAccordion` em 34
páginas + CSS órfão em 37), já superado pelo `nav-menu.js` que monta o
menu em runtime.

### NOC Zenith
Cadastrar computador agora entrega direto o **comando do PowerShell** (que
é o que ativa a máquina), não mais o link. Mudar de unidade faz o mesmo — o
vigia instalado tem a unidade gravada dentro dele e precisa ser
reinstalado.

---

## 9. Diagnóstico aberto: latência da frota

A tela `noc-rede.html` mostra **todas as máquinas acima de 1000ms**, em
cidades e operadoras diferentes, com dispersão apertada (1096–1272ms fora
os outliers). Isso é assinatura de piso comum, e o único componente comum
é o servidor — o próprio `redeDiagnostico.js` já classifica como
`culpa: 'servidor'`.

O que o número mede: round-trip completo do POST de heartbeat (`Stopwatch`
em volta do `Invoke-RestMethod`), incluindo TLS, fila do Render, handler e
escritas no Firestore.

Próximos passos combinados, ainda não executados:
1. `curl` cronometrado de fora da frota, contra endpoint barato — separa
   "infra lenta" de "handler lento"
2. instrumentar o handler: tempo total × tempo em Firestore
3. suspeito principal: o heartbeat **reescreve o doc do computador a cada
   25s** (~1 escrita/s com a frota atual, só de presença)

**Não** trocar link de loja nem abrir chamado em operadora — nada disso
move um piso comum a toda a frota.

Higiene que a mesma tela denuncia (não é causa): 8 computadores com nome
de hash (`5714d283`, `4a0d6d15`…), todos em Praça Aeroporto Recife, e
mojibake no nome da unidade ("Pra**�**a") — algum ponto do caminho não
está em UTF-8.

---

## 10. Pergunta pendente pro Master

A coluna **AdyenV2** da planilha é lida pro campo `adyen`, então aparece
embaixo de **"Maquininhas (cartão)"** — e a coluna "AdyenV2" fica 0,00 nas
linhas vindas de planilha. É comportamento antigo e documentado. Falta
decidir se AdyenV2 da planilha deve passar a alimentar a coluna AdyenV2.

---

## 11. Coisas que parecem código morto e não são

- **`fetch-reports.js`, `import-report.js`, `seed.js`** — ninguém dá
  `require` neles, mas são utilitários de linha de comando
- **classes CSS `active`, `back`** — injetadas em runtime pelo
  `nav-menu.js`, não aparecem no HTML estático
- **`migracaoUnidades.js`** — nome de migração, conteúdo de runtime
  permanente (ver seção 5)
