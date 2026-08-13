const assert = require("node:assert/strict");
const { inferPlanSubmissionState } = require("../lib/six-state");

assert.equal(
  inferPlanSubmissionState({ withdrawVisible: true }),
  "submitted",
);
assert.equal(
  inferPlanSubmissionState({ submitVisible: true }),
  "editable",
);
assert.equal(
  inferPlanSubmissionState({
    messages: [
      "Silakan melakukan perwalian tatap muka atau menghubungi dosen wali untuk memperoleh persetujuan rencana studi.",
    ],
  }),
  "submitted",
);
assert.equal(
  inferPlanSubmissionState({
    messages: ["Silakan memperoleh persetujuan rencana studi."],
    submitVisible: true,
  }),
  "editable",
);
assert.equal(inferPlanSubmissionState({}), "unknown");

console.log("Inferensi state Kirim KRS: OK");
