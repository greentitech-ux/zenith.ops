(function(root){
  'use strict';
  const PADRAO = { campanhaRosa: true, campanhaFim: '2026-11-01T00:00:00-03:00', tamanhoLogin: 'ampliado', fundoPosicao: 'right bottom' };
  function efetiva(config, agora = Date.now()) {
    const c = { ...PADRAO, ...config };
    const fim = Date.parse(c.campanhaFim);
    const expirada = c.campanhaRosa && Number.isFinite(fim) && agora >= fim;
    return { ...c, ...(expirada ? { ativo: false, bubbleTitulo: '', bubbleTexto: '', fundoArquivo: null, fundoMobileArquivo: null, temFundo: false, temFundoMobile: false } : {}),
      rosaAtiva: !!c.campanhaRosa && agora >= Date.parse('2026-10-01T00:00:00-03:00') && !expirada,
      campanhaExpirada: !!expirada };
  }
  const api = { PADRAO, efetiva };
  if(typeof module === 'object' && module.exports) module.exports = api;
  else root.loginCampanha = api;
})(typeof window === 'object' ? window : globalThis);
