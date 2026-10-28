/*
 * ui.js — Utilitários de interface: montagem segura de HTML, modais,
 * confirmações, avisos e download de arquivos.
 *
 * Todo texto vindo de dados (nomes, observações, conteúdo de arquivos) é
 * escapado pelo template h`...`; somente HTML produzido pelo próprio sistema
 * (marcado com raw/h) é inserido sem escape.
 */
(function (root) {
  'use strict';
  const U = root.Ponto.util;
  const UI = {};

  class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
  UI.raw = (s) => new Raw(String(s));
  const fmt = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(fmt).join('') : (v === null || v === undefined || v === false) ? '' : U.esc(v));
  UI.h = (strings, ...vals) => new Raw(strings.reduce((acc, s, i) => acc + s + (i < vals.length ? fmt(vals[i]) : ''), ''));

  UI.$ = (sel, el) => (el || document).querySelector(sel);
  UI.$$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));

  // ---------------------------------------------------------------- avisos
  UI.toast = function (msg, tipo) {
    const box = document.getElementById('toasts');
    const t = document.createElement('div');
    t.className = 'toast ' + (tipo || 'ok');
    t.setAttribute('role', tipo === 'erro' ? 'alert' : 'status');
    t.textContent = msg;
    box.appendChild(t);
    setTimeout(() => { t.classList.add('saindo'); setTimeout(() => t.remove(), 400); }, tipo === 'erro' ? 8000 : 4000);
  };

  /** Mostra o erro ao usuário. Erros de regra têm mensagem pronta; os demais são técnicos. */
  UI.erro = function (e) {
    console.error(e);
    const msg = e && e.name === 'ErroRegra' ? e.message : 'Erro inesperado: ' + ((e && e.message) || e) + '. Nenhum dado foi alterado por esta operação.';
    UI.modal({ titulo: 'Não foi possível concluir', corpo: UI.h`<p class="pre">${msg}</p>`, botoes: [{ texto: 'Entendi', valor: true, classe: 'primario' }] });
  };

  // ---------------------------------------------------------------- modal
  /**
   * Abre um modal. Retorna Promise com { valor, form } do botão clicado (ou null se fechado).
   * opts.validar(valor, form) pode lançar erro para manter o modal aberto.
   */
  UI.modal = function (opts) {
    return new Promise((resolve) => {
      const dlg = document.createElement('dialog');
      dlg.className = 'modal' + (opts.largo ? ' largo' : '');
      dlg.innerHTML = String(UI.h`
        <form method="dialog" novalidate>
          <header><h2>${opts.titulo}</h2><button type="button" class="fechar" aria-label="Fechar" data-x>×</button></header>
          <div class="corpo">${opts.corpo || ''}<p class="erro-form" hidden></p></div>
          <footer>${(opts.botoes || [{ texto: 'OK', valor: true, classe: 'primario' }]).map((b, i) => UI.h`<button type="submit" value="${i}" class="${b.classe || ''}">${b.texto}</button>`)}</footer>
        </form>`);
      document.body.appendChild(dlg);
      const form = dlg.querySelector('form');
      const botoes = opts.botoes || [{ texto: 'OK', valor: true }];
      let resolvido = false;
      const fim = (v) => { if (resolvido) return; resolvido = true; dlg.close(); dlg.remove(); resolve(v); };
      dlg.querySelector('[data-x]').onclick = () => fim(null);
      dlg.addEventListener('cancel', (ev) => { ev.preventDefault(); fim(null); });
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const btn = ev.submitter || form.querySelector('footer button');
        const b = botoes[+btn.value];
        if (b.valor === null || b.valor === false) return fim(null); // cancelar sempre devolve null
        if (!opts.validar) return fim({ valor: b.valor, form });
        const errEl = dlg.querySelector('.erro-form');
        try {
          btn.disabled = true;
          const r = await opts.validar(b.valor, form);
          fim({ valor: b.valor, form, resultado: r });
        } catch (e) {
          errEl.hidden = false;
          errEl.textContent = e && e.message ? e.message : String(e);
          if (!(e && e.name === 'ErroRegra') && !(e && e.validacao)) console.error(e);
        } finally { btn.disabled = false; }
      });
      dlg.showModal();
      if (opts.aoAbrir) opts.aoAbrir(dlg);
      const primeiro = dlg.querySelector('.corpo input:not([type=hidden]), .corpo select, .corpo textarea');
      if (primeiro) primeiro.focus();
    });
  };

  UI.falha = (msg) => { const e = new Error(msg); e.validacao = true; return e; };

  /** Confirmação. opts.perigo destaca ação destrutiva; opts.digitar exige digitar uma palavra. */
  UI.confirmar = async function (titulo, mensagem, opts) {
    opts = opts || {};
    const corpo = UI.h`<div class="pre">${mensagem}</div>${opts.digitar ? UI.h`<label>Para confirmar, digite <b>${opts.digitar}</b>:<input name="conf" autocomplete="off"></label>` : ''}`;
    const r = await UI.modal({
      titulo, corpo,
      botoes: [{ texto: 'Cancelar', valor: false }, { texto: opts.botao || 'Confirmar', valor: true, classe: opts.perigo ? 'perigo' : 'primario' }],
      validar: (v, form) => { if (opts.digitar && form.conf.value.trim().toUpperCase() !== opts.digitar.toUpperCase()) throw UI.falha('Texto de confirmação incorreto.'); }
    });
    return !!(r && r.valor);
  };

  /** Pede uma justificativa obrigatória; executa `acao(texto)` e só fecha se der certo. */
  UI.justificar = async function (titulo, mensagem, acao, opts) {
    opts = opts || {};
    const r = await UI.modal({
      titulo,
      corpo: UI.h`${mensagem ? UI.h`<div class="pre">${mensagem}</div>` : ''}<label>Justificativa (obrigatória)<textarea name="just" rows="3" required minlength="3"></textarea></label>`,
      botoes: [{ texto: 'Cancelar', valor: false }, { texto: opts.botao || 'Confirmar', valor: true, classe: opts.perigo ? 'perigo' : 'primario' }],
      validar: async (v, form) => {
        const t = form.just.value.trim();
        if (t.length < 3) throw UI.falha('Informe a justificativa (mínimo de 3 caracteres).');
        return acao(t);
      }
    });
    return r ? r.resultado === undefined ? true : r.resultado : null;
  };

  /**
   * Modo somente leitura: desativa todos os controles de `el`, exceto os marcados com
   * data-leitura (navegação, impressão, histórico, exportar backup, baixar arquivo).
   * Os valores exibidos são mantidos. A proteção real está no Store e no adaptador.
   */
  UI.somenteLeitura = function (el) {
    UI.$$('button, input, select, textarea', el).forEach((c) => {
      if (c.closest('[data-leitura]')) return;
      c.disabled = true;
      c.title = 'Somente leitura: o sistema está aberto em outra aba';
    });
  };

  // ---------------------------------------------------------------- arquivos
  UI.baixar = function (nome, conteudo, tipo) {
    const blob = conteudo instanceof Blob ? conteudo : new Blob([conteudo], { type: tipo || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = nome; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  UI.lerArquivo = function (file) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(new Uint8Array(fr.result));
      fr.onerror = () => rej(fr.error || new Error('Falha ao ler o arquivo.'));
      fr.readAsArrayBuffer(file);
    });
  };

  // ---------------------------------------------------------------- componentes
  UI.saldoSpan = (min) => UI.h`<span class="saldo ${min > 0 ? 'pos' : min < 0 ? 'neg' : ''}">${U.saldo(min)}</span>`;

  UI.badgeSituacaoDia = function (d) {
    const cls = d.situacao === 'Inconsistente' ? 'erro' : d.situacao === 'Pendente de conferência' ? 'alerta' : d.situacao === 'Conferido' ? 'ok' : d.situacao === 'Aguardando' ? 'neutro' : 'ok-leve';
    return UI.h`<span class="badge ${cls}">${d.situacao}</span>`;
  };

  UI.ORIGENS = { importacao: 'Relógio (importado)', 'importacao-teste': 'Arquivo de TESTE', manual: 'Manual', exemplo: 'Exemplo' };
  UI.badgeOrigem = function (m) {
    const cls = { importacao: 'relogio', 'importacao-teste': 'teste', manual: 'manual', exemplo: 'exemplo' }[m.origem] || '';
    return UI.h`<span class="origem ${cls}" title="${UI.ORIGENS[m.origem] || m.origem}${m.ajustada ? ' — horário ajustado (original ' + (m.original || '').slice(11) + ')' : ''}">${({ importacao: 'R', 'importacao-teste': 'T', manual: 'M', exemplo: 'E' }[m.origem] || '?')}${m.ajustada ? '*' : ''}</span>`;
  };

  UI.vazio = (msg, acao) => UI.h`<div class="vazio"><p>${msg}</p>${acao || ''}</div>`;

  root.Ponto.ui = UI;
})(typeof globalThis !== 'undefined' ? globalThis : this);
