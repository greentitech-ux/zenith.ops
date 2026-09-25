// Consolidação de fontes para a leitura de fechamentos.
//
// Uma planilha pode continuar sendo usada como integração/histórico ao mesmo
// tempo em que a unidade já lança no NoPulso. Na coincidência de unidade+data
// os dois registros descrevem o MESMO fechamento; somá-los dobra todos os
// valores. Sangrias são movimentos complementares e entram depois.
function chave(f) {
  return `${f.unidade}__${f.data}`;
}

function combinar({ planilha = [], lancados = [], sangriasLancadas = [], saltiversoLancado = [] } = {}, mesclar) {
  if (typeof mesclar !== 'function') throw new Error('Informe a função de mesclagem dos fechamentos.');
  const chavesNativas = new Set((lancados || []).map(chave));
  const planilhaSemEspelho = (planilha || []).filter((f) => !chavesNativas.has(chave(f)));
  return mesclar([
    ...planilhaSemEspelho,
    ...(lancados || []),
    ...(sangriasLancadas || []),
    ...(saltiversoLancado || []),
  ]);
}

module.exports = { combinar };
