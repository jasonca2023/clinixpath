import {
  Dna,
  FlaskConical,
  HeartPulse,
  Pill,
  Tag,
  User,
  UserSearch,
} from "lucide-react";

/**
 * Category tokens shared by the checklist.
 *
 * WHY CATEGORIES ARE NOT COLOUR-CODED.
 *
 * An earlier build gave each category its own hue so the panel could be scanned by
 * colour. It read well in isolation and was wrong in context: the hues it reached
 * for are already spoken for. `--color-ok` and `--color-hold` mean *met* and
 * *unresolved* on every verdict in the product, and `--color-accent` means
 * *interactive*. Painting "Medications" green and "Conditions" amber made a green
 * chip mean "met" in one panel and "this is a drug" in the next, which is the
 * failure mode the palette was designed to prevent — the token file reserves those
 * three flags for result state and nothing else.
 *
 * Colour is a shared resource here, so category spends none of it. The distinction
 * is carried by the icon and the word, which is what a reader uses anyway; what is
 * bought back is that every coloured thing on screen now means exactly one thing.
 */
const CATEGORY_CHIP = "bg-paper-2 text-ink-3 border-rule-strong/40";

export const CATEGORY_STYLES = {
  GENETICS: { label: "Genetics", icon: Dna, chip: CATEGORY_CHIP },
  LAB_VALUES: { label: "Lab values", icon: FlaskConical, chip: CATEGORY_CHIP },
  DEMOGRAPHICS: { label: "Demographics", icon: User, chip: CATEGORY_CHIP },
  COMORBIDITIES: {
    // Plain English on screen. "Comorbidities" is correct clinical usage, but it
    // is the longest and least readable chip in the set, and "Conditions" says
    // the same thing. The API enum is unchanged; this is display only.
    label: "Conditions",
    icon: HeartPulse,
    chip: CATEGORY_CHIP,
  },
  MEDICATIONS: { label: "Medications", icon: Pill, chip: CATEGORY_CHIP },
};

export const FALLBACK_CATEGORY = {
  label: "Other",
  icon: Tag,
  chip: CATEGORY_CHIP,
};

export function categoryStyle(category) {
  return CATEGORY_STYLES[category] ?? FALLBACK_CATEGORY;
}

/**
 * The order a clinician reads a chart in: who the patient is, what the tumour
 * is, what the numbers say, what else is going on, what they are taking.
 *
 * Fixed rather than derived from the response, so the panel does not reshuffle
 * between two runs on the same patient. Anything the backend adds later sorts
 * to the end instead of disappearing.
 */
const CATEGORY_ORDER = [
  "DEMOGRAPHICS",
  "GENETICS",
  "LAB_VALUES",
  "COMORBIDITIES",
  "MEDICATIONS",
];

/** Bucket facts by category, preserving the model's order within each group. */
function groupByCategory(rows) {
  const buckets = new Map();
  for (const row of rows) {
    const key = row?.category ?? "OTHER";
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }
  const rank = (key) => {
    const at = CATEGORY_ORDER.indexOf(key);
    return at === -1 ? CATEGORY_ORDER.length : at;
  };
  return [...buckets.entries()]
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([category, facts]) => ({ category, facts }));
}

/**
 * Human label for a category enum.
 *
 * The backend speaks SCREAMING_SNAKE_CASE because that is the API contract; the
 * UI should not. Anything unrecognised is title-cased rather than shown raw, so
 * a new backend category never surfaces as "SOME_NEW_THING".
 */
export function categoryLabel(category) {
  const known = CATEGORY_STYLES[category];
  if (known) return known.label;
  if (!category) return FALLBACK_CATEGORY.label;
  return category
    .toString()
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/^./, (c) => c.toUpperCase());
}

function ChecklistSkeleton() {
  return (
    <div className="space-y-2.5">
      {[0, 1, 2].map((row) => (
        <div
          key={row}
          className="rounded-lg border border-rule/70 bg-paper/40 p-3.5"
        >
          <div className="skeleton h-3 w-24" />
          <div className="skeleton mt-3 h-3.5 w-36" />
          <div className="skeleton mt-2.5 h-4 w-full" />
        </div>
      ))}
    </div>
  );
}

/** Component B: the facts read out of the record. */
export default function PatientChecklist({ items, loading }) {
  const rows = Array.isArray(items) ? items : [];

  // No `flex-1` on the panel below. It has no scroll region and nothing to
  // spread, so absorbing leftover column height only ever produced dead space
  // under the last fact.
  return (
    <section className="flex flex-col">
      <div className="block-label justify-between">
        <div className="flex items-center gap-2">
          <UserSearch className="h-4 w-4 text-ink-3" strokeWidth={2} />
          <h2 className="text-sm font-semibold tracking-tight text-ink">
            Extracted facts
          </h2>
        </div>
        <span className="rounded-md border border-rule/70 bg-paper-2 px-1.5 py-0.5 font-mono text-xs text-ink-3">
          {loading ? "·" : rows.length}
        </span>
      </div>

      {loading ? (
        <ChecklistSkeleton />
      ) : rows.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center px-4 py-10 text-center">
          <p className="text-sm font-medium text-ink-3">
            No extracted facts yet
          </p>
          <p className="mx-auto mt-1.5 max-w-[24ch] text-sm leading-relaxed text-ink-3">
            Facts extracted from the record appear here once a search runs.
          </p>
        </div>
      ) : (
        /* A grouped definition list, not a stack of cards.
         *
         * Every fact used to be a bordered box carrying its own icon and its own
         * category chip. On a real record that is twenty-four boxes and
         * twenty-four repetitions of the same six labels — the chip stopped
         * distinguishing anything the moment more than one fact shared a
         * category, and the borders turned a reference panel into a wall.
         *
         * Grouping states each category ONCE, as a heading, and lets the facts
         * beneath it be what they are: name on the left, measured value on the
         * right. Hairlines instead of boxes. It reads like the lab section of a
         * chart, which is exactly what it is.
         */
        <div className="px-md pb-md">
          {groupByCategory(rows).map(({ category, facts }) => {
            const style = categoryStyle(category);
            const Icon = style.icon;
            return (
              <section key={category} className="animate-rise-in pt-md first:pt-xs">
                <h3 className="flex items-center gap-2 pb-1">
                  <Icon className="h-3.5 w-3.5 text-ink-3" strokeWidth={2.25} />
                  <span className="eyebrow">{categoryLabel(category)}</span>
                </h3>
                <dl>
                  {facts.map((item, index) => (
                    <div
                      key={`${item?.metric_name ?? "metric"}-${index}`}
                      className="flex flex-wrap items-baseline justify-between gap-x-md gap-y-0.5 border-t border-rule py-1.5"
                    >
                      <dt className="min-w-0 text-sm leading-snug text-ink-2">
                        {item?.metric_name ?? "Unnamed metric"}
                      </dt>
                      {/* `value` gives tabular figures, so a column of measured
                          results lines up on the decimal. */}
                      <dd className="value min-w-0 break-words text-sm leading-snug">
                        {item?.extracted_value ?? "not recorded"}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            );
          })}
        </div>
      )}
    </section>
  );
}
