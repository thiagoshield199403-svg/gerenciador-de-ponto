/* Banco de horas: extrato entre competências, movimentação por data, compensações e ajustes. */
(function (root) {
  'use strict';
  const P = root.Ponto; const U = P.util, UI = P.ui; const h = UI.h;
  P.views = P.views || {};

  P.views.banco = {
    titulo: 'Banco de horas',
    render(el, app) {
      const s = app.store, emp = app.funcionarioSel(), comp = app.state.comp;
      if (!emp) { el.innerHTML = String(UI.vazio('Cadastre um funcionário primeiro.')); return; }
      const pol = s.politica();
      const ex = s.extrato(emp.id, comp);
      const linha = ex.length ? ex[ex.length - 1] : null;
      const cp = s.competencia(emp.id, comp);
      const lancs = s.lancamentos(emp.id, comp, true);
      const movDias = cp.apuracao.dias.filter((d) => d.saldoMin !== null && (d.creditoMin || d.debitoMin || d.compensacaoMin));
      const divergentes = ex.filter((l) => l.divergencia);

      el.innerHTML = String(h`
        <h1>Banco de horas <small>${emp.nome}</small></h1>
        <div class="faixa info">Fórmula: <b>saldo final = saldo anterior + créditos − débitos + compensações + ajustes</b>.
          Política atual: créditos ${pol.creditosNoBanco ? 'entram' : 'NÃO entram'} no banco; débitos ${pol.debitosNoBanco ? 'são descontados' : 'NÃO são descontados (ficam para tratamento à parte)'} do banco.
          <a href="#/config">Alterar política</a>. A política deve ser validada conforme contrato, acordo/convenção e legislação aplicável.</div>
        ${divergentes.length ? h`<div class="faixa alerta">Há competências fechadas cujo saldo anterior mudou: ${divergentes.map((l) => U.compLabel(l.comp)).join(', ')}.
          <button type="button" id="atualizar">Atualizar saldos transportados</button></div>` : ''}
        ${!linha ? h`<div class="faixa alerta">A competência ${U.compLabel(comp)} é anterior ao início do banco de horas deste funcionário.</div>` : h`
        <div class="kpis">
          <div class="kpi"><span class="rotulo">Saldo anterior</span><span class="valor">${UI.saldoSpan(linha.saldoAnteriorMin)}</span></div>
          <div class="kpi"><span class="rotulo">Créditos do mês</span><span class="valor">${UI.saldoSpan(linha.creditosMin)}</span></div>
          <div class="kpi"><span class="rotulo">Débitos do mês</span><span class="valor">${UI.saldoSpan(-linha.debitosMin)}</span></div>
          <div class="kpi"><span class="rotulo">Compensações</span><span class="valor">${UI.saldoSpan(linha.compensacoesMin)}</span></div>
          <div class="kpi"><span class="rotulo">Ajustes</span><span class="valor">${UI.saldoSpan(linha.ajustesMin)}</span></div>
          <div class="kpi destaque"><span class="rotulo">Saldo final</span><span class="valor">${UI.saldoSpan(linha.saldoFinalMin)}</span><span class="extra">${linha.fechada ? 'Competência fechada' : linha.provisoria ? 'Provisório — há ' + (linha.diasNaoApurados + linha.diasPendentes) + ' dia(s) não apurados/pendentes' : 'Competência aberta'}</span></div>
        </div>
        ${linha.debitosForaBancoMin || linha.creditosForaBancoMin ? h`<div class="faixa alerta">Fora do banco nesta competência: créditos ${U.dur(linha.creditosForaBancoMin)}, débitos ${U.dur(linha.debitosForaBancoMin)}.</div>` : ''}
        ${linha.alertas.map((a) => h`<div class="faixa alerta">${a}</div>`)}`}

        <h2>Extrato histórico</h2>
        <div class="tabela-rolagem"><table class="tabela">
          <thead><tr><th>Competência</th><th>Saldo anterior</th><th>Créditos</th><th>Débitos</th><th>Compensações</th><th>Ajustes</th><th>Saldo final</th><th>Situação</th></tr></thead>
          <tbody>${ex.map((l) => h`<tr class="${l.comp === comp ? 'selecionada' : ''}"><td>${U.compLabel(l.comp)}</td><td>${UI.saldoSpan(l.saldoAnteriorMin)}</td><td>${U.dur(l.creditosMin)}</td><td>${U.dur(l.debitosMin)}</td><td>${UI.saldoSpan(l.compensacoesMin)}</td><td>${UI.saldoSpan(l.ajustesMin)}</td><td><b>${UI.saldoSpan(l.saldoFinalMin)}</b></td>
            <td>${l.fechada ? h`<span class="badge ok">Fechada</span>` : l.provisoria ? h`<span class="badge alerta">Aberta (provisória)</span>` : h`<span class="badge neutro">Aberta</span>`}${l.divergencia ? h` <span class="badge erro">Saldo anterior alterado</span>` : ''}</td></tr>`)}</tbody>
        </table></div>

        <h2>Créditos e débitos por data — ${U.compLabel(comp)}</h2>
        ${movDias.length || lancs.length ? h`<div class="tabela-rolagem curta"><table class="tabela"><thead><tr><th>Data</th><th>Origem</th><th>Crédito</th><th>Débito</th><th>Compensação</th><th>Ajuste</th><th>Detalhe</th></tr></thead>
          <tbody>${[
            ...movDias.map((d) => ({ data: d.data, html: h`<tr><td>${U.fmtDate(d.data)}</td><td>Apuração diária</td><td>${d.creditoMin ? U.dur(d.creditoMin) : ''}</td><td>${d.debitoMin ? U.dur(d.debitoMin) : ''}</td><td>${d.compensacaoMin ? '-' + U.dur(d.compensacaoMin) : ''}</td><td></td><td>${d.falta ? 'Falta' : ''}${d.compensacaoMin ? 'Folga compensatória' : ''}</td></tr>` })),
            ...lancs.map((l) => ({ data: l.data, html: h`<tr class="${l.cancelado ? 'removida' : ''}"><td>${U.fmtDate(l.data)}</td><td>Lançamento manual</td><td></td><td></td><td>${l.tipo === 'compensacao' ? U.saldo(l.minutos) : ''}</td><td>${l.tipo === 'ajuste' ? U.saldo(l.minutos) : ''}</td>
              <td>${l.justificativa}${l.cancelado ? h` <span class="badge neutro" title="${l.cancelado.motivo}">cancelado</span>` : (!cp.fechada ? h` <button type="button" class="perigo" data-cancelar="${l.id}">Cancelar</button>` : '')}</td></tr>` }))
          ].sort((a, b) => U.cmp(a.data, b.data)).map((x) => x.html)}</tbody></table></div>` : UI.vazio('Sem movimentação apurada nesta competência.')}

        ${!cp.fechada && linha ? h`<div class="cartao"><h2>Registrar compensação ou ajuste</h2>
          <form id="form-lanc" class="grade" novalidate>
            <label>Tipo<select name="tipo"><option value="compensacao">Compensação (ex.: pagamento das horas, folga já usufruída)</option><option value="ajuste">Ajuste justificado</option></select></label>
            <label>Data<input type="date" name="data" value="${comp}-01"></label>
            <label>Horas (±hh:mm)<input name="horas" placeholder="-02:00 ou +01:30"></label>
            <label class="largo">Justificativa (obrigatória)<input name="just"></label>
            <p class="ajuda largo">Use valores negativos para reduzir o saldo e positivos para aumentar. Para folga compensatória em dia de trabalho, prefira registrar a ocorrência “Folga compensatória” no dia.</p>
            <div class="largo"><button type="submit" class="primario">Lançar</button></div>
          </form></div>` : ''}`);

      const at = UI.$('#atualizar', el);
      if (at) at.onclick = () => app.acao(async () => {
        const r = await s.atualizarSaldosPosteriores(emp.id, '0000-00', 'atualização manual dos saldos transportados');
        UI.toast(r.length ? 'Atualizadas: ' + r.map(U.compLabel).join(', ') : 'Nada a atualizar.');
      });
      const f = UI.$('#form-lanc', el);
      if (f) f.onsubmit = async (ev) => {
        ev.preventDefault();
        const min = U.parseDuracao(f.horas.value || '');
        if (min === null || min === 0) { UI.toast('Informe as horas no formato ±hh:mm.', 'erro'); return; }
        const ok = await UI.confirmar('Confirmar lançamento', (f.tipo.value === 'ajuste' ? 'Ajuste' : 'Compensação') + ' de ' + U.saldo(min) + ' em ' + U.fmtDate(f.data.value) + '.\nJustificativa: ' + f.just.value);
        if (ok) await app.acao(() => s.lancarBanco({ employeeId: emp.id, data: f.data.value, tipo: f.tipo.value, minutos: min, justificativa: f.just.value }), 'Lançamento registrado.');
      };
      UI.$$('[data-cancelar]', el).forEach((b) => b.onclick = async () => {
        const ok = await UI.justificar('Cancelar lançamento', 'O lançamento deixará de valer, mas fica no histórico.', (t) => s.cancelarLancamento(b.dataset.cancelar, t), { perigo: true });
        if (ok) { UI.toast('Lançamento cancelado.'); app.render(); }
      });
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
