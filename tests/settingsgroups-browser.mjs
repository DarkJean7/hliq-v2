// Settings in labelled groups that open and close, the same on both shells. Hermetic: the exchange is stubbed.
// "lets change how settings are displayed. like make groups, etc to make it more organized, clean.
// add notifications label for example", then "make it like expandable, by default unexpanded".
// Every setting has to survive the move, so this names each one.
import { chromium } from 'playwright'

const arg = (k, d) => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1] ?? d
const APP = `http://localhost:${arg('port', '5175')}/app`
let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))

const A1 = '0x' + '1'.repeat(40)
const sum = { accountValue: '1000', totalNtlPos: '0', totalRawUsd: '1000', totalMarginUsed: '0' }
const WIN = { accountValueHistory: [[Date.now() - 864e5, '1000'], [Date.now(), '1000']], pnlHistory: [[Date.now() - 864e5, '0'], [Date.now(), '0']], vlm: '0' }
const reply = (q) => {
  switch (q.type) {
    case 'clearinghouseState': return { marginSummary: sum, crossMarginSummary: sum, crossMaintenanceMarginUsed: '0', withdrawable: '1000', assetPositions: [], time: Date.now() }
    case 'frontendOpenOrders': case 'userFills': case 'userFillsByTime': case 'userFunding': case 'userNonFundingLedgerUpdates': case 'candleSnapshot': case 'perpCategories': case 'perpConciseAnnotations': return []
    case 'spotClearinghouseState': return { balances: [] }
    case 'allMids': return { BTC: '100' }
    case 'portfolio': return ['day', 'week', 'month', 'allTime', 'perpDay', 'perpWeek', 'perpMonth', 'perpAllTime'].map(w => [w, WIN])
    case 'metaAndAssetCtxs': return [{ universe: [] }, []]
    case 'spotMetaAndAssetCtxs': return [{ tokens: [], universe: [] }, []]
    case 'allPerpMetas': return [{ universe: [] }]
    case 'perpDexs': return [null]
    default: return {}
  }
}

const b = await chromium.launch()
async function open(viewport, isMobile) {
  const ctx = await b.newContext({ viewport, isMobile, hasTouch: isMobile, locale: 'en-US', permissions: ['notifications'] })
  try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
  await ctx.route(/api\.hyperliquid\.xyz/, (route) => {
    let q = {}
    try { q = JSON.parse(route.request().postData() || '{}') } catch {}
    return route.fulfill({ status: 200, contentType: 'application/json', json: reply(q) })
  })
  await ctx.route('**/api/**', (route) => route.fulfill({ status: 503, body: 'offline in test' }))
  const p = await ctx.newPage()
  const errs = []
  p.on('pageerror', e => errs.push(e.message))
  await p.addInitScript(() => { try { Object.defineProperty(window.Notification, 'permission', { get: () => 'granted' }) } catch {} })
  await p.goto(APP, { waitUntil: 'domcontentloaded' })
  await p.evaluate(() => {
    localStorage.clear()
    for (const k of ['hliq_onboard_done', 'hliq_lang_chosen', 'hliq_onboard_welcomed_v1', 'hliq_onboard_tour_v1', 'hliq_install_nudge_v2']) localStorage.setItem(k, '1')
    localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_ann_dismissed', JSON.stringify(['*'])); localStorage.setItem('hliq_privacy', '0')
  })
  await p.reload({ waitUntil: 'domcontentloaded' })
  await p.waitForFunction(() => !!window.loadDashboard, null, { timeout: 60000 })
  await p.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, A1)
  await p.waitForFunction(() => document.getElementById('dashboard')?.classList.contains('active'), null, { timeout: 30000 })
  return { ctx, p, errs }
}
const sectionText = (p, root) => p.$$eval(`${root} [data-settings-sec]`, es => Object.fromEntries(es.map(e => [e.dataset.settingsSec, e.textContent.replace(/\s+/g, ' ')])))
const ORDER = 'account,notifications,appearance,security,trading,data,developer'
const NAMES = /Account.*Notifications.*Appearance.*Security.*Trading & risk.*Data & backup.*Developer/

async function closedByDefault(p, root) {
  const shut = await p.$$eval(`${root} [data-settings-sec]`, es => es.map(e => [e.classList.contains('open'), e.querySelector('.set-head-btn')?.getAttribute('aria-expanded')]))
  t('every group starts closed', shut.length === 7 && shut.every(([o, a]) => !o && a === 'false'), shut)
  const shown = await p.$$eval(`${root} [data-settings-sec] .pin-toggle`, es => es.filter(e => e.offsetParent !== null).length)
  t('so no control is showing', shown === 0, shown)
  const hints = await p.$eval(`${root} [data-settings-sec="notifications"] .set-head-hint`, e => e.offsetParent !== null && e.textContent)
  t('and each says what is inside', /Alerts/.test(hints), hints)
}
function checkHome(s, want, shell) {
  for (const [sec, labels] of Object.entries(want)) for (const l of labels) t(`${shell}: ${l} is under ${sec}`, s[sec]?.includes(l), s[sec]?.slice(0, 200))
}

