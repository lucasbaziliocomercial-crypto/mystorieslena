// Hook de resolução de módulos pra os testes em node conseguirem importar arquivos
// do app que usam (a) o alias de path `@/*` → raiz do projeto (igual ao
// tsconfig.json) e (b) imports relativos SEM extensão (`./foo`) — os dois são
// resolvidos pelo bundler em produção, mas o node não os conhece sozinho.
//
// Registrado via `module.register(...)` no topo do teste, ANTES do dynamic import
// do módulo alvo. O node ≥ 23 já faz type-stripping de `.ts` por padrão, então só
// falta a resolução de caminho. Mantém-se MÍNIMO: só age em `@/` e em relativos
// (`./`, `../`); todo o resto (pacotes npm) cai no resolvedor padrão.
import { pathToFileURL, fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, ".."); // scripts/ → raiz
const EXTS = [".ts", ".tsx", ".mjs", ".js", ".json"];

/** Acha o arquivo concreto pra um caminho-base sem extensão (probe de EXTS + index). */
function probe(base) {
  if (existsSync(base) && path.extname(base)) return base; // já tem extensão real
  for (const ext of EXTS) if (existsSync(base + ext)) return base + ext;
  for (const ext of EXTS) {
    const idx = path.join(base, "index" + ext);
    if (existsSync(idx)) return idx;
  }
  return base; // deixa o node reclamar com um caminho concreto
}

export async function resolve(specifier, context, nextResolve) {
  // `lz-string` é CJS — redireciona pro shim que re-exporta os named bindings
  // (o import ESM `{ compressToUTF16 }` falha direto contra o pacote CJS no node).
  if (specifier === "lz-string") {
    const shim = path.join(ROOT, "scripts", "_lz-string-shim.mjs");
    return nextResolve(pathToFileURL(shim).href, context);
  }
  if (specifier.startsWith("@/")) {
    const target = probe(path.join(ROOT, specifier.slice(2)));
    return nextResolve(pathToFileURL(target).href, context);
  }
  if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    context.parentURL &&
    !path.extname(specifier)
  ) {
    const fromDir = path.dirname(fileURLToPath(context.parentURL));
    const target = probe(path.resolve(fromDir, specifier));
    return nextResolve(pathToFileURL(target).href, context);
  }
  return nextResolve(specifier, context);
}
