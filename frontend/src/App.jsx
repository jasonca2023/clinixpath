import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { gapImpact, rankTrials } from "./lib/scoring.js";
import { AlertTriangle, RotateCcw, ShieldCheck } from "lucide-react";
import Header from "./components/Header.jsx";
import IngestionPanel from "./components/IngestionPanel.jsx";
import PatientChecklist from "./components/PatientChecklist.jsx";
import ComplianceMatrix from "./components/ComplianceMatrix.jsx";
import TrialCandidates from "./components/TrialCandidates.jsx";
import RedactionReview from "./components/RedactionReview.jsx";
import SourceViewer from "./components/SourceViewer.jsx";
import DataGapChecklist, { gapRowId } from "./components/DataGapChecklist.jsx";
import GapPriority from "./components/GapPriority.jsx";
import TrialBrief from "./components/TrialBrief.jsx";
import SearchProgress from "./components/SearchProgress.jsx";
import Landing from "./components/Landing.jsx";
import TermsGate from "./components/TermsGate.jsx";
import {
  acceptTerms,
  clearLastRun,
  hasAcceptedTerms,
  loadLastRun,
  saveLastRun,
} from "./lib/session.js";
import { extractPdfText } from "./lib/pdfText.js";
import { deidentify } from "./lib/deidentify.js";
import { mockData } from "./mockData.js";

// Set VITE_API_BASE_URL at build time to point at a deployed backend (see
// ../backend). The localhost fallback keeps `npm run dev` working with no env
// file at all; hardcoding it meant a deployed build silently posted patient text
// at the visitor's own machine and failed with a connection error.
const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL?.replace(/\/+$/, "") ||
  "http://localhost:8000";

// PRD section 1: no auth. A single active session is hardcoded for the demo.
const SESSION_ID = "demo-user";

// A small PDF parses in ~100ms, which made the scrub overlay flash for a few
// frames and read as a glitch rather than a step. Holding a floor gives the
// stage time to be seen, and it is honest: the work genuinely happened.
const MIN_SCRUB_MS = 700;
// Overlap: the review modal opens while the overlay is still up, so the scrim
// covers it instead of the overlay popping out to reveal a bare panel first.
const SCRUB_HANDOFF_MS = 260;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Charts are text; 40 MB is a generous ceiling for one. The cap exists because
// `extractPdfText` reads the whole file into an ArrayBuffer before pdf.js sees a
// byte of it, so an oversized file is a frozen tab, not an error message.
const MAX_PDF_BYTES = 40 * 1024 * 1024;

/**
 * Reject anything that is not a PDF we can actually parse.
 *
 * `accept="application/pdf"` on the file input constrains the browse dialog and
 * nothing else: a drag-and-drop hands over whatever was dragged, so a video file
 * reached the parser and surfaced as "Could not read that PDF" after a long stall.
 * Checked here rather than in the panel because both the drop target and the
 * browse dialog funnel through this one callback.
 *
 * @returns {string|null} the reason it was rejected, or null when it is fine
 */
function rejectionReason(file) {
  const name = (file?.name ?? "").toLowerCase();
  const type = file?.type ?? "";
  // Some browsers report an empty type for a dragged file, so the extension is the
  // fallback rather than the primary test.
  const looksLikePdf = type === "application/pdf" || name.endsWith(".pdf");
  if (!looksLikePdf) {
    return `${file?.name || "That file"} is not a PDF. Export the record as a PDF and try again.`;
  }
  if (file.size > MAX_PDF_BYTES) {
    const mb = (file.size / 1024 / 1024).toFixed(0);
    return `${file.name} is ${mb} MB, over the ${MAX_PDF_BYTES / 1024 / 1024} MB limit. Parsing happens in this tab, so a file that size would hang the page.`;
  }
  if (file.size === 0) {
    return `${file.name} is empty.`;
  }
  return null;
}


/**
 * Read a server-sent event stream and return the final DiscoveryPayload.
 *
 * `onProgress` is called with a cumulative snapshot as each event lands, so the
 * wait screen can report real work instead of a plausible sequence on a timer.
 *
 * Frames are split on a blank line, and a partial frame is carried over between
 * chunks: a network read boundary lands wherever it likes, and parsing per-chunk
 * silently drops whichever event happened to straddle one.
 */
