# Gerenciador de Ponto — versão 1.0.0

Sistema de controle de jornada, banco de horas e fechamento mensal para pequenas empresas. Funciona no navegador (Chrome ou Edge, no Windows), sem servidor, sem instalação e sem dependências externas.

> **Aviso:** ferramenta de controle interno e conferência. Não é certificada nem homologada e não declara atender, por si só, à Portaria MTP nº 671/2021 (REP-C/REP-A/REP-P, AFD/AEJ). As regras de jornada, tolerância e banco de horas são configuráveis e devem ser validadas com a contabilidade ou a assessoria jurídica.

## Como abrir

1. Dê dois cliques em `index.html` (ou arraste para o Chrome/Edge).
2. Na primeira vez: **Configurações** → dados do empregador; **Funcionários** → cadastre a funcionária com a jornada contratual.
3. Para conhecer o sistema antes, use **Configurações → Carregar funcionária de exemplo**. Ela aparece marcada como **EXEMPLO**. Remova-a antes do uso real.

Use sempre **o mesmo navegador e a mesma forma de abertura**. Os dados ficam no armazenamento do navegador (IndexedDB) e são separados por endereço: abrir pelo arquivo local, pelo GitHub Pages ou por outro navegador dá armazenamentos diferentes. Para levar os dados de um para outro, use o backup.

### Executar por um servidor local (necessário para o Google Drive)

O login do Google não funciona abrindo o arquivo diretamente (`file://`). Para usar o Drive, sirva a pasta do projeto e abra pelo endereço autorizado no Google Cloud:

```
python -m http.server 8080 --bind 127.0.0.1
```

Depois abra `http://localhost:8080/index.html`, com "localhost" e não "127.0.0.1". O endereço `localhost:8080` tem armazenamento próprio: para levar dados de outro endereço, exporte o backup lá e restaure aqui.

### Google Drive e backups criptografados (opcional)

1. Crie no Google Cloud Console o seu próprio projeto, ative a Google Drive API, configure a tela de consentimento e crie um **ID do cliente OAuth do tipo "Aplicativo da Web"**, com a origem do endereço que você usa. O passo a passo está em `docs/INTEGRACAO-GOOGLE-DRIVE.md`. O sistema usa só o escopo `drive.file` e **não precisa de client secret**: nunca o coloque no código.
2. Em **Backup → Google Drive**, cole o Client ID (termina em `.apps.googleusercontent.com`) e clique em **Salvar Client ID**. Ele é público e fica só neste navegador.
3. **Conectar Google Drive**: o login e o consentimento são feitos na janela do próprio Google.
4. **Enviar backup ao Drive**: informe e repita uma **senha de criptografia**, com pelo menos 12 caracteres. O backup é criptografado no navegador (AES-256-GCM, chave derivada por PBKDF2-SHA-256) e só o arquivo cifrado vai para o Drive. **A senha não é guardada em lugar nenhum: sem ela, o backup não pode ser recuperado.**
5. **Recuperar**: selecione o arquivo, informe a senha, confira a prévia e confirme digitando RESTAURAR. Um backup criptografado baixado pelo site do Drive também pode ser restaurado por **Importar e restaurar**.

## Uso mensal

1. **Importar ponto** (ou lançar manualmente em **Marcações**). A importação mostra uma prévia, os erros e as duplicidades, e só grava depois que você confirma.
2. **Marcações**: clique num dia para ver os detalhes, incluir uma batida esquecida, corrigir um horário, excluir (desconsiderar) uma batida, registrar uma ocorrência ou marcar o dia como conferido. Toda correção exige justificativa, e o registro original nunca é apagado.
3. **Ocorrências e feriados**: feriados (para todos os funcionários), folgas, férias, faltas, atestados, abonos e folgas compensatórias.
4. **Banco de horas**: extrato acumulado, créditos e débitos por data, compensações e ajustes justificados.
5. **Fechamento mensal**: só é liberado quando não há pendências, o mês já terminou e o mês anterior está fechado. Depois de fechado, o mês fica protegido. A reabertura exige justificativa e, ao fechar de novo, os saldos dos meses seguintes são recalculados.
6. **Relatórios e impressão**: espelho mensal, extrato do banco, ocorrências, histórico de ajustes e resumo para a contabilidade. Use "Imprimir / Salvar como PDF" (papel A4).

## Backup (importante)

