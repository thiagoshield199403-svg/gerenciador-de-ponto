/*
 * backup.js — Montagem e validação de backups completos (JSON).
 *
 * Estrutura:
 * {
 *   formato: "gerenciador-ponto-backup", versaoFormato: 1, versaoSistema, geradoEm,
 *   contagens: {store: n}, integridade: {algoritmo, hash}, dados: {store: [registros]}
 * }
 * O hash é calculado sobre JSON.stringify(dados). Qualquer alteração manual
 * no conteúdo é detectada na restauração.
 */
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports;
  const U = isNode ? require('./util.js') : root.Ponto.util;
  const C = isNode ? require('./calc.js') : root.Ponto.calc;
  const DB = isNode ? require('./db.js') : root.Ponto.db;

  const BK = {};
  BK.FORMATO = 'gerenciador-ponto-backup';
  BK.VERSAO_FORMATO = 1;

  BK.montar = async function (dados, versaoSistema) {
    const ordenado = {};
    const contagens = {};
    for (const s of DB.STORES) {
      ordenado[s] = (dados[s] || []).slice().sort((a, b) => U.cmp(String(a.id), String(b.id)));
      contagens[s] = ordenado[s].length;
    }
    const h = await U.hash(JSON.stringify(ordenado));
    return {
      formato: BK.FORMATO,
      versaoFormato: BK.VERSAO_FORMATO,
      versaoSistema: versaoSistema || '',
      geradoEm: U.nowISO(),
      contagens,
      integridade: { algoritmo: h.algoritmo, hash: h.valor },
      dados: ordenado
    };
  };

  const isStr = (v) => typeof v === 'string';
  const isNonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
  const isInt = (v) => Number.isInteger(v);

  /** Regras mínimas por coleção: retorna mensagem de erro ou null. */
  const REGRAS = {
    config: () => null,
    funcionarios: (r) => !isNonEmpty(r.nome) ? 'nome ausente'
      : !['ativo', 'inativo'].includes(r.situacao) ? 'situação inválida'
        : !(r.jornada && Array.isArray(r.jornada.semana) && r.jornada.semana.length === 7) ? 'jornada semanal inválida' : null,
    marcacoes: (r) => !isStr(r.employeeId) ? 'funcionário ausente' : !U.isDT(r.dt) ? 'data/hora inválida'
      : !U.isDateKey(r.dataRef) ? 'data de referência inválida' : !isNonEmpty(r.origem) ? 'origem ausente' : null,
    ajustes: (r) => !['inclusao', 'alteracao', 'desconsiderar', 'restaurar'].includes(r.tipo) ? 'tipo inválido'
      : !isStr(r.employeeId) ? 'funcionário ausente'
        : !isNonEmpty(r.justificativa) ? 'justificativa ausente'
          : ((r.tipo === 'inclusao' || r.tipo === 'alteracao') && !U.isDT(r.dt)) ? 'data/hora inválida'
            : (r.tipo !== 'inclusao' && !/^[pa]:/.test(r.alvo || '')) ? 'alvo inválido' : null,
    eventos: (r) => !Object.prototype.hasOwnProperty.call(C.TIPOS_EVENTO, r.tipo) ? 'tipo de ocorrência desconhecido'
      : !U.isDateKey(r.data) ? 'data inválida' : !(r.employeeId === null || isStr(r.employeeId)) ? 'funcionário inválido' : null,
    lancamentos: (r) => !['ajuste', 'compensacao'].includes(r.tipo) ? 'tipo inválido' : !isStr(r.employeeId) ? 'funcionário ausente'
      : !U.isDateKey(r.data) ? 'data inválida' : !isInt(r.minutos) ? 'minutos inválidos' : !isNonEmpty(r.justificativa) ? 'justificativa ausente' : null,
    fechamentos: (r) => !isStr(r.employeeId) ? 'funcionário ausente' : !U.isComp(r.comp) ? 'competência inválida'
      : !['fechada', 'reaberta'].includes(r.status) ? 'situação inválida' : !Array.isArray(r.historico) ? 'histórico ausente' : null,
    conferencias: (r) => !isStr(r.employeeId) ? 'funcionário ausente' : !U.isDateKey(r.data) ? 'data inválida' : null,
    importacoes: (r) => !isNonEmpty(r.nomeArquivo) ? 'nome do arquivo ausente' : !isStr(r.importadoEm) ? 'data da importação ausente' : null,
    auditoria: (r) => !isStr(r.em) ? 'data ausente' : !isNonEmpty(r.acao) ? 'ação ausente' : null
  };

  /** Valida estrutura, integridade e referências. Não altera nada. */
  BK.validar = async function (obj) {
    const erros = [], avisos = [];
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, erros: ['O arquivo não contém um objeto JSON válido.'], avisos };
    if (obj.formato !== BK.FORMATO) return { ok: false, erros: ['Este arquivo não é um backup do Gerenciador de Ponto.'], avisos };
    if (!isInt(obj.versaoFormato) || obj.versaoFormato > BK.VERSAO_FORMATO) {
      return { ok: false, erros: ['Versão de backup não suportada (' + obj.versaoFormato + '). Atualize o sistema antes de restaurar.'], avisos };
    }
    if (!obj.dados || typeof obj.dados !== 'object') return { ok: false, erros: ['Backup sem a seção de dados.'], avisos };

    for (const s of DB.STORES) {
      if (!Array.isArray(obj.dados[s])) erros.push('Coleção "' + s + '" ausente ou inválida.');
    }
    for (const s of Object.keys(obj.dados)) if (!DB.STORES.includes(s)) avisos.push('Coleção desconhecida "' + s + '" será ignorada.');
    if (erros.length) return { ok: false, erros, avisos };

    // Integridade
    if (!obj.integridade || !isStr(obj.integridade.hash)) {
      erros.push('Backup sem código de integridade.');
    } else {
      const calc = await U.hashWith(obj.integridade.algoritmo, JSON.stringify(obj.dados));
      if (calc === null) avisos.push('Não foi possível verificar a integridade (algoritmo ' + obj.integridade.algoritmo + ' indisponível neste navegador).');
      else if (calc !== obj.integridade.hash) erros.push('Falha na verificação de integridade: o conteúdo do arquivo foi alterado ou está corrompido.');
    }

    // Registros
    const ids = {};
    for (const s of DB.STORES) {
      ids[s] = new Set();
      obj.dados[s].forEach((r, i) => {
        if (!r || typeof r !== 'object' || !isStr(r.id) || !r.id) { erros.push(s + ' #' + (i + 1) + ': registro sem identificador.'); return; }
        if (ids[s].has(r.id)) { erros.push(s + ': identificador duplicado ' + r.id + '.'); return; }
        ids[s].add(r.id);
        const e = REGRAS[s](r);
        if (e) erros.push(s + ' ' + r.id + ': ' + e + '.');
      });
      if (obj.contagens && isInt(obj.contagens[s]) && obj.contagens[s] !== obj.dados[s].length) {
        erros.push(s + ': quantidade de registros (' + obj.dados[s].length + ') difere da informada (' + obj.contagens[s] + ').');
      }
    }

    // Referências
    const emp = ids.funcionarios;
    const ref = (s, r) => { if (r.employeeId !== null && r.employeeId !== undefined && !emp.has(r.employeeId)) erros.push(s + ' ' + r.id + ': funcionário inexistente.'); };
    ['marcacoes', 'ajustes', 'eventos', 'lancamentos', 'fechamentos', 'conferencias'].forEach((s) => obj.dados[s].forEach((r) => ref(s, r)));
    obj.dados.ajustes.forEach((a) => {
      if (!a.alvo) return;
      const [t, id] = [a.alvo.slice(0, 1), a.alvo.slice(2)];
      if ((t === 'p' && !ids.marcacoes.has(id)) || (t === 'a' && !ids.ajustes.has(id))) erros.push('ajustes ' + a.id + ': marcação de referência inexistente.');
    });
    obj.dados.marcacoes.forEach((m) => { if (m.importId && !ids.importacoes.has(m.importId)) avisos.push('marcação ' + m.id + ': registro de importação de origem ausente.'); });

    const resumo = {};
    DB.STORES.forEach((s) => { resumo[s] = obj.dados[s].length; });
    return { ok: erros.length === 0, erros: erros.slice(0, 200), totalErros: erros.length, avisos, resumo, geradoEm: obj.geradoEm, versaoSistema: obj.versaoSistema };
  };

  if (isNode) module.exports = BK;
  else { root.Ponto = root.Ponto || {}; root.Ponto.backup = BK; }
})(typeof globalThis !== 'undefined' ? globalThis : this);
