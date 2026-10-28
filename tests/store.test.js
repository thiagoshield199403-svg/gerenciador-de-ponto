/* Testes de integração da camada de dados (Store) usando o adaptador em memória.
 * Executar:  node --test tests/unit.test.js tests/store.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const U = require('../js/util.js');
const C = require('../js/calc.js');
const { Store, ErroRegra } = require('../js/store.js');
const { MemoryAdapter } = require('../js/db.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'ARQUIVO-DE-TESTE_NAO-E-DO-RELOGIO.csv');
let relogio = 0;
const novoStore = async (adapter, hoje) => new Store(adapter || new MemoryAdapter(), {
  hoje: () => hoje || '2026-05-20',
  agora: () => new Date(Date.UTC(2026, 4, 20, 12, 0, 0) + (relogio++) * 1000).toISOString()
}).init();

const funcionaria = (extra) => Object.assign({
  nome: 'Funcionária de Teste', cpf: '', cargo: 'Vendedora', admissao: '2026-01-01', codigoRelogio: '1001',
  regime: 'CLT', jornada: { semana: C.semanaExemplo(), regras: {} }, banco: { compInicial: '2026-01', saldoInicialMin: 0 }
}, extra || {});

/** Lança marcações completas (09-12/14-19) em todos os dias úteis da competência, com ajustes opcionais. */
async function preencherMes(s, empId, comp, extras) {
  extras = extras || {};
  for (const d of U.compDays(comp)) {
    const wd = U.weekday(d);
    if (wd === 0 || wd === 6) continue;
    const horas = extras[d] || ['09:00', '12:00', '14:00', '19:00'];
    for (const h of horas) await s.incluirMarcacao(empId, d + ' ' + h, 'lançamento de teste');
  }
}

test('funcionário: cadastro, validação, edição e inativação', async () => {
  const s = await novoStore();
  const f = await s.salvarFuncionario(funcionaria({ cpf: '529.982.247-25' }));
  assert.ok(f.id);
  assert.equal(f.cpf, '52998224725');
  await assert.rejects(s.salvarFuncionario(funcionaria({ nome: 'Outra Pessoa', cpf: '123.456.789-00', codigoRelogio: '2' })), /CPF inválido/);
  await assert.rejects(s.salvarFuncionario(funcionaria({ nome: 'Outra Pessoa' })), /já pertence/);
  const editado = await s.salvarFuncionario(Object.assign(s.funcionario(f.id), { cargo: 'Gerente' }));
  assert.equal(editado.cargo, 'Gerente');
  assert.equal(s.funcionarios().length, 1);
  await assert.rejects(s.inativarFuncionario(f.id, ''), /justificativa/);
  await s.inativarFuncionario(f.id, 'pedido de demissão', '2026-05-10');
  assert.equal(s.funcionario(f.id).situacao, 'inativo');
  assert.equal(s.funcionarios({ ativos: true }).length, 0);
  assert.ok(s.auditoria({ employeeId: f.id }).length >= 3);
});

test('persistência: dados continuam após "recarregar" (nova instância no mesmo armazenamento)', async () => {
  const adapter = new MemoryAdapter();
  const s1 = await novoStore(adapter);
  const f = await s1.salvarFuncionario(funcionaria());
  await s1.incluirMarcacao(f.id, '2026-03-02 09:00', 'teste de persistência');
  const s2 = await novoStore(adapter);
  assert.equal(s2.funcionario(f.id).nome, 'Funcionária de Teste');
  assert.equal(s2.efetivas(f.id).length, 1);
});

test('jornada: configuração por dia da semana é respeitada na apuração', async () => {
  const s = await novoStore();
  const semana = C.semanaExemplo();
  semana[6] = { folga: false, periodos: [{ ini: '08:00', fim: '12:00' }] }; // sábado meio período
  const f = await s.salvarFuncionario(funcionaria({ jornada: { semana, regras: {} } }));
  const ap = s.apurarMes(f.id, '2026-03');
  const sab = ap.dias.find((d) => d.data === '2026-03-07');
  assert.equal(sab.previstoMin, 240);
  await assert.rejects(s.salvarFuncionario(Object.assign(s.funcionario(f.id), { jornada: { semana: semana.map((d) => ({ folga: false, periodos: [] })) } })), /informe ao menos um período/);
});

