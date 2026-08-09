import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  HelpCircle,
  MapPin,
  Plus,
  SearchX,
} from "lucide-react";
import { MatrixRow } from "./ComplianceMatrix.jsx";

/**
 * Discovery results: one patient, many recruiting trials, ranked.
 *
 * This is the inverted flow. A clinician rarely arrives knowing which protocol to
 * test. They have a patient and need to know what is open and reachable. Each card
 * collapses a full compliance matrix down to a verdict, and expands to show the
 * per-criterion reasoning so nothing is taken on trust.
 */

const VERDICTS = {
  LIKELY_ELIGIBLE: {
    label: "Likely eligible",
    icon: CheckCircle2,
    chip: "border-ok/40 bg-ok/15 text-ok",
    card: "border-ok/40 hover:border-ok/60",
  },
  NEEDS_DATA: {
    label: "Needs data",
    icon: HelpCircle,
    chip: "border-hold/40 bg-hold/15 text-hold",
    card: "border-hold/35 hover:border-hold/55",
  },
  BLOCKED: {
    label: "Blocked",
    icon: AlertTriangle,
    chip: "border-risk/45 bg-risk/15 text-risk",
    card: "border-risk/35 hover:border-risk/55",
  },
};

const verdictStyle = (v) => VERDICTS[v] ?? VERDICTS.NEEDS_DATA;

function Stat({ value, label, tone }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className={`font-mono text-sm font-semibold ${tone}`}>
        {value}
      </span>
      <span className="text-xs text-ink-3">{label}</span>
    </div>
  );
}

