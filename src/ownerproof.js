/**
 * INSOLVENT TERMINAL — what a wallet signs to prove a request is its owner's.
 *
 * Shared by server.js (which verifies) and the app (which signs), so the two cannot drift.
 *
 * Why this exists: on 2026-11-12 a scripted scan from a rented server walked every write
 * endpoint with addresses lifted from the public leaderboard. Three took any address on trust:
 *   /api/sub/trial       — burned the one free trial of ten wallets, two of them the owner's
 *   /api/sub/payfrom     — "payments from X count for Y", for anyone's X: a real customer's
 *                          subscription payment could be credited to a stranger
 *   /api/challenge/claim — rewrote the contest winner's payout wallet
 * Each now needs the operator PIN, an agent-key session Hyperliquid lists as approved for the
 * wallet, or a personal_sign of the message below from the wallet itself, at most ten minutes
 * old (PROOF_MAX_AGE_MS). The timestamp is inside what is signed, so a captured signature
 * cannot be replayed later, and the action and addresses are too, so it cannot be reused for
 * a different request.
 */

export const PROOF_MAX_AGE_MS = 10 * 60 * 1000

const lc = (a) => String(a ?? '').toLowerCase()

/** Start the one free trial for `addr`. */
export const trialMessage = (addr, ts) =>
  `Insolvent Trade — start free trial\naddress: ${lc(addr)}\nts: ${ts}`

/** Let payments sent FROM `payer` enable `addr`. Signed by the payer: it is their money. */
export const payFromMessage = (payer, addr, ts) =>
  `Insolvent Trade — credit my payments to another wallet\npayer: ${lc(payer)}\ncredits: ${lc(addr)}\nts: ${ts}`