console.log('-- phone --')
{
  const { ctx, p, errs } = await open({ width: 430, height: 930 }, true)
  await p.evaluate(() => window.mobVTab('settings'))
  await p.waitForSelector('#mobSettings [data-settings-sec="developer"]', { timeout: 15000 })
  const ids = await p.$$eval('#mobSettings [data-settings-sec]', es => es.map(e => e.dataset.settingsSec))
  t('seven groups, in order', ids.join() === ORDER, ids)
  const heads = await p.$$eval('#mobSettings .set-head-name', es => es.map(e => e.textContent.trim()).join(' '))
  t('each with its label', NAMES.test(heads), heads)
  await closedByDefault(p, '#mobSettings')
  t('all of them fit on one phone screen, above the bottom bar', await p.$eval('#mobSettings [data-settings-sec="developer"]', e => e.getBoundingClientRect().bottom) < 840, await p.$eval('#mobSettings [data-settings-sec="developer"]', e => e.getBoundingClientRect().bottom))
  await p.waitForFunction(() => /Wake alarm/.test(document.querySelector('#mobSettings [data-settings-sec="notifications"]')?.textContent ?? ''), null, { timeout: 10000 })
  const s = await sectionText(p, '#mobSettings')
  checkHome(s, {
    account: ['Main Wallet', 'Agent Key'],
    notifications: ['Sound on fill', 'Order filled cards', 'Wake alarm', 'Browser Notifications'],
    appearance: ['Interface', 'Color Scheme', 'Style', 'Accent', 'Backdrop', 'Your own image', 'Brightness', 'Celebrations', 'Language'],
    security: ['PIN Lock', 'Security & Keys'],
    trading: ['News Pause', 'Risk Management'],
    data: ['Export Settings', 'Import Settings'],
    developer: ['Debug panel', 'Dev Mode'],
  }, 'phone')
  t('the wake alarm is labelled once', s.notifications.split('Wake alarm').length === 2, s.notifications)
  t('sound is no longer under appearance', !s.appearance.includes('Sound on fill'))
  t('key info is no longer under data', !s.data.includes('Security & Keys'))
  // With permission, the alert settings appear in the same group.
  if (s.notifications.includes('Health Alert')) checkHome(s, { notifications: ['Health Alert', 'Position Health Alert', 'Alert Frequency', 'Mute All Alerts', 'Price Alerts'] }, 'phone')
  t('sign out is still at the end', await p.$$eval('#mobSettings > *', es => /Sign Out/.test(es.at(-1).textContent)))
  t('nothing runs off the side', await p.$eval('#mobSettings', e => e.scrollWidth - e.clientWidth) <= 0)
  if (arg('shot')) await p.screenshot({ path: arg('shot') })

  const head = (id) => `#mobSettings [data-settings-sec="${id}"] .set-head-btn`
  await p.tap(head('trading'))
  await p.waitForSelector('#mobSettings [data-settings-sec="trading"] .pin-toggle', { state: 'visible' })
  t('a tap opens a group', await p.$eval(head('trading'), e => e.getAttribute('aria-expanded')) === 'true')
  t('and only that one', await p.$$eval('#mobSettings [data-settings-sec].open', es => es.length) === 1)
  await p.tap(head('data'))
  await p.waitForFunction(() => document.querySelector('#mobSettings [data-settings-sec="data"]').classList.contains('open'))
  t('several can be open at once', await p.$$eval('#mobSettings [data-settings-sec].open', es => es.length) === 2)
  await p.tap('#mobSettings [data-settings-sec="trading"] .pin-toggle')
  await p.waitForFunction(() => /Keywords/.test(document.querySelector('#mobSettings [data-settings-sec="trading"]')?.textContent ?? ''), null, { timeout: 5000 })
  t('a setting still works where it lives now', true)
  t('and a group stays open through the redraw that follows', await p.$eval('#mobSettings [data-settings-sec="trading"]', e => e.classList.contains('open')))
  await p.tap(head('data'))
  await p.waitForFunction(() => !document.querySelector('#mobSettings [data-settings-sec="data"]').classList.contains('open'))
  t('and a second tap closes it', await p.$eval('#mobSettings [data-settings-sec="data"] .mob-v-setting-group', e => e.offsetParent === null))

  console.log('-- a warning cannot hide in a closed group --')
  await p.evaluate(({ A1 }) => {
    localStorage.setItem('hliq_agent_key_' + A1.toLowerCase(), '0x' + 'a'.repeat(64)); localStorage.setItem('hliq_agent_key_' + A1, '0x' + 'a'.repeat(64))
    window.__agentKeyBad = () => true
    window.mobVTab('settings')
  }, { A1 })
  await p.waitForSelector('#mobSettings [data-settings-sec="account"] [data-settings-alert]', { timeout: 6000 })
  t('a bad agent key shows on the closed Account group', /does not recognize/.test(await p.$eval('#mobSettings [data-settings-sec="account"] [data-settings-alert]', e => e.textContent)))
  t('and it is closed', await p.$eval('#mobSettings [data-settings-sec="account"]', e => !e.classList.contains('open')))
  await p.evaluate(() => { window.__settingsOpen('account') })
  t('"Wallet settings" lands on an open group', await p.$eval('#mobSettings [data-settings-sec="account"] #mobVAgentKeyInput', e => e.offsetParent !== null))
  t('no page errors', !errs.length, errs)
  await ctx.close()
}

