'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { calcular } = require('./saldoDinheiroLoja');
// Exercita também a ligação real com o painel, sem Firestore/rede.
const contexto = { module: { exports: {} }, process: { env: {} },
  require: nome => nome === './saldoDinheiroLoja' ? { calcular } : {} };
vm.runInNewContext(fs.readFileSync(__dirname + '/saidasPainel.js', 'utf8'), contexto);
const saldo = contexto.module.exports.dinheiroEmLoja;
const e = (data, valor, unidade = 'Mooca') => ({ unidade, data, valor });
let sequencia = 0;
const s = (data, valor, origem = 'saida', unidade = 'Mooca', extra) => ({ ...e(data, valor, unidade), chave: `${origem}::${++sequencia}`, origem, extra });
const entradas = [e('2026-10-01', 149.43), e('2026-10-02', 107), e('2026-10-04', 140)];
const itens = [s('2026-10-02', 30), s('2026-10-02', 96.02, 'sangria'),
  s('2026-10-03', 40), s('2026-10-03', 50.98), s('2026-10-04', 30), s('2026-10-04', 30)];
assert.equal(saldo(itens, entradas, { ate: '2026-10-31' }).total, 119.43, 'Mooca: preservar os 130,41 restantes após sangria');
assert.equal(saldo(itens, entradas, { ate: '2026-10-02' }).total, 130.41);
assert.equal(saldo(itens, entradas, { ate: '2026-10-01' }).total, 149.43);
assert.equal(saldo(itens, [...entradas, e('2026-09-30', 119.49)], { ate: '2026-10-31' }).total, 238.92, 'virada de mês mantém saldo anterior');
assert.equal(saldo(itens, [...entradas, e('2026-09-30', 119.49)], { inicio:'2026-10-01', ate: '2026-10-31' }).total, 119.43, 'filtro de outubro não mistura setembro');
assert.equal(saldo(itens, entradas, { inicio:'2026-10-03', ate:'2026-10-04' }).total, -10.98, 'intervalo parcial usa os mesmos movimentos dos cards');
assert.equal(saldo([...itens, s('2026-10-05', 100, 'sangria')], entradas, { ate: '2026-10-31' }).total, 19.43, 'segunda retirada parcial');
assert.equal(saldo([s('2026-10-05', 100, 'sangria', 'Mooca', {periodoFim:'2026-09-30'})], [e('2026-09-30',100)], {ate:'2026-09-30'}).total, 100, 'retirada futura não zera mês anterior');
assert.equal(saldo([s('2026-10-02', 120, 'sangria')], [e('2026-10-01',100)]).total, -20, 'saldo negativo não é ocultado');
assert.equal(saldo([s('2026-07-31',999, 'sangria')], [e('2026-07-31',9999),e('2026-08-01',1)], {inicio:'2026-08-01'}).total, 1, 'respeitar início solicitado');
assert.equal(saldo([s('2026-07-31',999, 'sangria')], [e('2026-07-31',9999),e('2026-08-01',1)]).total, 9001, 'sem início não existe corte oculto');
assert.equal(saldo([s('2026-08-01',1),s('2026-09-01',2,'sangria'),s('2026-10-01',3)], [e('2026-08-01',10),e('2026-09-01',20),e('2026-10-01',30)], {inicio:'2026-08-01',ate:'2026-10-31'}).total,54, 'três meses com os mesmos limites para entradas, saídas e sangrias');
assert.equal(saldo([], [e('2026-10-01',100)], {ate:'2026-09-30'}).porUnidade[0].semBase, true);
assert.equal(saldo([s('2026-10-01',1,'sangria')], []).total, -1, 'retirada isolada não vira zero');
assert.equal(saldo([], [e('2026-10-01',-.03)]).total, -.03, 'ajuste negativo registrado não é descartado');
const multi = saldo([...itens,s('2026-10-01',10,'sangria','Carrao')], [...entradas,e('2026-10-01',50,'Carrao')]);
assert.equal(multi.total,159.43);
assert.equal(multi.porUnidade.find(x=>x.unidade==='Mooca').valor,119.43, 'não misturar unidades');
assert.equal(saldo([], Array.from({length:10000},()=>e('2026-10-01',.01))).total,100, 'centavos exatos');
assert.equal(saldo(itens.slice().reverse(), entradas.slice().reverse()).total,119.43, 'independente da ordem');
assert.throws(()=>saldo([], [e('2026-10-01','inválido')]), /inválido/, 'não mascarar valor inválido como zero');
console.log('OK: saldo exato da Mooca, centavos, filtros de um e três meses e isolamento por unidade.');
