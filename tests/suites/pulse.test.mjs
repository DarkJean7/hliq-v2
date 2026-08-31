// Exchange metrics, driven against the REAL metaAndAssetCtxs payload.
import fs from 'fs'
import { computeEcosystem, oiConcentration, oiShare, fundingApr, computeDexes, computeSpot, isTradFi, computeProtocol, HL_FEE_TAKER, HL_FEE_MAKER }
  from '../../src/ecosystem.js'

const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const html = fs.readFileSync('index.html', 'utf8')

const grab = (str, sig) => {
  const i = str.indexOf(sig); if (i < 0) return ''
  let p = str.indexOf('(', i), pd = 0, k = p
  for (; k < str.length; k++) { if (str[k] === '(') pd++; else if (str[k] === ')') { pd--; if (!pd) break } }
  let j = str.indexOf('{', k), dd = 0
  for (; j < str.length; j++) { if (str[j] === '{') dd++; else if (str[j] === '}') { dd--; if (!dd) return str.slice(i, j + 1) } }
  return ''
}
let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x))

const pair = await fetch('https://api.hyperliquid.xyz/info', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
}).then(r => r.json())

// ── funding ──────────────────────────────────────────────────────────────────
// HL quotes funding hourly; a raw hourly rate next to an APY elsewhere is a trap.
t('hourly funding is annualised', Math.abs(fundingApr(0.0001) - 87.6) < 0.01, String(fundingApr(0.0001)))
t('a zero rate is zero', fundingApr(0) === 0)
t('garbage is zero, not NaN', fundingApr(undefined) === 0 && fundingApr('x') === 0)

// ── the real payload ─────────────────────────────────────────────────────────
const d = computeEcosystem(pair)
t('it parsed the live exchange', d.ok && d.coins > 100, `${d.coins} coins`)
console.log(`  (live: ${d.coins} markets, OI $${(d.totalOi / 1e9).toFixed(2)}B, vol $${(d.totalVol / 1e9).toFixed(2)}B)`)

t('open interest is a plausible exchange-wide number', d.totalOi > 1e8 && d.totalOi < 1e12, String(d.totalOi))
t('so is volume', d.totalVol > 1e8 && d.totalVol < 1e12, String(d.totalVol))
t('the total is the sum of the parts',
  Math.abs(d.rows.reduce((s, r) => s + r.oi, 0) - d.totalOi) < 1)

// openInterest is quoted in BASE units — not multiplying by mark would rank a cheap
// high-supply coin above BTC.
const btc = d.rows.find(r => r.coin === 'BTC')
t('open interest is converted to notional, not left in base units',
  btc && btc.oi > 1e8, btc ? String(btc.oi) : 'no BTC')
t('BTC is therefore among the largest markets', d.topOi.slice(0, 3).some(r => r.coin === 'BTC'),
  d.topOi.map(r => r.coin).join(','))

t('lists are ranked, not arbitrary',
  d.topOi.every((r, i, a) => i === 0 || a[i - 1].oi >= r.oi)
  && d.topVol.every((r, i, a) => i === 0 || a[i - 1].vol >= r.vol))
t('funding extremes point opposite ways',
  d.fundingHigh[0].apr > d.fundingLow[0].apr)
t('gainers gain and losers lose', d.gainers[0].chg > d.losers[0].chg)

// The volume floor is the difference between a signal and a rounding artefact.
t('extremes only include markets that actually traded',
  [...d.fundingHigh, ...d.fundingLow, ...d.gainers, ...d.losers].every(r => r.vol >= 100_000))
t('but the totals still count every market', d.coins > d.liquidCoins, `${d.coins} vs ${d.liquidCoins}`)
t('a genuine extreme on real volume is NOT filtered out — that is signal, not noise',
  Math.abs(d.fundingLow[0].apr) > 50, String(d.fundingLow[0].apr))

t('concentration is a percentage', oiConcentration(d, 3) > 0 && oiConcentration(d, 3) <= 100)
t('and the top 3 cannot exceed the top 10', oiConcentration(d, 3) <= oiConcentration(d, 10) + 1e-9)
t('a coin share is a share', oiShare(d, 'BTC') > 0 && oiShare(d, 'BTC') < 100)
t('an unknown coin is zero, not NaN', oiShare(d, 'NOTACOIN') === 0)

