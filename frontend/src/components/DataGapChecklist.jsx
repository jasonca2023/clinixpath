import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ClipboardCheck,
  Copy,
  Minus,
  PenLine,
  X,
} from "lucide-react";
import { categoryLabel } from "./PatientChecklist.jsx";
import {
  RESOLUTION,
  effectiveStatus,
  gapAction,
  gapImpact,
  gapKey,
  gapSlug,
} from "../lib/scoring.js";

/**
 * The work list, and the only place a gap can be closed.
 *
 * A DATA GAP is not a failure. It is the most actionable output the tool produces:
 * "order a CBC and this patient qualifies" is a task a coordinator can do today,
 * whereas an UNKNOWN row buried in a matrix is just an absence. Every gap across
 * every trial collapses into one deduplicated list, ordered by how much answering
 * it would buy.
 *
 * Answering happens here rather than in the matrix because the same question often
 * belongs to several trials at once. `gapKey` is shared identity, so one answer
 * settles the question everywhere and the candidate list resorts immediately with
 * no request in flight.
 *
 * The component owns no answer state. The parent holds the map and merges each
 * patch, because the scoring the whole page reads from must have a single owner.
 */

const CHOICES = [
  {
    resolution: RESOLUTION.MET,
    label: "Met",
    icon: Check,
    on: "border-ok/50 bg-ok/12 text-ok",
  },
  {
    resolution: RESOLUTION.NOT_MET,
    label: "Not met",
    icon: X,
    on: "border-risk/50 bg-risk/12 text-risk",
  },
  {
    resolution: RESOLUTION.UNRESOLVED,
    label: "Unsure",
    icon: Minus,
    on: "border-rule-strong bg-paper-2 text-ink-2",
  },
];

const RESOLVED_STYLE = {
  [RESOLUTION.MET]: { label: "Met", tone: "text-ok" },
  [RESOLUTION.NOT_MET]: { label: "Not met", tone: "text-risk" },
};

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-paper-inset";

/**
 * The gaps the user has already settled.
 *
 * `gapImpact` deliberately drops these, since a settled gap is no longer a question
 * to prioritise. They still have to be reachable: a clinician who typed the wrong
 * haemoglobin needs a way back to it, so they are rebuilt here from raw status
 * UNKNOWN plus an effective status that has moved off it.
 */
function resolvedGaps(trials, answers) {
  const byKey = new Map();

  for (const trial of trials ?? []) {
    for (const node of trial?.compliance_matrix ?? []) {
      if (node?.status !== "UNKNOWN") continue;
      if (effectiveStatus(node, answers) === "UNKNOWN") continue;
      const key = gapKey(node);
      const entry = byKey.get(key) ?? {
        key,
        action: gapAction(node),
        category: node?.category,
        criteria: [],
        trials: new Set(),
      };
      if (node?.trial_rule) entry.criteria.push(node.trial_rule);
      if (trial?.nct_id) entry.trials.add(trial.nct_id);
      byKey.set(key, entry);
    }
  }

  return [...byKey.values()]
    .map((entry) => ({
      ...entry,
      trials: [...entry.trials],
      touches: entry.trials.size,
      resolution: answers?.[entry.key]?.resolution ?? RESOLUTION.UNRESOLVED,
    }))
    .sort((a, b) => b.touches - a.touches || a.action.localeCompare(b.action));
}

