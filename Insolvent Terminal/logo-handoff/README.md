# Insolvent — Logo Handoff (Terminal Prompt)

A small, self-contained handoff package for implementing the **Insolvent "Terminal Prompt" logo** in any codebase. Designed for a developer (or Claude Code) to drop in.

## What this is

The bundle contains design references for a single logo direction:

> `> insolvent ▮`

A wordmark rendered in **IBM Plex Mono**, with an **electric green prompt caret** (`>`) and a **blinking block cursor** at the end. It frames the brand as a CLI / terminal — fitting the product name "Insolvent Terminal."

These files are **design references**, not production code. The HTML and SVG show intended look and behavior; recreate them in your codebase using its existing patterns (React component, Vue SFC, Svelte, plain HTML/CSS, etc.).

## Concept

- **The prompt (`>`)** signals a command line — the user is *typing* the word "insolvent" into a terminal.
- **The blinking cursor** suggests the brand is mid-thought, mid-trade, mid-action. Insolvency is always one tick away.
- **Mono type** roots the brand in technical, no-bullshit territory — adjacent to Bloomberg, IRC, vim, and the trader's terminal.

## Type

| | |
|---|---|
| Family | **IBM Plex Mono** ([Google Fonts](https://fonts.google.com/specimen/IBM+Plex+Mono)) |
| Weight | **500 (Medium)** for the wordmark, **400 (Regular)** for the prompt `>` |
| Letter-spacing | `-0.02em` |
| Line-height | `1` |
| Case | All lowercase |

Acceptable swap: **JetBrains Mono 500** (slightly more geometric).
Do not use: any non-mono font.

## Color

Dark theme (canonical):

| Role | Token | Value |
|---|---|---|
| Foreground (wordmark) | `--fg` | `#e5e9f0` |
| Accent (prompt + cursor) | `--accent` | `oklch(0.78 0.18 142)` (electric green, ≈ `#84e96b`) |
| Background | `--bg` | `#0c0f15` |

Light theme:

| Role | Value |
|---|---|
| Foreground | `#15171c` |
| Accent | `oklch(0.55 0.18 142)` (≈ `#3aa337`) |
| Background | `#fafaf7` |

The wordmark is monochromatic; only the prompt and cursor carry the accent.

## Sizing & clear space

- **Min size**: 64px wide for the full lockup. Below that, drop the prompt and cursor and use **just the lowercase `i` glyph** as the favicon/mark.
- **Cap height** = 1 unit. Maintain at least **1 unit of clear space** on all sides.
- **Cursor block** is **50% of cap-height wide** and **96% of cap-height tall**, with **8px gap** to the last letter.
- **Prompt `>`** sits with a **4px right margin** before the wordmark begins.

## Animation

The cursor **blinks at 1Hz** using a CSS `steps(1)` animation — solid for 0.5s, hidden for 0.5s. It is not a smooth fade.

```css
@keyframes blink { 50% { opacity: 0; } }
.cursor { animation: blink 1s steps(1) infinite; }
```

For static contexts (favicons, business cards, screenshots), freeze the cursor in its **solid (visible)** state.

## Do's and don'ts

✅ Use on dark `#0c0f15` or warm dark `#0d0c0b` backgrounds.
✅ Animate the cursor in interactive surfaces (web header, splash, loading state).
✅ Pair with tabular-figure mono numerals elsewhere in the UI.

❌ Don't replace the prompt `>` with any other glyph (`$`, `#`, `~`).
❌ Don't change the cursor shape (no underscore, no I-beam, no pipe).
❌ Don't use a non-monospace font, even for the wordmark.
❌ Don't skew, outline, or apply gradients.
❌ Don't tint the wordmark — it stays neutral fg.

## Files in this bundle

```
logo/
├── insolvent-logo.html       # Reference HTML — open in a browser to see it live
├── insolvent-logo.svg        # Static SVG (cursor solid, no animation)
├── insolvent-logo-mark.svg   # Mono "i" mark for favicons / small contexts
├── react-component.jsx       # React port — copy/paste into any React app
└── README.md                 # This file
```

## Implementation notes for developers

### React (JSX)

See `react-component.jsx`. Single component, no dependencies beyond React + a CSS file.

### Plain HTML/CSS

```html
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<div class="insolvent-logo">
  <span class="prompt">&gt;</span>
  <span class="word">insolvent</span>
  <span class="cursor" aria-hidden="true"></span>
</div>
```

```css
.insolvent-logo {
  font-family: 'IBM Plex Mono', monospace;
  font-weight: 500;
  font-size: 32px;          /* scale freely */
  letter-spacing: -0.02em;
  line-height: 1;
  color: #e5e9f0;
  display: inline-flex;
  align-items: center;
  gap: 0.08em;
}
.insolvent-logo .prompt {
  color: #84e96b;            /* or oklch(0.78 0.18 142) */
  font-weight: 400;
  margin-right: 0.12em;
}
.insolvent-logo .cursor {
  display: inline-block;
  width: 0.5em;
  height: 0.96em;
  background: #84e96b;
  margin-left: 0.12em;
  animation: insolvent-blink 1s steps(1) infinite;
}
@keyframes insolvent-blink { 50% { opacity: 0; } }
```

### Tailwind / utility-first

If your app uses Tailwind, the same CSS above works as arbitrary values, or you can extract them into a small `Logo` component. Don't try to express the cursor with utility classes alone — keep the keyframes in your global stylesheet.

### Native (iOS / Android)

For native, use IBM Plex Mono Medium 500 as a bundled font. Render `>`, `insolvent`, and a 50%×96% accent-colored rectangle in a horizontal stack with a 1Hz `Animation.repeating` opacity toggle (no easing — step transition).

## Favicon

Use `insolvent-logo-mark.svg` (just the lowercase `i` glyph in mono) for 16/32/48px favicons. The full lockup is illegible at favicon size.

For larger app icons (180px, 512px), render the mark on a **rounded-square accent-green tile** (radius 22%, padding 18%).

## Questions or follow-ups

If you need:
- An **SVG with animated cursor** (CSS-driven, embed-friendly)
- The **full PWA icon set** (16, 32, 48, 96, 144, 180, 192, 512)
- A **dark-on-light variant** locked down
- A **monochrome black/white emergency variant**

…ask the design team. The above is the canonical lockup; other variants should derive from it without changing the type, color, or cursor mechanic.
