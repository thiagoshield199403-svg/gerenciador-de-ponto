/*
 * Integração com o Google Drive no navegador real (Chrome/Edge headless) — TOTALMENTE SIMULADA.
 *
 * - Sobe um servidor HTTP temporário só em 127.0.0.1 (porta aleatória), apenas durante o teste.
 * - Perfis temporários do navegador e somente dados fictícios.
 * - A biblioteca de login do Google (accounts.google.com/gsi/client) e a Drive API são
 *   interceptadas pelo protocolo de depuração do Chrome e respondidas por simulações; qualquer outro
 *   endereço externo é recusado, e a resolução de nomes fica bloqueada (--host-resolver-rules).
 *   Nenhum dado sai do computador e nenhuma conta Google é usada.
 * - Como a interceptação ocorre depois da checagem do navegador, a Content-Security-Policy real
 *   da página é exercitada.
 *
 * Executar:  node tests/drive-chrome.js
 */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const RAIZ = path.resolve(__dirname, '..');
const SAIDA = path.join(__dirname, 'saida', 'drive');
const URL_ARQUIVO = 'file:///' + path.join(RAIZ, 'index.html').replace(/\\/g, '/');
const EXE = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean).find((p) => fs.existsSync(p));
const CLIENT_ID = '123456789012-testeficticio0123456789abcdefgh.apps.googleusercontent.com';
const SENHA = 'senha ficticia do teste 2026';         // usada só neste teste
const SENHA_ERRADA = 'senha errada ficticia 2026';
const CSP_ESPERADA = "default-src 'self'; script-src 'self' https://accounts.google.com/gsi/client; style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style; img-src 'self' data: blob:; connect-src https://www.googleapis.com/drive/v3/ https://www.googleapis.com/upload/drive/v3/ https://oauth2.googleapis.com/revoke; object-src 'none'; base-uri 'none'; form-action 'none'";
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

const res = [];
let falhas = 0;
function reg(nome, cond, detalhe) {
  const linha = (cond ? '✔ ' : '✘ ') + nome + (detalhe ? ' — ' + detalhe : '');
  res.push(linha); console.log(linha);
  if (!cond) falhas++;
}

// ---------------------------------------------------------------- servidor local temporário
function servidor() {
  const tipos = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.csv': 'text/csv' };
  const srv = http.createServer((req, resp) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
    const arq = path.resolve(RAIZ, rel);
    if (!arq.startsWith(RAIZ + path.sep) || !fs.existsSync(arq) || fs.statSync(arq).isDirectory() || /[\\/](tests[\\/]saida|node_modules)[\\/]/.test(arq)) { resp.writeHead(404); resp.end(); return; }
    resp.writeHead(200, { 'Content-Type': tipos[path.extname(arq)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(arq).pipe(resp);
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ srv, origem: 'http://127.0.0.1:' + srv.address().port })));
}

// ---------------------------------------------------------------- Google simulado
const GIS_SIMULADO = `(function () {
  var n = 0;
  function token() { n++; return 'TOKEN-FICTICIO-CHROME-' + n + '-' + Math.random().toString(36).slice(2); }
  var l = document.createElement('link'); l.rel = 'stylesheet'; l.href = 'https://accounts.google.com/gsi/style'; document.head.appendChild(l);
  window.google = window.google || {};
  window.google.accounts = { oauth2: {
    initTokenClient: function (cfg) { return { requestAccessToken: function () {
      var modo = window.__gisModo || 'ok';
      window.__gisPedidos = (window.__gisPedidos || 0) + 1;
      window.__gisUltimo = { client_id: cfg.client_id, scope: cfg.scope };
      setTimeout(function () {
        if (modo === 'cancelar') cfg.error_callback({ type: 'popup_closed' });
        else if (modo === 'erro') cfg.callback({ error: 'invalid_client' });
        else cfg.callback({ access_token: token(), expires_in: 3599, scope: cfg.scope, token_type: 'Bearer' });
      }, 30);
    } }; },
    hasGrantedAllScopes: function (r, s) { return String(r.scope || '').split(' ').indexOf(s) >= 0; },
    revoke: function (t, cb) { fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'token=' + encodeURIComponent(t) }).then(function () { if (cb) cb({ successful: true }); }, function () { if (cb) cb({ successful: false }); }); }
  } };
})();`;

/** Estado da Drive API simulada (compartilhado entre as abas, como uma conta Google real). */
const google = {
  pastas: [], arquivos: [], seq: 0, tokens: new Set(), revogados: [], reqs: [], externas: [], gis: 0,
  modo: { upload: null, listar: null, proximo401: false }
};

function respostaGoogle(req, origem) {
  const u = new URL(req.url);
  const cors = { 'Access-Control-Allow-Origin': origem, 'Access-Control-Expose-Headers': 'Location, Content-Length', Vary: 'Origin' };
  const json = (obj, status) => ({ status: status || 200, headers: Object.assign({ 'Content-Type': 'application/json' }, cors), body: JSON.stringify(obj) });
  if (req.method === 'OPTIONS') {
    return { status: 204, headers: Object.assign({}, cors, { 'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS', 'Access-Control-Allow-Headers': 'authorization, content-type, x-upload-content-type, x-upload-content-length', 'Access-Control-Max-Age': '0' }), body: '' };
  }
  if (u.host === 'oauth2.googleapis.com' && u.pathname === '/revoke') {
    const t = new URLSearchParams(req.postData || '').get('token');
    google.revogados.push(t); google.tokens.delete(t);
    return json({});
  }
  if (u.host !== 'www.googleapis.com') return null;
  google.reqs.push({ metodo: req.method, url: req.url });
  const auth = (req.headers.Authorization || req.headers.authorization || '').replace(/^Bearer /, '');
  if (google.modo.proximo401) { google.modo.proximo401 = false; return json({ error: { code: 401 } }, 401); }
  if (!auth.startsWith('TOKEN-FICTICIO-CHROME-') || google.revogados.includes(auth)) return json({ error: { code: 401 } }, 401);
  google.tokens.add(auth);
  if (u.pathname === '/drive/v3/files' && req.method === 'GET') {
    const q = u.searchParams.get('q') || '';
    if (q.includes("value='pasta'")) return json({ files: google.pastas });
    if (google.modo.listar === 'limite') return json({ error: { code: 403, errors: [{ reason: 'userRateLimitExceeded' }] } }, 403);
    return json({ files: google.arquivos.slice().reverse().map((a) => ({ id: a.id, name: a.name, size: a.size, createdTime: a.createdTime, appProperties: a.meta && a.meta.appProperties })) });
  }
  if (u.pathname === '/drive/v3/files' && req.method === 'POST') {
    const m = JSON.parse(req.postData);
    const p = { id: 'pasta' + (++google.seq) + '-ficticia', name: m.name, appProperties: m.appProperties };
    google.pastas.push(p);
    return json({ id: p.id, name: p.name });
  }
  if (u.pathname === '/upload/drive/v3/files' && u.searchParams.get('uploadType') === 'multipart') {
    if (google.modo.upload === '500') return json({ error: { code: 500 } }, 500);
    const limite = /boundary=(\S+)/.exec(req.headers['Content-Type'] || req.headers['content-type'])[1];
    const partes = req.postData.split('--' + limite).slice(1, 3).map((p) => p.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, ''));
    const meta = JSON.parse(partes[0]);
    const a = { id: 'arquivo' + (++google.seq) + '-ficticio', name: meta.name, meta, conteudo: partes[1], size: String(Buffer.byteLength(partes[1])), createdTime: new Date(Date.now() + google.seq * 1000).toISOString() };
    google.arquivos.push(a);
    return json({ id: a.id, name: a.name, size: a.size, createdTime: a.createdTime, mimeType: 'application/json' });
  }
  const mm = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
  if (mm && u.searchParams.get('alt') === 'media') {
    const a = google.arquivos.find((x) => x.id === mm[1]);
    if (!a) return json({ error: { code: 404 } }, 404);
    return { status: 200, headers: Object.assign({ 'Content-Type': 'application/json' }, cors), body: a.conteudo };
  }
  return json({ error: { code: 400 } }, 400);
}

