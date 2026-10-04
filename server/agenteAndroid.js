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
const VERSAO_AGENTE_ANDROID = 2;

// A publicação assinada e imutável vem do workflow deste repositório.
// AGENTE_ANDROID_URL pode substituir a origem; vazio explícito desabilita.
function urlDoApk() {
  const valor = String(process.env.AGENTE_ANDROID_URL === undefined
    ? `https://github.com/greentitech-ux/zenith.ops/releases/download/agente-android-v${VERSAO_AGENTE_ANDROID}/nopulso-agente.apk`
    : process.env.AGENTE_ANDROID_URL).trim();
  try {
    const url = new URL(valor);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
  } catch (_) { return ''; }
}

// NOC é a permissão existente network-private. Admin não ganha este acesso.
function podeBaixarInstalador(req) {
  if (req.isMaster && !req.isQaMaster) return true;
  const u = req.user || {};
  const cargos = [...(Array.isArray(u.cargos) ? u.cargos : []), u.cargo];
  return cargos.includes('suporte') && (u.permissions?.sections || []).includes('network-private');
}

// URL de origem vem exclusivamente da configuração do servidor, nunca do cliente.
// O proxy mantém a autorização no NoPulso e não manda o Bearer para o fornecedor.
async function baixarInstalador(req, res) {
  res.set('Cache-Control', 'private, no-store');
  if (!podeBaixarInstalador(req)) return res.status(403).json({ error: 'Download permitido somente ao Master ou Suporte com acesso NOC.' });
  const origem = urlDoApk();
  if (!origem) return res.status(503).json({ error: 'O APK assinado ainda não foi disponibilizado. O Master precisa configurar AGENTE_ANDROID_URL.' });
  const controlador = new AbortController();
  const limite = 32 * 1024 * 1024;
  const prazo = setTimeout(() => controlador.abort(), 60000);
  const fechar = () => { if (!res.writableFinished) controlador.abort(); };
  res.once('close', fechar);
  try {
    const resposta = await fetch(origem, { signal: controlador.signal, redirect: 'follow' });
    if (!resposta.ok || !resposta.body || Number(resposta.headers.get('content-length')) > limite) throw new Error('Origem indisponível');
    // APK é ZIP. Evita entregar página HTML de login/erro como instalador.
    const leitor = resposta.body.getReader();
    let bytes = 0;
    let prefixo = Buffer.alloc(0);
    while (prefixo.length < 4) {
      const item = await leitor.read();
      if (item.done) throw new Error('Arquivo vazio');
      prefixo = Buffer.concat([prefixo, Buffer.from(item.value)]);
      if (prefixo.length > limite) throw new Error('Arquivo muito grande');
    }
    if (!prefixo.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) throw new Error('Não é APK');
    res.type('application/vnd.android.package-archive');
    res.set('Content-Disposition', `attachment; filename="nopulso-agente-v${VERSAO_AGENTE_ANDROID}.apk"`);
    res.set('X-Content-Type-Options', 'nosniff');
    async function* conteudo() {
      bytes = prefixo.length;
      yield prefixo;
      while (true) {
        const item = await leitor.read();
        if (item.done) break;
        bytes += item.value.length;
        if (bytes > limite) throw new Error('Arquivo muito grande');
        yield Buffer.from(item.value);
      }
    }
    await require('stream/promises').pipeline(require('stream').Readable.from(conteudo()), res);
  } catch (_) {
    controlador.abort();
    if (!res.headersSent && !res.destroyed) res.status(502).json({ error: 'Não foi possível baixar o APK. Verifique a publicação do instalador assinado.' });
    else if (!res.destroyed) res.destroy();
  } finally {
    clearTimeout(prazo);
    res.removeListener('close', fechar);
  }
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

module.exports = { VERSAO_AGENTE_ANDROID, urlDoApk, montarLinkInscricao, podeBaixarInstalador, baixarInstalador };
