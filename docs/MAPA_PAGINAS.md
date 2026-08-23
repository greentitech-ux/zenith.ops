# Mapa de páginas — onde está cada coisa no código

Documento de referência rápida: para cada tela do NoPulso, onde fica o
arquivo, qual seção de permissão libera o acesso, e quais módulos do
backend ela consome. Serve pra achar rápido "onde mexo pra alterar a tela
X" sem precisar abrir `server/index.js` (quase 40 mil linhas) do zero.

## Como o projeto está organizado

```
server/
  index.js            rotas da API (quase todo o roteamento fica aqui)
  auth.js             login, sessão, permissões (requireAuth/requireSection/requireMaster)
  users.js            CRUD de usuários e permissões
  firestore.js         conexão com o Firestore (banco)
  liveCache.js         helper de cache em memória usado por quase todo módulo de domínio
  <dominio>.js        um módulo por área de negócio (rh.js, festas.js, grupos.js, parque.js, ...)
  public/
    <pagina>.html      uma página = um arquivo HTML com <script> inline (sem build step, sem framework)
    nav-gate.js         fonte única de verdade de quais links do menu aparecem pra cada permissão
```

Não tem framework de frontend nem bundler: cada página é um `.html` com
CSS/JS inline, autenticada via token JWT salvo em `localStorage`
(`authToken`) e mandado em toda chamada `fetch` como
`Authorization: Bearer <token>`. O padrão de todo módulo de domínio
(`rh.js`, `festas.js`, `parque.js`, `grupos.js`...) é: coleção própria no
Firestore + `createCache()` de `liveCache.js` + funções
`criar/listAll/listByUnidades/getOne/atualizar/remover`. As rotas HTTP
desses módulos ficam centralizadas em `server/index.js` (que faz
`require('./rh')`, `require('./festas')` etc. e chama as funções).

## Permissões: `nav-gate.js` é a fonte da verdade

`server/public/nav-gate.js` decide, no boot de qualquer página, quais
links do menu hambúrguer aparecem — objeto `REGRAS` mapeia
`id do link → seção(ões) de permissão que liberam`. Master e Admin veem
tudo. Um punhado de páginas (`usuarios.html`, `grupos.html`, `email.html`,
`entregas-regras.html`) são **Master-only** de verdade (a própria página
barra no `boot()` com `if (me.role !== 'master') { ... return; }`), fora
do esquema de seções.

## Tabela completa

