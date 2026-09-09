import { ethers } from 'ethers'

const WC_PROJECT_ID = 'e8673b3e68c70c77520d9f0042aebce4'

// ─── CONNECTED WALLETS ────────────────────────────────────────────────────────
// Several wallets can be connected at once, keyed by the address each controls —
// the same shape the agent-key layer already uses (_agentClients in trading.js).
// The accessors below resolve against the account the app is CURRENTLY VIEWING,
// so every existing call site automatically talks to the right wallet instead of
// to whichever one connected most recently.
//
// This replaces the old single-slot model, where connecting wallet B while
// viewing account A either mis-signed or had to be rejected outright.
const _wallets = new Map()   // addr(lowercase) → { signer, raw }

// The account the app is showing. Set by the dashboard on every account switch.
let _viewAddr = null
export function setActiveWallet(addr) {
  _viewAddr = /^0x[0-9a-fA-F]{40}$/.test(String(addr ?? '')) ? String(addr).toLowerCase() : null
}

// Resolve the wallet for an explicit address, else the viewed one. With exactly
// one wallet connected and no view set, fall back to it so nothing regresses.
function _entry(addr = null) {
  const key = String(addr ?? _viewAddr ?? '').toLowerCase()
  if (key && _wallets.has(key)) return _wallets.get(key)
  if (!key && _wallets.size === 1) return [..._wallets.values()][0]
  return null
}

let _onDisconnect = null

export function onWalletDisconnect(cb) { _onDisconnect = cb }

/** Addresses of every connected wallet — for UI that lists them. */
export function getConnectedWallets() { return [..._wallets.keys()] }
/** Is a wallet connected for this specific address (default: the viewed one)? */
export function hasWalletFor(addr) { return !!_entry(addr) }

const discovered = new Map() // rdns → { info, provider }

window.addEventListener('eip6963:announceProvider', ({ detail }) => {
  discovered.set(detail.info.rdns, detail)
})
window.dispatchEvent(new Event('eip6963:requestProvider'))

export function getDiscoveredWallets() { return [...discovered.values()] }
// All four resolve for the CURRENTLY VIEWED account, so callers need no changes.
export function getMainAddress()        { const e = _entry(); return e ? e.address : null }
export function isMainWalletConnected() { return !!_entry() }
export function getMainSigner()         { return _entry()?.signer ?? null }
export function getRawProvider()        { return _entry()?.raw ?? null }

