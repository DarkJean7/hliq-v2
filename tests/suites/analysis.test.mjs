// The Analysis tab: chart list persistence, remount discipline, and the symbol rules.
import fs from 'fs'
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const srv = fs.readFileSync('serve-prod.js', 'utf8').replace(/\r\n/g, '\n')
const htm = fs.readFileSync('index.html', 'utf8').replace(/\r\n/g, '\n')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x))

console.log('\n-- the tab is reachable --')
t('listed in the nav order', cli.includes("'allocation', 'analysis']"))
t('renders full-screen', cli.includes("'leaderboard', 'allocation', 'analysis'])"))
t('the More drawer routes it', cli.includes("'heatmap', 'analysis'])"))
t('and so does mobVGoTab', cli.includes("'pulse', 'allocation', 'analysis'])"))
t('the render dispatch calls it', cli.includes("if (_mobVActiveTab === 'analysis') {\n    _anaRender(el)"))
t('there is a button for it', htm.includes(`window.__mobMoreTab('analysis')`))

console.log('\n-- ids survive a reload --')
// The bug: _anaLoad minted a random id per call, so Compare/Promote captured an id from
// the DOM and then failed to find it on the next load. Both silently did nothing.
t('a minted id is written straight back', cli.includes('if (minted) _anaSave(out)'))
t('minting is tracked while mapping', cli.includes('if (!c.id) minted = true'))
t('why is recorded', cli.includes('silently matched nothing'))

const load = new Function('store', `
  const _ANA_IVS = [{v:'15'},{v:'60'},{v:'240'},{v:'D'},{v:'W'}]
  const _anaSave = (l) => { store.saved = l }
  let list = store.raw
  if (!Array.isArray(list) || !list.length) list = [{ sym: 'HYPERLIQUID:BTCUSDC.P', iv: '60', cmp: [] }]
  let minted = false
  const out = list.map((c, i) => {
    if (!c.id) minted = true
    return { id: c.id || 'a' + i + '_' + Math.random().toString(36).slice(2,7),
      sym: String(c.sym || ''), iv: _ANA_IVS.some(x => x.v === c.iv) ? c.iv : '60',
      cmp: Array.isArray(c.cmp) ? c.cmp.slice(0,4) : [] }
  }).filter(c => c.sym)
  if (minted) _anaSave(out)
  return out`)

const s1 = { raw: null }
const a = load(s1)
t('a seeded list gets ids', a.every(c => c.id))
t('and is persisted immediately', Array.isArray(s1.saved) && s1.saved[0].id === a[0].id)
const s2 = { raw: s1.saved }
t('so the SAME id comes back next load', load(s2)[0].id === a[0].id)
t('and nothing is re-saved when nothing was minted', load(s2) && s2.saved === undefined)
t('a junk interval falls back to 1H', load({ raw: [{ sym: 'X:Y', iv: 'nonsense' }] })[0].iv === '60')
t('a symbol-less entry is dropped', load({ raw: [{ sym: '' }, { sym: 'X:Y' }] }).length === 1)
t('cmp is capped at 4 on read', load({ raw: [{ sym: 'X:Y', cmp: [1,2,3,4,5,6] }] })[0].cmp.length === 4)
t('a non-array cmp does not throw', load({ raw: [{ sym: 'X:Y', cmp: 'oops' }] })[0].cmp.length === 0)

console.log('\n-- an iframe is only rebuilt when it must be --')
// This tab re-renders on every price tick. Re-injecting a TradingView embed costs a full
// reload, so the signature must cover exactly what the mount depends on and nothing else.
// just the one line, or the slice runs into _anaMount below it (which mentions "hero")
const sig = cli.slice(cli.indexOf('function _anaSig')).split(String.fromCharCode(10))[0]
for (const part of ['c.sym', 'c.iv', 'c.cmp.join', '_tvTheme()', 'window.innerWidth < 700'])
  t(`signature covers ${part}`, sig.includes(part))
t('but NOT the position in the list', !/\bindex\b|\bhero\b/.test(sig))
t('height is applied outside the remount branch',
  cli.includes("// Height and order are pure layout — never a reason to reload an iframe.\n    card.style.height"))
t('reordering moves the existing node', cli.includes('host.insertBefore(card, host.children[i] || null)'))
t('a removed chart is dropped from the DOM',
  cli.includes('for (const node of [...host.children]) if (!want.has(node.dataset.anaId)) node.remove()'))
t('the shell is only built when missing', cli.includes("let host = document.getElementById('anaList')\n  if (!host) {"))
t('why reconciling beats re-rendering is written down', cli.includes('takes seconds to load'))

