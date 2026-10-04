// Compatibilidade com páginas antigas em cache: nunca voltar ao portal especial.
(function () {
  try { localStorage.removeItem('nopulso.unidade'); localStorage.removeItem('nopulso.unidade.atividade'); } catch {}
  window.NoPulsoUnidade = { login: function(){}, verificar: function(){return true;}, voltar: function(){location.replace('/');} };
})();