function TrialCard({ trial, rank, onShowSource }) {
  const [open, setOpen] = useState(false);
  const style = verdictStyle(trial?.verdict);
  const Icon = style.icon;
  const rows = Array.isArray(trial?.compliance_matrix)
    ? trial.compliance_matrix
    : [];

  return (
    <article
      style={{ animationDelay: `${rank * 55}ms` }}
      className={`enter-content panel relative overflow-hidden border transition-colors duration-mid ease-out ${style.card}`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-start gap-3 px-4 py-3.5 text-left"
      >
        <span className="mt-0.5 font-mono text-sm text-ink-3">
          {String(rank).padStart(2, "0")}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono text-xs font-bold uppercase tracking-[0.1em] ${style.chip}`}
            >
              <Icon className="h-3 w-3" strokeWidth={2.5} />
              {style.label}
            </span>
            <span className="font-mono text-xs text-ink-3">
              {trial?.nct_id}
            </span>
            {trial?.phase && trial.phase !== "N/A" && (
              <span className="rounded border border-rule px-1.5 py-0.5 font-mono text-xs uppercase tracking-wider text-ink-3">
                {trial.phase.replace(/PHASE/g, "Ph ")}
              </span>
            )}
          </div>

          <h3 className="mt-2 text-sm font-medium leading-snug text-ink">
            {trial?.title || "Untitled study"}
          </h3>

          {trial?.distance_label && (
            <p className="mt-2 text-sm font-medium text-ink-2">
              {trial.distance_label}
            </p>
          )}

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <Stat value={trial?.match_count ?? 0} label="met" tone="text-ok" />
            <Stat
              value={trial?.conflict_count ?? 0}
              label="blocking"
              tone="text-risk"
            />
            <Stat
              value={trial?.unknown_count ?? 0}
              label="gaps"
              tone="text-gap"
            />
          </div>

          {Array.isArray(trial?.locations) && trial.locations.length > 0 && (
            <div className="mt-2 flex items-start gap-1.5 text-xs text-ink-3">
              <MapPin className="mt-0.5 h-3 w-3 shrink-0" strokeWidth={2} />
              <span className="leading-relaxed">
                {trial.locations.slice(0, 3).join(" · ")}
                {trial.site_count > 3 && (
                  <span className="text-ink-3">
                    {" "}
                    +{trial.site_count - 3} more site
                    {trial.site_count - 3 === 1 ? "" : "s"}
                  </span>
                )}
              </span>
            </div>
          )}
        </div>

        <ChevronDown
          className={`mt-1 h-4 w-4 shrink-0 text-ink-3 transition-transform duration-mid ease-out ${
            open ? "rotate-180" : ""
          }`}
          strokeWidth={2}
        />
      </button>

      <div className="disclose" data-open={open}>
        <div>
          <div className="border-t border-rule/70 bg-paper/40 px-4 py-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <span className="eyebrow">Criterion-by-criterion</span>
              <a
                href={trial?.url}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1.5 text-xs text-accent hover:text-accent"
              >
                Open on ClinicalTrials.gov
                <ExternalLink className="h-3 w-3" strokeWidth={2} />
              </a>
            </div>
            {rows.length === 0 ? (
              <p className="text-sm text-ink-3">
                No criteria were returned for this study.
              </p>
            ) : (
              <div className="space-y-3">
                {rows.map((row, i) => (
                  <MatrixRow
                    key={row?.id ?? `r-${i}`}
                    row={row}
                    index={i}
                    onShowSource={onShowSource}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

function DiscoverySkeleton() {
  return (
    <div className="space-y-3">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="panel-inset px-4 py-4">
          <div className="skeleton h-5 w-32" />
          <div className="skeleton mt-3 h-4 w-3/4" />
          <div className="skeleton mt-2.5 h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}

export default function TrialCandidates({
  result,
  loading,
  onShowSource,
  onScreenMore,
}) {
  if (loading) return <DiscoverySkeleton />;
  if (!result) return null;

  const candidates = Array.isArray(result.candidates) ? result.candidates : [];

  const failedCount = Array.isArray(result.failed) ? result.failed.length : 0;

  if (candidates.length === 0) {
    /* Two different empty states, and telling them apart is the whole point.
       "Nothing matched" sends the clinician to widen the location. That is the
       right advice only when the registry genuinely returned nothing — and it
       was being shown when the registry returned four studies and the model
       quota ran out before any of them could be scored. Widening the location
       cannot fix a spent quota, so the page was confidently pointing at the one
       thing that was not wrong. */
    if (failedCount > 0) {
      return (
        <div className="max-w-[62ch] py-md text-left">
          <h3 className="flex items-center gap-xs text-base font-semibold tracking-tight text-ink-2">
            <AlertTriangle
              className="h-4 w-4 shrink-0 text-hold"
              strokeWidth={2}
            />
            Trials were found, but none could be scored
          </h3>
          <p className="mt-2 max-w-[52ch] text-sm leading-relaxed text-ink-3">
            {result.failure_summary ||
              `${failedCount} recruiting ${
                failedCount === 1 ? "study" : "studies"
              } matched, but the eligibility check did not complete for any of them.`}
          </p>
          <p className="mt-2 max-w-[52ch] text-sm leading-relaxed text-ink-3">
            The search itself worked: {result.trials_screened ?? failedCount}{" "}
            recruiting studies matched{" "}
            <span className="font-mono text-ink-2">
              {result.search_condition}
            </span>
            . Nothing is wrong with the record or the location.
          </p>
        </div>
      );
    }

    return (
      <div className="max-w-[62ch] py-md text-left">
        <h3 className="flex items-center gap-xs text-base font-semibold tracking-tight text-ink-2">
          <SearchX className="h-4 w-4 shrink-0 text-ink-3" strokeWidth={2} />
          No recruiting trials matched
        </h3>
        <p className="mt-2 max-w-[48ch] text-sm leading-relaxed text-ink-3">
          Searched for{" "}
          <span className="font-mono text-ink-3">
            {result.search_condition}
          </span>
          . Try widening the location, or paste a specific trial URL to check it
          directly.
        </p>
      </div>
    );
  }

  const eligible = candidates.filter((c) => c.verdict !== "BLOCKED").length;

  return (
    <div className="space-y-3">
      <div className="enter-content panel flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="eyebrow">Searched</div>
          <div className="mt-0.5 truncate font-mono text-sm text-ink-2">
            {result.search_condition}
          </div>
        </div>
        <div className="text-right">
          <div className="font-mono text-lg font-semibold leading-none text-ok">
            {String(eligible).padStart(2, "0")}
          </div>
          <div className="eyebrow mt-1">worth review</div>
        </div>
        <div className="text-right">
          <div className="font-mono text-lg font-semibold leading-none text-ink-2">
            {String(result.trials_screened ?? candidates.length).padStart(
              2,
              "0",
            )}
          </div>
          <div className="eyebrow mt-1">screened</div>
        </div>
      </div>

      {candidates.map((trial, i) => (
        <TrialCard
          key={trial?.nct_id ?? `t-${i}`}
          trial={trial}
          rank={i + 1}
          onShowSource={onShowSource}
        />
      ))}

      {/* The registry matches location text strictly, so a city with no
          registered site returns nothing at all — "invasive ductal carcinoma"
          gives 12 studies nationally and zero for "Cleveland, OH". The search
          drops the filter rather than showing an empty page, but a clinician who
          asked "near me" and is reading "anywhere" has to be told. Each card
          still lists its own sites, nearest first. */}
      {result.location_relaxed && (
        <p className="px-1 text-xs leading-relaxed text-ink-3">
          No recruiting study was registered at the location you entered, so
          these results are not filtered by location. Check the sites listed on
          each study.
        </p>
      )}

      {/* The shortlist is capped, not exhaustive. Saying how many were screened
          and offering the next batch is the difference between "these are the
          trials" and "these are the trials we have looked at so far" — and after
          a page of blocked studies, the second is the honest claim. */}
      {onScreenMore && (
        <div className="flex flex-wrap items-center gap-sm px-1 pt-1">
          <button
            type="button"
            onClick={onScreenMore}
            className="btn-quiet inline-flex items-center gap-xs px-sm py-1.5 text-sm"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={2.5} />
            Screen more trials
          </button>
          <span className="text-xs text-ink-3">
            Only the first few studies are scored, because each one costs a model
            call.
          </span>
        </div>
      )}

      {/* The COUNT alone reads as a defect in the tool. It was "3 studies could
          not be scored" and nothing else, for a run whose only problem was a
          free-tier quota that refills in a minute — so the one useful response,
          waiting and pressing the button above, was undiscoverable. */}
      {failedCount > 0 && (
        <p className="px-1 text-xs leading-relaxed text-ink-3">
          {result.failure_summary ||
            `${failedCount} stud${failedCount === 1 ? "y" : "ies"} could not be
             scored and ${failedCount === 1 ? "is" : "are"} not listed above.`}
        </p>
      )}
    </div>
  );
}
