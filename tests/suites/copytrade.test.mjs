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

// ── The mirror arithmetic lives in copymirror.test.mjs now ──
// This suite used to re-implement "apply scale% of every signed delta" in its own arithmetic
// and assert that. Those assertions passed and described the rule that lost money: it opened
// a short when the target closed a position we never copied, and under the per-trade cap a
// partial close emptied us while a full close left most of the copy open. The rules moved to
// src/copymirror.js, and copymirror.test.mjs runs the REAL planner for every case that used
// to be simulated here — opens, adds, trims, closes, flips, the $10 minimum and both caps.
// What stays here is the bot's wiring.
console.log('\n── the bot uses the shared planner ──')
t('orders come from planMirror', bot.includes('planMirror({'))
t('the carry is whatever the plan left', bot.includes('carry[coin] = plan.carry'))
t('reduce-only comes from the plan, per order', bot.includes('r: reduceOnly,'))
t('a netted zero places nothing', bot.includes('if (Math.abs(theirDelta) < 1e-12) continue'))
// Changed on purpose: a missed OPEN used to be carried and retried. Buying it on a later poll
// is buying at a price the trader never paid, so it is now let go. A missed EXIT is the one
// that must not be dropped, and is retried until the copy is flat or they re-enter.
t('a missed open is let go, not chased', bot.includes('open skipped'))
t('a missed exit is retried', bot.includes('pendingExit[coin] = true') && bot.includes('await retryExits()'))

console.log('\n── identity: the one thing that must not double-fire ──')
// HL returns hash=0x0…0 on many fills, so hashes cannot identify a fill.
t('fills are deduped on tid', bot.includes('seen.has(f.tid)') && bot.includes('seen.add(f.tid)'))
t('never on hash', !/\.hash/.test(bot))
t('the re-ask window overlaps, because HL can surface a fill late',
  bot.includes('fetchTargetFills(cursor - 60_000)') && bot.includes('info.userFillsByTime({ user: TARGET, startTime })'))
t('the seen set is bounded, or it grows for as long as the bot runs',
  bot.includes('if (seen.size > 4000)'))
t('fills are applied oldest-first', bot.includes('.sort((a, b) => a.time - b.time)'))

console.log('\n── what it refuses to do ──')
t('history is NOT replayed — following someone does not buy their whole book',
  bot.includes('cursor = Date.now()') && bot.includes('Past trades are not copied'))
// The one exception, and it is bounded: a restart within minutes picks up where it stopped,
// so a deploy does not skip trades. Stopping and starting tomorrow still starts from now.
t('only a recent restart resumes the cursor',
  bot.includes('const RESUME_WINDOW_MS = 15 * 60 * 1000') && bot.includes('Date.now() - (saved.ts ?? 0) < RESUME_WINDOW_MS'))
t('a wallet cannot follow itself', bot.includes('A wallet cannot follow itself'))
// A wallet target must be an address. A paper account is named instead — it has none — and
// the check knows the difference.
t('the target must be an address', bot.includes("if (!PAPER_TARGET && !/^0x[0-9a-fA-F]{40}$/.test(TARGET))"))
t('or a paper account by name',
  bot.includes("'paper-target': { type: 'string' }") && bot.includes('/api/leaderboard/paper/one?name='))
t('a 0% scale is refused rather than running forever doing nothing',
  bot.includes('Scale is 0% — nothing would ever be mirrored'))
t('spot and builder-dex fills are skipped, not guessed at',
  bot.includes('not a main-dex perp'))
t('the coin allowlist is honoured', bot.includes('if (ONLY.size && !ONLY.has(coin)) continue'))
t('leverage is left alone when 0, rather than forced to 1x',
  bot.includes('LEVERAGE > 0 && !levelled.has(coin)'))
t('and never touched for an exit', bot.includes('if (!o.reduceOnly && LEVERAGE > 0'))
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
// The paper board used to get no action row at all. Asked to be "exactly the same as the
// real", it now gets the same three buttons — but never the WALLET actions: a paper row has
// no wallet, so its row is built by _lbPaperSocialHtml, which cannot start a copy trade.
t('the paper board never gets the wallet action row',
  cli.includes('expandHtml += opts.paper ? _lbPaperSocialHtml(r) : _lbSocialHtml(r)'))
// It CAN be copied now: the owner's device posts that account's fills with its board row, and
// the bot reads them from our own server. Asked for: "able to copy trade them".
t('and its Copy trade starts a real follow of that paper account',
  grab(cli, 'function _lbPaperSocialHtml(r)').includes('{ paper: decodeURIComponent(')
    && bot.includes("const PAPER_TARGET = String(args['paper-target'] ?? '').trim()"))

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
// Sliced, not brace-matched: the signature's own `opts = {}` ends a brace scan immediately.
const _shI  = cli.indexOf("window.__lbCopyTrade = function(addr = '', name = '', opts = {})")
const sheet = cli.slice(_shI, cli.indexOf('\nfunction _mobVBuildLbHtml', _shI))
t('it refuses a non-address', sheet.includes("if (!paperName && !/^0x[0-9a-fA-F]{40}$/.test(to))"))
t('it refuses following yourself before the server has to', sheet.includes('it cannot follow itself'))
t('it refuses without an agent key rather than failing at the server',
  sheet.includes('has no agent key saved'))
t('in the combined view it asks WHICH of your accounts copies',
  sheet.includes('Pick which of your accounts should do the copying first'))
t('it signs with that account\'s key, not whichever connected last',
  sheet.includes('const key    = _stratTargetKey()') && sheet.includes('agentKey: key'))
// A dry run gets its own instance so it can shadow a live copy of the same trader.
// The instance is the wallet address, or "P:<name>" for a paper account — so a follow of each
// kind, live or dry, is four distinct bots that cannot collide.
t('the target is the instance, so you can follow several traders at once',
  sheet.includes("const base = paperName ? 'P:' + paperName : to") && sheet.includes('address: tgt, instance }'))
t('a 402 opens the paywall instead of showing a raw error',
  sheet.includes('if (r.subscribe) { close(); window.__subOpenPaywall?.(); return }'))
t('it warns that this is real money on a stranger\'s judgement',
  sheet.includes('real orders with real money'))
t('and hides that warning only for a dry run, which places nothing',
  sheet.includes("ov.querySelector('#ct-warn').style.display = d ? 'none' : ''"))
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
