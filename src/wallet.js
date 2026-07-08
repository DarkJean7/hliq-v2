import { ethers } from 'ethers'

const WC_PROJECT_ID = 'e8673b3e68c70c77520d9f0042aebce4'

let mainSigner   = null
let mainAddress  = null
let rawProvider  = null
let _onDisconnect = null

export function onWalletDisconnect(cb) { _onDisconnect = cb }

const discovered = new Map() // rdns → { info, provider }

window.addEventListener('eip6963:announceProvider', ({ detail }) => {
  discovered.set(detail.info.rdns, detail)
})
window.dispatchEvent(new Event('eip6963:requestProvider'))

export function getDiscoveredWallets() { return [...discovered.values()] }
export function getMainAddress()        { return mainAddress }
export function isMainWalletConnected() { return mainSigner !== null }
export function getMainSigner()         { return mainSigner }
export function getRawProvider()        { return rawProvider }

export async function connectWallet(rdns) {
  let raw
  if (rdns === 'walletconnect') {
    const { EthereumProvider } = await import(/* @vite-ignore */ '@walletconnect/ethereum-provider')
    const wc = await EthereumProvider.init({
      projectId:      WC_PROJECT_ID,
      // Arbitrum is REQUIRED — HL's bridge (deposits) lives there. With it only
      // optional, mobile wallets approve a mainnet-only session and Arbitrum
      // transactions fail with "request() chainId: eip155:1".
      chains:         [42161],
      optionalChains: [1],
      showQrModal:    true,
      metadata: {
        name:        'Insolvent Terminal',
        description: 'Hyperliquid Dashboard',
        url:         window.location.origin,
        icons:       [window.location.origin + '/apple-touch-icon.png'],
      },
    })
    await wc.connect()
    wc.on('disconnect', () => { disconnectMainWallet(); _onDisconnect?.() })
    wc.on('session_expire', () => { disconnectMainWallet(); _onDisconnect?.() })
    raw = wc
  } else if (rdns && discovered.has(rdns)) {
    raw = discovered.get(rdns).provider
  } else if (window.ethereum) {
    raw = window.ethereum
  } else {
    throw new Error('No wallet found.')
  }

  const provider = new ethers.BrowserProvider(raw)
  await provider.send('eth_requestAccounts', [])
  const signer = await provider.getSigner()
  mainAddress  = (await signer.getAddress()).toLowerCase()
  mainSigner   = signer
  rawProvider  = raw
  return mainAddress
}

export function generateAgentWallet() {
  const w = ethers.Wallet.createRandom()
  return { privateKey: w.privateKey, address: w.address }
}

// Make the wallet's ACTIVE chain match `chainIdHex` before signing. Mobile /
// WalletConnect wallets reject eth_signTypedData_v4 when the domain chainId
// (Arbitrum, used by HL agent approval) ≠ the wallet's current network — the
// "Missing or invalid. request() chainId: eip155:42161" error. Switching first
// aligns them. No-op if already on that chain.
const ARBITRUM_HEX = '0xa4b1'   // 42161
export async function ensureChain(chainIdHex = ARBITRUM_HEX) {
  const raw = rawProvider
  if (!raw?.request) return
  // WalletConnect: point its active session chain at Arbitrum so requests route there.
  try { raw.setDefaultChain?.(`eip155:${parseInt(chainIdHex, 16)}`) } catch (_) {}
  try {
    const cur = await raw.request({ method: 'eth_chainId' }).catch(() => null)
    if (cur && parseInt(cur, 16) === parseInt(chainIdHex, 16)) return
    await raw.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainIdHex }] })
  } catch (e) {
    // 4902 = chain unknown to the wallet — add Arbitrum One then retry the switch.
    if (e?.code === 4902 || /Unrecognized chain|not been added/i.test(e?.message || '')) {
      try {
        await raw.request({ method: 'wallet_addEthereumChain', params: [{
          chainId: chainIdHex, chainName: 'Arbitrum One',
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          rpcUrls: ['https://arb1.arbitrum.io/rpc'],
          blockExplorerUrls: ['https://arbiscan.io'],
        }] })
      } catch (_) {}
    }
    // Non-fatal: the sign will still be attempted; the caller surfaces any error.
  }
}

// A minimal "ethers-v6-shaped" signer the Hyperliquid SDK accepts, but which signs
// by calling the raw EIP-1193 provider directly — passing the chain explicitly so
// WalletConnect can route `eth_signTypedData_v4`. ethers' BrowserProvider does NOT
// forward the chainId to WC, which is what produced
// "Missing or invalid. request() chainId: eip155:42161".
export function getHlSigner() {
  const raw     = rawProvider
  const address = mainAddress
  if (!raw?.request || !address) return mainSigner   // fallback to the ethers signer
  return {
    getAddress: async () => address,
    // Give the SDK a chain id (→ signatureChainId) without touching the wallet.
    provider: { getNetwork: async () => ({ chainId: 42161n }) },
    // ethers-v6 signature shape: (domain, types, message) — length MUST be 3 so the
    // SDK's `isEthersV6Signer` detects it.
    signTypedData: async (domain, types, message) => {
      const primaryType = Object.keys(types)[0]
      const payload = {
        domain,
        types: {
          EIP712Domain: [
            { name: 'name', type: 'string' },
            { name: 'version', type: 'string' },
            { name: 'chainId', type: 'uint256' },
            { name: 'verifyingContract', type: 'address' },
          ],
          ...types,
        },
        primaryType,
        message,
      }
      const json   = JSON.stringify(payload, (_k, v) => typeof v === 'bigint' ? v.toString() : v)
      const args   = { method: 'eth_signTypedData_v4', params: [address, json] }
      const caip   = `eip155:${Number(domain?.chainId) || 42161}`
      // Route the sign to the right chain. WalletConnect's inner UniversalProvider
      // (raw.signer) accepts request(args, caipChain); the outer EthereumProvider
      // ignores a 2nd arg and routes to its active chain; injected providers just
      // take request(args). Try the most specific first.
      const attempts = [
        () => raw.signer?.request?.(args, caip),   // WC UniversalProvider — explicit chain
        () => raw.request(args, caip),             // some providers accept (args, chain)
        () => raw.request(args),                   // injected / default routing
      ]
      let lastErr
      for (const run of attempts) {
        try { const sig = await run(); if (typeof sig === 'string' && sig.startsWith('0x')) return sig }
        catch (e) { lastErr = e }
      }
      throw lastErr || new Error('signTypedData failed')
    },
  }
}

export function disconnectMainWallet() {
  mainSigner  = null
  mainAddress = null
  rawProvider = null
}

export async function connectWalletSilent(rdns) {
  if (rdns === 'walletconnect') return null // WC always needs user interaction
  let raw
  if (rdns && discovered.has(rdns)) raw = discovered.get(rdns).provider
  else if (window.ethereum)         raw = window.ethereum
  else                              return null
  try {
    const provider = new ethers.BrowserProvider(raw)
    const accounts = await provider.send('eth_accounts', []) // no popup
    if (!accounts || accounts.length === 0) return null
    const signer = await provider.getSigner()
    mainAddress  = (await signer.getAddress()).toLowerCase()
    mainSigner   = signer
    rawProvider  = raw
    return mainAddress
  } catch { return null }
}
