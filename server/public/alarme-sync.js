// alarme-sync.js
// Silenciar/atender o alarme critico numa aba tem que calar TODAS as abas do
// MESMO acesso - senao quem deixa 5 telas do NoPulso abertas silencia uma e
// continua com 4 sirenes tocando, e acaba tendo que cacar aba por aba.
//
// Tres caminhos, de proposito, porque cobrem situacoes diferentes:
//   1. BroadcastChannel - instantaneo, entre abas do mesmo navegador. E o
//      caso que o usuario descreveu e o que resolve 99% das vezes.
//   2. evento 'storage' do localStorage - mesma coisa, pra navegador sem
//      BroadcastChannel. Nao substitui o item 1: 'storage' so dispara nas
//      OUTRAS abas, nunca na que escreveu, entao os dois juntos nao geram
//      eco.
//   3. POST /api/alarme/silenciado - o servidor repassa por SSE pras outras
//      sessoes DA MESMA PESSOA (celular + desktop). Sem isso, silenciar no
//      computador deixaria o celular tocando.
//
// A identidade (id do usuario logado) viaja junto e e conferida na chegada:
// duas contas diferentes no mesmo navegador nao podem calar o alarme uma da
// outra.
(function () {
  if (window.ZenithAlarmeSync) return;

  const CANAL = 'zenith-alarme';
  const CHAVE_LS = 'zenithAlarmeSilenciado';
  const TIPO = 'alarme-silenciado';

  let canal = null;
  try { canal = new BroadcastChannel(CANAL); } catch (e) { /* navegador antigo: fica so com o localStorage */ }

  let identidade = null;
  const ouvintes = [];

  function identificar(id) { identidade = id || null; }
  function aoSilenciar(cb) { if (typeof cb === 'function') ouvintes.push(cb); }

  function receber(msg) {
    if (!msg || msg.tipo !== TIPO) return;
    // so cala se veio do MESMO acesso. Quando um dos lados nao sabe quem e
    // (pagina de alarme aberta direto pela notificacao, antes do /api/me
    // responder), deixa passar: e o mesmo navegador, e errar pro lado de
    // calar e melhor que deixar tocando sozinho.
    if (identidade && msg.usuario && msg.usuario !== identidade) return;
    ouvintes.forEach((cb) => { try { cb(); } catch (e) { /* um ouvinte quebrado nao pode impedir os outros */ } });
  }

  if (canal) canal.addEventListener('message', (e) => receber(e.data));
  window.addEventListener('storage', (e) => {
    if (e.key !== CHAVE_LS || !e.newValue) return;
    try { receber(JSON.parse(e.newValue)); } catch (err) { /* valor estranho no storage - ignora */ }
  });

  // chamado por quem CLICOU em atender/silenciar. Quem só recebeu o aviso
  // nao chama isso - senao duas abas ficariam repassando a mesma mensagem
  // uma pra outra pra sempre.
  function silenciar() {
    const msg = { tipo: TIPO, usuario: identidade, em: Date.now() };
    try { if (canal) canal.postMessage(msg); } catch (e) { /* ignora */ }
    try { localStorage.setItem(CHAVE_LS, JSON.stringify(msg)); } catch (e) { /* storage cheio/bloqueado */ }
    // outros aparelhos com o mesmo login. Falhar aqui nao e problema: as
    // abas locais ja foram avisadas pelos dois caminhos acima.
    try {
      const token = localStorage.getItem('authToken');
      if (token) {
        fetch('/api/alarme/silenciado', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token },
        }).catch(() => { /* sem rede: silencia só localmente */ });
      }
    } catch (e) { /* ignora */ }
  }

  window.ZenithAlarmeSync = { identificar, aoSilenciar, silenciar };
})();
