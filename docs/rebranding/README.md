# Handoff: Rebranding Zenith Ops → NoPulso

## Visão geral
Rebranding visual do painel operacional (`greentitech-ux/zenith.ops`, branch `master`) de **Zenith Ops** para **NoPulso**. Não há mudança de arquitetura, de rotas ou de dados: o que muda é a camada de marca — nome, logotipo, cor de acento, tipografia dos títulos e tom das mensagens — aplicada sobre a estrutura de tela que já existe (topbar sticky + hamburguer + drawer, KPIs em mono, painéis com header e borda, tabela densa, badges de status).

## Sobre os arquivos de design
O arquivo `NoPulso Mockups.dc.html` deste pacote é uma **referência de design em HTML** — protótipo de aparência e comportamento, não código para copiar e colar. O repositório alvo é **HTML/CSS/JS inline por página, sem framework e sem build step** (ver `docs/CONTEXTO.md` §2), então a implementação é feita editando as páginas em `server/public/*.html` e os scripts compartilhados, seguindo os padrões que já existem lá.

## Fidelidade
**Hi-fi.** Cores, tipografia, espaçamentos e estados estão finais. Os valores abaixo são para uso literal.

## Design tokens

### Cores (substituem o bloco `:root` repetido em todas as páginas)
| Token | Zenith Ops (atual) | NoPulso (novo) | Uso |
|---|---|---|---|
| `--bg` | `#0b0d10` | `#0b0d10` (mantém) | fundo da página |
| `--panel` | `#12161b` | `#12161b` (mantém) | painéis, cards, drawer |
| `--panel2` | `#181d24` | `#181d24` (mantém) | inputs, chips, cards internos |
| `--line` | `#232a33` | `#232a33` (mantém) | bordas e divisores |
| `--text` | `#e7ecf1` | `#e7ecf1` (mantém) | texto |
| `--muted` | `#7d8896` | `#7d8896` (mantém) | rótulos, texto secundário |
| `--accent` | `#5cc8ff` | **`#b8ff3c`** | ação, meta, marca, item ativo do menu |
| `--accent2` | — | **`#5cc8ff`** (novo) | dado técnico/neutro (latência, NOC, badges de compra) |
| `--ok` | `#3ddc97` | `#3ddc97` (mantém) | conferido, meta batida |
| `--warn` | `#f2b33d` / `--warn-dim` `#3a2e14` | mantém | pendente, sangria |
| `--bad` | `#ff5c5c` / `--bad-dim` `#3a1616` | mantém | diferença de caixa, crítico |
| texto sobre acento | `#06202b` / `#06121a` | **`#0b0d10`** | label de botão limão |

Detalhe importante: existem regras que usam o ciano **hard-coded em rgba** e não pelo token — trocar também:
- `entregas.html` e irmãs: `a.back.active{background:rgba(92,200,255,.1)}` → `rgba(184,255,60,.10)`
- `nav-menu.js`, `injetarEstilo()`: `#nav-drawer a.nmz-item.active{background:rgba(92,200,255,.13)}` → `rgba(184,255,60,.13)`
- `abastecimento.html`: `.painel-sugestao` usa `rgba(138,180,248,.45)` → `rgba(184,255,60,.35)`
- `index.html`: o `::before` do login usa `rgba(255,183,94,.11)` e `rgba(92,200,255,.08)` → `rgba(184,255,60,.10)` e `rgba(92,200,255,.07)`
- `<meta name="theme-color" content="#0b0d10">` permanece.

### Tipografia
```css
--sans: 'Archivo', -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
--mono: 'JetBrains Mono', 'SF Mono', ui-monospace, Menlo, Consolas, monospace;
```
- Títulos (`h1`, título de painel, valor grande de card): **Archivo 700/800**, `letter-spacing:-.01em` a `-.03em`.
- Números, rótulos, badges, chips, datas, IDs: **JetBrains Mono**, `font-variant-numeric:tabular-nums`.
- Eyebrow acima do título: mono 10,5–11px, `letter-spacing:.16em`, `text-transform:uppercase`, cor `--accent`.
- Escala usada nos mockups: eyebrow 10,5px · título de tela 20px/700 · título de painel 13px/700 · rótulo de KPI 11px mono · valor de KPI 23–26px mono 600 · corpo 12,5–13px · tabela 11,5px · header de tabela 9,5px mono uppercase.
- Fonte via Google Fonts (`Archivo` 500–800 + `JetBrains Mono` 400–700). Como não há build, incluir o `<link>` em cada página **ou** injetar pelo `tema.js`, que já é carregado por todas (caminho preferido: uma linha só, sem editar 49 arquivos).

