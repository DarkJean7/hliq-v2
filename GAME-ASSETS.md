# Insolvent Game Mode — Painted Asset Spec

The game engine is already wired for these files. Drop finished PNGs into
`public/game/`, list their names (no extension) in `public/game/manifest.json`,
rebuild/deploy — every listed asset replaces its hand-drawn SVG placeholder
automatically. Anything not listed keeps the SVG fallback, so you can ship art
piece by piece.

```
public/game/
  manifest.json        ← e.g. ["bg-den", "pet-bullo-thriving", "obj-door"]
  bg-den.png
  pet-bullo-thriving.png
  ...
```

---

## Locked style guide — prepend this to EVERY prompt

> **STYLE:** high-quality 2D mobile-game illustration, painterly casual-game
> style (Moy 7 / Kleptocats / Alchemy Stars lobby quality), soft cel shading
> with ambient occlusion, clean thick-to-thin lineart, rich color depth.
> **LIGHTING:** dark cozy night interior; key light = warm orange neon glow
> from upper right; fill = cool blue moonlight from a window on the left;
> objects softly rim-lit orange on their right edges.
> **PALETTE:** deep navy blues (#151a2c, #242c4a), warm woods (#5a3d20,
> #38291c), neon orange accent (#ff8a2a), mint green (#35c97e), soft red
> (#f0597a).
> **FORMAT:** transparent background PNG (unless noted), no text or logos baked
> in, no watermark, single object centered, crisp silhouette.

Consistency matters more than beauty: generate all assets in one session /
same seed-style so they read as one game.

---

## 1. Backgrounds (opaque, full-canvas, no transparency)

| File | Size (px) | Contents |
|---|---|---|
| `bg-den.png` | 800 × 1640 | The trading den, empty of interactive objects: navy wall, wood plank floor (bottom 27%), round rug center-bottom, empty desk from x≈3%–75% at y≈57–61% with an orange LED strip under its lip, warm ambient. **Leave clear zones** (objects are composited on top): window x 5–42% y 25–41%; wall right x 78–96% y 27–39% (clipboard); desk-top center x 25–75% y 41–57% (monitor+terminal); right wall x 77–98% y 45–74% (door); floor-left x 2–33% y 76–92% (table); floor-right x 62–80% y 76–89% (bot). |
| `bg-shop.png` | 800 × 1640 | Warm bistro deli interior: dark wood walls, wainscot, two pendant lamps with visible light cones, shelf of glass jars up top, big glass display counter across the middle (y≈36–51%) with empty glass case (food is composited inside), checkerboard floor bottom 25%. |
| `bg-study.png` | 800 × 1640 | Cozy night study: desk lamp warm glow left, window with stars right, big empty corkboard center (y≈15–60%, it gets the order list overlaid), wood floor. |
| `bg-market.png` | 800 × 1640 | Outdoor night market stall: purple-and-cream striped tent canopy top, string lights, empty card-display rack center (y≈18–64%, cards composited), grass/cobble bottom. |

## 2. The pets — 3 species × 4 moods (12 files)

All: 500 × 520 px, transparent, character centered, feet at bottom edge ±20 px,
consistent camera (straight-on, slight top-down), same scale across all 12.

| Species | Identity |
|---|---|
| `pet-bullo-*` | **Bullo the bull** — chubby round mint-green bull calf, small white crescent horns curving up, tiny ears, pale muzzle, stubby legs. The eternal long. |
| `pet-bera-*` | **Bera the bear** — chubby warm-brown bear cub, big round ears, cream muzzle + tummy patch, stubby paws. Respect the downside. |
| `pet-botto-*` | **Botto the bot** — chunky rounded steel robot, dark visor face with glowing expression, candlestick-shaped antenna, yellow shoulder bolts, little tank-tread feet. |

Mood poses (suffix):
- `*-thriving` — beaming smile, blushing, sparkles/hearts around, bouncy pose. Botto: visor face glows **mint green**.
- `*-uneasy` — flat worried mouth, slightly slumped, one sweat drop. Botto: visor glows **amber**.
- `*-critical` — panicking: wide eyes, open wailing mouth, multiple sweat drops, trembling pose lines. Botto: visor glows **red**, antenna spark.
- `*-idle` — asleep sitting, closed content eyes, "z z z" NOT baked in (we animate it), relaxed.

Example prompt (Bullo thriving):
> [STYLE GUIDE] + "cute chubby round mint-green baby bull mascot, small white
> crescent horns, tiny ears, pale muzzle, stubby legs, beaming happy smile with
> blush, bouncy joyful pose, sparkles around, full body, mobile game pet
> mascot, transparent background"

## 3. Interactive objects (transparent PNGs)

Composited at these exact layout boxes (design grid 400×820 → export @2x):

| File | Size (px) | Layout box | Contents |
|---|---|---|---|
| `obj-monitor.png` | 400 × 300 | x100 y336 w200 h128 + stand | Big desk monitor, **screen itself pure dark navy and EMPTY** (live account value + chart are rendered on top by the app), stylish bezel, small stand. |
| `obj-terminal.png` | 140 × 200 | x28 y386 w66 h96 | Small retro CRT terminal on the desk, dark green-tinted empty screen (prompt lines overlaid by app), chunky keyboard ledge. |
| `obj-clipboard.png` | 130 × 220 | x322 y222 w58 h100 | Wooden clipboard hanging on the wall, metal clip, cream paper (lines overlaid by app). |
| `obj-door.png` | 160 × 540 | x314 y346 w74 h270 | Wooden door with panels, brass knob, small blue "EXIT" LED sign above the frame. |
| `obj-table.png` | 240 × 220 | x23 y640 w110 h106 | Small round wooden side table with a white ceramic plate on top (food itself may be baked in: pizza slice + apple + cheese). |
| `obj-bot.png` | 120 × 200 | x258 y620 w48 h94 | A *different* mini helper robot (not Botto): boxy, cyan eyes, standing idle. |

## 4. Food (Feed shop, transparent, 200 × 200 each)

`food-apple.png` ($10) · `food-pizza.png` ($20) · `food-burger.png` ($50) ·
`food-cake.png` ($100) · `food-bento.png` (custom) — each a single painted food
item on a small ceramic plate, same angle/scale, appetizing casual-game style.

## 5. Rules that make or break it

1. **One session, one style.** Regenerate outliers until the set is uniform.
2. Silhouettes must read at 25% size (test by zooming out).
3. No baked-in text anywhere (billboard, monitor, signs are live app layers).
4. Respect the empty zones in backgrounds — live UI is composited there.
5. Export PNG with real transparency (no white halos — matte on dark navy).

## 6. Skins / alternate looks (additive, any time later)

The built-in SVG art is the **default skin**. Extra looks are variant files with
a dot suffix, listed in the manifest like any asset:

```
obj-door.neon.png          ← alternate look for the door
bg-den.winter.png          ← seasonal den background
pet-bullo-thriving.royal.png  (all 4 moods needed per pet skin)
```

Selection is per slot via `window.__gmSetSkin(slot, name)`:
`__gmSetSkin('door','neon')` · `__gmSetSkin('bg-den','winter')` ·
`__gmSetSkin('pet','royal')` · back to default: `__gmSetSkin('door','default')`.
Choice persists in localStorage (`hliq_game_skins`). Resolution order:
**selected variant → base painted asset → built-in SVG** — so a missing file
never breaks anything. The future in-game shop is just UI over `__gmSetSkin`.

Slots: `feed` `terminal` `list` `door` `bots` `monitor` `pet` `food`
`bg-den` `bg-shop` `bg-study` `bg-market`.

## Workflow

1. Generate → drop files in `public/game/` → add names to `manifest.json`.
2. `npm run build` + deploy (or ask Claude to deploy).
3. Anything missing stays SVG — ship art incrementally, pets first (biggest win),
   then `bg-den`, then objects, then the other backgrounds.
