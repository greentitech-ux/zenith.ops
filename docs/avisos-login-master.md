# Avisos de entrada no sistema

Um login concluído por senha ou biometria avisa somente as conexões autenticadas do Master principal. Não entrega para Master secundário, QA Master ou funcionário e não avisa o próprio login do principal. Falha de senha, atualização, navegação e reconexão SSE não disparam aviso.

O aviso mostra nome e horário; unidade e posto aparecem apenas quando comprovados pela validação NOC já feita no login. Para acessos autorizados fora do NOC, identifica que o dispositivo não foi reconhecido, sem atribuir uma unidade por inferência.

É uma notificação interna temporária, fechável e removida após 10 segundos. Não abre janela do Windows, não envia push/e-mail e não grava histórico nem presença no Firestore. Se o Master estiver com o NoPulso fechado ou desconectado, não há entrega posterior. Não significa presença online contínua.

Reaproveita o SSE compartilhado por página; não cria polling. Em página Master sem SSE ainda aberto, a assinatura usa uma conexão. O custo adicional é tráfego curto do aviso por conexão Master, não uma leitura/escrita no banco por entrada. Nomes de unidades usam a configuração em memória já carregada.

Verificação: testeAvisosLogin.js (autorização/sabotagem e HTTP/SSE real na suíte testeRotas.js), testeAvisosLoginVisual.js (celular/desktop, foco, duplicatas e texto seguro) e varredura visual antes/depois. A suíte geral tinha 64 falhas pré-existentes.
