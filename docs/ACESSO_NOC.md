# Login limitado a computadores NOC

## Regra

- Campo `somenteNoc` ausente ou marcado: acesso exige navegador validado pelo agente.
- Sem tag de função válida: continua exigindo NOC, mesmo com o campo desmarcado.
- Tag válida + campo desmarcado pelo Master: permite outros dispositivos, mantendo senha, biometria e permissões pessoais.
- Apenas o Master principal identificado pela hierarquia mantém acesso de recuperação sem esse vínculo. Outra conta Master não herda a exceção.
- Senha, passkey, sessões existentes e identificação opcional usam a mesma verificação. Mudanças de tags/política fecham as conexões ao vivo da pessoa, cuja reconexão é revalidada.

## Atenção antes do deploy

A regra entra em vigor ao publicar o servidor. Navegadores antigos ainda não têm a prova de computador: **inclusive usuários em máquinas NOC precisarão validar o navegador antes de voltar a entrar**. Prepare a janela de implantação e confirme o acesso de recuperação do Master principal antes de publicar.

O agente v137 cria o atalho **NoPulso - acesso NOC** na instalação e na atualização automática. A distribuição continua em ondas: até quatro pilotos, incluindo Windows antigo/servidor quando disponíveis, e expansão após 30 minutos saudáveis. Até a atualização chegar, as máquinas antigas não terão o atalho novo. Não contorne isso liberando indiscriminadamente acesso externo.

Em cada computador, abra o atalho e clique em **Continuar para o NoPulso**. Use o mesmo navegador para entrar. A configuração individual está em **Usuários → Permissões/tags → Somente computadores com NOC**. QA Master não pode alterar essa política.

## Como funciona e limites

O launcher local autentica com a chave do agente, recebendo um vínculo de uso único, válido por dois minutos. O navegador troca esse vínculo por um cookie HttpOnly, SameSite Strict e Secure no domínio HTTPS. A chave permanente do agente não é entregue ao navegador.

A prova dura 24 horas e é vinculada ao IP público e ao navegador. Mudança de conexão/navegador ou vencimento exige abrir novamente o atalho. Rotação da chave ou remoção do cadastro NOC invalida a prova na verificação seguinte; as leituras usam o espelho em memória existente, não consultas por requisição.

Isso comprova um **vínculo emitido pelo agente**, não uma atestação de hardware nem uma verificação contínua da instalação. Desinstalar o agente localmente não revoga por si só um cookie já emitido: ele pode continuar válido até expirar, salvo revogação do cadastro/chave. Estar na mesma rede sem esse vínculo não é suficiente. Computador comprometido e roubo conjunto de credenciais/cookie exigem medidas adicionais de segurança do dispositivo.

## Verificação

`server/testeLoginNoc.js`: autenticação real com banco falso, senha, passkey, middleware, acesso opcional, tags, Master principal/secundário, validade/IP/navegador, revogação, uso único, launcher PowerShell e sabotagem. Defina `HYPERV_TEST_PWSH` para o executável PowerShell dos testes.

`server/testeRotas.js`: também exercita as rotas HTTP reais de emissão/registro, o cookie e a restrição de login/sessão. A suíte histórica usa uma prova NOC de teste, sem desligar a política no código de produção.
