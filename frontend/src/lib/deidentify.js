// Client-side de-identification, targeting the HIPAA Safe Harbor identifier list.
//
// READ THIS BEFORE TRUSTING IT
// ----------------------------
// This module removes *direct* identifiers well and *indirect* identifiers only
// partially. It is a strong first pass, not a compliance control, and it does not
// make anything downstream of it HIPAA compliant: this project has no BAA with the
// model provider, no authentication and no audit log, so the legal posture is
// "synthetic records, or records already de-identified to your institution's
// standard" regardless of how well the patterns below perform. The human review
// gate (RedactionReview.jsx) is load-bearing, not a formality.
//
// Coverage against the 18 Safe Harbor identifiers:
//   1  Names ............................ labelled fields, relationships, titled
//                                         narrative names, all-caps name lines
//   2  Geography < state ................ street, ZIP, city+state, labelled
//                                         city/county, institution names
//   3  Dates except year ................ numeric, ISO, month-name, month-year, DOB
//   4  Telephone ........................ bare and labelled
//   5  Fax .............................. labelled
//   6  Email ............................ yes
//   7  SSN .............................. dashed, and labelled undashed
//   8  Medical record numbers ........... yes
//   9  Health plan beneficiary numbers .. member/policy/group/subscriber
//   10 Account numbers .................. yes
//   11 Certificate / licence numbers .... yes
//   12 Vehicle identifiers .............. VIN, labelled plate
//   13 Device identifiers ............... labelled serial
//   14 Web URLs ......................... yes
//   15 IP addresses ..................... yes
//   16 Biometric identifiers ............ NOT DETECTABLE in free text
//   17 Face photographs ................. N/A (text only)
//   18 Any other unique identifier ...... NPI, DEA, accession, encounter; the
//                                         open-ended clause cannot be automated
//
// Design rule: never destroy clinical meaning. Lab values, units, gene notation and
// staging are protected up front and restored at the end, so the scrubber cannot eat
// "1,200 cells/µL", "EGFR Exon 19" or "eGFR 44 mL/min/1.73m²".

/** Categories reported to the reviewer, in display order. */
export const CATEGORIES = [
  "SSN",
  "MRN / Record No.",
  "Health plan / Account",
  "Provider ID",
  "Vehicle / Device",
  "Phone / Fax",
  "Email",
  "URL / IP",
  "Date",
  "Address",
  "Geography",
  "Institution",
  "Name",
  "Age 90+",
];

// Record-keeping labels that must never be mistaken for gene notation. Without
// this, `MRN A1234` matched the variant pattern below, got vaulted as clinical
// content, and survived scrubbing untouched.
const RECORD_LABELS =
  "MRN|CHART|ACCT|ACCOUNT|PATIENT|RECORD|POLICY|MEMBER|GROUP|SUBSCRIBER|ENCOUNTER|LICENSE|LICENCE|SERIAL|ACCESSION|ID|NPI|DEA|SSN|DOB|PLATE|VIN";

// Department words that legitimately precede a facility suffix. "Radiation
// Oncology" is a service line, not a hospital name, and redacting it would remove
// clinically relevant context.
const DEPARTMENTS =
  "Radiation|Medical|Surgical|Clinical|Gynecologic|Gynaecologic|Pediatric|Paediatric|Thoracic|Neuro|Ortho|Orthopedic|Orthopaedic|Cardiac|Hematologic|Haematologic|Radiation";

const STATES =
  "AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC";

