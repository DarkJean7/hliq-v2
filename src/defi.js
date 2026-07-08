import { ethers } from 'ethers'
import { ExchangeClient, HttpTransport } from '@nktkas/hyperliquid'
import { getRawProvider, getMainSigner } from './wallet.js'

const BRIDGE_ADDRESS    = '0x2df1c51e09aecf9cacb7bc98cb1742757f163df7'
const USDC_ADDRESS      = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'
const ARBITRUM_CHAIN_ID = 42161n

const USDC_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
]

const BRIDGE_ABI = [
  'function deposit(uint256 amount, uint32 destinationDex)',
]

const PERP_DEX = 0
const SPOT_DEX = 4294967295 // type(uint32).max

async function getArbitrumSigner() {
  const raw = getRawProvider()
  if (!raw) throw new Error('Main wallet not connected')

  // WalletConnect (mobile/PWA): Arbitrum is already an approved chain in the session, so
  // just route requests to it — this switches the active chain WITHOUT a wallet prompt and
  // is the reliable mobile path. Do it FIRST, then re-check, before any switch prompt.
  try { raw.setDefaultChain?.('eip155:42161') } catch {}
  if (raw.setDefaultChain) await new Promise(r => setTimeout(r, 250))   // let WC propagate

  let network = await new ethers.BrowserProvider(raw).getNetwork()
  if (network.chainId !== ARBITRUM_CHAIN_ID) {
    // Injected wallets (in-app dapp browsers): ask them to switch.
    try {
      await raw.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0xa4b1' }] })
    } catch (e) {
      if (e.code === 4902 || e.code === -32603) {
        await raw.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: '0xa4b1',
            chainName: 'Arbitrum One',
            nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
            rpcUrls: ['https://arb1.arbitrum.io/rpc'],
            blockExplorerUrls: ['https://arbiscan.io'],
          }],
        })
      } else if (e.code === 4001) {
        throw new Error('Network switch rejected — approve switching to Arbitrum One in your wallet')
      } else {
        throw new Error('Switch your wallet to Arbitrum One, then tap Deposit again')
      }
    }
    try { raw.setDefaultChain?.('eip155:42161') } catch {}
    await new Promise(r => setTimeout(r, 300))
    network = await new ethers.BrowserProvider(raw).getNetwork()
    if (network.chainId !== ARBITRUM_CHAIN_ID) {
      throw new Error('Wallet still on the wrong network — set it to Arbitrum One in your wallet app and retry')
    }
  }

  const provider = new ethers.BrowserProvider(raw)
  return provider.getSigner()
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

export async function deposit({ amount, destination, onStep }) {
  onStep('Switching to Arbitrum...')
  const signer = await getArbitrumSigner()
  const addr   = await signer.getAddress()

  const amountWei = ethers.parseUnits(amount.toString(), 6)
  const destDex   = destination === 'spot' ? SPOT_DEX : PERP_DEX

  const usdc   = new ethers.Contract(USDC_ADDRESS, USDC_ABI, signer)
  const bridge = new ethers.Contract(BRIDGE_ADDRESS, BRIDGE_ABI, signer)

  const allowance = await usdc.allowance(addr, BRIDGE_ADDRESS)
  if (allowance < amountWei) {
    onStep('Approving USDC — confirm in wallet...')
    const approveTx = await usdc.approve(BRIDGE_ADDRESS, amountWei)
    onStep('Waiting for approval confirmation...')
    await approveTx.wait()
  }

  onStep('Confirm deposit in wallet...')
  const tx = await bridge.deposit(amountWei, destDex)
  onStep('Waiting for confirmation...')
  await tx.wait()
  return tx.hash
}

export async function withdraw({ amount, destination }) {
  const signer = getMainSigner()
  if (!signer) throw new Error('Main wallet not connected')
  const transport = new HttpTransport()
  const client    = new ExchangeClient({ transport, wallet: signer })
  return client.withdraw3({ destination, amount: amount.toString() })
}
