// formulariosUnidades.js
// Cadastro das unidades que podem emitir Formulário: razão social + CNPJ,
// que entram travados no documento (Depósito de Caixa, Pagamento de
// Diárias, Avulso, Reembolso, Ass. Boleto).
//
// POR QUE VIROU CADASTRO. Antes essa lista era uma constante dentro de
// formularios.js. Isso criava tres problemas de uma vez:
//
//  1. Trocar um CNPJ, corrigir uma razão social ou desativar uma unidade
//     que fechou exigia mexer no código e subir deploy - dado fiscal, que
//     muda por decisão de contabilidade e não por release.
//  2. Unidade nova (Saltiverso Patteo) simplesmente não existia no
//     formulário, sem nenhum lugar pra cadastrar.
//  3. E o mais grave: os nomes daquela lista ("Domino's Caruaru") eram
//     escritos a mão e NÃO batiam com os códigos de unidade que o resto do
//     NoPulso usa ("Dominos Caruaru"). Como as permissões por unidade
//     comparam justamente por esse código, nada casava: o seletor mostrava
//     TODAS as unidades pra qualquer pessoa com a seção, e a lista de
//     formulários de quem não é Master vinha vazia. As duas pontas do
//     mesmo defeito.
//
// Por isso cada cadastro tem um `codigo` - a unidade DE VERDADE (a mesma de
// Fechamento/RH/permissões) - separado do `unidade`, que é só o rótulo que
// aparece no PDF e que os formulários já emitidos guardam. Rótulo é
// aparência; código é identidade.
//
// FALHA FECHADA de propósito: cadastro sem `codigo` vinculado só aparece
// pro Master. Na migração, três entradas antigas não tinham como ser
// ligadas a uma unidade só sem chutar ("Spoleto Domino's Aeroporto Recife"
// serve a mais de uma loja do aeroporto; "Big Brother - Recife" e "Grupo
// Bravo Empresarial" não tem loja equivalente) - e chutar aqui significaria
// mostrar formulário de pagamento de uma empresa pra gerente de outra.
// Ficam esperando o Master vincular na tela, visíveis só pra ele.
const db = require('./firestore');
const { createCache } = require('./liveCache');

const COLLECTION = db.collection('formulariosUnidades');

// Semente da migração: exatamente a lista que estava fixa no código, mais o
// Saltiverso Patteo (que faltava). Só é gravada se a coleção estiver vazia -
// depois disso quem manda é o cadastro, e mexer aqui não muda mais nada.
const SEMENTE = [
  { unidade: 'Spoleto Shopping Recife', razaoSocial: 'Trigo Recife', cnpj: '50.625.368/0001-13', codigo: 'Spoleto Shopping Recife' },
  { unidade: "Domino's Caruaru", razaoSocial: 'America Caruaru', cnpj: '50.724.770/0001-55', codigo: 'Dominos Caruaru' },
  { unidade: 'São Braz Ilha do Leite', razaoSocial: 'Cafe SBI', cnpj: '50.929.548/0001-99', codigo: 'São Braz IL' },
  { unidade: "Domino's Garanhuns", razaoSocial: 'America Restaurante', cnpj: '43.675.465/0001-55', codigo: 'Dominos Garanhuns' },
  { unidade: 'Spoleto Tacaruna', razaoSocial: 'Grano Tacaruna', cnpj: '49.942.203/0001-96', codigo: 'Spoleto Shopping Tacaruna' },
  // serve mais de uma loja do aeroporto (Spoleto E Domino's, mesmo CNPJ) -
  // o Master escolhe na tela a qual unidade vincular
  { unidade: "Spoleto Domino's Aeroporto Recife", razaoSocial: 'Grande Fratello', cnpj: '20.182.750/0001-39', codigo: null },
  { unidade: "Domino's Tirol - Natal", razaoSocial: 'America Partners RN', cnpj: '47.677.381/0001-01', codigo: 'Dominos Tirol' },
  { unidade: 'Milky Moo Tirol - Natal', razaoSocial: 'Milky Moo Tirol - Natal', cnpj: '48.049.478/0001-32', codigo: 'Milky Moo Tirol' },
  { unidade: "Domino's Bessa - João Pessoa", razaoSocial: 'America Bessa', cnpj: '59.449.391/0001-79', codigo: 'Dominos Bessa' },
  { unidade: 'Big Brother - Recife', razaoSocial: 'Big Brother Serviços Combinados LTDA.', cnpj: '36.196.587/0001-01', codigo: null },
  { unidade: 'Grupo Bravo Empresarial', razaoSocial: 'MvPar', cnpj: '41.051.829/0001-09', codigo: null },
  { unidade: 'Saltiverso Patteo', razaoSocial: 'CIA ENTRETENIMENTO PATTEO OLINDA LTDA', cnpj: '66.644.523/0001-89', codigo: 'Saltiverso Patteo' },
];

