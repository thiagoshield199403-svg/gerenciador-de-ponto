# Relógio FR-1533 — o que falta quando o equipamento chegar

O formato do arquivo exportado pelo relógio **ainda não é conhecido**. O sistema não presume nenhum layout e não afirma compatibilidade.

## Roteiro de verificação (quando o relógio chegar)

1. Cadastre a funcionária no relógio e anote o **código/matrícula** que o equipamento atribui. Informe o mesmo valor em *Funcionários → Identificador no relógio*.
2. Faça algumas batidas de teste em horários conhecidos (anote-os em papel).
3. Exporte as marcações pelo relógio (normalmente para pen drive). Verifique no manual:
   - formatos disponíveis (TXT, CSV, XLS, DAT, AFD…);
   - se há opção de exportar "registros de presença"/"attendance log" em texto.
4. No sistema, abra **Importar ponto** e selecione o arquivo **sem confirmar**. Confira:
   - "Tipo": se aparecer *Binário*, o relógio não exportou texto. Procure outra opção de exportação no menu do relógio.
   - "Primeiras linhas do arquivo": veja como as colunas estão organizadas.
   - Ajuste as colunas (identificador, data, hora, formato da data, linhas de cabeçalho) até a prévia mostrar exatamente as batidas anotadas no passo 2.
5. Salve o mapeamento como **perfil** (ex.: "Relógio FR-1533 – TXT").
6. Só então confirme a importação. Guarde uma cópia do arquivo original.

## Se o arquivo não for texto delimitado

Se o formato real for binário ou tiver layout fixo (colunas por posição), será necessário criar um leitor dedicado em `js/importer.js` (lista `I.LEITORES`), com testes usando **cópias anonimizadas** do arquivo real. Não use o arquivo de teste do projeto (`tests/fixtures/ARQUIVO-DE-TESTE_NAO-E-DO-RELOGIO.csv`) como referência do formato do relógio — ele foi criado apenas para testar o sistema.

## Formato AFD (Portaria MTP 671/2021)

Alguns relógios exportam o AFD (Arquivo Fonte de Dados). O layout do AFD é público, mas este sistema **não implementa** a leitura do AFD nesta versão, porque não foi confirmado que o FR-1533 o gera. Se o equipamento exportar AFD, a implementação deve seguir o leiaute oficial e ser testada com arquivo real.
