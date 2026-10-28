/*
 * app.js — Inicialização, verificação de armazenamento, roteamento e estado global
 * (funcionário e competência selecionados).
 */
(function (root) {
  'use strict';
  const P = root.Ponto;
  const U = P.util, UI = P.ui;

  const App = {
    store: null,
    views: P.views,
    state: { empId: null, comp: U.compOf(U.todayKey()), view: 'painel', param: null },
    armazenamento: { persistente: null, protocolo: location.protocol, estimativa: null }
  };
  P.app = App;

  // ------------------------------------------------------------ preferências locais (apenas conveniência)
  const PREF = 'gerenciador-ponto:preferencias';
  function lerPref() { try { return JSON.parse(localStorage.getItem(PREF) || '{}'); } catch (e) { return {}; } }
  function salvarPref() { try { localStorage.setItem(PREF, JSON.stringify({ empId: App.state.empId, comp: App.state.comp })); } catch (e) { /* ignora */ } }

  // ------------------------------------------------------------ ações com tratamento de erro
  /** Executa uma operação; em caso de erro mostra a mensagem; ao final re-renderiza. */
  App.acao = async function (fn, msgOk) {
    try {
      const r = await fn();
      if (r !== false && msgOk) UI.toast(msgOk);
      return r;
    } catch (e) { UI.erro(e); return false; }
    finally { App.render(); }
  };

  App.funcionarioSel = function () { return App.state.empId ? App.store.funcionario(App.state.empId) : null; };

  App.ir = function (view, param) { location.hash = '#/' + view + (param ? '/' + encodeURIComponent(param) : ''); };

  // ------------------------------------------------------------ cabeçalho
  function renderSeletores() {
    const sel = UI.$('#sel-funcionario');
    const fs = App.store.funcionarios();
    if (App.state.empId && !fs.some((f) => f.id === App.state.empId)) App.state.empId = null;
    if (!App.state.empId && fs.length) App.state.empId = (fs.find((f) => f.situacao === 'ativo') || fs[0]).id;
    sel.innerHTML = fs.length
      ? String(UI.h`${fs.map((f) => UI.h`<option value="${f.id}" ${f.id === App.state.empId ? UI.raw('selected') : ''}>${f.nome}${f.situacao === 'inativo' ? ' (inativo)' : ''}</option>`)}`)
      : '<option value="">— nenhum funcionário cadastrado —</option>';
    sel.disabled = !fs.length;
    UI.$('#sel-comp').value = App.state.comp;

    const sis = App.store.sistema();
    const av = UI.$('#aviso-backup');
    const dias = sis.ultimoBackupEm ? Math.floor((Date.now() - new Date(sis.ultimoBackupEm)) / 86400000) : null;
    if ((sis.alteracoesDesdeBackup || 0) > 0 && (dias === null || dias >= 7 || sis.alteracoesDesdeBackup >= 50)) {
      av.hidden = false;
      av.innerHTML = String(UI.h`⚠ ${sis.ultimoBackupEm ? 'Último backup há ' + dias + ' dia(s)' : 'Nenhum backup exportado ainda'} — ${sis.alteracoesDesdeBackup} alteração(ões) sem cópia externa. <a href="#/backup">Exportar backup</a>`);
    } else av.hidden = true;
  }

  function renderStatusArmazenamento() {
    const a = App.armazenamento;
    const el = UI.$('#status-armazenamento');
    const pers = a.persistente === true ? 'persistente' : a.persistente === false ? 'não persistente' : 'desconhecido';
    el.innerHTML = String(UI.h`<span class="ponto ${a.persistente ? 'ok' : 'alerta'}"></span>Armazenamento: IndexedDB (${pers})<br><small>${a.protocolo === 'file:' ? 'Aberto como arquivo local' : 'Aberto via ' + location.host}</small>`);
  }

  // ------------------------------------------------------------ roteamento
  function lerRota() {
    const partes = (location.hash || '#/painel').replace(/^#\/?/, '').split('/');
    App.state.view = App.views[partes[0]] ? partes[0] : 'painel';
    App.state.param = partes[1] ? decodeURIComponent(partes[1]) : null;
  }

  let renderizando = false;
  App.render = function () {
    if (renderizando) return;
    renderizando = true;
    try {
      renderSeletores();
      UI.$$('#menu a').forEach((a) => a.classList.toggle('ativo', a.dataset.view === App.state.view));
      const v = App.views[App.state.view];
      const el = UI.$('#view');
      document.title = v.titulo + ' — Gerenciador de Ponto';
      el.innerHTML = '';
      App.formAlterado = false;
      UI.$('#aviso-atualizacao').hidden = true;
      renderModo();
      const r = v.render(el, App);
      if (!App.editavel) {
        UI.somenteLeitura(el);
        if (r && typeof r.then === 'function') r.then(() => UI.somenteLeitura(el)); // telas com partes assíncronas
      }
    } catch (e) {
      console.error(e);
      UI.$('#view').innerHTML = String(UI.h`<div class="erro-fatal"><h2>Erro ao exibir a tela</h2><p>${e.message}</p><p>Seus dados não foram alterados. Recarregue a página; se persistir, exporte um backup em “Backup”.</p></div>`);
    } finally { renderizando = false; }
  };

  // ------------------------------------------------------------ inicialização
  async function verificarArmazenamento() {
    try {
      if (navigator.storage && navigator.storage.persisted) {
        App.armazenamento.persistente = await navigator.storage.persisted();
        if (!App.armazenamento.persistente && navigator.storage.persist) App.armazenamento.persistente = await navigator.storage.persist();
      }
      if (navigator.storage && navigator.storage.estimate) App.armazenamento.estimativa = await navigator.storage.estimate();
    } catch (e) { /* recurso indisponível neste navegador/modo */ }
  }

  function telaFatal(titulo, detalhes) {
    UI.$('#view').innerHTML = String(UI.h`<div class="erro-fatal"><h2>${titulo}</h2><div class="pre">${detalhes}</div>
      <p>Nenhum dado será gravado enquanto este problema existir. Possíveis causas: navegação privativa/anônima, bloqueio de armazenamento do site nas configurações do navegador, ou outra aba do sistema aberta durante uma atualização.</p>
      <p>Sugestão: abra o sistema no Google Chrome ou Microsoft Edge em uma janela normal (não anônima).</p></div>`);
  }

  // ------------------------------------------------------------ bloqueio de edição entre abas (Web Locks)
  /*
   * Somente a aba que detém o bloqueio exclusivo "gerenciador-ponto:editor" grava dados.
   * - O navegador concede o bloqueio a UMA aba por vez e o libera sozinho quando ela é
   *   fechada, recarregada, navega para outro endereço ou trava (o contexto deixa de existir).
   * - Perda de foco ou aba em segundo plano NÃO liberam o bloqueio.
   * - As demais abas ficam em somente leitura e aguardam na fila do próprio navegador;
   *   quando o bloqueio é liberado, a primeira da fila assume, recarrega os dados do banco
   *   e passa a permitir edição.
   * - Sem Web Locks não há exclusão mútua confiável: todas as abas ficam em somente leitura.
   */
  const NOME_BLOQUEIO = 'gerenciador-ponto:editor';
  App.editavel = false;
  App.modo = 'iniciando'; // 'editor' | 'leitura' | 'sem-suporte' | 'iniciando'
  App.MSG_LEITURA = 'O sistema já está aberto em outra aba. Esta aba está em modo somente leitura.';
  App.MSG_SEM_SUPORTE = 'Este navegador não oferece o bloqueio entre abas (Web Locks). Para evitar perda de dados, esta aba está em modo somente leitura. Use uma versão atual do Google Chrome ou Microsoft Edge.';
  let liberarBloqueio = null;

  /** Tenta obter o bloqueio imediatamente. Resolve true/false sem esperar. */
  function tentarBloqueio() {
    return new Promise((resolve) => {
      navigator.locks.request(NOME_BLOQUEIO, { mode: 'exclusive', ifAvailable: true }, (lock) => {
        if (!lock) { resolve(false); return undefined; }
        resolve(true);
        return new Promise((r) => { liberarBloqueio = r; }); // mantido até a aba deixar de existir
      }).catch(() => resolve(false));
    });
  }

  /** Entra na fila do navegador; `aoObter` é chamado quando esta aba recebe o bloqueio. */
  function aguardarBloqueio(aoObter) {
    navigator.locks.request(NOME_BLOQUEIO, { mode: 'exclusive' }, async () => {
      const segurar = new Promise((r) => { liberarBloqueio = r; });
      try { await aoObter(); } catch (e) { console.error(e); if (liberarBloqueio) liberarBloqueio(); }
      return segurar;
    }).catch((e) => console.error(e));
  }

  function renderModo() {
    const av = UI.$('#aviso-leitura');
    if (App.modo === 'leitura' || App.modo === 'sem-suporte') {
      av.hidden = false;
      av.textContent = App.modo === 'leitura' ? App.MSG_LEITURA : App.MSG_SEM_SUPORTE;
    } else av.hidden = true;
    document.body.classList.toggle('somente-leitura', !App.editavel);
  }

  /** Re-renderização disparada por outra aba: não descarta o que o usuário está digitando. */
  App.renderExterno = function (mensagem) {
    if (App.formAlterado) {
      const av = UI.$('#aviso-atualizacao');
      av.hidden = false;
      av.innerHTML = String(UI.h`${mensagem || 'Os dados foram atualizados.'} Esta tela não foi recarregada para não perder o que você digitou. <button type="button" id="aplicar-atualizacao">Recarregar a tela agora (descarta o que foi digitado)</button>`);
      UI.$('#aplicar-atualizacao').onclick = () => App.render();
      return false;
    }
    App.render();
    if (mensagem) UI.toast(mensagem, 'info');
    return true;
  };

  async function iniciar() {
    UI.$('#versao').textContent = 'versão ' + P.store.VERSAO_SISTEMA;
    const temLocks = !!(navigator.locks && typeof navigator.locks.request === 'function');
    const obtido = temLocks ? await tentarBloqueio() : false;
    App.modo = !temLocks ? 'sem-suporte' : obtido ? 'editor' : 'leitura';
    App.editavel = App.modo === 'editor';
    renderModo();
    try {
      const adapter = new P.db.IndexedDBAdapter();
      App.store = await new P.store.Store(adapter, {
        editavel: App.editavel, motivoSomenteLeitura: App.modo === 'sem-suporte' ? App.MSG_SEM_SUPORTE : App.MSG_LEITURA
      }).init();
    } catch (e) {
      console.error(e);
      // Sem armazenamento esta aba não pode editar: libera o bloqueio para outra aba poder assumir.
      if (liberarBloqueio) { liberarBloqueio(); liberarBloqueio = null; }
      App.editavel = false; App.modo = 'erro';
      telaFatal('Não foi possível acessar o armazenamento do navegador', 'Detalhe técnico: ' + (e && e.message ? e.message : e));
      return;
    }
    if (App.modo === 'leitura') {
      aguardarBloqueio(async () => {
        await App.store.definirEscrita(true); // recarrega do banco antes de permitir gravações
        App.editavel = true; App.modo = 'editor';
        App.renderExterno('A outra aba do sistema foi fechada. Esta aba agora pode editar.');
        if (!App.formAlterado) return;
        renderModo();
      });
    }
    await verificarArmazenamento();
    const pref = lerPref();
    if (pref.empId) App.state.empId = pref.empId;
    if (U.isComp(pref.comp)) App.state.comp = pref.comp;

    // Sincronização entre abas: a aba editora avisa; as de leitura recarregam do banco
    let canal = null;
    try { canal = new BroadcastChannel('gerenciador-ponto'); } catch (e) { /* sem suporte */ }
    App.store.aoAlterar(() => { if (canal) canal.postMessage('alterado'); });
    if (canal) {
      canal.onmessage = async () => {
        await App.store.recarregar();
        App.renderExterno('Dados atualizados por outra aba do sistema.');
      };
    }

    // Marca a tela como "com dados digitados" para não descartá-los em atualizações externas
    UI.$('#view').addEventListener('input', (e) => { if (e.isTrusted && e.target.matches('input, textarea, select')) App.formAlterado = true; });
    // Aviso do navegador ao fechar/recarregar com gravação em andamento ou formulário não salvo
    root.addEventListener('beforeunload', (e) => {
      if ((App.store && App.store.escritasPendentes > 0) || App.formAlterado) { e.preventDefault(); e.returnValue = ''; }
    });

    UI.$('#sel-funcionario').addEventListener('change', (e) => { App.state.empId = e.target.value || null; salvarPref(); App.render(); });
    UI.$('#sel-comp').addEventListener('change', (e) => { if (U.isComp(e.target.value)) { App.state.comp = e.target.value; salvarPref(); App.render(); } });
    UI.$('#comp-ant').addEventListener('click', () => { App.state.comp = U.prevComp(App.state.comp); salvarPref(); App.render(); });
    UI.$('#comp-prox').addEventListener('click', () => { App.state.comp = U.nextComp(App.state.comp); salvarPref(); App.render(); });
    root.addEventListener('hashchange', () => { lerRota(); App.render(); UI.$('#view').focus({ preventScroll: true }); root.scrollTo(0, 0); });

    renderStatusArmazenamento();
    lerRota();
    App.render();
    App.pronto = true;
  }

  App.selecionarFuncionario = function (id) { App.state.empId = id; salvarPref(); };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
  else iniciar();
})(typeof globalThis !== 'undefined' ? globalThis : this);
