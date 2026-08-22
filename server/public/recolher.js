// recolher.js
// Toda seção grande do app vira recolhível: clicou no título, o corpo some e
// fica SÓ o título; clicou de novo, volta. Pedido do usuário olhando o app no
// celular - as telas empilham vários blocos ("Unidades do formulário",
// "Painel de RH", "Alertas"...) e quem só quer UM deles rola por todos.
//
// O QUE vira recolhível: os dois padrões de bloco que o app inteiro já usa -
// `.panel` (com <h2>/<h3> como primeiro título) e `.secao` (com
// `.secao-titulo`) - mais qualquer elemento marcado com `data-recolher`.
// Bloco sem título direto fica de fora sozinho (não tem onde pendurar a
// seta), e `data-recolher="nao"` exclui um bloco de propósito.
//
// A escolha fica GUARDADA (localStorage, por página + por seção): quem
// recolheu o que não usa abre a tela do jeito que deixou. Padrão é tudo
// aberto - a tela não muda pra ninguém até a pessoa recolher algo.
//
// Seções que nascem depois (render por JS, painel que só aparece pro Master)
// são pegas por MutationObserver - mesma técnica do resto do app.
(function () {
  if (window.ZenithRecolher) return;

  const TITULOS = ':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > .secao-titulo, :scope > .panel-titulo, :scope > [data-recolher-titulo]';

  const css = document.createElement('style');
  css.textContent = [
    // esconder por classe no PAI (e não remover nós) preserva o estado do que
    // está dentro - formulário meio preenchido não perde nada ao recolher
    '.zr-recolhido > :not(.zr-titulo) { display: none !important; }',
    '.zr-titulo { cursor: pointer; user-select: none; }',
    '.zr-recolhido > .zr-titulo { margin-bottom: 0 !important; }',
    '.zr-seta { float: right; font-size: 11px; color: var(--muted, #8b98a5); transition: transform .15s; margin-left: 8px; }',
    '.zr-recolhido .zr-seta { transform: rotate(-90deg); }',
  ].join('\n');
  document.head.appendChild(css);

  function chaveDe(sec, titulo) {
    // id do elemento quando existe (estável por construção); senão o texto do
    // título - se o Master renomear a seção, o estado guardado se perde, o
    // que é aceitável (volta aberta)
    const nome = sec.id || String(titulo.textContent || '').trim().slice(0, 60);
    return `zenith-recolher:${location.pathname}:${nome}`;
  }

  function guardar(chave, recolhido) {
    // localStorage pode estar bloqueado (modo privado etc.) - recolher
    // continua funcionando na sessão, só não persiste
    try { recolhido ? localStorage.setItem(chave, '1') : localStorage.removeItem(chave); } catch (e) {}
  }
  function lembrado(chave) {
    try { return localStorage.getItem(chave) === '1'; } catch (e) { return false; }
  }

  function ligar(sec) {
    if (sec.dataset.zrLigado || sec.dataset.recolher === 'nao') return;
    const titulo = sec.querySelector(TITULOS);
    if (!titulo || !String(titulo.textContent || '').trim()) return;
    sec.dataset.zrLigado = '1';
    titulo.classList.add('zr-titulo');
    const chave = chaveDe(sec, titulo);

    const seta = document.createElement('span');
    seta.className = 'zr-seta';
    seta.textContent = '▼';
    titulo.appendChild(seta);

    const aplicar = (recolhido) => {
      sec.classList.toggle('zr-recolhido', recolhido);
      titulo.setAttribute('aria-expanded', recolhido ? 'false' : 'true');
      titulo.title = recolhido ? 'Expandir seção' : 'Recolher seção';
    };
    titulo.addEventListener('click', (e) => {
      // clique num botão/link/campo que more DENTRO do título continua
      // fazendo o que sempre fez - só o "resto" do título recolhe
      if (e.target.closest('button, a, input, select, textarea, label')) return;
      const vai = !sec.classList.contains('zr-recolhido');
      aplicar(vai);
      guardar(chave, vai);
    });
    aplicar(lembrado(chave));
  }

  function varrer(raiz) {
    (raiz || document).querySelectorAll('.panel, .secao, [data-recolher]').forEach(ligar);
  }

  function iniciar() {
    varrer();
    // seções renderizadas depois do load (JS, gate de permissão)
    new MutationObserver(() => varrer()).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
  else iniciar();

  window.ZenithRecolher = { varrer };
})();
