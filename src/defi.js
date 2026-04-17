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

  const network = await new ethers.BrowserProvider(raw).getNetwork()
  if (network.chainId !== ARBITRUM_CHAIN_ID) {
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
      } else {
        throw new Error('Please switch to Arbitrum One to deposit')
      }
    }
  }

  const provider = new ethers.BrowserProvider(raw)
  return provider.getSigner()
}

export async function getUsdcBalance() {
  try {
    const raw = getRawProvider()
    if (!raw) return null
    const provider = new ethers.BrowserProvider(raw)
    const network  = await provider.getNetwork()
    if (network.chainId !== ARBITRUM_CHAIN_ID) return null
    const signer = await provider.getSigner()
    const usdc   = new ethers.Contract(USDC_ADDRESS, USDC_ABI, signer)
    const addr   = await signer.getAddress()
    const bal    = await usdc.balanceOf(addr)
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