// --- clinical spans that must survive scrubbing -----------------------------
// Matched first, swapped for sentinels, restored last.
const PROTECTED_PATTERNS = [
  // Quantities with a clinical unit: 1,200 cells/µL · 9.4 g/dL · 44 mL/min/1.73m²
  /\b\d[\d,.]*\s*(?:cells\/(?:µ|u|μ)L|g\/dL|mg\/dL|mmol\/L|mEq\/L|ng\/mL|pg\/mL|IU\/L|U\/L|mL\/min(?:\/1\.73\s*m2|\/1\.73\s*m²)?|k\/(?:µ|u|μ)L|10\^\d+\/L|%|mm\s?Hg|kg|cm|mg)\b/gi,
  // Gene / variant notation: EGFR Exon 19 · KRAS G12C · BRAF V600E · PD-L1 TPS
  /\b(?:exon|intron|codon)\s*\d+\b/gi,
  new RegExp(`\\b(?!(?:${RECORD_LABELS})\\b)[A-Z][A-Z0-9-]{1,9}\\s+[A-Z]\\d{1,4}[A-Z]?\\b`, "g"),
  /\bPD-?L?1\b/gi,
  /\bHER-?2\b/gi,
  // Staging and grading: Stage IV · Grade 3 · T2N1M0 · ECOG 1
  /\b(?:stage|grade)\s+(?:[0-9IVX]+[A-Ca-c]?)\b/gi,
  /\bT\d[a-z]?N\d[a-z]?M\d[a-z]?\b/gi,
  /\bECOG\s*(?:PS\s*)?[0-4]\b/gi,
  // Relative intervals carry trial-relevant meaning and are not dates.
  /\b\d+\s*(?:day|days|week|weeks|month|months|year|years)\s*(?:ago|prior|previously|earlier)\b/gi,
];

const SENTINEL_OPEN = "";
const SENTINEL_CLOSE = "";

// Index -> letters (no digits, no lowercase) so no downstream pattern can match it.
const encodeIndex = (i) =>
  String(i)
    .split("")
    .map((d) => String.fromCharCode(65 + Number(d)))
    .join("");

/** Replace clinical spans with sentinels so identifier rules cannot touch them. */
function protectClinical(text) {
  const vault = [];
  let out = text;
  for (const pattern of PROTECTED_PATTERNS) {
    out = out.replace(pattern, (match) => {
      const token = `${SENTINEL_OPEN}${encodeIndex(vault.length)}${SENTINEL_CLOSE}`;
      vault.push(match);
      return token;
    });
  }
  return { text: out, vault };
}

function restoreClinical(text, vault) {
  return text.replace(
    new RegExp(`${SENTINEL_OPEN}([A-J]+)${SENTINEL_CLOSE}`, "g"),
    (_full, letters) => {
      const index = Number(
        letters
          .split("")
          .map((c) => c.charCodeAt(0) - 65)
          .join(""),
      );
      return vault[index] ?? "";
    },
  );
}

const MONTHS =
  "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";

/**
 * Build a "labelled field" replacement.
 *
 * WHY THIS EXISTS. Rules whose colon was optional used to derive the label with
 * `match.split(/[:#]/)[0]`. With no colon in the match that returns the WHOLE
 * match, so `Accession B5678` became `Accession B5678: [REDACTED]` — the
 * identifier echoed back into the output while the line looked redacted, which is
 * the most dangerous possible failure for a review gate. The label now comes from
 * a capture group, so the value is always dropped.
 */
const labelled = (token) => (_match, label) => `${label.trim()}: ${token}`;

