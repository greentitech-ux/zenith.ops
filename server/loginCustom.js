// loginCustom.js
// Personalizacao do fundo e do balao de mensagem da tela de login
// (index.html), editavel pelo Master (ver painel em login-custom.html).
// Por pedido explicito do usuario, o que fica FIXO e nao mexe aqui: a logo
// do Grupo Bravo e a frase "Zenith Ops faz parte do..." acima dela, o
// proprio card de login, e o robo em si (so o texto do balao dele muda). So
// e customizavel: o fundo da tela e o texto que aparece dentro do balao -
// pra dar pra escrever mensagens carinhosas em datas especiais (aniversario
// da equipe, feriados etc) sem precisar mexer em codigo a cada data.
const crypto = require('crypto');
const db = require('./firestore');
const DOC = db.collection('loginCustomConfig').doc('config');

const PADRAO = { ativo: false, bubbleTitulo: '', bubbleTexto: '', fundoArquivo: null, logos: [] };

// Logos das empresas que fazem parte do Zenith, no rodapé da tela de login.
// Antes era UMA imagem fixa no código (/grupo-bravo.png): toda vez que uma
// empresa entrasse ou saísse do grupo, era preciso mexer em código e subir
// deploy. Agora é cadastro - o Master sobe e remove pela tela.
// Enquanto ninguém cadastrar nada, a tela continua mostrando a logo fixa do
// Grupo Bravo (ver login-footer em index.html): nada some de propósito só
// porque a lista nasceu vazia.
const MAX_LOGOS = 12;

async function obter() {
  const snap = await DOC.get();
  if (!snap.exists) return { ...PADRAO };
  return { ...PADRAO, ...snap.data() };
}

// so o Master ve o caminho de Storage do fundo (ver rota admin em index.js) -
// a tela de login publica so precisa saber SE tem fundo customizado, nunca o
// caminho em si
function semDetalheInterno(config) {
  const { fundoArquivo, logos, ...resto } = config;
  return {
    ...resto,
    temFundo: !!fundoArquivo,
    // a tela pública recebe só id + nome; a imagem sai por
    // /api/login-custom/logo/:id, nunca o caminho do Storage
    logos: (logos || []).map((l) => ({ id: l.id, nome: l.nome })),
  };
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

async function adicionarLogo({ nome, caminho, atualizadoPorEmail }) {
  const config = await obter();
  const logos = config.logos || [];
  if (logos.length >= MAX_LOGOS) throw new Error(`Máximo de ${MAX_LOGOS} logos no rodapé - remova uma antes de subir outra.`);
  const logo = {
    id: crypto.randomBytes(8).toString('hex'),
    nome: String(nome || '').trim().slice(0, 60) || 'Empresa',
    arquivo: caminho,
    em: new Date().toISOString(),
  };
  await DOC.set({
    logos: [...logos, logo],
    atualizadoEm: new Date().toISOString(), atualizadoPorEmail: atualizadoPorEmail || null,
  }, { merge: true });
  return obter();
}

// devolve o caminho no Storage junto com a config nova, pra quem chamou
// poder apagar o arquivo DEPOIS que a remoção do cadastro deu certo (se
// apagasse antes e a escrita falhasse, sobrava um cadastro apontando pra
// arquivo que não existe mais)
async function removerLogo(id, atualizadoPorEmail) {
  const config = await obter();
  const logos = config.logos || [];
  const alvo = logos.find((l) => l.id === id);
  if (!alvo) throw new Error('Logo não encontrada.');
  await DOC.set({
    logos: logos.filter((l) => l.id !== id),
    atualizadoEm: new Date().toISOString(), atualizadoPorEmail: atualizadoPorEmail || null,
  }, { merge: true });
  return { config: await obter(), arquivoRemovido: alvo.arquivo || null };
}

async function acharLogo(id) {
  const config = await obter();
  return (config.logos || []).find((l) => l.id === id) || null;
}

module.exports = {
  obter, salvar, salvarFundo, removerFundo, semDetalheInterno,
  adicionarLogo, removerLogo, acharLogo, MAX_LOGOS,
};
