/**
 * The Oracle's reading of one market, from its candles, book ratio and funding — the same
 * pipeline the tab draws (outlookview.js cardHtml + analysis.js resultFor), as one pure function
 * so the server can log every market without anybody opening it ("log every coin automatically
 * even if nobody opens it"). No DOM, no fetching: oraclelogger.js does that on the server.
 *
 *   setup   — buildZones over the last ZONE_4H_DAYS of 4h plus daily and weekly, then readSetup.
 *   past    — pastSamples over the year of 4h + daily; per horizon the learned multipliers and the
 *             cone's own calibration (learnedWeights, coneRecord → coneScale).
 *   reading — outlookFor with no position, at each horizon.
 *
 * Only a reading whose signals were ≥90% present is reported, as the tab does before logging.
 */
import { buildZones, readSetup } from './zones.js'
import { outlookFor, pastSamples, learnedWeights, coneRecord, coneScale } from './outlook.js'

// Must match analysis.js (a suite checks it): older 4h swings are what daily and weekly are for.
export const ZONE_4H_DAYS = 180

/** The Analysis tab's setup for `price`, from candles { '4h', '1d', '1w' }. Null without one. */
export function setupFrom(candles, price, ratio = null, prev = null, now = Date.now()) {
  const c4 = candles?.['4h'] ?? []
  if (!(price > 0) || !c4.length) return null
  const from = now - ZONE_4H_DAYS * 864e5
  const r = buildZones({ candles: { ...candles, '4h': c4.filter(k => k.t >= from) }, price, now })
  return r ? readSetup({ zones: r.zones, price, atrD: r.atrD, daily: candles['1d'] ?? [], ratio, prev }) : null
}

/** The replay a market's learned weights and cone come from. Changes only with a new 4h candle. */
export function pastOf(candles) { return pastSamples(candles['4h'], candles['1d']) }

/**
 * Every horizon's reading: { [hours]: { score, sigma } | null }. `samples` may be passed in when
 * the caller keeps them between candles (pastOf); `setup` likewise.
 */
export function readingsFor({ candles, price, ratio = null, fundingPctHr = null, hours, samples = null, setup = undefined, now = Date.now() }) {
  const c4 = candles?.['4h'], c1 = candles?.['1d']
  if (!(price > 0) || !c4?.length || !c1?.length) return {}
  const s = samples ?? pastOf(candles)
  const su = setup === undefined ? setupFrom(candles, price, ratio, null, now) : setup
  const out = {}
  for (const h of hours) {
    const o = outlookFor({ position: null, price, c4, c1, setup: su, ratio, fundingPctHr, hours: h, mult: learnedWeights(s, h), sigmaScale: coneScale(coneRecord(s, h), h) })
    out[h] = (o.score?.coverage ?? 0) >= 0.9 && o.sigma > 0 ? { score: o.score.score, sigma: o.sigma } : null
  }
  return out
}
