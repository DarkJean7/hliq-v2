// Every HIP-4 outcome market HL currently lists must produce a readable question.
//
// HL ships two description schemas. The old one is name="Recurring" with
//   class:priceBinary|underlying:BTC|expiry:...|targetPrice:77610|period:1d
// everything added since is name="template:<kind>" with
//   perp:xyz:CL|priceDescription:...|seconds:1|threshold:83.196|time:20260929-2100
// Only the first was understood, so the new markets rendered their internal name --
// users saw the literal string "template:binaryPrice" where the question should be.
import fs from 'fs'
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const css = fs.readFileSync('src/style.css', 'utf8').replace(/\r\n/g, '\n')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const grab = (sig) => {
  const i = cli.indexOf(sig)
  if (i < 0) return ''
  let j = cli.indexOf('{', i), d = 0
  for (; j < cli.length; j++) { if (cli[j] === '{') d++; else if (cli[j] === '}') { d--; if (!d) return cli.slice(i, j + 1) } }
  return ''
}

// Build the real functions out of the source so this tests shipped code, not a copy.
const src = [
  grab('function _parseOutcomeDesc(desc)'),
  grab('function _ocNormalizeDesc(o, d)'),
  grab('function _ocUnderLabel(u)').replace('coinLabel(String(u ?? \'\'))', 'String(u ?? \'\').replace(/.*:/, \'\')'),
  grab('function _ocMoney(v)'),
  grab('function _ocDesc(o)'),
  grab('function _buildFullQuestion(d, name)'),
  grab('function _ocGetCategory(o, d)'),
].join('\n')
t('all seven functions were found in source', src.split('function ').length - 1 === 7, src.length)

const fns = new Function(`
  const _fmtOcQuestionTime = (raw) => 'WHEN(' + raw + ')'
  ${src}
  return { _parseOutcomeDesc, _ocNormalizeDesc, _ocDesc, _buildFullQuestion, _ocGetCategory, _ocUnderLabel, _ocMoney }
`)()

console.log('\n-- the parser no longer truncates at the second colon --')
// perp:xyz:CL used to yield perp="xyz", losing the market entirely. Every commodity and
// equity outcome HL has added is of that shape.
t('a colon-bearing value survives', fns._parseOutcomeDesc('perp:xyz:CL|threshold:83.196').perp === 'xyz:CL')
t('ordinary values are unchanged', fns._parseOutcomeDesc('underlying:BTC|period:1d').underlying === 'BTC')
t('a valueless part is ignored', Object.keys(fns._parseOutcomeDesc('other')).length === 0)
t('an empty description is empty, not a throw', Object.keys(fns._parseOutcomeDesc('')).length === 0)
t('a leading colon is not a key', Object.keys(fns._parseOutcomeDesc(':x')).length === 0)
t('the reason is recorded', cli.includes('Split on the FIRST colon only'))

console.log('\n-- the new schema is normalised onto the old field names --')
const touch = { name: 'template:priceTouch', description: 'perp:BTC|priceDescription:BTC-USDC mark|seconds:1|target:95000|time:20261001-0000' }
const bin   = { name: 'template:binaryPrice', description: 'perp:xyz:GOLD|priceDescription:xyz:GOLD-USDC mark|seconds:1|threshold:4460.9|time:20260829-2100' }
const old   = { name: 'Recurring', description: 'class:priceBinary|underlying:BTC|expiry:20260830-0600|targetPrice:77610|period:1d' }
const dT = fns._ocDesc(touch), dB = fns._ocDesc(bin), dO = fns._ocDesc(old)
t('priceTouch: perp becomes underlying', dT.underlying === 'BTC')
t('priceTouch: target becomes targetPrice', dT.targetPrice === '95000')
t('priceTouch: time becomes expiry', dT.expiry === '20261001-0000')
t('binaryPrice: threshold becomes targetPrice', dB.targetPrice === '4460.9')
t('binaryPrice: a HIP-3 underlying keeps its dex prefix internally', dB.underlying === 'xyz:GOLD')
t('and is labelled without it', fns._ocUnderLabel(dB.underlying) === 'GOLD')
t('the old schema is left exactly as it was', dO.underlying === 'BTC' && dO.targetPrice === '77610' && dO.class === 'priceBinary')
t('normalising is a no-op for non-template outcomes', dO.template === undefined)

