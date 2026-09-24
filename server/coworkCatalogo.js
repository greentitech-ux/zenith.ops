// coworkCatalogo.js
// DESCOBERTA PRO CLAUDE (pedido do Cowork, 24/09/2026): o que existe e com
// que nome, antes de agir. Nasceu de dois erros reais:
//   - criar_formulario recusava "Dom Praça Aero Recife", o nome que o próprio
//     NoPulso devolve nas outras ferramentas ("Unidade inválida"), sem dizer
//     qual nome ele aceitava;
//   - o Claude não tinha como saber quais tipos de formulário existem nem
//     quais campos cada um pede, e chutava.
//
// ESPAÇOS DE NOME (CLAUDE.md §1): a unidade tem CÓDIGO (identidade, o que vai
// gravado - "Dominos Praça Aeroporto Recife"), NOME de exibição ("Dom Praça
// Aero Recife") e APELIDOS (códigos da Adyen, nome curto). O formulário tem
// ainda um RÓTULO próprio, o que sai impresso no PDF ("Spoleto Domino's
// Aeroporto Recife"), ligado ao código pelo cadastro (formulariosUnidades).
// Aqui só se TRADUZ entrada -> código/rótulo; nada é renomeado nem migrado.
//
// Custo (§3): os nomes vêm de listas fixas + unidadesExtras (cache), e o
// cadastro de formulário tem cache próprio. Nenhuma leitura por chamada.
const formulariosUnidades = require('./formulariosUnidades');
const unidades = require('./unidades');
const empresas = require('./empresas');

// o index.js entrega os nomes (listas fixas + extras) e os apelidos - eles
// moram lá e não devem ser copiados pra cá
let fonte = { nomes: async () => ({}), apelidos: {} };
function configurar(opcoes = {}) {
  if (typeof opcoes.nomes === 'function') fonte.nomes = opcoes.nomes;
  if (opcoes.apelidos && typeof opcoes.apelidos === 'object') fonte.apelidos = opcoes.apelidos;
}

// "Dom Praça Aero Recife" == "dom praca aero recife" == "DOM  PRAÇA  AERO RECIFE"
function normalizar(v) {
  return String(v == null ? '' : v).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[’'`´]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// { codigo: { codigo, nome, apelidos: [] } }
async function mapaDeUnidades() {
  const nomes = await fonte.nomes().catch(() => ({}));
  const out = {};
  for (const [codigo, nome] of Object.entries(nomes || {})) out[codigo] = { codigo, nome: nome || codigo, apelidos: [] };
  // apelido aponta pro NOME; o nome aponta pro código
  const porNome = {};
  Object.values(out).forEach((u) => { porNome[normalizar(u.nome)] = u; });
  for (const [apelido, nome] of Object.entries(fonte.apelidos || {})) {
    const u = porNome[normalizar(nome)];
    if (u && apelido !== u.codigo && !u.apelidos.includes(apelido)) u.apelidos.push(apelido);
  }
  return out;
}

function erroComLista(o_que, recebido, validos) {
  const e = new Error(`${o_que} "${recebido}" não existe. Valores aceitos: ${validos.join(' | ')}.`);
  e.code = 'VALOR_INVALIDO';
  e.aceitos = validos;
  return e;
}

// código, nome ou apelido -> { codigo, nome }. Sem diferenciar acento nem
// maiúscula. Não achou: erro com a lista do que existe.
async function resolverUnidade(entrada) {
  const alvo = normalizar(entrada);
  if (!alvo) throw new Error('Informe a unidade (código, nome ou apelido).');
  const mapa = await mapaDeUnidades();
  for (const u of Object.values(mapa)) {
    if ([u.codigo, u.nome, ...u.apelidos].some((k) => normalizar(k) === alvo)) return { codigo: u.codigo, nome: u.nome };
  }
  throw erroComLista('Unidade', entrada, Object.values(mapa).map((u) => `${u.nome} (${u.codigo})`));
}

// entrada -> cadastro de formulário (o RÓTULO que vai no PDF). Aceita o
// rótulo, o código, o nome ou o apelido da unidade.
async function resolverUnidadeDoFormulario(entrada) {
  const bruto = String(entrada == null ? '' : entrada).trim();
  if (!bruto) throw new Error('Informe a unidade do formulário.');
  const ativos = (await formulariosUnidades.listar()).filter((c) => c.ativo !== false);
  const alvo = normalizar(bruto);
  const peloRotulo = ativos.find((c) => normalizar(c.unidade) === alvo);
  if (peloRotulo) return peloRotulo;
  let unidade = null;
  try { unidade = await resolverUnidade(bruto); } catch (e) { unidade = null; }
  if (unidade) {
    const c = await formulariosUnidades.obterPorCodigo(unidade.codigo);
    if (c && c.ativo !== false) return c;
    throw erroComLista(`A unidade ${unidade.nome} não tem cadastro de formulário (razão social/CNPJ). Unidade`, bruto,
      ativos.map((x) => x.unidade));
  }
  throw erroComLista('Unidade de formulário', bruto, ativos.map((x) => x.unidade));
}

async function listarUnidades() {
  const mapa = await mapaDeUnidades();
  const cadastros = (await formulariosUnidades.listar()).filter((c) => c.ativo !== false);
  const out = [];
  for (const u of Object.values(mapa)) {
    const perfil = await unidades.perfil(u.codigo).catch(() => null);
    const empresa = await empresas.empresaDaUnidade(u.codigo).catch(() => null);
    const cad = cadastros.find((c) => formulariosUnidades.codigosDe(c).includes(u.codigo)) || null;
    out.push({
      codigo: u.codigo, nome: u.nome, apelidos: u.apelidos,
      marca: perfil && perfil.marca ? (unidades.MARCAS_LABEL[perfil.marca] || perfil.marca) : null,
      empresa: empresa ? (empresa.nome || empresa.id) : null,
      formulario: cad ? { unidade: cad.unidade, razaoSocial: cad.razaoSocial, cnpj: cad.cnpj } : null,
    });
  }
  return out.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
}

module.exports = { configurar, normalizar, mapaDeUnidades, resolverUnidade, resolverUnidadeDoFormulario, listarUnidades, erroComLista };