console.log('\n-- symbols that an embed cannot draw --')
// TradingView's own index feeds are licensed for tradingview.com only; a third-party
// embed gets a notification panel instead of a chart. Every one of these was verified
// by mounting it.
const blocked = ['TVC:DXY', 'SP:SPX', 'TVC:NDX', 'DJ:DJI', 'TVC:US10Y', 'TVC:VIX']
// stop at _TV_RETIRED -- that map names the blocked symbols on purpose
const markets = cli.slice(cli.indexOf('const _TV_MARKETS = ['), cli.indexOf('const _TV_RETIRED'))
for (const b of blocked) t(`${b} is not offered as a preset`, !markets.includes(`'${b}'`))
t('every blocked symbol has a replacement', blocked.every(b => cli.includes(`'${b}':`) || cli.includes(`${b}':`)))
t('DXY resolves to the feed that embeds', markets.includes("'CAPITALCOM:DXY'"))
t('the S&P too', markets.includes("'CAPITALCOM:US500'"))
t('gold keeps its TVC feed, which does embed', markets.includes("'TVC:GOLD'"))
t('saved watchlists are rewritten on read', cli.includes('_TV_RETIRED[s] || s'))
t('search hits are rewritten as well', cli.includes('const sub = _TV_RETIRED[x.full]'))
t('and so is a hand-typed symbol', cli.includes('sym = _TV_RETIRED[sym] || sym'))
t('substituted duplicates are collapsed', cli.includes('!seen.has(x.full) && seen.add(x.full)'))
t('the licence trap is explained for whoever edits the list next',
  cli.includes('licensed for tradingview.com only'))

const retired = new Function(`
  const _TV_RETIRED = { 'TVC:DXY':'CAPITALCOM:DXY','SP:SPX':'CAPITALCOM:US500','TVC:NDX':'CAPITALCOM:US100',
    'DJ:DJI':'CAPITALCOM:US30','TVC:US10Y':'FRED:DGS10','TVC:VIX':'CAPITALCOM:VIX' }
  const load = (raw) => [...new Set(raw.map(s => _TV_RETIRED[s] || s))]
  return load`)()
t('an old watchlist stops showing the licence panel',
  retired(['TVC:DXY', 'TVC:GOLD']).join() === 'CAPITALCOM:DXY,TVC:GOLD')
t('and does not end up with the symbol twice',
  retired(['TVC:DXY', 'CAPITALCOM:DXY']).length === 1)

console.log('\n-- comparison overlays --')
t('compare rides on the study, not compare_symbols',
  cli.includes("id: 'Compare@tv-basicstudies', inputs: { symbol: s }"))
t('why the documented option is not used is recorded',
  cli.includes('the documented `compare_symbols` option is ignored here'))
t('one per saved comparison', cli.includes('studies: c.cmp.map(s =>'))
t('adding is capped', cli.includes('if (c.cmp.length >= 4)'))
t('a duplicate is refused rather than drawn twice',
  cli.includes('if (c.sym === sym || c.cmp.includes(sym))'))
t('each overlay has a chip that removes it', cli.includes('window.__anaCmpRemove('))
t('the chip strip can actually be dragged',
  cli.includes('<div data-dragscroll style="display:flex;align-items:center;gap:5px;padding:0 11px 7px;overflow-x:auto">'))
// Compare moved INTO the chip strip: it is the "add another" affordance sitting right
// after the existing chips, and it stays visible when a chart has no comparisons yet.
t('and Compare sits inside that strip, so it is always reachable',
  cli.slice(cli.indexOf('data-dragscroll style="display:flex;align-items:center')).slice(0, 800).includes('__anaCompare'))

console.log('\n-- the picker --')
t('search goes through our own proxy', cli.includes("fetch(`/tvsearch?q=${encodeURIComponent(q)}"))
t('it is debounced', cli.includes('window._anaSearchT = setTimeout'))
t('a stale response cannot overwrite a newer one', cli.includes('if (seq !== _anaSearchSeq) return'))
t('a symbol with no exchange is rejected', cli.includes("if (!sym.includes(':'))"))
t('an HL coin is checked against TradingView before it is added',
  cli.includes('const hit = (j.symbols ?? []).find(s => s.full === `HYPERLIQUID:${coin}USDC.P`)'))
t('and says so plainly when it is not listed', cli.includes("TradingView doesn't list ${coin}"))
t('HIP-3 markets are declared unavailable rather than half-working',
  cli.includes('are not listed on TradingView and cannot be charted here'))
t('the same limit is explained at the top of the section',
  cli.includes('HIP-3 builder markets (SP500, GOLD, SPCX on the builder dexes)'))
