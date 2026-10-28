# Integração com o Google Drive

Integração **opcional** para guardar e recuperar backups no Google Drive. O sistema continua funcionando normalmente sem ela: com o Drive desconectado, sem Client ID configurado ou sem internet. O **backup local** (Backup → Exportar / Importar e restaurar) continua disponível e continua necessário.

> **Criptografia (LGPD):** todo backup enviado ao Drive é **criptografado neste navegador com uma senha escolhida por você** (AES-256-GCM, chave derivada por PBKDF2-SHA-256) antes do envio. O Google recebe apenas o arquivo cifrado; a senha nunca sai do navegador e não é guardada. **Sem a senha, o backup não pode ser recuperado** — não existe "esqueci a senha". Veja a seção [Criptografia dos backups](#criptografia-dos-backups).
>
> O backup **local** (Backup → Exportar) continua sendo um JSON comum, **não criptografado**: guarde-o com cuidado.

## Situação desta versão

- **Testes automatizados:** feitos com o Google simulado (biblioteca de login e Drive API substituídas por simulações, sem conta Google e sem rede).
- **Validação real em 27/10/2026**, só com dados fictícios (a funcionária de exemplo), em `http://localhost:8081`, com a conta de teste do projeto "Gerenciador de Ponto" no Google Cloud:
  - login e consentimento feitos pelo proprietário;
  - criação da pasta "Backups Gerenciador de Ponto";
  - dois envios, que criaram dois arquivos diferentes, confirmados pela API e visíveis no site do Drive;
  - listagem e download, com integridade verificada;
  - cancelamento da restauração, sem alterar dados;
  - restauração confirmada com `RESTAURAR`;
  - aba de leitura impedida de restaurar;
  - desconexão, sem apagar arquivos do Drive.
  - Nenhuma violação da política de segurança (CSP) foi registrada.
- **Não validados com o Google real:** o envio acima de 5 MB (*resumable*), o GitHub Pages, o vencimento real do token (cerca de 1 hora) e o comportamento com a conta fora da lista de usuários de teste.
- **Criptografia validada com o Google real em 27/10/2026**, de novo só com a funcionária de exemplo em `http://localhost:8081`:
  - envio criptografado confirmado pela API;
  - arquivo `backup-ponto-cripto_…` visível na pasta do Drive e marcado como criptografado;
  - conteúdo guardado no Google sem nenhum dado legível;
  - senha errada recusada e senha correta aceita;
  - cancelamento da restauração sem alterar dados;
  - restauração confirmada idêntica ao estado enviado;
  - desconexão sem apagar arquivos;
  - nenhuma violação de CSP e nenhum token ou senha no armazenamento do navegador.
- A criptografia também é coberta pelos testes automatizados (Node e Chrome real com o Google simulado).

## Arquitetura

| Parte | Onde | O que faz |
|---|---|---|
| Criptografia | `js/cripto.js` | Criptografa e descriptografa o backup com senha (Web Crypto API). Não grava nada. |
| Módulo do Drive | `js/drive.js` | Login, envio, listagem, download e desconexão. Traduz os erros para português. Não grava nenhum dado local. |
| Tela | `js/views/backup.js`, cartão "Google Drive (opcional)" | Botões, status e lista de arquivos. |
| Regras de backup | `js/store.js` | `gerarBackupParaEnvio()` e `registrarEnvioDrive()`; restauração por `validarBackup()` e `restaurarBackup()`, as mesmas do arquivo local. |

- **Sem servidor próprio e sem `client_secret`.** O login usa o *Google Identity Services* no modelo de token, a forma oficial para aplicações JavaScript que rodam só no navegador.
- **Sem a biblioteca `gapi`.** As chamadas à Drive API v3 são feitas diretamente com `fetch`.
- **Carga da biblioteca de login** (`https://accounts.google.com/gsi/client`): só acontece quando as três condições abaixo valem. Ela nunca é carregada ao iniciar o sistema.
  - a tela Backup está aberta;
  - há um Client ID configurado;
  - o sistema está aberto por http(s).
- **Token de acesso:**
  - Fica só num campo privado na memória da aba e vale cerca de 1 hora; o sistema o descarta 1 minuto antes.
  - Nunca é gravado em localStorage, IndexedDB, backup ou console.
  - Cada aba tem o seu: recarregar ou fechar a aba exige conectar de novo.
- **Client ID:**
  - É um identificador público, não um segredo.
  - Fica no localStorage deste navegador, como preferência da tela (chave `gerenciador-ponto:drive-client-id`).
  - Não entra no backup e não é gravado no banco de dados.

### Fluxo de envio

1. `store.gerarBackupParaEnvio()` monta o backup completo, com o mesmo formato, versão e hash SHA-256 da exportação local. Essa operação:
   - passa pela fila de gravação;
   - **não registra nada** ainda;
   - guarda o valor do contador de "alterações sem backup" naquele instante.
2. A tela pede a **senha de criptografia** (duas vezes) e `cripto.criptografar()` gera o arquivo cifrado. Cancelar a senha cancela o envio, sem registrar nada.
3. `drive.enviar(backup, { criptografado: true, conteudo })` procura a pasta **"Backups Gerenciador de Ponto"** e a cria se não existir. Depois cria um **arquivo novo**:
   - nome `backup-ponto-cripto_AAAA-MM-DD_HH-MM-SS_xxxxxx.json`, com data e hora reais e um sufixo aleatório;
   - metadados do Drive: só a marca de que é um backup deste sistema e de que é criptografado (nenhum dado do conteúdo, nem o hash);
   - envio *multipart* até 5 MB, *resumable* acima disso;
   - nada é sobrescrito.
4. O envio só é considerado feito quando o Google devolve o identificador, o nome e o tamanho do arquivo, e o tamanho confere com o enviado.
5. Só então `store.registrarEnvioDrive()`, também na fila de gravação:
   - registra a data do último backup;
   - **desconta do contador apenas as alterações que estavam no arquivo**;
   - grava o evento `backup-enviado-drive` na auditoria, indicando que o arquivo foi criptografado.
   - Se outro backup ou uma restauração foi registrado durante o envio, só a auditoria é gravada.
6. **Se o envio falhar:** a mensagem diz "Envio ao Google Drive NÃO confirmado", nada é registrado e os dados locais ficam intactos.

### Fluxo de recuperação

1. **Atualizar lista** consulta os backups deste sistema e mostra nome, proteção ("🔒 criptografado" ou "não criptografado", conforme a marca do Drive), data e tamanho. Os dados locais não mudam.
2. Ao selecionar um arquivo, ele fica destacado e aparece "Selecionado: …".
3. **Recuperar backup do Drive** baixa o arquivo e o entrega ao **mesmo fluxo da restauração local**:
   - se o **conteúdo** for um arquivo criptografado (nunca pelo nome ou pela marca do Drive), a tela pede a senha e descriptografa; senha errada ou arquivo alterado mostram o erro na própria janela, que permite tentar de novo ou cancelar;
   - validação de formato, versão, integridade (SHA-256) e referências do backup descriptografado;
   - prévia do conteúdo;
   - confirmação digitando `RESTAURAR`;
   - restauração em uma única transação, com cópia de segurança interna antes.
4. Arquivo inválido, senha errada, arquivo adulterado e cancelamento (da senha ou da confirmação) não alteram nada. Nunca há mistura entre o backup e os dados atuais.
5. O mesmo vale para **Importar e restaurar** com um arquivo local: um backup criptografado baixado pelo site do Drive é reconhecido e pede a senha.

## Criptografia dos backups

### Algoritmos e parâmetros

| Item | Valor |
|---|---|
| Implementação | Web Crypto API do navegador (`crypto.subtle`), sem bibliotecas externas |
| Cifra | AES-GCM, chave de 256 bits, IV aleatório de 96 bits (novo a cada arquivo), tag de autenticação de 128 bits |
| Derivação da chave | PBKDF2-HMAC-SHA-256, sal aleatório de 128 bits (novo a cada arquivo), 600.000 iterações |
| Dados autenticados (AAD) | Todo o cabeçalho: formato, versão, data, aviso, parâmetros da derivação, sal, cifra e IV |
| Senha | Mínimo de 12 e máximo de 256 caracteres, sem espaço no início nem no fim; normalizada em Unicode NFC |

- A chave é derivada **somente da senha** digitada (mais o sal aleatório do arquivo). Ela não é fixa, não está no código e não tem relação com o Client ID.
- Na leitura, só são aceitos os parâmetros acima, com iterações entre 100.000 e 5.000.000. Um arquivo fora disso é recusado antes de pedir a senha.

### Formato do arquivo

O arquivo continua sendo JSON:

```json
{
  "formato": "gerenciador-ponto-backup-criptografado",
  "versaoFormato": 1,
  "criadoEm": "2026-10-28T01:06:07.738Z",
  "aviso": "Backup criptografado do Gerenciador de Ponto. Sem a senha ...",
  "kdf":   { "algoritmo": "PBKDF2", "hash": "SHA-256", "iteracoes": 600000, "sal": "<base64>" },
  "cifra": { "algoritmo": "AES-GCM", "tamanhoChave": 256, "iv": "<base64>", "tagBits": 128 },
  "dados": "<base64 do backup cifrado, com a tag>"
}
```

- O conteúdo cifrado é **o mesmo backup JSON** da exportação local, com seu próprio código SHA-256. Depois de descriptografado, ele passa pela validação de sempre.
- O sistema reconhece um arquivo criptografado **pelo conteúdo** (`formato`), nunca pelo nome ou pela extensão. Um backup comum tem `"formato": "gerenciador-ponto-backup"`.

### Verificação de integridade em duas camadas

1. **A tag do AES-GCM autentica o conteúdo e o cabeçalho.** Senha errada, qualquer byte alterado, cabeçalho alterado ou arquivo truncado fazem a descriptografia falhar. A mensagem é a mesma nos quatro casos: "a senha está incorreta ou o arquivo foi alterado ou está corrompido". A cifra não distingue esses casos.
2. **O SHA-256 e as regras do backup** são conferidos depois, como em qualquer restauração.

### Senha

- **Envio:** a senha é pedida a cada envio, digitada duas vezes.
- **Restauração:** a senha é pedida quando um arquivo criptografado é aberto.
- **Armazenamento:** a senha **não é guardada** em localStorage, sessionStorage, IndexedDB, configurações, backups ou logs. O campo é limpo e a janela removida logo após o uso.
- **Envio ao Google:** a senha nunca é enviada ao Google nem a lugar nenhum.
- **Perda da senha:** quem perder a senha **perde aquele backup**. O sistema e o Google não conseguem recuperá-lo.
  - Guarde a senha em um gerenciador de senhas ou em papel, em local seguro.
  - Mantenha também o backup local.
- **Senhas diferentes:** cada backup pode ter uma senha diferente. A senha certa é a usada na criação daquele arquivo.
- **Limitação do JavaScript:** não é possível apagar de forma garantida um texto da memória do navegador. A senha fica só na memória da página durante a operação e some quando a página é fechada.
- **Gerenciador de senhas:** o Chrome pode oferecer salvar a senha no próprio gerenciador. Aceitar ou não é escolha sua. O sistema não guarda nada.

### Compatibilidade

- **Backups antigos sem criptografia**, locais ou do Drive:
  - continuam sendo aceitos na restauração;
  - aparecem como "não criptografado" na lista e "Este backup não é criptografado" na prévia;
  - não são criptografados nem migrados automaticamente;
  - se quiser removê-los do Drive, apague-os manualmente pelo site do Drive.
- **Exportação local:** continua gerando JSON comum, não criptografado.

### Várias abas

O bloqueio de edição entre abas (Web Locks) e a fila de gravação não foram alterados.

| Ação | Aba editora | Aba somente leitura |
|---|---|---|
| Configurar Client ID, conectar, listar | Permitido | Permitido |
| Enviar backup ao Drive | Permitido; registra data, contador e auditoria | Permitido; **não** registra data nem contador |
| Recuperar e restaurar | Permitido | **Bloqueado**, na tela e na camada de dados |

Falhas de login, rede ou download não alteram o modo de edição da aba.

## Escopo de acesso

O sistema pede um único escopo, `https://www.googleapis.com/auth/drive.file`. Com ele, o sistema só acessa **os arquivos que ele mesmo criou**. Os backups ficam numa pasta visível do seu Drive.

**Limitações do `drive.file`:**
- **Arquivos colocados por você no Drive não aparecem** na lista, nem os criados com outro Client ID ou outro projeto do Google Cloud. Para restaurar um desses, baixe-o pelo site do Drive e use **Backup → Importar e restaurar**.
- Se você trocar o Client ID (outro projeto), os backups antigos continuam no Drive, mas deixam de aparecer na lista.
- Se você mover o arquivo para outra pasta, ele continua aparecendo, porque a listagem usa uma marcação interna do arquivo (`appProperties`), não a pasta.

O seletor oficial de arquivos do Google (Google Picker) resolveria essas limitações, mas exige uma chave de API e outro script externo. Ele ficou **fora desta etapa**.

O escopo `drive.appdata` **não é usado**, porque esconderia os backups da interface normal do Drive.

## Política de segurança da página (CSP)

Antes da integração, nenhum recurso externo era permitido (`connect-src 'none'`). Exceções acrescentadas, todas restritas a endereços exatos:

| Diretiva | Valor acrescentado | Motivo |
|---|---|---|
| `script-src` | `https://accounts.google.com/gsi/client` | Biblioteca oficial de login (somente esse arquivo). |
| `style-src` | `https://accounts.google.com/gsi/style` | Folha de estilo que essa biblioteca injeta, conforme a documentação de CSP do Google Identity Services. |
| `connect-src` | `https://www.googleapis.com/drive/v3/` | Drive API: procurar e criar a pasta, listar e baixar. |
| `connect-src` | `https://www.googleapis.com/upload/drive/v3/` | Envio do arquivo. |
| `connect-src` | `https://oauth2.googleapis.com/revoke` | Revogar o token ao desconectar. |

Ficam iguais `default-src 'self'`, `img-src`, `object-src 'none'`, `base-uri 'none'` e `form-action 'none'`.

Nenhum domínio genérico foi liberado: nada de `*.google.com`, `https:` ou `'unsafe-eval'`. O teste `tests/drive-chrome.js` confere que outros domínios, outros caminhos do Google e scripts como `apis.google.com` continuam bloqueados.

A documentação do Google para essa biblioteca lista também `frame-src` e `connect-src` para `https://accounts.google.com/gsi/`, usados pelo botão "Fazer login com o Google" e pelo One Tap. Este sistema não usa nenhum dos dois, então eles **não** foram liberados. Se o teste com o Google real mostrar bloqueio no console, procure "Content Security Policy" e acrescente somente o endereço indicado.

## Configuração no Google Cloud Console (feita por você)

Nunca informe senha, código de autenticação ou "client secret" a ninguém, nem no sistema.

1. Acesse <https://console.cloud.google.com/> com a conta Google que vai guardar os backups.
2. **Crie um projeto**: seletor de projetos → Novo projeto, por exemplo "Gerenciador de Ponto".
3. **Ative a Drive API**: APIs e serviços → Biblioteca → "Google Drive API" → Ativar.
4. **Configure a tela de consentimento OAuth** (APIs e serviços → Tela de consentimento OAuth, ou "Google Auth Platform"):
   - **Tipo de usuário:** Externo.
   - **Dados:** nome do app, e-mail de suporte e e-mail do desenvolvedor.
   - **Escopos:** adicione `.../auth/drive.file`.
   - **Status de publicação:** "Em teste". Inclua o seu e-mail em **Usuários de teste**; só esses e-mails conseguem fazer login.
5. **Crie o ID do cliente OAuth** (APIs e serviços → Credenciais → Criar credenciais → ID do cliente OAuth):
   - **Tipo:** Aplicativo da Web.
   - **Origens JavaScript autorizadas:**
     - `http://localhost:8080`, para desenvolvimento;
     - opcionalmente, `http://localhost:8081`, para um ambiente de teste separado, só com dados fictícios. Ele tem armazenamento próprio, porque cada porta é uma origem diferente;
     - `https://SEU-USUARIO.github.io`, quando publicar. É só a origem, sem caminho e sem barra final.
   - **URIs de redirecionamento autorizados:** deixe em branco; o modelo de token não usa.
   - Salve e copie o **ID do cliente**, que termina em `.apps.googleusercontent.com`.
   - O Google também mostra um *client secret*: **não o copie para lugar nenhum**. Ele não é usado.
6. Mudanças nas origens podem levar alguns minutos para valer.

`127.0.0.1:8080` e `localhost:8080` são origens diferentes para o Google: abra sempre pelo endereço que você cadastrou.

## Como servir o sistema em `http://localhost:8080`

O login do Google **não funciona** abrindo o `index.html` direto (`file://`). Nesse caso, a tela mostra o Drive como "Indisponível ao abrir como arquivo local".

Para desenvolvimento, sirva a pasta do projeto com qualquer servidor estático, por exemplo:

```
python -m http.server 8080 --bind 127.0.0.1
```

ou

```
npx --yes http-server -p 8080 -a 127.0.0.1
```

Esses comandos são rodados por você; o sistema não inclui nem inicia servidor nenhum. Abra `http://localhost:8080/index.html` (com "localhost", como cadastrado no Google). O segundo comando baixa um pacote da internet.

## Migração dos dados de `file://` para `http://localhost:8080` (ou GitHub Pages)

Os dados do navegador são **separados por endereço**: o que está gravado ao abrir pelo arquivo local não aparece em `http://localhost:8080`, e vice-versa.

1. Abra o sistema **pelo endereço antigo**, o arquivo local, e use **Backup → EXPORTAR BACKUP COMPLETO**. Confira o arquivo baixado.
2. Abra o sistema **pelo endereço novo** e use **Backup → Importar e restaurar** com esse arquivo, confirmando com `RESTAURAR`.
3. Confira funcionários, marcações, saldos e fechamentos no endereço novo.
4. **Não apague** os dados do endereço antigo. Eles continuam lá como reserva.
5. A partir daí, use sempre o endereço novo.

## Uso

1. **Backup → Google Drive (opcional)** → cole o Client ID → **Salvar Client ID**. Formato aceito: `123456789012-abc….apps.googleusercontent.com`. Um valor que pareça "client secret" é recusado.
2. **Conectar Google Drive**: abre a janela do Google. Escolha a conta, confira a permissão de acesso aos arquivos criados pelo app e permita. Se o navegador bloquear a janela, permita pop-ups para o endereço do sistema.
3. **Enviar backup ao Drive**: informe e repita a senha de criptografia (mínimo de 12 caracteres). O sucesso só aparece depois da confirmação do Google.
4. **Atualizar lista** → selecione um arquivo → **Recuperar backup do Drive** → informe a senha (se o arquivo for criptografado) → confira a prévia → **IMPORTAR E RESTAURAR BACKUP** → digite `RESTAURAR`.
5. **Desconectar**: o token sai da memória da aba e é revogado no Google. Nenhum arquivo do Drive é apagado.

Status possíveis:
- aguardando configuração;
- indisponível ao abrir como arquivo local;
- carregando;
- desconectado;
- aguardando o login;
- conectado;
- sessão expirada;
- sem internet;
- erro.

## Tratamento de erros

| Situação | O que o sistema faz |
|---|---|
| Sem Client ID ou Client ID inválido | Status "aguardando configuração"; o valor inválido não é salvo. |
| Biblioteca do Google não carrega | Status "erro" ou "sem internet". O botão Conectar tenta carregar de novo. |
| Janela fechada ou login cancelado | Aviso "Login cancelado"; continua desconectado. |
| Janela bloqueada pelo navegador | Pede para permitir pop-ups. |
| Acesso negado, ou opção do Drive desmarcada no consentimento | Mensagem de permissão; o token parcial é revogado. |
| Client ID ou origem não autorizados | "O Google recusou o login"; verifique as origens no Google Cloud. |
| Token expirado ou revogado (HTTP 401) | O token é descartado e o status vira "sessão expirada"; é preciso conectar de novo. |
| Permissão negada (403) | Mensagem com o motivo; verifique se a Drive API está ativada. |
| Drive sem espaço (403) | Mensagem específica. |
| Limite de uso da API (403/429) | Pede para aguardar alguns minutos. Nada é repetido automaticamente. |
| Arquivo não encontrado (404) | Mensagem; a lista pode ser atualizada. |
| Erro do Google (5xx) ou falha de rede | Mensagem; nada é registrado. |
| Resposta inesperada ou tamanho divergente | "Envio NÃO confirmado"; nada é registrado. |
| Arquivo baixado inválido | Recusado pela validação do backup; nada é alterado. |
| Senha do envio curta ou digitada diferente | Recusada na própria janela; nada é enviado. |
| Senha do envio cancelada | "Envio cancelado"; nada é enviado nem registrado. |
| Senha errada, arquivo criptografado alterado ou truncado | "A senha está incorreta ou o arquivo foi alterado ou está corrompido"; a janela permite tentar de novo ou cancelar; nada é alterado. |
| Arquivo criptografado com parâmetros fora do aceito, versão desconhecida ou vazio | Recusado antes de pedir a senha; nada é alterado. |
| Senha do arquivo cancelada | "Senha não informada: restauração cancelada"; nada é alterado. |

O console do navegador nunca recebe token nem conteúdo de backup.

## Como revogar o acesso

- **No sistema:** Backup → **Desconectar**. Revoga o token desta aba.
- **Na conta Google:** <https://myaccount.google.com/permissions> → selecione o app → **Remover acesso**. Os arquivos já enviados continuam no seu Drive; apague-os manualmente, se quiser.
- **No Google Cloud:** excluir o ID do cliente impede novos logins.

## Testes

- `node --test tests/drive.test.js`: módulo do Drive com Google e rede simulados. Faz parte de `npm test`.
- `node --test tests/cripto.test.js`: criptografia, também parte de `npm test`. Cobre:
  - ida e volta com recuperação exata do conteúdo;
  - sal e IV novos a cada arquivo;
  - senha errada;
  - alteração de cada parte do arquivo;
  - arquivos vazios, truncados ou com parâmetros inválidos;
  - regras de senha;
  - restauração sem alterar nada em caso de falha;
  - aba de leitura;
  - arquivo acima de 6 MB;
  - envio criptografado ao Drive simulado sem vazar dados pessoais ou a senha.
- `node tests/drive-chrome.js`: Chrome real com perfil temporário. Detalhes:
  - um servidor HTTP temporário roda em `127.0.0.1`, numa porta aleatória, só durante o teste;
  - a biblioteca do Google e a Drive API são interceptadas e simuladas;
  - qualquer outro endereço é bloqueado;
  - nenhuma conta Google é usada e nenhum dado sai do computador.

### Roteiro de teste manual com o Google real (quando você autorizar)

Use dados fictícios: um endereço separado só para teste, como `http://localhost:8081`, com a funcionária de exemplo. A validação de 27/10/2026 foi feita assim.

1. Sirva em `http://localhost:8081` (`python -m http.server 8081 --bind 127.0.0.1`) e abra `http://localhost:8081/index.html#/backup`.
2. Salve o Client ID e confira o status "Desconectado".
3. **Conectar:** faça o login na janela do Google. Status "Conectado"; a lista aparece vazia.
4. **Enviar**, com uma senha de teste:
   - confira no site do Drive a pasta "Backups Gerenciador de Ponto" e o arquivo `backup-ponto-cripto_…`;
   - abra o arquivo no Drive: o conteúdo deve ser só texto cifrado, sem nomes nem horários;
   - o contador da tela Backup deve zerar.
5. Envie de novo e confira dois arquivos com nomes diferentes.
6. Recupere um deles:
   - com uma senha errada, a janela deve recusar;
   - com a senha certa, confira a prévia "Backup criptografado";
   - cancele e confira que nada mudou;
   - depois restaure digitando `RESTAURAR`.
7. Clique em Desconectar. O app deve deixar de constar como conectado em <https://myaccount.google.com/permissions>.
8. Durante todo o teste, observe o console do navegador (F12): **não deve haver** erros de "Content Security Policy".
