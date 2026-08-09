/**
 * Client-side eligibility scoring.
 *
 * This is a faithful port of `_score_matrix` in backend/main.py. It exists so the
 * ranking can be recomputed instantly when a clinician fills in a missing data
 * point, without spending a model call per keystroke. The two implementations must
 * agree: a trial that ranks third on the server must rank third here before any
 * answer is supplied. `scoreMatrix(nodes, {})` is the identity case that proves it.
 *
 * HOW A GAP GETS RESOLVED, and why there is no model call.
 *
 * When the user answers "what is the ECOG status?", something has to decide whether
 * that answer satisfies the criterion. Sending it back to the model would cost a
 * call per answer and defeat the point of a live re-rank. So the user classifies it
 * themselves: MET, NOT_MET, or still UNRESOLVED. That is honest about who is doing
 * the reasoning. The clinician reads "ECOG 0-1 required", knows the patient is a 1,
 * and says so. We do not pretend to interpret free text we never sent anywhere.
 *
 * The typed value is carried alongside purely as a note, so it can appear on the
 * printed brief. It never drives the score.
 */

export const RESOLUTION = {
  UNRESOLVED: "UNRESOLVED",
  MET: "MET",
  NOT_MET: "NOT_MET",
};

/**
 * The action text shown for an UNKNOWN node.
 *
 * Falls back to the criterion itself when the model gave no explicit order, so a
 * gap is never rendered as an empty row.
 */
export function gapAction(node) {
  const explicit = (node?.data_needed || "").trim();
  if (explicit) return explicit;
  const rule = (node?.trial_rule || "").trim();
  return rule ? `Confirm: ${rule}` : "Confirm this criterion";
}

/**
 * Stable identity for a gap ACROSS trials.
 *
 * Two trials both wanting a recent CBC are one question to the patient, not two, so
 * the key is derived from the action text rather than the node id. Answering it once
 * must resolve it everywhere; that shared identity is the whole basis of the
 * "which one question unlocks the most trials" calculation.
 */
export function gapKey(node) {
  return normalizeKey(gapAction(node));
}

/**
 * Reduce free text to the identity of the question it asks.
 *
 * Every run of non-alphanumeric characters becomes one space. Case, punctuation and
 * hyphenation are noise here: two protocols asking the same thing wrote it in their
 * own house style, and a trailing full stop used to split one question into two
 * rows the user answered twice, while `touches` and `resolves` both undercounted.
 * Since prioritisation is entirely a count of shared questions, a dedup miss is not
 * cosmetic, it is the feature failing quietly.
 *
 * The output alphabet is deliberately narrow: [a-z0-9] separated by single spaces.
 * `gapSlug` relies on that to be reversible into a DOM id without collapsing two
 * distinct keys onto one.
 */
export function normalizeKey(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * DOM-safe id for a gap key.
 *
 * Space to hyphen and nothing else. `normalizeKey` has already removed everything
 * that would need escaping, so this is one-to-one: distinct keys give distinct ids.
 * Substituting on the raw text instead, as this used to, meant "ECOG 0-1 status"
 * and "ECOG 0 1 status" produced the same id, which duplicated ids on the page,
 * pointed a label at the wrong input, and scrolled to the wrong row.
 */
export function gapSlug(key) {
  return normalizeKey(key).replace(/ /g, "-");
}

/**
 * A node's status once the user's answers are applied.
 *
 * Only UNKNOWN nodes are movable. A MATCH or CONFLICT was decided against the
 * record itself and is not something an answer here should overwrite.
 */
export function effectiveStatus(node, answers = {}) {
  if (node?.status !== "UNKNOWN") return node?.status ?? "UNKNOWN";
  const answer = answers[gapKey(node)];
  if (answer?.resolution === RESOLUTION.MET) return "MATCH";
  if (answer?.resolution === RESOLUTION.NOT_MET) return "CONFLICT";
  return "UNKNOWN";
}

/**
 * Port of `_score_matrix`. Keep the arithmetic identical to the backend.
 *
 * Ranking is by how close the patient is to enrolling, not pass/fail. A single
 * CONFLICT is still disqualifying: eligibility is not a majority vote, so blocked
 * trials sort below every unblocked one no matter how much else fits.
 */
/**
 * Round half to even, at four places, to match Python's `round`.
 *
 * `Math.round` breaks ties upward; `round()` breaks them toward even. The two agree
 * everywhere except on an exact tie, which a float score essentially never lands on,
 * but "essentially never" is not the contract this file claims. Since the scores it
 * produces are compared against the server's to decide sort order, a 1e-4
 * disagreement is enough to swap two adjacent trials, so the tie rule is matched
 * rather than assumed unreachable.
 */
function roundHalfEven(value, places = 4) {
  const factor = 10 ** places;
  const scaled = value * factor;
  const lower = Math.floor(scaled);
  const remainder = scaled - lower;
  // Tolerance, because the multiply above is itself inexact.
  if (Math.abs(remainder - 0.5) < 1e-9) {
    return (lower % 2 === 0 ? lower : lower + 1) / factor;
  }
  return Math.round(scaled) / factor;
}

export function scoreMatrix(nodes, answers = {}) {
  const list = Array.isArray(nodes) ? nodes : [];

  // Parity with the backend's `_score_matrix`, and for the same reason. Reading
  // "no conflicts, no unknowns" off an empty list returns LIKELY_ELIGIBLE at 1.0
  // labelled "All criteria met": the strongest verdict this tool has, sorted to the
  // top, resting on nothing. Zero criteria means the trial was not screened.
  if (list.length === 0) {
    return {
      verdict: "NEEDS_DATA",
      score: 0,
      match_count: 0,
      conflict_count: 0,
      unknown_count: 0,
      blockers: 0,
      open_items: 0,
      distance_label: "No criteria were scored",
    };
  }

  const statuses = list.map((n) => effectiveStatus(n, answers));

  const match = statuses.filter((s) => s === "MATCH").length;
  const conflict = statuses.filter((s) => s === "CONFLICT").length;
  const unknown = statuses.filter((s) => s === "UNKNOWN").length;
  const total = Math.max(list.length, 1);

  let verdict;
  let score;
  if (conflict) {
    verdict = "BLOCKED";
    score = Math.max(0, 0.3 - 0.06 * conflict + 0.1 * (match / total));
  } else if (unknown) {
    verdict = "NEEDS_DATA";
    score = 0.55 + 0.4 * (match / total) - 0.03 * Math.min(unknown, 8);
  } else {
    verdict = "LIKELY_ELIGIBLE";
    score = 1;
  }

  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  let distance_label;
  if (conflict) {
    distance_label =
      plural(conflict, "blocking exclusion") +
      (unknown ? `, ${unknown} unresolved` : "");
  } else if (unknown) {
    distance_label = `${plural(unknown, "item")} to confirm`;
  } else {
    distance_label = "All criteria met";
  }

  return {
    verdict,
    score: roundHalfEven(Math.max(0, Math.min(score, 1))),
    match_count: match,
    conflict_count: conflict,
    unknown_count: unknown,
    blockers: conflict,
    open_items: unknown,
    distance_label,
  };
}

/**
 * Re-score and re-sort a candidate list under a set of answers.
 *
 * Sort key mirrors the backend's `(-score, conflict_count, -match_count)`.
 * Each trial keeps its original server score under `baseline`, so the UI can show
 * what moved and by how much rather than silently reshuffling under the user.
 */
export function rankTrials(trials, answers = {}) {
  const list = Array.isArray(trials) ? trials : [];

  const scored = list.map((trial, index) => {
    const next = scoreMatrix(trial?.compliance_matrix, answers);
    return {
      ...trial,
      ...next,
      baseline: {
        rank: index + 1,
        verdict: trial?.verdict,
        score: trial?.score,
        unknown_count: trial?.unknown_count,
      },
    };
  });

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.conflict_count - b.conflict_count ||
      b.match_count - a.match_count,
  );

  return scored.map((trial, index) => ({
    ...trial,
    rank: index + 1,
    rank_delta: trial.baseline.rank - (index + 1),
    verdict_changed: trial.baseline.verdict !== trial.verdict,
  }));
}

