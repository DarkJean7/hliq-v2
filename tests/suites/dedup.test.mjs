import { fillKey, parseFills } from '../../src/format.js'

const merge = (existing, incoming) => {
  const have = new Set(existing.map(fillKey))
  return [...incoming.filter(f => !have.has(fillKey(f))), ...existing]
}
let pass = 0, fail = 0
const t = (name, cond) => { cond ? (pass++, console.log('  PASS', name)) : (fail++, console.log('  FAIL', name)) }

// two fills, same ms, same coin, different tid — both must survive
const raw = [
  { time: 1000, coin:'BTC', side:'B', sz:'1', px:'100', closedPnl:'5',  fee:'0.1', tid: 111, oid: 9, dir:'Close Long', hash:'0x0000' },
  { time: 1000, coin:'BTC', side:'B', sz:'2', px:'100', closedPnl:'7',  fee:'0.2', tid: 222, oid: 9, dir:'Close Long', hash:'0x0000' },
]
const fills = parseFills(raw)
t('distinct tids kept', merge([], fills).length === 2)
t('re-serving both is a no-op', merge(fills, fills).length === 2)
t('partial overlap adds only the new one', merge([fills[0]], fills).length === 2)

// null tid → composite fallback must still distinguish
const noTid = parseFills([
  { time: 2000, coin:'ETH', side:'A', sz:'1', px:'50', closedPnl:'1', fee:'0', tid: null, oid: 4, dir:'Close Short' },
  { time: 2000, coin:'ETH', side:'A', sz:'3', px:'50', closedPnl:'2', fee:'0', tid: null, oid: 4, dir:'Close Short' },
])
t('null tid: different sz stays distinct', merge([], noTid).length === 2)
t('null tid: identical re-serve deduped', merge(noTid, noTid).length === 2)

// hash is 0x0…0 on both — proves we are not keying on it
t('identical hashes do not collapse distinct fills', new Set(fills.map(fillKey)).size === 2)

// realized PnL must not inflate on a re-serve
const pnl = a => a.reduce((s,f) => s + f.closedPnl, 0)
t('realized PnL stable across re-serve', pnl(merge(fills, fills)) === 12)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
