# Rebranding NoPulso — regras de trabalho

Trecho pronto para colar no `CLAUDE.md` do repositório `greentitech-ux/zenith.ops`.
Referência completa: `docs/rebranding/README.md` (este pacote) e os mockups em
`NoPulso Mockups.dc.html`.

---

## Rebranding NoPulso (visual apenas — nada de backend muda)

O produto se chama **NoPulso**. O acento da marca é o verde-limão `--accent`
(`#b8ff3c` no tema Escuro, `#5b8c00` no Claro) para **ação e meta**; o ciano
`--accent2` (`#5cc8ff` / `#0d7ac2`) fica reservado para **dado técnico**.
Títulos em **Archivo**, números/rótulos/badges em **JetBrains Mono** com
`font-variant-numeric: tabular-nums`. Fundo, painéis e linhas não mudaram
(`#0b0d10` / `#12161b` / `#181d24` / `#232a33`).

### Regras que não podem ser quebradas (tudo está em produção)

1. **Nunca cravar o hex do acento no CSS.** Sempre `var(--accent)` /
   `var(--accent2)`. O tema Claro existe (`:root[data-tema="claro"]` no
   `tema.js`) e o limão puro é ilegível sobre branco — hex cravado quebra a
   tela no modo Claro.
2. **Não renomear chaves de `localStorage`:** `authToken`,
   `zenithMonitorFixo`, `zenithAbertoDesde`, `zenithTema`, `zenithFonte`,
   `centralSecao`. Renomear `zenithMonitorFixo` faz os computadores das lojas
   esquecerem qual unidade/posto monitoram — a loja passa a acusar offline.
   São nomes internos, não marca visível.
3. **Não renomear ids do menu** (`nav-painel`, `nav-fechamentos-gbe`, …): são
   a chave da regra de permissão em `aplicarRegras()` no `nav-menu.js`.
   Trocar rótulo é seguro; trocar id esconde link de quem tem acesso.
4. **`manifest.json`:** `name`/`short_name`/ícones podem mudar; `start_url`
   continua `"/"` — o heartbeat depende de reabrir a raiz e ler a unidade
   salva no próprio navegador.
5. **`<meta name="theme-color">` continua `#0b0d10`.**
6. **Cores semânticas não são marca:** `--ok` / `--warn` / `--bad` e os
   marcadores 🟢🟡🔴 do NOC e dos alertas ficam como estão. Repintar status
   com o limão apaga a leitura de gravidade — que é justamente o que a
   operação usa para decidir.
7. **Relatórios e e-mails têm hex próprio** (`relatorioMV.js` `STATUS_COR`,
   `fechamentosReport.js`, `fraudReport.js`, `vaultExport.js`): não são
   afetados pelo CSS e não mudam comportamento. Rebrandeá-los é opcional e
   independente.
8. **Fontes:** preferir servir Archivo e JetBrains Mono de
   `server/public/fonts/` com `@font-face` local em vez do Google Fonts. A
   frota tem piso de latência ~1.1s e máquinas caindo; CDN é dependência
   externa no caminho crítico e pode ser barrada por proxy de loja.
9. **Archivo é mais larga que a fonte de sistema.** As telas medem tudo em px
   e o A+/A− aplica `zoom` no `<html>`. Antes de subir, testar
   `fechamentos.html` (10 colunas + `white-space:nowrap`) e `monitor.html` a
   1366×768 com fonte em 100% e 130%.
10. **Nada de backend:** sem rota nova, sem coleção nova, sem leitura extra no
    Firestore (logo, sem risco de `RESOURCE_EXHAUSTED`). Ainda assim, rodar
    `server/testeRotas.js` antes de qualquer merge — ele varre todos os
    `.html` e falha se alguma página autenticada perder o token.