function limpar(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

// CNPJ entra no PDF e vai pra contabilidade: um dígito trocado só aparece
// semanas depois, quando alguém tenta conciliar. Conferir os dois
// verificadores custa nada e pega erro de digitação na hora.
function cnpjValido(bruto) {
  const d = String(bruto || '').replace(/\D/g, '');
  if (d.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(d)) return false; // 00.000.000/0000-00 e afins
  const digito = (ate) => {
    let peso = ate - 7;
    let soma = 0;
    for (let i = 0; i < ate; i += 1) {
      soma += Number(d[i]) * peso;
      peso -= 1;
      if (peso < 2) peso = 9;
    }
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  return digito(12) === Number(d[12]) && digito(13) === Number(d[13]);
}

function formatarCnpj(bruto) {
  const d = String(bruto || '').replace(/\D/g, '');
  if (d.length !== 14) return String(bruto || '').trim();
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}

async function listUncached() {
  const snap = await COLLECTION.get();
  if (snap.empty) return null; // null = ainda não semeado (ver listar)
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => String(a.unidade).localeCompare(String(b.unidade), 'pt-BR'));
}
const cache = createCache(listUncached, 5 * 60 * 1000);

let semeando = null;
async function semear() {
  // uma vez só, mesmo com várias abas abrindo a tela ao mesmo tempo
  if (!semeando) {
    semeando = (async () => {
      const lote = db.batch();
      SEMENTE.forEach((s, i) => {
        const ref = COLLECTION.doc(`seed${String(i + 1).padStart(2, '0')}`);
        lote.set(ref, { ...s, ativo: true, criadoEm: new Date().toISOString(), criadoPorEmail: 'migração' });
      });
      await lote.commit();
      cache.invalidar();
    })().catch((e) => { semeando = null; throw e; });
  }
  return semeando;
}

async function listar() {
  const atual = await cache.cached();
  if (atual) return atual;
  await semear();
  return (await cache.cached()) || [];
}

const listarAtivas = async () => (await listar()).filter((u) => u.ativo !== false);

// resolve pelo RÓTULO, que é o que os formulários já emitidos guardam em
// `unidade` - inclusive os de unidade depois desativada (o PDF de um
// formulário antigo tem que continuar abrindo)
async function obterPorUnidade(rotulo) {
  const alvo = limpar(rotulo, 80);
  return (await listar()).find((u) => u.unidade === alvo) || null;
}

// rótulo -> código da unidade de verdade, pra filtrar por permissão os
// formulários JÁ gravados (que só tem o rótulo)
async function mapaRotuloParaCodigo() {
  const out = {};
  (await listar()).forEach((u) => { if (u.codigo) out[u.unidade] = u.codigo; });
  return out;
}

async function validar({ unidade, razaoSocial, cnpj, codigo }, { ignorarId } = {}) {
  const unidadeOk = limpar(unidade, 80);
  const razaoOk = limpar(razaoSocial, 120);
  if (!unidadeOk) throw new Error('Informe o nome da unidade como deve aparecer no formulário.');
  if (!razaoOk) throw new Error('Informe a razão social.');
  if (!cnpjValido(cnpj)) throw new Error('CNPJ inválido - confira os números (o dígito verificador não fechou).');
  const jaTem = (await listar()).some((u) => u.unidade === unidadeOk && u.id !== ignorarId);
  if (jaTem) throw new Error(`Já existe uma unidade de formulário chamada "${unidadeOk}".`);
  return { unidade: unidadeOk, razaoSocial: razaoOk, cnpj: formatarCnpj(cnpj), codigo: limpar(codigo, 80) || null };
}

async function criar(dados, porEmail) {
  const ok = await validar(dados);
  const ref = COLLECTION.doc();
  const registro = { id: ref.id, ...ok, ativo: true, criadoEm: new Date().toISOString(), criadoPorEmail: porEmail || null };
  await ref.set(registro);
  cache.invalidar();
  return registro;
}

// O RÓTULO pode ser editado (corrigir grafia), mas os formulários já
// emitidos guardam o rótulo antigo - então mudar aqui não pode reescrever o
// que já foi assinado. Quem quiser trocar o nome de vez precisa aceitar que
// o histórico continua com o nome de quando foi emitido, que é o certo pra
// documento fiscal.
async function atualizar(id, dados, porEmail) {
  await listar();
  const ok = await validar(dados, { ignorarId: id });
  const atual = (await listar()).find((u) => u.id === id);
  if (!atual) throw new Error('Unidade de formulário não encontrada.');
  const registro = { ...atual, ...ok, atualizadoEm: new Date().toISOString(), atualizadoPorEmail: porEmail || null };
  await COLLECTION.doc(id).set(registro);
  cache.invalidar();
  return registro;
}

// desativar em vez de apagar: formulário emitido continua tendo que abrir,
// com a razão social e o CNPJ que valiam na época
async function alternarAtivo(id, ativo, porEmail) {
  const atual = (await listar()).find((u) => u.id === id);
  if (!atual) throw new Error('Unidade de formulário não encontrada.');
  const registro = { ...atual, ativo: !!ativo, atualizadoEm: new Date().toISOString(), atualizadoPorEmail: porEmail || null };
  await COLLECTION.doc(id).set(registro);
  cache.invalidar();
  return registro;
}

module.exports = {
  SEMENTE, listar, listarAtivas, obterPorUnidade, mapaRotuloParaCodigo,
  criar, atualizar, alternarAtivo, cnpjValido, formatarCnpj,
};
