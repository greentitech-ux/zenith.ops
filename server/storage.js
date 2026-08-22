// storage.js
// Guarda os anexos das disputas/observacoes de pedido (foto, print, video,
// audio de ligacao, etc.) no Firebase Cloud Storage (mesmo projeto/credenciais
// do Firestore) - nao expomos URL publica, os arquivos sao servidos via
// streaming pelo proprio backend (index.js).
require('./firestore'); // garante que o app do firebase-admin ja foi inicializado
const { resolverBucket, comBucket } = require('./storageBucket');

function caminhoSeguro(nome) {
  return (nome || 'arquivo').replace(/[^a-zA-Z0-9_.-]/g, '_');
}

async function salvarArquivo(pedidoId, file, pasta = 'disputes') {
  const caminho = `${pasta}/${caminhoSeguro(pedidoId)}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${caminhoSeguro(file.originalname)}`;
  try {
    // comBucket testa os candidatos de bucket com o upload REAL - se o
    // primeiro nome nao existir, tenta o proximo automaticamente (ver
    // storageBucket.js); so estoura pro usuario se nenhum funcionar
    await comBucket((bucket) => bucket.file(caminho).save(file.buffer, { contentType: file.mimetype || 'application/octet-stream' }));
  } catch (err) {
    console.error('Erro ao salvar arquivo no Storage:', err.message);
    throw new Error('Não foi possível enviar o arquivo agora. Tente novamente em instantes ou contate o suporte.');
  }
  return caminho;
}

async function streamArquivo(caminho, tipo, res) {
  const bucket = await resolverBucket();
  if (tipo) res.set('Content-Type', tipo);
  bucket
    .file(caminho)
    .createReadStream()
    .on('error', (err) => {
      console.error('Erro ao ler arquivo do Storage:', err.message);
      if (!res.headersSent) res.sendStatus(404);
    })
    .pipe(res);
}

// baixa o arquivo pra memoria em vez de mandar direto pro cliente. Existe
// pro relatorio em PDF, que precisa EMBUTIR a foto dentro do documento (o
// pdfkit e sincrono, entao os bytes tem que estar na mao antes de desenhar).
// Devolve null em vez de estourar: uma foto que sumiu do Storage nao pode
// derrubar o relatorio inteiro - o PDF sai com o aviso no lugar dela.
async function baixarArquivo(caminho) {
  try {
    const bucket = await resolverBucket();
    const [buffer] = await bucket.file(caminho).download();
    return buffer;
  } catch (err) {
    console.error('Erro ao baixar arquivo do Storage:', caminho, err.message);
    return null;
  }
}

async function apagarArquivo(caminho) {
  const bucket = await resolverBucket();
  await bucket.file(caminho).delete({ ignoreNotFound: true });
}

module.exports = { salvarArquivo, streamArquivo, baixarArquivo, apagarArquivo };
