// migracaoUnidades.js
// Migração pontual (decisão do Master, 2026-08-18): a mesma loja física tem
// hoje DOIS códigos - um no espaço de Fechamento ("Dominos Bessa") e outro
// no espaço de Entregas ("Bessa"), ver comentário de UNIDADES_APELIDOS em
// index.js. Isso fazia a loja aparecer como 2 cadastros separados no painel
// de Unidades. Decisão: unificar usando o código de FECHAMENTO como
// principal (é o dado mais importante do sistema) - o código de Entregas
// morre, tudo que usava ele passa a usar o código de Fechamento.
//
// Só cobre as 3 lojas que hoje têm os dois espaços de código ao mesmo tempo
// (ver ENTREGAS_UNIDADES_NOMES/FECHAMENTO_UNIDADES_NOMES em index.js) -
// Bessa/Caruaru/Garanhuns. MMTirol Natal não tem código de Fechamento
// (unidade só de Entregas) e continua como está.
const db = require('./firestore');
const store = require('./store');
const entregasLive = require('./entregasLive');
const entregasRegras = require('./entregasRegras');
const fraudMarks = require('./fraudMarks');
const disputes = require('./disputes');
const refunds = require('./refunds');
const users = require('./users');

const MAPA_CODIGO_ENTREGAS_PARA_FECHAMENTO = {
  Bessa: 'Dominos Bessa',
  Caruaru: 'Dominos Caruaru',
  Garanhuns: 'Dominos Garanhuns',
};

// segunda migração (mesma decisão do Master, mesmo dia): o espaço de
// Monitor/Disputas (merchantAccountCode que a Adyen manda em cada
// transação/webhook - formato fora do nosso controle) também duplicava
// cadastro com o de Fechamento pra loja que tem os dois. Mais arriscado que
// a migração de Entregas (dado financeiro/fraude, não só operacional) -
// cobre as 9 unidades ARCFOOD/GBE que hoje tem os dois códigos (inclui
// DOM19940/Dominos Tirol, achado nesta revisão - já usada em produção, ver
// fechamentos.html UNIDADES_IDPULSE, mas faltava no GBE_MONITOR/index.js)
const MAPA_CODIGO_MONITOR_PARA_FECHAMENTO = {
  Mooca: '19888', DOM___19888: '19888',
  Tatuape: '19889', DOM_19889: '19889',
  'Sao Miguel': '19821', DOM__19821: '19821',
  Carrao: '19855', DOM__19855: '19855',
  DOM_19798: 'Dominos Caruaru',
  DOM19911: 'Dominos Garanhuns',
  DOM_19706: 'Dominos Bessa',
  DOM_19633: 'Dominos Campina Grande',
  DOM19940: 'Dominos Tirol',
};

// mapa combinado, pra normalizar QUALQUER codigo bruto que chegue na
// ingestao (webhook Adyen, planilha de Entregas) direto pro codigo
// unificado - usado por normalize.js/reportImport.js pra toda transacao
// NOVA já nascer com o código certo, sem depender de rodar a migração de
// novo a cada nova transação antiga reaparecendo
const MAPA_CODIGO_UNIFICADO = { ...MAPA_CODIGO_ENTREGAS_PARA_FECHAMENTO, ...MAPA_CODIGO_MONITOR_PARA_FECHAMENTO };
function normalizarCodigoUnidade(bruto) {
  return MAPA_CODIGO_UNIFICADO[bruto] || bruto;
}

// migra permissions.unidades de todo usuario afetado, num UNICO passe sobre
// o mapa inteiro (nao um passe por codigo antigo) - importante quando o
// mesmo usuario (ex: um Admin regional) tem permissao pra MAIS de um codigo
// antigo do mesmo mapa ao mesmo tempo: migrar um passe de cada vez, cada um
// relendo a mesma lista `todosUsuarios` já desatualizada, faria a segunda
// gravação sobrescrever e desfazer a mudança da primeira (bug encontrado
// nesta revisão, corrigido antes de ir pra produção)
async function migrarPermissoesUsuarios(todosUsuarios, mapaAntigoParaNovo, { executar = false } = {}) {
  const afetados = todosUsuarios.filter((u) => (u.permissions?.unidades || []).some((c) => c in mapaAntigoParaNovo));
  if (executar) {
    await Promise.all(afetados.map((u) => {
      const unidades = [...new Set(u.permissions.unidades.map((c) => mapaAntigoParaNovo[c] || c))];
      return users.updatePermissions(u.id, { ...u.permissions, unidades });
    }));
  }
  return afetados;
}

