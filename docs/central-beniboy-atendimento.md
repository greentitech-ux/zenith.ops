# Central Beniboy — mesa de atendimento

Acesse **Central do Beniboy** pelo menu ou `/beniboy`. O botão ↗ no
cabeçalho abre uma aba exclusiva, paralela aos outros painéis do NoPulso.
O login e as permissões continuam os mesmos: Master, Admin ou seção Suporte.

## Organização

- Fila à esquerda: conversas abertas por padrão; busca por nome, contato,
  assunto, unidade ou protocolo. Filtros locais de status, unidade,
  meus atendimentos e desbloqueios.
- Conversa ao centro: abas dos atendimentos abertos, uma conversa visível
  por vez. Trocar de aba preserva resposta, arquivo e posição de leitura.
- Contexto à direita: solicitante, contato, unidade, responsável, protocolo,
  tickets, notas internas e alertas de segurança (estes continuam Master-only).
- Em tablet/celular, **Dados da conversa** abre o contexto e **← Fila** volta
  à lista. Não é necessário sair da central para alternar atendimentos.

As ações de assumir, transferir N1/N2/N3, resolver, encerrar sem solução,
reabrir, gerar tarefa, anexar/colar print e baixar PDF foram preservadas.
O visitante continua no chat atual, informando nome e telefone/e-mail.
Não há outro cadastro, novo atalho de Windows ou nova coleção de mensagens.

## Atualização e custo

Reaproveita `/api/suporte-chats` e o ao vivo compartilhado do NoPulso.
Mantém a atualização de segurança a cada 60 segundos somente com a aba visível.
Chamadas simultâneas da fila são agrupadas. Filtros e troca de abas não fazem
consultas adicionais ao Firestore. Abrir várias abas continua tendo o custo
normal de cada página; isso não é uma promessa de custo zero.

Erros de rede mostram aviso e mantêm a lista anterior. Não há indicador
inventado de disponibilidade/online do atendente.

## Verificação

`server/testeCentralBeniboyVisual.js`: Chromium, interface real e APIs
simuladas, desktop 1440, tablet 1024 (Claro) e celular 390.
Verifica filtros, abas, envio, rascunhos, contexto, erros de rede,
botão Enviar visível e ausência de overflow. Sabotagem remove o estado do
rascunho e confirma que a asserção reprova a perda de texto.

Capturas em `docs/varredura/central-beniboy-*.png` (artefatos locais ignorados).
Nenhuma conversa ou mensagem foi criada em produção durante os testes.
