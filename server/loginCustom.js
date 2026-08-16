// loginCustom.js
// Personalizacao do fundo e do balao de mensagem da tela de login
// (index.html), editavel pelo Master (ver painel em login-custom.html).
// Por pedido explicito do usuario, o que fica FIXO e nao mexe aqui: a logo
// do Grupo Bravo e a frase "Zenith Ops faz parte do..." acima dela, o
// proprio card de login, e o robo em si (so o texto do balao dele muda). So
// e customizavel: o fundo da tela e o texto que aparece dentro do balao -
// pra dar pra escrever mensagens carinhosas em datas especiais (aniversario
// da equipe, feriados etc) sem precisar mexer em codigo a cada data.
const db = require('./firestore');
const DOC = db.collection('loginCustomConfig').doc('config');

const PADRAO = { ativo: false, bubbleTitulo: '', bubbleTexto: '', fundoArquivo: null };

async function obter() {
  const snap = await DOC.get();
  if (!snap.exists) return { ...PADRAO };
  return { ...PADRAO, ...snap.data() };
}

// so o Master ve o caminho de Storage do fundo (ver rota admin em index.js) -
// a tela de login publica so precisa saber SE tem fundo customizado, nunca o
// caminho em si
function semDetalheInterno(config) {
  const { fundoArquivo, ...resto } = config;
  return { ...resto, temFundo: !!fundoArquivo };
}

async function salvar({ ativo, bubbleTitulo, bubbleTexto, atualizadoPorEmail }) {
  const dados = {
    ativo: !!ativo,
    bubbleTitulo: String(bubbleTitulo || '').trim().slice(0, 80),
    bubbleTexto: String(bubbleTexto || '').trim().slice(0, 240),
    atualizadoEm: new Date().toISOString(),
    atualizadoPorEmail: atualizadoPorEmail || null,
  };
  await DOC.set(dados, { merge: true });
  return obter();
}

async function salvarFundo(caminho, atualizadoPorEmail) {
  await DOC.set({ fundoArquivo: caminho, atualizadoEm: new Date().toISOString(), atualizadoPorEmail: atualizadoPorEmail || null }, { merge: true });
  return obter();
}

async function removerFundo(atualizadoPorEmail) {
  await DOC.set({ fundoArquivo: null, atualizadoEm: new Date().toISOString(), atualizadoPorEmail: atualizadoPorEmail || null }, { merge: true });
  return obter();
}

module.exports = { obter, salvar, salvarFundo, removerFundo, semDetalheInterno };
