// Scroll-jank telemetry (src/scrolljank.js). Reported: "currently when scrolling down for example
// its kinda buggy", which did not reproduce headless — so the user's own browser reports it.
// What has to hold: a smooth scroll says nothing, a stalling one is reported, and the report
// carries what is needed to name a cause without another round of guessing.
import fs from 'fs'
import { summarise } from '../../src/scrolljank.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const src = fs.readFileSync('src/scrolljank.js', 'utf8')
const cli = fs.readFileSync('src/main.js', 'utf8')

const smooth = Array(120).fill(16.7)
t('a smooth 60Hz scroll is not jank', !summarise(smooth).janky, summarise(smooth))
t('nor one stall in a long scroll (a GC, a tab switch)', !summarise([...smooth, 120]).janky)
t('three frames over 50ms is', summarise([...smooth, 60, 70, 80]).janky)
t('so is a p95 worse than two frames at 60Hz', summarise(Array(40).fill(40)).janky)
t('and it reports the worst frame', summarise([16, 16, 250]).worst === 250)
t('an empty session is not jank and does not throw', summarise([]).janky === false)

t('it says what was scrolling — a box inside the page feels different from the page', src.includes('scrolled=') && src.includes("return 'page'"))
t('what blocked the page', src.includes("type: 'longtask'") && src.includes('longtasks='))
t('whether the page was rewriting itself meanwhile', src.includes('nodesRewritten='))
t('whether the wallpaper blur was on', src.includes("has-bg-image") && src.includes('wallpaper='))
t('and whether the GPU is drawing at all', src.includes('UNMASKED_RENDERER_WEBGL') && src.includes('gpu='))
t('a hidden tab reports nothing (rAF stops, which is not a stall)', src.includes('document.hidden) return'))
t('throttled and capped per page', src.includes('minGapMs = 5 * 60_000') && src.includes('maxReports = 6'))
t('the listener is passive, so measuring cannot cause the jank', /addEventListener\('scroll'[\s\S]{0,700}passive: true/.test(src))
t('main.js installs it and posts kind=scrolljank', cli.includes("import { installScrollJank } from './scrolljank.js'") && cli.includes("kind: 'scrolljank'"))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
