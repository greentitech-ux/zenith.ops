/* aparelho.js — o que o NAVEGADOR sabe do aparelho, e manter a tela acordada.
 *
 * Master (23/09/2026): "quero poder monitorar tanto celular como tablet -
 * temos celulares e tablets no parque".
 *
 * Não existe agente pra Android/iOS: o NOCZenith é PowerShell e não roda em
 * celular; e nem iOS nem Android executam página em segundo plano de forma
 * confiável. O que existe é o que já monitora o quiosque hoje - a aba aberta
 * batendo presença (ver atendimento.html) - e este arquivo acrescenta a ela o
 * que faltava saber do aparelho: BATERIA, armazenamento, tipo de rede e
 * versão do sistema.
 *
 * Num parque de tablets, bateria é o dado que mais falta: "o tablet do salão
 * está com 8%" é o aviso que evita o aparelho morrer no meio do serviço - e
 * hoje ninguém tem como saber isso sem ir olhar.
 *
 * UM ARQUIVO SÓ, e não uma cópia por tela: são três telas batendo heartbeat
 * (index, atendimento, abastecimento) e CSS/JS copiado entre telas sempre
 * diverge na primeira correção.
 *
 * CUSTO: nada disso abre requisição nova. Viaja de carona no heartbeat que já
 * acontece a cada 25s, na mesma escrita que o servidor já fazia (CLAUDE.md
 * §3). Tudo aqui é best-effort: navegador que não souber responder devolve
 * nulo e o campo simplesmente não aparece - nunca um número inventado.
 */
(function () {
  'use strict';

  // A API de bateria só existe no Chrome/Edge (Android e desktop). No iOS ela
  // não existe, e é assim mesmo: melhor o campo não aparecer do que a tela
  // mostrar "100%" pra um iPad que nunca informou nada.
  var bateriaObj = null;
  function lerBateria() {
    try {
      if (!navigator.getBattery) return Promise.resolve(null);
      if (bateriaObj) return Promise.resolve(formatarBateria(bateriaObj));
      return navigator.getBattery().then(function (b) {
        bateriaObj = b; // o objeto se atualiza sozinho: pega uma vez e relê
        return formatarBateria(b);
      }).catch(function () { return null; });
    } catch (e) { return Promise.resolve(null); }
  }
  function formatarBateria(b) {
    if (!b || typeof b.level !== 'number') return null;
    return { porcento: Math.round(b.level * 100), carregando: !!b.charging };
  }

  // Espaço do aparelho, pela cota do navegador. Não é o disco inteiro (nenhum
  // navegador entrega isso), é o que o app pode usar - que é justamente o que
  // acaba e trava o quiosque.
  function lerArmazenamento() {
    try {
      if (!navigator.storage || !navigator.storage.estimate) return Promise.resolve(null);
      return navigator.storage.estimate().then(function (e) {
        if (!e || !e.quota) return null;
        var usadoGb = (e.usage || 0) / 1073741824;
        var totalGb = e.quota / 1073741824;
        return {
          usadoGb: Math.round(usadoGb * 100) / 100,
          totalGb: Math.round(totalGb * 100) / 100,
          usadoPct: Math.round(((e.usage || 0) / e.quota) * 100),
        };
      }).catch(function () { return null; });
    } catch (e) { return Promise.resolve(null); }
  }

  // Wi-Fi ou dados móveis, e a estimativa de velocidade. Serve pra separar
  // "a loja está lenta" de "esse tablet caiu pro 4G".
  function lerRede() {
    try {
      var c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      if (!c) return null;
      var saida = {};
      if (c.type) saida.tipo = String(c.type);
      if (c.effectiveType) saida.geracao = String(c.effectiveType);
      if (typeof c.downlink === 'number') saida.downlinkMbps = c.downlink;
      return Object.keys(saida).length ? saida : null;
    } catch (e) { return null; }
  }

  // O sistema do aparelho sai do User-Agent, que o heartbeat JÁ manda há
  // tempos e ninguém lia. Só o suficiente pra saber o que é e se está velho.
  function lerSistema() {
    var ua = navigator.userAgent || '';
    var m;
    if ((m = ua.match(/Android\s+([\d.]+)/))) return { nome: 'Android', versao: m[1], movel: true };
    if ((m = ua.match(/(?:iPhone )?OS ([\d_]+) like Mac OS X/))) return { nome: /iPad/.test(ua) ? 'iPadOS' : 'iOS', versao: m[1].replace(/_/g, '.'), movel: true };
    if (/iPad|iPhone|iPod/.test(ua)) return { nome: /iPad/.test(ua) ? 'iPadOS' : 'iOS', versao: null, movel: true };
    if ((m = ua.match(/Windows NT ([\d.]+)/))) return { nome: 'Windows', versao: m[1], movel: false };
    if (/Macintosh/.test(ua)) return { nome: 'macOS', versao: null, movel: false };
    if (/Linux/.test(ua)) return { nome: 'Linux', versao: null, movel: false };
    return null;
  }

  // O pacote que viaja no heartbeat. Devolve null quando não há NADA a contar
  // (navegador antigo), pra não gravar um objeto vazio no lugar do que já
  // estava gravado.
  window.aparelhoTelemetria = function () {
    return Promise.all([lerBateria(), lerArmazenamento()]).then(function (r) {
      var saida = {};
      if (r[0]) saida.bateria = r[0];
      if (r[1]) saida.armazenamento = r[1];
      var rede = lerRede();
      if (rede) saida.rede = rede;
      var so = lerSistema();
      if (so) saida.so = so;
      saida.toque = (navigator.maxTouchPoints || 0) > 0;
      return Object.keys(saida).length > 1 ? saida : null;
    }).catch(function () { return null; });
  };

  // MANTER A TELA ACORDADA. Tablet de quiosque que dorme para de bater
  // presença e some do NOC - e aí a loja aparece offline sem nada ter
  // acontecido. O bloqueio cai sozinho quando a aba vai pro fundo (regra do
  // navegador), então é preciso repor quando ela volta.
  //
  // Só existe no Chrome/Android e no Safari 16.4+. Onde não existir, a tela
  // segue funcionando igual - só continua dormindo como antes.
  var travaTela = null;
  function pedirTrava() {
    try {
      if (!navigator.wakeLock || document.visibilityState !== 'visible') return;
      navigator.wakeLock.request('screen').then(function (t) {
        travaTela = t;
        t.addEventListener('release', function () { travaTela = null; });
      }).catch(function () { /* bateria fraca ou aba em segundo plano: tudo bem */ });
    } catch (e) { /* navegador sem a API */ }
  }
  window.manterTelaAcordada = function () {
    pedirTrava();
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && !travaTela) pedirTrava();
    });
  };
})();