export async function connectWallet(rdns, wantAddr = null) {
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
        name:        'Insolvent Trade',
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
  let accounts = await provider.send('eth_requestAccounts', [])
  const want = String(wantAddr ?? '').toLowerCase()

  // A wallet usually authorizes SEVERAL accounts, but getSigner() with no argument
  // always returns accounts[0] — the extension's currently-selected one. When the
  // app is viewing a specific account, prefer that account if the wallet already
  // exposes it, instead of rejecting the connection over a mismatch the user never
  // chose (very common with two extensions competing for window.ethereum).
  const pick = (list) => want
    ? (list ?? []).find(a => String(a).toLowerCase() === want)
    : (list ?? [])[0]

  let chosen = pick(accounts)

  // Wanted account not authorized yet — ask the wallet to open its account picker
  // so the user can grant it, then look again. Far better than a dead-end alert.
  if (want && !chosen) {
    try {
      await raw.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] })
      accounts = await provider.send('eth_accounts', [])
      chosen   = pick(accounts)
    } catch { /* user dismissed the picker — fall through to accounts[0] */ }
  }

  // Lowercase before handing it to ethers: getSigner() runs getAddress(), which
  // throws on a mixed-case address whose checksum doesn't validate. All-lowercase
  // is always accepted, so this can't fail on an oddly-cased wallet response.
  const signer  = await provider.getSigner(chosen ? String(chosen).toLowerCase() : undefined)
  const address = (await signer.getAddress()).toLowerCase()
  // ADD to the registry rather than replacing — connecting a second wallet must not
  // disconnect the first, so each account keeps its own signer.
  _wallets.set(address, { signer, raw, address })
  return address
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
// Returns true once the wallet's ACTIVE chain is Arbitrum. HL agent/builder approvals
// are EIP-712 signs whose domain.chainId is 42161; most wallets reject the sign if their
// active chain differs ("chainId must match the active chainId") — which the SDK then
// re-wraps as the opaque "Failed to sign typed data with ethers v6 wallet". Confirming
// the switch here lets the caller show a real "switch to Arbitrum" message instead.
/**
 * Make the wallet's ACTIVE chain match `chainIdHex`. THE only implementation.
 *
 * There used to be two: this one, and a copy inside defi.js's getArbitrumSigner. This one
 * was imported by main.js and never called, so every deposit ran the copy -- and each time
 * someone fixed "wrong network" they hardened whichever version they happened to open. That
 * is why the bug kept coming back: it was never one bug, it was one fix applied to one of
 * two places. Anything that needs a chain calls this.
 *
 * Returns { ok, rejected } rather than a bare boolean, because "the user declined the
 * switch" and "the wallet never got there" need different things said to them, and a
 * caller that cannot tell them apart has to guess.
 *
 * `wake` deep-links into the wallet app after firing the request. On mobile WalletConnect
 * the switch prompt is relayed to the wallet, which the browser does not foreground -- so
 * the user never sees it, and we time out while they stare at a spinner.
 */
export async function ensureChain(chainIdHex = ARBITRUM_HEX, forAddr = null, { wake = false } = {}) {
  const raw = _entry(forAddr)?.raw
  if (!raw?.request) return { ok: true, rejected: false }
  const want = parseInt(chainIdHex, 16)
  const isWC = !!raw.setDefaultChain
  const onChain = async () => {
    try { return parseInt(await raw.request({ method: 'eth_chainId' }), 16) === want }
    catch { return false }
  }

  // WalletConnect: point the session at the chain first. This usually switches the active
  // chain with no prompt at all, so it is worth a beat to let it propagate before asking.
  try { raw.setDefaultChain?.(`eip155:${want}`) } catch (_) {}
  if (isWC) await new Promise(r => setTimeout(r, 300))
  if (await onChain()) return { ok: true, rejected: false }

  let rejected = false
  const req = raw.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainIdHex }] })
    .catch(async (e) => {
      // 4902 (and -32603 from wallets that wrap it) = chain unknown; add it, then retry.
      if (e?.code === 4902 || e?.code === -32603 ||
          /Unrecognized chain|not been added/i.test(e?.message || '')) {
        try {
          await raw.request({ method: 'wallet_addEthereumChain', params: [{
            chainId: chainIdHex, chainName: 'Arbitrum One',
            nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
            rpcUrls: ['https://arb1.arbitrum.io/rpc'],
            blockExplorerUrls: ['https://arbiscan.io'],
          }] })
          await raw.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainIdHex }] })
            .catch(() => {})
        } catch (_) {}
        return null
      }
      if (e?.code === 4001) { rejected = true; return null }
      // Some mobile wallets reject the RPC and switch anyway when routed. Swallow it and
      // let the poll below decide, rather than failing on a wallet that actually complied.
      return null
    })
  if (wake && isWC) setTimeout(() => { try { wakeWallet() } catch (_) {} }, 300)
  await req
  try { raw.setDefaultChain?.(`eip155:${want}`) } catch (_) {}
  if (rejected) return { ok: false, rejected: true }

  // Mobile wallets report the switch a beat late -- poll ~4.8s before giving up. The old
  // copy in wallet.js polled 1s, which is where "wrong network" came from on a wallet that
  // had already switched.
  for (let i = 0; i < 12; i++) {
    if (await onChain()) return { ok: true, rejected: false }
    await new Promise(r => setTimeout(r, 400))
  }
  return { ok: await onChain(), rejected: false }
}

