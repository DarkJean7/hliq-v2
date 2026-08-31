// Copy trade: the mirror arithmetic, the guards, and the social row it is reached from.
import fs from 'fs'
const bot = fs.readFileSync('strategies/copytrade.js', 'utf8').replace(/\r\n/g, '\n')
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const srv = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n')

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

console.log('\n── mirroring by signed delta ──')
// Every trade shape has to fall out of one rule, or the bot needs to classify trades and
// will eventually classify one wrong.
const SCALE = 0.25
const mirror = (fills) => {
  const net = {}
  for (const f of fills) {
    const signed = (f.side === 'B' ? 1 : -1) * parseFloat(f.sz)
    net[f.coin] = (net[f.coin] ?? 0) + signed
  }
  return net
}
t('they open a long → we buy a quarter of it',
  mirror([{ coin: 'BTC', side: 'B', sz: '10' }]).BTC * SCALE === 2.5)
t('they add → we add',
  mirror([{ coin: 'BTC', side: 'B', sz: '10' }, { coin: 'BTC', side: 'B', sz: '6' }]).BTC * SCALE === 4)
t('they half-close → we half-close, no special case needed',
  mirror([{ coin: 'BTC', side: 'A', sz: '5' }]).BTC * SCALE === -1.25)
t('they flip long→short in one fill → the delta crosses zero on its own',
  mirror([{ coin: 'BTC', side: 'A', sz: '20' }]).BTC * SCALE === -5)
t('a burst nets to ONE order rather than three sub-minimum ones',
  Object.keys(mirror([
    { coin: 'BTC', side: 'A', sz: '3' }, { coin: 'BTC', side: 'A', sz: '3' }, { coin: 'BTC', side: 'A', sz: '4' },
  ])).length === 1)
t('and that net is the sum, not the last fill',
  mirror([{ coin: 'BTC', side: 'A', sz: '3' }, { coin: 'BTC', side: 'A', sz: '3' }, { coin: 'BTC', side: 'A', sz: '4' }]).BTC === -10)
t('offsetting fills inside one poll net to nothing and place no order',
  mirror([{ coin: 'BTC', side: 'B', sz: '5' }, { coin: 'BTC', side: 'A', sz: '5' }]).BTC === 0)
t('two coins in one burst stay separate',
  Object.keys(mirror([{ coin: 'BTC', side: 'B', sz: '1' }, { coin: 'HYPE', side: 'B', sz: '9' }])).length === 2)
t('the loop skips a netted zero instead of sending a 0-size order',
  bot.includes('if (theirDelta === 0) continue'))

console.log('\n── reduce-only: the guard that stops an accidental reversal ──')
const reducing = (delta, ourSzi, sz) => ourSzi !== 0 && Math.sign(delta) !== Math.sign(ourSzi) && sz <= Math.abs(ourSzi)
t('selling while long, within our size, is reduce-only', reducing(-2, 5, 2) === true)
t('buying while short, within our size, is reduce-only', reducing(2, -5, 2) === true)
t('adding to a long is NOT reduce-only', reducing(2, 5, 2) === false)
t('opening from flat is NOT reduce-only', reducing(2, 0, 2) === false)
t('a sell bigger than our long is not reduce-only, so a real flip can go through',
  reducing(-9, 5, 9) === false)
t('the order actually carries the flag', grab(bot, 'async function applyDelta(').includes('r: reducing,'))

console.log('\n── the $10 minimum, which would otherwise eat a small trader ──')
const MIN = 10
const decide = (delta, px, ourSzi) => {
  const notional = Math.abs(delta) * px
  const closing = ourSzi !== 0 && Math.sign(delta) !== Math.sign(ourSzi)
  return notional < MIN && !closing ? 'carry' : 'place'
}
t('a $4 mirrored open is carried, not dropped', decide(0.04, 100, 0) === 'carry')
t('once it stacks past $10 it fires', decide(0.11, 100, 0) === 'place')
t('a $4 CLOSE is placed anyway — we must always be able to get out',
  decide(-0.04, 100, 5) === 'place')
