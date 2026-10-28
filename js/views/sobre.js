/* Sobre o sistema: funcionamento, limitações técnicas e legais. */
(function (root) {
  'use strict';
  const P = root.Ponto; const UI = P.ui; const h = UI.h;
  P.views = P.views || {};

  P.views.sobre = {
    titulo: 'Sobre e limitações',
    render(el) {
      el.innerHTML = String(h`
        <h1>Sobre e limitações</h1>
        <div class="cartao"><h2>Como os cálculos funcionam</h2>
          <ul>
            <li>Todos os cálculos são feitos internamente em minutos inteiros; os totais são exibidos em horas e minutos. Segundos das batidas são descartados.</li>
            <li>As marcações são agrupadas em pares (entrada/saída). O tempo entre pares é o intervalo.</li>
            <li>O sistema <b>não inventa batidas</b>: dia com quantidade ímpar de marcações ou dia útil passado sem marcações fica “não apurado” e bloqueia o fechamento até a conferência.</li>
            <li>Batidas muito próximas (janela configurável) são tratadas como possível duplicidade e exigem conferência.</li>
            <li>Horas excedentes e não cumpridas são apenas apuradas. Considerá-las hora extra a pagar, banco de horas ou desconto depende da política configurada e das regras legais/contratuais.</li>
            <li>O banco de horas é sempre recalculado a partir dos registros; reprocessar uma competência não duplica lançamentos, e o saldo não é zerado na virada do mês.</li>
          </ul></div>
        <div class="cartao"><h2>Limitações técnicas</h2>
          <ul>
            <li>Os dados ficam no navegador deste computador (IndexedDB). Não há sincronização entre computadores nem entre navegadores. Use o backup externo.</li>
            <li>Abrir o sistema por endereços diferentes (arquivo local, GitHub Pages, outro navegador) resulta em armazenamentos separados.</li>
            <li>Várias abas: somente uma aba por vez pode alterar dados. As demais abrem em modo somente leitura (permitem consultar, imprimir e exportar backup) e assumem a edição automaticamente quando a aba que edita é fechada ou recarregada. O controle usa o bloqueio do navegador (Web Locks; verificado em testes automatizados no Google Chrome). Em navegadores sem esse recurso, todas as abas ficam em somente leitura. A proteção vale para o uso normal pela interface; não impede alterações intencionais pelas ferramentas de desenvolvedor do navegador. Trocar de tela pelo menu descarta o que foi digitado e não salvo.</li>
            <li>A importação lê arquivos de texto delimitado. O formato do relógio FR-1533 ainda não foi verificado com arquivo real; formatos binários não são lidos.</li>
            <li>Não há controle de acesso por usuário/senha nesta versão: quem usa o computador acessa os dados. Proteja o acesso ao computador.</li>
            <li>Google Drive (opcional): só funciona com o sistema aberto por um endereço http(s) autorizado (ex.: http://localhost:8080 ou GitHub Pages), depois de configurar um Client ID próprio no Google Cloud. O sistema só enxerga os backups que ele mesmo enviou. O backup enviado ao Drive é <b>criptografado com uma senha sua</b> (AES-256-GCM); <b>sem a senha, ele não pode ser recuperado</b>. O backup exportado localmente continua <b>não criptografado</b>.</li>
          </ul></div>
        <div class="cartao"><h2>Limitações legais</h2>
          <ul>
            <li>Este sistema é uma ferramenta de controle interno e conferência. <b>Não é certificado nem homologado</b> e não afirma atender, por si só, aos requisitos de REP-C, REP-A ou REP-P da Portaria MTP nº 671/2021, nem gera AFD/AEJ.</li>
            <li>Jornadas, tolerâncias, intervalos e a política do banco de horas são configuráveis e devem ser validados com a contabilidade ou assessoria jurídica, conforme contrato, acordo/convenção coletiva e legislação.</li>
            <li>Os relatórios são gerados para conferência e assinatura entre as partes; não são automaticamente documentos oficiais válidos para qualquer modalidade de registro.</li>
            <li>Dados pessoais (nome, CPF, salário, horários) devem ser tratados conforme a LGPD: colete apenas o necessário, restrinja o acesso e guarde os backups em local seguro.</li>
          </ul></div>`);
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