test('importação: prévia, erros, identificador, duplicidade e confirmação', async () => {
  const s = await novoStore();
  const f = await s.salvarFuncionario(funcionaria());
  const bytes = new Uint8Array(fs.readFileSync(FIXTURE));
  const prep = await s.prepararImportacao('ARQUIVO-DE-TESTE_NAO-E-DO-RELOGIO.csv', bytes);
  assert.equal(prep.info.tipo, 'texto');
  const previa = s.previaImportacao(prep, prep.sugestao, null);
  assert.equal(previa.erros.length, 2);
  assert.equal(previa.resumo.semFuncionario, 1);       // código 2002
  assert.equal(previa.resumo.duplicadosArquivo, 1);    // 08:58:00 e 08:58:30
  assert.equal(previa.resumo.novos, 15);
  assert.deepEqual(previa.codigos.map((c) => c.codigo).sort(), ['1001', '2002']);
  // Nada foi gravado ainda
  assert.equal(s.efetivas(f.id).length, 0);
  const imp = await s.confirmarImportacao(previa, { teste: true });
  assert.equal(s.efetivas(f.id).length, 15);
  assert.ok(s.efetivas(f.id).every((m) => m.origem === 'importacao-teste'));
  // Arquivo original preservado byte a byte
  assert.deepEqual(Buffer.from(s.arquivoOriginal(imp.id).bytes), Buffer.from(bytes));
  // Reimportar o mesmo arquivo: tudo detectado como duplicado
  const prep2 = await s.prepararImportacao('copia.csv', bytes);
  assert.ok(prep2.jaImportado);
  const previa2 = s.previaImportacao(prep2, prep2.sugestao, null);
  assert.equal(previa2.resumo.novos, 0);
  assert.equal(previa2.resumo.duplicadosExistentes, 15);
  await assert.rejects(s.confirmarImportacao(previa2, {}), /Não há marcações novas/);
  // Vincular manualmente o código desconhecido
  const previa3 = s.previaImportacao(prep2, prep2.sugestao, { 2002: f.id });
  assert.equal(previa3.resumo.semFuncionario, 0);
  // Apuração dos dias importados
  const ap = s.apurarMes(f.id, '2026-03');
  const d = (k) => ap.dias.find((x) => x.data === k);
  assert.equal(d('2026-03-02').saldoMin, 0);        // 09:00-12:01 / 14:00-19:00 = 8h01, dentro da tolerância
  assert.equal(d('2026-03-03').saldoMin, 15);       // 09:15 / 19:30 -> +15
  assert.equal(d('2026-03-05').saldoMin, null);     // ímpar
  assert.ok(d('2026-03-05').pendente);
  // Desconsiderar a importação inteira (registros continuam existindo)
  await s.desconsiderarImportacao(imp.id, 'era apenas arquivo de teste');
  assert.equal(s.efetivas(f.id).filter((m) => !m.removida).length, 0);
  assert.equal(s.all('marcacoes').length, 15);
});

test('importação: arquivo binário é recusado com mensagem clara', async () => {
  const s = await novoStore();
  const prep = await s.prepararImportacao('relogio.dat', new Uint8Array([0, 1, 2, 3, 0, 0, 255]));
  assert.equal(prep.info.tipo, 'binario');
  assert.throws(() => s.previaImportacao(prep, {}, null), /não pôde ser lido como texto/);
});

