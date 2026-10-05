'use strict';
// A lista e a validação usam a mesma regra. Admin não ganha acesso global
// por ser Admin: precisa ter a unidade marcada e dentro da sua empresa.
async function listar(unidade, deps = {}) {
  if (!unidade || typeof unidade !== 'string') throw new Error('Selecione a unidade.');
  const usuarios = deps.users || require('./users');
  const empresas = deps.empresas || require('./empresas');
  const candidatos = (await usuarios.list()).filter(u => u.active !== false && u.role !== 'master'
    && (u.permissions?.unidades || []).includes(unidade));
  const tetos = new Map();
  for (const u of candidatos) {
    if (u.empresaId && !tetos.has(u.empresaId)) tetos.set(u.empresaId, new Set(await empresas.unidadesDaEmpresa(u.empresaId)));
  }
  return candidatos.filter(u => !u.empresaId || tetos.get(u.empresaId).has(unidade))
    .map(u => ({ id: u.id, nome: u.nome || u.username || u.email, email: u.email || '', username: u.username || '', admin: !!u.isAdmin }))
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
}
async function resolver(id, unidade, deps) {
  if (typeof id !== 'string' || !id) throw new Error('Selecione quem lançou.');
  const autor = (await listar(unidade, deps)).find(u => u.id === id);
  if (!autor) throw new Error('Quem lançou deve ser um usuário ativo vinculado à unidade selecionada.');
  return { criadoPorId: autor.id, criadoPorNome: autor.nome, criadoPorEmail: autor.email };
}
module.exports = { listar, resolver };
