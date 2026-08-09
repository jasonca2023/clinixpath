import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Crosshair } from "lucide-react";
import { gapImpact, topPriority } from "../lib/scoring.js";
import { categoryLabel } from "./PatientChecklist.jsx";

/**
 * The one question to ask first.
 *
 * Everything else in this app reports state. This panel gives an instruction, and
 * an instruction has to earn its volume: the number on screen is the count of
 * trials that would finish outright if this single gap came back MET, computed by
 * actually rescoring under that hypothetical in `gapImpact`, not by counting how
 * often the phrase appears.
 *
 * That distinction is the whole reason the copy branches below. `touches` is how
 * many trials mention a gap and it is always the larger, more flattering number;
 * reporting it as though it were `resolves` would be a claim the arithmetic never
 * made. So when nothing resolves, the headline changes shape and says so plainly
 * rather than dressing up reach as leverage.
 */

const prefersStillness = () =>
  typeof window === "undefined" ||
  typeof window.matchMedia !== "function" ||
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Runs the headline figure from wherever it currently sits to `target`, and hands
 * back the raw float so the numeral and the leverage bar ride one value rather than
 * two timelines that drift out of step.
 *
 * It interpolates from the previous reading, not from zero, because after the first
 * paint every change to this number is a recalculation: watching 7 walk down to 4
 * when an answer lands says something true about what just happened, whereas a
 * reset to zero would read as a fresh page.
 *
 * Reduced motion is settled in the initial state, not just in the effect, since an
 * effect fires after paint and would flash a wrong figure at the one user who asked
 * for none of this.
 */
