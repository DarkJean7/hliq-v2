// Reproduce Hyperliquid's Unified Account Ratio exactly as their docs define it, and compare
// it with what the app currently shows as Health. Throwaway probe.
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
const acctVal = n(main.marginSummary?.accountValue)
const mainMaint = n(main.crossMaintenanceMarginUsed)
console.log('')
console.log('HL Unified Account Ratio :', (maxRatio * 100).toFixed(2) + '%', detail)
console.log('  → health (100 - ratio) :', (100 - maxRatio * 100).toFixed(2) + '%')
console.log('')
console.log("OUR current formula       : 1 - mainMaint / accountValue")
console.log(`  mainMaint=${mainMaint.toFixed(2)} accountValue=${acctVal.toFixed(2)}`)
console.log('  → health                :', acctVal > 0 ? ((1 - mainMaint / acctVal) * 100).toFixed(2) + '%' : 'n/a')