async function readDiscoveryStream(response, onProgress) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = null;
  const seen = [];

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      const line = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;

      let event;
      try {
        event = JSON.parse(line.slice(6));
      } catch {
        continue; // a malformed frame is not worth killing the run over
      }

      if (event.event === "error") throw new Error(event.detail);
      if (event.event === "done") {
        finished = event.payload;
        continue;
      }
      if (event.event === "trial") seen.push(event);
      onProgress?.((prev) => ({
        ...prev,
        ...(event.event === "searched"
          ? { condition: event.condition, found: event.found }
          : {}),
        ...(event.event === "screening" ? { total: event.total } : {}),
        trials: [...seen],
      }));
    }
  }

  if (!finished) {
    // The stream ended without a terminal event: the server died or a proxy cut
    // it. Saying so beats returning an empty result that looks like "no trials".
    throw new Error(
      "The connection closed before the run finished. Nothing was retained; try again.",
    );
  }
  return finished;
}

// Module scope so the identity is stable across renders; see `gapSource`.
const EMPTY_LIST = [];
const EMPTY_GAP_SOURCE = [];

/**
 * A section of the console document.
 *
 * The whole container vocabulary: a surface, a header row carrying the label and
 * an optional count and action, then the content well. `weight="instrument"`
 * raises the audit readout above everything else and gives it the page's only
 * accent edge, because it is the thing the page exists to deliver.
 *
 * (This comment used to say "there is no card component". That was true of a
 * previous build whose containers were bare top rules; it read as flat, and the
 * reversal is documented on `.panel` in index.css.)
 */
function ConsoleBlock({ label, meta, action, weight, children }) {
  return (
    <section
      className={`enter-content mt-xl ${
        weight === "instrument" ? "instrument" : "panel"
      }`}
    >
      <div className="block-label flex-wrap justify-between">
        <div className="flex items-baseline gap-sm">
          {/* The section name is a heading now, not a mono tag. Uppercase mono
              on every block was giving twelve equal-weight labels and no
              hierarchy; the display face at real size says which block matters. */}
          <h2 className="font-display text-lg font-semibold tracking-tightish text-ink">
            {label}
          </h2>
          {meta && (
            <span className="font-mono text-xs tabular-nums text-ink-3">{meta}</span>
          )}
        </div>
        {action}
      </div>
      <div className="panel-body space-y-3">{children}</div>
    </section>
  );
}

