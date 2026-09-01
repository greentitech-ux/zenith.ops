// storage.js
// Guarda os anexos das disputas/observacoes de pedido (foto, print, video,
// audio de ligacao, etc.) no Firebase Cloud Storage (mesmo projeto/credenciais
// do Firestore) - nao expomos URL publica, os arquivos sao servidos via
// streaming pelo proprio backend (index.js).
require('./firestore'); // garante que o app do firebase-admin ja foi inicializado
const { resolverBucket, comBucket } = require('./storageBucket');

// COBRANÇA DO GOOGLE CLOUD SUSPENSA tem cara de erro passageiro e não é.
// O Storage devolve 403 accountDisabled ("The billing account for the owning
// project is disabled in state delinquent") e a mensagem que existia aqui
// mandava "tentar novamente em instantes" - quem estava anexando o
// comprovante tentava cinco vezes, desistia, e ninguém ficava sabendo o
// motivo. Tentar de novo NÃO resolve: só pagar resolve.
//
// Firestore continua funcionando (tem faixa gratuita), então o app inteiro
// parece bem enquanto SÓ os anexos falham - e anexo aqui é comprovante de
// estorno, boleto pra assinar, nota de compra. Por isso o erro tem que dizer
// a causa, e o log tem que gritar.
function ehCobrancaSuspensa(err) {
  const msg = String((err && err.message) || '');
  const cod = err && (err.code === 403 || err.code === '403');
  return /accountDisabled|billing account/i.test(msg) || (cod && /disabled|delinquent/i.test(msg));
}
const ERRO_COBRANCA = 'O armazenamento de arquivos do Google Cloud está bloqueado '
  + '(cobrança do projeto suspensa). Anexo não sobe nem abre até a fatura ser regularizada - '
  + 'tentar de novo não resolve. Avise o Master.';

// grita UMA vez por processo: um 403 desses se repete em toda tentativa de
// anexo, e cem linhas iguais escondem o resto do log
let jaGritouCobranca = false;
function gritarCobranca(err) {
  if (jaGritouCobranca) return;
  jaGritouCobranca = true;
  console.error('[STORAGE BLOQUEADO] A cobrança do projeto no Google Cloud está suspensa '
    + '(accountDisabled). NENHUM anexo sobe ou abre até regularizar a fatura no Google Cloud Billing. '
    + `Detalhe: ${(err && err.message) || err}`);
}

// a decisão fica numa função própria pra poder ser testada: o que importa é
// QUAL mensagem chega em quem está anexando, e isso não dá pra conferir
// olhando o try/catch de fora
function erroDeUpload(err) {
  if (ehCobrancaSuspensa(err)) {
    gritarCobranca(err);
    return new Error(ERRO_COBRANCA);
  }
  console.error('Erro ao salvar arquivo no Storage:', (err && err.message) || err);
  return new Error('Não foi possível enviar o arquivo agora. Tente novamente em instantes ou contate o suporte.');
}

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
    throw erroDeUpload(err);
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
      // 404 aqui e mentira quando a causa e cobranca: o arquivo EXISTE, quem
      // esta bloqueado e o acesso. Dizer "nao encontrado" manda o Master
      // procurar um anexo que nunca sumiu.
      if (ehCobrancaSuspensa(err)) {
        gritarCobranca(err);
        if (!res.headersSent) res.status(503).type('text/plain; charset=utf-8').send(ERRO_COBRANCA);
        return;
      }
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
    if (ehCobrancaSuspensa(err)) gritarCobranca(err);
    console.error('Erro ao baixar arquivo do Storage:', caminho, err.message);
    return null;
  }
}

async function apagarArquivo(caminho) {
  const bucket = await resolverBucket();
  await bucket.file(caminho).delete({ ignoreNotFound: true });
}

module.exports = { salvarArquivo, streamArquivo, baixarArquivo, apagarArquivo, ehCobrancaSuspensa, ERRO_COBRANCA, erroDeUpload };
