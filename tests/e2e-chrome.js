/*
 * Teste ponta a ponta no navegador real (Chrome/Edge headless), sem dependências.
 * Abre o index.html diretamente (file://), usa IndexedDB real e opera a interface.
 *
 * Executar:  node tests/e2e-chrome.js
 * Opcional:  set CHROME="C:\caminho\chrome.exe"
 *
 * Usa um perfil temporário do navegador: NÃO toca nos dados do seu navegador.
 */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RAIZ = path.resolve(__dirname, '..');
const SAIDA = path.join(__dirname, 'saida');
const URL_APP = 'file:///' + path.join(RAIZ, 'index.html').replace(/\\/g, '/');
const FIXTURE = path.join(__dirname, 'fixtures', 'ARQUIVO-DE-TESTE_NAO-E-DO-RELOGIO.csv');
const CANDIDATOS = [process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].filter(Boolean);
const PORTA = 9300 + Math.floor(Math.random() * 500);

const resultados = [];
let falhas = 0;
function ok(nome, cond, detalhe) {
  resultados.push((cond ? '✔ ' : '✘ ') + nome + (detalhe ? ' — ' + detalhe : ''));
  if (!cond) falhas++;
  console.log(resultados[resultados.length - 1]);
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const exe = CANDIDATOS.find((p) => fs.existsSync(p));
  if (!exe) { console.error('Chrome/Edge não encontrado. Defina a variável CHROME.'); process.exit(2); }
  fs.mkdirSync(SAIDA, { recursive: true });
  const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'ponto-e2e-'));
  const proc = spawn(exe, ['--headless=new', '--remote-debugging-port=' + PORTA, '--user-data-dir=' + perfil, '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank'], { stdio: 'ignore' });

  let ws;
  try {
    let alvo = null;
    for (let i = 0; i < 50 && !alvo; i++) {
      try { const r = await fetch('http://127.0.0.1:' + PORTA + '/json/list'); alvo = (await r.json()).find((t) => t.type === 'page'); } catch (e) { await esperar(200); }
    }
    if (!alvo) throw new Error('Não foi possível conectar ao navegador.');
    ws = new WebSocket(alvo.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

    let seq = 0; const pend = new Map(); const errosJS = [];
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
      else if (m.method === 'Runtime.exceptionThrown') errosJS.push(m.params.exceptionDetails.exception ? m.params.exceptionDetails.exception.description : m.params.exceptionDetails.text);
      else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errosJS.push(m.params.args.map((a) => a.value || a.description).join(' '));
      else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errosJS.push(m.params.entry.text + ' ' + (m.params.entry.url || ''));
    };
    const cdp = (method, params) => new Promise((res, rej) => { const id = ++seq; pend.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params: params || {} })); });
    const js = async (expr) => {
      const r = await cdp('Runtime.evaluate', { expression: '(async () => { ' + expr + ' })()', awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error('JS: ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text));
      return r.result.value;
    };
    const aguardar = async (expr, desc, ms) => {
      const fim = Date.now() + (ms || 8000);
      while (Date.now() < fim) { try { if (await js('return !!(' + expr + ')')) return true; } catch (e) { /* ainda carregando */ } await esperar(100); }
      throw new Error('Tempo esgotado aguardando: ' + (desc || expr));
    };
    const clicar = (sel) => js(`const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error('não encontrado: ${sel.replace(/'/g, '')}'); e.click(); return true;`);
    const preencher = (sel, valor) => js(`const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error('não encontrado'); e.value = ${JSON.stringify(valor)}; e.dispatchEvent(new Event('input', {bubbles:true})); e.dispatchEvent(new Event('change', {bubbles:true})); return true;`);
    const enviarArquivo = async (sel, arquivo) => {
      const doc = await cdp('DOM.getDocument', { depth: -1 });
      const q = await cdp('DOM.querySelector', { nodeId: doc.root.nodeId, selector: sel });
      await cdp('DOM.setFileInputFiles', { nodeId: q.nodeId, files: [arquivo] });
    };
    const abrir = async () => { await cdp('Page.navigate', { url: URL_APP }); await aguardar('window.Ponto && Ponto.app && Ponto.app.pronto', 'inicialização'); };
    const ir = async (rota) => { await js(`location.hash = ${JSON.stringify(rota)}; return true;`); await esperar(150); };

    await cdp('Runtime.enable'); await cdp('Page.enable'); await cdp('Log.enable'); await cdp('DOM.enable');
    const downloads = path.join(SAIDA, 'downloads');
    fs.rmSync(downloads, { recursive: true, force: true }); fs.mkdirSync(downloads, { recursive: true });
    await cdp('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });

    // ---------------------------------------------------------- 1. abertura via file://
    await abrir();
    ok('Abre via file:// e inicializa o IndexedDB', await js('return Ponto.app.store !== null && document.querySelector(".erro-fatal") === null'));
    ok('Sem erros de JavaScript na abertura', errosJS.length === 0, errosJS.join(' | '));
    const protocolo = await js('return Ponto.app.armazenamento.protocolo');
    ok('Protocolo detectado', protocolo === 'file:', protocolo + ' · persistente=' + await js('return String(Ponto.app.armazenamento.persistente)'));

    // ---------------------------------------------------------- 2. cadastro pela interface
    await ir('#/funcionarios/novo');
    await aguardar('document.querySelector("#form-func")');
    await preencher('[name=nome]', 'Funcionária Teste E2E');
    await preencher('[name=cargo]', 'Vendedora');
    await preencher('[name=admissao]', '2026-03-01');
    await preencher('[name=codigoRelogio]', '1001');
    await preencher('[name=compInicial]', '2026-03');
    await preencher('[name=saldoInicial]', '+05:30');
    // jornada configurada pela interface: sábado 08:00-12:00
    await js(`const tr = document.querySelector('tr[data-wd="6"]'); tr.querySelector('.trabalha').checked = true; tr.querySelector('.ini').value='08:00'; tr.querySelector('.fim').value='12:00'; tr.querySelector('.trabalha').dispatchEvent(new Event('change',{bubbles:true})); return true;`);
    ok('Total semanal calculado na tela (40h + 4h sábado)', (await js('return document.querySelector("#total-semanal").textContent')) === '44:00');
    // volta sábado a folga
    await js(`const tr = document.querySelector('tr[data-wd="6"]'); tr.querySelector('.trabalha').checked = false; tr.querySelector('.trabalha').dispatchEvent(new Event('change',{bubbles:true})); return true;`);
    await js('document.querySelector("#form-func").requestSubmit(); return true;');
    await aguardar('Ponto.app.store.funcionarios().length === 1', 'gravação do funcionário');
    const empId = await js('return Ponto.app.store.funcionarios()[0].id');
    ok('Cadastro de funcionário pela interface', !!empId);
    // edição
    await ir('#/funcionarios/' + empId);
    await aguardar('document.querySelector("#form-func")');
    await preencher('[name=cargo]', 'Gerente de loja');
    await js('document.querySelector("#form-func").requestSubmit(); return true;');
    await aguardar('Ponto.app.store.funcionario(' + JSON.stringify(empId) + ').cargo === "Gerente de loja"', 'edição');
    ok('Edição de funcionário pela interface', true);
    // validação: CPF inválido mostra erro e não grava
    await ir('#/funcionarios/' + empId);
    await aguardar('document.querySelector("#form-func")');
    await preencher('[name=cpf]', '123.456.789-00');
    await js('document.querySelector("#form-func").requestSubmit(); return true;');
    await aguardar('!document.querySelector("#erros").hidden', 'mensagem de erro');
    ok('CPF inválido é recusado com mensagem', /CPF inválido/.test(await js('return document.querySelector("#erros").textContent')));

    // ---------------------------------------------------------- 3. persistência após recarregar
    await js('window.__paginaAntiga = true; return true;'); await cdp('Page.reload', { ignoreCache: true });
    await aguardar('!window.__paginaAntiga && window.Ponto && Ponto.app && Ponto.app.pronto', 'recarga');
    ok('Persistência após atualizar a página (IndexedDB em file://)', await js('return Ponto.app.store.funcionarios().length === 1 && Ponto.app.store.funcionarios()[0].cargo === "Gerente de loja"'));

    // ---------------------------------------------------------- 4. importação pela interface
    await js('Ponto.app.state.comp = "2026-03"; return true;');
    await ir('#/importar');
    await aguardar('document.querySelector("#arquivo")');
    await enviarArquivo('#arquivo', FIXTURE);
    await aguardar('document.querySelector("#confirmar")', 'prévia da importação');
    const txtPrevia = await js('return document.querySelector("#view").innerText');
    ok('Prévia identifica arquivo de TESTE e separador', /ponto e vírgula/.test(txtPrevia) && await js('return document.querySelector("#teste").checked'));
    ok('Prévia mostra linhas não identificadas', /Linhas que não puderam ser identificadas \(2\)/.test(txtPrevia));
    ok('Prévia mostra duplicidade e identificador sem funcionário', /Duplicada no próprio arquivo/.test(txtPrevia) && /Identificador sem funcionário/.test(txtPrevia));
    ok('Nada gravado antes da confirmação', await js('return Ponto.app.store.all("marcacoes").length === 0'));
    ok('Botão de confirmação mostra 15 marcações', /Confirmar e gravar 15/.test(await js('return document.querySelector("#confirmar").textContent')));
    await clicar('#confirmar');
    await aguardar('document.querySelector("dialog.modal footer button.primario")', 'modal de confirmação');
    await clicar('dialog.modal footer button.primario');
    await aguardar('Ponto.app.store.all("marcacoes").length === 15', 'gravação da importação');
    ok('Importação gravada após confirmação (15 marcações, origem teste)', await js('return Ponto.app.store.all("marcacoes").every(m => m.origem === "importacao-teste")'));
    // reimportar: tudo duplicado
    await enviarArquivo('#arquivo', FIXTURE);
    await aguardar('document.querySelector("#confirmar")', 'prévia 2');
    ok('Reimportação detecta arquivo repetido e duplicidades', /já foi importado/.test(await js('return document.querySelector("#view").innerText')) && await js('return document.querySelector("#confirmar").disabled'));
    await clicar('#cancelar');

    // ---------------------------------------------------------- 5. correção de ponto pela interface
    await ir('#/marcacoes');
    await aguardar('document.querySelector("tr[data-dia=\\"2026-03-05\\"]")');
    ok('Dia com marcação ímpar aparece como inconsistente', /Inconsistente/.test(await js('return document.querySelector("tr[data-dia=\\"2026-03-05\\"]").innerText')));
    await clicar('tr[data-dia="2026-03-05"]');
    await aguardar('document.querySelector("dialog.modal [data-a=incluir]")', 'detalhe do dia');
    await clicar('dialog.modal [data-a=incluir]');
    await aguardar('document.querySelectorAll("dialog.modal").length === 2');
    await js(`const d = [...document.querySelectorAll('dialog.modal')].pop(); d.querySelector('[name=hora]').value = '19:00'; d.querySelector('[name=just]').value = 'Funcionária esqueceu a saída (teste E2E)'; d.querySelector('footer button.primario').click(); return true;`);
    await aguardar('Ponto.app.store.apurarMes(' + JSON.stringify(empId) + ', "2026-03").dias.find(d => d.data === "2026-03-05").saldoMin === 0', 'inclusão manual');
    ok('Inclusão de marcação esquecida com justificativa (dia passa a ser apurado)', true);
    const nAjustes = await js('return Ponto.app.store.all("ajustes").length');
    ok('Ajuste registrado separadamente do original', nAjustes === 1 && await js('return Ponto.app.store.all("marcacoes").length === 15'));
    await js('document.querySelectorAll("dialog.modal").forEach(d => { d.close(); d.remove(); }); Ponto.app.render(); return true;');

    // ---------------------------------------------------------- 6. fechamento e reabertura pela interface
    // resolve os demais dias de março via API (atestado) para permitir o fechamento
    await js(`const s = Ponto.app.store, id = ${JSON.stringify(empId)};
      const ap = s.apurarMes(id, '2026-03');
      for (const d of ap.dias) if (d.ocorrencias.some(o => o.codigo === 'SEM_MARCACAO')) await s.registrarEvento({ employeeId: id, data: d.data, tipo: 'atestado', descricao: 'dia de teste' });
      for (const d of s.apurarMes(id, '2026-03').dias) if (d.pendente && !d.ocorrencias.some(o => o.nivel === 'erro')) await s.conferirDia(id, d.data, 'conferido no teste');
      return true;`);
    await ir('#/fechamento');
    await aguardar('document.querySelector("#fechar")');
    ok('Botão de fechar habilitado sem pendências', !(await js('return document.querySelector("#fechar").disabled')), await js('return [...document.querySelectorAll(".ocorrencias li.erro")].map(l=>l.textContent).join(" | ")'));
    await clicar('#fechar');
    await aguardar('document.querySelector("dialog.modal [name=conferi]")');
    await clicar('dialog.modal footer button.primario');
    await aguardar('!document.querySelector("dialog.modal .erro-form").hidden', 'exigência de confirmação');
    ok('Fechamento exige marcar a conferência', true);
    await js('document.querySelector("dialog.modal [name=conferi]").checked = true; document.querySelector("dialog.modal footer button.primario").click(); return true;');
    await aguardar('Ponto.app.store.compFechada(' + JSON.stringify(empId) + ', "2026-03")', 'fechamento');
    const saldoMar = await js('return Ponto.app.store.linhaBanco(' + JSON.stringify(empId) + ', "2026-03").saldoFinalMin');
    ok('Competência fechada; saldo transportado', saldoMar !== null, 'saldo final de março (min) = ' + saldoMar);
    ok('Saldo de abril começa com o final de março', await js('return Ponto.app.store.linhaBanco(' + JSON.stringify(empId) + ', "2026-04").saldoAnteriorMin') === saldoMar);
    const bloq = await js(`try { await Ponto.app.store.incluirMarcacao(${JSON.stringify(empId)}, '2026-03-10 10:00', 'tentativa'); return false; } catch (e) { return /fechada/.test(e.message); }`);
    ok('Competência fechada bloqueia alterações', bloq);
    await ir('#/fechamento');
    await aguardar('document.querySelector("#reabrir")');
    await clicar('#reabrir');
    await aguardar('document.querySelector("dialog.modal [name=just]")');
    await js('const d = document.querySelector("dialog.modal"); d.querySelector("[name=just]").value = "Reabertura de teste E2E"; d.querySelector("footer button.perigo").click(); return true;');
    await aguardar('!Ponto.app.store.compFechada(' + JSON.stringify(empId) + ', "2026-03")', 'reabertura');
    ok('Reabertura com justificativa e histórico', await js('return Ponto.app.store.fechamento(' + JSON.stringify(empId) + ', "2026-03").historico.map(h => h.acao).join(",")') === 'fechamento,reabertura');

    // ---------------------------------------------------------- 7. todas as telas renderizam
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
    for (const v of ['painel', 'funcionarios', 'marcacoes', 'importar', 'ocorrencias', 'banco', 'fechamento', 'relatorios', 'backup', 'config', 'sobre']) {
      await ir('#/' + v); await esperar(100);
      const okV = await js('return !document.querySelector(".erro-fatal") && document.querySelector("#view h1") !== null');
      ok('Tela "' + v + '" renderiza', okV);
      const shot = await cdp('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(SAIDA, 'tela-' + v + '.png'), Buffer.from(shot.data, 'base64'));
    }
    for (const t of ['espelho', 'extrato', 'ocorrencias', 'ajustes', 'contabilidade']) {
      await ir('#/relatorios'); await esperar(50);
      await clicar('[data-tipo="' + t + '"]'); await esperar(80);
      ok('Relatório "' + t + '" renderiza', await js('return document.querySelector("#relatorio .rel-cab") !== null'));
    }

    // ---------------------------------------------------------- 8. impressão do espelho mensal (PDF A4)
    await ir('#/relatorios'); await esperar(50);
    await clicar('[data-tipo="espelho"]'); await esperar(100);
    await cdp('Emulation.setEmulatedMedia', { media: 'print' });
    const ocultos = await js('return ["aside.sidebar", ".topo", ".abas", "#imprimir"].every(s => getComputedStyle(document.querySelector(s)).display === "none") || ["aside.sidebar", ".topo"].every(s => document.querySelector(s).offsetParent === null)');
    ok('CSS de impressão oculta menus e botões', ocultos);
    await cdp('Emulation.setEmulatedMedia', { media: '' });
    const pdf = await cdp('Page.printToPDF', { paperWidth: 8.27, paperHeight: 11.69, preferCSSPageSize: true, printBackground: true });
    const buf = Buffer.from(pdf.data, 'base64');
    const arqPdf = path.join(SAIDA, 'espelho-mensal-TESTE.pdf');
    fs.writeFileSync(arqPdf, buf);
    const paginas = (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
    ok('Espelho mensal impresso em PDF A4', buf.length > 10000 && paginas >= 1, paginas + ' página(s), ' + buf.length + ' bytes → ' + path.relative(RAIZ, arqPdf));

    // ---------------------------------------------------------- 9. backup: exportar (download real) e restaurar pela interface
    await ir('#/backup');
    await aguardar('document.querySelector("#exportar")');
    await clicar('#exportar');
    let arqBackup = null;
    for (let i = 0; i < 50 && !arqBackup; i++) { await esperar(100); arqBackup = fs.readdirSync(downloads).find((f) => /^backup-ponto_.*\.json$/.test(f)); }
    ok('Exportação gera arquivo de backup', !!arqBackup, arqBackup || '');
    const conteudoBackup = JSON.parse(fs.readFileSync(path.join(downloads, arqBackup), 'utf8'));
    ok('Backup contém todas as coleções e hash', conteudoBackup.formato === 'gerenciador-ponto-backup' && conteudoBackup.integridade.algoritmo === 'SHA-256' && conteudoBackup.dados.marcacoes.length === 15 && conteudoBackup.dados.fechamentos.length === 1);
    const contar = 'const s = Ponto.app.store; return ["funcionarios","marcacoes","ajustes","eventos","fechamentos","importacoes"].map(k => s.all(k).length).join(",")';
    const antes = await js(contar);
    // altera depois do backup (deve ser desfeito pela restauração)
    await js(`await Ponto.app.store.lancarBanco({ employeeId: ${JSON.stringify(empId)}, data: '2026-04-02', tipo: 'ajuste', minutos: 30, justificativa: 'depois do backup' }); return true;`);
    // backup adulterado é recusado
    const adulterado = path.join(SAIDA, 'backup-ADULTERADO-teste.json');
    const ruim = JSON.parse(JSON.stringify(conteudoBackup)); ruim.dados.marcacoes[0].dt = '2026-03-02 05:00';
    fs.writeFileSync(adulterado, JSON.stringify(ruim));
    await ir('#/backup'); await aguardar('document.querySelector("#arq-backup")');
    await enviarArquivo('#arq-backup', adulterado);
    await aguardar('document.querySelector("#resultado-validacao .faixa")');
    ok('Backup adulterado é recusado (integridade)', /integridade/.test(await js('return document.querySelector("#resultado-validacao").innerText')) && !(await js('return !!document.querySelector("#restaurar")')));
    // restauração válida
    await enviarArquivo('#arq-backup', path.join(downloads, arqBackup));
    await aguardar('document.querySelector("#restaurar")', 'validação do backup');
    await clicar('#restaurar');
    await aguardar('document.querySelector("dialog.modal [name=conf]")');
    await js('const d = document.querySelector("dialog.modal"); d.querySelector("[name=conf]").value = "RESTAURAR"; d.querySelector("footer button.perigo").click(); return true;');
    await aguardar('Ponto.app.store.all("lancamentos").length === 0', 'restauração');
    ok('Restauração substitui sem duplicar registros', (await js(contar)) === antes, antes);
    await js('window.__paginaAntiga = true; return true;'); await cdp('Page.reload', { ignoreCache: true });
    await aguardar('!window.__paginaAntiga && window.Ponto && Ponto.app && Ponto.app.pronto', 'recarga');
    ok('Dados restaurados persistem após recarregar', (await js(contar)) === antes);
    ok('Cópia de segurança interna criada antes da restauração', (await js('return (await Ponto.app.store.copiasSeguranca()).length')) >= 1);

    ok('Nenhum erro de JavaScript durante todo o teste', errosJS.length === 0, errosJS.slice(0, 5).join(' | '));
  } catch (e) {
    ok('Execução do teste', false, e.message);
  } finally {
    try { ws && ws.close(); } catch (e) { /* ignora */ }
    proc.kill();
    await esperar(500);
    try { fs.rmSync(perfil, { recursive: true, force: true }); } catch (e) { /* perfil ainda em uso */ }
  }
  console.log('\n' + (resultados.length - falhas) + ' de ' + resultados.length + ' verificações aprovadas.');
  process.exit(falhas ? 1 : 0);
}

main();
