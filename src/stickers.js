/**
 * INSOLVENT TERMINAL — chat stickers
 *
 * Asked for alongside image upload in the global chat. These are NOT files: a sticker is a
 * NAME, the message carries the name, and the client draws the glyph large. The same reason
 * alarm.js synthesises its ringtones and fillsound.js its chimes — a sticker sheet would be
 * a binary asset to ship, cache-bust, and have go missing — with a second reason that only
 * applies here: a name cannot be anything but one of these. An open upload needs a size cap,
 * a rate limit, a type check and a moderator; a sticker needs an `isSticker` and is finished.
 *
 * Shared by the client that draws the picker and by server.js, which refuses a name that is
 * not in this list. One list, so the two cannot drift.
 */

/** Every sticker, in the order the picker shows them. */
export const STICKERS = [
  { id: 'rocket',   char: '🚀', label: 'Rocket' },
  { id: 'moon',     char: '🌕', label: 'Moon' },
  { id: 'bull',     char: '🐂', label: 'Bull' },
  { id: 'bear',     char: '🐻', label: 'Bear' },
  { id: 'up',       char: '📈', label: 'Up' },
  { id: 'down',     char: '📉', label: 'Down' },
  { id: 'fire',     char: '🔥', label: 'Fire' },
  { id: 'diamond',  char: '💎', label: 'Diamond' },
  { id: 'hands',    char: '🙌', label: 'Hands' },
  { id: 'money',    char: '💰', label: 'Money' },
  { id: 'liq',      char: '💀', label: 'Liquidated' },
  { id: 'clown',    char: '🤡', label: 'Clown' },
  { id: 'cry',      char: '😭', label: 'Cry' },
  { id: 'laugh',    char: '😂', label: 'Laugh' },
  { id: 'think',    char: '🤔', label: 'Think' },
  { id: 'eyes',     char: '👀', label: 'Eyes' },
  { id: 'pray',     char: '🙏', label: 'Pray' },
  { id: 'muscle',   char: '💪', label: 'Strong' },
  { id: 'brain',    char: '🧠', label: 'Brain' },
  { id: 'shrug',    char: '🤷', label: 'Shrug' },
  { id: 'ok',       char: '👌', label: 'OK' },
  { id: 'up1',      char: '👍', label: 'Yes' },
  { id: 'down1',    char: '👎', label: 'No' },
  { id: 'warn',     char: '⚠️', label: 'Careful' },
  { id: 'bomb',     char: '💣', label: 'Bomb' },
  { id: 'popcorn',  char: '🍿', label: 'Popcorn' },
  { id: 'sleep',    char: '😴', label: 'Asleep' },
  { id: 'party',    char: '🎉', label: 'Party' },
  { id: 'salute',   char: '🫡', label: 'Salute' },
  { id: 'cold',     char: '🥶', label: 'Cold' },
  { id: 'sweat',    char: '🥵', label: 'Sweating' },
  { id: 'nervous',  char: '😬', label: 'Nervous' },
]

const BY_ID = new Map(STICKERS.map(s => [s.id, s]))

/** Is this one of ours? The only validation a sticker needs, on both sides of the wire. */
export const isSticker = (id) => typeof id === 'string' && BY_ID.has(id)

/** The glyph to draw, or '' for a name we do not know — never a guess and never a blank box. */
export const stickerChar = (id) => BY_ID.get(id)?.char ?? ''

/** Its name, for a title and for a screen reader. */
export const stickerLabel = (id) => BY_ID.get(id)?.label ?? ''