/** Three way control. Deliberately not a dropdown: one tap, and the choice is visible. */
function ResolutionControl({ item, value, onAnswer, compact }) {
  return (
    <div
      role="group"
      aria-label={`Resolution for ${item.action}`}
      className="flex flex-wrap gap-1.5"
    >
      {CHOICES.map((choice) => {
        const selected = value === choice.resolution;
        const Icon = choice.icon;
        return (
          <button
            key={choice.resolution}
            type="button"
            aria-pressed={selected}
            // `detail === 0` means the click came from Enter or Space rather than
            // a pointer. Only then does focus need rehoming: a mouse user has not
            // lost anything, and moving focus for them scrolls the page to
            // wherever the row went, which is halfway down a long panel.
            onClick={(event) =>
              onAnswer(
                item.key,
                { resolution: choice.resolution },
                { viaKeyboard: event.detail === 0 },
              )
            }
            className={`inline-flex flex-1 basis-[4.75rem] items-center justify-center gap-1.5 rounded-md border px-2 font-medium transition-colors duration-fast ease-out active:translate-y-px ${FOCUS_RING} ${
              compact ? "py-1 text-xs" : "py-1.5 text-xs"
            } ${
              selected
                ? choice.on
                : "border-rule text-ink-3 hover:border-rule-strong hover:bg-paper-2/60 hover:text-ink-2"
            }`}
          >
            <Icon className="h-3 w-3 shrink-0" strokeWidth={2.5} />
            {choice.label}
          </button>
        );
      })}
    </div>
  );
}

/** The note field. Its only job is to reach the printed brief. */
function ValueNote({ item, value, onAnswer }) {
  const id = `gap-note-${gapSlug(item.key)}`;
  return (
    <div className="mt-2.5">
      <label
        htmlFor={id}
        className="mb-1 flex items-center gap-1.5 font-mono text-xs uppercase tracking-[0.14em] text-ink-3"
      >
        <PenLine className="h-3 w-3" strokeWidth={2} />
        Value, note only
      </label>
      <input
        id={id}
        type="text"
        value={value}
        onChange={(event) => onAnswer(item.key, { value: event.target.value })}
        placeholder="ECOG 1, 8.2 g/dL"
        className={`field w-full px-2.5 py-1.5 font-mono text-sm ${FOCUS_RING}`}
      />
      {/* The caveat about a note not deciding anything is stated once, in the
          panel intro. It was repeated under every row, which added two lines to
          each of a dozen gaps and turned the list into a wall for a sentence the
          reader had already agreed to by the third time they met it. */}
    </div>
  );
}

/**
 * Stable DOM id for a gap row, so the priority panel can send a click here.
 * Derived from the same `gapKey` both sides already agree on, rather than an index,
 * which would break the moment answering something reorders the list.
 */
export function gapRowId(key) {
  return `gap-row-${gapSlug(key)}`;
}

/* Registry criteria are occasionally a whole paragraph of thresholds. One of them
   ran to ten lines of monospace inside a 420px rail, which on its own outran the
   results column beside it. Past this many characters the quote is clamped and the
   reader opts in to the rest. */
const QUOTE_CLAMP_CHARS = 120;

/* How many gaps stand open before the rest are folded away. Six is roughly a
   screen of work, and `gapImpact` has already put the highest leverage first. */
const VISIBLE_OPEN_GAPS = 6;

