// Treinamentos: catálogo versionado + aplicação por unidade + link individual.
// O link permite estudar sem usuário/senha; a conclusão grava a assinatura,
// data/hora e a versão exata do material que a pessoa recebeu.
const crypto = require('crypto');
const db = require('./firestore');
const { createCache } = require('./liveCache');

const CATALOG0 = db.collection('treinamentos');
const VERSOES = db.collection('treinamentoVersoes');
const APLICACOES = db.collection('treinamentoAplicacoes');
const LINKS = db.collection('treinamentoLinks');
const MAX_ASSINATURA = 300000;
const STATUS = ['RASCUNHO', 'PUBLICADO', 'ARQUIVADO'];

function id() { return crypto.randomBytes(12).toString('hex'); }
function texto(v, n = 3000) { return String(v || '').trim().slice(0, n); }
function agora() { return new Date().toISOString(); }
function hash(token) { return crypto.createHash('sha256').update(String(token)).digest('hex'); }
function linkNovo() { return crypto.randomBytes(32).toString('base64url'); }
function expirou(prazo) {
  if (!prazo) return false;
  // Campo date não traz horário; para uma loja brasileira, vence no FIM do
  // dia local, e não às 21h da véspera por interpretação UTC do JavaScript.
  const valor = /^\d{4}-\d{2}-\d{2}$/.test(String(prazo)) ? `${prazo}T23:59:59-03:00` : prazo;
  return new Date(valor).getTime() < Date.now();
}
function normalizarMateriais(materiais) {
  return (Array.isArray(materiais) ? materiais : []).map((m) => ({
    id: texto(m.id, 80) || id(), nome: texto(m.nome, 180), tipo: texto(m.tipo, 80) || 'arquivo',
    path: texto(m.path, 600), mime: texto(m.mime, 120) || null, criadoEm: m.criadoEm || agora(),
  })).filter((m) => m.nome && m.path).slice(0, 40);
}
function retrato(curso) {
  return {
    id: curso.id, nome: curso.nome, franquia: curso.franquia, setor: curso.setor,
    descricao: curso.descricao || null, criticidade: curso.criticidade || 'normal',
    versao: curso.versao, materiais: curso.materiais || [], publicadoEm: curso.publicadoEm || null,
  };
}
function publico(snapshot) {
  return { ...snapshot, materiais: (snapshot.materiais || []).map((m) => ({ id: m.id, nome: m.nome, tipo: m.tipo, mime: m.mime })) };
}

async function salvarCurso(payload, porEmail) {
  const existente = payload.id ? await CATALOG0.doc(String(payload.id)).get() : null;
  if (existente && !existente.exists) throw new Error('Treinamento não encontrado.');
  const anterior = existente && existente.exists ? existente.data() : null;
  const nome = texto(payload.nome === undefined ? anterior?.nome : payload.nome, 180);
  const franquia = texto(payload.franquia === undefined ? anterior?.franquia : payload.franquia, 120);
  const setor = texto(payload.setor === undefined ? anterior?.setor : payload.setor, 120);
  if (!nome || !franquia || !setor) throw new Error('Informe nome, franquia e setor do treinamento.');
  const registro = {
    id: anterior?.id || id(), nome, franquia, setor, descricao: texto(payload.descricao === undefined ? anterior?.descricao : payload.descricao, 4000) || null,
    criticidade: ['normal', 'obrigatorio', 'critico'].includes(payload.criticidade) ? payload.criticidade : (anterior?.criticidade || 'normal'),
    status: STATUS.includes(payload.status) ? payload.status : (anterior?.status || 'RASCUNHO'),
    materiais: normalizarMateriais(Array.isArray(payload.materiais) ? payload.materiais : anterior?.materiais),
    versao: Number(anterior?.versao || 0) + 1, criadoEm: anterior?.criadoEm || agora(), criadoPorEmail: anterior?.criadoPorEmail || porEmail || null,
    atualizadoEm: agora(), atualizadoPorEmail: porEmail || null,
  };
  if (registro.status === 'PUBLICADO' && !registro.materiais.length) throw new Error('Anexe ao menos um material antes de publicar.');
  registro.publicadoEm = registro.status === 'PUBLICADO' ? (anterior?.publicadoEm || agora()) : null;
  await CATALOG0.doc(registro.id).set(registro);
  await VERSOES.doc(`${registro.id}-v${registro.versao}`).set({ ...retrato(registro), criadoEm: agora(), criadoPorEmail: porEmail || null });
  cacheCursos.invalidar(); return registro;
}
async function adicionarMaterial(idCurso, material, porEmail) {
  const s = await CATALOG0.doc(String(idCurso)).get(); if (!s.exists) throw new Error('Treinamento não encontrado.');
  const c = s.data();
  return salvarCurso({ ...c, materiais: [...(c.materiais || []), material], status: c.status }, porEmail);
}
async function listarCursosUncached() {
  const s = await CATALOG0.orderBy('atualizadoEm', 'desc').limit(300).get();
  return s.docs.map((d) => { const c = d.data(); return { id:c.id,nome:c.nome,franquia:c.franquia,setor:c.setor,criticidade:c.criticidade,status:c.status,versao:c.versao,materiais:(c.materiais||[]).length,atualizadoEm:c.atualizadoEm }; });
}
const cacheCursos = createCache(listarCursosUncached, 20 * 1000);
async function listarCursos() { return cacheCursos.cached(); }
async function obterCurso(idCurso) { const s=await CATALOG0.doc(String(idCurso)).get(); if(!s.exists) throw new Error('Treinamento não encontrado.'); return s.data(); }

