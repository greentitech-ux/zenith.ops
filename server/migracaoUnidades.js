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
const entregasLive = require('./entregasLive');
const entregasRegras = require('./entregasRegras');
const users = require('./users');

const MAPA_CODIGO_ENTREGAS_PARA_FECHAMENTO = {
  Bessa: 'Dominos Bessa',
  Caruaru: 'Dominos Caruaru',
  Garanhuns: 'Dominos Garanhuns',
};

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

    const afetados = todosUsuarios.filter((u) => (u.permissions?.unidades || []).includes(antigo));
    item.usuarios = afetados.length;
    if (executar) {
      await Promise.all(afetados.map((u) => {
        const unidades = [...new Set(u.permissions.unidades.map((c) => (c === antigo ? novo : c)))];
        return users.updatePermissions(u.id, { ...u.permissions, unidades });
      }));
    }

    resumo.push(item);
  }

  if (executar) {
    entregasLive.invalidar();
    entregasRegras.invalidar();
  }
  return resumo;
}

module.exports = { MAPA_CODIGO_ENTREGAS_PARA_FECHAMENTO, migrarCodigosEntregas };
