import { useCallback, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Activity, Printer } from "lucide-react";
import {
  RESOLUTION,
  effectiveStatus,
  gapAction,
  gapImpact,
  gapKey,
  rankTrials,
} from "../lib/scoring.js";

/**
 * The sheet the patient carries into the appointment.
 *
 * Everything on screen so far is built for the person operating the console. This
 * is the one artifact built for the person the console is about, and it leaves the
 * building on paper, so it has to survive without tooltips, without hover, and
 * without anyone to explain it. That drives three choices.
 *
 * ONE, it is a separate document, not the app scaled down. The sheet is portaled
 * to document.body and the whole app tree is removed at print time, so no sibling
 * panel has to opt out of printing and no console layout leaks onto the page.
 *
 * TWO, it carries no theme. Colour tokens flip with the band, so a clinician
 * reading in dark mode would hand over a black page. Every rule that touches the
 * sheet lives in print.css as a literal, and the sheet uses no Tailwind colour
 * class at all. Verdicts read as symbol, weight and rule, because most people
 * print in greyscale.
 *
 * THREE, it never states a conclusion it has not earned. The tool compares a
 * record against published criteria; it does not decide whether anyone can enrol.
 * So the copy says criteria appear to match the record supplied, and the loudest
 * block on the page is the list of questions still open, not the ranking.
 */

/* Wording per verdict. The symbol carries the state in greyscale; the sentence
   carries the qualification that keeps it out of determination territory. */
const VERDICT = {
  LIKELY_ELIGIBLE: {
    symbol: "✓",
    line: "Every criterion checked appears to match the record supplied.",
  },
  NEEDS_DATA: {
    symbol: "?",
    line: "Some criteria could not be checked from the record supplied.",
  },
  BLOCKED: {
    symbol: "×",
    line: "At least one criterion appears to conflict with the record supplied.",
  },
};

const MAX_TRIALS = 5;
const MAX_QUESTIONS = 6;
const MAX_SET_ASIDE = 4;
const MAX_SITES = 3;

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const criteriaCount = (n) => `${n} ${n === 1 ? "criterion" : "criteria"}`;
const studyCount = (n) => `${n} ${n === 1 ? "study" : "studies"}`;

const clean = (value) => (typeof value === "string" ? value.trim() : "");

/** Split one matrix into the three buckets the sheet prints, under the answers. */
function splitRows(trial, answers) {
  const rows = Array.isArray(trial?.compliance_matrix)
    ? trial.compliance_matrix
    : [];
  const match = [];
  const conflict = [];
  const open = [];
  for (const node of rows) {
    const status = effectiveStatus(node, answers);
    if (status === "MATCH") match.push(node);
    else if (status === "CONFLICT") conflict.push(node);
    else open.push(node);
  }
  return { match, conflict, open };
}

function Criterion({ node, symbol, showFact }) {
  const rule = clean(node?.trial_rule) || gapAction(node);
  const fact = showFact ? clean(node?.patient_fact) : "";
  return (
    <li data-sym={symbol}>
      <span className="pb-crit">{rule}</span>
      {fact && <span className="pb-fact">Record shows: {fact}</span>}
    </li>
  );
}

/**
 * One study block.
 *
 * `mode` is "carried" for a study still in play and "aside" for one that is not.
 * Both run the same split, so the conflicting criteria a patient is entitled to
 * see are printed by the same code path that prints the matching ones.
 */