async function criarAplicacao({ treinamentoId, unidade, unidadeNome, instrutor, prazo, participantes }, porEmail, baseUrl) {
  const curso = await obterCurso(treinamentoId); if (curso.status !== 'PUBLICADO') throw new Error('Só treinamento publicado pode ser aplicado.');
  const pessoas = (Array.isArray(participantes)?participantes:[]).map((p)=>({ nome:texto(p.nome,160), contato:texto(p.contato,160) })).filter((p)=>p.nome).slice(0,200);
  if (!unidade || !pessoas.length) throw new Error('Informe unidade e ao menos um participante.');
  const aplicacao = { id:id(), treinamento:retrato(curso), unidade:texto(unidade,120), unidadeNome:texto(unidadeNome,180)||null,
    instrutor:texto(instrutor,160)||null, prazo:texto(prazo,20)||null, status:'ABERTA', criadoEm:agora(), criadoPorEmail:porEmail||null, participantes:pessoas.map((p)=>({id:id(),nome:p.nome,contato:p.contato,status:'PENDENTE'})) };
  await APLICACOES.doc(aplicacao.id).set(aplicacao);
  const convites=[];
  for (const p of aplicacao.participantes) {
    const token=linkNovo(); const tokenHash=hash(token);
    await LINKS.doc(tokenHash).set({ tokenHash, aplicacaoId:aplicacao.id, participanteId:p.id, criadoEm:agora(), expiraEm:aplicacao.prazo||null, abertoEm:null, concluidoEm:null, revogadoEm:null });
    convites.push({ participanteId:p.id,nome:p.nome,contato:p.contato,link:`${String(baseUrl||'').replace(/\/$/,'')}/treinamento-publico?token=${encodeURIComponent(token)}` });
  }
  return { aplicacao, convites };
}
async function listarAplicacoes(unidades) {
  const s=await APLICACOES.orderBy('criadoEm','desc').limit(200).get(); const filtro=unidades?new Set(unidades):null;
  return s.docs.map((d)=>d.data()).filter((a)=>!filtro||filtro.has(a.unidade)).map((a)=>({id:a.id,unidade:a.unidade,unidadeNome:a.unidadeNome,treinamento:a.treinamento,nome:a.treinamento.nome,status:a.status,prazo:a.prazo,criadoEm:a.criadoEm,participantes:(a.participantes||[]).map((p)=>({nome:p.nome,status:p.status,concluidoEm:p.concluidoEm||null}))}));
}
async function acessoPorToken(token) {
  const s=await LINKS.doc(hash(token)).get(); if(!s.exists) throw new Error('Link inválido.'); const link=s.data();
  if(link.revogadoEm) throw new Error('Este link foi revogado.'); if(expirou(link.expiraEm)) throw new Error('Este link expirou.');
  const a=await APLICACOES.doc(link.aplicacaoId).get(); if(!a.exists) throw new Error('Aplicação não encontrada.'); const aplicacao=a.data(); const participante=(aplicacao.participantes||[]).find((p)=>p.id===link.participanteId);
  if(!participante) throw new Error('Participante não encontrado.'); return { link, aplicacao, participante };
}
async function abrirLink(token) { const acesso=await acessoPorToken(token); if(!acesso.link.abertoEm) await LINKS.doc(hash(token)).set({abertoEm:agora()},{merge:true}); return { aplicacaoId:acesso.aplicacao.id, unidadeNome:acesso.aplicacao.unidadeNome, participante:{nome:acesso.participante.nome,status:acesso.participante.status}, treinamento:publico(acesso.aplicacao.treinamento) }; }
async function concluirPorLink(token,{ aceite, assinatura, nomeConfirmado, ip, userAgent }) {
  const acesso=await acessoPorToken(token); if(acesso.participante.status==='CONCLUIDO') return {ok:true, jaConcluido:true};
  if(aceite!==true) throw new Error('Confirme que participou e compreendeu o treinamento.');
  const img=String(assinatura||''); if(!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(img)||img.length>MAX_ASSINATURA) throw new Error('Assinatura digital inválida.');
  if(texto(nomeConfirmado,160).toLowerCase()!==String(acesso.participante.nome).toLowerCase()) throw new Error('Confirme o nome exatamente como está no convite.');
  const em=agora(); const participantes=acesso.aplicacao.participantes.map((p)=>p.id===acesso.participante.id?{...p,status:'CONCLUIDO',concluidoEm:em,assinatura:{imagem:img,nome:p.nome,metodo:'link-individual',assinadoEm:em,ip:texto(ip,80)||null,userAgent:texto(userAgent,300)||null},versao:acesso.aplicacao.treinamento.versao}:p);
  await APLICACOES.doc(acesso.aplicacao.id).set({participantes},{merge:true}); await LINKS.doc(hash(token)).set({concluidoEm:em},{merge:true});
  return {ok:true,nome:acesso.participante.nome,treinamento:acesso.aplicacao.treinamento.nome,versao:acesso.aplicacao.treinamento.versao,concluidoEm:em};
}
async function materialPorLink(token, materialId) { const acesso=await acessoPorToken(token); const m=(acesso.aplicacao.treinamento.materiais||[]).find((x)=>x.id===materialId); if(!m) throw new Error('Material não encontrado.'); return m; }
module.exports={salvarCurso,adicionarMaterial,listarCursos,obterCurso,criarAplicacao,listarAplicacoes,abrirLink,concluirPorLink,materialPorLink,MAX_ASSINATURA};
