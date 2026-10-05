# Permissões das saídas avulsas

Não há migração nem troca automática de autor em lançamentos existentes.

- Novas saídas usam ID, e-mail e nome do usuário autenticado no servidor; o cliente não escolhe o autor.
- Master pode corrigir quem lançou, descrição, valor, unidade e data.
- Admin pode corrigir descrição, valor, unidade e data e excluir a saída, somente nas unidades permitidas. Alteração de autor é exclusiva do Master, inclusive via API.
- Exclusão direta mantém registro e histórico, retirando a saída dos cards e dos totais. Não exclui o fechamento.
- Mudar unidade/data move somente a saída. Para lançamentos nativos, o destino precisa ter fechamento. Origem e destino são atualizados na mesma transação, com ajuste dos totais e invalidação do cache.
- Índices existentes não são removidos nem reordenados: verificação e reclassificação de outras saídas continuam apontando para os mesmos itens.
- Saídas importadas da planilha recebem correção auditada à parte; a planilha original não é reescrita.
- Os outros perfis continuam usando a fila de pedido de correção existente. Não foi criado novo fluxo de aprovação de cancelamento: Master/Admin têm exclusão direta.

## Uso

Painel de Saídas → Editar. Master/Admin veem Unidade, Data, Valor e Excluir. Somente Master vê Quem lançou. A operação só altera o registro depois de Salvar/confirmar Excluir.

## Verificação

`node server/testeSaidaAvulsaPermissoes.js` verifica as regras reais, transação, autor legado preservado, criação autenticada, exclusão, histórico, JS inline e sabotagem do bloqueio de autoria para Admin.

O mesmo teste integra `testeRotas.js` com HTTP autenticado e banco falso. Não há acesso a dados de produção nesses testes.

Validação local: teste dedicado e HTTP autenticado passaram, incluindo sabotagem. A suíte geral continua com 63 cenários com problema (mesmo total observado antes desta mudança); não está totalmente verde. Varredura da página em celular/desktop: 2 capturas, nenhum problema geométrico/JS detectado. A prancha está em `docs/varredura/prancha.html` (artefato local ignorado pelo Git).
