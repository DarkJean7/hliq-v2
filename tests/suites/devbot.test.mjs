// Device bots: a file the user wrote, running in this browser.
//
// The security claim this rests on is narrow and worth stating exactly: a Web Worker has
// no localStorage, so a bot file cannot read the agent private key that every saved wallet
// keeps there. It cannot sign. It can only post an intent back, and the main thread decides.
// Verified live in the browser, not just asserted here: `typeof localStorage` inside a
// worker is "undefined".
import fs from 'fs'
const bot = fs.readFileSync('src/devicebot.js', 'utf8').replace(/\r\n/g, '\n')
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const grab = (src, sig) => {
  const i = src.indexOf(sig); if (i < 0) return ''
  let j = src.indexOf('{', i), d = 0
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (!d) return src.slice(i, j + 1) } }
  return ''
}

console.log(String.fromCharCode(10) + '-- the key never enters the bot --')
t('the bot runs in a Worker, not the page', bot.includes('new Worker(url)'))
t('the code is never eval-ed in the main thread', !/\beval\(/.test(cli.slice(cli.indexOf('DEVICE BOTS: the glue'))))
t('the worker is built from a blob', bot.includes("new Blob([RUNNER], { type: 'text/javascript' })"))
t('and the blob url is released', bot.includes('URL.revokeObjectURL(url)'))
t('why a worker and not eval is written down', bot.includes('WHY A WORKER, AND NOT JUST eval()'))
t('the actual threat is named, not hand-waved', bot.includes('paste a file from Discord'))
t('and what the box does NOT stop is stated too', bot.includes('WHAT THE BOX DOES NOT STOP'))
t('the fetch caveat is honest', bot.includes('A Worker can still call fetch()'))
t('the install screen repeats it rather than burying it',
  cli.includes('to any server it likes') && cli.includes('cannot</b> read your private key'))

console.log(String.fromCharCode(10) + '-- what a bot is allowed to see --')
const snap = grab(cli, 'function _devBotSnapshot(def, bot)')
t('one market only', snap.includes('const coin = def.coin'))
t('its own position', snap.includes('position: pos ?'))
t('its own resting orders', snap.includes("openOrders: (state.openOrders ?? []).filter(o => o.coin === coin)"))
t('equity and candles', snap.includes('equity:') && snap.includes('candles:'))
// The absences matter more than the presences here.
// Word-bounded: the snapshot's own comment says "the wallet address is not here", and a
// loose /addr/ would match that comment and pass for the wrong reason.
t('NOT the wallet address', !/\baddr\b/i.test(snap))
t('NOT the agent key', !/agentKey|privateKey/i.test(snap))
// Superseded by design: it now DOES carry every position and order, so a bot can manage
// more than one market. What stays out is anything that could sign or identify the wallet.
t('NOT the spot balances', !snap.includes('spotState'))
t('the narrowness is explained', cli.includes('It is not\n// handed the wallet address'))

console.log(String.fromCharCode(10) + '-- the limits live where the bot cannot reach them --')
const check = grab(bot, '_check(it, ctx)')
t('per-order value is capped', check.includes('usd > this.def.maxUsd'))
t('orders per minute are capped', check.includes('this.rateBlocked()'))
t('resting orders are capped', check.includes('cap > 0 && resting >= cap'))
t('an unknown intent type is refused', check.includes('unknown intent'))
t('a limit order must carry a real price', check.includes('limit order needs a positive px'))
// Reducing risk should never be blocked by a throughput cap.
t('cancel and close are never rate-limited', check.includes("if (type === 'cancel' || type === 'close') return null"))
t('why that exemption exists is stated', check.includes('reducing risk is never capped'))
t('a refused intent is dropped, not queued', bot.includes('never queued'))
// Was a flat ten. A bot on fifteen markets can legitimately want a close and an open in
// each at a shared window boundary, and the eleventh onwards used to vanish unannounced.
t('a tick is capped at two intents per market, never under ten',
  bot.includes('Math.max(10, DeviceBot.coinsOf(this.def).length * 2)') && bot.includes('intents.slice(0, perTick)'))
t('and going over is reported rather than silently truncated', bot.includes('only the first'))

// Drive the limit logic directly.
const mkBot = (def) => {
  const B = new Function('def', `
    ${grab(bot, 'class DeviceBot')}
    const b = new DeviceBot(def, {})
    return b`)
  return B(def)
}
// A market is required: the list is checked before the caps, and a definition with no
// markets is a bot that may trade nothing. These cases are about the caps.
const b1 = mkBot({ coin: 'BTC', maxUsd: 25, maxPerMin: 2, maxOpen: 3 })
t('a good order passes', b1._check({ type: 'market', isBuy: true, usd: 10 }, { openOrders: [] }) === null)
t('an oversized order is refused', /over the \$25/.test(b1._check({ type: 'market', usd: 9999 }, { openOrders: [] })))
t('a zero-size order is refused', /positive usd/.test(b1._check({ type: 'market', usd: 0 }, { openOrders: [] })))
t('a NaN size is refused', /positive usd/.test(b1._check({ type: 'market', usd: 'x' }, { openOrders: [] })))
t('garbage is refused', /not an intent/.test(b1._check(null, {})))
t('an unknown type is refused', /unknown intent/.test(b1._check({ type: 'wire-funds', usd: 5 }, { openOrders: [] })))
t('too many resting orders refuses a new limit',
  /resting orders/.test(b1._check({ type: 'limit', usd: 5, px: 10 }, { openOrders: [1, 2, 3] })))
t('but a market order is not blocked by resting count',
  b1._check({ type: 'market', usd: 5 }, { openOrders: [1, 2, 3] }) === null)
b1.sentAt = [Date.now(), Date.now()]
t('the per-minute cap bites', /rate limit/.test(b1._check({ type: 'market', usd: 5 }, { openOrders: [] })))
t('and a close still gets through it', b1._check({ type: 'close' }, { openOrders: [] }) === null)
b1.sentAt = [Date.now() - 61_000, Date.now() - 62_000]
t('sends older than a minute stop counting', b1._check({ type: 'market', usd: 5 }, { openOrders: [] }) === null)

console.log(String.fromCharCode(10) + '-- a bad file is survivable --')
t('a throw in one tick is logged, not fatal', bot.includes("' threw: '"))
t('and why is stated', bot.includes('not a reason to stop the bot'))
t('a file with no onTick is rejected with the fix in the message', bot.includes('Define: function onTick(ctx)'))
t('a load failure is fatal and stops the bot', bot.includes("if (m.t === 'fatal') { this.say('error', m.msg); this.stop(); return }"))
t('the log is bounded', bot.includes('if (this.log.length > 200) this.log.length = 200'))
t('install refuses a file with no onTick', cli.includes("if (!/onTick/.test(code))"))
t('and an oversized file', cli.includes('f.size > 200_000'))
t('installing requires an explicit acknowledgement', cli.includes("document.getElementById('devBotAck')?.checked"))

console.log(String.fromCharCode(10) + '-- it really places orders, through the normal path --')
const exec = grab(cli, 'async function _devBotExecute(def, it)')
t('paper accounts use the paper engine', exec.includes('if (isPaper())'))
t('real accounts use the same order calls the buttons use',
  exec.includes('placeLimitOrder({') && exec.includes('placeMarketOrder({'))
t('close uses the real close path', exec.includes('closePosition({'))
t('cancel uses the real cancel path', exec.includes('cancelOrder({'))
t('a market order with no mark is refused, and says for which market',
  exec.includes("error: 'no mark price for ' + coin"))
t('a zero size is refused before it is sent', exec.includes("size worked out to zero"))
t('closing with no position says so', exec.includes("no position to close"))

console.log(String.fromCharCode(10) + '-- the UI states what it is --')
// The separate "ON THIS DEVICE" section is gone: device bots are now ordinary cards in
// the same list as the built-ins. Where it runs is said in prose beneath them, and on the
// back of each card, rather than as a badge on a section that no longer exists.
t('it still says where these run', cli.includes('run in this browser, not on our servers'))
t('and on the back of each card too', cli.includes("_T('Runs where', 'Dónde corre')"))
t('and that it stops when the app closes', cli.includes('It stops when you close the app'))
t('a bot can be started, stopped, read and deleted',
  ['__devBotStart', '__devBotStop', '__devBotLogs', '__devBotDelete'].every(f => cli.includes(f)))
t('deleting warns that open orders survive', cli.includes('Anything it has already placed stays open'))
t('blocked intents are surfaced on the card, not hidden', cli.includes("${_T('blocked', 'bloqueadas')}"))
t('a starter template ships with it', bot.includes('export const DEVBOT_TEMPLATE'))
t('the template documents the ctx it receives', bot.includes('//   position: { szi, entryPx, unrealizedPnl } | null,'))
t('and the intents it can return', bot.includes("//   { type: 'market', isBuy: true,  usd: 25 }"))

console.log(String.fromCharCode(10) + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
