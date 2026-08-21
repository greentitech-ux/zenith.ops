// kpi-tempo.js
// Conversão dos KPI's de TEMPO (ADT, Run Time, Legal Time, OTD, Load Time...).
//
// POR QUE EXISTE. Esse número chega de DOIS jeitos, e os dois são legítimos:
//
//   - copiado do relatório do PDV, em MINUTOS DECIMAIS com vírgula: "9,66"
//   - digitado à mão, em minuto:segundo: "9:40"
//
// São a mesma duração - 9,66 minutos são 9 minutos e 40 segundos. O campo só
// aceitava a segunda forma (pattern mm:ss), então quem copiava o número do
// relatório - que é o caso NORMAL, é de lá que o dado vem - não conseguia
// lançar o fechamento: o navegador só dizia "É preciso que o formato
// corresponda ao exigido", sem dizer qual era o exigido nem o que estava
// errado.
//
// O SEPARADOR decide, e não sobra ambiguidade:
//
//   tem ":"            -> minuto:segundo   ("9:40" = 9 min 40 s)
//   tem "," / "." / só número -> minutos   ("9,66" = 9,66 min = 9 min 40 s)
//
// Sem essa regra fixa, "9,40" viraria adivinhação: 9 min 40 s ou 9,4 min? São
// 16 segundos de diferença num indicador que a rede cobra por segundo. Por
// isso a tela mostra, ao lado do campo, o que entendeu - a conferência
// acontece na hora de digitar, não semanas depois no relatório.
//
// Guardado sempre em SEGUNDOS (número), como já era: quem soma e faz média
// desses valores depois é o Fechamento, e média de "9,66" com "10:03" só
// fecha se os dois virarem a mesma unidade antes.
(function () {
  if (window.ZenithKpiTempo) return;

  function paraSegundos(txt) {
    const bruto = String(txt == null ? '' : txt).trim();
    if (!bruto) return 0;
    if (bruto.includes(':')) {
      const partes = bruto.split(':').map((p) => parseInt(p, 10));
      if (partes.some((p) => isNaN(p))) return 0;
      return partes.reduce((seg, p) => seg * 60 + p, 0);
    }
    const minutos = parseFloat(bruto.replace(',', '.'));
    if (isNaN(minutos) || minutos < 0) return 0;
    return Math.round(minutos * 60);
  }

  function paraTexto(seg) {
    const s = Math.max(0, Math.round(Number(seg) || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  // vazio não é erro de formato - é campo não preenchido, e quem decide se
  // pode ficar vazio é a regra do formulário, não esta função
  function valido(txt) {
    const bruto = String(txt == null ? '' : txt).trim();
    if (!bruto) return true;
    if (bruto.includes(':')) return /^\d{1,4}:[0-5]\d(:[0-5]\d)?$/.test(bruto);
    return /^\d{1,4}([.,]\d{1,3})?$/.test(bruto);
  }

  const MSG = 'Use o número do relatório (9,66) ou minuto:segundo (9:40).';

  // Liga um campo: mostra o que foi entendido e troca a mensagem crua do
  // navegador por uma que diz o que fazer. setCustomValidity é o que impede o
  // envio sem inventar validação paralela - o formulário continua sendo o
  // dono do "pode enviar".
  function ligar(el) {
    if (!el || el.dataset.tempoLigado) return;
    el.dataset.tempoLigado = '1';
    el.setAttribute('placeholder', '9,66 ou 9:40');
    el.setAttribute('title', MSG);
    el.removeAttribute('pattern'); // a checagem agora é aqui, com mensagem

    const dica = document.createElement('span');
    dica.className = 'kpi-tempo-dica';
    dica.style.cssText = 'display:block;font-size:11px;font-family:var(--mono,monospace);color:var(--muted,#8b98a5);margin-top:3px;min-height:14px;';
    el.insertAdjacentElement('afterend', dica);

    const conferir = () => {
      const bruto = String(el.value || '').trim();
      if (!bruto) { el.setCustomValidity(''); dica.textContent = ''; return; }
      if (!valido(bruto)) {
        el.setCustomValidity(MSG);
        dica.textContent = MSG;
        dica.style.color = 'var(--bad,#ff6b6b)';
        return;
      }
      el.setCustomValidity('');
      dica.style.color = 'var(--muted,#8b98a5)';
      // o eco é o que tira a dúvida do "9,40": mostra a leitura na OUTRA
      // unidade, não a que a pessoa acabou de digitar. Repetir a digitada
      // seria pior que inútil - o arredondamento pro segundo inteiro faz
      // "9,66" voltar como "9,67", e quem tem o relatório na mão vê um
      // número diferente do que copiou e desconfia da conta certa.
      const seg = paraSegundos(bruto);
      dica.textContent = bruto.includes(':')
        ? `= ${(seg / 60).toFixed(2).replace('.', ',')} min`
        : `= ${paraTexto(seg)} (min:seg)`;
    };
    el.addEventListener('input', conferir);
    el.addEventListener('blur', conferir);
    conferir();
  }

  function ligarTodos(seletor) {
    document.querySelectorAll(seletor).forEach(ligar);
  }

  window.ZenithKpiTempo = { paraSegundos, paraTexto, valido, ligar, ligarTodos, MSG };
})();
