/* Painel inicial: visão geral da competência selecionada. */
(function (root) {
  'use strict';
  const P = root.Ponto; const U = P.util, UI = P.ui; const h = UI.h;
  P.views = P.views || {};

  function kpi(rotulo, valor, extra) {
    return h`<div class="kpi"><span class="rotulo">${rotulo}</span><span class="valor">${valor}</span>${extra ? h`<span class="extra">${extra}</span>` : ''}</div>`;
  }

  function situacaoFech(l) {
    if (l.fechada) return h`<span class="badge ok">Fechada</span>`;
    if (l.reaberta) return h`<span class="badge alerta">Reaberta</span>`;
    return h`<span class="badge neutro">Aberta</span>`;
  }

  P.views.painel = {
    titulo: 'Painel',
    render(el, app) {
      const s = app.store, comp = app.state.comp;
      const todos = s.funcionarios();
      if (!todos.length) {
        el.innerHTML = String(h`
          <h1>Bem-vindo ao Gerenciador de Ponto</h1>
          <div class="cartao">
            <p>Nenhum funcionário cadastrado ainda. Para começar:</p>
            <ol>
              <li>Cadastre os <a href="#/config">dados do empregador</a> (aparecem nos relatórios).</li>
              <li>Cadastre a <a href="#/funcionarios/novo">funcionária</a> com a jornada contratual.</li>
              <li>Lance ou <a href="#/importar">importe</a> as marcações.</li>
              <li>Exporte um <a href="#/backup">backup</a> regularmente.</li>
            </ol>
            <div class="acoes">
              <a class="botao primario" href="#/funcionarios/novo">Cadastrar funcionário</a>
              <button type="button" id="demo">Carregar funcionária de EXEMPLO (dados fictícios)</button>
            </div>
          </div>`);
        UI.$('#demo', el).onclick = () => app.acao(async () => { const f = await s.criarDemo(); app.selecionarFuncionario(f.id); app.state.comp = U.prevComp(U.compOf(U.todayKey())); }, 'Funcionária de exemplo criada. Ela está claramente identificada e pode ser removida em Configurações.');
        return;
      }

      const pn = s.painel(comp);
      const sel = pn.linhas.find((l) => l.funcionario.id === app.state.empId) || pn.linhas[0];
      const sis = pn.sistema;
      const pendTotal = pn.linhas.reduce((a, l) => a + l.diasPendentes, 0);
      const b = sel && sel.banco;

      el.innerHTML = String(h`
        <h1>Painel <small>${U.compLabel(comp)}</small></h1>
        ${s.temDemo() ? h`<div class="faixa exemplo">Existem dados de EXEMPLO (fictícios) no sistema. Remova-os em <a href="#/config">Configurações</a> antes do uso real.</div>` : ''}
        <div class="kpis">
          ${kpi('Funcionários ativos', String(pn.linhas.length))}
          ${kpi('Competência', U.compLabel(comp))}
          ${kpi('Marcações pendentes de conferência', String(pendTotal) + ' dia(s)', pendTotal ? h`<a href="#/marcacoes">Conferir</a>` : 'Nenhuma pendência')}
          ${kpi('Último backup', sis.ultimoBackupEm ? U.fmtDateTimeISO(sis.ultimoBackupEm) : 'Nunca', h`<a href="#/backup">${(sis.alteracoesDesdeBackup || 0) + ' alteração(ões) desde então'}</a>`)}
        </div>
        ${sel ? h`
          <h2>${sel.funcionario.nome}${sel.funcionario.demo ? h` <span class="badge exemplo">EXEMPLO</span>` : ''}</h2>
          <div class="kpis">
            ${kpi('Horas previstas no mês', U.dur(sel.previstoMin))}
            ${kpi('Horas trabalhadas no mês', U.dur(sel.trabalhadoMin))}
            ${kpi('Saldo anterior do banco', b ? UI.saldoSpan(b.saldoAnteriorMin) : '—', b ? '' : 'Competência anterior ao início do banco')}
            ${kpi('Créditos do mês', b ? UI.saldoSpan(b.creditosMin) : '—')}
            ${kpi('Débitos do mês', b ? UI.saldoSpan(-b.debitosMin) : '—')}
            ${kpi('Compensações e ajustes', b ? UI.saldoSpan(b.compensacoesMin + b.ajustesMin) : '—')}
            ${kpi('Saldo acumulado atualizado', b ? UI.saldoSpan(b.saldoFinalMin) : '—', b && b.provisoria ? 'Provisório: há dias não apurados ou pendentes' : '')}
            ${kpi('Fechamento mensal', situacaoFech(sel), h`<a href="#/fechamento">Ir para o fechamento</a>`)}
          </div>
          ${b && b.alertas.length ? h`<div class="faixa alerta">${b.alertas.map((a) => h`<div>${a}</div>`)}</div>` : ''}
        ` : h`<p>Não há funcionários ativos.</p>`}

        <h2>Todos os funcionários ativos</h2>
        <div class="tabela-rolagem"><table class="tabela">
          <thead><tr><th>Funcionário</th><th>Previsto</th><th>Trabalhado</th><th>Saldo anterior</th><th>Créditos</th><th>Débitos</th><th>Comp./ajustes</th><th>Saldo final</th><th>Pendências</th><th>Fechamento</th></tr></thead>
          <tbody>${pn.linhas.map((l) => h`<tr>
            <td><a href="#/marcacoes" data-emp="${l.funcionario.id}">${l.funcionario.nome}</a>${l.funcionario.demo ? h` <span class="badge exemplo">EXEMPLO</span>` : ''}</td>
            <td>${U.dur(l.previstoMin)}</td><td>${U.dur(l.trabalhadoMin)}</td>
            <td>${l.banco ? UI.saldoSpan(l.banco.saldoAnteriorMin) : '—'}</td>
            <td>${l.banco ? U.dur(l.banco.creditosMin) : '—'}</td>
            <td>${l.banco ? U.dur(l.banco.debitosMin) : '—'}</td>
            <td>${l.banco ? UI.saldoSpan(l.banco.compensacoesMin + l.banco.ajustesMin) : '—'}</td>
            <td>${l.banco ? UI.saldoSpan(l.banco.saldoFinalMin) : '—'}</td>
            <td>${l.diasPendentes ? h`<span class="badge alerta">${l.diasPendentes} dia(s)</span>` : h`<span class="badge ok-leve">0</span>`}</td>
            <td>${situacaoFech(l)}</td></tr>`)}</tbody>
        </table></div>

        ${pn.importacoes.length ? h`<h2>Importações recentes</h2><ul class="lista">${pn.importacoes.map((i) => h`<li>${U.fmtDateTimeISO(i.importadoEm)} — ${i.nomeArquivo} (${i.totais.gravadas} marcações)${i.teste ? h` <span class="badge teste">ARQUIVO DE TESTE</span>` : ''}${i.desconsiderada ? h` <span class="badge erro">desconsiderada</span>` : ''}</li>`)}</ul>` : ''}
      `);
      UI.$$('[data-emp]', el).forEach((a) => a.addEventListener('click', () => app.selecionarFuncionario(a.dataset.emp)));
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
