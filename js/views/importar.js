/* Importação de marcações: arquivo -> detecção -> mapeamento -> prévia -> confirmação. */
(function (root) {
  'use strict';
  const P = root.Ponto; const U = P.util, UI = P.ui; const h = UI.h;
  P.views = P.views || {};

  const st = { prep: null, map: null, vinculos: {}, teste: false, obs: '', previa: null, erroPrevia: null };
  const reset = () => { st.prep = null; st.map = null; st.vinculos = {}; st.teste = false; st.obs = ''; st.previa = null; st.erroPrevia = null; };

  const STATUS = {
    nova: ['ok', 'Será gravada'],
    'duplicada-arquivo': ['alerta', 'Duplicada no próprio arquivo'],
    'duplicada-existente': ['alerta', 'Já existe no sistema'],
    'sem-funcionario': ['erro', 'Identificador sem funcionário'],
    'competencia-fechada': ['erro', 'Competência fechada']
  };

  const NOMES_DELIM = { '\t': 'tabulação', ';': 'ponto e vírgula (;)', ',': 'vírgula (,)', '|': 'barra vertical (|)', espacos: 'espaços' };

  function opcoesColunas(n, sel, amostra, comNenhuma) {
    const ops = [];
    if (comNenhuma) ops.push(h`<option value="" ${sel === null || sel === '' ? UI.raw('selected') : ''}>${comNenhuma}</option>`);
    for (let c = 0; c < n; c++) ops.push(h`<option value="${c}" ${String(sel) === String(c) ? UI.raw('selected') : ''}>Coluna ${c + 1}${amostra && amostra[c] !== undefined ? ' (ex.: ' + amostra[c].slice(0, 25) + ')' : ''}</option>`);
    return ops;
  }

  function calcularPrevia(app) {
    st.previa = null; st.erroPrevia = null;
    if (!st.prep || !st.prep.tab) return;
    const m = st.map;
    if (m.modo === 'datahora' ? m.colDataHora === null || m.colDataHora === '' : (m.colData === null || m.colData === '' || m.colHora === null || m.colHora === '')) {
      st.erroPrevia = 'Selecione as colunas de data e hora.'; return;
    }
    const semCodigo = m.colCodigo === null || m.colCodigo === '';
    if (semCodigo && !app.state.empId) { st.erroPrevia = 'Sem coluna de identificador: selecione o funcionário no topo da página.'; return; }
    const mapa = Object.assign({}, m, m.modo === 'datahora' ? { colData: null, colHora: null } : { colDataHora: null });
    try { st.previa = app.store.previaImportacao(st.prep, mapa, st.vinculos, semCodigo ? app.state.empId : null); }
    catch (e) { st.erroPrevia = e.message; }
  }

  function secaoHistorico(app) {
    const imps = app.store.importacoes();
    return h`<h2>Histórico de importações</h2>
      ${imps.length ? h`<div class="tabela-rolagem"><table class="tabela"><thead><tr><th>Importado em</th><th>Arquivo</th><th>Tipo</th><th>Gravadas</th><th>Ignoradas</th><th>Erros</th><th>Situação</th><th></th></tr></thead>
      <tbody>${imps.map((i) => h`<tr>
        <td>${U.fmtDateTimeISO(i.importadoEm)}</td><td>${i.nomeArquivo}${i.teste ? h` <span class="badge teste">ARQUIVO DE TESTE</span>` : ''}<br><small class="mudo" title="${i.hashAlgoritmo}">${i.hashAlgoritmo} ${i.hash.slice(0, 16)}…</small></td>
        <td>${i.codificacao || ''} · ${NOMES_DELIM[i.delimitador] || i.delimitador || ''}</td><td>${i.totais.gravadas}</td><td>${i.totais.total - i.totais.gravadas}</td><td>${i.totais.erros}</td>
        <td>${i.desconsiderada ? h`<span class="badge erro" title="${i.desconsiderada.justificativa}">Desconsiderada</span>` : h`<span class="badge ok">Ativa</span>`}</td>
        <td class="nowrap"><button type="button" data-leitura data-baixar="${i.id}">Baixar arquivo original</button> ${!i.desconsiderada ? h`<button type="button" class="perigo" data-desc="${i.id}">Desconsiderar</button>` : ''}</td></tr>`)}</tbody></table></div>` : UI.vazio('Nenhuma importação realizada.')}`;
  }

  P.views.importar = {
    titulo: 'Importar ponto',
    render(el, app) {
      const s = app.store;
      const p = st.prep;
      const perfis = s.perfisImportacao();
      if (p && st.map) calcularPrevia(app); // sempre recalcula (funcionário ou dados podem ter mudado)
      let corpo = '';
      if (p) {
        const info = p.info;
        const inf = h`<div class="cartao"><h2>2. Arquivo identificado</h2>
          <table class="tabela chave-valor"><tbody>
            <tr><th>Nome</th><td>${p.nome}</td></tr>
            <tr><th>Tamanho</th><td>${info.tamanho.toLocaleString('pt-BR')} bytes</td></tr>
            <tr><th>Tipo</th><td>${{ texto: 'Texto', binario: 'Binário (não legível como texto)', vazio: 'Arquivo vazio', 'grande-demais': 'Grande demais' }[info.tipo] || info.tipo}${info.extensao ? ' · extensão .' + info.extensao : ''}</td></tr>
            ${info.tipo === 'texto' ? h`<tr><th>Codificação</th><td>${info.codificacao}</td></tr><tr><th>Separador detectado</th><td>${NOMES_DELIM[p.tab.delimitador]}</td></tr><tr><th>Linhas com conteúdo</th><td>${p.tab.linhas.length}</td></tr>` : ''}
            <tr><th>Código de integridade</th><td><small>${p.hash.algoritmo} ${p.hash.valor}</small></td></tr>
            <tr><th>Formato</th><td>Leitura genérica de texto delimitado. <b>Nenhum layout específico do relógio FR-1533 foi presumido</b> — confira o mapeamento abaixo.</td></tr>
          </tbody></table>
          ${p.jaImportado ? h`<div class="faixa alerta">Este mesmo arquivo já foi importado em ${U.fmtDateTimeISO(p.jaImportado.importadoEm)} (${p.jaImportado.nomeArquivo}). As marcações repetidas serão detectadas como duplicadas.</div>` : ''}
          ${info.avisos.map((a) => h`<div class="faixa erro">${a}</div>`)}
          ${info.tipo === 'vazio' ? h`<div class="faixa erro">O arquivo está vazio.</div>` : ''}
          ${info.tipo === 'grande-demais' ? h`<div class="faixa erro">O arquivo excede o limite de 20 MB.</div>` : ''}
          ${p.tab ? h`<details open><summary>Primeiras linhas do arquivo (como texto, sem interpretação)</summary><pre class="amostra">${p.tab.linhas.slice(0, 15).map((l) => String(l.n).padStart(4) + ' | ' + l.bruto.slice(0, 160) + '\n').join('')}</pre></details>` : ''}
        </div>`;

        let mapeamento = '';
        if (p.tab) {
          const m = st.map;
          const amostraLinha = p.tab.linhas[Math.min(p.tab.linhas.length - 1, m.ignorarLinhas | 0)];
          const amostra = amostraLinha ? amostraLinha.celulas : [];
          const n = Math.max(m.nColunas || 0, ...p.tab.linhas.slice(0, 50).map((l) => l.celulas.length));
          mapeamento = h`<div class="cartao"><h2>3. Conferência das colunas</h2>
            <p class="ajuda">O sistema sugeriu as colunas abaixo a partir do conteúdo. Confira com as primeiras linhas mostradas acima e ajuste se necessário. Quando o arquivo real do relógio chegar, salve o mapeamento como perfil para reutilizar.</p>
            <form id="form-map" class="grade">
              <label>Identificador do funcionário<select name="colCodigo">${opcoesColunas(n, m.colCodigo, amostra, 'Não há — todas as marcações são do funcionário selecionado no topo')}</select></label>
              <label>Data e hora estão<select name="modo"><option value="separadas" ${m.modo !== 'datahora' ? UI.raw('selected') : ''}>em colunas separadas</option><option value="datahora" ${m.modo === 'datahora' ? UI.raw('selected') : ''}>na mesma coluna</option></select></label>
              ${m.modo === 'datahora'
                ? h`<label>Coluna de data e hora<select name="colDataHora">${opcoesColunas(n, m.colDataHora, amostra, '— selecione —')}</select></label>`
                : h`<label>Coluna da data<select name="colData">${opcoesColunas(n, m.colData, amostra, '— selecione —')}</select></label>
                    <label>Coluna da hora<select name="colHora">${opcoesColunas(n, m.colHora, amostra, '— selecione —')}</select></label>`}
              <label>Formato da data<select name="formatoData">
                <option value="dmy" ${m.formatoData === 'dmy' ? UI.raw('selected') : ''}>dia/mês/ano</option>
                <option value="ymd" ${m.formatoData === 'ymd' ? UI.raw('selected') : ''}>ano-mês-dia</option>
                <option value="mdy" ${m.formatoData === 'mdy' ? UI.raw('selected') : ''}>mês/dia/ano</option></select></label>
              <label>Ignorar linhas iniciais (cabeçalho)<input type="number" min="0" name="ignorarLinhas" value="${m.ignorarLinhas | 0}"></label>
            </form>
            <div class="acoes">
              ${perfis.length ? h`<label>Perfil salvo<select id="perfil"><option value="">— aplicar perfil —</option>${perfis.map((pf) => h`<option value="${pf.nome}">${pf.nome}</option>`)}</select></label>` : ''}
              <button type="button" id="salvar-perfil">Salvar mapeamento como perfil</button>
            </div>
          </div>`;
        }

        let previa = '';
        if (p.tab) {
          const pv = st.previa;
          if (st.erroPrevia) previa = h`<div class="cartao"><h2>4. Prévia</h2><div class="faixa alerta">${st.erroPrevia}</div></div>`;
          else if (pv) {
            const r = pv.resumo;
            const funcs = s.funcionarios({ ativos: true });
            const semCodigo = st.map.colCodigo === null || st.map.colCodigo === '';
            previa = h`<div class="cartao"><h2>4. Prévia das marcações reconhecidas</h2>
              <div class="kpis compacto">
                <div class="kpi"><span class="rotulo">Reconhecidas</span><span class="valor">${r.total}</span></div>
                <div class="kpi"><span class="rotulo">Serão gravadas</span><span class="valor">${r.novos}</span></div>
                <div class="kpi"><span class="rotulo">Duplicadas</span><span class="valor">${r.duplicadosArquivo + r.duplicadosExistentes}</span></div>
                <div class="kpi"><span class="rotulo">Sem funcionário</span><span class="valor">${r.semFuncionario}</span></div>
                <div class="kpi"><span class="rotulo">Em competência fechada</span><span class="valor">${r.competenciaFechada}</span></div>
                <div class="kpi"><span class="rotulo">Linhas não identificadas</span><span class="valor">${r.erros}</span></div>
              </div>
              ${r.periodo ? h`<p>Período encontrado: <b>${U.fmtDate(r.periodo.de)}</b> a <b>${U.fmtDate(r.periodo.ate)}</b>.</p>` : ''}
              ${semCodigo ? h`<p>Todas as marcações serão atribuídas a <b>${(app.funcionarioSel() || {}).nome}</b>.</p>` : h`
                <h3>Conferência dos identificadores</h3>
                <table class="tabela"><thead><tr><th>Identificador no arquivo</th><th>Marcações</th><th>Funcionário</th></tr></thead>
                <tbody>${pv.codigos.map((c) => h`<tr><td><code>${c.codigo}</code></td><td>${c.quantidade}</td><td>
                  <select data-codigo="${c.codigo}"><option value="">— não importar —</option>${funcs.map((f) => h`<option value="${f.id}" ${c.employeeId === f.id ? UI.raw('selected') : ''}>${f.nome}${f.codigoRelogio ? ' (cód. ' + f.codigoRelogio + ')' : ''}</option>`)}</select>
                  ${c.employeeId && c.sugerido === c.employeeId ? h` <small class="mudo">vinculado pelo cadastro</small>` : ''}</td></tr>`)}</tbody></table>`}
              ${pv.erros.length ? h`<h3>Linhas que não puderam ser identificadas (${pv.erros.length})</h3>
                <div class="tabela-rolagem curta"><table class="tabela"><thead><tr><th>Linha</th><th>Motivo</th><th>Conteúdo</th></tr></thead>
                <tbody>${pv.erros.slice(0, 200).map((e) => h`<tr><td>${e.linha}</td><td>${e.motivo}</td><td><code>${e.conteudo}</code></td></tr>`)}</tbody></table></div>` : ''}
              <h3>Marcações (${pv.registros.length}${pv.registros.length > 500 ? ', mostrando 500' : ''})</h3>
              <div class="tabela-rolagem curta"><table class="tabela"><thead><tr><th>Linha</th><th>Identificador</th><th>Data</th><th>Hora</th><th>Funcionário</th><th>Situação</th></tr></thead>
              <tbody>${pv.registros.slice(0, 500).map((x) => { const [cls, txt] = STATUS[x.status]; const f = x.employeeId ? s.funcionario(x.employeeId) : null; return h`<tr><td>${x.linha}</td><td>${x.codigo}</td><td>${U.fmtDate(x.data)}</td><td>${x.hora}</td><td>${f ? f.nome : '—'}</td><td><span class="badge ${cls}">${txt}</span></td></tr>`; })}</tbody></table></div>
            </div>
            <div class="cartao"><h2>5. Confirmação</h2>
              <label class="chk"><input type="checkbox" id="teste" ${st.teste ? UI.raw('checked') : ''}> Este é um <b>arquivo de TESTE</b> (as marcações ficarão identificadas como teste e não como registros do relógio)</label>
              <label>Observação (opcional)<input id="obs-imp" value="${st.obs}"></label>
              <p class="ajuda">Nada foi gravado até agora. Ao confirmar, somente as marcações marcadas como “Será gravada” são registradas; o arquivo original é guardado e pode ser baixado novamente.</p>
              <div class="acoes"><button type="button" class="primario" id="confirmar" ${r.novos ? '' : UI.raw('disabled')}>Confirmar e gravar ${r.novos} marcação(ões)</button>
              <button type="button" data-leitura id="cancelar">Cancelar importação</button></div>
            </div>`;
          }
        }
        corpo = h`${inf}${mapeamento}${previa}`;
      }

      el.innerHTML = String(h`
        <h1>Importar ponto</h1>
        <div class="faixa info">O formato do arquivo do relógio <b>FR-1533</b> ainda não foi analisado com um arquivo real; a compatibilidade não está confirmada. Esta tela lê arquivos de texto (CSV/TXT) genéricos e permite configurar as colunas.</div>
        <div class="cartao"><h2>1. Selecionar arquivo</h2>
          <label class="arquivo">Arquivo de marcações (.txt, .csv ou outro)<input type="file" id="arquivo"></label>
          ${p ? h`<p>Arquivo carregado: <b>${p.nome}</b></p>` : ''}
        </div>
        ${corpo}
        ${secaoHistorico(app)}`);

      UI.$('#arquivo', el).onchange = async (ev) => {
        const file = ev.target.files[0];
        if (!file) return;
        try {
          const bytes = await UI.lerArquivo(file);
          reset();
          st.prep = await s.prepararImportacao(file.name, bytes);
          st.teste = /teste/i.test(file.name);
          if (st.prep.sugestao) {
            st.map = Object.assign({}, st.prep.sugestao, { modo: st.prep.sugestao.colDataHora !== null ? 'datahora' : 'separadas' });
            calcularPrevia(app);
          }
        } catch (e) { UI.erro(e); }
        app.render();
      };

      const fm = UI.$('#form-map', el);
      if (fm) fm.addEventListener('change', () => {
        const v = (n) => { const x = fm.elements[n]; return x ? (x.value === '' ? null : x.value) : undefined; };
        const modo = v('modo');
        Object.assign(st.map, { colCodigo: v('colCodigo'), modo, formatoData: v('formatoData'), ignorarLinhas: Math.max(0, parseInt(fm.elements.ignorarLinhas.value, 10) || 0) });
        if (modo === 'datahora') { if (v('colDataHora') !== undefined) st.map.colDataHora = v('colDataHora'); }
        else { if (v('colData') !== undefined) st.map.colData = v('colData'); if (v('colHora') !== undefined) st.map.colHora = v('colHora'); }
        ['colCodigo', 'colData', 'colHora', 'colDataHora'].forEach((k) => { if (st.map[k] !== null && st.map[k] !== undefined) st.map[k] = +st.map[k]; });
        st.vinculos = {};
        calcularPrevia(app); app.render();
      });
      const pfSel = UI.$('#perfil', el);
      if (pfSel) pfSel.onchange = () => {
        const pf = perfis.find((x) => x.nome === pfSel.value);
        if (pf) { st.map = Object.assign({}, pf.mapeamento); st.vinculos = {}; calcularPrevia(app); app.render(); UI.toast('Perfil "' + pf.nome + '" aplicado.'); }
      };
      const sp = UI.$('#salvar-perfil', el);
      if (sp) sp.onclick = () => UI.modal({
        titulo: 'Salvar perfil de importação',
        corpo: h`<label>Nome do perfil<input name="nome" placeholder="Ex.: Relógio da loja (TXT)"></label>`,
        botoes: [{ texto: 'Cancelar', valor: false }, { texto: 'Salvar', valor: true, classe: 'primario' }],
        validar: (v, f) => s.salvarPerfilImportacao(f.nome.value, st.map)
      }).then((r) => { if (r) { UI.toast('Perfil salvo.'); app.render(); } });

      UI.$$('[data-codigo]', el).forEach((sel) => sel.onchange = () => { st.vinculos[sel.dataset.codigo] = sel.value || null; calcularPrevia(app); app.render(); });
      const t = UI.$('#teste', el); if (t) t.onchange = () => { st.teste = t.checked; };
      const o = UI.$('#obs-imp', el); if (o) o.oninput = () => { st.obs = o.value; };
      const cc = UI.$('#cancelar', el); if (cc) cc.onclick = () => { reset(); app.render(); };
      const cf = UI.$('#confirmar', el);
      if (cf) cf.onclick = async () => {
        const r = st.previa.resumo;
        const ok = await UI.confirmar('Confirmar importação',
          'Arquivo: ' + st.prep.nome + (st.teste ? ' (ARQUIVO DE TESTE)' : '') + '\n\nSerão gravadas ' + r.novos + ' marcação(ões).\nIgnoradas: ' + (r.total - r.novos) + ' (duplicadas, sem funcionário ou em competência fechada).\nLinhas não identificadas: ' + r.erros + '.',
          { botao: 'Gravar marcações' });
        if (!ok) return;
        await app.acao(async () => { await s.confirmarImportacao(st.previa, { teste: st.teste, observacao: st.obs }); reset(); }, 'Importação concluída.');
      };
      UI.$$('[data-baixar]', el).forEach((b) => b.onclick = () => {
        try { const a = s.arquivoOriginal(b.dataset.baixar); UI.baixar(a.nome, a.bytes); } catch (e) { UI.erro(e); }
      });
      UI.$$('[data-desc]', el).forEach((b) => b.onclick = async () => {
        const ok = await UI.justificar('Desconsiderar importação', 'Todas as marcações deste arquivo deixarão de ser consideradas no cálculo. Os registros e o arquivo original continuam guardados (nada é apagado).', (j) => s.desconsiderarImportacao(b.dataset.desc, j), { perigo: true, botao: 'Desconsiderar' });
        if (ok) { UI.toast('Importação desconsiderada.'); app.render(); }
      });
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
