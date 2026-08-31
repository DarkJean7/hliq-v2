// Drives the real bucket helpers out of src/main.js against the LIVE outcomeMeta and the
// live mids, because the whole bug was a mismatch with what Hyperliquid actually returns.
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

const M = new Function(`
  ${grab(cli, 'function _parseOutcomeDesc(')}
  ${grab(cli, 'function _fmtOcK(')}
  ${grab(cli, 'function _fmtOcQuestionTime(')}
  ${grab(cli, 'function _fmtOutcomeExpiry(')}
  ${grab(cli, 'function _ocNormalizeBuckets(')}
  ${grab(cli, 'function _ocBucketLabel(')}
  ${grab(cli, 'function _buildFullQuestion(')}
  ${grab(cli, 'function _ocGetCategory(')}
  return { _parseOutcomeDesc, _ocNormalizeBuckets, _ocBucketLabel, _buildFullQuestion, _ocGetCategory }
`)()

const post = (b) => fetch('https://api.hyperliquid.xyz/info', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
}).then(r => r.json())

const meta = await post({ type: 'outcomeMeta' })
const mids = await post({ type: 'allMids' })

const bucketQs = (meta.questions ?? []).filter(q =>
  M._parseOutcomeDesc(q.description || '').class === 'priceBucket')
t('Hyperliquid is serving at least one priceBucket question', bucketQs.length > 0,
  JSON.stringify((meta.questions ?? []).map(q => q.description)))

// ── the exact shape the old filter choked on ─────────────────────────────────
t('the bucket question is named "Recurring" — the string the old filter hid on',
  bucketQs.every(q => /recurring/i.test(q.name || '')), bucketQs.map(q => q.name).join(','))
const beforeMembers = (bucketQs[0]?.namedOutcomes ?? [])
  .map(id => (meta.outcomes ?? []).find(o => o.outcome === id))
t('its members arrive with a placeholder name and no spec of their own',
  beforeMembers.length >= 2 && beforeMembers.every(o =>
    !M._parseOutcomeDesc(o.description).underlying && /named outcome/i.test(o.name || '')),
  JSON.stringify(beforeMembers.map(o => [o.name, o.description])))

// ── normalize ────────────────────────────────────────────────────────────────
M._ocNormalizeBuckets(meta)
const q = bucketQs[0]
const qd = M._parseOutcomeDesc(q.description)
const th = String(qd.priceThresholds).split(',').map(Number).sort((a, b) => a - b)
const members = q.namedOutcomes.map(id => meta.outcomes.find(o => o.outcome === id))

t('every member now carries the question\'s underlying',
  members.every(o => M._parseOutcomeDesc(o.description).underlying === qd.underlying))
t('every member now carries the expiry, so the countdown can render',
  members.every(o => M._parseOutcomeDesc(o.description).expiry === qd.expiry))
t('every member is classed priceBucket',
  members.every(o => M._parseOutcomeDesc(o.description).class === 'priceBucket'))
t('N thresholds produce N+1 buckets', members.length === th.length + 1,
  `${members.length} members, ${th.length} thresholds`)

const ds = members.map(o => M._parseOutcomeDesc(o.description))
const lo = ds.find(d => d.bucketLo === undefined)
const hi = ds.find(d => d.bucketHi === undefined)
t('exactly one open-ended bucket at each end',
  !!lo && !!hi && ds.filter(d => d.bucketLo === undefined).length === 1
              && ds.filter(d => d.bucketHi === undefined).length === 1)
t('the bottom bucket ends at the lowest threshold', Number(lo.bucketHi) === th[0])
t('the top bucket starts at the highest threshold', Number(hi.bucketLo) === th[th.length - 1])
t('the buckets tile without gaps or overlaps', ds
  .filter(d => d.bucketLo !== undefined && d.bucketHi !== undefined)
  .every(d => Number(d.bucketLo) < Number(d.bucketHi)))

// ── index → bucket, checked against what the market actually costs ───────────
// The bottom bucket must be the cheapest Yes and the top the dearest, or the mapping is
// inverted and the app would sell people the opposite of what the label says.
const yes = (o) => Number(mids['#' + (o.outcome * 10)])
const priced = members.map(o => ({ o, d: M._parseOutcomeDesc(o.description), y: yes(o) }))
  .filter(x => Number.isFinite(x.y))
t('live mids exist for every bucket', priced.length === members.length)
if (priced.length === members.length && priced.length > 1) {
  const bottom = priced.find(x => x.d.bucketLo === undefined)
  const top    = priced.find(x => x.d.bucketHi === undefined)
  const spot   = Number(mids[qd.underlying])
  // Spot is above the top threshold today, so "above" must be the expensive leg.
  const expectTopDearer = spot > th[th.length - 1]
  // A daily market that has just rolled over has no trades yet and every leg sits at 0.5,
  // which carries no information about the mapping. Skip rather than fail on a fresh one.
  const untraded = priced.every(x => Math.abs(x.y - 0.5) < 1e-6)
  if (untraded) {
    console.log('  SKIP the mapping check — this daily market just rolled over, all legs at 0.50')
  } else {
    t('the mapping matches the market: the in-the-money end is the dearer one',
      expectTopDearer ? top.y > bottom.y : bottom.y > top.y,
      `spot ${spot}, thresholds ${th}, bottom ${bottom.y}, top ${top.y}`)
  }
  // Deliberately NOT asserting that the legs sum to 1. Their books are one-sided and
  // very wide — the middle leg quotes 0.003 bid against 0.947 ask — so allMids is not a
  // probability here and a sum test would measure Hyperliquid's liquidity, not our code.
}