function TrialEntry({ trial, rank, answers, mode }) {
  const { match, conflict, open } = splitRows(trial, answers);
  const verdict = VERDICT[trial?.verdict] ?? VERDICT.NEEDS_DATA;
  const sites = (Array.isArray(trial?.locations) ? trial.locations : [])
    .map(clean)
    .filter(Boolean);
  const shown = sites.slice(0, MAX_SITES);
  const siteCount = Number(trial?.site_count);
  const extraSites =
    Number.isFinite(siteCount) && siteCount > shown.length
      ? siteCount - shown.length
      : 0;
  const nearby = Number(trial?.nearby_count);
  const phase = clean(trial?.phase);
  const url = clean(trial?.url);

  return (
    <article className="pb-trial">
      <div className="pb-trial-top">
        <span className="pb-rank">{String(rank).padStart(2, "0")}</span>
        <div className="pb-trial-body">
          <p className="pb-idline">
            {clean(trial?.nct_id) || "Study identifier not supplied"}
            {phase && phase !== "N/A" && (
              <span className="pb-phase">{phase.replace(/PHASE/gi, "Phase ")}</span>
            )}
          </p>

          <h3 className="pb-title">{clean(trial?.title) || "Untitled study"}</h3>

          <p className="pb-verdict">
            <span className="pb-sym">{verdict.symbol}</span>
            {verdict.line}
          </p>

          {mode === "carried" && (
            <p className="pb-counts">
              {criteriaCount(match.length)}{" "}
              {match.length === 1 ? "appears" : "appear"} to match
              {open.length > 0 && `, ${open.length} still to confirm`}
            </p>
          )}

          {shown.length > 0 && (
            <p className="pb-sites">
              Sites: {shown.join("; ")}
              {/* "and 29 more sites", not "and 29 sites more". */}
              {extraSites > 0 &&
                ` and ${extraSites} more ${extraSites === 1 ? "site" : "sites"}`}
              {Number.isFinite(nearby) &&
                nearby > 0 &&
                ` (${plural(nearby, "site")} near the location searched)`}
            </p>
          )}

          {url && <p className="pb-url">{url}</p>}

          {mode === "carried" && match.length > 0 && (
            <>
              <h4 className="pb-crit-h">
                Criteria that appear to match the record
              </h4>
              <ul className="pb-list">
                {match.map((node, i) => (
                  <Criterion
                    key={node?.id ?? `m-${i}`}
                    node={node}
                    symbol={"✓"}
                    showFact
                  />
                ))}
              </ul>
            </>
          )}

          {conflict.length > 0 && (
            <>
              <h4 className="pb-crit-h">
                Criteria that appear to conflict with the record
              </h4>
              <ul className="pb-list">
                {conflict.map((node, i) => (
                  <Criterion
                    key={node?.id ?? `c-${i}`}
                    node={node}
                    symbol={"×"}
                    showFact
                  />
                ))}
              </ul>
            </>
          )}

          {mode === "carried" && open.length > 0 && (
            <>
              <h4 className="pb-crit-h">Open questions for this study</h4>
              <ul className="pb-list">
                {open.map((node, i) => (
                  <li key={node?.id ?? `o-${i}`} data-sym="?">
                    <span className="pb-crit">{gapAction(node)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </article>
  );
}

export default function TrialBrief({
  trials,
  answers,
  searchCondition,
  truncation,
}) {
  // Captured once on mount so the printed date cannot drift mid session.
  const [preparedAt] = useState(() => new Date());
  // Stable identity, otherwise every memo below rebuilds on each render when the
  // parent has not supplied answers yet.
  const safeAnswers = useMemo(() => answers ?? {}, [answers]);

  const dateLong = useMemo(
    () =>
      preparedAt.toLocaleDateString(undefined, {
        year: "numeric",
        month: "long",
        day: "numeric",
      }),
    [preparedAt],
  );

  const ranked = useMemo(
    () => rankTrials(trials ?? [], safeAnswers),
    [trials, safeAnswers],
  );

  const carried = useMemo(
    () => ranked.filter((t) => t?.verdict !== "BLOCKED").slice(0, MAX_TRIALS),
    [ranked],
  );

  const setAside = useMemo(
    () => ranked.filter((t) => t?.verdict === "BLOCKED").slice(0, MAX_SET_ASIDE),
    [ranked],
  );

  /**
   * Questions are scored against the studies actually printed, so every count on
   * the page can be checked against the page. When nothing survived screening
   * there is no such list to count against, and the questions fall back to the
   * full screened set rather than the sheet losing its most useful section.
   */
  const questionScope = carried.length > 0 ? carried : ranked;
  const scopePhrase =
    carried.length > 0 ? "studies listed here" : "studies screened";
  const questions = useMemo(
    () => gapImpact(questionScope, safeAnswers),
    [questionScope, safeAnswers],
  );
  const shownQuestions = questions.slice(0, MAX_QUESTIONS);
  const hiddenQuestions = questions.length - shownQuestions.length;

  /* Answers are stored under the gap key, which is derived text rather than
     something readable. Walk the matrices once to recover the phrasing the
     clinician actually saw, and keep matrix order so the list is stable. */
  const recorded = useMemo(() => {
    const seen = new Map();
    for (const trial of trials ?? []) {
      for (const node of trial?.compliance_matrix ?? []) {
        const key = gapKey(node);
        if (!seen.has(key)) seen.set(key, gapAction(node));
      }
    }
    const out = [];
    for (const [key, label] of seen) {
      const answer = safeAnswers[key];
      if (!answer) continue;
      const value = clean(answer.value);
      if (answer.resolution === RESOLUTION.UNRESOLVED && !value) continue;
      out.push({ key, label, resolution: answer.resolution, value });
    }
    return out;
  }, [trials, safeAnswers]);

  const canPrint = ranked.length > 0;

  const handlePrint = useCallback(() => {
    const previous = document.title;
    try {
      // Names the file when the print dialog is used to save a PDF.
      document.title = `ClinixPath trial brief, ${dateLong}`;
      window.print();
    } finally {
      document.title = previous;
    }
  }, [dateLong]);

  const condition = clean(searchCondition);

  const sheet = (
    <section className="print-only pb-sheet" style={{ display: "none" }}>
      <header className="pb-head">
        <div className="pb-mark">
          <Activity className="pb-mark-icon" strokeWidth={2.25} />
          <div>
            <p className="pb-brand">ClinixPath</p>
            <p className="pb-brand-sub">Trial candidacy brief</p>
          </div>
        </div>

        <ul className="pb-meta">
          {condition && (
            <li>
              <span className="pb-meta-k">Condition searched</span>
              <span className="pb-meta-v">{condition}</span>
            </li>
          )}
          <li>
            <span className="pb-meta-k">Prepared</span>
            <span className="pb-meta-v">{dateLong}</span>
          </li>
        </ul>

        <p className="pb-note">
          This page is a decision support summary. It is not medical advice, and
          it is not a determination that anyone is eligible for any study. It
          compares one supplied record against published criteria so the right
          questions can be asked. Only the study team can decide who enrolls.
        </p>

        {/* Stated on the sheet, not only in the console. This is the copy that
            leaves the building and gets read at an appointment by someone who
            was not there when it was generated, so a screen that covered part
            of the record must say so here or the omission travels silently. */}
        {truncation?.record_truncated && (
          <p className="pb-note pb-note-warn">
            Based on part of the record only. The document supplied was longer
            than this tool can process in one pass, so the first{" "}
            {Number(truncation.record_chars_used ?? 0).toLocaleString()} of{" "}
            {Number(truncation.record_chars_total ?? 0).toLocaleString()}{" "}
            characters were screened. Anything recorded later in the document was
            not read, and could change every finding below. Ask the treating team
            to review the full record.
          </p>
        )}
      </header>

      <section className="pb-block pb-questions">
        <h2 className="pb-h2 pb-h2-loud">Questions to ask my doctor</h2>
        {shownQuestions.length === 0 ? (
          <p className="pb-lede">
            Nothing was left outstanding in the record supplied. Ask the team
            whether anything further is needed before a referral.
          </p>
        ) : (
          <>
            <p className="pb-lede">
              The record supplied did not answer these. Each one is a detail the
              studies below need, and answering them is the fastest way to
              narrow the list.
            </p>
            <ol className="pb-qlist">
              {shownQuestions.map((q) => (
                <li key={q.key}>
                  <p className="pb-q">{q.action}</p>
                  {q.criteria?.[0] && (
                    <p className="pb-qcrit">
                      Study wording: {clean(q.criteria[0])}
                    </p>
                  )}
                  <p className="pb-qnote">
                    Relates to {q.touches} of the {scopePhrase}
                    {q.resolves > 0 &&
                      `. If met, ${studyCount(q.resolves)} would have no remaining open items in this record`}
                    .
                  </p>
                </li>
              ))}
            </ol>
            {hiddenQuestions > 0 && (
              <p className="pb-qmore">
                {plural(hiddenQuestions, "further question")} came out of the
                same screening and are held in the console.
              </p>
            )}
          </>
        )}
      </section>

      <section className="pb-block">
        <h2 className="pb-h2">Studies worth asking about</h2>
        {carried.length === 0 ? (
          <p className="pb-lede">
            No study from this search is being carried forward. Every study
            screened had at least one criterion that appears to conflict with
            the record supplied. That is a reason to review the record and the
            search with the treating team, not a conclusion about eligibility.
          </p>
        ) : (
          <div className="pb-trials">
            {carried.map((trial, i) => (
              <TrialEntry
                key={trial?.nct_id ?? `t-${i}`}
                trial={trial}
                rank={i + 1}
                answers={safeAnswers}
                mode="carried"
              />
            ))}
          </div>
        )}
      </section>

      {setAside.length > 0 && (
        <section className="pb-block">
          <h2 className="pb-h2">Studies not carried forward</h2>
          <p className="pb-lede">
            Listed so the reason is visible rather than hidden. A criterion that
            appears to conflict can rest on a detail the record recorded poorly,
            which is worth raising.
          </p>
          <div className="pb-trials">
            {/* Numbered from one, not continuing the section above. `carried` is
                capped at MAX_TRIALS, so continuing the count printed "06" against
                a study that actually ranked ninth. These are a separate list, and
                their order carries no claim beyond the order they are printed in. */}
            {setAside.map((trial, i) => (
              <TrialEntry
                key={trial?.nct_id ?? `b-${i}`}
                trial={trial}
                rank={i + 1}
                answers={safeAnswers}
                mode="aside"
              />
            ))}
          </div>
        </section>
      )}

      {recorded.length > 0 && (
        <section className="pb-block">
          <h2 className="pb-h2">Details recorded during the review</h2>
          <p className="pb-lede">
            Entered by hand by whoever prepared this page, and used to rank the
            studies above. They were not read back out of the record.
          </p>
          <ul className="pb-answers">
            {recorded.map((item) => (
              <li key={item.key}>
                <span className="pb-answer-label">{item.label}</span>
                <span className="pb-answer-state">
                  {item.resolution === RESOLUTION.MET
                    ? "Recorded as met"
                    : item.resolution === RESOLUTION.NOT_MET
                      ? "Recorded as not met"
                      : "Noted, still open"}
                </span>
                {item.value && (
                  <span className="pb-answer-value">{item.value}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer className="pb-foot">
        <p>
          The record behind this page was de-identified in the browser before
          any part of it was sent for analysis. No name, date of birth or record
          number appears anywhere above.
        </p>
        <p>
          Recruitment status changes without notice. These studies were checked
          on {dateLong}. Confirm a study is still open, and still recruiting at
          a site you can reach, before making travel plans.
        </p>
        <p>
          ClinixPath is decision support software. It does not determine
          eligibility, and nothing here replaces the judgment of the treating
          team.
        </p>
      </footer>
    </section>
  );

  return (
    <>
      <div className="no-print enter-content">
        <button
          type="button"
          onClick={handlePrint}
          disabled={!canPrint}
          title={
            canPrint
              ? "Open the print dialog for a one page summary"
              : "Run a search to build a brief"
          }
          className="btn-quiet group inline-flex max-w-full items-center justify-center gap-2 whitespace-nowrap px-3 py-2 text-sm transition duration-fast ease-out hover:border-accent hover:bg-accent/[0.06] hover:text-ink focus-visible:border-accent active:translate-y-px active:bg-accent/[0.1] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-rule-strong disabled:hover:bg-transparent disabled:hover:text-ink-2"
        >
          <Printer
            className="h-3.5 w-3.5 shrink-0 text-ink-3 transition-colors duration-fast ease-out group-hover:text-accent group-focus-visible:text-accent group-disabled:text-ink-3"
            strokeWidth={2}
          />
          Print brief
        </button>
      </div>

      {typeof document === "undefined"
        ? null
        : createPortal(sheet, document.body)}
    </>
  );
}