test('correção de ponto: inclusão, alteração e exclusão com histórico preservado', async () => {
  const s = await novoStore();
  const f = await s.salvarFuncionario(funcionaria());
  const prep = await s.prepararImportacao('teste.csv', new TextEncoder().encode('1001;02/03/2026;09:00\n1001;02/03/2026;12:00\n1001;02/03/2026;14:00\n'));
  await s.confirmarImportacao(s.previaImportacao(prep, prep.sugestao, null), { teste: true });
  let ap = s.apurarMes(f.id, '2026-03').dias.find((d) => d.data === '2026-03-02');
  assert.equal(ap.saldoMin, null); // ímpar
  // inclusão da saída esquecida
  await assert.rejects(s.incluirMarcacao(f.id, '2026-03-02 19:00', ''), /justificativa/);
  const inc = await s.incluirMarcacao(f.id, '2026-03-02 19:00', 'funcionária esqueceu de bater a saída');
  ap = s.apurarMes(f.id, '2026-03').dias.find((d) => d.data === '2026-03-02');
  assert.equal(ap.saldoMin, 0);
  assert.equal(ap.marcacoes.find((m) => m.ref === 'a:' + inc.id).origem, 'manual');
  // alteração de horário importado
  const orig = s.efetivas(f.id).find((m) => m.dt === '2026-03-02 09:00');
  await s.alterarMarcacao(f.id, orig.ref, '2026-03-02 09:30', 'relógio com horário adiantado');
  const h = s.historicoMarcacao(f.id, orig.ref);
  assert.equal(h.marcacao.original.dt, '2026-03-02 09:00');
  assert.equal(h.marcacao.dt, '2026-03-02 09:30');
  assert.equal(h.ajustes.length, 1);
  assert.equal(h.ajustes[0].justificativa, 'relógio com horário adiantado');
  // o registro original importado não foi alterado
  assert.equal(s.all('marcacoes').find((m) => m.dt === '2026-03-02 09:00').dt, '2026-03-02 09:00');
  // exclusão (desconsideração) e restauração
  await s.desconsiderarMarcacao(f.id, 'a:' + inc.id, 'lançada por engano');
  ap = s.apurarMes(f.id, '2026-03').dias.find((d) => d.data === '2026-03-02');
  assert.equal(ap.marcacoes.length, 3);
  assert.equal(ap.removidas.length, 1);
  await s.restaurarMarcacao(f.id, 'a:' + inc.id, 'na verdade estava correta');
  assert.equal(s.apurarMes(f.id, '2026-03').dias.find((d) => d.data === '2026-03-02').marcacoes.length, 4);
  assert.equal(s.all('ajustes').length, 4); // nada foi apagado
});

test('banco de horas: positivo, negativo e transporte entre meses', async () => {
  const s = await novoStore(null, '2026-04-10');
  const f = await s.salvarFuncionario(funcionaria({ banco: { compInicial: '2026-01', saldoInicialMin: 330 } }));
  // Janeiro: um dia +2h (saída 21:00), Fevereiro: um dia -4h15 (saída 14:45 sem intervalo)
  await preencherMes(s, f.id, '2026-01', { '2026-01-05': ['09:00', '12:00', '14:00', '21:00'] });
  await preencherMes(s, f.id, '2026-02', { '2026-02-02': ['09:00', '12:00', '14:00', '14:45'] });
  const ex = s.extrato(f.id, '2026-03');
  assert.equal(ex[0].saldoAnteriorMin, 330);
  assert.equal(ex[0].creditosMin, 120);
  assert.equal(ex[0].saldoFinalMin, 450);
  assert.equal(ex[1].saldoAnteriorMin, 450);
  assert.equal(ex[1].debitosMin, 255);
  assert.equal(ex[1].saldoFinalMin, 195);
  // Março ainda sem marcações: dias passados ficam pendentes, saldo é transportado sem zerar
  assert.equal(ex[2].saldoAnteriorMin, 195);
  assert.equal(ex[2].provisoria, true);
  // Compensação e ajuste justificados
  await s.lancarBanco({ employeeId: f.id, data: '2026-03-10', tipo: 'compensacao', minutos: -195, justificativa: 'pagamento das horas em folha' });
  assert.equal(s.linhaBanco(f.id, '2026-03').saldoFinalMin, 0);
  await s.lancarBanco({ employeeId: f.id, data: '2026-03-11', tipo: 'ajuste', minutos: -60, justificativa: 'ajuste acordado' });
  assert.equal(s.linhaBanco(f.id, '2026-03').saldoFinalMin, -60);
  const l = s.lancamentos(f.id, '2026-03')[1];
  await s.cancelarLancamento(l.id, 'lançado errado');
  assert.equal(s.linhaBanco(f.id, '2026-03').saldoFinalMin, 0);
  assert.equal(s.lancamentos(f.id, '2026-03', true).length, 2);
});

