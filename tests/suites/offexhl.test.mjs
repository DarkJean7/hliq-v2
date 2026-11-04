// Holding HYPE off-exchange.
//
// Reported: "not letting me add hype as an off-exchange token". The address pasted was
// 0x0d01dc56dcaaca66ad901c959b4011ec — Hyperliquid's HYPE *tokenId*, 16 bytes, which the form
// correctly refused as not being a 20-byte contract address. But there was no address to use
// instead: HL's spotMeta gives HYPE `evmContract: null`, because it is HyperEVM's NATIVE gas
// token. offex.js was contract-address-only, so a native token could not be expressed at all.
//
// So Hyperliquid is a network in that table now, its tokens are NAMED rather than addressed,
// and its prices come from the mids the app already polls — no DEX source to ask, no request
// to spend, and deeper than any HyperEVM pool for the same token.
import fs from 'fs'
import { HL_NET, normToken, isHlToken, normHlToken, quoteKey, NETWORKS } from '../../src/offex.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const UI  = fs.readFileSync('src/offexui.js', 'utf8').replace(/\r\n/g, '\n')
const CLI = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')

console.log(nl + '-- a token can be named instead of addressed --')
t('HYPE is a token name', isHlToken('HYPE') && normHlToken(' hype ') === 'HYPE')
t('an @N pair id is one too', normHlToken('@107') === '@107')
// The thing actually pasted: HL's 16-byte tokenId. It is neither an address nor a symbol.
// Through normToken, not the helpers directly: an earlier version of this suite asserted
// isHlToken/normHlToken on their own and so passed even with the branch that chooses between
// them deleted. The branch IS the feature.
t('a symbol resolves on the HL network', normToken(HL_NET, 'hype') === 'HYPE')
t('and is refused on an addressed one', normToken('eth', 'HYPE') === null)
t('an address is refused on the HL network', normToken(HL_NET, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48') === null)
t('and still resolves on an addressed one', typeof normToken('eth', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48') === 'string')
t('the HL tokenId is refused either way',
  normToken(HL_NET, '0x0d01dc56dcaaca66ad901c959b4011ec') === null &&
  normToken('eth', '0x0d01dc56dcaaca66ad901c959b4011ec') === null)
t('and the key it produces names the token', quoteKey(HL_NET, 'hype') === 'hl:HYPE')
t('and so is an empty symbol', normToken(HL_NET, '') === null)
t('Hyperliquid is in the network table', !!NETWORKS[HL_NET] && NETWORKS[HL_NET].label === 'Hyperliquid')

console.log(nl + '-- the form asks for the right thing on each network --')
t('the token label follows the network (symbol on HL, mint on Solana, contract elsewhere)', /offexTokenLabel[\s\S]{0,140}?HL_NET \? 'Token symbol' : _sheet\.net === SOL_NET \? 'Mint address' : 'Contract address'/.test(UI))
t('so does the hint', /const TOKEN_HINT = \(net\) => normNet\(net\) === HL_NET/.test(UI))
t('and the hint says why there is no address to paste', /no contract address to paste/.test(UI))
t('changing network reshapes the box', /window\.__offexNetChange = \(\) => \{/.test(UI))
t('and re-runs the lookup against the new meaning', /window\.__offexNetChange = \(\) => \{[\s\S]{0,900}?lookup\(inp\.value\)/.test(UI))
t('the select actually calls it', /id="offexNet" onchange="window\.__offexNetChange\(\)"/.test(UI))

console.log(nl + '-- saving reads the network before the token --')
// The original order read the token as an address FIRST, which refused every symbol outright
// no matter what the network said.
const save = UI.slice(UI.indexOf('function save()'), UI.indexOf('function save()') + 1400)
t('net is resolved first', save.indexOf("const net = normNet(") < save.indexOf('const token = normToken('))
t('and the token by that network', /const token = normToken\(net,/.test(save))
t('with an error that matches what was asked for', /HL_NET \? 'Enter the token..s symbol/.test(save))

console.log(nl + '-- and the price comes from the app, not a DEX --')
t('offexui resolves HL quotes locally', /if \(n === HL_NET\) \{[\s\S]{0,400}?ctx\.hlPrice/.test(UI))
t('marked as sourced from Hyperliquid', /src: 'Hyperliquid'/.test(UI))
t('never thin — an exchange book is not a pool', /src: 'Hyperliquid'[\s\S]{0,60}?|thin: false/.test(UI))
t('main.js supplies the mids', /hlPrice: async \(tok\) => \{/.test(CLI))
t('and the module waits for them', /Number\(await ctx\.hlPrice\?\.\(a\)\)/.test(UI))

// Built from the source so the assertion tracks the real function.
//
// It used to read _spotNameMap — filled only by the Trade tab's market load — and fall back to
// mids[symbol]. So "it is not letting me add drv": DRV is spot-only (@700), and HYPE and PURR only
// "worked" because a perp shares each name, which priced them off the PERP. Now it goes through
// _spotMid, the pair map the Spot tab and the wheel read, and loads that map when it has to.
const SRC = CLI.slice(CLI.indexOf('hlPrice: async (tok) => {'), CLI.indexOf('\n  },', CLI.indexOf('hlPrice: async (tok) => {')) + 4)
const hlPrice = (spot, loaded, tok) => {
  const calls = { ensured: 0 }
  const p = new Function('stubs', `
    const { _spotMetaLoaded, ensureSpotMeta, _spotMid } = stubs
    const o = { ${SRC} }
    return o.hlPrice('${tok}')
  `)({
    _spotMetaLoaded: () => loaded.v,
    ensureSpotMeta: async () => { calls.ensured++; loaded.v = true },
    _spotMid: (t) => loaded.v ? (spot[t] ?? 0) : 0,
  })
  return p.then(v => ({ v, ...calls }))
}
{
  const a = await hlPrice({ DRV: 0.3497 }, { v: true }, 'DRV')
  t('a spot-only token prices through the pair map', a.v === 0.3497, a)
  const b = await hlPrice({ DRV: 0.3497 }, { v: false }, 'drv')
  t('the map is loaded first when no tab has loaded it', b.v === 0.3497 && b.ensured === 1, b)
  t('a perp of the same name is not the spot price', !/mids\[t\]/.test(SRC))
  t('an unknown token has no price, not a zero', (await hlPrice({}, { v: true }, 'NOPE')).v === null)
  t('and a junk mid is refused rather than shown as 0', (await hlPrice({ HYPE: 0 }, { v: true }, 'HYPE')).v === null)
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
