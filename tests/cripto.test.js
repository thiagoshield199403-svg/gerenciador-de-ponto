/*
 * Testes da criptografia de backups (js/cripto.js) e do envio criptografado ao Drive (simulado).
 * Somente dados fictícios. Executar: node --test tests/cripto.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../js/calc.js');
const BK = require('../js/backup.js');
const K = require('../js/cripto.js');
const { Store } = require('../js/store.js');
const { MemoryAdapter } = require('../js/db.js');
const { Drive, PREF_CLIENT_ID, ESCOPO } = require('../js/drive.js');

const SENHA = 'frase de teste fictícia 2026';
const RAPIDO = { iteracoes: 100000 }; // mínimo aceito; só para acelerar os testes

async function storeFicticio() {
  const s = await new Store(new MemoryAdapter(), { hoje: () => '2026-05-20' }).init();
  const f = await s.salvarFuncionario({ nome: 'PESSOA FICTÍCIA DA CRIPTOGRAFIA', cpf: '529.982.247-25', salario: 1234.56, admissao: '2026-01-01',
    jornada: { semana: C.semanaExemplo(), regras: {} }, banco: { compInicial: '2026-01', saldoInicialMin: 0 } });
  for (const h of ['09:00', '12:00', '14:00', '18:00']) await s.incluirMarcacao(f.id, '2026-03-02 ' + h, 'marcação fictícia');
  return { s, f };
}

const rejeitaCom = (codigo) => (e) => { assert.equal(e.name, 'ErroCripto', String(e)); assert.equal(e.codigo, codigo, e.message); return true; };
const copia = (o) => JSON.parse(JSON.stringify(o));

test('criptografa e descriptografa um backup fictício recuperando exatamente o conteúdo original', async () => {
  const { s } = await storeFicticio();
  const backup = await s.exportarBackup();
  const texto = JSON.stringify(backup, null, 1);
  const env = await K.criptografar(texto, SENHA); // parâmetros padrão (600.000 iterações)
  assert.equal(env.formato, K.FORMATO);
  assert.equal(env.kdf.iteracoes, 600000);
  assert.equal(env.cifra.algoritmo, 'AES-GCM');
  const arquivo = JSON.stringify(env);
  for (const trecho of ['PESSOA FICTÍCIA', '529.982.247-25', '1234.56', 'marcação fictícia', backup.integridade.hash, SENHA]) {
    assert.ok(!arquivo.includes(trecho), 'o arquivo criptografado não pode conter "' + trecho + '"');
  }
  const volta = await K.descriptografar(copia(env), SENHA);
  assert.equal(volta, texto);
  const obj = JSON.parse(volta);
  assert.deepEqual(obj, copia(backup));
  assert.equal((await BK.validar(obj)).ok, true); // o SHA-256 interno continua valendo
});

test('cada criptografia usa sal e IV novos', async () => {
  const a = await K.criptografar('conteúdo fictício', SENHA, RAPIDO);
  const b = await K.criptografar('conteúdo fictício', SENHA, RAPIDO);
  assert.notEqual(a.kdf.sal, b.kdf.sal);
  assert.notEqual(a.cifra.iv, b.cifra.iv);
  assert.notEqual(a.dados, b.dados);
});

test('senha incorreta falha sem devolver conteúdo', async () => {
  const env = await K.criptografar('{"x":1}', SENHA, RAPIDO);
  for (const errada of ['frase de teste fictícia 2025', SENHA + ' ', SENHA.toUpperCase()]) {
    await assert.rejects(K.descriptografar(copia(env), errada), rejeitaCom('senha-ou-adulterado'));
  }
  await assert.rejects(K.descriptografar(copia(env), ''), rejeitaCom('sem-senha'));
  await assert.rejects(K.descriptografar(copia(env), null), rejeitaCom('sem-senha'));
});

test('a mesma senha digitada com acentos compostos ou decompostos funciona (normalização NFC)', async () => {
  const composta = 'coração do relógio fictício';
  const env = await K.criptografar('ok', composta, RAPIDO);
  assert.equal(await K.descriptografar(copia(env), composta.normalize('NFD')), 'ok');
});

test('qualquer alteração no conteúdo ou no cabeçalho é detectada', async () => {
  const env = await K.criptografar(JSON.stringify({ dado: 'fictício', n: [1, 2, 3] }), SENHA, RAPIDO);
  const bytes = Buffer.from(env.dados, 'base64');
  const flip = (i) => { const b = Buffer.from(bytes); b[i] ^= 0x01; return b.toString('base64'); };
  const outroIv = Buffer.from(env.cifra.iv, 'base64'); outroIv[0] ^= 1;
  const outroSal = Buffer.from(env.kdf.sal, 'base64'); outroSal[5] ^= 1;
  const casos = {
    'byte do início do conteúdo': (e) => { e.dados = flip(0); },
    'byte da tag de autenticação': (e) => { e.dados = flip(bytes.length - 1); },
    'IV trocado': (e) => { e.cifra.iv = outroIv.toString('base64'); },
    'sal trocado': (e) => { e.kdf.sal = outroSal.toString('base64'); },
    'iterações trocadas (dentro do limite)': (e) => { e.kdf.iteracoes = 100001; },
    'data de criação trocada': (e) => { e.criadoEm = '2020-01-01T00:00:00.000Z'; },
    'aviso trocado': (e) => { e.aviso = 'texto alterado'; },
    'conteúdo truncado': (e) => { e.dados = bytes.subarray(0, bytes.length - 5).toString('base64'); }
  };
  for (const [rotulo, alterar] of Object.entries(casos)) {
    const e = copia(env); alterar(e);
    await assert.rejects(K.descriptografar(e, SENHA), rejeitaCom('senha-ou-adulterado'), rotulo);
  }
  assert.equal(await K.descriptografar(copia(env), SENHA), JSON.stringify({ dado: 'fictício', n: [1, 2, 3] })); // o original continua bom
});

test('arquivos vazios, truncados, com outro formato ou parâmetros fora do aceito são recusados antes de tentar a senha', async () => {
  const env = await K.criptografar('conteúdo fictício', SENHA, RAPIDO);
  const casos = [
    [{}, 'formato'], [null, 'formato'], [[], 'formato'], [{ formato: 'gerenciador-ponto-backup' }, 'formato'],
    [Object.assign(copia(env), { versaoFormato: 2 }), 'versao'],
    [Object.assign(copia(env), { dados: '' }), 'formato'],
    [Object.assign(copia(env), { dados: 'AAAA' }), 'formato'],
    [Object.assign(copia(env), { dados: 'não é base64!' }), 'formato'],
    [Object.assign(copia(env), { criadoEm: 'ontem' }), 'formato'],
    [Object.assign(copia(env), { kdf: Object.assign({}, env.kdf, { iteracoes: 1000 }) }), 'parametros'],
    [Object.assign(copia(env), { kdf: Object.assign({}, env.kdf, { iteracoes: 1e9 }) }), 'parametros'], // evitaria travar a página
    [Object.assign(copia(env), { kdf: Object.assign({}, env.kdf, { hash: 'SHA-1' }) }), 'parametros'],
    [Object.assign(copia(env), { cifra: Object.assign({}, env.cifra, { algoritmo: 'AES-CBC' }) }), 'parametros'],
    [Object.assign(copia(env), { cifra: Object.assign({}, env.cifra, { iv: Buffer.alloc(8).toString('base64') }) }), 'parametros'],
    [Object.assign(copia(env), { kdf: null }), 'parametros']
  ];
  for (const [e, codigo] of casos) await assert.rejects(K.descriptografar(e, SENHA), rejeitaCom(codigo), JSON.stringify(e).slice(0, 80));
  assert.equal(K.ehCriptografado(env), true);
  assert.equal(K.ehCriptografado({ formato: 'gerenciador-ponto-backup' }), false);
  assert.equal(K.ehCriptografado({ name: 'backup-ponto-cripto_2026.json' }), false); // o nome do arquivo não decide nada
});

test('regras para criar a senha', async () => {
  assert.match(K.validarNovaSenha('curta'), /pelo menos 12/);
  assert.match(K.validarNovaSenha(' frase com espaço'), /espaço/);
  assert.match(K.validarNovaSenha(SENHA, SENHA + 'x'), /não são iguais/);
  assert.match(K.validarNovaSenha('x'.repeat(300)), /no máximo/);
  assert.equal(K.validarNovaSenha(SENHA, SENHA), null);
  await assert.rejects(K.criptografar('x', 'curta', RAPIDO), rejeitaCom('senha-fraca'));
  await assert.rejects(K.criptografar('', SENHA, RAPIDO), rejeitaCom('entrada'));
  await assert.rejects(K.criptografar('x', SENHA, { iteracoes: 10 }), rejeitaCom('parametros'));
});

test('restauração a partir do arquivo criptografado: falha não altera nada; sucesso restaura tudo com cópia interna e auditoria', async () => {
  const { s: origem, f } = await storeFicticio();
  const backup = await origem.exportarBackup();
  const env = await K.criptografar(JSON.stringify(backup, null, 1), SENHA, RAPIDO);

  const adapter = new MemoryAdapter();
  const destino = await new Store(adapter, { hoje: () => '2026-05-20' }).init();
  await destino.salvarFuncionario({ nome: 'PESSOA FICTÍCIA DO DESTINO', admissao: '2026-01-01', jornada: { semana: C.semanaExemplo(), regras: {} }, banco: { compInicial: '2026-01', saldoInicialMin: 0 } });
  const antes = JSON.stringify(destino.dadosCompletos());
  // mesmo caminho da tela: descriptografar -> JSON -> validar -> (confirmação) -> restaurar
  const preparar = async (e, senha) => { const obj = JSON.parse(await K.descriptografar(e, senha)); const v = await destino.validarBackup(obj); if (!v.ok) throw new Error('inválido'); return obj; };
  await assert.rejects(preparar(copia(env), 'senha errada fictícia'), /senha está incorreta/);
  const adulterado = copia(env); adulterado.dados = Buffer.from(Buffer.from(env.dados, 'base64').map((b, i) => (i === 10 ? b ^ 1 : b))).toString('base64');
  await assert.rejects(preparar(adulterado, SENHA), /alterado/);
  await destino.recarregar();
  assert.equal(JSON.stringify(destino.dadosCompletos()), antes);
  assert.equal((await destino.copiasSeguranca()).length, 0);

  const obj = await preparar(copia(env), SENHA);
  await destino.restaurarBackup(obj);
  assert.deepEqual(destino.funcionarios().map((x) => x.nome), ['PESSOA FICTÍCIA DA CRIPTOGRAFIA']);
  assert.deepEqual(destino.efetivas(f.id).map((m) => m.dt), origem.efetivas(f.id).map((m) => m.dt));
  assert.deepEqual(destino.all('marcacoes').map((m) => m.id).sort(), origem.all('marcacoes').map((m) => m.id).sort());
  const copias = await destino.copiasSeguranca();
  assert.equal(copias.length, 1);
  assert.equal(copias[0].contagens.funcionarios, 1); // a cópia interna guarda o estado anterior (PESSOA DO DESTINO)
  assert.equal(destino.all('auditoria').filter((a) => a.acao === 'backup-restaurado').length, 1);
  assert.equal(destino.sistema().alteracoesDesdeBackup, 0);
  await destino.recarregar();
  assert.deepEqual(destino.funcionarios().map((x) => x.nome), ['PESSOA FICTÍCIA DA CRIPTOGRAFIA']);
});

test('aba somente leitura não restaura nem um backup descriptografado corretamente', async () => {
  const { s } = await storeFicticio();
  const env = await K.criptografar(JSON.stringify(await s.exportarBackup()), SENHA, RAPIDO);
  const leitor = await new Store(Object.create(s.db), { editavel: false }).init();
  const obj = JSON.parse(await K.descriptografar(env, SENHA));
  await assert.rejects(leitor.restaurarBackup(obj), /somente leitura/);
});

test('arquivo grande (mais de 6 MB) é criptografado e recuperado integralmente', async () => {
  const grande = JSON.stringify({ preenchimento: 'ç'.repeat(3 * 1024 * 1024), fim: 'ok' });
  const env = await K.criptografar(grande, SENHA, RAPIDO);
  assert.ok(Buffer.byteLength(JSON.stringify(env)) > 6 * 1024 * 1024);
  assert.equal(await K.descriptografar(env, SENHA), grande);
});

// ------------------------------------------------------------------ envio criptografado ao Drive (simulado)
function apiSimulada() {
  const arquivos = [];
  const reqs = [];
  const json = (o, st) => new Response(JSON.stringify(o), { status: st || 200, headers: { 'Content-Type': 'application/json' } });
  const f = async (url, init) => {
    const req = { url: String(url), method: (init && init.method) || 'GET', body: init && init.body, headers: (init && init.headers) || {} };
    reqs.push(req);
    const u = new URL(req.url);
    if (u.pathname === '/drive/v3/files' && req.method === 'GET') {
      if (decodeURIComponent(req.url).includes("value='pasta'")) return json({ files: [{ id: 'pasta-ficticia-1', name: 'p' }] });
      return json({ files: arquivos.map((a) => ({ id: a.id, name: a.name, size: a.size, createdTime: '2026-05-20T12:00:00Z', appProperties: a.meta.appProperties })) });
    }
    if (u.pathname === '/upload/drive/v3/files') {
      const limite = /boundary=(\S+)/.exec(req.headers['Content-Type'])[1];
      const partes = req.body.split('--' + limite).slice(1, 3).map((p) => p.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, ''));
      const a = { id: 'arquivo-cripto-' + (arquivos.length + 1) + '-ficticio', meta: JSON.parse(partes[0]), conteudo: partes[1] };
      a.name = a.meta.name; a.size = String(Buffer.byteLength(a.conteudo));
      arquivos.push(a);
      return json({ id: a.id, name: a.name, size: a.size });
    }
    const m = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
    if (m) return new Response(arquivos.find((a) => a.id === m[1]).conteudo, { status: 200 });
    return json({}, 400);
  };
  f.arquivos = arquivos; f.reqs = reqs;
  return f;
}

test('envio criptografado ao Drive: só o arquivo cifrado sai; download, descriptografia, auditoria e contador conferem', async () => {
  const saida = []; const orig = {};
  for (const k of ['log', 'info', 'warn', 'error', 'debug']) { orig[k] = console[k]; console[k] = (...a) => saida.push(a.map(String).join(' ')); }
  try {
    const api = apiSimulada();
    const prefs = new Map([[PREF_CLIENT_ID, '123456789012-ficticio.apps.googleusercontent.com']]);
    const d = new Drive({ protocolo: 'http:', online: () => true, fetch: api,
      armazenamento: { get: (k) => prefs.get(k) || null, set: (k, v) => prefs.set(k, v), remove: (k) => prefs.delete(k) },
      gis: { initTokenClient: (cfg) => ({ requestAccessToken: () => setTimeout(() => cfg.callback({ access_token: 'TOKEN-FICTICIO-CRIPTO', expires_in: 3600, scope: ESCOPO }), 0) }), hasGrantedAllScopes: () => true, revoke: () => {} } });
    await d.conectar();
    const { s, f } = await storeFicticio();
    await s.salvarEmpregador({ nome: 'EMPRESA FICTÍCIA', documento: '', endereco: '', responsavel: '' });
    const { backup, marco } = await s.gerarBackupParaEnvio();
    const conteudo = JSON.stringify(await K.criptografar(JSON.stringify(backup, null, 1), SENHA, RAPIDO));
    const arq = await d.enviar(backup, { criptografado: true, conteudo });
    assert.equal(arq.criptografado, true);
    assert.match(arq.name, /^backup-ponto-cripto_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_[0-9a-f]{6}\.json$/);
    const enviado = api.arquivos[0];
    assert.equal(enviado.conteudo, conteudo);
    assert.equal(enviado.meta.appProperties.criptografado, '1');
    assert.equal(enviado.meta.appProperties.hash, undefined); // nada do conteúdo aberto vai nos metadados
    assert.match(enviado.meta.description, /criptografado com senha/);
    const tudoQueSaiu = api.reqs.map((r) => r.url + ' ' + (typeof r.body === 'string' ? r.body : '')).join('\n');
    for (const trecho of ['PESSOA FICTÍCIA', '529.982.247-25', 'EMPRESA FICTÍCIA', SENHA, backup.integridade.hash]) assert.ok(!tudoQueSaiu.includes(trecho), trecho);

    await s.registrarEnvioDrive(backup, marco, arq);
    const aud = s.all('auditoria').filter((a) => a.acao === 'backup-enviado-drive');
    assert.equal(aud.length, 1);
    assert.equal(aud[0].detalhes.criptografado, true);
    assert.match(aud[0].descricao, /criptografado com senha/);
    assert.equal(s.sistema().alteracoesDesdeBackup, 0);

    const lista = await d.listar();
    assert.equal(lista[0].criptografado, true);
    const baixado = JSON.parse(new TextDecoder().decode(await d.baixar(arq.id)));
    assert.equal(K.ehCriptografado(baixado), true);
    const obj = JSON.parse(await K.descriptografar(baixado, SENHA));
    assert.deepEqual(obj, copia(backup));
    assert.equal((await BK.validar(obj)).ok, true);
    assert.equal(obj.dados.funcionarios[0].id, f.id);

    // conteúdo que não é um arquivo criptografado não é aceito como tal
    await assert.rejects(d.enviar(backup, { criptografado: true, conteudo: JSON.stringify(backup) }), /Conteúdo criptografado inválido/);
    await assert.rejects(d.enviar(backup, { criptografado: true, conteudo: '{' }), /Conteúdo criptografado inválido/);
    assert.equal(api.arquivos.length, 1);
    assert.ok(!saida.join('\n').includes(SENHA) && !saida.join('\n').includes('ya29.'));
    assert.ok(![...prefs.values()].join(' ').includes(SENHA));
  } finally { Object.assign(console, orig); }
});
