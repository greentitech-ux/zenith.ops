// Regra pura: mantém índices estáveis, autoria e auditoria; não apaga fechamento.
'use strict';
function validarData(data) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(data)) || !Number.isFinite(Date.parse(data + 'T00:00:00Z')) || new Date(data + 'T00:00:00Z').toISOString().slice(0, 10) !== data) throw new Error('Data inválida.');
}
function preparar(atual, indice, dados, destino = atual) {
  const i = Number(indice), antigo = (atual.detalhesSaidas || [])[i];
  if (!Number.isInteger(i) || i < 0 || !antigo || antigo.excluida) throw new Error('Saída não encontrada nesse fechamento.');
  validarData(destino.data);
  const excluir = dados.excluir === true;
  const valor = excluir ? 0 : Number(dados.valor ?? antigo.valor);
  const descricao = String(dados.descricao ?? antigo.descricao ?? '').trim().slice(0, 300);
  if (!Number.isFinite(valor) || valor < 0) throw new Error('Informe um valor válido.');
  if (!excluir && !descricao) throw new Error('Descreva a saída.');
  const novo = { ...antigo, descricao, valor: +valor.toFixed(2) };
  if (dados.criadoPorNome !== undefined) {
    const nome = String(dados.criadoPorNome).trim().slice(0, 120);
    if (!nome) throw new Error('Informe quem lançou.');
    novo.criadoPorNome = nome;
    if (dados.criadoPorId !== undefined) novo.criadoPorId = dados.criadoPorId;
    if (dados.criadoPorEmail !== undefined) novo.criadoPorEmail = dados.criadoPorEmail;
  }
  const em = new Date().toISOString();
  const movida = atual.id !== destino.id;
  const origemItens = [...atual.detalhesSaidas];
  // Tombstone: remover por splice trocaria as chaves de verificação dos irmãos.
  origemItens[i] = excluir || movida ? { ...antigo, valor: 0, excluida: true, excluidaEm: em, excluidaPorEmail: dados.editadoPorEmail } : novo;
  const historico = { em, por: dados.editadoPorEmail, motivo: String(dados.motivo || '').trim() || (excluir ? 'Saída excluída no painel' : 'Saída editada no painel'),
    valoresAnteriores: { saida: antigo, unidade: atual.unidade, data: atual.data },
    valoresNovos: { saida: excluir ? null : novo, unidade: destino.unidade, data: destino.data } };
  const patch = (f, itens, diferenca) => ({ detalhesSaidas: itens, totalSaida: Math.max(0, +(Number(f.totalSaida || 0) + diferenca).toFixed(2)), historico: [...(f.historico || []), historico], atualizadoEm: em });
  const origem = patch(atual, origemItens, (excluir || movida ? 0 : novo.valor) - Number(antigo.valor || 0));
  let alvo = null;
  if (movida && !excluir) {
    // Manter autor legado até alguém corrigi-lo explicitamente.
    novo.criadoPorNome = novo.criadoPorNome || atual.gerente || atual.criadoPorEmail || '';
    alvo = patch(destino, [...(destino.detalhesSaidas || []), novo], novo.valor);
  }
  return { origem, destino: alvo };
}
module.exports = { preparar, validarData };
