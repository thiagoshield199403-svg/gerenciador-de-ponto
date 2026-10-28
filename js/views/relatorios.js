/* Relatórios para impressão em A4 (ou "Salvar como PDF" pelo navegador). */
(function (root) {
  'use strict';
  const P = root.Ponto; const U = P.util, C = P.calc, UI = P.ui; const h = UI.h;
  P.views = P.views || {};

  const TIPOS = {
    espelho: 'Espelho mensal',
    extrato: 'Extrato do banco de horas',
    ocorrencias: 'Resumo de ocorrências',
    ajustes: 'Histórico de ajustes',
    contabilidade: 'Resumo para contabilidade'
  };

  const AVISO = 'Documento gerado por sistema de controle interno, para conferência entre as partes. Não é certificado nem homologado e não substitui, por si só, as exigências legais aplicáveis a cada modalidade de registro eletrônico de ponto (ex.: Portaria MTP nº 671/2021).';

  function cabecalho(app, titulo, emp, comp, fechada) {
    const e = app.store.empregador();
    return h`<header class="rel-cab">
      <div class="rel-empregador"><b>${e.nome || 'Empregador não cadastrado (Configurações)'}</b>${e.documento ? h`<br>CNPJ/CPF: ${e.documento}` : ''}${e.endereco ? h`<br>${e.endereco}` : ''}</div>
      <div class="rel-titulo"><h1>${titulo}</h1><div>Competência: <b>${U.compLabel(comp)}</b> (${U.fmtDate(comp + '-01')} a ${U.fmtDate(U.compLastDay(comp))})</div>
        <div>Situação: <b>${fechada ? 'FECHADA' : 'ABERTA — valores sujeitos a alteração'}</b> · Emitido em ${U.fmtDateTimeISO(U.nowISO())}</div></div>
    </header>
    ${emp ? h`<section class="rel-func">
      <div><span>Funcionário</span><b>${emp.nome}</b>${emp.demo ? ' (EXEMPLO — dados fictícios)' : ''}</div>
      <div><span>CPF</span>${emp.cpf ? U.fmtCPF(emp.cpf) : '—'}</div>
      <div><span>Cargo</span>${emp.cargo || '—'}</div>
      <div><span>Admissão</span>${U.fmtDate(emp.admissao)}</div>
      <div><span>Identificador</span>${emp.codigoRelogio || '—'}</div>
      <div><span>Regime</span>${emp.regime || '—'}</div>
      <div class="largo"><span>Jornada prevista</span>${[1, 2, 3, 4, 5, 6, 0].map((wd) => { const d = emp.jornada.semana[wd]; return U.WEEKDAYS_SHORT[wd] + ': ' + (d.folga ? 'folga' : d.periodos.map((p) => p.ini + '–' + p.fim).join(' / ')); }).join(' · ')}</div>
    </section>` : ''}`;
  }

  function assinaturas(emp) {
    return h`<section class="rel-assinaturas">
      <div><span></span>${emp ? emp.nome : 'Funcionário'}<br><small>Funcionário(a) — declaro que conferi as marcações</small></div>
      <div><span></span>Empregador / responsável</div>
    </section>`;
  }

  function rodape() { return h`<footer class="rel-rodape">${AVISO}</footer>`; }

  function espelho(app, emp, comp) {
    const cp = app.store.competencia(emp.id, comp);
    const t = cp.apuracao.totais, b = cp.banco;
    return h`${cabecalho(app, 'Espelho de ponto mensal', emp, comp, cp.fechada)}
      <table class="rel-tabela espelho">
        <thead><tr><th>Data</th><th>Jornada prevista</th><th>Marcações originais</th><th>Marcações consideradas</th><th>Trab.</th><th>Interv.</th><th>Saldo</th><th>Ocorrências</th></tr></thead>
        <tbody>${cp.apuracao.dias.map((d) => {
          const originais = d.marcacoes.concat(d.removidas || []).filter((m) => m.ref.startsWith('p:')).map((m) => m.original || m.dt).sort();
          const consid = d.marcacoes.map((m) => U.dtTime(m.dt) + (m.origem === 'manual' ? 'ᴹ' : '') + (m.ajustada ? '*' : '') + (m.duplicada ? 'ᴰ' : ''));
          const oc = d.eventos.map((e) => C.TIPOS_EVENTO[e.tipo].nome).concat(d.ocorrencias.filter((o) => o.nivel !== 'info' || o.codigo === 'FALTA').map((o) => ({ DUPLICADA: 'Duplicidade', IMPAR: 'Marcação faltando', SEM_MARCACAO: 'Sem marcações', FORA_JORNADA: 'Fora da jornada', TRABALHO_SEM_JORNADA: 'Trabalho s/ jornada', INTERVALO_CURTO: 'Intervalo curto', SEM_INTERVALO: 'Sem intervalo', JORNADA_EXCESSIVA: 'Jornada excessiva', FALTA: 'Falta', FALTA_COM_MARCACAO: 'Falta c/ marcação', FORA_CONTRATO: 'Fora do contrato' }[o.codigo] || o.codigo)));
          if (d.atrasoMin) oc.push('Atraso ' + U.dur(d.atrasoMin));
          if (d.saidaAntecipadaMin) oc.push('Saída antec. ' + U.dur(d.saidaAntecipadaMin));
          if (d.abonoMin) oc.push('Abono ' + U.dur(d.abonoMin));
          if (d.ocorrencias.some((o) => o.codigo === 'TOLERANCIA')) oc.push('Dif. ' + U.saldo(d.diferencaBrutaMin) + ' na tolerância');
          if (d.conferido) oc.push('Conferido');
          if (d.obs) oc.push('Obs.: ' + d.obs);
          return h`<tr class="${d.diaSemana === 0 || d.diaSemana === 6 ? 'fds' : ''}">
            <td class="nowrap">${U.fmtDate(d.data).slice(0, 5)} ${U.WEEKDAYS_SHORT[d.diaSemana]}</td>
            <td>${d.foraContrato ? '—' : d.periodosPrevistos.length ? d.periodosPrevistos.map((p) => p.ini + '–' + p.fim).join(' ') : ({ folga: 'Folga', feriado: 'Feriado', ferias: 'Férias' }[d.tipoDia] || '—')}</td>
            <td>${originais.map((x) => U.dtTime(x)).join(' ')}</td>
            <td>${consid.join(' ')}</td>
            <td>${d.marcacoes.length ? U.dur(d.trabalhadoMin) : ''}</td>
            <td>${d.intervaloMin ? U.dur(d.intervaloMin) : ''}</td>
            <td class="nowrap">${d.saldoMin === null ? (d.futuro ? '' : 'pend.') : (d.saldoMin || d.previstoMin || d.marcacoes.length) ? U.saldo(d.saldoMin) : ''}</td>
            <td class="oc">${oc.join('; ')}</td></tr>`;
        })}</tbody>
      </table>
      <p class="rel-legenda">Legenda: ᴹ marcação incluída manualmente · * horário corrigido (o original aparece em “Marcações originais”) · ᴰ possível duplicidade, desconsiderada no cálculo · “pend.” dia com pendência, não apurado.</p>
      <section class="rel-totais">
        <h2>Totais do mês</h2>
        <table class="rel-tabela compacta"><tbody>
          <tr><th>Horas previstas</th><td>${U.dur(t.previstoMin)}</td><th>Horas trabalhadas</th><td>${U.dur(t.trabalhadoMin)}</td></tr>
          <tr><th>Atrasos (soma)</th><td>${U.dur(t.atrasosMin)}</td><th>Saídas antecipadas (soma)</th><td>${U.dur(t.saidasAntecipadasMin)}</td></tr>
          <tr><th>Faltas registradas</th><td>${t.faltas} dia(s)</td><th>Abonos</th><td>${U.dur(t.abonosMin)}</td></tr>
          <tr><th>Dias pendentes / não apurados</th><td>${t.diasPendentes} / ${t.diasNaoApurados}</td><th></th><td></td></tr>
        </tbody></table>
        <h2>Banco de horas</h2>
        ${b ? h`<table class="rel-tabela compacta"><tbody>
          <tr><th>Saldo anterior</th><td>${U.saldo(b.saldoAnteriorMin)}</td><th>Créditos do mês</th><td>${U.saldo(b.creditosMin)}</td></tr>
          <tr><th>Débitos do mês</th><td>${U.saldo(-b.debitosMin)}</td><th>Compensações</th><td>${U.saldo(b.compensacoesMin)}</td></tr>
          <tr><th>Ajustes</th><td>${U.saldo(b.ajustesMin)}</td><th>Saldo final acumulado</th><td><b>${U.saldo(b.saldoFinalMin)}</b></td></tr>
        </tbody></table>` : h`<p>Competência anterior ao início do banco de horas.</p>`}
      </section>
      ${assinaturas(emp)}${rodape()}`;
  }

  function extrato(app, emp, comp) {
    const ex = app.store.extrato(emp.id, comp);
    const cp = app.store.competencia(emp.id, comp);
    const lancs = app.store.lancamentos(emp.id, null, true).filter((l) => l.data <= U.compLastDay(comp));
    return h`${cabecalho(app, 'Extrato do banco de horas', emp, comp, cp.fechada)}
      <table class="rel-tabela"><thead><tr><th>Competência</th><th>Saldo anterior</th><th>Créditos</th><th>Débitos</th><th>Compensações</th><th>Ajustes</th><th>Saldo final</th><th>Situação</th></tr></thead>
      <tbody>${ex.map((l) => h`<tr><td>${U.compLabel(l.comp)}</td><td>${U.saldo(l.saldoAnteriorMin)}</td><td>${U.dur(l.creditosMin)}</td><td>${U.dur(l.debitosMin)}</td><td>${U.saldo(l.compensacoesMin)}</td><td>${U.saldo(l.ajustesMin)}</td><td><b>${U.saldo(l.saldoFinalMin)}</b></td><td>${l.fechada ? 'Fechada' : 'Aberta'}${l.provisoria ? ' (provisória)' : ''}</td></tr>`)}</tbody></table>
      <h2>Compensações e ajustes lançados</h2>
      ${lancs.length ? h`<table class="rel-tabela"><thead><tr><th>Data</th><th>Tipo</th><th>Horas</th><th>Justificativa</th><th>Lançado em</th><th>Situação</th></tr></thead>
        <tbody>${lancs.map((l) => h`<tr><td>${U.fmtDate(l.data)}</td><td>${l.tipo === 'ajuste' ? 'Ajuste' : 'Compensação'}</td><td>${U.saldo(l.minutos)}</td><td>${l.justificativa}</td><td>${U.fmtDateTimeISO(l.criadoEm)}</td><td>${l.cancelado ? 'Cancelado: ' + l.cancelado.motivo : 'Válido'}</td></tr>`)}</tbody></table>` : h`<p>Nenhum lançamento.</p>`}
      <h2>Movimentação diária de ${U.compLabel(comp)}</h2>
      <table class="rel-tabela compacta"><thead><tr><th>Data</th><th>Crédito</th><th>Débito</th><th>Compensação</th></tr></thead>
        <tbody>${cp.apuracao.dias.filter((d) => d.saldoMin !== null && (d.creditoMin || d.debitoMin || d.compensacaoMin)).map((d) => h`<tr><td>${U.fmtDate(d.data)}</td><td>${d.creditoMin ? U.dur(d.creditoMin) : ''}</td><td>${d.debitoMin ? U.dur(d.debitoMin) : ''}</td><td>${d.compensacaoMin ? U.dur(d.compensacaoMin) : ''}</td></tr>`)}</tbody></table>
      ${assinaturas(emp)}${rodape()}`;
  }

  function ocorrencias(app, emp, comp) {
    const cp = app.store.competencia(emp.id, comp);
    const dias = cp.apuracao.dias.filter((d) => d.eventos.length || d.ocorrencias.some((o) => o.nivel !== 'info' || o.codigo === 'FALTA') || d.atrasoMin || d.saidaAntecipadaMin);
    const t = cp.apuracao.totais;
    return h`${cabecalho(app, 'Resumo de ocorrências', emp, comp, cp.fechada)}
      <table class="rel-tabela compacta"><tbody>
        <tr><th>Faltas</th><td>${t.faltas}</td><th>Atrasos (soma)</th><td>${U.dur(t.atrasosMin)}</td><th>Saídas antecipadas</th><td>${U.dur(t.saidasAntecipadasMin)}</td></tr>
        <tr><th>Abonos</th><td>${U.dur(t.abonosMin)}</td><th>Dias pendentes</th><td>${t.diasPendentes}</td><th>Dias inconsistentes</th><td>${t.diasInconsistentes}</td></tr>
      </tbody></table>
      <table class="rel-tabela"><thead><tr><th>Data</th><th>Registros</th><th>Atraso</th><th>Saída antec.</th><th>Detalhes</th><th>Situação</th></tr></thead>
      <tbody>${dias.length ? dias.map((d) => h`<tr><td class="nowrap">${U.fmtDate(d.data)} ${U.WEEKDAYS_SHORT[d.diaSemana]}</td>
        <td>${d.eventos.map((e) => C.TIPOS_EVENTO[e.tipo].nome + (e.descricao ? ' — ' + e.descricao : '')).join('; ')}</td>
        <td>${d.atrasoMin ? U.dur(d.atrasoMin) : ''}</td><td>${d.saidaAntecipadaMin ? U.dur(d.saidaAntecipadaMin) : ''}</td>
        <td>${d.ocorrencias.filter((o) => o.nivel !== 'info' || o.codigo === 'FALTA').map((o) => o.texto).join(' ')}</td><td>${d.situacao}</td></tr>`) : h`<tr><td colspan="6">Sem ocorrências.</td></tr>`}</tbody></table>
      ${rodape()}`;
  }

  function ajustes(app, emp, comp) {
    const s = app.store;
    const cp = s.competencia(emp.id, comp);
    const nomes = { inclusao: 'Inclusão manual', alteracao: 'Correção de horário', desconsiderar: 'Exclusão (desconsiderada)', restaurar: 'Restauração' };
    const ajs = s.all('ajustes').filter((a) => a.employeeId === emp.id && U.compOf(a.dataRef) === comp).sort((a, b) => U.cmp(a.criadoEm, b.criadoEm));
    const dtFmt = (dt) => dt ? U.fmtDate(U.dtDate(dt)) + ' ' + U.dtTime(dt) : '—';
    const aud = s.auditoria({ employeeId: emp.id, comp }).filter((a) => !/^marcacao-/.test(a.acao));
    const f = cp.fechamento;
    return h`${cabecalho(app, 'Histórico de ajustes', emp, comp, cp.fechada)}
      <h2>Correções de marcações</h2>
      <table class="rel-tabela"><thead><tr><th>Lançado em</th><th>Dia de referência</th><th>Ação</th><th>Horário anterior</th><th>Novo horário</th><th>Justificativa</th></tr></thead>
      <tbody>${ajs.length ? ajs.map((a) => h`<tr><td>${U.fmtDateTimeISO(a.criadoEm)}</td><td>${U.fmtDate(a.dataRef)}</td><td>${nomes[a.tipo]}</td><td>${dtFmt(a.dtAnterior)}</td><td>${a.tipo === 'inclusao' || a.tipo === 'alteracao' ? dtFmt(a.dt) : '—'}</td><td>${a.justificativa}</td></tr>`) : h`<tr><td colspan="6">Nenhuma correção nesta competência.</td></tr>`}</tbody></table>
      <h2>Outras alterações registradas</h2>
      <table class="rel-tabela"><thead><tr><th>Data</th><th>Descrição</th></tr></thead>
      <tbody>${aud.length ? aud.map((a) => h`<tr><td class="nowrap">${U.fmtDateTimeISO(a.em)}</td><td>${a.descricao}</td></tr>`) : h`<tr><td colspan="2">Nenhuma.</td></tr>`}</tbody></table>
      ${f ? h`<h2>Fechamentos e reaberturas</h2><table class="rel-tabela"><tbody>${f.historico.map((x) => h`<tr><td class="nowrap">${U.fmtDateTimeISO(x.em)}</td><td>${{ fechamento: 'Fechamento', reabertura: 'Reabertura', 'recalculo-saldo': 'Recálculo do saldo' }[x.acao]}</td><td>${x.justificativa || x.observacao || x.motivo || ''}</td></tr>`)}</tbody></table>` : ''}
      ${rodape()}`;
  }

  function contabilidade(app, comp) {
    const s = app.store;
    const fs = s.funcionarios().filter((f) => f.situacao === 'ativo' || (f.desligamento && f.desligamento >= comp + '-01'));
    const linhas = fs.map((f) => ({ f, cp: s.competencia(f.id, comp) }));
    return h`${cabecalho(app, 'Resumo para contabilidade', null, comp, linhas.length > 0 && linhas.every((l) => l.cp.fechada))}
      <table class="rel-tabela"><thead><tr><th>Funcionário</th><th>CPF</th><th>Cargo</th><th>Previsto</th><th>Trabalhado</th><th>Horas excedentes</th><th>Horas não cumpridas</th><th>Faltas</th><th>Abonos</th><th>Banco: anterior</th><th>Banco: final</th><th>Fechamento</th></tr></thead>
      <tbody>${linhas.map(({ f, cp }) => { const t = cp.apuracao.totais, b = cp.banco; return h`<tr><td>${f.nome}${f.demo ? ' (EXEMPLO)' : ''}</td><td>${f.cpf ? U.fmtCPF(f.cpf) : '—'}</td><td>${f.cargo}</td><td>${U.dur(t.previstoMin)}</td><td>${U.dur(t.trabalhadoMin)}</td><td>${U.dur(t.creditosMin)}</td><td>${U.dur(t.debitosMin)}</td><td>${t.faltas}</td><td>${U.dur(t.abonosMin)}</td><td>${b ? U.saldo(b.saldoAnteriorMin) : '—'}</td><td>${b ? U.saldo(b.saldoFinalMin) : '—'}</td><td>${cp.fechada ? 'Fechada' : 'ABERTA'}</td></tr>`; })}</tbody></table>
      <p class="rel-legenda">“Horas excedentes” e “horas não cumpridas” são resultados da apuração conforme as regras configuradas. A classificação como hora extra a pagar, compensação em banco de horas ou desconto depende do contrato, do acordo/convenção coletiva e da legislação, e deve ser validada pela contabilidade.</p>
      ${rodape()}`;
  }

  P.views.relatorios = {
    titulo: 'Relatórios',
    tipo: 'espelho',
    render(el, app) {
      const emp = app.funcionarioSel(), comp = app.state.comp;
      const tipo = this.tipo;
      let conteudo;
      if (tipo === 'contabilidade') conteudo = contabilidade(app, comp);
      else if (!emp) conteudo = UI.vazio('Cadastre um funcionário primeiro.');
      else conteudo = ({ espelho, extrato, ocorrencias, ajustes })[tipo](app, emp, comp);
      el.innerHTML = String(h`
        <div class="no-print">
          <h1>Relatórios e impressão</h1>
          <div class="abas" role="tablist" data-leitura>${Object.entries(TIPOS).map(([k, v]) => h`<button type="button" role="tab" class="${k === tipo ? 'ativa' : ''}" data-tipo="${k}" aria-selected="${k === tipo}">${v}</button>`)}</div>
          <div class="acoes"><button type="button" data-leitura class="primario" id="imprimir">Imprimir / Salvar como PDF</button>
          <span class="ajuda">Na janela de impressão, escolha a impressora ou “Salvar como PDF”, papel A4.</span></div>
        </div>
        <article class="relatorio" id="relatorio">${conteudo}</article>`);
      UI.$$('[data-tipo]', el).forEach((b) => b.onclick = () => { this.tipo = b.dataset.tipo; app.render(); });
      UI.$('#imprimir', el).onclick = () => root.print();
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