| Página (menu) | Arquivo | Seção de permissão¹ | Módulo(s) backend | Rota base da API | Acesso | O que faz |
|---|---|---|---|---|---|---|
| Login | `index.html` | — | `auth.js`, `users.js` | `/api/auth/login`, `/api/me` | Pública | Tela de login + troca de senha obrigatória no 1º acesso. |
| Painel | `painel.html` | (sempre visível, sem seção própria) | quase todos — agrega KPIs de cada módulo | `/api/me`, `/api/central`, `/api/rh/checkins/abertos`, `/api/festas`, `/api/mensalistas`, `/api/inventario/*`, `/api/entregas`, `/api/fechamentos`, `/api/ifood/vendas`, `/api/abastecimento`, `/api/push/*` | Autenticada | Dashboard operacional inicial — página de entrada depois do login. |
| Monitor | `monitor.html` | `monitor` | `store.js`, `disputes.js`, `fraudMarks.js`, `refunds.js`, `push.js` | `/api/transactions`, `/api/orders/changed`, `/api/chargebacks`, `/api/fraude`, `/api/disputes`, `/api/refund-requests` | Autenticada | Monitor de transações Adyen, disputas, fraude e fila de estorno. |
| Relatórios | `relatorios.html` | `disputas` | `disputes.js`, `store.js` | `/api/disputes`, `/api/orders` | Autenticada | Consulta/relatório de disputas e pedidos. |
| Cofre | `cofre.html` | `cofre` | `vaultGroups.js`, `vaultSubgroups.js`, `vaultEntries.js`, `vaultExport.js` (usa `vaultCrypto.js`) | `/api/vault/groups`, `/api/vault/subgroups`, `/api/vault/entries` | Autenticada | Cofre de senhas (Grupo → Subgrupo → Senha) com export CSV/PDF. |
| Fechamentos (Faturamentos) | `fechamentos.html` | `fechamentos` | `fechamentosLive.js`, `fechamentosReport.js`, `grupos.js`, `sangrias.js`, `unidades.js` | `/api/fechamentos`, `/api/fechamentos/relatorio*`, `/api/grupos`, `/api/sangrias/minhas` | Autenticada | Dashboard + tabela + relatório CSV/PDF de fechamento de caixa por unidade. |
| Lançamento | `lancamento.html` | `lancamento` | `fechamentosLive.js`, `grupos.js`, `sangrias.js` | `/api/fechamentos/lancar`, `/api/grupos`, `/api/sangrias` | Autenticada | Formulário diário de lançamento de fechamento de caixa. |
| Entregas | `entregas.html` | `entregas` | `entregasLive.js`, `entregasSync.js`, `unidades.js` | `/api/entregas`, `/api/entregas/sincronizacao` | Autenticada | Dashboard/relatório de entregas por entregador e unidade. |
| Entrega Lançamento | `entrega-lancamento.html` | `entregas-lancamento` | `entregasLive.js`, `entregasRegras.js`, `unidades.js` | `/api/entregas/lancar`, `/api/entregas/regras` | Autenticada | Formulário de lançamento de entregas do dia por unidade. |
| Entregas · Regras | `entregas-regras.html` | **Master-only** | `entregasRegras.js`, `unidades.js` | `/api/entregas/regras` | Autenticada (Master) | Configuração de comissão/regras de entregadores por unidade. |
| iFood | `ifood.html` | `ifood` | `ifoodStore.js`, `ifoodSync.js`, `unidades.js` | `/api/ifood/vendas`, `/api/ifood/sincronizar` | Autenticada | Dashboard de vendas iFood por unidade + sincronização manual. |
| Central (lançador) | `central.html` | (sem seção — todo mundo lança) | `solicitacoes.js`, `refunds.js`, `grupos.js`, `unidades.js` | `/api/solicitacoes`, `/api/refund-requests` | Autenticada | Tela simples de abrir solicitação (compra/manutenção/TI/pagamento/nota/estorno). |
| Central · Histórico | `central-historico.html` | `solicitacoes` (+ `manutencao`/`tecnico` só leitura) | `centralCards.js` (agrega `solicitacoes.js`+`chamadosTI.js`+`chamadosManutencao.js`), `centralChat.js`, `grupos.js` | `/api/central`, `/api/central/enviar-email` | Autenticada | Kanban histórico/gestão de todos os tickets (solicitações, TI, manutenção). |
| Central · Soluções | `central-solucoes.html` | `central-solucoes` | `docsMaster.js`, `suporteChat.js` | `/api/central-solucoes` | Autenticada | Painel unificado de pendências do time de suporte (chat + docs). |
| Beniboy | `beniboy.html` | `suporte` | `suporteChat.js` | `/api/suporte-chats` | Autenticada | Kanban do atendimento do assistente Beniboy (N1/N2/N3). |
| Técnico | `tecnico.html` | `tecnico`/`suporte` | `chamadosTI.js`, `grupos.js`, `unidades.js` | `/api/chamados`, `/api/grupos/responsaveis` | Autenticada | Kanban de chamados de TI (abrir/iniciar/concluir/escalar presencial). |
| Manutenção | `manutencao.html` | `manutencao` | `chamadosManutencao.js`, `users.js` | `/api/chamados` | Autenticada | Kanban de chamados de manutenção (aceitar/iniciar/concluir/cobrança). |
| Ativos TI | `ativos-ti.html` | `ativos-ti` | `ativosTI.js`, `unidades.js` | `/api/ativos-ti` | Autenticada | Inventário de ativos de TI das lojas, vistorias por área. |
| Inventário/Estoque | `estoque.html` | `inventario` | `inventario.js` | `/api/inventario/*` | Autenticada | Catálogo, recebimento, saída e contagem de estoque. |
| Abastecimento | `abastecimento.html` | `abastecimento-carrinho`/`abastecimento-loja` | `abastecimentoCarrinho.js` | `/api/abastecimento*` | Autenticada | Fluxo de pedido/envio de carrinho de abastecimento entre lojas. |
| Parque | `parque.html` | `parque` | `parque.js`, `mensalistas.js`, `saltiversoImport.js` | `/api/parque/checkins`, `/api/parque/importar-planilha` | Autenticada | Dashboard/lista de check-ins do parque + importação de planilha. |
| Parque · Check-in | `parque-checkin.html` | `parque-checkin` | `parque.js` | `/api/parque/checkins` | Autenticada | Formulário de entrada/check-in de visitantes do parque. |
| Mensalistas | `mensalistas.html` | `parque` (reaproveitada) | `mensalistas.js` | `/api/mensalistas` | Autenticada | Gestão de clientes mensalistas (passaporte mensal do Saltiverso). |
| Festas | `festas.html` | `festas` | `festas.js` | `/api/festas` | Autenticada | Cadastro/gestão de reservas de festa. |
| **RH (BigBrother)** | `rh.html` | `rh` | `rh.js`, `rhCheckin.js`, `rhAdvertencias.js`, `unidades.js` | `/api/rh/funcionarios`, `/api/rh/checkins*`, `/api/rh/advertencias` | Autenticada | Colaboradores/Extras/Em Teste/Em Experiência, check-ins, advertências, aprovações. |
| RH · Check-in (quiosque) | `rh-checkin.html` | `rh` | `rhCheckin.js`, `rh.js` | `/api/rh/checkins` | Autenticada | Quiosque fixo de check-in/check-out por foto na entrada da loja. |
| Grupos | `grupos.html` | **Master-only** | `grupos.js`, `users.js`, `unidades.js` | `/api/grupos`, `/api/meta/unidades-extras` | Autenticada (Master) | Franquias/grupos: KPIs extras, canais/formas de pagamento, responsáveis, unidades. |
| Usuários | `usuarios.html` | **Master-only** | `users.js`, `sessions.js`, `backup.js`, `relatorios.js`, `relatorioMV.js`, `unidades.js` | `/api/users`, `/api/backups`, `/api/relatorios` | Autenticada (Master) | Gestão de contas/permissões, backups, relatórios administrativos. |
| E-mail (relatório MV) | `email.html` | **Master-only** | `relatorioMV.js`, `users.js` | `/api/relatorio-config` | Autenticada (Master) | Configuração do relatório diário automático por e-mail. |
| Ajuda | `ajuda.html` | (sempre visível) | `docsMaster.js` | `/api/ajuda/topicos-master` | Autenticada | Central de documentação/POP, filtrada por permissão de quem lê. |
| — | `alerta-beniboy.html` | — | nenhum (não chama API) | — | client-only | Tela de alarme sonoro/visual, parâmetros só via URL. |
| — | `atendimento.html` | — | `unidades.js` | `/api/meta/unidades` | **Pública** | Chat público direto com o Beniboy (widget), sem WhatsApp. |
| — | `decidir.html` | — | `solicitacoes.js` | `/api/solicitacoes/decidir*` | **Pública** | Link público pra quem pediu a solicitação aprovar/recusar um orçamento. |
| — | `estorno-cliente.html` | — | `refunds.js`, `unidades.js` | `/api/refund-requests/publico` | **Pública** | Formulário público de solicitação de estorno (link gerado pelo Beniboy). |
| — | `solicitacao-publica.html` | — | `solicitacoes.js`, `unidades.js` | `/api/solicitacoes/publico` | **Pública** | Formulário público de abertura de solicitação (compra/manutenção/TI/...). |

