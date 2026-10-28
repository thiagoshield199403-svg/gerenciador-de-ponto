/*
 * importer.js — Leitura de arquivos de marcações (funções puras).
 *
 * IMPORTANTE: o layout do arquivo exportado pelo relógio FR-1533 ainda NÃO é
 * conhecido. Este módulo NÃO presume nenhum layout específico. Ele oferece:
 *   1) detecção do tipo de arquivo (texto x binário, codificação);
 *   2) leitura genérica de texto delimitado (; , tabulação | ou espaços);
 *   3) sugestão de mapeamento de colunas, que o usuário confere e ajusta;
 *   4) extração das marcações com relatório de erros linha a linha.
 *
 * Quando o arquivo real do relógio for analisado, um leitor dedicado pode ser
 * registrado em Importer.LEITORES (ver README, seção "Relógio FR-1533").
 * O conteúdo do arquivo é tratado apenas como TEXTO: nunca é executado.
 */
(function (root) {
  'use strict';
  const U = (typeof module !== 'undefined' && module.exports) ? require('./util.js') : root.Ponto.util;

  const I = {};

  I.TAMANHO_MAXIMO = 20 * 1024 * 1024; // 20 MB

  /** Leitores dedicados a formatos confirmados com arquivos reais. Vazio de propósito. */
  I.LEITORES = [];

  /** Detecta se os bytes são texto e decodifica (UTF-8; se inválido, Windows-1252). */
  I.detectar = function (nome, bytes) {
    const ext = (/\.([a-z0-9]+)$/i.exec(nome || '') || [, ''])[1].toLowerCase();
    const info = { nome, extensao: ext, tamanho: bytes.length, tipo: 'desconhecido', codificacao: null, texto: null, avisos: [] };
    if (bytes.length === 0) { info.tipo = 'vazio'; return info; }
    if (bytes.length > I.TAMANHO_MAXIMO) { info.tipo = 'grande-demais'; return info; }
    const amostra = bytes.subarray(0, Math.min(bytes.length, 8192));
    let controle = 0, nulos = 0;
    for (const b of amostra) {
      if (b === 0) nulos++;
      else if (b < 32 && b !== 9 && b !== 10 && b !== 13) controle++;
    }
    let inicio = 0;
    if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) inicio = 3;
    const utf16 = (bytes[0] === 0xFF && bytes[1] === 0xFE) || (bytes[0] === 0xFE && bytes[1] === 0xFF);
    if (utf16) {
      info.tipo = 'texto';
      info.codificacao = bytes[0] === 0xFF ? 'utf-16le' : 'utf-16be';
      info.texto = new TextDecoder(info.codificacao).decode(bytes.subarray(2));
      return info;
    }
    if (nulos > 0 || controle / amostra.length > 0.05) {
      info.tipo = 'binario';
      info.avisos.push('O arquivo parece ser binário (não é texto). Formatos binários de relógio não são lidos por esta versão; verifique se o relógio permite exportar em TXT/CSV.');
      return info;
    }
    try {
      info.texto = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(inicio));
      info.codificacao = 'utf-8';
    } catch (e) {
      info.texto = new TextDecoder('windows-1252').decode(bytes);
      info.codificacao = 'windows-1252';
    }
    info.tipo = 'texto';
    return info;
  };

  /** Divide o texto em linhas e colunas, detectando o delimitador. */
  I.tabular = function (texto) {
    const linhas = texto.split(/\r\n|\n|\r/);
    const naoVazias = linhas.map((l, i) => ({ n: i + 1, l })).filter((x) => x.l.trim() !== '');
    const candidatos = ['\t', ';', ',', '|'];
    let melhor = null;
    for (const d of candidatos) {
      const contagens = naoVazias.slice(0, 50).map((x) => x.l.split(d).length - 1);
      if (!contagens.length) continue;
      const freq = {};
      contagens.forEach((c) => { freq[c] = (freq[c] || 0) + 1; });
      const [moda, vezes] = Object.entries(freq).sort((a, b) => b[1] - a[1])[0];
      if (+moda > 0) {
        const score = vezes / contagens.length + (+moda) * 0.001;
        if (!melhor || score > melhor.score) melhor = { d, score };
      }
    }
    // Vírgula como separador decimal/data é rara; se ; ou tab foram encontrados com boa consistência, prefira-os
    const delimitador = melhor && melhor.score >= 0.6 ? melhor.d : 'espacos';
    const dividir = (l) => delimitador === 'espacos'
      ? l.trim().split(/\s+/)
      : l.split(delimitador).map((c) => c.trim().replace(/^"(.*)"$/, '$1').trim());
    return {
      delimitador,
      linhas: naoVazias.map((x) => ({ n: x.n, bruto: x.l, celulas: dividir(x.l) }))
    };
  };

  const RE_DATA = /^(\d{1,4})[\/\-.](\d{1,2})[\/\-.](\d{1,4})$/;
  const RE_HORA = /^\d{1,2}:\d{2}(:\d{2})?$/;
  const RE_DATAHORA = /^(\d{1,4}[\/\-.]\d{1,2}[\/\-.]\d{1,4})[ T](\d{1,2}:\d{2}(?::\d{2})?)$/;

  /** Converte texto em data "AAAA-MM-DD" conforme o formato (dmy, ymd, mdy). */
  I.lerData = function (s, formato) {
    const m = RE_DATA.exec((s || '').trim());
    if (!m) return null;
    let y, mo, d;
    if (formato === 'ymd') { y = m[1]; mo = m[2]; d = m[3]; }
    else if (formato === 'mdy') { mo = m[1]; d = m[2]; y = m[3]; }
    else { d = m[1]; mo = m[2]; y = m[3]; }
    if (y.length === 2) y = '20' + y;
    if (y.length !== 4) return null;
    const k = U.dateKey(+y, +mo, +d);
    return U.isDateKey(k) ? k : null;
  };

  I.lerHora = function (s) {
    const v = U.parseHM((s || '').trim());
    return v === null ? null : U.hm(v);
  };

  /** Sugere o mapeamento de colunas olhando o conteúdo das primeiras linhas. */
  I.sugerirMapeamento = function (tab) {
    const amostra = tab.linhas.slice(0, 200);
    const nCols = Math.max(0, ...amostra.map((l) => l.celulas.length));
    const stats = [];
    for (let c = 0; c < nCols; c++) {
      const vals = amostra.map((l) => (l.celulas[c] || '').trim()).filter(Boolean);
      const st = { col: c, data: 0, hora: 0, datahora: 0, numero: 0, total: vals.length };
      for (const v of vals) {
        if (RE_DATAHORA.test(v)) st.datahora++;
        else if (RE_DATA.test(v)) st.data++;
        else if (RE_HORA.test(v)) st.hora++;
        else if (/^\d{1,12}$/.test(v)) st.numero++;
      }
      stats.push(st);
    }
    const melhor = (campo, excluir) => {
      let b = null;
      for (const s of stats) {
        if (excluir.includes(s.col) || !s.total) continue;
        const r = s[campo] / s.total;
        if (r >= 0.5 && (!b || r > b.r)) b = { col: s.col, r };
      }
      return b ? b.col : null;
    };
    const m = { colCodigo: null, colData: null, colHora: null, colDataHora: null, formatoData: 'dmy', ignorarLinhas: 0 };
    m.colDataHora = melhor('datahora', []);
    if (m.colDataHora === null) {
      m.colData = melhor('data', []);
      m.colHora = melhor('hora', [m.colData]);
    }
    m.colCodigo = melhor('numero', [m.colData, m.colHora, m.colDataHora].filter((x) => x !== null));
    // Cabeçalho: primeira linha sem data reconhecível
    const primeira = tab.linhas[0];
    if (primeira) {
      const colD = m.colDataHora !== null ? m.colDataHora : m.colData;
      const v = colD !== null ? (primeira.celulas[colD] || '') : '';
      if (colD !== null && !RE_DATA.test(v) && !RE_DATAHORA.test(v)) m.ignorarLinhas = 1;
    }
    // Formato de data: se algum valor tem 4 dígitos no início, é ano-mês-dia
    const colD = m.colDataHora !== null ? m.colDataHora : m.colData;
    if (colD !== null) {
      const vals = amostra.map((l) => (l.celulas[colD] || '').trim().split(/[ T]/)[0]).filter((v) => RE_DATA.test(v));
      if (vals.some((v) => /^\d{4}/.test(v))) m.formatoData = 'ymd';
      else if (vals.some((v) => +RE_DATA.exec(v)[2] > 12)) m.formatoData = 'mdy';
      else m.formatoData = 'dmy';
    }
    m.nColunas = nCols;
    return m;
  };

  /** Extrai marcações segundo o mapeamento. Não grava nada. */
  I.extrair = function (tab, map) {
    const registros = [], erros = [];
    const ign = Math.max(0, map.ignorarLinhas | 0);
    tab.linhas.forEach((l, idx) => {
      if (idx < ign) return;
      const cel = (c) => (c === null || c === undefined || c === '') ? '' : (l.celulas[+c] || '').trim();
      const codigo = map.colCodigo === null || map.colCodigo === '' ? '' : cel(map.colCodigo);
      let data = null, hora = null;
      if (map.colDataHora !== null && map.colDataHora !== '' && map.colDataHora !== undefined) {
        const m = RE_DATAHORA.exec(cel(map.colDataHora));
        if (m) { data = I.lerData(m[1], map.formatoData); hora = I.lerHora(m[2]); }
      } else {
        data = I.lerData(cel(map.colData), map.formatoData);
        hora = I.lerHora(cel(map.colHora));
      }
      const motivos = [];
      if (!data) motivos.push('data não reconhecida');
      if (!hora) motivos.push('hora não reconhecida');
      if (map.colCodigo !== null && map.colCodigo !== '' && !codigo) motivos.push('identificador vazio');
      if (motivos.length) { erros.push({ linha: l.n, conteudo: l.bruto.slice(0, 200), motivo: motivos.join(', ') }); return; }
      registros.push({ linha: l.n, codigo, data, hora, dt: data + ' ' + hora, bruto: l.bruto.slice(0, 500) });
    });
    return { registros, erros };
  };

  /** Marca duplicidades dentro do próprio arquivo e contra marcações existentes. */
  I.marcarDuplicidades = function (registros, existentesPorChave) {
    const vistos = new Set();
    for (const r of registros) {
      const chave = (r.employeeId || 'cod:' + r.codigo) + '|' + r.dt;
      r.duplicadaArquivo = vistos.has(chave);
      r.duplicadaExistente = !!(r.employeeId && existentesPorChave && existentesPorChave.has(r.employeeId + '|' + r.dt));
      vistos.add(chave);
    }
    return registros;
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = I;
  else { root.Ponto = root.Ponto || {}; root.Ponto.importer = I; }
})(typeof globalThis !== 'undefined' ? globalThis : this);
