// Smoke test: the agent key shown is the key that signs, for the account on screen.
//
// The suite in tests/suites/agentkeys.test.mjs reads the source. This drives the real app,
// because the bug it locks was never visible in the source of any one function — it was four
// places disagreeing about which account the panel was about. Every fault below was found by
// running this, not by reading:
//
//   - a "dedupe" pass deleted a key shared by two accounts (normal: one agent wallet can be
//     approved by several masters);
//   - changing the account inside All Accounts did not repaint the key;
//   - readers asked for state.addr's key, which there is the "__all_accounts__" sentinel;
//   - the status line reported the one globally-connected client, so a keyless account
//     showed a green "connected" belonging to a different wallet.
//
// It needs no real wallet, agent key or Hyperliquid account: the keys are freshly generated
// and /api/** is stubbed offline. Requests to Hyperliquid itself are left alone, so an
// account with a random key is honestly reported as "not approved".
//
// Run:  npm run test:browser            (expects a dev server; pass --port=NNNN)
import { chromium, devices } from 'playwright'
import { Wallet } from 'ethers'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const URL  = `http://localhost:${port}/`

const A = '0xaa7Ad5Fa4D99D9BF3397232Df7F4523853538159'   // has a key
const B = '0x84Ceb6127A07bf6c7234470F4ca8563DeEDc7c6F'   // has a different key
const C = '0x01A4062754D9Cc42C728F3277B5a2C46FdbBd6D7'   // has none
const kA = Wallet.createRandom(), kB = Wallet.createRandom()
const short = (k) => k.privateKey.slice(0, 12)

let pass = 0, fail = 0
const t = (n, got, want) => {
  const ok = got === want
  ok ? pass++ : fail++
  console.log('  ' + (ok ? 'PASS ' : 'FAIL ') + n + ' → ' + JSON.stringify(got) + (ok ? '' : ' (wanted ' + JSON.stringify(want) + ')'))
}

/**
 * Poll for a condition rather than sleeping a guessed number of seconds. Fixed waits made
 * this flaky in exactly the way that gets a test deleted instead of trusted: entering the
 * combined view takes as long as nine wallets take to answer.
 */
const waitFor = async (p, label, fn, ms = 30000, arg = undefined) => {
  const t0 = Date.now()
  for (;;) {
    try { if (await p.evaluate(fn, arg)) return true } catch {}
    if (Date.now() - t0 > ms) { console.log('  (timed out waiting for ' + label + ')'); return false }
    await p.waitForTimeout(250)
  }
}

const seed = async (p) => {
  await p.goto(URL, { waitUntil: 'domcontentloaded' })
  await p.evaluate(({ A, B, C, ka, kb }) => {
    localStorage.clear()
    localStorage.setItem('hliq_lang', 'en')
    localStorage.setItem('hliq_onboard_done', '1')
    localStorage.setItem('hliq_agent_key_' + A.toLowerCase(), ka)
    localStorage.setItem('hliq_agent_key_' + B.toLowerCase(), kb)
    localStorage.setItem('savedWallets', JSON.stringify([
      { addr: A, label: 'Acct A' }, { addr: B, label: 'Acct B' }, { addr: C, label: 'Acct C' },
    ]))
  }, { A, B, C, ka: kA.privateKey, kb: kB.privateKey })
  await p.reload({ waitUntil: 'domcontentloaded' })
  await waitFor(p, 'the app to boot', () => !!document.getElementById('walletInput') && !!window.loadDashboard)
  try { await p.evaluate(() => window.__pickLang('en')) } catch {}
}
const statusText = (p) => p.evaluate(() => (document.getElementById('apiConnectStatus')?.textContent || '').trim())
const load = async (p, a) => {
  // Loaded means two things, and waiting for only the first is what made this flaky: the app
  // is on that account, AND the agent-key restore has finished painting. The second is caught
  // by the status line changing — a readiness signal, not the thing being asserted.
  const before = await statusText(p)
  await p.evaluate((x) => { document.getElementById('walletInput').value = x; return window.loadDashboard() }, a)
  await waitFor(p, 'account ' + a.slice(0, 6), (x) =>
    String(localStorage.getItem('walletAddr') || '').toLowerCase() === x.toLowerCase() &&
    document.getElementById('dashboard')?.classList.contains('active'), 30000, a)
  await waitFor(p, 'the key panel to repaint', (b) =>
    (document.getElementById('apiConnectStatus')?.textContent || '').trim() !== b, 15000, before)
  await p.waitForTimeout(600)
}
const enterAllAccounts = async (p) => {
  await p.evaluate(() => window.__goAllAccounts())
  await waitFor(p, 'the combined view', () => !!window.__getTradeAcct?.(), 45000)
}

const browser = await chromium.launch()
const errs = []

