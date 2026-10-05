# Campanha sem perder a estrutura do papel de parede

O upload de uma arte completa substitui o modelo institucional. Para trocar
só o fundo, a seção **NOC-NoPulso → Papel de parede do parque** agora oferece
**Trocar só o fundo — manter logos, cartão, máquina e suporte**.

## Uso após publicação

1. Publicar a correção do servidor e do agente v142; aguardar a liberação
   normal dos pilotos e confirmar v142 na máquina escolhida para validar.
2. Selecionar o escopo do envio (todas as marcas ou grupo/marca).
3. Escolher a imagem da campanha, manter a nova opção marcada e confirmar
   o envio com a senha Master.
4. Validar uma estação antes de ampliar a distribuição. A máquina precisa
   da política de papel de parede ligada e do agente na sessão do usuário.

As imagens antigas permanecem no modo arte completa até serem reenviadas.
Nenhum dado de produção é alterado automaticamente por esta entrega.
Versões anteriores do agente não desenham o fundo novo: mantêm o modelo
preto com a identificação. Windows Antigo continua sem alteração visual.

O servidor entrega os logos reais da unidade; o agente desenha o fundo antes
do modelo existente. Nome, grupo, marca e suporte não são gravados na imagem
da campanha. Remover o upload pelo controle existente devolve o modelo preto.
A campanha do NOC não herda o prazo automático configurado no login.

Não há polling extra de configuração: a versão do fundo entra no mecanismo
existente de revisão. O download ocorre ao redesenhar (mudança de fundo,
logo ou nome); falhas continuam limitadas pelo mecanismo de tentativa atual.

## Verificação local

`server/testePapelFundoModelo.js` usa a função real de configuração com
dependências falsas e renderiza o código PowerShell real em Windows.
Definir `FUNDO_MODELO_TESTE`, `LOGO_MODELO_TESTE` e opcionalmente `PWSH_TESTE`.
O modo `--sabotagem` deve reprovar ao remover a seleção do modelo preservado.
As imagens geradas ficam em `docs/varredura/papel-fundo-modelo`.

Resultado desta entrega: teste específico e parser PowerShell normal/antigo
passaram; sabotagem foi detectada. Suíte geral reportou 63 falhas, mesma
contagem já registrada anteriormente; não tratá-la como totalmente aprovada.
