// data-br.js
// Data de NASCIMENTO digitada (dd/mm/aaaa) em vez de <input type="date">.
//
// Pedido do Master: "sempre que for data de nascimento deixar digitável". O
// motivo é operacional - o seletor nativo do Android/iOS abre no mês ATUAL e
// obriga a navegar ano a ano pra trás. Pra data de utilização isso é ótimo
// (a data é sempre perto de hoje); pra nascimento de uma criança de 2019 são
// dezenas de toques. Digitar 8 números é mais rápido e não erra.
//
// O que trafega pro servidor continua ISO (aaaa-mm-dd) - é o formato que o
// backend e o cálculo de aniversário (ehNiverAuto) leem. A conversão é só na
// borda da tela.
//
// Arquivo compartilhado porque o mesmo campo existe em 4 telas
// (parque-checkin, parque, mensalistas, rh) - duplicar a validação de
// calendário em cada uma é como um dia elas divergirem.

// máscara enquanto digita: só números entram, as barras entram sozinhas
function mascararDataBR(el) {
  const d = el.value.replace(/\D/g, '').slice(0, 8);
  let out = d.slice(0, 2);
  if (d.length > 2) out += '/' + d.slice(2, 4);
  if (d.length > 4) out += '/' + d.slice(4, 8);
  el.value = out;
  el.classList.toggle('data-invalida', !!out && !dataBRparaISO(out));
}

// devolve ISO só quando a data existe DE VERDADE no calendário.
// 31/02/2020 e 29/02/2021 voltam null em vez de "virar" 02/03 e 01/03 - o
// Date do JavaScript faz esse ajuste sozinho e sem checar de volta a criança
// nasceria em outro dia sem ninguém perceber.
// Ano fora de 1900..hoje também é null: nascimento no futuro não existe.
function dataBRparaISO(txt) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(txt || '').trim());
  if (!m) return null;
  const [, dd, mm, aaaa] = m;
  const dia = Number(dd), mes = Number(mm), ano = Number(aaaa);
  if (ano < 1900 || ano > new Date().getFullYear()) return null;
  const dt = new Date(Date.UTC(ano, mes - 1, dia));
  if (dt.getUTCFullYear() !== ano || dt.getUTCMonth() !== mes - 1 || dt.getUTCDate() !== dia) return null;
  return `${aaaa}-${mm}-${dd}`;
}

// o que já está salvo (ISO) volta pra tela no formato de quem digita
function isoParaDataBR(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

// campo opcional preenchido com texto que não é data: não pode virar null em
// silêncio (o desconto de aniversário depende dele, e a pessoa acharia que
// salvou). true = tem texto e o texto não é uma data válida.
function dataBRInvalida(el) {
  return !!(el && el.value.trim() && !dataBRparaISO(el.value));
}

// campos de data digitada com conteúdo inválido dentro de um formulário. As
// telas chamam isso antes de enviar - recalcula em vez de confiar na classe
// .data-invalida, que só existe se o oninput chegou a rodar.
function camposDataBRInvalidos(raiz) {
  return [...(raiz || document).querySelectorAll('input[oninput*="mascararDataBR"]')].filter(dataBRInvalida);
}
