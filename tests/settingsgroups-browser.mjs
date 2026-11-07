// Settings in labelled groups, the same on both shells. Hermetic: the exchange is stubbed.
// "lets change how settings are displayed. like make groups, etc to make it more organized, clean.
// add notifications label for example". Every setting has to survive the move, so this names each one.
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
  const heads = await p.$$eval('#mobSettings .set-sec-head', es => es.map(e => e.textContent.trim()).join(' '))
  t('each with its label', NAMES.test(heads), heads)
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
  t('a shortcut for each group', (await p.$$('#mobSettings [data-settings-jump]')).length === 7)
  t('the shortcuts can scroll sideways', await p.$eval('#mobSettings .set-nav', e => e.hasAttribute('data-dragscroll')))
  t('nothing runs off the side', await p.$eval('#mobSettings', e => e.scrollWidth - e.clientWidth) <= 0)

  const before = await p.$eval('#mobSettings [data-settings-sec="data"]', e => e.getBoundingClientRect().top)
  await p.tap('[data-settings-jump="data"]')
  await p.waitForFunction(() => { const r = document.querySelector('#mobSettings [data-settings-sec="data"]').getBoundingClientRect(); return r.top < 500 && r.top > 0 }, null, { timeout: 6000 })
  t('a shortcut jumps to its group', before > 500, before)
  const navTop = await p.$eval('#mobSettings .set-nav', e => e.getBoundingClientRect().top)
  t('and the shortcuts stay on screen', navTop >= 0 && navTop < 120, navTop)
  if (arg('shot')) await p.screenshot({ path: arg('shot') })

  await p.tap('[data-settings-jump="trading"]')
  await p.waitForFunction(() => { const r = document.querySelector('#mobSettings [data-settings-sec="trading"]').getBoundingClientRect(); return r.top < 500 }, null, { timeout: 6000 })
  await p.tap('#mobSettings [data-settings-sec="trading"] .pin-toggle')
  await p.waitForFunction(() => /Keywords/.test(document.querySelector('#mobSettings [data-settings-sec="trading"]')?.textContent ?? ''), null, { timeout: 5000 })
  t('a setting still works where it lives now', true)
  t('and the group holds its place after the redraw', await p.$eval('#mobSettings [data-settings-sec="trading"]', e => e.getBoundingClientRect().top) < 600)
  t('no page errors', !errs.length, errs)
  await ctx.close()
}

console.log('-- desktop --')
{
  const { ctx, p, errs } = await open({ width: 1500, height: 950 }, false)
  await p.evaluate(() => window.switchTab('settings', null))
  await p.waitForSelector('#settingsNav [data-settings-jump]', { timeout: 15000 })
  const ids = await p.$$eval('#tab-settings [data-settings-sec]', es => es.map(e => e.dataset.settingsSec))
  t('the same seven groups, in the same order', ids.join() === ORDER, ids)
  const titles = await p.$$eval('#tab-settings .settings-card-title', es => es.map(e => e.textContent.trim()).join(' '))
  t('each with its label', NAMES.test(titles), titles)
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
  t('still two columns', await p.$eval('#tab-settings .settings-body', e => getComputedStyle(e).columnCount) === '2')
  await p.click('[data-settings-jump="developer"]')
  await p.waitForFunction(() => { const r = document.querySelector('#tab-settings [data-settings-sec="developer"]').getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight }, null, { timeout: 6000 })
  t('a shortcut brings its group into view', true)
  if (arg('deskshot')) { await p.evaluate(() => window.scrollTo(0, 0)); await p.screenshot({ path: arg('deskshot') }) }
  t('no page errors', !errs.length, errs)

  await p.evaluate(() => window.__setLang?.('es'))
  await p.evaluate(() => window.switchTab('settings', null))
  await p.waitForFunction(() => /Notificaciones/.test(document.getElementById('settingsNav')?.textContent ?? ''), null, { timeout: 8000 })
  t('Spanish labels', /Seguridad/.test(await p.$eval('#settingsNav', e => e.textContent)))
  await ctx.close()
}

console.log(`\n${pass} passed, ${fail} failed`)
await b.close()
process.exit(fail ? 1 : 0)