console.log('\n-- every live market produces a real question --')
const LIVE = [
  ['Recurring', 'class:priceBinary|underlying:BTC|expiry:20260830-0600|targetPrice:77610|period:1d'],
  ['Recurring', 'class:priceBinary|underlying:HYPE|expiry:20260830-0600|targetPrice:81.89|period:1d'],
  ['template:priceTouch', 'perp:HYPE|priceDescription:HYPE-USDC perp mark |seconds:1|target:100|time:20261001-0000'],
  ['template:binaryPrice', 'perp:BTC|priceDescription:BTC-USDC mark|seconds:1|threshold:100000|time:20261001-0000'],
  ['template:priceTouch', 'perp:BTC|priceDescription:BTC-USDC mark|seconds:1|target:65000|time:20261001-0000'],
  ['template:binaryPrice', 'perp:xyz:SP500|priceDescription:xyz:SP500-USDC mark|seconds:1|threshold:7719.4|time:20260829-2000'],
  ['template:binaryPrice', 'perp:xyz:SNDK|priceDescription:xyz:SNDK-USDC mark|seconds:1|threshold:1490.1|time:20260829-2000'],
  ['template:binaryPrice', 'perp:xyz:SPCX|priceDescription:xyz:SPCX-USDC mark|seconds:1|threshold:140.64|time:20260829-2000'],
  ['template:binaryPrice', 'perp:xyz:SKHX|priceDescription:xyz:SKHX-USDC mark|seconds:1|threshold:1214.6|time:20260830-0630'],
  ['template:binaryPrice', 'perp:xyz:XYZ100|priceDescription:xyz:XYZ100|seconds:1|threshold:29486|time:20260829-2000'],
  ['template:binaryPrice', 'perp:xyz:DRAM|priceDescription:xyz:DRAM-USDC mark|seconds:1|threshold:56.048|time:20260829-2000'],
  ['template:binaryPrice', 'perp:xyz:GOLD|priceDescription:xyz:GOLD-USDC mark|seconds:1|threshold:4460.9|time:20260829-2100'],
  ['template:binaryPrice', 'perp:xyz:SILVER|priceDescription:xyz:SILVER-USDC mark|seconds:1|threshold:66.509|time:20260829-2100'],
  ['template:binaryPrice', 'perp:xyz:CL|priceDescription:xyz:CL|seconds:1|threshold:83.196|time:20260929-2100'],
  ['template:binaryPrice', 'perp:xyz:NBIS|priceDescription:xyz:NBIS-USDC mark|seconds:1|threshold:209.45|time:20260829-2000'],
  ['template:policyRateIncrease', ''],
  ['template:policyRateDecrease', ''],
  ['template:policyRateNoChange', ''],
]
let raw = 0
for (const [name, description] of LIVE) {
  const o = { name, description }
  const q = fns._buildFullQuestion(fns._ocDesc(o), name)
  if (String(q.line1).includes('template:')) { raw++; console.log('    still raw ->', q.line1) }
}
t('no market renders its internal template name', raw === 0, raw + ' of ' + LIVE.length)

const q = (name, description) => fns._buildFullQuestion(fns._ocDesc({ name, description }), name)
t('a touch market reads as "touch ... by"',
  q('template:priceTouch', 'perp:BTC|target:95000|time:20261001-0000').line1 === 'Will BTC touch $95,000')
t('and its deadline is a by-date', q('template:priceTouch', 'perp:BTC|target:95000|time:20261001-0000').line2.startsWith('by '))
t('a threshold market reads as "above ... at"',
  q('template:binaryPrice', 'perp:xyz:GOLD|threshold:4460.9|time:20260829-2100').line1 === 'Will GOLD be above $4,461')
