// Allocation → By sector (src/sectoralloc.js): exposure grouped by the categories /markets uses.
import fs from 'fs'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = '\n'

const S = await import('../../src/sectoralloc.js')
const h = (o) => ({ id: o.id ?? o.sym, kind: 'perp', hlCat: null, long: 0, short: 0, label: o.sym, accts: new Set(), ...o })
const META = { revenue: { HYPE: { name: 'Hyperliquid', category: 'Derivatives', r30: 5e7, f30: 6e7 }, KAITO: { category: 'Launchpad', r30: 0, f30: 0 } }, sic: { XOM: [2911, 'Petroleum refining'] } }

console.log(nl + '-- one sector per asset, the same rules as /markets --')
{
  const d = S.holdingsSectors([
    h({ sym: 'BTC', long: 2000 }),
    h({ sym: 'HYPE', short: 500 }),
    h({ id: 'spot:HYPE', sym: 'HYPE', kind: 'spot', long: 150 }),
    h({ id: 'xyz:NVDA', sym: 'NVDA', hlCat: 'stocks', long: 1000 }),
    h({ id: 'xyz:XOM', sym: 'XOM', hlCat: 'stocks', long: 300 }),
    h({ id: 'xyz:GOLD', sym: 'GOLD', hlCat: 'commodities', long: 100 }),
    h({ id: 'spot:UBTC', sym: 'UBTC', kind: 'spot', long: 50 }),
    h({ id: 'spot:KNTQ', sym: 'KNTQ', kind: 'spot', long: 20 }),
    h({ id: 'spot:+41590', sym: '+41590', kind: 'outcome', long: 10 }),
    h({ sym: 'KAITO', long: 40 }),
  ], META)
  const sec = Object.fromEntries(d.sectors.map(s => [s.key, s]))
  t('BTC is a Layer 1, and so is Unit\'s wrapped UBTC', sec.l1?.gross === 2050, sec.l1)
  t('HYPE is filed where /markets labels it: Derivatives (DefiLlama), perp and spot together', sec.derivatives?.gross === 650 && sec.derivatives.items.length === 2)
  t('a short counts as exposure, and is kept apart from the longs', sec.derivatives.short === 500 && sec.derivatives.long === 150)
  const nvda = sec.ai?.items.find(i => i.sym === 'NVDA')
  t('NVDA on a HIP-3 stock dex is AI — and also tech and semis, as tags', nvda?.gross === 1000 && ['tech', 'semis'].every(k => nvda.tags.includes(k)))
  t('a stock with no list of ours takes its sector from its SEC industry code', sec.energy?.gross === 300, Object.keys(sec))
  t('commodities split into metals', sec.metals?.gross === 100)
  t('a token nobody categorises is "Other crypto", not dropped', sec.other?.gross === 20 && S.sectorLabel('other') === 'Other crypto')
  t('DefiLlama\'s category only counts for a protocol that earns: $0 KAITO "Launchpad" is not one — it is AI, by our list', !sec.launchpad && sec.ai.items.some(i => i.sym === 'KAITO'))
  t('outcome shares are predictions', sec.outcomes?.gross === 10)
  t('the ring adds up: gross is every holding once', d.gross === 2000 + 500 + 150 + 1000 + 300 + 100 + 50 + 20 + 10 + 40 && d.sectors.reduce((a, s) => a + s.gross, 0) === d.gross)
  t('net: longs less shorts', d.long - d.short === d.gross - 1000)
  t('sorted biggest first', d.sectors.every((s, i, a) => !i || a[i - 1].gross >= s.gross))
  const tag = Object.fromEntries(d.tags.map(x => [x.key, x.gross]))
  t('every tag counts every asset that carries it: tech includes NVDA', tag.tech === 1000 && tag.semis === 1000 && tag.stocks === 1300)
  t('so the tags add up to more than the ring', d.tags.reduce((a, x) => a + x.gross, 0) > d.gross)
}

console.log(nl + '-- unknown is not other --')
{
  const d = S.holdingsSectors([h({ sym: 'HYPE', long: 100 })], null)
  t('without DefiLlama, HYPE still has a sector from our lists (Layer 1)', d.sectors[0].key === 'l1')
  t('cash and empty holdings add nothing', S.holdingsSectors([h({ sym: 'BTC' })], META).sectors.length === 0)
  t('a ticker a community token happens to share is not unwrapped', S.unwrapSym('UNI', s => s === 'UNI' || s === 'NI') === 'UNI')
  t('a tradfi market with only Hyperliquid\'s word for it is filed by that word', S.holdingsSectors([h({ sym: 'XYZ100', hlCat: 'indices', long: 5 })], META).sectors[0].key === 'indices')
}

console.log(nl + '-- wired into the Allocation screen, both shells --')
{
  const MAIN = fs.readFileSync('src/main.js', 'utf8')
  t('a By type / By sector switch on the allocation view', MAIN.includes("b('sector', _T('By sector', 'Por sector'))") && MAIN.includes("if (_allocMode === 'sector')   { _mobVRenderSectors(el); return }"))
  t('it remembers the choice', MAIN.includes("localStorage.setItem('hliq_alloc_mode', _allocMode)"))
  t('the same sources as the money wheel: positions, spot (all visible wallets), off-exchange',
    /function _sectorHoldings[\s\S]{0,2500}state\.perpState\?\.assetPositions[\s\S]{0,1500}_allocSpotBalances\(\)[\s\S]{0,800}_offexWheelItems\(\)/.test(MAIN))
  t('Hyperliquid\'s own categories from the market data the app already loads', MAIN.includes('hlCat: _mktCatMap[coin] ?? _MAIN_DEX_TRADFI_CATS[coin] ?? null'))
  const SRC = fs.readFileSync('src/sectoralloc.js', 'utf8')
  t('the categoriser is /markets\' own', SRC.includes("import { classify, SECTOR_LABEL, LLAMA_TO_SECTOR } from './sectors.js'"))
  t('a failed category load says so and offers a retry', SRC.includes('data-sec-retry') && SRC.includes("metaState = 'failed'"))
  t('privacy: every dollar goes through the app\'s formatter', !/\$\{fmt|toLocaleString/.test(SRC))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
