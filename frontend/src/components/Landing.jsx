import { ArrowRight, Database, FileText, Lock } from "lucide-react";
import ThemeToggle from "./ThemeToggle.jsx";
import { MatrixRow } from "./ComplianceMatrix.jsx";
import { mockData } from "../mockData.js";

/**
 * Landing page · macrostructure: Marquee Hero (03) · nav N1b · footer Ft2.
 *
 * WHY THE PREVIOUS SHAPES HAD TO GO.
 *
 * This page has been two things before. First Narrative Workflow: four numbered
 * stages, 1.0 through 4.0, describing the pipeline. It described the product competently and never
 * once showed it. For a tool whose entire claim is "every verdict arrives with
 * the sentence it came from", a page that only *asserts* that is arguing against
 * itself — the proof is the product, so the product is the page.
 *
 * So the instrument is here, live, rendering the same `MatrixRow` component the
 * console renders, from the same sample data. Not a screenshot, not a mockup,
 * not a hand-drawn browser frame with fake traffic-light dots: the actual
 * component. If the audit readout changes, this page changes with it, which
 * means it cannot drift into advertising something that no longer exists.
 *
 * Surfaces lift: a panel is an object with a fill, a hairline and a shadow.
 * See the `.panel` comment in index.css for why that reversed.
 */

/** What the tool does with a record, stated as work rather than as features. */
const TOUR = [
  {
    label: "On your machine",
    title: "The chart is read and stripped here.",
    body: "A PDF goes in. It is parsed in this browser and the identifiers — names, record numbers, dates, addresses, contacts — come out before any network call exists. You then read the exact text that would be sent, edit it if you want, and approve it. Nothing transmits until you press send.",
  },
  {
    label: "Against the registry",
    title: "Every recruiting study, not the one you already knew about.",
    body: "The condition is read out of the record and matched against currently-recruiting trials on ClinicalTrials.gov, filtered to sites near your patient. This is the step that cannot be done by hand, because there are thousands of open protocols and they change weekly.",
  },
  {
    label: "Criterion by criterion",
    title: "Met, blocked, or a gap — with the sentence behind each.",
    body: "Every criterion resolves exactly three ways, and each verdict carries the quote it relied on, from the chart and from the protocol. A single blocking exclusion sinks a trial however much else fits. When a quote cannot be found in the source, the row is marked unverifiable rather than rendered as fact.",
  },
  {
    label: "What to order",
    title: "The gaps are the useful output.",
    body: "A criterion the chart is silent on is not a failure, it is an order to place. Gaps are collected into a checklist ranked by how many trials each one unblocks, so the most valuable test to run next sits at the top. Answer one and the whole ranking re-sorts.",
  },
];

const LIMITS = [
  [
    "It is not a medical device.",
    "Verdicts are a research aid for a clinician to check, never an enrolment decision.",
  ],
  [
    "It is not HIPAA compliant.",
    "No BAA with the model provider, no authentication, no audit log. Built for synthetic records, or records already de-identified to your institution’s standard.",
  ],
  [
    "The scrubber misses identifiers written as prose.",
    "Structured fields — names in labelled fields, record numbers, dates, addresses — are removed reliably. A bare first name, a hospital, or a city inside a sentence is not. That is why you read and approve the exact text before it is sent.",
  ],
];

/** Section label sitting against its own rule, never beside the heading. */
function Block({ label, children, tone = "strong", id }) {
  return (
    <section
      id={id}
      className={`scroll-mt-20 mt-xl ${
        tone === "strong"
          ? "border-t-[length:var(--rule-section)] border-t-ink-3/70"
          : "border-t border-t-rule-strong"
      }`}
    >
      {/* Deliberately NOT `.block-label`. That class is a header row inside a
          filled surface, so it carries a bottom rule and the surface's inline
          padding — both wrong on a bare page section, where it produced a
          stray divider and indented the label a rem past its own body copy. */}
      <h2 className="eyebrow pb-sm pt-xs text-ink-3">{label}</h2>
      {children}
    </section>
  );
}

