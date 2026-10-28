/* Backup completo (exportação/validação/restauração) e informações de armazenamento. */
(function (root) {
  'use strict';
  const P = root.Ponto; const U = P.util, UI = P.ui; const h = UI.h;
  P.views = P.views || {};

  const NOMES = { config: 'Configurações', funcionarios: 'Funcionários', marcacoes: 'Marcações originais', ajustes: 'Ajustes de marcações', eventos: 'Ocorrências', lancamentos: 'Lançamentos do banco', fechamentos: 'Fechamentos', conferencias: 'Conferências', importacoes: 'Arquivos importados', auditoria: 'Histórico de alterações' };

  let pendente = null; // { nome, obj, validacao }

  function nomeArquivo(geradoEm) {
    const d = new Date(geradoEm);
    return 'backup-ponto_' + d.getFullYear() + '-' + U.pad2(d.getMonth() + 1) + '-' + U.pad2(d.getDate()) + '_' + U.pad2(d.getHours()) + 'h' + U.pad2(d.getMinutes()) + '.json';
  }

  P.views.backup = {
    titulo: 'Backup',
    async render(el, app) {
      const s = app.store, sis = s.sistema(), arm = app.armazenamento;
      const est = arm.estimativa;
      el.innerHTML = String(h`
        <h1>Backup e restauração</h1>
        <div class="cartao destaque-borda">
          <h2>Por que exportar o backup?</h2>
          <p>Os dados ficam gravados <b>somente neste navegador, neste computador</b>. Eles podem ser perdidos se o navegador for reinstalado, se os “dados de navegação/cookies” forem limpos, se o computador apresentar defeito, ou se você abrir o sistema por outro endereço ou outro navegador (cada um tem seu próprio armazenamento). Não há sincronização automática entre computadores.</p>
          <p><b>Quando exportar:</b> ao final de cada dia de uso; sempre após importar marcações, corrigir ponto ou fechar uma competência; e antes de atualizar o sistema, trocar de navegador ou de computador.</p>
          <p><b>Onde guardar:</b> em uma pasta do computador (ex.: <code>Documentos\\Backups Ponto</code>) <b>e</b> em um segundo local (pen drive, e-mail para você mesmo ou nuvem). Mantenha várias versões; não apague as antigas.</p>
          <p class="mudo">O arquivo de backup contém dados pessoais (nome, CPF, salário, horários). Guarde-o com cuidado (LGPD).</p>
        </div>

        <div class="cartao">
          <h2>Exportar</h2>
          <p>Último backup exportado: <b>${sis.ultimoBackupEm ? U.fmtDateTimeISO(sis.ultimoBackupEm) : 'nunca'}</b> · Alterações desde então: <b>${sis.alteracoesDesdeBackup || 0}</b></p>
          <button type="button" data-leitura class="primario grande" id="exportar">EXPORTAR BACKUP COMPLETO</button>
          <p class="ajuda">Gera um arquivo .json com todos os funcionários, jornadas, marcações, ajustes, justificativas, ocorrências, fechamentos, movimentações do banco de horas, arquivos importados e histórico, com código de integridade (SHA-256).</p>
        </div>

        <div class="cartao">
          <h2>Importar e restaurar</h2>
          <label class="arquivo">Arquivo de backup (.json)<input type="file" id="arq-backup" accept=".json,application/json"></label>
          <div id="resultado-validacao">${pendente ? resultado(pendente) : ''}</div>
        </div>

        <div class="cartao">
          <h2>Cópias de segurança internas</h2>
          <p class="ajuda">Antes de cada restauração, o sistema guarda automaticamente uma cópia do estado anterior neste navegador (as 3 mais recentes). Ela não substitui o backup externo.</p>
          <div id="copias">Carregando…</div>
        </div>

        <div class="cartao">
          <h2>Armazenamento neste navegador</h2>
          <table class="tabela chave-valor"><tbody>
            <tr><th>Tecnologia</th><td>IndexedDB (banco de dados do navegador, com transações)</td></tr>
            <tr><th>Armazenamento persistente</th><td>${arm.persistente === true ? 'Concedido — o navegador não deve apagar os dados automaticamente por falta de espaço.' : arm.persistente === false ? 'Não concedido — o navegador pode apagar os dados em situações de pouco espaço. Exporte backups com frequência.' : 'Não informado por este navegador.'}</td></tr>
            <tr><th>Forma de abertura</th><td>${arm.protocolo === 'file:' ? 'Arquivo local (file://). Os dados ficam associados a este navegador e a esta forma de abertura; se abrir pelo GitHub Pages ou outro endereço, os dados NÃO aparecerão lá (use o backup para transferir).' : 'Endereço ' + location.origin + '. Outros endereços (ou abrir o arquivo diretamente) usam armazenamento separado.'}</td></tr>
            ${est ? h`<tr><th>Espaço utilizado (estimativa)</th><td>${(est.usage / 1024 / 1024).toFixed(2)} MB de ${(est.quota / 1024 / 1024).toFixed(0)} MB disponíveis</td></tr>` : ''}
          </tbody></table>
        </div>

        <div class="cartao" id="cartao-drive"></div>`);

      UI.$('#exportar', el).onclick = async () => {
        try {
          const b = await s.exportarBackup();
          UI.baixar(nomeArquivo(b.geradoEm), JSON.stringify(b, null, 1), 'application/json');
          UI.toast(b.naoRegistrado
            ? 'Backup gerado nesta aba somente leitura. A data do último backup não foi registrada; ela será registrada quando o backup for exportado pela aba que está editando.'
            : 'Backup gerado. Confira se o arquivo foi salvo na pasta de downloads e copie-o para um local seguro.', b.naoRegistrado ? 'info' : 'ok');
          app.render();
        } catch (e) { UI.erro(e); }
      };

      UI.$('#arq-backup', el).onchange = async (ev) => {
        const file = ev.target.files[0];
        if (!file) return;
        await prepararRestauracao(el, app, file.name, () => UI.lerArquivo(file));
      };
      ligarRestaurar(el, app);
      desenharDrive(el, app);

      try {
        const copias = await s.copiasSeguranca();
        const box = UI.$('#copias', el);
        if (!box) return;
        box.innerHTML = String(copias.length ? h`<table class="tabela"><thead><tr><th>Criada em</th><th>Conteúdo</th><th></th></tr></thead><tbody>${copias.map((c) => h`<tr><td>${U.fmtDateTimeISO(c.em)}</td><td>${c.contagens.funcionarios} funcionário(s), ${c.contagens.marcacoes} marcação(ões), ${c.contagens.fechamentos} fechamento(s)</td><td><button type="button" data-leitura data-copia="${c.id}">Baixar como arquivo de backup</button></td></tr>`)}</tbody></table>` : h`<p class="mudo">Nenhuma cópia interna (nenhuma restauração foi feita).</p>`);
        UI.$$('[data-copia]', box).forEach((b) => b.onclick = async () => {
          try { const bk = await s.backupDaCopia(b.dataset.copia); UI.baixar('copia-seguranca_' + nomeArquivo(bk.geradoEm), JSON.stringify(bk, null, 1), 'application/json'); } catch (e) { UI.erro(e); }
        });
      } catch (e) { console.error(e); }
    }
  };

  // ------------------------------------------------------------------ Google Drive (opcional)
  /*
   * O Drive é só origem/destino do arquivo: o envio usa store.gerarBackupParaEnvio() e, depois da
   * confirmação da API, store.registrarEnvioDrive(); a recuperação baixa o arquivo e o entrega a
   * prepararRestauracao() — a mesma validação, prévia e confirmação "RESTAURAR" do arquivo local.
   */
  const D = P.drive;
  let drive = null;            // instância única por página (o token fica só na memória dela)
  let arquivosDrive = null;    // última listagem: null = ainda não listado
  let selecionadoDrive = null; // id do arquivo selecionado
  let ocupadoDrive = '';       // texto da operação em andamento
  let erroDrive = '';          // última falha, mostrada no cartão
  let appRef = null;

  function obterDrive() {
    if (!drive && D) {
      drive = new D.Drive();
      drive.aoMudar(() => redesenharDrive());
      root.addEventListener('online', () => { if (drive) drive.preparar(); redesenharDrive(); });
      root.addEventListener('offline', () => redesenharDrive());
    }
    return drive;
  }

  function redesenharDrive() {
    const el = UI.$('#view');
    if (appRef && el && UI.$('#cartao-drive', el)) desenharDrive(el, appRef);
  }

  const fmtTamanho = (n) => (n === null || n === undefined || isNaN(n)) ? '—' : n < 1024 ? n + ' bytes' : n < 1024 * 1024 ? (n / 1024).toFixed(1).replace('.', ',') + ' KB' : (n / 1024 / 1024).toFixed(2).replace('.', ',') + ' MB';
  const CLASSE_ESTADO = { conectado: 'ok', desconectado: 'neutro', carregando: 'neutro', conectando: 'neutro', 'aguardando-configuracao': 'alerta', expirado: 'alerta', 'sem-internet': 'alerta', 'indisponivel-local': 'alerta', erro: 'erro' };

  function mensagemErro(e) {
    return e && (e.name === 'ErroDrive' || e.name === 'ErroRegra' || e.name === 'ErroCripto') ? e.message : 'Erro inesperado: ' + ((e && e.message) || e);
  }

  function falhaDrive(titulo, e, complemento) {
    erroDrive = mensagemErro(e);
    UI.modal({ titulo, corpo: h`<p class="pre">${erroDrive}</p>${complemento ? h`<p>${complemento}</p>` : ''}`, botoes: [{ texto: 'Entendi', valor: true, classe: 'primario' }] });
    redesenharDrive();
  }

  function desenharDrive(el, app) {
    appRef = app;
    const card = UI.$('#cartao-drive', el);
    if (!card) return;
    const d = obterDrive();
    if (!d) { card.innerHTML = String(h`<h2>Google Drive</h2><p>Módulo do Google Drive não carregado.</p>`); return; }
    let est = d.estado();
    const semRede = root.navigator && root.navigator.onLine === false;
    if (semRede && !['indisponivel-local', 'aguardando-configuracao'].includes(est.codigo)) est = { codigo: 'sem-internet', texto: D.ESTADOS['sem-internet'], detalhe: 'O sistema continua funcionando normalmente; use o backup local.' };
    const conectado = est.codigo === 'conectado';
    const local = est.codigo === 'indisponivel-local';
    const temId = !!d.clientId();
    const ocupado = !!ocupadoDrive;
    const lista = arquivosDrive || [];
    if (selecionadoDrive && !lista.some((f) => f.id === selecionadoDrive)) selecionadoDrive = null;
    const sel = lista.find((f) => f.id === selecionadoDrive) || null;
    const des = (cond) => (cond ? UI.raw('disabled') : '');

    card.innerHTML = String(h`
      <h2>Google Drive (opcional)</h2>
      <div class="faixa info">🔒 Os backups enviados ao Google Drive são <b>criptografados neste navegador com uma senha sua</b> (AES-256-GCM) antes do envio. A senha não é enviada nem guardada: <b>sem ela, o backup não pode ser recuperado</b>. Backups antigos enviados sem criptografia continuam no Drive e aparecem como “não criptografado”. O backup local (acima) continua necessário.</div>
      <p>Status: <span class="badge ${CLASSE_ESTADO[est.codigo] || 'neutro'}" id="drive-status" data-estado="${est.codigo}">${est.texto}</span>${ocupado ? h` <span class="mudo" id="drive-ocupado">${ocupadoDrive}</span>` : ''}</p>
      ${est.detalhe ? h`<p class="ajuda" id="drive-detalhe">${est.detalhe}</p>` : ''}
      ${erroDrive && !ocupado ? h`<div class="faixa erro" id="drive-erro">${erroDrive}</div>` : ''}
      ${local ? h`<p>Para usar o Google Drive, abra o sistema por <code>http://localhost:8080</code> (desenvolvimento) ou pelo endereço do GitHub Pages, ambos autorizados no Google Cloud. Os dados deste navegador são separados por endereço: exporte o backup aqui e restaure no novo endereço. Veja <code>docs/INTEGRACAO-GOOGLE-DRIVE.md</code>.</p>` : h`
      <div class="drive-config" data-leitura>
        <label>Client ID do Google (identificador público do aplicativo — não é senha)
          <input type="text" id="drive-client-id" autocomplete="off" spellcheck="false" placeholder="123456789012-abc123.apps.googleusercontent.com" value="${d.clientId()}" ${des(ocupado || conectado)}></label>
        <div class="acoes"><button type="button" id="drive-salvar-id" ${des(ocupado || conectado)}>${temId ? 'Alterar Client ID' : 'Salvar Client ID'}</button>
          ${temId ? h`<button type="button" id="drive-remover-id" ${des(ocupado || conectado)}>Remover Client ID</button>` : ''}</div>
        <p class="ajuda">Nunca informe aqui o “client secret”, senhas ou códigos. O login é feito na janela do próprio Google.</p>
      </div>
      ${temId ? h`<div class="acoes" data-leitura>
          ${conectado
    ? h`<button type="button" id="drive-desconectar" ${des(ocupado)}>Desconectar</button>`
    : h`<button type="button" class="primario" id="drive-conectar" ${des(ocupado || !['desconectado', 'expirado', 'erro'].includes(est.codigo))}>Conectar Google Drive</button>`}
          <button type="button" class="primario" id="drive-enviar" ${des(!conectado || ocupado)}>Enviar backup ao Drive</button>
          <button type="button" id="drive-atualizar" ${des(!conectado || ocupado)}>Atualizar lista</button>
        </div>` : ''}
      ${conectado || arquivosDrive ? h`
        <h3>Backups disponíveis no Drive</h3>
        <p class="ajuda">Aparecem somente os backups enviados por este sistema (com este Client ID), na pasta “${D.PASTA}”. Arquivos colocados no Drive por outros meios não aparecem: baixe-os pelo site do Drive e use “Importar e restaurar”.</p>
        ${arquivosDrive === null ? h`<p class="mudo">Lista ainda não carregada. Clique em “Atualizar lista”.</p>`
    : !lista.length ? h`<p class="mudo" id="drive-vazio">Nenhum backup deste sistema encontrado no Drive.</p>`
      : h`<table class="tabela" id="drive-lista" data-leitura><thead><tr><th></th><th>Arquivo</th><th>Proteção</th><th>Criado em</th><th>Tamanho</th></tr></thead><tbody>${lista.map((f) => h`
              <tr class="${f.id === selecionadoDrive ? 'selecionado' : ''}"><td><input type="radio" name="drive-arquivo" value="${f.id}" aria-label="Selecionar ${f.name}" ${f.id === selecionadoDrive ? UI.raw('checked') : ''} ${des(ocupado)}></td>
              <td>${f.name}</td><td>${f.criptografado ? '🔒 criptografado' : 'não criptografado'}</td><td>${f.createdTime ? U.fmtDateTimeISO(f.createdTime) : '—'}</td><td>${fmtTamanho(f.size)}</td></tr>`)}</tbody></table>`}
        ${lista.length ? h`<p id="drive-selecionado">${sel ? h`Selecionado: <b>${sel.name}</b>` : 'Nenhum arquivo selecionado.'}</p>
          <div class="acoes"><button type="button" class="perigo" id="drive-recuperar" ${des(!sel || !conectado || ocupado || !app.editavel)}>Recuperar backup do Drive</button></div>
          ${!app.editavel ? h`<p class="ajuda" id="drive-recuperar-leitura">A recuperação está bloqueada nesta aba (somente leitura). Use a aba do sistema que está editando.</p>` : h`<p class="ajuda">O arquivo é baixado e conferido; nada é alterado antes da prévia e da confirmação digitando RESTAURAR.</p>`}` : ''}` : ''}`}`);

    if (!app.editavel) UI.somenteLeitura(card); // controles com data-leitura continuam ativos
    ligarDrive(card, app, d);
    // carrega a biblioteca do Google ao abrir a tela (antes do clique em Conectar); falhas não são repetidas sozinhas
    if (!local && temId && !ocupado && !semRede && d.estado().codigo === 'desconectado' && !d.bibliotecaCarregada()) d.preparar();
  }

  function ligarDrive(card, app, d) {
    const on = (id, fn) => { const b = UI.$('#' + id, card); if (b) b.onclick = fn; };
    const ocupar = async (texto, fn) => {
      ocupadoDrive = texto; erroDrive = ''; redesenharDrive();
      try { return await fn(); } finally { ocupadoDrive = ''; redesenharDrive(); }
    };

    on('drive-salvar-id', () => {
      try {
        d.definirClientId(UI.$('#drive-client-id', card).value);
        erroDrive = ''; arquivosDrive = null; selecionadoDrive = null;
        app.formAlterado = false;
        UI.toast('Client ID salvo neste navegador.');
        d.preparar();
      } catch (e) { falhaDrive('Client ID não salvo', e); }
      redesenharDrive();
    });
    on('drive-remover-id', async () => {
      const ok = await UI.confirmar('Remover Client ID', 'A integração com o Google Drive ficará desativada neste navegador. Nenhum arquivo do Drive será apagado.', { botao: 'Remover' });
      if (!ok) return;
      d.removerClientId(); arquivosDrive = null; selecionadoDrive = null; erroDrive = '';
      redesenharDrive();
    });
    on('drive-conectar', () => {
      erroDrive = '';
      if (!d.bibliotecaCarregada()) { // nova tentativa de carregar; o login fica para o próximo clique
        d.preparar().then((ok) => { if (ok) UI.toast('Biblioteca de login do Google carregada. Clique em “Conectar Google Drive”.', 'info'); });
        return;
      }
      const p = d.conectar(); // chamado direto no clique: o navegador permite abrir a janela do Google
      redesenharDrive();
      p.then(() => {
        UI.toast('Conectado ao Google Drive.');
        return listarDrive(d).catch((e) => falhaDrive('Conectado, mas não foi possível listar os backups', e));
      }, (e) => { if (e && e.codigo === 'cancelado') { erroDrive = e.message; redesenharDrive(); } else falhaDrive('Não foi possível conectar ao Google Drive', e); });
    });
    on('drive-desconectar', () => {
      d.desconectar(); arquivosDrive = null; selecionadoDrive = null; erroDrive = '';
      UI.toast('Google Drive desconectado nesta aba. Nenhum arquivo do Drive foi apagado.', 'info');
      redesenharDrive();
    });
    on('drive-atualizar', () => ocupar('Consultando o Google Drive…', () => listarDrive(d)).catch((e) => falhaDrive('Não foi possível listar os backups', e)));
    on('drive-enviar', async () => {
      const senha = await pedirNovaSenha(); // obrigatória para o Drive; não é guardada em lugar nenhum
      if (senha === null) { UI.toast('Envio cancelado. Nada foi enviado ao Google Drive.', 'info'); return; }
      enviarDrive(senha);
    });
    const enviarDrive = (senha) => ocupar('Gerando, criptografando e enviando o backup ao Google Drive…', async () => {
      const s = app.store;
      const { backup, marco } = await s.gerarBackupParaEnvio(); // mesma fila de gravação da exportação
      let conteudo = JSON.stringify(await K.criptografar(JSON.stringify(backup, null, 1), senha));
      senha = null;
      const arq = await d.enviar(backup, { criptografado: true, conteudo }); // só retorna após a confirmação da API
      conteudo = null;
      let registro = 'leitura';
      if (s.editavel) {
        try { await s.registrarEnvioDrive(backup, marco, arq); registro = 'ok'; } catch (e) { registro = 'falhou'; }
      }
      UI.toast('Backup criptografado enviado e confirmado pelo Google Drive: “' + arq.name + '” (' + fmtTamanho(arq.size) + ').' +
        (registro === 'leitura' ? ' Esta aba está em somente leitura: a data do último backup não foi registrada.' : registro === 'falhou' ? ' Atenção: não foi possível registrar a data do backup neste navegador.' : ''), registro === 'ok' ? 'ok' : 'info');
      try { await listarDrive(d); selecionadoDrive = arq.id; } catch (e) { erroDrive = 'O envio foi confirmado, mas a lista não pôde ser atualizada: ' + mensagemErro(e); }
      if (registro === 'ok') setTimeout(() => app.render(), 0); // atualiza contador e data exibidos
    }).catch((e) => falhaDrive('Envio ao Google Drive NÃO confirmado', e, 'Os dados deste navegador não foram alterados e o backup não foi registrado como feito. Use também o backup local.'));
    UI.$$('input[name="drive-arquivo"]', card).forEach((r) => { r.onchange = () => { selecionadoDrive = r.value; redesenharDrive(); }; });
    on('drive-recuperar', () => {
      if (!app.editavel) { falhaDrive('Recuperação bloqueada', new Error('Esta aba está em modo somente leitura. Use a aba do sistema que está editando para recuperar um backup.')); return; }
      const f = (arquivosDrive || []).find((x) => x.id === selecionadoDrive);
      if (!f) return;
      ocupar('Baixando “' + f.name + '” do Google Drive…', async () => {
        const bytes = await d.baixar(f.id);
        const el = UI.$('#view');
        await prepararRestauracao(el, app, f.name + ' (Google Drive)', async () => bytes);
        const res = UI.$('#resultado-validacao', el);
        if (res && res.scrollIntoView) res.scrollIntoView({ block: 'center' });
      }).catch((e) => falhaDrive('Não foi possível baixar o backup do Drive', e, 'Nenhum dado foi alterado.'));
    });
  }

  async function listarDrive(d) {
    arquivosDrive = await d.listar();
    redesenharDrive();
    return arquivosDrive;
  }

  // ------------------------------------------------------------------ senhas de criptografia
  /*
   * As senhas são lidas do campo, usadas e descartadas: o campo é limpo e a janela removida.
   * Nada é gravado (localStorage, IndexedDB, backup) nem escrito no console.
   */
  const K = P.cripto;

  async function pedirNovaSenha() {
    const r = await UI.modal({
      titulo: 'Senha de criptografia do backup',
      corpo: h`<p>O backup será <b>criptografado neste navegador</b> (AES-256-GCM) antes de ir para o Google Drive. O Google recebe apenas o arquivo cifrado; a senha nunca é enviada nem guardada.</p>
        <label>Senha (mínimo de ${K.SENHA_MIN} caracteres; prefira uma frase longa)<input type="password" name="senha" autocomplete="new-password" spellcheck="false"></label>
        <label>Repita a senha<input type="password" name="senha2" autocomplete="new-password" spellcheck="false"></label>
        <div class="faixa alerta"><b>Guarde esta senha em local seguro.</b> Sem ela, este backup <b>não pode ser recuperado</b> por ninguém — nem pelo sistema, nem pelo Google. Não há “esqueci a senha”.</div>`,
      botoes: [{ texto: 'Cancelar', valor: false }, { texto: 'Criptografar e enviar', valor: true, classe: 'primario' }],
      validar: (v, form) => { const erro = K.validarNovaSenha(form.senha.value, form.senha2.value); if (erro) throw UI.falha(erro); }
    });
    if (!r) return null;
    const senha = r.form.senha.value;
    r.form.senha.value = ''; r.form.senha2.value = '';
    return senha;
  }

  /** Pede a senha e descriptografa; permite tentar de novo. Devolve o texto aberto ou null (cancelado). */
  async function pedirSenhaArquivo(nome, env) {
    const r = await UI.modal({
      titulo: 'Backup criptografado',
      corpo: h`<p>O arquivo “${nome}” é um backup criptografado (criado em ${U.fmtDateTimeISO(env.criadoEm)}). Informe a senha usada na criação. Nada será alterado antes da prévia e da confirmação.</p>
        <label>Senha do backup<input type="password" name="senha" autocomplete="off" spellcheck="false"></label>`,
      botoes: [{ texto: 'Cancelar', valor: false }, { texto: 'Descriptografar', valor: true, classe: 'primario' }],
      validar: async (v, form) => {
        const senha = form.senha.value;
        if (!senha) throw UI.falha('Informe a senha.');
        try { return await K.descriptografar(env, senha); } catch (e) {
          form.senha.value = '';
          throw UI.falha(e && e.name === 'ErroCripto' ? e.message : 'Não foi possível descriptografar.');
        }
      }
    });
    if (!r) return null;
    r.form.senha.value = '';
    return r.resultado;
  }

  /**
   * Lê, valida e mostra a prévia de um backup (arquivo local ou baixado do Google Drive).
   * Não altera nada: a restauração só acontece pelo botão e pela confirmação de ligarRestaurar.
   */
  async function prepararRestauracao(el, app, nome, lerBytes) {
    let obj = null, validacao, criptografado = false;
    try {
      const bytes = await lerBytes();
      if (bytes.length > 200 * 1024 * 1024) throw new Error('Arquivo grande demais.');
      const texto = new TextDecoder('utf-8').decode(bytes);
      try { obj = JSON.parse(texto); } catch (e) { validacao = { ok: false, erros: ['O arquivo não é um JSON válido (pode estar corrompido ou incompleto).'], avisos: [] }; }
      // Arquivo criptografado: reconhecido pelo CONTEÚDO (nunca pelo nome). Senha errada, arquivo
      // alterado ou cancelamento terminam aqui, sem nada a restaurar.
      if (obj && K.ehCriptografado(obj)) {
        criptografado = true;
        const env = obj; obj = null;
        try {
          K.conferirEnvelope(env);
          const textoClaro = await pedirSenhaArquivo(nome, env);
          if (textoClaro === null) validacao = { ok: false, erros: ['Senha não informada: restauração cancelada.'], avisos: [] };
          else {
            try { obj = JSON.parse(textoClaro); } catch (e) { validacao = { ok: false, erros: ['O conteúdo descriptografado não é um backup válido.'], avisos: [] }; }
          }
        } catch (e) { validacao = { ok: false, erros: [mensagemErro(e)], avisos: [] }; }
      }
      if (obj) validacao = await app.store.validarBackup(obj);
    } catch (e) { validacao = { ok: false, erros: ['Falha ao ler o arquivo: ' + e.message], avisos: [] }; }
    if (!validacao.ok) obj = null;
    pendente = { nome, obj, validacao, criptografado };
    UI.$('#resultado-validacao', el).innerHTML = String(resultado(pendente));
    ligarRestaurar(el, app);
    if (!app.editavel) UI.somenteLeitura(UI.$('#resultado-validacao', el));
  }

  function resultado(p) {
    const v = p.validacao;
    if (!v.ok) {
      return h`<div class="faixa erro"><b>Backup recusado: “${p.nome}”.</b> Nenhum dado foi alterado.<ul>${v.erros.map((e) => h`<li>${e}</li>`)}</ul>${v.totalErros > v.erros.length ? h`<p>… e mais ${v.totalErros - v.erros.length} erro(s).</p>` : ''}</div>`;
    }
    return h`<div class="faixa ok"><b>Backup válido: “${p.nome}”</b> — gerado em ${U.fmtDateTimeISO(v.geradoEm)} (versão do sistema ${v.versaoSistema || '?'}). Integridade verificada.</div>
      <p id="protecao-backup">${p.criptografado ? h`🔒 <b>Backup criptografado</b>: descriptografado com a senha informada e autenticado (AES-256-GCM).` : h`Este backup <b>não é criptografado</b> (arquivo JSON comum).`}</p>
      ${v.avisos.length ? h`<div class="faixa alerta"><ul>${v.avisos.map((a) => h`<li>${a}</li>`)}</ul></div>` : ''}
      <table class="tabela"><thead><tr><th>Conteúdo</th><th>No backup</th></tr></thead><tbody>${Object.entries(v.resumo).filter(([k]) => NOMES[k]).map(([k, n]) => h`<tr><td>${NOMES[k]}</td><td>${n}</td></tr>`)}</tbody></table>
      <div class="faixa alerta">A restauração <b>substitui todos os dados atuais</b> deste navegador pelos dados do backup (não mistura nem duplica registros). Uma cópia de segurança interna do estado atual será criada antes.</div>
      <div class="acoes"><button type="button" class="perigo" id="restaurar">IMPORTAR E RESTAURAR BACKUP</button> <button type="button" data-leitura id="descartar">Descartar</button></div>`;
  }

  function ligarRestaurar(el, app) {
    const d = UI.$('#descartar', el);
    if (d) d.onclick = () => { pendente = null; app.render(); };
    const r = UI.$('#restaurar', el);
    if (!r) return;
    r.onclick = async () => {
      const ok = await UI.confirmar('Restaurar backup', 'Todos os dados atuais serão substituídos pelos do arquivo “' + pendente.nome + '”.\nRecomenda-se exportar um backup dos dados atuais antes de continuar.', { perigo: true, digitar: 'RESTAURAR', botao: 'Restaurar' });
      if (!ok) return;
      await app.acao(async () => {
        const res = await app.store.restaurarBackup(pendente.obj);
        pendente = null;
        app.state.empId = null;
        return res;
      }, 'Backup restaurado com sucesso.');
    };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
