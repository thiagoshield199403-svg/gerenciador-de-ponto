/*
 * db.js — Adaptadores de armazenamento.
 *
 *  - IndexedDBAdapter: armazenamento principal no navegador. Ao contrário do
 *    localStorage, suporta transações (todas as gravações de uma operação são
 *    confirmadas juntas ou nenhuma é) e volumes maiores de dados.
 *  - MemoryAdapter: mesma interface, só em memória; usado nos testes automatizados.
 *
 * Nenhum dos dois substitui o BACKUP EXTERNO (arquivo .json guardado fora do navegador).
 */
(function (root) {
  'use strict';

  const DB_NAME = 'gerenciador-ponto';
  const DB_VERSION = 1;
  const STORES = ['config', 'funcionarios', 'marcacoes', 'ajustes', 'eventos', 'lancamentos',
    'fechamentos', 'conferencias', 'importacoes', 'auditoria'];
  const INTERNAL_STORES = ['copiasSeguranca']; // cópia automática antes de restaurar; fica fora do backup

  const clone = (o) => JSON.parse(JSON.stringify(o));

  function req2p(req) {
    return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  }

  function erroSomenteLeitura() {
    const e = new Error('Gravação bloqueada: esta aba está em modo somente leitura.');
    e.name = 'ErroRegra';
    return e;
  }

  class IndexedDBAdapter {
    constructor(name) { this.name = name || DB_NAME; this.db = null; this.somenteLeitura = false; }

    /** Segunda barreira (além do Store): com false, qualquer gravação é recusada. */
    permitirEscrita(sim) { this.somenteLeitura = !sim; }

    async open() {
      if (!root.indexedDB) throw new Error('Este navegador não oferece IndexedDB.');
      this.db = await new Promise((res, rej) => {
        const r = root.indexedDB.open(this.name, DB_VERSION);
        r.onupgradeneeded = () => {
          const db = r.result;
          for (const s of STORES.concat(INTERNAL_STORES)) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
        r.onblocked = () => rej(new Error('O banco de dados está bloqueado por outra aba aberta. Feche as outras abas do sistema e recarregue.'));
      });
      this.db.onversionchange = () => { this.db.close(); };
      return this;
    }

    async getAll(store) {
      const tx = this.db.transaction(store, 'readonly');
      return req2p(tx.objectStore(store).getAll());
    }

    async get(store, id) {
      const tx = this.db.transaction(store, 'readonly');
      const v = await req2p(tx.objectStore(store).get(id));
      return v === undefined ? null : v;
    }

    /**
     * Executa várias operações em UMA transação.
     * ops: [{op:'put', store, value} | {op:'delete', store, id} | {op:'clear', store}]
     */
    async write(ops) {
      if (this.somenteLeitura) throw erroSomenteLeitura();
      const stores = [...new Set(ops.map((o) => o.store))];
      if (!stores.length) return;
      await new Promise((res, rej) => {
        const tx = this.db.transaction(stores, 'readwrite');
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
        tx.onabort = () => rej(tx.error || new Error('Transação cancelada.'));
        try {
          for (const o of ops) {
            const st = tx.objectStore(o.store);
            if (o.op === 'put') st.put(clone(o.value));
            else if (o.op === 'delete') st.delete(o.id);
            else if (o.op === 'clear') st.clear();
          }
        } catch (e) {
          // Erro síncrono ao enfileirar (ex.: registro sem chave): cancela TODO o lote,
          // senão as operações já enfileiradas (inclusive "clear") seriam gravadas.
          try { tx.abort(); } catch (e2) { /* transação já finalizada */ }
          rej(e);
        }
      });
    }
  }

  class MemoryAdapter {
    constructor() { this.data = {}; this.somenteLeitura = false; for (const s of STORES.concat(INTERNAL_STORES)) this.data[s] = new Map(); }
    permitirEscrita(sim) { this.somenteLeitura = !sim; }
    async open() { return this; }
    async getAll(store) { return [...this.data[store].values()].map(clone); }
    async get(store, id) { const v = this.data[store].get(id); return v === undefined ? null : clone(v); }
    async write(ops) {
      if (this.somenteLeitura) throw erroSomenteLeitura();
      // Simula atomicidade: valida tudo antes de aplicar.
      for (const o of ops) if (!this.data[o.store]) throw new Error('Store inexistente: ' + o.store);
      for (const o of ops) if (o.op === 'put' && (o.value === null || o.value.id === undefined)) throw new Error('Registro sem id.');
      for (const o of ops) {
        if (o.op === 'put') this.data[o.store].set(o.value.id, clone(o.value));
        else if (o.op === 'delete') this.data[o.store].delete(o.id);
        else if (o.op === 'clear') this.data[o.store].clear();
      }
    }
  }

  const api = { STORES, INTERNAL_STORES, IndexedDBAdapter, MemoryAdapter, DB_NAME };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Ponto = root.Ponto || {}; root.Ponto.db = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this);