### Raio, espaçamento, sombra
- Raio: 6px (chip/preset/input pequeno) · 8px (input, botão, item de menu) · 10px (KPI, card) · 12px (painel) · 14px (card de login) · 20px (badge pill).
- Espaçamento: grid de KPIs `gap:12px`; painéis `gap:16px`; padding de painel `13–14px 16px`; célula de tabela `9px 12px`.
- Sombra: só no drawer (`6px 0 28px rgba(0,0,0,.45)`) e no multiselect (`0 8px 24px rgba(0,0,0,.5)`) — já existentes.
- Alvo de toque em tablet/celular: **mínimo 44px**, 48px nos botões de conferência do carrinho.

### Logotipo
Wordmark "No**Pulso**" — `No` em `--text`, `Pulso` em `--accent`, Archivo 800, `letter-spacing:-.02em`. À esquerda, marca gráfica: polyline de sinal vital em `--accent`, `stroke-width:3–4`, `stroke-linecap/linejoin:round`, viewBox `0 0 64 40`, pontos `2,26 14,26 21,10 29,32 36,20 62,20`. Tamanhos: 64×40 (login), 30×20 (drawer/mobile).
Substituir também: `logo.png`, `favicon*`, `icon-192/512.png`, `apple-touch-icon.png`, `manifest.json` (`name`/`short_name`), `<title>` de todas as páginas (`… · NoPulso`), e a string `Zenith Ops` no `nmz-marca` do `nav-menu.js`. Nomes internos com "Zenith" que **não** são marca de produto (ex.: `zenithMonitorFixo`, `zenithAbertoDesde` no `localStorage`, seção "NOC Zenith") ficam como estão — renomear chave de storage derruba o monitoramento já instalado nas máquinas.

## Telas

### 1a — Login (`server/public/index.html`)
Coluna centralizada, `gap:22px`, fundo `--bg` com dois radial-gradients (ver acima).
1. **Herói**: marca gráfica + wordmark (64×40 / 34px) com `animation: float 4s ease-in-out infinite` (`translateY(0 → -8px)`); ao lado, balão `--panel2`, borda `--line`, raio 14px, padding `10px 16px`, `max-width:240px` — título 14px/700 e linha mono 11,5px `--muted`. O balão continua personalizável pelo Master (`loginCustom.js`); o robô atual pode ser mantido ou substituído pela marca gráfica — nos mockups é a marca.
2. **Card** `--panel`, borda `--line`, raio 12px, padding 28px, largura 360px: eyebrow mono 10px "CENTRAL DE CONTROLE OPERACIONAL", h2 18px/700 "Entre com seu acesso", dois campos (label 12px `--muted`, input `--panel2` raio 8px padding 10px, texto mono 13px), botão largura total `background:--accent`, `color:#0b0d10`, 800, raio 8px, padding 12px, e linha de suporte 11px com link `--accent`.
3. **Rodapé**: mono 9,5px `letter-spacing:.14em` uppercase "NOPULSO FAZ PARTE DO" + logos do grupo (placeholder 150×38 no mockup; em produção é `/grupo-bravo.png` ou as logos de `login-custom.html`).
Estados: botão `disabled` → `opacity:.6`; erro em `--bad` 12px; popup de suporte já existente permanece, só troca a cor do link.