test('fechamento: bloqueios, fechamento, proteção, reabertura e correção retroativa', async () => {
  const s = await novoStore(null, '2026-04-10');
  const f = await s.salvarFuncionario(funcionaria());
  await preencherMes(s, f.id, '2026-01', { '2026-01-05': ['09:00', '12:00', '14:00', '20:00'] }); // +1h
  await preencherMes(s, f.id, '2026-02', { '2026-02-02': ['09:00', '12:00', '14:00', '19:30'] }); // +30
  // Abril não terminou
  assert.equal(s.verificarFechamento(f.id, '2026-04').podeFechar, false);
  // Fevereiro antes de janeiro: bloqueado (sequencial)
  const vFev = s.verificarFechamento(f.id, '2026-02');
  assert.equal(vFev.podeFechar, false);
  assert.match(vFev.bloqueios.join(' '), /competência anterior/);
  // Pendência em janeiro bloqueia
  await s.desconsiderarMarcacao(f.id, s.efetivas(f.id).find((m) => m.dt === '2026-01-06 19:00').ref, 'teste de pendência');
  assert.match(s.verificarFechamento(f.id, '2026-01').bloqueios.join(' '), /pendências/);
  await assert.rejects(s.fechar(f.id, '2026-01'), /Não é possível fechar/);
  await s.incluirMarcacao(f.id, '2026-01-06 19:00', 'saída corrigida');
  // Fecha janeiro e fevereiro
  const r1 = await s.fechar(f.id, '2026-01', 'conferido com a funcionária');
  assert.equal(r1.fechamento.snapshot.saldoFinalMin, 60);
  await s.fechar(f.id, '2026-02');
  assert.equal(s.linhaBanco(f.id, '2026-02').saldoFinalMin, 90);
  // Competência fechada protegida
  await assert.rejects(s.incluirMarcacao(f.id, '2026-01-10 10:00', 'tentativa'), /está fechada/);
  await assert.rejects(s.registrarEvento({ employeeId: null, data: '2026-02-16', tipo: 'feriado', descricao: 'Carnaval' }), /está fechada/);
  // Reabertura exige justificativa
  await assert.rejects(s.reabrir(f.id, '2026-01', ''), /justificativa/);
  await s.reabrir(f.id, '2026-01', 'faltou registrar hora extra do dia 07');
  // Correção retroativa: +30 em janeiro
  const ref = s.efetivas(f.id).find((m) => m.dt === '2026-01-07 19:00').ref;
  await s.alterarMarcacao(f.id, ref, '2026-01-07 19:30', 'hora extra autorizada');
  // Enquanto janeiro está aberto, fevereiro (fechado) mostra divergência
  const exAntes = s.extrato(f.id, '2026-02');
  assert.equal(exAntes[0].saldoFinalMin, 90);
  assert.ok(exAntes[1].divergencia);
  assert.equal(exAntes[1].saldoFinalMin, 120);
  // Fechar janeiro novamente recalcula os posteriores
  const r2 = await s.fechar(f.id, '2026-01', 'refechamento após correção');
  assert.deepEqual(r2.atualizadas, ['2026-02']);
  const exDepois = s.extrato(f.id, '2026-02');
  assert.equal(exDepois[1].divergencia, null);
  assert.equal(s.fechamento(f.id, '2026-02').snapshot.saldoFinalMin, 120);
  assert.equal(s.fechamento(f.id, '2026-02').snapshot.movimento.creditosMin, 30); // movimento congelado intacto
  const hist = s.fechamento(f.id, '2026-01').historico.map((h) => h.acao);
  assert.deepEqual(hist, ['fechamento', 'reabertura', 'fechamento']);
  assert.ok(s.fechamento(f.id, '2026-02').historico.some((h) => h.acao === 'recalculo-saldo'));
  // Reprocessar não duplica: extrato idêntico em chamadas repetidas
  assert.deepEqual(s.extrato(f.id, '2026-03'), s.extrato(f.id, '2026-03'));
});

test('fechamento: dados congelados não mudam se a jornada do funcionário for alterada depois', async () => {
  const s = await novoStore(null, '2026-03-10');
  const f = await s.salvarFuncionario(funcionaria({ banco: { compInicial: '2026-02', saldoInicialMin: 0 } }));
  await preencherMes(s, f.id, '2026-02');
  await s.fechar(f.id, '2026-02');
  const antes = s.competencia(f.id, '2026-02').apuracao.totais.previstoMin;
  const semana = C.semanaExemplo(); semana[1].periodos = [{ ini: '09:00', fim: '12:00' }];
  const g = s.funcionario(f.id); g.jornada.semana = semana;
  await s.salvarFuncionario(g);
  assert.equal(s.competencia(f.id, '2026-02').apuracao.totais.previstoMin, antes);
  await assert.rejects(s.salvarFuncionario(Object.assign(s.funcionario(f.id), { banco: { compInicial: '2026-02', saldoInicialMin: 60 } })), /saldo inicial/);
});

