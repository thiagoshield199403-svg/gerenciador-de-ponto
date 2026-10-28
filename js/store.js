/*
 * store.js — Serviço de dados e regras de negócio.
 *
 * - Mantém uma cópia em memória (cache) de todas as coleções para leitura rápida.
 * - Toda gravação passa por _commit(): grava no banco em UMA transação e só
 *   depois atualiza o cache, sempre acompanhada de um registro de auditoria.
 * - Marcações originais (relógio/importação) NUNCA são alteradas nem apagadas.
 *   Correções são registradas como AJUSTES (inclusão, alteração, desconsideração,
 *   restauração), cada um com justificativa, data e hora.
 * - Competências fechadas ficam protegidas: qualquer alteração que as afete
 *   exige reabertura com justificativa.
 */
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports;
  const U = isNode ? require('./util.js') : root.Ponto.util;
  const C = isNode ? require('./calc.js') : root.Ponto.calc;
  const B = isNode ? require('./bank.js') : root.Ponto.bank;
  const I = isNode ? require('./importer.js') : root.Ponto.importer;
  const BK = isNode ? require('./backup.js') : root.Ponto.backup;
  const DB = isNode ? require('./db.js') : root.Ponto.db;

  const VERSAO_SISTEMA = '1.0.0';
  const MSG_SOMENTE_LEITURA = 'O sistema já está aberto em outra aba. Esta aba está em modo somente leitura.';

  class ErroRegra extends Error { constructor(msg) { super(msg); this.name = 'ErroRegra'; } }

  const exigir = (cond, msg) => { if (!cond) throw new ErroRegra(msg); };
  const exigirJustificativa = (j) => exigir(typeof j === 'string' && j.trim().length >= 3, 'Informe uma justificativa (mínimo de 3 caracteres).');

  class Store {
    constructor(adapter, opts) {
      opts = opts || {};
      this.db = adapter;
      this.hoje = opts.hoje || (() => U.todayKey());
      this.agora = opts.agora || (() => U.nowISO());
      this.c = {};
      this.ouvintes = [];
      this._seq = 0;
      // Modo de escrita: somente a aba que detém o bloqueio de edição grava (ver app.js).
      this.editavel = opts.editavel !== false;
      this.motivoSomenteLeitura = opts.motivoSomenteLeitura || MSG_SOMENTE_LEITURA;
      // Fila de escrita: operações de gravação desta aba são executadas uma de cada vez,
      // para que validações (duplicidade, competência fechada...) e gravação não se intercalem.
      this._fila = Promise.resolve();
      this.escritasPendentes = 0;
      for (const nome of Store.OPERACOES_ESCRITA) {
        const original = Store.prototype[nome];
        this[nome] = (...args) => {
          try { this._exigirEscrita(); } catch (e) { return Promise.reject(e); }
          return this._enfileirar(() => { this._exigirEscrita(); return original.apply(this, args); });
        };
      }
      // Exportar também entra na fila: o arquivo gerado e o zeramento do contador de alterações
      // refletem o mesmo estado (sem isso, uma gravação concluída durante a exportação ficaria
      // fora do arquivo e o contador seria zerado). Continua permitido em somente leitura.
      this.exportarBackup = (...args) => this._enfileirar(() => Store.prototype.exportarBackup.apply(this, args));
      this.gerarBackupParaEnvio = (...args) => this._enfileirar(() => Store.prototype.gerarBackupParaEnvio.apply(this, args));
    }

    _enfileirar(fn) {
      this.escritasPendentes++;
      const exec = this._fila.then(fn);
      this._fila = exec.catch(() => { /* um erro não trava a fila */ });
      return exec.finally(() => { this.escritasPendentes--; });
    }

    static get VERSAO() { return VERSAO_SISTEMA; }

    /** Métodos que gravam dados. Todos passam pela fila e pela verificação de modo de escrita. */
    static get OPERACOES_ESCRITA() {
      return ['salvarEmpregador', 'salvarPolitica', 'salvarPerfilImportacao', 'salvarFuncionario', 'inativarFuncionario',
        'reativarFuncionario', 'criarDemo', 'removerDemo', 'incluirMarcacao', 'alterarMarcacao', 'desconsiderarMarcacao',
        'restaurarMarcacao', 'registrarEvento', 'cancelarEvento', 'conferirDia', 'desfazerConferencia', 'salvarObservacaoDia',
        'lancarBanco', 'cancelarLancamento', 'fechar', 'reabrir', 'atualizarSaldosPosteriores', 'confirmarImportacao',
        'desconsiderarImportacao', 'restaurarBackup', 'registrarEnvioDrive'];
    }

    _exigirEscrita() { if (!this.editavel) throw new ErroRegra(this.motivoSomenteLeitura); }

    /** Bloqueia (false) ou libera (true) a escrita nesta instância e no adaptador. */
    async definirEscrita(editavel, motivo) {
      if (motivo) this.motivoSomenteLeitura = motivo;
      if (!editavel) {
        this.editavel = false;
        if (this.db.permitirEscrita) this.db.permitirEscrita(false);
        return;
      }
      if (this.db.permitirEscrita) this.db.permitirEscrita(true);
      this.editavel = true;
      try {
        await this.recarregar(); // a memória desta aba pode estar desatualizada
        await this._garantirSistema();
      } catch (e) {
        // Sem dados atualizados esta aba não pode editar (e o app libera o bloqueio): volta a recusar gravações.
        this.editavel = false;
        if (this.db.permitirEscrita) this.db.permitirEscrita(false);
        throw e;
      }
    }

    async _garantirSistema() {
      if (this.editavel && !this.cfg('sistema')) {
        await this._commit([{ op: 'put', store: 'config', value: { id: 'sistema', criadoEm: this.agora(), ultimoBackupEm: null, alteracoesDesdeBackup: 0 } }], null, { semContador: true });
      }
    }

    async init() {
      if (!this.editavel && this.db.permitirEscrita) this.db.permitirEscrita(false);
      await this.db.open();
      await this.recarregar();
      await this._garantirSistema();
      return this;
    }

    async recarregar() {
      for (const s of DB.STORES) {
        const all = await this.db.getAll(s);
        this.c[s] = new Map(all.map((r) => [r.id, r]));
      }
    }

    aoAlterar(fn) { this.ouvintes.push(fn); }

    // ------------------------------------------------------------------ infraestrutura
    // this._seq desempata registros criados no mesmo milissegundo (ordem estável dos ajustes).
    async _commit(ops, auditoria, opts) {
      this._exigirEscrita();
      opts = opts || {};
      ops = ops.slice();
      const auds = auditoria ? (Array.isArray(auditoria) ? auditoria : [auditoria]) : [];
      for (const a of auds) {
        ops.push({ op: 'put', store: 'auditoria', value: Object.assign({ id: U.uid(), em: this.agora(), seq: this._seq++ }, a) });
      }
      if (!opts.semContador) {
        const sis = Object.assign({}, this.cfg('sistema') || { id: 'sistema' });
        sis.alteracoesDesdeBackup = (sis.alteracoesDesdeBackup || 0) + 1;
        sis.ultimaAlteracaoEm = this.agora();
        ops.push({ op: 'put', store: 'config', value: sis });
      }
      await this.db.write(ops);
      for (const o of ops) {
        if (o.op === 'put') this.c[o.store].set(o.value.id, U.clone(o.value));
        else if (o.op === 'delete') this.c[o.store].delete(o.id);
        else if (o.op === 'clear') this.c[o.store].clear();
      }
      this.ouvintes.forEach((fn) => { try { fn(); } catch (e) { /* ignora */ } });
    }

    all(store) { return [...this.c[store].values()]; }
    get(store, id) { const v = this.c[store].get(id); return v ? U.clone(v) : null; }
    cfg(id) { const v = this.c.config.get(id); return v ? U.clone(v) : null; }

    // ------------------------------------------------------------------ configurações
    empregador() { return Object.assign({ nome: '', documento: '', endereco: '', responsavel: '' }, this.cfg('empregador') || {}); }

    async salvarEmpregador(d) {
      const v = { id: 'empregador', nome: (d.nome || '').trim(), documento: (d.documento || '').trim(), endereco: (d.endereco || '').trim(), responsavel: (d.responsavel || '').trim() };
      await this._commit([{ op: 'put', store: 'config', value: v }], { acao: 'config-empregador', entidade: 'config', descricao: 'Dados do empregador atualizados.' });
    }

    politica() { return B.politica(this.cfg('politica')); }

    async salvarPolitica(p) {
      const v = Object.assign({ id: 'politica' }, B.politica(p));
      ['limitePositivoMin', 'limiteNegativoMin'].forEach((k) => {
        if (v[k] === '' || v[k] === undefined) v[k] = null;
        exigir(v[k] === null || Number.isInteger(v[k]), 'Limite inválido.');
      });
      v.creditosNoBanco = !!v.creditosNoBanco; v.debitosNoBanco = !!v.debitosNoBanco;
      await this._commit([{ op: 'put', store: 'config', value: v }], { acao: 'config-politica', entidade: 'config', descricao: 'Política do banco de horas atualizada.', detalhes: v });
    }

    sistema() { return this.cfg('sistema') || {}; }

    perfisImportacao() { return (this.cfg('perfisImportacao') || { perfis: [] }).perfis; }

    async salvarPerfilImportacao(nome, mapeamento) {
      exigir(nome && nome.trim(), 'Informe um nome para o perfil.');
      const perfis = this.perfisImportacao().filter((p) => p.nome !== nome.trim());
      perfis.push({ nome: nome.trim(), mapeamento: U.clone(mapeamento), salvoEm: this.agora() });
      await this._commit([{ op: 'put', store: 'config', value: { id: 'perfisImportacao', perfis } }], { acao: 'config-perfil-importacao', entidade: 'config', descricao: 'Perfil de importação "' + nome.trim() + '" salvo.' });
    }

    // ------------------------------------------------------------------ funcionários
    funcionarios(opts) {
      opts = opts || {};
      return this.all('funcionarios')
        .filter((f) => !opts.ativos || f.situacao === 'ativo')
        .sort((a, b) => (a.demo - b.demo) || a.nome.localeCompare(b.nome, 'pt-BR'))
        .map(U.clone);
    }

    funcionario(id) { return this.get('funcionarios', id); }

    validarFuncionario(f) {
      const erros = [];
      if (!f.nome || f.nome.trim().length < 3) erros.push('Informe o nome completo.');
      if (f.cpf && !U.validCPF(f.cpf)) erros.push('CPF inválido.');
      if (!U.isDateKey(f.admissao)) erros.push('Informe a data de admissão.');
      if (f.desligamento && !U.isDateKey(f.desligamento)) erros.push('Data de desligamento inválida.');
      if (f.desligamento && f.admissao && f.desligamento < f.admissao) erros.push('Desligamento anterior à admissão.');
      if (f.salario !== null && f.salario !== undefined && f.salario !== '' && (isNaN(f.salario) || f.salario < 0)) erros.push('Salário inválido.');
      if (f.codigoRelogio) {
        const dup = this.all('funcionarios').find((o) => o.id !== f.id && o.situacao === 'ativo' && o.codigoRelogio && o.codigoRelogio.trim() === f.codigoRelogio.trim());
        if (dup) erros.push('O identificador do relógio "' + f.codigoRelogio + '" já pertence a ' + dup.nome + '.');
      }
      if (!f.jornada || !Array.isArray(f.jornada.semana)) erros.push('Configure a jornada semanal.');
      else erros.push(...C.validarSemana(f.jornada.semana));
      const rg = (f.jornada && f.jornada.regras) || {};
      ['toleranciaDiariaMin', 'janelaDuplicidadeMin', 'intervaloMinimoMin', 'limiteForaJornadaMin', 'jornadaMaximaMin'].forEach((k) => {
        if (rg[k] !== undefined && (!Number.isInteger(rg[k]) || rg[k] < 0)) erros.push('Regra "' + k + '" inválida.');
      });
      if (rg.horaCorteVirada && U.parseHM(rg.horaCorteVirada) === null) erros.push('Hora de corte de virada inválida.');
      const bk = f.banco || {};
      if (bk.compInicial && !U.isComp(bk.compInicial)) erros.push('Competência inicial do banco inválida.');
      if (bk.saldoInicialMin !== undefined && !Number.isInteger(bk.saldoInicialMin)) erros.push('Saldo inicial do banco inválido.');
      return erros;
    }

    async salvarFuncionario(dados) {
      const atual = dados.id ? this.funcionario(dados.id) : null;
      const f = Object.assign({}, atual || {}, U.clone(dados));
      f.nome = (f.nome || '').trim();
      f.cpf = f.cpf ? U.onlyDigits(f.cpf) : '';
      f.codigoRelogio = (f.codigoRelogio || '').trim();
      f.salario = (f.salario === '' || f.salario === undefined || f.salario === null) ? null : Number(f.salario);
      f.situacao = f.situacao || 'ativo';
      f.demo = !!f.demo;
      f.banco = Object.assign({ compInicial: '', saldoInicialMin: 0 }, f.banco || {});
      f.jornada = f.jornada || { semana: C.semanaExemplo(), regras: {} };
      f.jornada.regras = Object.assign({}, C.REGRAS_PADRAO, f.jornada.regras || {});
      const erros = this.validarFuncionario(f);
      if (erros.length) throw new ErroRegra(erros.join('\n'));
      if (atual) {
        const temFechada = this.all('fechamentos').some((x) => x.employeeId === f.id && x.status === 'fechada');
        const mudouBanco = JSON.stringify(atual.banco || {}) !== JSON.stringify(f.banco);
        exigir(!(temFechada && mudouBanco), 'O saldo inicial do banco não pode ser alterado depois que existem competências fechadas. Reabra as competências fechadas antes.');
      }
      const agora = this.agora();
      if (!atual) { f.id = U.uid(); f.criadoEm = agora; }
      f.atualizadoEm = agora;
      await this._commit([{ op: 'put', store: 'funcionarios', value: f }], {
        acao: atual ? 'funcionario-editado' : 'funcionario-criado', entidade: 'funcionarios', entidadeId: f.id, employeeId: f.id,
        descricao: (atual ? 'Cadastro alterado: ' : 'Funcionário cadastrado: ') + f.nome,
        detalhes: atual ? { antes: atual, depois: f } : null
      });
      return f;
    }

    async inativarFuncionario(id, motivo, desligamento) {
      exigirJustificativa(motivo);
      const f = this.funcionario(id); exigir(f, 'Funcionário não encontrado.');
      exigir(!desligamento || U.isDateKey(desligamento), 'Data de desligamento inválida.');
      f.situacao = 'inativo'; f.inativadoEm = this.agora(); f.motivoInativacao = motivo.trim();
      if (desligamento) f.desligamento = desligamento;
      f.atualizadoEm = this.agora();
      await this._commit([{ op: 'put', store: 'funcionarios', value: f }], { acao: 'funcionario-inativado', entidade: 'funcionarios', entidadeId: id, employeeId: id, descricao: 'Funcionário inativado: ' + f.nome + '. Motivo: ' + motivo.trim() });
    }

    async reativarFuncionario(id, motivo) {
      exigirJustificativa(motivo);
      const f = this.funcionario(id); exigir(f, 'Funcionário não encontrado.');
      f.situacao = 'ativo'; f.atualizadoEm = this.agora();
      const erros = this.validarFuncionario(f);
      if (erros.length) throw new ErroRegra(erros.join('\n'));
      await this._commit([{ op: 'put', store: 'funcionarios', value: f }], { acao: 'funcionario-reativado', entidade: 'funcionarios', entidadeId: id, employeeId: id, descricao: 'Funcionário reativado: ' + f.nome + '. Motivo: ' + motivo.trim() });
    }

    // ------------------------------------------------------------------ dados demonstrativos
    temDemo() { return this.all('funcionarios').some((f) => f.demo); }

    async criarDemo() {
      exigir(!this.temDemo(), 'Os dados demonstrativos já existem.');
      const hoje = this.hoje();
      const compAnt = U.prevComp(U.compOf(hoje));
      const f = await Store.prototype.salvarFuncionario.call(this, { // chamada interna: já está na fila de escrita
        nome: 'EXEMPLO — Funcionária Demonstrativa', cpf: '', cargo: 'Vendedora (exemplo)', admissao: compAnt + '-01',
        codigoRelogio: '9999', regime: 'CLT — jornada semanal (exemplo)', cargaSemanalMin: 40 * 60, demo: true,
        observacoes: 'Registro fictício para conhecer o sistema. Não representa pessoa real. Remova antes do uso real.',
        jornada: { semana: C.semanaExemplo(), regras: {} }, banco: { compInicial: compAnt, saldoInicialMin: 0 }
      });
      // Marcações fictícias no mês anterior, com algumas variações e uma inconsistência proposital.
      const ops = [];
      const variacoes = [[0, 0, 0, 0], [12, 0, 0, 0], [0, 0, 0, 25], [-5, 0, 0, 40], [0, 0, 5, -30]];
      let i = 0;
      for (const d of U.compDays(compAnt)) {
        const wd = U.weekday(d);
        if (wd === 0 || wd === 6) continue;
        const v = variacoes[i % variacoes.length];
        const base = ['09:00', '12:00', '14:00', '19:00'].map((h, k) => U.hm(U.parseHM(h) + v[k]));
        const lista = (i === 7) ? base.slice(0, 3) : base; // dia com batida faltando, para demonstrar a conferência
        i++;
        for (const h of lista) {
          const dt = d + ' ' + h;
          ops.push({ op: 'put', store: 'marcacoes', value: { id: U.uid(), employeeId: f.id, dt, dataRef: C.dataReferencia(f, dt), origem: 'exemplo', importId: null, criadoEm: this.agora() } });
        }
      }
      await this._commit(ops, { acao: 'demo-criado', entidade: 'funcionarios', entidadeId: f.id, employeeId: f.id, descricao: 'Dados demonstrativos criados (' + ops.length + ' marcações fictícias).' });
      return f;
    }

    async removerDemo() {
      const demos = this.all('funcionarios').filter((f) => f.demo);
      exigir(demos.length, 'Não há dados demonstrativos.');
      const ids = new Set(demos.map((f) => f.id));
      const ops = [];
      for (const s of ['funcionarios', 'marcacoes', 'ajustes', 'eventos', 'lancamentos', 'fechamentos', 'conferencias']) {
        for (const r of this.all(s)) if (ids.has(s === 'funcionarios' ? r.id : r.employeeId)) ops.push({ op: 'delete', store: s, id: r.id });
      }
      await this._commit(ops, { acao: 'demo-removido', entidade: 'funcionarios', descricao: 'Dados demonstrativos removidos (' + ops.length + ' registros fictícios).' });
    }

    // ------------------------------------------------------------------ competências fechadas
    fechamento(empId, comp) { return this.get('fechamentos', empId + '|' + comp); }

    compFechada(empId, comp) {
      const f = this.c.fechamentos.get(empId + '|' + comp);
      return !!(f && f.status === 'fechada');
    }

    _exigirAberto(empId, data) {
      const comp = U.compOf(data);
      const ids = empId ? [empId] : this.all('funcionarios').map((f) => f.id);
      for (const id of ids) {
        if (this.compFechada(id, comp)) {
          const nome = empId ? '' : ' para ' + this.c.funcionarios.get(id).nome;
          throw new ErroRegra('A competência ' + U.compLabel(comp) + ' está fechada' + nome + '. Reabra-a, com justificativa, antes de alterar.');
        }
      }
    }

    // ------------------------------------------------------------------ marcações efetivas
    /**
     * Marcações efetivas de um funcionário: originais (exceto importações desconsideradas)
     * + inclusões manuais, com alterações/desconsiderações aplicadas em ordem cronológica.
     */
    efetivas(empId) {
      const impDesc = new Set(this.all('importacoes').filter((i) => i.desconsiderada).map((i) => i.id));
      const mapa = new Map();
      for (const m of this.all('marcacoes')) {
        if (m.employeeId !== empId) continue;
        mapa.set('p:' + m.id, {
          ref: 'p:' + m.id, dt: m.dt, dataRef: m.dataRef, origem: m.origem, importId: m.importId || null,
          original: { dt: m.dt, dataRef: m.dataRef }, ajustada: false, removida: impDesc.has(m.importId), removidaPorImportacao: impDesc.has(m.importId), ajustes: []
        });
      }
      const ajustes = this.all('ajustes').filter((a) => a.employeeId === empId).sort((a, b) => U.cmp(a.criadoEm, b.criadoEm) || (a.seq || 0) - (b.seq || 0));
      for (const a of ajustes) {
        if (a.tipo === 'inclusao') {
          mapa.set('a:' + a.id, { ref: 'a:' + a.id, dt: a.dt, dataRef: a.dataRef, origem: 'manual', importId: null, original: null, ajustada: false, removida: false, ajustes: [a] });
        }
      }
      for (const a of ajustes) {
        if (a.tipo === 'inclusao') continue;
        const m = mapa.get(a.alvo);
        if (!m) continue;
        m.ajustes.push(a);
        if (a.tipo === 'alteracao') { m.dt = a.dt; m.dataRef = a.dataRef; m.ajustada = true; }
        else if (a.tipo === 'desconsiderar') m.removida = true;
        else if (a.tipo === 'restaurar') m.removida = m.removidaPorImportacao;
      }
      return [...mapa.values()].sort((a, b) => U.dtAbs(a.dt) - U.dtAbs(b.dt));
    }

    _marcacaoEfetiva(empId, ref) {
      const m = this.efetivas(empId).find((x) => x.ref === ref);
      exigir(m, 'Marcação não encontrada.');
      return m;
    }

    async incluirMarcacao(empId, dt, justificativa, dataRef) {
      exigirJustificativa(justificativa);
      const f = this.funcionario(empId); exigir(f, 'Funcionário não encontrado.');
      exigir(U.isDT(dt), 'Data e hora inválidas.');
      const ref = dataRef || C.dataReferencia(f, dt);
      exigir(U.isDateKey(ref), 'Data de referência inválida.');
      this._exigirAberto(empId, ref);
      const dup = this.efetivas(empId).find((m) => !m.removida && m.dt === dt);
      exigir(!dup, 'Já existe uma marcação ativa neste mesmo horário.');
      const a = { id: U.uid(), tipo: 'inclusao', employeeId: empId, dt, dataRef: ref, alvo: null, justificativa: justificativa.trim(), criadoEm: this.agora(), seq: this._seq++ };
      await this._commit([{ op: 'put', store: 'ajustes', value: a }], { acao: 'marcacao-incluida', entidade: 'ajustes', entidadeId: a.id, employeeId: empId, data: ref, descricao: 'Marcação incluída manualmente: ' + U.fmtDate(U.dtDate(dt)) + ' ' + U.dtTime(dt) + '. Justificativa: ' + a.justificativa });
      return a;
    }

    async alterarMarcacao(empId, ref, novoDt, justificativa, novaDataRef) {
      exigirJustificativa(justificativa);
      const f = this.funcionario(empId); exigir(f, 'Funcionário não encontrado.');
      exigir(U.isDT(novoDt), 'Data e hora inválidas.');
      const m = this._marcacaoEfetiva(empId, ref);
      exigir(!m.removida, 'A marcação está desconsiderada; restaure-a antes de alterar.');
      exigir(m.dt !== novoDt, 'O novo horário é igual ao atual.');
      const dataRef = novaDataRef || C.dataReferencia(f, novoDt);
      this._exigirAberto(empId, m.dataRef);
      this._exigirAberto(empId, dataRef);
      const a = { id: U.uid(), tipo: 'alteracao', employeeId: empId, alvo: ref, dt: novoDt, dataRef, dtAnterior: m.dt, justificativa: justificativa.trim(), criadoEm: this.agora(), seq: this._seq++ };
      await this._commit([{ op: 'put', store: 'ajustes', value: a }], { acao: 'marcacao-alterada', entidade: 'ajustes', entidadeId: a.id, employeeId: empId, data: dataRef, descricao: 'Marcação alterada de ' + U.fmtDate(U.dtDate(m.dt)) + ' ' + U.dtTime(m.dt) + ' para ' + U.fmtDate(U.dtDate(novoDt)) + ' ' + U.dtTime(novoDt) + '. Justificativa: ' + a.justificativa });
      return a;
    }

    async desconsiderarMarcacao(empId, ref, justificativa) {
      exigirJustificativa(justificativa);
      const m = this._marcacaoEfetiva(empId, ref);
      exigir(!m.removida, 'A marcação já está desconsiderada.');
      this._exigirAberto(empId, m.dataRef);
      const a = { id: U.uid(), tipo: 'desconsiderar', employeeId: empId, alvo: ref, dataRef: m.dataRef, dtAnterior: m.dt, justificativa: justificativa.trim(), criadoEm: this.agora(), seq: this._seq++ };
      await this._commit([{ op: 'put', store: 'ajustes', value: a }], { acao: 'marcacao-desconsiderada', entidade: 'ajustes', entidadeId: a.id, employeeId: empId, data: m.dataRef, descricao: 'Marcação de ' + U.fmtDate(U.dtDate(m.dt)) + ' ' + U.dtTime(m.dt) + ' desconsiderada (o registro original é preservado). Justificativa: ' + a.justificativa });
      return a;
    }

    async restaurarMarcacao(empId, ref, justificativa) {
      exigirJustificativa(justificativa);
      const m = this._marcacaoEfetiva(empId, ref);
      exigir(m.removida && !m.removidaPorImportacao, m.removidaPorImportacao ? 'Esta marcação pertence a uma importação desconsiderada.' : 'A marcação não está desconsiderada.');
      this._exigirAberto(empId, m.dataRef);
      const a = { id: U.uid(), tipo: 'restaurar', employeeId: empId, alvo: ref, dataRef: m.dataRef, justificativa: justificativa.trim(), criadoEm: this.agora(), seq: this._seq++ };
      await this._commit([{ op: 'put', store: 'ajustes', value: a }], { acao: 'marcacao-restaurada', entidade: 'ajustes', entidadeId: a.id, employeeId: empId, data: m.dataRef, descricao: 'Marcação de ' + U.fmtDate(U.dtDate(m.dt)) + ' ' + U.dtTime(m.dt) + ' restaurada. Justificativa: ' + a.justificativa });
      return a;
    }

    /** Histórico completo de uma marcação: original + todos os ajustes. */
    historicoMarcacao(empId, ref) {
      const m = this.efetivas(empId).find((x) => x.ref === ref);
      if (!m) return null;
      return { marcacao: m, ajustes: m.ajustes.slice() };
    }

    // ------------------------------------------------------------------ ocorrências (eventos)
    eventos(filtro) {
      filtro = filtro || {};
      return this.all('eventos').filter((e) => (filtro.incluirCancelados || !e.cancelado)
        && (!filtro.comp || U.compOf(e.data) === filtro.comp)
        && (filtro.employeeId === undefined || e.employeeId === filtro.employeeId || (filtro.incluirGlobais && e.employeeId === null)))
        .sort((a, b) => U.cmp(a.data, b.data)).map(U.clone);
    }

    async registrarEvento(d) {
      exigir(C.TIPOS_EVENTO[d.tipo], 'Tipo de ocorrência inválido.');
      exigir(U.isDateKey(d.data), 'Data inválida.');
      const fim = d.dataFim || d.data;
      exigir(U.isDateKey(fim) && fim >= d.data, 'Data final inválida.');
      exigir(U.dayNumber(fim) - U.dayNumber(d.data) <= 366, 'Período muito longo (máximo de 1 ano).');
      const empId = d.employeeId || null;
      exigir(empId !== null || d.tipo === 'feriado', 'Somente feriados podem valer para todos os funcionários.');
      if (empId) exigir(this.funcionario(empId), 'Funcionário não encontrado.');
      const minutos = C.TIPOS_EVENTO[d.tipo].abonaMinutos ? Math.round(d.minutos || 0) : 0;
      if (C.TIPOS_EVENTO[d.tipo].abonaMinutos) exigir(minutos > 0, 'Informe a quantidade de horas a abonar.');
      if (d.tipo !== 'feriado') exigirJustificativa(d.descricao);
      const ops = [];
      const grupo = U.uid();
      for (let dia = d.data; dia <= fim; dia = U.addDays(dia, 1)) {
        this._exigirAberto(empId, dia);
        const dup = this.all('eventos').find((e) => !e.cancelado && e.data === dia && e.tipo === d.tipo && e.employeeId === empId);
        exigir(!dup, 'Já existe "' + C.TIPOS_EVENTO[d.tipo].nome + '" registrado em ' + U.fmtDate(dia) + '.');
        ops.push({ op: 'put', store: 'eventos', value: { id: U.uid(), grupo, employeeId: empId, data: dia, tipo: d.tipo, descricao: (d.descricao || '').trim(), minutos, criadoEm: this.agora(), cancelado: null } });
      }
      await this._commit(ops, { acao: 'ocorrencia-registrada', entidade: 'eventos', entidadeId: grupo, employeeId: empId, data: d.data, descricao: C.TIPOS_EVENTO[d.tipo].nome + ' em ' + U.fmtDate(d.data) + (fim !== d.data ? ' a ' + U.fmtDate(fim) : '') + (d.descricao ? ': ' + d.descricao.trim() : '') });
      return ops.map((o) => o.value);
    }

    async cancelarEvento(id, motivo) {
      exigirJustificativa(motivo);
      const e = this.get('eventos', id); exigir(e && !e.cancelado, 'Ocorrência não encontrada.');
      this._exigirAberto(e.employeeId, e.data);
      e.cancelado = { em: this.agora(), motivo: motivo.trim() };
      await this._commit([{ op: 'put', store: 'eventos', value: e }], { acao: 'ocorrencia-cancelada', entidade: 'eventos', entidadeId: id, employeeId: e.employeeId, data: e.data, descricao: C.TIPOS_EVENTO[e.tipo].nome + ' de ' + U.fmtDate(e.data) + ' cancelada. Motivo: ' + motivo.trim() });
    }

    // ------------------------------------------------------------------ conferência diária
    conferencia(empId, data) { return this.get('conferencias', empId + '|' + data); }

    async conferirDia(empId, data, obs) {
      this._exigirAberto(empId, data);
      const ap = this.apurarMes(empId, U.compOf(data)).dias.find((d) => d.data === data);
      exigir(ap, 'Dia não encontrado.');
      exigir(!ap.ocorrencias.some((o) => o.nivel === 'erro'), 'Este dia tem inconsistências que impedem a apuração (ex.: marcação faltando). Corrija antes de conferir.');
      const atual = this.conferencia(empId, data) || {};
      const v = Object.assign(atual, { id: empId + '|' + data, employeeId: empId, data, assinatura: ap.assinatura, conferidoEm: this.agora(), obs: obs !== undefined ? obs : (atual.obs || '') });
      await this._commit([{ op: 'put', store: 'conferencias', value: v }], { acao: 'dia-conferido', entidade: 'conferencias', entidadeId: v.id, employeeId: empId, data, descricao: 'Dia ' + U.fmtDate(data) + ' conferido.' + (v.obs ? ' Obs.: ' + v.obs : '') });
    }

    async desfazerConferencia(empId, data) {
      this._exigirAberto(empId, data);
      const v = this.conferencia(empId, data); exigir(v && v.assinatura, 'O dia não está conferido.');
      v.assinatura = null; v.conferidoEm = null;
      await this._commit([{ op: 'put', store: 'conferencias', value: v }], { acao: 'conferencia-desfeita', entidade: 'conferencias', entidadeId: v.id, employeeId: empId, data, descricao: 'Conferência do dia ' + U.fmtDate(data) + ' desfeita.' });
    }

    async salvarObservacaoDia(empId, data, obs) {
      this._exigirAberto(empId, data);
      const v = this.conferencia(empId, data) || { id: empId + '|' + data, employeeId: empId, data, assinatura: null, conferidoEm: null };
      v.obs = (obs || '').trim();
      await this._commit([{ op: 'put', store: 'conferencias', value: v }], { acao: 'observacao-dia', entidade: 'conferencias', entidadeId: v.id, employeeId: empId, data, descricao: 'Observação do dia ' + U.fmtDate(data) + ': ' + (v.obs || '(removida)') });
    }

    // ------------------------------------------------------------------ lançamentos do banco
    lancamentos(empId, comp, incluirCancelados) {
      return this.all('lancamentos').filter((l) => l.employeeId === empId && (!comp || U.compOf(l.data) === comp) && (incluirCancelados || !l.cancelado))
        .sort((a, b) => U.cmp(a.data, b.data)).map(U.clone);
    }

    async lancarBanco(d) {
      exigir(['ajuste', 'compensacao'].includes(d.tipo), 'Tipo de lançamento inválido.');
      exigir(this.funcionario(d.employeeId), 'Funcionário não encontrado.');
      exigir(U.isDateKey(d.data), 'Data inválida.');
      exigir(Number.isInteger(d.minutos) && d.minutos !== 0, 'Informe uma quantidade de horas diferente de zero.');
      exigirJustificativa(d.justificativa);
      this._exigirAberto(d.employeeId, d.data);
      const ini = B.compInicial(this.funcionario(d.employeeId));
      exigir(!ini || U.compOf(d.data) >= ini, 'A data é anterior ao início do banco de horas deste funcionário.');
      const l = { id: U.uid(), employeeId: d.employeeId, data: d.data, tipo: d.tipo, minutos: d.minutos, justificativa: d.justificativa.trim(), criadoEm: this.agora(), cancelado: null };
      await this._commit([{ op: 'put', store: 'lancamentos', value: l }], { acao: 'banco-lancamento', entidade: 'lancamentos', entidadeId: l.id, employeeId: l.employeeId, data: l.data, descricao: (l.tipo === 'ajuste' ? 'Ajuste' : 'Compensação') + ' de ' + U.saldo(l.minutos) + ' em ' + U.fmtDate(l.data) + '. Justificativa: ' + l.justificativa });
      return l;
    }

    async cancelarLancamento(id, motivo) {
      exigirJustificativa(motivo);
      const l = this.get('lancamentos', id); exigir(l && !l.cancelado, 'Lançamento não encontrado.');
      this._exigirAberto(l.employeeId, l.data);
      l.cancelado = { em: this.agora(), motivo: motivo.trim() };
      await this._commit([{ op: 'put', store: 'lancamentos', value: l }], { acao: 'banco-lancamento-cancelado', entidade: 'lancamentos', entidadeId: id, employeeId: l.employeeId, data: l.data, descricao: 'Lançamento de ' + U.saldo(l.minutos) + ' em ' + U.fmtDate(l.data) + ' cancelado. Motivo: ' + motivo.trim() });
    }

    // ------------------------------------------------------------------ apuração e banco
    /** Apuração AO VIVO de uma competência (ignora fechamento). */
    apurarMes(empId, comp) {
      const emp = this.funcionario(empId);
      exigir(emp, 'Funcionário não encontrado.');
      const efet = this.efetivas(empId);
      const marcacoesPorDia = {}, removidasPorDia = {};
      for (const m of efet) {
        if (U.compOf(m.dataRef) !== comp) continue;
        const item = { ref: m.ref, dt: m.dt, origem: m.origem, ajustada: m.ajustada, original: m.original ? m.original.dt : null, importId: m.importId };
        if (m.removida) (removidasPorDia[m.dataRef] = removidasPorDia[m.dataRef] || []).push(Object.assign(item, { motivo: (m.ajustes.filter((a) => a.tipo === 'desconsiderar').pop() || {}).justificativa || (m.removidaPorImportacao ? 'importação desconsiderada' : '') }));
        else (marcacoesPorDia[m.dataRef] = marcacoesPorDia[m.dataRef] || []).push(item);
      }
      const eventosPorDia = {};
      for (const e of this.all('eventos')) {
        if (e.cancelado || U.compOf(e.data) !== comp) continue;
        if (e.employeeId !== null && e.employeeId !== empId) continue;
        (eventosPorDia[e.data] = eventosPorDia[e.data] || []).push(e);
      }
      const conferencias = {};
      for (const cf of this.all('conferencias')) if (cf.employeeId === empId && U.compOf(cf.data) === comp && cf.assinatura) conferencias[cf.data] = cf;
      const ap = C.apurarMes(emp, comp, { marcacoesPorDia, eventosPorDia, conferencias, hoje: this.hoje() });
      for (const d of ap.dias) {
        d.removidas = removidasPorDia[d.data] || [];
        const cf = this.c.conferencias.get(empId + '|' + d.data);
        d.obs = cf ? cf.obs || '' : '';
      }
      return ap;
    }

    movimentoAoVivo(empId, comp) {
      return B.movimentoAoVivo(this.apurarMes(empId, comp), this.lancamentos(empId, comp));
    }

    _fechamentosMap(empId) {
      const m = {};
      for (const f of this.all('fechamentos')) if (f.employeeId === empId) m[f.comp] = f;
      return m;
    }

    extrato(empId, ateComp) {
      const emp = this.funcionario(empId); exigir(emp, 'Funcionário não encontrado.');
      return B.extrato({ emp, ateComp, politica: this.politica(), movimento: (c) => this.movimentoAoVivo(empId, c), fechamentos: this._fechamentosMap(empId) });
    }

    /** Linha do extrato da competência (ou null se anterior ao início do banco). */
    linhaBanco(empId, comp) {
      const ex = this.extrato(empId, comp);
      return ex.length ? ex[ex.length - 1] : null;
    }

    /**
     * Dados de uma competência para telas e relatórios. Se estiver fechada,
     * usa os dados congelados no fechamento.
     */
    competencia(empId, comp) {
      const f = this.fechamento(empId, comp);
      const fechada = !!(f && f.status === 'fechada');
      const apuracao = fechada ? { comp, dias: f.snapshot.dias, totais: f.snapshot.totais } : this.apurarMes(empId, comp);
      const lancamentos = fechada ? f.snapshot.lancamentos : this.lancamentos(empId, comp);
      return { fechada, fechamento: f, apuracao, lancamentos, banco: this.linhaBanco(empId, comp) };
    }

    // ------------------------------------------------------------------ fechamento mensal
    verificarFechamento(empId, comp) {
      const emp = this.funcionario(empId); exigir(emp, 'Funcionário não encontrado.');
      exigir(U.isComp(comp), 'Competência inválida.');
      const bloqueios = [], avisos = [];
      const ini = B.compInicial(emp);
      if (this.compFechada(empId, comp)) bloqueios.push('A competência já está fechada.');
      if (U.compLastDay(comp) >= this.hoje()) bloqueios.push('A competência ainda não terminou (o último dia é ' + U.fmtDate(U.compLastDay(comp)) + ').');
      if (ini && comp < ini) bloqueios.push('A competência é anterior ao início do banco de horas (' + U.compLabel(ini) + ').');
      if (ini && comp > ini && !this.compFechada(empId, U.prevComp(comp))) bloqueios.push('Feche antes a competência anterior (' + U.compLabel(U.prevComp(comp)) + '). O fechamento é sequencial para garantir o saldo transportado.');
      const ap = this.apurarMes(empId, comp);
      const pend = ap.dias.filter((d) => d.pendente);
      if (pend.length) bloqueios.push(pend.length + ' dia(s) com pendências: ' + pend.slice(0, 10).map((d) => U.fmtDate(d.data)).join(', ') + (pend.length > 10 ? '...' : '') + '.');
      const linha = this.linhaBanco(empId, comp);
      if (linha && linha.alertas.length) avisos.push(...linha.alertas);
      const f = this.fechamento(empId, comp);
      if (f && f.status === 'reaberta') avisos.push('Esta competência foi reaberta anteriormente; o novo fechamento substituirá os dados congelados (o histórico é mantido).');
      return { podeFechar: bloqueios.length === 0, bloqueios, avisos, apuracao: ap, banco: linha, pendentes: pend };
    }

    async fechar(empId, comp, observacao) {
      const v = this.verificarFechamento(empId, comp);
      exigir(v.podeFechar, 'Não é possível fechar:\n' + v.bloqueios.join('\n'));
      const mov = this.movimentoAoVivo(empId, comp);
      const anterior = this.fechamento(empId, comp);
      const snapshot = {
        geradoEm: this.agora(), versaoSistema: VERSAO_SISTEMA,
        saldoAnteriorMin: v.banco.saldoAnteriorMin, saldoFinalMin: v.banco.saldoFinalMin,
        movimento: mov, totais: v.apuracao.totais, dias: v.apuracao.dias,
        lancamentos: this.lancamentos(empId, comp), politica: this.politica(),
        funcionario: this.funcionario(empId)
      };
      const f = {
        id: empId + '|' + comp, employeeId: empId, comp, status: 'fechada', snapshot,
        historico: ((anterior && anterior.historico) || []).concat([{ acao: 'fechamento', em: this.agora(), observacao: (observacao || '').trim(), saldoAnteriorMin: snapshot.saldoAnteriorMin, saldoFinalMin: snapshot.saldoFinalMin }])
      };
      await this._commit([{ op: 'put', store: 'fechamentos', value: f }], { acao: 'competencia-fechada', entidade: 'fechamentos', entidadeId: f.id, employeeId: empId, comp, descricao: 'Competência ' + U.compLabel(comp) + ' fechada. Saldo final: ' + U.saldo(snapshot.saldoFinalMin) + '.' });
      const atualizadas = await Store.prototype.atualizarSaldosPosteriores.call(this, empId, comp, 'novo fechamento de ' + U.compLabel(comp)); // chamada interna
      return { fechamento: f, atualizadas };
    }

    async reabrir(empId, comp, justificativa) {
      exigirJustificativa(justificativa);
      const f = this.fechamento(empId, comp);
      exigir(f && f.status === 'fechada', 'A competência não está fechada.');
      f.status = 'reaberta';
      f.historico.push({ acao: 'reabertura', em: this.agora(), justificativa: justificativa.trim(), saldoAnteriorMin: f.snapshot.saldoAnteriorMin, saldoFinalMin: f.snapshot.saldoFinalMin });
      await this._commit([{ op: 'put', store: 'fechamentos', value: f }], { acao: 'competencia-reaberta', entidade: 'fechamentos', entidadeId: f.id, employeeId: empId, comp, descricao: 'Competência ' + U.compLabel(comp) + ' reaberta. Justificativa: ' + justificativa.trim() });
    }

    /**
     * Recalcula o saldo transportado das competências FECHADAS posteriores a `desdeComp`.
     * O movimento congelado não muda; apenas saldo anterior/final, com registro no histórico.
     */
    async atualizarSaldosPosteriores(empId, desdeComp, motivo) {
      const fmap = this._fechamentosMap(empId);
      const fechadas = Object.keys(fmap).filter((c) => c > desdeComp && fmap[c].status === 'fechada').sort();
      if (!fechadas.length) return [];
      const ex = this.extrato(empId, fechadas[fechadas.length - 1]);
      const ops = [], auds = [], atualizadas = [];
      for (const l of ex) {
        if (!l.fechada || !l.divergencia || l.comp <= desdeComp) continue;
        const f = U.clone(fmap[l.comp]);
        const de = { saldoAnteriorMin: f.snapshot.saldoAnteriorMin, saldoFinalMin: f.snapshot.saldoFinalMin };
        f.snapshot.saldoAnteriorMin = l.saldoAnteriorMin;
        f.snapshot.saldoFinalMin = l.saldoFinalMin;
        f.historico.push({ acao: 'recalculo-saldo', em: this.agora(), motivo, de, para: { saldoAnteriorMin: l.saldoAnteriorMin, saldoFinalMin: l.saldoFinalMin } });
        ops.push({ op: 'put', store: 'fechamentos', value: f });
        auds.push({ acao: 'competencia-recalculada', entidade: 'fechamentos', entidadeId: f.id, employeeId: empId, comp: l.comp, descricao: 'Saldo transportado de ' + U.compLabel(l.comp) + ' recalculado (' + motivo + '): saldo final de ' + U.saldo(de.saldoFinalMin) + ' para ' + U.saldo(l.saldoFinalMin) + '.' });
        atualizadas.push(l.comp);
      }
      if (ops.length) await this._commit(ops, auds);
      return atualizadas;
    }

    // ------------------------------------------------------------------ importação
    async prepararImportacao(nome, bytes) {
      const info = I.detectar(nome, bytes);
      const h = await U.hash(U.bytesToB64(bytes));
      const res = { nome, info, hash: h, bytes, tab: null, sugestao: null, jaImportado: null };
      res.jaImportado = this.all('importacoes').find((i) => i.hash === h.valor && !i.desconsiderada) || null;
      if (info.tipo === 'texto') {
        res.tab = I.tabular(info.texto);
        res.sugestao = I.sugerirMapeamento(res.tab);
      }
      return res;
    }

    /** Gera a prévia completa (não grava nada). vinculos: {codigo: employeeId} */
    previaImportacao(prep, mapeamento, vinculos, empUnico) {
      exigir(prep.tab, 'O arquivo não pôde ser lido como texto.');
      const { registros, erros } = I.extrair(prep.tab, mapeamento);
      const porCodigo = {};
      const funcs = this.all('funcionarios');
      for (const r of registros) {
        let empId = null;
        if (empUnico) empId = empUnico;
        else if (vinculos && Object.prototype.hasOwnProperty.call(vinculos, r.codigo)) empId = vinculos[r.codigo] || null;
        else {
          const f = funcs.find((x) => x.situacao === 'ativo' && x.codigoRelogio && x.codigoRelogio === r.codigo);
          empId = f ? f.id : null;
        }
        r.employeeId = empId;
        porCodigo[r.codigo] = porCodigo[r.codigo] || { codigo: r.codigo, quantidade: 0, employeeId: empId, sugerido: null };
        porCodigo[r.codigo].quantidade++;
        const fs = funcs.find((x) => x.codigoRelogio && x.codigoRelogio === r.codigo);
        porCodigo[r.codigo].sugerido = fs ? fs.id : null;
      }
      const existentes = new Set();
      const empIds = new Set(registros.map((r) => r.employeeId).filter(Boolean));
      const empCache = {};
      for (const id of empIds) {
        empCache[id] = this.funcionario(id);
        for (const m of this.efetivas(id)) if (!m.removida) existentes.add(id + '|' + m.dt);
        // marcações originais desconsideradas também contam: reimportar não deve "ressuscitá-las"
        for (const m of this.all('marcacoes')) if (m.employeeId === id) existentes.add(id + '|' + m.dt);
      }
      I.marcarDuplicidades(registros, existentes);
      const resumo = { total: registros.length, novos: 0, duplicadosArquivo: 0, duplicadosExistentes: 0, semFuncionario: 0, competenciaFechada: 0, erros: erros.length };
      for (const r of registros) {
        if (r.employeeId) r.dataRef = C.dataReferencia(empCache[r.employeeId], r.dt);
        if (!r.employeeId) { r.status = 'sem-funcionario'; resumo.semFuncionario++; }
        else if (r.duplicadaArquivo) { r.status = 'duplicada-arquivo'; resumo.duplicadosArquivo++; }
        else if (r.duplicadaExistente) { r.status = 'duplicada-existente'; resumo.duplicadosExistentes++; }
        else if (this.compFechada(r.employeeId, U.compOf(r.dataRef))) { r.status = 'competencia-fechada'; resumo.competenciaFechada++; }
        else { r.status = 'nova'; resumo.novos++; }
      }
      const datas = registros.map((r) => r.data).sort();
      resumo.periodo = datas.length ? { de: datas[0], ate: datas[datas.length - 1] } : null;
      return { prep, mapeamento: U.clone(mapeamento), registros, erros, codigos: Object.values(porCodigo), resumo };
    }

    async confirmarImportacao(previa, opts) {
      opts = opts || {};
      const novas = previa.registros.filter((r) => r.status === 'nova');
      exigir(novas.length > 0, 'Não há marcações novas para gravar.');
      const p = previa.prep;
      const imp = {
        id: U.uid(), nomeArquivo: p.nome, tamanho: p.info.tamanho, tipoDetectado: p.info.tipo, codificacao: p.info.codificacao,
        delimitador: p.tab.delimitador, hash: p.hash.valor, hashAlgoritmo: p.hash.algoritmo, conteudoBase64: U.bytesToB64(p.bytes),
        mapeamento: previa.mapeamento, importadoEm: this.agora(), teste: !!opts.teste, observacao: (opts.observacao || '').trim(),
        totais: Object.assign({}, previa.resumo, { gravadas: novas.length }), desconsiderada: null
      };
      const origem = opts.teste ? 'importacao-teste' : 'importacao';
      const ops = [{ op: 'put', store: 'importacoes', value: imp }];
      for (const r of novas) {
        ops.push({ op: 'put', store: 'marcacoes', value: { id: U.uid(), employeeId: r.employeeId, dt: r.dt, dataRef: r.dataRef, origem, importId: imp.id, codigoRelogio: r.codigo, linhaArquivo: r.linha, criadoEm: this.agora() } });
      }
      await this._commit(ops, { acao: 'importacao', entidade: 'importacoes', entidadeId: imp.id, descricao: 'Arquivo "' + p.nome + '" importado' + (imp.teste ? ' (ARQUIVO DE TESTE)' : '') + ': ' + novas.length + ' marcações gravadas, ' + (previa.registros.length - novas.length) + ' ignoradas, ' + previa.erros.length + ' linhas com erro.' });
      return imp;
    }

    importacoes() { return this.all('importacoes').sort((a, b) => U.cmp(b.importadoEm, a.importadoEm)).map((i) => { const c = U.clone(i); delete c.conteudoBase64; return c; }); }

    arquivoOriginal(importId) {
      const i = this.c.importacoes.get(importId); exigir(i, 'Importação não encontrada.');
      return { nome: i.nomeArquivo, bytes: U.b64ToBytes(i.conteudoBase64) };
    }

    async desconsiderarImportacao(importId, justificativa) {
      exigirJustificativa(justificativa);
      const imp = this.get('importacoes', importId); exigir(imp && !imp.desconsiderada, 'Importação não encontrada ou já desconsiderada.');
      for (const m of this.all('marcacoes')) if (m.importId === importId) this._exigirAberto(m.employeeId, m.dataRef);
      imp.desconsiderada = { em: this.agora(), justificativa: justificativa.trim() };
      await this._commit([{ op: 'put', store: 'importacoes', value: imp }], { acao: 'importacao-desconsiderada', entidade: 'importacoes', entidadeId: importId, descricao: 'Importação do arquivo "' + imp.nomeArquivo + '" desconsiderada (registros preservados). Justificativa: ' + justificativa.trim() });
    }

    // ------------------------------------------------------------------ auditoria
    auditoria(filtro) {
      filtro = filtro || {};
      return this.all('auditoria').filter((a) => (!filtro.employeeId || a.employeeId === filtro.employeeId)
        && (!filtro.comp || (a.data && U.compOf(a.data) === filtro.comp) || a.comp === filtro.comp))
        .sort((a, b) => U.cmp(b.em, a.em) || (b.seq || 0) - (a.seq || 0)).map(U.clone);
    }

    // ------------------------------------------------------------------ painel
    painel(comp) {
      const linhas = this.funcionarios({ ativos: true }).map((f) => {
        const ap = this.competencia(f.id, comp);
        const b = ap.banco;
        return {
          funcionario: f, fechada: ap.fechada, reaberta: !!(ap.fechamento && ap.fechamento.status === 'reaberta'),
          previstoMin: ap.apuracao.totais.previstoMin, trabalhadoMin: ap.apuracao.totais.trabalhadoMin,
          diasPendentes: ap.apuracao.totais.diasPendentes,
          banco: b
        };
      });
      return { comp, linhas, sistema: this.sistema(), importacoes: this.importacoes().slice(0, 5) };
    }

    // ------------------------------------------------------------------ backup
    dadosCompletos() {
      const d = {};
      for (const s of DB.STORES) d[s] = this.all(s).map(U.clone);
      return d;
    }

    async exportarBackup() {
      const b = await BK.montar(this.dadosCompletos(), VERSAO_SISTEMA);
      // Exportar não altera dados. Em aba somente leitura o arquivo é gerado, mas a data do
      // "último backup" não é registrada (isso seria uma gravação).
      if (!this.editavel) return Object.defineProperty(b, 'naoRegistrado', { value: true, enumerable: false });
      const sis = Object.assign({}, this.cfg('sistema') || { id: 'sistema' }, { ultimoBackupEm: b.geradoEm, alteracoesDesdeBackup: 0 });
      // o registro de "último backup" não entra no próprio backup (já foi montado)
      await this._commit([{ op: 'put', store: 'config', value: sis }], { acao: 'backup-exportado', entidade: 'config', descricao: 'Backup completo exportado (hash ' + b.integridade.hash.slice(0, 12) + '...).' }, { semContador: true });
      return b;
    }

    /**
     * Backup para envio a um destino externo (Google Drive): mesmo conteúdo de exportarBackup(),
     * mas NÃO registra nada. O registro só é feito por registrarEnvioDrive(), depois que o destino
     * confirmar o arquivo. `marco` guarda o estado do contador no instante em que o backup foi montado.
     */
    async gerarBackupParaEnvio() {
      const sis = this.sistema();
      const marco = { alteracoes: sis.alteracoesDesdeBackup || 0, ultimoBackupEm: sis.ultimoBackupEm || null, restauradoEm: sis.restauradoEm || null };
      const backup = await BK.montar(this.dadosCompletos(), VERSAO_SISTEMA);
      return { backup, marco };
    }

    /**
     * Registra um backup cujo envio ao Google Drive foi confirmado pela API.
     * Desconta do contador apenas as alterações que estavam no arquivo; as feitas durante o envio
     * continuam contando. Se outro backup ou uma restauração foi registrado nesse meio-tempo, o
     * contador e a data não são tocados (o arquivo enviado já não é o mais recente) — só a auditoria.
     */
    async registrarEnvioDrive(backup, marco, arquivo) {
      exigir(arquivo && typeof arquivo.id === 'string' && arquivo.id !== '', 'O Google Drive não confirmou o arquivo; nada foi registrado.');
      exigir(backup && backup.formato === BK.FORMATO && backup.integridade && typeof backup.integridade.hash === 'string', 'Backup inválido; nada foi registrado.');
      exigir(marco && Number.isInteger(marco.alteracoes) && marco.alteracoes >= 0, 'Dados do envio incompletos; nada foi registrado.');
      const atual = this.cfg('sistema') || { id: 'sistema' };
      const ops = [];
      if ((atual.ultimoBackupEm || null) === marco.ultimoBackupEm && (atual.restauradoEm || null) === marco.restauradoEm) {
        const sis = Object.assign({}, atual, {
          ultimoBackupEm: backup.geradoEm,
          alteracoesDesdeBackup: Math.max(0, (atual.alteracoesDesdeBackup || 0) - marco.alteracoes)
        });
        ops.push({ op: 'put', store: 'config', value: sis });
      }
      await this._commit(ops, {
        acao: 'backup-enviado-drive', entidade: 'config',
        descricao: 'Backup completo enviado ao Google Drive e confirmado pela API' + (arquivo.criptografado ? ', criptografado com senha' : ', sem criptografia') + ': arquivo "' + String(arquivo.name || '') + '" (hash ' + backup.integridade.hash.slice(0, 12) + '...).',
        detalhes: { arquivoId: arquivo.id, nome: String(arquivo.name || ''), tamanho: arquivo.size === undefined ? null : Number(arquivo.size), geradoEm: backup.geradoEm, criptografado: !!arquivo.criptografado }
      }, { semContador: true });
      return this.sistema();
    }

    async validarBackup(obj) { return BK.validar(obj); }

    async restaurarBackup(obj) {
      const v = await BK.validar(obj);
      exigir(v.ok, 'Backup inválido:\n' + v.erros.join('\n'));
      // Cópia de segurança interna do estado atual antes de substituir
      const copia = { id: 'copia-' + Date.now(), em: this.agora(), dados: this.dadosCompletos() };
      await this.db.write([{ op: 'put', store: 'copiasSeguranca', value: copia }]);
      const antigas = (await this.db.getAll('copiasSeguranca')).sort((a, b) => U.cmp(b.em, a.em)).slice(3);
      if (antigas.length) await this.db.write(antigas.map((a) => ({ op: 'delete', store: 'copiasSeguranca', id: a.id })));
      // Substituição completa em UMA transação: não há como duplicar registros
      const ops = DB.STORES.map((s) => ({ op: 'clear', store: s }));
      for (const s of DB.STORES) for (const r of obj.dados[s]) ops.push({ op: 'put', store: s, value: r });
      await this.db.write(ops);
      await this.recarregar();
      const sis = Object.assign({ id: 'sistema' }, this.cfg('sistema') || {}, { restauradoEm: this.agora(), restauradoDe: obj.geradoEm, alteracoesDesdeBackup: 0 });
      await this._commit([{ op: 'put', store: 'config', value: sis }], { acao: 'backup-restaurado', entidade: 'config', descricao: 'Backup de ' + U.fmtDateTimeISO(obj.geradoEm) + ' restaurado. Cópia de segurança interna do estado anterior: ' + copia.id + '.' }, { semContador: true });
      return { validacao: v, copiaSeguranca: copia.id };
    }

    async copiasSeguranca() {
      return (await this.db.getAll('copiasSeguranca')).sort((a, b) => U.cmp(b.em, a.em)).map((c) => ({ id: c.id, em: c.em, contagens: Object.fromEntries(Object.entries(c.dados).map(([k, v]) => [k, v.length])) }));
    }

    /** Monta um arquivo de backup a partir de uma cópia de segurança interna (para baixar). */
    async backupDaCopia(id) {
      const c = await this.db.get('copiasSeguranca', id); exigir(c, 'Cópia não encontrada.');
      return BK.montar(c.dados, VERSAO_SISTEMA);
    }
  }

  const api = { Store, ErroRegra, VERSAO_SISTEMA };
  if (isNode) module.exports = api;
  else { root.Ponto = root.Ponto || {}; root.Ponto.store = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this);
