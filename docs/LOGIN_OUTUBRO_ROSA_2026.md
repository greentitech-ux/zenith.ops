# Login · Outubro Rosa 2026

Configuração em `/login-custom`, exclusiva do Master.

- Campanha rosa ativada por padrão em outubro de 2026, com encerramento em **01/11/2026 às 00h de Brasília**. Não se repete automaticamente em 2027.
- Formulário e balão ampliados, com opção de voltar ao tamanho padrão.
- Laço vetorial pulsante no lugar do sinal vital somente enquanto a campanha está ativa. Respeita movimento reduzido.
- Fundo proporcional, ancorado à direita e embaixo por padrão. O Master pode escolher centralizado ou esquerda/baixo.
- Imagens desktop e mobile independentes. Durante a campanha, sem upload, usa as artes Outubro Rosa do projeto.
- Data/hora de término editável, explicitamente interpretada no horário de Brasília.
- Ao encerrar, servidor deixa de fornecer os fundos pela rota pública e de apresentar a mensagem da campanha; a página aberta remove a campanha por temporizador local. Não há polling nem escrita no Firestore para encerrar.
- Arquivos e configuração são preservados. O Master continua vendo as imagens pelo preview autenticado. Desativar a campanha libera novamente o uso normal das imagens e mensagem cadastradas.
- Logos do rodapé, autenticação, biometria e restrições NOC não foram alteradas.

## Verificações

`testeLoginCampanha.js`: sete resoluções (320 a 2560px), tema claro/escuro, fundo, laço, movimento reduzido e virada de data em tela aberta. O teste foi sabotado em memória atrasando o encerramento: reprovou.

`TESTE_LOGIN_CAMPANHA=1 node testeRotas.js`: HTTP real para Master/não-Master, validação de data/enquadramento, upload, encerramento público, preservação dos arquivos e preview protegido.

`testeLoginMobile.js`: armazenamento independente, fallback e painel sem overflow.

A suíte geral mantém as **63 falhas preexistentes**. Os testes específicos desta entrega passaram.

Capturas locais: `docs/varredura/login-outubro-rosa/`.

Entrega exige Manual Deploy no Render; push na master não publica sozinho.
