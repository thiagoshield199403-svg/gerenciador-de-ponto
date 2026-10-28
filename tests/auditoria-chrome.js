/*
 * Auditoria de preservação de dados no navegador real (Chrome/Edge headless).
 * Cada cenário usa um PERFIL TEMPORÁRIO próprio: não toca no armazenamento do usuário.
 * Usa apenas dados fictícios.
 *
 * Executar:  node tests/auditoria-chrome.js
 */
'use strict';
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RAIZ = path.resolve(__dirname, '..');
const SAIDA = path.join(__dirname, 'saida', 'auditoria');
const URL_APP = 'file:///' + path.join(RAIZ, 'index.html').replace(/\\/g, '/');
const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'ARQUIVO-DE-TESTE_NAO-E-DO-RELOGIO.csv'), 'utf8');
const EXE = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean).find((p) => fs.existsSync(p));
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

const res = [];
let falhas = 0;
function reg(nome, cond, detalhe) {
  const linha = (cond === null ? '• ' : cond ? '✔ ' : '✘ ') + nome + (detalhe ? ' — ' + detalhe : '');
  res.push(linha); console.log(linha);
  if (cond === false) falhas++;
}

// ---------------------------------------------------------------- navegador / páginas
async function navegador(nome) {
  const porta = 9400 + Math.floor(Math.random() * 500);
  const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'ponto-aud-' + nome + '-'));
  const proc = spawn(EXE, ['--headless=new', '--remote-debugging-port=' + porta, '--user-data-dir=' + perfil, '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { await fetch('http://127.0.0.1:' + porta + '/json/version'); break; } catch (e) { await esperar(150); } }
  return {
    porta, perfil,
    async pagina(opts) {
      const r = await fetch('http://127.0.0.1:' + porta + '/json/new?about:blank', { method: 'PUT' });
      const alvo = await r.json();
      const pg = await Pagina.conectar(alvo.webSocketDebuggerUrl, opts || {});
      pg.fecharAba = async () => { pg.fechar(); await fetch('http://127.0.0.1:' + porta + '/json/close/' + alvo.id); };
      return pg;
    },
    async fechar() { proc.kill(); await esperar(600); try { fs.rmSync(perfil, { recursive: true, force: true }); } catch (e) { /* em uso */ } }
  };
}

class Pagina {
  static async conectar(url, opts) {
    const p = new Pagina();
    p.ws = new WebSocket(url); p.seq = 0; p.pend = new Map(); p.errosJS = []; p.dialogos = [];
    await new Promise((ok, err) => { p.ws.onopen = ok; p.ws.onerror = err; });
    p.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && p.pend.has(m.id)) { const x = p.pend.get(m.id); p.pend.delete(m.id); m.error ? x.rej(new Error(m.error.message)) : x.res(m.result); }
      else if (m.method === 'Runtime.exceptionThrown') p.errosJS.push(m.params.exceptionDetails.text + ' ' + (m.params.exceptionDetails.exception || {}).description);
      else if (m.method === 'Page.javascriptDialogOpening') { p.dialogos.push(m.params.type); p.cdp('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}); }
    };
    await p.cdp('Runtime.enable'); await p.cdp('Page.enable'); await p.cdp('DOM.enable');
    if (opts.downloads) await p.cdp('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: opts.downloads });
    if (opts.scriptInicial) await p.cdp('Page.addScriptToEvaluateOnNewDocument', { source: opts.scriptInicial });
    return p;
  }
  cdp(method, params) { return new Promise((res2, rej) => { const id = ++this.seq; this.pend.set(id, { res: res2, rej }); this.ws.send(JSON.stringify({ id, method, params: params || {} })); }); }
  async js(expr) {
    const r = await this.cdp('Runtime.evaluate', { expression: '(async () => { ' + expr + ' })()', awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('JS: ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text));
    return r.result.value;
  }
  async aguardar(expr, desc, ms) {
    const fim = Date.now() + (ms || 8000);
    while (Date.now() < fim) { try { if (await this.js('return !!(' + expr + ')')) return true; } catch (e) { /* carregando */ } await esperar(100); }
    throw new Error('Tempo esgotado: ' + (desc || expr));
  }
  async abrir() { await this.cdp('Page.navigate', { url: URL_APP }); await this.aguardar('window.Ponto && Ponto.app && (Ponto.app.pronto || document.querySelector(".erro-fatal"))', 'inicialização'); }
  async recarregar() { await this.js('window.__paginaAntiga = true; return true;'); await this.cdp('Page.reload', { ignoreCache: true }); await this.aguardar('!window.__paginaAntiga && window.Ponto && Ponto.app && Ponto.app.pronto', 'recarga'); }
  async arquivo(sel, caminho) {
    const doc = await this.cdp('DOM.getDocument', { depth: -1 });
    const q = await this.cdp('DOM.querySelector', { nodeId: doc.root.nodeId, selector: sel });
    await this.cdp('DOM.setFileInputFiles', { nodeId: q.nodeId, files: [caminho] });
  }
  fechar() { try { this.ws.close(); } catch (e) { /* */ } }
}

// Instantâneo comparável de todas as coleções (exclui contadores de backup e o registro da própria restauração)
const SNAP = `const s = Ponto.app.store; const d = s.dadosCompletos();
  d.config = d.config.filter(c => c.id !== 'sistema');
  d.auditoria = d.auditoria.filter(a => a.acao !== 'backup-restaurado' && a.acao !== 'backup-exportado');
  for (const k in d) d[k].sort((a, b) => a.id < b.id ? -1 : 1);
  return JSON.stringify(d);`;

// ---------------------------------------------------------------- cenário de dados fictícios completos
const POPULAR = (csv) => `
  const s = Ponto.app.store, C = Ponto.calc, U = Ponto.util;
  await s.salvarEmpregador({ nome: 'LOJA FICTÍCIA DE TESTE LTDA', documento: '00.000.000/0000-00', endereco: 'Rua de Teste, 0', responsavel: 'Responsável Fictício' });
  await s.salvarPolitica({ creditosNoBanco: true, debitosNoBanco: true, limitePositivoMin: 2400, limiteNegativoMin: 600, observacao: 'política fictícia' });
  const semana = C.semanaExemplo(); semana[6] = { folga: false, periodos: [{ ini: '08:00', fim: '12:00' }] };
  const f = await s.salvarFuncionario({ nome: 'PESSOA FICTÍCIA DE AUDITORIA', cpf: '529.982.247-25', cargo: 'Vendedora (teste)', admissao: '2026-02-01',
    salario: 1234.56, codigoRelogio: '1001', regime: 'CLT — teste', cargaSemanalMin: 2640, observacoes: 'dados fictícios',
    jornada: { semana, regras: { toleranciaDiariaMin: 5 } }, banco: { compInicial: '2026-02', saldoInicialMin: 330 } });
  const f2 = await s.salvarFuncionario({ nome: 'SEGUNDA PESSOA FICTÍCIA', cargo: 'Caixa (teste)', admissao: '2026-01-01', codigoRelogio: '2002', jornada: { semana: C.semanaExemplo(), regras: {} } });
  await s.inativarFuncionario(f2.id, 'inativação fictícia de teste', '2026-02-28');
  // fevereiro: marcações completas + 1 dia corrigido
  for (const d of U.compDays('2026-02')) { const wd = U.weekday(d); if (wd === 0) continue;
    const hs = wd === 6 ? ['08:00', '12:00'] : ['09:00', '12:00', '14:00', d === '2026-02-10' ? '20:00' : '19:00'];
    for (const h of hs) await s.incluirMarcacao(f.id, d + ' ' + h, 'lançamento fictício'); }
  await s.registrarEvento({ employeeId: null, data: '2026-02-16', tipo: 'feriado', descricao: 'feriado fictício' });
  for (const d of s.apurarMes(f.id, '2026-02').dias) if (d.pendente && !d.ocorrencias.some(o => o.nivel === 'erro')) await s.conferirDia(f.id, d.data, 'conferência fictícia');
  await s.fechar(f.id, '2026-02', 'fechamento fictício');
  // março: importação + correções + ocorrências + lançamentos
  const prep = await s.prepararImportacao('ARQUIVO-DE-TESTE_NAO-E-DO-RELOGIO.csv', new TextEncoder().encode(${JSON.stringify(csv)}));
  await s.salvarPerfilImportacao('Perfil fictício', prep.sugestao);
  await s.confirmarImportacao(s.previaImportacao(prep, prep.sugestao, null), { teste: true, observacao: 'auditoria' });
  const ef = s.efetivas(f.id);
  const p0902 = ef.find(m => m.dt === '2026-03-02 09:00');
  await s.alterarMarcacao(f.id, p0902.ref, '2026-03-02 09:10', 'correção fictícia');
  const inc = await s.incluirMarcacao(f.id, '2026-03-05 19:00', 'saída esquecida (fictício)');
  const p1303 = ef.find(m => m.dt === '2026-03-03 19:30');
  await s.desconsiderarMarcacao(f.id, p1303.ref, 'exclusão fictícia');
  await s.restaurarMarcacao(f.id, p1303.ref, 'restauração fictícia');
  await s.registrarEvento({ employeeId: f.id, data: '2026-03-06', tipo: 'falta', descricao: 'falta fictícia' });
  await s.registrarEvento({ employeeId: f.id, data: '2026-03-09', tipo: 'abono', minutos: 60, descricao: 'abono fictício' });
  const evC = await s.registrarEvento({ employeeId: f.id, data: '2026-03-10', tipo: 'falta', descricao: 'será cancelada' });
  await s.cancelarEvento(evC[0].id, 'cancelamento fictício');
  for (const d of s.apurarMes(f.id, '2026-03').dias) if (d.ocorrencias.some(o => o.codigo === 'SEM_MARCACAO')) await s.registrarEvento({ employeeId: f.id, data: d.data, tipo: 'atestado', descricao: 'atestado fictício' });
  for (const d of s.apurarMes(f.id, '2026-03').dias) if (d.pendente && !d.ocorrencias.some(o => o.nivel === 'erro')) await s.conferirDia(f.id, d.data, 'conferência fictícia');
  await s.salvarObservacaoDia(f.id, '2026-03-04', 'observação fictícia');
  const l = await s.lancarBanco({ employeeId: f.id, data: '2026-03-20', tipo: 'compensacao', minutos: -60, justificativa: 'compensação fictícia' });
  const l2 = await s.lancarBanco({ employeeId: f.id, data: '2026-03-21', tipo: 'ajuste', minutos: 15, justificativa: 'ajuste fictício' });
  await s.cancelarLancamento(l2.id, 'cancelamento fictício');
  await s.fechar(f.id, '2026-03', 'fechamento fictício de março');
  await s.reabrir(f.id, '2026-02', 'reabertura fictícia');
  await s.lancarBanco({ employeeId: f.id, data: '2026-02-27', tipo: 'ajuste', minutos: 30, justificativa: 'ajuste retroativo fictício' });
  await s.fechar(f.id, '2026-02', 'refechamento fictício');
  Ponto.app.selecionarFuncionario(f.id); Ponto.app.state.comp = '2026-03'; Ponto.app.render();
  return f.id;`;

const RESUMO = (empId) => `const s = Ponto.app.store, id = ${JSON.stringify(empId)};
  return JSON.stringify({ extrato: s.extrato(id, '2026-04').map(l => [l.comp, l.saldoAnteriorMin, l.saldoFinalMin, l.fechada, !!l.divergencia]),
    fev: s.fechamento(id, '2026-02').historico.map(h => h.acao), mar: s.fechamento(id, '2026-03').historico.map(h => h.acao),
    espelhoMar: s.competencia(id, '2026-03').apuracao.dias.map(d => [d.data, d.saldoMin, d.marcacoes.map(m => m.dt + m.origem + (m.ajustada ? '*' : '')).join(',')]).join(';'),
    historico: s.historicoMarcacao(id, s.efetivas(id).find(m => m.original && m.original.dt === '2026-03-02 09:00').ref).ajustes.map(a => a.tipo + ':' + a.justificativa) });`;

async function main() {
  if (!EXE) { console.error('Chrome/Edge não encontrado.'); process.exit(2); }
  fs.rmSync(SAIDA, { recursive: true, force: true }); fs.mkdirSync(SAIDA, { recursive: true });
  const dl = path.join(SAIDA, 'downloads'); fs.mkdirSync(dl);
  let empId, snapA, resumoA, arqBackup;

  // ============================================================ 1-3. Perfil A: dados completos, aviso, exportação
  console.log('\n== Perfil A: popular dados fictícios, aviso de backup, exportação ==');
  const A = await navegador('A');
  try {
    const p = await A.pagina({ downloads: dl });
    await p.abrir();
    empId = await p.js(POPULAR(FIXTURE));
    const cont = JSON.parse(await p.js('return JSON.stringify(Object.fromEntries(Ponto.db.STORES.map(s => [s, Ponto.app.store.all(s).length])))'));
    reg('Dados fictícios criados em todas as coleções', Ponto_todas(cont), JSON.stringify(cont));
    await p.js('Ponto.app.render(); return true;');
    const aviso1 = await p.js('const a = document.querySelector("#aviso-backup"); return a.hidden ? null : a.textContent.trim()');
    reg('Aviso aparece quando há alterações e nunca houve backup', !!aviso1, aviso1);
    await p.recarregar();
    const aviso2 = await p.js('const a = document.querySelector("#aviso-backup"); return a.hidden ? null : a.textContent.trim()');
    reg('Aviso continua após recarregar (contador gravado no IndexedDB)', aviso2 === aviso1, aviso2);
    snapA = await p.js(SNAP);
    resumoA = await p.js(RESUMO(empId));
    // exportação pelo botão
    await p.js('location.hash = "#/backup"; return true;');
    await p.aguardar('document.querySelector("#exportar")');
    await p.js('document.querySelector("#exportar").click(); return true;');
    for (let i = 0; i < 60 && !arqBackup; i++) { await esperar(100); arqBackup = fs.readdirSync(dl).find((f) => /^backup-ponto_.*\.json$/.test(f) && !f.endsWith('.crdownload')); }
    reg('Backup exportado pelo botão gera arquivo', !!arqBackup, arqBackup);
    await esperar(300);
    const aviso3 = await p.js('const a = document.querySelector("#aviso-backup"); return a.hidden');
    reg('Aviso some após exportar', aviso3);
    await p.recarregar();
    reg('Aviso permanece oculto após recarregar', await p.js('return document.querySelector("#aviso-backup").hidden'));
    // regra atual: após um backup, o aviso só volta com 7 dias ou 50 alterações
    await p.js(`await Ponto.app.store.salvarObservacaoDia(${JSON.stringify(empId)}, '2026-04-01', 'alteração após o backup'); Ponto.app.render(); return true;`);
    const cnt = await p.js('return Ponto.app.store.sistema().alteracoesDesdeBackup');
    const oculto = await p.js('return document.querySelector("#aviso-backup").hidden');
    reg('Alteração após o backup é contada', cnt === 1, 'alteracoesDesdeBackup=' + cnt);
    reg('OBSERVAÇÃO: com 1 alteração pós-backup o aviso no topo fica oculto (regra: ≥7 dias ou ≥50 alterações); a tela Backup mostra o contador', null, 'aviso oculto=' + oculto);
    const naBackup = await p.js('location.hash = "#/painel"; await new Promise(r => setTimeout(r, 100)); return document.querySelector("#view").innerText.includes("1 alteração(ões) desde então")');
    reg('Painel mostra "1 alteração(ões) desde então"', naBackup);
    reg('Sem erros de JavaScript no perfil A', p.errosJS.length === 0, p.errosJS.join(' | '));
    p.fechar();
  } finally { await A.fechar(); }

  // ============================================================ 2. conteúdo do backup
  console.log('\n== Conteúdo do arquivo de backup ==');
  const bk = JSON.parse(fs.readFileSync(path.join(dl, arqBackup), 'utf8'));
  const D = bk.dados;
  const f = D.funcionarios.find((x) => x.id === empId);
  reg('Funcionários (inclusive inativos) com jornada e regras', D.funcionarios.length === 2 && f.jornada.semana[6].periodos[0].ini === '08:00' && f.jornada.regras.toleranciaDiariaMin === 5 && D.funcionarios.some((x) => x.situacao === 'inativo'));
  reg('Saldo inicial do banco e dados cadastrais', f.banco.saldoInicialMin === 330 && f.salario === 1234.56 && f.cpf === '52998224725');
  reg('Marcações originais preservadas (incluindo a que foi corrigida)', D.marcacoes.some((m) => m.dt === '2026-03-02 09:00') && D.marcacoes.length === 15);
  const tipos = [...new Set(D.ajustes.map((a) => a.tipo))].sort().join(',');
  reg('Correções com justificativas (inclusão, alteração, exclusão, restauração)', tipos === 'alteracao,desconsiderar,inclusao,restaurar' && D.ajustes.every((a) => a.justificativa), tipos + ' · ' + D.ajustes.length + ' ajustes');
  reg('Ocorrências, inclusive canceladas e feriado geral', D.eventos.some((e) => e.cancelado) && D.eventos.some((e) => e.employeeId === null));
  reg('Lançamentos do banco (inclusive cancelado)', D.lancamentos.length === 3 && D.lancamentos.some((l) => l.cancelado));
  const fev = D.fechamentos.find((x) => x.comp === '2026-02');
  reg('Fechamentos com dados congelados e histórico (fechar/reabrir/recalcular)', D.fechamentos.length === 2 && fev.historico.map((h) => h.acao).join(',') === 'fechamento,reabertura,fechamento' && Array.isArray(fev.snapshot.dias) && D.fechamentos.find((x) => x.comp === '2026-03').historico.some((h) => h.acao === 'recalculo-saldo'));
  reg('Conferências e observações', D.conferencias.length > 0 && D.conferencias.some((c) => c.obs === 'observação fictícia'));
  reg('Arquivo importado original (bytes) e metadados', D.importacoes.length === 1 && Buffer.from(D.importacoes[0].conteudoBase64, 'base64').toString('utf8') === FIXTURE);
  reg('Configurações: empregador, política e perfil de importação', ['empregador', 'politica', 'perfisImportacao'].every((id) => D.config.some((c) => c.id === id)));
  reg('Histórico de alterações (auditoria)', D.auditoria.length > 50, D.auditoria.length + ' registros');
  const hash = crypto.createHash('sha256').update(JSON.stringify(D)).digest('hex');
  reg('Hash SHA-256 confere com cálculo independente (Node)', hash === bk.integridade.hash, hash.slice(0, 16) + '…');
  reg('OBSERVAÇÃO: não entram no backup as preferências da tela (funcionário/mês selecionados, localStorage) e as cópias de segurança internas — por projeto', null);

  // ============================================================ 1 e 6. Perfil B limpo: inválidos não alteram; restauração completa
  console.log('\n== Perfil B (limpo): backups inválidos e restauração completa ==');
  const B = await navegador('B');
  try {
    const p = await B.pagina();
    await p.abrir();
    // dados fictícios mínimos que NÃO podem ser perdidos por um backup inválido
    await p.js(`await Ponto.app.store.salvarFuncionario({ nome: 'PESSOA FICTÍCIA DO PERFIL B', admissao: '2026-01-01', jornada: { semana: Ponto.calc.semanaExemplo(), regras: {} } }); return true;`);
    const antes = await p.js(SNAP);
    const invalidos = [];
    const escrever = (nome, conteudo) => { const c = path.join(SAIDA, nome); fs.writeFileSync(c, conteudo); invalidos.push([nome, c]); };
    escrever('invalido-json-quebrado.json', JSON.stringify(bk).slice(0, 5000));
    escrever('invalido-outro-formato.json', JSON.stringify({ qualquer: 'coisa' }));
    const t1 = JSON.parse(JSON.stringify(bk)); t1.dados.marcacoes[0].dt = '2026-03-02 05:00'; escrever('invalido-adulterado.json', JSON.stringify(t1));
    // estrutura inválida com hash RECALCULADO (passa na integridade, falha nas regras)
    const t2 = JSON.parse(JSON.stringify(bk)); t2.dados.marcacoes[0].employeeId = 'inexistente';
    t2.integridade.hash = crypto.createHash('sha256').update(JSON.stringify(t2.dados)).digest('hex'); escrever('invalido-referencia-hash-ok.json', JSON.stringify(t2));
    const t3 = JSON.parse(JSON.stringify(bk)); t3.versaoFormato = 99; escrever('invalido-versao-futura.json', JSON.stringify(t3));
    const t4 = JSON.parse(JSON.stringify(bk)); delete t4.dados.ajustes; escrever('invalido-colecao-ausente.json', JSON.stringify(t4));
    await p.js('location.hash = "#/backup"; return true;');
    await p.aguardar('document.querySelector("#arq-backup")');
    for (const [nome, cam] of invalidos) {
      await p.js('const r = document.querySelector("#resultado-validacao"); if (r) r.innerHTML = ""; return true;');
      await p.arquivo('#arq-backup', cam);
      await p.aguardar('document.querySelector("#resultado-validacao .faixa")', 'validação ' + nome);
      const recusado = await p.js('return document.querySelector("#resultado-validacao .faixa.erro") !== null && !document.querySelector("#restaurar")');
      const msg = await p.js('return document.querySelector("#resultado-validacao").innerText.split("\\n").slice(1,2).join(" ")');
      reg('Recusado pela interface: ' + nome, recusado, msg);
      // tentativa direta pela API também é recusada
      const api = await p.js(`try { await Ponto.app.store.restaurarBackup(${fs.readFileSync(cam, 'utf8').startsWith('{"formato') && nome !== 'invalido-json-quebrado.json' ? fs.readFileSync(cam, 'utf8') : '{"x":1}'}); return 'restaurou'; } catch (e) { return 'recusou'; }`);
      reg('Recusado pela API: ' + nome, api === 'recusou');
    }
    await p.recarregar();
    reg('Dados existentes intactos após os 6 backups inválidos (inclusive após recarregar)', (await p.js(SNAP)) === antes);
    reg('Nenhuma cópia de segurança criada por backups inválidos', (await p.js('return (await Ponto.app.store.copiasSeguranca()).length')) === 0);
    // restauração válida no perfil limpo
    await p.js('location.hash = "#/backup"; return true;');
    await p.aguardar('document.querySelector("#arq-backup")');
    await p.arquivo('#arq-backup', path.join(dl, arqBackup));
    await p.aguardar('document.querySelector("#restaurar")', 'backup válido');
    await p.js('document.querySelector("#restaurar").click(); return true;');
    await p.aguardar('document.querySelector("dialog.modal [name=conf]")');
    await p.js('const d = document.querySelector("dialog.modal"); d.querySelector("[name=conf]").value = "RESTAURAR"; d.querySelector("footer button.perigo").click(); return true;');
    await p.aguardar('Ponto.app.store.funcionarios().length === 2', 'restauração');
    await p.recarregar();
    const snapB = await p.js(SNAP);
    reg('Restauração em perfil limpo: TODAS as coleções idênticas ao perfil de origem', snapB === snapA, snapB === snapA ? snapA.length + ' caracteres comparados' : diff(snapA, snapB));
    const resumoB = await p.js(RESUMO(empId));
    reg('Extrato do banco, fechamentos, espelho e histórico de correções idênticos', resumoB === resumoA, JSON.parse(resumoB).extrato.map((l) => l[0] + ':' + l[2]).join(' '));
    reg('Funcionário restaurado do perfil B foi substituído (restauração substitui, não mistura)', await p.js('return !Ponto.app.store.funcionarios().some(f => f.nome === "PESSOA FICTÍCIA DO PERFIL B")'));
    reg('Cópia de segurança interna do estado anterior do perfil B', (await p.js('return (await Ponto.app.store.copiasSeguranca()).length')) === 1);
    // restaurar novamente o mesmo backup: não duplica
    const dupl = await p.js(`const s = Ponto.app.store; const n1 = Ponto.db.STORES.map(k => s.all(k).length).join(','); await s.restaurarBackup(${fs.readFileSync(path.join(dl, arqBackup), 'utf8')}); const n2 = Ponto.db.STORES.map(k => s.all(k).length).join(','); return [n1, n2];`);
    reg('Restaurar o mesmo backup duas vezes não duplica registros', dupl[0] === dupl[1], dupl[1]);
    reg('Sem erros de JavaScript no perfil B', p.errosJS.length === 0, p.errosJS.join(' | '));

    // ---- atomicidade do adaptador IndexedDB quando uma operação do lote falha
    console.log('\n== Atomicidade da gravação (falha no meio de um lote) ==');
    const nEv = await p.js('return Ponto.app.store.all("eventos").length');
    const r = await p.js(`try { await Ponto.app.store.db.write([{ op: 'clear', store: 'eventos' }, { op: 'put', store: 'eventos', value: { semId: true } }]); return 'gravou'; } catch (e) { return 'erro: ' + e.name; }`);
    await p.recarregar();
    const nEv2 = await p.js('return Ponto.app.store.all("eventos").length');
    reg('Lote com operação inválida não apaga dados já existentes', nEv2 === nEv, 'eventos antes=' + nEv + ', depois=' + nEv2 + ' (' + r + ')');
    p.fechar();
  } finally { await B.fechar(); }

  // ============================================================ 4. armazenamento persistente / falhas do IndexedDB
  console.log('\n== Armazenamento persistente e falhas do IndexedDB ==');
  const Cn = await navegador('C');
  try {
    const p = await Cn.pagina();
    await p.abrir();
    const pers = await p.js('return String(Ponto.app.armazenamento.persistente)');
    const lateral = await p.js('return document.querySelector("#status-armazenamento").innerText.replace(/\\n/g, " ")');
    reg('Persistência negada é informada na lateral', pers !== 'true' && /não persistente/.test(lateral), 'persistente=' + pers + ' · "' + lateral + '"');
    await p.js('location.hash = "#/backup"; return true;'); await esperar(200);
    reg('Tela Backup explica o risco quando a persistência não é concedida', await p.js('return document.querySelector("#view").innerText.includes("pode apagar os dados")'));
    reg('Sistema continua funcionando sem persistência (grava e lê após recarregar)', await (async () => {
      await p.js(`await Ponto.app.store.salvarFuncionario({ nome: 'PESSOA FICTÍCIA C', admissao: '2026-01-01', jornada: { semana: Ponto.calc.semanaExemplo(), regras: {} } }); return true;`);
      await p.recarregar(); return p.js('return Ponto.app.store.funcionarios().length === 1');
    })());
    // falha de gravação em operação normal
    const antes = await p.js(SNAP);
    await p.js(`Ponto.app.store.db.write = async () => { throw new DOMException('Simulação de cota excedida', 'QuotaExceededError'); }; location.hash = '#/config'; return true;`);
    await esperar(200);
    await p.js('const f = document.querySelector("#form-emp"); f.nome.value = "NÃO DEVE SER GRAVADO"; f.requestSubmit(); return true;');
    await p.aguardar('[...document.querySelectorAll("dialog.modal")].some(d => d.innerText.includes("Não foi possível concluir"))', 'mensagem de erro');
    const msg = await p.js('return [...document.querySelectorAll("dialog.modal")].pop().innerText.replace(/\\n+/g, " ")');
    reg('Falha de gravação mostra mensagem clara ao usuário', /Nenhum dado foi alterado/.test(msg), msg.slice(0, 140));
    reg('Memória da página não registra a alteração que falhou', (await p.js('return Ponto.app.store.empregador().nome')) !== 'NÃO DEVE SER GRAVADO');
    await p.recarregar();
    reg('Após recarregar, dados iguais aos de antes da falha', (await p.js(SNAP)) === antes);
    p.fechar();
    // IndexedDB indisponível na abertura
    const p2 = await Cn.pagina({ scriptInicial: `Object.defineProperty(window, 'indexedDB', { get() { return { open() { throw new DOMException('Simulação: IndexedDB bloqueado', 'SecurityError'); } }; } });` });
    await p2.abrir();
    const fatal = await p2.js('const e = document.querySelector(".erro-fatal"); return e ? e.innerText.replace(/\\n+/g, " ") : null');
    reg('IndexedDB indisponível: tela de erro explicativa, sem operar sem armazenamento', !!fatal && /Não foi possível acessar o armazenamento/.test(fatal) && await p2.js('return Ponto.app.store === null'), (fatal || '').slice(0, 120));
    p2.fechar();
    // erro assíncrono na abertura (onerror)
    const p3 = await Cn.pagina({ scriptInicial: `Object.defineProperty(window, 'indexedDB', { get() { return { open() { const r = {}; setTimeout(() => { r.error = new DOMException('falha simulada', 'UnknownError'); r.onerror && r.onerror(); }, 10); return r; } }; } });` });
    await p3.abrir();
    reg('IndexedDB com erro assíncrono na abertura: tela de erro', await p3.js('return document.querySelector(".erro-fatal") !== null'));
    p3.fechar();
  } finally { await Cn.fechar(); }

  await testesDuasAbas();

  console.log('\n' + res.filter((r) => r.startsWith('✔')).length + ' aprovadas, ' + falhas + ' com problema, ' + res.filter((r) => r.startsWith('•')).length + ' observações.');
  fs.writeFileSync(path.join(SAIDA, 'resultado.txt'), res.join('\n') + '\n');
  process.exit(falhas ? 1 : 0);
}

// ================================================================ 5. duas abas (bloqueio de edição)
const MSG_LEITURA = 'O sistema já está aberto em outra aba. Esta aba está em modo somente leitura.';
const ESTADO = 'return JSON.stringify({ modo: Ponto.app.modo, editavel: Ponto.app.editavel, storeEditavel: Ponto.app.store ? Ponto.app.store.editavel : null, aviso: document.querySelector("#aviso-leitura").hidden ? null : document.querySelector("#aviso-leitura").textContent })';
const SEGURADORES = "const q = await navigator.locks.query(); return q.held.filter(l => l.name === 'gerenciador-ponto:editor').length;";
const rejeita = (p, expr) => p.js(`try { ${expr}; return 'GRAVOU'; } catch (e) { return /somente leitura/.test(e.message) ? 'recusado' : 'outro erro: ' + e.message; }`);
const estado = async (p) => JSON.parse(await p.js(ESTADO));

async function testesDuasAbas() {
  console.log('\n== Duas abas: bloqueio de edição (Web Locks) ==');
  const N = await navegador('D');
  try {
    // ---- 1. primeira aba é editora
    const a = await N.pagina(); await a.abrir();
    const ea = await estado(a);
    reg('1. Primeira aba abre com permissão de edição', ea.modo === 'editor' && ea.editavel && ea.storeEditavel && ea.aviso === null, JSON.stringify(ea));
    reg('1. Web Locks disponível via file:// e bloqueio obtido', (await a.js(SEGURADORES)) === 1);
    const id = await a.js(`const s = Ponto.app.store, U = Ponto.util;
      const f = await s.salvarFuncionario({ nome: 'PESSOA FICTÍCIA DAS ABAS', cargo: 'Cargo original', admissao: '2026-02-01', codigoRelogio: '1001',
        jornada: { semana: Ponto.calc.semanaExemplo(), regras: {} }, banco: { compInicial: '2026-02', saldoInicialMin: 0 } });
      for (const d of U.compDays('2026-02')) { const wd = U.weekday(d); if (wd === 0 || wd === 6) continue;
        for (const h of ['09:00', '12:00', '14:00', '19:00']) await s.incluirMarcacao(f.id, d + ' ' + h, 'fictício'); }
      await s.fechar(f.id, '2026-02', 'fictício');
      await s.registrarEvento({ employeeId: null, data: '2026-03-02', tipo: 'feriado', descricao: 'feriado fictício' });
      Ponto.app.selecionarFuncionario(f.id); Ponto.app.state.comp = '2026-03'; Ponto.app.render(); return f.id;`);
    const I = JSON.stringify(id);
    const backupA = await a.js('return JSON.stringify(await Ponto.app.store.exportarBackup())');

    // ---- 2. segunda aba em somente leitura
    const b = await N.pagina(); await b.abrir();
    const eb = await estado(b);
    reg('2. Segunda aba abre em modo somente leitura com o aviso exigido', eb.modo === 'leitura' && !eb.editavel && eb.storeEditavel === false && eb.aviso === MSG_LEITURA, JSON.stringify(eb));
    reg('2. Aba de leitura enxerga os dados gravados pela editora', await b.js(`return !!Ponto.app.store.funcionario(${I})`));
    const snap0 = await a.js(SNAP);

    // ---- 3. camada de dados
    reg('3. Gravação direta no adaptador IndexedDB é recusada', (await rejeita(b, "await Ponto.app.store.db.write([{ op: 'clear', store: 'marcacoes' }])")) === 'recusado');
    reg('3. Gravação direta via _commit é recusada', (await rejeita(b, "await Ponto.app.store._commit([{ op: 'put', store: 'config', value: { id: 'x' } }])")) === 'recusado');

    // ---- 4. editar / excluir
    const ops4 = {
      'editar funcionário': `const f = Ponto.app.store.funcionario(${I}); f.cargo = 'invasor'; await Ponto.app.store.salvarFuncionario(f)`,
      'inativar funcionário': `await Ponto.app.store.inativarFuncionario(${I}, 'teste')`,
      'incluir marcação': `await Ponto.app.store.incluirMarcacao(${I}, '2026-03-03 09:00', 'teste')`,
      'corrigir marcação': `const m = Ponto.app.store.efetivas(${I})[0]; await Ponto.app.store.alterarMarcacao(${I}, m.ref, '2026-02-02 08:00', 'teste')`,
      'excluir marcação': `const m = Ponto.app.store.efetivas(${I})[0]; await Ponto.app.store.desconsiderarMarcacao(${I}, m.ref, 'teste')`,
      'cancelar ocorrência': `await Ponto.app.store.cancelarEvento(Ponto.app.store.eventos({})[0].id, 'teste')`,
      'lançar no banco': `await Ponto.app.store.lancarBanco({ employeeId: ${I}, data: '2026-03-05', tipo: 'ajuste', minutos: 10, justificativa: 'teste' })`,
      'salvar empregador': `await Ponto.app.store.salvarEmpregador({ nome: 'x' })`,
      'remover dados de exemplo': `await Ponto.app.store.removerDemo()`
    };
    const r4 = {};
    for (const [k, e] of Object.entries(ops4)) r4[k] = await rejeita(b, e);
    reg('4. Aba de leitura não edita nem exclui pela camada de negócio', Object.values(r4).every((v) => v === 'recusado'), JSON.stringify(r4));
    await b.js('Ponto.app.state.comp = "2026-02"; location.hash = "#/marcacoes"; Ponto.app.render(); return true;'); await esperar(200);
    const u4 = JSON.parse(await b.js(`return JSON.stringify({ incluir: document.querySelector('#incluir') ? document.querySelector('#incluir').disabled : 'ausente', filtro: document.querySelector('#filtro').disabled })`));
    await b.js('document.querySelector("tr[data-dia=\\"2026-02-03\\"]").click(); return true;');
    await b.aguardar('document.querySelector("dialog.modal [data-a=hist]")');
    const m4 = JSON.parse(await b.js(`const d = document.querySelector('dialog.modal'); return JSON.stringify({ hist: d.querySelector('[data-a=hist]').disabled, fechar: d.querySelector('footer [data-a=fechar]').disabled, escrita: [...d.querySelectorAll('button')].filter(x => !x.closest('[data-leitura]')).map(x => x.textContent.trim() + ':' + x.disabled) })`));
    await b.js('document.querySelectorAll("dialog.modal").forEach(d => { d.close(); d.remove(); }); return true;');
    reg('4. Interface: competência fechada não mostra "Incluir"; filtro de consulta ativo', (u4.incluir === true || u4.incluir === 'ausente') && u4.filtro === false, JSON.stringify(u4));
    await b.js('Ponto.app.state.comp = "2026-03"; Ponto.app.render(); return true;'); await esperar(100);
    const u4b = await b.js('return document.querySelector("#incluir").disabled');
    await b.js('document.querySelector("tr[data-dia=\\"2026-03-03\\"]").click(); return true;');
    await b.aguardar('document.querySelector("dialog.modal footer [data-a=fechar]")');
    const m4b = JSON.parse(await b.js(`const d = document.querySelector('dialog.modal'); return JSON.stringify({ fechar: d.querySelector('footer [data-a=fechar]').disabled, escrita: [...d.querySelectorAll('button')].filter(x => !x.closest('[data-leitura]')).map(x => x.textContent.trim() + ':' + x.disabled) })`));
    await b.js('document.querySelectorAll("dialog.modal").forEach(d => { d.close(); d.remove(); }); return true;');
    reg('4. Interface (competência aberta): "Incluir marcação" desativado', u4b === true);
    reg('4. Detalhe do dia: Corrigir/Excluir/Incluir/Ocorrência/Conferir desativados; Histórico e Fechar ativos',
      m4.hist === false && m4.fechar === false && m4b.fechar === false && m4b.escrita.length >= 4 && m4b.escrita.every((x) => x.endsWith(':true')), JSON.stringify(m4b.escrita));

    // ---- 5. importar e restaurar
    const r5imp = await b.js(`const s = Ponto.app.store; const prep = await s.prepararImportacao('ARQUIVO-DE-TESTE.csv', new TextEncoder().encode(${JSON.stringify(FIXTURE)}));
      const pv = s.previaImportacao(prep, prep.sugestao, null);
      try { await s.confirmarImportacao(pv, { teste: true }); return 'GRAVOU'; } catch (e) { return /somente leitura/.test(e.message) ? 'recusado (prévia com ' + pv.resumo.novos + ' novas)' : e.message; }`);
    reg('5. Aba de leitura não confirma importação', /^recusado/.test(r5imp), r5imp);
    const r5res = await rejeita(b, `await Ponto.app.store.restaurarBackup(${backupA})`);
    reg('5. Aba de leitura não restaura backup (mesmo válido)', r5res === 'recusado', r5res);
    reg('5. Aba de leitura não criou cópia de segurança interna', (await b.js('return (await Ponto.app.store.copiasSeguranca()).length')) === 0);
    await b.js('location.hash = "#/importar"; return true;'); await esperar(150);
    const ui5a = await b.js('return document.querySelector("#arquivo").disabled');
    await b.js('location.hash = "#/backup"; return true;'); await esperar(300);
    const ui5b = JSON.parse(await b.js('return JSON.stringify({ restaurar: document.querySelector("#arq-backup").disabled, exportar: document.querySelector("#exportar").disabled })'));
    reg('5. Interface: arquivos de importação e de backup desativados; exportar backup ativo', ui5a && ui5b.restaurar && !ui5b.exportar, 'importar=' + ui5a + ' ' + JSON.stringify(ui5b));
    const exp5 = await b.js('const bk = await Ponto.app.store.exportarBackup(); return [bk.naoRegistrado === true, bk.dados.funcionarios.length]');
    reg('5. Exportar backup na aba de leitura gera o arquivo sem gravar nada', exp5[0] && exp5[1] === 1, JSON.stringify(exp5));

    // ---- 6. fechar / reabrir
    const r6 = {
      fechar: await rejeita(b, `await Ponto.app.store.fechar(${I}, '2026-03')`),
      reabrir: await rejeita(b, `await Ponto.app.store.reabrir(${I}, '2026-02', 'teste')`),
      recalcular: await rejeita(b, `await Ponto.app.store.atualizarSaldosPosteriores(${I}, '0000-00', 'teste')`)
    };
    reg('6. Aba de leitura não fecha, não reabre e não recalcula competências', Object.values(r6).every((v) => v === 'recusado'), JSON.stringify(r6));
    await b.js('Ponto.app.state.comp = "2026-02"; location.hash = "#/fechamento"; return true;'); await esperar(200);
    reg('6. Interface: botão "Reabrir competência" desativado', await b.js('return document.querySelector("#reabrir").disabled'));
    await b.recarregar();
    reg('3-6. Nenhuma das tentativas alterou os dados (comparação completa após recarregar)', (await b.js(SNAP)) === snap0 && (await a.js(SNAP)) === snap0);

    // ---- 7. formulários preservam conteúdo
    await b.js(`location.hash = '#/funcionarios/' + ${I}; return true;`); await b.aguardar('document.querySelector("#form-func")');
    await a.js(`await Ponto.app.store.salvarEmpregador({ nome: 'LOJA FICTÍCIA 7' }); return true;`); await esperar(500);
    const f7b = JSON.parse(await b.js('const f = document.querySelector("#form-func"); return JSON.stringify({ nome: f.nome.value, cargo: f.cargo.value, desativado: f.nome.disabled && f.cargo.disabled })'));
    reg('7. Formulário na aba de leitura mostra os valores (desativado) após atualização externa', f7b.nome === 'PESSOA FICTÍCIA DAS ABAS' && f7b.cargo === 'Cargo original' && f7b.desativado, JSON.stringify(f7b));
    await a.js(`location.hash = '#/funcionarios/' + ${I}; return true;`); await a.aguardar('document.querySelector("#form-func")');
    await a.js('const i = document.querySelector("[name=cargo]"); i.focus(); i.select(); return true;');
    await a.cdp('Input.insertText', { text: 'Digitado na aba editora, não salvo' });
    await b.js("new BroadcastChannel('gerenciador-ponto').postMessage('alterado'); return true;"); // aviso de "dados alterados em outra aba"
    await esperar(600);
    const f7a = JSON.parse(await a.js('return JSON.stringify({ cargo: document.querySelector("[name=cargo]").value, aviso: !document.querySelector("#aviso-atualizacao").hidden })'));
    reg('7. Texto digitado e não salvo NÃO é descartado por atualização vinda de outra aba', f7a.cargo === 'Digitado na aba editora, não salvo' && f7a.aviso, JSON.stringify(f7a));
    reg('7. Fechar/recarregar com formulário não salvo aciona o aviso do navegador', await a.js('const e = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented'));
    await a.js('document.querySelector("#aplicar-atualizacao").click(); return true;'); await esperar(100);
    reg('7. O conteúdo só é descartado quando o usuário pede ("Recarregar a tela agora")', await a.js('return document.querySelector("[name=cargo]").value === "Cargo original" && !Ponto.app.formAlterado'));

    // ---- 8. fechar a editora: a outra assume
    await a.js(`await Ponto.app.store.incluirMarcacao(${I}, '2026-03-04 09:00', 'última gravação da aba A'); return true;`);
    await a.fecharAba();
    let assumiu = false;
    try { await b.aguardar('Ponto.app.modo === "editor" && Ponto.app.store.editavel', 'promoção', 6000); assumiu = true; } catch (e) { /* registrado abaixo */ }
    reg('8. Ao fechar a aba editora, a segunda assume a edição', assumiu, await b.js(ESTADO));
    reg('8. Aviso de somente leitura some e os controles voltam a funcionar', await b.js('return document.querySelector("#aviso-leitura").hidden && !document.querySelector("#form-func [name=cargo]").disabled'));
    reg('8. Nova editora recarregou do banco (vê a última gravação da aba fechada)', await b.js(`return Ponto.app.store.efetivas(${I}).some(m => m.dt === '2026-03-04 09:00')`));
    reg('8. Nova editora grava normalmente', (await b.js(`try { await Ponto.app.store.incluirMarcacao(${I}, '2026-03-04 12:00', 'gravado pela aba B'); return 'ok'; } catch (e) { return e.message; }`)) === 'ok');

    // ---- 9. recarregar a editora não abre janela com dois editores
    const c = await N.pagina(); await c.abrir();
    reg('9. Terceira aba abre em leitura enquanto a segunda edita', (await estado(c)).modo === 'leitura');
    await c.js("window.__amostras = []; window.__t = setInterval(async () => { try { const q = await navigator.locks.query(); window.__amostras.push(q.held.filter(l => l.name === 'gerenciador-ponto:editor').length); } catch (e) {} }, 5); return true;");
    await b.js('window.__paginaAntiga = true; return true;'); await b.cdp('Page.reload', { ignoreCache: true });
    await esperar(1500);
    await b.aguardar('!window.__paginaAntiga && window.Ponto && Ponto.app && Ponto.app.pronto', 'recarga da editora');
    await esperar(500);
    const am = await c.js('clearInterval(window.__t); return window.__amostras');
    const eb9 = await estado(b), ec9 = await estado(c);
    const editores = [eb9, ec9].filter((x) => x.editavel).length;
    reg('9. Durante a recarga, nunca há mais de um detentor do bloqueio', Math.max(...am) <= 1 && am.length > 20, am.length + ' amostras; máximo de detentores = ' + Math.max(...am) + '; amostras sem detentor = ' + am.filter((x) => x === 0).length);
    reg('9. Após a recarga, exatamente uma aba editora', editores === 1 && (await c.js(SEGURADORES)) === 1, 'recarregada=' + eb9.modo + ', terceira=' + ec9.modo);
    const editora = ec9.editavel ? c : b, outra = ec9.editavel ? b : c;
    await outra.fecharAba();
    await editora.recarregar();
    reg('9. Aba única recarregada volta a ser editora', (await estado(editora)).modo === 'editor');

    // ---- 10. escritas simultâneas
    const p = editora;
    const leitor = await N.pagina(); await leitor.abrir();
    const cont0 = await p.js('return Ponto.app.store.sistema().alteracoesDesdeBackup');
    const r10 = await Promise.all([
      p.js(`const s = Ponto.app.store; const r = await Promise.allSettled([...Array(10)].map(() => s.incluirMarcacao(${I}, '2026-03-05 12:00', 'simultânea'))); return r.filter(x => x.status === 'fulfilled').length;`),
      p.js(`const s = Ponto.app.store; const r = await Promise.allSettled([...Array(10)].map((_, i) => s.incluirMarcacao(${I}, '2026-03-06 ' + String(8 + i).padStart(2, '0') + ':00', 'distinta'))); return r.filter(x => x.status === 'fulfilled').length;`),
      leitor.js(`try { await Ponto.app.store.incluirMarcacao(${I}, '2026-03-05 12:00', 'da aba leitora'); return 'GRAVOU'; } catch (e) { return 'recusado'; }`)
    ]);
    const errosLeitor = leitor.errosJS.slice();
    await leitor.fecharAba(); // senão a leitora assumiria a edição durante a recarga abaixo (comportamento correto, ver item 9)
    await p.recarregar();
    const v10 = await p.js(`const s = Ponto.app.store; return [s.efetivas(${I}).filter(m => m.dt === '2026-03-05 12:00').length, s.efetivas(${I}).filter(m => m.dataRef === '2026-03-06').length, s.sistema().alteracoesDesdeBackup];`);
    reg('10. 10 inclusões simultâneas da mesma batida gravam exatamente 1', r10[0] === 1 && v10[0] === 1, 'aceitas=' + r10[0] + ', gravadas=' + v10[0]);
    reg('10. 10 inclusões simultâneas de batidas diferentes gravam todas', r10[1] === 10 && v10[1] === 10, 'gravadas=' + v10[1]);
    reg('10. Tentativa simultânea pela aba de leitura recusada', r10[2] === 'recusado');
    reg('10. Contador de alterações sem backup consistente (sem perda de atualização)', v10[2] === cont0 + 11, cont0 + ' → ' + v10[2]);

    // ---- 11. correção de gravação em lote
    const nEv = await p.js('return Ponto.app.store.all("eventos").length');
    const r11 = await p.js("try { await Ponto.app.store.db.write([{ op: 'clear', store: 'eventos' }, { op: 'put', store: 'eventos', value: { semId: true } }]); return 'gravou'; } catch (e) { return e.name; }");
    await p.recarregar();
    const nEv2 = await p.js('return Ponto.app.store.all("eventos").length');
    reg('11. Correção de gravação em lote preservada (lote inválido não apaga nada)', nEv2 === nEv && nEv > 0, 'eventos ' + nEv + ' → ' + nEv2 + ' (' + r11 + ')');

    // ---- 12. situações de erro
    await p.js("window.__w = Ponto.app.store.db.write; Ponto.app.store.db.write = async () => { throw new DOMException('cota excedida (simulada)', 'QuotaExceededError'); }; return true;");
    const e12 = await p.js(`try { await Ponto.app.store.incluirMarcacao(${I}, '2026-03-09 09:00', 'vai falhar'); return 'gravou'; } catch (e) { return e.name; }`);
    const pos12 = JSON.parse(await p.js('return JSON.stringify({ modo: Ponto.app.modo, pend: Ponto.app.store.escritasPendentes })'));
    const held12 = await p.js(SEGURADORES);
    await p.js('Ponto.app.store.db.write = window.__w; return true;');
    const ok12 = await p.js(`try { await Ponto.app.store.incluirMarcacao(${I}, '2026-03-09 09:00', 'após a falha'); return 'ok'; } catch (e) { return e.message; }`);
    reg('12. Falha de gravação: operação recusada, aba continua editora e mantém o bloqueio', e12 === 'QuotaExceededError' && pos12.modo === 'editor' && held12 === 1, e12 + ' ' + JSON.stringify(pos12) + ' detentores=' + held12);
    reg('12. Após a falha, a fila de escrita não fica travada', ok12 === 'ok' && pos12.pend === 0, ok12);
    await p.js(`window.__w = Ponto.app.store.db.write; Ponto.app.store.db.write = async (ops) => { await new Promise(r => setTimeout(r, 800)); return window.__w.call(Ponto.app.store.db, ops); }; window.__p = Ponto.app.store.incluirMarcacao(${I}, '2026-03-10 09:00', 'gravação lenta'); return true;`);
    const bu12 = await p.js('const e = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(e); return [e.defaultPrevented, Ponto.app.store.escritasPendentes]');
    await p.js('await window.__p; Ponto.app.store.db.write = window.__w; return true;');
    reg('12. Fechar/recarregar com gravação em andamento aciona o aviso do navegador', bu12[0] === true && bu12[1] === 1, JSON.stringify(bu12));
    const erros = [a, b, c].flatMap((pg) => pg.errosJS).concat(errosLeitor);
    reg('Sem erros de JavaScript nas abas do teste', erros.length === 0, erros.slice(0, 3).join(' | '));
    p.fechar();
  } finally { await N.fechar(); }

  // ---- 12b. aba que falha ao abrir o banco libera o bloqueio; 12c. navegador sem Web Locks
  const E = await navegador('E');
  try {
    const x = await E.pagina({ scriptInicial: "Object.defineProperty(window, 'indexedDB', { get() { return { open() { throw new DOMException('IndexedDB bloqueado (simulado)', 'SecurityError'); } }; } });" });
    await x.abrir();
    const fx = await x.js('return JSON.stringify({ fatal: !!document.querySelector(".erro-fatal"), modo: Ponto.app.modo })');
    const y = await E.pagina(); await y.abrir();
    const ey = await estado(y);
    reg('12. Aba que falhou ao abrir o banco libera o bloqueio; a próxima aba edita', JSON.parse(fx).fatal && ey.modo === 'editor', fx + ' → próxima aba: ' + ey.modo);
    const z = await E.pagina({ scriptInicial: "Object.defineProperty(Navigator.prototype, 'locks', { get() { return undefined; } });" });
    await z.abrir();
    const ez = await estado(z);
    const wz = await rejeita(z, "await Ponto.app.store.salvarEmpregador({ nome: 'x' })");
    await z.js('location.hash = "#/config"; return true;'); await esperar(200);
    const botao = await z.js('return document.querySelector("#form-emp button[type=submit]").disabled');
    reg('12. Sem Web Locks: aviso e edição desativada (comportamento seguro)', ez.modo === 'sem-suporte' && !ez.editavel && /Web Locks/.test(ez.aviso || '') && wz === 'recusado' && botao, JSON.stringify(ez).slice(0, 170));
    reg('12. Aba sem Web Locks não interfere na aba editora', (await estado(y)).modo === 'editor');
    for (const pg of [x, y, z]) pg.fechar();
  } finally { await E.fechar(); }
}

function Ponto_todas(c) { return ['config', 'funcionarios', 'marcacoes', 'ajustes', 'eventos', 'lancamentos', 'fechamentos', 'conferencias', 'importacoes', 'auditoria'].every((k) => c[k] > 0); }
function diff(a, b) {
  const A = JSON.parse(a), B = JSON.parse(b);
  return Object.keys(A).filter((k) => JSON.stringify(A[k]) !== JSON.stringify(B[k])).map((k) => k + ' (' + A[k].length + ' x ' + (B[k] || []).length + ')').join(', ');
}

main().catch((e) => { console.error(e); process.exit(1); });