### 1b — Painel (`server/public/painel.html`) + drawer
Shell **igual ao resto do app**: header sticky com hamburguer 34×34 (`--panel2`, borda `--accent` quando o menu está disponível), eyebrow + título, e à direita chips mono 11px (`Todas as unidades`, `● ao vivo · 25s` em `--ok`, `Sair`). Não existe sidebar fixa — o menu é o drawer do `nav-menu.js`.
Conteúdo (padding `20px 24px`, `gap:16px`):
1. **4 KPIs** (`grid-template-columns:repeat(4,1fr)`, gap 12px): Faturamento hoje (com delta em `--ok`), Meta do mês (valor em `--accent` + barra de progresso 5px, trilha `--line`, preenchimento `--accent`), Diferença de caixa (`--bad`), Chamados abertos (`--warn`).
2. **Grid 1,55fr / 1fr**: painel "Fechamento de ontem por unidade" com cards `--panel2` de `flex:0 1 150px` (unidade que não lançou ganha borda `--bad-dim` e texto "Não lançou" em `--bad`), e painel "Alertas" com linhas separadas por `#1a1f26`, barra vertical 3px colorida por severidade e botão tracejado "ver central de alertas".
3. **Painel "Chamados na fila"**: filtros (chip ativo = fundo `--accent`, texto `#0b0d10`) e 3 cards em `repeat(3,1fr)` com badge de tipo (TI `--bad`/`--bad-dim`, Manutenção `--warn`/`--warn-dim`, Compra `--accent2`/`#12374a`), ID mono, título 13px/600 e linha de contexto mono 10,5px.
**Drawer** (frame separado no mockup, 270px): topo com marca + `usuário · Master` + botão ✕; corpo com item ungrouped "🏠 Painel" ativo (fundo `rgba(184,255,60,.13)`, texto `--accent`, barra esquerda 3px `--accent`), grupos em mono 9,5px uppercase com acordeão (só o grupo da tela atual aberto); rodapé Ajuda / Suporte / Sair (`--bad`). Itens e grupos vêm do `MENU` em `nav-menu.js` — **não inventar rótulos** e não adicionar contadores (o `itemHtml()` renderiza só ícone + rótulo).

### 1c — Fechamento de caixa (`server/public/fechamentos.html`)
Header com hamburguer + eyebrow + título e ações à direita (CSV, PDF, 🧩 Colunas, e o CTA `+ Lançar fechamento` em `--accent`).
1. **Barra de filtros** em painel: presets Ontem/Semana/Mês/Trimestre (ativo = fundo `--accent`, texto `#0b0d10`), dois campos de data mono, multiselect de unidades, e à direita status do import da planilha em mono 11px.
2. **5 KPIs**: Faturamento, Dinheiro, Maquininhas, Sangrias (`--warn`), Diferença (`--bad`, com borda `rgba(255,92,92,.35)` no card).
3. **Tabela por grupo**: header do painel com nome do grupo + contagem em mono + selo "planilha e sistema conciliados" em `--ok`. Colunas: Unidade, Faturamento, Delivery, Carryout, iFood, Pix CNPJ, Dinheiro, Sangria, Diferença, Status — números alinhados à direita, mono tabular; linha de unidade pendente usa `colspan` com "aguardando lançamento da loja"; última linha é **Total do grupo** em 700. Badges: `CONFERIDO` (`--ok`/`--ok-dim`), `PENDENTE` (`--warn`/`--warn-dim`), `TRATATIVA` (`--bad`/`--bad-dim`).
As 10 colunas e o seletor 🧩 com checks independentes (Tela/Relatório) já existem no produto — o rebranding não altera essa lógica.

### 1d — Loja em movimento
**Celular 390×780** (gestor na loja): header com marca + hamburguer 44×44; eyebrow com unidade e data; card de faturamento parcial com barra de meta; card de ação em borda `rgba(255,92,92,.35)` com badge "AÇÃO NECESSÁRIA", título "Diferença de caixa detectada" e botão limão 48px "Registrar tratativa"; dois KPIs 1fr/1fr (Chamados em `--warn`, Carrinho em `--accent2`); botão secundário "Lançar fechamento do turno".
**Tablet 900×620** (`abastecimento.html`, seção do carrinho — o uso de maior fluxo num único aparelho): abas grandes (A conferir / Enviados / Recebidos, ativa em `--accent`), grid 2 colunas de itens com nome 16px/700, linha mono 12px com pedido × separado (divergência em `--warn`) e botão de 48px à direita — "Conferir" em `--accent`, "Ajustar" secundário; rodapé com botão tracejado "Fechar conferência e enviar carrinho".

