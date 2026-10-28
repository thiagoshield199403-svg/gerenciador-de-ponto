/* Cadastro de funcionários e configuração individual de jornada. */
(function (root) {
  'use strict';
  const P = root.Ponto; const U = P.util, C = P.calc, UI = P.ui; const h = UI.h;
  P.views = P.views || {};

  const MAX_PERIODOS = 3;
  const ORDEM_DIAS = [1, 2, 3, 4, 5, 6, 0]; // segunda a domingo

  function lista(el, app) {
    const fs = app.store.funcionarios();
    el.innerHTML = String(h`
      <h1>Funcionários</h1>
      <div class="acoes"><a class="botao primario" href="#/funcionarios/novo">+ Novo funcionário</a></div>
      ${fs.length ? h`<div class="tabela-rolagem"><table class="tabela">
        <thead><tr><th>Nome</th><th>Cargo</th><th>Admissão</th><th>Identificador no relógio</th><th>Jornada semanal prevista</th><th>Situação</th><th></th></tr></thead>
        <tbody>${fs.map((f) => h`<tr class="${f.situacao === 'inativo' ? 'inativo' : ''}">
          <td>${f.nome}${f.demo ? h` <span class="badge exemplo">EXEMPLO</span>` : ''}</td><td>${f.cargo}</td><td>${U.fmtDate(f.admissao)}</td>
          <td>${f.codigoRelogio || h`<span class="mudo">não informado</span>`}</td>
          <td>${U.dur(C.previstoSemanal(f.jornada.semana))}</td>
          <td>${f.situacao === 'ativo' ? h`<span class="badge ok">Ativo</span>` : h`<span class="badge neutro">Inativo</span>`}</td>
          <td><a href="#/funcionarios/${f.id}">Editar</a></td></tr>`)}</tbody></table></div>`
        : UI.vazio('Nenhum funcionário cadastrado.')}`);
  }

  function linhaDia(wd, dia) {
    const periodos = dia.periodos || [];
    return h`<tr data-wd="${wd}">
      <th scope="row">${U.WEEKDAYS[wd]}</th>
      <td class="centro"><input type="checkbox" class="trabalha" ${!dia.folga ? UI.raw('checked') : ''} aria-label="Trabalha em ${U.WEEKDAYS[wd]}"></td>
      ${[0, 1, 2].map((i) => h`<td class="periodo"><input type="time" class="ini" value="${periodos[i] ? periodos[i].ini : ''}" aria-label="Início período ${i + 1}"> – <input type="time" class="fim" value="${periodos[i] ? periodos[i].fim : ''}" aria-label="Fim período ${i + 1}"></td>`)}
      <td class="total"></td><td class="intervalo"></td>
    </tr>`;
  }

  function lerSemana(form) {
    const semana = [];
    UI.$$('tr[data-wd]', form).forEach((tr) => {
      const wd = +tr.dataset.wd;
      const trabalha = UI.$('.trabalha', tr).checked;
      const ps = [];
      UI.$$('.periodo', tr).forEach((td) => {
        const ini = UI.$('.ini', td).value, fim = UI.$('.fim', td).value;
        if (ini || fim) ps.push({ ini, fim });
      });
      semana[wd] = { folga: !trabalha, periodos: trabalha ? ps : [] };
    });
    return semana;
  }

  function atualizarTotais(form) {
    const semana = lerSemana(form);
    UI.$$('tr[data-wd]', form).forEach((tr) => {
      const d = semana[+tr.dataset.wd];
      const { total, abs } = C.previstoPeriodos(d.periodos);
      let inter = 0;
      for (let i = 1; i < abs.length; i++) inter += abs[i].ini - abs[i - 1].fim;
      UI.$('.total', tr).textContent = d.folga ? 'Folga' : U.dur(total);
      UI.$('.intervalo', tr).textContent = d.folga || abs.length < 2 ? '—' : U.dur(inter);
      tr.classList.toggle('folga', d.folga);
      UI.$$('input[type=time]', tr).forEach((i) => { i.disabled = d.folga; });
    });
    UI.$('#total-semanal', form).textContent = U.dur(C.previstoSemanal(semana));
  }

  function formulario(el, app, id) {
    const s = app.store;
    const novo = id === 'novo';
    const f = novo ? {
      nome: '', cpf: '', cargo: '', admissao: '', desligamento: '', salario: null, codigoRelogio: '', regime: '', cargaSemanalMin: null,
      situacao: 'ativo', observacoes: '', jornada: { semana: C.semanaExemplo(), regras: Object.assign({}, C.REGRAS_PADRAO) }, banco: { compInicial: '', saldoInicialMin: 0 }
    } : s.funcionario(id);
    if (!f) { el.innerHTML = String(UI.vazio('Funcionário não encontrado.', h`<a href="#/funcionarios">Voltar</a>`)); return; }
    const rg = Object.assign({}, C.REGRAS_PADRAO, f.jornada.regras || {});
    const temFechada = !novo && s.all('fechamentos').some((x) => x.employeeId === f.id && x.status === 'fechada');

    el.innerHTML = String(h`
      <h1>${novo ? 'Novo funcionário' : 'Editar: ' + f.nome}</h1>
      ${f.demo ? h`<div class="faixa exemplo">Registro de EXEMPLO com dados fictícios.</div>` : ''}
      ${f.situacao === 'inativo' ? h`<div class="faixa alerta">Funcionário inativo desde ${U.fmtDateTimeISO(f.inativadoEm)}. Motivo: ${f.motivoInativacao || '—'}</div>` : ''}
      <form id="form-func" class="formulario" novalidate>
        <fieldset><legend>Dados do funcionário</legend>
          <div class="grade">
            <label class="largo">Nome completo *<input name="nome" required value="${f.nome}" autocomplete="off"></label>
            <label>CPF <small>(quando necessário)</small><input name="cpf" value="${U.fmtCPF(f.cpf)}" inputmode="numeric" autocomplete="off" placeholder="000.000.000-00"></label>
            <label>Cargo<input name="cargo" value="${f.cargo}"></label>
            <label>Data de admissão *<input type="date" name="admissao" required value="${f.admissao}"></label>
            <label>Data de desligamento<input type="date" name="desligamento" value="${f.desligamento || ''}"></label>
            <label>Salário mensal <small>(opcional)</small><input type="number" name="salario" min="0" step="0.01" value="${f.salario === null || f.salario === undefined ? '' : f.salario}"></label>
            <label>Identificador no relógio <small>(código/matrícula usado no equipamento)</small><input name="codigoRelogio" value="${f.codigoRelogio}" autocomplete="off"></label>
            <label>Regime de jornada<input name="regime" value="${f.regime || ''}" placeholder="Ex.: CLT — 44h semanais, escala 5x2" list="regimes"></label>
            <datalist id="regimes"><option value="CLT — jornada semanal"><option value="CLT — escala 5x2"><option value="CLT — escala 6x1"><option value="CLT — escala 12x36"><option value="CLT — tempo parcial"></datalist>
            <label>Jornada contratual semanal <small>(conforme contrato, hh:mm)</small><input name="cargaSemanal" value="${f.cargaSemanalMin ? U.dur(f.cargaSemanalMin) : ''}" placeholder="44:00"></label>
          </div>
        </fieldset>

        <fieldset><legend>Jornada prevista por dia da semana</legend>
          <p class="ajuda">Informe os períodos de trabalho de cada dia. O intervalo é o tempo entre um período e o seguinte. Dias desmarcados são folga semanal. Períodos que terminam após a meia-noite (ex.: 22:00 – 02:00) são aceitos. <b>A jornada de exemplo não representa configuração legalmente validada</b>; ajuste conforme o contrato e a legislação/convenção aplicável.</p>
          <div class="padrao">
            <span>Preencher rapidamente:</span>
            <label>Entrada<input type="time" id="p-ent" value="09:00"></label>
            <label>Saída intervalo<input type="time" id="p-sai1" value="12:00"></label>
            <label>Retorno<input type="time" id="p-ret" value="14:00"></label>
            <label>Saída<input type="time" id="p-sai2" value="19:00"></label>
            <span class="dias-padrao">${ORDEM_DIAS.map((wd) => h`<label class="chk"><input type="checkbox" value="${wd}" ${wd >= 1 && wd <= 5 ? UI.raw('checked') : ''}>${U.WEEKDAYS_SHORT[wd]}</label>`)}</span>
            <button type="button" id="aplicar-padrao">Aplicar aos dias marcados</button>
          </div>
          <div class="tabela-rolagem"><table class="tabela jornada">
            <thead><tr><th>Dia</th><th>Trabalha</th><th>1º período</th><th>2º período</th><th>3º período</th><th>Previsto</th><th>Intervalo</th></tr></thead>
            <tbody>${ORDEM_DIAS.map((wd) => linhaDia(wd, f.jornada.semana[wd]))}</tbody>
            <tfoot><tr><th colspan="5">Total semanal previsto</th><th id="total-semanal"></th><th></th></tr></tfoot>
          </table></div>
        </fieldset>

        <fieldset><legend>Regras de apuração</legend>
          <p class="ajuda">Valores em minutos. A tolerância diária padrão (10 min) segue a referência do art. 58, §1º da CLT, mas deve ser validada para o seu caso; use 0 para não aplicar tolerância.</p>
          <div class="grade">
            <label>Tolerância diária (min)<input type="number" min="0" name="toleranciaDiariaMin" value="${rg.toleranciaDiariaMin}"></label>
            <label>Janela de duplicidade (min)<input type="number" min="0" name="janelaDuplicidadeMin" value="${rg.janelaDuplicidadeMin}"></label>
            <label>Intervalo mínimo para alerta (min)<input type="number" min="0" name="intervaloMinimoMin" value="${rg.intervaloMinimoMin}"></label>
            <label>Alerta de batida fora da jornada (min)<input type="number" min="0" name="limiteForaJornadaMin" value="${rg.limiteForaJornadaMin}"></label>
            <label>Alerta de jornada diária acima de (min)<input type="number" min="0" name="jornadaMaximaMin" value="${rg.jornadaMaximaMin}"></label>
            <label>Hora de corte para jornada noturna <small>(vazio = automático)</small><input type="time" name="horaCorteVirada" value="${rg.horaCorteVirada || ''}"></label>
          </div>
        </fieldset>

        <fieldset><legend>Banco de horas — implantação</legend>
          <p class="ajuda">Se a funcionária já possui saldo de banco de horas de um controle anterior, informe-o como saldo anterior da competência inicial. Sem competência inicial, o banco começa no mês da admissão.${temFechada ? ' Bloqueado: existem competências fechadas.' : ''}</p>
          <div class="grade">
            <label>Competência inicial do banco<input type="month" name="compInicial" value="${f.banco.compInicial || ''}" ${temFechada ? UI.raw('disabled') : ''}></label>
            <label>Saldo anterior inicial (±hh:mm)<input name="saldoInicial" value="${U.saldo(f.banco.saldoInicialMin || 0)}" ${temFechada ? UI.raw('disabled') : ''}></label>
          </div>
        </fieldset>

        <fieldset><legend>Observações</legend>
          <textarea name="observacoes" rows="2">${f.observacoes || ''}</textarea>
        </fieldset>

        <p class="erro-form" id="erros" hidden></p>
        <div class="acoes">
          <button type="submit" class="primario">Salvar</button>
          <a class="botao" href="#/funcionarios">Cancelar</a>
          ${!novo && f.situacao === 'ativo' ? h`<button type="button" id="inativar" class="perigo">Inativar funcionário</button>` : ''}
          ${!novo && f.situacao === 'inativo' ? h`<button type="button" id="reativar">Reativar funcionário</button>` : ''}
        </div>
      </form>`);

    const form = UI.$('#form-func', el);
    form.addEventListener('input', () => atualizarTotais(form));
    form.addEventListener('change', () => atualizarTotais(form));
    atualizarTotais(form);

    UI.$('#aplicar-padrao', form).onclick = () => {
      const ent = UI.$('#p-ent', form).value, s1 = UI.$('#p-sai1', form).value, ret = UI.$('#p-ret', form).value, s2 = UI.$('#p-sai2', form).value;
      if (!ent || !s2) { UI.toast('Informe ao menos a entrada e a saída.', 'erro'); return; }
      const periodos = (s1 && ret) ? [[ent, s1], [ret, s2]] : [[ent, s2]];
      UI.$$('.dias-padrao input:checked', form).forEach((chk) => {
        const tr = UI.$('tr[data-wd="' + chk.value + '"]', form);
        UI.$('.trabalha', tr).checked = true;
        UI.$$('.periodo', tr).forEach((td, i) => {
          UI.$('.ini', td).value = periodos[i] ? periodos[i][0] : '';
          UI.$('.fim', td).value = periodos[i] ? periodos[i][1] : '';
        });
      });
      atualizarTotais(form);
    };

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const errEl = UI.$('#erros', form);
      errEl.hidden = true;
      const fd = new FormData(form);
      const num = (k) => { const v = fd.get(k); return v === '' || v === null ? undefined : Number(v); };
      const carga = (fd.get('cargaSemanal') || '').trim();
      const cargaMin = carga ? U.parseDuracao(carga) : null;
      const saldoIni = temFechada ? f.banco.saldoInicialMin : U.parseDuracao((fd.get('saldoInicial') || '00:00').trim() || '00:00');
      const problemas = [];
      if (carga && (cargaMin === null || cargaMin <= 0)) problemas.push('Jornada contratual semanal inválida (use hh:mm).');
      if (saldoIni === null) problemas.push('Saldo inicial do banco inválido (use +hh:mm ou -hh:mm).');
      if (problemas.length) { errEl.hidden = false; errEl.textContent = problemas.join('\n'); return; }
      const dados = Object.assign({}, novo ? {} : f, {
        nome: fd.get('nome'), cpf: fd.get('cpf'), cargo: (fd.get('cargo') || '').trim(), admissao: fd.get('admissao'),
        desligamento: fd.get('desligamento') || '', salario: fd.get('salario'), codigoRelogio: fd.get('codigoRelogio'),
        regime: (fd.get('regime') || '').trim(), cargaSemanalMin: cargaMin, observacoes: (fd.get('observacoes') || '').trim(),
        jornada: {
          semana: lerSemana(form),
          regras: {
            toleranciaDiariaMin: num('toleranciaDiariaMin'), janelaDuplicidadeMin: num('janelaDuplicidadeMin'), intervaloMinimoMin: num('intervaloMinimoMin'),
            limiteForaJornadaMin: num('limiteForaJornadaMin'), jornadaMaximaMin: num('jornadaMaximaMin'), horaCorteVirada: fd.get('horaCorteVirada') || ''
          }
        },
        banco: temFechada ? f.banco : { compInicial: fd.get('compInicial') || '', saldoInicialMin: saldoIni }
      });
      Object.keys(dados.jornada.regras).forEach((k) => { if (dados.jornada.regras[k] === undefined) delete dados.jornada.regras[k]; });
      try {
        const salvo = await app.store.salvarFuncionario(dados);
        app.selecionarFuncionario(salvo.id);
        UI.toast('Cadastro salvo.');
        app.ir('funcionarios');
      } catch (e) {
        if (e.name === 'ErroRegra') { errEl.hidden = false; errEl.textContent = e.message; errEl.scrollIntoView({ block: 'center' }); }
        else UI.erro(e);
      }
    });

    const btIn = UI.$('#inativar', form);
    if (btIn) btIn.onclick = async () => {
      const r = await UI.modal({
        titulo: 'Inativar ' + f.nome,
        corpo: h`<p>O funcionário deixa de aparecer como ativo, mas todo o histórico é mantido.</p>
          <label>Data de desligamento (opcional)<input type="date" name="deslig"></label>
          <label>Motivo (obrigatório)<textarea name="motivo" rows="2"></textarea></label>`,
        botoes: [{ texto: 'Cancelar', valor: false }, { texto: 'Inativar', valor: true, classe: 'perigo' }],
        validar: (v, fm) => app.store.inativarFuncionario(f.id, fm.motivo.value, fm.deslig.value || null)
      });
      if (r) { UI.toast('Funcionário inativado.'); app.render(); }
    };
    const btRe = UI.$('#reativar', form);
    if (btRe) btRe.onclick = async () => {
      const ok = await UI.justificar('Reativar ' + f.nome, 'O funcionário voltará a aparecer como ativo.', (t) => app.store.reativarFuncionario(f.id, t));
      if (ok) { UI.toast('Funcionário reativado.'); app.render(); }
    };
  }

  P.views.funcionarios = {
    titulo: 'Funcionários',
    render(el, app) {
      if (app.state.param) formulario(el, app, app.state.param);
      else lista(el, app);
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
