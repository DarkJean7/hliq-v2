// Does our Health match Hyperliquid's Unified Account Ratio, on a real account?
//
//   npm run health-reconcile -- 0xabc...
//
// NOT part of `npm test`: it talks to Hyperliquid. tests/suites/health.test.mjs pins the
// algorithm against fixtures; this answers the different question of whether the live data
// still flows into it correctly — the bug it was written for was never in the formula, it was
// in which numbers were being fed to one.
//
// It prints HL's ratio computed from their own documented algorithm alongside the old
// main-dex-over-portfolio-value form, so a regression to the flattering version is obvious.
// On the account it was written against: HL 15.64%, old formula 88.96% health, correct 84.36%.
const post = async (b) => (await fetch('https://api.hyperliquid.xyz/info', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
})).json()
const n = x => Number(x ?? 0)
const A = process.argv[2]

const dexs = await post({ type: 'perpDexs' })
console.log('perpDexs shape:', JSON.stringify(dexs?.slice(0, 3)))

const spot = await post({ type: 'spotClearinghouseState', user: A })
console.log('spot balances:', JSON.stringify((spot.balances ?? []).filter(b => n(b.total) > 0)))

// Every dex's clearinghouse state, index-aligned with perpDexs (index 0 = main).
const states = []
for (let i = 0; i < (dexs ?? []).length; i++) {
  const d = dexs[i]
  const cs = d?.name
    ? await post({ type: 'clearinghouseState', user: A, dex: d.name }).catch(() => null)
    : await post({ type: 'clearinghouseState', user: A })
  states.push(cs)
  if (cs && (n(cs.crossMaintenanceMarginUsed) > 0 || (cs.assetPositions ?? []).length)) {
    console.log(`dex[${i}] ${d?.name ?? '(main)'}: maint=${n(cs.crossMaintenanceMarginUsed).toFixed(2)}`
      + ` acctVal=${n(cs.marginSummary?.accountValue).toFixed(2)} positions=${(cs.assetPositions ?? []).length}`)
  }
}

// HL's algorithm, transcribed.
const crossByToken = {}, isoByToken = {}
for (let i = 0; i < states.length; i++) {
  const cs = states[i]
  if (!cs) continue
  // collateralToken per dex. Main (index 0) is USDC = token 0.
  const token = i === 0 ? 0 : (dexs[i]?.collateralToken ?? dexs[i]?.collateral_token ?? 0)
  crossByToken[token] = (crossByToken[token] ?? 0) + n(cs.crossMaintenanceMarginUsed)
  for (const ap of (cs.assetPositions ?? [])) {
    if (ap.position?.leverage?.type === 'isolated') {
      isoByToken[token] = (isoByToken[token] ?? 0) + n(ap.position.marginUsed)
    }
  }
}

let maxRatio = 0, detail = ''
for (const [tokStr, cross] of Object.entries(crossByToken)) {
  const token = Number(tokStr)
  const spotTotal = n((spot.balances ?? []).find(b => b.token === token)?.total)
  const iso = isoByToken[token] ?? 0
  const available = spotTotal - iso
  const r = available > 0 ? cross / available : 0
  console.log(`token ${token}: cross=${cross.toFixed(2)} spotTotal=${spotTotal.toFixed(2)} iso=${iso.toFixed(2)}`
    + ` available=${available.toFixed(2)} ratio=${(r * 100).toFixed(2)}%`)
  if (available > 0 && r > maxRatio) { maxRatio = r; detail = `token ${token}` }
}

const main = states[0] ?? {}
const mainMaint = n(main.crossMaintenanceMarginUsed)

// The app's own health, through the shipped module and the shipped fetch — so this checks the
// code that actually runs, not a second copy of the formula that could agree while the app
// disagrees.
const { accountHealth } = await import('../src/health.js')
const dexStates = states.map((cs, i) => ({
  crossMaintenanceMarginUsed: n(cs?.crossMaintenanceMarginUsed),
  assetPositions: cs?.assetPositions ?? [],
  _dex: i === 0 ? 'main' : dexs[i]?.name,
}))
const ours = accountHealth(dexStates, spot.balances)

// And the form this replaced, for contrast: main-dex maintenance over the PORTFOLIO value.
// Wrong twice and optimistic twice, which is why it is printed — a regression back to it
// shows up here as a number several points too kind.
const port = await post({ type: 'portfolio', user: A }).catch(() => null)
const hist = (port ?? []).find(x => x[0] === 'allTime')?.[1]?.accountValueHistory ?? []
const portVal = hist.length ? n(hist.at(-1)[1]) : 0

console.log('')
console.log('HL Unified Account Ratio :', (maxRatio * 100).toFixed(2) + '%', detail)
console.log('  → health (100 - ratio) :', (100 - maxRatio * 100).toFixed(2) + '%')
console.log('')
console.log('the app, via src/health.js:', ours == null ? 'unknown' : ours.toFixed(2) + '%',
  ours != null && Math.abs(ours - (100 - maxRatio * 100)) < 0.5 ? '  ✓ agrees' : '  ✗ DISAGREES')
console.log('')
console.log('the old formula it replaced: 1 - mainDexMaint / portfolioValue')
console.log(`  mainMaint=${mainMaint.toFixed(2)} portfolioValue=${portVal.toFixed(2)}`)
console.log('  → health                :', portVal > 0 ? ((1 - mainMaint / portVal) * 100).toFixed(2) + '%  (too kind)' : 'n/a')
