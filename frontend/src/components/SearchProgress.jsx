import { useEffect, useRef, useState } from "react";
import { Check, Clock, Lock, X } from "lucide-react";

/**
 * The wait, as its own screen.
 *
 * WHY A WHOLE PAGE. This started as a panel under the intake form, which meant a
 * live progress readout sat beneath a still-editable form full of inputs the run
 * had already consumed — two competing "current steps" on one screen, and the
 * form implying an edit could still change the run it had already started. A run
 * is a distinct state of this app, so it gets a distinct view: nothing on screen
 * belongs to any other step.
 *
 * WHY NOT A SPINNER. A discovery run takes 30–90 seconds against a free-tier
 * model. The perceived-performance literature is consistent here: a spinner suits
 * sub-3-second waits, a skeleton a few seconds, and past roughly ten seconds the
 * user needs to know WHAT is happening and that it is still moving, or they
 * conclude the app has hung and reload.
 *
 * WHAT IS NOT CLAIMED. The backend streams no progress events, so the UI cannot
 * know which stage is live. Rather than invent a percentage — the one thing that
 * would make this dishonest — stages advance on measured typical timings, the
 * copy says so plainly, and the elapsed clock is real. That clock is the only
 * hard number on screen and the one that proves nothing has stalled.
 */

/* The terminal stage must be the one that genuinely owns the long tail. An
   earlier build ended on "Ranking by distance", which the server reaches in
   milliseconds, so past the last threshold the list sat fully ticked with one
   row spinning forever — at 02:32 it read as a hang. Scoring is the long pole;
   ranking is folded into it rather than given a row it would hold for a minute. */
const DISCOVER_STAGES = [
  { label: "Reading the record", detail: "Deriving the condition to search", at: 0 },
  { label: "Searching the registry", detail: "ClinicalTrials.gov, recruiting only", at: 14 },
  {
    label: "Scoring each trial",
    detail: "Criterion by criterion, then ranked by how close the patient is",
    at: 20,
  },
];

const ANALYZE_STAGES = [
  { label: "Fetching the protocol", detail: "Eligibility criteria from the registry", at: 0 },
  {
    label: "Cross-referencing",
    detail: "Criterion by criterion, every verdict traced to a quote",
    at: 8,
  },
];