function Console() {
  /* The last run, restored once on mount.
   *
   * Read lazily in the initialiser rather than in an effect: an effect paints
   * the empty console first and swaps the results in afterwards, which reads as
   * the page losing your work and then changing its mind. */
  const [restored] = useState(() => loadLastRun());

  const [trialUrl, setTrialUrl] = useState("");
  const [location, setLocation] = useState("");
  // Discovery results (one record -> many ranked trials).
  const [discovery, setDiscovery] = useState(() => restored?.discovery ?? null);
  const [file, setFile] = useState(null);
  const [scrubbing, setScrubbing] = useState(false);
  const [loading, setLoading] = useState(false);
  // Live only while a run is in flight, so the search page can stop it.
  const abortRef = useRef(null);
  // Real progress, streamed from the server: {condition, found, total, trials[]}.
  const [progress, setProgress] = useState(null);

  const [error, setError] = useState(null);
  const [result, setResult] = useState(() => restored?.result ?? null);
  const [demoMode, setDemoMode] = useState(false);
  // Parsed + scrubbed text awaiting human approval. Never auto-sent.
  const [review, setReview] = useState(null);
  // Kept after sending so evidence quotes can be highlighted in the real source.
  // This is the de-identified text only; the original PDF is never retained.
  const [approvedText, setApprovedText] = useState(() => restored?.approvedText ?? "");
  const [trialCriteria, setTrialCriteria] = useState(() => restored?.trialCriteria ?? "");
  const [sourceView, setSourceView] = useState(null);
  // Answers the clinician has supplied for gaps the record left open, keyed by
  // `gapKey`. This is the single owner of that map: the checklist writes into it
  // and the ranking reads out of it, so both always agree.
  const [answers, setAnswers] = useState(() => restored?.answers ?? {});
  // Which gap row the priority panel last pointed at. Transient, purely visual.
  const [highlightGap, setHighlightGap] = useState(null);
  // The intake is a step, not a permanent fixture. Once a record has been run it
  // collapses to a single line stating what was screened, because from that
  // point on the answer is the page and the form is just history. Re-opening it
  // is one click, and it re-opens by itself if the run fails.
  // A restored run means the answer is already on the page, so the form
  // starts collapsed exactly as it would have after the original run.
  const [intakeOpen, setIntakeOpen] = useState(() => !restored);
  // What the model was not shown. The backend caps the record at MAX_PDF_CHARS;
  // saying nothing about it would present a partial screen as a complete one.
  const [truncation, setTruncation] = useState(() => restored?.truncation ?? null);

  /* Persist whatever is currently on the page.
   *
   * Keyed off the pieces a run produces, so answering a gap re-saves too and a
   * reload keeps the re-ranked order rather than reverting to the raw result.
   * Demo mode is excluded: restoring sample data as if it were a real run is
   * exactly the confusion the sample banner exists to prevent. */
  useEffect(() => {
    if (demoMode) return;
    if (!result && !discovery) return;
    saveLastRun({ discovery, result, truncation, answers, approvedText, trialCriteria });
  }, [discovery, result, truncation, answers, approvedText, trialCriteria, demoMode]);

  // Shared empties. A fresh `[]` per render is a new identity, which defeats every
  // memo downstream that takes one of these as a dependency.
  const patientSummary = result?.patient_summary ?? EMPTY_LIST;
  const complianceMatrix = result?.compliance_matrix ?? EMPTY_LIST;
  const hasData = patientSummary.length > 0 || complianceMatrix.length > 0;
  // Gaps come from every scored trial in discovery mode, or the single matrix.
  // Memoised because the single-trial branch builds a fresh array and a fresh
  // wrapper object: as a bare expression it handed the checklist a new identity on
  // every keystroke in the inputs above, so the memo guarding `gapImpact` never
  // once hit.
  const gapSource = useMemo(() => {
    if (discovery?.candidates?.length) return discovery.candidates;
    if (complianceMatrix.length)
      return [{ nct_id: "current", compliance_matrix: complianceMatrix }];
    return EMPTY_GAP_SOURCE;
  }, [discovery, complianceMatrix]);

  /**
   * Re-rank on every answer, in this tab, with nothing in flight.
   *
   * The server ranked these once with the record as written. Each answer is new
   * information about the same patient, so the order it produced is stale the
   * moment one arrives. `rankTrials` is a parity-tested port of the backend's
   * scoring, so with no answers supplied this reproduces the server order exactly
   * and the list does not jump around on arrival.
   */
  const rankedDiscovery = useMemo(() => {
    if (!discovery?.candidates?.length) return discovery;
    return { ...discovery, candidates: rankTrials(discovery.candidates, answers) };
  }, [discovery, answers]);

  // Open gap count for the switcher badge. Cheap next to the ranking itself, but
  // it rides the same answers, so it has to be recomputed alongside it.
  const openGapCount = useMemo(
    () => (gapSource.length ? gapImpact(gapSource, answers).length : 0),
    [gapSource, answers],
  );
  const candidateCount = rankedDiscovery?.candidates?.length ?? 0;
  const hasRun = hasData || candidateCount > 0;

  const handleAnswer = useCallback((key, patch) => {
    setAnswers((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  }, []);

  /**
   * Send a click on the priority panel down to the row that can act on it.
   *
   * The panel names the question but deliberately cannot answer it: one control per
   * gap, in one place, or the two copies disagree about what is selected. So this
   * scrolls to the real control and tints it briefly, which also covers the case
   * where the checklist is offscreen on a short viewport.
   */
  const handleFocusGap = useCallback((key) => {
    setHighlightGap(key);
    // After paint, so the row exists and any layout shift has settled.
    requestAnimationFrame(() => {
      document
        .getElementById(gapRowId(key))
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, []);

  useEffect(() => {
    if (!highlightGap) return undefined;
    const timer = window.setTimeout(() => setHighlightGap(null), 2200);
    return () => window.clearTimeout(timer);
  }, [highlightGap]);

  /**
   * Stage the file. Parsing happens later (on Run) so the PDF is only ever held as
   * a local File handle until the clinician actually starts an audit.
   */
  const handleFileSelected = useCallback((incoming) => {
    if (!incoming) return;
    const reason = rejectionReason(incoming);
    if (reason) {
      setFile(null);
      setError({ title: "That file cannot be read", detail: reason });
      return;
    }
    setError(null);
    setFile(incoming);
  }, []);

  const handleClearFile = useCallback(() => {
    setFile(null);
  }, []);

  /** Open the evidence viewer for whichever half of a row was clicked. */
  const handleShowSource = useCallback(
    (which, row) => {
      if (which === "record") {
        setSourceView({
          title: "Patient record",
          source: approvedText,
          quote: row?.record_quote ?? "",
        });
      } else {
        // In discovery mode each trial carries its own criteria text; fall back to
        // the single-trial criteria, then to the rule itself.
        const owner = (discovery?.candidates ?? []).find((c) =>
          (c.compliance_matrix ?? []).some((n) => n === row),
        );
        setSourceView({
          title: "Trial eligibility criteria",
          source:
            owner?.trial_criteria || trialCriteria || row?.trial_rule || "",
          quote: row?.criterion_quote ?? "",
        });
      }
    },
    [approvedText, trialCriteria, discovery],
  );

  /**
   * Sample-audit fallback. Reachable only from the error path, so a failed backend
   * still gives the user something to look at instead of an empty screen.
   */
  const handleLoadSample = useCallback(() => {
    setScrubbing(false);
    setLoading(false);
    setError(null);
    setReview(null);
    setResult(mockData);
    setTruncation(null);
    setAnswers({});
    setIntakeOpen(false);
    setDemoMode(true);
  }, []);

  /* Screen the next few trials without re-running everything.
   *
   * DEFAULT_MAX_TRIALS caps the shortlist because each trial on it costs a model
   * call, but the registry routinely returns twice that many — so a run where
   * all four come back blocked used to be the end of the road, with the other
   * four studies sitting unexamined on the server.
   *
   * Reuses the text the clinician already approved rather than re-parsing the
   * PDF, and tells the server which NCT ids it has already seen so the second
   * pass screens genuinely new studies. Results MERGE into the existing list, so
   * the ranking is over everything screened so far rather than restarting.
   */
  const handleScreenMore = useCallback(async () => {
    if (!approvedText || !discovery) return;

    const seen = [
      ...(discovery.candidates ?? []).map((c) => c?.nct_id),
      // Failures count as seen. Without them a study that could not be scored
      // would be retried on every press, spending the budget on the one trial
      // least likely to succeed.
      ...(discovery.failed ?? []).map((f) => String(f).match(/NCT\d+/)?.[0]),
    ].filter(Boolean);

    setError(null);
    setProgress(null);
    setLoading(true);
    const canceller = new AbortController();
    abortRef.current = canceller;

    try {
      const form = new FormData();
      form.append("patient_text", approvedText);
      form.append("session_id", SESSION_ID);
      form.append("location", location.trim());
      form.append("exclude_nct", seen.join(","));
      if (discovery.search_condition) {
        // Reuse the condition already derived. It saves a model call, and it
        // guarantees the second page is drawn from the same search as the first.
        form.append("condition", discovery.search_condition);
      }

      const response = await fetch(`${API_BASE_URL}/api/discover/stream`, {
        method: "POST",
        body: form,
        signal: AbortSignal.any([
          AbortSignal.timeout(720_000),
          canceller.signal,
        ]),
      });
      if (!response.ok) throw new Error(`Service responded with ${response.status}`);

      const payload = await readDiscoveryStream(response, setProgress);
      setDiscovery((prev) => ({
        ...prev,
        trials_screened: (prev?.trials_screened ?? 0) + (payload?.trials_screened ?? 0),
        candidates: [...(prev?.candidates ?? []), ...(payload?.candidates ?? [])],
        failed: [...(prev?.failed ?? []), ...(payload?.failed ?? [])],
      }));
    } catch (caught) {
      if (abortRef.current?.signal.aborted) return;
      setError({
        title: "Could not screen more trials",
        detail: `${caught.message}`,
      });
    } finally {
      abortRef.current = null;
      setLoading(false);
    }
  }, [approvedText, discovery, location]);

  const handleRun = useCallback(async () => {
    if (!file) {
      setError({
        title: "Add the patient record",
        detail:
          "Drop a medical history PDF, or click the upload area to browse.",
      });
      return;
    }

    setError(null);
    setDemoMode(false);
    setResult(null);
    setDiscovery(null);
    setTruncation(null);
    // `gapKey` is derived from the criterion text, not from a run id, so an answer
    // about the last patient would silently apply to this one. Clear on every run.
    setAnswers({});
    setScrubbing(true);

    // PHASE 1, entirely local. Parse the PDF and de-identify it in this tab.
    // No network call happens anywhere in this block.
    const startedAt =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    try {
      const rawText = await extractPdfText(file);
      if (!rawText.trim()) {
        throw new Error(
          "No selectable text found. Scanned/image-only PDFs are not supported.",
        );
      }
      const { text, counts, total } = deidentify(rawText);

      // Let the scrub stage be seen before handing over to the review gate.
      const elapsed =
        (typeof performance !== "undefined" ? performance.now() : Date.now()) -
        startedAt;
      if (elapsed < MIN_SCRUB_MS) await wait(MIN_SCRUB_MS - elapsed);

      setReview({ originalText: rawText, redactedText: text, counts, total });
      // Clear the overlay only once the modal scrim is on top of it.
      await wait(SCRUB_HANDOFF_MS);
      setScrubbing(false);
    } catch (caught) {
      setScrubbing(false);
      setError({
        title: "Could not read that PDF",
        detail: `${caught.message} The file never left your device.`,
      });
    }
  }, [file, trialUrl]);

  /**
   * PHASE 2, the only place patient-derived data crosses the network, and it only
   * runs from an explicit click in the review dialog.
   */
  const handleConfirmedSend = useCallback(
    async (approvedText) => {
      setReview(null);
      setError(null);
      setLoading(true);
      setApprovedText(approvedText);
      // Collapse the intake the moment the run starts, not when it finishes.
      // Leaving it open stacked a live progress panel under a still-editable
      // form, so the screen showed two competing "current steps" at once. The
      // run owns the screen while it is running; a failure re-opens the form.
      setIntakeOpen(false);

      // Two modes off the same record: a URL means "check this trial", no URL
      // means "find every recruiting trial this patient could join".
      const url = trialUrl.trim();
      const discoverMode = url.length === 0;

      try {
        const form = new FormData();
        form.append("patient_text", approvedText);
        form.append("session_id", SESSION_ID);

        if (discoverMode) {
          form.append("location", location.trim());
          // Deliberately not sent. The server owns this number, because the
          // right value depends on the provider's speed — hardcoding 6 here
          // meant a backend tuned for a fast provider still got asked for the
          // slow provider's trial count. See DEFAULT_MAX_TRIALS in main.py.
        } else {
          form.append("trial_url", url);
        }

        // Without a signal this fetch has no deadline at all. A free-tier provider
        // that stalls mid-response leaves the spinner turning forever, with no
        // error and no way back except a page reload — the worst failure mode
        // available, because it looks identical to "still working".
        //
        // Both numbers must stay ABOVE the server's own ceiling for the endpoint,
        // or the tab gives up on a run that was going to succeed and reports a
        // timeout the server never hit. From backend/main.py:
        //   /api/analyze  = LLM_TOTAL_TIMEOUT_SECONDS (150s) + trial fetch (30s)
        //   /api/discover = derive (150) + search (30)
        //                 + DISCOVERY_TOTAL_TIMEOUT_SECONDS (300)
        //                 + one in-flight call (150) = 630s
        // The margins below are deliberate; shrink them only alongside the server.
        // Two ways this request can end early: the deadline above, or the user
        // deciding they are done waiting. A run can take two and a half minutes,
        // and a wait with no way out is the thing that makes people reload the
        // tab — which loses the scrubbed text and starts the whole parse again.
        setProgress(null);
        const canceller = new AbortController();
        abortRef.current = canceller;

        const signal = AbortSignal.any([
          AbortSignal.timeout(discoverMode ? 720_000 : 240_000),
          canceller.signal,
        ]);

        // Discovery streams; a single-trial audit has one step and nothing to
        // report, so it stays a plain request.
        const response = await fetch(
          `${API_BASE_URL}${
            discoverMode ? "/api/discover/stream" : "/api/analyze"
          }`,
          { method: "POST", body: form, signal },
        );

        if (!response.ok) {
          let detail = `Service responded with ${response.status}`;
          try {
            const body = await response.json();
            if (body?.detail) detail = body.detail;
          } catch {
            /* non-JSON error body; keep the status line */
          }
          throw new Error(detail);
        }

        const payload = discoverMode
          ? await readDiscoveryStream(response, setProgress)
          : await response.json();
        setTruncation(payload?.truncation ?? null);

        if (discoverMode) {
          setTrialCriteria("");
          setDiscovery({
            search_condition: payload?.search_condition ?? "",
            // The server drops the location filter when it returns nothing rather
            // than showing an empty page. This flag is how the readout admits it;
            // omitted here, the search silently answers "anywhere".
            location_relaxed: payload?.location_relaxed === true,
            trials_screened: payload?.trials_screened ?? 0,
            candidates: Array.isArray(payload?.candidates)
              ? payload.candidates
              : [],
            failed: Array.isArray(payload?.failed) ? payload.failed : [],
          });
          setResult({
            patient_summary: Array.isArray(payload?.patient_summary)
              ? payload.patient_summary
              : [],
            compliance_matrix: [],
          });
        } else {
          setTrialCriteria(payload?.trial_criteria ?? "");
          setResult({
            patient_summary: Array.isArray(payload?.patient_summary)
              ? payload.patient_summary
              : [],
            compliance_matrix: Array.isArray(payload?.compliance_matrix)
              ? payload.compliance_matrix
              : [],
          });
        }
        setIntakeOpen(false);
      } catch (caught) {
        setResult(null);
        setDiscovery(null);
        setTruncation(null);
        // A failed run puts the form back: the user's next move is to change
        // something and try again, and it should be in front of them.
        setIntakeOpen(true);
        // AbortSignal.timeout() rejects with a TimeoutError, whose message is the
        // unhelpful "signal timed out". Say what actually happened and what to do.
        // A run the user stopped is not a failure and must not be reported as
        // one. The form is already back on screen with their file still staged.
        if (abortRef.current?.signal.aborted) return;

        const timedOut = caught?.name === "TimeoutError";
        setError({
          title: timedOut
            ? "The model took too long to respond"
            : discoverMode
              ? "Trial search failed"
              : "The audit service is unreachable",
          detail: timedOut
            ? "Free-tier model providers queue behind paid traffic and can stall under load. Try again, or switch to a faster model in backend/.env."
            : `${caught.message}`,
          offerSample: true,
        });
      } finally {
        abortRef.current = null;
        setLoading(false);
      }
    },
    [trialUrl, location],
  );

  // A run is its own state of this app, so it gets its own screen. Returning
  // early is what makes it a page rather than a panel: the intake, the results
  // and the footer are not rendered at all, so nothing on screen belongs to a
  // step other than the one actually happening. See SearchProgress.
  if (loading) {
    return (
      // Locked to the viewport, not `min-h-full`: a run is a state you wait in,
      // and there is nothing below the fold to reach. `100dvh` rather than
      // `100vh` so mobile browser chrome collapsing does not leave a gap.
      <div className="relative z-10 flex h-[100dvh] flex-col overflow-hidden">
        <Header />
        <SearchProgress
          active
          mode={trialUrl.trim() ? "analyze" : "discover"}
          fileName={demoMode ? null : file?.name}
          onCancel={() => abortRef.current?.abort()}
          progress={progress}
        />
      </div>
    );
  }

  return (
    <div className="relative z-10 min-h-full">
      <Header />

      <SourceViewer
        open={Boolean(sourceView)}
        title={sourceView?.title ?? ""}
        source={sourceView?.source ?? ""}
        quote={sourceView?.quote ?? ""}
        onClose={() => setSourceView(null)}
      />

      <RedactionReview
        open={Boolean(review)}
        originalText={review?.originalText ?? ""}
        redactedText={review?.redactedText ?? ""}
        counts={review?.counts ?? {}}
        total={review?.total ?? 0}
        onCancel={() => setReview(null)}
        onConfirm={handleConfirmedSend}
      />

      <main className="mx-auto max-w-[1120px] px-md pb-2xl sm:px-lg">
        {/* The intake is a step. Before a run it is the whole page; after one it
            is a single line of provenance, because the answer is what the user
            came for and the form has already done its job. */}
        <div className="disclose" data-open={intakeOpen}>
          <div>
            <IngestionPanel
              trialUrl={trialUrl}
              onTrialUrlChange={setTrialUrl}
              location={location}
              onLocationChange={setLocation}
              file={file}
              onFileSelected={handleFileSelected}
              onClearFile={handleClearFile}
              onRun={handleRun}
              loading={loading}
              scrubbing={scrubbing}
              error={error}
              onDismissError={() => setError(null)}
              onLoadSample={handleLoadSample}
            />
          </div>
        </div>

        <div className="disclose" data-open={!intakeOpen}>
          <div>
            {/* Provenance bar. `.panel` carries a fill and a radius now, so it
                needs its own horizontal padding — without it the text sat
                against the rounded border. The label is body-cased rather than
                a tracked mono cap, and the facts are body type: mono is for
                measured values in this system, and a filename beside a city is
                neither. The filename keeps mono because it IS a literal string
                whose characters matter. */}
            <div className="panel flex flex-wrap items-center gap-x-sm gap-y-xs px-md py-sm">
              <span className="shrink-0 text-sm font-medium text-ink">
                Screened
              </span>
              <p className="min-w-0 flex-1 truncate text-sm text-ink-3">
                <span className="font-mono">
                  {demoMode ? "sample record" : file?.name}
                </span>
                {[
                  location.trim(),
                  rankedDiscovery?.search_condition,
                  candidateCount
                    ? `${candidateCount} ${candidateCount === 1 ? "trial" : "trials"}`
                    : null,
                ]
                  .filter(Boolean)
                  .map((part) => (
                    <span key={part}>
                      <span className="px-2xs text-rule-strong">·</span>
                      {part}
                    </span>
                  ))}
              </p>
              <button
                type="button"
                onClick={() => {
                  // Drop the saved run as well as reopening the form: a reload
                  // would otherwise resurrect the previous patient's results
                  // beside a fresh, empty intake.
                  clearLastRun();
                  setIntakeOpen(true);
                }}
                className="btn-quiet inline-flex shrink-0 items-center gap-xs whitespace-nowrap px-sm py-1.5 text-sm"
              >
                <RotateCcw className="h-3.5 w-3.5" strokeWidth={2.25} />
                New record
              </button>
            </div>
          </div>
        </div>


        {/* The record was longer than the model's context budget, so these verdicts
            rest on part of it. This has to be stated where the verdicts are read:
            a matrix drawn from the first sixth of a chart looks exactly like one
            drawn from all of it, and the difference is what a clinician would act
            on. Styled as a warning rather than a footnote for the same reason. */}
        {truncation?.record_truncated && (
          <div className="enter-content mt-md flex items-start gap-sm border-t border-risk/40 py-sm">
            <AlertTriangle
              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-risk"
              strokeWidth={2.25}
            />
            <p className="text-sm leading-relaxed text-risk">
              <span className="font-mono text-xs uppercase tracking-[0.12em]">
                Partial record screened
              </span>
              <span className="mt-1 block text-ink-2">
                Only the first{" "}
                {truncation.record_chars_used.toLocaleString()} of{" "}
                {truncation.record_chars_total.toLocaleString()} characters were
                sent to the model. Everything below is based on that portion;
                facts later in the record were not read. Split the document and
                run the remainder separately.
              </span>
            </p>
          </div>
        )}

        {demoMode && (
          <p className="enter-content mt-md flex items-center gap-sm border-t border-hold/50 py-sm font-mono text-xs uppercase tracking-[0.12em] text-hold">
            <ShieldCheck className="h-3.5 w-3.5 shrink-0" strokeWidth={2.25} />
            Sample audit · illustrative data, not a real patient record
          </p>
        )}

        {/* Open questions lead. They are the only thing on this page the reader
            can act on today: a ranked trial is information, an unanswered
            criterion is an order to place. Putting them behind a tab, as the
            previous build did, buried the product's actual output. */}
        {gapSource.length > 0 && (
          <ConsoleBlock
            label="Open questions"
            meta={openGapCount ? `${openGapCount} unresolved` : "all resolved"}
          >
            <GapPriority
              trials={rankedDiscovery?.candidates}
              answers={answers}
              onFocusGap={handleFocusGap}
            />
            <DataGapChecklist
              trials={gapSource}
              answers={answers}
              onAnswer={handleAnswer}
              highlightKey={highlightGap}
            />
          </ConsoleBlock>
        )}

        {/* The audit. Full width, nothing beside it.
            Hidden while a run is in flight: SearchProgress already previews this
            shape in skeleton, and showing both meant two competing skeletons of
            the same content on one screen. */}
        <ConsoleBlock
          label={discovery ? "Ranked trials" : "Compliance matrix"}
          // "ranked", not "screened". The bar inside this block already reports
          // trials_screened — how many were ATTEMPTED — and this counts how many
          // came back with a result. Both were labelled "screened", so the panel
          // showed "2 screened" beside "04 SCREENED" and neither number was wrong.
          meta={candidateCount ? `${candidateCount} ranked` : null}
          action={
            rankedDiscovery?.candidates?.length > 0 ? (
              <TrialBrief
                trials={rankedDiscovery.candidates}
                answers={answers}
                searchCondition={rankedDiscovery.search_condition}
                truncation={truncation}
              />
            ) : null
          }
          weight="instrument"
        >
          {discovery ? (
            <TrialCandidates
              result={rankedDiscovery}
              loading={false}
              onShowSource={handleShowSource}
              onScreenMore={handleScreenMore}
            />
          ) : (
            <ComplianceMatrix
              items={complianceMatrix}
              loading={false}
              onShowSource={handleShowSource}
            />
          )}
        </ConsoleBlock>

        {/* Reference, so it closes the document rather than opening it. */}
        {hasRun && (
          <ConsoleBlock
            label="Facts read from the record"
            meta={patientSummary.length ? `${patientSummary.length} extracted` : null}
          >
            <PatientChecklist items={patientSummary} loading={false} />
          </ConsoleBlock>
        )}
      </main>

      {/* Ft2 · inline rule, single line. A console does not close with a
          colophon; it closes with the one caveat that has to travel with every
          verdict on the page, and nothing else. */}
      <footer className="mt-2xl border-t border-rule">
        <div className="mx-auto flex max-w-[1120px] flex-wrap items-baseline gap-x-sm gap-y-2xs px-md py-md text-sm text-ink-3 sm:px-lg">
          <span>Decision support only — confirm eligibility with the study team.</span>
          <span className="text-ink-3">Trial data: ClinicalTrials.gov API v2.</span>
        </div>
      </footer>
    </div>
  );
}

/**
 * Route shell: landing → terms gate → console.
 *
 * First visit lands on the marketing page and cannot reach the console without
 * accepting the terms. Acceptance is remembered per terms version in localStorage,
 * so a returning user goes straight through, but a materially changed version of
 * the terms re-prompts everyone.
 */
export default function App() {
  const [view, setView] = useState("landing");
  const [gateOpen, setGateOpen] = useState(false);
  const [accepted, setAccepted] = useState(false);

  useEffect(() => {
    const already = hasAcceptedTerms();
    setAccepted(already);
    // A returning user who has already agreed opens straight into the console;
    // the landing page is an introduction, not a toll booth they pay every time.
    if (already) setView("console");
  }, []);

  const enterConsole = useCallback(() => {
    if (hasAcceptedTerms()) {
      setAccepted(true);
      setView("console");
      return;
    }
    setGateOpen(true);
  }, []);

  const handleAccept = useCallback(() => {
    acceptTerms();
    setAccepted(true);
    setGateOpen(false);
    setView("console");
  }, []);

  if (view === "console" && accepted) return <Console />;

  return (
    <>
      <Landing onEnter={enterConsole} />
      {gateOpen && (
        <TermsGate
          onAccept={handleAccept}
          onDecline={() => setGateOpen(false)}
        />
      )}
    </>
  );
}
