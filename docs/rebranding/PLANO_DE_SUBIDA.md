# Plano de subida — rebranding NoPulso

Checklist executável para o Claude Code. Ordem importa: cada passo deixa o
sistema inteiro consistente antes do próximo. Nada aqui muda backend, rota,
coleção, mapeamento de campo ou código de unidade.

Leia antes: `README.md` (spec completa) e `CLAUDE.md.trecho.md` (as 12 regras).
Referência visual: `NoPulso Mockups.dc.html` — abre no navegador; os ids (1a…5d)
são citados em cada passo.

---

## Passo 0 — verificar o que já está feito

O `tema.js` **já** injeta Archivo + JetBrains Mono e já tem a paleta clara com
`--accent:#5b8c00` / `--accent2:#0d7ac2`. Várias páginas (`central-solucoes`,
`dashboard-atendimentos`, `noc-maquinas`, `alerta-beniboy`) já estão com
`--accent:#b8ff3c` e `--accent2:#5cc8ff` no `:root` e o título `· NoPulso`.

```bash
cd server/public
grep -l -- "--accent:#5cc8ff" *.html   # páginas que ainda estão no ciano antigo
grep -l "Zenith Ops" *.html *.js       # marca antiga visível
grep -rn "rgba(92,200,255" *.html *.js # ciano cravado fora do token
```

Trate só o que essas três buscas devolverem.

## Passo 1 — tokens (todas as páginas restantes)

Em cada `.html` da lista do passo 0, no bloco `:root`:

- `--accent:#5cc8ff` → `--accent:#b8ff3c`
- adicionar `--accent2:#5cc8ff` (dado técnico: gráficos, NOC, badges de compra)
- `--sans` passa a começar com `'Archivo'`
- `--mono` permanece `'JetBrains Mono', 'SF Mono', ui-monospace, …`
- `--bg/--panel/--panel2/--line/--text/--muted/--ok/--warn/--bad` **não mudam**
- `<meta name="theme-color">` continua `#0b0d10`

E os `rgba` cravados: `rgba(92,200,255,.1)` → `rgba(184,255,60,.1)` em
`a.back.active`; `rgba(138,180,248,.45)` → `rgba(184,255,60,.35)` em
`.painel-sugestao` (abastecimento). Botão com `color:#06202b`/`#06121a` sobre
`var(--accent)` → `color:#0b0d10`.

Regra dura: nenhum hex de acento novo fora do `:root`. Sempre `var(--accent)`.

## Passo 2 — chrome compartilhado

- `nav-menu.js`: `.nmz-marca` → `NoPulso`; `#nav-drawer a.nmz-item.active`
  background `rgba(184,255,60,.13)`. **Ids dos itens não mudam.** Ref: 1b.
- `notif-central.js`, `suporte-chat.js`, `recolher.js`, `alarme-sync.js`: só
  cor/rótulo se houver marca antiga.
- `<title>` de cada página: `<Tela> · NoPulso`.

## Passo 3 — login e identidade

`index.html` (ref 1a): wordmark No**Pulso** (Archivo 800, `Pulso` em
`var(--accent)`) + marca gráfica SVG (polyline de pulso, `stroke-width:3`,
pontos `2,26 14,26 21,10 29,32 36,20 62,20`), gradiente do `::before` em
`rgba(184,255,60,.10)` + `rgba(92,200,255,.07)`, rodapé "NOPULSO FAZ PARTE DO".
Assets: `logo.png`, `favicon.ico`, `favicon-16/32.png`, `icon-192/512.png`,
`apple-touch-icon.png`, `manifest.json` (`name`/`short_name`; `start_url`
continua `"/"`).

## Passo 4 — telas por ordem de uso

