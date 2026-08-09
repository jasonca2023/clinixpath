import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Lock,
  ShieldOff,
  Stethoscope,
} from "lucide-react";
import { TERMS_VERSION } from "../lib/session.js";
import { useDialog } from "../lib/dialog.js";

/**
 * The terms gate.
 *
 * Every claim here is one this codebase can actually stand behind. The scrubber
 * failure rate is measured, not estimated; the "no retention" claim is enforced by
 * the backend's finally-block purge and the absence of any database. Writing a
 * softer, vaguer version would be the easy thing and the wrong one. A clinician
 * who over-trusts this tool because the terms were reassuring is the failure mode
 * that matters.
 *
 * Consent is stored per terms VERSION, so materially changing this copy re-prompts
 * everyone who accepted the old text.
 */

const CLAUSES = [
  {
    icon: Stethoscope,
    tone: "risk",
    title: "Not a medical device. Not clinical advice.",
    body: `ClinixPath produces a research aid, not a determination of eligibility. Every verdict, whether MATCH, CONFLICT, or DATA GAP, is a suggestion to be checked by a qualified clinician against the full protocol and the complete patient record. Enrolment decisions must never rest on this output alone. Nothing here is diagnosis, treatment advice, or a substitute for the judgement of the study team.`,
  },
  {
    icon: ShieldOff,
    tone: "risk",
    title: "Not HIPAA compliant. Use synthetic or de-identified records.",
    body: `There is no Business Associate Agreement with the model provider, no authentication, no audit logging, and no transport encryption on a local install. Do not upload records that identify a real patient. This tool is built for synthetic data, for records a patient is sharing about themselves, or for records already de-identified to your institution's standard.`,
  },
  {
    icon: AlertTriangle,
    tone: "hold",
    title: "The de-identification is incomplete, and measurably so.",
    body: `Your record is parsed and scrubbed in this browser before anything is transmitted; the file itself is never uploaded. That scrubber reliably removes structured identifiers: names in labelled fields, SSNs, MRNs, phone numbers, emails, addresses, dates. It does not understand language. In testing against eleven HIPAA Safe Harbor cases it failed ten: bare first names in narrative text, surnames without a title, hospital and employer names, city names, and ages stated in prose all passed through untouched. Read the review screen before you send. That human check is the actual safeguard; the automation is only a first pass.`,
  },
  {
    icon: Lock,
    tone: "accent",
    title: "What leaves your device, and what does not.",
    body: `Only the de-identified text you explicitly approve on the review screen is transmitted. It goes to a third-party language model to be analysed. Depending on which provider is configured, that provider's terms may permit human review of submitted content or its use in product improvement. Nothing is written to a database, a log, or a disk by ClinixPath itself: buffers are purged as soon as a response is returned. The original PDF never leaves this browser.`,
  },
  {
    icon: AlertTriangle,
    tone: "hold",
    title: "The model can be wrong. Verify against the quoted source.",
    body: `Language models misread negation, conflate similar criteria, and occasionally assert a match the record does not support. Every row therefore quotes the exact sentence it relied on, and clicking that quote highlights it inside the original document. If a quote cannot be located in the source, the interface says so. Treat that row as unverified. Use those quotes. A verdict you have not traced is a verdict you should not act on.`,
  },
  {
    icon: AlertTriangle,
    tone: "gap",
    title: "Trial data comes from ClinicalTrials.gov and may be out of date.",
    body: `Eligibility criteria, recruiting status, and site locations are read live from the public ClinicalTrials.gov API. That registry is maintained by study sponsors and can lag reality: a trial listed as recruiting may have closed, and posted criteria may differ from the current protocol. Confirm with the study team before acting.`,
  },
  {
    icon: ShieldOff,
    tone: "gap",
    title: "Provided as-is, with no warranty.",
    body: `This is a hackathon prototype. It carries no warranty of accuracy, availability, or fitness for any purpose, and no liability is accepted for decisions made using it. You are responsible for complying with the privacy law and institutional policy that applies to you.`,
  },
];