// --- identifier rules, applied in this order --------------------------------
// Order matters: email before URL (both contain dots), SSN before generic
// numbers, labelled fields before free-text heuristics.
const RULES = [
  {
    category: "Email",
    pattern: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g,
    replace: () => "[EMAIL REDACTED]",
  },
  {
    category: "URL / IP",
    pattern: /\bhttps?:\/\/\S+|\bwww\.\S+/gi,
    replace: () => "[URL REDACTED]",
  },
  {
    category: "URL / IP",
    pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    replace: () => "[IP REDACTED]",
  },
  // Labelled SSN first, so an undashed one is caught by its label.
  {
    category: "SSN",
    pattern:
      /\b(SSN|Social Security(?: (?:No|Number|#))?)\s*[:#]?\s*\d{3}-?\d{2}-?\d{4}\b/gi,
    replace: () => "[SSN REDACTED]",
  },
  {
    category: "SSN",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    replace: () => "[SSN REDACTED]",
  },
  // Provider identifiers. Common in clinical documents and squarely inside Safe
  // Harbor's catch-all clause.
  {
    category: "Provider ID",
    pattern: /\b(NPI|DEA)\s*[:#]?\s*[A-Z]{0,2}[\d-]{7,12}\b/gi,
    replace: labelled("[REDACTED]"),
  },
  {
    category: "Health plan / Account",
    pattern:
      /\b(Member(?: ID| No| Number| #)?|Policy(?: No| Number| #)?|Group(?: No| Number| #)|Subscriber(?: ID| No| Number| #)?|Insurance(?: ID| No| Number| #)?|Beneficiary(?: ID| No| Number| #)?)\s*[:#]?\s*(?=[\w-]*\d)[A-Z0-9][A-Z0-9-]{2,}\b/gi,
    replace: labelled("[REDACTED]"),
  },
  {
    category: "MRN / Record No.",
    // The value must contain a digit, or `Chart note` matches and the rule eats
    // the word "note".
    pattern:
      /\b(MRN|Medical Record(?: (?:No|Number|#))?|Patient ID|Chart(?: No| Number| #)?|Account(?: No| Number| #)?|Accession(?: No| Number| #)?|Encounter(?: No| ID| #)?|Licen[cs]e(?: No| Number| #)?|Serial(?: No| Number| #)?)\s*[:#]?\s*(?=[\w-]*\d)[A-Z0-9][A-Z0-9-]{2,}\b/gi,
    replace: labelled("[REDACTED]"),
  },
  {
    category: "Vehicle / Device",
    // VIN: 17 chars, no I/O/Q by standard.
    pattern: /\b[A-HJ-NPR-Z0-9]{17}\b/g,
    replace: () => "[VIN REDACTED]",
  },
  {
    category: "Vehicle / Device",
    pattern:
      /\b(Licen[cs]e Plate|Plate(?: No| Number| #)?|Vehicle(?: ID| No| #)?|Device(?: ID| Serial| No| #)?)\s*[:#]?\s*(?=[\w-]*\d)[A-Z0-9][A-Z0-9-]{2,}\b/gi,
    replace: labelled("[REDACTED]"),
  },
  {
    category: "Phone / Fax",
    // No leading \b: it fails on "(555) 231-8890" because "(" is not a word char,
    // which would let bare narrative phone numbers through.
    pattern:
      /(?:\+?1[\s.-]?)?(?:\(\d{3}\)[\s.-]?|\b\d{3}[\s.-])\d{3}[\s.-]\d{4}\b/g,
    replace: () => "[PHONE REDACTED]",
  },
  {
    category: "Phone / Fax",
    // [^\S\n] is horizontal whitespace only; plain \s would swallow the newline
    // and glue the next field onto this one.
    pattern:
      /\b(phone|tel|telephone|fax|mobile|cell|pager|beeper)[^\S\n]*[:#]?[^\S\n]*[\d()+.\t -]{7,}/gi,
    replace: labelled("[REDACTED]"),
  },
  // DOB must be handled BEFORE the generic date rules, otherwise those rewrite it
  // to "[DATE: 1967]" first and this rule only eats the "[DATE:" token, stranding
  // the birth year. Birth year is technically Safe Harbor-permitted, but age is
  // retained separately and is what the trial actually needs, so drop DOB entirely.
  {
    category: "Date",
    pattern: /\b(?:DOB|Date of Birth|Birth ?date)[^\S\n]*[:#]?[^\S\n]*[^\n]*/gi,
    replace: () => "DOB: [REDACTED]",
  },
  // Safe Harbor permits the year. Month/day are removed; year is kept so the model
  // can still reason about treatment sequencing.
  {
    category: "Date",
    pattern: /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g, // ISO
    replace: (_m, y) => `[DATE: ${y}]`,
  },
  {
    category: "Date",
    pattern: /\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/g,
    replace: (_m, _a, _b, y) => `[DATE: ${y.length === 2 ? `20${y}` : y}]`,
  },
  {
    category: "Date",
    pattern: new RegExp(`\\b${MONTHS}\\.?\\s+\\d{1,2},?\\s+(\\d{4})\\b`, "gi"),
    replace: (_m, y) => `[DATE: ${y}]`,
  },
  {
    category: "Date",
    pattern: new RegExp(`\\b\\d{1,2}\\s+${MONTHS}\\.?\\s+(\\d{4})\\b`, "gi"),
    replace: (_m, y) => `[DATE: ${y}]`,
  },
  {
    category: "Date",
    // Month + year with no day still narrows a patient more than the year alone.
    pattern: new RegExp(`\\b${MONTHS}\\.?\\s+(\\d{4})\\b`, "gi"),
    replace: (_m, y) => `[DATE: ${y}]`,
  },
  {
    category: "Date",
    // Bare day/month with no year, but ONLY in a date context. Matching the bare
    // shape ate "Pain 5/10", "1/2 tablet" and "Cycle 2/6"; a yearless date is a
    // weak identifier and a destroyed dose is a real harm, so the context word
    // is required.
    pattern:
      /\b(on|seen|dated|visit(?:ed)?|admitted|discharged|scheduled|appointment|appt|follow-?up|since|as of|returned)([^\S\n]+)\d{1,2}\/\d{1,2}\b(?!\/)/gi,
    replace: (_m, word, gap) => `${word}${gap}[DATE REDACTED]`,
  },
  {
    category: "Geography",
    // Lazily bounded: the value ends at end-of-line, a column gap of two or more
    // spaces, a following `Label:`, or a sentence break. Previously it ran to the
    // newline and swallowed any clinical text sharing the line.
    pattern:
      /\b(address|residence|resides at|city|town|county|province|state|zip|postal code)\s*[:#]\s*[^\n]*?(?=$|\n|[ \t]{2,}|[ \t]+[A-Z][a-z]+[ \t]*:|[.;][ \t]+[A-Z])/gi,
    replace: labelled("[REDACTED]"),
  },
  {
    category: "Address",
    pattern:
      /\b\d{1,6}\s+(?:[A-Z][\w.'-]*\s+){0,4}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Terrace|Ter|Place|Pl|Circle|Cir|Parkway|Pkwy|Suite|Apt|Unit)\b\.?/gi,
    replace: () => "[ADDRESS REDACTED]",
  },
  {
    category: "Address",
    pattern: /\b\d{5}(?:-\d{4})?\b(?=\s*(?:$|[,.\n]))/g,
    replace: () => "[ZIP REDACTED]",
  },
  {
    category: "Name",
    // Must precede the city/state rule: MD, PA, DO and OR are both credentials
    // and state codes, and a credentialled surname is a name.
    pattern: /\b[A-Z][\w'-]+,\s*(?:MD|DO|PA-?C?|RN|NP|PhD|DDS|DMD|MBBS|DVM)\b\.?/g,
    replace: () => "[NAME REDACTED]",
  },
  {
    category: "Geography",
    // "Cleveland, OH" — the single most common way a place survives a scrub that
    // only looks at street lines. A physician credential ("Chen, MD") can collide
    // with a state code; that over-redacts a name, which is the safe direction.
    pattern: new RegExp(
      `\\b[A-Z][a-z]+(?:[ -][A-Z][a-z]+){0,2},\\s*(?:${STATES})\\b\\.?`,
      "g",
    ),
    replace: () => "[CITY REDACTED]",
  },
  {
    category: "Institution",
    // A facility name is an indirect identifier. Service lines are not, so a
    // department word in the leading position is excluded.
    pattern: new RegExp(
      `\\b(?!(?:${DEPARTMENTS})\\b)[A-Z][\\w'-]+(?:\\s+[A-Z][\\w'-]+){0,3}\\s+(?:Hospital|Medical Cent(?:er|re)|Health System|Healthcare|Clinic|Cancer Cent(?:er|re)|Infirmary|Associates|Physicians|Partners)\\b`,
      "g",
    ),
    replace: () => "[INSTITUTION REDACTED]",
  },
  {
    category: "Institution",
    // ALL-CAPS letterheads are how a facility name actually appears at the top of
    // a scanned chart ("NORTHSIDE ONCOLOGY ASSOCIATES"), and the title-case rule
    // above cannot see them. Kept as a separate pattern rather than adding the
    // `i` flag, because case-insensitivity there would let the leading [A-Z]
    // match ordinary prose and swallow running text.
    pattern: new RegExp(
      `\\b(?!(?:${DEPARTMENTS.toUpperCase()})\\b)[A-Z][A-Z'-]{2,}(?:\\s+[A-Z][A-Z'-]+){0,3}\\s+(?:HOSPITAL|MEDICAL CENT(?:ER|RE)|HEALTH SYSTEM|HEALTHCARE|CLINIC|CANCER CENT(?:ER|RE)|INFIRMARY|ASSOCIATES|PHYSICIANS|PARTNERS|ONCOLOGY)\\b`,
      "g",
    ),
    replace: () => "[INSTITUTION REDACTED]",
  },
  // Labelled name fields are the reliable case.
  {
    category: "Name",
    // The value is a NAME, so it is matched as one -- up to five capitalised or
    // initialled tokens -- instead of "the rest of the line". The first
    // lowercase word ends it, which is where the prose resumes.
    pattern:
      /\b(Patient(?: Name)?|Name|Surname|Family Name|Given Name|Guardian|Next of Kin|Emergency Contact|Physician|Provider|Attending|Referring(?: Physician)?|Ordering(?: Provider)?|Signed by|Dictated by|Spouse|Mother|Father|Son|Daughter|Sibling|Caregiver|Contact)\s*[:#]\s*[A-Z][\w'.-]*(?:[ \t]+[A-Z][\w'.-]*){0,4}/gi,
    replace: labelled("[NAME REDACTED]"),
  },
  // Titled names in narrative text: Dr. Alice Chen · Mr. J. Doe · Mrs. M. Ruiz.
  // The middle-initial case is why the optional-initial group exists: the old
  // pattern stopped at "Mr. J" because "." is not whitespace, and published the
  // surname.
  {
    category: "Name",
    pattern:
      /\b(?:Dr|Doctor|Mr|Mrs|Ms|Miss|Prof|RN|NP|PA)\.?\s+(?:[A-Z][\w'-]*\.?[ \t]+){0,3}[A-Z][\w'-]+\b/g,
    replace: () => "[NAME REDACTED]",
  },
];

/**
 * Safe Harbor requires ages over 89 to be aggregated.
 * Ages <= 89 are permitted and are load-bearing for trial matching, so they stay.
 */
function aggregateElderAges(text, tally) {
  const bump = () => {
    tally["Age 90+"] = (tally["Age 90+"] ?? 0) + 1;
  };
  let out = text.replace(
    /\b(\d{2,3})[-\s]?(?:year[s]?[-\s]?old|yo\b|y\/o\b)/gi,
    (match, ageStr) => {
      if (Number(ageStr) > 89) {
        bump();
        return "90 or older";
      }
      return match;
    },
  );
  // "Age: 94" and "aged 94" are the other two common spellings.
  out = out.replace(/\b(aged?)\s*[:#]?\s*(\d{2,3})\b/gi, (match, label, ageStr) => {
    if (Number(ageStr) > 89) {
      bump();
      return `${label} 90 or older`;
    }
    return match;
  });
  return out;
}

/**
 * De-identify clinical free text.
 *
 * @param {string} raw
 * @returns {{ text: string, counts: Record<string, number>, total: number }}
 */
export function deidentify(raw) {
  const counts = {};
  if (!raw || typeof raw !== "string") {
    return { text: "", counts, total: 0 };
  }

  const { text: protectedText, vault } = protectClinical(raw);

  let working = protectedText;
  for (const { category, pattern, replace } of RULES) {
    working = working.replace(pattern, (...args) => {
      counts[category] = (counts[category] ?? 0) + 1;
      return replace(...args);
    });
  }

  working = aggregateElderAges(working, counts);
  working = restoreClinical(working, vault);

  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  return { text: working.trim(), counts, total };
}

export default deidentify;
