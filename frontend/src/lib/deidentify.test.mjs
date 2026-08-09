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
must("continuous narrative phone", "Call 5552318890 after discharge.", ["5552318890"]);

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
must("UUID", "Portal export ID 550e8400-e29b-41d4-a716-446655440000 attached.", ["550e8400-e29b-41d4-a716-446655440000"]);
must("MAC address", "Monitor MAC 00:1A:2B:3C:4D:5E recorded.", ["00:1A:2B:3C:4D:5E"]);
must("month day without year", "Seen March 14 after progression.", ["March 14"]);
must("day month without year", "Seen 14 March after progression.", ["14 March"]);
must("city in prose", "Patient resides in Cleveland and is stable.", ["Cleveland"]);
must("facility beginning St", "Transferred from St. Aloysius Medical Center.", ["St. Aloysius Medical Center"]);
must("relationship name in prose", "His wife Susan was at bedside.", ["Susan"]);
must("staff name with role", "Care coordinated by Karen Ellsworth, oncology navigator.", ["Karen", "Ellsworth"]);
must("patient is name", "Patient is Alice Smith with EGFR mutation.", ["Alice", "Smith"]);
must("employer in prose", "Works as a machinist and works at Voss Precision Tooling.", ["Voss", "Precision", "Tooling"]);

console.log("\n── prose rules must fire at the START of a sentence ──");
// Every rule above triggers on a lowercase verb or relationship word. A chart
// writes those at the start of a sentence constantly, and a lowercase-only
// trigger fails there SILENTLY — the reviewer sees a clean-looking scrub with
// the identifier still in it. Seven of ten cases leaked before these existed.
must("residence, sentence-initial", "Resides in Cleveland with his son.", ["Cleveland"]);
must("residence, lives", "Lives in Cleveland with his son.", ["Cleveland"]);
must("residence, relocated", "Relocated to Cleveland last year.", ["Cleveland"]);
must("employer, sentence-initial", "Works at Voss Precision Tooling.", ["Voss", "Precision"]);
must("employer, employed", "Employed at Voss Precision Tooling.", ["Voss", "Precision"]);
must("relationship, sentence-initial", "Wife Susan was at bedside.", ["Susan"]);
must("relationship, daughter", "Daughter Rebecca provides transport.", ["Rebecca"]);

console.log("\n── geography below state level ──");
// Both found by running the project's OWN sample record through the app and
// reading the review panel, not by reading this file. The sample's address
// block is "Cleveland, 44113" — city straight onto a ZIP, no state — so the
// city+state rule never fired, the ZIP was redacted beside it, and the panel
// looked like the address had been handled.
must("city with ZIP and no state", "Cleveland, 44113", ["Cleveland"]);
must("city with ZIP+4 and no state", "Cleveland, 44113-2201", ["Cleveland"]);
must("address block from the sample record",
  "Address: 1184 Birchwood Avenue, Apt 12C\nCleveland, 44113",
  ["Birchwood", "Cleveland", "44113"]);
// A spelled-out state left BOTH halves in place: the alternation held
// abbreviations only, so "Cleveland, OH" was caught and "Cleveland, Ohio" was not.
must("city with a spelled-out state", "Cleveland, Ohio 44106", ["Cleveland", "Ohio"]);
must("two-word spelled-out state", "Charleston, West Virginia 25301", ["Charleston", "West Virginia"]);
must("city with abbreviation still works", "Cleveland, OH 44106", ["Cleveland", "44106"]);
// The wider state list must not start eating clinical text that merely
// contains a state name.
must("state name inside a clinical term",
  "New York Heart Association class II heart failure.", [], ["New York Heart Association"]);
must("state name inside a source", "Washington Manual guidance followed.", [], ["Washington Manual"]);
must("comma before a big number", "Cycle 3, 45000 platelets noted.", [], ["45000"]);

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
must("patient plus stage is not a name", "Patient is Stage IV NSCLC with EGFR Exon 19 deletion.", [], ["Stage IV", "EGFR Exon 19"]);

// ANATOMY. A capitalised body site is indistinguishable from a place name to
// any rule that has to guess, and the guess was being made: "located in" was a
// geography trigger, so the tumour site was redacted out of the record. A trial
// asking for a lobar primary cannot be matched against a tumour with no site,
// and nothing in the UI would show that the site had gone missing.
must("tumour site kept", "Mass located in the Right Upper Lobe.", [], ["Right Upper Lobe"]);
must("metastatic sites kept", "Metastatic disease located in Liver, Bone and Adrenal Gland.", [], ["Liver", "Bone", "Adrenal Gland"]);
must("nodal station kept", "Lesion located at Left Hilar Lymph Node station 10.", [], ["Left Hilar Lymph Node"]);
must("level of care kept", "Patient transferred from Intensive Care Unit on day 4.", [], ["Intensive Care Unit"]);
// Sites the vault above does NOT name, so these cover the trigger list itself
// rather than the safety net. "located" and "transferred" were geography
// triggers; the vault can only protect anatomy someone thought to list, and no
// list covers a real radiology report.
must("unlisted site kept", "Mass located in Segment VIII on triphasic CT.", [], ["Segment VIII"]);
must("unlisted structure kept", "Deposit located in the Gastrohepatic Ligament.", [], ["Gastrohepatic Ligament"]);
must("nodal station code kept", "Tumour located at Station 4R.", [], ["Station 4R"]);
// `[A-Z]` under a /i flag matches lowercase, which turned "a capitalised word"
// into "any word": these two ate the words around the name, and the first ate
// clinical prose outright.
must("spelled staging is not a name", "Patient is stage four with progressive disease.", [], ["stage four", "progressive disease"]);
must("named scale is not a name", "Participant is Eastern Cooperative Oncology Group status 1.", [], ["Eastern Cooperative Oncology Group"]);
must("word before a staff name kept", "Care coordinated by Karen Ellsworth, oncology navigator.", ["Ellsworth"], ["coordinated by"]);
must("word after a prose name kept", "Patient is Alice Smith with EGFR mutation.", ["Alice"], ["with EGFR mutation"]);
// NDC is a drug PRODUCT code, not a patient identifier, and it is ten digits —
// so the bare ten-digit contact rule claimed it and reported the medication as
// a redacted phone number.
must("drug code kept", "NDC 0078050561 dispensed for 30 days.", [], ["0078050561"]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