/**
 * Every distinct gap across every trial, ordered by how much answering it would buy.
 *
 * This is the core of the prioritisation. `touches` is how many trials mention the
 * gap at all; `resolves` is how many would go from NEEDS_DATA to LIKELY_ELIGIBLE if
 * it were answered MET. `resolves` is the far more useful number and sorts first:
 * a question appearing in eight trials that leaves all eight still incomplete is
 * worth less than one that finishes three outright.
 *
 * `resolves` is computed by actually re-scoring under a hypothetical answer rather
 * than by counting, because "is this the last open item" is a property of the whole
 * matrix, not of the node.
 */
export function gapImpact(trials, answers = {}) {
  const list = Array.isArray(trials) ? trials : [];
  const gaps = new Map();

  for (const trial of list) {
    for (const node of trial?.compliance_matrix ?? []) {
      // Skip gaps the user has already settled; they are no longer questions.
      if (effectiveStatus(node, answers) !== "UNKNOWN") continue;
      const key = gapKey(node);
      const entry = gaps.get(key) ?? {
        key,
        action: gapAction(node),
        category: node?.category,
        trials: new Set(),
        criteria: [],
      };
      if (trial?.nct_id) entry.trials.add(trial.nct_id);
      if (node?.trial_rule) entry.criteria.push(node.trial_rule);
      gaps.set(key, entry);
    }
  }

  const current = new Map(
    list.map((t) => [t?.nct_id, scoreMatrix(t?.compliance_matrix, answers)]),
  );

  return [...gaps.values()]
    .map((entry) => {
      const hypothetical = { ...answers, [entry.key]: { resolution: RESOLUTION.MET } };
      let resolves = 0;
      let advances = 0;
      for (const trial of list) {
        if (!entry.trials.has(trial?.nct_id)) continue;
        const before = current.get(trial?.nct_id);
        const after = scoreMatrix(trial?.compliance_matrix, hypothetical);
        if (after.verdict === "LIKELY_ELIGIBLE" && before?.verdict !== after.verdict) {
          resolves += 1;
        } else if (after.unknown_count < (before?.unknown_count ?? 0)) {
          advances += 1;
        }
      }
      return {
        key: entry.key,
        action: entry.action,
        category: entry.category,
        criteria: entry.criteria,
        trials: [...entry.trials],
        touches: entry.trials.size,
        resolves,
        advances,
      };
    })
    .sort(
      (a, b) =>
        b.resolves - a.resolves ||
        b.touches - a.touches ||
        a.action.localeCompare(b.action),
    );
}

/**
 * Headline summary for the prioritisation panel.
 *
 * Returns null when there is nothing outstanding, so the caller can drop the whole
 * panel rather than render an empty state that says "0 questions remaining".
 */
export function topPriority(trials, answers = {}) {
  const impact = gapImpact(trials, answers);
  if (impact.length === 0) return null;
  const top = impact[0];
  if (top.resolves === 0 && top.touches < 2) return null;
  return top;
}
