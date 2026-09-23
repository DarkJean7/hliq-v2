// Depositing and withdrawing over Arbitrum, driven through the real UI with a fake wallet.
//
// Reported: "make sure the user can make deposits via arbitrum and also withdraw. last time i
// got error trying to withdraw." Nothing in either function's source says what was wrong — the
// failures are in the ORDER of things: which chain the wallet is on when it signs, and which
// side of the account the money is on when the withdrawal is submitted. Both need a wallet and
// an exchange to sit between, so both are here.
//
// Hermetic: the wallet is an EIP-6963 provider announced by the test, and both Hyperliquid and
// the Arbitrum RPC are stubbed. Nothing is signed, sent or withdrawn for real.
//
// Run:  npm run test:browser        (expects a dev server; pass --port=NNNN)
import { chromium } from 'playwright'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const BASE = 'http://localhost:' + port + '/'
const ADDR = '0xaa7Ad5Fa4D99D9BF3397232Df7F4523853538159'
const DEST = '0x974e086b541afc90acaf9ac5d3326d666a601e6b'
const NL   = String.fromCharCode(10)
const HL_HOST = /^https?:\/\/[a-z0-9.-]*hyperliquid[a-z0-9.-]*\.xyz\//i
const BRIDGE = '0x2df1c51e09aecf9cacb7bc98cb1742757f163df7'

let pass = 0, fail = 0
const ok = (n, cond, got = '') => {
  cond ? pass++ : fail++
  console.log('  ' + (cond ? 'PASS ' : 'FAIL ') + n + (cond ? '' : ' → ' + JSON.stringify(got)))
}
const waitFor = async (p, label, fn, arg, ms = 20000) => {
  const t0 = Date.now()
  for (;;) {
    try { if (await p.evaluate(fn, arg)) return true } catch {}
    if (Date.now() - t0 > ms) { console.log('  (timed out waiting for ' + label + ')'); return false }
    await p.waitForTimeout(150)
  }
}

// $0.10 withdrawable on the perp side, $231.02 free on the spot side — the real shape measured
// on an account while this was reported, and the one the old code could not withdraw from.
const PERP_WITHDRAWABLE = '0.097783'
const SPOT_USDC = { coin: 'USDC', token: 0, total: '444.69095324', hold: '213.669232', entryNtl: '0' }
const MARGIN = { accountValue: '205.649438', totalNtlPos: '0', totalRawUsd: '205.6', totalMarginUsed: '160.32859' }
const STATE  = { marginSummary: MARGIN, crossMarginSummary: MARGIN, crossMaintenanceMarginUsed: '0',
                 withdrawable: PERP_WITHDRAWABLE, assetPositions: [], time: Date.now() }
const WINDOW = { accountValueHistory: [[Date.now() - 3600e3, '650'], [Date.now(), '650']], pnlHistory: [], vlm: '0' }
const HL_INFO = {
  clearinghouseState: STATE,
  spotClearinghouseState: { balances: [SPOT_USDC] },
  allMids: {}, frontendOpenOrders: [], userFills: [], userFillsByTime: [], userFunding: [],
  userNonFundingLedgerUpdates: [], subAccounts: [], candleSnapshot: [], extraAgents: [],
  allPerpMetas: [{ universe: [] }], outcomeMeta: {}, perpDexs: [null], perpCategories: [],
  portfolio: ['day', 'week', 'month', 'allTime'].map(w => [w, WINDOW]),
  webData2: { clearinghouseState: STATE, openOrders: [] },
  meta: { universe: [] }, spotMeta: { tokens: [], universe: [] },
  metaAndAssetCtxs: [{ universe: [] }, []], spotMetaAndAssetCtxs: [{ tokens: [], universe: [] }, []],
}

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } })
try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}

// Everything the exchange is asked to do, in order.
const actions = []
// The app approves a builder fee and sets a referrer when a wallet connects; those are not
// what this test is about. Only the actions that move money count.
const moves = () => actions.filter(a => ['withdraw3', 'usdClassTransfer'].includes(a.type))
await ctx.route(HL_HOST, async (route) => {
  const url = route.request().url()
  let b = {}
  try { b = JSON.parse(route.request().postData() || '{}') } catch {}
  if (/\/exchange/.test(url)) {
    actions.push(b?.action ?? {})
    return route.fulfill({ status: 200, contentType: 'application/json', json: { status: 'ok', response: { type: 'default' } } })
  }
  return route.fulfill({ status: 200, contentType: 'application/json', json: HL_INFO[b.type] ?? {} })
})
// The Arbitrum RPC the USDC balance is read from (a plain JSON-RPC POST from ethers).
await ctx.route(/arb1\.arbitrum\.io/, (route) => {
  let b = {}
  try { b = JSON.parse(route.request().postData() || '{}') } catch {}
  const one = (r) => ({ jsonrpc: '2.0', id: r.id, result: r.method === 'eth_chainId' ? '0xa4b1'
    // balanceOf → 500 USDC (6 decimals)
    : r.method === 'eth_call' ? '0x' + (500_000_000).toString(16).padStart(64, '0')
    : '0x' })
  return route.fulfill({ status: 200, contentType: 'application/json', json: Array.isArray(b) ? b.map(one) : one(b) })
})
await ctx.route('**/api/**', (route) => route.fulfill({ status: 503, body: 'offline in test' }))
await ctx.route('**/offexprice**', (route) => route.fulfill({ status: 200, json: { prices: {} } }))

