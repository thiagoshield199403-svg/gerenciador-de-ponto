/*
 * bank.js — Banco de horas acumulado entre competências (funções puras).
 *
 * Fórmula:
 *   saldo final = saldo anterior + créditos − débitos + compensações + ajustes
 *   (compensações e ajustes têm sinal; compensações normalmente são negativas)
 *
 * O extrato é SEMPRE recalculado a partir das fontes (marcações, ocorrências,
 * lançamentos e fechamentos). Não existe "saldo acumulado" gravado que possa
 * ser somado duas vezes: reprocessar a mesma competência dá o mesmo resultado.
 *
 * Competência FECHADA usa o movimento congelado no fechamento; o saldo anterior
 * continua vindo da competência anterior. Se ele mudar (por correção retroativa),
 * a linha indica a divergência até que o fechamento seja atualizado.
 */
(function (root) {
  'use strict';
  const U = (typeof module !== 'undefined' && module.exports) ? require('./util.js') : root.Ponto.util;

  const B = {};

  B.POLITICA_PADRAO = {
    creditosNoBanco: true,     // créditos diários entram no banco
    debitosNoBanco: true,      // débitos diários são descontados do banco
    limitePositivoMin: null,   // alerta quando o saldo ultrapassa (null = sem limite)
    limiteNegativoMin: null,   // alerta quando o saldo fica abaixo de −limite
    observacao: ''
  };

  B.politica = (p) => Object.assign({}, B.POLITICA_PADRAO, p || {});

  /** Movimento de uma competência ainda aberta, a partir da apuração e dos lançamentos. */
  B.movimentoAoVivo = function (apuracao, lancamentosMes) {
    const t = apuracao.totais;
    const lanc = (lancamentosMes || []).filter((l) => !l.cancelado);
    return {
      creditosMin: t.creditosMin,
      debitosMin: t.debitosMin,
      compensacoesMin: -t.compensacoesDiasMin + lanc.filter((l) => l.tipo === 'compensacao').reduce((s, l) => s + l.minutos, 0),
      ajustesMin: lanc.filter((l) => l.tipo === 'ajuste').reduce((s, l) => s + l.minutos, 0),
      diasNaoApurados: t.diasNaoApurados,
      diasPendentes: t.diasPendentes
    };
  };

  B.saldoFinal = function (saldoAnterior, mov, politica) {
    const p = B.politica(politica);
    return saldoAnterior
      + (p.creditosNoBanco ? mov.creditosMin : 0)
      - (p.debitosNoBanco ? mov.debitosMin : 0)
      + mov.compensacoesMin
      + mov.ajustesMin;
  };

  B.compInicial = function (emp) {
    if (emp.banco && U.isComp(emp.banco.compInicial)) return emp.banco.compInicial;
    if (emp.admissao && U.isDateKey(emp.admissao)) return U.compOf(emp.admissao);
    return null;
  };

  /**
   * Extrato de competências, da inicial até `ateComp`.
   * @param o.emp          funcionário
   * @param o.ateComp      "AAAA-MM"
   * @param o.politica     política do banco
   * @param o.movimento    function(comp) -> movimento ao vivo (usado se não estiver fechada)
   * @param o.fechamentos  { comp: fechamento } do funcionário
   */
  B.extrato = function (o) {
    const pol = B.politica(o.politica);
    const ini = B.compInicial(o.emp) || o.ateComp;
    const linhas = [];
    if (U.cmp(o.ateComp, ini) < 0) return linhas;
    let saldo = Math.round((o.emp.banco && o.emp.banco.saldoInicialMin) || 0);
    for (let c = ini; U.cmp(c, o.ateComp) <= 0; c = U.nextComp(c)) {
      const f = (o.fechamentos || {})[c];
      const fechada = !!(f && f.status === 'fechada');
      const mov = fechada ? f.snapshot.movimento : o.movimento(c);
      // Competência fechada usa a política vigente no momento do fechamento
      const polMes = fechada && f.snapshot.politica ? B.politica(f.snapshot.politica) : pol;
      const final = B.saldoFinal(saldo, mov, polMes);
      const linha = {
        comp: c, fechada, saldoAnteriorMin: saldo,
        creditosMin: mov.creditosMin, debitosMin: mov.debitosMin,
        compensacoesMin: mov.compensacoesMin, ajustesMin: mov.ajustesMin,
        creditosForaBancoMin: polMes.creditosNoBanco ? 0 : mov.creditosMin,
        debitosForaBancoMin: polMes.debitosNoBanco ? 0 : mov.debitosMin,
        saldoFinalMin: final,
        provisoria: !fechada && (mov.diasNaoApurados > 0 || mov.diasPendentes > 0),
        diasNaoApurados: fechada ? 0 : mov.diasNaoApurados,
        diasPendentes: fechada ? 0 : mov.diasPendentes,
        divergencia: null, alertas: []
      };
      if (fechada && f.snapshot.saldoAnteriorMin !== saldo) {
        linha.divergencia = {
          saldoAnteriorRegistradoMin: f.snapshot.saldoAnteriorMin,
          saldoFinalRegistradoMin: f.snapshot.saldoFinalMin
        };
        linha.alertas.push('Saldo anterior mudou desde o fechamento (era ' + U.saldo(f.snapshot.saldoAnteriorMin) + ', agora ' + U.saldo(saldo) + '). Atualize o fechamento desta competência.');
      }
      if (pol.limitePositivoMin != null && final > pol.limitePositivoMin) linha.alertas.push('Saldo acima do limite positivo configurado (' + U.saldo(pol.limitePositivoMin) + ').');
      if (pol.limiteNegativoMin != null && final < -Math.abs(pol.limiteNegativoMin)) linha.alertas.push('Saldo abaixo do limite negativo configurado (' + U.saldo(-Math.abs(pol.limiteNegativoMin)) + ').');
      linhas.push(linha);
      saldo = final;
    }
    return linhas;
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = B;
  else { root.Ponto = root.Ponto || {}; root.Ponto.bank = B; }
})(typeof globalThis !== 'undefined' ? globalThis : this);