// ─── desktop ──────────────────────────────────────────────────────────────────
{
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  await ctx.route('**/api/**', r => r.fulfill({ status: 503, body: 'offline in test' }))
  const p = await ctx.newPage()
  p.on('pageerror', e => errs.push('desktop: ' + e.message))
  await seed(p)

  const shown = () => p.evaluate(() => ({
    settings: document.getElementById('agentKey')?.value?.slice(0, 12) || null,
    trade: document.getElementById('privateKeyInput')?.value?.slice(0, 12) || null,
    status: (document.getElementById('apiConnectStatus')?.textContent || '').trim(),
    dot: !!document.getElementById('apiStatusDot')?.classList.contains('connected'),
  }))

  console.log('\n-- desktop · one account at a time --')
  for (const [name, addr, want, label] of [
    ['A', A, short(kA), 'Acct A'], ['B', B, short(kB), 'Acct B'],
    ['C (no key)', C, null, 'Acct C'], ['back to A', A, short(kA), 'Acct A'],
  ]) {
    await load(p, addr)
    const s = await shown()
    t(name + ' · settings field', s.settings, want)
    t(name + ' · trade field', s.trade, want)
    t(name + ' · status names the account', s.status.includes(label), true)
    t(name + ' · dot', s.dot, !!want)
  }

  console.log('\n-- desktop · inside All Accounts, the key follows the account you pick --')
  await enterAllAccounts(p)
  for (const [name, addr, want, label] of [
    ['pick A', A, short(kA), 'Acct A'], ['pick B', B, short(kB), 'Acct B'],
    ['pick C', C, null, 'Acct C'], ['back to A', A, short(kA), 'Acct A'],
  ]) {
    await p.evaluate((x) => window.__pickStratAcct(x), addr)
    await p.waitForTimeout(350)   // the repaint is synchronous; this is slack, not a wait
    const s = await shown()
    t(name + ' · field', s.settings, want)
    t(name + ' · status', s.status.includes(label), true)
    t(name + ' · signs with that account’s key', await p.evaluate(() => {
      const a = window.__getTradeAcct?.()
      return a ? (localStorage.getItem('hliq_agent_key_' + a.toLowerCase()) || '').slice(0, 12) || null : null
    }), want)
    t(name + ' · can trade', await p.evaluate(() => window.__canTradeUI?.()), !!want)
  }

  console.log('\n-- desktop · a key pasted there lands on the picked account, not the sentinel --')
  const kC = Wallet.createRandom()
  await p.evaluate((x) => window.__pickStratAcct(x), C)
  await p.waitForTimeout(400)
  await p.evaluate((k) => window.__saveAgentKey(k), kC.privateKey)
  await p.waitForTimeout(400)
  t('stored under C', await p.evaluate((c) => (localStorage.getItem('hliq_agent_key_' + c.toLowerCase()) || '').slice(0, 12) || null, C), short(kC))
  t('nothing under the sentinel', await p.evaluate(() => Object.keys(localStorage).filter(k => k.includes('all_accounts')).length), 0)
  t('C shows its own key', (await shown()).settings, short(kC))
  t('A still has its own', await p.evaluate((a) => (localStorage.getItem('hliq_agent_key_' + a.toLowerCase()) || '').slice(0, 12) || null, A), short(kA))

  console.log('\n-- desktop · a key shared by two accounts survives a reload --')
  // One agent wallet approved by several masters is a normal setup. The old dedupe pass read
  // it as a mis-migration and deleted every copy but one.
  await p.evaluate((ka) => {
    localStorage.setItem('hliq_agent_key_0x84ceb6127a07bf6c7234470f4ca8563deedc7c6f', ka)
    localStorage.removeItem('hliq_agentkey_dedupe_v1')
  }, kA.privateKey)
  await p.reload({ waitUntil: 'domcontentloaded' })
  await waitFor(p, 'the app to boot', () => !!window.loadDashboard)
  await load(p, A)
  t('both accounts keep it', await p.evaluate(([a, b]) => [a, b].map(x =>
    (localStorage.getItem('hliq_agent_key_' + x.toLowerCase()) || '').slice(0, 12)).join(','), [A, B]),
    short(kA) + ',' + short(kA))

  await ctx.close()
}

// ─── mobile, the primary surface ──────────────────────────────────────────────
{
  const ctx = await browser.newContext({ ...devices['iPhone 14 Pro'] })
  await ctx.route('**/api/**', r => r.fulfill({ status: 503, body: 'offline in test' }))
  const p = await ctx.newPage()
  p.on('pageerror', e => errs.push('mobile: ' + e.message))
  await seed(p)
  await load(p, A)

  const panel = () => p.evaluate(() => {
    const el = document.getElementById('mobVContent')
    return {
      key: document.getElementById('m-agentKey')?.value?.slice(0, 12) || null,
      status: (document.getElementById('m-agentKeyStatus')?.textContent || '').trim(),
      autoGen: !!el?.querySelector('.auto-gen-agent-btn'),
      pills: [...(el?.querySelectorAll('[data-strat-acct]') ?? [])].map(x => x.textContent.trim()),
    }
  })

  console.log('\n-- mobile · Strategies, inside All Accounts --')
  await enterAllAccounts(p)
  await p.evaluate(() => window.mobVGoTab('strategies'))
  await waitFor(p, 'the account pills', () => document.querySelectorAll('[data-strat-acct]').length >= 3)
  t('every saved account is offered', (await panel()).pills.length, 3)
  // A keyless account must stay pickable: selecting it is how it gets a key.
  t('including the one with no key', (await panel()).pills.some(x => x.includes('Acct C')), true)

  for (const [name, addr, want, label] of [
    ['A', A, short(kA), 'Acct A'], ['B', B, short(kB), 'Acct B'],
    ['C (no key)', C, null, 'Acct C'], ['back to B', B, short(kB), 'Acct B'],
  ]) {
    await p.evaluate((x) => window.__pickStratAcct(x), addr)
    await p.waitForTimeout(400)
    const s = await panel()
    t(name + ' · key field', s.key, want)
    t(name + ' · status names the account', s.status.includes(label), true)
    t(name + ' · auto-generate offered only with no key', s.autoGen, !want)
  }

  await ctx.close()
}

await browser.close()
console.log('\nerrors: ' + (errs.length ? JSON.stringify(errs.slice(0, 4)) : 'none'))
console.log(pass + ' passed, ' + (fail + errs.length) + ' failed')
process.exit(fail || errs.length ? 1 : 0)
