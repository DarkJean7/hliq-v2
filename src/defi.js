import { ethers } from 'ethers'
import { ExchangeClient, HttpTransport } from '@nktkas/hyperliquid'
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
async function getArbitrumSigner() {
  const raw = getRawProvider()
  if (!raw) throw new Error('Main wallet not connected')
  // wake: on mobile the switch prompt goes to the wallet app, which the browser will not
  // bring forward on its own.
  const r = await ensureChain('0xa4b1', null, { wake: true })
  if (!r.ok) {
    throw new Error(r.rejected
      ? 'Network switch rejected — approve switching to Arbitrum One in your wallet'
      : 'Wallet still on the wrong network — open your wallet, switch to Arbitrum One, then tap Deposit again')
  }
  return new ethers.BrowserProvider(raw).getSigner()
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

export async function withdraw({ amount, destination }) {
  const signer = getMainSigner()
  if (!signer) throw new Error('Main wallet not connected')
  const transport = new HttpTransport()
  const client    = new ExchangeClient({ transport, wallet: signer })
  // Mobile WalletConnect: the withdraw signature prompt lands in the (backgrounded) wallet
  // app — deep-link so it surfaces, same as deposit/agent-approval.
  const p = client.withdraw3({ destination, amount: amount.toString() })
  if (getRawProvider()?.setDefaultChain) setTimeout(() => { try { wakeWallet() } catch {} }, 300)
  return p
}
