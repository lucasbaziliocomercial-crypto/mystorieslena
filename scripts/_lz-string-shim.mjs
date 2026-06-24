// Shim ESM pro `lz-string` (que é CommonJS): o node não expõe os named exports
// (`compressToUTF16`, etc.) de um módulo CJS via `import { ... }`, mas o app/bundler
// sim. Carrega via `createRequire` (CJS, FORA do loader ESM — sem recursão pelo
// hook de alias) e re-exporta os nomes. Usado só nos testes; o `_ts-alias-hooks.mjs`
// redireciona o specifier "lz-string" pra cá.
import { createRequire } from "node:module";

const pkg = createRequire(import.meta.url)("lz-string");

export const compressToUTF16 = pkg.compressToUTF16;
export const decompressFromUTF16 = pkg.decompressFromUTF16;
export const compress = pkg.compress;
export const decompress = pkg.decompress;
export const compressToBase64 = pkg.compressToBase64;
export const decompressFromBase64 = pkg.decompressFromBase64;
export const compressToEncodedURIComponent = pkg.compressToEncodedURIComponent;
export const decompressFromEncodedURIComponent =
  pkg.decompressFromEncodedURIComponent;
export const compressToUint8Array = pkg.compressToUint8Array;
export const decompressFromUint8Array = pkg.decompressFromUint8Array;
export default pkg;
