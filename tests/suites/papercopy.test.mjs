// Visiting and copying a PAPER account — "lets make paper accounts visitable, able to copy
// trade them and everything that a real account can. currently is not possible".
//
// It was not possible because a paper account trades only on its owner's device: there is no
// address to point the dashboard at, and nothing for a bot to poll. What there IS is the board
// row its owner posts. So the row grew the missing half — the account's own FILLS — and both
// features read from there:
//
//   VISIT       a read-only profile: holdings, track record, open orders, recent trades.
//   COPY TRADE  the same bot as for a wallet, with its fill feed pointed at our own server
//               instead of Hyperliquid. planMirror never learns which kind of target it is.
//
// Driven for real elsewhere: the bot followed a paper feed through an open, an add, a 50%
// reduce, a full close and a flip (0 errors), and the sheet started a follow with
// `--paper-target`.
import fs from 'fs'

const cli   = fs.readFileSync('src/main.js', 'utf8')
const srv   = fs.readFileSync('server.js', 'utf8')
const paper = fs.readFileSync('src/paper.js', 'utf8')
const bot   = fs.readFileSync('strategies/copytrade.js', 'utf8')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const grab = (s, sig) => {
  const i = s.indexOf(sig)
  if (i < 0) return ''
  let j = s.indexOf('{', i), d = 0
  for (; j < s.length; j++) { if (s[j] === '{') d++; else if (s[j] === '}') { d--; if (!d) return s.slice(i, j + 1) } }
  return ''
}

console.log(nl + '-- a paper fill says what the position was before it --')
{
  // Without this a follower cannot tell an open from a close, which is what src/copymirror.js
  // needs and what every REAL fill carries. Paper fills had none.
  t('recordFill takes it', paper.includes('function recordFill(s, { coin, px, sz, isBuy, closedPnl, dir, oid, fee = 0, startPosition = null })'))
  t('and writes it in HL’s shape (a string, or null)',
    paper.includes('startPosition: startPosition == null ? null : String(startPosition)'))
  t('a perp fill passes the position it had', paper.includes('dir: dirLabel(prevSzi, newSzi), oid, fee, startPosition: prevSzi'))
  t('a liquidation does too', (paper.match(/startPosition: p\.szi,/g) ?? []).length === 2)
  t('why is written down', paper.includes('a copy bot cannot tell an'))
}

console.log(nl + '-- the account posts its trades with its row --')
{
  const pay = grab(cli, 'function _lbPaperPayload(slot)')
  t('the payload carries fills', pay.includes('fills: (s.fills ?? []).slice(0, 40).map('))
  t('including startPosition', pay.includes('startPosition: f.startPosition ?? null'))
  t('capped, so a sync stays small', pay.includes('.slice(0, 40)'))
}

console.log(nl + '-- the server keeps them per account, not in the board file --')
{
  t('one file per account', srv.includes('const PAPER_FILL_DIR = join(LOGS_DIR, \'paper-fills\')'))
  t('capped', srv.includes('const PAPER_FILL_MAX = 200'))
  t('merged by tid, since a client re-posts its last fills every sync',
    srv.includes('const seen = new Set(have.map(f => f.tid))'))
  t('why not a field on the row is written down', srv.includes('rewritten whole'))
  const post = srv.slice(srv.indexOf("path === '/api/leaderboard/paper'", srv.indexOf('POST')), srv.indexOf('// ── POST /api/leaderboard/paper/remove'))
  t('incoming fills are re-typed field by field', post.includes("if (!/^[A-Za-z0-9:#@+._-]{1,24}$/.test(coin)) return null") && post.includes("tid, time,"))
  t('a fill with no id or no time is dropped', post.includes("if (!/^[A-Za-z0-9_-]{1,32}$/.test(tid)) return null") && post.includes('if (!time) return null'))
  // Ownership is proven by the row secret; appending to someone else's account must be
  // impossible, so the merge happens only after that check passes.
  t('fills are only merged after the secret check',
    post.indexOf('paperFillsMerge(name, fills)') > post.indexOf("error: 'that name is taken"))
  t('deleting an account deletes its trades', srv.includes('paperFillsDelete(gone)'))
}

