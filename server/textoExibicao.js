// textoExibicao.js
// Como o NoPulso MOSTRA nome de pessoa e valor preenchido: sempre em
// MAIÚSCULO. Pedido do Master (14/09/2026), olhando o próprio usuário no
// menu: "em todo lugar que aparecer o usuário, sempre com letras maiúsculas
// - assim fica feio. 100% dos locais, mesmo que seja escrito minúsculo.
// Quero levar isso também pra tudo: formulários, PDF, relatórios,
// preenchimentos".
//
// TRANSFORMA NA EXIBIÇÃO, NUNCA NO BANCO. O que a pessoa digitou continua
// gravado como ela digitou, e por dois motivos que não são preciosismo:
//
//   1. Maiúsculo PERDE informação e não tem volta: "d'Ávila", "McDonald's",
//      "von Ahn" não se reconstroem depois. Se um dia a regra mudar, com o
//      dado intacto é uma linha; com o dado destruído é um dado perdido.
//   2. A regra da casa (CLAUDE.md §1) é não escrever migração nova por cima
//      de dado antigo - o histórico tem que continuar legível exatamente
//      como está.
//
// E transformar na exibição também resolve o passado: os nomes já gravados em
// minúsculo aparecem maiúsculos sem ninguém migrar nada.
//
// O QUE SOBE - E SÓ ISSO. A primeira versão subiu a tela inteira (uma regra
// no `body`) e ficou ruim de ler; o Master corrigiu o alvo (14/09): "não
// gostei de tudo maiúsculo / o que falei pra ser tudo maiúsculo foi NOMES DOS
// USUÁRIOS e DADOS PREENCHIDOS para formulários e relatórios". Então são dois
// casos, não a interface:
//
//   - nome de pessoa, onde quer que a tela ou o PDF escreva gente;
//   - o que foi PREENCHIDO: o que a pessoa digitou ou escolheu num campo.
//
// Menu, botão, rótulo, título e texto corrido ficam como estão escritos - são
// interface, não dado. Dentro do que sobe não há exceção de tipo: e-mail,
// observação, nome de item e endereço preenchidos sobem junto.
//
// Na TELA isso é CSS, e é o que torna a decisão barata: o texto gravado não
// muda, e COPIAR devolve o original (o navegador copia o texto de origem, não
// o transformado). Ou seja: o e-mail aparece MAIÚSCULO e cola minúsculo.
// No PDF e no e-mail não existe CSS, então ali a string sobe de verdade - e
// por isso as duas funções abaixo existem.
//
// A ÚNICA EXCEÇÃO É O QUE QUEBRA SE FOR REDIGITADO À MÃO - e não é questão de
// gosto: senha, token, ID, MAC, IP e código de unidade são VALORES EXATOS.
// Mostrar "17F080C6" pra quem vai digitar num terminal onde o valor é
// minúsculo não é estilo, é erro. Pra esses existe valorExato(), e na tela a
// classe .nao-maiusc. São poucos lugares, todos identificados no código.

// Só os caracteres: não mexe em espaço, acento nem pontuação.
// toLocaleUpperCase com 'pt-BR' porque o toUpperCase() puro erra em alguns
// alfabetos e um dia isso encosta aqui.
function maiusc(v) {
  if (v === null || v === undefined) return v;
  const s = String(v);
  if (!s) return s;
  return s.toLocaleUpperCase('pt-BR');
}

// Nome de pessoa pra exibir. Aceita o que os módulos já carregam (nome,
// nomeCompleto, username, e-mail como último recurso).
function nomePessoa(pessoa) {
  if (!pessoa) return '';
  if (typeof pessoa === 'string') return maiusc(pessoa);
  return maiusc(pessoa.nomeCompleto || pessoa.nome || pessoa.username || pessoa.email || '');
}

// Valor preenchido por gente, em formulário/relatório/PDF. Número e booleano
// voltam como vieram porque maiúsculo neles não existe - e devolver string
// aqui quebraria quem soma.
function valorPreenchido(v) {
  if (v === null || v === undefined) return v;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  return maiusc(v);
}

// O ESCAPE. Valor que alguém vai ler da tela e DIGITAR em outro lugar: token,
// senha, ID, MAC, IP, código de unidade, chave de API. Devolve intacto, e
// existe pra que "não subir" seja uma decisão explícita no código em vez de
// um esquecimento.
function valorExato(v) {
  return v;
}

module.exports = { maiusc, nomePessoa, valorPreenchido, valorExato };
