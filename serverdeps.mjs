// Every local file a server process loads, by following its relative imports from the entry file.
// Printed one per line, sorted, so CI can hash them (.github/workflows/deploy.yml).
//
// Why: the deploy restarted hliq-strat only when server.js or strategies/ changed. server.js
// imports seven modules from src/ (and they import more), and a change to one of those shipped
// to disk but never ran -- the process kept the old copy in memory until something else happened
// to restart it. A seed fix in src/comboseed.js would have sat there unused.
//
//   node serverdeps.mjs server.js
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

export function serverDeps(entry, root = process.cwd()) {
  const seen = new Set()
  const walk = (file) => {
    const abs = resolve(root, file)
    if (seen.has(abs) || !existsSync(abs)) return
    seen.add(abs)
    const src = readFileSync(abs, 'utf8')
    // Static `from '...'`, bare `import '...'` and dynamic `import('...')`, relative ones only.
    for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g)) {
      walk(relative(root, join(dirname(abs), m[1])))
    }
  }
  walk(entry)
  return [...seen].map(f => relative(root, f).split('\\').join('/')).sort()
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  for (const f of serverDeps(process.argv[2] || 'server.js')) console.log(f)
}
