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
  ].join('\n');
  document.head.appendChild(style);

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

  function iniciar() { montarControles(); vigiarDrawer(); avisarEnderecoNovo(); }

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
})();
