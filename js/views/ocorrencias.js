/* Ocorrências: feriados, folgas, férias, faltas, atestados, abonos e folgas compensatórias. */
(function (root) {
  'use strict';
  const P = root.Ponto; const U = P.util, C = P.calc, UI = P.ui; const h = UI.h;
  P.views = P.views || {};

  const EFEITOS = {
    feriado: 'Dia sem jornada prevista. Trabalho no dia gera crédito e alerta para conferência.',
    folga: 'Folga avulsa: dia sem jornada prevista.',
    ferias: 'Dias sem jornada prevista.',
    folga_compensatoria: 'O dia continua com jornada prevista; o tempo não trabalhado é descontado do banco como COMPENSAÇÃO (não como débito/falta).',
    falta: 'Confirma a ausência: a jornada do dia vira débito.',
    falta_justificada: 'Abona o tempo não trabalhado do dia (saldo zero).',
    atestado: 'Abona o tempo não trabalhado do dia (saldo zero).',
    abono: 'Abona até a quantidade de horas informada.'
  };

  P.views.ocorrencias = {
    titulo: 'Ocorrências e feriados',
    render(el, app) {
      const s = app.store, emp = app.funcionarioSel(), comp = app.state.comp;
      const evs = s.eventos({ comp, employeeId: emp ? emp.id : null, incluirGlobais: true, incluirCancelados: true });
      const nomeEmp = (id) => id === null ? 'Todos (feriado geral)' : (s.funcionario(id) || {}).nome || '?';
      el.innerHTML = String(h`
        <h1>Ocorrências e feriados <small>${U.compLabel(comp)}</small></h1>
        <div class="cartao"><h2>Registrar ocorrência</h2>
          <form id="form-ev" class="grade" novalidate>
            <label>Tipo<select name="tipo">${Object.entries(C.TIPOS_EVENTO).map(([k, v]) => h`<option value="${k}">${v.nome}</option>`)}</select></label>
            <label>Funcionário<select name="emp">
              ${emp ? h`<option value="${emp.id}">${emp.nome}</option>` : ''}
              <option value="">Todos os funcionários (somente feriado)</option></select></label>
            <label>Data inicial<input type="date" name="data" value="${comp}-01"></label>
            <label>Data final <small>(para períodos, ex.: férias)</small><input type="date" name="fim"></label>
            <label class="minutos" hidden>Horas a abonar por dia (hh:mm)<input name="minutos" placeholder="01:00"></label>
            <label class="largo">Descrição / justificativa<input name="desc" placeholder="Ex.: Feriado municipal; atestado médico de 1 dia"></label>
            <p class="ajuda largo" id="efeito"></p>
            <div class="largo"><button type="submit" class="primario">Registrar</button></div>
          </form>
        </div>
        <h2>Ocorrências da competência</h2>
        ${evs.length ? h`<div class="tabela-rolagem"><table class="tabela"><thead><tr><th>Data</th><th>Tipo</th><th>Funcionário</th><th>Descrição</th><th>Registrado em</th><th>Situação</th><th></th></tr></thead>
        <tbody>${evs.map((e) => h`<tr class="${e.cancelado ? 'removida' : ''}"><td>${U.fmtDate(e.data)} ${U.WEEKDAYS_SHORT[U.weekday(e.data)]}</td><td>${C.TIPOS_EVENTO[e.tipo].nome}${e.minutos ? ' (' + U.dur(e.minutos) + ')' : ''}</td><td>${nomeEmp(e.employeeId)}</td><td>${e.descricao}</td><td>${U.fmtDateTimeISO(e.criadoEm)}</td>
          <td>${e.cancelado ? h`<span class="badge neutro" title="${e.cancelado.motivo}">Cancelada em ${U.fmtDateTimeISO(e.cancelado.em)}</span>` : h`<span class="badge ok">Ativa</span>`}</td>
          <td>${!e.cancelado ? h`<button type="button" class="perigo" data-cancelar="${e.id}">Cancelar</button>` : ''}</td></tr>`)}</tbody></table></div>` : UI.vazio('Nenhuma ocorrência nesta competência.')}`);

      const f = UI.$('#form-ev', el);
      const atualizar = () => {
        UI.$('.minutos', f).hidden = !C.TIPOS_EVENTO[f.tipo.value].abonaMinutos;
        UI.$('#efeito', f).textContent = 'Efeito na apuração: ' + EFEITOS[f.tipo.value];
      };
      f.tipo.onchange = atualizar; atualizar();
      f.onsubmit = async (ev) => {
        ev.preventDefault();
        const min = f.minutos.value ? U.parseDuracao(f.minutos.value) : 0;
        if (C.TIPOS_EVENTO[f.tipo.value].abonaMinutos && !(min > 0)) { UI.toast('Informe as horas a abonar (hh:mm).', 'erro'); return; }
        await app.acao(() => s.registrarEvento({ employeeId: f.emp.value || null, tipo: f.tipo.value, data: f.data.value, dataFim: f.fim.value || null, descricao: f.desc.value, minutos: min }), 'Ocorrência registrada.');
      };
      UI.$$('[data-cancelar]', el).forEach((b) => b.onclick = async () => {
        const ok = await UI.justificar('Cancelar ocorrência', 'A ocorrência deixará de valer na apuração, mas continuará no histórico como cancelada.', (t) => s.cancelarEvento(b.dataset.cancelar, t), { perigo: true, botao: 'Cancelar ocorrência' });
        if (ok) { UI.toast('Ocorrência cancelada.'); app.render(); }
      });
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