// ── the shapes that would crash it ───────────────────────────────────────────
t('an empty response is handled', computeEcosystem([]).ok === false)
t('undefined is handled', computeEcosystem(undefined).ok === false)
t('a universe with no contexts is handled',
  computeEcosystem([{ universe: [{ name: 'X' }] }, []]).ok === false)
t('a market with no mark price is skipped rather than dividing by zero',
  computeEcosystem([{ universe: [{ name: 'X' }] }, [{ markPx: '0', openInterest: '5' }]]).coins === 0)
t('a brand-new market with no previous close reads as 0%, not Infinity',
  computeEcosystem([{ universe: [{ name: 'X' }] }, [{ markPx: '10', prevDayPx: '0', dayNtlVlm: '0', openInterest: '1', funding: '0' }]]).rows[0].chg === 0)

// ── wiring ───────────────────────────────────────────────────────────────────
t('the News stub is gone', !cli.includes("_mobVActiveTab === 'news'") && !cli.includes('Coming soon'))
t('the tab is renamed everywhere, leaving no dead allowlist entry', !/'news'/.test(cli))
t('the button opens it', html.includes("window.mobVGoTab('pulse')"))
t('and is no longer labelled News', !html.includes('aria-label="News"'))
// Scoped to the pulse fetch: metaAndAssetCtxs is also called elsewhere in the app, which
// is not this feature's business.
const pf = cli.slice(cli.indexOf('async function _pulseFetch('), cli.indexOf('const _pulseUsd'))
// The 60s path is two whole-exchange calls. What it must never do is fan out per MARKET —
// 232 of those would be 4,640 weight a minute against a 1,200 budget shared with the bots.
t('the fast path is two whole-exchange calls, never per-market',
  (pf.match(/infoClient\./g) ?? []).length === 2
  && pf.includes('metaAndAssetCtxs()') && pf.includes('spotMetaAndAssetCtxs()'))
t('the per-dex fan-out is ten calls and lives on the slow path',
  grab(cli, 'async function _pulseFetchDexes(main)').includes('metaAndAssetCtxs({ dex })'))
