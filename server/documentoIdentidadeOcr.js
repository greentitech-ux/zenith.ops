// documentoIdentidadeOcr.js
// Le a foto do documento de identidade (RG, CNH ou CPF) que a pessoa anexa
// no cadastro de Extra / Candidato (teste de 5 dias) e devolve os dados
// pessoais ja separados por campo: nome, nascimento, CPF, RG, nome da mae.
//
// Mesma ideia da leitura da nota fiscal (inventarioNotaOcr.js) e do
// relatorio do PDV (canaisVendaOcr.js). A diferenca aqui e o PESO do erro:
// nome trocado ou nascimento errado numa ficha de RH vira contrato errado,
// eSocial errado e, no caso de menor de idade, escala ilegal. Por isso este
// modulo e o mais desconfiado dos tres:
//
// - CPF passa por digito verificador. E a unica validacao dos tres modulos
//   que consegue provar que a leitura esta errada sem ninguem conferir: CPF
//   lido torto quase nunca fecha a conta dos digitos. Nao fechando, o campo
//   volta vazio em vez de entrar errado na ficha.
// - Data de nascimento passa por sanidade de idade (14 a 100). "12/08/2026"
//   lido no lugar de "12/08/1996" e um erro comum de OCR em documento gasto,
//   e passaria despercebido num campo de data solto.
// - Idade < 18 volta marcada. Menor de idade tem restricao de horario e de
//   funcao (nada de trabalho noturno/perigoso), entao isso precisa aparecer
//   pra quem cadastra em vez de ficar implicito na data.
//
// So funciona com ANTHROPIC_API_KEY configurada: sem ela ativo() volta false
// e o cadastro segue com os campos digitados na mao, como era antes.
let cliente = null;
function ativo() {
  return !!process.env.ANTHROPIC_API_KEY;
}
function getCliente() {
  if (!cliente) {
    const Anthropic = require('@anthropic-ai/sdk');
    cliente = new Anthropic(); // le ANTHROPIC_API_KEY da env var sozinho
  }
  return cliente;
}

// Documento de identidade e denso e mal fotografado (plastificado brilhando,
// papel gasto, foto torta) - e o dado lido vai pra ficha trabalhista
const MODELO = 'claude-sonnet-5';

const MAX_ARQUIVOS = 3; // frente + verso + eventual segunda via
const IDADE_MIN = 14;   // menor aprendiz (CLT art. 403)
const IDADE_MAX = 100;

const TODOS_CAMPOS = ['nome', 'dataNascimento', 'cpf', 'rg', 'nomeMae'];
const LINHA_JSON = {
  nome: '  "nome": "nome completo exatamente como está escrito no documento, ou null",',
  dataNascimento: '  "dataNascimento": "AAAA-MM-DD, ou null",',
  cpf: '  "cpf": "somente os 11 dígitos, sem pontos nem traço, ou null",',
  rg: '  "rg": "número do RG como está no documento, ou null",',
  nomeMae: '  "nomeMae": "nome da mãe (filiação), ou null"',
};
// regra que só faz sentido se o campo estiver sendo pedido - pedir cuidado
// com um campo que nem vai ser lido é ruído no prompt
const REGRA_DO_CAMPO = {
  nome: '- NOME: copie exatamente como está no documento, com todos os sobrenomes, sem abreviar e sem "corrigir" grafia (nomes como "Jonhatan", "Wellyngton" ou "Cezar" existem e estão certos no documento). Não inclua "Nome:", "Titular" nem rótulo nenhum.\n- NÃO confunda o nome do titular com o nome da MÃE ou do PAI. No RG a filiação vem logo abaixo do nome e é fácil trocar: o nome do titular é o que aparece sob "NOME", e os da filiação sob "FILIAÇÃO" (geralmente dois nomes, mãe e pai). Se não der pra separar com certeza, mande nome como null.',
  dataNascimento: '- DATA DE NASCIMENTO: é a data de nascimento do titular, nunca a data de emissão/expedição do documento, nem a validade. Documento sempre tem várias datas - a de nascimento costuma vir rotulada como "DATA DE NASCIMENTO" ou "NASC". Se houver dúvida sobre qual é qual, mande null.',
  cpf: '- CPF: só os 11 dígitos. Se o documento mostrar o CPF em mais de um lugar e eles não baterem, mande null.',
};

