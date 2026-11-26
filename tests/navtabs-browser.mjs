// The desktop tab bar: the main tabs alone, the rest in groups, one row, every tab reachable.
// "i cannot access all tabs. settings is missing" — the bar outgrew the window. Wrapping put
// Settings alone on a second row ("the tab looks awful"); then: "groups tabs that when pressing
// it expands and displays the other tabs … maintain the high important tabs single"
// (src/navgroups.js). Both designs, a few widths, dev mode on so Grid Ladder is there too.
import { chromium } from 'playwright'
const PORT = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const URL = `http://localhost:${PORT}/app`
let pass = 0, fail = 0
const t = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++; console.log(ok ? '  PASS' : '  FAIL', n, ok ? '' : `→ ${JSON.stringify(got)} (wanted ${JSON.stringify(want)})`) }
const errs = []
const ALL = ['Overview', 'Trade', 'Markets', 'Portfolio', 'History', 'Transfers', 'Calendar', 'Scoreboard', 'Analysis', 'Oracle', 'Outcomes', 'Watch',
  'Leaderboard', 'Agent Arena', 'Global Chat', 'Strategies', 'Portfolios', 'Simulator', 'Labs', 'Grid Ladder', 'Performance', 'Settings']
const browser = await chromium.launch()
for (const classic of [false, true]) for (const width of [1920, 1440, 1100]) {
  const label = `${classic ? 'classic' : 'nova'} ${width}px`
  const ctx = await browser.newContext({ viewport: { width, height: 900 } })
  try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
  await ctx.route('**/api/**', r => r.fulfill({ status: 503, body: 'offline in test' }))
  await ctx.route(/^https?:\/\/[a-z0-9.-]*hyperliquid[a-z0-9.-]*\.xyz\//i, r => r.fulfill({ status: 200, contentType: 'application/json', json: [] }))
  const p = await ctx.newPage()
  p.on('pageerror', e => errs.push(e.message))
  await p.goto(URL, { waitUntil: 'domcontentloaded' })
  await p.evaluate((classic) => {
    localStorage.clear()
    for (const k of ['hliq_onboard_done', 'hliq_lang_chosen', 'hliq_onboard_welcomed_v1', 'hliq_sub_unlocked', 'hliq_dev']) localStorage.setItem(k, '1')
    localStorage.setItem('hliq_lang', 'en')
    if (classic) localStorage.setItem('hliq_ui', 'classic')
  }, classic)
  await p.reload({ waitUntil: 'domcontentloaded' })
  await p.waitForFunction(() => !!window.__goPaper, null, { timeout: 30000 })
  await p.evaluate(() => window.__goPaper())
  await p.waitForFunction(() => document.querySelector('.nav-tabs')?.offsetParent != null && document.querySelector('.nav-tabs')?.dataset.navGroups, null, { timeout: 30000 })

  const r = await p.evaluate(() => {
    const n = document.querySelector('.nav-tabs'), nr = n.getBoundingClientRect()
    const top = [...n.children].filter(el => el.offsetParent !== null && el.getBoundingClientRect().width > 0)
    const rows = new Set(top.map(el => Math.round(el.getBoundingClientRect().top))).size
    const out = top.filter(el => { const r = el.getBoundingClientRect(); return r.right > nr.right + 1 || r.left < nr.left - 1 || r.right > innerWidth }).map(el => el.textContent.trim())
    // Everything a person can reach: a tab in the bar, or one inside a group that is in the bar
    // or under More. Display:none ones (dev-gate outside dev mode) do not count.
    const name = (b) => b.textContent.replace(/\s+\d+\s*$/, '').trim()
    const moreShown = !n.querySelector('.nav-more')?.hidden
    const reach = [...n.querySelectorAll('.nav-tab')]
      .filter(b => {
        if (!b.closest('[data-nav-overflow]')) return getComputedStyle(b).display !== 'none'
        // Under More: reachable if More is showing, and (dev-gate) only in dev mode.
        return moreShown && (!b.classList.contains('dev-gate') || document.documentElement.classList.contains('is-dev'))
      })
      .map(name)
    // Hidden under More on a narrow window still counts: More is where it went.
    const single = [...n.children].filter(el => el.classList.contains('nav-tab')).map(name)
    return { rows, out, reach: [...new Set(reach)].sort(), single }
  })
  t(`${label}: one row, nothing outside the bar`, { rows: r.rows, out: r.out }, { rows: 1, out: [] })
  t(`${label}: every tab is in the bar or a group`, r.reach, [...ALL].sort())
  t(`${label}: the main tabs stand alone`, r.single, ['Overview', 'Trade', 'Markets', 'Portfolio', 'Settings'])

  if (width === 1440) {
    // Open Bots, pick Strategies: the tab opens, the menu closes, Bots is lit and says so.
    await p.click('.nav-group[data-group="bots"] > .nav-group-btn')
    const opened = await p.evaluate(() => !document.querySelector('.nav-group[data-group="bots"] .nav-group-menu').hidden)
    await p.click('.nav-group[data-group="bots"] .nav-tab[onclick*="\'strategies\'"]')
    await p.waitForFunction(() => document.querySelector('.nav-group[data-group="bots"]').classList.contains('active'), null, { timeout: 5000 }).catch(() => {})
    const after = await p.evaluate(() => {
      const g = document.querySelector('.nav-group[data-group="bots"]')
      return { tab: document.getElementById('tab-strategies')?.classList.contains('active') ?? false, closed: g.querySelector('.nav-group-menu').hidden, lit: g.classList.contains('active'), says: g.querySelector('.nav-group-cur').textContent }
    })
    t(`${label}: Bots opens; Strategies opens from it; the menu closes; Bots is lit and names it`, { opened, ...after }, { opened: true, tab: true, closed: true, lit: true, says: 'Strategies' })

    // One menu at a time, and a click elsewhere closes it.
    await p.click('.nav-group[data-group="account"] > .nav-group-btn')
    await p.click('.nav-group[data-group="research"] > .nav-group-btn')
    const one = await p.evaluate(() => [...document.querySelectorAll('.nav-group-menu')].filter(m => !m.hidden).map(m => m.parentElement.dataset.group))
    await p.mouse.click(5, 880)
    const none = await p.evaluate(() => [...document.querySelectorAll('.nav-group-menu')].filter(m => !m.hidden).length)
    t(`${label}: one menu open at a time; a click outside closes it`, { one, none }, { one: ['research'], none: 0 })

    // A single tab clears the group highlight.
    await p.click('.nav-tabs > .nav-tab[onclick*="\'overview\'"]')
    await p.waitForFunction(() => !document.querySelector('.nav-group.active'), null, { timeout: 5000 }).catch(() => {})
    t(`${label}: back on Overview, no group is lit`, await p.evaluate(() => document.querySelectorAll('.nav-group.active').length), 0)
  }
  await ctx.close()
}
t('no page errors', errs, [])
await browser.close()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
