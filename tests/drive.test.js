/*
 * Testes da integração com o Google Drive (js/drive.js) — SEM conta Google e SEM rede.
 * A biblioteca de login do Google e a Drive API são substituídas por simulações; nenhum dado
 * é enviado para fora. Executar: node --test tests/drive.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../js/calc.js');
const BK = require('../js/backup.js');
const { Store } = require('../js/store.js');
const { MemoryAdapter } = require('../js/db.js');
const { Drive, ErroDrive, ESCOPO, PREF_CLIENT_ID, validarClientId, nomeArquivo, LIMITE_MULTIPART } = require('../js/drive.js');

const CLIENT_ID = '123456789012-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com';
const TOKEN = 'TOKEN-FICTICIO-DE-TESTE-NAO-E-REAL-0123456789';

// ------------------------------------------------------------------ simulações
function prefsSimuladas(inicial) {
  const m = new Map(Object.entries(inicial || {}));
  const gravados = [];
  return { gravados, get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => { gravados.push([k, v]); m.set(k, v); }, remove: (k) => m.delete(k) };
}

/** Simula google.accounts.oauth2. `login(cfg)` decide a resposta (callback ou error_callback). */
function gisSimulado(login) {
  const reg = { inits: [], revogados: [] };
  return {
    reg,
    initTokenClient(cfg) { reg.inits.push(cfg); return { requestAccessToken() { setTimeout(() => login(cfg), 0); } }; },
    hasGrantedAllScopes(resp, ...esc) { return esc.every((e) => String(resp.scope || '').split(' ').includes(e)); },
    revoke(t, cb) { reg.revogados.push(t); if (cb) cb(); }
  };
}
const loginOk = (extra) => (cfg) => cfg.callback(Object.assign({ access_token: TOKEN, expires_in: 3599, scope: ESCOPO, token_type: 'Bearer' }, extra || {}));

/** Simula a Drive API. `rotas` recebe (req) e devolve Response ou lança. Registra todas as requisições. */
function fetchSimulado(rotas) {
  const reqs = [];
  const f = async (url, init) => {
    const req = { url: String(url), method: (init && init.method) || 'GET', headers: (init && init.headers) || {}, body: init && init.body };
    reqs.push(req);
    return rotas(req);
  };
  f.reqs = reqs;
  return f;
}
const json = (obj, status, headers) => new Response(JSON.stringify(obj), { status: status || 200, headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}) });

