import { Lock } from "lucide-react";
import ThemeToggle from "./ThemeToggle.jsx";

/**
 * Console masthead.
 *
 * The same rules-above-and-below masthead the landing page carries, so crossing
 * the terms gate does not feel like arriving in a different product. It was a
 * sticky translucent bar with a backdrop blur, a rounded logo tile and a
 * hover-card tooltip — app chrome, in a product whose whole visual argument is
 * that it behaves like a printed clinical document. Documents do not have
 * floating toolbars.
 *
 * The privacy claim stays, because it is the one fact that distinguishes this
 * tool, but it moves into the dateline where a document states its handling
 * conditions rather than into a badge with a hover panel behind it.
 */
export default function Header() {
  return (
    <header className="sticky top-0 z-40 border-b border-rule bg-paper/85 backdrop-blur-md">
      <div className="mx-auto flex max-w-[1120px] flex-wrap items-center gap-x-md gap-y-2xs px-md py-sm sm:px-lg">
        <div className="flex min-w-0 shrink-0 items-center gap-sm">
          <Mark />
          <h1 className="font-display text-lg font-semibold tracking-tightish text-ink">
            ClinixPath
          </h1>
        </div>

        {/* The handling claim, inline in the bar rather than on its own dateline
            strip. It is the product's single distinguishing fact, so it stays
            visible — but it is a status, not a masthead. */}
        <span className="inline-flex min-w-0 items-center gap-xs rounded-[var(--radius-sm)] bg-accent-soft px-xs py-0.5 font-mono text-xs text-accent">
          <Lock className="h-3 w-3 shrink-0" strokeWidth={2.5} />
          <span className="truncate">De-identified on this device</span>
        </span>

        <div className="ml-auto flex shrink-0 items-center gap-sm">
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}

/**
 * The mark.
 *
 * Was a blue rounded-square tile with a squiggle inside it — the default app-icon
 * gesture, and the same shape as every other product on a phone home screen. A
 * tile also fights the masthead: it is a piece of chrome sitting next to a
 * wordmark, adding a container nobody asked for.
 *
 * This draws the product's actual output instead: four criterion rows, one of
 * them resolved. The rows are ink; the resolved one is the only filled block, so
 * the mark carries the same argument as the interface — a page of neutral
 * evidence with a single decisive mark in it. No tile, no fill behind it, so it
 * sits in the text block as a glyph rather than as an icon.
 *
 * Drawn on a 32-unit grid with square caps, which keeps it crisp at 24px where
 * a rounded stroke would blur into a smudge.
 */
function Mark({ className = "h-[26px] w-[26px]" }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={className}
      aria-hidden="true"
      fill="none"
    >
      {/* The bracket. Two halves that do not meet, because the whole product is
          the act of closing the distance between them. */}
      <path
        d="M11 4H5v24h6"
        stroke="var(--color-ink)"
        strokeWidth="2.75"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
      <path
        d="M21 4h6v24h-6"
        stroke="var(--color-ink)"
        strokeWidth="2.75"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
      {/* The patient inside it: a single stroke that steps up and holds — the
          path in ClinixPath, drawn as an actual course through the criteria
          rather than as an abstract flourish. */}
      <path
        d="M9 21l4 0 3-9 3 5h4"
        stroke="var(--color-ink)"
        strokeWidth="2.25"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
    </svg>
  );
}
