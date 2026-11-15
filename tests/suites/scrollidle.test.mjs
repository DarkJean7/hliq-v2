// Work that waits for scrolling to pause (src/scrollidle.js).
import fs from 'fs'
import { whenScrollIdle, _markScroll } from '../../src/scrollidle.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))

// A fake clock: `wait` advances it instead of sleeping.
const clock = (start) => { let now = start; return { now: () => now, wait: async (ms) => { now += ms } } }
{
  const c = clock(10_000); _markScroll(0)
  const t0 = c.now(); await whenScrollIdle({ ...c }); t('not scrolling: it goes at once', c.now() === t0)
}
{
  const c = clock(10_000); _markScroll(10_000)
  await whenScrollIdle({ ...c, quietMs: 300 }); t('just scrolled: it waits out the quiet period', c.now() >= 10_300, c.now())
}
{
  // Scrolling non-stop: every wait, another scroll lands.
  const c = clock(10_000); let n = 0
  const w = { now: c.now, wait: async (ms) => { await c.wait(ms); _markScroll(c.now()); n++ } }
  _markScroll(10_000)
  await whenScrollIdle({ ...w, quietMs: 300, maxWaitMs: 6000 }); t('never pausing still gets the work done, after the cap', c.now() >= 16_000 && c.now() < 16_400, c.now())
}
const m = fs.readFileSync('src/main.js', 'utf8')
t('the stored-history read waits for a pause in scrolling', /async function _histEnsure\(key\) \{[\s\S]{0,400}await whenScrollIdle\(\)[\s\S]{0,200}_histDbGet\(key\)/.test(m))

console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