t('cached, so switching tabs does not re-poll', cli.includes('PULSE_TTL_MS'))
t('a failed fetch keeps the last good data rather than blanking',
  /catch \(e\) \{\s*console\.warn\('\[pulse\]'/.test(cli))
t('four-figure funding is rounded, not printed to two decimals',
  cli.includes('Math.abs(v) >= 100 ? Math.round(Math.abs(v))'))
t('the footnote states the volume floor, so a missing coin is explainable',
  cli.includes('under $100k of 24h volume'))
t('rows open the coin rather than being dead text', cli.includes('__watchOpenTrade?.('))

// ── full page ────────────────────────────────────────────────────────────────
const css = fs.readFileSync('src/style.css', 'utf8')
t('Pulse takes the whole pane', cli.includes("classList.add('mob-tab-full')"))
t('and reuses the lift built for Strats rather than a second mechanism',
  /#mobileView\.mob-strats-full \.mob-v-content,\s*#mobileView\.mob-tab-full \.mob-v-content/.test(css))
t('it sits below the bottom nav, so Home and Trade stay reachable',
  /mob-tab-full[\s\S]{0,300}z-index: 120/.test(css))
// The exact bug the Strats guard was written for: leaving the tab any other way left every
// other view rendering inside a fixed pane stuck over the app.
const rc = cli.slice(cli.indexOf('function _mobVRenderContent(tick = false)'), cli.indexOf('function _mobVRenderContent(tick = false)') + 1800)
t('leaving Pulse gives the pane back',
  rc.includes("if (_mobVActiveTab !== 'pulse') document.getElementById('mobileView')?.classList.remove('mob-tab-full')"))
t('and that runs before the new tab is drawn',
  rc.indexOf("remove('mob-tab-full')") < rc.indexOf('_i18nHarvest'))
t('the Strats toggle is untouched', cli.includes("classList.toggle('mob-strats-full', _stratsFull)"))

// ── builder dexes, the RWA split, and spot — all against live data ───────────
const hl = (b) => fetch('https://api.hyperliquid.xyz/info', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json())

const cats = Object.fromEntries(await hl({ type: 'perpCategories' }))
t('perpCategories returns entries', Object.keys(cats).length > 50, String(Object.keys(cats).length))
// This is why an RWA split cannot be computed from the main dex: the categories only
// describe HIP-3 markets, and every key is prefixed with its dex.
t('every category key is a HIP-3 market, prefixed with its dex',
  Object.keys(cats).every(k => k.includes(':')))
t('and so NONE of the main-dex coins are categorised',
  d.rows.slice(0, 20).every(r => !cats[r.coin]))
t('TradFi categories are recognised', isTradFi('stocks') && isTradFi('FX') && !isTradFi('crypto'))

const names = (await hl({ type: 'perpDexs' })).filter(Boolean).map(x => x.name).filter(Boolean)
const fetched = []
for (const dex of names) { try { fetched.push({ dex, pair: await hl({ type: 'metaAndAssetCtxs', dex }) }) } catch {} }
const dx = computeDexes(fetched, cats, d)
console.log(`  (builder dexes: ${dx.live.length} live of ${dx.dexes.length}, $${(dx.builderVol / 1e6).toFixed(0)}M vol; RWA ${dx.rwaVolShare.toFixed(1)}%)`)

t('every builder dex is accounted for', dx.dexes.length === names.length)
t('sorted by volume', dx.dexes.every((x, i, a) => i === 0 || a[i - 1].vol >= x.vol))
t('the live list excludes dexes with no volume', dx.live.every(x => x.vol > 0) && dx.live.length < dx.dexes.length)
t('there is real RWA volume to report', dx.rwaVol > 0, String(dx.rwaVol))
t('the main dex counts as crypto, not as uncategorised',
  dx.cryptoVol >= d.totalVol, `${dx.cryptoVol} vs ${d.totalVol}`)
t('the split is a share of the whole, not of HIP-3 alone',
  dx.rwaVolShare > 0 && dx.rwaVolShare < 50, String(dx.rwaVolShare))
t('no dex is double counted',
  Math.abs(dx.builderVol - dx.dexes.reduce((s, x) => s + x.vol, 0)) < 1)
t('an empty fan-out does not crash', computeDexes([], {}, d).dexes.length === 0)
t('and still reports the main dex as crypto', computeDexes([], {}, d).cryptoVol === d.totalVol)
t('a missing main is handled', computeDexes([], {}, undefined).cryptoVol === 0)

const sp = computeSpot(await hl({ type: 'spotMetaAndAssetCtxs' }))
console.log(`  (spot: $${(sp.vol / 1e6).toFixed(1)}M across ${sp.pairs} pairs)`)
t('spot volume parsed', sp.ok && sp.vol > 0)
t('spot pairs counted', sp.pairs > 100, String(sp.pairs))
t('top spot pairs are ranked', sp.top.every((x, i, a) => i === 0 || a[i - 1].vol >= x.vol))
t('a broken spot payload is handled', computeSpot(undefined).ok === false && computeSpot([]).ok === false)

// ── wiring ───────────────────────────────────────────────────────────────────
t('the dex fan-out is on a slower clock than the headline figures',
  cli.includes('PULSE_DEX_TTL_MS') && cli.includes('5 * 60_000'))
t('and never blocks them', /_pulseFetchDexes\(d\)\.then\(/.test(cli))
t('spot failing does not take the whole tab down',
  cli.includes('infoClient.spotMetaAndAssetCtxs().catch(() => null)'))
t('categories failing does not take the dex section down',
  cli.includes('infoClient.perpCategories().catch(() => [])'))
t('the RWA bar only renders when there is RWA volume', cli.includes('_pulseDex.rwaVol > 0 ?'))
t('and explains that RWA lives on builder dexes, not the main exchange',
  cli.includes('the main exchange is crypto only'))

// ── protocol: the Assistance Fund, and what may honestly be called revenue ───
const AF = '0xfefefefefefefefefefefefefefefefefefefefe'
const [afSt, afPf, mids] = await Promise.all([
  hl({ type: 'spotClearinghouseState', user: AF }),
  hl({ type: 'portfolio', user: AF }),
  hl({ type: 'allMids' }),
])
const pr = computeProtocol({ afBalances: afSt?.balances, afPortfolio: afPf,
  hypeMid: mids.HYPE, perpVol: d.totalVol, spotVol: sp.vol })
console.log(`  (fund: ${pr.afHype.toLocaleString(undefined,{maximumFractionDigits:0})} HYPE = $${(pr.afUsd/1e9).toFixed(2)}B; fees $${(pr.feesLow/1e6).toFixed(2)}M-$${(pr.feesHigh/1e6).toFixed(2)}M)`)

t('the Assistance Fund is readable like any account', pr.ok && pr.afHype > 1e6, String(pr.afHype))
t('and is worth billions, which is the point of showing it', pr.afUsd > 1e9)
t('valued at the live HYPE price, not a stored one',
  Math.abs(pr.afUsd - pr.afHype * Number(mids.HYPE)) < 1)
t('its start date comes from the fund history', pr.since > 0 && pr.since < Date.now())

// Fees are bounds, never a point estimate — the maker/taker mix is not published.
t('the low bound is the maker rate', Math.abs(pr.feesLow - pr.vol * HL_FEE_MAKER) < 1e-6)
t('the high bound is the taker rate', Math.abs(pr.feesHigh - pr.vol * HL_FEE_TAKER) < 1e-6)
t('and the low really is below the high', pr.feesLow < pr.feesHigh)
t('both perps and spot volume are counted', Math.abs(pr.vol - (d.totalVol + sp.vol)) < 1)

// The fund's VALUE moved ~$990M in a week on a 46M HYPE position. Calling that revenue
// would overstate it by an order of magnitude, so nothing here does.
const eco = fs.readFileSync('src/ecosystem.js', 'utf8')
t('the module states that the fund value is not revenue', eco.includes('NOT REVENUE'))
t('the UI calls it a balance, not a revenue total',
  cli.includes('a balance, not a revenue total'))
t('and never labels the fund as revenue',
  !/revenue['"]\s*[,)]/.test(cli.slice(cli.indexOf('Assistance Fund'), cli.indexOf('Assistance Fund') + 1200)))
t('the fee range says why it is a range', cli.includes('so this is bounds rather than a figure'))

t('a fund with no HYPE is not reported as ok', computeProtocol({ afBalances: [] }).ok === false)
t('missing input does not crash', computeProtocol().ok === false && computeProtocol({}).afUsd === 0)
t('the fund read is on the slow clock, not the 60s one',
  cli.indexOf('_pulseFetchProto') > 0 && grab(cli, 'async function _pulseFetchProto(main, spot)').includes('spotClearinghouseState'))
t('and a failure there degrades only that section',
  grab(cli, 'async function _pulseFetchProto(main, spot)').includes("console.warn('[pulse proto]'"))

// ── the asset card ───────────────────────────────────────────────────────────
const chg = new Function(`
  ${grab(cli, 'function _pulseChangeFrom(pts, msAgo)')}
  return _pulseChangeFrom
`)()
const now = Date.now(), H = 3600e3
const series = Array.from({ length: 200 }, (_, i) => ({ t: now - (199 - i) * H, c: 100 + i }))
t('a timeframe change is measured from the candle at or before the cutoff',
  Math.abs(chg(series, 10 * H) - ((299 / 289 - 1) * 100)) < 1e-6, String(chg(series, 10 * H)))
t('a window longer than the history returns nothing rather than a wrong number',
  chg(series, 5000 * H) === null)
t('too few points is null', chg([{ t: now, c: 1 }], H) === null && chg([], H) === null)
t('a zero last price is null, not Infinity', chg([{ t: now - H, c: 5 }, { t: now, c: 0 }], H) === null)
t('a zero base is null too', chg([{ t: now - H, c: 0 }, { t: now, c: 5 }], H) === null)

// Tapping used to leave the tab entirely, which threw away the context you tapped from.
const row = grab(cli, 'function _pulseRow(r, right, tone, key = \'\')')
t('a row expands in place instead of navigating away', row.includes('window.__pulseToggle('))
t('and no longer jumps straight to Trade', !row.includes('__watchOpenTrade'))
t('Trade is still reachable, from inside the card',
  grab(cli, 'function _pulseCardHtml(r, id)').includes('__watchOpenTrade'))
t('the trade button does not also collapse the card', 
  grab(cli, 'function _pulseCardHtml(r, id)').includes('event.stopPropagation()'))

t('funding shows on EVERY row, not only the funding sections', row.includes("_pulseApr(r.apr)") && row.includes('24h vol'))
t('a row with no funding (spot) omits it rather than printing NaN',
  row.includes('Number.isFinite(r.apr)'))

const card = grab(cli, 'function _pulseCardHtml(r, id)')
for (const f of ['Mark', 'Open interest', '24h volume', 'Market cap', 'Funding APR', 'Premium'])
  t(`the card shows ${f}`, card.includes(f))
t('and every timeframe from 1h to all-time', cli.includes('const _PULSE_TF = [') &&
  ['1h', '7d', '30d', '3M', '1y', 'All'].every(k => cli.includes(`'${k}',`)))
t('market cap comes from the spot map, since a perp alone has none',
  card.includes('_mktCapByName[r.coin]'))
t('a spot row prefers the cap it carries itself', card.includes('num(r.marketCap) ?? _mktCapByName[r.coin]'))
t('and shows a dash when the token does not trade spot', card.includes('mkt > 0 ? _pulseUsd(mkt) : dash'))

// Candles are one call PER COIN — fetching them for every row would be dozens of calls
// for rows nobody opened.
const lc = grab(cli, 'function _pulseLoadCandles(coin)')
t('candles are fetched lazily, on expand only', grab(cli, 'window.__pulseToggle = function(coin, id)').includes('_pulseLoadCandles(coin)'))
t('and cached per coin AND interval — a card needs two series', lc.includes("const key = coin + '|' + iv"))
// A year of hourly candles is 8,760 points and HL caps a snapshot at 5,000, so the long
// windows have to come from a daily series. Two intervals, one loop, one call site.
t('two intervals cover every timeframe, from a single call site',
  (lc.match(/fetchCandles\(/g) ?? []).length === 1 && lc.includes("[['1h', 31 * 24 * 3600e3], ['1d', 0]]"))
t('a failed fetch is remembered as an error rather than retried forever',
  lc.includes("_pulseCandles[key] = 'error'"))
t('the same coin in two sections expands independently',
  row.includes("'pl' + key + '-'"))
t('the id survives coins like xyz:SPCX and @107',
  row.includes('charCodeAt(0).toString(36)'))
// _ensureMarketData() would have done, but it also starts the HIP-3 loader: one
// weight-20 call per builder dex to fill in numbers this card never shows.
t('market cap is loaded on expand from ONE spot call, not the full market-data fan-out',
  lc.includes('_pulseEnsureCaps()') && !lc.includes('_ensureMarketData'))
t('and that loader reads circulatingSupply straight off the spot context',
  grab(cli, 'async function _pulseEnsureCaps()').includes('circulatingSupply'))
t('it skips the call entirely when the markets tab already built the map',
  grab(cli, 'async function _pulseEnsureCaps()').includes('if (Object.keys(_mktCapByName).length) return'))

// Market caps run to trillions; before the T tier BTC printed "$1620.67B".
const usd = new Function(cli.slice(cli.indexOf('const _pulseUsd = '), cli.indexOf('// Funding runs to four figures')) + ' return _pulseUsd')()
t('a trillion market cap reads as $1.62T, not $1620.67B', usd(1.6207e12) === '$1.62T', usd(1.6207e12))
t('billions still read as billions', usd(2.91e9) === '$2.91B', usd(2.91e9))
t('and the smaller tiers are untouched', usd(1.7e6) === '$1.7M' && usd(5e3) === '$5k')

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
