// Central Beniboy em origem própria. O host separa a Central do NoPulso
// instalado no www, sem transportar sessão, token ou permissões entre eles.
const HOST_PADRAO = 'atendimento.nopulso.com.br';

function hostAtendimento() {
  return String(process.env.ATENDIMENTO_HOST || HOST_PADRAO).trim().toLowerCase();
}

function hostDe(req) {
  return String(req.headers?.host || '').split(':')[0].trim().toLowerCase();
}

function ehHostAtendimento(req) {
  const host = hostDe(req);
  return !!host && host === hostAtendimento();
}

function ehTelaDoAtendimento(caminho) {
  const rota = String(caminho || '/').replace(/\.html$/i, '');
  return rota === '/atendimento' || rota.startsWith('/atendimento/') || rota === '/alerta-beniboy';
}

function ehNavegacaoDeTela(req) {
  if (!['GET', 'HEAD'].includes(req.method)) return false;
  const rota = String(req.path || '/');
  if (rota.startsWith('/api/') || rota.startsWith('/webhooks/') || rota.startsWith('/mcp/')) return false;
  if (/\.[a-z0-9]+$/i.test(rota) && !/\.html$/i.test(rota)) return false;
  const aceita = String(req.headers?.accept || '');
  return aceita.includes('text/html') || /\.html$/i.test(rota) || rota === '/';
}

function consulta(req) {
  const url = String(req.originalUrl || req.url || '');
  const indice = url.indexOf('?');
  return indice >= 0 ? url.slice(indice) : '';
}

function destino(req, baseOficial) {
  if (!ehHostAtendimento(req) || !ehNavegacaoDeTela(req)) return null;
  const rota = String(req.path || '/');
  const query = consulta(req);
  // A raiz limpa é a Central. Sem sessão ela própria leva ao portal de
  // entrada; com sessão preserva a abertura direta das conversas. A query
  // ?app=beniboy é o antigo acesso normal.
  if (rota === '/' || /^\/index(\.html)?$/i.test(rota)) {
    return query ? `${baseOficial}/${query}` : '/atendimento/central';
  }
  if (/^\/beniboy(\.html)?$/i.test(rota)) return '/atendimento/central' + query;
  if (ehTelaDoAtendimento(rota)) return null;
  const curta = rota.replace(/\.html$/i, '') || '/';
  return `${baseOficial}${curta}${query}`;
}

function middleware(getBaseOficial) {
  return (req, res, next) => {
    const base = String(typeof getBaseOficial === 'function' ? getBaseOficial() : getBaseOficial || '').replace(/\/+$/, '');
    const alvo = destino(req, base);
    if (!alvo) return next();
    res.set('Cache-Control', 'no-store');
    return res.redirect(302, alvo);
  };
}

function manifesto(base) {
  return { ...base, start_url: '/atendimento/central', scope: '/' };
}

module.exports = { HOST_PADRAO, hostAtendimento, ehHostAtendimento, destino, middleware, manifesto };