function montarPrompt(qtdImagens, campos) {
  const blocoMultiplas = qtdImagens > 1 ? `

Você recebeu ${qtdImagens} imagens. Elas são do MESMO documento (frente e verso, ou páginas diferentes). Junte tudo numa resposta só. Se forem claramente de PESSOAS diferentes (nomes diferentes), devolva {"erro": "as fotos são de pessoas diferentes"}.` : '';
  return `Você está vendo a foto de um documento de identidade brasileiro (RG, CNH, CPF, CIN/RG novo ou Carteira de Trabalho). Extraia os dados pessoais.${blocoMultiplas}

Devolva SOMENTE um JSON válido, sem nenhum texto antes ou depois, exatamente neste formato:
{
  "tipoDocumento": "RG" | "CNH" | "CPF" | "CIN" | "CTPS" | "outro",
${campos.map((c) => LINHA_JSON[c]).join('\n').replace(/,$/, '')}
}

Regras:
- Campo que você não conseguir ler com CERTEZA vai como null. Um campo vazio quem cadastra preenche olhando o documento; um campo errado vira contrato errado e ninguém percebe. Na dúvida entre duas letras ou dois números, devolva null.
${campos.map((c) => REGRA_DO_CAMPO[c]).filter(Boolean).join('\n')}
- Não devolva nenhum campo além dos listados acima, mesmo que apareça no documento.
- Se a imagem NÃO for um documento de identidade (foto de pessoa, print de tela, papel em branco, currículo), devolva {"erro": "descrição curta do que você viu"}.`;
}

function extrairJson(texto) {
  const limpo = String(texto || '').trim().replace(/^```(json)?/i, '').replace(/```\s*$/i, '').trim();
  return JSON.parse(limpo);
}

// Digito verificador do CPF. Esta e a unica checagem do fluxo que prova
// sozinha que a leitura saiu errada - por isso CPF que nao fecha volta null
// em vez de ir pra ficha. Rejeita tambem os "111.111.111-11" da vida, que
// fecham a conta mas nunca sao CPF de gente.
function cpfValido(digitos) {
  if (!/^\d{11}$/.test(digitos)) return false;
  if (/^(\d)\1{10}$/.test(digitos)) return false;
  const calcular = (ate) => {
    let soma = 0;
    for (let i = 0; i < ate; i += 1) soma += Number(digitos[i]) * (ate + 1 - i);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  return calcular(9) === Number(digitos[9]) && calcular(10) === Number(digitos[10]);
}

function idadeEm(dataISO, hoje = new Date()) {
  const [a, m, d] = dataISO.split('-').map(Number);
  let idade = hoje.getFullYear() - a;
  const mesAtual = hoje.getMonth() + 1;
  if (mesAtual < m || (mesAtual === m && hoje.getDate() < d)) idade -= 1;
  return idade;
}

// nascimento so passa se for data real E de uma idade plausivel pra
// trabalho: ano lido errado (2026 no lugar de 1996) e o erro mais comum de
// OCR em documento gasto, e passaria batido num campo de data solto
function nascimentoOuNull(valor) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(valor || ''))) return null;
  const data = new Date(`${valor}T12:00:00Z`);
  if (Number.isNaN(data.getTime())) return null;
  if (data.toISOString().slice(0, 10) !== valor) return null; // 31/02 e afins
  const idade = idadeEm(valor);
  if (idade < IDADE_MIN || idade > IDADE_MAX) return null;
  return valor;
}

const texto = (v, max) => {
  const s = String(v == null ? '' : v).trim().replace(/\s+/g, ' ').slice(0, max);
  return s || null;
};