/** Drive API simulada com estado (pasta + arquivos), como o Google responderia ao escopo drive.file. */
function driveApiSimulada(opts) {
  opts = opts || {};
  const estado = { pastas: [], arquivos: [], seq: 0 };
  const f = fetchSimulado(async (req) => {
    if (opts.falhar) { const r = await opts.falhar(req); if (r) return r; }
    if (req.headers.Authorization !== 'Bearer ' + TOKEN) return json({ error: { code: 401 } }, 401);
    const u = new URL(req.url);
    if (u.pathname === '/drive/v3/files' && req.method === 'GET') {
      const q = u.searchParams.get('q') || '';
      if (q.includes("value='pasta'")) return json({ files: estado.pastas });
      return json({ files: estado.arquivos.slice().reverse().map(({ conteudo, ...m }) => m) });
    }
    if (u.pathname === '/drive/v3/files' && req.method === 'POST') {
      const m = JSON.parse(req.body);
      const p = { id: 'pasta' + (++estado.seq) + '-ficticia', name: m.name };
      estado.pastas.push(p);
      return json(p);
    }
    if (u.pathname === '/upload/drive/v3/files' && u.searchParams.get('uploadType') === 'multipart') {
      const limite = /boundary=(\S+)/.exec(req.headers['Content-Type'])[1];
      const partes = req.body.split('--' + limite).slice(1, 3).map((p) => p.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, ''));
      const meta = JSON.parse(partes[0]);
      const conteudo = partes[1];
      const a = { id: 'arquivo' + (++estado.seq) + '-ficticio', name: meta.name, size: String(Buffer.byteLength(conteudo)), createdTime: new Date().toISOString(), meta, conteudo };
      estado.arquivos.push(a);
      return json({ id: a.id, name: a.name, size: a.size, createdTime: a.createdTime, mimeType: 'application/json' });
    }
    const mm = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
    if (mm && u.searchParams.get('alt') === 'media') {
      const a = estado.arquivos.find((x) => x.id === mm[1]);
      if (!a) return json({ error: { code: 404, errors: [{ reason: 'notFound' }] } }, 404);
      return new Response(a.conteudo, { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return json({ error: { code: 400 } }, 400);
  });
  f.estado = estado;
  return f;
}

function novoDrive(opts) {
  opts = opts || {};
  return new Drive(Object.assign({
    protocolo: 'http:',
    armazenamento: prefsSimuladas({ [PREF_CLIENT_ID]: CLIENT_ID }),
    gis: gisSimulado(loginOk()),
    fetch: driveApiSimulada(),
    online: () => true
  }, opts));
}

async function backupFicticio() {
  const s = await new Store(new MemoryAdapter(), { hoje: () => '2026-05-20' }).init();
  await s.salvarFuncionario({ nome: 'Pessoa Fictícia de Teste', admissao: '2026-01-01', jornada: { semana: C.semanaExemplo(), regras: {} }, banco: { compInicial: '2026-01', saldoInicialMin: 0 } });
  return { s, ...(await s.gerarBackupParaEnvio()) };
}

const rejeitaCom = (codigo) => (e) => { assert.ok(e instanceof ErroDrive, 'esperado ErroDrive, veio ' + e); assert.equal(e.codigo, codigo, e.message); return true; };

// ------------------------------------------------------------------ configuração
test('Client ID: ausente, inválido, segredo recusado e válido aceito; file:// fica indisponível', () => {
  const vazio = novoDrive({ armazenamento: prefsSimuladas() });
  assert.equal(vazio.estado().codigo, 'aguardando-configuracao');
  assert.match(vazio.estado().texto, /Aguardando configuração/);
  for (const v of ['', '   ', 'abc', '123.apps.googleusercontent.com', CLIENT_ID + '.evil.com', 'https://' + CLIENT_ID]) {
    assert.equal(validarClientId(v).ok, false, v);
    assert.throws(() => vazio.definirClientId(v), rejeitaCom('client-id'));
  }
  assert.throws(() => vazio.definirClientId('GOCSPX-abcdefghijklmnop'), /client secret/);
  assert.equal(vazio.estado().codigo, 'aguardando-configuracao');
  assert.equal(vazio.definirClientId('  ' + CLIENT_ID + ' '), CLIENT_ID);
  assert.equal(vazio.estado().codigo, 'desconectado');
  // valor inválido gravado por fora é ignorado
  assert.equal(novoDrive({ armazenamento: prefsSimuladas({ [PREF_CLIENT_ID]: 'lixo' }) }).estado().codigo, 'aguardando-configuracao');
  const local = novoDrive({ protocolo: 'file:' });
  assert.equal(local.estado().codigo, 'indisponivel-local');
  assert.match(local.estado().texto, /localhost:8080/);
});

test('Biblioteca do Google: carregada só sob demanda; sem internet ou falha de carga não quebra', async () => {
  let cargas = 0;
  const semGis = { carregarScript: async () => { cargas++; throw new Error('falhou'); }, gis: null };
  const d = novoDrive(Object.assign({}, semGis, { online: () => false }));
  assert.equal(await d.preparar(), false);
  assert.equal(d.estado().codigo, 'sem-internet');
  assert.equal(cargas, 0); // sem internet: nem tenta
  const d2 = novoDrive(semGis);
  assert.equal(await d2.preparar(), false);
  assert.equal(d2.estado().codigo, 'erro');
  assert.equal(cargas, 1);
  assert.equal(await d2.preparar(), false); // pode tentar de novo
  assert.equal(cargas, 2);
  await assert.rejects(d2.conectar(), rejeitaCom('nao-carregado'));
  const semConfig = novoDrive({ armazenamento: prefsSimuladas(), carregarScript: async () => { cargas++; } });
  assert.equal(await semConfig.preparar(), false);
  assert.equal(cargas, 2); // sem Client ID: não carrega nada
});

// ------------------------------------------------------------------ login
test('Login: sucesso, cancelado, janela bloqueada, negado, permissão do Drive desmarcada e erro', async () => {
  const ok = novoDrive();
  const est = await ok.conectar();
  assert.equal(est.codigo, 'conectado');
  assert.equal(ok.conectado(), true);
  const cfg = ok._gis.reg.inits[0];
  assert.equal(cfg.client_id, CLIENT_ID);
  assert.equal(cfg.scope, ESCOPO); // escopo único e mínimo

  const casos = [
    [(c) => c.error_callback({ type: 'popup_closed' }), 'cancelado', 'desconectado'],
    [(c) => c.error_callback({ type: 'popup_failed_to_open' }), 'popup-bloqueado', 'erro'],
    [(c) => c.error_callback({ type: 'unknown' }), 'autenticacao', 'erro'],
    [(c) => c.callback({ error: 'access_denied' }), 'negado', 'erro'],
    [(c) => c.callback({ error: 'invalid_client' }), 'autenticacao', 'erro'],
    [(c) => c.callback({}), 'resposta', 'erro'],
    [loginOk({ scope: 'email profile' }), 'negado', 'erro']
  ];
  for (const [login, codigo, estado] of casos) {
    const gis = gisSimulado(login);
    const d = novoDrive({ gis });
    await assert.rejects(d.conectar(), rejeitaCom(codigo));
    assert.equal(d.conectado(), false);
    assert.equal(d.estado().codigo, estado, codigo);
    if (codigo === 'negado' && login !== casos[3][0]) assert.deepEqual(gis.reg.revogados, [TOKEN]); // token parcial é revogado
  }
});

test('Token ausente ou expirado: nenhuma chamada à API; 401 descarta o token', async () => {
  const api = driveApiSimulada();
  const { backup } = await backupFicticio();
  const d = novoDrive({ fetch: api });
  await assert.rejects(d.enviar(backup), rejeitaCom('sem-token'));
  await assert.rejects(d.listar(), rejeitaCom('sem-token'));
  assert.equal(api.reqs.length, 0);

  let agora = 1000000;
  const d2 = novoDrive({ fetch: api, agora: () => agora });
  await d2.conectar();
  agora += 3600 * 1000; // passou da validade
  assert.equal(d2.estado().codigo, 'expirado');
  await assert.rejects(d2.listar(), rejeitaCom('expirado'));
  assert.equal(api.reqs.length, 0);

  const api401 = fetchSimulado(async () => json({ error: { code: 401 } }, 401));
  const d3 = novoDrive({ fetch: api401 });
  await d3.conectar();
  await assert.rejects(d3.listar(), rejeitaCom('expirado'));
  assert.equal(d3.estado().codigo, 'expirado');
  await assert.rejects(d3.listar(), rejeitaCom('expirado'));
  assert.equal(api401.reqs.length, 1); // a segunda tentativa nem chega à rede
});

// ------------------------------------------------------------------ envio
test('Envio confirmado: cria pasta uma vez, arquivo novo com metadados e o mesmo conteúdo do backup', async () => {
  const api = driveApiSimulada();
  const d = novoDrive({ fetch: api });
  await d.conectar();
  const { backup } = await backupFicticio();
  const r = await d.enviar(backup);
  assert.match(r.id, /^arquivo\d+-ficticio$/);
  assert.match(r.name, /^backup-ponto_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_[0-9a-f]{6}\.json$/);
  assert.equal(r.size, Buffer.byteLength(JSON.stringify(backup, null, 1)));
  assert.ok(r.createdTime);
  const enviado = api.estado.arquivos[0];
  assert.deepEqual(JSON.parse(enviado.conteudo), JSON.parse(JSON.stringify(backup))); // formato e hash preservados
  assert.equal((await BK.validar(JSON.parse(enviado.conteudo))).ok, true);
  assert.deepEqual(enviado.meta.parents, [api.estado.pastas[0].id]);
  assert.equal(enviado.meta.appProperties.gerenciadorPonto, 'backup');
  assert.match(enviado.meta.description, /não criptografado/);
  for (const q of api.reqs) {
    assert.equal(q.headers.Authorization, 'Bearer ' + TOKEN);
    assert.ok(/^https:\/\/www\.googleapis\.com\/(upload\/)?drive\/v3\/files/.test(q.url), q.url); // só endpoints da Drive API
    assert.notEqual(q.method, 'DELETE'); // nunca apaga nada
  }
  await d.enviar(backup);
  assert.equal(api.estado.pastas.length, 1); // pasta reaproveitada
});

test('Dois envios do mesmo backup geram arquivos e nomes diferentes (nada é sobrescrito)', async () => {
  const api = driveApiSimulada();
  const d = novoDrive({ fetch: api });
  await d.conectar();
  const { backup } = await backupFicticio();
  const a = await d.enviar(backup);
  const b = await d.enviar(backup);
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.name, b.name);
  assert.equal(api.estado.arquivos.length, 2);
  assert.ok(api.reqs.every((q) => q.method === 'GET' || q.method === 'POST'));
  assert.throws(() => nomeArquivo('não é data', 'x'), rejeitaCom('backup'));
});

test('Envio com falha nunca é dado como confirmado', async () => {
  const { backup } = await backupFicticio();
  const casos = [
    [async (q) => (q.url.includes('/upload/') ? json({ error: { code: 500 } }, 500) : null), 'servidor'],
    [async (q) => (q.url.includes('/upload/') ? json({ error: { code: 403, errors: [{ reason: 'storageQuotaExceeded' }] } }, 403) : null), 'sem-espaco'],
    [async (q) => (q.url.includes('/upload/') ? json({ error: { code: 403, errors: [{ reason: 'insufficientPermissions' }] } }, 403) : null), 'permissao'],
    [async (q) => (q.url.includes('/upload/') ? json({ error: { code: 429 } }, 429) : null), 'limite'],
    [async (q) => (q.url.includes('/upload/') ? json({ name: 'sem-id' }) : null), 'resposta'],
    [async (q) => (q.url.includes('/upload/') ? new Response('<html>erro</html>', { status: 200 }) : null), 'resposta'],
    [async (q) => { if (q.url.includes('/upload/')) throw new TypeError('Failed to fetch'); return null; }, 'rede']
  ];
  for (const [falhar, codigo] of casos) {
    const d = novoDrive({ fetch: driveApiSimulada({ falhar }) });
    await d.conectar();
    await assert.rejects(d.enviar(backup), rejeitaCom(codigo));
    assert.equal(d.conectado(), true); // uma falha da API não derruba a conexão (exceto 401)
  }
  // tamanho devolvido diferente do enviado
  const api = driveApiSimulada();
  const tamanhoErrado = fetchSimulado(async (q) => {
    const r = await api(q.url, { method: q.method, headers: q.headers, body: q.body });
    if (!q.url.includes('/upload/')) return r;
    const j = await r.json();
    return json(Object.assign(j, { size: '1' }));
  });
  const d = novoDrive({ fetch: tamanhoErrado });
  await d.conectar();
  await assert.rejects(d.enviar(backup), rejeitaCom('tamanho'));
  // sem internet: falha antes de qualquer requisição
  let online = true;
  const api2 = driveApiSimulada();
  const d2 = novoDrive({ fetch: api2, online: () => online });
  await d2.conectar();
  online = false;
  await assert.rejects(d2.enviar(backup), rejeitaCom('sem-internet'));
  assert.equal(api2.reqs.length, 0);
  assert.equal(d2.estado().codigo, 'sem-internet');
  // backup inválido não é enviado
  const d3 = novoDrive({ fetch: api2 });
  await d3.conectar();
  await assert.rejects(d3.enviar({ formato: 'outro' }), rejeitaCom('backup'));
});

test('Envio grande usa o envio "resumable" e confere a confirmação', async () => {
  const { backup } = await backupFicticio();
  const grande = Object.assign({}, backup, { preenchimento: 'x'.repeat(LIMITE_MULTIPART + 10) });
  const tamanho = Buffer.byteLength(JSON.stringify(grande, null, 1));
  const SESSAO = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=SESSAO-FICTICIA';
  let nome = null;
  const f = fetchSimulado(async (q) => {
    if (decodeURIComponent(q.url).includes("value='pasta'")) return json({ files: [{ id: 'pasta-ficticia-1', name: 'p' }] });
    if (q.url.includes('uploadType=resumable') && q.method === 'POST') {
      nome = JSON.parse(q.body).name;
      assert.equal(q.headers['X-Upload-Content-Length'], String(tamanho));
      return new Response(null, { status: 200, headers: { Location: SESSAO } });
    }
    if (q.url === SESSAO && q.method === 'PUT') { assert.equal(q.body.byteLength, tamanho); return json({ id: 'arquivo-grande-ficticio', name: nome, size: String(tamanho) }); }
    return json({}, 400);
  });
  const d = novoDrive({ fetch: f });
  await d.conectar();
  const r = await d.enviar(grande);
  assert.equal(r.id, 'arquivo-grande-ficticio');
  assert.equal(r.size, tamanho);
  // sessão para um endereço fora da API é recusada
  const f2 = fetchSimulado(async (q) => (decodeURIComponent(q.url).includes("value='pasta'") ? json({ files: [{ id: 'pasta-ficticia-1' }] }) : new Response(null, { status: 200, headers: { Location: 'https://exemplo.invalid/x' } })));
  const d2 = novoDrive({ fetch: f2 });
  await d2.conectar();
  await assert.rejects(d2.enviar(grande), rejeitaCom('resposta'));
  assert.equal(f2.reqs.length, 2);
});

// ------------------------------------------------------------------ listagem e download
test('Listagem: vazia, com arquivos (várias páginas) e com erro', async () => {
  const vazia = driveApiSimulada();
  const d = novoDrive({ fetch: vazia });
  await d.conectar();
  assert.deepEqual(await d.listar(), []);
  assert.ok(decodeURIComponent(vazia.reqs[0].url).includes("appProperties has { key='gerenciadorPonto' and value='backup' } and trashed=false"));

  const paginas = fetchSimulado(async (q) => {
    const u = new URL(q.url);
    if (!u.searchParams.get('pageToken')) return json({ files: [{ id: 'arquivo-ficticio-02', name: 'b2.json', size: '20', createdTime: '2026-05-02T10:00:00Z', appProperties: { criptografado: '1' } }, { lixo: true }], nextPageToken: 'P2' });
    return json({ files: [{ id: 'arquivo-ficticio-01', name: 'b1.json', createdTime: '2026-05-01T10:00:00Z' }] });
  });
  const d2 = novoDrive({ fetch: paginas });
  await d2.conectar();
  assert.deepEqual(await d2.listar(), [
    { id: 'arquivo-ficticio-02', name: 'b2.json', size: 20, createdTime: '2026-05-02T10:00:00Z', criptografado: true },
    { id: 'arquivo-ficticio-01', name: 'b1.json', size: null, createdTime: '2026-05-01T10:00:00Z', criptografado: false }
  ]);
  assert.ok(paginas.reqs.every((q) => q.method === 'GET'));

  for (const [resp, codigo] of [[json({ error: { code: 403, errors: [{ reason: 'userRateLimitExceeded' }] } }, 403), 'limite'],
    [json({ error: { code: 500 } }, 503), 'servidor'], [json({ semFiles: true }), 'resposta'], [new Response('não é json'), 'resposta']]) {
    const d3 = novoDrive({ fetch: fetchSimulado(async () => resp.clone()) });
    await d3.conectar();
    await assert.rejects(d3.listar(), rejeitaCom(codigo));
  }
});

test('Download: baixa o arquivo selecionado; id inválido e arquivo inexistente são recusados', async () => {
  const api = driveApiSimulada();
  const d = novoDrive({ fetch: api });
  await d.conectar();
  const { backup } = await backupFicticio();
  const a = await d.enviar(backup);
  await d.enviar(backup);
  const bytes = await d.baixar(a.id);
  assert.ok(bytes instanceof Uint8Array);
  assert.equal(new TextDecoder().decode(bytes), api.estado.arquivos[0].conteudo);
  const ultima = api.reqs[api.reqs.length - 1];
  assert.equal(ultima.url, 'https://www.googleapis.com/drive/v3/files/' + a.id + '?alt=media');
  for (const id of ['', '../x', 'a b', null, 'curto']) await assert.rejects(d.baixar(id), rejeitaCom('id'));
  await assert.rejects(d.baixar('arquivo-inexistente-ficticio'), rejeitaCom('nao-encontrado'));
});

// ------------------------------------------------------------------ desconectar e sigilo do token
test('Desconectar: revoga, tira o token da memória e não apaga arquivos do Drive', async () => {
  const api = driveApiSimulada();
  const gis = gisSimulado(loginOk());
  const d = novoDrive({ fetch: api, gis });
  await d.conectar();
  const { backup } = await backupFicticio();
  await d.enviar(backup);
  const n = api.reqs.length;
  d.desconectar();
  assert.deepEqual(gis.reg.revogados, [TOKEN]);
  assert.equal(d.conectado(), false);
  assert.equal(d.estado().codigo, 'desconectado');
  await assert.rejects(d.listar(), rejeitaCom('sem-token'));
  assert.equal(api.reqs.length, n); // nenhuma requisição (muito menos DELETE)
  assert.equal(api.estado.arquivos.length, 1);
  d.definirClientId(CLIENT_ID); // mesmo ID: nada muda
  await d.conectar();
  d.definirClientId('999999999999-outroid.apps.googleusercontent.com'); // trocar o ID desconecta
  assert.equal(d.conectado(), false);
});

test('Token nunca é gravado em armazenamento, devolvido pelo estado ou escrito no console', async () => {
  const saida = [];
  const orig = {};
  for (const k of ['log', 'info', 'warn', 'error', 'debug']) { orig[k] = console[k]; console[k] = (...a) => saida.push(a.map((x) => (x && x.stack) || String(x)).join(' ')); }
  try {
    const prefs = prefsSimuladas();
    const api = driveApiSimulada({ falhar: async (q) => (q.url.includes('alt=media') ? json({ error: { code: 500 } }, 500) : null) });
    const d = novoDrive({ armazenamento: prefs, fetch: api });
    d.definirClientId(CLIENT_ID);
    await d.conectar();
    const { s, backup, marco } = await backupFicticio();
    const arq = await d.enviar(backup);
    await s.registrarEnvioDrive(backup, marco, arq);
    await d.listar();
    await assert.rejects(d.baixar(arq.id));
    const visivel = [JSON.stringify(d), JSON.stringify(d.estado()), Object.keys(d).join(','), JSON.stringify(prefs.gravados),
      JSON.stringify(api.estado.arquivos.map((a) => a.conteudo)), JSON.stringify(s.dadosCompletos()), JSON.stringify(await s.exportarBackup()), saida.join('\n')].join('\n');
    assert.ok(!visivel.includes(TOKEN), 'o token apareceu em dados persistentes, no estado ou no console');
    assert.ok(!visivel.includes('ya29.'));
    assert.deepEqual(prefs.gravados.map((g) => g[0]), [PREF_CLIENT_ID]); // só o Client ID público é preferência
  } finally { Object.assign(console, orig); }
});

// ------------------------------------------------------------------ recuperação pelo fluxo existente
test('Recuperação: arquivo baixado passa pela validação existente; inválidos são recusados sem alterar dados', async () => {
  const api = driveApiSimulada();
  const d = novoDrive({ fetch: api });
  await d.conectar();
  const { s, backup } = await backupFicticio();
  const arq = await d.enviar(backup);

  const destino = await new Store(new MemoryAdapter(), { hoje: () => '2026-05-20' }).init();
  const ler = async (id) => JSON.parse(new TextDecoder().decode(await d.baixar(id)));
  const obj = await ler(arq.id);
  assert.equal((await destino.validarBackup(obj)).ok, true);
  await destino.restaurarBackup(obj);
  assert.deepEqual(destino.funcionarios().map((f) => f.nome), ['Pessoa Fictícia de Teste']);

  // arquivos adulterados colocados no Drive simulado: mesmo resultado da restauração local
  const adulterar = (fn) => { const o = JSON.parse(JSON.stringify(backup)); fn(o); return o; };
  const ruins = {
    'não é backup': { qualquer: 1 },
    'versão incompatível': adulterar((o) => { o.versaoFormato = 99; }),
    'hash incorreto': adulterar((o) => { o.dados.funcionarios[0].nome = 'Alterado'; }),
    'referência inválida': adulterar((o) => { o.dados.marcacoes.push({ id: 'm-x', employeeId: 'inexistente', dt: '2026-05-04 09:00', dataRef: '2026-05-04', origem: 'manual' }); o.contagens.marcacoes++; })
  };
  const antes = JSON.stringify(destino.dadosCompletos());
  for (const [rotulo, o] of Object.entries(ruins)) {
    api.estado.arquivos.push({ id: 'arquivo-ruim-' + rotulo.replace(/\W/g, '') + '-x', name: rotulo, conteudo: JSON.stringify(o) });
    const baixado = await ler(api.estado.arquivos[api.estado.arquivos.length - 1].id);
    const v = await destino.validarBackup(baixado);
    assert.equal(v.ok, false, rotulo);
    await assert.rejects(destino.restaurarBackup(baixado), /Backup inválido/, rotulo);
  }
  api.estado.arquivos.push({ id: 'arquivo-corrompido-x', name: 'c', conteudo: '{"formato": "gerenciador-ponto-backup", "dad' });
  const corrompido = new TextDecoder().decode(await d.baixar('arquivo-corrompido-x'));
  assert.throws(() => JSON.parse(corrompido), SyntaxError); // a tela mostra "não é um JSON válido" e não restaura
  assert.equal(JSON.stringify(destino.dadosCompletos()), antes);
  assert.ok(s);
});

test('Recuperação: falha durante a restauração não deixa dados parciais; aba de leitura não restaura', async () => {
  const api = driveApiSimulada();
  const d = novoDrive({ fetch: api });
  await d.conectar();
  const { backup } = await backupFicticio();
  const arq = await d.enviar(backup);
  const obj = JSON.parse(new TextDecoder().decode(await d.baixar(arq.id)));

  const adapter = new MemoryAdapter();
  const destino = await new Store(adapter, { hoje: () => '2026-05-20' }).init();
  await destino.salvarFuncionario({ nome: 'Pessoa Fictícia Atual', admissao: '2026-01-01', jornada: { semana: C.semanaExemplo(), regras: {} }, banco: { compInicial: '2026-01', saldoInicialMin: 0 } });
  const antes = JSON.stringify(destino.dadosCompletos());
  const write = adapter.write.bind(adapter);
  adapter.write = async (ops) => { if (ops.some((o) => o.op === 'clear')) throw new Error('falha simulada de gravação'); return write(ops); };
  await assert.rejects(destino.restaurarBackup(obj), /falha simulada/);
  await destino.recarregar();
  assert.equal(JSON.stringify(destino.dadosCompletos()), antes);
  adapter.write = write;

  const leitor = await new Store(Object.create(adapter), { editavel: false }).init();
  await assert.rejects(leitor.restaurarBackup(obj), /somente leitura/);
  await destino.recarregar();
  assert.equal(JSON.stringify(destino.dadosCompletos()), antes);
  // envio pela aba de leitura é permitido (gera o backup sem registrar nada)
  const env = await leitor.gerarBackupParaEnvio();
  const r = await d.enviar(env.backup);
  assert.ok(r.id);
  await assert.rejects(leitor.registrarEnvioDrive(env.backup, env.marco, r), /somente leitura/);
});
