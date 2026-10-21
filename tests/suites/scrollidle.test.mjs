// Repaints wait out a scroll (src/scrollidle.js). Reported "it stutters"; the field telemetry
// showed 200-885ms JavaScript freezes from All Accounts rebuilding the Overview on every live push.
import fs from 'fs'
import { createScrollIdle, SCROLL_IDLE_MS } from '../../src/scrollidle.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))

// A fake clock and timer queue, so a quarter second costs nothing.
const rig = () => {
  let ms = 1000; const timers = []
  const s = createScrollIdle({ now: () => ms, setTimer: (fn, d) => timers.push({ at: ms + d, fn }) })
  const advance = (d) => {
    ms += d
    for (;;) { const i = timers.findIndex(x => x.at <= ms); if (i < 0) break; timers.splice(i, 1)[0].fn() }
  }
  return { s, advance, pending: () => timers.length }
}

{
  const { s } = rig(); let n = 0
  t('not scrolling: it paints at once', s.run('a', () => n++) === true && n === 1)
}
{
  const { s, advance } = rig(); const seen = []
  s.noteScroll()
  s.run('a', () => seen.push(1)); s.run('a', () => seen.push(2)); s.run('a', () => seen.push(3))
  t('mid-scroll: nothing paints', seen.length === 0)
  advance(100); s.noteScroll()          // still scrolling
  advance(200)
  t('a scroll that keeps going keeps it waiting', seen.length === 0, seen)
  advance(SCROLL_IDLE_MS)
  t('once it stops, the LATEST paint runs, once', JSON.stringify(seen) === '[3]', seen)
}
{
  const { s, advance } = rig(); const seen = []
  s.noteScroll(); s.run('a', () => seen.push('a')); s.run('b', () => seen.push('b'))
  advance(SCROLL_IDLE_MS + 1)
  t('different keys each run', seen.join() === 'a,b', seen)
}
{
  const { s, advance } = rig(); let n = 0
  s.noteScroll(); s.run('a', () => { throw new Error('x') }); s.run('b', () => n++)
  advance(SCROLL_IDLE_MS + 1)
  t('one failing paint does not stop the others', n === 1)
}

const cli = fs.readFileSync('src/main.js', 'utf8')
t('All Accounts light paint goes through it', cli.includes("_scrollIdle.run('allAcctLightPaint', _allAcctLightPaintNow)"))
t('and main.js imports it', cli.includes("import { scrollIdle as _scrollIdle } from './scrollidle.js'"))
t('the scroll listener is passive', /addEventListener\('scroll'[^\n]*passive: true/.test(fs.readFileSync('src/scrollidle.js', 'utf8')))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
