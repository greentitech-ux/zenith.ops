# Instalador Android no NOC

Em NOC → computador → Programas → Manutenção, o cartão Tablet ou celular
oferece Baixar agente Android (APK) e Inscrever este tablet.

## Acesso

Somente Master (não QA Master) ou usuário com cargo/tag Suporte E a seção
NOC (`network-private`). Admin sozinho e Técnico com NOC não autorizam.
A mesma regra é aplicada no servidor e enviada em `/api/me` para a tela.
O download usa o Bearer existente via fetch, nunca token na URL.

O APK vem de `AGENTE_ANDROID_URL`, exclusivamente HTTPS sem credenciais
na URL. O servidor transmite o arquivo sem consulta ao Firestore e sem
encaminhar credenciais NoPulso à origem, com limite de 32 MiB e 60 segundos.
Há transferência pela origem E pelo Render: cada download tem custo de
banda correspondente ao tamanho do APK. Não há consulta periódica nova.
ZIP é só uma verificação de formato, não substitui assinatura Android.

## Publicação assinada

Em 04/10/2026, com autorização expressa do Master, foi criada a primeira
chave permanente RSA-4096, certificado de 30 anos, PKCS12 criptografado,
e os quatro secrets foram enviados cifrados à API do GitHub.
Backup local fora do repositório: `../.android-assinatura`, ACL limitada
ao usuário atual e SYSTEM. Guardar uma cópia desse backup em cofre seguro:
perder a chave impede atualizar os tablets já instalados.
Fingerprint SHA-256: `4d1eebc9158fe66c029ef9e7a865cfb92138aa4741b556ec1b4849ce020347e4`.

A versão 2 é a primeira de distribuição. O workflow falha se faltar a
chave; em master publica `agente-android-v2/nopulso-agente.apk` nos Releases.
Não substitui uma versão já publicada. O servidor usa essa publicação por
padrão, sem configurar variável no Render. `AGENTE_ANDROID_URL` substitui
a origem; vazio explícito desabilita o botão. APK de debug antigo não deve
ser usado nas lojas e, se instalado, precisa ser desinstalado antes da v2.
O deploy do servidor sozinho não cria nem publica o APK: esperar o workflow.

Publicação v2 confirmada no workflow `37218501985`; todas as etapas passaram.
Download verificado: 1.579.448 bytes. O certificado no bloco de assinatura
APK v2 corresponde ao fingerprint da chave permanente acima.
SHA-256 do APK: `dc5fc118b69ddd25414336bbd146eec35d11b2248ee6741cd3e0cf2c73c8b534`.

O botão e a rota NoPulso são restritos. O binário genérico, sem token nem
identidade de unidade, fica em Release público deste repositório público;
essa restrição NÃO torna o arquivo secreto nem impede sua cópia fora do
NoPulso. Instalar o APK não autoriza inscrição: é necessário o token
individual do aparelho, gerado pelo NOC.

## Inscrição

Depois de instalar o APK, clicar Inscrever este tablet gera o link do
computador escolhido e apresenta um link real Abrir NoPulso Agente e
confirmar inscrição. O segundo toque preserva o gesto do usuário para
o navegador abrir o aplicativo; não pesquisa o esquema no Google/IA.
Não salva credenciais de inscrição no localStorage nem no histórico de URL
HTTP. O cadastro usa o token individual existente desse computador.

## Login restrito no Android (APK v3)

A v2 só monitora. A v3 também inicia o validador em `127.0.0.1:17841`,
mesmo protocolo/HMAC do Windows, origem HTTPS oficial, Host exato,
preflight CORS e rede privada, entradas limitadas e timeout de 2,5s.
Não abre serviço na LAN e não devolve o segredo. O servidor só reconhece
`agenteAndroidVersao >= 3` recebido em heartbeat com token válido, na mesma
escrita/cache já usados pelo monitoramento. Não há polling novo no Render.
Prova única de 60s e cookie HttpOnly vinculado a IP/navegador continuam
inalterados, assim como as unidades autorizadas do usuário.

Para corrigir um tablet com v2: fazer o deploy do servidor, instalar o APK
v3 por cima da v2, abrir o agente e aguardar a primeira batida. A assinatura
permanente preserva a inscrição. Se ainda não inscrito, inscrever pelo NOC.
No navegador, permitir comunicação com a rede local se solicitado e tentar
login novamente. APK sem inscrição, token errado e unidade não autorizada
continuam bloqueados; Windows Antigo continua sem validação de acesso.

O serviço pode ser encerrado pelo Android/usuário: abrir o agente inscrito
inicia novamente. Sem permissão de rede local no navegador a validação
falha, não há bypass para liberar o usuário fora das unidades autorizadas.

## Verificação

### Aviso rápido de atualização (APK v4)

A v4 lê `atualizacaoAndroid` na resposta do heartbeat existente (25s).
Notifica uma vez por versão, guardando a versão avisada em SharedPreferences.
Não marca como avisada se as notificações do app/canal estiverem bloqueadas.
Canal Atualizações NoPulso separado do monitoramento silencioso; tocar abre
download HTTPS. Android ainda exige confirmação para instalar. APKs antigos
mantêm verificação de 6h: instalar v4 uma primeira vez para obter o novo fluxo.

O servidor só envia esse campo ao userAgent NoPulsoAgente. Verifica publicação
somente se houver versão mais nova; tablet atualizado recebe apenas o número,
sem repetir URL longa ou consultar origem de download a cada batida.
Confirma publicação
por HEAD (timeout 5s), com uma chamada compartilhada por URL/boot, sem Firestore.
Publicação imutável confirmada fica em memória; falha aguarda 30s antes de nova
tentativa. Não baixar APK inteiro para verificar, não fazer polling por tablet.
Publicar o APK antes de fazer o deploy do servidor. Após a liberação no servidor,
tablets v4 conectados avisam na próxima batida; offline recebem quando voltam.
Não existe instalação silenciosa ou push externo pago nesta implementação.

`testeAvisoAtualizacaoAndroid.js` verifica cache/publicação/HTTP e sabotagem;
`RegraAtualizacaoTest.kt` verifica nova versão, duplicatas e URL insegura no JVM.

`node testeInstaladorAndroid.js`: permissões, sabotagem, download binário,
HTML rejeitado, URL insegura, ausência de publicação e credencial não
encaminhada à origem. `testeRotas.js` também testa as rotas HTTP reais.
Teste visual em 390/1280 px: sem overflow, botão oculto para não autorizados,
publicação ausente desabilitada, inscrição com link real. Suíte completa
permanece com 64 falhas anteriores; os novos testes passaram.
