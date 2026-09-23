// agenteAndroid.js
//
// O AGENTE DE TABLET/CELULAR (codigo em android/, neste mesmo repositorio).
//
// POR QUE ELE EXISTE. O quiosque no navegador (public/aparelho.js) so conta
// bateria enquanto a aba esta ABERTA. Master (23/09/2026): "precisa rodar
// mesmo que o NoPulso nao esteja aberto". No navegador isso nao tem conserto:
// `navigator.getBattery` nao existe dentro de service worker, e nem Android
// nem iOS executam pagina em segundo plano de forma confiavel. Entao a parte
// que roda com o app fechado tem que ser um aplicativo de verdade.
//
// O QUE ESTE ARQUIVO NAO FAZ, DE PROPOSITO: rota nova de telemetria. O agente
// bate no MESMO /api/loja-status/heartbeat do NOCZenith e do quiosque, com o
// MESMO campo `aparelho` (e passando pelo MESMO sanitizarAparelho). Um tablet
// entra no NOC como qualquer outra maquina - card, aviso de bateria, alerta
// de loja offline e mensagem do Suporte funcionam sem uma linha a mais.
//
// Aqui ficam so as duas coisas que o servidor precisa saber do aplicativo:
// que versao existe, e como inscrever um aparelho.

// MESMA REGRA DO VERSAO_VIGIA (CLAUDE.md §4 item 2): sobe TODA VEZ que um APK
// novo for publicado, e tem que casar com o versionCode do
// android/app/build.gradle.kts. Sem subir, nenhum tablet fica sabendo que
// existe versao nova.
const VERSAO_AGENTE_ANDROID = 1;

// De onde o tablet baixa o APK. Sai de variavel de ambiente pelo mesmo motivo
// do APP_BASE_URL (CLAUDE.md §4): endereco cravado em codigo e endereco que
// alguem vai ter que caçar no dia da troca. Vazio = nao ha APK publicado
// ainda, e o agente simplesmente nao avisa de atualizacao nenhuma.
function urlDoApk() {
  return String(process.env.AGENTE_ANDROID_URL || '').trim();
}

// O LINK DE INSCRICAO que o NOC gera e alguem abre no tablet.
//
// Esquema proprio (nopulso://) e nao https de proposito: assim a inscricao
// nao depende de qual dominio o app responde hoje, e trocar de endereco
// (CLAUDE.md §4) nao quebra o jeito de inscrever aparelho novo. O endereco do
// servidor viaja DENTRO do link (b=), que e' o que o agente vai usar pra
// bater - entao um tablet inscrito hoje continua apontando certo amanha.
function montarLinkInscricao({ codigo, posto, agentToken, base }) {
  const q = new URLSearchParams();
  q.set('u', String(codigo || ''));
  if (posto) q.set('p', String(posto));
  if (agentToken) q.set('t', String(agentToken));
  if (base) q.set('b', String(base).replace(/\/+$/, ''));
  return `nopulso://inscrever?${q.toString()}`;
}

module.exports = { VERSAO_AGENTE_ANDROID, urlDoApk, montarLinkInscricao };