t('and its deadline is an at-time', q('template:binaryPrice', 'perp:xyz:GOLD|threshold:4460.9|time:20260829-2100').line2.startsWith('at '))
t('the Fed legs are distinguishable', [
  q('template:policyRateIncrease', '').line1,
  q('template:policyRateDecrease', '').line1,
  q('template:policyRateNoChange', '').line1,
].join('|') === 'Will the Fed raise rates|Will the Fed cut rates|Will the Fed hold rates')
t('the old daily series still reads the same',
  q('Recurring', 'class:priceBinary|underlying:BTC|expiry:20260830-0600|targetPrice:77610').line1 === 'Will BTC close above $77,610')
t('an unknown future template degrades to its name rather than throwing',
  q('template:somethingNew', 'perp:BTC').line1 === 'template:somethingNew')

console.log('\n-- prices read as prices --')
t('thousands lose the cents', fns._ocMoney('100000') === '$100,000')
t('small numbers keep them', fns._ocMoney('66.509') === '$66.51')
t('junk does not become NaN', fns._ocMoney('x') === '?')

console.log('\n-- categories follow the underlying, not keyword luck --')
const cat = (name, description) => { const o = { name, description }; return fns._ocGetCategory(o, fns._ocDesc(o)) }
t('metals are commodities', cat('template:binaryPrice', 'perp:xyz:GOLD|threshold:1') === 'commodities')
t('oil is a commodity', cat('template:binaryPrice', 'perp:xyz:CL|threshold:1') === 'commodities')
t('indices are economy', cat('template:binaryPrice', 'perp:xyz:SP500|threshold:1') === 'economy')
t('chip names are tech', cat('template:binaryPrice', 'perp:xyz:SKHX|threshold:1') === 'tech')
t('crypto is still crypto', cat('template:priceTouch', 'perp:BTC|target:1') === 'crypto')
t('the Fed is economy', cat('template:policyRateIncrease', '') === 'economy')
t('the old series is unchanged', cat('Recurring', 'class:priceBinary|underlying:BTC') === 'crypto')
t('why underlying beats keywords is recorded', cli.includes('far more reliable'))
// A category with no chip is worse than "Other": the market is filed somewhere the user
// cannot navigate to, so it only ever shows under "All".
for (const c of ['crypto','commodities','economy','tech','other'])
  t(`the "${c}" category has a chip to reach it`, cli.includes(`data-cat="${c}"`))

console.log('\n-- one entry point, so a site cannot forget to normalise --')
t('call sites use _ocDesc', !cli.includes('_parseOutcomeDesc(o.description'))
t('and it is the parse+normalise pair', cli.includes('function _ocDesc(o) { return _ocNormalizeDesc(o, _parseOutcomeDesc(o?.description || \'\')) }'))
t('the settled-spec backfill normalises too', cli.includes('_ocNormalizeDesc(spec, _parseOutcomeDesc(spec.description))'))
t('and labels its underlying', cli.includes('d.underlying ? _ocUnderLabel(d.underlying) : spec.name'))


console.log(String.fromCharCode(10) + '-- every category a card can get MUST have a section --')
// Cards are appended by walking _OC_SECTIONS. A category with no row there is not merely
// unsorted: its cards are built and then never added to the page. Adding "commodities"
// as a category + filter chip WITHOUT a section is exactly how the gold/silver/oil
// markets vanished from the list.
const secBlock = cli.slice(cli.indexOf('const _OC_SECTIONS = ['), cli.indexOf('const _OC_SECTIONS = [') + 600)
const catBody  = grab('function _ocGetCategory(o, d)')
const returned = [...catBody.matchAll(/return '([a-z]+)'/g)].map(m => m[1])
t('the categoriser returns at least 8 distinct categories', new Set(returned).size >= 8, [...new Set(returned)])
for (const c of new Set(returned))
  t(`"${c}" has a section row`, secBlock.includes(`'${c}'`), c)
t('and each has a filter chip too', [...new Set(returned)].every(c => cli.includes(`data-cat="${c}"`)))
t('the invariant is written down', cli.includes('its cards are built and then silently dropped'))

