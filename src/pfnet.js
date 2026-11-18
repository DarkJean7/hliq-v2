// Profit factor over the account's WHOLE life, from its net PnL.
//
// Asked for: "i want profit factor to be based from all time, net pnl" -- after an account read
// 3.46 beside -99.7% ROE and -$22M net. The trade-based figure only sees the fills Hyperliquid
// still hands out (its most recent 10,000), and for James Wynn those were a few months of small
// wins after the losses that made the -$22M.
//
// Built from Hyperliquid's all-time PnL curve instead: every rise over every fall. Gain − loss
// IS the all-time net PnL, so the factor is above 1 exactly when the account is up -- open
// positions, funding and fees included. The curve's points are hours to days apart, so a rise
// and fall inside one step net out: it measures the account, not each decision; the trade
// figures beside it (avg win/loss, win rate) still do that.
//
// Its own module, not trackrecord.js: server.js imports that one, and any change to what the bot
// server loads restarts it (and the bots) on deploy.

/** { gain, loss, pf, noLosses } from a `portfolio` answer, or null without its all-time curve. */
export function pnlCurveFactor(portfolio) {
  const h = (Array.isArray(portfolio) ? portfolio : []).find(p => p?.[0] === 'allTime')?.[1]?.pnlHistory
  if (!Array.isArray(h) || h.length < 2) return null
  let gain = 0, loss = 0, prev = null
  for (const pt of h) {
    const v = parseFloat(pt?.[1])
    if (!Number.isFinite(v)) continue
    // The curve starts at 0 when the account began, so its first point is a step from 0 too.
    const d = v - (prev ?? 0)
    if (d > 0) gain += d; else if (d < 0) loss -= d
    prev = v
  }
  if (prev === null) return null
  return { gain, loss, pf: loss > 0 ? gain / loss : null, noLosses: loss === 0 && gain > 0 }
}
