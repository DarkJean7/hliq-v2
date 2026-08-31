# Writing your own bot for Insolvent Terminal

Your bot is one `.js` file. It runs **in your browser, on your device** — not on anyone's
server — and it stops when you close the app.

Start on the **paper account**. It is simulated money, it needs no wallet and no keys, and
a bot behaves identically there and on a real account, so anything you see on paper is what
you would get live.

---

## 1. The file

One function, called `onTick`. That is the only requirement.

```js
function onTick(ctx) {
  // called once every N seconds, N being the interval you pick when adding the bot
}
```

It may be `async`.

## 2. What you get

```js
ctx = {
  coin:      "BTC",         // the market you chose for this bot
  mark:      78123.5,       // its current mark price
  tick:      1735600000000, // ms timestamp
  paper:     true,          // true on the practice account
  equity:    1042.11,       // account value, USDC

  position:  { szi, entryPx, unrealizedPnl } | null,   // in ctx.coin
  openOrders:[ { oid, isBuy, sz, limitPx } ],          // in ctx.coin
  candles:   [ { t, o, h, l, c, v } ],   // ~200 recent 1h bars, oldest first

  // the whole account, if you want more than one market
  mids:      { BTC: "78123.5", ETH: "2431.0", ... },   // note: strings
  positions: [ { coin, szi, entryPx, unrealizedPnl, leverage, liquidationPx, marginUsed } ],
  orders:    [ { oid, coin, isBuy, sz, limitPx } ],
  margin:    { accountValue, totalMarginUsed, withdrawable },
}
```

`ctx.candles` is often **empty for the first few ticks** while history loads. Check its
length, or use `api.candles()` below, which fetches immediately.

## 3. Acting — the simple way

Return one object, an array of them, or nothing:

```js
{ type: "market", isBuy: true,  usd: 25 }
{ type: "limit",  isBuy: false, usd: 25, px: 80000 }
{ type: "cancel", oid: 123456789 }
{ type: "close" }
```

Sizes are in **dollars**, not coins — the app converts at the price it sends at.

## 4. Acting — the full way

```js
await api.info({ type: "l2Book", coin: "BTC" })          // any public /info request
await api.candles("ETH", "15m", Date.now() - 86400000)
await api.order({ orders: [ ... ], grouping: "na" })     // any order the SDK accepts
await api.cancel({ cancels: [ { a: 0, o: 123 } ] })
await api.exchange("updateLeverage", { asset: 0, isCross: true, leverage: 5 })
```

## 5. Logging

```js
log("anything", 123, obj)
```

Goes to the bot's Log panel. `console.log` goes nowhere you can see.

---

## Adding it

**Strategies → Upload .js** (or *Write your own bot* to paste it), then set:

| Field | Meaning |
|---|---|
| Market | the one market `ctx.coin` refers to |
| Max per order | dollars; an order above this is refused |
| Max orders / min | throttle; refused beyond it |
| Max resting orders | cap on open limit orders |
| Run every (s) | how often `onTick` is called |
| Leverage | used when the app places your orders |

Set any of the three caps to **0** to switch that limit off. Leave a field **blank** and it
uses the default — blank is not zero.

Then press **👁 Preview**. It runs one real tick against live prices with nothing sent, and
shows you what your bot decided. When that looks right, press **Run**.

---

## What it can and cannot do

Your file runs in a Web Worker. It has **no access to any private key** — not yours, not
anyone's. It cannot sign anything. When it asks for an order, the app signs and sends it,
after checking the request against the limits above.

That is worth knowing in both directions: your keys are not exposed to code you paste, and
your bot cannot do anything the app has not agreed to. Actions that move funds, and
approving another agent for the account, are refused outright.

It **can** still call `fetch()`, so a file you did not write could send what it is given —
the market it runs on, your position in it, your equity — somewhere. Only run a file you
wrote or have read.

Not available: `window`, `document`, `localStorage`, `import` / `require`. It is a Worker,
so there is no page and no module loader — put everything in the one file.

You can use **any variable names you like**, including `log` and `api`. Your file runs in
its own scope and will not collide with the app.

---

## Errors

A throw inside one tick is logged and the bot keeps running. A file with no `onTick`, or
one that does not parse, is refused when you add it, with the reason.

---

## A working example

`selftest-bot.js` in this folder walks the whole surface and reports what it found, then
opens a $15 position and closes it a few ticks later. Upload it, press Preview, then Run,
and read the Log — it is the fastest way to see the shape of everything above.

The complete format reference is also in the app: **Strategies → File format**.