// camposLidos: quais campos devem sair do documento. O que o Master marcou
// como "digitado na mão" (ver rhCamposConfig.js) nao entra - nem no prompt
// nem no "naoLidos", senao a tela cobraria da leitura um campo que ela nao
// foi encarregada de trazer.
async function lerDocumento({ arquivos, camposLidos }) {
  const campos = Array.isArray(camposLidos) && camposLidos.length
    ? TODOS_CAMPOS.filter((c) => camposLidos.includes(c))
    : TODOS_CAMPOS;
  if (!campos.length) throw new Error('Todos os campos estão marcados como digitados na mão - não há o que ler no documento.');
  const fotos = (Array.isArray(arquivos) ? arquivos : []).filter((a) => a && a.buffer);
  if (!fotos.length) throw new Error('Anexe a foto do documento.');
  if (fotos.length > MAX_ARQUIVOS) throw new Error(`Envie no máximo ${MAX_ARQUIVOS} imagens do documento.`);

  validarArquivosDocumento(fotos);
  // HÍBRIDO: PDF do gov.br (CNH/RG digital) tem camada de texto - extrai
  // LOCAL, de graça e determinístico, sem chamar o modelo. Foto/escaneado
  // (ou PDF cujo texto não deu o essencial com prova) cai no modelo abaixo.
  // Roda ANTES do gate da API key de propósito: PDF digital funciona até em
  // servidor sem ANTHROPIC_API_KEY configurada.
  const local = await tentarLeituraLocal(fotos, campos);
  if (local) return local;
  if (!ativo()) throw new Error('Leitura automática de documento não está configurada neste servidor.');
  const blocos = [];
  fotos.forEach((f, i) => {
    if (fotos.length > 1) blocos.push({ type: 'text', text: `Imagem ${i + 1} de ${fotos.length}:` });
    blocos.push(f.mimeType === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.buffer.toString('base64') } }
      : { type: 'image', source: { type: 'base64', media_type: normalizarTipoImagem(f.mimeType), data: f.buffer.toString('base64') } });
  });
  blocos.push({ type: 'text', text: montarPrompt(fotos.length, campos) });

  const resp = await getCliente().messages.create({
    model: MODELO,
    max_tokens: 1500,
    messages: [{ role: 'user', content: blocos }],
  });
  const bruto = (resp.content || []).map((b) => b.text || '').join('');
  let dados;
  try {
    dados = extrairJson(bruto);
  } catch (e) {
    // sem o texto bruto no log e impossivel diagnosticar corte por
    // max_tokens ou JSON malformado pela mensagem generica que o usuario ve
    console.error('documentoIdentidadeOcr: falha ao parsear JSON. stop_reason=%s texto=%s', resp.stop_reason, bruto.slice(0, 1500));
    throw new Error('Não consegui ler esse documento. Tente uma foto mais nítida, com o documento inteiro e sem reflexo.');
  }
  if (dados.erro) throw new Error(String(dados.erro).slice(0, 200));
  return montarResultado(dados, campos);
}

// ---------------------------------------------------------------------------
// Extração LOCAL de PDF com camada de texto (o "híbrido"). Só assume a
// leitura quando consegue o ESSENCIAL com prova: nome plausível E (CPF que
// fecha o dígito OU nascimento com idade plausível). Qualquer dúvida devolve
// null e o modelo assume - errado aqui vira ficha trabalhista errada.
// ---------------------------------------------------------------------------
let pdfjsPromise = null;
function getPdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

async function extrairTextoPdf(buffer) {
  try {
    const { getDocument } = await getPdfjs();
    const doc = await getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, disableFontFace: true }).promise;
    let texto = '';
    for (let i = 1; i <= doc.numPages; i += 1) {
      const tc = await (await doc.getPage(i)).getTextContent();
      texto += tc.items.map((it) => it.str).join('\n') + '\n';
    }
    return texto;
  } catch (e) {
    return ''; // PDF escaneado/protegido: sem texto, o modelo assume
  }
}