const prefersStillness = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export default function SearchProgress({
  active,
  mode = "discover",
  fileName,
  onCancel,
  // Streamed from the server: {condition, found, total, trials[]}. When present
  // the stages report what actually happened instead of what usually happens.
  progress,
}) {
  const [elapsed, setElapsed] = useState(0);
  const startedAt = useRef(null);

  useEffect(() => {
    if (!active) {
      startedAt.current = null;
      setElapsed(0);
      return undefined;
    }
    startedAt.current = Date.now();
    const id = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000)),
      1000,
    );
    return () => window.clearInterval(id);
  }, [active]);

  /* Hold the document still for the duration of the run.
   *
   * The container is already viewport-height with overflow hidden, but the
   * BODY can still scroll behind it — on a trackpad or a phone that produces
   * rubber-banding against a page with nowhere to go, which reads as the app
   * being broken rather than busy.
   *
   * The previous value is restored rather than assumed to be "", so this cannot
   * clobber an overflow another component set. */
  useEffect(() => {
    if (!active) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [active]);

  if (!active) return null;

  const single = mode === "analyze";
  const stages = single ? ANALYZE_STAGES : DISCOVER_STAGES;
  const still = prefersStillness();

  // Real progress when the server is streaming it, the measured timings only as
  // a fallback for the single-trial audit (which has nothing to report) and for
  // the moments before the first event lands.
  const scored = progress?.trials?.length ?? 0;
  const timed = stages.reduce((acc, s, i) => (elapsed >= s.at ? i : acc), 0);
  const streamed =
    progress?.total != null ? 2 : progress?.found != null ? 1 : null;
  const activeIndex = Math.min(
    streamed ?? timed,
    stages.length - 1,
  );

  // The stage detail becomes a count once the denominator is known. This is the
  // line the old copy had to disclaim as "typical sequence, not live progress";
  // it is now the literal number of trials the server has finished.
  const liveDetail = (index) => {
    if (!progress) return null;
    if (index === 1 && progress.found != null) {
      return `${progress.found} recruiting studies found`;
    }
    if (index === 2 && progress.total != null) {
      return `${scored} of ${progress.total} scored`;
    }
    return null;
  };

  return (
    <main
      // `min-h-0` is what makes the flex parent actually clip instead of growing
      // to fit its content — without it a flex child's implicit `min-height:auto`
      // silently defeats the parent's overflow-hidden and the page scrolls again.
      className="progress-screen mx-auto flex w-full min-h-0 max-w-[720px] flex-1 flex-col px-md pb-lg pt-[6vh] sm:px-lg"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="progress-enter">
        <p className="eyebrow text-accent">
          {single ? "Auditing" : "Screening"}
        </p>
        <h1 className="mt-sm font-display text-display-s font-bold leading-[1.05] tracking-display text-ink">
          {single
            ? "Checking the record against this protocol."
            : "Finding the trials this patient can join."}
        </h1>

        <div className="mt-md flex flex-wrap items-center gap-x-md gap-y-2xs text-sm text-ink-3">
          {fileName && <span className="font-mono">{fileName}</span>}
          {/* The only hard number on screen. Proves motion when nothing else can. */}
          <span className="value font-mono tabular-nums text-ink-2">
            {String(Math.floor(elapsed / 60)).padStart(2, "0")}:
            {String(elapsed % 60).padStart(2, "0")}
          </span>
        </div>


        <ol className="mt-lg">
          {stages.map((stage, i) => {
            const done = i < activeIndex;
            const running = i === activeIndex;
            return (
              <li
                key={stage.label}
                className={`relative flex items-start gap-md overflow-hidden border-t border-rule py-sm first:border-t-0 ${
                  running ? "" : "opacity-60"
                }`}
              >
                <span className="mt-1 flex h-4 w-4 shrink-0 items-center justify-center">
                  {done ? (
                    <Check className="h-4 w-4 text-ok" strokeWidth={2.75} />
                  ) : running ? (
                    <span className={still ? "stage-mark" : "stage-mark is-live"} />
                  ) : (
                    <span className="h-1.5 w-1.5 rounded-full bg-rule-strong" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    // Same size and face in both states; only weight and colour
                    // change. Swapping to a larger type ramp on the running row
                    // resized it, which is the other half of the jump.
                    className={`block font-display text-lg leading-snug transition-colors duration-mid ease-out ${
                      running ? "font-semibold text-ink" : "font-medium text-ink-3"
                    }`}
                  >
                    {stage.label}
                  </span>
                  {/* Always rendered, only faded. Mounting it on transition
                      changed the list's height, and with the page centred that
                      moved every element on screen — a jump with no cause the
                      user could see. Reserving the space costs nothing. */}
                  <span
                    className={`mt-1 block text-sm leading-relaxed text-ink-3 transition-opacity duration-mid ease-out ${
                      running ? "opacity-100" : "opacity-0"
                    }`}
                  >
                    {liveDetail(i) ?? stage.detail}
                  </span>
                </span>
                {/* The one moving thing on the page, and it sits on the row that
                    is actually running: a hairline creeping along the active
                    stage's rule. Indeterminate on purpose — the backend streams
                    no progress, so a bar that filled to 100% would be a claim we
                    cannot make. */}
                {running && !still && <span className="stage-crawl" />}
              </li>
            );
          })}
        </ol>

        {/* Past the point where a run is normally done, say so. Silence while a
            clock ticks past two minutes is what makes a user reload; naming the
            cause and the ceiling turns an unexplained wait into an expected one.
            The numbers match the server's real timeouts. */}
        {elapsed >= 100 && (
          <p className="mt-lg flex items-start gap-sm rounded-[var(--radius-md)] border border-hold/30 bg-hold/[0.07] px-md py-sm text-sm leading-relaxed text-hold">
            <Clock className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2.25} />
            <span>
              Longer than usual. Free-tier model providers queue behind paid
              traffic. If the model does not answer, this stops on its own with a
              clear error. There is no need to reload.
            </span>
          </p>
        )}

        {/* A way out. The guidance for waits this long is unanimous that the
            user must stay in control of the process, and without this the only
            exit from a two-and-a-half-minute run is reloading the tab — which
            throws away the parsed, scrubbed, human-approved text and makes them
            do the whole intake again. Stopping keeps all of it staged. */}
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="mt-lg inline-flex items-center gap-xs rounded-[var(--radius-md)] border border-rule-strong px-md py-2 text-sm font-medium text-ink-2 transition-colors duration-fast ease-out hover:border-ink-3 hover:text-ink"
          >
            <X className="h-3.5 w-3.5" strokeWidth={2.5} />
            Stop this run
          </button>
        )}

        <div className="mt-lg border-t border-rule pt-md">
          <p className="flex items-start gap-sm text-sm leading-relaxed text-ink-3">
            <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" strokeWidth={2.25} />
            <span>
              {progress
                ? "Live progress, reported by the server as each trial finishes. Nothing about the record left this device beyond the text you approved."
                : "Typical sequence, not live progress. The clock is real. Nothing about the record left this device beyond the text you approved."}
            </span>
          </p>
        </div>
      </div>
    </main>
  );
}