test('ocorrências: feriado global, falta e cancelamento com histórico', async () => {
  const s = await novoStore(null, '2026-04-10');
  const f = await s.salvarFuncionario(funcionaria());
  await s.registrarEvento({ employeeId: null, data: '2026-03-02', tipo: 'feriado', descricao: 'Feriado municipal (teste)' });
  await s.registrarEvento({ employeeId: f.id, data: '2026-03-03', tipo: 'falta', descricao: 'não compareceu' });
  await s.registrarEvento({ employeeId: f.id, data: '2026-03-09', dataFim: '2026-03-13', tipo: 'ferias', descricao: 'férias de teste' });
  await assert.rejects(s.registrarEvento({ employeeId: f.id, data: '2026-03-03', tipo: 'falta', descricao: 'de novo' }), /Já existe/);
  const ap = s.apurarMes(f.id, '2026-03');
  const d = (k) => ap.dias.find((x) => x.data === k);
  assert.equal(d('2026-03-02').previstoMin, 0);
  assert.equal(d('2026-03-03').saldoMin, -480);
  assert.equal(d('2026-03-11').tipoDia, 'ferias');
  const ev = s.eventos({ employeeId: f.id }).find((e) => e.tipo === 'falta');
  await s.cancelarEvento(ev.id, 'era atestado');
  assert.equal(s.apurarMes(f.id, '2026-03').dias.find((x) => x.data === '2026-03-03').saldoMin, null);
  assert.equal(s.eventos({ employeeId: f.id, incluirCancelados: true }).filter((e) => e.cancelado).length, 1);
});

test('conferência de dia com alerta libera o fechamento; mudança posterior invalida', async () => {
  const s = await novoStore(null, '2026-04-10');
  const f = await s.salvarFuncionario(funcionaria({ banco: { compInicial: '2026-03', saldoInicialMin: 0 } }));
  await preencherMes(s, f.id, '2026-03', { '2026-03-02': ['09:00', '09:01', '12:00', '14:00', '19:00'] });
  assert.equal(s.verificarFechamento(f.id, '2026-03').podeFechar, false);
  await s.conferirDia(f.id, '2026-03-02', 'batida dupla no relógio');
  assert.equal(s.verificarFechamento(f.id, '2026-03').podeFechar, true);
  await s.incluirMarcacao(f.id, '2026-03-02 20:00', 'teste');
  await s.incluirMarcacao(f.id, '2026-03-02 20:30', 'teste');
  assert.equal(s.verificarFechamento(f.id, '2026-03').podeFechar, false);
});

test('backup: exportar e restaurar sem duplicar; arquivo adulterado é recusado', async () => {
  const s = await novoStore(null, '2026-04-10');
  const f = await s.salvarFuncionario(funcionaria());
  await preencherMes(s, f.id, '2026-01');
  await s.fechar(f.id, '2026-01');
  await s.lancarBanco({ employeeId: f.id, data: '2026-02-10', tipo: 'ajuste', minutos: 30, justificativa: 'teste' });
  const backup = JSON.parse(JSON.stringify(await s.exportarBackup()));
  const contagem = (st) => Object.fromEntries(['funcionarios', 'marcacoes', 'ajustes', 'fechamentos', 'lancamentos'].map((k) => [k, st.all(k).length]));
  const antes = contagem(s);
  // Restaurar sobre os mesmos dados: nada é duplicado
  await s.restaurarBackup(backup);
  assert.deepEqual(contagem(s), antes);
  // Restaurar em outro "computador" (armazenamento vazio)
  const outro = await novoStore(null, '2026-04-10');
  await outro.restaurarBackup(backup);
  assert.deepEqual(contagem(outro), antes);
  assert.equal(outro.linhaBanco(f.id, '2026-02').saldoFinalMin, s.linhaBanco(f.id, '2026-02').saldoFinalMin);
  assert.equal(outro.compFechada(f.id, '2026-01'), true);
  // Mudanças depois do backup são descartadas pela restauração, mas há cópia de segurança interna
  await s.incluirMarcacao(f.id, '2026-02-02 09:00', 'depois do backup');
  await s.restaurarBackup(backup);
  assert.equal(s.efetivas(f.id).filter((m) => m.dataRef === '2026-02-02').length, 0);
  assert.ok((await s.copiasSeguranca()).length >= 1);
  // Adulterado
  const ruim = JSON.parse(JSON.stringify(backup));
  ruim.dados.ajustes[0].dt = '2026-01-05 05:00';
  await assert.rejects(s.restaurarBackup(ruim), /integridade/);
  assert.deepEqual(contagem(s), antes);
});

