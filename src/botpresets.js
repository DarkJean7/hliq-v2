/**
 * Bots that ship with the app.
 *
 * A device bot is a file, and getting a file onto a phone is the hard part of using one:
 * the market list has to be typed in, the caps have to suit it, and getting either wrong
 * fails quietly rather than loudly. A fifteen-market bot on the default four-orders-a-minute
 * cap trades the first four markets and looks like a broken strategy. That is not something
 * a user should have to find out.
 *
 * So a preset is the file AND the card it needs: the markets it was built for, and caps that
 * can actually carry it. Adding one still goes through the ordinary install sheet, with the
 * code on screen and the acknowledgement to tick -- a preset is a filled-in form, not a
 * privileged path. Nothing here can run without the same tap any pasted file needs.
 *
 * The code is imported with `?raw`, so what ships is the file byte for byte. Inlining it as
 * a template literal would put backticks and ${ } in a JS string, which is how a bot that
 * was reviewed stops being the bot that runs.
 */
import tokyoPartners from './bots/tokyo-partners.js?raw'

/**
 * `coins[0]` is the home market: the one its candles load for and the one an order that
 * names no market goes to.
 *
 * `maxPerMin` is deliberately at least the market count. A portfolio bot opens its whole
 * book in a single tick, so anything lower silently truncates the portfolio to whatever
 * arrived first -- see the warning in the install sheet, which exists because of this.
 */
export const BOT_PRESETS = [
  {
    id: 'tokyo-partners',
    name: 'tokyo_partners_bot',
    tagline: ['Hourly windows, 15 markets', 'Ventanas horarias, 15 mercados'],
    blurb: [
      'A portfolio bot. Each of fifteen markets has two fixed windows found by sweeping ~200 days of hourly candles — one it holds long, one it holds short — and every tick it moves the whole book to match the clock in New York. Settings let you change the risk, the leverage and the windows without editing the file.',
      'Un bot de cartera. Cada uno de los quince mercados tiene dos ventanas fijas halladas barriendo ~200 días de velas horarias — una en largo y otra en corto — y en cada tick mueve toda la cartera según el reloj de Nueva York. Los ajustes permiten cambiar riesgo, apalancamiento y ventanas sin tocar el archivo.',
    ],
    code: tokyoPartners,
    coins: ['ZEC', 'CASHCAT', 'xyz:SMSN', 'xyz:SKHX', 'LIT', 'XMR', 'xyz:SNDK', 'xyz:EWY',
            'xyz:MU', 'NEAR', 'xyz:DRAM', 'PUMP', 'xyz:INTC', 'xyz:SPCX', 'xyz:SOXL'],
    maxUsd: 25,
    maxPerMin: 20,      // > 15: one tick opens the whole book at once
    maxOpen: 20,
    everySec: 30,       // the file's own note: turning a window over takes two ticks
    leverage: 3,
    params: '',
    // Not a suggestion about markets, a fact about arithmetic: the risk fraction is split
    // across the markets, and below roughly this the split lands under the exchange minimum,
    // so every order gets rounded up and the book risks more than it was told to.
    minEquity: 2000,
  },
]

export function botPreset(id) {
  return BOT_PRESETS.find(p => p.id === id) ?? null
}