function useTally(target, duration = 560) {
  const [exact, setExact] = useState(() => (prefersStillness() ? target : 0));
  const fromRef = useRef(prefersStillness() ? target : 0);

  useEffect(() => {
    if (prefersStillness()) {
      fromRef.current = target;
      setExact(target);
      return undefined;
    }

    const from = fromRef.current;
    let raf = 0;
    const started = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - started) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const next = from + (target - from) * eased;
      fromRef.current = next;
      setExact(next);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);

  return exact;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/* Stable empties: a fresh literal each render would invalidate the memo below on
   every keystroke the parent handles, and rescoring the whole matrix is the one
   piece of work in this panel worth not repeating. */
const NO_TRIALS = [];
const NO_ANSWERS = {};

/**
 * The affected studies, named. A leverage claim you cannot audit is a slogan, so
 * the ids are always on screen; only the overflow is folded away.
 */
function NctList({ ids, max }) {
  const shown = ids.slice(0, max);
  const rest = ids.length - shown.length;

  return (
    <div className="flex flex-wrap items-center gap-1">
      {shown.map((id) => (
        <span
          key={id}
          className="rounded border border-rule px-1.5 py-0.5 font-mono text-xs text-ink-3"
        >
          {id}
        </span>
      ))}
      {rest > 0 && (
        <span className="font-mono text-xs text-ink-3">
          and {rest} more
        </span>
      )}
    </div>
  );
}

/** Renders as a button only when the parent gave us somewhere to send the click. */
function Focusable({ onActivate, className, children }) {
  if (!onActivate) return <div className={className}>{children}</div>;
  return (
    <button
      type="button"
      onClick={onActivate}
      className={`${className} w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-paper-inset active:translate-y-px`}
    >
      {children}
    </button>
  );
}

export default function GapPriority({ trials, answers, onFocusGap }) {
  const list = Array.isArray(trials) ? trials : NO_TRIALS;
  const settled = answers ?? NO_ANSWERS;

  const { top, runners, open } = useMemo(() => {
    const impact = gapImpact(list, settled);
    return {
      top: topPriority(list, settled),
      runners: impact.slice(1, 5),
      open: impact.length,
    };
  }, [list, settled]);

  // `resolves` beats `touches` for the headline whenever it exists, so the tally
  // has to be picked before the hook runs; hooks cannot sit behind the null guard.
  const decisive = (top?.resolves ?? 0) > 0;
  const headline = decisive ? (top?.resolves ?? 0) : (top?.touches ?? 0);
  const running = useTally(headline);

  if (!top) return null;

  const total = Math.max(list.length, 1);
  const trialWord = total === 1 ? "trial" : "trials";
  const focus = typeof onFocusGap === "function" ? onFocusGap : null;
  const width = Math.max(0, Math.min(100, (running / total) * 100));

  return (
    <section className="enter-content panel-inset">
      <div className="block-label justify-between">
        <div className="flex min-w-0 items-center gap-2.5">
          <Crosshair
            className={`h-4 w-4 shrink-0 ${decisive ? "text-accent" : "text-hold"}`}
            strokeWidth={2.25}
          />
          <h2 className="truncate text-sm font-semibold tracking-tight text-ink">
            Ask this first
          </h2>
        </div>
        <span className="shrink-0 font-mono text-xs uppercase tracking-wider text-ink-3">
          {plural(open, "open question")}
        </span>
      </div>

      <Focusable
        onActivate={focus ? () => focus(top.key) : null}
        className="block px-4 py-4 transition-colors duration-mid ease-out hover:bg-paper-2/40"
      >
        <h3 className="text-lg font-semibold leading-snug tracking-tight text-ink">
          {top.action}
        </h3>

        <div
          className="enter-content mt-3 flex items-baseline gap-2.5"
        >
          <span
            className={`value shrink-0 text-3xl font-semibold leading-none ${
              decisive ? "text-accent" : "text-hold"
            }`}
          >
            {Math.round(running)}
          </span>
          <p className="min-w-0 text-sm leading-relaxed text-ink-2">
            {decisive ? (
              <>
                of your {total} {trialWord} would move straight to likely
                eligible once this is answered.{" "}
                <span className="font-medium text-ink">
                  Ask about this first.
                </span>
              </>
            ) : (
              <>
                of your {total} {trialWord} raise this, and no other open
                question touches more. It closes none of them outright, so it is
                groundwork rather than a shortcut.
              </>
            )}
          </p>
        </div>

        <div
          className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-rule/70"
          aria-hidden="true"
        >
          <span
            className={`block h-full rounded-full ${decisive ? "bg-accent" : "bg-hold"}`}
            style={{ width: `${width}%` }}
          />
        </div>

        {top.advances > 0 && (
          <p
            className="enter-content mt-2.5 text-sm leading-relaxed text-ink-3"
          >
            {decisive
              ? `Another ${plural(top.advances, "trial")} would move forward without closing.`
              : `It does move ${plural(top.advances, "trial")} forward.`}
          </p>
        )}

        <div
          className="enter-content mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-1.5"
        >
          <span className="font-mono text-xs uppercase tracking-wider text-ink-3">
            {categoryLabel(top.category)}
          </span>
          {/* Only worth saying when reach and leverage differ. If every trial that
              raises this also closes on it, the headline already said it. */}
          {decisive && top.touches > top.resolves && (
            <span className="font-mono text-xs uppercase tracking-wider text-ink-3">
              raised by {top.touches} of {total}
            </span>
          )}
        </div>

        <div className="mt-2">
          <NctList ids={top.trials} max={6} />
        </div>

        {top.criteria.length > 0 && (
          <p
            className="enter-content mt-3 border-l-2 border-rule pl-2.5 text-sm leading-relaxed text-ink-3"
          >
            {top.criteria[0]}
            {top.criteria.length > 1 && (
              <span className="font-mono text-xs text-ink-3">
                {" "}
                (+{top.criteria.length - 1} more wordings)
              </span>
            )}
          </p>
        )}
      </Focusable>

      {runners.length > 0 && (
        <div className="border-t border-rule/70">
          <div className="px-4 pb-1.5 pt-3">
            <span className="eyebrow">Then</span>
          </div>
          <ul className="divide-y divide-rule/60">
            {runners.map((item, i) => (
              <li
                key={item.key}
                className="enter-content"
              >
                <Focusable
                  onActivate={focus ? () => focus(item.key) : null}
                  className="flex items-start gap-2.5 px-4 py-2.5 transition-colors duration-mid ease-out hover:bg-paper-2/40"
                >
                  <span className="mt-0.5 shrink-0 font-mono text-xs text-ink-3">
                    {String(i + 2).padStart(2, "0")}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm leading-snug text-ink-2">
                      {item.action}
                    </span>
                    <span className="mt-1 block">
                      <NctList ids={item.trials} max={3} />
                    </span>
                  </span>
                  {/* Deliberately colourless. The top item owns the only tinted
                      figure in this panel; giving the runners a tone too would
                      flatten the ranking back into a table. */}
                  <span className="shrink-0 text-right">
                    <span className="value block text-sm font-semibold leading-none text-ink-2">
                      {item.resolves > 0 ? item.resolves : item.touches}
                    </span>
                    <span className="mt-1 block font-mono text-xs uppercase tracking-wider text-ink-3">
                      {item.resolves > 0
                        ? "closes"
                        : item.touches === 1
                          ? "trial"
                          : "trials"}
                    </span>
                  </span>
                  {focus && (
                    <ChevronRight
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-3"
                      strokeWidth={2}
                    />
                  )}
                </Focusable>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
