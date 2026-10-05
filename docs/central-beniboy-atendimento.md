# Central Beniboy — mesa de atendimento

Acesse o portal público em `/atendimento` e a mesa da equipe em
`/atendimento/central`. O endereço antigo `/beniboy` continua compatível.
O usuário e senha são os do NoPulso, mas a mesa é exclusiva para Master ou
cargo Suporte/Técnico. Admin ou seção Suporte isolados não concedem acesso.
A autorização também é aplicada nas rotas de leitura e resposta.

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
Não há outro cadastro ou nova coleção de mensagens. Nenhum atalho é instalado
automaticamente nos computadores das unidades.

## Layout inspirado no atendimento GCOM

Cards com avatar, horário, faixa de status e protocolo; unidade em destaque
no cabeçalho; balões distintos para solicitante e suporte; caixa fixa de
mensagem e controles A−, A+ e Claro/Escuro ligados às preferências do NoPulso.
Enter envia, Shift+Enter quebra linha. A seta ao lado da mensagem seleciona
uma citação que acompanha o rascunho ao trocar de aba ou atualizar a lista.
A citação é enviada como texto, limitada a 500 caracteres, pelo endpoint
existente — não é um vínculo novo entre mensagens no banco. O × cancela.
Não foi adicionado botão de gravação de áudio sem implementação real.

## App / Atalho

O botão abre opções de instalação web (PWA), conforme suporte do navegador,
ou download opcional do atalho Windows em ZIP. Extraia o `.url` e mova-o para
a Área de Trabalho. O arquivo não contém token ou senha. A instalação web
abre uma janela própria; o atalho abre o navegador padrão. Nenhum é APK/EXE.
O manifesto principal permanece com entrada `/`; o da Central usa
`/atendimento/central`, identidade própria e escopo `/atendimento/`.
O login do atalho fica em `/atendimento/entrar` e volta à Central só para
quem tem acesso. A política NOC e a preparação obrigatória da conta continuam
valendo. As duas janelas compartilham a conta/sessão do mesmo navegador:
separar atalhos não significa criar sessões independentes.
O ícone amarelo/preto é renderizado do Beniboy original em `tema.js`, pelo
script `server/gerarIconesBeniboy.js`, sem manter outro desenho.

Visitantes escolhem “Iniciar atendimento sem login” e continuam informando
nome e telefone/e-mail. A Central não exige credenciais para pedir ajuda,
mas não expõe fila, notas ou conversas de terceiros ao visitante.

O sino da Central pede permissão de notificações e cria uma inscrição push
própria, sem substituir o registro do NoPulso. Esse registro recebe apenas
atendimentos. O envio verifica o cargo atual, incluindo revogação. Alertas
dependem de navegador compatível, conexão, permissão e políticas de bateria
do aparelho; não há garantia de entrega com navegador encerrado pelo sistema.
O service worker não armazena chats/senhas nem oferece atendimento offline.

O subdomínio `atendimento.nopulso.com.br` ainda depende de configuração
de DNS/Render; esta entrega não o publica nem altera o domínio do NoPulso.

## Atualização e custo

### Aviso de digitação

Central e widget mostram “Solicitante está digitando…” / “Suporte está
digitando…”. Nenhum texto é enviado antes da mensagem. Os pacotes aceitam
somente uma capacidade temporária e um booleano; campo `texto` é recusado.
Há no máximo um sinal positivo a cada 4 segundos, parada após 3 segundos
sem entrada, ao sair do campo/enviar/ocultar, e expiração de segurança em
8 segundos. O relógio do aparelho não precisa coincidir com o servidor.

`chatDigitando.js` mantém concessões e estado só em memória. As capacidades
imprevisíveis, específicas de conversa/lado/atendente, são fornecidas nas
consultas já autorizadas e expiram em 15 minutos; fechar a conversa revoga.
Reiniciar/deploy apaga o estado. Não concedem leitura de mensagens nem
permissões administrativas. O visitante só recebe a sua; atendimento mantém
o gate Master/cargo Suporte/Técnico. Vários atendentes são agregados sem que
a parada de um apague a digitação do outro.

