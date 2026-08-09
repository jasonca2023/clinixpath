// Regression suite for the de-identification module. Run with:  node src/lib/deidentify.test.mjs
//
// WHY THIS FILE EXISTS. Three identifier leaks shipped in this module and none of
// them were visible by reading it: a titled name published the surname when it
// carried a middle initial, an unpunctuated MRN was swallowed by the clinical
// protection vault, and two rules echoed the identifier back into the output
// while printing "[REDACTED]" beside it. All three were found by executing the
// scrubber, not by reviewing it. Every case below is either one of those bugs or
// a rule that must not eat clinical meaning — the two ways this module can fail.
//
// No test framework: it must stay runnable with a bare `node` on any machine.

import { deidentify } from "./deidentify.js";

let pass = 0, fail = 0;
const must = (label, input, gone, kept = []) => {
  const out = deidentify(input).text;
  const leaked = gone.filter((g) => out.includes(g));
  const lost = kept.filter((k) => !out.includes(k));
  const ok = !leaked.length && !lost.length;
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) {
    console.log(`        out: ${JSON.stringify(out)}`);
    if (leaked.length) console.log(`        LEAKED: ${leaked.join(", ")}`);
    if (lost.length) console.log(`        DESTROYED: ${lost.join(", ")}`);
  }
};

console.log("── the three bugs ──");
must("titled name + initial", "Discussed with Mr. J. Doe and Dr. A. Chen.", ["Doe", "Chen"]);
must("full titled name still works", "Seen by Dr. Alice Chen.", ["Alice", "Chen"]);
must("MRN without colon (was vaulted)", "MRN A1234 recorded.", ["A1234"]);
must("Accession echo bug", "Accession B5678 filed.", ["B5678"]);
must("Chart echo bug", "Chart C9012 pulled.", ["C9012"]);
must("Phone echo bug", "Phone 5552318890 on file.", ["5552318890"]);

console.log("\n── new Safe Harbor coverage ──");
must("undashed labelled SSN", "SSN 412889931", ["412889931"]);
must("NPI", "NPI: 1234567893", ["1234567893"]);
must("DEA", "DEA BC1234563", ["BC1234563"]);
must("member id", "Member ID: XQ99381", ["XQ99381"]);
must("policy no", "Policy No: 5567-22", ["5567-22"]);
must("VIN", "Vehicle 1HGCM82633A004352 impounded.", ["1HGCM82633A004352"]);
must("plate", "License Plate: HJK4410", ["HJK4410"]);
must("ISO date", "Imaging 2024-03-14 showed response.", ["03-14"], ["2024"]);
must("month + year", "Recurrence in March 2025.", ["March"], ["2025"]);
must("bare day/month", "Follow-up 3/14 in clinic.", ["3/14"]);
must("city, state", "Seen in Cleveland, OH last cycle.", ["Cleveland"]);
must("institution", "Treated at Northside Oncology Associates.", ["Northside"]);
must("ALL-CAPS letterhead", "NORTHSIDE ONCOLOGY ASSOCIATES — Clinical Summary", ["NORTHSIDE"]);
must("relationship name", "Mother: Deborah Bellweather", ["Deborah", "Bellweather"]);
must("aged 94", "Patient aged 94 at referral.", ["94"]);

console.log("\n── labelled fields must not eat the rest of the line ──");
must("name field beside clinical text",
  "Physician: Dr. Chen. Patient has Stage IV NSCLC with EGFR Exon 19 deletion.",
  ["Chen"], ["Stage IV NSCLC", "EGFR Exon 19"]);
must("address field beside labs",
  "Address: 4120 Larchmere Blvd. ANC 1,200 cells/uL and ECOG 1 recorded.",
  ["Larchmere"], ["1,200 cells/uL", "ECOG 1"]);
must("single-line record, all three fields",
  "Patient Name: Marcus Bellweather, MRN 88401225, seen 3/14.",
  ["Marcus", "Bellweather", "88401225"]);

console.log("\n── must NOT destroy clinical meaning ──");
must("lab values + genes + staging",
  "ANC 1,200 cells/uL, Hgb 9.4 g/dL, eGFR 44 mL/min/1.73m2, EGFR Exon 19 deletion, KRAS G12C, BRAF V600E, Stage IV, ECOG 1, T2N1M0, PD-L1 TPS 60%",
  [],
  ["1,200 cells/uL","9.4 g/dL","44 mL/min/1.73m2","EGFR Exon 19","KRAS G12C","BRAF V600E","Stage IV","ECOG 1","T2N1M0"]);
must("service line survives", "Referred to Radiation Oncology for consult.", [], ["Radiation Oncology"]);
must("age <= 89 kept", "58-year-old man with NSCLC.", [], ["58-year-old"]);
must("relative interval kept", "Carboplatin completed 8 months ago.", [], ["8 months ago"]);
must("chart note not eaten", "Chart note: patient improved.", [], ["patient improved"]);
must("blood pressure not a date", "BP 120/80 stable.", [], ["120/80"]);
must("pain score kept", "Pain 5/10 at rest.", [], ["5/10"]);
must("dosing fraction kept", "Take 1/2 tablet daily.", [], ["1/2 tablet"]);
must("cycle count kept", "Cycle 2/6 complete.", [], ["Cycle 2/6"]);
must("ALL-CAPS service line kept", "RADIATION ONCOLOGY consult", [], ["RADIATION ONCOLOGY"]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
