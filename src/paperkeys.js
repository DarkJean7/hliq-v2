/**
 * Which localStorage keys are a paper account's — shared by the app (src/papersync.js) and the
 * server (src/paperhost.js), so the two can never disagree about what is synced. A key not
 * matched here never leaves the device: agent keys, wallets, the leaderboard secret.
 */
export const PAPER_KEY_RE = /^hliq_paper_(v2|chal_v2|s_[a-z0-9]{1,40}|accts|name|bots(_[a-z0-9]{1,40})?|pf_[a-z0-9_]{1,40})$/

/** A key that is one account's store → that account's slot; anything else → null. */
export function slotOfKey(k) {
  if (k === 'hliq_paper_v2') return 'main'
  if (k === 'hliq_paper_chal_v2') return 'challenge'
  const m = /^hliq_paper_s_([a-z0-9]{1,40})$/.exec(k)
  return m ? m[1] : null
}
