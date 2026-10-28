/*
 * drive.js — Integração OPCIONAL com o Google Drive (guardar e recuperar backups).
 *
 * - Login: Google Identity Services, modelo de token (biblioteca oficial carregada de
 *   https://accounts.google.com/gsi/client somente quando a tela de Backup é aberta, há
 *   Client ID configurado e o sistema está em http/https). Sem client_secret, sem servidor.
 * - Escopo único: drive.file — o sistema só enxerga os arquivos que ele mesmo criou.
 * - Chamadas à Drive API v3 feitas diretamente com fetch (sem a biblioteca gapi).
 * - O token de acesso fica SOMENTE em um campo privado desta instância, na memória da página.
 *   Nunca é gravado (localStorage, IndexedDB, backup) nem escrito no console.
 * - Este módulo não grava dados locais: o envio usa o backup gerado pelo Store (criptografado
 *   antes por js/cripto.js, na tela) e a recuperação apenas entrega os bytes baixados para o fluxo
 *   de restauração já existente.
 *
 * Todas as dependências externas (fetch, biblioteca do Google, armazenamento de preferências,
 * relógio) podem ser substituídas nos testes, que usam versões simuladas.
 */
(function (root) {
  'use strict';

  const ESCOPO = 'https://www.googleapis.com/auth/drive.file';
  const GIS_URL = 'https://accounts.google.com/gsi/client';
  const API = 'https://www.googleapis.com/drive/v3/files';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
  const PASTA = 'Backups Gerenciador de Ponto';
  const PROP = 'gerenciadorPonto'; // appProperties: 'pasta' | 'backup'
  const PREF_CLIENT_ID = 'gerenciador-ponto:drive-client-id';
  const LIMITE_MULTIPART = 5 * 1024 * 1024; // acima disso, envio "resumable"
  const LIMITE_DOWNLOAD = 200 * 1024 * 1024; // mesmo limite da restauração local
  const RE_CLIENT_ID = /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/;
  const RE_ID_ARQUIVO = /^[A-Za-z0-9_-]{10,200}$/;

  const ESTADOS = {
    'indisponivel-local': 'Indisponível ao abrir como arquivo local (file://). O login do Google exige o sistema aberto por um endereço http(s) autorizado, como http://localhost:8080 ou o GitHub Pages.',
    'aguardando-configuracao': 'Aguardando configuração: informe o Client ID do Google.',
    carregando: 'Carregando a biblioteca de login do Google…',
    desconectado: 'Desconectado.',
    conectando: 'Aguardando o login na janela do Google…',
    conectado: 'Conectado ao Google Drive.',
    expirado: 'A sessão do Google expirou. Conecte novamente.',
    'sem-internet': 'Sem conexão com a internet.',
    erro: 'Erro.'
  };

  class ErroDrive extends Error {
    constructor(msg, codigo, status) { super(msg); this.name = 'ErroDrive'; this.codigo = codigo || 'erro'; this.status = status || null; }
  }

  const pad2 = (n) => String(n).padStart(2, '0');

  function armazenamentoPadrao() {
    return {
      get(k) { try { return root.localStorage.getItem(k); } catch (e) { return null; } },
      set(k, v) { try { root.localStorage.setItem(k, v); } catch (e) { /* preferência não gravada */ } },
      remove(k) { try { root.localStorage.removeItem(k); } catch (e) { /* ignora */ } }
    };
  }

  function carregarScriptPadrao(url) {
    return new Promise((resolve, reject) => {
      const s = root.document.createElement('script');
      s.src = url; s.async = true; s.defer = true;
      const t = setTimeout(() => { s.onload = s.onerror = null; reject(new Error('tempo esgotado')); }, 20000);
      s.onload = () => { clearTimeout(t); resolve(); };
      s.onerror = () => { clearTimeout(t); s.remove(); reject(new Error('falha ao carregar')); };
      root.document.head.appendChild(s);
    });
  }

  function sufixoAleatorio() {
    const b = new Uint8Array(3);
    root.crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }

  /** Nome exclusivo com data e hora locais reais do backup: backup-ponto_AAAA-MM-DD_HH-MM-SS_xxxxxx.json */
  function nomeArquivo(geradoEm, sufixo, criptografado) {
    const d = new Date(geradoEm);
    if (isNaN(d)) throw new ErroDrive('Backup sem data de geração válida.', 'backup');
    return (criptografado ? 'backup-ponto-cripto_' : 'backup-ponto_') + d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + '_' +
      pad2(d.getHours()) + '-' + pad2(d.getMinutes()) + '-' + pad2(d.getSeconds()) + '_' + (sufixo || sufixoAleatorio()) + '.json';
  }

  function validarClientId(v) {
    const id = String(v === undefined || v === null ? '' : v).trim();
    if (!id) return { ok: false, id: '', erro: 'Informe o Client ID.' };
    if (/secret|GOCSPX-/i.test(id)) return { ok: false, id: '', erro: 'Isto parece um "client secret". Não use o segredo: informe somente o ID do cliente (termina em .apps.googleusercontent.com).' };
    if (!RE_CLIENT_ID.test(id)) return { ok: false, id: '', erro: 'Formato inválido. O Client ID tem a forma 123456789012-abc123.apps.googleusercontent.com.' };
    return { ok: true, id, erro: null };
  }

  /** Converte uma resposta HTTP de erro em mensagem clara (sem copiar conteúdo da resposta). */
  async function erroHttp(resp) {
    let motivo = '';
    try { const j = await resp.json(); motivo = (j && j.error && ((j.error.errors && j.error.errors[0] && j.error.errors[0].reason) || j.error.status)) || ''; } catch (e) { /* corpo não é JSON */ }
    const st = resp.status;
    if (st === 401) return new ErroDrive('A sessão do Google expirou ou foi revogada. Clique em "Conectar Google Drive" novamente.', 'expirado', st);
    if (st === 429 || /rateLimitExceeded|userRateLimitExceeded|RESOURCE_EXHAUSTED/.test(motivo)) return new ErroDrive('Limite de uso da API do Google Drive atingido. Aguarde alguns minutos e tente novamente.', 'limite', st);
    if (st === 403 && /storageQuotaExceeded/.test(motivo)) return new ErroDrive('O Google Drive desta conta está sem espaço.', 'sem-espaco', st);
    if (st === 403) return new ErroDrive('Permissão negada pelo Google Drive (' + (motivo || 'acesso não autorizado') + '). Verifique se a Drive API está ativada no projeto e se o acesso ao Drive foi permitido no login.', 'permissao', st);
    if (st === 404) return new ErroDrive('Arquivo ou pasta não encontrado no Google Drive (pode ter sido excluído, ou não foi criado por este aplicativo).', 'nao-encontrado', st);
    if (st >= 500) return new ErroDrive('O Google Drive está temporariamente indisponível (erro ' + st + '). Tente novamente em alguns minutos.', 'servidor', st);
    return new ErroDrive('O Google Drive recusou a operação (erro ' + st + (motivo ? ', ' + motivo : '') + ').', 'http', st);
  }

  class Drive {
    #token = null;
    #expira = 0;

    constructor(opts) {
      opts = opts || {};
      this._fetch = opts.fetch || ((...a) => root.fetch(...a));
      this._gis = opts.gis || null; // google.accounts.oauth2 (injetado nos testes)
      this._carregarScript = opts.carregarScript || carregarScriptPadrao;
      this._prefs = opts.armazenamento || armazenamentoPadrao();
      this._agora = opts.agora || (() => Date.now());
      this._online = opts.online || (() => !(root.navigator && root.navigator.onLine === false));
      this._protocolo = opts.protocolo || (root.location ? root.location.protocol : 'file:');
      this._sufixo = opts.sufixo || sufixoAleatorio;
      this._estado = 'desconectado';
      this.detalhe = '';
      this._carga = null;
      this._pastaId = null;
      this._ouvintes = [];
    }

    // ------------------------------------------------------------------ estado
    aoMudar(fn) { this._ouvintes.push(fn); }
    _mudar(estado, detalhe) {
      this._estado = estado; this.detalhe = detalhe || '';
      this._ouvintes.forEach((fn) => { try { fn(this.estado()); } catch (e) { /* ignora */ } });
    }

    /** Estado atual: { codigo, texto, detalhe } */
    estado() {
      let codigo = this._estado;
      if (this._protocolo !== 'http:' && this._protocolo !== 'https:') codigo = 'indisponivel-local';
      else if (!this.clientId()) codigo = 'aguardando-configuracao';
      else if (codigo === 'conectado' && !this.conectado()) codigo = 'expirado';
      return { codigo, texto: ESTADOS[codigo] || codigo, detalhe: this.detalhe };
    }

    conectado() {
      if (!this.#token) return false;
      if (this._agora() >= this.#expira) { this.#token = null; this.#expira = 0; this._estado = 'expirado'; return false; }
      return true;
    }

    // ------------------------------------------------------------------ configuração (Client ID público)
    clientId() { const v = this._prefs.get(PREF_CLIENT_ID); return v && RE_CLIENT_ID.test(v) ? v : ''; }

    definirClientId(valor) {
      const v = validarClientId(valor);
      if (!v.ok) throw new ErroDrive(v.erro, 'client-id');
      if (v.id !== this.clientId()) { this.desconectar(); this._prefs.set(PREF_CLIENT_ID, v.id); this._mudar('desconectado'); }
      return v.id;
    }

    removerClientId() { this.desconectar(); this._prefs.remove(PREF_CLIENT_ID); this._mudar('desconectado'); }

    // ------------------------------------------------------------------ biblioteca de login
    _api() {
      if (this._gis) return this._gis;
      const g = root.google && root.google.accounts && root.google.accounts.oauth2;
      return g && typeof g.initTokenClient === 'function' ? g : null;
    }

    bibliotecaCarregada() { return !!this._api(); }

    /** Carrega a biblioteca oficial do Google (uma vez). Não lança: o resultado fica no estado. */
    async preparar() {
      const e = this.estado().codigo;
      if (e === 'indisponivel-local' || e === 'aguardando-configuracao') return false;
      if (this._api()) { if (this._estado === 'carregando' || this._estado === 'sem-internet' || this._estado === 'erro') this._mudar(this.#token ? 'conectado' : 'desconectado'); return true; }
      if (!this._online()) { this._mudar('sem-internet', 'A biblioteca de login do Google não pôde ser carregada.'); return false; }
      if (!this._carga) {
        this._mudar('carregando');
        this._carga = this._carregarScript(GIS_URL).then(() => {
          if (!this._api()) throw new Error('biblioteca incompleta');
          this._mudar('desconectado');
          return true;
        }).catch(() => {
          this._carga = null; // permite tentar de novo
          if (!this._online()) this._mudar('sem-internet', 'A biblioteca de login do Google não pôde ser carregada.');
          else this._mudar('erro', 'Não foi possível carregar a biblioteca de login do Google (accounts.google.com). Verifique a conexão ou se algum bloqueador está impedindo o acesso.');
          return false;
        });
      }
      return this._carga;
    }

    // ------------------------------------------------------------------ conectar / desconectar
    /**
     * Abre o consentimento do Google. Deve ser chamado DIRETAMENTE no clique do usuário
     * (sem await antes), senão o navegador bloqueia a janela do Google.
     */
    conectar() {
      const e = this.estado().codigo;
      if (e === 'indisponivel-local') return Promise.reject(new ErroDrive(ESTADOS[e], e));
      if (e === 'aguardando-configuracao') return Promise.reject(new ErroDrive('Configure o Client ID antes de conectar.', e));
      if (!this._online()) { this._mudar('sem-internet'); return Promise.reject(new ErroDrive('Sem conexão com a internet.', 'sem-internet')); }
      const gis = this._api();
      if (!gis) return Promise.reject(new ErroDrive('A biblioteca de login do Google ainda não foi carregada. Aguarde e tente novamente.', 'nao-carregado'));
      this._mudar('conectando');
      return new Promise((resolve, reject) => {
        const falhar = (erro) => { this.#token = null; this.#expira = 0; this._mudar(erro.codigo === 'cancelado' ? 'desconectado' : 'erro', erro.message); reject(erro); };
        let cliente;
        try {
          cliente = gis.initTokenClient({
            client_id: this.clientId(),
            scope: ESCOPO,
            callback: (resp) => {
              if (!resp || resp.error) {
                const cod = resp && resp.error;
                falhar(cod === 'access_denied'
                  ? new ErroDrive('O acesso ao Google Drive foi negado no login.', 'negado')
                  : new ErroDrive('O Google recusou o login (' + (cod || 'resposta vazia') + '). Verifique o Client ID e as origens autorizadas no Google Cloud.', 'autenticacao'));
                return;
              }
              if (typeof resp.access_token !== 'string' || !resp.access_token) { falhar(new ErroDrive('Resposta inesperada do login do Google.', 'resposta')); return; }
              if (typeof gis.hasGrantedAllScopes === 'function' && !gis.hasGrantedAllScopes(resp, ESCOPO)) {
                try { if (typeof gis.revoke === 'function') gis.revoke(resp.access_token, () => {}); } catch (e2) { /* ignora */ }
                falhar(new ErroDrive('A permissão de acesso ao Google Drive não foi concedida. Conecte novamente e marque a opção do Google Drive.', 'negado'));
                return;
              }
              const seg = Number(resp.expires_in) > 0 ? Number(resp.expires_in) : 3600;
              this.#token = resp.access_token;
              this.#expira = this._agora() + Math.max(seg - 60, 30) * 1000; // margem antes do vencimento real
              this._mudar('conectado');
              resolve(this.estado());
            },
            error_callback: (err) => {
              const t = err && err.type;
              falhar(t === 'popup_closed'
                ? new ErroDrive('Login cancelado: a janela do Google foi fechada.', 'cancelado')
                : t === 'popup_failed_to_open'
                  ? new ErroDrive('O navegador bloqueou a janela de login do Google. Permita janelas pop-up para este endereço e tente novamente.', 'popup-bloqueado')
                  : new ErroDrive('Falha no login do Google.', 'autenticacao'));
            }
          });
          cliente.requestAccessToken();
        } catch (erro) {
          falhar(new ErroDrive('Falha ao iniciar o login do Google.', 'autenticacao'));
        }
      });
    }

    /** Remove o token da memória (e pede ao Google para revogá-lo). Não apaga nenhum arquivo do Drive. */
    desconectar() {
      const t = this.#token;
      this.#token = null; this.#expira = 0; this._pastaId = null;
      if (t) {
        const gis = this._api();
        try { if (gis && typeof gis.revoke === 'function') gis.revoke(t, () => {}); } catch (e) { /* o token já saiu da memória */ }
      }
      if (this._estado !== 'carregando') this._mudar('desconectado');
    }

    // ------------------------------------------------------------------ chamadas à API
    async _req(url, init) {
      if (!this._online()) { this._mudar('sem-internet'); throw new ErroDrive('Sem conexão com a internet. Nada foi enviado nem baixado.', 'sem-internet'); }
      if (!this.conectado()) {
        const exp = this._estado === 'expirado';
        this._mudar(exp ? 'expirado' : 'desconectado');
        throw new ErroDrive(exp ? 'A sessão do Google expirou. Clique em "Conectar Google Drive" novamente.' : 'Conecte o Google Drive primeiro.', exp ? 'expirado' : 'sem-token');
      }
      init = Object.assign({}, init || {});
      init.headers = Object.assign({}, init.headers || {}, { Authorization: 'Bearer ' + this.#token });
      init.cache = 'no-store';
      init.credentials = 'omit';
      init.referrerPolicy = 'no-referrer';
      let resp;
      try { resp = await this._fetch(url, init); } catch (e) {
        if (!this._online()) this._mudar('sem-internet');
        throw new ErroDrive('Não foi possível comunicar com o Google Drive (falha de rede). Verifique a conexão.', 'rede');
      }
      if (!resp || typeof resp.status !== 'number') throw new ErroDrive('Resposta inesperada do Google Drive.', 'resposta');
      if (!resp.ok) {
        const erro = await erroHttp(resp);
        if (erro.codigo === 'expirado') { this.#token = null; this.#expira = 0; this._mudar('expirado', erro.message); }
        throw erro;
      }
      return resp;
    }

    async _json(url, init) {
      const resp = await this._req(url, init);
      try { return await resp.json(); } catch (e) { throw new ErroDrive('Resposta inesperada do Google Drive.', 'resposta'); }
    }

    async _pasta() {
      if (this._pastaId) return this._pastaId;
      const q = "mimeType='application/vnd.google-apps.folder' and appProperties has { key='" + PROP + "' and value='pasta' } and trashed=false";
      const r = await this._json(API + '?q=' + encodeURIComponent(q) + '&orderBy=createdTime&pageSize=10&spaces=drive&fields=' + encodeURIComponent('files(id,name)'));
      if (!r || !Array.isArray(r.files)) throw new ErroDrive('Resposta inesperada do Google Drive ao procurar a pasta de backups.', 'resposta');
      if (r.files.length && typeof r.files[0].id === 'string') { this._pastaId = r.files[0].id; return this._pastaId; }
      const nova = await this._json(API + '?fields=id,name', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({ name: PASTA, mimeType: 'application/vnd.google-apps.folder', appProperties: { [PROP]: 'pasta' } })
      });
      if (!nova || typeof nova.id !== 'string' || !nova.id) throw new ErroDrive('O Google Drive não confirmou a criação da pasta de backups.', 'resposta');
      this._pastaId = nova.id;
      return this._pastaId;
    }

    /**
     * Envia um backup (objeto gerado pelo Store) como arquivo JSON NOVO.
     * opts.criptografado + opts.conteudo: envia o arquivo criptografado (texto JSON gerado por
     * js/cripto.js) no lugar do backup aberto. Só resolve depois que a API devolver os metadados
     * do arquivo criado e o tamanho conferir.
     */
    async enviar(backup, opts) {
      opts = opts || {};
      if (!backup || backup.formato !== 'gerenciador-ponto-backup' || !backup.integridade || typeof backup.integridade.hash !== 'string') {
        throw new ErroDrive('Backup inválido: nada foi enviado.', 'backup');
      }
      const cripto = !!opts.criptografado;
      let texto;
      if (cripto) {
        let env = null;
        try { env = typeof opts.conteudo === 'string' ? JSON.parse(opts.conteudo) : null; } catch (e) { env = null; }
        if (!env || env.formato !== 'gerenciador-ponto-backup-criptografado' || typeof env.dados !== 'string' || !env.dados) {
          throw new ErroDrive('Conteúdo criptografado inválido: nada foi enviado.', 'backup');
        }
        texto = opts.conteudo;
      } else {
        texto = JSON.stringify(backup, null, 1); // mesmo conteúdo do arquivo exportado localmente
      }
      const bytes = new TextEncoder().encode(texto);
      const nome = nomeArquivo(backup.geradoEm, this._sufixo(), cripto);
      const pasta = await this._pasta();
      const meta = {
        name: nome,
        mimeType: 'application/json',
        parents: [pasta],
        description: cripto
          ? 'Backup completo do Gerenciador de Ponto, criptografado com senha (AES-256-GCM). Sem a senha, não pode ser recuperado.'
          : 'Backup completo do Gerenciador de Ponto (contém dados pessoais; não criptografado).',
        // a marca "criptografado" serve só para a lista; quem decide é o conteúdo baixado
        appProperties: cripto
          ? { [PROP]: 'backup', formato: 'gerenciador-ponto-backup-criptografado', criptografado: '1' }
          : { [PROP]: 'backup', formato: String(backup.formato), criptografado: '0', hash: backup.integridade.hash.slice(0, 16) }
      };
      const campos = encodeURIComponent('id,name,size,createdTime,mimeType');
      let criado;
      if (bytes.length <= LIMITE_MULTIPART) {
        const limite = 'gp' + this._sufixo() + this._sufixo();
        const corpo = '--' + limite + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) +
          '\r\n--' + limite + '\r\nContent-Type: application/json\r\n\r\n' + texto + '\r\n--' + limite + '--';
        criado = await this._json(UPLOAD + '?uploadType=multipart&fields=' + campos, {
          method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + limite }, body: corpo
        });
      } else {
        const ini = await this._req(UPLOAD + '?uploadType=resumable&fields=' + campos, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'application/json', 'X-Upload-Content-Length': String(bytes.length) },
          body: JSON.stringify(meta)
        });
        const sessao = ini.headers && ini.headers.get ? ini.headers.get('Location') : null;
        if (!sessao || sessao.indexOf(UPLOAD) !== 0) throw new ErroDrive('O Google Drive não iniciou o envio. Nada foi confirmado.', 'resposta');
        criado = await this._json(sessao, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: bytes });
      }
      if (!criado || typeof criado.id !== 'string' || !criado.id || criado.name !== nome) {
        throw new ErroDrive('O Google Drive não devolveu a confirmação do arquivo criado. Considere o envio NÃO confirmado.', 'resposta');
      }
      if (criado.size !== undefined && Number(criado.size) !== bytes.length) {
        throw new ErroDrive('O tamanho do arquivo no Google Drive (' + criado.size + ' bytes) difere do enviado (' + bytes.length + ' bytes). Considere o envio NÃO confirmado.', 'tamanho');
      }
      return { id: criado.id, name: criado.name, size: criado.size !== undefined ? Number(criado.size) : bytes.length, createdTime: criado.createdTime || null, criptografado: cripto };
    }

    /** Lista os backups que este aplicativo criou (escopo drive.file), do mais novo ao mais antigo. */
    async listar() {
      const q = "appProperties has { key='" + PROP + "' and value='backup' } and trashed=false";
      const base = API + '?q=' + encodeURIComponent(q) + '&orderBy=' + encodeURIComponent('createdTime desc') + '&pageSize=100&spaces=drive&fields=' +
        encodeURIComponent('nextPageToken,files(id,name,size,createdTime,modifiedTime,appProperties)');
      const arquivos = [];
      let pagina = null;
      for (let i = 0; i < 10; i++) {
        const r = await this._json(base + (pagina ? '&pageToken=' + encodeURIComponent(pagina) : ''));
        if (!r || !Array.isArray(r.files)) throw new ErroDrive('Resposta inesperada do Google Drive ao listar os backups.', 'resposta');
        for (const f of r.files) {
          if (!f || typeof f.id !== 'string' || typeof f.name !== 'string') continue;
          arquivos.push({ id: f.id, name: f.name, size: f.size !== undefined ? Number(f.size) : null, createdTime: f.createdTime || f.modifiedTime || null,
            criptografado: !!(f.appProperties && f.appProperties.criptografado === '1') }); // indicação para a lista; o conteúdo decide
        }
        pagina = typeof r.nextPageToken === 'string' && r.nextPageToken ? r.nextPageToken : null;
        if (!pagina) break;
      }
      return arquivos;
    }

    /** Baixa o conteúdo de um backup. Retorna Uint8Array (a validação é feita pelo fluxo de restauração). */
    async baixar(id) {
      if (typeof id !== 'string' || !RE_ID_ARQUIVO.test(id)) throw new ErroDrive('Identificador de arquivo inválido.', 'id');
      const resp = await this._req(API + '/' + encodeURIComponent(id) + '?alt=media');
      const tam = Number(resp.headers && resp.headers.get ? resp.headers.get('Content-Length') : NaN);
      if (tam > LIMITE_DOWNLOAD) throw new ErroDrive('Arquivo grande demais para ser um backup deste sistema.', 'tamanho');
      let buf;
      try { buf = await resp.arrayBuffer(); } catch (e) { throw new ErroDrive('O download do arquivo foi interrompido. Nada foi alterado.', 'rede'); }
      if (buf.byteLength > LIMITE_DOWNLOAD) throw new ErroDrive('Arquivo grande demais para ser um backup deste sistema.', 'tamanho');
      return new Uint8Array(buf);
    }
  }

  const api = { Drive, ErroDrive, ESCOPO, GIS_URL, API, UPLOAD, PASTA, PREF_CLIENT_ID, ESTADOS, validarClientId, nomeArquivo, LIMITE_MULTIPART };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Ponto = root.Ponto || {}; root.Ponto.drive = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this);
