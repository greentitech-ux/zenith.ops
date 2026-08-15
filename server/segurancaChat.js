// segurancaChat.js
// Heuristica leve pra flagar tentativa de injecao/execucao de script ou
// comando no chat de suporte (widget publico, sem login) - pedido
// explicito do usuario: "fechar as brechas de seguranca afim que nao
// mandem um script e o bot rode o script". O Beniboy (suporteBot.js) JA
// NUNCA executa texto livre como codigo - a unica acao que roda comando
// de verdade e' 'comando_maquina' (ver agenteAcoes.js/lojaStatus.js), e o
// texto do comando vem SEMPRE de um catalogo pre-cadastrado pelo Master,
// nunca do que o visitante escreveu. Isso aqui e' uma camada A MAIS:
// detectar quando ALGUEM TENTA (mesmo sem chance real de rodar nada) e
// alertar o Master na hora, com contexto do acesso, pra decisao humana.
function detectarConteudoSuspeito(texto) {
  const t = String(texto || '');
  if (!t) return null;
  const padroes = [
    { re: /invoke-expression|invoke-webrequest|downloadstring|-encodedcommand|start-process\s|iex\s*\(/i, motivo: 'Comando PowerShell' },
    { re: /(rm\s+-rf|chmod\s+\+x|wget\s+http|curl\s+http[^\s]*\s*\|\s*(bash|sh)\b|\/bin\/(bash|sh)\b)/i, motivo: 'Comando de shell Unix' },
    { re: /cmd(\.exe)?\s*\/c|certutil\s+-urlcache|mshta\s|regsvr32\s/i, motivo: 'Comando do Windows (cmd/certutil/mshta)' },
    { re: /<script[\s>]|javascript:|onerror\s*=|document\.cookie/i, motivo: 'Injeção de script (XSS)' },
    { re: /\bunion\s+select\b|\bdrop\s+table\b|'\s*or\s*'1'\s*=\s*'1/i, motivo: 'Injeção de SQL' },
    { re: /ignore (all |todas )?(previous|above|as )?(instructions|instruções)|disregard (your|the) (instructions|rules)|modo desenvolvedor|voc[eê] (agora )?[ée] (um |o )?dev(eloper)?/i, motivo: 'Tentativa de manipular o assistente (prompt injection)' },
  ];
  for (const p of padroes) {
    if (p.re.test(t)) return p.motivo;
  }
  return null;
}

// extensoes nunca aceitas como anexo do chat - qualquer coisa executavel/
// script. Bloqueio por extensao E por mimetype (defesa em profundidade -
// nenhum dos dois sozinho e confiavel: extensao pode mentir, mimetype
// tambem e so o que o navegador declarou)
const EXTENSOES_BLOQUEADAS = /\.(exe|bat|cmd|com|scr|msi|ps1|psm1|vbs|vbe|js|mjs|jse|wsf|wsh|jar|sh|bash|apk|dll|app|command|reg|hta|py|pyc|rb|pl|php)$/i;
const MIME_PERMITIDOS = /^(image\/(jpeg|png|gif|webp|heic|heif)|application\/pdf)$/i;

function validarAnexo(file) {
  const nome = String((file && file.originalname) || '');
  if (EXTENSOES_BLOQUEADAS.test(nome)) {
    return { ok: false, motivo: `Tipo de arquivo não permitido (.${nome.split('.').pop()}).` };
  }
  if (!MIME_PERMITIDOS.test((file && file.mimetype) || '')) {
    return { ok: false, motivo: 'Só é permitido enviar imagens ou PDF.' };
  }
  return { ok: true };
}

module.exports = { detectarConteudoSuspeito, validarAnexo };
