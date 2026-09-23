import { ethers } from 'ethers'
import { ExchangeClient, InfoClient, HttpTransport } from '@nktkas/hyperliquid'
import { getRawProvider, getMainSigner, wakeWallet, ensureChain } from './wallet.js'

const BRIDGE_ADDRESS    = '0x2df1c51e09aecf9cacb7bc98cb1742757f163df7'
const USDC_ADDRESS      = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'

const USDC_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
]

// Hyperliquid's minimum bridge deposit. Anything smaller is CONFISCATED by the
// bridge rather than credited, so this is enforced before sending.
const MIN_DEPOSIT_USDC = 5

/**
 * A signer guaranteed to be on Arbitrum.
 *
 * The switching logic lives in wallet.js and is shared with everything else that needs a
 * chain. This function used to carry its own copy of it -- which is why "wrong network"
 * kept coming back: fixes went into whichever of the two someone found first, and the
 * deposit path was running the copy that had not been hardened.
 */
async function ensureArbitrum(what = 'Deposit') {
  const raw = getRawProvider()
  if (!raw) throw new Error('Main wallet not connected')
  // wake: on mobile the switch prompt goes to the wallet app, which the browser will not
  // bring forward on its own.
  const r = await ensureChain('0xa4b1', null, { wake: true })
  if (!r.ok) {
    throw new Error(r.rejected
      ? 'Network switch rejected — approve switching to Arbitrum One in your wallet'
      : `Wallet still on the wrong network — open your wallet, switch to Arbitrum One, then tap ${what} again`)
  }
  return raw
}

async function getArbitrumSigner() {
  const raw = await ensureArbitrum('Deposit')
  return new ethers.BrowserProvider(raw).getSigner()
}

/**
 * What can actually leave the account, and where it is sitting.
 *
 * `withdrawable` on the perp side is what a withdrawal can take. USDC held on the SPOT side is
 * the same account's money but not that figure — on an account that is not in unified mode the
 * two are separate balances, and a withdrawal larger than the perp half is rejected however
 * much spot USDC is there. Measured on a real account mid-report: perp withdrawable $0.10
 * against $231 of free spot USDC, while the app offered their SUM as "Max".
 */
export async function withdrawableUsdc(addr) {
  const info = new InfoClient({ transport: new HttpTransport() })
  const [perp, spot] = await Promise.all([
    info.clearinghouseState({ user: addr }),
    info.spotClearinghouseState({ user: addr }).catch(() => null),
  ])
  const u = (spot?.balances ?? []).find(b => b.coin === 'USDC')
  const free = u ? Math.max(0, parseFloat(u.total ?? 0) - parseFloat(u.hold ?? 0)) : 0
  return {
    perp: Math.max(0, parseFloat(perp?.withdrawable ?? 0) || 0),
    spot: Number.isFinite(free) ? free : 0,
  }
}

export async function getUsdcBalance() {
  try {
    const raw = getRawProvider()
    if (!raw) return null
    // Use eth_accounts (no prompt, no hang) instead of getSigner().getAddress()
    const accounts = await raw.request({ method: 'eth_accounts' })
    if (!accounts || !accounts.length) return null
    const addr = accounts[0]
    // Read USDC balance on Arbitrum via public RPC — no chain switch needed
    const arbProvider = new ethers.JsonRpcProvider('https://arb1.arbitrum.io/rpc')
    const usdc = new ethers.Contract(USDC_ADDRESS, USDC_ABI, arbProvider)
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10_000))
    const bal = await Promise.race([usdc.balanceOf(addr), timeout])
    return Number(ethers.formatUnits(bal, 6))
  } catch {
    return null
  }
}

/**
 * Deposit USDC into Hyperliquid.
 *
 * A Hyperliquid deposit is a PLAIN ERC-20 TRANSFER of USDC to the Arbitrum bridge —
 * the bridge credits the sender's account when it sees the transfer. This used to
 * call `bridge.deposit(uint256,uint32)`, which does not exist in the bridge's
 * deployed bytecode (verified against the contract on Arbitrum), so every deposit
 * reverted during estimateGas with an opaque "missing revert data" CALL_EXCEPTION.
 *
 * Because it's a bare transfer there is no destination selector and no approval
 * step — funds land in the account's unified/perp balance. `destination` is kept
 * for the caller's UI copy only.
 */
