'use strict';
// Projeções de leitura sobre os mesmos caches usados pelas telas. Nunca
// dispara coleta, comandos de NOC, pagamentos ou consultas ao Chrome.
const { periodo, normalizar, mascarar } = require('./pedidosMonitor');
const texto = v => v == null ? null : mascarar(String(v)).slice(0, 500);
const numero = v => v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
const nomeProtegido = v => String(v || '').trim().split(/\s+/).filter(Boolean).map(s => s[0] + '.').join(' ').slice(0, 80) || null;
const diaSP = ms => new Intl.DateTimeFormat('en-CA', { timeZone:'America/Sao_Paulo' }).format(new Date(ms));
const schemaTexto = { type:'string' };
const comum = { unidade:schemaTexto, desde:schemaTexto, ate:schemaTexto,
  limite:{type:'integer',minimum:1,maximum:100}, pagina:{type:'integer',minimum:1} };
const definicoes = {
  obter_fechamento:['Fechamento de uma unidade/dia. Mesma leitura consolidada da tela; valores ausentes são null, não zero.', ['unidade'], {unidade:schemaTexto,data:schemaTexto,limite:comum.limite,pagina:comum.pagina}],
  listar_fechamentos:['Fechamentos consolidados por período; padrão hoje em São Paulo, paginação e campos financeiros preservados.', [], comum],
  consultar_acessos_parque:['Check-ins efetivamente iniciados, recorrência na base retida, planos, horários e financeiro pela data da venda. Dados pessoais mascarados.', ['unidade'], comum],
  obter_cliente_parque:['Histórico retido do parque por documento/telefone exato ou nome. Retorna identificação mascarada e visitas paginadas, sem documentos, endereços ou dados de saúde.', ['unidade'], {...comum,documento:schemaTexto,telefone:schemaTexto,nome:schemaTexto}],
  obter_diagnostico:['Último diagnóstico completo e telemetria de um computador. Não executa comandos. A coleta via executar_noc exige aprovação do Master.', ['codigo','posto'], {codigo:schemaTexto,posto:schemaTexto}],
  resumo_unidade:['Resumo diário das fontes nativas, Monitor e vendas iFood já sincronizadas. Fontes não conectadas aparecem indisponíveis, nunca como zero.', ['unidade'], {unidade:schemaTexto,data:schemaTexto}],
};
const ferramentas = Object.fromEntries(Object.entries(definicoes).map(([nome,[descricao,obrigatorios]])=>[nome,{descricao,obrigatorios,risco:'leitura'}]));
const parametros = Object.fromEntries(Object.entries(definicoes).map(([nome,[,,props]])=>[nome,Object.keys(props)]));
const propriedades = nome => definicoes[nome]?.[2];
let fonteFechamentos = null;
function configurar({fechamentos}={}) { if(typeof fechamentos==='function') fonteFechamentos=fechamentos; }
function janela(p={}) {
  const j=periodo(p.data ? {desde:p.data,ate:p.data} : p);
  if(j.ate-j.desde>366*86400000) throw new Error('Consulte no máximo 366 dias por vez.');
  return {...j,inicio:diaSP(j.desde),fim:diaSP(j.ate)};
}
function paginacao(p={}) {
  const limite=p.limite??30,pagina=p.pagina??1;
  if(!Number.isInteger(limite)||limite<1||limite>100) throw new Error('limite deve ser inteiro entre 1 e 100.');
  if(!Number.isSafeInteger(pagina)||pagina<1||pagina>1000000) throw new Error('pagina deve ser inteiro entre 1 e 1000000.');
  return {limite,pagina};
}
function paginar(lista,p) {
  const {limite,pagina}=paginacao(p),inicio=(pagina-1)*limite;
  return {total:lista.length,pagina,limite,proximaPagina:inicio+limite<lista.length?pagina+1:null,itens:lista.slice(inicio,inicio+limite)};
}
async function unidade(entrada) {
  const catalogo=require('./coworkCatalogo'),u=await catalogo.resolverUnidade(entrada);
  const mapa=await catalogo.mapaDeUnidades();
  const iguais=Object.values(mapa).filter(x=>x.codigo===u.codigo||normalizar(x.nome)===normalizar(u.nome));
  const codigos=new Set([u.codigo,u.nome,...iguais.flatMap(x=>[x.codigo,x.nome,...x.apelidos])].map(normalizar));
  return {...u,contem:codigo=>codigos.has(normalizar(codigo))};
}
const noPeriodo = (dia,j) => typeof dia==='string' && dia>=j.inicio && dia<=j.fim;
const indisponivel = motivo => ({disponivel:false,motivo});
function projetarFechamento(f) {
  // CLAUDE.md: pix é Adyen online; adyen são maquininhas. Não remapear histórico.
  const campos={pix:'Adyen',ifood:'iFood',food99:'99Food',adyen:'Maquininhas (total)',pixCnpj:'PIX CNPJ',entradaDinheiro:'Dinheiro',outros:'Outros'};
  return {id:f.id,unidade:f.unidade,unidadeNome:f.unidadeNome,data:f.data,
    status:f.status || null,conferido:typeof f.conferido==='boolean'?f.conferido:null,
    fechadoPor:texto(f.gerente||f.criadoPorNome||f.criadoPorEmail),criadoEm:f.criadoEm||null,
    formasPagamento:Object.entries(campos).map(([campo,nome])=>({campo,nome,valor:numero(f[campo]),quantidade:null})),
    formasAdicionais:Object.entries(f.formasPagamentoExtras||{}).slice(0,100).map(([nome,v])=>({nome:texto(nome),valor:numero(v),quantidade:null})),
    detalhesMaquinas:(f.detalhesMaquinas||[]).slice(0,100).map(x=>({descricao:texto(x.descricao),valor:numero(x.valor)})),
    totais:{faturamento:numero(f.faturamento),declarado:numero(f.totalDeclarado),bruto:numero(f.totalBruto),descontos:numero(f.descontos),liquido:numero(f.totalLiquido),cancelamentos:numero(f.valorCancelados)},
    quantidadeCancelados:numero(f.cancelados),divergencia:{valor:numero(f.diferenca),motivo:texto(f.obsDif)},observacao:texto(f.observacao),
    cobertura:'Lançado não significa conferido. Quantidades por pagamento e bruto/líquido só existem quando fornecidos pela origem. Adicionais podem compor os totais, não somar novamente.'};
}
async function fechamentos(p,um=false) {
  const j=janela(p),u=p.unidade?await unidade(p.unidade):null; paginacao(p);
  if(!fonteFechamentos) return indisponivel('Fonte de fechamentos não configurada.');
  const fonte=await fonteFechamentos();
  const itens=fonte.itens.filter(f=>(!u||u.contem(f.unidade))&&noPeriodo(f.data,j))
    .sort((a,b)=>String(b.data).localeCompare(String(a.data))||String(a.unidade).localeCompare(String(b.unidade)))
    .map(projetarFechamento);
  return {disponivel:true,fonte:'Fechamentos consolidados do NoPulso',periodo:{desde:j.inicio,ate:j.fim},
    cobertura:fonte.cobertura||null,...paginar(itens,p),...(um?{encontrado:itens.length>0}:{}),
    aviso:itens.length?null:'Nenhum lançamento retido encontrado; não comprova caixa aberto nem faturamento zero.'};
}
function chaveCrianca(c,r) {
  const responsavel=String(r?.cpf||r?.contato||'').replace(/\D/g,'');
  if(!c.nome||!c.dataNascimento||!responsavel) return null;
  // Heurística explícita: sem identificador único global de criança, não
  // misturar homônimos ou declarar primeira visita sem identidade suficiente.
  return JSON.stringify([normalizar(c.nome),c.dataNascimento,responsavel]);
}
const visitou = c => c.iniciado===true && c.usou!==false && c.status!=='cancelado' && !c.cancelado;
function resumirVisitas(base,j) {
  const historico=new Map(),linhas=[];
  for(const v of base.filter(visitou).sort((a,b)=>(a.dataUtilizacao+' '+(a.timeInicial||'')).localeCompare(b.dataUtilizacao+' '+(b.timeInicial||''))||String(a.id).localeCompare(String(b.id)))) {
    const vistasNoCheckin=new Set();
    for(const [i,c] of (v.criancas||[]).entries()) {
      const chave=chaveCrianca(c,v.responsavel),antes=chave?historico.get(chave)||{total:0,ultima:null}:{total:0,ultima:null};
      if(chave&&vistasNoCheckin.has(chave)) continue;
      if(chave) vistasNoCheckin.add(chave);
      if(noPeriodo(v.dataUtilizacao,j)) linhas.push({checkinId:v.id,criancaIndice:i,data:v.dataUtilizacao,hora:v.timeInicial||null,
        crianca:nomeProtegido(c.nome),responsavel:nomeProtegido(v.responsavel?.nome),
        minutos:numero(c.tempoMinutos??v.tempoMinutos),saida:c.timeFinal||v.timeFinal||null,
        corPulseira:texto(v.pulseirasInfo?.find(x=>x.criancaIndice===i)?.nome||v.corPulseira?.nome),
        classificacao:!chave?'IDENTIDADE_INSUFICIENTE':antes.total?'RECORRENTE_NA_BASE':'PRIMEIRA_NA_BASE',
        visitasAnteriores:chave?antes.total:null,ultimaVisitaAnterior:antes.ultima,_chave:chave});
      if(chave) historico.set(chave,{total:antes.total+1,ultima:v.dataUtilizacao});
    }
  }
  const porHorario={},porPlano={};
  for(const l of linhas){const h=l.hora?.slice(0,2)||'não informado',plano=l.minutos==null?'não informado':l.minutos+' min';porHorario[h]=(porHorario[h]||0)+1;porPlano[plano]=(porPlano[plano]||0)+1;}
  return {linhas,resumo:{acessos:linhas.length,criancasIdentificadasUnicas:new Set(linhas.map(x=>x._chave).filter(Boolean)).size,
    primeiraNaBase:linhas.filter(x=>x.classificacao==='PRIMEIRA_NA_BASE').length,recorrentesNaBase:linhas.filter(x=>x.classificacao==='RECORRENTE_NA_BASE').length,
    identidadeInsuficiente:linhas.filter(x=>!x._chave).length,porHorario,porPlano}};
}
async function acessosParque(p) {
  const u=await unidade(p.unidade),j=janela(p);paginacao(p);
  const [checkins,futuras,festas]=await Promise.all([require('./parque').listAll(),require('./parqueVendasFuturas').listar(),require('./festas').listAll()]);
  const base=checkins.filter(c=>u.contem(c.unidade)),atual=resumirVisitas(base,j);
  const anterior=resumirVisitas(base,{inicio:diaSP(j.desde-7*86400000),fim:diaSP(j.ate-7*86400000)});
  let totalConhecido=0,registrosSemValor=0;
  const totalizar=v=>{if(numero(v)==null)registrosSemValor++;else totalConhecido+=Number(v);};
  const porForma={},somar=(forma,v)=>{if(numero(v)!=null)porForma[forma||'não informado']=Math.round(((porForma[forma||'não informado']||0)+Number(v))*100)/100;};
  for(const c of base.filter(c=>!c.vendaFuturaId&&noPeriodo(c.dataUtilizacao,j))) {
    totalizar(c.valor); // Mesmo total do fechamento nativo, inclusive legados sem split.
    for(const q of c.pagamentos||[])somar(q.forma,q.valor);
    for(const a of c.acrescimos||[])somar(a.metodoPagamento,a.valor);
  }
  for(const v of futuras.filter(v=>u.contem(v.unidade)&&noPeriodo(v.dataVenda,j))){totalizar(v.valor);somar(v.forma,v.valor);}
  const totalDiscriminado=Math.round(Object.values(porForma).reduce((a,b)=>a+b,0)*100)/100;
  totalConhecido=Math.round(totalConhecido*100)/100;
  const eventos=festas.filter(f=>u.contem(f.unidade)&&noPeriodo(f.dataDeUso,j)).map(f=>({id:f.id,data:f.dataDeUso,hora:f.horaInicio||null,status:f.status,cliente:nomeProtegido(f.cliente?.nome)}));
  return {disponivel:true,unidade:{codigo:u.codigo,nome:u.nome},periodo:{desde:j.inicio,ate:j.fim},
    ...atual.resumo,...paginar(atual.linhas.map(({_chave,...l})=>l),p),
    financeiro:{porForma,total:registrosSemValor?null:totalConhecido,totalConhecido,totalDiscriminado,registrosSemValor,
      diferencaDiscriminacao:registrosSemValor?null:Math.round((totalConhecido-totalDiscriminado)*100)/100,
      cobertura:'Pagamentos registrados do parque; vendas antecipadas pela dataVenda, sem duplicar na visita. Não inclui caixa de festas. Sem pagamento discriminado, valores legados não são reconstruídos.'},
    eventos:paginar(eventos,p),semanaAnterior:{desde:diaSP(j.desde-7*86400000),ate:diaSP(j.ate-7*86400000),...anterior.resumo},
    cobertura:{fonte:'Check-ins nativos e histórico importado retido no NoPulso',primeiroDiaRetido:base.map(c=>c.dataUtilizacao).sort()[0]||null,
      historicoExternoCompleto:false,criterio:'Nome + nascimento + documento/contato do responsável. Mudança de responsável pode separar a identidade. Primeira na base não comprova primeira visita ao parque.'}};
}
async function clienteParque(p) {
  paginacao(p);const u=await unidade(p.unidade);
  const criterios=['documento','telefone','nome'].filter(k=>String(p[k]||'').trim());
  if(criterios.length!==1)throw new Error('Informe exatamente um filtro: documento, telefone ou nome.');
  const dig=v=>String(v||'').replace(/\D/g,'');
  if(p.documento&&dig(p.documento).length<11||p.telefone&&dig(p.telefone).length<10||p.nome&&normalizar(p.nome).length<3)throw new Error('Filtro insuficiente. Use documento/telefone completo ou nome com pelo menos 3 caracteres.');
  const j=p.desde||p.ate?janela(p):null;
  const lista=(await require('./parque').listAll()).filter(v=>u.contem(v.unidade)&&(!j||noPeriodo(v.dataUtilizacao,j)))
    .filter(v=>p.documento?dig(v.responsavel?.cpf)===dig(p.documento):p.telefone?dig(v.responsavel?.contato)===dig(p.telefone):normalizar(v.responsavel?.nome).includes(normalizar(p.nome))||(v.criancas||[]).some(c=>normalizar(c.nome).includes(normalizar(p.nome))))
    .sort((a,b)=>String(b.dataUtilizacao).localeCompare(String(a.dataUtilizacao)))
    .map(v=>({checkinId:v.id,data:v.dataUtilizacao,iniciado:!!v.iniciado,responsavel:nomeProtegido(v.responsavel?.nome),criancas:(v.criancas||[]).slice(0,100).map(c=>({nome:nomeProtegido(c.nome),minutos:numero(c.tempoMinutos??v.tempoMinutos)}))}));
  return {disponivel:true,...paginar(lista,p),cobertura:'Histórico retido. Busca por nome pode incluir homônimos; dados pessoais mascarados.'};
}
async function diagnostico(p) {
  const u=await unidade(p.codigo),m=(await require('./lojaStatus').listar()).find(m=>u.contem(m.codigo)&&m.posto===p.posto);
  if(!m)return indisponivel('Computador não encontrado nessa unidade.');
  // Reaplica a projeção também na leitura de dados persistidos/legados.
  const completo=m.diagnostico?require('./diagnosticoCompleto').extrair('NOC_DIAGNOSTICO_JSON:'+JSON.stringify(m.diagnostico)):null;
  if(completo)completo.recebidoEm=Number.isFinite(Date.parse(m.diagnostico.recebidoEm))?new Date(m.diagnostico.recebidoEm).toISOString():null;
  return {disponivel:true,codigo:m.codigo,posto:m.posto,maquina:texto(m.nome),online:!!m.online,estado:texto(m.estado),
    ultimoContato:m.ultimoHeartbeatEm||null,versaoAgente:m.agenteVersao||null,
    hardwareMedidoEm:m.hardwareMedidoEm||null,ramMedidaEm:m.ramMedidaEm||null,
    processador:m.hardware?.processador?{nome:texto(m.hardware.processador.nome),nucleos:numero(m.hardware.processador.nucleos),threads:numero(m.hardware.processador.threads)}:null,
    ram:m.ram?{totalGb:numero(m.ram.totalGb),livreGb:numero(m.ram.livreGb),nivel:texto(m.ramNivel)}:null,
    memoria:(m.hardware?.memoria||[]).slice(0,16).map(x=>({capacidadeGb:numero(x.capacidadeGb),frequenciaMhz:numero(x.frequenciaMhz),tipo:texto(x.tipo)})),
    discos:(m.disco?.discos||[]).slice(0,16).map(x=>({modelo:texto(x.modelo),tipo:texto(x.tipo),saude:texto(x.saude),temperaturaC:numero(x.temperaturaC),desgastePct:numero(x.desgastePct)})),
    volumes:(m.disco?.volumes||[]).slice(0,16).map(x=>({letra:texto(x.letra),totalGb:numero(x.totalGb),livreGb:numero(x.livreGb),livrePct:numero(x.livrePct)})),
    alertas:[...(m.degradacao||[]),...(m.ramMotivos||[]),...(m.discoMotivos||[])].slice(0,20).map(texto),
    diagnosticoCompleto:completo?{disponivel:true,...completo,
      relatorioCompleto:JSON.stringify(completo,null,2),
      cobertura:'Resumo estruturado e mascarado da última coleta. Relatório local em C:\\Diagnostico. Eventos limitados à amostra de 200; fontes não disponíveis listadas.'}
      :indisponivel('Nenhuma coleta completa recebida. Use executar_noc com tarefa diagnostico-completo, mediante aprovação do Master.'),
    cobertura:'Estado e alertas da telemetria já recebida. Não é uma inspeção completa nem em tempo real.'};
}
async function resumo(p) {
  const u=await unidade(p.unidade),j=janela(p),params={unidade:u.codigo,data:j.inicio,desde:j.inicio,ate:j.fim,limite:20};
  const seguro=async fn=>{try{return await fn();}catch{return indisponivel('Fonte não respondeu. Não interpretar como zero; consultar novamente.');}};
  const [fechamento,ifood,monitor,noc,perfil]=await Promise.all([
    seguro(()=>fechamentos(params,true)),seguro(()=>require('./pedidosAgregadorCowork').buscar({...params,canal:'IFOOD'})),
    seguro(()=>require('./pedidosMonitor').buscar(params)),seguro(async()=>({disponivel:true,...paginar((await require('./lojaStatus').listarResumo()).filter(m=>u.contem(m.codigo)).map(m=>({codigo:m.codigo,posto:m.posto,nome:texto(m.nome),online:!!m.online,estado:texto(m.estado),ultimoContato:m.ultimoHeartbeatEm||null})),{limite:100})})),
    require('./unidades').perfil(u.codigo),
  ]);
  return {unidade:{codigo:u.codigo,nome:u.nome},data:j.inicio,fechamento,ifood,monitor,noc,
    parque:perfil?.marca==='saltiverso'?await seguro(()=>acessosParque(params)):indisponivel('Não aplicável: unidade sem marca Saltiverso cadastrada.'),
    anyfood:indisponivel('Integração adiada pelo Master; aguarda definição da fonte.'),pulse:indisponivel('Integração adiada pelo Master; aguarda exportação/fonte.'),
    cobertura:'Fontes independentes, com limites e horários próprios. Não somar vendas entre fontes: podem representar o mesmo recebimento.'};
}
async function executar(nome,p) {
  if(nome==='obter_fechamento')return fechamentos({...p,desde:undefined,ate:undefined},true);
  if(nome==='listar_fechamentos')return fechamentos(p);
  if(nome==='consultar_acessos_parque')return acessosParque(p);
  if(nome==='obter_cliente_parque')return clienteParque(p);
  if(nome==='obter_diagnostico')return diagnostico(p);
  if(nome==='resumo_unidade')return resumo(p);
  throw new Error('Consulta não implementada.');
}
module.exports={ferramentas,parametros,propriedades,configurar,executar,paginar,janela,projetarFechamento,resumirVisitas};
