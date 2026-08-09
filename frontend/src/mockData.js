// Fail-safe presentation dataset (PRD section 7). Mirrors the exact shape the
// backend (../backend) returns from POST /api/analyze so "Load Presentation Mode"
// never depends on the network holding up on stage.
export const mockData = {
  patient_summary: [
    {
      category: "DEMOGRAPHICS",
      metric_name: "Age Profile",
      extracted_value: "58 years old",
    },
    {
      category: "GENETICS",
      metric_name: "EGFR Target Biomarker",
      extracted_value: "EGFR Exon 19 Deletion Positive",
    },
    {
      category: "LAB_VALUES",
      metric_name: "Absolute Neutrophil Count",
      extracted_value: "1,200 cells/µL",
    },
  ],
  compliance_matrix: [
    {
      id: "node_1",
      category: "GENETICS",
      patient_fact: "EGFR Exon 19 Deletion Positive",
      record_quote:
        "Molecular pathology: EGFR exon 19 deletion (p.E746_A750del) detected, 42% variant allele fraction.",
      criterion_quote:
        "Documented activating EGFR tyrosine kinase mutation confirmed by an accredited laboratory.",
      trial_rule:
        "Patients must present documentation of an active, verified EGFR tyrosine kinase activator mutation.",
      status: "MATCH",
      explanation:
        "The recorded driver mutation is the one this cohort is built around, so the criterion is satisfied on the record as written.",
    },
    {
      id: "node_2",
      category: "LAB_VALUES",
      patient_fact: "Absolute Neutrophil Count: 1,200 cells/µL",
      record_quote: "CBC with differential: ANC 1,200 cells/µL (ref 1,800–7,700).",
      criterion_quote:
        "Absolute Neutrophil Count must be > 1,500 cells/µL at baseline screening.",
      trial_rule:
        "Absolute Neutrophil Count must be strictly greater than 1,500 cells/µL at baseline screening.",
      status: "CONFLICT",
      explanation:
        "The patient is currently neutropenic, which falls below the protocol's baseline safety floor and excludes them as written.",
    },
    {
      id: "node_3",
      category: "MEDICATIONS",
      patient_fact:
        "No mention of explicit immunotherapy wash-out timing in the record.",
      criterion_quote:
        "Must not have received prior anti-PD-1 or anti-PD-L1 therapy within 6 months of enrolment.",
      trial_rule:
        "Must not have received prior anti-PD-1 or anti-PD-L1 checkpoint therapy lines within the last 6 months.",
      status: "UNKNOWN",
      data_needed:
        "Confirm from oncology notes whether any anti-PD-1/PD-L1 agent was given, and the date of the last dose.",
      explanation:
        "The chart records platinum chemotherapy but never states whether a checkpoint inhibitor was given, so this cannot be resolved from the record alone.",
    },
  ],
};

export default mockData;
