// agenteLinux.js
// AGENTE DO NOC PARA LINUX (Zorin, Ubuntu e derivados). Pedido do Master
// (13/10): "faça um agente que rode em Linux" - o STT-HOME-ZORIN só aparecia
// no NOC pela aba do navegador, sem rede, disco, reinício nem nada do que o
// NOCZenith conta nas máquinas Windows.
//
// O agente é um script Python 3 (agenteLinuxScript.py), que vem instalado em
// todo Zorin/Ubuntu. Este arquivo só faz duas coisas: monta o script com a
// unidade, o posto e o token DESTA máquina, e monta o comando de instalação
// que o NOC mostra. Mesmo token do NOCZenith e do app Android (garantirAgentToken):
// três formas de instalar a mesma máquina nunca discordam de cadastro.
//
// Versão: sobe a cada mudança no script. O agente instalado baixa o próprio
// script a cada 6 h e se troca quando a versão aqui for maior.
'use strict';
const fs = require('fs');
const path = require('path');

const VERSAO_AGENTE_LINUX = 3;
const MODELO = fs.readFileSync(path.join(__dirname, 'agenteLinuxScript.py'), 'utf8');
const PRINT_X11 = fs.readFileSync(path.join(__dirname, 'noPulsoPrintLinux.py'), 'utf8');

function caminhoDoScript(codigo, posto) {
  return `/api/loja-status/${encodeURIComponent(codigo)}/computadores/${encodeURIComponent(posto)}/agente-linux.py`;
}

// literal de string Python a partir de JSON: JSON.stringify gera aspas duplas
// e escapes que o Python entende igual (\n, \", \\, \uXXXX)
const lit = (v) => JSON.stringify(String(v == null ? '' : v));

function montarScriptAgenteLinux({ codigo, posto, agentToken, base }) {
  const trocas = {
    __PRINT_X11__: lit(PRINT_X11),
    __VERSAO__: String(VERSAO_AGENTE_LINUX),
    __BASE__: lit(String(base || '').replace(/\/+$/, '')),
    __CODIGO__: lit(codigo),
    __POSTO__: lit(posto),
    __TOKEN__: lit(agentToken),
    __CAMINHO_SCRIPT__: lit(caminhoDoScript(codigo, posto)),
  };
  let saida = MODELO;
  for (const [marca, valor] of Object.entries(trocas)) {
    if (!saida.includes(marca)) throw new Error('Modelo do agente Linux sem a marca ' + marca);
    saida = saida.split(marca).join(valor);
  }
  return saida;
}

// UMA linha pra colar no terminal: baixa o script desta máquina (com o token
// no cabeçalho, nunca na URL) e instala como serviço. O sudo pede a senha do
// usuário uma vez - é o equivalente do UAC no Windows.
function montarComandoInstalacaoLinux({ codigo, posto, agentToken, base }) {
  const url = String(base || '').replace(/\/+$/, '') + caminhoDoScript(codigo, posto);
  const aspas = (v) => "'" + String(v).replace(/'/g, "'\\''") + "'";
  // arquivo temporário NOVO a cada vez (mktemp): com nome fixo, uma 2ª tentativa
  // com "sudo curl" batia no arquivo deixado pela 1ª (dono: o usuário) e o
  // Linux recusa o root gravando por cima em /tmp - "curl: (23) Failure
  // writing output to destination", caso real da 1ª instalação. O curl roda
  // como o usuário; só a instalação usa sudo.
  return `f=$(mktemp /tmp/nopulso-agente.XXXXXX) && curl -fsSL -H ${aspas('X-NOC-Token: ' + agentToken)} ${aspas(url)} -o "$f" && sudo python3 "$f" --instalar`;
}

module.exports = { VERSAO_AGENTE_LINUX, montarScriptAgenteLinux, montarComandoInstalacaoLinux, caminhoDoScript };