// A wallet that answers like a real injected one, and records what it was asked.
await ctx.addInitScript(({ addr }) => {
  const calls = []
  window.__walletCalls = calls
  let chain = '0x1'                       // starts on Ethereum: a withdrawal must move it
  window.__walletChain = () => chain
  const SIG = '0x' + '11'.repeat(64) + '1b'
  const provider = {
    isTest: true,
    async request({ method, params }) {
      calls.push({ method, params })
      switch (method) {
        case 'eth_requestAccounts': case 'eth_accounts': return [addr]
        case 'eth_chainId': return chain
        case 'wallet_switchEthereumChain': chain = params[0].chainId; return null
        case 'net_version': return String(parseInt(chain, 16))
        case 'eth_signTypedData_v4': case 'personal_sign': case 'eth_sign': return SIG
        case 'eth_estimateGas': return '0x186a0'
        case 'eth_gasPrice': case 'eth_maxPriorityFeePerGas': return '0x3b9aca00'
        case 'eth_getTransactionCount': return '0x1'
        case 'eth_blockNumber': return '0x64'
        case 'eth_getBlockByNumber': return { number: '0x64', baseFeePerGas: '0x3b9aca00', gasLimit: '0x1c9c380', timestamp: '0x1', hash: '0x' + 'aa'.repeat(32) }
        case 'eth_sendTransaction': return '0x' + 'bb'.repeat(32)
        case 'eth_getTransactionReceipt': return { transactionHash: '0x' + 'bb'.repeat(32), blockNumber: '0x64', blockHash: '0x' + 'aa'.repeat(32), status: '0x1', gasUsed: '0x5208', cumulativeGasUsed: '0x5208', logs: [], from: addr, to: addr, contractAddress: null, type: '0x2', logsBloom: '0x' + '00'.repeat(256), effectiveGasPrice: '0x3b9aca00', transactionIndex: '0x0' }
        case 'eth_call': return '0x' + (500_000_000).toString(16).padStart(64, '0')   // 500 USDC
        case 'eth_getCode': return '0x60'
        default: return null
      }
    },
    on() {}, removeListener() {},
  }
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
    detail: Object.freeze({ info: { uuid: 'test-uuid', name: 'Test Wallet', icon: 'data:image/svg+xml,<svg/>', rdns: 'test.wallet' }, provider }),
  }))
  window.addEventListener('eip6963:requestProvider', announce)
  announce()
  window.ethereum = provider
}, { addr: ADDR })

const p = await ctx.newPage()
const errs = []
p.on('pageerror', e => errs.push(e.message))
await p.goto(BASE, { waitUntil: 'domcontentloaded' })
await p.evaluate(({ a }) => {
  localStorage.clear()
  localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1')
  localStorage.setItem('hliq_lang_chosen', '1')
  ;['hliq_onboard_welcomed_v1', 'hliq_onboard_tour_v1', 'hliq_install_nudge_v2'].forEach(x => localStorage.setItem(x, '1'))
  localStorage.setItem('hliq_ann_dismissed', JSON.stringify(['*']))
  localStorage.setItem('hliq_privacy', '0')
  localStorage.setItem('savedWallets', JSON.stringify([{ addr: a, label: 'Main' }]))
}, { a: ADDR })
await p.reload({ waitUntil: 'domcontentloaded' })
await waitFor(p, 'boot', () => !!window.loadDashboard)
await p.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, ADDR)
await waitFor(p, 'the account', () => document.getElementById('dashboard')?.classList.contains('active'))
await p.evaluate(() => window.__pickWallet('test.wallet'))
await waitFor(p, 'the wallet', () => !!window.__isMainWalletConnected?.() || /0xaa7A/i.test(document.getElementById('mainWalletStatus')?.textContent ?? ''), null, 25000)

const status = (id) => p.evaluate((i) => document.getElementById(i)?.textContent?.trim() ?? '', id)
const fill = async (id, v) => p.evaluate(({ i, v }) => {
  const el = document.getElementById(i)
  el.value = v
  el.dispatchEvent(new Event('input', { bubbles: true }))
}, { i: id, v })

