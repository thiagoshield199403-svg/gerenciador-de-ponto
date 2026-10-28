/*
 * cripto.js — Criptografia de arquivos de backup com senha (Web Crypto API).
 *
 * - Cifra autenticada: AES-GCM com chave de 256 bits, IV aleatório de 96 bits e tag de 128 bits.
 * - Derivação da chave: PBKDF2-HMAC-SHA-256, sal aleatório de 128 bits, 600.000 iterações
 *   (os parâmetros ficam no arquivo; na leitura só são aceitos os valores dentro dos limites abaixo).
 * - O cabeçalho (formato, versão, data, parâmetros, sal e IV) entra como "dados adicionais
 *   autenticados" do GCM: alterar qualquer campo, o conteúdo ou a tag faz a descriptografia falhar.
 * - O conteúdo cifrado é o backup JSON completo, que continua tendo o próprio SHA-256 e passa
 *   pela mesma validação de sempre depois de descriptografado.
 * - A senha e a chave derivada existem só durante a operação, na memória da página. Nada é gravado
 *   nem escrito no console. Sem a senha, o arquivo NÃO pode ser recuperado.
 *
 * Funciona no navegador e no Node (globalThis.crypto.subtle), o que permite testar o mesmo código.
 */
(function (root) {
  'use strict';

  const FORMATO = 'gerenciador-ponto-backup-criptografado';
  const VERSAO_FORMATO = 1;
  const ITERACOES = 600000;
  const LIMITES_ITERACOES = [100000, 5000000]; // fora disso o arquivo é recusado (inválido ou lento demais)
  const BYTES_SAL = 16, BYTES_IV = 12, BITS_TAG = 128;
  const SENHA_MIN = 12, SENHA_MAX = 256;

  class ErroCripto extends Error {
    constructor(msg, codigo) { super(msg); this.name = 'ErroCripto'; this.codigo = codigo || 'cripto'; }
  }

  const subtle = () => {
    const s = root.crypto && root.crypto.subtle;
    if (!s) throw new ErroCripto('Este navegador não oferece a criptografia necessária (Web Crypto). Use uma versão atual do Chrome ou Edge, aberta por http://localhost ou https.', 'sem-suporte');
    return s;
  };

  function aleatorio(n) { const b = new Uint8Array(n); root.crypto.getRandomValues(b); return b; }

  function paraBase64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return root.btoa(s);
  }

  function deBase64(txt, rotulo) {
    if (typeof txt !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(txt) || txt.length % 4 !== 0) throw new ErroCripto('Arquivo criptografado inválido: campo "' + rotulo + '" corrompido.', 'formato');
    const s = root.atob(txt);
    const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    return b;
  }

  /** Regras para CRIAR uma senha (na leitura, qualquer senha é tentada). */
  function validarNovaSenha(senha, confirmacao) {
    if (typeof senha !== 'string' || senha.length < SENHA_MIN) return 'A senha precisa ter pelo menos ' + SENHA_MIN + ' caracteres. Prefira uma frase longa, fácil de lembrar e difícil de adivinhar.';
    if (senha.length > SENHA_MAX) return 'A senha pode ter no máximo ' + SENHA_MAX + ' caracteres.';
    if (senha.trim() !== senha) return 'A senha não pode começar nem terminar com espaço.';
    if (confirmacao !== undefined && senha !== confirmacao) return 'As duas senhas digitadas não são iguais.';
    return null;
  }

  function ehCriptografado(obj) { return !!obj && typeof obj === 'object' && !Array.isArray(obj) && obj.formato === FORMATO; }

  /** Dados adicionais autenticados: o cabeçalho inteiro, em ordem fixa. */
  function aad(e) {
    return new TextEncoder().encode(JSON.stringify([e.formato, e.versaoFormato, e.criadoEm, typeof e.aviso === 'string' ? e.aviso : null,
      e.kdf.algoritmo, e.kdf.hash, e.kdf.iteracoes, e.kdf.sal, e.cifra.algoritmo, e.cifra.tamanhoChave, e.cifra.iv, e.cifra.tagBits]));
  }

  async function derivarChave(senha, sal, iteracoes, usos) {
    const s = subtle();
    const base = await s.importKey('raw', new TextEncoder().encode(senha.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
    return s.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: sal, iterations: iteracoes }, base, { name: 'AES-GCM', length: 256 }, false, usos);
  }

  /**
   * Criptografa um texto (o JSON do backup). Retorna o objeto do arquivo criptografado.
   * opts.iteracoes só existe para testes; o padrão é ITERACOES.
   */
  async function criptografar(texto, senha, opts) {
    opts = opts || {};
    if (typeof texto !== 'string' || !texto) throw new ErroCripto('Nada para criptografar.', 'entrada');
    const erroSenha = validarNovaSenha(senha);
    if (erroSenha) throw new ErroCripto(erroSenha, 'senha-fraca');
    const iteracoes = opts.iteracoes || ITERACOES;
    if (!Number.isInteger(iteracoes) || iteracoes < LIMITES_ITERACOES[0] || iteracoes > LIMITES_ITERACOES[1]) throw new ErroCripto('Parâmetro de derivação inválido.', 'parametros');
    const sal = aleatorio(BYTES_SAL), iv = aleatorio(BYTES_IV);
    const env = {
      formato: FORMATO,
      versaoFormato: VERSAO_FORMATO,
      criadoEm: new Date().toISOString(),
      aviso: 'Backup criptografado do Gerenciador de Ponto. Sem a senha usada na criação, o conteúdo não pode ser recuperado.',
      kdf: { algoritmo: 'PBKDF2', hash: 'SHA-256', iteracoes, sal: paraBase64(sal) },
      cifra: { algoritmo: 'AES-GCM', tamanhoChave: 256, iv: paraBase64(iv), tagBits: BITS_TAG },
      dados: ''
    };
    const chave = await derivarChave(senha, sal, iteracoes, ['encrypt']);
    const cifrado = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aad(env), tagLength: BITS_TAG }, chave, new TextEncoder().encode(texto));
    env.dados = paraBase64(new Uint8Array(cifrado));
    return env;
  }

  /** Confere a estrutura e os parâmetros do arquivo antes de tentar a senha. Lança ErroCripto. */
  function conferirEnvelope(e) {
    if (!ehCriptografado(e)) throw new ErroCripto('Este arquivo não é um backup criptografado do Gerenciador de Ponto.', 'formato');
    if (e.versaoFormato !== VERSAO_FORMATO) throw new ErroCripto('Versão de backup criptografado não suportada (' + e.versaoFormato + '). Atualize o sistema antes de restaurar.', 'versao');
    if (typeof e.criadoEm !== 'string' || isNaN(new Date(e.criadoEm))) throw new ErroCripto('Arquivo criptografado inválido: data de criação ausente.', 'formato');
    const k = e.kdf || {}, c = e.cifra || {};
    if (k.algoritmo !== 'PBKDF2' || k.hash !== 'SHA-256' || !Number.isInteger(k.iteracoes) || k.iteracoes < LIMITES_ITERACOES[0] || k.iteracoes > LIMITES_ITERACOES[1]) {
      throw new ErroCripto('Arquivo criptografado com parâmetros de derivação não aceitos.', 'parametros');
    }
    if (c.algoritmo !== 'AES-GCM' || c.tamanhoChave !== 256 || c.tagBits !== BITS_TAG) throw new ErroCripto('Arquivo criptografado com cifra não aceita.', 'parametros');
    const sal = deBase64(k.sal, 'sal'), iv = deBase64(c.iv, 'iv'), dados = deBase64(e.dados, 'dados');
    if (sal.length !== BYTES_SAL || iv.length !== BYTES_IV) throw new ErroCripto('Arquivo criptografado inválido: sal ou IV com tamanho incorreto.', 'parametros');
    if (dados.length <= BITS_TAG / 8) throw new ErroCripto('Arquivo criptografado vazio ou truncado.', 'formato');
    return { sal, iv, dados };
  }

  /**
   * Descriptografa. Senha errada, conteúdo alterado, cabeçalho alterado ou arquivo truncado falham
   * da mesma forma (a cifra autenticada não distingue esses casos) e nada é devolvido.
   */
  async function descriptografar(e, senha) {
    const { sal, iv, dados } = conferirEnvelope(e);
    if (typeof senha !== 'string' || !senha) throw new ErroCripto('Informe a senha do backup.', 'sem-senha');
    const chave = await derivarChave(senha, sal, e.kdf.iteracoes, ['decrypt']);
    let claro;
    try {
      claro = await subtle().decrypt({ name: 'AES-GCM', iv, additionalData: aad(e), tagLength: BITS_TAG }, chave, dados);
    } catch (erro) {
      throw new ErroCripto('Não foi possível descriptografar: a senha está incorreta ou o arquivo foi alterado ou está corrompido. Nenhum dado foi alterado.', 'senha-ou-adulterado');
    }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(claro); } catch (erro) {
      throw new ErroCripto('O conteúdo descriptografado não é um texto válido.', 'conteudo');
    }
  }

  const api = { FORMATO, VERSAO_FORMATO, ITERACOES, LIMITES_ITERACOES, SENHA_MIN, ErroCripto, ehCriptografado, validarNovaSenha, criptografar, descriptografar, conferirEnvelope };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Ponto = root.Ponto || {}; root.Ponto.cripto = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this);