- **Backup → EXPORTAR BACKUP COMPLETO** gera um arquivo `.json` com todos os dados e um código de integridade SHA-256.
- Exporte ao fim de cada dia de uso, depois de importar, corrigir ou fechar um mês, e antes de trocar de navegador ou de computador. Guarde em uma pasta (ex.: `Documentos\Backups Ponto`) **e** em um segundo local. Não apague as versões antigas.
- **IMPORTAR E RESTAURAR BACKUP**: o sistema valida o formato, a versão, a integridade e as referências; mostra o conteúdo e pede confirmação (é preciso digitar RESTAURAR). A restauração **substitui** os dados atuais (não mistura nem duplica). Antes de restaurar, guarda uma cópia interna do estado anterior.
- O sistema conta as alterações feitas desde o último backup exportado. O contador fica gravado no navegador e continua valendo depois de recarregar a página. O **Painel** sempre mostra o contador. O **aviso amarelo no topo** aparece quando há alterações e: nunca houve backup, **ou** o último backup tem 7 dias ou mais, **ou** já são 50 alterações ou mais. Logo depois de um backup, poucas alterações **não** fazem o aviso aparecer.
- O sistema considera o backup feito no momento em que gera o arquivo. Ele não tem como saber se o download foi salvo ou cancelado: confira o arquivo na pasta de downloads.
- O arquivo de backup contém dados pessoais (LGPD): guarde-o com cuidado.
- **Google Drive (opcional):** a tela Backup também pode enviar o backup ao Google Drive e recuperá-lo de lá, pelo mesmo fluxo de validação e confirmação. Para isso, é preciso abrir o sistema por `http://localhost:8080` ou pelo GitHub Pages e configurar um Client ID próprio. O envio só é registrado como backup depois que o Google confirma o arquivo. O arquivo enviado é **criptografado com uma senha sua** (AES-256-GCM): a senha não é enviada nem guardada, e sem ela o backup não pode ser recuperado. O backup exportado localmente continua não criptografado. Os testes automatizados usam o Google simulado; o fluxo real, inclusive com criptografia, foi validado com dados fictícios em `http://localhost:8081`. Veja `docs/INTEGRACAO-GOOGLE-DRIVE.md`.

## Regras de cálculo

- Os cálculos são feitos em minutos inteiros (sem arredondamento intermediário). Os segundos das batidas são descartados.
- As batidas formam pares entrada/saída; o tempo entre os pares é o intervalo.
- Quantidade ímpar de batidas, ou dia útil passado sem batidas e sem ocorrência, deixa o dia **não apurado**: o saldo não entra no banco e o fechamento fica bloqueado. **O sistema não inventa batidas.**
- Batidas muito próximas uma da outra (3 min, configurável) são tratadas como possível duplicidade: ficam de fora do cálculo e exigem conferência.
- Tolerância diária padrão de 10 min (referência: art. 58, §1º da CLT), configurável por funcionário; use 0 para desativar.
- Jornadas que passam da meia-noite são aceitas. Batidas da madrugada são atribuídas ao dia anterior quando esse dia tem jornada noturna.
- Banco: **saldo final = saldo anterior + créditos − débitos + compensações + ajustes**. O saldo é sempre recalculado a partir dos registros: reprocessar não duplica nada e a virada do mês não zera o saldo. A política (créditos e débitos dentro ou fora do banco, limites de alerta) fica em Configurações.

## Relógio FR-1533

O layout do arquivo do relógio **ainda não foi verificado**. A importação atual lê qualquer texto delimitado (CSV/TXT) e deixa você escolher as colunas, com perfis reutilizáveis. Veja `docs/RELOGIO-FR1533.md`.

O arquivo `tests/fixtures/ARQUIVO-DE-TESTE_NAO-E-DO-RELOGIO.csv` foi **criado para testes** e não representa o formato do equipamento.

## Testes

Precisa do Node.js 22 ou mais recente, sem pacotes adicionais. Os testes foram executados apenas com o Node 24.

```
npm test                     # 82 testes: cálculo, banco, importação, backup, fluxos de dados, somente leitura, Google Drive (simulado) e criptografia
node tests/e2e-chrome.js     # 49 verificações no Chrome/Edge real (headless), abrindo via file://
node tests/auditoria-chrome.js  # 92 verificações: backup entre perfis, falhas de armazenamento, bloqueio entre abas
node tests/drive-chrome.js   # 67 verificações do Google Drive e da criptografia no Chrome real, com o Google SIMULADO
```