// executar:false (padrão) = so CONTA o que seria mudado, sem gravar nada -
// pra o Master ver o tamanho do impacto antes de rodar de verdade
async function migrarCodigosEntregas({ executar = false } = {}) {
  const todosUsuarios = await users.list();
  const resumo = [];

  for (const [antigo, novo] of Object.entries(MAPA_CODIGO_ENTREGAS_PARA_FECHAMENTO)) {
    const item = { antigo, novo, entregasLive: 0, entregaEdicoes: 0, entregasRegras: false, usuarios: 0 };

    // atualiza pelo ID (via .doc(id), nao pelo .ref do resultado da query) -
    // o jeito seguro de fazer update em lote depois de um where()
    const liveSnap = await db.collection('entregasLive').where('unidade', '==', antigo).get();
    item.entregasLive = liveSnap.size;
    if (executar) {
      await Promise.all(liveSnap.docs.map((doc) => db.collection('entregasLive').doc(doc.id).update({ unidade: novo })));
    }

    const edicoesSnap = await db.collection('entregaEdicoes').where('unidade', '==', antigo).get();
    item.entregaEdicoes = edicoesSnap.size;
    if (executar) {
      await Promise.all(edicoesSnap.docs.map((doc) => db.collection('entregaEdicoes').doc(doc.id).update({ unidade: novo })));
    }

    // doc ID desta coleção E o proprio codigo - precisa reler sob o novo id,
    // nao so trocar um campo
    const regraAntiga = await db.collection('entregasRegras').doc(antigo).get();
    if (regraAntiga.exists) {
      item.entregasRegras = true;
      if (executar) {
        const novaRef = db.collection('entregasRegras').doc(novo);
        const novaJaExiste = (await novaRef.get()).exists;
        if (!novaJaExiste) await novaRef.set({ ...regraAntiga.data(), unidade: novo });
        await db.collection('entregasRegras').doc(antigo).delete();
      }
    }

    item.usuarios = todosUsuarios.filter((u) => (u.permissions?.unidades || []).includes(antigo)).length;
    resumo.push(item);
  }

  await migrarPermissoesUsuarios(todosUsuarios, MAPA_CODIGO_ENTREGAS_PARA_FECHAMENTO, { executar });

  if (executar) {
    entregasLive.invalidar();
    entregasRegras.invalidar();
  }
  return resumo;
}

// migração do espaço Monitor/Disputas (Adyen) - ver comentário de
// MAPA_CODIGO_MONITOR_PARA_FECHAMENTO acima. Cobre: transações (via
// store.renomearUnidades, que também atualiza o cache em memória e o
// snapshot do Storage), marcações de fraude, disputas/chargebacks
// acompanhados, solicitações de estorno e permissões de usuário.
async function migrarCodigosMonitor({ executar = false } = {}) {
  const todosUsuarios = await users.list();
  const resumo = [];

  for (const [antigo, novo] of Object.entries(MAPA_CODIGO_MONITOR_PARA_FECHAMENTO)) {
    const item = { antigo, novo, transacoes: 0, fraudMarks: 0, disputes: 0, refundRequests: 0, usuarios: 0 };

    item.transacoes = await store.renomearUnidades({ [antigo]: novo }, { executar });

    const fraudSnap = await db.collection('fraudMarks').where('unidade', '==', antigo).get();
    item.fraudMarks = fraudSnap.size;
    if (executar) {
      await Promise.all(fraudSnap.docs.map((doc) => db.collection('fraudMarks').doc(doc.id).update({ unidade: novo })));
    }

    const disputesSnap = await db.collection('disputes').where('unidade', '==', antigo).get();
    item.disputes = disputesSnap.size;
    if (executar) {
      await Promise.all(disputesSnap.docs.map((doc) => db.collection('disputes').doc(doc.id).update({ unidade: novo })));
    }

    const refundsSnap = await db.collection('refundRequests').where('unidade', '==', antigo).get();
    item.refundRequests = refundsSnap.size;
    if (executar) {
      await Promise.all(refundsSnap.docs.map((doc) => db.collection('refundRequests').doc(doc.id).update({ unidade: novo })));
    }

    item.usuarios = todosUsuarios.filter((u) => (u.permissions?.unidades || []).includes(antigo)).length;
    resumo.push(item);
  }

  await migrarPermissoesUsuarios(todosUsuarios, MAPA_CODIGO_MONITOR_PARA_FECHAMENTO, { executar });

  if (executar) {
    fraudMarks.invalidar();
    disputes.invalidar();
    refunds.invalidar();
  }
  return resumo;
}

module.exports = {
  MAPA_CODIGO_ENTREGAS_PARA_FECHAMENTO, MAPA_CODIGO_MONITOR_PARA_FECHAMENTO, MAPA_CODIGO_UNIFICADO,
  normalizarCodigoUnidade, migrarCodigosEntregas, migrarCodigosMonitor,
};
