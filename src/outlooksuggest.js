/**
 * The Outlook card's suggestion: which way the tested signals lean, how much to make of it, and
 * what that means for each position held.
 *
 * Asked: "i want something to act as a suggestion ... with all the signals it should be inclined
 * to something. for example you said something about mean reversal".
 *
 * The lean always comes from the 4h set — the only signals that beat chance on real candles
 * (outlook.js WEIGHTS_4H, tests/research/signal-results.json) — whichever horizon is on screen.
 * The 24h and 7d scores have no tested edge, and a suggestion built on them would be confidence
 * nobody earned.
 *
 * Conviction is earned twice: the reading has to be strong, AND this market's own past record for
 * a reading like it has to back it. A market whose record says "no better than chance" never gets
 * more than "low", however loud the score. The actions are things a trader would consider — a stop
 * where there is none, size when liquidation is close, profit into a likely pullback — with the
 * prices the card already computed. They are not orders and the card says so.
 *
 * Pure: readings in, a plain object out. The view does the words' formatting.
 */

const REVERT = ['rev3d', 'bbFade']

/**
 * The lean for the next 4 hours.
 * `o4` — outlookFor at 4h (score and factors); `rec4` — pastRecord of the learned 4h score on
 * this market (or null). Returns { lean, kind, conviction 0..3, score, stretch, record }.
 *
 *   kind: 'pullback' | 'bounce'          the fading signals carry the lean (mean reversion)
 *         'trend-up' | 'trend-down'      trend and range carry it
 *         'none'                         no lean
 */
export function leanOf(o4, rec4, tested = true) {
  const sc = o4?.score
  if (!sc) return { lean: 'flat', kind: 'none', conviction: 0, score: null, stretch: null, record: rec4 ?? null, tested }
  const fs = o4.factors ?? []
  const pull = (ids) => fs.filter(f => ids.includes(f.id)).reduce((s, f) => s + f.w * f.v, 0)
  const rev = pull(REVERT), rest = pull(fs.map(f => f.id).filter(id => !REVERT.includes(id)))
  const lean = sc.lean
  const revDrives = lean !== 'flat' && Math.sign(rev) === (lean === 'up' ? 1 : -1) && Math.abs(rev) >= Math.abs(rest) * 0.8
  const kind = lean === 'flat' ? 'none' : revDrives ? (lean === 'up' ? 'bounce' : 'pullback') : lean === 'up' ? 'trend-up' : 'trend-down'
  const a = Math.abs(sc.score)
  let conviction = a < 15 ? 0 : a < 40 ? 1 : 2
  const v = rec4?.verdict
  if (conviction && v === 'better') conviction = Math.min(3, conviction + 1)
  else if (conviction && v !== 'better') conviction = 1          // the market's own record does not back it
  // A horizon where no signal set has beaten chance on real candles (outlook.js TESTED_HORIZONS):
  // the lean is still shown, but it is never more than Low, however loud the score.
  if (!tested) conviction = Math.min(conviction, 1)
  const st = Object.fromEntries(fs.filter(f => REVERT.includes(f.id)).map(f => [f.id, f.x]))
  return { lean, kind, conviction, score: sc.score, stretch: { move3d: st.rev3d?.move ?? null, sd: st.bbFade?.sd ?? null }, record: rec4 ?? null, tested }
}

/**
 * What the lean means for one position. `out` — that position's outlookFor at the horizon on
 * screen (cases, risk with its liquidation/TP/stop); `setup` — the levels. Returns a list of
 * { id, px? } in order of importance; the view words them.
 *
 *   noEdge        nothing to act on: keep to the plan
 *   setStop       against you and no stop — one beyond the case against you (or the level past it)
 *   cutRisk       liquidation within reach — reduce size or add margin
 *   takeSome      in profit with the lean against you — consider taking some off
 *   dontAdd       against you, not in profit — a better price may come at the case against you
 *   hold          with you — holding fits
 *   setTarget     with you and no take-profit — the next level your way
 *   addOnDip      a bounce read on a long (or a pullback on a short) — adding into the move fits it
 */
export function actionsFor(L, out, setup) {
  const pos = out?.pos
  if (!pos) return []
  const acts = []
  const risk = out.risk ?? {}
  // Liquidation first, whatever the lean: within 3σ at this horizon, or a 5% chance to touch it.
  if (risk.liq && (risk.liq.sig < 3 || risk.liq.p >= 0.05)) acts.push({ id: 'cutRisk', px: risk.liq.px, sig: risk.liq.sig })
  if (!L || L.conviction === 0 || L.lean === 'flat') { acts.push({ id: 'noEdge' }); return acts }
  const long = pos.side === 'long'
  const withYou = (L.lean === 'up') === long
  const cs = out.cases
  if (!withYou) {
    if (!risk.sl) {
      // Beyond the case against you, or the key level past it if that is nearer — a stop inside
      // the normal range gets taken by the normal range.
      const caseAgainst = long ? cs?.bear?.px : cs?.bull?.px
      const level = long ? setup?.support?.lo : setup?.resistance?.hi
      const px = long ? Math.min(...[caseAgainst, level].filter(v => v > 0)) : Math.max(...[caseAgainst, level].filter(v => v > 0))
      if (Number.isFinite(px) && px > 0) acts.push({ id: 'setStop', px: long ? px * 0.995 : px * 1.005 })
    }
    if (pos.upnl > 0) acts.push({ id: 'takeSome' })
    else acts.push({ id: 'dontAdd', px: long ? cs?.bear?.px : cs?.bull?.px })
  } else {
    acts.push({ id: 'hold' })
    if (!risk.tp) {
      const px = long ? (setup?.resistance?.lo ?? cs?.bull?.px) : (setup?.support?.hi ?? cs?.bear?.px)
      if (px > 0) acts.push({ id: 'setTarget', px })
    }
    if ((L.kind === 'bounce' && long) || (L.kind === 'pullback' && !long)) acts.push({ id: 'addOnDip' })
  }
  return acts
}
