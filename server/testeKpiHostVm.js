const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
function testar(src = fs.readFileSync(__dirname + '/public/loja-status.html', 'utf8')) {
  const extrair = nome => {
    const inicio = src.indexOf('function ' + nome + '(');
    assert.ok(inicio >= 0, nome);
    const proximo = src.indexOf('\nfunction ', inicio + 10);
    return src.slice(inicio, proximo);
  };
  const elementos = {};
  const el = id => elementos[id] || (elementos[id] = { classList: { toggle() {} } });
  const computadores = [
    { nome:'Comum', estado:'online' }, { nome:'Servidor', estado:'online', ehServidor:true },
    { nome:'Host', estado:'online', ehHostVm:true }, { nome:'Pulse', estado:'degradado', ehVmPulse:true },
    { nome:'Gcom', estado:'offline', ehVmGcom:true },
    { nome:'Múltiplas tags', estado:'online', ehServidor:true, ehHostVm:true, ehVmGcom:true },
    { nome:'VM sem agente', estado:'nunca', ehVmPulse:true },
    { nome:'PC sem agente', estado:'nunca' }, { nome:null, ehHostVm:true, estado:'online' },
  ];
  const ctx = { COMPUTADORES:computadores, FILTRO_STATUS:'', FILTRO_SERVIDOR:'', FILTRO_HOST_VM:true,
    document:{ getElementById:el }, statusDe:c=>c.estado, render(){} };
  vm.createContext(ctx);
  for(const nome of ['ehHostOuVm','ehGrupoServidor','computadoresReais','renderKpis','filtrarGrupoKpi']) vm.runInContext(extrair(nome),ctx);
  ctx.renderKpis();
  assert.equal(el('kpi-num-total').textContent,8);
  assert.equal(el('btn-host-vm').textContent,'🗄️ HOST & VM (5)');
  const numeros = id => [...el('kpi-num-'+id).innerHTML.matchAll(/onclick="filtrarGrupoKpi[^>]+>(\d+)<\/span>/g)].map(m=>Number(m[1]));
  assert.deepEqual(numeros('online'),[1,3]);
  assert.deepEqual(numeros('degradado'),[0,1]);
  assert.deepEqual(numeros('offline'),[0,1]);
  assert.deepEqual(numeros('nunca'),[1,1]);
  const filtrados = computadores.filter(c=>c.nome && ctx.ehGrupoServidor(c));
  assert.equal(filtrados.length,6,'máquina com múltiplas tags conta só uma vez');
  assert.match(src,/FILTRO_SERVIDOR === 'servidor'\) === ehGrupoServidor\(c\)/);
  ctx.filtrarGrupoKpi({stopPropagation(){}},'online','servidor',3);
  assert.equal(ctx.FILTRO_HOST_VM,false,'clique no KPI não mantém um segundo filtro ocultando servidores');
  assert.equal(ctx.FILTRO_SERVIDOR,'servidor');
  ctx.filtrarGrupoKpi({stopPropagation(){}},'online','servidor',3);
  assert.equal(ctx.FILTRO_SERVIDOR,'');
  for(const m of src.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))if(m[1].trim())new vm.Script(m[1]);
}
if(require.main === module){ testar(); console.log('✓ Servidores incluem HOST/VM nos KPIs e filtros, sem duplicidade'); }
module.exports={testar};
