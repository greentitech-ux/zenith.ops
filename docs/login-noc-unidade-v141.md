# Login por computador NOC e unidade — v141

Em Usuários e permissões, marque **Somente computadores NOC das unidades permitidas** e escolha as unidades já existentes na seção de permissões. Não há um segundo cadastro de unidades nem liberação pelo IP público da loja.

Exemplo: Junius com apenas Saltiverso Patteo marcada poderá usar máquinas NOC dessa unidade. Uma máquina NOC de outra unidade também é recusada. Admin não ignora a regra. Sem função válida, a restrição NOC continua obrigatória; uma conta sem unidades permitidas não ganha acesso a qualquer loja. O Master principal mantém a recuperação; Masters secundários mantêm seu escopo global, mas exigem prova NOC quando restritos.

O acesso continua na página normal do NoPulso. Quando a prova está ausente ou inválida, o login por senha tenta automaticamente a validação local e repete o pedido. Na biometria, a validação acontece antes da cerimônia. O suporte mantém nome e telefone/e-mail; não há portal Chat da Unidade nem atalho especial.

## Agente e navegador

O agente v141 escuta apenas `127.0.0.1:17841`, em runspace separado e sem janela, firewall liberado ou necessidade de URL ACL. Só aceita a origem oficial de APP_BASE_URL e Host loopback exato. Assina desafio de 60 segundos, vinculado ao IP e navegador, com HMAC; o segredo do agente não vai para o navegador. O servidor confere assinatura, cadastro, unidade e uso único. A confirmação fica em cookie HttpOnly/Secure/SameSite, válido por 24 horas como na política anterior; não é uma atestação contínua de hardware nem de localização física. Remover o computador do NOC ou rotacionar sua credencial invalida a confirmação.

Chrome/Edge recentes podem pedir autorização de acesso local na primeira utilização. Autorize somente para o domínio oficial. Não se desativam proteções do navegador e não se permite qualquer site acessar o serviço local. Negação da permissão, conflito da porta ou agente antigo produz bloqueio seguro com aviso no login.

**Windows Antigo é exclusivamente monitoramento NOC:** não inicia o validador de login, não cria launcher de acesso NoPulso, não abre aplicativo/navegador e seu cadastro não emite prova de login. Mantém o agente e os controles NOC silenciosos.

## Publicação e testes

Servidor depende do agente v141 para validação automática; deploy não atualiza todas as máquinas instantaneamente. Manter rollout existente de até quatro pilotos e 30 minutos antes do parque. Validar primeiro uma máquina normal de Saltiverso Patteo, outra unidade (negação), computador sem agente (negação) e Windows Antigo (somente monitoramento). Não mudar o cadastro real de Junius sem identificar a conta correta.

Testes: testeLoginNoc.js (senha, passkey, sessão e unidade), testeNocLocal.js (PowerShell TCP real, HMAC, CORS, prova falsa/replay, parsers normal/antigo), testeWindowsAntigoSilencioso.js e testeRotas.js (HTTP real). A suíte geral mantém 64 falhas previamente existentes; os testes novos passam. Prancha visual: docs/varredura/prancha.html.