test('dados demonstrativos: claramente identificados e removíveis sem afetar dados reais', async () => {
  const s = await novoStore();
  const real = await s.salvarFuncionario(funcionaria());
  const demo = await s.criarDemo();
  assert.equal(demo.demo, true);
  assert.match(demo.nome, /EXEMPLO/);
  assert.ok(s.efetivas(demo.id).length > 0);
  assert.ok(s.efetivas(demo.id).every((m) => m.origem === 'exemplo'));
  await s.removerDemo();
  assert.equal(s.funcionario(demo.id), null);
  assert.equal(s.all('marcacoes').filter((m) => m.employeeId === demo.id).length, 0);
  assert.ok(s.funcionario(real.id));
});

test('erros de regra usam ErroRegra (mensagem amigável para a interface)', async () => {
  const s = await novoStore();
  try { await s.salvarFuncionario({ nome: 'x' }); assert.fail('deveria falhar'); }
  catch (e) { assert.ok(e instanceof ErroRegra); }
});

// ------------------------------------------------------------------ concorrência / modo somente leitura
test('somente leitura: Store e adaptador recusam todas as operações de escrita', async () => {
  const adapter = new MemoryAdapter();
  const editor = await novoStore(adapter, '2026-04-10');
  const f = await editor.salvarFuncionario(funcionaria());
  await preencherMes(editor, f.id, '2026-03');
  // cada aba tem seu próprio adaptador sobre o mesmo banco: Object.create compartilha os dados
  const leitor = await new Store(Object.create(adapter), { editavel: false, hoje: () => '2026-04-10' }).init();
  const backupValido = await editor.exportarBackup(); // gerado pelo editor antes do instantâneo
  await leitor.recarregar();
  const antes = JSON.stringify(leitor.dadosCompletos());
  const ref = leitor.efetivas(f.id)[0].ref;
  const tentativas = {
    salvarFuncionario: () => leitor.salvarFuncionario(Object.assign(leitor.funcionario(f.id), { cargo: 'x' })),
    incluirMarcacao: () => leitor.incluirMarcacao(f.id, '2026-03-02 20:00', 'teste'),
    alterarMarcacao: () => leitor.alterarMarcacao(f.id, ref, '2026-03-02 08:00', 'teste'),
    desconsiderarMarcacao: () => leitor.desconsiderarMarcacao(f.id, ref, 'teste'),
    registrarEvento: () => leitor.registrarEvento({ employeeId: null, data: '2026-03-02', tipo: 'feriado' }),
    lancarBanco: () => leitor.lancarBanco({ employeeId: f.id, data: '2026-03-02', tipo: 'ajuste', minutos: 10, justificativa: 'teste' }),
    fechar: () => leitor.fechar(f.id, '2026-03'),
    reabrir: () => leitor.reabrir(f.id, '2026-03', 'teste'),
    restaurarBackup: () => leitor.restaurarBackup(backupValido),
    removerDemo: () => leitor.removerDemo(),
    _commit: () => leitor._commit([{ op: 'put', store: 'config', value: { id: 'x' } }]),
    adaptador: () => leitor.db.write([{ op: 'clear', store: 'marcacoes' }])
  };
  for (const [nome, fn] of Object.entries(tentativas)) {
    await assert.rejects(fn(), /somente leitura/, nome);
  }
  await leitor.recarregar();
  assert.equal(JSON.stringify(leitor.dadosCompletos()), antes);
  assert.equal(leitor.all('marcacoes').length, 0); // marcações manuais ficam em "ajustes"
  assert.equal(leitor.all('ajustes').length, 88);
  // exportar backup é permitido em leitura, sem registrar a data do backup
  const b = await leitor.exportarBackup();
  assert.equal(b.naoRegistrado, true);
});