Os testes no navegador usam perfis temporários (não mexem nos seus dados) e somente dados fictícios. Eles geram em `tests/saida/` o PDF do espelho mensal, capturas das telas, o backup baixado e os resultados (`tests/saida/auditoria/resultado.txt`, `tests/saida/drive/resultado.txt`). O teste do Drive sobe um servidor temporário só em `127.0.0.1` durante a execução e não acessa a internet nem conta Google.

## Estrutura

```
index.html              interface (scripts clássicos, para funcionar via file://)
css/app.css, print.css  estilos de tela e de impressão A4
js/util.js              datas, horas, formatação, hash
js/calc.js              apuração diária e mensal (funções puras)
js/bank.js              banco de horas acumulado (funções puras)
js/importer.js          detecção e leitura genérica de arquivos de marcações
js/backup.js            montagem e validação de backups
js/cripto.js            criptografia dos backups com senha (AES-256-GCM, Web Crypto)
js/drive.js             integração opcional com o Google Drive (login, envio, listagem, download)
js/db.js                IndexedDB e adaptador em memória (testes)
js/store.js             regras de negócio, histórico, fechamento, importação, backup
js/ui.js, js/app.js     componentes de interface, inicialização e rotas
js/views/*.js           telas
tests/                  testes automatizados, auditoria no navegador e arquivo de teste
docs/                   relógio FR-1533 e integração com o Google Drive
```

Para transformar em aplicativo instalável (PWA), falta adicionar um `manifest.webmanifest` e um service worker. Isso só funciona com o sistema publicado em HTTPS (ex.: GitHub Pages), não abrindo o arquivo local.

## Limitações conhecidas

- Não há sincronização entre computadores ou navegadores; use o backup.
- Não há login nem perfis de usuário: quem usa o computador acessa os dados.
- **Várias abas:** somente uma aba por vez pode alterar dados (a primeira que foi aberta). As demais abrem em **modo somente leitura**, com o aviso "O sistema já está aberto em outra aba. Esta aba está em modo somente leitura.". Nelas é possível consultar, imprimir relatórios e exportar backup (sem registrar a data do backup). Quando a aba que edita é fechada ou recarregada, a próxima aba aberta assume a edição automaticamente e recarrega os dados. O controle usa o recurso de bloqueio do navegador (Web Locks). Em navegadores sem esse recurso, todas as abas ficam em somente leitura.
- Ao recarregar a aba que edita com outra aba aberta, a edição passa para a outra aba, e a aba recarregada fica em somente leitura. Para voltar a editar nela, feche a outra.
- Se houver texto digitado e ainda não salvo, a tela não é redesenhada por atualizações vindas de outra aba: aparece um aviso com o botão "Recarregar a tela agora". Ao fechar ou recarregar a aba com texto não salvo, ou com uma gravação em andamento, o navegador pede confirmação. Trocar de tela pelo menu ainda descarta o que foi digitado e não salvo.
- O bloqueio protege contra o uso normal pela interface. Ele não impede alguém de alterar os dados intencionalmente pelas ferramentas de desenvolvedor do navegador.
- O navegador pode negar o "armazenamento persistente" (aparece no canto inferior da tela). Nesse caso, faça backups com mais frequência.
- **Não use janela anônima/privativa.** Nela o navegador permite gravar, mas apaga tudo ao fechar a janela, e o sistema não consegue detectar essa situação.
- Se o armazenamento do navegador estiver indisponível ou bloqueado, o sistema mostra uma tela de erro e não opera. Se uma gravação falhar (ex.: falta de espaço), aparece a mensagem "Nenhum dado foi alterado" e os dados anteriores são mantidos.
- **Google Drive (opcional):**
  - só funciona com o sistema aberto por um endereço http(s) autorizado (ex.: `http://localhost:8080` ou GitHub Pages), não pelo arquivo local;
  - exige um Client ID criado por você no Google Cloud;
  - o sistema só enxerga os backups que ele mesmo enviou;
  - o backup enviado é **criptografado com uma senha sua** (AES-256-GCM); **sem a senha, ele não pode ser recuperado**;
  - o envio criptografado foi validado com o Google real só com dados fictícios, em `localhost:8081`;
  - foi validado com o Google real só com dados fictícios, em `localhost`; o GitHub Pages e arquivos acima de 5 MB não foram testados com o Google real.
  Veja `docs/INTEGRACAO-GOOGLE-DRIVE.md`.