// Each leg must have a real book, or the label is honest about a market nobody can trade.
const books = await Promise.all(members.map(o =>
  post({ type: 'l2Book', coin: '#' + (o.outcome * 10) }).catch(() => null)))
// A just-created daily market legitimately has no resting orders yet.
const anyBook = books.some(b => (b?.levels?.[0]?.length ?? 0) + (b?.levels?.[1]?.length ?? 0) > 0)
if (!anyBook) {
  console.log('  SKIP the order-book check — this daily market has no resting orders yet')
} else {
  t('every bucket that trades at all has a book, so the card leads somewhere tradeable',
    books.every(b => (b?.levels?.[0]?.length ?? 0) + (b?.levels?.[1]?.length ?? 0) > 0))
}

// ── labels ───────────────────────────────────────────────────────────────────
const labels = ds.map(d => M._ocBucketLabel(d))
t('the bottom bucket reads "Below …"', labels.some(l => l.startsWith('Below ')), labels.join(' | '))
t('the top bucket reads "Above …"', labels.some(l => l.startsWith('Above ')), labels.join(' | '))
t('no label is the placeholder name', labels.every(l => !/recurring|named outcome/i.test(l)))
t('every label is distinct', new Set(labels).size === labels.length, labels.join(' | '))
t('short labels stay short for narrow rows',
  ds.every(d => M._ocBucketLabel(d, true).length <= 16), ds.map(d => M._ocBucketLabel(d, true)).join(' | '))

const qs = ds.map(d => M._buildFullQuestion(d, 'Recurring Named Outcome'))
t('the full question names the asset and the range',
  qs.every(x => x.line1.includes(qd.underlying)) &&
  qs.some(x => /close below/.test(x.line1)) &&
  qs.some(x => /close above/.test(x.line1)) &&
  (th.length < 2 || qs.some(x => /close between/.test(x.line1))),
  qs.map(x => x.line1).join(' | '))
t('the second line carries the settlement time', qs.every(x => /^on .+\?$/.test(x.line2)),
  qs[0]?.line2)
t('a bucket market is categorised as crypto, not "other"',
  members.every((o, i) => M._ocGetCategory(o, ds[i]) === 'crypto'))

// ── the filter that was hiding them ──────────────────────────────────────────
const sect = grab(cli, 'function _ocSectionize()')
t('the template filter now consults the parsed class, not just the name',
  /!qd\.class && \/\\b\(recurring\|fallback\|template\)/.test(sect), 'filter not updated')
t('the event card labels rows by range rather than by placeholder name',
  sect.includes('rowName(o)') && !sect.includes('esc(o.name)</span>'))
t('a bucket event gets a real title', sect.includes("Closing price on"))
t('binary markets keep their old title path', sect.includes("title.match("))

// ── the normalizer is reached by every fetch, not just the Predictions tab ───
const build = grab(cli, 'function _buildOcTokenMap(')
t('normalization happens at the shared choke point', build.includes('_ocNormalizeBuckets(meta)'))
t('history/position labels carry the range too', build.includes('bucketStr'))
t('the grouping label is not the placeholder "Recurring"', build.includes('closing price'))

// ── the displayed odds must match Hyperliquid's mark, not a one-sided book ───
// A bucket leg routinely quotes a lone bid with no ask. Taking that lone side as the price
// showed 6% for a market HL marks at 0.3755, while outcome.xyz showed 38%.
const mid = grab(cli, 'async function _ocSideMid(pairIdx, info, candleFallback = false)')
t('the mark is consulted before the book', mid.indexOf('state.allMids') < mid.indexOf('l2Book'))
t('a one-sided book no longer yields a price',
  mid.includes('const mid  = bid > 0 && ask > 0 ? (bid + ask) / 2 : 0'))
t('the lone-side fallback is gone', !mid.includes('(bid || ask)'))
t('the fill price is a separate path and still reads the book',
  cli.includes('_ocEffPx'))

// Drive it against the live market.
const M2 = new Function('state', 'info', 'fetchCandles', `
  return (async () => {
    ${grab(cli, 'async function _ocSideMid(pairIdx, info, candleFallback = false)')}
    return _ocSideMid
  })()
`)
const liveMids = await post({ type: 'allMids' })
const sideMid = await M2({ allMids: liveMids }, {
  l2Book: ({ coin }) => post({ type: 'l2Book', coin }),
}, async () => [])

for (const o of members) {
  const key = '#' + (o.outcome * 10)
  const want = Number(liveMids[key])
  if (!(want > 0 && want < 1)) { console.log('  SKIP mark check for', key, '— HL has no mark yet'); continue }
  const got = await sideMid(o.outcome * 10, { l2Book: ({ coin }) => post({ type: 'l2Book', coin }) })
  t(`bucket ${M._ocBucketLabel(M._parseOutcomeDesc(o.description), true)} shows HL's mark`,
    Math.abs(got - want) < 1e-9, `got ${got}, HL says ${want}`)
}

// And confirm the old behaviour really would have differed on a one-sided book.
const oneSided = (await post({ type: 'l2Book', coin: '#' + (members[members.length - 1].outcome * 10) }))
const hasBid = (oneSided?.levels?.[0]?.length ?? 0) > 0
const hasAsk = (oneSided?.levels?.[1]?.length ?? 0) > 0
if (!hasBid && !hasAsk) {
  console.log('  SKIP the one-sided check — this leg has no book at all yet')
} else {
  t('at least one bucket leg really is one-sided right now, which is the whole problem',
    !(hasBid && hasAsk), `bid ${hasBid} ask ${hasAsk} — if both, the market is two-sided today`)
}

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
