/* Testes unitários das regras de cálculo, banco de horas, importação e backup.
 * Executar:  node --test tests/unit.test.js tests/store.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const U = require('../js/util.js');
const C = require('../js/calc.js');
const B = require('../js/bank.js');
const I = require('../js/importer.js');
const BK = require('../js/backup.js');

const HOJE = '2026-04-15';
const emp = (extra) => Object.assign({ id: 'e1', nome: 'Teste', admissao: '2026-01-01', jornada: { semana: C.semanaExemplo(), regras: {} } }, extra || {});
const marc = (data, horas) => horas.map((h, i) => ({ ref: 'p:' + data + i, dt: data + ' ' + h, origem: 'importacao' }));
const dia = (e, data, horas, ctx) => C.apurarDia(e, data, marc(data, horas), Object.assign({ hoje: HOJE }, ctx || {}));

// ------------------------------------------------------------------ util
test('util: conversão e formatação de horas', () => {
  assert.equal(U.parseHM('09:30'), 570);
  assert.equal(U.parseHM('09:30:59'), 570);
  assert.equal(U.parseHM('24:00'), null);
  assert.equal(U.saldo(330), '+05:30');
  assert.equal(U.saldo(-255), '-04:15');
  assert.equal(U.saldo(0), '00:00');
  assert.equal(U.dur(1500), '25:00');
  assert.equal(U.parseDuracao('+05:30'), 330);
  assert.equal(U.parseDuracao('-4:15'), -255);
  assert.equal(U.parseDuracao('1h30'), 90);
  assert.equal(U.parseDuracao('abc'), null);
});

test('util: datas, dia da semana e competências', () => {
  assert.equal(U.weekday('2026-03-02'), 1); // segunda
  assert.equal(U.weekday('2026-10-27'), 2); // terça
  assert.equal(U.compDays('2026-02').length, 28);
  assert.equal(U.compDays('2028-02').length, 29);
  assert.equal(U.nextComp('2026-12'), '2027-01');
  assert.equal(U.prevComp('2026-01'), '2025-12');
  assert.equal(U.isDateKey('2026-02-30'), false);
  assert.equal(U.validCPF('529.982.247-25'), true);
  assert.equal(U.validCPF('111.111.111-11'), false);
});

// ------------------------------------------------------------------ apuração diária
test('jornada: prevista semanal do exemplo = 40h', () => {
  assert.equal(C.previstoSemanal(C.semanaExemplo()), 40 * 60);
  assert.deepEqual(C.validarSemana(C.semanaExemplo()), []);
});

test('apuração: jornada normal com intervalo', () => {
  const r = dia(emp(), '2026-03-02', ['09:00', '12:00', '14:00', '19:00']);
  assert.equal(r.previstoMin, 480);
  assert.equal(r.trabalhadoMin, 480);
  assert.equal(r.intervaloMin, 120);
  assert.equal(r.saldoMin, 0);
  assert.equal(r.pendente, false);
});

test('apuração: atraso fora da tolerância gera débito', () => {
  const r = dia(emp(), '2026-03-02', ['09:20', '12:00', '14:00', '19:00']);
  assert.equal(r.atrasoMin, 20);
  assert.equal(r.saldoMin, -20);
  assert.equal(r.debitoMin, 20);
  assert.equal(r.creditoMin, 0);
});

test('apuração: diferença dentro da tolerância diária é desconsiderada', () => {
  const r = dia(emp(), '2026-03-02', ['09:08', '12:00', '14:00', '19:00']);
  assert.equal(r.diferencaBrutaMin, -8);
  assert.equal(r.saldoMin, 0);
  assert.ok(r.ocorrencias.some((o) => o.codigo === 'TOLERANCIA'));
});

test('apuração: tolerância zero mantém a diferença exata', () => {
  const e = emp({ jornada: { semana: C.semanaExemplo(), regras: { toleranciaDiariaMin: 0 } } });
  assert.equal(dia(e, '2026-03-02', ['09:08', '12:00', '14:00', '19:00']).saldoMin, -8);
});

test('apuração: horas excedentes geram crédito', () => {
  const r = dia(emp(), '2026-03-02', ['09:00', '12:00', '14:00', '19:40']);
  assert.equal(r.saldoMin, 40);
  assert.equal(r.extraMin, 40);
  assert.equal(r.creditoMin, 40);
});

test('apuração: quantidade ímpar de marcações não é inventada', () => {
  const r = dia(emp(), '2026-03-02', ['09:00', '12:00', '14:00']);
  assert.equal(r.saldoMin, null);
  assert.ok(r.ocorrencias.some((o) => o.codigo === 'IMPAR' && o.nivel === 'erro'));
  assert.equal(r.pendente, true);
  assert.equal(r.marcacoes.length, 3);
});

test('apuração: dia útil passado sem marcações fica pendente (não vira falta sozinho)', () => {
  const r = dia(emp(), '2026-03-02', []);
  assert.equal(r.saldoMin, null);
  assert.ok(r.ocorrencias.some((o) => o.codigo === 'SEM_MARCACAO'));
});

test('apuração: dia futuro sem marcações não gera pendência', () => {
  const r = dia(emp(), '2026-04-20', []);
  assert.equal(r.futuro, true);
  assert.equal(r.pendente, false);
  assert.equal(r.saldoMin, null);
});

test('apuração: falta registrada gera débito da jornada', () => {
  const r = dia(emp(), '2026-03-02', [], { eventos: [{ id: 'ev', tipo: 'falta' }] });
  assert.equal(r.falta, true);
  assert.equal(r.saldoMin, -480);
  assert.equal(r.debitoMin, 480);
});

test('apuração: atestado abona o dia', () => {
  const r = dia(emp(), '2026-03-02', [], { eventos: [{ id: 'ev', tipo: 'atestado' }] });
  assert.equal(r.saldoMin, 0);
  assert.equal(r.abonoMin, 480);
});

test('apuração: abono parcial limita-se ao déficit', () => {
  const r = dia(emp(), '2026-03-02', ['09:00', '12:00', '14:00', '17:00'], { eventos: [{ id: 'ev', tipo: 'abono', minutos: 60 }] });
  assert.equal(r.abonoMin, 60);
  assert.equal(r.saldoMin, -60);
});

test('apuração: folga compensatória classifica o déficit como compensação', () => {
  const r = dia(emp(), '2026-03-02', [], { eventos: [{ id: 'ev', tipo: 'folga_compensatoria' }] });
  assert.equal(r.compensacaoMin, 480);
  assert.equal(r.debitoMin, 0);
});

test('apuração: feriado zera a jornada e trabalho no feriado gera crédito com alerta', () => {
  const r1 = dia(emp(), '2026-03-02', [], { eventos: [{ id: 'ev', tipo: 'feriado' }] });
  assert.equal(r1.previstoMin, 0); assert.equal(r1.saldoMin, 0); assert.equal(r1.tipoDia, 'feriado');
  const r2 = dia(emp(), '2026-03-02', ['09:00', '13:00'], { eventos: [{ id: 'ev', tipo: 'feriado' }] });
  assert.equal(r2.saldoMin, 240);
  assert.ok(r2.ocorrencias.some((o) => o.codigo === 'TRABALHO_SEM_JORNADA'));
});

test('apuração: folga semanal (sábado) sem marcações', () => {
  const r = dia(emp(), '2026-03-07', []);
  assert.equal(r.previstoMin, 0); assert.equal(r.saldoMin, 0); assert.equal(r.pendente, false);
});

test('apuração: marcações duplicadas são ignoradas no cálculo e exigem conferência', () => {
  const ms = marc('2026-03-02', ['09:00', '09:01', '12:00', '14:00', '19:00']);
  const r = C.apurarDia(emp(), '2026-03-02', ms, { hoje: HOJE });
  assert.equal(r.trabalhadoMin, 480);
  assert.equal(r.marcacoes.filter((m) => m.duplicada).length, 1);
  assert.equal(r.pendente, true);
  const conferido = C.apurarDia(emp(), '2026-03-02', ms, { hoje: HOJE, conferencia: { assinatura: r.assinatura } });
  assert.equal(conferido.pendente, false);
  assert.equal(conferido.conferido, true);
  // conferência fica inválida se as marcações mudarem
  const outra = C.apurarDia(emp(), '2026-03-02', ms.slice(1), { hoje: HOJE, conferencia: { assinatura: r.assinatura } });
  assert.equal(outra.conferido, false);
});

test('apuração: marcação muito fora da jornada gera alerta', () => {
  const r = dia(emp(), '2026-03-02', ['07:30', '12:00', '14:00', '19:00']);
  assert.ok(r.ocorrencias.some((o) => o.codigo === 'FORA_JORNADA'));
});

test('apuração: jornada noturna com virada de dia', () => {
  const semana = [0, 1, 2, 3, 4, 5, 6].map((wd) => (wd >= 1 && wd <= 5) ? { folga: false, periodos: [{ ini: '22:00', fim: '02:00' }, { ini: '03:00', fim: '06:00' }] } : { folga: true, periodos: [] });
  const e = emp({ jornada: { semana, regras: {} } });
  assert.equal(C.previstoPeriodos(semana[1].periodos).total, 420);
  // batidas de terça de madrugada pertencem à segunda
  assert.equal(C.dataReferencia(e, '2026-03-03 06:05'), '2026-03-02');
  assert.equal(C.dataReferencia(e, '2026-03-03 02:00'), '2026-03-02');
  assert.equal(C.dataReferencia(e, '2026-03-03 21:55'), '2026-03-03');
  // segunda-feira de madrugada NÃO pertence a domingo (domingo é folga)
  assert.equal(C.dataReferencia(e, '2026-03-02 05:00'), '2026-03-02');
  const ms = [{ ref: 'a', dt: '2026-03-02 22:00' }, { ref: 'b', dt: '2026-03-03 02:00' }, { ref: 'c', dt: '2026-03-03 03:00' }, { ref: 'd', dt: '2026-03-03 06:30' }];
  const r = C.apurarDia(e, '2026-03-02', ms, { hoje: HOJE });
  assert.equal(r.trabalhadoMin, 450);
  assert.equal(r.intervaloMin, 60);
  assert.equal(r.saldoMin, 30);
});

test('apuração: dia anterior à admissão fica fora do contrato', () => {
  const r = dia(emp({ admissao: '2026-03-10' }), '2026-03-02', []);
  assert.equal(r.foraContrato, true); assert.equal(r.previstoMin, 0); assert.equal(r.pendente, false);
});

test('apuração mensal: totais em minutos sem arredondamento', () => {
  const e = emp();
  const mpd = {
    '2026-03-02': marc('2026-03-02', ['09:00', '12:00', '14:00', '19:13']), // +13
    '2026-03-03': marc('2026-03-03', ['09:17', '12:00', '14:00', '19:00'])  // -17
  };
  const ev = {};
  for (const d of U.compDays('2026-03')) if (!mpd[d] && U.weekday(d) !== 0 && U.weekday(d) !== 6) ev[d] = [{ id: d, tipo: 'atestado' }];
  const m = C.apurarMes(e, '2026-03', { marcacoesPorDia: mpd, eventosPorDia: ev, hoje: HOJE });
  assert.equal(m.totais.creditosMin, 13);
  assert.equal(m.totais.debitosMin, 17);
  assert.equal(m.totais.diasPendentes, 0);
  assert.equal(m.totais.previstoMin, 22 * 480);
});

// ------------------------------------------------------------------ banco de horas
const mov = (cred, deb, comp, aj) => ({ creditosMin: cred, debitosMin: deb, compensacoesMin: comp || 0, ajustesMin: aj || 0, diasNaoApurados: 0, diasPendentes: 0 });

test('banco: exemplo do enunciado (+05:30 +02:00 −04:15 = +03:15)', () => {
  const e = emp({ banco: { compInicial: '2026-03', saldoInicialMin: 330 } });
  const ex = B.extrato({ emp: e, ateComp: '2026-03', movimento: () => mov(120, 255) });
  assert.equal(ex.length, 1);
  assert.equal(ex[0].saldoAnteriorMin, 330);
  assert.equal(ex[0].saldoFinalMin, 195);
  assert.equal(U.saldo(ex[0].saldoFinalMin), '+03:15');
});

test('banco: saldo negativo, zerado e transporte entre meses (sem zerar na virada)', () => {
  const e = emp({ banco: { compInicial: '2026-01', saldoInicialMin: 0 } });
  const movs = { '2026-01': mov(0, 90), '2026-02': mov(90, 0), '2026-03': mov(30, 0), '2026-04': mov(0, 0) };
  const ex = B.extrato({ emp: e, ateComp: '2026-04', movimento: (c) => movs[c] });
  assert.deepEqual(ex.map((l) => l.saldoFinalMin), [-90, 0, 30, 30]);
  assert.deepEqual(ex.map((l) => l.saldoAnteriorMin), [0, -90, 0, 30]);
});

test('banco: virada de ano', () => {
  const e = emp({ banco: { compInicial: '2025-12', saldoInicialMin: 60 } });
  const ex = B.extrato({ emp: e, ateComp: '2026-01', movimento: () => mov(10, 0) });
  assert.deepEqual(ex.map((l) => l.comp), ['2025-12', '2026-01']);
  assert.equal(ex[1].saldoFinalMin, 80);
});

test('banco: compensações e ajustes com sinal', () => {
  const e = emp({ banco: { compInicial: '2026-03', saldoInicialMin: 600 } });
  const ex = B.extrato({ emp: e, ateComp: '2026-03', movimento: () => mov(0, 0, -480, 30) });
  assert.equal(ex[0].saldoFinalMin, 150);
});

test('banco: política com débitos fora do banco', () => {
  const e = emp({ banco: { compInicial: '2026-03', saldoInicialMin: 0 } });
  const ex = B.extrato({ emp: e, ateComp: '2026-03', politica: { debitosNoBanco: false }, movimento: () => mov(60, 100) });
  assert.equal(ex[0].saldoFinalMin, 60);
  assert.equal(ex[0].debitosForaBancoMin, 100);
});

test('banco: reprocessar não duplica (resultado determinístico)', () => {
  const e = emp({ banco: { compInicial: '2026-01', saldoInicialMin: 0 } });
  const f = (c) => mov(c === '2026-02' ? 45 : 0, 0);
  const a = B.extrato({ emp: e, ateComp: '2026-03', movimento: f });
  const b = B.extrato({ emp: e, ateComp: '2026-03', movimento: f });
  assert.deepEqual(a, b);
  assert.equal(a[2].saldoFinalMin, 45);
});

test('banco: competência fechada com saldo anterior divergente é sinalizada', () => {
  const e = emp({ banco: { compInicial: '2026-01', saldoInicialMin: 0 } });
  const fechamentos = { '2026-02': { status: 'fechada', snapshot: { saldoAnteriorMin: 10, saldoFinalMin: 20, movimento: mov(10, 0) } } };
  const ex = B.extrato({ emp: e, ateComp: '2026-02', movimento: () => mov(30, 0), fechamentos });
  assert.equal(ex[1].saldoAnteriorMin, 30);
  assert.equal(ex[1].saldoFinalMin, 40); // movimento congelado (+10) sobre o novo saldo anterior
  assert.ok(ex[1].divergencia);
});

// ------------------------------------------------------------------ importação
const fs = require('node:fs');
const path = require('node:path');
const FIXTURE = path.join(__dirname, 'fixtures', 'ARQUIVO-DE-TESTE_NAO-E-DO-RELOGIO.csv');

test('importação: detecta texto e arquivo binário', () => {
  const txt = I.detectar('a.csv', new Uint8Array(fs.readFileSync(FIXTURE)));
  assert.equal(txt.tipo, 'texto');
  assert.equal(txt.codificacao, 'utf-8');
  const bin = I.detectar('a.dat', new Uint8Array([0x00, 0x01, 0x02, 0xff, 0x00, 0x10]));
  assert.equal(bin.tipo, 'binario');
  assert.equal(I.detectar('v.txt', new Uint8Array([])).tipo, 'vazio');
  const latin = I.detectar('l.txt', new Uint8Array([0x4a, 0x6f, 0xe3, 0x6f])); // "João" em Windows-1252
  assert.equal(latin.codificacao, 'windows-1252');
  assert.equal(latin.texto, 'João');
});

test('importação: sugere mapeamento e extrai com erros por linha', () => {
  const info = I.detectar('a.csv', new Uint8Array(fs.readFileSync(FIXTURE)));
  const tab = I.tabular(info.texto);
  assert.equal(tab.delimitador, ';');
  const m = I.sugerirMapeamento(tab);
  assert.equal(m.colCodigo, 0); assert.equal(m.colData, 1); assert.equal(m.colHora, 2);
  assert.equal(m.ignorarLinhas, 1); assert.equal(m.formatoData, 'dmy');
  const { registros, erros } = I.extrair(tab, m);
  assert.equal(registros.length, 17);
  assert.equal(erros.length, 2); // data 31/02 e a linha de aviso final
  assert.equal(registros[0].dt, '2026-03-02 09:00'); // segundos descartados
});

test('importação: formatos de data e data/hora na mesma coluna', () => {
  assert.equal(I.lerData('2026-03-02', 'ymd'), '2026-03-02');
  assert.equal(I.lerData('03/02/2026', 'mdy'), '2026-03-02');
  assert.equal(I.lerData('02/03/26', 'dmy'), '2026-03-02');
  assert.equal(I.lerData('30/02/2026', 'dmy'), null);
  const tab = I.tabular('7,2026-03-02 09:00:00\n7,2026-03-02 18:00:00\n');
  const m = I.sugerirMapeamento(tab);
  assert.equal(m.colDataHora, 1); assert.equal(m.formatoData, 'ymd');
  assert.equal(I.extrair(tab, m).registros.length, 2);
});

test('importação: duplicidades no arquivo e contra existentes', () => {
  const regs = [{ employeeId: 'e', codigo: '1', dt: '2026-03-02 09:00' }, { employeeId: 'e', codigo: '1', dt: '2026-03-02 09:00' }, { employeeId: 'e', codigo: '1', dt: '2026-03-02 12:00' }];
  I.marcarDuplicidades(regs, new Set(['e|2026-03-02 12:00']));
  assert.deepEqual(regs.map((r) => [r.duplicadaArquivo, r.duplicadaExistente]), [[false, false], [true, false], [false, true]]);
});

// ------------------------------------------------------------------ backup
const DB = require('../js/db.js');
const dadosVazios = () => Object.fromEntries(DB.STORES.map((s) => [s, []]));

test('backup: estrutura válida e integridade', async () => {
  const d = dadosVazios();
  d.funcionarios.push({ id: 'f1', nome: 'Fulana', situacao: 'ativo', jornada: { semana: C.semanaExemplo() } });
  d.marcacoes.push({ id: 'm1', employeeId: 'f1', dt: '2026-03-02 09:00', dataRef: '2026-03-02', origem: 'manual' });
  const b = await BK.montar(d, 'teste');
  const json = JSON.parse(JSON.stringify(b, null, 2)); // simula gravar e ler o arquivo
  const v = await BK.validar(json);
  assert.equal(v.ok, true, v.erros.join('; '));
  json.dados.marcacoes[0].dt = '2026-03-02 08:00';
  const v2 = await BK.validar(json);
  assert.equal(v2.ok, false);
  assert.match(v2.erros.join(' '), /integridade/);
});

test('backup: rejeita arquivo de outro formato e referências quebradas', async () => {
  assert.equal((await BK.validar({ foo: 1 })).ok, false);
  assert.equal((await BK.validar([])).ok, false);
  const d = dadosVazios();
  d.marcacoes.push({ id: 'm1', employeeId: 'naoexiste', dt: '2026-03-02 09:00', dataRef: '2026-03-02', origem: 'manual' });
  const v = await BK.validar(await BK.montar(d));
  assert.equal(v.ok, false);
  assert.match(v.erros.join(' '), /funcionário inexistente/);
});
