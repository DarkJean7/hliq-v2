// "Wrong network" on an Arbitrum deposit — and why it kept coming back.
//
// It was never one bug. There were TWO chain-switch implementations: ensureChain in
// wallet.js, and a copy inside getArbitrumSigner in defi.js. ensureChain was imported by
// main.js and never called, so every deposit ran the copy — and each time someone fixed
// "wrong network" they hardened whichever of the two they happened to open. Half the fixes
// went into code no user ever reached.
//
// So the assertion that matters here is not about the switching logic. It is that there is
// exactly ONE of it. If a second grows back, this suite goes red before a user finds it.
import fs from 'fs'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)

const SRC = Object.fromEntries(
  fs.readdirSync('src').filter(f => f.endsWith('.js'))
    .map(f => [f, fs.readFileSync('src/' + f, 'utf8')]))

console.log(nl + '-- there is exactly one chain switcher --')
{
  const owners = Object.entries(SRC).filter(([, c]) => c.includes('wallet_switchEthereumChain'))
  t('only one module asks a wallet to switch chains',
    owners.length === 1 && owners[0][0] === 'wallet.js',
    owners.map(([f]) => f).join(','))
  const adders = Object.entries(SRC).filter(([, c]) => c.includes('wallet_addEthereumChain'))
  t('and only one adds Arbitrum to a wallet',
    adders.length === 1 && adders[0][0] === 'wallet.js',
    adders.map(([f]) => f).join(','))
  t('the deposit path calls it rather than reimplementing it',
    SRC['defi.js'].includes("ensureChain('0xa4b1', null, { wake: true })"))
  t('and imports it', /import \{[^}]*ensureChain[^}]*\} from '\.\/wallet\.js'/.test(SRC['defi.js']))
  t('why two copies is the actual bug is written down',
    SRC['wallet.js'].includes('it was never one bug'))
}

console.log(nl + '-- the one implementation keeps what both copies had --')
{
  const w = SRC['wallet.js']
  t('it routes the WalletConnect session first', w.includes('setDefaultChain?.(`eip155:${want}`)'))
  t('and gives that a beat to propagate before asking', w.includes('setTimeout(r, 300)'))
  t('a chain the wallet does not know is added, then re-switched',
    w.includes('wallet_addEthereumChain') && w.includes('4902'))
  t('including wallets that wrap that as -32603', w.includes('-32603'))
  // The copy polled ~4.8s and this one polled 1s. A wallet that had already switched was
  // being told it was on the wrong network.
  t('it polls long enough for a mobile wallet to catch up', w.includes('i < 12'))
  t('why a short poll was wrong is recorded', w.includes('which is where "wrong network" came from'))
  t('it can deep-link so the prompt is actually seen', w.includes('wakeWallet()'))
  t('and that is opt-in, not forced on every caller', w.includes('{ wake = false } = {}'))
}

console.log(nl + '-- a refusal and a timeout are different answers --')
{
  const w = SRC['wallet.js']
  t('the result says which happened', w.includes('{ ok: false, rejected: true }'))
  t('a user declining is detected', w.includes('e?.code === 4001'))
  t('the deposit says "you declined" for one',
    SRC['defi.js'].includes('Network switch rejected'))
  t('and "still on the wrong network" for the other',
    SRC['defi.js'].includes('Wallet still on the wrong network'))
  t('why a bare boolean was not enough is recorded',
    w.includes('cannot tell them apart has to guess'))
}

console.log(nl + '-- nothing is left behind to grow a second copy around --')
t('defi.js no longer keeps its own chain id', !SRC['defi.js'].includes('ARBITRUM_CHAIN_ID'))
t('and does not poll eth_chainId itself', !SRC['defi.js'].includes("method: 'eth_chainId'"))

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