console.log(NL + '-- a withdrawal says what is wrong before asking for a signature --')
{
  await fill('withdrawAmount', '0.50')
  await fill('withdrawDest', DEST)
  await p.evaluate(() => { window.__executeWithdraw(); return true })
  await p.waitForTimeout(300)
  ok('under the $1 fee is refused', /more than the \$1 fee/i.test(await status('withdrawStatus')), await status('withdrawStatus'))
  ok('and nothing was sent to the exchange', moves().length === 0, moves())

  await fill('withdrawAmount', '50')
  await fill('withdrawDest', '0x123')
  await p.evaluate(() => { window.__executeWithdraw(); return true })
  await p.waitForTimeout(300)
  ok('a destination that is not an address is refused', /not a wallet address/i.test(await status('withdrawStatus')), await status('withdrawStatus'))

  await fill('withdrawDest', DEST)
  await fill('withdrawAmount', '5000')
  await p.evaluate(() => { window.__executeWithdraw(); return true })
  await waitFor(p, 'the balance check', () => /can be withdrawn right now/i.test(document.getElementById('withdrawStatus')?.textContent ?? ''))
  ok('more than the account holds is refused, with the real figure',
    /231\.1\d|231\.\d\d/.test(await status('withdrawStatus')), await status('withdrawStatus'))
  ok('still nothing sent', moves().length === 0, moves())
}

console.log(NL + '-- and then it withdraws, from wherever the money is --')
{
  // $50: the perp side has $0.10, so the rest has to come across from spot first.
  await fill('withdrawAmount', '50')
  await p.evaluate(() => { window.__executeWithdraw(); return true })
  await waitFor(p, 'the withdrawal', () => /Withdrawal submitted/i.test(document.getElementById('withdrawStatus')?.textContent ?? ''), null, 25000)
  ok('it is submitted', /Withdrawal submitted/i.test(await status('withdrawStatus')), await status('withdrawStatus'))
  ok('the wallet was moved to Arbitrum before signing', (await p.evaluate(() => window.__walletChain())) === '0xa4b1')
  ok('two actions, in order: top up the perp side, then withdraw',
    moves().map(a => a.type).join(',') === 'usdClassTransfer,withdraw3', moves().map(a => a.type))
  const [xfer, wd] = moves()
  ok('the transfer covers exactly the shortfall', Math.abs(parseFloat(xfer.amount) - (50 - parseFloat(PERP_WITHDRAWABLE))) < 0.01 && xfer.toPerp === true, xfer)
  ok('the withdrawal names the destination and the amount', wd?.destination?.toLowerCase() === DEST.toLowerCase() && parseFloat(wd.amount) === 50, wd)
  ok('and it is signed on Arbitrum', wd.signatureChainId === '0xa4b1', wd.signatureChainId)
  ok('the signature prompt was a typed-data one, not a blind sign',
    await p.evaluate(() => window.__walletCalls.some(c => c.method === 'eth_signTypedData_v4')))
}

console.log(NL + '-- a deposit is a plain USDC transfer to the bridge --')
{
  actions.length = 0
  await fill('depositAmount', '2')
  await p.evaluate(() => window.__updateDepositPreview())
  ok('below the bridge minimum the button refuses, before any wallet prompt',
    /too low/i.test(await p.evaluate(() => document.getElementById('depositBtn')?.textContent ?? '')) &&
    /permanently lost/i.test(await status('depositWarning')), await status('depositWarning'))

  await fill('depositAmount', '25')
  await p.evaluate(() => { window.__executeDeposit(); return true })
  // The transaction the wallet is asked to send is the whole of what a deposit IS. Waiting for
  // a confirmation instead would be waiting on a fake chain to mine a fake block.
  const asked = await waitFor(p, 'the transfer', () => window.__walletCalls.some(c => c.method === 'eth_sendTransaction'), null, 25000)
  ok('it reaches the wallet as a transaction to sign', asked, await status('depositStatus'))
  const sent = await p.evaluate(() => window.__walletCalls.filter(c => c.method === 'eth_sendTransaction').map(c => c.params[0]))
  ok('one transaction, to USDC, transferring to the bridge', sent.length === 1 &&
    /^0xa9059cbb/.test(sent[0].data ?? '') && (sent[0].data ?? '').toLowerCase().includes('2df1c51e09aecf9cacb7bc98cb1742757f163df7'), sent)
  // 25 USDC = 25_000_000 with 6 decimals = 0x17d7840
  ok('for the amount asked, in USDC decimals', (sent[0].data ?? '').toLowerCase().endsWith((25_000_000).toString(16).padStart(64, '0')), sent[0]?.data?.slice(-64))
  ok('and it never touched the exchange API', moves().length === 0, moves())
  ok('on Arbitrum, and to the USDC contract', (await p.evaluate(() => window.__walletChain())) === '0xa4b1' &&
    String(sent[0]?.to ?? '').toLowerCase() === '0xaf88d065e77c8cc2239327c5edb3a432268e5831', sent[0]?.to)
}

if (errs.length) { fail++; console.log('  FAIL page errors → ' + JSON.stringify(errs.slice(0, 4))) }
console.log(NL + `${pass} passed, ${fail} failed`)
await browser.close()
process.exit(fail ? 1 : 0)