export default function Landing({ onEnter }) {
  return (
    <div className="min-h-full">
      {/* N1b · canonical SaaS three-section: wordmark left, anchor cluster
          centre, actions right. Replaces the N6 masthead, whose centred wordmark
          and dateline strip were doing newspaper cosplay on a product page. */}
      <header className="sticky top-0 z-40 border-b border-rule bg-paper/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1120px] items-center gap-md px-md py-sm sm:px-lg">
          <a href="#top" className="flex min-w-0 shrink-0 items-center gap-sm">
            <Mark />
            <span className="font-display text-lg font-semibold tracking-tightish text-ink">
              ClinixPath
            </span>
          </a>

          <nav className="ml-auto hidden items-center gap-lg md:flex">
            {/* Every one of these resolves to a real section id on this page.
                A nav link that scrolls nowhere is worse than no nav at all. */}
            {[
              ["What it returns", "#returns"],
              ["Sources", "#sources"],
              ["Limits", "#limits"],
            ].map(([label, href]) => (
              <a
                key={href}
                href={href}
                className="whitespace-nowrap text-sm text-ink-2 transition-colors duration-fast ease-out hover:text-ink"
              >
                {label}
              </a>
            ))}
          </nav>

          <div className="ml-auto flex shrink-0 items-center gap-sm md:ml-lg">
            <ThemeToggle />
            <button
              type="button"
              onClick={onEnter}
              className="btn-primary whitespace-nowrap px-md py-2 text-sm"
            >
              Open console
            </button>
          </div>
        </div>
      </header>

      <main id="top" className="mx-auto max-w-[1120px] px-md pb-2xl sm:px-lg">
        {/* Marquee Hero. Centre-set and very large — the reference's whole move
            is that the statement occupies the fold and nothing competes with it.
            `overflow-wrap: anywhere` + `min-width: 0` per the responsive floor,
            so the display size cannot force a horizontal scroll at 320px. */}
        <section className="flex flex-col items-center pb-xl pt-2xl text-center lg:pt-3xl">
          <p className="eyebrow mb-lg text-accent">
            Clinical trial eligibility screening
          </p>
          <h1
            className="min-w-0 max-w-[15ch] text-display font-bold leading-[0.98] tracking-display text-ink"
            style={{ overflowWrap: "anywhere" }}
          >
            Faster screening, fewer missed trials.
          </h1>
          <p className="mt-lg max-w-[56ch] text-lg leading-relaxed text-ink-2">
            Drop in a medical record. ClinixPath strips the identifiers before
            anything leaves your browser, then checks the chart against every
            recruiting study — criterion by criterion, with the source sentence
            quoted for each verdict.
          </p>
          <div className="mt-xl flex flex-wrap items-center justify-center gap-sm">
            <button
              type="button"
              onClick={onEnter}
              className="btn-primary inline-flex items-center gap-xs whitespace-nowrap px-lg py-3 text-base"
            >
              Open the console
              <ArrowRight className="h-4 w-4" strokeWidth={2.25} />
            </button>
            <a
              href="#returns"
              className="btn-quiet inline-flex items-center whitespace-nowrap px-lg py-3 text-base"
            >
              See what it returns
            </a>
          </div>
          {/* The privacy claim rides directly under the CTA: it is the reason
              someone is willing to press the button, not a footnote. */}
          <span className="mt-md inline-flex items-center gap-xs font-mono text-xs uppercase tracking-[0.12em] text-ink-3">
            <Lock className="h-3.5 w-3.5 text-accent" strokeWidth={2.25} />
            The file never leaves your device
          </span>
        </section>

                <section id="returns" className="mt-xl scroll-mt-20">
          <div className="instrument">
            {/* `.instrument` carries a fill and a radius now, so its header row
                takes the surface's own padding and a divider, matching the
                `.block-label` rhythm the console uses. */}
            <div className="flex flex-wrap items-baseline justify-between gap-x-lg gap-y-2xs border-b border-rule px-md py-sm">
              <h2 className="font-display text-lg font-semibold tracking-tightish text-ink">
                Compliance matrix
              </h2>
              <p className="font-mono text-xs tabular-nums text-ink-3">
                3 criteria · 1 met · 1 blocked · 1 gap
              </p>
            </div>
            <div className="panel-body space-y-3">
              {mockData.compliance_matrix.map((row, i) => (
                <MatrixRow key={row.id} row={row} index={i} />
              ))}
            </div>
            <p className="border-t border-rule px-md py-sm text-sm leading-relaxed text-ink-3">
              Illustrative data, not a real patient. This is the console’s own
              readout, rendered by the same component — what you see here is what
              the tool returns.
            </p>
          </div>
        </section>

        {/* Guided tour. Label above heading, single column, always. */}
        {TOUR.map((step) => (
          <Block key={step.label} label={step.label} tone="light">
            <div className="grid gap-x-2xl gap-y-xs pb-lg md:grid-cols-[minmax(0,26ch)_minmax(0,62ch)]">
              <h3 className="text-xl font-semibold leading-snug tracking-[-0.02em] text-ink">
                {step.title}
              </h3>
              <p className="text-base leading-relaxed text-ink-2">{step.body}</p>
            </div>
          </Block>
        ))}

        <Block id="sources" label="Where the data comes from">
          <dl className="grid gap-x-2xl gap-y-md pb-lg md:grid-cols-2">
            <div>
              <dt className="flex items-baseline gap-xs text-base font-semibold text-ink">
                <Database
                  className="h-4 w-4 shrink-0 translate-y-0.5 text-accent"
                  strokeWidth={2}
                />
                Trial criteria · ClinicalTrials.gov API v2
              </dt>
              <dd className="mt-xs max-w-[58ch] text-sm leading-relaxed text-ink-2">
                Read live from the public registry, filtered to studies currently
                recruiting and to sites near your patient. No scraper sits in
                between, so the criteria are the ones the sponsor posted.
                Registry entries can lag reality, so confirm with the study team.
              </dd>
            </div>
            <div>
              <dt className="flex items-baseline gap-xs text-base font-semibold text-ink">
                <FileText
                  className="h-4 w-4 shrink-0 translate-y-0.5 text-accent"
                  strokeWidth={2}
                />
                Patient facts · the record you supply
              </dt>
              <dd className="mt-xs max-w-[58ch] text-sm leading-relaxed text-ink-2">
                Nothing is inferred from outside the document. If the chart does
                not say it, the criterion resolves to a data gap rather than a
                guess — which is why gaps are treated as the useful output rather
                than a shortfall.
              </dd>
            </div>
          </dl>
        </Block>

        <Block id="limits" label="What this does not do">
          <dl className="pb-lg">
            {LIMITS.map(([term, def]) => (
              <div
                key={term}
                className="row-rule grid gap-x-2xl gap-y-2xs py-md first:border-t-0 md:grid-cols-[minmax(0,26ch)_minmax(0,62ch)]"
              >
                <dt className="text-base font-semibold leading-snug text-ink">
                  {term}
                </dt>
                <dd className="text-sm leading-relaxed text-ink-2">{def}</dd>
              </div>
            ))}
          </dl>
        </Block>
      </main>

      {/* Ft4 · colophon. A document closes by stating what it is and where its
          material came from, not with four columns of links it does not have. */}
      <footer className="border-t-[length:var(--rule-page)] border-ink">
        <div className="mx-auto max-w-[1120px] px-md py-lg sm:px-lg">
          <p className="max-w-[22ch] font-display text-display-s font-semibold leading-[1.06] tracking-[-0.03em] text-ink">
            A shortlist is a starting point, not a decision.
          </p>
          <dl className="mt-xl grid gap-x-2xl gap-y-md border-t border-ink pt-md font-mono text-xs leading-relaxed sm:grid-cols-3">
            <div>
              <dt className="uppercase tracking-[0.12em] text-ink-3">Built as</dt>
              <dd className="mt-2xs text-ink-2">
                A prototype. No authentication, no audit log, no BAA.
              </dd>
            </div>
            <div>
              <dt className="uppercase tracking-[0.12em] text-ink-3">
                Trial data
              </dt>
              <dd className="mt-2xs text-ink-2">
                ClinicalTrials.gov API v2, recruiting studies only.
              </dd>
            </div>
            <div>
              <dt className="uppercase tracking-[0.12em] text-ink-3">
                Patient data
              </dt>
              <dd className="mt-2xs text-ink-2">
                De-identified in your browser. The file is never uploaded.
              </dd>
            </div>
          </dl>
          <div className="mt-lg flex flex-wrap items-center justify-between gap-md border-t border-rule pt-md">
            <div className="flex items-center gap-sm">
              <Mark className="h-5 w-5" />
              <span className="font-mono text-xs text-ink-3">ClinixPath</span>
            </div>
            <button
              type="button"
              onClick={onEnter}
              className="text-sm font-medium text-accent underline-offset-4 hover:underline"
            >
              Open the console
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}

/**
 * The mark, kept byte-identical to the one in Header.jsx.
 *
 * Duplicated rather than shared because the two mastheads are deliberately
 * separate components, but they must not drift: crossing the terms gate should
 * not change the logo. If you edit one, edit both.
 */
function Mark({ className = "h-[26px] w-[26px]" }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={className}
      aria-hidden="true"
      fill="none"
    >
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
