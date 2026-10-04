# Acesso normal do NoPulso — agente v140

O portal Chat da Unidade foi retirado. O acesso NoPulso permanece na página normal de login; o suporte público solicita nome e telefone ou e-mail, sem identificar automaticamente o visitante como colaborador.

Links antigos `/unidade` redirecionam para `/`. As antigas APIs de vínculo de unidade retornam 410. A limpeza dos marcadores locais não remove o token de login nem o histórico do suporte.

O agente v140 não cria atalho de chat. Restaura apenas o atalho registrado e alterado pelo launcher anterior, usando o backup original quando disponível. Sem backup, o mesmo atalho abre a página normal do NoPulso. Em hosts e máquinas silenciosas, remove apenas esse atalho especial. Valida o caminho na Área de Trabalho antes da alteração; outros atalhos não são removidos.

As regras de login restrito a máquinas NOC e as proteções de Windows Antigo continuam. A atualização do agente segue o rollout de pilotos existente; publicar o servidor não atualiza instantaneamente todas as máquinas.

Verificação: `testeAcessoNormal.js`, `testeWindowsAntigoSilencioso.js`, `testeLoginNoc.js`, teste HTTP em `testeRotas.js` e varredura visual antes/depois. A suíte geral já apresentava 64 falhas anteriores, independentes desta correção.