console.log('-- desktop --')
{
  const { ctx, p, errs } = await open({ width: 1500, height: 950 }, false)
  await p.evaluate(() => window.switchTab('settings', null))
  await p.waitForSelector('#tab-settings .set-head-btn', { timeout: 15000 })
  const ids = await p.$$eval('#tab-settings [data-settings-sec]', es => es.map(e => e.dataset.settingsSec))
  t('the same seven groups, in the same order', ids.join() === ORDER, ids)
  const titles = await p.$$eval('#tab-settings .set-head-name', es => es.map(e => e.textContent.trim()).join(' '))
  t('each with its label', NAMES.test(titles), titles)
  await closedByDefault(p, '#tab-settings')
  const s = await sectionText(p, '#tab-settings')
  checkHome(s, {
    account: ['Agent Key'],
    notifications: ['Browser Notifications', 'Account Health Alert', 'Position Health Alert', 'Alert Frequency', 'Mute All Alerts', 'Price Alerts', 'Sound on fill', 'Order filled cards'],
    appearance: ['Interface', 'Color Scheme', 'Style', 'Accent Color', 'Backdrop', 'Your own image', 'Brightness', 'Compact (Mobile) UI', 'Celebrations', 'Language'],
    security: ['PIN Lock', 'Security & Keys'],
    trading: ['News Pause', 'Risk Management'],
    data: ['Export Settings', 'Import Settings'],
    developer: ['Dev Mode'],
  }, 'desktop')
  t('"View Mode" is gone', !/View Mode/.test(await p.$eval('#tab-settings', e => e.textContent)))
  for (const id of ['forceMobileToggle', 'fillToastToggle', 'celebrateToggle', 'fillSoundBox', 'pinToggle', 'wakeAlarmRow', 'notifToggle', 'langGrid']) {
    t(`#${id} is there exactly once`, await p.$$eval(`[id="${id}"]`, es => es.length) === 1)
  }
  t('still two across', await p.$eval('#tab-settings .settings-body', e => getComputedStyle(e).gridTemplateColumns.split(' ').length) === 2)
  if (arg('deskshot')) await p.screenshot({ path: arg('deskshot') })
  const place = () => p.$$eval('#tab-settings [data-settings-sec]', es => es.map(e => Math.round(e.getBoundingClientRect().left)).join())
  const before = await place()
  await p.click('#tab-settings [data-settings-sec="notifications"] .set-head-btn')
  await p.waitForSelector('#notifToggle', { state: 'attached' })
  await p.waitForFunction(() => document.querySelector('#tab-settings [data-settings-sec="notifications"]').classList.contains('open'))
  t('a click opens a group', await p.$eval('#tab-settings [data-settings-sec="notifications"] .settings-section', e => e.offsetParent !== null))
  t('and the others stay in their columns', await place() === before, [before, await place()])
  await p.evaluate(() => window.switchTab('overview', null))
  await p.evaluate(() => window.switchTab('settings', null))
  await p.waitForTimeout(200)
  t('it is still open on coming back', await p.$eval('#tab-settings [data-settings-sec="notifications"]', e => e.classList.contains('open')))
  t('no page errors', !errs.length, errs)

  await p.evaluate(() => window.__setLang?.('es'))
  await p.evaluate(() => window.switchTab('settings', null))
  await p.waitForFunction(() => /Notificaciones/.test(document.getElementById('tab-settings')?.textContent ?? ''), null, { timeout: 8000 })
  t('Spanish labels', /Seguridad/.test(await p.$eval('#tab-settings [data-settings-sec="security"] .set-head-name', e => e.textContent)))
  await ctx.close()
}

console.log(`\n${pass} passed, ${fail} failed`)
await b.close()
process.exit(fail ? 1 : 0)
