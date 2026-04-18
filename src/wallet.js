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
      chains:         [1],
      optionalChains: [42161],
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

export function disconnectMainWallet() {
  mainSigner  = null
  mainAddress = null
  rawProvider = null
}
