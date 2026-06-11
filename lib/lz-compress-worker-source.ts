/**
 * Fonte do compressor lz-string VENDORIZADO que roda dentro do Web Worker de
 * compressão (ver `lib/storage.ts`). Vive num módulo SEM dependências (nenhum
 * import `@/` nem browser) por dois motivos:
 *
 *  1. O worker é criado a partir de uma string (Blob URL) — ele não pode
 *     `import` de módulos do bundle, então o código precisa existir como texto.
 *  2. Assim o teste `scripts/test-lz-compress-vendored.mjs` consegue importar a
 *     MESMA string por caminho relativo (node `--experimental-strip-types` não
 *     resolve `@/` em import de valor) e travar drift contra o lz-string do npm.
 *
 * ⚠️ `_compress` abaixo é cópia VERBATIM de `node_modules/lz-string/libs/
 * lz-string.js` (LZ-string v1.4.5 — formato estável há anos). A LEITURA do
 * storage continua usando `decompressFromUTF16` do npm; só a ESCRITA usa esta
 * cópia. O literal "LZ1:" espelha `COMPRESSED_PREFIX` de `lib/storage.ts` —
 * manter os dois em sincronia. O teste compara byte-a-byte com o npm.
 */

/** Compressor vendorizado + shim `compressToUTF16` (sem o handler do worker). */
export const COMPRESS_FN_SOURCE = `
var f = String.fromCharCode;
function _compress(uncompressed, bitsPerChar, getCharFromInt) {
  if (uncompressed == null) return "";
  var i, value,
      context_dictionary= {},
      context_dictionaryToCreate= {},
      context_c="",
      context_wc="",
      context_w="",
      context_enlargeIn= 2,
      context_dictSize= 3,
      context_numBits= 2,
      context_data=[],
      context_data_val=0,
      context_data_position=0,
      ii;
  for (ii = 0; ii < uncompressed.length; ii += 1) {
    context_c = uncompressed.charAt(ii);
    if (!Object.prototype.hasOwnProperty.call(context_dictionary,context_c)) {
      context_dictionary[context_c] = context_dictSize++;
      context_dictionaryToCreate[context_c] = true;
    }
    context_wc = context_w + context_c;
    if (Object.prototype.hasOwnProperty.call(context_dictionary,context_wc)) {
      context_w = context_wc;
    } else {
      if (Object.prototype.hasOwnProperty.call(context_dictionaryToCreate,context_w)) {
        if (context_w.charCodeAt(0)<256) {
          for (i=0 ; i<context_numBits ; i++) {
            context_data_val = (context_data_val << 1);
            if (context_data_position == bitsPerChar-1) {
              context_data_position = 0;
              context_data.push(getCharFromInt(context_data_val));
              context_data_val = 0;
            } else { context_data_position++; }
          }
          value = context_w.charCodeAt(0);
          for (i=0 ; i<8 ; i++) {
            context_data_val = (context_data_val << 1) | (value&1);
            if (context_data_position == bitsPerChar-1) {
              context_data_position = 0;
              context_data.push(getCharFromInt(context_data_val));
              context_data_val = 0;
            } else { context_data_position++; }
            value = value >> 1;
          }
        } else {
          value = 1;
          for (i=0 ; i<context_numBits ; i++) {
            context_data_val = (context_data_val << 1) | value;
            if (context_data_position ==bitsPerChar-1) {
              context_data_position = 0;
              context_data.push(getCharFromInt(context_data_val));
              context_data_val = 0;
            } else { context_data_position++; }
            value = 0;
          }
          value = context_w.charCodeAt(0);
          for (i=0 ; i<16 ; i++) {
            context_data_val = (context_data_val << 1) | (value&1);
            if (context_data_position == bitsPerChar-1) {
              context_data_position = 0;
              context_data.push(getCharFromInt(context_data_val));
              context_data_val = 0;
            } else { context_data_position++; }
            value = value >> 1;
          }
        }
        context_enlargeIn--;
        if (context_enlargeIn == 0) {
          context_enlargeIn = Math.pow(2, context_numBits);
          context_numBits++;
        }
        delete context_dictionaryToCreate[context_w];
      } else {
        value = context_dictionary[context_w];
        for (i=0 ; i<context_numBits ; i++) {
          context_data_val = (context_data_val << 1) | (value&1);
          if (context_data_position == bitsPerChar-1) {
            context_data_position = 0;
            context_data.push(getCharFromInt(context_data_val));
            context_data_val = 0;
          } else { context_data_position++; }
          value = value >> 1;
        }
      }
      context_enlargeIn--;
      if (context_enlargeIn == 0) {
        context_enlargeIn = Math.pow(2, context_numBits);
        context_numBits++;
      }
      context_dictionary[context_wc] = context_dictSize++;
      context_w = String(context_c);
    }
  }
  if (context_w !== "") {
    if (Object.prototype.hasOwnProperty.call(context_dictionaryToCreate,context_w)) {
      if (context_w.charCodeAt(0)<256) {
        for (i=0 ; i<context_numBits ; i++) {
          context_data_val = (context_data_val << 1);
          if (context_data_position == bitsPerChar-1) {
            context_data_position = 0;
            context_data.push(getCharFromInt(context_data_val));
            context_data_val = 0;
          } else { context_data_position++; }
        }
        value = context_w.charCodeAt(0);
        for (i=0 ; i<8 ; i++) {
          context_data_val = (context_data_val << 1) | (value&1);
          if (context_data_position == bitsPerChar-1) {
            context_data_position = 0;
            context_data.push(getCharFromInt(context_data_val));
            context_data_val = 0;
          } else { context_data_position++; }
          value = value >> 1;
        }
      } else {
        value = 1;
        for (i=0 ; i<context_numBits ; i++) {
          context_data_val = (context_data_val << 1) | value;
          if (context_data_position == bitsPerChar-1) {
            context_data_position = 0;
            context_data.push(getCharFromInt(context_data_val));
            context_data_val = 0;
          } else { context_data_position++; }
          value = 0;
        }
        value = context_w.charCodeAt(0);
        for (i=0 ; i<16 ; i++) {
          context_data_val = (context_data_val << 1) | (value&1);
          if (context_data_position == bitsPerChar-1) {
            context_data_position = 0;
            context_data.push(getCharFromInt(context_data_val));
            context_data_val = 0;
          } else { context_data_position++; }
          value = value >> 1;
        }
      }
      context_enlargeIn--;
      if (context_enlargeIn == 0) {
        context_enlargeIn = Math.pow(2, context_numBits);
        context_numBits++;
      }
      delete context_dictionaryToCreate[context_w];
    } else {
      value = context_dictionary[context_w];
      for (i=0 ; i<context_numBits ; i++) {
        context_data_val = (context_data_val << 1) | (value&1);
        if (context_data_position == bitsPerChar-1) {
          context_data_position = 0;
          context_data.push(getCharFromInt(context_data_val));
          context_data_val = 0;
        } else { context_data_position++; }
        value = value >> 1;
      }
    }
    context_enlargeIn--;
    if (context_enlargeIn == 0) {
      context_enlargeIn = Math.pow(2, context_numBits);
      context_numBits++;
    }
  }
  value = 2;
  for (i=0 ; i<context_numBits ; i++) {
    context_data_val = (context_data_val << 1) | (value&1);
    if (context_data_position == bitsPerChar-1) {
      context_data_position = 0;
      context_data.push(getCharFromInt(context_data_val));
      context_data_val = 0;
    } else { context_data_position++; }
    value = value >> 1;
  }
  while (true) {
    context_data_val = (context_data_val << 1);
    if (context_data_position == bitsPerChar-1) {
      context_data.push(getCharFromInt(context_data_val));
      break;
    } else context_data_position++;
  }
  return context_data.join('');
}
function compressToUTF16(input) {
  if (input == null) return "";
  // espelha "LZ1:" (COMPRESSED_PREFIX de lib/storage.ts) — manter em sincronia.
  return "LZ1:" + _compress(input, 15, function(a){return f(a+32);}) + " ";
}
`;

/** Corpo completo do worker = compressor vendorizado + handler de mensagem. */
export const WORKER_SOURCE = `${COMPRESS_FN_SOURCE}
self.onmessage = function (e) {
  var id = e.data && e.data.id;
  try {
    var value = compressToUTF16(e.data.json);
    self.postMessage({ id: id, ok: true, value: value });
  } catch (err) {
    self.postMessage({ id: id, ok: false });
  }
};
`;
