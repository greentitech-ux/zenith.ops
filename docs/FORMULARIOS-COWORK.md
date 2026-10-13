# Formulários pelo Cowork

## Criação e reenvio

- Uma intenção nova usa uma `idempotencyKey` nova. `criar_formulario` em modo `link` não reaproveita pendências da mesma unidade/tipo/autor.
- Uma repetição da mesma intenção usa a mesma chave e os mesmos parâmetros.
- Para reenviar: `gerar_link_formulario({formularioId})` ou `{numero}`. Mantém o documento e o token válido; `regenerar:true` revoga o token anterior. Validade dos links novos: sete dias.
- Aceita RASCUNHO e AGUARDANDO_PREENCHIMENTO sem assinaturas. O papel deve corresponder ao preenchedor do modelo; não concede assinatura de Master pelo link público.
- `linkValidado:false` significa documento salvo, mas URL pública indisponível/expirada. Não criar outro: consultar/gerar o link do mesmo ID.
- Dados previamente lançados ficam preservados. O destinatário complementa os campos vazios e acrescenta comprovantes; não altera beneficiário, itens ou valores já informados.

## Origem e financeiro

`origem:{tipo:'chat'|'solicitacao'|'tarefa',numero}` identifica o atendimento. A unidade precisa corresponder. Em estornos, permanece obrigatória a origem financeira aprovada (`numero`); o atendimento adicional é salvo em `origemAtendimento`, sem substituir o estorno.

`criar_formulario({tipo:'avulso',numero:12123,modo:'link'})` copia uma solicitação de pagamento aprovada e não finalizada: unidade, favorecido, descrição, valor e anexos. Registra a mudança para Pix, preservando o boleto anterior no histórico.

Criação, assinaturas, PDF assinado e protocolo Conecta geram registros internos na origem. Na conclusão das assinaturas, a execução do pagamento vai para EM_ANDAMENTO, nunca para FINALIZADO. Assinatura e envio ao Conecta **não comprovam pagamento**.

PDF do chat é acessível somente à equipe autorizada, pela rota autenticada do chat correspondente. Não aparece na conversa pública. As autorizações existentes do Master continuam obrigatórias para sua assinatura.

Falha ao anexar PDF não perde a assinatura: `sincronizacaoPendente:true` é persistido. `obter_formulario` tenta novamente; notas/anexos usam marcadores para não duplicar. Não há novo agendamento de retentativas neste patch.

## Cancelamento e vínculo

- `cancelar_formulario({numero,motivo})` cancela rascunho/aguardando não assinado e não enviado; mantém conteúdo e motivo, revoga links.
- `vincular_formulario({formularioId|numero,origem})` vincula um documento existente sem duplicá-lo. Recusa transferir um documento já pertencente a outro atendimento.

## Registros reais — ainda não alterados

Depois do deploy e da conferência autenticada:

1. Conferir #12510 e #12511 (avulso, Spoleto Shopping Recife, R$ 90). Cancelar #12510 somente se continuar duplicado não assinado/não enviado, referenciando #12511 no motivo.
2. Conferir beneficiário/unidade/valor do #12511 e da solicitação #12123 antes de vincular. O vínculo de um documento existente não converte por si só a modalidade financeira; revisar a modalidade no processo já existente.
3. Não transferir automaticamente #12382: o relato indica criação para Julia/#12379 e reenvio indevido para Ivanildo/Paulo/#12493. Conferir conteúdo/assinaturas/destinatário e decidir com o Master se preserva o original e cria um documento correto para #12493.

## Verificação local

### Correção da empresa emitente

Em **Formulários → Editar**, o Master pode selecionar outra empresa/unidade cadastrada e ativa, informar o motivo e salvar. A mesma rota autenticada de correção recebe `unidade` e `motivoEmpresa`; nenhum campo enviado pelo navegador pode substituir o autor da auditoria.

A correção mantém ID, protocolo, favorecido, itens, valores e anexos, atualiza código da unidade/razão social/CNPJ e registra antes/depois, data, autor e motivo em `historicoEmpresas`, visível no editor. Assinaturas anteriores são invalidadas e os links refeitos; links de preenchimento anteriores são revogados. Rascunho permanece rascunho.

Cancelados/aguardando preenchimento conservam as restrições existentes. Se já enviado ao financeiro/Conecta, regularizar o envio antes da troca; se vinculado a atendimento, a unidade de origem deve corresponder ao destino. Não move solicitações financeiras nem atendimentos entre empresas automaticamente. Uma transação recusa salvar se o documento mudou durante o processamento da correção.

- `node testeFormularioEmpresa.js`: rota real, Master versus usuário comum, campos fiscais, histórico, vínculos, revogação de assinaturas e envio concorrente.
- `node testeFormularioEmpresaVisual.js`: editor real em celular/desktop, motivo obrigatório e transmissão da empresa selecionada. Ambos possuem `--sabotagem`.

- `node testeFormulariosCowork.js`: casos do pedido, idempotência, preenchimento, rotação/cancelamento, origem, assinatura, retentativa Storage, PDF protegido e financeiro.
- `node testeFormularioComplementoVisual.js`: página real em 390 e 1366 px, dados fictícios e rede interceptada.
- Ambos aceitam `--sabotagem`: introduzem a regressão em memória e devem falhar.
- `node testeRotas.js`: suíte geral. A comparação deste trabalho passou de 73 para 72 falhas preexistentes; o teste de formulário público passou. A suíte geral ainda não está verde.

Não publica nem altera dados reais ao executar os testes.