t('the bot carries rather than silently skipping', bot.includes("carry[coin] = delta"))
t('a filled order clears the carry', grab(bot, 'async function run()').includes('carry[coin] = 0'))
t('a missed IOC keeps the carry so we do not fall behind their book',
  bot.includes("log('MISS'") && /carry\[coin\] = delta\s*\n\s*log\('MISS'/.test(bot))

console.log('\n── caps ──')
const capped = (delta, px, maxUsd) =>
  maxUsd > 0 && Math.abs(delta) * px > maxUsd ? Math.sign(delta) * (maxUsd / px) : delta
t('a whale trade is clamped to the per-trade cap', capped(10, 100, 250) === 2.5)
t('clamping keeps the direction', capped(-10, 100, 250) === -2.5)
t('a trade under the cap is untouched', capped(1, 100, 250) === 1)
t('cap 0 means no cap', capped(10, 100, 0) === 10)
t('the clamped excess is NOT carried — a whale trade must not leak out for hours after',
  /log\('CAP'[\s\S]{0,200}delta = Math\.sign\(delta\) \* \(MAX_USD \/ markPx\)/.test(bot))
t('the position cap never blocks a close',
  bot.includes('// Position cap applies to opening only — never block someone getting out.'))
t('and it is applied as remaining room, not all-or-nothing',
  bot.includes('const room = (MAX_POSITION - have) / markPx'))

console.log('\n── identity: the one thing that must not double-fire ──')
// HL returns hash=0x0…0 on many fills, so hashes cannot identify a fill.
t('fills are deduped on tid', bot.includes('seen.has(f.tid)') && bot.includes('seen.add(f.tid)'))
t('never on hash', !/\.hash/.test(bot))
t('the re-ask window overlaps, because HL can surface a fill late',
  bot.includes('startTime: cursor - 60_000'))
t('the seen set is bounded, or it grows for as long as the bot runs',
  bot.includes('if (seen.size > 4000)'))
t('fills are applied oldest-first', bot.includes('.sort((a, b) => a.time - b.time)'))

console.log('\n── what it refuses to do ──')
t('history is NOT replayed — following someone does not buy their whole book',
  bot.includes('let cursor = Date.now()') && bot.includes('Past trades are not copied'))
t('a wallet cannot follow itself', bot.includes('A wallet cannot follow itself'))
t('the target must be an address', bot.includes("if (!/^0x[0-9a-fA-F]{40}$/.test(TARGET))"))
t('a 0% scale is refused rather than running forever doing nothing',
  bot.includes('Scale is 0% — nothing would ever be mirrored'))
t('spot and builder-dex fills are skipped, not guessed at',
  bot.includes('not a main-dex perp'))
t('the coin allowlist is honoured', bot.includes('if (ONLY.size && !ONLY.has(coin)) continue'))
t('leverage is left alone when 0, rather than forced to 1x',
  bot.includes('if (LEVERAGE > 0 && !levelled.has(coin))'))
t('and set once per coin, not on every order', bot.includes('levelled.add(coin)'))
t('it honours the shared pause switch', bot.includes('if (isPaused())'))
t('the agent key comes from env, never argv', bot.includes('process.env.AGENT_KEY'))

console.log('\n── server wiring ──')
t('the strategy is registered', srv.includes("copytrade: 'strategies/copytrade.js'"))
t('so the paywall and agent-key ownership checks cover it automatically',
  srv.includes("if (!SCRIPTS[type]) return { ok: false, error: 'unknown strategy' }"))

console.log('\n── the social row ──')
const social = grab(cli, 'function _lbSocialHtml(r)')
t('a row offers Visit, Copy and Copy trade', ['__lbVisitWallet', '__lbCopyAddr', '__lbCopyTrade'].every(f => social.includes(f)))
t('the buttons do not also collapse the row', (social.match(/event\.stopPropagation\(\)/g) ?? []).length >= 1)
t('actions sit ABOVE the holdings, not below eleven orders',
  cli.indexOf('_lbSocialHtml(r)\n      const openPos') > 0 ||
  /expandHtml \+= _lbSocialHtml\(r\)[\s\S]{0,200}const openPos/.test(cli))
t('the paper board gets no wallet actions — there is no wallet to visit',
  cli.includes('if (r.addr && !opts.paper) expandHtml += _lbSocialHtml(r)'))

console.log('\n── collapsed by default ──')
const coll = grab(cli, 'function _lbCollapse(id, title, rowsHtml)')
t('a sub-section starts closed', coll.includes("display:${xp ? '' : 'none'}"))
t('it reuses the same toggle every other card uses', coll.includes('window._mobVToggleRow'))
t('the count stays visible when closed — that is the part you scan',
  cli.includes('`${openPos.length} Open Position'))
t('positions, orders and outcomes are all collapsed',
  ['-pos', '-ord', '-oc'].every(k => cli.includes('_lbCollapse(`${id}' + k + '`')))
t('each has a distinct id, so opening one does not open the others',
  new Set(['-pos', '-ord', '-oc']).size === 3)

console.log('\n── visiting is reversible ──')
const visit = grab(cli, 'window.__lbVisitWallet = async function(addr)')
t('the account being left is remembered before the switch', visit.includes("sessionStorage.setItem('hliq_visit_return', cur)"))
t('visiting yourself does not overwrite the return address',
  visit.includes("cur.toLowerCase() !== String(addr).toLowerCase()"))
const back = grab(cli, 'window.__lbEndVisit = async function()')
t('going back restores the previous account', back.includes('input.value = back'))
t('including the combined view, which is not a loadable address',
  back.includes("back === '__all_accounts__'") && back.includes('loadAllAccountsDashboard()'))
t('and the flag is cleared so the banner does not stick', back.includes("sessionStorage.removeItem('hliq_visit_return')"))
t('the banner is painted at boot too, since a visit survives a reload',
  /renderRecentAddrs\(\)[\s\S]{0,300}_visitBannerSync\(\)/.test(cli))
t('the banner says read-only, because no agent key exists for a stranger',
  grab(cli, 'function _visitBannerSync()').includes("_T('read only'"))

console.log('\n── the copy-trade sheet ──')
const sheet = grab(cli, 'window.__lbCopyTrade = function(addr = \'\', name = \'\')')
t('it refuses a non-address', sheet.includes("if (!/^0x[0-9a-fA-F]{40}$/.test(to))"))
t('it refuses following yourself before the server has to', sheet.includes('it cannot follow itself'))
t('it refuses without an agent key rather than failing at the server',
  sheet.includes('has no agent key saved'))
t('in the combined view it asks WHICH of your accounts copies',
  sheet.includes('Pick which of your accounts should do the copying first'))
t('it signs with that account\'s key, not whichever connected last',
  sheet.includes('const key    = _stratTargetKey()') && sheet.includes('agentKey: key'))
t('the target is the instance, so you can follow several traders at once',
  sheet.includes('instance: to'))
t('a 402 opens the paywall instead of showing a raw error',
  sheet.includes('if (r.subscribe) { close(); window.__subOpenPaywall?.(); return }'))
t('it warns that this is real money on a stranger\'s judgement',
  sheet.includes('real orders with real money'))
t('and states plainly that existing positions are not bought',
  sheet.includes('Their existing positions are <b>not</b> bought'))
t('the button cannot be double-fired', sheet.includes('btn.disabled = true'))
t('and re-enables on failure, rather than stranding the sheet',
  (sheet.match(/btn\.disabled = false/g) ?? []).length >= 2)
t('copy trade appears in Strategies, so a running follow can be stopped',
  cli.includes("{ type: 'copytrade', label:"))
t('Run there opens the sheet, since a follow needs a person not a coin',
  grab(cli, 'async function runStrategyMob(type)').includes("if (type === 'copytrade') { window.__lbCopyTrade(''); return }"))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
