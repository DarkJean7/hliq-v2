// Editing TP/SL on a position that already has triggers.
import fs from 'fs'
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const html = fs.readFileSync('index.html', 'utf8').replace(/\r\n/g, '\n')
let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x))
const grab = (s, sig) => {
  const i = s.indexOf(sig); if (i < 0) return ''
  let p = s.indexOf('(', i), pd = 0, k = p
  for (; k < s.length; k++) { if (s[k] === '(') pd++; else if (s[k] === ')') { pd--; if (!pd) break } }
  let j = s.indexOf('{', k), d = 0
  for (; j < s.length; j++) { if (s[j] === '{') d++; else if (s[j] === '}') { d--; if (!d) return s.slice(i, j + 1) } }
  return ''
}

console.log('\n-- collecting the triggers --')
// The reported case: 3 TPs on one ADA short. The loop kept overwriting, so whichever came
// last became "the" TP and looked like a default.
const pick = new Function('orders', 'entry', `
  const tps = [], sls = []
  for (const o of orders) {
    const isTp = o.orderType?.startsWith('Take Profit')
    const isSl = o.orderType?.startsWith('Stop')
    const opx = parseFloat(o.triggerPx ?? 0)
    if (opx <= 0) continue
    const row = { px: opx, oid: o.oid, sz: Math.abs(parseFloat(o.sz ?? 0)), whole: !!o.isPositionTpsl }
    if (isTp) tps.push(row); else if (isSl) sls.push(row)
  }
  const byDist = (a, b) => Math.abs(a.px - entry) - Math.abs(b.px - entry)
  tps.sort(byDist); sls.sort(byDist)
  return {
    tps, sls,
    tpPx: tps.length === 1 ? tps[0].px : 0,
    tpOid: tps.length === 1 ? tps[0].oid : 0,
  }
`)
const ADA = [
  { sz: '2000.0', orderType: 'Take Profit Market', triggerPx: '0.202',   oid: 1, isPositionTpsl: false },
  { sz: '1000.0', orderType: 'Take Profit Market', triggerPx: '0.19187', oid: 2, isPositionTpsl: false },
  { sz: '1000.0', orderType: 'Take Profit Market', triggerPx: '0.20961', oid: 3, isPositionTpsl: false },
]
const r = pick(ADA, 0.22324)
t('all three are collected, not just the last', r.tps.length === 3)
t('with their sizes, so a partial can be told from a full one',
  r.tps.map(o => o.sz).sort((a, b) => a - b).join(',') === '1000,1000,2000')
t('with several, NOTHING is pre-filled - picking one would be the same bug in disguise',
  r.tpPx === 0 && r.tpOid === 0)
t('they are ordered nearest the entry first', r.tps[0].px === 0.20961)
t('a lone trigger IS pre-filled', pick([ADA[2]], 0.22324).tpPx === 0.20961)
t('and carries its oid', pick([ADA[2]], 0.22324).tpOid === 3)
t('stop losses are kept apart from take profits',
  pick([{ sz: '5', orderType: 'Stop Market', triggerPx: '0.3', oid: 9 }], 0.22).sls.length === 1)
t('a trigger with no price is skipped rather than stored as 0',
  pick([{ sz: '5', orderType: 'Take Profit Market', triggerPx: '0', oid: 9 }], 0.22).tps.length === 0)

console.log('\n-- both entry points collect the same way --')
t('the positions tab does', cli.includes('const tps = [], sls = []'))
t('and the orders/chart path does too', cli.includes('const tps2 = [], sls2 = []'))
t('neither overwrites a previous match', !cli.includes('if (isTp && opx > 0) { tpPx = opx; tpOid = o.oid }'))
t('both pass the lists to the modal',
  (cli.match(/__openEditModal\([^)]*tps2?, sls2?\)/g) ?? []).length === 2)

console.log('\n-- the editor shows what is already there --')
t('there is a slot for it', html.includes('id="tpslExisting"'))
t('hidden until there is something to show', html.includes('id="tpslExisting" style="display:none'))
const ren = grab(cli, 'function _tpslRenderExisting(coin, fullSz, tps, sls)')
t('it lists every trigger', ren.includes('[...tps.map') && ren.includes('...sls.map'))
t('each with its price and size', ren.includes('fmtPrice(o.px)') && ren.includes('fmtSize(o.sz)'))
t('marked full or a percentage of the position', ren.includes("_T('full', 'total')") && ren.includes('o.sz / fullSz * 100'))
t('TP and SL are told apart', ren.includes("o.kind === 'tp' ? 'TP' : 'SL'"))
t('it states the consequence of confirming', ren.includes('Confirming cancels all'))
t('and warns louder when several will go', ren.includes("n > 1 ? 'var(--orange"))
t('with none resting, the box stays hidden', ren.includes("if (!all.length) { box.style.display = 'none'"))

console.log('\n-- a lone PARTIAL trigger opens as partial --')
const mod = grab(cli, 'window.__openEditModal = function (coin, side, szi, entryPx,')
t('a single trigger smaller than the position switches tabs', mod.includes("window.__tpslTab('partial')"))
t('and sets the slider to its share', mod.includes('Math.round(_lone.sz / sz * 100)'))
t('a full-size trigger is left on Entire', mod.includes('_lone.sz < sz * 0.995'))
t('only when exactly one trigger exists overall',
  mod.includes("(existingTps ?? []).length === 1 && (existingSls ?? []).length === 0"))

console.log('\n-- confirming clears everything it replaces --')
const conf = grab(cli, 'window.__confirmEditPosition = async function ()')
t('the lists reach confirm', conf.includes('tps: _tps = [], sls: _sls = []'))
t('every TP oid is cancelled when a TP is set', conf.includes('for (const oid of _oids(_tps, tpOid))'))
t('and every SL oid when an SL is set', conf.includes('for (const oid of _oids(_sls, slOid))'))
t('falling back to the single oid when no list came through', conf.includes('return ids.length ? ids : (oneOid ? [oneOid] : [])'))
t('nothing is cancelled for a side being left alone',
  conf.includes('if (tpPx) for (const oid of') && conf.includes('if (slPx) for (const oid of'))
// Cancelling one of three left two resting beside the replacement.
const oids = new Function('list', 'one', "const ids=(list??[]).map(o=>o.oid).filter(Boolean); return ids.length?ids:(one?[one]:[])")
t('three resting triggers yield three cancels', oids(r.tps, 0).length === 3)
t('an empty list with a known oid still cancels that one', oids([], 42).join() === '42')
t('and nothing known yields no cancels', oids([], 0).length === 0)

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
