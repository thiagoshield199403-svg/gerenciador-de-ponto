/* Marcações diárias, conferência e correções com histórico. */
(function (root) {
  'use strict';
  const P = root.Ponto; const U = P.util, C = P.calc, UI = P.ui; const h = UI.h;
  P.views = P.views || {};

  /** Hora da marcação; indica "+1" quando cai no dia seguinte à data de referência. */
  function horaM(m, dataRef) {
    const dd = U.dtDate(m.dt);
    const dif = U.dayNumber(dd) - U.dayNumber(dataRef);
    return U.dtTime(m.dt) + (dif ? ' (' + (dif > 0 ? '+' : '') + dif + 'd)' : '');
  }

  function celM(m, dataRef) {
    if (!m) return h`<span class="mudo">—</span>`;
    return h`<span class="marc ${m.duplicada ? 'dup' : ''}" title="${m.duplicada ? 'Possível duplicidade (ignorada no cálculo)' : ''}">${horaM(m, dataRef)} ${UI.badgeOrigem(m)}</span>`;
  }

  function previstoTxt(d) {
    if (d.foraContrato) return 'Fora do contrato';
    if (!d.periodosPrevistos.length) return ({ folga: 'Folga', feriado: 'Feriado', ferias: 'Férias' }[d.tipoDia] || 'Sem jornada');
    return d.periodosPrevistos.map((p) => p.ini + '–' + p.fim).join(' / ');
  }

  P.views.marcacoes = {
    titulo: 'Marcações',
    filtroPendentes: false,
    render(el, app) {
      const s = app.store, emp = app.funcionarioSel(), comp = app.state.comp;
      if (!emp) { el.innerHTML = String(UI.vazio('Cadastre um funcionário primeiro.', h`<a class="botao primario" href="#/funcionarios/novo">Cadastrar</a>`)); return; }
      const cp = s.competencia(emp.id, comp);
      const ap = cp.apuracao, t = ap.totais;
      const dias = this.filtroPendentes ? ap.dias.filter((d) => d.pendente) : ap.dias;
      el.innerHTML = String(h`
        <h1>Marcações <small>${emp.nome} — ${U.compLabel(comp)}</small></h1>
        ${cp.fechada ? h`<div class="faixa ok">Competência FECHADA em ${U.fmtDateTimeISO(cp.fechamento.snapshot.geradoEm)}. Os dados abaixo estão congelados. Para corrigir, reabra em <a href="#/fechamento">Fechamento mensal</a>.</div>` : ''}
        ${emp.demo ? h`<div class="faixa exemplo">Funcionária de EXEMPLO — marcações fictícias.</div>` : ''}
        <div class="kpis compacto">
          <div class="kpi"><span class="rotulo">Previsto</span><span class="valor">${U.dur(t.previstoMin)}</span></div>
          <div class="kpi"><span class="rotulo">Trabalhado</span><span class="valor">${U.dur(t.trabalhadoMin)}</span></div>
          <div class="kpi"><span class="rotulo">Créditos</span><span class="valor">${UI.saldoSpan(t.creditosMin)}</span></div>
          <div class="kpi"><span class="rotulo">Débitos</span><span class="valor">${UI.saldoSpan(-t.debitosMin)}</span></div>
          <div class="kpi"><span class="rotulo">Dias pendentes</span><span class="valor">${t.diasPendentes}</span></div>
        </div>
        <div class="acoes">
          ${!cp.fechada ? h`<button type="button" class="primario" id="incluir">+ Incluir marcação</button>` : ''}
          <a class="botao" href="#/importar">IMPORTAR PONTO</a>
          <label class="chk" data-leitura><input type="checkbox" id="filtro" ${this.filtroPendentes ? UI.raw('checked') : ''}> Mostrar somente dias pendentes</label>
          <span class="legenda">Origem: ${UI.badgeOrigem({ origem: 'importacao' })} relógio · ${UI.badgeOrigem({ origem: 'manual' })} manual · ${UI.badgeOrigem({ origem: 'importacao-teste' })} arquivo de teste · ${UI.badgeOrigem({ origem: 'exemplo' })} exemplo · * horário ajustado</span>
        </div>
        <div class="tabela-rolagem"><table class="tabela marcacoes">
          <thead><tr><th>Data</th><th>Jornada prevista</th><th>Entrada</th><th>Saída intervalo</th><th>Retorno</th><th>Saída final</th><th>Outras</th><th>Trabalhado</th><th>Saldo</th><th>Ocorrências / observações</th><th>Situação</th></tr></thead>
          <tbody>${dias.map((d) => {
            const ms = d.marcacoes;
            const fimSemana = d.diaSemana === 0 || d.diaSemana === 6;
            return h`<tr class="dia ${fimSemana ? 'fds' : ''} ${d.pendente ? 'pendente' : ''}" data-dia="${d.data}" tabindex="0" title="Clique para ver detalhes e corrigir">
              <td class="nowrap"><b>${U.fmtDate(d.data).slice(0, 5)}</b> ${U.WEEKDAYS_SHORT[d.diaSemana]}</td>
              <td class="mudo">${previstoTxt(d)}</td>
              <td>${celM(ms[0], d.data)}</td><td>${celM(ms[1], d.data)}</td><td>${celM(ms[2], d.data)}</td><td>${celM(ms[3], d.data)}</td>
              <td>${ms.slice(4).map((m) => celM(m, d.data))}</td>
              <td>${ms.length ? U.dur(d.trabalhadoMin) : ''}</td>
              <td>${d.saldoMin === null ? h`<span class="mudo">—</span>` : UI.saldoSpan(d.saldoMin)}</td>
              <td class="ocorr">${d.eventos.map((e) => h`<span class="badge neutro">${(C.TIPOS_EVENTO[e.tipo] || {}).nome || e.tipo}</span> `)}${d.ocorrencias.filter((o) => o.nivel !== 'info').map((o) => h`<div class="${o.nivel}">${o.texto}</div>`)}${d.removidas && d.removidas.length ? h`<div class="mudo">${d.removidas.length} marcação(ões) desconsiderada(s)</div>` : ''}${d.obs ? h`<div class="obs">Obs.: ${d.obs}</div>` : ''}</td>
              <td>${UI.badgeSituacaoDia(d)}</td></tr>`;
          })}</tbody>
        </table></div>
        ${!dias.length ? UI.vazio('Nenhum dia pendente nesta competência.') : ''}`);

      UI.$('#filtro', el).onchange = (e) => { this.filtroPendentes = e.target.checked; app.render(); };
      const inc = UI.$('#incluir', el);
      if (inc) inc.onclick = () => incluir(app, emp, null);
      UI.$$('tr.dia', el).forEach((tr) => {
        tr.onclick = () => abrirDia(app, emp.id, tr.dataset.dia);
        tr.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abrirDia(app, emp.id, tr.dataset.dia); } };
      });
    }
  };

  // ------------------------------------------------------------ ações de correção
  async function incluir(app, emp, data) {
    const dataPadrao = data || (U.compOf(U.todayKey()) === app.state.comp ? U.todayKey() : app.state.comp + '-01');
    return UI.modal({
      titulo: 'Incluir marcação — ' + emp.nome,
      corpo: h`<p class="ajuda">Use para incluir uma marcação esquecida. Ela fica identificada como <b>manual</b>, com a justificativa e a data do lançamento.</p>
        <div class="grade">
          <label>Data da batida<input type="date" name="data" value="${dataPadrao}" required></label>
          <label>Hora<input type="time" name="hora" required></label>
        </div>
        ${data ? h`<label class="chk"><input type="checkbox" name="manterRef" checked> Vincular ao dia de trabalho ${U.fmtDate(data)} (útil em jornadas que passam da meia-noite)</label>` : ''}
        <label>Justificativa (obrigatória)<textarea name="just" rows="2"></textarea></label>`,
      botoes: [{ texto: 'Cancelar', valor: false }, { texto: 'Incluir', valor: true, classe: 'primario' }],
      validar: async (v, f) => {
        if (!f.data.value || !f.hora.value) throw UI.falha('Informe data e hora.');
        const ref = f.manterRef && f.manterRef.checked ? data : null;
        await app.store.incluirMarcacao(emp.id, f.data.value + ' ' + f.hora.value, f.just.value, ref);
      }
    }).then((r) => { if (r) { UI.toast('Marcação incluída.'); app.render(); } return r; });
  }

  async function alterar(app, emp, m, dataRef) {
    return UI.modal({
      titulo: 'Corrigir horário',
      corpo: h`<p>Horário atual: <b>${U.fmtDate(U.dtDate(m.dt))} ${U.dtTime(m.dt)}</b>${m.original && m.original !== m.dt ? h` (original: ${U.fmtDate(U.dtDate(m.original))} ${U.dtTime(m.original)})` : ''}</p>
        <p class="ajuda">O registro original é preservado; a correção é gravada separadamente com justificativa.</p>
        <div class="grade"><label>Nova data<input type="date" name="data" value="${U.dtDate(m.dt)}"></label><label>Nova hora<input type="time" name="hora" value="${U.dtTime(m.dt)}"></label></div>
        <label class="chk"><input type="checkbox" name="manterRef" checked> Manter no dia de trabalho ${U.fmtDate(dataRef)}</label>
        <label>Justificativa (obrigatória)<textarea name="just" rows="2"></textarea></label>`,
      botoes: [{ texto: 'Cancelar', valor: false }, { texto: 'Salvar correção', valor: true, classe: 'primario' }],
      validar: async (v, f) => {
        if (!f.data.value || !f.hora.value) throw UI.falha('Informe data e hora.');
        await app.store.alterarMarcacao(emp.id, m.ref, f.data.value + ' ' + f.hora.value, f.just.value, f.manterRef.checked ? dataRef : null);
      }
    });
  }

  function historico(app, empId, ref) {
    const hst = app.store.historicoMarcacao(empId, ref);
    if (!hst) return;
    const m = hst.marcacao;
    const nomes = { inclusao: 'Inclusão manual', alteracao: 'Alteração de horário', desconsiderar: 'Desconsiderada (exclusão)', restaurar: 'Restaurada' };
    UI.modal({
      titulo: 'Histórico da marcação', largo: true,
      corpo: h`<p>Origem: <b>${UI.ORIGENS[m.origem] || m.origem}</b>${m.original ? h` — horário original registrado: <b>${U.fmtDate(U.dtDate(m.original.dt))} ${U.dtTime(m.original.dt)}</b>` : ''}</p>
        <p>Situação atual: <b>${m.removida ? 'desconsiderada' : U.fmtDate(U.dtDate(m.dt)) + ' ' + U.dtTime(m.dt)}</b>${m.removidaPorImportacao ? ' (importação desconsiderada)' : ''}</p>
        <table class="tabela"><thead><tr><th>Lançado em</th><th>Ação</th><th>De</th><th>Para</th><th>Justificativa</th></tr></thead>
        <tbody>${hst.ajustes.length ? hst.ajustes.map((a) => h`<tr><td>${U.fmtDateTimeISO(a.criadoEm)}</td><td>${nomes[a.tipo]}</td><td>${a.dtAnterior ? U.fmtDate(U.dtDate(a.dtAnterior)) + ' ' + U.dtTime(a.dtAnterior) : '—'}</td><td>${a.dt ? U.fmtDate(U.dtDate(a.dt)) + ' ' + U.dtTime(a.dt) : '—'}</td><td>${a.justificativa}</td></tr>`) : h`<tr><td colspan="5">Nenhum ajuste: marcação original sem alterações.</td></tr>`}</tbody></table>`
    });
  }

  async function registrarOcorrenciaDia(app, emp, data) {
    return UI.modal({
      titulo: 'Registrar ocorrência em ' + U.fmtDate(data),
      corpo: h`<label>Tipo<select name="tipo">${Object.entries(C.TIPOS_EVENTO).map(([k, v]) => h`<option value="${k}">${v.nome}</option>`)}</select></label>
        <label class="minutos" hidden>Horas a abonar (hh:mm)<input name="minutos" placeholder="01:00"></label>
        <label>Descrição / justificativa<textarea name="desc" rows="2"></textarea></label>
        <p class="ajuda">Feriados registrados aqui valem só para este funcionário; para todos, use “Ocorrências e feriados”.</p>`,
      aoAbrir: (dlg) => { const sel = dlg.querySelector('[name=tipo]'); const lb = dlg.querySelector('.minutos'); sel.onchange = () => { lb.hidden = !C.TIPOS_EVENTO[sel.value].abonaMinutos; }; },
      botoes: [{ texto: 'Cancelar', valor: false }, { texto: 'Registrar', valor: true, classe: 'primario' }],
      validar: async (v, f) => {
        const min = f.minutos.value ? U.parseDuracao(f.minutos.value) : 0;
        if (C.TIPOS_EVENTO[f.tipo.value].abonaMinutos && !(min > 0)) throw UI.falha('Informe as horas a abonar no formato hh:mm.');
        await app.store.registrarEvento({ employeeId: emp.id, data, tipo: f.tipo.value, descricao: f.desc.value, minutos: min });
      }
    });
  }

  // ------------------------------------------------------------ detalhe do dia
  function abrirDia(app, empId, data) {
    const dlg = document.createElement('dialog');
    dlg.className = 'modal largo';
    document.body.appendChild(dlg);
    const fechar = () => { dlg.close(); dlg.remove(); app.render(); };
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); fechar(); });

    const executar = async (fn, msg) => {
      try { const r = await fn(); if (r !== null && r !== false) { if (msg) UI.toast(msg); } } catch (e) { UI.erro(e); }
      desenhar();
    };

    function desenhar() {
      const s = app.store, emp = s.funcionario(empId);
      const cp = s.competencia(empId, U.compOf(data));
      const d = cp.apuracao.dias.find((x) => x.data === data);
      const ro = cp.fechada;
      const cf = s.conferencia(empId, data);
      dlg.innerHTML = String(h`
        <div class="dlg">
        <header><h2>${U.WEEKDAYS[d.diaSemana]}, ${U.fmtDate(data)} — ${emp.nome}</h2><button type="button" class="fechar" data-leitura data-a="fechar" aria-label="Fechar">×</button></header>
        <div class="corpo">
          ${ro ? h`<div class="faixa ok">Competência fechada: somente consulta.</div>` : ''}
          <p>Jornada prevista: <b>${previstoTxt(d)}</b> (${U.dur(d.previstoMin)}) · Situação: ${UI.badgeSituacaoDia(d)}</p>
          ${d.eventos.length ? h`<p>Ocorrências registradas: ${d.eventos.map((e) => h`<span class="badge neutro">${C.TIPOS_EVENTO[e.tipo].nome}${e.minutos ? ' ' + U.dur(e.minutos) : ''}</span> ${e.descricao} `)}</p>` : ''}
          ${d.ocorrencias.length ? h`<ul class="ocorrencias">${d.ocorrencias.map((o) => h`<li class="${o.nivel}"><b>${{ erro: 'Inconsistência', alerta: 'Alerta', info: 'Informação' }[o.nivel]}:</b> ${o.texto}</li>`)}</ul>` : ''}
          <h3>Marcações consideradas</h3>
          <table class="tabela"><thead><tr><th>#</th><th>Data/hora</th><th>Origem</th><th>Original</th><th>Observação</th><th></th></tr></thead>
          <tbody>${d.marcacoes.length ? d.marcacoes.map((m, i) => h`<tr class="${m.duplicada ? 'dup' : ''}">
            <td>${i + 1}</td><td><b>${horaM(m, data)}</b> <small class="mudo">${U.fmtDate(U.dtDate(m.dt))}</small></td>
            <td>${UI.ORIGENS[m.origem] || m.origem}</td>
            <td>${m.ajustada ? U.fmtDate(U.dtDate(m.original)) + ' ' + U.dtTime(m.original) : '—'}</td>
            <td>${m.duplicada ? 'Possível duplicidade (ignorada no cálculo)' : ''}</td>
            <td class="nowrap">${!ro ? h`<button type="button" data-a="alterar" data-ref="${m.ref}">Corrigir</button> <button type="button" class="perigo" data-a="excluir" data-ref="${m.ref}">Excluir</button> ` : ''}<button type="button" data-leitura data-a="hist" data-ref="${m.ref}">Histórico</button></td></tr>`) : h`<tr><td colspan="6" class="mudo">Nenhuma marcação.</td></tr>`}</tbody></table>
          ${d.removidas && d.removidas.length ? h`<h3>Marcações desconsideradas (preservadas no histórico)</h3>
            <table class="tabela"><tbody>${d.removidas.map((m) => h`<tr class="removida"><td><s>${horaM(m, data)}</s></td><td>${UI.ORIGENS[m.origem] || m.origem}</td><td>${m.motivo}</td>
            <td class="nowrap">${!ro ? h`<button type="button" data-a="restaurar" data-ref="${m.ref}">Restaurar</button> ` : ''}<button type="button" data-leitura data-a="hist" data-ref="${m.ref}">Histórico</button></td></tr>`)}</tbody></table>` : ''}
          <h3>Apuração do dia</h3>
          <div class="kpis compacto">
            <div class="kpi"><span class="rotulo">Trabalhado</span><span class="valor">${U.dur(d.trabalhadoMin)}</span></div>
            <div class="kpi"><span class="rotulo">Intervalo</span><span class="valor">${U.dur(d.intervaloMin)}</span></div>
            <div class="kpi"><span class="rotulo">Atraso</span><span class="valor">${U.dur(d.atrasoMin)}</span></div>
            <div class="kpi"><span class="rotulo">Saída antecipada</span><span class="valor">${U.dur(d.saidaAntecipadaMin)}</span></div>
            <div class="kpi"><span class="rotulo">Diferença bruta</span><span class="valor">${d.diferencaBrutaMin === null ? '—' : UI.saldoSpan(d.diferencaBrutaMin)}</span></div>
            <div class="kpi"><span class="rotulo">Saldo do dia</span><span class="valor">${d.saldoMin === null ? 'não apurado' : UI.saldoSpan(d.saldoMin)}</span></div>
            ${d.abonoMin ? h`<div class="kpi"><span class="rotulo">Abonado</span><span class="valor">${U.dur(d.abonoMin)}</span></div>` : ''}
            ${d.compensacaoMin ? h`<div class="kpi"><span class="rotulo">Compensação</span><span class="valor">${U.dur(d.compensacaoMin)}</span></div>` : ''}
          </div>
          <p><b>Observação do dia:</b> ${d.obs || h`<span class="mudo">nenhuma</span>`}</p>
          ${cf && cf.conferidoEm ? h`<p class="mudo">Conferido em ${U.fmtDateTimeISO(cf.conferidoEm)}.</p>` : ''}
        </div>
        <footer>
          ${!ro ? h`
            <button type="button" class="primario" data-a="incluir">+ Incluir marcação</button>
            <button type="button" data-a="ocorrencia">Registrar ocorrência</button>
            <button type="button" data-a="obs">Observação</button>
            ${d.conferido ? h`<button type="button" data-a="desconferir">Desfazer conferência</button>` : h`<button type="button" data-a="conferir" ${d.ocorrencias.some((o) => o.nivel === 'erro') ? UI.raw('disabled title="Corrija as inconsistências antes de conferir"') : ''}>Marcar dia como conferido</button>`}` : ''}
          <button type="button" data-leitura data-a="fechar">Fechar</button>
        </footer></div>`);

      if (!app.editavel) UI.somenteLeitura(dlg);
      dlg.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', () => {
        const a = b.dataset.a, ref = b.dataset.ref;
        const m = ref ? (d.marcacoes.find((x) => x.ref === ref) || d.removidas.find((x) => x.ref === ref)) : null;
        if (a === 'fechar') return fechar();
        if (a === 'hist') return historico(app, empId, ref);
        if (a === 'alterar') return executar(() => alterar(app, emp, m, data), 'Horário corrigido.');
        if (a === 'excluir') return executar(() => UI.justificar('Excluir marcação ' + U.dtTime(m.dt), 'A marcação deixará de ser considerada no cálculo. O registro original e esta exclusão ficam no histórico.', (t) => app.store.desconsiderarMarcacao(empId, ref, t), { perigo: true, botao: 'Excluir' }), 'Marcação desconsiderada.');
        if (a === 'restaurar') return executar(() => UI.justificar('Restaurar marcação', '', (t) => app.store.restaurarMarcacao(empId, ref, t)), 'Marcação restaurada.');
        if (a === 'incluir') return executar(() => incluir(app, emp, data), null);
        if (a === 'ocorrencia') return executar(() => registrarOcorrenciaDia(app, emp, data), 'Ocorrência registrada.');
        if (a === 'conferir') return executar(() => app.store.conferirDia(empId, data), 'Dia conferido.');
        if (a === 'desconferir') return executar(() => app.store.desfazerConferencia(empId, data), 'Conferência desfeita.');
        if (a === 'obs') return executar(() => UI.modal({
          titulo: 'Observação do dia ' + U.fmtDate(data),
          corpo: h`<textarea name="obs" rows="3">${d.obs}</textarea>`,
          botoes: [{ texto: 'Cancelar', valor: false }, { texto: 'Salvar', valor: true, classe: 'primario' }],
          validar: (v, f) => app.store.salvarObservacaoDia(empId, data, f.obs.value)
        }), 'Observação salva.');
      }));
    }

    desenhar();
    dlg.showModal();
  }

  P.views.marcacoes.abrirDia = abrirDia;
})(typeof globalThis !== 'undefined' ? globalThis : this);