console.log(String.fromCharCode(10) + '-- side names are sides, not template ids --')
const side = new Function('raw', 'fallback', `${grab('function _ocSideName(raw, fallback)')}
 return _ocSideName(raw, fallback)`)
t('"template:Yes" reads as Yes', side('template:Yes', 'Yes') === 'Yes')
t('"template:No" reads as No', side('template:No', 'No') === 'No')
t('a plain name is untouched', side('Increase', 'Yes') === 'Increase')
t('an empty name falls back', side('', 'Yes') === 'Yes')
t('a bare "template:" falls back rather than becoming blank', side('template:', 'Yes') === 'Yes')
t('no call site still reads the raw sideSpec name',
  !/sideSpecs\?\.\[0\]\?\.name \|\| 'Yes'/.test(cli) && !/sideSpecs\[i\]\.name \}/.test(cli))

console.log(String.fromCharCode(10) + '-- a template QUESTION is not a placeholder --')
// The old test was "has no class: key", which is true of every new-template question --
// they identify by name and put the spec in other keys -- so the name regex hid all of
// their legs. That removed the Fed rate-decision market from the list entirely.
t('placeholders are judged on having no keys at all', cli.includes('!Object.keys(qd).length && /'))
t('not on the absence of a class key', !cli.includes("!qd.class && /"))
t('why is recorded', cli.includes('removed the Fed'))
t('the Fed question gets a real title', cli.includes("title = qd.decisionLabel ? `Rate decision · ${qd.decisionLabel}`"))
t('and names its institution', cli.includes("qd.institution.replace(/'s Open Market Committee$/, '')"))
t('its legs read as answers', cli.includes("{ Increase: 'Increase', Decrease: 'Decrease', NoChange: 'No change' }"))
t('an unknown template leg is de-camel-cased rather than shown raw',
  cli.includes("const w = n.slice('template:'.length).replace(/([a-z])([A-Z])/g, '$1 $2')"))

console.log(String.fromCharCode(10) + '-- event cards carry the same identity cues as single ones --')
t('an event shows an icon', cli.includes('const evtIcon = _ocEventIcon(q, qd)'))
t('and a live marker with its date', cli.includes('const evtWhen = qd.expiry ? _fmtOutcomeExpiry(qd.expiry)'))
t('a rate decision falls back to its deadline', cli.includes('qd.decisionDeadline ? _fmtOutcomeExpiry(qd.decisionDeadline)'))
t('the bucket subtitle is labelled, not dex-prefixed', cli.includes('sub   = _ocUnderLabel(qd.underlying)'))
t('odds sit in a pill', css.includes('.oc-evt-pct {'))


console.log(String.fromCharCode(10) + '-- every event card has a face --')
// An event with no underlying coin (the Fed rate decision) had nothing for _coinIconHtml
// to draw, so it sat logo-less beside cards that all had one.
t('the icon is chosen by a helper, not inline', cli.includes('const evtIcon = _ocEventIcon(q, qd)'))
t('a coin-backed event uses the coin logo', cli.includes('if (qd.underlying) return _coinIconHtml(qd.underlying)'))
t('a rate decision gets an institutional glyph', cli.includes("if (name.startsWith('template:policyRate')) return _ocGlyphAvatar("))
t('and a fixed hue rather than a random one', cli.includes("_ocGlyphAvatar('&#127963;&#65039;', 'fed', 218)"))
t('anything else still gets a glyph rather than nothing', cli.includes("return _ocGlyphAvatar('&#128302;', name)"))
t('the wrapper is unconditional now that an icon always exists',
  cli.includes('<span class="oc-compact-icon">${evtIcon}</span>'))
t('the glyph avatar needs no network', !grab('function _ocGlyphAvatar(glyph, seed, hue)').includes('http'))
t('it is deterministic when no hue is given', grab('function _ocGlyphAvatar(glyph, seed, hue)').includes('h = (h * 31 + raw.charCodeAt(i)) % 360'))
t('why it exists is recorded', cli.includes('still needs a face'))

console.log(String.fromCharCode(10) + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
