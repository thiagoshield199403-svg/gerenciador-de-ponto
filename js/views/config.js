/* Configurações: empregador, política do banco de horas, perfis de importação, dados de exemplo e auditoria. */
(function (root) {
  'use strict';
  const P = root.Ponto; const U = P.util, UI = P.ui; const h = UI.h;
  P.views = P.views || {};

  P.views.config = {
    titulo: 'Configurações',
    render(el, app) {
      const s = app.store, e = s.empregador(), pol = s.politica();
      const aud = s.auditoria().slice(0, 100);
      el.innerHTML = String(h`
        <h1>Configurações</h1>
        <div class="cartao"><h2>Dados do empregador <small>(aparecem nos relatórios)</small></h2>
          <form id="form-emp" class="grade" novalidate>
            <label class="largo">Razão social / nome<input name="nome" value="${e.nome}"></label>
            <label>CNPJ ou CPF<input name="documento" value="${e.documento}"></label>
            <label>Responsável<input name="responsavel" value="${e.responsavel}"></label>
            <label class="largo">Endereço<input name="endereco" value="${e.endereco}"></label>
            <div class="largo"><button type="submit" class="primario">Salvar dados do empregador</button></div>
          </form></div>

        <div class="cartao"><h2>Política do banco de horas</h2>
          <p class="ajuda">Defina como créditos e débitos diários são tratados. Essas escolhas devem refletir o contrato, o acordo individual ou coletivo e a legislação aplicável (por exemplo, prazos de compensação do art. 59 da CLT); o sistema não valida a legalidade da política. Alterações valem para competências abertas; as fechadas mantêm a política vigente no fechamento.</p>
          <form id="form-pol" class="grade" novalidate>
            <label class="chk largo"><input type="checkbox" name="creditos" ${pol.creditosNoBanco ? UI.raw('checked') : ''}> Créditos diários (horas excedentes) entram no banco de horas</label>
            <label class="chk largo"><input type="checkbox" name="debitos" ${pol.debitosNoBanco ? UI.raw('checked') : ''}> Débitos diários (horas não cumpridas) são descontados do banco de horas</label>
            <label>Alertar se o saldo passar de (+hh:mm, vazio = sem limite)<input name="limPos" value="${pol.limitePositivoMin != null ? U.dur(pol.limitePositivoMin) : ''}"></label>
            <label>Alertar se o saldo ficar abaixo de (−hh:mm, vazio = sem limite)<input name="limNeg" value="${pol.limiteNegativoMin != null ? U.dur(pol.limiteNegativoMin) : ''}"></label>
            <label class="largo">Observação sobre a política (ex.: referência do acordo)<input name="obs" value="${pol.observacao}"></label>
            <div class="largo"><button type="submit" class="primario">Salvar política</button></div>
          </form></div>

        <div class="cartao"><h2>Perfis de importação</h2>
          ${s.perfisImportacao().length ? h`<ul class="lista">${s.perfisImportacao().map((p) => h`<li><b>${p.nome}</b> — salvo em ${U.fmtDateTimeISO(p.salvoEm)}</li>`)}</ul>` : h`<p class="mudo">Nenhum perfil salvo. Crie um na tela “Importar ponto” depois de conferir as colunas do arquivo do relógio.</p>`}
        </div>

        <div class="cartao"><h2>Dados de demonstração</h2>
          ${s.temDemo()
            ? h`<p>Existe uma funcionária de EXEMPLO com marcações fictícias. Remova-a antes de começar o uso real; os dados reais não são afetados.</p><button type="button" class="perigo" id="rem-demo">Remover dados de exemplo</button>`
            : h`<p>Crie uma funcionária fictícia, claramente identificada como EXEMPLO, com marcações do mês anterior, para conhecer o sistema.</p><button type="button" id="criar-demo">Carregar funcionária de exemplo</button>`}
        </div>

        <div class="cartao"><h2>Histórico de alterações (últimas 100)</h2>
          <div class="tabela-rolagem curta"><table class="tabela"><thead><tr><th>Data</th><th>Funcionário</th><th>Descrição</th></tr></thead>
          <tbody>${aud.map((a) => h`<tr><td class="nowrap">${U.fmtDateTimeISO(a.em)}</td><td>${a.employeeId ? ((s.funcionario(a.employeeId) || {}).nome || '(removido)') : '—'}</td><td>${a.descricao}</td></tr>`)}</tbody></table></div>
        </div>`);

      const fe = UI.$('#form-emp', el);
      fe.onsubmit = (ev) => { ev.preventDefault(); app.acao(() => s.salvarEmpregador({ nome: fe.nome.value, documento: fe.documento.value, endereco: fe.endereco.value, responsavel: fe.responsavel.value }), 'Dados do empregador salvos.'); };
      const fp = UI.$('#form-pol', el);
      fp.onsubmit = (ev) => {
        ev.preventDefault();
        const lim = (v) => { v = v.trim(); if (!v) return null; const m = U.parseDuracao(v.replace(/^[+-]/, '')); return m === null ? NaN : Math.abs(m); };
        const lp = lim(fp.limPos.value), ln = lim(fp.limNeg.value);
        if (Number.isNaN(lp) || Number.isNaN(ln)) { UI.toast('Limite inválido: use hh:mm.', 'erro'); return; }
        app.acao(() => s.salvarPolitica({ creditosNoBanco: fp.creditos.checked, debitosNoBanco: fp.debitos.checked, limitePositivoMin: lp, limiteNegativoMin: ln, observacao: fp.obs.value.trim() }), 'Política salva.');
      };
      const cd = UI.$('#criar-demo', el);
      if (cd) cd.onclick = () => app.acao(async () => { const f = await s.criarDemo(); app.selecionarFuncionario(f.id); }, 'Funcionária de exemplo criada.');
      const rd = UI.$('#rem-demo', el);
      if (rd) rd.onclick = async () => {
        if (await UI.confirmar('Remover dados de exemplo', 'A funcionária de EXEMPLO e todos os registros fictícios ligados a ela serão apagados. Dados reais não são afetados.', { perigo: true, botao: 'Remover' })) {
          app.acao(() => s.removerDemo(), 'Dados de exemplo removidos.');
        }
      };
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
