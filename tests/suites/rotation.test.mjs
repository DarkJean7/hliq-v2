// Turning the phone sideways must not change the money.
//
// Reported from a phone: All Accounts showed $5,667.74 in landscape and $5,574.29 in portrait,
// seconds apart. Crossing the breakpoint swaps the mobile shell for the desktop one, and the
// two were computing the headline from DIFFERENT SOURCES:
//
//   mobile   _combinedServerValue() ?? _combinedHeldValue(), then the spike filter
//   desktop  liveAccountValue(portfolio, perpState.marginSummary.accountValue, spotUSDC)
//
// The second is the per-device sum. comboequity.js and the mobile headline had both already
// discarded it as a third basis -- the mobile call site still carries the measurement that
// got it removed (+$201.37 up and straight back, "almost exactly the spot HYPE"). The desktop
// overview never knew the combined view existed: it sums perpState as though it were one
// account. So the fix is that it no longer computes the number at all when one is handed in.
//
// The change PILL was a separate confusion with the same symptom: the range defaults to a
// week, so the desktop pill showed the week while the caption under it said "today".
import fs from 'fs'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const CLI = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const RND = fs.readFileSync('src/render.js', 'utf8').replace(/\r\n/g, '\n')

console.log(nl + '-- both shells read one figure --')
// `allMids = {}` sits in the same parameter list, so a [^}] scan stops short of the end.
t('renderOverview accepts a combined value', /export function renderOverview\(\{[\s\S]{0,500}?comboValue = null/.test(RND))
t('and prefers it over its own sum', /comboValue > 0 \? comboValue : _localAcctVal/.test(RND))
// The old expression must not survive as the thing actually rendered.
// computeAcctStats still computes it and should: its callers override the value in the
// combined view. What must not survive is a RENDERER publishing it unconditionally.
const bodyOf = (sig) => { const i = RND.indexOf(sig); return i < 0 ? '' : RND.slice(i, i + 2000) }
t('neither renderer publishes the local sum unconditionally',
  !/const accountValue\s*=\s*liveAccountValue\(/.test(bodyOf('export function renderOverview(')) &&
  !/const accountValue\s*=\s*liveAccountValue\(/.test(bodyOf('export function renderPortfolioStats(')))
// computeAcctStats keeps computing it, and should: its callers decide whether to override it
// in the combined view, and the mobile headline has done exactly that all along.
t('computeAcctStats is left alone, because its callers already override it',
  /const accountValue\s*=\s*liveAccountValue\(/.test(bodyOf('export function computeAcctStats(')))
t('and the portfolio tab takes the same figure',
  /renderPortfolioStats\(\{[\s\S]{0,300}?comboValue = null/.test(RND) &&
  /renderPortfolioStats\(\{[^)]*comboValue, comboPending \}\)/.test(CLI))
// Once per render: the filter and the re-anchor are stateful. The mobile call passes the
// server value it has already asked for (_comboDisplayEquity(_srvVal)) for the same reason.
t('computed once per render, because the filter is stateful',
  /const comboValue = _comboDisplayEquity\(\)/.test(CLI) &&
  (CLI.match(/_comboDisplayEquity\((\)|_srvVal\))/g) || []).length === 2)
t('the desktop call site hands it over', /renderOverview\(\{[^)]*comboValue, comboPending \}\)/.test(CLI))

console.log(nl + '-- and that figure is the mobile one, not a second opinion --')
// Start from the doc comment, not the keyword: the reasoning lives above the signature.
const fn = CLI.slice(CLI.indexOf('The combined figure BOTH shells show'), CLI.indexOf('function _comboEqFilter'))
t('there is such a function', fn.length > 0)
t('it is null outside the combined view', fn.includes('if (!state.isAllAccounts) return null'))
t('same chain as the mobile headline', fn.includes('_combinedServerValue()) ?? _combinedHeldValue()'))
t('and the same spike filter', fn.includes('_comboEqFilter(raw)'))
// Sharing the filter's state is the point, not an oversight: a rotation must not hand the
// first reading on the other side a free pass.
t('sharing the filter state is written down as deliberate', fn.includes('SHOULD carry across a rotation'))

console.log(nl + '-- the caption names the period the pill is measuring --')
t('the period default really is a week, which is why this matters',
  /let _ovPeriod = 'week'/.test(RND))
t('there is a label per period', /_OV_PERIOD_LABEL = \{[^}]*day: 'today'[^}]*week: 'this week'/.test(RND))
t('the caption uses it instead of a hardcoded word',
  /ov-eq-sub[^`]*_OV_PERIOD_LABEL\[_ovPeriod\]/.test(RND))
t('no hardcoded "· today" is left in that caption',
  !/cross \+ isolated · today</.test(RND))
// __ovSetRange repaints the pill WITHOUT a full re-render, which is how the caption went stale.
const setRange = RND.slice(RND.indexOf('window.__ovSetRange = function'), RND.indexOf('// Outcome (prediction) holdings'))
t('switching range updates the caption too', setRange.includes('ovEqSub'))
t('and the caption has an id to be updated by', RND.includes('id="ovEqSub"'))

console.log(nl + '-- and neither shell prints a total that is missing a wallet --')
// Both combined sources filter an errored row out and then find the count no longer matches
// the snapshot, so both return null the moment a wallet fails. The local sum left behind is
// SHORT BY THAT WALLET. Mobile has always shown loading dots there; desktop used to print the
// short sum, so rotating turned an honest dash into a wrong number.
t('the caller tells the renderers when it has nothing trustworthy',
  /const comboPending = state\.isAllAccounts && comboValue == null/.test(CLI))
t('and passes it to both', (CLI.match(/comboValue, comboPending \}\)/g) || []).length === 2)
t('both renderers accept it',
  /renderOverview\(\{[\s\S]{0,600}?comboPending = false/.test(RND) &&
  /renderPortfolioStats\(\{[\s\S]{0,400}?comboPending = false/.test(RND))
t('the printed figure goes through the guard', (RND.match(/comboPending \? '—' :/g) || []).length === 2)
// Every place the value reaches the screen must use it, including _ovHead, which is what
// _ovPaintHead repaints the hero from on a chart-mode switch.
t('no renderer still prints the raw value',
  !/value: '\$' \+ fmtUSD\(accountValue\),/.test(RND) &&
  !/ov-eq-val">\$\$\{fmtUSD\(accountValue\)\}/.test(RND))
t('the live repaint follows it too', /_ovHead = \{[\s\S]{0,200}?value: acctValStr/.test(RND))
t('why the old fallback was wrong is written down', RND.includes('is what this used to say, and it was'))

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
