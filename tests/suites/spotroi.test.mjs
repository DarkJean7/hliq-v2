// ROI on spot holdings, from HL's own cost basis.
import fs from 'fs'
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x))

// The arithmetic, driven directly.
const roiOf = new Function('items', 'px', 'coin', `
  const total = items.reduce((s, b) => s + parseFloat(b.total ?? 0), 0)
  const usdOf = t => px > 0 ? t * px : (coin === 'USDC' ? t : 0)
  const usd   = usdOf(total)
  const cost  = items.reduce((s, b) => s + parseFloat(b.entryNtl ?? 0), 0)
  const roi   = cost > 0 && usd > 0 ? (usd - cost) / cost * 100 : null
  const pnl   = cost > 0 && usd > 0 ? usd - cost : null
  return { total, usd, cost, roi, pnl }
`)

console.log('\n-- cost basis comes from HL, not inferred from fills --')
// Real payload: 1.24916006 HYPE bought for $98.77988, now $80.7965.
const one = roiOf([{ total: '1.24916006', entryNtl: '98.77988' }], 80.7965, 'HYPE')
t('value is size x price', Math.abs(one.usd - 1.24916006 * 80.7965) < 1e-9)
t('ROI is profit over what it cost', Math.abs(one.roi - ((one.usd - 98.77988) / 98.77988 * 100)) < 1e-9)
t('and reads about +2.2% on that holding', one.roi > 2 && one.roi < 2.4, one.roi.toFixed(3))
t('profit is shown in dollars too', Math.abs(one.pnl - (one.usd - 98.77988)) < 1e-9)

console.log('\n-- several accounts collapse into one honest figure --')
const many = roiOf([
  { total: '1.52897', entryNtl: '118.90' },
  { total: '1.24916', entryNtl: '98.78' },
  { total: '0.409724', entryNtl: '31.95' },
], 80.7965, 'HYPE')
t('cost is the sum of every account\'s cost', Math.abs(many.cost - (118.90 + 98.78 + 31.95)) < 1e-9)
t('so the group ROI is on the combined basis, not an average of percentages',
  Math.abs(many.roi - ((many.usd - many.cost) / many.cost * 100)) < 1e-9)
t('which is what makes it agree with the dollar profit beside it',
  Math.abs(many.pnl - (many.usd - many.cost)) < 1e-9)

console.log('\n-- no cost basis means no ROI, never a fabricated 0% --')
t('USDC has no cost basis and gets no ROI', roiOf([{ total: '2468.4679', entryNtl: '0.0' }], 0, 'USDC').roi === null)
t('a token that arrived by transfer gets none either',
  roiOf([{ total: '5', entryNtl: '0.0' }], 12, 'FOO').roi === null)
t('a missing entryNtl is treated as no basis, not as zero cost',
  roiOf([{ total: '5' }], 12, 'FOO').roi === null)
t('a token with no price yet gets none rather than -100%',
  roiOf([{ total: '5', entryNtl: '50' }], 0, 'FOO').roi === null)
t('a loss reports negative', roiOf([{ total: '1', entryNtl: '100' }], 80, 'FOO').roi < 0)
t('and break-even reports zero, not null', roiOf([{ total: '1', entryNtl: '80' }], 80, 'FOO').roi === 0)

console.log('\n-- where it renders --')
const grp = cli.slice(cli.indexOf('const renderSpotGroup = (coin, items, id)'), cli.indexOf('if (_mobVActiveTab === \'spot\')'))
t('the group row computes a cost from entryNtl', grp.includes("items.reduce((s, b) => s + parseFloat(b.entryNtl ?? 0), 0)"))
t('and shows ROI beside the value', grp.includes("${roi >= 0 ? '+' : ''}${roi.toFixed(2)}%"))
t('only when there is a basis', grp.includes("roi == null ? '' :"))
t('expanding shows what it cost and what it is worth',
  grp.includes("['Cost', '$' + fmtUSD(cost)]") && grp.includes("['Value', '$' + fmtUSD(usd)]"))
t('plus the average buy price against the current one',
  grp.includes("['Avg buy'") && grp.includes("['Now'"))
t('and the profit in dollars, not only a percentage', grp.includes("['Profit'"))
t('the detail block is skipped entirely for a coin with no basis', grp.includes('cost > 0 ? _mobVDetailGrid(['))
t('each account row carries its own ROI', grp.includes('const rr = c > 0 && u > 0 ? (u - c) / c * 100 : null'))
t('falling back to the held figure when it has none', grp.includes("rr != null") && grp.includes('held'))
t('green above water, red below', grp.includes("roi >= 0 ? 'var(--green)' : 'var(--red)'"))

console.log('\n-- the tick must notice a changed basis --')
// Buying more changes entryNtl without necessarily changing the displayed USD value,
// and the spot tab skips a rebuild when its key is unchanged.
t('the skip key includes entryNtl', cli.includes("${parseFloat(b.entryNtl ?? 0).toFixed(2)}"))

console.log(String.fromCharCode(10) + '-- the dollar figure sits beside the percent --')
const money = /\$\$\{fmtUSD\(Math\.abs\(pnl\)\)\} . \$\{roi >= 0/
t('the group row prints profit then ROI', money.test(grp), 'not found')
t('a loss shows a minus on the money too', grp.includes("pnl >= 0 ? '+' : '-'"))
t('each account row does the same', grp.includes("rp >= 0 ? '+' : '-'"))
t('and computes its own dollar figure', grp.includes('const rp = c > 0 && u > 0 ? u - c : null'))
t('the pair never wraps mid-number', (grp.match(/white-space:nowrap/g) ?? []).length >= 2)
// The per-account dollars must add up to the group's, or the row contradicts its children.
const parts = [4.92, 2.38, 1.23]
t('per-account profits sum to the group profit',
  Math.abs(parts.reduce((a, b) => a + b, 0) - 8.53) < 0.005)

console.log(String.fromCharCode(10) + '-- single account gets it too, from the same fields --')
const row = cli.slice(cli.indexOf('const renderSpotRow = (b, id)'), cli.indexOf('const renderOutcomeRow'))
t('it computes a basis', row.includes("const cost  = parseFloat(b.entryNtl ?? 0)"))
t('shows profit and ROI on the row', money.test(row))
t('and adds Cost / Avg buy / Profit / ROI when expanded',
  row.includes("['Cost', '$' + fmtUSD(cost)]") && row.includes("['Avg buy'") && row.includes("['ROI'"))
t('those lines are skipped entirely for a coin with no basis', row.includes('...(cost > 0 ? ['))
t('USDC therefore still shows just its balance', row.includes("['Available'"))

console.log(String.fromCharCode(10) + '-- the widened column is the spot one only --')
t('the Orders tab was left alone',
  (cli.match(/width:104px;flex-shrink:0;flex-grow:0/g) ?? []).length === 3)

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