const TONES = {
  risk: "text-risk",
  hold: "text-hold",
  gap: "text-ink-3",
  accent: "text-accent",
};

export default function TermsGate({ onAccept, onDecline }) {
  const [checked, setChecked] = useState(false);
  const [readToEnd, setReadToEnd] = useState(false);
  const scrollRef = useRef(null);
  // This gate is only ever mounted when it is open, so `open` is a constant true.
  const dialogRef = useDialog(true, onDecline);

  useEffect(() => {
    dialogRef.current?.focus();
  }, [dialogRef]);

  // If the terms fit without scrolling, there is nothing to scroll to the end of.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && el.scrollHeight <= el.clientHeight + 4) setReadToEnd(true);
  }, []);

  const handleScroll = (e) => {
    const { scrollTop, scrollHeight, clientHeight } = e.currentTarget;
    if (scrollTop + clientHeight >= scrollHeight - 24) setReadToEnd(true);
  };

  const ready = checked && readToEnd;

  return (
    <div
      className="enter-scrim fixed inset-0 z-[80] flex items-center justify-center bg-ink/40 p-md backdrop-blur-sm sm:p-lg"
      role="dialog"
      aria-modal="true"
      aria-labelledby="terms-title"
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="enter-dialog flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-rule bg-paper shadow-card outline-none"
      >
        <header className="border-b border-rule px-lg py-md">
          <p className="eyebrow">Terms of use · v{TERMS_VERSION}</p>
          <h2
            id="terms-title"
            className="mt-xs text-xl font-semibold tracking-tight text-ink sm:text-2xl"
          >
            Read this before you use ClinixPath
          </h2>
          <p className="mt-xs text-sm leading-relaxed text-ink-2">
            Seven things about what this tool does, what it does badly, and what
            it does not do at all. They are short and they are not boilerplate.
          </p>
        </header>

        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="min-h-0 flex-1 divide-y divide-rule overflow-y-auto"
        >
          {CLAUSES.map((clause, i) => {
            const Icon = clause.icon;
            return (
              <article key={clause.title} className="px-lg py-md">
                <div className="flex items-start gap-sm">
                  <Icon
                    className={`mt-1 h-4 w-4 shrink-0 ${TONES[clause.tone]}`}
                    strokeWidth={2}
                  />
                  <div className="min-w-0">
                    <h3 className="text-base font-semibold leading-snug text-ink">
                      <span className="mr-xs font-mono text-xs text-ink-3">
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      {clause.title}
                    </h3>
                    <p className="mt-xs text-sm leading-relaxed text-ink-2">
                      {clause.body}
                    </p>
                  </div>
                </div>
              </article>
            );
          })}

          <p className="px-lg py-md text-xs leading-relaxed text-ink-3">
            ClinixPath is an independent prototype. It is not affiliated with,
            endorsed by, or connected to ClinicalTrials.gov, the U.S. National
            Library of Medicine, or any trial sponsor. Accepting these terms
            records a timestamp in this browser's local storage and nothing else
            . No account is created and no identifier is sent anywhere.
          </p>
        </div>

        <footer className="border-t border-rule bg-paper-2 px-lg py-md">
          {!readToEnd && (
            <p className="mb-sm text-xs text-ink-3" role="status">
              Scroll to the end to continue.
            </p>
          )}

          <label className="flex cursor-pointer items-start gap-sm">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-accent)]"
            />
            <span className="text-sm leading-relaxed text-ink-2">
              I understand this is not a medical device, that it is not HIPAA
              compliant, and that I am responsible for what I upload.
            </span>
          </label>

          <div className="mt-md flex flex-wrap items-center justify-end gap-sm">
            <button
              type="button"
              onClick={onDecline}
              className="btn-quiet px-md py-2.5 text-sm"
            >
              Decline
            </button>
            <button
              type="button"
              disabled={!ready}
              onClick={onAccept}
              className="btn-primary inline-flex items-center gap-xs px-lg py-2.5 text-sm"
            >
              <Check className="h-4 w-4" strokeWidth={2.5} />
              Agree and open the console
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