11. **Não reabrir o que já foi resolvido.** O mapeamento da planilha (AdyenV2 → campo `pix`, rotulado "Adyen"; colunas de máquina somadas em `adyen` = "Maquininhas (total)"; `somarMaquininhas` no `bravoImport.js`) e a unificação dos códigos de unidade estão **fechados** — decisão do Master. Não alterar mapeamento, rótulo ou destino de campo, e não escrever migração nova sobre dado antigo: o histórico precisa continuar legível exatamente como está. Rebranding mexe em cor, fonte e nome — nunca em para onde o número vai.
12. **Não tocar nos espaços de código de unidade:** `migracaoUnidades.js`,
    `normalizarCodigoUnidade()`, `UNIDADES_APELIDOS`, `merchantAccountCode` da
    Adyen, nem nos 3 testes de fold do `testeRotas.js`. É rebranding visual; o
    dado continua igual e o histórico continua acessível.

### Vocabulário: usar o que já existe no código

Ao mexer em qualquer tela, os status, colunas e verbos vêm do próprio código —
nunca inventar rótulo novo:

- Solicitações/estornos: `PENDENTE`, `APROVADO`, `REJEITADO`, `CONVERTIDO`
  (`solicitacoes.js`, `refunds.js`; colunas do kanban em `central-historico.html`).
- Chamados de TI: `ABERTO`, `INICIADO`, `CONCLUIDO`, `CANCELADO` + remoto ×
  presencial e triagem N1/N2 (`chamadosTI.js`, `tecnico.html`).
- Manutenção: Aguardando aceite / Recusado / Aceito / Em execução / Em espera /
  Finalizado / Cancelado (`manutencao.html` `STATUS_LABEL`).
- Compras: `aguardando` → `aprovada` → `comprada` → `entregue` (`compras.html`).
- Disputas: `MONITORANDO`, `ABERTA`, `ENVIADA`, `GANHA`, `PERDIDA`,
  `ERRO_SISTEMA` (`disputes.js`).
- Beniboy: `PENDENTE`, `EM_ATENDIMENTO`, `TRANSFERIDO`, `TICKET_CRIADO`,
  `RESOLVIDO`, `SEM_SOLUCAO` (`suporteChat.js`).
- NOC: `nunca` / Operacional / degradado / Indisponível — quatro estados
  disjuntos (`loja-status.html` `statusDe()`); "culpa: servidor" vem do
  `redeDiagnostico.js`.
- Fechamento: campos de `NOMES_CAMPOS_FECHAMENTO` (Caixa inicial/final,
  Delivery, Carryout, Pickup, Loja (salão), Maquininhas (total), Maquininha POS
  01 (pós meia-noite), Adyen, Pix CNPJ, Outros, Total de saída, Faturamento
  total, Total declarado, Quebra de caixa, TC, Cancelados). Correção só por
  Central → Histórico → 🧾 Fechamentos → Pedir correção.
- Monitor: colunas de `reportExport.js` (data/hora, unidade, status, portador,
  método, final, valor, motivo, PSP Reference); unidade no espaço Adyen
  (`DOM_19706`, `Mooca`).
- Tipos de solicitação com ícone: `usuarios.html` `TIPOS_SOLICITACAO`;
  áreas: `grupos.html` `AREAS_LABEL`.

### Tom de voz

Notificação e alerta são **diretos e específicos**, sempre com o fato e o
número: "Diferença de caixa detectada", "3 de 14 unidades faltando lançar",
"Latência acima de 1000ms em 8 máquinas", "⚠ saída negativa - sobrou mais do
que entrou: provável contagem ou envio não lançado". Nunca "Ops, algo deu
errado".

### Ordem de implementação

1. Tokens + fontes (`:root` das páginas + `tema.js`) e os `rgba` de ciano
   cravados fora do token (`a.back.active`, `.nmz-item.active`,
   `.painel-sugestao`, gradiente do login).
2. `nav-menu.js`: marca do drawer e cor do item ativo — pega as ~53 páginas de
   uma vez.
3. `index.html` (login), assets, `manifest.json`, `<title>` das páginas.
4. `painel.html`, `fechamentos.html`, `abastecimento.html` — maior uso.
5. Varredura do restante só para tokens e `<title>`.
6. `server/testeRotas.js` antes de qualquer merge.
