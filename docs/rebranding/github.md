repo: greentitech-ux/zenith.ops
branch: master
path: server/public

## Last sync
date: 2026-08-23T18:20:00Z

### Updated in this project
- Mockups NoPulso criados a partir do design atual do Zenith Ops (tokens dark, KPIs em mono, painéis, tabela densa).
- Novo acento verde-limão (#b8ff3c) substituindo o ciano #5cc8ff como cor de ação/meta; ciano mantido para dado técnico.
- Telas cobertas: Login, Painel, Fechamento de caixa, celular da loja e tablet do abastecimento.
- Painel refeito sobre o shell real (hamburguer + drawer do nav-menu.js), com os grupos e rótulos reais do menu.

### Revisão de produção
- tema.js já está rebrandeado no repo (fontes NoPulso injetadas + paleta clara com --accent #5b8c00 e --accent2 #0d7ac2).
- Riscos e regras (usar var(--accent), não renomear chaves de localStorage nem ids do menu, fontes locais em vez de CDN, teste de largura de tabela com Archivo) documentados no handoff.

### Aterramento de vocabulário
- Status/colunas/verbos lidos de: solicitacoes.js, refunds.js, chamadosTI.js, chamadosManutencao.js, decidir.html, reportExport.js, monitor.html, loja-status.html, tecnico.html, notif-central.js.
- Nenhuma tela com selo PROPOSTA: 2e (abas + diferenças/CMV), 2f (abas do rh.html, experiência 30/60, alertas trabalhistas), 2h (NOMES_CAMPOS_FECHAMENTO completo), 3j (Quem está no parque agora, tempo esgotado, adicionar tempo), 3k (tabela 30/60/90/120 com preços, meia R$25, formas de pagamento), 3l (dias cobertos, envios sem conferir, perda em trânsito, saída apurada) todas aterradas no código.
- Aterrados nesta rodada: badge ativo/expirado de mensalistas.html e "➕ Adicionar tempo (30 a 120min)" de ajuda.html.

## Sync history
- 2026-08-23T14:52:00Z — primeira leitura (docs, index.html, entregas.html) e criação dos mockups.

### Turno 4
- 4a detalhe do card da Central (conversa do card, anexos, decidir, link público) — central-historico.html, solicitacoes.js, decidir.html.
- 4b estados de exceção com as mensagens reais (vazio, carregando, sem permissão).
- 4c Abastecimento Carrinho: pré-envio pós-contagem, Pedido/Envio/Contagem, avarias, popups de recebimento e de contagem — abastecimento.html, ajuda.html.
- 2h ganhou o bloco "📷 Preencher por foto do relatório do PDV" (canaisVendaOcr.js): campos travados com fundo cinza, ✏️ para manual, aviso de divergência.

### Turno 5 (menu 100% coberto)
- 5a Lançar entrega + Regras de Entregas — entrega-lancamento.html (NOMES_CAMPOS), entregas-regras.html (campos de valor, destinos, modo Plataforma).
- 5b Central de Soluções (kanban por assunto, origem 💬 Widget site / 🎫 Solicitação·Chamado, ABERTO/FINALIZADO) + Dashboard de Atendimentos (Total, Humanizados, Via Beniboy, Em aberto agora, tempo médio de resposta/resolução, por dia, por hora, por atendente, por assunto) — páginas lidas.
- 5c Saúde das Máquinas (barra de volume crítico, 🌡️ temperatura, 🔁 sem reiniciar Xd, ⏳ anos de disco, 🕐 medido há, detalhes do disco) + alerta do Beniboy (gradiente vermelho, "Beniboy precisa de você", 🎧 Atender agora / 🔕 Silenciar, variante ?tipo=seguranca) — páginas lidas.
- 5d Fechamento do balcão + ticket público + auto-cadastro do RH — saltiverso-fechamento.html, ticket-publico.html, rh-cadastro.html, documentoIdentidadeOcr.js.

### Turno 6 — Beniboy
- 6a marca do assistente: avatar circular com a polyline da marca, 4 estados por cor, escala de tamanhos, ícone de push e regra de tom de voz.
- 6b aplicações: widget de chat, avatar de mensagem, menu e cabeçalho da Central, tela de alarme, e o login sem o robô.

### Turnos 7 e 8 — Beniboy
- 7a/7b alternativas de recipiente (balão de conversa, pastilha) ao lado do avatar circular de 6a; prós e contras anotados.
- 8a demo interativa (logica no DC): sinal vital com ritmo por estado, alternância sem login × logado — fluxo real de atendimento.html/suporte-chat.js (?unidade= no link/QR entrega o nome da loja; link solto, o bot pergunta).

### Última atualização enviada ao Claude Code
- Beniboy fechado na opção 1 (avatar circular). Alternativas 7a/7b marcadas como "não escolhida" no mockup.
- Animação: linha base SÓLIDA + brilho curto correndo (logotipo e cartões de estado). O traçar-e-apagar ficou só na demo ao vivo 8a. CSS pronto no BENIBOY.md §2 e §8.
- Login perde o robô; o balão de mensagem fica.
- Apresentação de lançamento (15 slides) + assets inclusos no pacote.

## Screen map
| Tela no projeto | Arquivos do repo |
|---|---|
| 1a Login | server/public/index.html |
| 1b Painel | server/public/painel.html, server/public/nav-menu.js (MENU, drawer, estados) |
| 1c Fechamento de caixa | server/public/fechamentos.html, server/public/entregas.html (padrão de KPIs/tabela) |
| 1d Mobile + tablet abastecimento | server/public/abastecimento.html, server/public/central-historico.html |
| 2a Central · Histórico | server/public/central-historico.html, server/public/centralCards.js |
| 2b Chamados TI | server/public/tecnico.html |
| 2c Monitor | server/public/monitor.html |
| 2d Entregas | server/public/entregas.html |
| 2e Estoque | server/public/estoque.html |
| 2f RH (BigBrother) | server/public/rh.html |
| 2g NOC | server/public/loja-status.html, server/public/noc-rede.html |
| 2h Lançamento | server/public/lancamento.html |
| 3a Central | server/public/central.html, usuarios.html (TIPOS_SOLICITACAO) |
| 3b Manutenção | server/public/manutencao.html (STATUS_LABEL), chamadosManutencao.js |
| 3c Compras | server/public/compras.html (ETAPAS_LINHA) |
| 3d Beniboy | server/public/beniboy.html, server/suporteChat.js |
| 3e Relatórios/Disputas | server/public/relatorios.html, server/disputes.js |
| 3f iFood | server/public/ifood.html |
| 3g KPI's + Recordes | server/public/kpis-operacionais.html, vendas-recordes.html |
| 3h Cofre + Ativos TI | server/public/cofre.html, ativos-ti.html |
| 3i Formulários | server/public/formularios.html, assinar.html |
| 3j Saltiverso | server/public/parque.html, mensalistas.html, festas.html |
| 3k Quiosques | server/public/parque-checkin.html, rh-checkin.html, saltiverso-vendas.html |
| 3l Carrinho + Rede | server/public/abastecimento-relatorios.html, noc-rede.html |
| 3m Usuários + Grupos | server/public/usuarios.html, grupos.html (AREAS_LABEL) |
| 3n Alertas + E-mail + Login | server/public/central-alertas.html (TIPOS), email.html, login-custom.html |
| 3o Públicas | server/public/estorno-cliente.html, decidir.html, atendimento.html, solicitacao-publica.html |
| 3p Ajuda | server/public/ajuda.html |
| Contexto geral | docs/CONTEXTO.md, docs/MAPA_PAGINAS.md |
