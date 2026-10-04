# Login limitado a computadores NOC

## Regra

- Campo `somenteNoc` ausente ou marcado: acesso exige navegador validado pelo agente.
- Sem tag de função válida: continua exigindo NOC, mesmo com o campo desmarcado.
- Tag válida + campo desmarcado pelo Master: permite outros dispositivos, mantendo senha, biometria e permissões pessoais.
- Apenas o Master principal identificado pela hierarquia mantém acesso de recuperação sem esse vínculo. Outra conta Master não herda a exceção.
- Senha, passkey, sessões existentes e identificação opcional usam a mesma verificação. Mudanças de tags/política fecham as conexões ao vivo da pessoa, cuja reconexão é revalidada.

## Atenção antes do deploy

A regra entra em vigor ao publicar o servidor. Navegadores antigos ainda não têm a prova de computador: **inclusive usuários em máquinas NOC precisarão validar o navegador antes de voltar a entrar**. Prepare a janela de implantação e confirme o acesso de recuperação do Master principal antes de publicar.

O agente v139 mantém o validador interno, sem ícone em nenhuma unidade. A distribuição continua em ondas: até quatro pilotos, incluindo Windows antigo/servidor quando disponíveis, e expansão após 30 minutos saudáveis. Até a atualização chegar, máquinas antigas podem ainda ter os atalhos de versões anteriores. Não contorne a restrição liberando indiscriminadamente acesso externo.

O TI pode executar o validador protegido em `%LOCALAPPDATA%\NOCZenith\abrir-acesso-noc.ps1` usando PowerShell com `-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File`. Essa execução deliberada abre a página de validação; não acontece automaticamente. Depois clique em **Continuar para o NoPulso**, usando o mesmo navegador. A configuração individual está em **Usuários → Permissões/tags → Somente computadores com NOC**. QA Master não pode alterar essa política.

O agente remove somente o atalho exato `NoPulso - acesso NOC.lnk` da área de trabalho do usuário e da área de trabalho pública, em todos os computadores. Não altera as VMs nem o monitoramento. Perfil de usuário sem instância de agente só terá seu atalho antigo removido na próxima execução do agente nesse perfil.

## Windows Antigo: operação silenciosa (v139)

Máquinas marcadas como Windows Antigo não instalam o PWA, não abrem o chat/navegador, não ativam NoPulsoPrint e não aplicam políticas visuais na área de trabalho. Apps/atalhos automáticos previamente identificados como criados pelo agente são limpos; atalhos de outros programas e instalações manuais não são apagados indiscriminadamente. O atalho de chat só é removido com registro do launcher e validação de nome/local/destino.

Mesmo se o tipo cadastrado for Atendimento ou Abastecimento, essas máquinas usam o loop com heartbeat próprio do agente, sem depender de navegador aberto. Telemetria, atualização e comandos operacionais permanecem disponíveis. A inicialização e o instalador usam janela oculta; a confirmação UAC do Windows, quando necessária na instalação deliberada, não é contornada. Avisos de segurança de ações administrativas explícitas não são removidos.

## Como funciona e limites

O launcher local autentica com a chave do agente, recebendo um vínculo de uso único, válido por dois minutos. O navegador troca esse vínculo por um cookie HttpOnly, SameSite Strict e Secure no domínio HTTPS. A chave permanente do agente não é entregue ao navegador.

A prova dura 24 horas e é vinculada ao IP público e ao navegador. Mudança de conexão/navegador ou vencimento exige executar novamente o validador interno. Rotação da chave ou remoção do cadastro NOC invalida a prova na verificação seguinte; as leituras usam o espelho em memória existente, não consultas por requisição.

Isso comprova um **vínculo emitido pelo agente**, não uma atestação de hardware nem uma verificação contínua da instalação. Desinstalar o agente localmente não revoga por si só um cookie já emitido: ele pode continuar válido até expirar, salvo revogação do cadastro/chave. Estar na mesma rede sem esse vínculo não é suficiente. Computador comprometido e roubo conjunto de credenciais/cookie exigem medidas adicionais de segurança do dispositivo.

## Verificação

`server/testeLoginNoc.js`: autenticação real com banco falso, senha, passkey, middleware, acesso opcional, tags, Master principal/secundário, validade/IP/navegador, revogação, uso único, launcher PowerShell e sabotagem. Defina `HYPERV_TEST_PWSH` para o executável PowerShell dos testes.

`server/testeRotas.js`: também exercita as rotas HTTP reais de emissão/registro, o cookie e a restrição de login/sessão. A suíte histórica usa uma prova NOC de teste, sem desligar a política no código de produção.

`server/testeWindowsAntigoSilencioso.js`: guardas de interface executadas em PowerShell, tipos Interno/Atendimento/Abastecimento, heartbeat próprio e sabotagem das guardas. Não opera máquinas reais.