export async function deposit({ amount, destination, onStep }) {
  const amt = parseFloat(amount)
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('Enter an amount to deposit')
  // Below the bridge minimum the funds are lost, not returned — refuse loudly.
  if (amt < MIN_DEPOSIT_USDC) {
    throw new Error(`Hyperliquid's minimum deposit is ${MIN_DEPOSIT_USDC} USDC — smaller amounts are lost, not refunded.`)
  }

  onStep('Switching to Arbitrum...')
  const signer = await getArbitrumSigner()
  const addr   = await signer.getAddress()

  const usdc      = new ethers.Contract(USDC_ADDRESS, USDC_ABI, signer)
  const amountWei = ethers.parseUnits(amt.toString(), 6)

  const bal = await usdc.balanceOf(addr)
  if (bal < amountWei) {
    throw new Error(`Not enough USDC on Arbitrum — you have ${ethers.formatUnits(bal, 6)}`)
  }

  onStep('Confirm deposit in wallet...')
  // Mobile WalletConnect: the send-transaction prompt goes to the wallet app, which the
  // browser doesn't foreground — deep-link so the user sees it (mirrors getArbitrumSigner).
  const txPromise = usdc.transfer(BRIDGE_ADDRESS, amountWei)
  if (getRawProvider()?.setDefaultChain) setTimeout(() => { try { wakeWallet() } catch {} }, 300)
  const tx = await txPromise
  onStep('Waiting for confirmation...')
  await tx.wait()
  return tx.hash
}

/** Hyperliquid's own fee, taken out of the amount withdrawn. */
export const WITHDRAW_FEE_USDC = 1

/**
 * Withdraw USDC to an Arbitrum address.
 *
 * Three things this has to do that it did not, each behind a reported "error trying to
 * withdraw" with nothing useful on screen:
 *
 *  - SIGN ON ARBITRUM. The signature carries the chain it was made on, and a withdrawal is
 *    the one action where that chain is also where the money lands. Asking the wallet to
 *    switch is also what wakes a sleeping WalletConnect session: telemetry has the failure
 *    that leaves behind — "Cannot read properties of undefined (reading 'request')" from
 *    inside the WalletConnect bundle, which is the provider not being there at all.
 *  - MOVE THE MONEY TO THE SIDE A WITHDRAWAL TAKES FROM. `withdrawable` is the perp side;
 *    USDC sitting in spot is the same account's money but not part of that figure, and a
 *    withdrawal for more than the perp half is rejected. The "Max" button offered the sum of
 *    the two, so Max could not go through. When the perp side is short, the shortfall is
 *    moved across first (one extra signature, announced through onStep).
 *  - SAY WHAT IS WRONG BEFORE ASKING FOR A SIGNATURE: an amount under the fee, a destination
 *    that is not an address, or more than the account holds.
 */
export async function withdraw({ amount, destination, onStep = () => {} }) {
  const amt  = parseFloat(amount)
  const dest = String(destination ?? '').trim()
  if (!Number.isFinite(amt) || amt <= WITHDRAW_FEE_USDC) {
    throw new Error(`A withdrawal has to be more than the $${WITHDRAW_FEE_USDC} fee.`)
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(dest)) {
    throw new Error('That destination is not a wallet address (0x followed by 40 characters).')
  }
  if (!getMainSigner()) throw new Error('Main wallet not connected')

  onStep('Switching to Arbitrum...')
  const raw = await ensureArbitrum('Withdraw')
  // A FRESH signer, built after the switch. The connected one was made when the wallet was on
  // whatever chain it was on then, and ethers pins a provider to the network it first saw:
  // signing through it after the switch throws `network changed: 1 => 42161`, which is the
  // reported "error trying to withdraw". The deposit path has always rebuilt its signer here,
  // which is why depositing worked and withdrawing did not.
  const signer = await new ethers.BrowserProvider(raw).getSigner()

  const addr      = await signer.getAddress()
  const transport = new HttpTransport()
  const client    = new ExchangeClient({ transport, wallet: signer })

  const bal = await withdrawableUsdc(addr).catch(() => null)
  if (bal && amt > bal.perp + bal.spot + 1e-6) {
    throw new Error(`Only ${(bal.perp + bal.spot).toFixed(2)} USDC can be withdrawn right now — the rest is margin behind open positions and resting orders.`)
  }
  // The perp side is what a withdrawal takes from; top it up from spot if it is short.
  if (bal && amt > bal.perp + 1e-6) {
    const need = Math.min(Math.ceil((amt - bal.perp) * 1e6) / 1e6, bal.spot)
    onStep('Move USDC from spot to perps (1 of 2 signatures)...')
    const t = client.usdClassTransfer({ amount: need.toFixed(6), toPerp: true })
    if (getRawProvider()?.setDefaultChain) setTimeout(() => { try { wakeWallet() } catch {} }, 300)
    await t
    onStep('Confirm the withdrawal (2 of 2)...')
  } else {
    onStep('Confirm withdrawal in wallet...')
  }

  // Mobile WalletConnect: the withdraw signature prompt lands in the (backgrounded) wallet
  // app — deep-link so it surfaces, same as deposit/agent-approval.
  const p = client.withdraw3({ destination: dest, amount: amt.toString() })
  if (getRawProvider()?.setDefaultChain) setTimeout(() => { try { wakeWallet() } catch {} }, 300)
  return p
}
