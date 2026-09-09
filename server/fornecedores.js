const crypto = require('crypto');
const db = require('./firestore');

const COLLECTION = db.collection('fornecedores');
const CONVITES = db.collection('fornecedorConvites');
const STATUS = ['PENDENTE', 'ATIVO', 'INATIVO'];

const texto = (v, max = 160) => String(v || '').trim().slice(0, max);
const soDigitos = (v) => String(v || '').replace(/\D/g, '').slice(0, 14);

function contatosValidos(lista) {
  return (Array.isArray(lista) ? lista : []).map((c) => ({
    nome: texto(c?.nome, 100), cargo: texto(c?.cargo, 80), telefone: texto(c?.telefone, 40),
    email: texto(c?.email, 160).toLowerCase(), principal: !!c?.principal,
  })).filter((c) => c.nome || c.telefone || c.email).slice(0, 12);
}

function pagamentosValidos(lista, documentoEmpresa) {
  return (Array.isArray(lista) ? lista : []).map((p) => {
    const tipo = p?.tipo === 'transferencia' ? 'transferencia' : 'pix';
    const beneficiario = texto(p?.beneficiario, 160);
    const documentoBeneficiario = soDigitos(p?.documentoBeneficiario || documentoEmpresa);
    if (!documentoEmpresa) throw new Error('Informe o CPF/CNPJ do fornecedor antes de cadastrar dados de pagamento.');
    if (!beneficiario || !documentoBeneficiario) throw new Error('Todo meio de pagamento precisa de beneficiário e CPF/CNPJ.');
    if (documentoBeneficiario !== documentoEmpresa) throw new Error('O CPF/CNPJ do beneficiário deve ser o mesmo do fornecedor.');
    if (tipo === 'pix') {
      const chavePix = texto(p?.chavePix, 180);
      if (!chavePix) throw new Error('Informe a chave Pix.');
      return { tipo, chavePix, banco: texto(p?.banco, 100), beneficiario, documentoBeneficiario, principal: !!p?.principal };
    }
    const banco = texto(p?.banco, 100), agencia = texto(p?.agencia, 30), conta = texto(p?.conta, 40);
    if (!banco || !agencia || !conta) throw new Error('Para transferência informe banco, agência e conta.');
    return { tipo, banco, agencia, conta, tipoConta: texto(p?.tipoConta, 30), beneficiario, documentoBeneficiario, principal: !!p?.principal };
  }).slice(0, 8);
}

function normalizar(dados) {
  const razaoSocial = texto(dados?.razaoSocial, 180);
  const nomeFantasia = texto(dados?.nomeFantasia, 180);
  const documento = soDigitos(dados?.documento);
  if (!razaoSocial && !nomeFantasia) throw new Error('Informe razão social ou nome do fornecedor.');
  if (documento && ![11, 14].includes(documento.length)) throw new Error('CPF/CNPJ inválido.');
  const contatos = contatosValidos(dados?.contatos);
  if (!contatos.length) throw new Error('Inclua ao menos um contato.');
  return {
    razaoSocial, nomeFantasia, documento, categoria: texto(dados?.categoria, 100),
    contatos, pagamentos: pagamentosValidos(dados?.pagamentos, documento), observacao: texto(dados?.observacao, 1000),
  };
}

async function listar(unidades) {
  const snap = await COLLECTION.orderBy('atualizadoEm', 'desc').get();
  const permitidas = unidades ? new Set(unidades) : null;
  return snap.docs.map((d) => d.data()).filter((f) => !permitidas || permitidas.has(f.unidade));
}

async function criar({ unidade, unidadeNome, dados, por }) {
  if (!unidade) throw new Error('Unidade é obrigatória.');
  const doc = COLLECTION.doc(), agora = new Date().toISOString();
  const registro = { id: doc.id, unidade, unidadeNome: unidadeNome || unidade, ...normalizar(dados),
    status: 'ATIVO', origem: 'interno', criadoEm: agora, atualizadoEm: agora,
    criadoPorNome: texto(por?.nome || por?.username || 'Usuário', 80), validadoPorNome: texto(por?.nome || por?.username || 'Usuário', 80), validadoEm: agora };
  await doc.set(registro); return registro;
}

async function criarPublico({ unidade, unidadeNome, dados, convite }) {
  const doc = COLLECTION.doc(), agora = new Date().toISOString();
  const registro = { id: doc.id, unidade, unidadeNome: unidadeNome || unidade, ...normalizar(dados),
    status: 'PENDENTE', origem: 'fornecedor', conviteId: convite.id, criadoEm: agora, atualizadoEm: agora,
    criadoPorNome: 'Fornecedor (link público)', validadoPorNome: null, validadoEm: null };
  await doc.set(registro); return registro;
}

async function atualizar(id, dados, por) {
  const ref = COLLECTION.doc(id), snap = await ref.get(); if (!snap.exists) throw new Error('Fornecedor não encontrado.');
  const atual = snap.data(), agora = new Date().toISOString();
  await ref.update({ ...normalizar(dados), atualizadoEm: agora, atualizadoPorNome: texto(por?.nome || por?.username || 'Usuário', 80) });
  return { ...atual, ...normalizar(dados), atualizadoEm: agora };
}

async function validar(id, por) {
  const ref = COLLECTION.doc(id), snap = await ref.get(); if (!snap.exists) throw new Error('Fornecedor não encontrado.');
  const agora = new Date().toISOString();
  await ref.update({ status: 'ATIVO', validadoEm: agora, validadoPorNome: texto(por?.nome || por?.username || 'Usuário', 80), atualizadoEm: agora });
  return ref.get().then((s) => s.data());
}

async function criarConvite({ unidade, unidadeNome, por }) {
  const token = crypto.randomBytes(24).toString('base64url'), agora = new Date().toISOString();
  const registro = { id: token, token, unidade, unidadeNome: unidadeNome || unidade, criadoEm: agora,
    criadoPorNome: texto(por?.nome || por?.username || 'Usuário', 80), usadoEm: null };
  await CONVITES.doc(token).set(registro); return registro;
}
async function convite(token) { const s = await CONVITES.doc(String(token || '')).get(); return s.exists ? s.data() : null; }
async function usarConvite(token) { await CONVITES.doc(token).update({ usadoEm: new Date().toISOString() }); }

module.exports = { listar, criar, criarPublico, atualizar, validar, criarConvite, convite, usarConvite, STATUS };
