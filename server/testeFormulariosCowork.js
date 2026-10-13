'use strict';
// Reproduz os dois incidentes com API real, Firestore/Storage locais e sem produção.
const assert = require('node:assert/strict');
async function testar({ DOCS, fakeDb, port }) {
  const cw=require('./coworkApi'), fm=require('./formularios'), fu=require('./formulariosUnidades');
  process.env.APP_BASE_URL=`http://127.0.0.1:${port}`;
  process.env.NOPULSO_AGENT_MASTER=process.env.MASTER_EMAIL;
  // Commits diferidos e serializados: leituras após escritas são erro real no Firestore.
  let fila=Promise.resolve();
  fakeDb.runTransaction=fn=>{const p=fila.then(async()=>{const ops=[];const r=await fn({get:async ref=>{assert.equal(ops.length,0,'ler antes de escrever');const s=await ref.get();return {...s,data:()=>structuredClone(s.data())};},set:(ref,d)=>ops.push(()=>ref.set(d)),update:(ref,d)=>ops.push(()=>ref.update(d))});for(const op of ops)await op();return r;});fila=p.catch(()=>{});return p;};
  await fu.criar({unidade:'Loja Formulários A',razaoSocial:'Loja A',cnpj:'11.222.333/0001-81'},'teste');
  await fu.criar({unidade:'Loja Formulários B',razaoSocial:'Loja B',cnpj:'11.222.333/0001-81'},'teste');
  const unidade='Loja Formulários A'; let seq=0;
  const chamar=async(nome,entrada,chave)=> (await cw.executar({nome,entrada,idempotencyKey:chave||'form-novo-'+(++seq)})).resultado;
  const forms=()=>[...DOCS.entries()].filter(([k])=>k.startsWith('formularios/'));
  DOCS.set('suporteChats/chat-12493',{id:'chat-12493',numeroTicket:12493,nome:'Ivanildo',status:'ABERTO',unidadeContexto:unidade,mensagens:[],notasInternas:[]});
  DOCS.set('suporteChats/chat-antigo',{id:'chat-antigo',numeroTicket:12379,nome:'Julia',status:'ABERTO',unidadeContexto:unidade,mensagens:[],notasInternas:[]});
  const antigo=await fm.criarParaPreenchimento({tipo:'reembolso',unidade,criadoPorId:(await require('./users').list()).find(u=>u.role==='master').id});
  const antes=JSON.stringify(await fm.getOne(antigo.id));
  const entrada={tipo:'reembolso',unidade,modo:'link',origem:{tipo:'chat',numero:12493},campos:{favorecido:'PAULO ROBERTO'},linhas:[{data:'11/10/2026',fornecedor:'Loja',descricao:'Reembolso',valor:127}]};
  const a=await chamar('criar_formulario',entrada,'caso-a');
  assert.notEqual(a.formularioId,antigo.id); assert.equal(a.valorTotal,127);assert.equal(a.campos.favorecido,'PAULO ROBERTO');assert(a.linkPreenchimento);assert.equal(a.linkValidado,true);
  assert.equal(JSON.stringify(await fm.getOne(antigo.id)),antes,'formulário da outra pessoa intacto');
  const quant=forms().length;
  const repetido=await chamar('criar_formulario',entrada,'caso-a');assert.equal(repetido.formularioId,a.formularioId);assert.equal(forms().length,quant);
  await assert.rejects(chamar('criar_formulario',{...entrada,campos:{favorecido:'OUTRA PESSOA'}},'caso-a'),/outra intenção/);
  const distinto=await chamar('criar_formulario',{...entrada,campos:{favorecido:'OUTRA PESSOA'}});assert.notEqual(distinto.formularioId,a.formularioId);
  const consulta=await chamar('consultar_ticket',{numero:'12493'});assert(consulta.formularios.some(f=>f.formularioId===a.formularioId));
  const chat=await require('./suporteChat').getOne('chat-12493');assert(chat.notasInternas.some(n=>n.resumo.includes('#'+a.ticket)));assert.equal(chat.mensagens.length,0,'nota nunca vai para o visitante');
  const l=await chamar('gerar_link_formulario',{numero:String(a.ticket)});assert.equal(l.token,a.token);assert.equal(forms().length,quant+1);
  const rotacao=await chamar('gerar_link_formulario',{formularioId:a.formularioId,regenerar:true},'rotacionar');assert.notEqual(rotacao.token,a.token);
  assert.equal((await fetch(`${process.env.APP_BASE_URL}/api/formularios-publico/preencher/${a.token}`)).status,404);
  const fresco=await chamar('criar_formulario',entrada,'caso-a');assert.equal(fresco.token,rotacao.token,'repetição nunca devolve token revogado');
  const vista=await fm.vistaPreenchimento(rotacao.token);assert.equal(vista.campos.favorecido,'PAULO ROBERTO');assert.equal(vista.linhas[0].valor,127);
  await assert.rejects(fm.salvarPreenchimento(rotacao.token,{campos:{favorecido:'TROCA'}}),/preservados/);
  await assert.rejects(fm.salvarPreenchimento(rotacao.token,{linhas:[{data:'11/10/2026',fornecedor:'Loja',descricao:'Reembolso',valor:999}]}),/não podem/);
  const salvo=await fm.salvarPreenchimento(rotacao.token,{campos:{favorecido:'',cpf:'529.982.247-25',banco:'Banco',agencia:'1',conta:'2',chavePix:'teste@local'},linhas:[]});
  const cheio=await fm.getOne(a.formularioId);assert.equal(cheio.campos.favorecido,'PAULO ROBERTO');assert.equal(cheio.valorTotal,127);assert.equal(cheio.status,'PENDENTE');assert.equal(salvo.meuPapel,'favorecido');
  await assert.rejects(chamar('gerar_link_formulario',{formularioId:a.formularioId}),/PENDENTE/);

  // O segundo caso: rascunho já lançado -> link, sem outro número.
  const b=await chamar('criar_formulario',{tipo:'avulso',unidade,campos:{favorecido:'iSolutions'},linhas:[{data:'12/10/2026',descricao:'Serviço',valor:90}]});
  const qtd=forms().length;
  const links=await Promise.all([chamar('gerar_link_formulario',{formularioId:b.formularioId}),chamar('gerar_link_formulario',{formularioId:b.formularioId})]);
  assert.equal(links[0].token,links[1].token);assert.equal(forms().length,qtd);assert.equal(links[0].valorTotal,90);
  await chamar('cancelar_formulario',{numero:String(b.ticket),motivo:'Duplicado de teste'});
  assert.equal((await fm.getOne(b.formularioId)).valorTotal,90);assert.equal((await fm.getOne(b.formularioId)).status,'CANCELADO');assert.equal(await fm.vistaPreenchimento(links[0].token),null);
  const boleto={nome:'boleto antigo.pdf',path:'teste/boleto',tipo:'application/pdf'};
  DOCS.set('solicitacoes/pag-12123',{id:'pag-12123',numeroTicket:12123,tipo:'pagamento',status:'APROVADO',execucaoStatus:'PENDENTE',unidade,criadoPorEmail:'anderson@local',criadoEm:'2026-10-11T15:00:00Z',titulo:'iSolutions',valorEstimado:90,anexos:[boleto]});
  const pix=await chamar('criar_formulario',{tipo:'avulso',numero:'12123',modo:'link'});
  assert.equal(pix.valorTotal,90);assert.equal(pix.origem.id,'pag-12123');assert.equal(pix.campos.favorecido,'anderson@local');assert.equal(pix.anexos[0],boleto.nome);
  assert.equal(DOCS.get('solicitacoes/pag-12123').formaPagamento,'pix');
  const resposta=await fetch(`${process.env.APP_BASE_URL}/api/formularios-publico/preencher/${pix.token}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({campos:{favorecido:'',banco:'Banco',agencia:'1',conta:'2',chavePix:'favorecido@local'},linhas:[]})});
  assert.equal(resposta.status,200);const preenchido=await resposta.json();
  const imagem='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1sAAAAASUVORK5CYII=';
  assert.equal((await fetch(`${process.env.APP_BASE_URL}/api/formularios-publico/${pix.formularioId}/assinar`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:preenchido.meuToken,nome:'Anderson',imagem})})).status,200);
  assert([...DOCS.values()].some(v=>v.cardKey==='pagamento:pag-12123'&&v.texto?.includes('assinatura')));
  assert.equal(DOCS.get('solicitacoes/pag-12123').execucaoStatus,'PENDENTE');
  const pedido=await cw.executar({nome:'pedir_assinatura',entrada:{formularioId:pix.formularioId},idempotencyKey:'assinar-pix'});assert(pedido.pendente);
  const storage=require('./storage'), upload=storage.salvarArquivo;let falhar=true;
  storage.salvarArquivo=async(...args)=>{if(falhar)throw new Error('Storage indisponível no teste');return upload(...args);};
  try{
    await fm.assinarEletronicamente(pix.formularioId,{papel:'gerente',nome:'Master',metodo:'senha',autorizacaoId:pedido.autorizacaoId});
    assert.equal((await fm.getOne(pix.formularioId)).status,'ASSINADO');assert.equal((await fm.getOne(pix.formularioId)).origemSincronizacaoPendente,true);
    falhar=false;
    await chamar('obter_formulario',{formularioId:pix.formularioId});
  }finally{storage.salvarArquivo=upload;}
  const final=await fm.getOne(pix.formularioId);assert.equal(final.origemSincronizacaoPendente,false);assert(final.origemPdf?.path);
  assert.equal(final.enviadoPagamento.pagamentoId,'pag-12123','reutiliza o pagamento, não cria uma segunda cobrança');
  const pag=DOCS.get('solicitacoes/pag-12123');assert.equal(pag.execucaoStatus,'EM_ANDAMENTO');assert.equal(pag.anexos[0].path,boleto.path);assert(pag.anexos.some(a=>a.formularioId===pix.formularioId));
  const notas=()=>[...DOCS.values()].filter(v=>v.cardKey==='pagamento:pag-12123').length;
  const n=notas();await chamar('obter_formulario',{formularioId:pix.formularioId});assert.equal(notas(),n,'notas e PDF idempotentes');
  await chamar('registrar_envio_conecta',{formularioId:pix.formularioId,protocolo:'C-12123'});assert.equal(DOCS.get('solicitacoes/pag-12123').formulariosConecta[pix.formularioId].protocolo,'C-12123');
  assert.equal(DOCS.get('solicitacoes/pag-12123').execucaoStatus,'EM_ANDAMENTO','Conecta não é comprovação de pagamento');
  await assert.rejects(chamar('gerar_link_formulario',{formularioId:pix.formularioId}),/ASSINADO/);
  await assert.rejects(chamar('cancelar_formulario',{formularioId:pix.formularioId,motivo:'Teste'}),/Só rascunhos/);
  await assert.rejects(chamar('criar_formulario',{...entrada,unidade:'Loja Formulários B'}),/mesma/);
  await assert.rejects(chamar('vincular_formulario',{formularioId:a.formularioId,origem:{tipo:'chat',numero:12379}}),/outro atendimento/);
  // Indisponibilidade pública não perde o ID e não orienta criar duplicado.
  const realFetch=global.fetch;let falha;
  try{global.fetch=async()=>new Response('offline',{status:503});falha=await chamar('criar_formulario',{tipo:'avulso',unidade,modo:'link',campos:{favorecido:'Teste'}});assert.equal(falha.linkValidado,false);assert(falha.formularioId);assert.equal(falha.linkPreenchimento,null);}finally{global.fetch=realFetch;}
  const recuperar=await chamar('gerar_link_formulario',{formularioId:falha.formularioId});assert(recuperar.linkValidado);assert.equal(recuperar.formularioId,falha.formularioId);
  // PDF interno só para a equipe e só dentro do chat ao qual pertence.
  await fm.assinar(a.formularioId,salvo.meuToken,{nome:'Paulo',imagem});
  const pa=await cw.executar({nome:'pedir_assinatura',entrada:{formularioId:a.formularioId},idempotencyKey:'assinar-chat'});
  await fm.assinarEletronicamente(a.formularioId,{papel:'responsavel',nome:'Master',metodo:'senha',autorizacaoId:pa.autorizacaoId});
  assert.equal((await fm.getOne(a.formularioId)).status,'ASSINADO');
  const url=`${process.env.APP_BASE_URL}/api/suporte-chats/chat-12493/formularios/${a.formularioId}/pdf`;
  assert.equal((await fetch(url)).status,401);
  const jwt=require('jsonwebtoken');
  for(const [cargo,status] of [['suporte',200],['operador',403]]){
    const id='form-pdf-'+cargo;DOCS.set('users/'+id,{id,role:'user',active:true,cargo,cargos:[cargo],permissions:{sections:[],unidades:[]}});
    const headers={Authorization:'Bearer '+jwt.sign({sub:id,role:'user'},process.env.JWT_SECRET)};
    const pdf=await fetch(url,{headers});assert.equal(pdf.status,status);
    if(status===200){assert((await pdf.text()).startsWith('%PDF'));assert.equal((await fetch(url.replace('chat-12493','chat-antigo'),{headers})).status,404);}
  }
  // Estorno pode ter atendimento adicional sem perder a referência aprovada.
  DOCS.set('refundRequests/estorno-form',{id:'estorno-form',numeroTicket:12300,status:'APROVADO',unidade});
  const legado=await fm.criar({tipo:'avulso',unidade,campos:{favorecido:'Estorno'},linhas:[{data:'12/10/2026',descricao:'Teste',valor:10}],origem:{tipo:'estorno',id:'estorno-form',numero:12300}});
  await chamar('vincular_formulario',{formularioId:legado.id,origem:{tipo:'chat',numero:12493}});
  const vinculado=await fm.getOne(legado.id);assert.equal(vinculado.origem.tipo,'estorno');assert.equal(vinculado.origemAtendimento.id,'chat-12493');
  assert((await chamar('consultar_ticket',{numero:'12493'})).formularios.some(f=>f.formularioId===legado.id));
  DOCS.set('tarefas/tarefa-form',{id:'tarefa-form',numeroTicket:12494,unidade,comentarios:[]});
  const tf=await chamar('criar_formulario',{...entrada,origem:{tipo:'tarefa',numero:12494}});
  assert(DOCS.get('tarefas/tarefa-form').comentarios.some(c=>c.texto.includes('#'+tf.ticket)));
  const boletoRascunho=await chamar('criar_formulario',{tipo:'assBoleto',unidade,modo:'link',campos:{},linhas:[]});
  assert((await chamar('gerar_link_formulario',{formularioId:boletoRascunho.formularioId})).linkValidado);
  await fm.cancelarPreenchimento(boletoRascunho.formularioId);
  assert.equal((await fm.getOne(boletoRascunho.formularioId)).status,'CANCELADO','tela antiga preserva novo lançamento');
  DOCS.set('refundRequests/estorno-real-modelo',{id:'estorno-real-modelo',numeroTicket:12301,status:'APROVADO',unidade,valorEstornar:10,nomeCliente:'Teste',dataVenda:'2026-10-12'});
  require('./refunds').invalidar();
  const est=await chamar('criar_formulario',{tipo:'estorno',numero:'12301',unidade,origem:{tipo:'chat',numero:12493}});
  assert.equal(est.origem.tipo,'estorno');assert.equal(est.origemAtendimento.id,'chat-12493');
  console.log('✓ Formulários Cowork: casos A/B, campos, links concorrentes, rotação, cancelamento, origem/unidade, assinatura pública/Master, PDF, retry Storage, Conecta e financeiro sem baixa indevida.');
}
module.exports={testar};
if(require.main===module){
  process.env.JWT_SECRET='teste-formularios-cowork';process.env.ENCRYPTION_KEY='11'.repeat(32);
  const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),Module=require('node:module');
  if(process.argv.includes('--sabotagem')){const original=Module._extensions['.js'];Module._extensions['.js']=(m,file)=>{if(file!==path.join(__dirname,'coworkApi.js'))return original(m,file);const src=fs.readFileSync(file,'utf8');assert(src.includes('sempreNovo: true'));m._compile(src.replace('sempreNovo: true','sempreNovo: false'),file);};}
  const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>{const file=path.join(__dirname,'testeRotas.js'),src=fs.readFileSync(file,'utf8').split('setTimeout(async () => {')[0].replace(/\b8899\b/g,String(port));const m=new Module(file,module);m.filename=file;m.paths=module.paths;m._compile(src+`\nsetTimeout(()=>require('./testeFormulariosCowork').testar({DOCS,fakeDb,port:${port}}).then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)}),2500);`,file);});});
}