function OpenGap({ item, answer, onAnswer, index, highlighted }) {
  const criterion = item.criteria?.[0];
  const clampable = (criterion?.length ?? 0) > QUOTE_CLAMP_CHARS;
  const [quoteOpen, setQuoteOpen] = useState(false);

  return (
    <li
      id={gapRowId(item.key)}
      className={`enter-content scroll-mt-24 px-4 py-3.5 transition-colors duration-mid ease-out hover:bg-paper-2/40 ${
        highlighted ? "bg-accent/10" : ""
      }`}
    >
      <p className="text-sm leading-relaxed text-ink-2">{item.action}</p>

      {criterion && (
        <div className="mt-1.5 border-l-2 border-rule pl-2">
          <p
            className={`font-mono text-xs leading-relaxed text-ink-3 ${
              clampable ? "clamp" : ""
            }`}
            data-open={quoteOpen}
          >
            {criterion}
          </p>
          {clampable && (
            <button
              type="button"
              onClick={() => setQuoteOpen((v) => !v)}
              aria-expanded={quoteOpen}
              className={`mt-0.5 rounded font-mono text-xs uppercase tracking-wider text-ink-3 underline decoration-rule-strong underline-offset-2 transition-colors duration-fast ease-out hover:text-ink-2 ${FOCUS_RING}`}
            >
              {quoteOpen ? "Less" : "Full criterion"}
            </button>
          )}
        </div>
      )}

      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-mono text-xs uppercase tracking-wider text-ink-3">
          {categoryLabel(item.category)}
        </span>
        {/* `touches` is how many trials ASK the question, which is not the same as
            how many it would unblock. Saying "unblocks" here would overclaim on
            every gap that leaves other items still open. The unblock count is
            `resolves`, and it gets its own chip below. */}
        {item.touches > 1 && (
          <span className="rounded border border-accent/30 bg-accent/10 px-1.5 py-0.5 font-mono text-xs text-accent">
            asked by {item.touches} trials
          </span>
        )}
        {item.resolves > 0 && (
          <span className="rounded border border-ok/30 bg-ok/10 px-1.5 py-0.5 font-mono text-xs text-ok">
            completes {item.resolves}
          </span>
        )}
      </div>

      <div className="mt-2.5">
        <ResolutionControl
          item={item}
          value={answer?.resolution ?? RESOLUTION.UNRESOLVED}
          onAnswer={onAnswer}
        />
      </div>

      <ValueNote item={item} value={answer?.value ?? ""} onAnswer={onAnswer} />
    </li>
  );
}

/**
 * A settled gap, collapsed to one line.
 *
 * Reopening is a disclosure rather than a jump back into the open list, so changing
 * a mind never costs the user their place in a long list.
 */
function ResolvedGap({ item, answer, onAnswer, index, open, onToggle }) {
  const style = RESOLVED_STYLE[item.resolution] ?? RESOLVED_STYLE.MET;
  const note = answer?.value ?? "";

  return (
    <li
      className="enter-content relative"
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={`flex w-full items-start gap-2 px-4 py-2.5 text-left transition-colors duration-mid ease-out hover:bg-paper-2/40 ${FOCUS_RING}`}
      >
        <span className="min-w-0 flex-1">
          <span className="block text-sm leading-relaxed text-ink-3 line-through decoration-rule-strong">
            {item.action}
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={`font-mono text-xs uppercase tracking-wider ${style.tone}`}>
              {style.label}
            </span>
            {note && (
              <span className="truncate font-mono text-xs text-ink-3">
                {note}
              </span>
            )}
          </span>
        </span>
        <ChevronDown
          className={`mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-3 transition-transform duration-mid ease-out ${
            open ? "rotate-180" : ""
          }`}
          strokeWidth={2}
        />
      </button>

      <div className="disclose" data-open={open}>
        <div>
          <div className="px-4 pb-3">
            <ResolutionControl
              item={item}
              value={item.resolution}
              onAnswer={onAnswer}
              compact
            />
            <ValueNote item={item} value={note} onAnswer={onAnswer} />
          </div>
        </div>
      </div>
    </li>
  );
}

