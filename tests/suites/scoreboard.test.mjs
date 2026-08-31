// Expandable Scoreboard rows, driven against REAL Hyperliquid fills.
import fs from 'fs'
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')

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

const M = new Function('fmtUSD', 'fmtPrice', 'esc', '_T', `
  ${grab(cli, 'function _scPnl(v)')}
  ${cli.slice(cli.indexOf('const SC_TRADE_LIMIT'), cli.indexOf('function _scTradesHtml'))}
  ${grab(cli, 'function _scTradesHtml(fills, funding = [])')}
  return { _scPnl, _scTradesHtml, SC_TRADE_LIMIT }
`)(
  (n) => Number(n).toFixed(2),
  (n) => Number(n).toFixed(4),
  (s) => String(s),
  (en) => en,
)

// ── the sign bug the screenshot showed ───────────────────────────────────────
// A loss rendered as "$724.70" in red: the template prefixed only the positive case and
// printed Math.abs. Colour alone carried the meaning.
t('a loss carries a minus sign, not just a red colour', M._scPnl(-724.7) === '−$724.70')
t('a gain still carries a plus', M._scPnl(2822.32) === '+$2822.32')
t('zero reads as a gain rather than "−$0.00"', M._scPnl(0) === '+$0.00')
t('the row uses it', cli.includes('<div class="mob-v-row-val ${cls}">${_scPnl(s.totalPnl)}</div>'))

// ── against real fills ───────────────────────────────────────────────────────
const fills = await fetch('https://api.hyperliquid.xyz/info', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'userFillsByTime', user: '0xaa7Ad5Fa4D99D9BF3397232Df7F4523853538159', startTime: 1786000000000 }),
}).then(r => r.json()).catch(() => [])
t('real fills fetched', Array.isArray(fills) && fills.length > 0, String(fills.length))

const byCoin = {}
for (const f of fills) (byCoin[f.coin] ??= []).push(f)
const coin = Object.entries(byCoin).sort((a, b) => b[1].length - a[1].length)[0]
const html = M._scTradesHtml(coin[1])
const closes = coin[1].filter(f => Number(f.closedPnl) !== 0)
console.log(`  (using ${coin[0]}: ${coin[1].length} fills, ${closes.length} closed)`)

t('only CLOSING fills are listed — an opening fill has no realized number',
  (html.match(/Long|Short/g) ?? []).length >= 1
  && (html.match(/@ \$/g) ?? []).length === Math.min(closes.length, M.SC_TRADE_LIMIT))
t('the header counts the closed trades', html.includes(`${closes.length} closed`))
t('and how many won', /\d+\/\d+ won/.test(html))

// The total must reconcile with what the account kept, so EVERY fee comes off — the
// opening fills carry closedPnl 0 and a real fee, and they used to be skipped.
const netExpected = closes.reduce((a, f) => a + Number(f.closedPnl), 0)
                  - coin[1].reduce((a, f) => a + Number(f.fee ?? 0), 0)
t('the total is after every fee, entry included', html.includes(M._scPnl(netExpected)), M._scPnl(netExpected))
t('and says so', html.includes('after fees'))
t('the parts are shown so the figure can be checked',
  html.includes('realized') && html.includes('fees'))

// ── the awkward cases ────────────────────────────────────────────────────────
t('a coin with only opening fills says so rather than showing an empty panel',
  M._scTradesHtml([{ closedPnl: 0, fee: 0, time: 1, px: 1, dir: 'Open Long' }]).includes('No closed trades yet'))
t('no fills at all is handled', M._scTradesHtml([]).includes('No closed trades yet'))
t('undefined is handled', M._scTradesHtml(undefined).includes('No closed trades yet'))

const many = Array.from({ length: 200 }, (_, i) => ({
  closedPnl: 1, fee: 0.1, time: i, px: 10, dir: 'Close Long',
}))
const capped = M._scTradesHtml(many)
t('a 200-trade coin is capped rather than rendering 200 rows',
  (capped.match(/@ \$/g) ?? []).length === M.SC_TRADE_LIMIT)
t('and says how many it is hiding', capped.includes('Showing the latest 60 of 200'))
t('but the totals still cover ALL of them, not just the shown ones',
  capped.includes(M._scPnl(200 * 0.9)), M._scPnl(200 * 0.9))

t('newest first', (() => {
  const h = M._scTradesHtml([
    { closedPnl: 1, fee: 0, time: 1000, px: 1, dir: 'Close Long' },
    { closedPnl: 2, fee: 0, time: 9000, px: 2, dir: 'Close Long' },
  ])
  return h.indexOf('$2.0000') < h.indexOf('$1.0000')
})())

// HL's `dir` describes the position closed, not the side of this fill.
t('a closed short is labelled Short',
  M._scTradesHtml([{ closedPnl: 5, fee: 0, time: 1, px: 1, dir: 'Close Short' }]).includes('>Short<'))
t('a closed long is labelled Long',
  M._scTradesHtml([{ closedPnl: 5, fee: 0, time: 1, px: 1, dir: 'Close Long' }]).includes('>Long<'))

// A trade whose fee exceeds its gross is a net loss and must read as one.
t('fees can flip a winner into a loss, and it shows red',
  M._scTradesHtml([{ closedPnl: 0.5, fee: 2, time: 1, px: 1, dir: 'Close Long' }]).includes('−$1.50'))

// ── wiring ───────────────────────────────────────────────────────────────────
// The watch branch also appears far EARLIER in the file, so the end anchor has to be
// searched from the scoreboard's position, not from zero.
const scStart = cli.indexOf('const scHeader = _mobVFullHeader')
const sc = cli.slice(scStart, cli.indexOf("if (_mobVActiveTab === 'watch')", scStart))
t('the slice under test is the scoreboard branch', scStart > 0 && sc.length > 500 && sc.includes('allStats'))
t('rows are clickable', sc.includes('window._mobVToggleRow('))
t('it reuses the existing expand mechanism rather than a new one',
  sc.includes('_mobVExpandedIds.has(id)') && sc.includes('id="mrd-') && sc.includes('id="mrc-'))
t('the id is an index, since a coin can be "#11420" or "xyz:SPCX" or "@107"',
  sc.includes("const id = 'sc' + allStats.indexOf(s)"))
t('expansion survives a re-render', sc.includes("display:${xp ? '' : 'none'}"))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
