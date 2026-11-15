/**
 * postinstall: @langchain/langgraph-sdk vendors ESM dependencies under
 * dist/node_modules/.pnpm/<pkg>/node_modules/<name>/ with no package.json.
 * Node stops its "type" lookup at node_modules boundaries, so on runtimes that
 * load them through require() without syntax detection (Vercel's Node runtime)
 * the .js files are parsed as CommonJS and the function crashes at startup
 * ("Cannot use import statement outside a module"). Mark each vendored folder
 * as ESM; their .cjs siblings stay CommonJS by extension. Idempotent.
 */
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

let sdkDir;
try {
  sdkDir = dirname(createRequire(import.meta.url).resolve('@langchain/langgraph-sdk/package.json'));
} catch {
  process.exit(0); // not installed: nothing to fix
}

const pnpm = join(sdkDir, 'dist', 'node_modules', '.pnpm');
if (!existsSync(pnpm)) process.exit(0);

let marked = 0;
for (const entry of readdirSync(pnpm)) {
  const inner = join(pnpm, entry, 'node_modules');
  if (!existsSync(inner)) continue;
  for (const name of readdirSync(inner)) {
    const pkgDir = join(inner, name);
    const pkgJson = join(pkgDir, 'package.json');
    if (!existsSync(pkgJson)) {
      writeFileSync(pkgJson, '{"type":"module"}\n');
      marked++;
    }
  }
}
if (marked) console.log(`fix-vendored-esm: marked ${marked} vendored folder(s) as ESM`);