export default function DataGapChecklist({
  trials,
  answers = {},
  onAnswer,
  highlightKey,
}) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(() => new Set());
  // Closed by default. A settled gap is a receipt, not a task: it should be
  // available to audit and reversible, but it has no claim on the rail's height
  // once it is answered. Ten struck through rows pushed this panel past the
  // results column it sits beside.
  const [showResolved, setShowResolved] = useState(false);

  // Where focus should land after an answer moves a row between the two lists.
  // See `handleAnswer`.
  const resolvedToggleRef = useRef(null);
  const pendingFocus = useRef(null);

  const open = useMemo(() => gapImpact(trials, answers), [trials, answers]);
  const resolved = useMemo(() => resolvedGaps(trials, answers), [trials, answers]);

  // The gaps are already ordered by leverage, so the first few are the ones worth
  // acting on today. Showing all thirteen at full height made this panel taller
  // than the results column it sits beside, which is how the page ended up running
  // on with nothing next to it.
  const [showAllOpen, setShowAllOpen] = useState(false);
  // A click in the priority panel must always land on a row that exists. If the
  // gap it names is past the cut, the list opens rather than the click doing
  // nothing. Derived, not an effect, so the row is present on the same paint the
  // scroll goes looking for it.
  const highlightHidden =
    highlightKey != null &&
    open.findIndex((gap) => gap.key === highlightKey) >= VISIBLE_OPEN_GAPS;
  const expandedOpen = showAllOpen || highlightHidden;
  const overflowCount = Math.max(0, open.length - VISIBLE_OPEN_GAPS);
  const hiddenOpen = expandedOpen ? 0 : overflowCount;

  /**
   * Put focus back somewhere real after a row has been rehomed.
   *
   * Answering a gap unmounts the button that was just clicked, because the row
   * leaves the open list for the resolved one. The browser's fallback is to drop
   * focus on <body>, which sends a keyboard user back to the top of the document
   * on every single answer. No dependency array: this has to run after whichever
   * render actually rebuilt the lists.
   */
  useEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;

    if (target.type === "resolved") {
      // The row is now inside a section that is collapsed by default, so there is
      // nothing visible to focus in it. The group's own toggle is the honest
      // landing spot: it is on screen, and it says where the row went.
      resolvedToggleRef.current?.focus();
      return;
    }

    document
      .getElementById(gapRowId(target.key))
      ?.querySelector("button")
      ?.focus();
  });

  if (open.length === 0 && resolved.length === 0) return null;

  const handleAnswer = (key, patch, meta) => {
    // Pointer users keep their scroll position; see the note in ResolutionControl.
    if (patch?.resolution && meta?.viaKeyboard) {
      const was = answers[key]?.resolution ?? RESOLUTION.UNRESOLVED;
      const settled = (r) => r === RESOLUTION.MET || r === RESOLUTION.NOT_MET;
      // Only a move between the lists costs the user their place. Switching an
      // already-resolved row from Met to Not met keeps the same controls mounted,
      // so stealing focus there would be the bug rather than the fix.
      if (!settled(was) && settled(patch.resolution)) {
        pendingFocus.current = { type: "resolved" };
      } else if (settled(was) && !settled(patch.resolution)) {
        pendingFocus.current = { type: "open", key };
      }
    }
    onAnswer?.(key, patch);
  };

  const toggleExpanded = (key) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // Only the open items are worth carrying to a colleague; a settled gap is an
  // instruction to nobody.
  const copyOpen = async () => {
    const text = open
      .map(
        (item, i) =>
          `${i + 1}. ${item.action}${
            item.touches > 1 ? ` (asked by ${item.touches} trials)` : ""
          }`,
      )
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked; the list is still on screen to read */
    }
  };

  return (
    <section className="enter-content panel-inset">
      <div className="block-label flex-wrap justify-between">
        <div className="flex items-center gap-2.5">
          <ClipboardCheck className="h-4 w-4 text-hold" strokeWidth={2.25} />
          <h2 className="text-sm font-semibold tracking-tight text-ink">
            To obtain
          </h2>
          <span
            className={`rounded border px-1.5 py-0.5 font-mono text-xs transition-colors duration-mid ease-out ${
              open.length === 0
                ? "border-ok/30 bg-ok/10 text-ok"
                : "border-hold/30 bg-hold/10 text-hold"
            }`}
          >
            {open.length} open
          </span>
        </div>
        <button
          type="button"
          onClick={copyOpen}
          disabled={open.length === 0}
          className={`inline-flex items-center gap-1.5 rounded-md border border-rule px-2.5 py-1.5 text-xs text-ink-2 transition-colors duration-fast ease-out hover:border-rule-strong hover:text-ink active:translate-y-px disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:border-rule disabled:hover:text-ink-2 ${FOCUS_RING}`}
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-ok" strokeWidth={2.5} />
          ) : (
            <Copy className="h-3.5 w-3.5" strokeWidth={2} />
          )}
          {copied ? "Copied" : "Copy list"}
        </button>
      </div>

      {/* Instructions for answering, so they go when there is nothing left to
          answer. Keeping them would spend four lines explaining a control that
          is no longer on screen. */}
      {open.length > 0 && (
        <p className="border-b border-rule/70 px-4 py-2.5 text-sm leading-relaxed text-ink-3">
          Each item is a gap in the record, not a disqualification. Answer one
          and every trial that asked for it reranks at once, on this device,
          with nothing sent anywhere. The value box on a row is a note for the
          printed brief; it decides nothing, your Met or Not met choice sets the
          verdict.
        </p>
      )}

      {open.length > 0 && (
        <>
          <ul className="divide-y divide-rule/60">
            {open.slice(0, VISIBLE_OPEN_GAPS).map((item, index) => (
              <OpenGap
                key={item.key}
                item={item}
                index={index}
                answer={answers[item.key]}
                onAnswer={handleAnswer}
                highlighted={highlightKey === item.key}
              />
            ))}
          </ul>
          {/* The overflow is always mounted so it can be transitioned; the
              disclose hides it and takes it out of the tab order. */}
          <div className="disclose" data-open={expandedOpen}>
            <div>
              <ul className="divide-y divide-rule/60 border-t border-rule/60">
                {open.slice(VISIBLE_OPEN_GAPS).map((item, index) => (
                  <OpenGap
                    key={item.key}
                    item={item}
                    index={VISIBLE_OPEN_GAPS + index}
                    answer={answers[item.key]}
                    onAnswer={handleAnswer}
                    highlighted={highlightKey === item.key}
                  />
                ))}
              </ul>
            </div>
          </div>
          {overflowCount > 0 && (
            <button
              type="button"
              onClick={() => setShowAllOpen((v) => !v)}
              aria-expanded={expandedOpen}
              className={`flex w-full items-center justify-center gap-1.5 border-t border-rule/70 px-4 py-2.5 text-sm text-ink-3 transition-colors duration-mid ease-out hover:bg-paper-2/40 hover:text-ink-2 ${FOCUS_RING}`}
            >
              <ChevronDown
                className={`h-3.5 w-3.5 shrink-0 transition-transform duration-mid ease-out ${
                  expandedOpen ? "rotate-180" : ""
                }`}
                strokeWidth={2}
              />
              {hiddenOpen > 0
                ? `Show ${hiddenOpen} more ${hiddenOpen === 1 ? "gap" : "gaps"}`
                : "Show fewer"}
            </button>
          )}
        </>
      )}

      {open.length === 0 && (
        <p className="px-4 py-3.5 text-sm leading-relaxed text-ok">
          Every gap has an answer. The ranking now reflects all of them.
        </p>
      )}

      {resolved.length > 0 && (
        <div className="border-t border-rule/70 bg-paper/40">
          <button
            type="button"
            ref={resolvedToggleRef}
            onClick={() => setShowResolved((v) => !v)}
            aria-expanded={showResolved}
            className={`flex w-full items-center justify-between gap-2 px-4 py-2 text-left transition-colors duration-mid ease-out hover:bg-paper-2/40 ${FOCUS_RING}`}
          >
            <span className="flex items-center gap-1.5">
              <ChevronDown
                className={`h-3.5 w-3.5 shrink-0 text-ink-3 transition-transform duration-mid ease-out ${
                  showResolved ? "rotate-180" : ""
                }`}
                strokeWidth={2}
              />
              <span className="eyebrow">Resolved</span>
            </span>
            <span className="font-mono text-xs text-ink-3">
              {resolved.length}
            </span>
          </button>
          <div className="disclose" data-open={showResolved}>
            <div>
              <ul className="divide-y divide-rule/50 border-t border-rule/50">
                {resolved.map((item, index) => (
                  <ResolvedGap
                    key={item.key}
                    item={item}
                    index={index}
                    answer={answers[item.key]}
                    onAnswer={handleAnswer}
                    open={expanded.has(item.key)}
                    onToggle={() => toggleExpanded(item.key)}
                  />
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
