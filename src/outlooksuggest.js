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

/**
 * For a market watched but not held ("let the user add assets that he does not have as
 * positions"): which side the lean favours, a stop beyond the case against it (or the key level
 * past it), and a first target at the next level its way. `out` is outlookFor with no position.
 * No lean, or no edge: nothing to enter on.
 */
export function ideaFor(L, out, setup) {
  if (!L || L.conviction === 0 || L.lean === 'flat') return [{ id: 'noEdge' }]
  const long = L.lean === 'up'
  const cs = out?.cases
  const against = long ? [cs?.bear?.px, setup?.support?.lo] : [cs?.bull?.px, setup?.resistance?.hi]
  const valid = against.filter(v => v > 0)
  const stop = valid.length ? (long ? Math.min(...valid) * 0.995 : Math.max(...valid) * 1.005) : null
  const target = long ? (setup?.resistance?.lo ?? cs?.bull?.px) : (setup?.support?.hi ?? cs?.bear?.px)
  return [{ id: 'entryIdea', side: long ? 'long' : 'short', stop, target: target > 0 ? target : null }]
}

/** The ways the cards can be ordered ("add sorts"). Each section is sorted on its own. */
export const ORACLE_SORTS = ['default', 'strong', 'bull', 'bear', 'conviction', 'pnl', 'risk', 'az']

/**
 * Order cards by `by`. Each item carries `keys` — { score, conviction, pnl, risk (the nearest
 * liquidation in σ), name } — or null while it is still loading; those keep their place at the
 * end. `default` is the order given: positions as the app lists them, watched as added.
 * A missing value (a watched market has no P&L, a position no liquidation in range) sorts last.
 */
export function sortCards(items, by) {
  const ready = items.filter(i => i.keys), waiting = items.filter(i => !i.keys)
  const last = (v, dir) => v == null || !Number.isFinite(v) ? (dir > 0 ? Infinity : -Infinity) : v
  const num = (get, dir) => (a, b) => dir * (last(get(a.keys), dir) - last(get(b.keys), dir))
  const cmp = {
    strong: num(k => k.score == null ? null : Math.abs(k.score), -1),
    bull: num(k => k.score, -1),
    bear: num(k => k.score, 1),
    conviction: (a, b) => (b.keys.conviction - a.keys.conviction) || (Math.abs(b.keys.score ?? 0) - Math.abs(a.keys.score ?? 0)),
    pnl: num(k => k.pnl, -1),
    risk: num(k => k.risk, 1),
    az: (a, b) => String(a.keys.name).localeCompare(String(b.keys.name)),
  }[by]
  const sorted = cmp ? ready.map((x, i) => [x, i]).sort((a, b) => cmp(a[0], b[0]) || a[1] - b[1]).map(([x]) => x) : ready
  return [...sorted, ...waiting]
}
