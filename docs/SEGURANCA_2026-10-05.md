# Revisão de segurança — 4 e 5 de outubro de 2026

## Resultado e limites

Foram corrigidas falhas confirmadas na autenticação, nos anexos públicos e nas notificações. A revisão é de código e testes locais com banco/arquivos simulados: não é uma certificação de ausência de vulnerabilidades nem um teste de intrusão em produção. Nenhuma chave real foi exibida, rotacionada ou enviada; nenhuma conta de cliente foi alterada.

## Correções

- **Uploads órfãos:** abertura do chat valida nome, contato e texto antes de gravar. Mensagem valida conversa, token, estado e quantidade de mensagens antes do Storage. Campos multipart têm limites de quantidade/tamanho.
- **Conteúdo ativo na origem do sistema:** HTML, SVG e outros formatos não confiáveis são entregues como download `application/octet-stream`, com `nosniff` e CSP sandbox. PNG/JPEG, PDF, áudio e vídeo continuam inline. O chat público de ticket também recusa formatos proibidos antes da gravação.
- **SSRF em push:** somente HTTPS e hosts conhecidos de provedores de push são aceitos, sem credenciais, portas alternativas ou fragmento; chaves têm formato/tamanho conferidos. Inscrições antigas inválidas não são usadas para envio.
- **Renovação de push:** exige inscrição anterior existente, dono e prova de posse do segredo `auth`. Não permite criar inscrições anônimas pela rota de migração nem substituir inscrição de outro dono.
- **Identificadores de push:** SHA-256 substitui base64 truncado, evitando colisões de prefixo. Leitura de registros legados confere o endpoint exato.
- **Exclusão de push:** um usuário não pode excluir a inscrição de outra conta.
- **Permissões de alertas:** privilégio gravado na inscrição não basta; a conta atual precisa continuar ativa, desbloqueada e com permissões correspondentes. Reusa cache de autenticação de 15 segundos, invalidado pelas edições locais; não cria polling. Há leituras por dono quando o cache expira, portanto não se promete custo adicional zero.
- **Senha temporária:** APIs ficam bloqueadas até a troca obrigatória; identificação e troca de senha continuam disponíveis. O contexto opcional do chat não recebe privilégios enquanto a troca estiver pendente.
- **Bloqueio da conta:** autenticação recusa contas bloqueadas. Ao bloquear por tentativas erradas, invalida o cache e encerra as sessões do usuário.
- **Token de API:** permitido apenas pelo header Authorization; parâmetros de URL não são registrados no log de auditoria.
- **Contexto do bot:** a próxima mensagem sem sessão válida limpa privilégios anteriores da conversa; mudanças de permissões na mesma conta atualizam o contexto. A autenticação opcional também respeita horário de acesso.
- **Notificações:** clique no worker principal restringe navegação à mesma origem, incluindo bloqueio de URLs `//externo`.
- **Dependências:** oito pacotes com avisos conhecidos foram atualizados (incluindo transitivos). A consulta posterior ao registro oficial npm examinou 360 pacotes e encontrou zero pacotes com avisos nessa consulta. Isso não prova ausência de falhas desconhecidas.

## Verificação

Passaram os testes locais `testePushSeguranca.js`, `testeArquivosSeguranca.js`, `testeBeniboyPush.js` e a execução HTTP focada `TESTE_SEGURANCA=1 node testeRotas.js`. Cobrem destinos internos/falsos, chaves inválidas, migração desconhecida/sem segredo, colisões, dono da inscrição, revogação, anexos ativos, uploads não autorizados, senha temporária, bloqueio, token em URL e contexto de logout. A sabotagem da allowlist é executada em memória: remover a trava faz a asserção falhar.

Também passaram a interface da Central em desktop/tablet/celular, o portal separado e o worker Beniboy. A barra vazia mostra microfone; texto ou anexo pendente mostra Enviar. Gravação usa permissão explícita do navegador, tem limite de dois minutos/8 MB, permite descarte e encerra as trilhas de microfone. O player de áudio foi preservado.

A suíte geral terminou com **63 testes falhando**. A execução comparativa com o código anterior em memória também terminou com 63 falhas. Dois testes incompatíveis foram corrigidos: um aprovava o log da URL completa, substituído por verificação comportamental de sigilo; outro só aceitava LF e foi ajustado para CRLF do Windows. A suíte geral NÃO está inteiramente verde.

## Pendências externas e operacionalização

- Confirmar a cadeia de proxies e o tratamento de X-Forwarded-For no Render antes de alterar o vínculo NOC e os limites por IP. Não foi comprovada exploração no proxy de produção, nem alterado esse vínculo com suposições.
- Verificar IAM, regras Firestore/Storage, backups, exposição de segredos, logs históricos, TLS e dispositivos reais em uma revisão da infraestrutura. Não foram auditados nesta rodada.
- Se o token de API já foi usado pela query, ele pode constar em logs antigos; verificar e rotacionar pelo fluxo seguro. Não houve confirmação de vazamento em produção.
- JWTs legados sem identificador de sessão continuam sujeitos à política de compatibilidade existente; não foi comprovada a existência de tokens desse tipo ainda válidos. Avaliar sua aposentadoria com planejamento de logout.
- As proteções de anexos não substituem antivírus nem inspeção do conteúdo de ZIPs. O servidor não extrai nem executa esses arquivos.
- Publicação no Git não é deploy: o Render está com deploy automático desativado. Usar Manual Deploy e depois validar login, anexos, áudio e alertas reais. Se a inscrição push não renovar, entrar novamente e reativar o sino.

## Referências

- [OWASP: prevenção de SSRF](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html).
- [OWASP: uploads seguros](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html).
- Consulta de dependências: registro oficial `registry.npmjs.org`, endpoint de advisories bulk; script `server/auditarDependencias.js`. Envia somente nomes e versões dos pacotes.