// A minimal "ethers-v6-shaped" signer the Hyperliquid SDK accepts, but which signs
// by calling the raw EIP-1193 provider directly — passing the chain explicitly so
// WalletConnect can route `eth_signTypedData_v4`. ethers' BrowserProvider does NOT
// forward the chainId to WC, which is what produced
// "Missing or invalid. request() chainId: eip155:42161".
export function getHlSigner(forAddr = null) {
  const entry   = _entry(forAddr)
  const raw     = entry?.raw
  const address = entry?.address
  if (!raw?.request || !address) return entry?.signer ?? null   // fallback to the ethers signer
  return {
    getAddress: async () => address,
    // HL accepts these user-signed EIP-712 actions (approveAgent, approveBuilderFee,
    // etc.) signed on ANY chain — verified empirically against mainnet/Arbitrum/Polygon/
    // Base. So sign on whatever chain the wallet is ALREADY on: report its live chain id
    // to the SDK (which sets signatureChainId + domain.chainId to match). Forcing 42161
    // here used to require the wallet to be on Arbitrum or the sign was rejected as a
    // chainId mismatch — the "switch to Arbitrum" failures. (Deposits/withdrawals are
    // real Arbitrum txns and still switch chains separately.)
    provider: { getNetwork: async () => {
      let id = 42161
      try { const hex = await raw.request({ method: 'eth_chainId' }); const n = parseInt(hex, 16); if (n > 0) id = n } catch (_) {}
      return { chainId: BigInt(id) }
    } },
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

// Mobile WalletConnect: a sign/approve request is relayed to the wallet app over the
// WC relay, but the browser tab is NOT switched to the wallet, so the user never sees
// the prompt and the action appears to hang forever ("stuck at approving on HL"). This
// best-effort opens the wallet's stored deep link so its approval screen surfaces.
// No-op for injected/extension providers (no session), which show their own popup.
export function wakeWallet(forAddr = null) {
  try {
    const raw = _entry(forAddr)?.raw
    if (!raw) return false
    // EthereumProvider (WC v2) keeps the peer's redirect metadata on the active session;
    // the inner UniversalProvider mirrors it at raw.signer.session.
    const session  = raw.session || raw.signer?.session
    const redirect = session?.peer?.metadata?.redirect
    const url      = redirect?.native || redirect?.universal
    if (!url) return false
    window.location.href = url
    return true
  } catch (_) { return false }
}

/**
 * Disconnect one wallet — by default the one for the account in view. Pass
 * `{ all: true }` to drop every connection (used when resetting the dashboard).
 */
export function disconnectMainWallet(opts = {}) {
  if (opts.all) { _wallets.clear(); return }
  const e = _entry(opts.addr ?? null)
  if (e) _wallets.delete(e.address)
}

export async function connectWalletSilent(rdns, wantAddr = null) {
  if (rdns === 'walletconnect') return null // WC always needs user interaction
  let raw
  if (rdns && discovered.has(rdns)) raw = discovered.get(rdns).provider
  else if (window.ethereum)         raw = window.ethereum
  else                              return null
  try {
    const provider = new ethers.BrowserProvider(raw)
    const accounts = await provider.send('eth_accounts', []) // no popup
    if (!accounts || accounts.length === 0) return null
    // Same account preference as connectWallet — silently rebinding to accounts[0]
    // on reload would reconnect as the wrong account without the user touching anything.
    const want   = String(wantAddr ?? '').toLowerCase()
    const chosen = want ? accounts.find(a => String(a).toLowerCase() === want) : accounts[0]
    const signer  = await provider.getSigner(chosen ? String(chosen).toLowerCase() : undefined)
    const address = (await signer.getAddress()).toLowerCase()
    _wallets.set(address, { signer, raw, address })
    return address
  } catch { return null }
}