## Interações e estados
- **Hover** de item de menu: fundo `--panel2`; de chip/botão fantasma: `border-color:--accent`, `color:--text`.
- **Ativo**: preset/chip = fundo `--accent` + texto `#0b0d10`; item de menu = fundo `rgba(184,255,60,.13)` + barra 3px.
- **Drawer**: `transform:translateX(-102%) → 0`, `.22s cubic-bezier(.4,0,.2,1)`; overlay `rgba(0,0,0,.5)` + `backdrop-filter:blur(2px)`; fecha por ✕, overlay, Esc ou clique em item. Toda essa mecânica já está em `nav-menu.js` — só a cor muda.
- **Login**: flutuação da marca 4s; respeitar `@media (prefers-reduced-motion:reduce)` (a regra já existe).
- **Vazio**: "Sem dados no período." / "aguardando lançamento da loja" em `--muted`, centralizado.
- **Erro/alerta**: tom direto e específico, sempre nomeando o fato e o número — "Diferença de caixa detectada", "3 de 14 faltando lançar", "Latência acima de 1000ms em 8 máquinas". Nunca "Ops, algo deu errado".
- **Responsivo**: manter os breakpoints existentes (`max-width:640px` reduz padding do body e tamanho do h1; `max-width:420px` deixa o drawer em 86vw).

## Estado e dados
Nada novo. As telas consomem o que já existe: `/api/me`, `/api/fechamentos*`, `/api/central`, `/api/abastecimento*`, `/api/entregas`, `/api/loja-status/heartbeat`, `/api/login-custom`. Token JWT em `localStorage.authToken` enviado como `Authorization: Bearer`. Cache obrigatório via `liveCache.js` em qualquer leitura nova (ver `docs/CONTEXTO.md` §3).

## Assets
- Marca gráfica: SVG inline (polyline), sem dependência externa.
- Fontes: Google Fonts (Archivo, JetBrains Mono).
- A substituir no repo: `logo.png`, `favicon.ico`, `favicon-16/32.png`, `icon-192/512.png`, `apple-touch-icon.png`. `grupo-bravo.png` permanece.
- Nos mockups, o slot de logo do grupo é um placeholder tracejado — usar o arquivo real.

## Ordem sugerida de implementação
1. Tokens + fontes (bloco `:root` de todas as páginas + `tema.js`) e os `rgba` hard-coded listados acima.
2. `nav-menu.js`: marca do drawer e cor do item ativo — pega as 49 páginas de uma vez.
3. `index.html` (login) e assets/manifest/títulos.
4. `painel.html`, `fechamentos.html`, `abastecimento.html` — as três telas de maior uso.
5. Varredura das páginas restantes só para tokens e `<title>`.
6. Rodar `server/testeRotas.js` (inclui a trava que varre todos os `.html`) antes de qualquer merge; sem CI, esse teste é a rede.

## Arquivos deste pacote
- `NoPulso Mockups.dc.html` — 12 telas. Turno 1: 1a login, 1b painel + drawer, 1c fechamento, 1d celular + tablet do carrinho. Turno 2: 2a Central·Histórico (kanban), 2b Chamados TI, 2c Monitor, 2d Entregas, 2e Estoque, 2f RH, 2g NOC, 2h Lançamento. Turno 3 (menu completo): 3a Central, 3b Manutenção, 3c Compras, 3d Beniboy, 3e Disputas, 3f iFood, 3g KPI's + Recordes, 3h Cofre + Ativos TI, 3i Formulários, 3j Saltiverso, 3k Quiosques (parque, ponto por foto, balcão), 3l Relatórios do Carrinho + Análise de Rede, 3m Usuários + Grupos, 3n Alertas + E-mail + Tela de Login, 3o páginas públicas, 3p Ajuda. Abre direto no navegador.
- `github.md` — associação com o repositório e mapa tela → arquivos de origem.


---

## Revisão de produção (23/08/2026)