O SSE de digitação é separado e direcionado à conversa, sem broadcast para
todo o suporte, push ou recarga da fila. Só permanece conectado enquanto o
campo estiver visível. Há limites de concessões, conexões e buffer; o helper
do widget é carregado sob demanda. Falha nesse recurso não impede mensagens.
Os sinais não leem/gravam no Firestore, nem alteram a frequência do poll
existente. Ainda consomem processamento e banda do Render — não custo zero.

Testes: `testeChatDigitando.js` (isolamento, expiração, sabotagem e SSE HTTP)
e `testeChatDigitandoVisual.js` (sigilo, rajada, aviso dos dois lados e
ocultação). A suíte de rotas mede dez sinais HTTP sem leitura adicional.

Reaproveita `/api/suporte-chats` e o ao vivo compartilhado do NoPulso.
Mantém a atualização de segurança a cada 60 segundos somente com a aba visível.
Chamadas simultâneas da fila são agrupadas. Filtros e troca de abas não fazem
consultas adicionais ao Firestore. Abrir várias abas continua tendo o custo
normal de cada página; isso não é uma promessa de custo zero.

Erros de rede mostram aviso e mantêm a lista anterior. Não há indicador
inventado de disponibilidade/online do atendente.

## Atendimento em aguardo e consulta de protocolo

O botão ⏳ “Deixar em aguardo” e o filtro “Em aguardo” mantêm a conversa
ABERTA, com responsável e histórico, fora do encerramento automático de
40 minutos. O solicitante recebe a informação no chat e pode falar novamente;
mensagens novas seguem o aviso normal ao suporte. ▶ retoma o atendimento;
somente as ações de conclusão encerram um atendimento em aguardo.

Pesquisar o protocolo na fila e abrir a conversa mostra “Resumo e últimas
respostas”. No chat, escrever “ticket #12345” ou “protocolo #12345” retorna
um resumo factual e as duas últimas respostas humanas, datadas, sem IA.
Não transmite notas internas, contato ou identidade do atendente. Outro
protocolo exige a conta autenticada vinculada à conversa ou acesso de suporte;
nome/telefone digitado ou número do ticket não são prova de identidade.
Conversas sensíveis concluídas continuam restritas. A consulta cobre protocolos
do chat Beniboy; não libera históricos de outras áreas por número.

Usa o cache de chats existente para referências a outro protocolo e a mesma
escrita de status para entrar em aguardo; o resumo enviado é uma mensagem
normal persistida. Não cria consulta periódica ou chamada extra de IA.
Testes HTTP em `testeAtendimentoAguardo.js` incluem controle negativo de
inatividade e sabotagem de autorização.

## Verificação

Áudios na Central usam player nativo com play/pausa e linha do tempo, na
mesma rota autenticada de anexos. Não baixam antes do play (`preload=none`).
Anexos antigos com MIME ausente/genérico são reconhecidos pela extensão de
áudio. Atualizar a conversa reaproveita o player; PDFs seguem como links.
O teste visual reproduz WAV válido e verifica retomada sem voltar ao início.

`server/testeCentralBeniboyVisual.js`: Chromium, interface real e APIs
simuladas, desktop 1440, tablet 1024 (Claro) e celular 390.
Verifica filtros, abas, envio, rascunhos, contexto, erros de rede, citação,
quebra de linha, tema, fonte, manifesto e conteúdo do atalho sem sessão,
botão Enviar visível e ausência de overflow. Sabotagem remove o estado do
rascunho/citação e confirma que as asserções reprovam a perda de estado.

Capturas em `docs/varredura/central-beniboy-*.png` (artefatos locais ignorados).
Nenhuma conversa ou mensagem foi criada em produção durante os testes.

Testes adicionais: `testePortalBeniboyVisual.js` (nome/contato, acesso,
recusa sem substituir sessão e três tamanhos), `testePortalBeniboy.js`
(HTTP real contra banco simulado, cargo e revogação) e
`testeBeniboyPush.js` (envios simulados, cargos atuais e isolamento).
Publicação no Git não efetua deploy: Render permanece em Manual Deploy.
