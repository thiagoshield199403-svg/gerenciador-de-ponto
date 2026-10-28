/*
 * calc.js — Apuração diária e mensal (funções puras).
 *
 * Princípios:
 *  - Tudo em minutos inteiros; formatação só na apresentação.
 *  - Nunca inventa batidas. Quantidade ímpar ou dia útil sem marcações
 *    gera ERRO: o saldo do dia fica "não apurado" (null) e não entra no
 *    banco de horas até a conferência humana resolver.
 *  - ALERTAS (duplicidade, trabalho fora da jornada, intervalo curto...)
 *    não bloqueiam o cálculo, mas exigem que o dia seja marcado como
 *    conferido antes do fechamento.
 *  - Excedente não é automaticamente "hora extra devida", e déficit não
 *    é automaticamente "desconto": o sistema apenas apura e classifica.
 */
(function (root) {
  'use strict';
  const U = (typeof module !== 'undefined' && module.exports) ? require('./util.js') : root.Ponto.util;

  const C = {};

  /** Valores padrão das regras de jornada (todas editáveis por funcionário). */
  C.REGRAS_PADRAO = {
    toleranciaDiariaMin: 10,      // diferença total do dia até este valor é desconsiderada
    janelaDuplicidadeMin: 3,      // batidas com diferença <= este valor são tratadas como duplicadas
    intervaloMinimoMin: 60,       // alerta se o intervalo registrado for menor
    limiteForaJornadaMin: 60,     // alerta se a batida estiver tão longe do horário previsto
    jornadaMaximaMin: 600,        // alerta se o trabalhado no dia ultrapassar este total
    horaCorteVirada: ''           // jornadas que cruzam meia-noite: batidas antes desta hora pertencem ao dia anterior.
                                  // Vazio = automático (fim da jornada noturna + MARGEM_VIRADA_MIN).
  };
  C.MARGEM_VIRADA_MIN = 240;

  /** Jornada de exemplo para testes (NÃO é configuração legalmente validada). */
  C.semanaExemplo = function () {
    const util = [{ ini: '09:00', fim: '12:00' }, { ini: '14:00', fim: '19:00' }];
    return [0, 1, 2, 3, 4, 5, 6].map((wd) => (wd === 0 || wd === 6)
      ? { folga: true, periodos: [] }
      : { folga: false, periodos: util.map((p) => ({ ...p })) });
  };

  /** Tipos de ocorrência cadastráveis e seus efeitos na apuração. */
  C.TIPOS_EVENTO = {
    feriado:             { nome: 'Feriado',                    zeraPrevisto: true },
    folga:               { nome: 'Folga',                      zeraPrevisto: true },
    ferias:              { nome: 'Férias',                     zeraPrevisto: true },
    folga_compensatoria: { nome: 'Folga compensatória (usa banco)', compensa: true },
    falta:               { nome: 'Falta (não justificada)',   confirmaFalta: true },
    falta_justificada:   { nome: 'Falta justificada',          abonaTotal: true },
    atestado:            { nome: 'Atestado',                   abonaTotal: true },
    abono:               { nome: 'Abono parcial (minutos)',    abonaMinutos: true }
  };

  C.regras = function (emp) {
    return Object.assign({}, C.REGRAS_PADRAO, (emp && emp.jornada && emp.jornada.regras) || {});
  };

  /** Duração prevista de um dia da semana (aceita período que cruza meia-noite). */
  C.previstoPeriodos = function (periodos) {
    let total = 0, lastEnd = null;
    const abs = [];
    for (const p of periodos || []) {
      let ini = U.parseHM(p.ini), fim = U.parseHM(p.fim);
      if (ini === null || fim === null) continue;
      if (lastEnd !== null) { while (ini < lastEnd) ini += 1440; }
      while (fim <= ini) fim += 1440;
      abs.push({ ini, fim });
      total += fim - ini;
      lastEnd = fim;
    }
    return { total, abs };
  };

  C.cruzaMeiaNoite = function (diaSemana) {
    if (!diaSemana || diaSemana.folga) return false;
    const { abs } = C.previstoPeriodos(diaSemana.periodos);
    return abs.length > 0 && abs[abs.length - 1].fim > 1440;
  };

  /** Valida a configuração semanal; retorna lista de erros em texto. */
  C.validarSemana = function (semana) {
    const erros = [];
    if (!Array.isArray(semana) || semana.length !== 7) return ['A jornada deve ter os 7 dias da semana.'];
    semana.forEach((d, i) => {
      if (d.folga) return;
      if (!d.periodos || !d.periodos.length) erros.push(U.WEEKDAYS[i] + ': informe ao menos um período ou marque como folga.');
      (d.periodos || []).forEach((p, j) => {
        if (U.parseHM(p.ini) === null || U.parseHM(p.fim) === null) erros.push(U.WEEKDAYS[i] + ', período ' + (j + 1) + ': horário inválido.');
        else if (p.ini === p.fim) erros.push(U.WEEKDAYS[i] + ', período ' + (j + 1) + ': início e fim iguais.');
      });
      const { total } = C.previstoPeriodos(d.periodos);
      if (total > 1440) erros.push(U.WEEKDAYS[i] + ': jornada maior que 24 horas.');
    });
    return erros;
  };

  C.previstoSemanal = function (semana) {
    return (semana || []).reduce((s, d) => s + (d.folga ? 0 : C.previstoPeriodos(d.periodos).total), 0);
  };

  /**
   * Data de referência (dia de trabalho) de uma batida.
   * Se o dia anterior tem jornada que cruza meia-noite e a batida ocorre antes da
   * hora de corte, ela pertence ao dia anterior.
   */
  C.dataReferencia = function (emp, dt) {
    const data = U.dtDate(dt);
    const semana = emp && emp.jornada && emp.jornada.semana;
    if (!semana) return data;
    const anterior = U.addDays(data, -1);
    const diaAnt = semana[U.weekday(anterior)];
    if (!C.cruzaMeiaNoite(diaAnt)) return data;
    let corte = U.parseHM(C.regras(emp).horaCorteVirada || '');
    if (corte === null) {
      const { abs } = C.previstoPeriodos(diaAnt.periodos);
      corte = Math.min(1439, abs[abs.length - 1].fim - 1440 + C.MARGEM_VIRADA_MIN);
    }
    return U.parseHM(U.dtTime(dt)) < corte ? anterior : data;
  };

  /** Assinatura das marcações de um dia (para invalidar conferências quando os dados mudam). */
  C.assinaturaDia = function (marcacoes) {
    return (marcacoes || []).map((m) => m.ref + '@' + m.dt).sort().join('|');
  };

  /**
   * Apura um dia.
   * @param emp       funcionário (com jornada.semana e jornada.regras)
   * @param data      "AAAA-MM-DD" (data de referência)
   * @param marcacoes [{ref, dt, origem, ajustada}] marcações EFETIVAS do dia
   * @param ctx       { eventos:[], conferencia:{assinatura,...}|null, hoje:"AAAA-MM-DD" }
   */
  C.apurarDia = function (emp, data, marcacoes, ctx) {
    ctx = ctx || {};
    const regras = C.regras(emp);
    const wd = U.weekday(data);
    const semana = (emp.jornada && emp.jornada.semana) || [];
    const diaSemana = semana[wd] || { folga: true, periodos: [] };
    const eventos = ctx.eventos || [];
    const hoje = ctx.hoje || U.todayKey();
    const oc = [];
    const add = (nivel, codigo, texto) => oc.push({ nivel, codigo, texto });

    const r = {
      data, diaSemana: wd, tipoDia: 'util', periodosPrevistos: [], previstoMin: 0,
      marcacoes: [], trabalhadoMin: 0, intervaloMin: 0, atrasoMin: 0, saidaAntecipadaMin: 0,
      diferencaBrutaMin: 0, saldoMin: null, creditoMin: 0, debitoMin: 0, compensacaoMin: 0, abonoMin: 0,
      extraMin: 0, faltanteMin: 0, falta: false, futuro: false, foraContrato: false,
      eventos: eventos.map((e) => ({ id: e.id, tipo: e.tipo, descricao: e.descricao || '', minutos: e.minutos || 0 })),
      ocorrencias: oc, conferido: false, pendente: false, situacao: ''
    };

    // --- Jornada prevista do dia
    const tipos = eventos.map((e) => C.TIPOS_EVENTO[e.tipo] || {});
    let previstoPeriodos = diaSemana.folga ? [] : (diaSemana.periodos || []);
    if (diaSemana.folga) r.tipoDia = 'folga';
    if (eventos.some((e) => e.tipo === 'feriado')) r.tipoDia = 'feriado';
    else if (eventos.some((e) => e.tipo === 'ferias')) r.tipoDia = 'ferias';
    else if (eventos.some((e) => e.tipo === 'folga')) r.tipoDia = 'folga';
    if (tipos.some((t) => t.zeraPrevisto)) previstoPeriodos = [];

    if ((emp.admissao && data < emp.admissao) || (emp.desligamento && data > emp.desligamento)) {
      r.foraContrato = true; r.tipoDia = 'fora'; previstoPeriodos = [];
    }

    const prev = C.previstoPeriodos(previstoPeriodos);
    r.periodosPrevistos = previstoPeriodos.map((p) => ({ ini: p.ini, fim: p.fim }));
    r.previstoMin = prev.total;
    const base = U.dayNumber(data) * 1440;
    const esperado = prev.abs.map((p) => ({ ini: base + p.ini, fim: base + p.fim }));

    // --- Marcações: ordenar e detectar duplicidades
    const ordenadas = (marcacoes || []).slice().sort((a, b) => U.dtAbs(a.dt) - U.dtAbs(b.dt));
    const consideradas = [];
    let ultima = null;
    for (const m of ordenadas) {
      const abs = U.dtAbs(m.dt);
      const item = Object.assign({}, m, { duplicada: false });
      if (ultima !== null && abs - ultima <= regras.janelaDuplicidadeMin) {
        item.duplicada = true;
      } else {
        consideradas.push(abs);
        ultima = abs;
      }
      r.marcacoes.push(item);
    }
    const nDup = r.marcacoes.filter((m) => m.duplicada).length;
    if (nDup) add('alerta', 'DUPLICADA', nDup + ' marcação(ões) com diferença de até ' + regras.janelaDuplicidadeMin + ' min da anterior, desconsiderada(s) no cálculo. Confira e, se for o caso, exclua com justificativa.');

    const n = consideradas.length;
    const abona = tipos.some((t) => t.abonaTotal);
    const compensa = tipos.some((t) => t.compensa);
    const confirmaFalta = tipos.some((t) => t.confirmaFalta);
    const abonoMinutos = eventos.filter((e) => C.TIPOS_EVENTO[e.tipo] && C.TIPOS_EVENTO[e.tipo].abonaMinutos)
      .reduce((s, e) => s + Math.max(0, Math.round(e.minutos || 0)), 0);

    // --- Trabalhado e intervalo (pares completos)
    for (let i = 0; i + 1 < n; i += 2) r.trabalhadoMin += consideradas[i + 1] - consideradas[i];
    for (let i = 1; i + 1 < n; i += 2) r.intervaloMin += consideradas[i + 1] - consideradas[i];

    let apuravel = true;
    if (r.foraContrato) {
      if (n > 0) add('alerta', 'FORA_CONTRATO', 'Há marcações em data fora do período do contrato (antes da admissão ou após o desligamento).');
      if (n % 2 === 1) { add('erro', 'IMPAR', 'Quantidade ímpar de marcações (' + n + ').'); apuravel = false; }
    } else if (n % 2 === 1 && data >= hoje) {
      add('info', 'EM_ANDAMENTO', 'Jornada em andamento (quantidade ímpar de marcações no dia de hoje).');
      r.futuro = true; apuravel = false;
    } else if (n % 2 === 1) {
      add('erro', 'IMPAR', 'Quantidade ímpar de marcações (' + n + '). Falta uma entrada ou saída — inclua ou exclua a marcação com justificativa.');
      apuravel = false;
    } else if (n === 0 && r.previstoMin > 0) {
      if (confirmaFalta) { r.falta = true; }
      else if (abona || compensa || abonoMinutos > 0) { /* tratado abaixo */ }
      else if (data >= hoje) { r.futuro = true; apuravel = false; }
      else {
        add('erro', 'SEM_MARCACAO', 'Dia de trabalho sem marcações. Registre a ocorrência (falta, atestado, folga, feriado...) ou inclua as marcações.');
        apuravel = false;
      }
    }

    if (n === 0 && r.previstoMin === 0 && data >= hoje) r.futuro = true;

    if (confirmaFalta && n > 0) add('alerta', 'FALTA_COM_MARCACAO', 'Há falta registrada, mas também existem marcações neste dia.');

    // --- Atraso, saída antecipada, alertas de jornada
    if (n >= 2 && n % 2 === 0 && esperado.length) {
      r.atrasoMin = Math.max(0, consideradas[0] - esperado[0].ini);
      r.saidaAntecipadaMin = Math.max(0, esperado[esperado.length - 1].fim - consideradas[n - 1]);
      const lim = regras.limiteForaJornadaMin;
      if (consideradas[0] < esperado[0].ini - lim || consideradas[n - 1] > esperado[esperado.length - 1].fim + lim) {
        add('alerta', 'FORA_JORNADA', 'Marcação a mais de ' + U.dur(lim) + ' do horário previsto.');
      }
    }
    if (n > 0 && r.previstoMin === 0 && !r.foraContrato) {
      add('alerta', 'TRABALHO_SEM_JORNADA', 'Marcações em dia sem jornada prevista (' + ({ folga: 'folga', feriado: 'feriado', ferias: 'férias' }[r.tipoDia] || 'sem jornada') + ').');
    }
    if (n >= 4 && n % 2 === 0 && r.intervaloMin < regras.intervaloMinimoMin && r.trabalhadoMin > 360) {
      add('alerta', 'INTERVALO_CURTO', 'Intervalo registrado (' + U.dur(r.intervaloMin) + ') menor que o mínimo configurado (' + U.dur(regras.intervaloMinimoMin) + ').');
    }
    if (n === 2 && r.trabalhadoMin > 360) add('alerta', 'SEM_INTERVALO', 'Mais de 6 horas trabalhadas sem intervalo registrado.');
    if (r.trabalhadoMin > regras.jornadaMaximaMin) add('alerta', 'JORNADA_EXCESSIVA', 'Total trabalhado acima de ' + U.dur(regras.jornadaMaximaMin) + '.');

    // --- Saldo do dia
    if (apuravel) {
      r.diferencaBrutaMin = r.trabalhadoMin - r.previstoMin;
      let saldo = r.diferencaBrutaMin;
      if (saldo !== 0 && Math.abs(saldo) <= regras.toleranciaDiariaMin && r.previstoMin > 0) {
        add('info', 'TOLERANCIA', 'Diferença de ' + U.saldo(saldo) + ' dentro da tolerância diária configurada (' + regras.toleranciaDiariaMin + ' min); desconsiderada.');
        saldo = 0;
      }
      if (saldo < 0 && abona) { r.abonoMin = -saldo; saldo = 0; }
      if (saldo < 0 && abonoMinutos > 0) { r.abonoMin = Math.min(abonoMinutos, -saldo); saldo += r.abonoMin; }
      r.saldoMin = saldo;
      r.extraMin = Math.max(0, saldo);
      r.faltanteMin = Math.max(0, -saldo);
      r.creditoMin = Math.max(0, saldo);
      if (saldo < 0 && compensa) r.compensacaoMin = -saldo;
      else r.debitoMin = Math.max(0, -saldo);
      if (r.falta) add('info', 'FALTA', 'Falta registrada (não justificada).');
    } else {
      r.diferencaBrutaMin = null;
    }

    // --- Conferência
    const assinatura = C.assinaturaDia(marcacoes) + '#' + eventos.map((e) => e.id).sort().join(',');
    r.assinatura = assinatura;
    if (ctx.conferencia && ctx.conferencia.assinatura === assinatura) r.conferido = true;
    else if (ctx.conferencia) add('info', 'CONFERENCIA_DESATUALIZADA', 'O dia foi conferido antes, mas os dados mudaram depois; confira novamente.');

    const temErro = oc.some((o) => o.nivel === 'erro');
    const temAlerta = oc.some((o) => o.nivel === 'alerta');
    r.pendente = temErro || (temAlerta && !r.conferido);
    r.situacao = temErro ? 'Inconsistente' : r.pendente ? 'Pendente de conferência' : r.futuro ? 'Aguardando' : r.conferido ? 'Conferido' : 'OK';
    return r;
  };

  /**
   * Apura um mês inteiro.
   * @param dados { marcacoesPorDia:{data:[...]}, eventosPorDia:{data:[...]}, conferencias:{data:{...}}, hoje }
   */
  C.apurarMes = function (emp, comp, dados) {
    const dias = U.compDays(comp).map((d) => C.apurarDia(emp, d, (dados.marcacoesPorDia || {})[d] || [], {
      eventos: (dados.eventosPorDia || {})[d] || [],
      conferencia: (dados.conferencias || {})[d] || null,
      hoje: dados.hoje
    }));
    const t = {
      previstoMin: 0, trabalhadoMin: 0, creditosMin: 0, debitosMin: 0, compensacoesDiasMin: 0, abonosMin: 0,
      atrasosMin: 0, saidasAntecipadasMin: 0, faltas: 0, diasTrabalhados: 0, diasPendentes: 0, diasInconsistentes: 0,
      diasNaoApurados: 0, previstoApuradoMin: 0
    };
    for (const d of dias) {
      t.previstoMin += d.previstoMin;
      t.trabalhadoMin += d.trabalhadoMin;
      t.atrasosMin += d.atrasoMin;
      t.saidasAntecipadasMin += d.saidaAntecipadaMin;
      if (d.saldoMin !== null) {
        t.previstoApuradoMin += d.previstoMin;
        t.creditosMin += d.creditoMin;
        t.debitosMin += d.debitoMin;
        t.compensacoesDiasMin += d.compensacaoMin;
        t.abonosMin += d.abonoMin;
      } else if (!d.futuro) t.diasNaoApurados++;
      if (d.falta) t.faltas++;
      if (d.marcacoes.length) t.diasTrabalhados++;
      if (d.pendente) t.diasPendentes++;
      if (d.ocorrencias.some((o) => o.nivel === 'erro')) t.diasInconsistentes++;
    }
    return { comp, dias, totais: t };
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = C;
  else { root.Ponto = root.Ponto || {}; root.Ponto.calc = C; }
})(typeof globalThis !== 'undefined' ? globalThis : this);