t('the button passes its own element, not the global event',
  cli.includes("window.__anaPickHl('${esc(c)}', this)") && !cli.includes('const btn = event?.currentTarget'))

console.log('\n-- the search proxy --')
t('the route exists', srv.includes("if (url === '/tvsearch')"))
t('GET only', srv.includes("if (req.method !== 'GET') { res.writeHead(405).end(); return }"))
t('the query is length-capped', srv.includes(".trim().slice(0, 64)"))
t('the exchange filter is sanitised', srv.includes("replace(/[^A-Za-z0-9_]/g, '').slice(0, 24)"))
t('an empty query is refused without calling out', srv.includes('if (!text) { res.writeHead(400'))
t('answers are memoised', srv.includes('tvSearchCache.get(key)') && srv.includes('TV_SEARCH_TTL'))
t('the cache cannot grow forever', srv.includes('if (tvSearchCache.size > 500) tvSearchCache.clear()'))
t('the upstream call cannot hang the request', srv.includes('AbortSignal.timeout(8000)'))
t('an upstream failure degrades to an empty list', srv.includes(`res.writeHead(502, { 'Content-Type': 'application/json' }).end('{"symbols":[]}')`))
t('prefix wins over source_id when building the symbol', srv.includes("(s.prefix || s.source_id || '')"))
t('the highlight markup TV injects is stripped', srv.includes("replace(/<[^>]*>/g, '')"))
t('a record with no exchange is dropped', srv.includes("s.full.includes(':') && !s.full.startsWith(':')"))
t('why the proxy has to exist is written down', srv.includes('gates on Referer'))
t('and that nothing identifying is forwarded', srv.includes('no wallet, no account'))


console.log('\n-- series style --')
// TradingView's toolbar is wider than a phone: at 420px its style menu and Indicators are
// off the right edge, unreachable. These controls are our own, in our own header.
t('three styles are offered', (cli.match(/\{ v: '[0-9]', l: '(Candles|Line|Area)'/g) || []).length === 3)
t('candles is 1, line 2, area 3 (TradingView ids)',
  cli.includes("{ v: '1', l: 'Candles'") && cli.includes("{ v: '2', l: 'Line'") && cli.includes("{ v: '3', l: 'Area'"))
t('the style is what the widget mounts with', cli.includes('theme: _tvTheme(), style: c.st,'))
t('it is part of the remount signature', cli.includes('${c.iv}|${c.st}|'))
t('it is validated on read', cli.includes("st:  _ANA_STYLES.some(x => x.v === c.st) ? c.st : '1',"))
t('a new chart starts on candles', cli.includes("iv: '60', st: '1', cmp: [] })"))
t('the buttons are shared by card and fullscreen', cli.includes('function _anaStyleBtn(c, x, px)'))
t('each is labelled for screen readers', cli.includes('aria-label="${_T(x.l, x.es)}"'))
t('why the control has to be ours is written down', cli.includes('wider than a phone'))
t('and why Line matters for a comparison', cli.includes('always drawn as a line'))

console.log('\n-- full screen --')
t('there is a way in', cli.includes("window.__anaFull('${c.id}')"))
t('and out', cli.includes('window.__anaCloseFull = function()'))
t('the drawing rail is shown only where it fits',
  cli.includes('hide_side_toolbar: full ? false : (!hero || window.innerWidth < 700)'))
t('date ranges show in fullscreen too', cli.includes('withdateranges: hero || full'))
t('closing frees the iframe', cli.includes("ov.innerHTML = ''; delete ov.dataset.anaId"))
t('it remembers which chart it is showing', cli.includes('ov.dataset.anaId = id'))
t('a style change only refreshes it when it shows THAT chart',
  cli.includes("ov.style.display !== 'none' && ov.dataset.anaId === id"))
t('why fullscreen exists at all is recorded', cli.includes('fights that page for vertical'))

console.log('\n-- the swipe guard covers embedded charts --')
// These charts are iframes, not canvases. Nothing matched them, so dragging across one
// navigated to Trade instead of panning the time axis.
t('iframe is in the blocked selector', cli.includes("const _SWIPE_BLOCKED_SEL = 'canvas, iframe, input"))
t('why is written down next to it', cli.includes('pannable surfaces'))
const sel = cli.slice(cli.indexOf('const _SWIPE_BLOCKED_SEL')).split(String.fromCharCode(10))[0]
for (const keep of ['canvas', 'input', 'textarea', 'select', '.mob-v-tabs', '.no-swipe', '[data-dragscroll]'])
  t(`${keep} is still covered`, sel.includes(keep))

console.log(String.fromCharCode(10) + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