¹ Seção conforme `REGRAS` em `server/public/nav-gate.js` — usada tanto pra
mostrar/esconder o link do menu quanto (em conjunto com
`requireSection()` em `index.js`) pra liberar a rota da API.

## Observações

- **Páginas públicas** (sem login: `atendimento.html`, `decidir.html`,
  `estorno-cliente.html`, `solicitacao-publica.html`) são reconhecíveis no
  backend pelas rotas com sufixo `-publico`/`decidir-info`/`decidir`, sem
  `requireSection`/`auth.requireMaster` no `index.js`.
- **Master-only de verdade** (a própria página barra no `boot()`, fora do
  esquema de seções): `usuarios.html`, `grupos.html`, `email.html`,
  `entregas-regras.html`.
- **`/api/meta/unidades`** e **`/api/meta/unidades-extras`** (servidas por
  `unidades.js` + listas fixas hardcoded em `index.js`) aparecem em quase
  toda página só pra popular seletor de loja — não é módulo de negócio,
  é metadado compartilhado.
- **`central.html`/`central-historico.html`** não têm módulo backend
  próprio: agregam `solicitacoes.js` + `chamadosTI.js` +
  `chamadosManutencao.js` através de `centralCards.js`.
- Todo módulo de domínio novo (o próximo depois de `rh.js`, por exemplo)
  segue o mesmo esqueleto: coleção Firestore própria, `createCache()` de
  `liveCache.js`, funções `criar/listAll/listByUnidades/getOne/atualizar/
  remover`, rotas registradas em `index.js` com `requireSection('<nome>')`
  e a seção nova cadastrada em `users.js` (`VALID_SECTIONS`) +
  `nav-gate.js` (`REGRAS`).

## Checklist rápido: "eu quero adicionar uma página nova"

1. Módulo de dados: `server/<dominio>.js` (copie o esqueleto de
   `server/festas.js` ou `server/rh.js`, é o mais simples).
2. Seção de permissão: adicionar em `VALID_SECTIONS` (`server/users.js`).
3. Rotas: registrar em `server/index.js`, atrás de
   `requireSection('<dominio>')` (ou `auth.requireMaster` se for
   Master-only).
4. Página: `server/public/<dominio>.html`, copiando o nav-drawer completo
   de uma página existente (ex: `festas.html`) — cabeçalho padrão, gate de
   permissão no `boot()`, token no `fetch`.
5. Menu: adicionar `<a id="nav-<dominio>">` no nav-drawer (repetido em
   todas as páginas — normalmente feito com `sed` num loop) + entrada em
   `REGRAS` (`server/public/nav-gate.js`).
6. Se a página tiver card no Painel: registrar em `CARDS_POR_SECAO`
   (`painel.html`).
7. Documentar em `/ajuda.html` e atualizar este arquivo.
