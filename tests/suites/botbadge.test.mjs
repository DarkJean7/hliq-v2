// "Which bot is running on this position?" answered on the card itself.
//
// The trap is the combined view. Four wallets can hold the same coin while a bot runs on
// ONE of them, so a badge drawn from whichever account happens to be selected would put a
// green dot on three positions nothing is managing — which is worse than no badge, because
// it would be believed.
import fs from 'fs'
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const grab = (s, sig) => {
  const i = s.indexOf(sig); if (i < 0) return ''
  let j = s.indexOf('{', i), d = 0
  for (; j < s.length; j++) { if (s[j] === '{') d++; else if (s[j] === '}') { d--; if (!d) return s.slice(i, j + 1) } }
  return ''
}
const fn = grab(cli, 'function _botsOnCoin')

// The real function, lifted out and given the two globals it reads.
const mk = (status, maStatus) => new Function('serverStatus', '_maBotStatus', `${fn}\n return _botsOnCoin`)(status, maStatus)

console.log(nl + '-- the account decides, not the selection --')
const ma = {
  '0xaaa': ['grid:HYPE', 'trend:BTC', 'liqguard:HYPE', 'dca'],
  '0xbbb': ['grid:SOL'],
}
const f = mk({ _instances: { 'grid:ETH': true } }, ma)
t('a bot on this coin, for this account, is found', f('HYPE', '0xaaa').includes('grid'))
t('another account holding the same coin gets nothing', f('HYPE', '0xbbb').length === 0)
t('an account with no row at all gets nothing', f('HYPE', '0xzzz').length === 0)
t('the address is matched case-insensitively', f('HYPE', '0xAAA').includes('grid'))
t('a bot on a different coin is not claimed', !f('BTC', '0xbbb').includes('trend'))
t('the selected account is NOT consulted for an owned position',
  !f('ETH', '0xaaa').includes('grid'), JSON.stringify(f('ETH', '0xaaa')))
t('why the account matters is recorded', cli.includes('nothing is managing'))

console.log(nl + '-- a position with no owner falls back to the selected account --')
t('single-account view reads serverStatus', mk({ _instances: { 'grid:ETH': true } }, {})('ETH', null).includes('grid'))
t('and only its own coins', mk({ _instances: { 'grid:ETH': true } }, {})('HYPE', null).length === 0)

console.log(nl + '-- what counts as "on this coin" --')
t('a HIP-3 instance matches its market',
  mk({ _instances: { 'grid:xyz:SPCX': true } }, {})('xyz:SPCX', null).includes('grid'))
t('and matches when the position names it bare',
  mk({ _instances: { 'grid:xyz:SPCX': true } }, {})('SPCX', null).includes('grid'))
t('case does not matter', mk({ _instances: { 'grid:hype': true } }, {})('HYPE', null).includes('grid'))
t('a partial name does not match',
  mk({ _instances: { 'grid:HYPER': true } }, {})('HYPE', null).length === 0)
t('an empty coin matches nothing', mk({ _instances: { 'grid:HYPE': true } }, {})('', null).length === 0)
t('duplicates collapse to one badge',
  mk({ _instances: { 'grid:HYPE': true, 'grid:hype': true } }, {})('HYPE', null).length === 1)

console.log(nl + '-- a bot whose market is only in its arguments --')
// Paper bots have no _instances at all: checkServer synthesises _configs['grid:'] with
// --coin. Without reading that, a paper bot never badged its own position.
const paper = mk({ _configs: { 'grid:': { args: ['--coin', 'HYPE'] } } }, {})
t('a paper bot badges its coin', paper('HYPE', null).includes('grid'))
t('and not another', paper('SOL', null).length === 0)
t('args are only read for the account being viewed',
  mk({ _configs: { 'grid:': { args: ['--coin', 'HYPE'] } } }, ma)('HYPE', '0xbbb').length === 0)
t('a config with no --coin claims nothing',
  mk({ _configs: { 'dca:': { args: ['--size', '10'] } } }, {})('HYPE', null).length === 0)
t('nor does one with the flag and no value',
  mk({ _configs: { 'dca:': { args: ['--coin'] } } }, {})('HYPE', null).length === 0)
t('why paper needed this is recorded', cli.includes('never badges its own'))

console.log(nl + '-- a bot that cannot be tied to a coin is not guessed at --')
t('an entry with no instance and no args is skipped',
  mk({ _instances: { 'dca:': true } }, {})('HYPE', null).length === 0)
t('and one with no colon at all', mk({}, { '0xaaa': ['dca'] })('HYPE', '0xaaa').length === 0)
t('why guessing is refused is recorded', cli.includes('right by luck is worse than no badge'))

console.log(nl + '-- nothing throws on missing state --')
t('no status at all', mk(undefined, undefined)('HYPE', null).length === 0)
t('null coin', mk({ _instances: { 'grid:HYPE': true } }, {})(null, null).length === 0)
t('a junk instances map', mk({ _instances: {} }, {})('HYPE', null).length === 0)

console.log(nl + '-- the badge --')
const badge = grab(cli, 'function _botBadgeHtml')
t('there is one', badge.length > 100)
t('guards are left out — they have their own row',
  badge.includes("t !== 'liqguard' && t !== 'levbrake'"))
t('nothing renders when nothing runs', badge.includes("if (!types.length) return ''"))
t('it shows the bot name, not the slug', badge.includes('_BOT_LABELS[t] ?? t'))
t('the label map is shared, not a second copy',
  cli.includes('const _BOT_LABELS = {') && cli.includes('const labels = _BOT_LABELS'))
t('the name is escaped', badge.includes('esc(_BOT_LABELS[t] ?? t)'))
t('and marked notranslate, being a product name', badge.includes('class="notranslate"'))
t('it is on the position card', cli.includes('_botBadgeHtml(p.coin, p._acctAddr, true)'))
t('and sits on the same row as the account name',
  cli.includes('Account name and running-bot badge share one row'))
t('the inline form drops the margin that would start a new line',
  grab(cli, 'function _botBadgeHtml').includes("inline ? '' : ';margin-top:4px'"))
t('a long account name truncates instead of pushing the badge off',
  cli.includes('eats its own ellipsis rather than pushing the badge off'))
t('the badge does not shrink', grab(cli, 'function _botBadgeHtml').includes('flex-shrink:0'))
t('the row is skipped entirely when there is neither', cli.includes('if (!p._acct && !_bb)'))

console.log(nl + '-- the grouped card counts them --')
// Four wallets holding a coin with one grid bot running is "Grid Bot 1/4". Plain
// "Grid Bot" would read as all four being managed.
const group = grab(cli, 'function _botBadgeGroupHtml')
t('there is a group badge', group.length > 100)
t('it counts across the members', group.includes('counts.set(t, (counts.get(t) ?? 0) + 1)'))
t('and shows the count only when it is not all of them', group.includes('${c < n ? ` ${c}/${n}` : \'\'}'))
t('why the bare label would mislead is recorded', cli.includes('reads as all four being managed'))
t('the member cards carry their address so the group can ask per account',
  cli.includes('acctAddr: p._acctAddr ?? null'))
t('it is on the grouped card', cli.includes('${_botBadgeGroupHtml(coin, members)}'))

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
