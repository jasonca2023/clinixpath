# Design — ClinixPath

A locked design system for this app. Every page redesign reads this file before
emitting code. Do not regenerate per page — extend or amend this file when the
system needs to grow.

## Genre

modern-minimal.

The reference is Ballpark: large tight-tracked display sans, off-white ground,
one saturated blue, generous whitespace, surfaces that lift. Adapted for clinical
work by keeping the register light-first and reserving colour for meaning.

## Macrostructure family

- **Marketing pages** — Marquee Hero. Centre-set display statement owns the fold;
  nothing competes with it. Varies on: hero eyebrow, secondary CTA presence.
- **App pages** — Stat-Led. The decisive count leads (trials screened, questions
  open); supporting detail sequences beneath it. Varies on: which stat leads.
- **Content / print** — Long Document (the printed brief in `print.css`). Untouched
  by this system: it prints greyscale and carries its own literal rules.

## Theme — custom "Protocol"

Full token block lives in [`tokens.css`](tokens.css). Anchors:

- `--color-paper` `oklch(97.5% 0.002 250)` — neutral leaf, **not** white
- `--color-paper-inset` `oklch(100% 0 0)` — surfaces are whiter than the ground
- `--color-ink` `oklch(17% 0.012 258)`
- `--color-rule` `oklch(90% 0.004 250)`
- `--color-accent` `oklch(52% 0.20 258)` — protocol blue
- `--color-focus` `oklch(52% 0.20 258)`

**Dark band** flips the ground to `oklch(16.5% 0.014 260)` and lifts the accent to
`oklch(70% 0.17 258)`. The dark ground carries a trace of the accent hue so blue
belongs to the surface instead of glowing on neutral charcoal. Pure black is
avoided — it maximises halation on thin type.

### The colour rule, and it is absolute

Blue means **interactive**. Green / amber / red / grey mean **result state**
(MATCH · borderline · CONFLICT · UNKNOWN). Neither borrows the other's job. There
is no decorative colour anywhere in this product.

## Typography

- Display: Instrument Sans, 600–700, roman, tracking `var(--track-display)` (-0.04em)
- Body: IBM Plex Sans, 400–500
- Mono: IBM Plex Mono — **measured values only**, so digits align in a column.
  Never a label font.
- Type scale anchor: `--text-display` = `clamp(2.75rem, 5.6vw + 0.5rem, 5.5rem)`

2+1 discipline: two text families, mono is the outlier. No italic headers, ever.

## Spacing

4-point named scale in `tokens.css`. Pages use named tokens (`var(--space-md)`),
never raw values.

## Motion

- Easings `--ease-out` / `--ease-in` / `--ease-in-out`. Never the browser default.
- Reveal: fade + 6–10px rise. Transform and opacity only.
- Reduced motion: global override in `index.css` collapses everything to ~0ms.
- Under three motion primitives per view.

## Microinteractions stance

- Silent success. No celebratory toasts anywhere in a clinical readout.
- Focus ring appears instantly — never animated.
- Hover tooltips delay 800ms; focus tooltips 0ms.

## Loading stance

Duration decides the pattern:

| Wait | Pattern |
| --- | --- |
| < 3s | nothing, or inline spinner |
| 3–10s | skeleton of the result shape |
| **10s+** | **named pipeline stages + real elapsed clock + result skeleton** |

Analysis runs are 30–90s, so they take the third row — see
`components/SearchProgress.jsx`. A bare spinner at that duration is
indistinguishable from a freeze and is banned in this product.

**Never fake progress.** The backend streams no progress events, so the UI must
not render a percentage or a completion bar it cannot substantiate. Stage
highlighting on measured typical timings is allowed *only* while labelled as a
typical sequence, alongside a real elapsed counter.

## CTA voice

- Primary: filled `--color-accent`, `--radius-md`, `--accent-ink` label, no gradient.
- Secondary: hairline `--color-rule-strong`, transparent fill.
- Never a pill. A pill button in a medical readout reads consumer.

## Containers

Surfaces lift. `.panel` = white fill + hairline + `--radius-lg` + `--shadow-card`.
`.panel-inset` = recessed, no shadow. `.instrument` = the audit readout, most
raised, and the **only** element that carries an accent edge.

Depth is a scale here exactly as rule weight was in the previous system:
`inset < panel < instrument`.

## Per-page allowances

- Marketing pages MAY use enrichment (Tier-A CSS art only).
- App pages MUST NOT use enrichment — function carries the page.
- The printed brief takes no theme colour at all; it prints greyscale.

## What pages MUST share

Wordmark · accent colour and its ≤5%-per-viewport placement · display + body
fonts · CTA voice · surface voice · the nav (N1b) and footer (Ft2) archetypes.

## What pages MAY differ on

Macrostructure within the family · hero archetype · enrichment on marketing only.