// ---------------------------------------------------------------- navegador / páginas
async function navegador(nome, origem) {
  const porta = 9900 + Math.floor(Math.random() * 400);
  const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'ponto-drive-' + nome + '-'));
  const proc = spawn(EXE, ['--headless=new', '--remote-debugging-port=' + porta, '--user-data-dir=' + perfil, '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-domain-reliability',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { await fetch('http://127.0.0.1:' + porta + '/json/version'); break; } catch (e) { await esperar(150); } }
  return {
    async pagina(opts) {
      const r = await fetch('http://127.0.0.1:' + porta + '/json/new?about:blank', { method: 'PUT' });
      const alvo = await r.json();
      return Pagina.conectar(alvo.webSocketDebuggerUrl, origem, opts || {});
    },
    async fechar() { proc.kill(); await esperar(600); try { fs.rmSync(perfil, { recursive: true, force: true }); } catch (e) { /* em uso */ } }
  };
}

class Pagina {
  static async conectar(url, origem, opts) {
    const p = new Pagina();
    p.origem = origem;
    p.ws = new WebSocket(url); p.seq = 0; p.pend = new Map(); p.errosJS = []; p.console = [];
    await new Promise((ok, err) => { p.ws.onopen = ok; p.ws.onerror = err; });
    p.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && p.pend.has(m.id)) { const x = p.pend.get(m.id); p.pend.delete(m.id); m.error ? x.rej(new Error(m.error.message)) : x.res(m.result); }
      else if (m.method === 'Runtime.exceptionThrown') p.errosJS.push(m.params.exceptionDetails.text + ' ' + (m.params.exceptionDetails.exception || {}).description);
      else if (m.method === 'Runtime.consoleAPICalled') p.console.push(m.params.args.map((a) => a.value !== undefined ? String(a.value) : (a.description || '')).join(' '));
      else if (m.method === 'Log.entryAdded') p.console.push(m.params.entry.text + ' ' + (m.params.entry.url || ''));
      else if (m.method === 'Fetch.requestPaused') p.interceptar(m.params).catch(() => {});
    };
    await p.cdp('Runtime.enable'); await p.cdp('Page.enable'); await p.cdp('Log.enable'); await p.cdp('DOM.enable');
    await p.cdp('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    if (opts.downloads) await p.cdp('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: opts.downloads });
    await p.cdp('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__csp = []; document.addEventListener("securitypolicyviolation", function (e) { window.__csp.push({ uri: e.blockedURI, diretiva: e.effectiveDirective }); });' });
    return p;
  }

  async interceptar(ev) {
    const req = ev.request;
    const u = new URL(req.url);
    if (u.protocol === 'file:' || u.protocol === 'data:' || u.protocol === 'blob:' || (this.origem && req.url.startsWith(this.origem + '/'))) {
      await this.cdp('Fetch.continueRequest', { requestId: ev.requestId }); return;
    }
    let r = null;
    if (u.host === 'accounts.google.com' && u.pathname === '/gsi/client') { google.gis++; r = { status: 200, headers: { 'Content-Type': 'text/javascript' }, body: GIS_SIMULADO }; }
    else if (u.host === 'accounts.google.com' && u.pathname === '/gsi/style') r = { status: 200, headers: { 'Content-Type': 'text/css' }, body: '' };
    else r = respostaGoogle(req, this.origem);
    if (!r) { google.externas.push(req.url); await this.cdp('Fetch.failRequest', { requestId: ev.requestId, errorReason: 'BlockedByClient' }); return; }
    await this.cdp('Fetch.fulfillRequest', {
      requestId: ev.requestId, responseCode: r.status,
      responseHeaders: Object.entries(r.headers).map(([name, value]) => ({ name, value: String(value) })),
      body: Buffer.from(r.body || '').toString('base64')
    });
  }

  cdp(method, params) { return new Promise((res2, rej) => { const id = ++this.seq; this.pend.set(id, { res: res2, rej }); this.ws.send(JSON.stringify({ id, method, params: params || {} })); }); }
  async js(expr) {
    const r = await this.cdp('Runtime.evaluate', { expression: '(async () => { ' + expr + ' })()', awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error('JS: ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text));
    return r.result.value;
  }
  async aguardar(expr, desc, ms) {
    const fim = Date.now() + (ms || 8000);
    while (Date.now() < fim) { try { if (await this.js('return !!(' + expr + ')')) return true; } catch (e) { /* carregando */ } await esperar(60); }
    throw new Error('Tempo esgotado: ' + (desc || expr));
  }
  async abrir(url) { await this.cdp('Page.navigate', { url }); await this.aguardar('window.Ponto && Ponto.app && Ponto.app.pronto', 'inicialização'); }
  async recarregar() { await this.js('window.__paginaAntiga = true; return true;'); await this.cdp('Page.reload', { ignoreCache: true }); await this.aguardar('!window.__paginaAntiga && window.Ponto && Ponto.app && Ponto.app.pronto', 'recarga'); }
  estado() { return this.js('const e = document.querySelector("#drive-status"); return e ? e.dataset.estado : null;'); }
  async clicar(sel) { await this.aguardar('document.querySelector(' + JSON.stringify(sel) + ') && !document.querySelector(' + JSON.stringify(sel) + ').disabled', 'botão ' + sel); await this.js('document.querySelector(' + JSON.stringify(sel) + ').click(); return true;'); }
  /** Fecha o modal aberto (botão "Entendi") e devolve o texto dele. */
  async modal() {
    await this.aguardar('document.querySelector("dialog.modal")', 'modal');
    return this.js('const d = document.querySelector("dialog.modal"); const t = d.innerText; d.querySelector("footer button").click(); return t;');
  }
  /** Conecta (Google simulado): espera a biblioteca carregar, clica e espera a lista. */
  async conectarDrive() {
    await this.aguardar('window.google && google.accounts && document.querySelector("#drive-conectar") && !document.querySelector("#drive-conectar").disabled', 'Conectar com a biblioteca carregada');
    await this.js('document.querySelector("#drive-conectar").click(); return true;');
    await this.aguardar('document.querySelector("#drive-status").dataset.estado === "conectado" && document.querySelector("#drive-lista, #drive-vazio")', 'conectado');
  }
  /** Janela de senha nova (envio ao Drive): preenche e confirma. */
  async senhaNova(senha, confirmacao) {
    await this.aguardar('document.querySelector("dialog.modal [name=senha2]")', 'janela de senha nova');
    await this.js('const d = document.querySelector("dialog.modal"); d.querySelector("[name=senha]").value = ' + JSON.stringify(senha) +
      '; d.querySelector("[name=senha2]").value = ' + JSON.stringify(confirmacao === undefined ? senha : confirmacao) + '; d.querySelector("footer button.primario").click(); return true;');
  }
  /** Janela de senha de um arquivo criptografado: preenche e confirma. */
  async senhaArquivo(senha) {
    await this.aguardar('document.querySelector("dialog.modal [name=senha]") && !document.querySelector("dialog.modal [name=senha2]")', 'janela de senha do arquivo');
    await this.js('const d = document.querySelector("dialog.modal"); d.querySelector("[name=senha]").value = ' + JSON.stringify(senha) + '; d.querySelector("footer button.primario").click(); return true;');
  }
  erroJanela() { return this.js('const e = document.querySelector("dialog.modal .erro-form"); return e && !e.hidden ? e.textContent : "";'); }
  cancelarJanela() { return this.js('[...document.querySelectorAll("dialog.modal footer button")].find(b => /Cancelar/.test(b.innerText)).click(); return true;'); }
  async arquivo(sel, caminho) {
    const doc = await this.cdp('DOM.getDocument', { depth: -1 });
    const q = await this.cdp('DOM.querySelector', { nodeId: doc.root.nodeId, selector: sel });
    await this.cdp('DOM.setFileInputFiles', { nodeId: q.nodeId, files: [caminho] });
  }
  toasts() { return this.js('return document.querySelector("#toasts").innerText'); }
  fechar() { try { this.ws.close(); } catch (e) { /* */ } }
}

/** Expressão JS que devolve o botão de seleção do arquivo `id` na lista do Drive. */
const selArq = (id) => 'document.querySelector(' + JSON.stringify('input[name=drive-arquivo][value="' + id + '"]') + ')';

const SNAP = `const s = Ponto.app.store; const d = s.dadosCompletos();
  d.config = d.config.filter(c => c.id !== 'sistema');
  d.auditoria = d.auditoria.filter(a => !['backup-restaurado', 'backup-exportado', 'backup-enviado-drive'].includes(a.acao));
  for (const k in d) d[k].sort((a, b) => a.id < b.id ? -1 : 1);
  return JSON.stringify(d);`;

const POPULAR = `const s = Ponto.app.store, C = Ponto.calc;
  await s.salvarEmpregador({ nome: 'EMPRESA FICTÍCIA DO TESTE DO DRIVE', documento: '', endereco: '', responsavel: '' });
  const f = await s.salvarFuncionario({ nome: 'PESSOA FICTÍCIA DO DRIVE', cargo: 'Teste', admissao: '2026-01-01', jornada: { semana: C.semanaExemplo(), regras: {} }, banco: { compInicial: '2026-01', saldoInicialMin: 0 } });
  for (const h of ['09:00', '12:00', '14:00', '18:00']) await s.incluirMarcacao(f.id, '2026-03-02 ' + h, 'marcação fictícia');
  return f.id;`;

// ---------------------------------------------------------------- cenários
async function principal() {
  if (!EXE) throw new Error('Chrome/Edge não encontrado.');
  fs.mkdirSync(SAIDA, { recursive: true });
  const { srv, origem } = await servidor();
  const URL_HTTP = origem + '/index.html#/backup';
  const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'ponto-drive-dl-'));
  const tokensVistos = () => [...google.tokens, ...google.revogados].filter(Boolean);

  // ---------------- 1. Aberto como arquivo local (file://): Drive indisponível, backup local funciona
  {
    const nav = await navegador('arquivo', null);
    const p = await nav.pagina({ downloads });
    try {
      await p.abrir(URL_ARQUIVO + '#/backup');
      await p.aguardar('document.querySelector("#drive-status")', 'cartão do Drive');
      reg('file://: Drive aparece como indisponível, com instrução de usar http://localhost:8080', await p.estado() === 'indisponivel-local' && /localhost:8080/.test(await p.js('return document.querySelector("#cartao-drive").innerText')));
      reg('file://: aviso de que o backup enviado ao Drive é criptografado com uma senha que não pode ser recuperada', /criptografados neste navegador/.test(await p.js('return document.querySelector("#cartao-drive").innerText')) && /não pode ser recuperado/.test(await p.js('return document.querySelector("#cartao-drive").innerText')));
      reg('file://: biblioteca do Google não é carregada', google.gis === 0 && await p.js('return !document.querySelector("script[src*=\\"accounts.google.com\\"]")'));
      await p.js(POPULAR);
      await p.clicar('#exportar');
      await p.aguardar('/Backup gerado/.test(document.querySelector("#toasts").innerText)', 'exportação local');
      await esperar(600);
      reg('file://: exportação local continua funcionando', fs.readdirSync(downloads).some((f) => /^backup-ponto_.*\.json$/.test(f)));
      reg('file://: nenhum erro de JavaScript', p.errosJS.length === 0, p.errosJS.join(' | '));
    } finally { p.fechar(); await nav.fechar(); }
  }

  // ---------------- 2. Origem http (127.0.0.1): fluxo completo com Google simulado
  const nav = await navegador('http', origem);
  const a = await nav.pagina({ downloads });
  let b = null;
  try {
    await a.abrir(URL_HTTP);
    const csp = await a.js('return document.querySelector("meta[http-equiv=Content-Security-Policy]").content');
    reg('CSP: exatamente a política prevista (só os endereços do Google necessários)', csp === CSP_ESPERADA, csp === CSP_ESPERADA ? '' : csp);
    await a.aguardar('document.querySelector("#drive-status")', 'cartão do Drive');
    reg('Sem Client ID: status "aguardando configuração" e nada é carregado do Google', await a.estado() === 'aguardando-configuracao' && google.gis === 0 && google.reqs.length === 0);
    const empId = await a.js(POPULAR);
    reg('Sem Drive: o sistema continua gravando normalmente', !!empId && await a.js('return Ponto.app.store.funcionarios().length') === 1);

    // Client ID inválido / segredo
    for (const v of ['abc', 'GOCSPX-segredo-ficticio']) {
      await a.js('document.querySelector("#drive-client-id").value = ' + JSON.stringify(v) + '; document.querySelector("#drive-salvar-id").click(); return true;');
      const t = await a.modal();
      reg('Client ID inválido recusado (' + v.slice(0, 6) + '…)', /Formato inválido|client secret/.test(t) && await a.estado() === 'aguardando-configuracao' && await a.js('return localStorage.getItem("gerenciador-ponto:drive-client-id")') === null);
    }
    await a.js('document.querySelector("#drive-client-id").value = ' + JSON.stringify(CLIENT_ID) + '; document.querySelector("#drive-salvar-id").click(); return true;');
    await a.aguardar('document.querySelector("#drive-status").dataset.estado === "desconectado" && Ponto.drive && window.google && google.accounts', 'biblioteca carregada');
    reg('Client ID válido salvo; biblioteca do Google carregada sob demanda; status "desconectado"', google.gis === 1 && await a.estado() === 'desconectado');

    // Login cancelado e com erro
    await a.js('window.__gisModo = "cancelar"; return true;');
    await a.clicar('#drive-conectar');
    await a.aguardar('document.querySelector("#drive-erro")', 'aviso de cancelamento');
    reg('Login cancelado: continua desconectado, com aviso', await a.estado() === 'desconectado' && /cancelado/.test(await a.js('return document.querySelector("#drive-erro").innerText')));
    await a.js('window.__gisModo = "erro"; return true;');
    await a.clicar('#drive-conectar');
    const tErro = await a.modal();
    reg('Erro de autenticação: mensagem clara e sem conexão', /recusou o login/.test(tErro) && await a.estado() === 'erro');
    await a.js('window.__gisModo = "ok"; return true;');
    await a.clicar('#drive-conectar');
    await a.aguardar('document.querySelector("#drive-status").dataset.estado === "conectado" && document.querySelector("#drive-vazio")', 'conectado e lista vazia');
    reg('Login concluído: status "conectado", escopo único drive.file', await a.js('return JSON.stringify(window.__gisUltimo)') === JSON.stringify({ client_id: CLIENT_ID, scope: 'https://www.googleapis.com/auth/drive.file' }));
    reg('Lista vazia exibida', /Nenhum backup deste sistema/.test(await a.js('return document.querySelector("#drive-vazio").innerText')));

    // Senha de criptografia: regras, cancelamento
    const sisC = await a.js('return Ponto.app.store.sistema()');
    await a.clicar('#drive-enviar');
    await a.senhaNova('curta');
    await a.aguardar('document.querySelector("dialog.modal .erro-form") && !document.querySelector("dialog.modal .erro-form").hidden');
    const eCurta = await a.erroJanela();
    await a.js('const d = document.querySelector("dialog.modal"); d.querySelector("[name=senha]").value = ' + JSON.stringify(SENHA) + '; d.querySelector("[name=senha2]").value = ' + JSON.stringify(SENHA + 'x') + '; d.querySelector("footer button.primario").click(); return true;');
    await a.aguardar('/não são iguais/.test(document.querySelector("dialog.modal .erro-form").textContent)', 'senhas diferentes');
    reg('Senha do envio: curta ou repetida errado é recusada na própria janela', /pelo menos 12/.test(eCurta) && /não são iguais/.test(await a.erroJanela()));
    await a.js('document.querySelector("#toasts").innerHTML = ""; return true;');
    await a.cancelarJanela();
    await a.aguardar('/Envio cancelado/.test(document.querySelector("#toasts").innerText)', 'cancelamento da senha');
    reg('Cancelar a senha: nada é enviado e nada é registrado', google.arquivos.length === 0 && JSON.stringify(await a.js('return Ponto.app.store.sistema()')) === JSON.stringify(sisC) && !(await a.js('return !!document.querySelector("dialog.modal")')));

    // Envio confirmado (criptografado)
    const snap1 = await a.js(SNAP);
    const sis0 = await a.js('return Ponto.app.store.sistema()');
    await a.clicar('#drive-enviar');
    await a.senhaNova(SENHA);
    await a.aguardar('/confirmado pelo Google Drive/.test(document.querySelector("#toasts").innerText) && document.querySelector("#drive-lista")', 'envio confirmado');
    await esperar(200);
    const sis1 = await a.js('return Ponto.app.store.sistema()');
    const enviado = google.arquivos[0];
    const valido = await a.js('const env = ' + enviado.conteudo + '; const t = await Ponto.cripto.descriptografar(env, ' + JSON.stringify(SENHA) + '); return Ponto.cripto.ehCriptografado(env) && (await Ponto.backup.validar(JSON.parse(t))).ok && JSON.parse(t).dados.funcionarios.length === 1;');
    reg('Envio: o Drive recebe só o arquivo criptografado, que descriptografado é o backup completo e íntegro', google.arquivos.length === 1 && valido && enviado.meta.parents[0] === google.pastas[0].id && enviado.meta.appProperties.criptografado === '1' && /^backup-ponto-cripto_/.test(enviado.name));
    reg('Envio: nenhum dado pessoal nem a senha aparecem no que foi enviado', !['PESSOA FICTÍCIA DO DRIVE', 'EMPRESA FICTÍCIA DO TESTE DO DRIVE', 'marcação fictícia', SENHA].some((t) => enviado.conteudo.includes(t) || JSON.stringify(enviado.meta).includes(t)));
    reg('Envio: data e contador registrados só após a confirmação (contador ' + sis0.alteracoesDesdeBackup + ' → ' + sis1.alteracoesDesdeBackup + ')', sis0.alteracoesDesdeBackup > 0 && sis1.alteracoesDesdeBackup === 0 && !!sis1.ultimoBackupEm);
    reg('Envio: evento registrado na auditoria', await a.js('return Ponto.app.store.all("auditoria").filter(x => x.acao === "backup-enviado-drive" && x.detalhes.arquivoId === ' + JSON.stringify(enviado.id) + ').length') === 1);
    reg('Envio: arquivo novo aparece na lista e fica selecionado', await a.js('return document.querySelectorAll("#drive-lista tbody tr").length') === 1 && /Selecionado:/.test(await a.js('return document.querySelector("#drive-selecionado").innerText')));
    await a.js('await Ponto.app.store.salvarEmpregador({ nome: "EMPRESA FICTÍCIA ALTERADA DEPOIS DO ENVIO", documento: "", endereco: "", responsavel: "" }); return true;');
    await a.clicar('#drive-enviar');
    await a.senhaNova(SENHA);
    await a.aguardar('document.querySelectorAll("#drive-lista tbody tr").length === 2', 'segundo envio');
    reg('Dois envios: arquivos e nomes diferentes, nenhum sobrescrito', google.arquivos.length === 2 && google.arquivos[0].name !== google.arquivos[1].name && google.arquivos[0].id !== google.arquivos[1].id);

    // Envio com falha
    await a.js('await Ponto.app.store.salvarObservacaoDia(' + JSON.stringify(empId) + ', "2026-03-02", "observação fictícia"); return true;');
    const sisAntes = await a.js('return Ponto.app.store.sistema()');
    google.modo.upload = '500';
    await a.js('document.querySelector("#toasts").innerHTML = ""; return true;');
    await a.clicar('#drive-enviar');
    await a.senhaNova(SENHA);
    await a.aguardar('!document.querySelector("dialog.modal [name=senha2]")');
    const tFalha = await a.modal();
    google.modo.upload = null;
    const sisDepois = await a.js('return Ponto.app.store.sistema()');
    reg('Envio com falha: mensagem "NÃO confirmado", sem mensagem de sucesso', /NÃO confirmado/.test(tFalha) && !/confirmado pelo Google/.test(await a.toasts()));
    reg('Envio com falha: contador e data não são alterados, nenhum arquivo criado', sisDepois.alteracoesDesdeBackup === sisAntes.alteracoesDesdeBackup && sisDepois.ultimoBackupEm === sisAntes.ultimoBackupEm && google.arquivos.length === 2);

    // Erro na listagem e token expirado
    google.modo.listar = 'limite';
    await a.clicar('#drive-atualizar');
    reg('Erro na listagem: mensagem de limite da API', /Limite de uso/.test(await a.modal()));
    google.modo.listar = null;
    google.modo.proximo401 = true;
    await a.clicar('#drive-atualizar');
    const t401 = await a.modal();
    reg('Token expirado (401): aviso para conectar de novo e status "expirado"', /expirou/.test(t401) && await a.estado() === 'expirado');
    await a.clicar('#drive-conectar');
    await a.aguardar('document.querySelector("#drive-status").dataset.estado === "conectado" && document.querySelectorAll("#drive-lista tbody tr").length === 2', 'reconexão');
    reg('Reconexão após expirar: lista volta a funcionar', true);

    // Recuperação: download, prévia, cancelamento
    const antesRec = await a.js(SNAP);
    const idAntigo = google.arquivos[0].id;
    await a.js(selArq(idAntigo) + '.click(); return true;');
    await a.aguardar('document.querySelector("#drive-lista tr.selecionado input").value === ' + JSON.stringify(idAntigo), 'seleção');
    await a.cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
    await a.js('document.querySelector("#cartao-drive").scrollIntoView(); return true;');
    await esperar(200);
    fs.writeFileSync(path.join(SAIDA, 'tela-drive-conectado.png'), Buffer.from((await a.cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    reg('Seleção: arquivo escolhido identificado', (await a.js('return document.querySelector("#drive-selecionado").innerText')).includes(google.arquivos[0].name));
    await a.clicar('#drive-recuperar');
    await a.senhaArquivo(SENHA_ERRADA);
    await a.aguardar('/senha está incorreta/.test((document.querySelector("dialog.modal .erro-form") || {}).textContent || "")', 'recusa da senha errada');
    reg('Recuperação: senha errada é recusada, a janela continua aberta e nada muda', !(await a.js('return !!document.querySelector("#restaurar")')) && await a.js(SNAP) === antesRec);
    await a.senhaArquivo(SENHA);
    await a.aguardar('document.querySelector("#restaurar")', 'prévia do backup');
    const previa = await a.js('return document.querySelector("#resultado-validacao").innerText');
    reg('Recuperação: com a senha certa, o arquivo é descriptografado, validado e mostra a prévia (sem alterar nada)', /Backup válido/.test(previa) && /Backup criptografado/.test(previa) && await a.js(SNAP) === antesRec);
    await a.clicar('#restaurar');
    await a.aguardar('document.querySelector("dialog.modal [name=conf]")', 'confirmação');
    await a.js('document.querySelector("dialog.modal footer button").click(); return true;'); // Cancelar
    await esperar(300);
    reg('Cancelar a restauração não altera os dados', await a.js(SNAP) === antesRec);
    await a.clicar('#drive-recuperar');
    await a.aguardar('document.querySelector("dialog.modal [name=senha]")');
    await a.cancelarJanela();
    await a.aguardar('/Senha não informada/.test(document.querySelector("#resultado-validacao").innerText)', 'cancelamento da senha do arquivo');
    reg('Cancelar a senha do arquivo: restauração cancelada, sem botão de restaurar e dados intactos', !(await a.js('return !!document.querySelector("#restaurar")')) && await a.js(SNAP) === antesRec);

    // Arquivos inválidos no Drive
    const base = JSON.parse(await a.js('return await Ponto.cripto.descriptografar(' + google.arquivos[0].conteudo + ', ' + JSON.stringify(SENHA) + ')'));
    const env0 = JSON.parse(google.arquivos[0].conteudo);
    const flip = (b64, i) => { const b = Buffer.from(b64, 'base64'); b[i] ^= 1; return b.toString('base64'); };
    const hashRuim = JSON.stringify(Object.assign({}, base, { dados: Object.assign({}, base.dados, { funcionarios: base.dados.funcionarios.map((f) => Object.assign({}, f, { nome: 'ADULTERADO' })) }) }));
    const cifradoHashRuim = await a.js('return JSON.stringify(await Ponto.cripto.criptografar(' + JSON.stringify(hashRuim) + ', ' + JSON.stringify(SENHA) + '))');
    const ruinsCripto = {
      'criptografado com conteúdo alterado': { conteudo: JSON.stringify(Object.assign({}, env0, { dados: flip(env0.dados, 40) })), janela: true },
      'criptografado truncado': { conteudo: JSON.stringify(Object.assign({}, env0, { dados: env0.dados.slice(0, env0.dados.length - 400) })), janela: true },
      'criptografado com cabeçalho alterado': { conteudo: JSON.stringify(Object.assign({}, env0, { criadoEm: '2020-01-01T00:00:00.000Z' })), janela: true },
      'criptografado com parâmetros fora do aceito': { conteudo: JSON.stringify(Object.assign({}, env0, { kdf: Object.assign({}, env0.kdf, { iteracoes: 10 }) })), janela: false },
      'criptografado vazio': { conteudo: JSON.stringify(Object.assign({}, env0, { dados: '' })), janela: false },
      'criptografado cujo conteúdo tem hash incorreto': { conteudo: cifradoHashRuim, janela: 'ok' }
    };
    const ruins = {
      'não é JSON': '{"formato":"gerenciador-ponto-backup","da',
      'outro formato': JSON.stringify({ formato: 'outra-coisa' }),
      'versão incompatível': JSON.stringify(Object.assign({}, base, { versaoFormato: 99 })),
      'hash incorreto': JSON.stringify(Object.assign({}, base, { dados: Object.assign({}, base.dados, { funcionarios: base.dados.funcionarios.map((f) => Object.assign({}, f, { nome: 'ADULTERADO' })) }) })),
      'referência inválida': JSON.stringify(Object.assign({}, base, { dados: Object.assign({}, base.dados, { marcacoes: base.dados.marcacoes.concat([{ id: 'm-ficticia-x', employeeId: 'inexistente', dt: '2026-03-03 09:00', dataRef: '2026-03-03', origem: 'manual' }]) }), contagens: Object.assign({}, base.contagens, { marcacoes: base.contagens.marcacoes + 1 }) }))
    };
    for (const [rotulo, conteudo] of Object.entries(ruins)) {
      const id = 'arquivo-ruim-' + (++google.seq) + '-ficticio';
      google.arquivos.push({ id, name: 'backup-ponto_ruim_' + rotulo.replace(/\W+/g, '-') + '.json', conteudo, size: String(Buffer.byteLength(conteudo)), createdTime: new Date().toISOString(), meta: {} });
      await a.clicar('#drive-atualizar');
      await a.aguardar(selArq(id), 'arquivo ruim na lista');
      await a.js(selArq(id) + '.click(); return true;');
      await a.aguardar('document.querySelector("#drive-lista tr.selecionado input").value === ' + JSON.stringify(id));
      await a.js('document.querySelector("#resultado-validacao").innerHTML = ""; return true;'); // não confundir com o resultado anterior
      await a.clicar('#drive-recuperar');
      await a.aguardar('/Backup recusado/.test(document.querySelector("#resultado-validacao").innerText)', 'recusa ' + rotulo);
      reg('Arquivo do Drive recusado (' + rotulo + '): sem botão de restaurar e dados intactos', !(await a.js('return !!document.querySelector("#restaurar")')) && await a.js(SNAP) === antesRec);
    }
    for (const [rotulo, caso] of Object.entries(ruinsCripto)) {
      const id = 'arquivo-ruim-' + (++google.seq) + '-ficticio';
      google.arquivos.push({ id, name: 'backup-ponto-cripto_ruim_' + rotulo.replace(/\W+/g, '-') + '.json', conteudo: caso.conteudo, size: String(Buffer.byteLength(caso.conteudo)), createdTime: new Date().toISOString(), meta: { appProperties: { criptografado: '1' } } });
      await a.clicar('#drive-atualizar');
      await a.aguardar(selArq(id), 'arquivo ruim na lista');
      await a.js(selArq(id) + '.click(); return true;');
      await a.aguardar('document.querySelector("#drive-lista tr.selecionado input").value === ' + JSON.stringify(id));
      await a.js('document.querySelector("#resultado-validacao").innerHTML = ""; return true;'); // não confundir com o resultado anterior
      await a.clicar('#drive-recuperar');
      let erroNaJanela = '';
      if (caso.janela) {
        await a.senhaArquivo(SENHA); // a senha CERTA: a falha tem de vir da alteração do arquivo
        if (caso.janela === true) {
          await a.aguardar('/alterado/.test((document.querySelector("dialog.modal .erro-form") || {}).textContent || "")', 'erro na janela ' + rotulo);
          erroNaJanela = await a.erroJanela();
          await a.cancelarJanela();
        }
      }
      await a.aguardar('/Backup recusado/.test(document.querySelector("#resultado-validacao").innerText)', 'recusa ' + rotulo);
      reg('Arquivo do Drive recusado (' + rotulo + '): sem botão de restaurar e dados intactos' + (erroNaJanela ? ' — "' + erroNaJanela.slice(0, 60) + '…"' : ''),
        !(await a.js('return !!document.querySelector("#restaurar")')) && await a.js(SNAP) === antesRec && !(await a.js('return !!document.querySelector("dialog.modal")')));
    }

    // Backup antigo, sem criptografia: continua aceito e é identificado como tal
    const idLegado = 'arquivo-legado-' + (++google.seq) + '-ficticio';
    google.arquivos.push({ id: idLegado, name: 'backup-ponto_legado.json', conteudo: JSON.stringify(base, null, 1), size: String(Buffer.byteLength(JSON.stringify(base, null, 1))), createdTime: new Date().toISOString(), meta: { appProperties: { criptografado: '0' } } });
    await a.clicar('#drive-atualizar');
    await a.aguardar(selArq(idLegado));
    reg('Lista identifica backups criptografados e não criptografados', /não criptografado/.test(await a.js('return ' + selArq(idLegado) + '.closest("tr").innerText')) && /🔒 criptografado/.test(await a.js('return ' + selArq(google.arquivos[0].id) + '.closest("tr").innerText')));
    await a.js(selArq(idLegado) + '.click(); return true;');
    await a.aguardar('document.querySelector("#drive-lista tr.selecionado input").value === ' + JSON.stringify(idLegado));
    await a.clicar('#drive-recuperar');
    await a.aguardar('document.querySelector("#restaurar")', 'prévia do legado');
    reg('Backup antigo não criptografado: aceito sem pedir senha e identificado como "não é criptografado"', /não é criptografado/.test(await a.js('return document.querySelector("#protecao-backup").innerText')) && !(await a.js('return !!document.querySelector("dialog.modal")')) && await a.js(SNAP) === antesRec);
    await a.clicar('#descartar');

    // Arquivo criptografado baixado do Drive e restaurado pela opção LOCAL (Importar e restaurar)
    const arqLocal = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ponto-drive-arq-')), 'backup-criptografado-ficticio.json');
    fs.writeFileSync(arqLocal, google.arquivos[0].conteudo);
    await a.aguardar('document.querySelector("#arq-backup")');
    await a.arquivo('#arq-backup', arqLocal);
    await a.senhaArquivo(SENHA);
    await a.aguardar('document.querySelector("#restaurar")', 'prévia local');
    reg('Arquivo criptografado pela opção local: pede a senha, descriptografa e mostra a prévia', /Backup criptografado/.test(await a.js('return document.querySelector("#protecao-backup").innerText')) && await a.js(SNAP) === antesRec);
    await a.clicar('#descartar');
    fs.rmSync(path.dirname(arqLocal), { recursive: true, force: true });

    // Restauração bem-sucedida pelo fluxo existente (digitar RESTAURAR)
    await a.js(selArq(idAntigo) + '.click(); return true;');
    await a.aguardar('document.querySelector("#drive-lista tr.selecionado input").value === ' + JSON.stringify(idAntigo));
    await a.clicar('#drive-recuperar');
    await a.senhaArquivo(SENHA);
    await a.aguardar('document.querySelector("#restaurar")', 'prévia');
    await a.clicar('#restaurar');
    await a.aguardar('document.querySelector("dialog.modal [name=conf]")');
    await a.js('const d = document.querySelector("dialog.modal"); d.querySelector("[name=conf]").value = "RESTAURAR"; d.querySelector("footer button.perigo").click(); return true;');
    await a.aguardar('/Backup restaurado/.test(document.querySelector("#toasts").innerText)', 'restauração');
    reg('Restauração do backup criptografado: funcionários, marcações e demais dados idênticos aos do arquivo enviado', await a.js(SNAP) === snap1 && await a.js('return Ponto.app.store.empregador().nome') === 'EMPRESA FICTÍCIA DO TESTE DO DRIVE');
    const posRest = await a.js('const s = Ponto.app.store; return { copias: (await s.copiasSeguranca()).length, aud: s.all("auditoria").filter(x => x.acao === "backup-restaurado").length, cont: s.sistema().alteracoesDesdeBackup }');
    reg('Restauração: cópia interna anterior criada, auditoria registrada e contador zerado', posRest.copias === 1 && posRest.aud === 1 && posRest.cont === 0, JSON.stringify(posRest));
    await a.recarregar();
    reg('Restauração do Drive persiste após recarregar', await a.js(SNAP) === snap1);

    // Restauração com falha de gravação: nada parcial
    await a.js('await Ponto.app.store.salvarEmpregador({ nome: "EMPRESA FICTÍCIA ANTES DA FALHA", documento: "", endereco: "", responsavel: "" }); return true;');
    const antesFalha = await a.js(SNAP);
    await a.conectarDrive(); // a recarga tirou o token da memória
    await a.js(`const db = Ponto.app.store.db, w = db.write.bind(db);
      db.write = async (ops) => { if (ops.some(o => o.op === 'clear')) { const e = new Error('falha simulada de gravação'); e.name = 'QuotaExceededError'; throw e; } return w(ops); };
      ${selArq(idAntigo)}.click(); return true;`);
    await a.aguardar('document.querySelector("#drive-lista tr.selecionado input").value === ' + JSON.stringify(idAntigo));
    await a.clicar('#drive-recuperar');
    await a.senhaArquivo(SENHA);
    await a.aguardar('document.querySelector("#restaurar")');
    await a.clicar('#restaurar');
    await a.aguardar('document.querySelector("dialog.modal [name=conf]")');
    await a.js('const d = document.querySelector("dialog.modal"); d.querySelector("[name=conf]").value = "RESTAURAR"; d.querySelector("footer button.perigo").click(); return true;');
    const tRest = await a.modal();
    await a.recarregar();
    reg('Restauração com falha: erro informado e nenhum dado parcial (comparação completa após recarregar)', /Nenhum dado foi alterado|falha simulada/.test(tRest) && await a.js(SNAP) === antesFalha);

    // Aba de leitura
    await a.conectarDrive();
    b = await nav.pagina({ downloads });
    await b.abrir(URL_HTTP);
    await b.aguardar('Ponto.app.modo === "leitura" && document.querySelector("#drive-status")', 'aba de leitura');
    await b.aguardar('document.querySelector("#drive-status").dataset.estado === "desconectado"', 'biblioteca na aba B');
    reg('Aba de leitura: Client ID aproveitado, mas o token NÃO passa de uma aba para outra', await b.estado() === 'desconectado' && await a.estado() === 'conectado');
    await b.conectarDrive();
    const sisDbAntes = await b.js('return await Ponto.app.store.db.get("config", "sistema")');
    const nArq = google.arquivos.length;
    await b.clicar('#drive-enviar');
    await b.senhaNova(SENHA);
    await b.aguardar('/confirmado pelo Google Drive/.test(document.querySelector("#toasts").innerText)', 'envio pela aba de leitura');
    const sisDbDepois = await b.js('return await Ponto.app.store.db.get("config", "sistema")');
    reg('Aba de leitura: envio ao Drive permitido, sem registrar data nem contador', google.arquivos.length === nArq + 1 && /somente leitura/.test(await b.toasts()) && JSON.stringify(sisDbAntes) === JSON.stringify(sisDbDepois));
    await b.aguardar('document.querySelector("#drive-recuperar")');
    reg('Aba de leitura: "Recuperar backup do Drive" desativado, com explicação', await b.js('return document.querySelector("#drive-recuperar").disabled') && /bloqueada nesta aba/.test(await b.js('return document.querySelector("#drive-recuperar-leitura").innerText')));
    const rej = await b.js('try { await Ponto.app.store.restaurarBackup(' + google.arquivos[0].conteudo + '); return "gravou"; } catch (e) { return e.message; }');
    reg('Aba de leitura: restauração direta pela camada de dados recusada', /somente leitura/.test(rej));
    reg('Bloqueio entre abas preservado: um único detentor do bloqueio de edição', await a.js('const q = await navigator.locks.query(); return q.held.filter(l => l.name === "gerenciador-ponto:editor").length') === 1 && await a.js('return Ponto.app.modo') === 'editor');

    // Desconectar
    const reqsAntes = google.reqs.length;
    await a.clicar('#drive-desconectar');
    await a.aguardar('document.querySelector("#drive-status").dataset.estado === "desconectado"', 'desconectado');
    await esperar(300);
    reg('Desconectar: token revogado e removido da memória; nenhum arquivo do Drive apagado', google.revogados.length >= 1 && google.reqs.length === reqsAntes && google.arquivos.length === nArq + 1 && !google.reqs.some((r) => r.metodo === 'DELETE'));
    reg('Desconectar: nenhuma ação do Drive disponível sem conectar', await a.js('return document.querySelector("#drive-enviar").disabled && !document.querySelector("#drive-recuperar")'));

    // Sem internet
    await a.cdp('Network.enable');
    await a.cdp('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await a.aguardar('document.querySelector("#drive-status").dataset.estado === "sem-internet"', 'status sem internet');
    await a.js('document.querySelector("#toasts").innerHTML = ""; return true;');
    await a.clicar('#exportar');
    await a.aguardar('/Backup gerado/.test(document.querySelector("#toasts").innerText)', 'exportação offline');
    await a.js('location.hash = "#/painel"; return true;');
    await a.aguardar('document.title.startsWith("Painel")');
    const gravouOffline = await a.js('await Ponto.app.store.salvarEmpregador({ nome: "EMPRESA FICTÍCIA SEM INTERNET", documento: "", endereco: "", responsavel: "" }); return Ponto.app.store.empregador().nome');
    reg('Sem internet: status "sem internet", backup local e gravações continuam funcionando', gravouOffline === 'EMPRESA FICTÍCIA SEM INTERNET');
    await a.cdp('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await a.js('location.hash = "#/backup"; return true;');
    await a.aguardar('document.querySelector("#drive-status") && document.querySelector("#drive-status").dataset.estado === "desconectado"', 'volta da internet');
    reg('Internet de volta: status volta a "desconectado"', true);

    // CSP: o navegador bloqueia qualquer outro destino
    const violacoesFluxo = (await a.js('return window.__csp')).concat(await b.js('return window.__csp'));
    const tentativa = await a.js(`window.__csp.length = 0;
      const r = [];
      for (const u of ['https://exemplo.invalid/x', 'https://www.googleapis.com/oauth2/v3/userinfo', 'https://accounts.google.com/o/oauth2/token', '${origem}/index.html']) {
        try { await fetch(u); r.push('ok'); } catch (e) { r.push('bloqueado'); } }
      await new Promise((ok) => { const s = document.createElement('script'); s.src = 'https://apis.google.com/js/api.js'; s.onload = s.onerror = ok; document.head.appendChild(s); });
      await new Promise((ok) => setTimeout(ok, 200));
      return { r, csp: window.__csp.map(v => v.diretiva + ' ' + v.uri) };`);
    reg('CSP: fetch para outros domínios, outros caminhos do Google e a própria origem bloqueados', tentativa.r.every((x) => x === 'bloqueado') && tentativa.csp.filter((c) => c.startsWith('connect-src')).length === 4, JSON.stringify(tentativa.csp));
    reg('CSP: script externo não autorizado (apis.google.com) bloqueado', tentativa.csp.some((c) => c.startsWith('script-src') && c.includes('apis.google.com')));
    reg('CSP: o fluxo do Drive (biblioteca, estilo, API, revogação) não gerou nenhuma violação', violacoesFluxo.length === 0, JSON.stringify(violacoesFluxo));
    reg('Nenhuma requisição saiu para endereços não simulados', google.externas.length === 0, google.externas.join(', '));

    // Sigilo do token
    const tokens = tokensVistos();
    const persistido = [];
    for (const pg of [a, b]) {
      persistido.push(await pg.js(`const out = [JSON.stringify(Object.entries(localStorage)), JSON.stringify(Object.entries(sessionStorage)), document.cookie];
        const db = await new Promise((ok, err) => { const r = indexedDB.open('gerenciador-ponto'); r.onsuccess = () => ok(r.result); r.onerror = () => err(r.error); });
        for (const nome of db.objectStoreNames) out.push(JSON.stringify(await new Promise((ok) => { const q = db.transaction(nome).objectStore(nome).getAll(); q.onsuccess = () => ok(q.result); })));
        db.close();
        out.push(JSON.stringify(await Ponto.app.store.exportarBackup()));
        out.push(document.documentElement.outerHTML);
        return out.join('\\n');`));
      persistido.push(pg.console.join('\n'));
    }
    persistido.push(google.arquivos.map((x) => x.conteudo).join('\n'));
    for (const f of fs.readdirSync(downloads)) persistido.push(fs.readFileSync(path.join(downloads, f), 'utf8'));
    const tudo = persistido.join('\n');
    reg('Token nunca gravado (localStorage, sessionStorage, IndexedDB, backups, página) nem escrito no console — ' + tokens.length + ' token(s) verificados',
      tokens.length >= 3 && tokens.every((t) => !tudo.includes(t)) && !tudo.includes('ya29.'));
    reg('Senha da criptografia (certa ou errada) nunca gravada nem escrita no console', !tudo.includes(SENHA) && !tudo.includes(SENHA_ERRADA) && !tudo.includes('senha ficticia'));
    reg('Nenhum erro de JavaScript nas abas', a.errosJS.length === 0 && b.errosJS.length === 0, a.errosJS.concat(b.errosJS).join(' | '));
  } finally {
    a.fechar(); if (b) b.fechar();
    await nav.fechar();
    srv.close();
    try { fs.rmSync(downloads, { recursive: true, force: true }); } catch (e) { /* */ }
  }
}

principal().catch((e) => { reg('Execução interrompida', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' ') : String(e)); }).finally(() => {
  fs.mkdirSync(SAIDA, { recursive: true });
  const aprovadas = res.filter((l) => l.startsWith('✔')).length;
  const resumo = '\n' + aprovadas + ' de ' + res.length + ' verificações aprovadas' + (falhas ? ' — ' + falhas + ' FALHA(S)' : '') + '.';
  fs.writeFileSync(path.join(SAIDA, 'resultado.txt'), res.join('\n') + resumo + '\n');
  console.log(resumo);
  process.exit(falhas ? 1 : 0);
});