### O que já está no repositório
`server/public/tema.js` **já foi rebrandeado**: o comentário de topo fala "Aparência do NoPulso", ele injeta Archivo + JetBrains Mono do Google Fonts para todas as páginas (em vez de repetir o `<link>` em cada arquivo) e a paleta clara já traz `--accent:#5b8c00` e `--accent2:#0d7ac2`. Ou seja: parte deste handoff já está aplicada. Confira antes de repetir o passo 1 da ordem de implementação.

### Regras que evitam quebra em produção
1. **Sempre `var(--accent)`, nunca o hex `#b8ff3c`.** O tema Claro existe (`:root[data-tema="claro"]` no tema.js) e o limão puro é ilegível como texto sobre branco — por isso a versão clara é `#5b8c00`. Qualquer CSS novo com o hex cravado quebra o tema Claro dessa tela. Mesma regra para `--accent2` (ciano de dado técnico → `#0d7ac2` no claro).
2. **Não renomear chaves de `localStorage`:** `authToken`, `zenithMonitorFixo`, `zenithAbertoDesde`, `zenithTema`, `zenithFonte`, `centralSecao`. Renomear `zenithMonitorFixo` derruba o monitoramento de presença já instalado nas máquinas das lojas (o computador esquece qual unidade/posto monitora e a loja passa a aparecer como offline). São nomes internos — não são marca visível.
3. **Não renomear os ids do menu** (`nav-painel`, `nav-fechamentos-gbe`, …): eles são a chave da regra de permissão em `aplicarRegras()`. Trocar rótulo é seguro; trocar id esconde links de quem tem acesso.
4. **`manifest.json`:** pode trocar `name`/`short_name`/ícones, mas mantenha `start_url: "/"` — o heartbeat depende de reabrir a raiz e ler a unidade salva no próprio navegador.
5. **`<meta name="theme-color">`** continua `#0b0d10` (o fundo não mudou).
6. **Cores semânticas não são marca:** `--ok`/`--warn`/`--bad` e os pontos 🟢🟡🔴 do NOC/alertas seguem iguais. Repintar status com o limão apaga a leitura de gravidade — e é justamente o que a operação usa para decidir.
7. **Relatórios e e-mails têm hex próprio** (`relatorioMV.js` `STATUS_COR`, `fechamentosReport.js`, `fraudReport.js`, `vaultExport.js`): não são afetados pelo CSS. Rebrandeá-los é opcional e independente — e nenhum deles muda comportamento.
8. **Fontes via CDN são o único ponto novo de dependência externa.** Com `display=swap` a tela nunca fica em branco, mas a frota tem piso de latência ~1.1s e máquinas caindo. Recomendação: baixar Archivo e JetBrains Mono para `server/public/fonts/` e servir com `@font-face` local — tira Google do caminho crítico e imuniza contra firewall/proxy de loja.
9. **Archivo é mais larga que a fonte de sistema.** As telas medem tudo em px e o A+/A− aplica `zoom` no `<html>`. Teste `fechamentos.html` (10 colunas + `white-space:nowrap`) e `monitor.html` a 1366×768 com fonte em 100% e 130% antes de subir — é o único risco funcional real da troca de tipografia.
10. **Nada de backend muda.** Sem rota nova, sem coleção nova, sem leitura extra no Firestore — logo, sem risco de `RESOURCE_EXHAUSTED`. Ainda assim, rode `server/testeRotas.js` (ele varre todos os `.html` e falha se alguma página autenticada perder o token) antes de qualquer merge.
11. **Não tocar nos espaços de código de unidade** (`migracaoUnidades.js`, `normalizarCodigoUnidade()`, `UNIDADES_APELIDOS`, `merchantAccountCode` da Adyen). É rebranding visual; o dado continua igual.

### Lacuna conhecida dos mockups
Todas as telas deste pacote estão no tema **Escuro**. O produto tem tema **Claro** por aparelho (menu ☰ › Aparência). Ao implementar, valide cada tela nos dois temas — e considere pedir uma versão clara dos mockups das 3 telas mais usadas (Painel, Fechamentos, Abastecimento).
