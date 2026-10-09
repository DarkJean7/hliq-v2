/**
 * Markets Hyperliquid's own UI shows under a different name than their ticker: xyz:CL is
 * "WTIOIL" there, xyz:OAI "OPENAI". Keyed by the ticker without its dex prefix.
 *
 * One list, shared by the app (src/main.js _MKT_DISPLAY), /markets and /portfolios — the
 * public pages searched only the ticker, so "wtioil" found nothing while the app called the
 * same market WTIOIL. The ticker stays the market's identity everywhere it is used as one
 * (categories, candles, orders); this is only what a person reads and types.
 */
export const DISPLAY_NAMES = { CL: 'WTIOIL', GPRO: 'GOPRO', OAI: 'OPENAI' }

/** The name to show for a ticker (with or without its dex prefix). */
export const displayName = (sym) => { const s = String(sym ?? '').replace(/^.*:/, ''); return DISPLAY_NAMES[s] ?? s }
