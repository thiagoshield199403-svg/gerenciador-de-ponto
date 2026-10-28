/* Fechamento mensal: verificação de pendências, confirmação, congelamento e reabertura controlada. */
(function (root) {
  'use strict';
  const P = root.Ponto; const U = P.util, B = P.bank, UI = P.ui; const h = UI.h;
  P.views = P.views || {};

  const ACOES = { fechamento: 'Fechamento', reabertura: 'Reabertura', 'recalculo-saldo': 'Recálculo do saldo transportado' };

  P.views.fechamento = {
    titulo: 'Fechamento mensal',
    render(el, app) {
      const s = app.store, emp = app.funcionarioSel(), comp = app.state.comp;
      if (!emp) { el.innerHTML = String(UI.vazio('Cadastre um funcionário primeiro.')); return; }
      const f = s.fechamento(emp.id, comp);
      const fechada = !!(f && f.status === 'fechada');
      const v = fechada ? null : s.verificarFechamento(emp.id, comp);
      const cp = s.competencia(emp.id, comp);
      const b = cp.banco, t = cp.apuracao.totais;
      const ini = B.compInicial(emp);
      const comps = [];
      if (ini) for (let c = ini; c <= U.compOf(U.todayKey()); c = U.nextComp(c)) comps.push(c);

      el.innerHTML = String(h`
        <h1>Fechamento mensal <small>${emp.nome} — ${U.compLabel(comp)}</small></h1>
        <div class="cartao">
          <h2>Situação: ${fechada ? h`<span class="badge ok">FECHADA</span>` : f && f.status === 'reaberta' ? h`<span class="badge alerta">REABERTA</span>` : h`<span class="badge neutro">ABERTA</span>`}</h2>
          ${fechada ? h`<p>Fechada em ${U.fmtDateTimeISO(f.snapshot.geradoEm)}. Marcações, ocorrências e lançamentos desta competência estão protegidos contra alteração e os relatórios usam os dados congelados no fechamento.</p>` : ''}
          ${v ? h`
            <h3>1. Pendências e verificações</h3>
            ${v.bloqueios.length ? h`<ul class="ocorrencias">${v.bloqueios.map((x) => h`<li class="erro">${x}</li>`)}</ul>` : h`<p class="ok-texto">✔ Nenhuma pendência impede o fechamento.</p>`}
            ${v.avisos.length ? h`<ul class="ocorrencias">${v.avisos.map((x) => h`<li class="alerta">${x}</li>`)}</ul>` : ''}
            ${v.pendentes.length ? h`<p><a href="#/marcacoes">Ir para as marcações para conferir os dias pendentes</a></p>` : ''}` : ''}
          <h3>${v ? '2. ' : ''}Resumo do período</h3>
          <div class="kpis compacto">
            <div class="kpi"><span class="rotulo">Previsto</span><span class="valor">${U.dur(t.previstoMin)}</span></div>
            <div class="kpi"><span class="rotulo">Trabalhado</span><span class="valor">${U.dur(t.trabalhadoMin)}</span></div>
            <div class="kpi"><span class="rotulo">Faltas</span><span class="valor">${t.faltas}</span></div>
            <div class="kpi"><span class="rotulo">Abonos</span><span class="valor">${U.dur(t.abonosMin)}</span></div>
            ${b ? h`
              <div class="kpi"><span class="rotulo">Saldo anterior</span><span class="valor">${UI.saldoSpan(b.saldoAnteriorMin)}</span></div>
              <div class="kpi"><span class="rotulo">Créditos</span><span class="valor">${UI.saldoSpan(b.creditosMin)}</span></div>
              <div class="kpi"><span class="rotulo">Débitos</span><span class="valor">${UI.saldoSpan(-b.debitosMin)}</span></div>
              <div class="kpi"><span class="rotulo">Compensações + ajustes</span><span class="valor">${UI.saldoSpan(b.compensacoesMin + b.ajustesMin)}</span></div>
              <div class="kpi destaque"><span class="rotulo">Saldo final</span><span class="valor">${UI.saldoSpan(b.saldoFinalMin)}</span></div>` : ''}
          </div>
          <p><a href="#/relatorios">Ver o espelho mensal completo antes de fechar</a></p>
          <div class="acoes">
            ${v ? h`<button type="button" class="primario" id="fechar" ${v.podeFechar ? '' : UI.raw('disabled')}>Fechar competência</button>` : ''}
            ${fechada ? h`<button type="button" class="perigo" id="reabrir">Reabrir competência</button>` : ''}
          </div>
        </div>

        ${f && f.historico.length ? h`<h2>Histórico desta competência</h2>
          <table class="tabela"><thead><tr><th>Data</th><th>Ação</th><th>Saldo final registrado</th><th>Justificativa / observação</th></tr></thead>
          <tbody>${f.historico.slice().reverse().map((x) => h`<tr><td>${U.fmtDateTimeISO(x.em)}</td><td>${ACOES[x.acao] || x.acao}</td>
            <td>${x.acao === 'recalculo-saldo' ? h`${U.saldo(x.de.saldoFinalMin)} → ${U.saldo(x.para.saldoFinalMin)}` : U.saldo(x.saldoFinalMin)}</td>
            <td>${x.justificativa || x.observacao || x.motivo || ''}</td></tr>`)}</tbody></table>` : ''}

        <h2>Competências do funcionário</h2>
        ${comps.length ? h`<div class="tabela-rolagem"><table class="tabela"><thead><tr><th>Competência</th><th>Situação</th><th>Saldo final</th><th></th></tr></thead>
          <tbody>${(() => { const ex = s.extrato(emp.id, comps[comps.length - 1]); return ex.map((l) => { const ff = s.fechamento(emp.id, l.comp); return h`<tr class="${l.comp === comp ? 'selecionada' : ''}"><td>${U.compLabel(l.comp)}</td>
            <td>${l.fechada ? h`<span class="badge ok">Fechada</span>` : ff && ff.status === 'reaberta' ? h`<span class="badge alerta">Reaberta</span>` : h`<span class="badge neutro">Aberta</span>`}</td>
            <td>${UI.saldoSpan(l.saldoFinalMin)}</td><td><button type="button" data-leitura data-comp="${l.comp}">Selecionar</button></td></tr>`; }); })()}</tbody></table></div>` : ''}`);

      UI.$$('[data-comp]', el).forEach((bt) => bt.onclick = () => { app.state.comp = bt.dataset.comp; app.render(); });

      const bf = UI.$('#fechar', el);
      if (bf) bf.onclick = async () => {
        const r = await UI.modal({
          titulo: 'Fechar ' + U.compLabel(comp) + ' — ' + emp.nome,
          corpo: h`<p>Resumo: previsto ${U.dur(t.previstoMin)}, trabalhado ${U.dur(t.trabalhadoMin)}.</p>
            ${b ? h`<p>Saldo anterior <b>${U.saldo(b.saldoAnteriorMin)}</b> + créditos <b>${U.dur(b.creditosMin)}</b> − débitos <b>${U.dur(b.debitosMin)}</b> + compensações/ajustes <b>${U.saldo(b.compensacoesMin + b.ajustesMin)}</b> = saldo final <b>${U.saldo(b.saldoFinalMin)}</b>, que será transportado para ${U.compLabel(U.nextComp(comp))}.</p>` : ''}
            <p>Após o fechamento, os dados desta competência ficam congelados. Alterações exigirão reabertura com justificativa.</p>
            <label class="chk"><input type="checkbox" name="conferi"> Conferi o espelho mensal e as marcações desta competência.</label>
            <label>Observação (opcional)<textarea name="obs" rows="2"></textarea></label>`,
          botoes: [{ texto: 'Cancelar', valor: false }, { texto: 'Fechar competência', valor: true, classe: 'primario' }],
          validar: async (val, fm) => {
            if (!fm.conferi.checked) throw UI.falha('Confirme que conferiu o espelho mensal.');
            return s.fechar(emp.id, comp, fm.obs.value);
          }
        });
        if (r) {
          UI.toast('Competência fechada.' + (r.resultado.atualizadas.length ? ' Saldos atualizados em: ' + r.resultado.atualizadas.map(U.compLabel).join(', ') + '.' : ''));
          app.render();
        }
      };
      const br = UI.$('#reabrir', el);
      if (br) br.onclick = async () => {
        const ok = await UI.justificar('Reabrir ' + U.compLabel(comp),
          'A competência voltará a aceitar correções. Os dados do fechamento anterior ficam registrados no histórico. Ao fechar novamente, os saldos das competências posteriores já fechadas serão recalculados automaticamente.',
          (j) => s.reabrir(emp.id, comp, j), { perigo: true, botao: 'Reabrir' });
        if (ok) { UI.toast('Competência reaberta.'); app.render(); }
      };
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
