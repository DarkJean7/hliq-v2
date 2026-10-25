// Refresh src/strictspot.js from Hyperliquid's own web app: the Strict spot list lives there as a
// constant (a '.'-joined string of token ids, mainnet and testnet), not in their API.
//   node tests/update-strict-spot.mjs           prints what changed
//   node tests/update-strict-spot.mjs --write   and rewrites the list in src/strictspot.js
// It finds the constant by its shape, `ve.chain===`Mainnet`?`0x….0x…`` — minified names change
// between their builds, so it matches the pattern, not the name, and refuses if it is not found.
import fs from 'node:fs'

const APP = 'https://app.hyperliquid.xyz'
const get = (u) => fetch(u).then(r => { if (!r.ok) throw new Error(u + ' ' + r.status); return r.text() })
const html = await get(APP + '/trade')
const main = /src="(\/assets\/index-[\w-]+\.js)"/.exec(html)?.[1]
if (!main) throw new Error('no main bundle in ' + APP)
const mainJs = await get(APP + main)
const chunks = [...new Set(mainJs.match(/assets\/[\w.-]+\.js/g) ?? [])]

let ids = null
for (const c of [main.slice(1), ...chunks]) {
  const js = c === main.slice(1) ? mainJs : await get(APP + '/' + c).catch(() => '')
  const m = /chain===`Mainnet`\?`((?:0x[0-9a-f]{32}\.)+0x[0-9a-f]{32})`/.exec(js)
  if (m) { ids = m[1].split('.'); console.log('found in', c); break }
}
if (!ids?.length) throw new Error('strict list not found — their bundle changed shape; update the pattern')

const f = 'src/strictspot.js'
const src = fs.readFileSync(f, 'utf8')
const cur = new Set([...src.matchAll(/'(0x[0-9a-f]{32})'/g)].map(m => m[1]))
const add = ids.filter(i => !cur.has(i)), drop = [...cur].filter(i => !ids.includes(i))
console.log(`${ids.length} ids · +${add.length} −${drop.length}`)

// Name what moved, so the commit can say it.
const meta = await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ type: 'spotMeta' }) }).then(r => r.json())
const nm = new Map(meta.tokens.map(t => [t.tokenId, t.name]))
if (add.length)  console.log('added:',   add.map(i => nm.get(i) ?? i).join(' '))
if (drop.length) console.log('removed:', drop.map(i => nm.get(i) ?? i).join(' '))

if (process.argv.includes('--write') && (add.length || drop.length)) {
  const nl = src.includes('\r\n') ? '\r\n' : '\n'
  const day = new Date().toISOString().slice(0, 10)
  const list = 'export const STRICT_SPOT_TOKEN_IDS = new Set([' + nl + ids.map(i => `  '${i}',`).join(nl) + nl + '])'
  const out = src.replace(/export const STRICT_SPOT_TOKEN_IDS = new Set\(\[[\s\S]*?\]\)/, list)
    .replace(/export const STRICT_SPOT_AS_OF = '[\d-]+'/, `export const STRICT_SPOT_AS_OF = '${day}'`)
  fs.writeFileSync(f, out)
  console.log('wrote', f, '— also update the date and counts in its header comment')
}
