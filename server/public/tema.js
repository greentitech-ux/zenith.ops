// tema.js
// Aparência do NoPulso por navegador (cada pessoa no seu aparelho): tema
// Escuro/Claro e tamanho da fonte. Carregado no <head> de TODAS as paginas
// (antes do body renderizar, pra nao "piscar" o tema errado). Os controles
// ficam numa secao "Aparência" no fim do menu ☰; a escolha e salva em
// localStorage e vale pra todas as telas.
//
// O tema claro funciona porque as 28 paginas usam o MESMO conjunto de
// variaveis CSS (--bg/--panel/--panel2/--line/--text/--muted/--ok/--warn/
// --bad/--accent + *-dim) - aqui a gente so sobrescreve as variaveis com
// uma paleta clara via :root[data-tema="claro"], sem tocar pagina a pagina.
// O tamanho da fonte usa zoom no <html> (as paginas medem tudo em px, entao
// mexer so no font-size nao escalaria nada).
(function () {
  if (window.__zenithTema) return;
  window.__zenithTema = true;

  // ---- fontes da marca (NoPulso) ----
  // Nao ha build no projeto: em vez de repetir o <link> nas 53 paginas, o
  // tema.js (que ja e carregado no <head> de todas) injeta o CSS das
  // fontes aqui. Archivo = titulos/corpo (--sans), JetBrains Mono =
  // numeros, rotulos e badges (--mono, que ja estava declarado mas caia no
  // fallback do sistema porque a fonte nunca era baixada).
  //
  // Servido pelo PROPRIO app (/fontes/), nao pelo CDN do Google: as lojas
  // tem piso de latencia alto e algumas ficam atras de rede restrita - uma
  // fonte que depende de fonts.gstatic.com e um ponto de falha externo num
  // app que roda o dia inteiro em maquina de balcao. Ver fontes/fontes.css.
  (function fontes() {
    if (document.getElementById('nopulso-fontes')) return;
    var css = document.createElement('link');
    css.id = 'nopulso-fontes';
    css.rel = 'stylesheet';
    css.href = '/fontes/fontes.css';
    document.head.appendChild(css);
  })();

  // Fundação compartilhada: foco visível, movimento reduzido, estados vazios
  // e conforto de toque sem obrigar cada uma das 56 telas a duplicar CSS.
  (function uiFoundation() {
    if (document.getElementById('nopulso-ui-foundation')) return;
    var css = document.createElement('link');
    css.id = 'nopulso-ui-foundation';
    css.rel = 'stylesheet';
    css.href = '/ui-foundation.css';
    document.head.appendChild(css);
  })();

  // ---- destaque do nome da unidade (loja) em tickets/chamados ----
  // Pedido do usuario: em qualquer card ou detalhe de ticket/chamado que
  // mostra o nome da unidade, ele tem que se destacar do resto da linha
  // (email, data, tipo) - antes tudo saia no mesmo tom, sem hierarquia
  // nenhuma, e o nome da loja se perdia no meio de metadado. Cor propria
  // (nao e o --accent da marca nem o --warn de severidade) porque isso aqui
  // nao e nem branding nem status - e "ONDE aconteceu", o dado que mais
  // importa pra quem esta escaneando uma lista de chamados de varias lojas.
  // Mora aqui (nao em cada pagina) pelo mesmo motivo das fontes/Beniboy:
  // tema.js e o UNICO arquivo carregado pelas 56 paginas.
  (function destaqueUnidade() {
    if (document.getElementById('zenith-destaque-unidade')) return;
    var css = document.createElement('style');
    css.id = 'zenith-destaque-unidade';
    css.textContent = [
      ':root{ --destaque-unidade:#ffd43b; }',
      // sobre fundo branco o amarelo claro quase some - versao escura
      // (mesma logica do --accent virar #5b8c00 no tema Claro)
      ':root[data-tema="claro"]{ --destaque-unidade:#8a6300; }',
      '.nome-unidade{ color:var(--destaque-unidade,#ffd43b); font-weight:800; font-size:1.08em; }',
    ].join('\n');
    document.head.appendChild(css);
  })();

  // ---- Beniboy: o avatar do assistente ----
  // Direcao aprovada no handoff de design (BENIBOY.md): circulo com o sinal
  // vital da marca - a MESMA polyline do logotipo NoPulso. Sem rosto, sem
  // olhos: o que "vive" e a linha de pulso. Substitui a cabeca de robo que
  // existia no widget e os emojis 🤖/🐝/🚨 espalhados pelas telas.
  //
  // Mora aqui pelo mesmo motivo das fontes: sao 6 lugares diferentes usando
  // o mesmo desenho (widget, atendimento, Central, menu, alarme) e o
  // tema.js ja e carregado por todas as paginas. Duplicar o SVG em 6
  // arquivos e o caminho mais curto pra eles divergirem na proxima mexida.
  //
  // A cor NUNCA e cravada: vem de var(--accent)/var(--accent2)/var(--bad)/
  // var(--ok), senao o tema Claro quebra (limao puro sobre branco e
  // ilegivel). A classe de estado troca so a cor e o ritmo.
  (function beniboy() {
    if (document.getElementById('nopulso-beniboy')) return;
    var st = document.createElement('style');
    st.id = 'nopulso-beniboy';
    st.textContent = [
      '.beniboy{flex:none;overflow:visible;color:var(--accent,#b8ff3c);}',
      '.beniboy .bb-nucleo,.beniboy .bb-anel,.beniboy .bb-eco,.beniboy .bb-traco{',
      '  stroke:currentColor;}',
      '.beniboy .bb-nucleo{fill:currentColor;stroke:none;}',
      '.beniboy .bb-fundo{fill:var(--panel,#12161b);}',
      /* A LINHA NUNCA DESAPARECE. A base fica solida na cor do estado e um
         brilho curto corre por cima. O "tracar e apagar" que existia aqui
         deixava o avatar vazio ~250ms por ciclo - em 40px no canto isso e
         batimento, em 112px numa tela de alarme parece defeito, e num PDF
         ou PPTX, que congela um frame, sai pela metade. Mesma mecanica do
         logotipo (ver marcaViva abaixo). */
      '.beniboy .bb-traco{filter:drop-shadow(0 0 5px currentColor);}',
      '.beniboy .bb-brilho{stroke:var(--pulso-brilho,#fff);stroke-dasharray:9 64;opacity:.9;',
      '  animation:bb-brilho var(--bb-ritmo,2.6s) linear infinite;}',
      '.beniboy .bb-nucleo{transform-box:fill-box;transform-origin:center;',
      '  animation:bb-nucleo var(--bb-ritmo,2.6s) ease-in-out infinite;}',
      '.beniboy .bb-anel{animation:bb-anel var(--bb-ritmo,2.6s) ease-in-out infinite;}',
      /* estados: so a cor e o ritmo mudam - o desenho e sempre o mesmo */
      '.beniboy.pensando{--bb-ritmo:1.7s;color:var(--accent2,#5cc8ff);}',
      '.beniboy.alarme{--bb-ritmo:1.1s;color:var(--bad,#ff5c5c);}',
      '.beniboy.resolvido{--bb-ritmo:3.6s;color:var(--ok,#3ddc97);}',
      /* no alarme em tela cheia o fundo ja e vermelho: o avatar vai em branco */
      '.beniboy.no-vermelho{color:#fff;}',
      '.beniboy.no-vermelho .bb-fundo{fill:rgba(255,255,255,.10);}',
      '.beniboy.no-vermelho .bb-brilho{stroke:#0b0d10;opacity:.5;}',
      '@keyframes bb-brilho{0%{stroke-dashoffset:73;}100%{stroke-dashoffset:-73;}}',
      '@keyframes bb-nucleo{0%,100%{transform:scale(.82);opacity:.16;}42%{transform:scale(1);opacity:.34;}}',
      '@keyframes bb-anel{0%,100%{opacity:.62;}42%{opacity:1;}}',
      '@media (prefers-reduced-motion:reduce){',
      '  .beniboy .bb-brilho{animation:none;opacity:0;}',
      '  .beniboy .bb-nucleo,.beniboy .bb-anel{animation:none;}}'
    ].join('\n');
    document.head.appendChild(st);
  })();

  // ---- a marca tambem bate ----
  // Decisao do usuario: onde tiver o sinal vital, ele se mexe - inclusive no
  // logotipo. Mas logotipo que SOME nao serve: a linha de base fica sempre
  // inteira e o que anda e um pulso claro por cima dela, como o cursor de um
  // monitor cardiaco. Assim a marca se move sem nunca ficar ilegivel.
  //
  // O ritmo e mais lento que o do Beniboy (3,6s x 2,6s) de proposito: as duas
  // coisas se mexem, mas quem chama atencao continua sendo o assistente.
  //
  // Comprimento real da polyline do logotipo: ~92,8 no viewBox 64x40 - o
  // dasharray de 96 cobre ela inteira com folga.
  (function marcaViva() {
    if (document.getElementById('nopulso-marca-viva')) return;
    var st = document.createElement('style');
    st.id = 'nopulso-marca-viva';
    st.textContent = [
      '.marca-brilho{stroke:var(--pulso-brilho,#fff);stroke-dasharray:12 82;opacity:.85;',
      '  animation:marca-brilho 3.2s linear infinite;}',
      '@keyframes marca-brilho{0%{stroke-dashoffset:94;}100%{stroke-dashoffset:-94;}}',
      '@media (prefers-reduced-motion:reduce){ .marca-brilho{animation:none;opacity:0;} }'
    ].join('\n');
    document.head.appendChild(st);
  })();

  // Devolve o SVG do Beniboy no tamanho pedido. `classes` aceita o estado
  // ('pensando', 'alarme', 'resolvido') e o 'no-vermelho' da tela de alarme.
  // Geometria fixa em viewBox 64x64 - so width/height mudam.
  window.beniboySVG = function (px, classes) {
    var t = px || 48;
    var pts = '14,34 22,34 27,21 33,45 38,32 50,32';
    return '<svg width="' + t + '" height="' + t + '" viewBox="0 0 64 64" fill="none"'
      + ' class="beniboy' + (classes ? ' ' + classes : '') + '" aria-hidden="true">'
      + '<circle class="bb-fundo" cx="32" cy="32" r="30"></circle>'
      + '<circle class="bb-nucleo" cx="32" cy="32" r="22"></circle>'
      + '<circle class="bb-anel" cx="32" cy="32" r="30" stroke-width="2.5" fill="none"></circle>'
      + '<polyline class="bb-traco" points="' + pts + '" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" fill="none"></polyline>'
      + '<polyline class="bb-brilho" points="' + pts + '" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" fill="none"></polyline>'
      + '</svg>';
  };

  // ---- VER ANTES DE BAIXAR (window.verRelatorio) ----
  // Pedido do Master: "todo relatorio de PDF ou CSV tem que ter o botao de
  // ver, pra antes de fazer download poder ver antes". Sao 47 rotas de
  // relatorio e 63 botoes espalhados por 25 telas - por isso o visualizador
  // mora AQUI, no unico arquivo que as 53 paginas ja carregam, e nao
  // copiado tela a tela (foi assim que o robo antigo virou duas copias
  // divergentes; ver o comentario do Beniboy acima).
  //
  // NADA MUDA NO SERVIDOR. O truque e buscar o arquivo por fetch e mostrar
  // o BLOB: um blob: dentro de um <iframe> abre no leitor de PDF do
  // navegador mesmo com o Content-Disposition: attachment que as 42 rotas
  // mandam - o cabecalho so vale pra navegacao, nao pro blob que ja esta
  // na memoria. Sem isso seria preciso um parametro `inline` em 42 lugares.
  //
  // E O BAIXAR SAI DO MESMO BLOB, de proposito: ver e depois baixar
  // custaria DUAS geracoes do relatorio, e relatorio aqui le Firestore
  // (que cobra por documento devolvido - ver secao 3 do CLAUDE.md). Assim
  // ver+baixar custa o mesmo que o download de hoje.
  var CSV_LINHAS_NA_TELA = 300;

  // parser de CSV de verdade (aspas, aspa dupla escapada, virgula e quebra
  // de linha DENTRO do campo). Um split(',') mostraria a coluna trocada em
  // qualquer relatorio com observacao ou nome de item com virgula - e a
  // tela existe justamente pra conferir antes de mandar pra reuniao.
  function lerCSV(texto) {
    var linhas = [];
    var campo = '';
    var linha = [];
    var aspas = false;
    var t = String(texto || '').replace(/^﻿/, '');
    for (var i = 0; i < t.length; i += 1) {
      var c = t[i];
      if (aspas) {
        if (c === '"') {
          if (t[i + 1] === '"') { campo += '"'; i += 1; } else { aspas = false; }
        } else { campo += c; }
      } else if (c === '"') { aspas = true; } else if (c === ',') {
        linha.push(campo); campo = '';
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && t[i + 1] === '\n') i += 1;
        linha.push(campo); campo = '';
        linhas.push(linha); linha = [];
      } else { campo += c; }
    }
    if (campo.length || linha.length) { linha.push(campo); linhas.push(linha); }
    return linhas.filter(function (l) { return l.length > 1 || (l[0] || '').trim() !== ''; });
  }

  function escaparHtml(v) {
    return String(v == null ? '' : v)
      .split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;')
      .split('"').join('&quot;');
  }

  // nome do arquivo como o SERVIDOR mandou - as rotas ja montam um nome com
  // periodo e unidade, e reinventar aqui daria dois nomes pro mesmo arquivo
  function nomeDoCabecalho(disp, url) {
    var m = /filename="?([^";]+)"?/.exec(String(disp || ''));
    if (m) return m[1];
    var caminho = String(url).split('?')[0].split('/').pop();
    return caminho || 'relatorio';
  }

  function estiloVisualizador() {
    if (document.getElementById('zrel-css')) return;
    var st = document.createElement('style');
    st.id = 'zrel-css';
    // Sem cor cravada: no tema Claro o --accent vira verde escuro (ver
    // aplicar() abaixo) e um #b8ff3c aqui ficaria ilegivel no branco - foi
    // exatamente o que aconteceu no suporte-chat.js.
    st.textContent = ''
      + '.zrel-fundo{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.72);'
      + 'display:flex;align-items:center;justify-content:center;padding:16px;}'
      + '.zrel-caixa{background:var(--panel,#12161c);border:1px solid var(--line,#232a33);'
      + 'border-radius:12px;width:min(1100px,100%);height:min(88vh,100%);display:flex;'
      + 'flex-direction:column;overflow:hidden;box-shadow:0 18px 60px rgba(0,0,0,.5);}'
      + '.zrel-topo{display:flex;align-items:center;gap:10px;padding:11px 14px;'
      + 'border-bottom:1px solid var(--line,#232a33);flex-wrap:wrap;}'
      + '.zrel-titulo{font-family:var(--mono,monospace);font-size:12px;color:var(--text,#e6edf3);'
      + 'font-weight:700;flex:1;min-width:140px;word-break:break-all;}'
      + '.zrel-btn{border:1px solid var(--line,#232a33);background:var(--panel2,#181d24);'
      + 'color:var(--text,#e6edf3);border-radius:8px;padding:7px 13px;font-size:12px;'
      + 'font-weight:700;cursor:pointer;font-family:var(--sans,sans-serif);}'
      + '.zrel-btn.baixar{background:var(--accent,#b8ff3c);color:#0b0d10;border-color:transparent;}'
      + '.zrel-btn[disabled]{opacity:.5;cursor:default;}'
      + '.zrel-corpo{flex:1;overflow:auto;background:var(--bg,#0b0d10);}'
      + '.zrel-corpo iframe{width:100%;height:100%;border:0;display:block;background:#fff;}'
      + '.zrel-aviso{padding:18px;font-size:12.5px;color:var(--muted,#8b949e);'
      + 'font-family:var(--sans,sans-serif);}'
      + '.zrel-aviso b{color:var(--bad,#f85149);}'
      + '.zrel-tab{width:100%;border-collapse:collapse;font-family:var(--mono,monospace);font-size:11.5px;}'
      + '.zrel-tab th,.zrel-tab td{border-bottom:1px solid var(--line,#232a33);padding:6px 9px;'
      + 'text-align:left;vertical-align:top;white-space:pre-wrap;color:var(--text,#e6edf3);}'
      + '.zrel-tab th{position:sticky;top:0;background:var(--panel2,#181d24);color:var(--muted,#8b949e);'
      + 'font-size:10.5px;text-transform:uppercase;letter-spacing:.5px;z-index:1;}'
      + '.zrel-tab tr:nth-child(even) td{background:rgba(127,127,127,.05);}';
    document.head.appendChild(st);
  }

  // Mostra o relatorio e so depois oferece o download. `url` e a MESMA que o
  // botao ja usava (com o token na query), entao nenhuma tela precisa saber
  // como o arquivo e buscado.
  window.verRelatorio = function (url, titulo) {
    estiloVisualizador();
    var ehCsv = /\.csv(\?|$)/i.test(String(url));
    var blobUrl = null;
    var fundo = document.createElement('div');
    fundo.className = 'zrel-fundo';
    fundo.innerHTML = ''
      + '<div class="zrel-caixa" role="dialog" aria-modal="true">'
      + '<div class="zrel-topo">'
      + '<span class="zrel-titulo">' + escaparHtml(titulo || (ehCsv ? 'Relatório CSV' : 'Relatório PDF')) + '</span>'
      + '<button type="button" class="zrel-btn baixar" disabled>⬇ Baixar</button>'
      + '<button type="button" class="zrel-btn fechar">Fechar</button>'
      + '</div>'
      + '<div class="zrel-corpo"><div class="zrel-aviso">Gerando o relatório…</div></div>'
      + '</div>';
    document.body.appendChild(fundo);

    var corpo = fundo.querySelector('.zrel-corpo');
    var btnBaixar = fundo.querySelector('.zrel-btn.baixar');

    function fechar() {
      // solta a memoria do blob: sem isso, abrir dez relatorios grandes numa
      // sessao deixa dez copias presas ate a aba fechar
      if (blobUrl) { try { URL.revokeObjectURL(blobUrl); } catch (e) { /* ok */ } }
      document.removeEventListener('keydown', naTecla);
      if (fundo.parentNode) fundo.parentNode.removeChild(fundo);
    }
    function naTecla(e) { if (e.key === 'Escape') fechar(); }
    document.addEventListener('keydown', naTecla);
    fundo.querySelector('.zrel-btn.fechar').addEventListener('click', fechar);
    // clique no fundo fecha; clique DENTRO da caixa nao
    fundo.addEventListener('click', function (e) { if (e.target === fundo) fechar(); });

    fetch(url).then(function (r) {
      if (!r.ok) {
        // as rotas devolvem { error } com 400 - mostrar a mensagem do
        // servidor ("Período inválido") vale mais que "falhou"
        return r.text().then(function (t) {
          var msg = t;
          try { msg = JSON.parse(t).error || t; } catch (e) { /* nao era JSON */ }
          throw new Error(msg || ('Erro ' + r.status));
        });
      }
      var nome = nomeDoCabecalho(r.headers.get('Content-Disposition'), url);
      return r.blob().then(function (b) { return { blob: b, nome: nome }; });
    }).then(function (d) {
      blobUrl = URL.createObjectURL(d.blob);
      btnBaixar.disabled = false;
      btnBaixar.addEventListener('click', function () {
        var a = document.createElement('a');
        a.href = blobUrl;
        a.download = d.nome;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      });
      if (!ehCsv) {
        // CELULAR NAO MOSTRA PDF DENTRO DE IFRAME. O Chrome do Android nao
        // tem leitor embutido: em vez da pagina, ele desenha um cartao cinza
        // com o id do blob e um botao "Abrir" - parece que o app quebrou.
        // navigator.pdfViewerEnabled diz exatamente isso (false no Android,
        // true no desktop); onde a propriedade nao existe, o user-agent
        // resolve. Sem essa checagem a tela de "ver antes de baixar" fica
        // pior que nao ter tela nenhuma no aparelho onde a loja mais usa.
        var mostraPdf = ('pdfViewerEnabled' in navigator)
          ? navigator.pdfViewerEnabled
          : !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
        if (mostraPdf) {
          corpo.innerHTML = '<iframe title="Relatório"></iframe>';
          corpo.querySelector('iframe').src = blobUrl;
          return null;
        }
        corpo.innerHTML = '<div class="zrel-aviso">'
          + 'Este navegador não abre PDF dentro da página. Toque em <b>Abrir o PDF</b> '
          + 'para ver no leitor do aparelho, ou em <b>Baixar</b> para guardar o arquivo.'
          + '<div style="margin-top:12px;"><button type="button" class="zrel-btn baixar" '
          + 'data-abrir="1">Abrir o PDF</button></div></div>';
        corpo.querySelector('[data-abrir]').addEventListener('click', function () {
          window.open(blobUrl, '_blank');
        });
        return null;
      }
      return d.blob.text().then(function (texto) {
        var linhas = lerCSV(texto);
        if (!linhas.length) { corpo.innerHTML = '<div class="zrel-aviso">O relatório saiu vazio.</div>'; return null; }
        var cab = linhas[0];
        var dados = linhas.slice(1);
        // planilha grande nao vira 5 mil linhas de DOM: a tela e pra
        // conferir, e o arquivo baixado continua completo
        var mostrar = dados.slice(0, CSV_LINHAS_NA_TELA);
        var html = '<table class="zrel-tab"><thead><tr>';
        cab.forEach(function (c) { html += '<th>' + escaparHtml(c) + '</th>'; });
        html += '</tr></thead><tbody>';
        mostrar.forEach(function (l) {
          html += '<tr>';
          for (var i = 0; i < cab.length; i += 1) html += '<td>' + escaparHtml(l[i]) + '</td>';
          html += '</tr>';
        });
        html += '</tbody></table>';
        if (dados.length > mostrar.length) {
          html += '<div class="zrel-aviso">Mostrando ' + mostrar.length + ' de '
            + dados.length + ' linhas. O arquivo baixado tem todas.</div>';
        }
        corpo.innerHTML = html;
        return null;
      });
    }).catch(function (err) {
      corpo.innerHTML = '<div class="zrel-aviso"><b>Não deu pra gerar o relatório.</b><br>'
        + escaparHtml(err && err.message ? err.message : 'Tente de novo.') + '</div>';
    });
  };


  // ---- COLAR PRINT COM CTRL+V EM QUALQUER CHAT ----
  // Pedido do usuario: "quero poder enviar imagens printadas quando eu apertar
  // Ctrl+V ... em TODOS os chats". Quem descreve um problema tira print o
  // tempo todo; obrigar a salvar em arquivo e depois procurar o 📎/📷 e
  // trabalho que nao precisa existir.
  //
  // MORA NO tema.js DE PROPOSITO: e a unica coisa carregada pelas 53 paginas.
  // O chat do NoPulso esta em sete lugares (widget do Beniboy, atendimento,
  // Central, tecnico, manutencao, conversa do pedido e a janela do NOC) e
  // cada um tem seu proprio desenho de rodape. Copiar esta funcao pra dentro
  // de cada tela e exatamente como o robo antigo virou duas copias
  // divergentes (ver CLAUDE.md secao 2).
  //
  // COMO FUNCIONA: o print entra no MESMO <input type=file> que o botao de
  // anexo ja usa, via DataTransfer, e a funcao dispara um evento 'change'
  // nele. Com isso o onchange que a tela JA TEM (trocar o icone, mostrar a
  // previa, somar anexo) roda igualzinho ao caminho do botao - envio, icone e
  // limpar continuam sendo um caminho so. Se a imagem colada virasse um
  // estado paralelo, o dia em que alguem mexesse no envio quebraria metade
  // dos anexos.
  var LIMITE_ANEXO_COLADO = 8 * 1024 * 1024; // igual ao uploadChatAnexo do servidor

  function nomeDePrint(tipo) {
    // colado do Windows o arquivo vem sempre "image.png", e uma conversa com
    // quatro anexos "image.png" nao diz qual e qual
    var ext = String(tipo || '').split('/')[1] || 'png';
    ext = ext.replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '') || 'png';
    var d = new Date();
    function p(n) { return String(n).padStart(2, '0'); }
    return 'print-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate())
      + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '.' + ext;
  }

  function imagemDoClipboard(ev) {
    var itens = (ev.clipboardData && ev.clipboardData.items) || [];
    for (var i = 0; i < itens.length; i++) {
      if (itens[i].kind === 'file' && /^image\//.test(itens[i].type || '')) {
        return itens[i].getAsFile();
      }
    }
    return null;
  }

  function estiloPrevia() {
    if (document.getElementById('zpv-estilo')) return;
    var st = document.createElement('style');
    st.id = 'zpv-estilo';
    st.textContent = ''
      + '.zpv{display:none;align-items:center;gap:8px;padding:6px 8px;margin:0 0 6px;'
      + 'border:1px solid var(--line,#2a2f3a);border-radius:8px;background:var(--panel2,rgba(127,127,127,.08));}'
      + '.zpv.tem{display:flex;}'
      + '.zpv img{width:44px;height:44px;object-fit:cover;border-radius:6px;flex-shrink:0;}'
      + '.zpv-nome{flex:1;min-width:0;font-size:11.5px;opacity:.75;'
      + 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}'
      + '.zpv-tirar{background:none;border:0;color:var(--bad,#f85149);cursor:pointer;font-size:14px;padding:0 4px;}';
    document.head.appendChild(st);
  }

  // previa embutida: quem passa `previa` ganha a miniatura + o ✕ sem escrever
  // nada. O ✕ limpa o input e dispara 'change' de novo, entao o icone da tela
  // volta sozinho ao estado "sem anexo".
  function desenharPrevia(caixa, inputArquivo) {
    var arq = inputArquivo.files && inputArquivo.files[0];
    if (!arq) { caixa.classList.remove('tem'); caixa.innerHTML = ''; return; }
    var ehImagem = /^image\//.test(arq.type || '');
    var url = ehImagem ? URL.createObjectURL(arq) : '';
    var img = document.createElement('img');
    var nome = document.createElement('span');
    var tirar = document.createElement('button');
    caixa.innerHTML = '';
    if (url) { img.src = url; img.alt = 'print colado'; caixa.appendChild(img); }
    nome.className = 'zpv-nome';
    nome.textContent = (arq.name || 'anexo') + ' · ' + Math.round(arq.size / 1024) + ' KB';
    tirar.type = 'button';
    tirar.className = 'zpv-tirar';
    tirar.title = 'Tirar';
    tirar.textContent = '✕';
    tirar.addEventListener('click', function () {
      if (url) URL.revokeObjectURL(url);
      inputArquivo.value = '';
      inputArquivo.dispatchEvent(new Event('change', { bubbles: true }));
    });
    caixa.appendChild(nome);
    caixa.appendChild(tirar);
    caixa.classList.add('tem');
  }

  // campoTexto: o <input>/<textarea> onde a pessoa digita a mensagem
  // inputArquivo: o <input type=file> que o botao de anexo daquele chat usa
  // opcoes.previa: elemento (ou seletor) que recebe a miniatura - opcional
  // opcoes.aoColar(arquivo): pra tela que ja tem previa propria (widget)
  // Devolve false quando nao deu pra ligar, pra ninguem achar que ligou.
  window.colarImagemNoChat = function (campoTexto, inputArquivo, opcoes) {
    var o = opcoes || {};
    if (typeof campoTexto === 'string') campoTexto = document.querySelector(campoTexto);
    if (typeof inputArquivo === 'string') inputArquivo = document.querySelector(inputArquivo);
    if (!campoTexto || !inputArquivo) return false;
    if (campoTexto.__zcColar) return true; // rechamada (tela que remonta o HTML)
    campoTexto.__zcColar = true;

    var caixa = typeof o.previa === 'string' ? document.querySelector(o.previa) : (o.previa || null);
    if (caixa) {
      estiloPrevia();
      caixa.classList.add('zpv');
      // a previa acompanha o input pelo 'change', entao ela vale tambem pro
      // 📎: quem escolheu pelo seletor tambem merece ver o que vai junto
      inputArquivo.addEventListener('change', function () { desenharPrevia(caixa, inputArquivo); });
    }

    campoTexto.addEventListener('paste', function (ev) {
      var arquivo = imagemDoClipboard(ev);
      // sem imagem na area de transferencia e colagem normal de TEXTO - nao
      // pode ser interceptada
      if (!arquivo) return;
      ev.preventDefault();
      if (arquivo.size > LIMITE_ANEXO_COLADO) {
        alert('Esse print tem ' + Math.round(arquivo.size / 1024 / 1024)
          + ' MB e o limite é 8 MB. Salve como JPG ou recorte só a parte que importa.');
        return;
      }
      var comNome = new File([arquivo], nomeDePrint(arquivo.type), { type: arquivo.type });
      try {
        var dt = new DataTransfer();
        dt.items.add(comNome);
        inputArquivo.files = dt.files;
      } catch (err) {
        // navegador antigo sem DataTransfer: o botao de anexo continua indo
        alert('Este navegador não deixa colar imagem. Use o botão de anexo pra escolher o arquivo.');
        return;
      }
      // e o 'change' que faz a tela reagir (icone, previa, contador). Sem ele
      // o arquivo iria junto no envio mas ninguem veria que tem print.
      inputArquivo.dispatchEvent(new Event('change', { bubbles: true }));
      if (typeof o.aoColar === 'function') o.aoColar(comNome);
    });
    return true;
  };

  // ---- aviso de mudanca de endereco ----
  // Quem entra pelo endereco antigo (adyen-monitor.onrender.com) precisa
  // saber que o NoPulso mudou de casa - senao continua usando o velho pra
  // sempre, com o atalho antigo na tela inicial. O endereco de destino vem
  // do servidor (/api/meta/endereco), que devolve o APP_BASE_URL: cravar o
  // dominio novo aqui quebraria a regra de que ele e a UNICA fonte.
  //
  // DUAS TELAS FICAM DE FORA, DE PROPOSITO: index.html na raiz e
  // abastecimento.html sao as que fazem heartbeat pelo navegador na maquina
  // de loja. localStorage e por origem - se alguem clicar no aviso ali, o
  // zenithMonitorFixo some, a maquina esquece que unidade monitora e a loja
  // passa a acusar offline no NOC. Nessas o vigia migra sozinho.
  //
  // Tambem so aparece pra quem tem authToken: cliente em pagina publica
  // (atendimento, estorno) nao ve. Se visse e clicasse, perderia a conversa
  // em andamento, que tambem mora no localStorage da origem antiga.
  var HOST_ANTIGO = 'adyen-monitor.onrender.com';
  var TELAS_DE_HEARTBEAT = ['/', '/index.html', '/abastecimento.html'];

  function avisarEnderecoNovo() {
    if (location.hostname !== HOST_ANTIGO) return;
    if (TELAS_DE_HEARTBEAT.indexOf(location.pathname) !== -1) return;
    try {
      if (!localStorage.getItem('authToken')) return;
      if (sessionStorage.getItem('nopulsoAvisoEndereco') === 'fechado') return;
    } catch (e) { return; }

    fetch('/api/meta/endereco').then(function (r) { return r.json(); }).then(function (d) {
      var oficial = (d && d.oficial) || '';
      if (!oficial) return;
      var destino;
      try { destino = new URL(oficial); } catch (e) { return; }
      if (destino.origin === location.origin) return;   // ja esta no endereco certo

      var st = document.createElement('style');
      st.textContent = [
        '#nopulso-mudou{position:fixed;left:0;right:0;bottom:0;z-index:99998;',
        '  background:var(--panel2,#181d24);border-top:2px solid var(--accent,#b8ff3c);',
        '  color:var(--text,#e7ecf1);padding:14px 16px;display:flex;gap:14px;',
        '  align-items:center;justify-content:center;flex-wrap:wrap;',
        "  font-family:'Archivo',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;",
        '  box-shadow:0 -6px 20px rgba(0,0,0,.35);}',
        '#nopulso-mudou .txt{font-size:13.5px;line-height:1.45;max-width:56ch;}',
        '#nopulso-mudou b{color:var(--accent,#b8ff3c);}',
        '#nopulso-mudou .acoes{display:flex;gap:8px;flex-wrap:wrap;}',
        '#nopulso-mudou a.ir{background:var(--accent,#b8ff3c);color:#0b0d10;text-decoration:none;',
        '  border-radius:8px;padding:9px 16px;font-size:13px;font-weight:700;white-space:nowrap;}',
        '#nopulso-mudou button.depois{background:none;border:1px solid var(--line,#232a33);',
        '  color:var(--muted,#7d8896);border-radius:8px;padding:9px 14px;font-size:13px;cursor:pointer;}',
        '@media(max-width:520px){#nopulso-mudou{flex-direction:column;align-items:stretch;text-align:center;}',
        '  #nopulso-mudou .acoes{justify-content:center;}}'
      ].join('\n');
      document.head.appendChild(st);

      var barra = document.createElement('div');
      barra.id = 'nopulso-mudou';
      barra.setAttribute('role', 'status');
      barra.innerHTML =
        '<div class="txt">O NoPulso mudou de endereço para <b>' + destino.host + '</b>. '
        + 'Entre por lá e reinstale o atalho na tela inicial — o ícone e o nome antigos só trocam '
        + 'depois de reinstalar. O 🔔 precisa ser ativado uma vez no endereço novo.</div>'
        + '<div class="acoes">'
        + '<a class="ir" href="' + destino.origin + '">Abrir no endereço novo</a>'
        + '<button type="button" class="depois">Agora não</button>'
        + '</div>';
      document.body.appendChild(barra);
      barra.querySelector('.depois').addEventListener('click', function () {
        try { sessionStorage.setItem('nopulsoAvisoEndereco', 'fechado'); } catch (e) {}
        barra.remove();
      });
    }).catch(function () { /* sem aviso e melhor que erro na tela */ });
  }

  var LS_TEMA = 'zenithTema';   // 'escuro' (padrao) | 'claro'
  var LS_FONTE = 'zenithFonte'; // percentual: 80..150 (padrao 100)
  var FONTE_MIN = 80, FONTE_MAX = 150, FONTE_PASSO = 10;

  function temaAtual() {
    return localStorage.getItem(LS_TEMA) === 'claro' ? 'claro' : 'escuro';
  }
  function fonteAtual() {
    var v = parseInt(localStorage.getItem(LS_FONTE), 10);
    return Number.isFinite(v) ? Math.min(FONTE_MAX, Math.max(FONTE_MIN, v)) : 100;
  }

  // paleta clara: mesmas variaveis, valores pro fundo branco. O accent fica
  // mais escuro que o azul do tema escuro pra continuar legivel como TEXTO
  // sobre branco (e ainda funcionar como fundo de botao)
  var style = document.createElement('style');
  style.id = 'zenith-tema-claro';
  style.textContent = [
    ':root[data-tema="claro"]{',
    '  --bg:#eef1f5; --panel:#ffffff; --panel2:#f2f5f8; --line:#d3dae2;',
    '  --text:#1d2733; --muted:#5d6a78;',
    '  --ok:#0e8a5f; --ok-dim:#dcf3e9;',
    '  --warn:#8f6400; --warn-dim:#faeccb;',
    '  --bad:#c62f2f; --bad-dim:#fbe3e3;',
    // limao escurecido: o #b8ff3c da marca e ilegivel como TEXTO sobre
    // branco. Este tom mantem a familia da marca e da ~5:1 contra o branco
    // (texto) e ~5:1 contra o #0b0d10 (label de botao), no mesmo patamar do
    // azul que estava aqui antes.
    '  --accent:#5b8c00;',
    // --accent2 (dado tecnico) tambem precisa de versao clara: o ciano
    // #5cc8ff some no fundo branco. Reaproveita o azul que era o --accent.
    '  --accent2:#0d7ac2;',
    // O brilho que corre pelo traco (marca e Beniboy) e BRANCO no Escuro,
    // onde ele e mais claro que o limao. Sobre fundo branco, branco vira
    // buraco: o traco parece cortado em vez de aceso. No Claro ele vira um
    // verde bem mais escuro que o --accent, que e o que 'mais aceso'
    // significa nesse fundo. Mesma logica do --accent virar #5b8c00.
    '  --pulso-brilho:#1f3300;',
    // variaveis proprias do Abastecimento (balões/botões de PEDIDO x ENVIO
    // da "Conversa do pedido") - sem isso o balão ficava escuro com texto
    // escuro no tema claro (ilegivel, reportado em 2026-08-09)
    '  --pedido:#c62828; --pedido-dim:#fde7e5;',
    '  --envio:#175fb4; --envio-dim:#e4edfb;',
    '}',
     // paginas pintam o body com a var --bg, mas garante mesmo se alguma
     // tiver a cor no proprio body
     ':root[data-tema="claro"] body{background:var(--bg);color:var(--text);}',
     // O claro nao pode ser apenas o escuro invertido: cards brancos em cima
     // de branco desapareciam, os blocos pareciam soltos e chips herdados
     // com fundo #181d24 ficavam pesados. Estas regras mantem a hierarquia
     // visual sem alterar o HTML nem a estrutura particular de cada tela.
     ':root[data-tema="claro"]{--bg:#f3f6f8;--panel:#fff;--panel2:#f7f9fb;--line:#cbd5df;--text:#17212b;--muted:#526477;}',
     ':root[data-tema="claro"] header{background:color-mix(in srgb,var(--panel) 92%,var(--bg));box-shadow:0 1px 0 rgba(23,33,43,.06),0 5px 14px rgba(23,33,43,.04);}',
     ':root[data-tema="claro"] .panel,:root[data-tema="claro"] .col,:root[data-tema="claro"] .sheet,:root[data-tema="claro"] .dialog{box-shadow:0 2px 7px rgba(23,33,43,.055);}',
     ':root[data-tema="claro"] .kcard,:root[data-tema="claro"] .task,:root[data-tema="claro"] .card,:root[data-tema="claro"] .status-toggle-btn{box-shadow:0 1px 3px rgba(23,33,43,.035);}',
     ':root[data-tema="claro"] .status-toggle-btn.aberto,:root[data-tema="claro"] .tipo-filtro-btn.active,:root[data-tema="claro"] a.back.active{background:#f0f7df;border-color:#628d19;color:#456a00;}',
     ':root[data-tema="claro"] .status-toggle-btn.aberto .stb-count{color:#456a00;}',
     ':root[data-tema="claro"] .triagem-nota{background:#f5f8fb;border-color:#c8d3de;color:#44576a;}',
     ':root[data-tema="claro"] .tipo-badge,:root[data-tema="claro"] span.tipo-badge[style*="background:#181d24"]{background:#e9eff4!important;color:#405367!important;border-color:#c7d2dc!important;}',
     ':root[data-tema="claro"] .badge.PENDENTE{background:#fff3cf;color:#765300;}',
     ':root[data-tema="claro"] .btn-notif,:root[data-tema="claro"] .hamburger-btn{background:#fff;box-shadow:0 1px 3px rgba(23,33,43,.06);}',
   ].join('\n');
  document.head.appendChild(style);

  // ---- barra de rolagem: a mesma em TODAS as telas ----
  //
  // Pedido do Master: "quero que todos os scroll sejam como o scroll que
  // atualizamos para Meu Dia - Tarefas fica otimo".
  //
  // O padrão do Chrome no Windows/Linux é uma barra larga e clara, com setas
  // nas pontas - sobre o fundo escuro do app ela vira uma faixa branca que
  // pesa mais que o conteúdo (aparecia assim na Central do Beniboy, no cartão
  // da máquina no NOC e em cada janela de conversa). O desenho do Meu Dia é o
  // contrário: fina, arredondada, invisível em repouso, e só aparece quando o
  // mouse entra no bloco que rola.
  //
  // Fica AQUI, e não em cada página, pela mesma razão do Beniboy: cópia por
  // página diverge. Já havia três desenhos diferentes soltos - 6px no Meu Dia,
  // 8px sempre sólida no menu ☰, e só "thin" na Central e nos Formulários.
  // Tela nova nasce com a barra certa sem ninguém lembrar de nada.
  //
  // Cor pelo token: --line em repouso, --muted sob o dedo. No tema Claro os
  // dois trocam sozinhos junto com o resto; cor cravada aqui ficaria escura
  // sobre branco em 59 telas de uma vez.
  //
  // O seletor é `*` de propósito (especificidade 0): qualquer página que já
  // tenha regra própria continua ganhando, nada quebra por causa desta.
  var barras = document.createElement('style');
  barras.id = 'zenith-barras';
  barras.textContent = [
    '*{scrollbar-width:thin;scrollbar-color:transparent transparent;}',
    // :hover pega o container inteiro, não só o pixel da barra - senão a
    // pessoa teria de acertar 6px invisíveis para a barra aparecer
    '*:hover{scrollbar-color:var(--line,#27313b) transparent;}',
    '::-webkit-scrollbar{width:6px;height:6px;}',
    '::-webkit-scrollbar-track{background:transparent;}',
    '::-webkit-scrollbar-corner{background:transparent;}',
    // as setinhas das pontas são metade da largura daquela faixa branca
    '::-webkit-scrollbar-button{display:none;}',
    '::-webkit-scrollbar-thumb{background:transparent;border-radius:999px;}',
    ':hover::-webkit-scrollbar-thumb{background:var(--line,#27313b);}',
    '::-webkit-scrollbar-thumb:hover{background:var(--muted,#8c99a7);}',
  ].join('\n');
  document.head.appendChild(barras);

  // ---- botão de fechar de painel/ficha ----
  //
  // Pedido do Master: "quero que os botões de fechar sejam todos desse estilo,
  // para telas como essa; popup mantém como está". O estilo é o ✕ redondo que
  // já fecha a ficha do ticket na Central.
  //
  // Ele existia em 15 telas - com o CSS COPIADO 15 vezes, e já divergindo:
  // 14 cópias tinham a regra de :hover, uma não. Agora sai daqui, como as
  // barras de rolagem e o Beniboy.
  //
  // Duas classes, um desenho só:
  //   .sheet-fechar-flutuante - solto na quina da ficha (o que já existia)
  //   .zenith-fechar          - dentro de uma linha de cabeçalho
  // Popup, toast e menu ficam de fora de propósito: o ✕ de 32px na quina de
  // um aviso de canto de tela seria maior que o próprio aviso.
  var fechar = document.createElement('style');
  fechar.id = 'zenith-fechar';
  fechar.textContent = [
    '.sheet-fechar-flutuante,.zenith-fechar{width:32px;height:32px;flex:none;padding:0;border-radius:50%;',
    '  background:var(--panel2,#181d24);border:1px solid var(--line,#27313b);color:var(--muted,#8c99a7);',
    '  font-size:16px;line-height:1;font-family:inherit;display:flex;align-items:center;justify-content:center;cursor:pointer;}',
    '.sheet-fechar-flutuante{position:absolute;top:-14px;right:-6px;box-shadow:0 2px 10px rgba(0,0,0,.5);z-index:5;}',
    '.sheet-fechar-flutuante:hover,.zenith-fechar:hover{color:var(--text,#e7ecf1);border-color:var(--accent,#b8ff3c);}',
  ].join('\n');
  document.head.appendChild(fechar);

  // ---- caixas de marcar: as mesmas em todas as telas ----
  //
  // Pedido do Master: "deixar os checks todos padrão".
  //
  // Eram 159 caixas espalhadas e SÓ 9 arquivos definiam a cor - o resto ficava
  // no azul/roxo do navegador, então na mesma janela apareciam uma limão e uma
  // roxa, uma do tamanho certo e outra esticada.
  //
  // O tamanho errado vinha de regra global de página: loja-status.html tem
  // input{width:100%;height:36px}, feita pros campos de texto, que a caixa de
  // marcar herdava junto. input[type=checkbox] tem especificidade maior que
  // input, então desfaz isso sem a página precisar saber.
  //
  // width/height auto (e não um número): devolve o tamanho NATIVO do sistema,
  // que é o que a pessoa reconhece como caixa de marcar - cravar 16px mudaria
  // o que hoje já está certo.
  var checks = document.createElement('style');
  checks.id = 'zenith-checks';
  checks.textContent = [
    'input[type=checkbox],input[type=radio]{',
    '  accent-color:var(--accent,#b8ff3c);',
    '  width:auto;height:auto;min-height:0;flex:none;',
    '  padding:0;border:0;background:none;border-radius:0;cursor:pointer;}',
    'input[type=checkbox]:disabled,input[type=radio]:disabled{cursor:default;opacity:.55;}',
  ].join('\n');
  document.head.appendChild(checks);

  // ---- balão de dica (data-dica) e botão só-ícone (.btn-icone) ----
  //
  // Pedido do Master: a fileira de ações quebrava em 3 linhas; encolher pra
  // uma linha só, e "ao passar o mouse mostra o nome ABAIXO do ícone, como um
  // balão - algo que não fique feio nem atrapalhando".
  //
  // CSS puro, via ::after/::before: não tem JS, não tem nó a mais no DOM e
  // NÃO empurra layout (o balão é absolute, fora do fluxo). O title nativo
  // não serve: demora ~1s, aparece onde o mouse está e não dá pra desenhar.
  //
  // Só em elemento que aceita ::after - botão, link, span. Em <input> os
  // pseudo-elementos não existem, então ali continua o title.
  //
  // :focus-visible junto do :hover: quem navega por teclado também precisa
  // saber o que o ícone faz, senão o botão só-ícone vira adivinhação.
  var dicas = document.createElement('style');
  dicas.id = 'zenith-dicas';
  dicas.textContent = [
    '[data-dica]{position:relative;}',
    '[data-dica]::after{content:attr(data-dica);position:absolute;top:calc(100% + 7px);left:50%;',
    '  transform:translateX(-50%) translateY(-3px);background:var(--panel2,#181d24);color:var(--text,#e7ecf1);',
    '  border:1px solid var(--line,#27313b);border-radius:7px;padding:4px 9px;',
    '  font:11px/1.3 var(--sans,Arial,sans-serif);font-weight:600;white-space:nowrap;letter-spacing:normal;text-transform:none;',
    '  pointer-events:none;opacity:0;visibility:hidden;z-index:60;',
    '  box-shadow:0 4px 14px rgba(0,0,0,.45);transition:opacity .12s ease,transform .12s ease;}',
    // a setinha que liga o balão ao ícone
    '[data-dica]::before{content:"";position:absolute;top:calc(100% + 2px);left:50%;transform:translateX(-50%);',
    '  border:5px solid transparent;border-bottom-color:var(--line,#27313b);',
    '  pointer-events:none;opacity:0;visibility:hidden;z-index:61;transition:opacity .12s ease;}',
    '[data-dica]:hover::after,[data-dica]:focus-visible::after{opacity:1;visibility:visible;transform:translateX(-50%) translateY(0);}',
    '[data-dica]:hover::before,[data-dica]:focus-visible::before{opacity:1;visibility:visible;}',
    // balão que nasceria fora da tela pela direita ancora pela borda
    '[data-dica][data-dica-fim]::after{left:auto;right:0;transform:translateX(0) translateY(-3px);}',
    '[data-dica][data-dica-fim]:hover::after,[data-dica][data-dica-fim]:focus-visible::after{transform:translateX(0) translateY(0);}',
    '@media (prefers-reduced-motion:reduce){[data-dica]::after,[data-dica]::before{transition:none;}}',
    // o balão depende de hover: em tela de toque não existe, e um balão preso
    // depois do toque atrapalharia mais do que ajuda
    '@media (hover:none){[data-dica]::after,[data-dica]::before{display:none;}}',
    // botão só-ícone: mesma família do ✕ de fechar, quadrado e sem relevo
    '.btn-icone{width:34px;height:34px;flex:none;padding:0;border-radius:8px;',
    '  background:var(--panel2,#181d24);border:1px solid var(--line,#27313b);color:var(--text,#e7ecf1);',
    '  font-size:15px;line-height:1;font-family:inherit;display:inline-flex;align-items:center;justify-content:center;',
    '  cursor:pointer;text-decoration:none;}',
    '.btn-icone:hover{border-color:var(--accent,#b8ff3c);}',
    '.btn-icone:disabled{opacity:.5;cursor:default;}',
    '.btn-icone.perigo:hover{border-color:var(--bad,#ff6b6b);}',
  ].join('\n');
  document.head.appendChild(dicas);

  function aplicar() {
    document.documentElement.setAttribute('data-tema', temaAtual());
    // zoom escala texto E espacamentos (tudo em px nas paginas) - e o
    // comportamento esperado de "aumentar a fonte" nessas telas
    document.documentElement.style.zoom = fonteAtual() === 100 ? '' : (fonteAtual() / 100);
    var painel = document.getElementById('zenith-aparencia');
    if (painel) {
      painel.querySelector('[data-tema-btn="escuro"]').classList.toggle('ztema-ativo', temaAtual() === 'escuro');
      painel.querySelector('[data-tema-btn="claro"]').classList.toggle('ztema-ativo', temaAtual() === 'claro');
      painel.querySelector('#ztema-fonte-pct').textContent = fonteAtual() + '%';
    }
  }

  function definirTema(t) { localStorage.setItem(LS_TEMA, t); aplicar(); }
  function mudarFonte(delta) {
    var novo = Math.min(FONTE_MAX, Math.max(FONTE_MIN, fonteAtual() + delta));
    localStorage.setItem(LS_FONTE, String(novo));
    aplicar();
  }

  aplicar(); // roda ja no <head>: o body nasce com o tema/fonte certos

  // ---- controles no menu ☰ (secao "Aparência", no fim do drawer) ----
  // O drawer aparece como class OU id, dependendo da idade da pagina.
  function acharDrawer() { return document.querySelector('#nav-drawer, .nav-drawer'); }

  function montarControles() {
    var drawer = acharDrawer();
    if (!drawer || document.getElementById('zenith-aparencia')) return;
    var css = document.createElement('style');
    css.textContent = [
      '#zenith-aparencia{padding:2px 10px 10px;display:flex;flex-direction:column;gap:6px;}',
      '#zenith-aparencia .ztema-linha{display:flex;gap:6px;align-items:center;}',
      '#zenith-aparencia button{background:var(--panel2,#181d24);border:1px solid var(--line,#232a33);color:var(--text,#e7ecf1);',
      '  border-radius:8px;padding:7px 10px;font-size:12px;cursor:pointer;flex:1;font-family:inherit;}',
      '#zenith-aparencia button.ztema-ativo{border-color:var(--accent,#b8ff3c);color:var(--accent,#b8ff3c);font-weight:700;}',
      '#zenith-aparencia .ztema-passo{flex:none;width:40px;font-weight:700;}',
      '#zenith-aparencia #ztema-fonte-pct{flex:1;text-align:center;font-family:var(--mono,monospace);font-size:11.5px;color:var(--muted,#7d8896);}',
    ].join('\n');
    document.head.appendChild(css);

    var grupo = document.createElement('div');
    grupo.className = 'nav-drawer-grupo';
    grupo.textContent = 'Aparência';
    var painel = document.createElement('div');
    painel.id = 'zenith-aparencia';
    painel.innerHTML =
      '<div class="ztema-linha">' +
        '<button type="button" data-tema-btn="escuro">🌙 Escuro</button>' +
        '<button type="button" data-tema-btn="claro">☀️ Claro</button>' +
      '</div>' +
      '<div class="ztema-linha">' +
        '<button type="button" class="ztema-passo" id="ztema-fonte-menos" title="Diminuir a fonte">A−</button>' +
        '<span id="ztema-fonte-pct">100%</span>' +
        '<button type="button" class="ztema-passo" id="ztema-fonte-mais" title="Aumentar a fonte">A+</button>' +
      '</div>';
    drawer.appendChild(grupo);
    drawer.appendChild(painel);
    painel.querySelector('[data-tema-btn="escuro"]').addEventListener('click', function () { definirTema('escuro'); });
    painel.querySelector('[data-tema-btn="claro"]').addEventListener('click', function () { definirTema('claro'); });
    painel.querySelector('#ztema-fonte-menos').addEventListener('click', function () { mudarFonte(-FONTE_PASSO); });
    painel.querySelector('#ztema-fonte-mais').addEventListener('click', function () { mudarFonte(FONTE_PASSO); });
    aplicar();
  }

  // O nav-menu.js monta o menu com `nav.innerHTML = ...`, o que APAGA tudo
  // que estiver dentro do drawer. Os dois esperam DOMContentLoaded e o
  // tema.js (que vive no <head>) registra o listener primeiro - entao a
  // ordem era: tema adiciona a "Aparência" -> nav-menu limpa o drawer e a
  // secao some. Era esse o motivo de o tema claro e o A+/A− terem
  // "desaparecido": o codigo estava aqui, mas o menu novo apagava a cada
  // carregamento.
  //
  // O observer resolve sem depender de ordem de carregamento: sempre que o
  // conteudo do drawer for trocado (por quem for), a Aparência volta. Nao
  // entra em laco porque montarControles sai na hora se a secao ja existe.
  // Em algumas paginas o drawer nem existe no HTML: o nav-menu.js cria e
  // pendura no body (ver nav-menu.js:484). Nesses casos, no momento em que
  // este arquivo roda ainda nao ha o que observar - por isso a espera pelo
  // body antes de vigiar o drawer.
  var obsCorpo = null;
  function vigiarDrawer() {
    var drawer = acharDrawer();
    if (!drawer) {
      if (!obsCorpo) {
        obsCorpo = new MutationObserver(vigiarDrawer);
        obsCorpo.observe(document.body, { childList: true });
      }
      return;
    }
    if (obsCorpo) { obsCorpo.disconnect(); obsCorpo = null; }
    montarControles();
    if (drawer.__zenithVigiado) return;
    drawer.__zenithVigiado = true;
    new MutationObserver(montarControles).observe(drawer, { childList: true });
  }

  // ---- fechamento do caixa que não foi lançado: aviso em QUALQUER tela ----
  //
  // Pedido do Master (07/09/2026): "se o fechamento do dia não for lançado até
  // as 2h da manhã, sempre que acessar qualquer tela um PopUp ficar aparecendo
  // informando que falta lançar o fechamento do caixa, e ter a opção de clicar
  // e ser direcionado para fechar caixa".
  //
  // Mora aqui porque este arquivo é o único carregado pelas 53 telas - o aviso
  // tem que alcançar quem está no Estoque, no Chamado, em qualquer lugar. Quem
  // decide o que está pendente é o SERVIDOR (ver diasPendentesDeFechamento em
  // fechamentosLive.js): a tela não repete regra de negócio, só mostra.
  //
  // O "Agora não" fecha só nesta tela: na próxima o aviso volta, de propósito,
  // até o fechamento ser lançado. Quem lança precisa ser cobrado.
  //
  // O X de "não avisar mais" é SÓ do Master (pedido dele, 09/09/2026), e por
  // um motivo concreto: a loja tem uma pendência, o Master tem a soma do
  // parque inteiro - o mesmo aviso que cobra uma pessoa atrapalha a outra. E
  // ele dispensa o que está pendente AGORA, não o aviso pra sempre: dia novo
  // sem fechamento volta a avisar. Um botão que silenciasse o alarme de vez
  // seria a última vez que alguém veria um caixa em aberto.
  var TELA_LANCAMENTO = '/lancamento.html';
  var CACHE_PENDENCIA_MS = 60 * 1000;
  var CHAVE_DISPENSA = 'nopulsoPendFechDispensadas';

  function lerDispensadas() {
    try { var v = JSON.parse(localStorage.getItem(CHAVE_DISPENSA) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; }
  }
  function gravarDispensadas(chaves) {
    try { localStorage.setItem(CHAVE_DISPENSA, JSON.stringify(chaves.slice(-400))); } catch (e) {}
  }

  // Decide o que o aviso mostra. Separada por ser a única regra desta parte que
  // dá pra errar: o que já foi dispensado some, e o que já foi LANÇADO some da
  // memória de dispensa - se aquele dia voltar a ficar em aberto, o aviso volta.
  function pendenciasVisiveis(dados, dispensadas) {
    var lista = (dados && dados.pendentes) || [];
    var chaves = (dados && dados.chaves) || lista.map(function (p) { return p.unidade + '|' + p.data; });
    var vivas = (dispensadas || []).filter(function (k) { return chaves.indexOf(k) >= 0; });
    var visiveis = lista.filter(function (p) { return vivas.indexOf(p.unidade + '|' + p.data) < 0; });
    var total = chaves.filter(function (k) { return vivas.indexOf(k) < 0; }).length;
    return { visiveis: visiveis, total: total, chaves: chaves, dispensadas: vivas };
  }

  function fmtDataAviso(iso) {
    var p = String(iso || '').split('-');
    return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : String(iso || '');
  }

  function pendenciasDeFechamento() {
    // resposta guardada por 1 minuto: trocar de tela não pode virar uma
    // chamada por clique (o aviso aparece igual, lendo o que já veio)
    try {
      var salvo = JSON.parse(sessionStorage.getItem('nopulsoPendFech') || 'null');
      if (salvo && (Date.now() - salvo.em) < CACHE_PENDENCIA_MS) return Promise.resolve(salvo.dados);
    } catch (e) { /* sem cache, busca */ }
    var token;
    try { token = localStorage.getItem('authToken'); } catch (e) { return Promise.resolve(null); }
    return fetch('/api/fechamentos/pendencias', { headers: { Authorization: 'Bearer ' + token } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        try { sessionStorage.setItem('nopulsoPendFech', JSON.stringify({ em: Date.now(), dados: d })); } catch (e) {}
        return d;
      })
      .catch(function () { return null; });
  }

  function avisarFechamentoPendente() {
    if (location.pathname === TELA_LANCAMENTO) return;   // já está na tela de lançar
    if (document.getElementById('nopulso-pend-fech')) return;
    try {
      if (!localStorage.getItem('authToken')) return;    // tela pública/login
      if (sessionStorage.getItem('nopulsoPendFechAdiado') === location.pathname) return;
    } catch (e) { return; }

    pendenciasDeFechamento().then(function (d) {
      var visao = pendenciasVisiveis(d, lerDispensadas());
      gravarDispensadas(visao.dispensadas);   // poda o que já foi lançado
      var lista = visao.visiveis;
      var total = visao.total;
      if (!lista.length || !total) return;

      var st = document.createElement('style');
      st.textContent = [
        '#nopulso-pend-fech{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.62);',
        'display:flex;align-items:center;justify-content:center;padding:16px;}',
        '#nopulso-pend-fech .cx{background:var(--panel,#12151a);border:1px solid var(--warn,#ffb020);border-radius:12px;',
        'max-width:440px;width:100%;padding:18px 18px 14px;color:var(--text,#e7ecf3);font-family:var(--sans,system-ui,sans-serif);',
        'box-shadow:0 18px 50px rgba(0,0,0,.5);max-height:86vh;overflow-y:auto;}',
        '#nopulso-pend-fech h3{margin:0 0 4px;font-size:16px;color:var(--warn,#ffb020);}',
        '#nopulso-pend-fech .sub{margin:0 0 12px;font-size:12.5px;line-height:1.45;color:var(--muted,#93a1b3);}',
        '#nopulso-pend-fech .item{display:block;width:100%;text-align:left;background:var(--panel2,#171b22);',
        'border:1px solid var(--line,#232a34);border-radius:9px;padding:9px 11px;margin-bottom:7px;color:var(--text,#e7ecf3);',
        'font-size:13px;cursor:pointer;font-family:inherit;}',
        '#nopulso-pend-fech .item:hover{border-color:var(--accent,#b8ff3c);}',
        '#nopulso-pend-fech .item b{display:block;font-size:13.5px;}',
        '#nopulso-pend-fech .item span{font-family:var(--mono,monospace);font-size:11.5px;color:var(--muted,#93a1b3);}',
        '#nopulso-pend-fech .mais{font-size:11.5px;color:var(--muted,#93a1b3);margin:2px 0 10px;}',
        '#nopulso-pend-fech .acoes{display:flex;gap:8px;justify-content:flex-end;margin-top:10px;}',
        '#nopulso-pend-fech .depois{background:none;border:1px solid var(--line,#232a34);color:var(--muted,#93a1b3);',
        'border-radius:8px;padding:8px 12px;font-size:12.5px;cursor:pointer;font-family:inherit;}',
        '#nopulso-pend-fech .cx{position:relative;}',
        '#nopulso-pend-fech .fechar{position:absolute;top:8px;right:9px;background:none;border:0;color:var(--muted,#93a1b3);',
        'font-size:22px;line-height:1;cursor:pointer;font-family:inherit;padding:2px 6px;}',
        '#nopulso-pend-fech .fechar:hover{color:var(--text,#e7ecf3);}',
        '#nopulso-pend-fech h3{padding-right:26px;}',
      ].join('');
      document.head.appendChild(st);

      var cx = document.createElement('div');
      cx.id = 'nopulso-pend-fech';
      var titulo = total === 1 ? 'Falta lançar o fechamento do caixa' : total + ' fechamentos de caixa não lançados';
      var itens = lista.map(function (p) {
        return '<button type="button" class="item" data-unidade="' + encodeURIComponent(p.unidade) + '" data-data="' + encodeURIComponent(p.data) + '">'
          + '<b>' + String(p.unidadeNome || p.unidade).replace(/</g, '&lt;') + '</b>'
          + '<span>' + fmtDataAviso(p.data) + ' · toque para lançar</span></button>';
      }).join('');
      var botaoX = d && d.souMaster
        ? '<button type="button" class="fechar" aria-label="Não avisar mais sobre estes" title="Não avisar mais sobre estes fechamentos">×</button>' : '';
      cx.innerHTML = '<div class="cx" role="dialog" aria-modal="true">' + botaoX + '<h3>⏰ ' + titulo + '</h3>'
        + '<p class="sub">O dia já virou e esse caixa continua sem fechamento. Enquanto não for lançado, o faturamento do dia não entra em relatório nenhum.</p>'
        + itens
        + (total > lista.length ? '<div class="mais">e mais ' + (total - lista.length) + ' dia(s) — a lista completa fica em Fechamentos → Dias sem fechamento.</div>' : '')
        + '<div class="acoes"><button type="button" class="depois">Agora não</button></div></div>';
      document.body.appendChild(cx);

      cx.addEventListener('click', function (e) {
        // o X vem ANTES do item: ele é um botão dentro da mesma caixa, e
        // testar o item primeiro engoliria o clique
        if (e.target.closest && e.target.closest('.fechar')) {
          gravarDispensadas(visao.dispensadas.concat(visao.chaves.filter(function (k) { return visao.dispensadas.indexOf(k) < 0; })));
          cx.remove();
          return;
        }
        var item = e.target.closest && e.target.closest('.item');
        if (item) {
          location.href = TELA_LANCAMENTO + '?unidade=' + item.getAttribute('data-unidade') + '&data=' + item.getAttribute('data-data');
          return;
        }
        // "Agora não" e o clique fora fecham só nesta tela: na próxima o aviso
        // volta, que é o pedido ("sempre que acessar qualquer tela")
        if ((e.target.closest && e.target.closest('.depois')) || e.target === cx) {
          try { sessionStorage.setItem('nopulsoPendFechAdiado', location.pathname); } catch (err) {}
          cx.remove();
        }
      });
    });
  }

  // ---- Beniboy em TODAS as telas ----
  //
  // Pedido do Master: "o Beniboy precisa estar em todas as telas sempre".
  // Antes o <script src="/suporte-chat.js"> era colado página a página, e 15
  // das 59 tinham ficado sem ele - incluindo Meu Dia, os dois NOC e a Central
  // de Soluções. Página nova nascia sem, e ninguém percebia.
  //
  // Aqui é injetado UMA vez, deste arquivo, que é o único carregado pelas 59.
  // Assim vale também para a próxima tela que alguém criar, sem depender de
  // lembrar da tag.
  //
  // A tela de alarme fica de fora: ela JÁ é o Beniboy em 112px ocupando o
  // ecrã inteiro (ver alerta-beniboy.html) - um lançador de chat por cima
  // seria o mesmo boneco duas vezes, e a tela existe para uma ação só.
  var SEM_BENIBOY = ['/alerta-beniboy.html'];

  function montarBeniboy() {
    if (SEM_BENIBOY.indexOf(location.pathname) >= 0) return;
    // 44 páginas ainda trazem a tag no HTML: sem esta checagem o arquivo seria
    // baixado duas vezes (o próprio suporte-chat.js já se protege de iniciar
    // duas vezes, mas o download repetido é desperdício em rede de loja)
    if (document.querySelector('script[src*="suporte-chat.js"]')) return;
    var tag = document.createElement('script');
    tag.src = '/suporte-chat.js';
    tag.defer = true;
    document.head.appendChild(tag);
  }

  function iniciar() { montarControles(); vigiarDrawer(); avisarEnderecoNovo(); avisarFechamentoPendente(); montarBeniboy(); }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
  else iniciar();

  // ---- campo de data: clique em qualquer parte do campo abre o seletor ----
  // Por padrao o navegador so abre o calendario clicando bem no iconezinho
  // (uns 20px) - nas 53 telas isso passava despercebido. Pedido do usuario:
  // "onde for data em todo o sistema ao clicar precisa abrir a opcao de
  // escolher a data". Delegado no document (nao precisa de DOMContentLoaded,
  // e pega campo de data criado depois via innerHTML, ja que boa parte das
  // telas monta filtro/formulario dinamicamente) e centralizado aqui - so
  // esse arquivo e' carregado por TODAS as paginas, entao um lugar so cobre
  // o sistema inteiro em vez de repetir o listener pagina a pagina (isso
  // ja existia solto, duplicado, em formularios.html e preencher.html).
  document.addEventListener('click', function (e) {
    var el = e.target.closest && e.target.closest('input[type=date]');
    if (el && typeof el.showPicker === 'function') { try { el.showPicker(); } catch (_) {} }
  });

  // ---- período "Mês": escolher um dia mantém o mês inteiro ----
  // Todas as telas usam pares De/Até, mas cada uma nasceu com ids e handlers
  // próprios. Esta camada comum preserva a intenção do atalho Mês: se o
  // usuário escolhe 15/06, o filtro vira automaticamente 01/06 a 30/06;
  // escolhendo um dia de outro mês, o período acompanha esse novo mês.
  // O marcador no container continua valendo mesmo se o handler antigo da
  // página redesenhar os botões ao receber a mudança de data.
  var PARES_PERIODO_MES = [
    { de: 'F-DE', ate: 'F-ATE', painel: '#PRESETS' },
    { de: 'filtro-data-de', ate: 'filtro-data-ate', painel: '#presets-periodo-central' },
    { de: 'filtro-data-de-lista', ate: 'filtro-data-ate-lista', painel: '#presets-periodo-lista' },
    { de: 'filtro-data-de-tecnico', ate: 'filtro-data-ate-tecnico', painel: '#presets-periodo-tecnico' },
    { de: 'f-date-start', ate: 'f-date-end', painel: '#presets' },
    { de: 'f-data-de', ate: 'f-data-ate', painel: '#presets' },
    { de: 'f-inicio', ate: 'f-fim', painel: '.filtros' },
    { de: 'd-inicio', ate: 'd-fim', painel: '#d-presets' },
    { de: 'h-inicio', ate: 'h-fim', painel: '#h-presets' }
  ];

  function parPeriodoMes(campo) {
    if (!campo || !campo.id) return null;
    return PARES_PERIODO_MES.find(function (p) { return p.de === campo.id || p.ate === campo.id; }) || null;
  }
  function painelDoPar(par) { return par && document.querySelector(par.painel); }
  function botaoMes(painel) {
    if (!painel) return null;
    return Array.prototype.find.call(painel.querySelectorAll('button'), function (b) {
      return String(b.dataset.tipo || b.dataset.preset || b.textContent || '').trim().toLocaleLowerCase('pt-BR') === 'mês'
        || String(b.dataset.tipo || b.dataset.preset || '').toLocaleLowerCase('pt-BR') === 'mes';
    }) || null;
  }
  function mesEstaAtivo(par) {
    var painel = painelDoPar(par), botao = botaoMes(painel);
    return !!(painel && (painel.dataset.zenithMesAtivo === '1' || (botao && botao.classList.contains('active'))));
  }
  function isoDoMes(data) {
    var d = new Date(String(data) + 'T12:00:00');
    if (Number.isNaN(d.getTime())) return null;
    var y = d.getFullYear(), m = d.getMonth();
    var f = function (n) { return String(n).padStart(2, '0'); };
    return { de: y + '-' + f(m + 1) + '-01', ate: y + '-' + f(new Date(y, m + 1, 0).getDate()) };
  }
  function manterBotaoMes(par) {
    var painel = painelDoPar(par);
    if (!painel) return;
    painel.dataset.zenithMesAtivo = '1';
    // Alguns handlers removem .active para indicar intervalo manual. Aqui o
    // intervalo não é manual: ele foi reencaixado no mês escolhido.
    setTimeout(function () { var b = botaoMes(painel); if (b) b.classList.add('active'); }, 0);
  }
  document.addEventListener('click', function (e) {
    var botao = e.target.closest && e.target.closest('button');
    if (!botao) return;
    var texto = String(botao.dataset.tipo || botao.dataset.preset || botao.textContent || '').trim().toLocaleLowerCase('pt-BR');
    if (!['mes', 'mês', 'hoje', 'ontem', 'semana', '7dias', 'trimestre', 'todos', 'tudo'].includes(texto)) return;
    PARES_PERIODO_MES.forEach(function (par) {
      var painel = painelDoPar(par);
      if (!painel || !painel.contains(botao)) return;
      if (texto === 'mes' || texto === 'mês') painel.dataset.zenithMesAtivo = '1';
      else delete painel.dataset.zenithMesAtivo;
    });
  }, true);
  function ajustarMesAoEscolherData(e) {
    var campo = e.target;
    if (!campo || campo.type !== 'date' || campo.dataset.zenithAjustandoMes === '1') return;
    var par = parPeriodoMes(campo);
    if (!par || !mesEstaAtivo(par) || !campo.value) return;
    var intervalo = isoDoMes(campo.value);
    var de = document.getElementById(par.de), ate = document.getElementById(par.ate);
    if (!intervalo || !de || !ate) return;
    campo.dataset.zenithAjustandoMes = '1';
    de.value = intervalo.de; ate.value = intervalo.ate;
    manterBotaoMes(par);
    setTimeout(function () { delete campo.dataset.zenithAjustandoMes; }, 0);
  }
  document.addEventListener('input', ajustarMesAoEscolherData, true);
  document.addEventListener('change', ajustarMesAoEscolherData, true);

  // ---- rascunhos de campos durante atualizacao da propria tela ----
  // Muitas telas recebem polling/SSE, trocam status ou redesenham cards com
  // innerHTML. Antes, isso recriava textarea/input/select e apagava o que a
  // pessoa ja tinha digitado, lido pelo leitor ou anexado. Esta camada vive
  // no arquivo comum de todas as paginas: preserva SOMENTE o que foi alterado
  // pelo usuario e devolve o valor quando o mesmo campo nasce de novo.
  //
  // Rascunho e da pagina atual, nao e dado salvo: ao navegar para outra tela
  // a proxima pagina limpa o rascunho da anterior. sessionStorage deixa uma
  // atualizacao/reload da MESMA pagina recuperar texto, mas nunca senha,
  // token ou campos hidden. Arquivos ficam em memoria (o browser nao permite
  // serializar File), suficiente para qualquer redesenho sem sair da pagina.
  (function protegerRascunhosDaTela() {
    var PREFIXO = 'nopulso.rascunho.v1:';
    var pagina = location.pathname + location.search;
    var chavePagina = PREFIXO + pagina;
    var rascunhos = new Map();
    var arquivos = new Map();
    var restauracaoPendente = false;

    function campoElegivel(campo) {
      if (!campo || campo.nodeType !== 1 || campo.dataset.zenithSemRascunho !== undefined) return false;
      var tag = String(campo.tagName || '').toLowerCase();
      if (!['input', 'textarea', 'select'].includes(tag) && !campo.isContentEditable) return false;
      var tipo = String(campo.type || '').toLowerCase();
      return !['hidden', 'password', 'submit', 'button', 'reset', 'image'].includes(tipo);
    }
    function identidade(campo) {
      if (!campoElegivel(campo)) return null;
      if (campo.id) return 'id:' + campo.id;
      if (campo.name) {
        var form = campo.form;
        var dono = form && (form.id || form.name);
        // Radio/checkbox do mesmo name precisam de identidade individual.
        var extra = /^(radio|checkbox)$/i.test(campo.type || '') ? ':' + String(campo.value || '') : '';
        return 'nome:' + (dono || 'pagina') + ':' + campo.name + extra;
      }
      return null;
    }
    function ler(campo) {
      var tipo = String(campo.type || '').toLowerCase();
      if (campo.isContentEditable) return { tipo: 'html', valor: campo.innerHTML };
      if (tipo === 'checkbox' || tipo === 'radio') return { tipo: 'marcado', valor: !!campo.checked };
      if (tipo === 'file') return { tipo: 'arquivo', valor: !!(campo.files && campo.files[0]) };
      return { tipo: 'valor', valor: campo.value };
    }
    function gravarNoStorage() {
      try {
        var simples = {};
        rascunhos.forEach(function (valor, chave) {
          // Limite defensivo por campo: evita encher a sessao por colagem
          // acidental de arquivo/texto gigante. O arquivo segue no Map.
          if (typeof valor.valor === 'string' && valor.valor.length > 50000) return;
          simples[chave] = valor;
        });
        sessionStorage.setItem(chavePagina, JSON.stringify(simples));
      } catch (e) { /* armazenamento bloqueado/cheio: a memoria ainda vale */ }
    }
    function carregarDoStorage() {
      try {
        Object.keys(sessionStorage).forEach(function (k) {
          if (k.indexOf(PREFIXO) === 0 && k !== chavePagina) sessionStorage.removeItem(k);
        });
        var salvo = JSON.parse(sessionStorage.getItem(chavePagina) || '{}');
        Object.keys(salvo).forEach(function (k) {
          var valor = salvo[k];
          if (valor && ['valor', 'marcado', 'html'].includes(valor.tipo)) rascunhos.set(k, valor);
        });
      } catch (e) { /* segue sem persistencia entre reloads */ }
    }
    function guardarCampo(campo) {
      var id = identidade(campo);
      if (!id) return;
      var estado = ler(campo);
      if (estado.tipo === 'arquivo') {
        var arq = campo.files && campo.files[0];
        if (arq) arquivos.set(id, arq); else arquivos.delete(id);
        rascunhos.set(id, estado);
      } else {
        rascunhos.set(id, estado);
      }
      gravarNoStorage();
    }
    function aplicarCampo(campo) {
      var id = identidade(campo), estado = id && rascunhos.get(id);
      if (!estado) return;
      var tipo = String(campo.type || '').toLowerCase();
      if (estado.tipo === 'html' && campo.isContentEditable) campo.innerHTML = estado.valor;
      else if (estado.tipo === 'marcado' && (tipo === 'checkbox' || tipo === 'radio')) campo.checked = !!estado.valor;
      else if (estado.tipo === 'valor' && !campo.isContentEditable && tipo !== 'file') campo.value = estado.valor;
      else if (estado.tipo === 'arquivo' && tipo === 'file' && arquivos.has(id)) {
        // DataTransfer fica CENTRALIZADO aqui (tema.js), igual a colagem de
        // print: devolve o mesmo File ao input recriado sem abrir caminho
        // paralelo nas dezenas de telas.
        try {
          var dt = new DataTransfer();
          dt.items.add(arquivos.get(id));
          campo.files = dt.files;
          campo.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (e) { /* o arquivo continua guardado para a proxima troca */ }
      }
    }
    function aplicarEm(no) {
      if (!no || no.nodeType !== 1) return;
      if (campoElegivel(no)) aplicarCampo(no);
      if (no.querySelectorAll) no.querySelectorAll('input,textarea,select,[contenteditable="true"]').forEach(aplicarCampo);
    }
    function agendarRestauracao() {
      if (restauracaoPendente) return;
      restauracaoPendente = true;
      requestAnimationFrame(function () {
        restauracaoPendente = false;
        document.querySelectorAll('input,textarea,select,[contenteditable="true"]').forEach(aplicarCampo);
      });
    }
    function limparNo(no) {
      if (!no || no.nodeType !== 1) return;
      var todos = [];
      if (campoElegivel(no)) todos.push(no);
      if (no.querySelectorAll) todos = todos.concat(Array.prototype.slice.call(no.querySelectorAll('input,textarea,select,[contenteditable="true"]')));
      todos.forEach(function (campo) {
        var id = identidade(campo);
        if (!id) return;
        rascunhos.delete(id); arquivos.delete(id);
      });
      gravarNoStorage();
    }

    carregarDoStorage();
    document.addEventListener('input', function (e) { guardarCampo(e.target); }, true);
    document.addEventListener('change', function (e) { guardarCampo(e.target); }, true);
    document.addEventListener('reset', function (e) { limparNo(e.target); }, true);
    // Fechar/cancelar um modal descarta o rascunho daquela caixa, como sair
    // da secao. Atualizacao de status nao passa por aqui e, portanto, nao o
    // apaga. Telas com fechamento customizado tambem podem chamar esta API.
    document.addEventListener('click', function (e) {
      var botao = e.target.closest && e.target.closest('button,[role="button"]');
      if (!botao) return;
      var texto = String(botao.getAttribute('aria-label') || botao.textContent || '').trim().toLocaleLowerCase('pt-BR');
      if (!/^(fechar|cancelar|×|x|✕)/.test(texto)) return;
      var caixa = botao.closest('[role="dialog"],.modal,.overlay,.sheet-wrap,.painel-conversa');
      if (caixa) limparNo(caixa);
    }, true);
    if (document.documentElement) {
      new MutationObserver(function (mudancas) {
        mudancas.forEach(function (m) { m.addedNodes.forEach(aplicarEm); });
        agendarRestauracao();
      }).observe(document.documentElement, { childList: true, subtree: true });
    }
    // Disponivel para fluxos que concluem/salvam e precisam limpar o que foi
    // efetivamente persistido, sem depender de classe ou texto de botao.
    // Use depois de uma gravacao confirmada. A atualizacao normal continua
    // preservando o texto, mas uma mensagem/comentario que ja foi enviado nao
    // pode reaparecer como se ainda fosse um rascunho.
    function limparCampoEnviado(campo) {
      limparNo(campo);
      if (campo && 'value' in campo) campo.value = '';
    }
    window.zenithRascunhos = { limpar: limparNo, limparCampoEnviado: limparCampoEnviado, restaurar: agendarRestauracao };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', agendarRestauracao);
    else agendarRestauracao();
  })();

  // ---- "Limpar filtros" onde houver período ----
  //
  // Pedido do Master: "onde tiver filtros de periodo precisamos ter um botao
  // de limpar filtro, porque os filtros estao ficando preso e isso atrapalha".
  //
  // POR QUE FICAVAM PRESOS: e' o guarda-rascunho logo acima. Ele existe pra
  // uma tela que recebe polling/SSE nao apagar o que a pessoa ja digitou -
  // e faz isso muito bem. So que ele nao distingue "texto que eu estava
  // escrevendo" de "filtro de periodo": o valor fica no sessionStorage e volta
  // no proximo carregamento, POR CIMA do padrao que a propria tela acabou de
  // montar. Medido no Monitor: a tela abre em "hoje", voce filtra 01/08-31/08,
  // recarrega e volta 01/08-31/08; apagando so o rascunho, volta "hoje".
  //
  // POR QUE UM BOTAO, e nao tirar o filtro do rascunho: durante o poll de 30s
  // o filtro TEM de sobreviver - perder o periodo escolhido no meio de uma
  // conferencia seria pior que o problema. O que faltava era a saida.
  //
  // O botao apaga o rascunho DAQUELA faixa de filtros (nao o da tela inteira:
  // um formulario meio preenchido ao lado nao pode ir junto) e recarrega, pra
  // a tela voltar exatamente como ela abre - cada tela monta o proprio padrao
  // no boot, entao recarregar e' a unica definicao de "limpo" que vale nas 59.
  //
  // ACHA SOZINHO onde colocar, pelo par de campos de data: nao da pra editar
  // 31 telas na mao e manter isso vivo. O par e' descoberto pelo ID - de/ate,
  // inicio/fim, start/end, ini/fim - que e' a convencao ja usada no app
  // inteiro (F-DE/F-ATE, f-date-start/f-date-end, DINI/DFIM, quedas-de/
  // quedas-ate...). Campo de data solto (nascimento, vencimento, data do
  // evento) nao forma par e nao ganha botao - nao e' filtro.
  var FIM_DO_PAR = [['de', 'ate'], ['inicio', 'fim'], ['ini', 'fim'], ['start', 'end'], ['inicial', 'final']];

  // Dado o id do campo INICIAL, devolve os ids possiveis do campo FINAL.
  // Puro de proposito (so texto): e' o que o testeRotas.js consegue extrair
  // e rodar sozinho, sem navegador.
  function idsDoFim(id) {
    var saida = [];
    if (!id) return saida;
    FIM_DO_PAR.forEach(function (par) {
      var comeco = par[0], fim = par[1];
      // como segmento inteiro: f-data-de -> f-data-ate, filtro-data-de-lista
      // -> filtro-data-ate-lista (o "de" no meio tambem conta)
      var seg = new RegExp('(^|[-_])' + comeco + '([-_]|$)', 'i');
      if (seg.test(id)) {
        saida.push(id.replace(seg, function (todo, a, b) {
          return a + (todo.slice(a.length, todo.length - b.length) === comeco.toUpperCase() ? fim.toUpperCase() : fim) + b;
        }));
      }
      // grudado no fim, sem separador: DINI -> DFIM
      var cauda = new RegExp(comeco + '$', 'i');
      if (cauda.test(id)) {
        saida.push(id.replace(cauda, function (achado) {
          return achado === comeco.toUpperCase() ? fim.toUpperCase() : fim;
        }));
      }
    });
    return saida.filter(function (v, i, a) { return v !== id && a.indexOf(v) === i; });
  }

  // FILTRO x CAMPO DE FICHA. Duas datas lado a lado tambem aparecem DENTRO de
  // formulario e de modal - e ali elas nao filtram nada, sao campo do
  // registro: "Data de inicio / Previsao de conclusao" da tarefa, o "Periodo
  // do deposito" da sangria. Um "Limpar filtros" no meio de um formulario
  // meio preenchido seria um botao que joga o trabalho fora.
  //
  // A linha e' estrutural, nao adivinhacao de nome: formulario e caixa que
  // abre por cima ficam de fora; painel e ficha lateral (.sheet-wrap, onde
  // mora o relatorio de chamados da Central) continuam valendo, porque ali as
  // datas filtram mesmo.
  var CAIXA_DE_EDICAO = 'form,dialog,[role="dialog"],.modal,.dialog,.overlay';
  function ehCampoDeFicha(el) { return !!(el && el.closest && el.closest(CAIXA_DE_EDICAO)); }

  function ehData(el) { return el && el.tagName === 'INPUT' && String(el.type).toLowerCase() === 'date'; }
  function controlesDe(el) { return el ? el.querySelectorAll('input,select,textarea') : []; }

  // Onde o botao entra e o que ele limpa: sobe do par ate achar a FAIXA de
  // filtros - o primeiro ancestral que tem algum outro campo alem das duas
  // datas (o status, a unidade, a busca). E' essa faixa que a pessoa chama de
  // "os filtros". Se nao houver (a tela so filtra por periodo), fica no
  // proprio bloco das datas.
  function faixaDeFiltros(inicio, fim) {
    var no = fim.parentElement;
    var ultimo = null;
    while (no && no !== document.body) {
      if (no.contains(inicio)) {
        ultimo = no;
        var campos = controlesDe(no).length;
        // mais que isso nao e' uma faixa de filtro, e' a tela inteira
        if (campos > 40) break;
        if (campos > 2) return no;
      }
      no = no.parentElement;
    }
    return ultimo;
  }

  function montarBotaoLimpar(faixa) {
    var botao = document.createElement('button');
    botao.type = 'button';
    botao.className = 'zenith-limpar-filtros';
    botao.textContent = '✕ Limpar filtros';
    botao.title = 'Volta esta tela ao período e aos filtros com que ela abre';
    botao.addEventListener('click', function () {
      try { if (window.zenithRascunhos) window.zenithRascunhos.limpar(faixa); } catch (_) {}
      location.reload();
    });
    return botao;
  }

  function plantarLimparFiltros() {
    var vistos = [];
    Array.prototype.forEach.call(document.querySelectorAll('input[type=date][id]'), function (inicio) {
      if (ehCampoDeFicha(inicio)) return;
      var fim = null;
      idsDoFim(inicio.id).some(function (idFim) {
        var alvo = document.getElementById(idFim);
        if (ehData(alvo) && alvo !== inicio) { fim = alvo; return true; }
        return false;
      });
      if (!fim) return;
      var faixa = faixaDeFiltros(inicio, fim);
      if (!faixa || vistos.indexOf(faixa) !== -1) return;
      if (faixa.querySelector('.zenith-limpar-filtros')) return;
      vistos.push(faixa);
      // depois do bloco que segura as duas datas, quando esse bloco so tem
      // elas (o "01/08 até 31/08" do Monitor): o botao encosta no periodo em
      // vez de cair no fim da faixa inteira
      var caixa = fim.parentElement;
      if (caixa && caixa !== faixa && caixa.contains(inicio) && controlesDe(caixa).length === 2) {
        caixa.parentElement.insertBefore(montarBotaoLimpar(faixa), caixa.nextSibling);
      } else {
        fim.parentElement.insertBefore(montarBotaoLimpar(faixa), fim.nextSibling);
      }
    });
  }

  var estiloLimpar = document.createElement('style');
  estiloLimpar.id = 'zenith-limpar-filtros';
  estiloLimpar.textContent = [
    '.zenith-limpar-filtros{flex:none;padding:8px 11px;border-radius:8px;',
    '  background:var(--panel2,#181d24);border:1px solid var(--line,#27313b);color:var(--muted,#8c99a7);',
    '  font:12px/1 var(--sans,Arial,sans-serif);font-weight:600;cursor:pointer;white-space:nowrap;',
    '  align-self:center;}',
    '.zenith-limpar-filtros:hover{color:var(--text,#e7ecf1);border-color:var(--accent,#b8ff3c);}',
  ].join('\n');
  document.head.appendChild(estiloLimpar);

  // As faixas de filtro de boa parte das telas so existem depois do boot
  // (a tela monta o filtro junto com os dados), por isso nao basta rodar uma
  // vez: acompanha o DOM e planta onde aparecer par novo.
  function iniciarLimparFiltros() {
    plantarLimparFiltros();
    if (!document.documentElement) return;
    var pendente = false;
    new MutationObserver(function () {
      if (pendente) return;
      pendente = true;
      requestAnimationFrame(function () { pendente = false; plantarLimparFiltros(); });
    }).observe(document.documentElement, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciarLimparFiltros);
  else iniciarLimparFiltros();
  window.zenithFiltros = { idsDoFim: idsDoFim, plantar: plantarLimparFiltros };

  // Todo campo de ANEXO que ja aceita PDF tambem aceita ZIP. Centralizar evita
  // que uma tela nova fique com o seletor antigo enquanto o servidor ja pode
  // receber o arquivo. Campos que so leem documento/foto continuam validados
  // pelo fluxo de leitura; ZIP e' evidencia/arquivo, nao entrada de OCR.
  (function liberarZipNosAnexos() {
    function ajustar(campo) {
      if (!campo || String(campo.type || '').toLowerCase() !== 'file') return;
      var aceita = String(campo.getAttribute('accept') || '');
      if (!/(application\/pdf|\.pdf)/i.test(aceita) || /(?:application\/zip|\.zip)/i.test(aceita)) return;
      campo.setAttribute('accept', aceita.replace(/\s+$/g, '') + ',application/zip,.zip');
    }
    function ajustarNo(no) {
      if (!no || no.nodeType !== 1) return;
      ajustar(no);
      if (no.querySelectorAll) no.querySelectorAll('input[type="file"]').forEach(ajustar);
    }
    function iniciarZip() {
      document.querySelectorAll('input[type="file"]').forEach(ajustar);
      new MutationObserver(function (mudancas) {
        mudancas.forEach(function (m) { m.addedNodes.forEach(ajustarNo); });
      }).observe(document.documentElement, { childList: true, subtree: true });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciarZip);
    else iniciarZip();
  })();
})();