test('somente leitura -> editor: definirEscrita recarrega os dados antes de gravar', async () => {
  const adapter = new MemoryAdapter();
  const editor = await novoStore(adapter);
  const leitor = await new Store(Object.create(adapter), { editavel: false }).init();
  const f = await editor.salvarFuncionario(funcionaria());
  assert.equal(leitor.funcionario(f.id), null); // memória do leitor desatualizada
  await leitor.definirEscrita(true);
  assert.ok(leitor.funcionario(f.id));
  await leitor.incluirMarcacao(f.id, '2026-03-02 09:00', 'agora pode');
  assert.equal(leitor.efetivas(f.id).length, 1);
});

test('fila de escrita: operações simultâneas na mesma aba não duplicam nem se perdem', async () => {
  const s = await novoStore();
  const f = await s.salvarFuncionario(funcionaria());
  const mesmas = await Promise.allSettled(Array.from({ length: 10 }, () => s.incluirMarcacao(f.id, '2026-03-02 12:00', 'simultânea')));
  assert.equal(mesmas.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(s.efetivas(f.id).filter((m) => m.dt === '2026-03-02 12:00').length, 1);
  const distintas = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => s.incluirMarcacao(f.id, '2026-03-03 ' + U.pad2(8 + i) + ':00', 'distinta')));
  assert.ok(distintas.every((r) => r.status === 'fulfilled'));
  assert.equal(s.efetivas(f.id).filter((m) => m.dataRef === '2026-03-03').length, 10);
  // um erro na fila não trava as operações seguintes
  await assert.rejects(s.incluirMarcacao(f.id, 'data inválida', 'x'));
  await s.incluirMarcacao(f.id, '2026-03-04 09:00', 'depois do erro');
  assert.equal(s.escritasPendentes, 0);
  // fechamento chama recálculo internamente sem travar a fila
  const s2 = await novoStore(null, '2026-04-10');
  const g = await s2.salvarFuncionario(funcionaria({ banco: { compInicial: '2026-03', saldoInicialMin: 0 } }));
  await preencherMes(s2, g.id, '2026-03');
  const r = await Promise.race([s2.fechar(g.id, '2026-03'), new Promise((_, rej) => setTimeout(() => rej(new Error('travou')), 3000))]);
  assert.ok(r.fechamento);
  await s2.criarDemo(); // criarDemo chama salvarFuncionario internamente
  assert.ok(s2.temDemo());
});

test('fila de escrita: backup exportado junto com uma gravação não perde a alteração no contador', async () => {
  const s = await novoStore();
  const f = await s.salvarFuncionario(funcionaria());
  await s.exportarBackup();
  // exportação e inclusão disparadas ao mesmo tempo: a inclusão fica fora do arquivo,
  // então o contador de alterações sem backup tem de continuar marcando 1
  const [b] = await Promise.all([s.exportarBackup(), s.incluirMarcacao(f.id, '2026-03-02 09:00', 'simultânea ao backup')]);
  assert.equal(b.dados.ajustes.length, 0);
  assert.equal(s.all('ajustes').length, 1);
  assert.equal(s.sistema().alteracoesDesdeBackup, 1);
  assert.equal((await s.db.get('config', 'sistema')).alteracoesDesdeBackup, 1);
  assert.equal(s.escritasPendentes, 0);
});

test('somente leitura -> editor: se a recarga falhar, a aba continua recusando gravações', async () => {
  const base = new MemoryAdapter();
  await novoStore(base);
  const vista = Object.create(base); // visão própria desta aba sobre o mesmo armazenamento
  const leitor = await new Store(vista, { editavel: false }).init();
  vista.getAll = async () => { throw new Error('falha simulada de leitura'); };
  await assert.rejects(leitor.definirEscrita(true), /falha simulada/);
  assert.equal(leitor.editavel, false);
  await assert.rejects(leitor.salvarEmpregador({ nome: 'Empresa Fictícia' }), /somente leitura/);
  await assert.rejects(vista.write([{ op: 'put', store: 'config', value: { id: 'x' } }]), /somente leitura/);
  assert.equal(await base.get('config', 'empregador'), null);
});