console.log(nl + '-- one account, with its trades: the endpoint both features read --')
{
  const one = srv.slice(srv.indexOf("path === '/api/leaderboard/paper/one'"), srv.indexOf("path === '/api/leaderboard/paper/one'") + 1200)
  t('the endpoint exists', one.length > 200)
  t('it needs a name', one.includes("if (!name) return json(res, 400, { error: 'name required' })"))
  t('the secret never leaves the server', one.includes('const { secret, ...pub } = row'))
  t('a hidden account is withheld, as on the real board', one.includes('if (!row || (row.hidden && !isAdmin))'))
  t('`since` keeps a polling bot cheap', one.includes('.filter(f => f.time > since)'))
}

console.log(nl + '-- the bot follows a paper account like a wallet --')
{
  t('there is a flag for it', bot.includes("'paper-target': { type: 'string' }"))
  t('and no address is demanded then', bot.includes("if (!PAPER_TARGET && !/^0x[0-9a-fA-F]{40}$/.test(TARGET))"))
  t('nor a self-follow check that cannot apply', bot.includes('if (!PAPER_TARGET && QUERY_ADDR.toLowerCase() === TARGET.toLowerCase())'))
  const feed = grab(bot, 'async function fetchTargetFills(startTime)')
  t('a wallet still comes from Hyperliquid', feed.includes('info.userFillsByTime({ user: TARGET, startTime })'))
  t('a paper account comes from our own leaderboard', feed.includes('/api/leaderboard/paper/one?name='))
  t('asking only for what is new', feed.includes('&since=${Math.max(0, startTime - 1)}'))
  t('positions for the exit retry come from its row',
    grab(bot, 'async function fetchTargetPositions()').includes("j?.row?.positions ?? []"))
  t('the mirror logic is untouched — same shape either way', bot.includes('planMirror({') && bot.includes('burstRange(cf)'))
  t('a paper follow has its own state key', bot.includes("${PAPER_TARGET ? 'paper:' : ''}"))
  t('and the log says it is a simulated trader', bot.includes('(simulated trader)'))
}

console.log(nl + '-- the row’s three buttons all work now --')
{
  const soc = grab(cli, 'function _lbPaperSocialHtml(r)')
  t('Visit opens your own account', soc.includes("window.__goPaper('${esc(r._slot)}')"))
  t('and anyone else’s profile', soc.includes('window.__paperVisit(decodeURIComponent('))
  t('Copy trade really starts a follow', soc.includes("window.__lbCopyTrade('', decodeURIComponent('${enc}'), { paper: decodeURIComponent('${enc}') })"))
  t('behind the same paywall as a wallet copy', soc.includes('_stratsUnlocked()') && soc.includes('__subOpenPaywall()'))
  t('the "nothing to copy" message is gone', !soc.includes('there is nothing to copy'))
}

console.log(nl + '-- the profile is built from the same renderers a real row uses --')
{
  const v = grab(cli, 'window.__paperVisit = async function(name)')
  t('it reads the one-account endpoint', v.includes("fetch('/api/leaderboard/paper/one?name='"))
  t('a missing account says so instead of hanging', v.includes('no longer on the board'))
  t('the track record is the same block', v.includes('_lbTrackHtml(asRow)'))
  t('positions and orders are the same sub-rows', v.includes('_mobVSubPosRow(ap,') && v.includes('_mobVSubOrdRow(o,'))
  t('recent trades are listed', v.includes("_T('Recent trades'"))
  t('its own close button, not the tab’s', v.includes('window.__paperVisitClose()') && !v.includes('_mobVFullHeader('))
  t('and it says the figures are unverifiable', v.includes('not verified by anyone'))
}

console.log(nl + '-- the copy sheet takes a paper trader --')
{
  // Not grab(): the signature's own `opts = {}` closes the brace scan immediately.
  const _si = cli.indexOf("window.__lbCopyTrade = function(addr = '', name = '', opts = {})")
  const sh  = cli.slice(_si, cli.indexOf(nl + 'function _mobVBuildLbHtml', _si))
  t('the target can be a paper name', sh.includes("const paperName = String(opts.paper ?? '').trim()"))
  t('the address field is replaced by the account it will follow', sh.includes("_T('Paper trader', 'Trader de papel')"))
  t('address validation is skipped for it', sh.includes("if (!paperName && !/^0x[0-9a-fA-F]{40}$/.test(to))"))
  t('the bot gets --paper-target', sh.includes("...(paperName ? ['--paper-target', paperName] : ['--target', to])"))
  t('its instance cannot collide with a wallet’s', sh.includes("const base = paperName ? 'P:' + paperName : to"))
  t('and the sheet says the trader is simulated while your orders are not',
    sh.includes('This trader is on paper') && sh.includes('your orders are real'))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