const MAIUSCULAS = "A-ZÁÀÂÃÉÊÍÓÔÕÚÜÇ";
function camposDoTexto(textoPdf) {
  const t = '\n' + String(textoPdf || '').replace(/\r/g, '') + '\n';
  const out = { nome: null, dataNascimento: null, cpf: null, rg: null, nomeMae: null, tipoDocumento: null };
  if (/CARTEIRA NACIONAL DE HABILITA/i.test(t)) out.tipoDocumento = 'CNH';
  else if (/IDENTIDADE NACIONAL|CARTEIRA DE IDENTIDADE|C[ÉE]DULA DE IDENTIDADE/i.test(t)) out.tipoDocumento = 'RG';
  // CPF: se houver mais de um CPF VÁLIDO diferente no texto, é ambíguo - null
  const cpfs = [...new Set((t.match(/\d{3}\.?\d{3}\.?\d{3}[-.]?\d{2}/g) || []).map((x) => x.replace(/\D/g, '')).filter(cpfValido))];
  if (cpfs.length === 1) out.cpf = cpfs[0];
  const paraISO = (d, m, a) => `${a}-${m}-${d}`;
  // nascimento: primeiro pelo RÓTULO; sem rótulo, só se EXATAMENTE uma data
  // do texto tiver idade plausível (emissão é recente e validade é futura,
  // então quase nunca competem)
  const porRotulo = t.match(/NASC\w*\.?\s*[:\-]?\s*\n?\s*(\d{2})[\/.](\d{2})[\/.](\d{4})/i);
  if (porRotulo) out.dataNascimento = nascimentoOuNull(paraISO(porRotulo[1], porRotulo[2], porRotulo[3]));
  if (!out.dataNascimento) {
    const plausiveis = [...new Set((t.match(/\b\d{2}[\/.]\d{2}[\/.]\d{4}\b/g) || [])
      .map((s) => { const [d, m, a] = s.split(/[\/.]/); return nascimentoOuNull(paraISO(d, m, a)); })
      .filter(Boolean))];
    if (plausiveis.length === 1) out.dataNascimento = plausiveis[0];
  }
  // nome: o que vem depois do rótulo NOME (nunca FILIAÇÃO), na mesma linha ou
  // na seguinte - e cortado em qualquer palavra que denuncie o rótulo seguinte
  const mNome = t.match(new RegExp(`\\bNOME(?:\\s+COMPLETO)?\\s*[:\\-]?\\s*\\n?\\s*([${MAIUSCULAS}][${MAIUSCULAS}' ]{4,})`));
  if (mNome) {
    const corte = mNome[1].replace(/\s+/g, ' ')
      .split(/\b(?:FILIA|DOC|CPF|NASC|DATA|REGISTRO|VALIDADE|HABILITA|CAT|IDENTIDADE|ORG|EMISS|NACIONALIDADE|NATURALIDADE|ASSINATURA|SEXO)\w*\b/)[0].trim();
    if (new RegExp(`^[${MAIUSCULAS}' ]+$`).test(corte) && corte.split(' ').length >= 2 && corte.length <= 150) out.nome = corte;
  }
  return out;
}

async function tentarLeituraLocal(fotos, campos) {
  if (!fotos.every((f) => String(f.mimeType || '').toLowerCase() === 'application/pdf')) return null;
  let textoTudo = '';
  for (const f of fotos) textoTudo += await extrairTextoPdf(f.buffer) + '\n';
  if (textoTudo.replace(/\s+/g, '').length < 60) return null; // escaneado sem texto de verdade
  const d = camposDoTexto(textoTudo);
  if (!d.nome || (!d.cpf && !d.dataNascimento)) return null; // sem o essencial provado, modelo assume
  return { ...montarResultado(d, campos), origemLeitura: 'pdf-local' };
}