test('envio ao Drive: backup só é registrado após confirmação e desconta só o que estava no arquivo', async () => {
  const s = await novoStore();
  const f = await s.salvarFuncionario(funcionaria());
  await s.incluirMarcacao(f.id, '2026-03-02 09:00', 'antes do envio');
  const antes = s.sistema();
  assert.equal(antes.alteracoesDesdeBackup, 2);
  // gerar não registra nada (nem data, nem contador, nem auditoria)
  const auditAntes = s.all('auditoria').length;
  const { backup, marco } = await s.gerarBackupParaEnvio();
  assert.equal(backup.formato, 'gerenciador-ponto-backup');
  assert.equal((await require('../js/backup.js').validar(JSON.parse(JSON.stringify(backup)))).ok, true);
  assert.deepEqual(marco, { alteracoes: 2, ultimoBackupEm: null, restauradoEm: null });
  assert.equal(s.sistema().ultimoBackupEm || null, null);
  assert.equal(s.sistema().alteracoesDesdeBackup, 2);
  assert.equal(s.all('auditoria').length, auditAntes);
  // alteração feita durante o envio: não está no arquivo e deve continuar contando
  await s.incluirMarcacao(f.id, '2026-03-02 12:00', 'durante o envio');
  // sem confirmação do Drive (sem id): recusado, nada muda
  await assert.rejects(s.registrarEnvioDrive(backup, marco, null), /não confirmou/);
  await assert.rejects(s.registrarEnvioDrive(backup, marco, { name: 'x' }), /não confirmou/);
  assert.equal(s.sistema().alteracoesDesdeBackup, 3);
  const sis = await s.registrarEnvioDrive(backup, marco, { id: 'arquivo-ficticio-1', name: 'backup-ponto_teste.json', size: '123' });
  assert.equal(sis.alteracoesDesdeBackup, 1);
  assert.equal(sis.ultimoBackupEm, backup.geradoEm);
  const aud = s.all('auditoria').filter((a) => a.acao === 'backup-enviado-drive');
  assert.equal(aud.length, 1);
  assert.equal(aud[0].detalhes.arquivoId, 'arquivo-ficticio-1');
  assert.equal((await s.db.get('config', 'sistema')).alteracoesDesdeBackup, 1);
});

test('envio ao Drive: outro backup ou restauração durante o envio não é sobrescrito', async () => {
  const s = await novoStore();
  const f = await s.salvarFuncionario(funcionaria());
  const env1 = await s.gerarBackupParaEnvio();
  const local = await s.exportarBackup(); // backup local mais novo registrado durante o envio
  await s.incluirMarcacao(f.id, '2026-03-02 09:00', 'depois do backup local');
  await s.registrarEnvioDrive(env1.backup, env1.marco, { id: 'a1', name: 'a1.json' });
  assert.equal(s.sistema().ultimoBackupEm, local.geradoEm);
  assert.equal(s.sistema().alteracoesDesdeBackup, 1); // a alteração posterior continua contando
  assert.equal(s.all('auditoria').filter((a) => a.acao === 'backup-enviado-drive').length, 1);
  const env2 = await s.gerarBackupParaEnvio();
  await s.restaurarBackup(JSON.parse(JSON.stringify(local)));
  await s.incluirMarcacao(f.id, '2026-03-03 09:00', 'depois da restauração');
  await s.registrarEnvioDrive(env2.backup, env2.marco, { id: 'a2', name: 'a2.json' });
  assert.equal(s.sistema().alteracoesDesdeBackup, 1);
});

test('envio ao Drive: aba de leitura gera o backup, mas não registra o envio', async () => {
  const adapter = new MemoryAdapter();
  const editor = await novoStore(adapter);
  await editor.salvarFuncionario(funcionaria());
  const leitor = await new Store(Object.create(adapter), { editavel: false }).init();
  const { backup, marco } = await leitor.gerarBackupParaEnvio();
  assert.equal(backup.dados.funcionarios.length, 1);
  await assert.rejects(leitor.registrarEnvioDrive(backup, marco, { id: 'x', name: 'x.json' }), /somente leitura/);
  assert.equal(leitor.escritasPendentes, 0);
  assert.equal((await adapter.get('config', 'sistema')).alteracoesDesdeBackup, 1);
});
