/*
 * util.js — Funções utilitárias puras (sem acesso a DOM ou banco).
 * Todos os cálculos de tempo são feitos em MINUTOS INTEIROS.
 * Datas são tratadas como texto "AAAA-MM-DD" e convertidas com Date.UTC,
 * evitando efeitos de fuso horário/horário de verão.
 */
(function (root) {
  'use strict';

  const U = {};

  U.WEEKDAYS = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
  U.WEEKDAYS_SHORT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  U.MONTHS = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

  U.pad2 = (n) => String(n).padStart(2, '0');

  /** "09:30" ou "09:30:15" -> 570 (segundos são descartados). Retorna null se inválido. */
  U.parseHM = function (s) {
    if (typeof s !== 'string') return null;
    const m = /^\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/.exec(s);
    if (!m) return null;
    const h = +m[1], mi = +m[2], se = m[3] === undefined ? 0 : +m[3];
    if (h > 23 || mi > 59 || se > 59) return null;
    return h * 60 + mi;
  };

  /** 570 -> "09:30" (hora do dia, módulo 24h). */
  U.hm = function (min) {
    const m = ((min % 1440) + 1440) % 1440;
    return U.pad2(Math.floor(m / 60)) + ':' + U.pad2(m % 60);
  };

  /** Duração em minutos -> "08:00" (sem sinal; aceita mais de 24h). */
  U.dur = function (min) {
    if (min === null || min === undefined || isNaN(min)) return '—';
    const a = Math.abs(Math.round(min));
    return U.pad2(Math.floor(a / 60)) + ':' + U.pad2(a % 60);
  };

  /** Saldo com sinal: 330 -> "+05:30", -255 -> "-04:15", 0 -> "00:00". */
  U.saldo = function (min) {
    if (min === null || min === undefined || isNaN(min)) return '—';
    if (min === 0) return '00:00';
    return (min > 0 ? '+' : '-') + U.dur(min);
  };

  /** "+05:30", "-4:15", "05:30", "2h", "1h30" -> minutos com sinal. null se inválido. */
  U.parseDuracao = function (s) {
    if (typeof s !== 'string') return null;
    const t = s.trim().replace(/\s+/g, '');
    let m = /^([+-])?(\d{1,4}):(\d{2})$/.exec(t);
    if (m) {
      if (+m[3] > 59) return null;
      const v = +m[2] * 60 + +m[3];
      return m[1] === '-' ? -v : v;
    }
    m = /^([+-])?(\d{1,4})h(?:(\d{1,2})(?:m|min)?)?$/i.exec(t);
    if (m) {
      const mi = m[3] === undefined ? 0 : +m[3];
      if (mi > 59) return null;
      const v = +m[2] * 60 + mi;
      return m[1] === '-' ? -v : v;
    }
    return null;
  };

  // ---------- Datas ----------
  U.dateKey = (y, m, d) => y + '-' + U.pad2(m) + '-' + U.pad2(d);

  U.isDateKey = function (s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  };

  U.dayNumber = function (dateKey) { // dias desde 1970-01-01
    const [y, m, d] = dateKey.split('-').map(Number);
    return Math.round(Date.UTC(y, m - 1, d) / 86400000);
  };

  U.fromDayNumber = function (n) {
    const dt = new Date(n * 86400000);
    return U.dateKey(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  };

  U.addDays = (dateKey, n) => U.fromDayNumber(U.dayNumber(dateKey) + n);
  U.weekday = (dateKey) => ((U.dayNumber(dateKey) % 7) + 7 + 4) % 7; // 1970-01-01 foi quinta (4)

  U.fmtDate = function (dateKey) {
    if (!dateKey) return '';
    const [y, m, d] = dateKey.split('-');
    return d + '/' + m + '/' + y;
  };

  U.fmtDateTimeISO = function (iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    return U.pad2(d.getDate()) + '/' + U.pad2(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + U.pad2(d.getHours()) + ':' + U.pad2(d.getMinutes());
  };

  U.todayKey = function () {
    const d = new Date();
    return U.dateKey(d.getFullYear(), d.getMonth() + 1, d.getDate());
  };

  U.nowISO = () => new Date().toISOString();

  // ---------- Competências "AAAA-MM" ----------
  U.isComp = (c) => typeof c === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(c);
  U.compOf = (dateKey) => dateKey.slice(0, 7);
  U.compLabel = function (c) {
    const [y, m] = c.split('-').map(Number);
    return U.MONTHS[m - 1] + '/' + y;
  };
  U.nextComp = function (c) {
    let [y, m] = c.split('-').map(Number);
    m++; if (m > 12) { m = 1; y++; }
    return y + '-' + U.pad2(m);
  };
  U.prevComp = function (c) {
    let [y, m] = c.split('-').map(Number);
    m--; if (m < 1) { m = 12; y--; }
    return y + '-' + U.pad2(m);
  };
  U.cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0); // funciona para "AAAA-MM" e "AAAA-MM-DD"
  U.compDays = function (c) {
    const [y, m] = c.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const out = [];
    for (let d = 1; d <= last; d++) out.push(U.dateKey(y, m, d));
    return out;
  };
  U.compLastDay = (c) => { const ds = U.compDays(c); return ds[ds.length - 1]; };

  // ---------- Data e hora de marcação: "AAAA-MM-DD HH:MM" ----------
  U.isDT = function (s) {
    if (typeof s !== 'string') return false;
    const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/.exec(s);
    return !!m && U.isDateKey(m[1]) && U.parseHM(m[2]) !== null;
  };
  U.dtDate = (dt) => dt.slice(0, 10);
  U.dtTime = (dt) => dt.slice(11, 16);
  /** minutos absolutos desde 1970 (para ordenar e subtrair marcações). */
  U.dtAbs = (dt) => U.dayNumber(U.dtDate(dt)) * 1440 + U.parseHM(U.dtTime(dt));
  U.absDT = (abs) => U.fromDayNumber(Math.floor(abs / 1440)) + ' ' + U.hm(abs);

  // ---------- Identificadores, texto e validações ----------
  U.uid = function () {
    if (root.crypto && typeof root.crypto.randomUUID === 'function') return root.crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
  };

  U.esc = function (v) {
    if (v === null || v === undefined) return '';
    return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  };

  U.onlyDigits = (s) => String(s || '').replace(/\D/g, '');

  U.validCPF = function (cpf) {
    const c = U.onlyDigits(cpf);
    if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
    let s = 0;
    for (let i = 0; i < 9; i++) s += +c[i] * (10 - i);
    let d1 = (s * 10) % 11; if (d1 === 10) d1 = 0;
    if (d1 !== +c[9]) return false;
    s = 0;
    for (let i = 0; i < 10; i++) s += +c[i] * (11 - i);
    let d2 = (s * 10) % 11; if (d2 === 10) d2 = 0;
    return d2 === +c[10];
  };

  U.fmtCPF = function (cpf) {
    const c = U.onlyDigits(cpf);
    if (c.length !== 11) return cpf || '';
    return c.slice(0, 3) + '.' + c.slice(3, 6) + '.' + c.slice(6, 9) + '-' + c.slice(9);
  };

  U.fmtMoney = function (v) {
    if (v === null || v === undefined || v === '' || isNaN(v)) return '';
    return Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  };

  /** Cópia profunda de dados JSON. */
  U.clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));

  // ---------- Base64 (preserva os bytes originais dos arquivos importados) ----------
  U.bytesToB64 = function (bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  U.b64ToBytes = function (b64) {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  };

  // ---------- Hash (integridade de backup e de arquivos importados) ----------
  function fnv1a(str) {
    let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x5bd1e995;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
    }
    return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
  }

  /** SHA-256 em hexadecimal; usa FNV-1a se a Web Crypto não estiver disponível. */
  U.hash = async function (str) {
    const subtle = root.crypto && root.crypto.subtle;
    if (subtle && typeof TextEncoder !== 'undefined') {
      try {
        const buf = await subtle.digest('SHA-256', new TextEncoder().encode(str));
        return { algoritmo: 'SHA-256', valor: Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('') };
      } catch (e) { /* cai no fallback */ }
    }
    return { algoritmo: 'FNV-1a-64', valor: fnv1a(str) };
  };

  U.hashWith = async function (algoritmo, str) {
    if (algoritmo === 'FNV-1a-64') return fnv1a(str);
    const r = await U.hash(str);
    return r.algoritmo === algoritmo ? r.valor : null;
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = U;
  else { root.Ponto = root.Ponto || {}; root.Ponto.util = U; }
})(typeof globalThis !== 'undefined' ? globalThis : this);
