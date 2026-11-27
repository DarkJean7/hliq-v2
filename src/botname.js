/**
 * How an arena row's name is SHOWN: "Momentum (bot)".
 *
 * "are the agents really agents or just bots? i consider agent a ia that thinks by itself, and a
 * bot just a fixed behaviour" — they follow fixed rules (Rekt-01 tunes its weights, but still by
 * rule), so the Agent Arena became the Bot Pit.
 *
 * The STORED name keeps "(agent)" (src/paperboard.js AGENT_TAG): the server matches it to answer
 * an arena row's feed, and a copy bot already following one names it that way, so renaming it
 * would silently break those. Kept out of paperboard.js because server.js imports that file, and
 * any change to it restarts every bot.
 */
export const showName = (n) => String(n ?? '').replace(/\(\s*agent\s*\)\s*$/i, '(bot)')