| Ordem | Arquivo | Ref | O que conferir |
|---|---|---|---|
| 1 | `painel.html` | 1b | KPIs em mono tabular, meta com barra limão, alertas com barra de severidade, cards de chamado |
| 2 | `fechamentos.html` | 1c | presets, 10 colunas, badges CONFERIDO/PENDENTE/TRATATIVA, linha de total |
| 3 | `lancamento.html` | 2h | bloco 📷 foto do relatório, campos travados com fundo `var(--panel)`, ✏️ manual, aviso de divergência, KPI's do grupo |
| 4 | `abastecimento.html` | 4c, 1d | pré-envio, Pedido/Envio/Contagem, popups de recebimento e contagem, tablet 48px |
| 5 | `central-historico.html` | 2a, 4a | kanban PENDENTE/APROVADO/CONVERTIDO/RECUSADO, detalhe com conversa do card |
| 6 | `tecnico.html` / `manutencao.html` | 2b, 3b | status e verbos reais, sem inventar rótulo |
| 7 | `monitor.html` / `relatorios.html` | 2c, 3e | tabela densa, série de gráfico em `--accent2` |
| 8 | `entregas.html` / `entrega-lancamento.html` / `entregas-regras.html` | 2d, 5a | COOP recebe calculado, campo removível com motivo |
| 9 | `estoque.html` / `rh.html` | 2e, 2f | abas, diferenças/CMV, experiência 30+60 |
| 10 | `loja-status.html` / `noc-rede.html` / `noc-maquinas.html` | 2g, 3l, 5c | 4 estados disjuntos, chips de disco/uptime |
| 11 | Saltiverso: `parque*`, `mensalistas`, `festas`, `saltiverso-*` | 3j, 3k, 5d | alvos de toque ≥44px nos quiosques |
| 12 | Admin: `usuarios`, `grupos`, `email`, `central-alertas`, `login-custom` | 3m, 3n | chips de área/tipo, Master-only visível |
| 13 | Públicas: `atendimento`, `decidir`, `estorno-cliente`, `solicitacao-publica`, `ticket-publico`, `assinar`, `rh-cadastro` | 3o, 3i, 5d | marca no topo, botões ≥48px |
| 14 | `ajuda.html` | 3p | tom direto; explicação dos 4 estados do NOC |

Estados de exceção (ref 4b) em toda página: vazio ("Sem dados no período."),
`carregando...` e sem permissão ("Você não tem acesso… Fale com o administrador
(Master).") com o contato do suporte.

## Passo 5 — fontes locais (recomendado)

Baixar Archivo (500/600/700/800) e JetBrains Mono (400/500/600/700) para
`server/public/fonts/`, declarar `@font-face` no `tema.js` e remover o `<link>`
do Google. Motivo: frota com piso de latência ~1,1s, máquinas caindo e proxy de
loja. Sem isso, o rebranding depende de rede externa para renderizar certo.

## Passo 6 — testes antes do merge

```bash
cd server && JWT_SECRET=teste1234567890abcdefghijklmnopqrstuv \
  ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  node testeRotas.js
```

Depois, no navegador (Playwright já disponível em `/tmp/node_modules`):

1. `fechamentos.html` e `monitor.html` a **1366×768**, fonte **100% e 130%**
   (A+/A− do menu ☰ › Aparência) — Archivo é mais larga; procurar coluna
   estourando com `white-space:nowrap`.
2. Cada tela tocada nos **dois temas** (Escuro e Claro). Limão puro sobre branco
   é ilegível — se aparecer, é hex cravado onde devia ser `var(--accent)`.
3. Quiosques (`parque-checkin`, `rh-checkin`, `saltiverso-vendas`) num viewport
   de tablet: nenhum alvo abaixo de 44px.

## Passo 7 — subir

Branch de desenvolvimento `claude/claude-md-docs-7tl9dg`, merge na `master`
rodando `testeRotas.js` de novo já na master (fluxo da §7 do
`docs/CONTEXTO.md`). Não abrir PR sem o usuário pedir.

---

## O que NÃO fazer (repetido de propósito)

- Renomear chave de `localStorage` (`zenithMonitorFixo` derruba o monitoramento
  das lojas), id de item de menu, ou `start_url` do manifest.
- Repintar `--ok/--warn/--bad` ou os 🟢🟡🔴 com a cor da marca.
- Mexer em mapeamento de campo da planilha (AdyenV2 → `pix`; máquinas somadas em
  `adyen`), em `migracaoUnidades.js`, `normalizarCodigoUnidade()`,
  `UNIDADES_APELIDOS` ou nos 3 testes de fold.
- Escrever migração nova sobre dado antigo. O histórico fica legível como está.