// monta a resposta final a partir dos dados crus - MESMO pos-processamento
// pros dois caminhos (modelo e extração local de PDF): CPF só entra com
// dígito verificador fechando, nascimento só com idade plausível, campo não
// pedido volta null, e naoLidos diz à tela o que faltou
function montarResultado(dados, campos) {
  const cpfDigitos = String(dados.cpf || '').replace(/\D/g, '');
  const cpf = cpfValido(cpfDigitos) ? cpfDigitos : null;
  const dataNascimento = nascimentoOuNull(dados.dataNascimento);

  // "naoLidos" existe pelo mesmo motivo do "faltando" da leitura de canais:
  // a tela precisa dizer O QUE ficou faltando, em vez de deixar quem cadastra
  // descobrir no erro de validacao do envio
  const todos = { nome: texto(dados.nome, 150), dataNascimento, cpf, rg: texto(dados.rg, 30), nomeMae: texto(dados.nomeMae, 150) };
  // campo fora do pedido volta null mesmo que o modelo tenha mandado: quem
  // preenche esse e quem cadastra, e um valor "vindo do documento" aqui
  // sobrescreveria a digitacao sem ninguem pedir
  const lidos = Object.fromEntries(TODOS_CAMPOS.map((c) => [c, campos.includes(c) ? todos[c] : null]));
  const naoLidos = campos.filter((c) => !lidos[c]);

  return {
    ...lidos,
    camposLidos: campos,
    tipoDocumento: texto(dados.tipoDocumento, 20),
    // avisa quando o modelo devolveu um CPF que nao fecha o digito: nesse
    // caso o campo volta vazio, e quem cadastra precisa saber que foi erro
    // de leitura e nao ausencia do dado no documento
    // os avisos so valem pro campo que foi PEDIDO: CPF digitado na mao nao
    // passou por essa leitura, entao nao ha rejeicao a relatar
    cpfRejeitado: !!(campos.includes('cpf') && cpfDigitos && !cpf),
    nascimentoRejeitado: !!(campos.includes('dataNascimento') && dados.dataNascimento && !dataNascimento),
    menorDeIdade: !!(lidos.dataNascimento && idadeEm(lidos.dataNascimento) < 18),
    naoLidos,
  };
}

// ---------------------------------------------------------------------------
// Validação dos anexos ANTES de qualquer coisa cara. O media_type ia CRU pro
// modelo - foto HEIC do iPhone (compartilhada pelo WhatsApp/Arquivos, que a
// compressão do navegador nem sempre consegue converter) ou o "image/jpg"
// fora do padrão de alguns Android viravam um erro críptico da API na cara
// do candidato ("não conseguem anexar, dá erro"). Aqui o tipo é normalizado
// quando dá, e quando não dá a recusa explica O QUE FAZER.
// ---------------------------------------------------------------------------
const TIPOS_IMAGEM_ACEITOS = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const APELIDOS_DE_TIPO = { 'image/jpg': 'image/jpeg', 'image/pjpeg': 'image/jpeg' };

function normalizarTipoImagem(mime) {
  const limpo = String(mime || '').toLowerCase().split(';')[0].trim();
  const oficial = APELIDOS_DE_TIPO[limpo] || limpo;
  if (TIPOS_IMAGEM_ACEITOS.includes(oficial)) return oficial;
  if (/heic|heif/.test(oficial)) {
    throw new Error('A foto veio em HEIC (formato do iPhone) e a leitura não aceita esse formato. Tire a foto pela câmera aqui no próprio formulário, ou mude em Ajustes → Câmera → Formatos → "Mais compatível" e tente de novo.');
  }
  throw new Error(`O arquivo do documento veio num formato que a leitura não aceita (${oficial || 'desconhecido'}). Envie foto em JPG/PNG ou o PDF do documento.`);
}

// usada pela ROTA antes de gastar teto/modelo, e de novo dentro de
// lerDocumento (defesa em profundidade - a rota pode esquecer de chamar)
function validarArquivosDocumento(arquivos) {
  (Array.isArray(arquivos) ? arquivos : []).forEach((f) => {
    // 0 byte = placeholder do iCloud: o Safari mostra "selecionado" mas o
    // conteúdo nunca veio - sem esta recusa o arquivo vazio chegava no
    // modelo/Storage e virava erro sem explicação
    if (f.buffer && f.buffer.length === 0) {
      throw new Error('O arquivo do documento veio vazio - ele ainda está no iCloud. Abra o PDF/foto uma vez no aparelho (pra ele baixar) e anexe de novo.');
    }
    const tipo = String(f.mimeType || f.mimetype || '').toLowerCase();
    if (tipo === 'application/pdf') return;
    normalizarTipoImagem(tipo); // estoura com mensagem clara se não servir
  });
}

module.exports = { ativo, lerDocumento, cpfValido, MAX_ARQUIVOS, TODOS_CAMPOS, normalizarTipoImagem, validarArquivosDocumento };
