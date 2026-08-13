const assert = require("node:assert/strict");
const {
  extractFullCourseCodes,
  parseTargetCapacityFromHtml,
} = require("../lib/six-html");

const html = `
  <h3>FK3057 Sains Sepak Bola</h3>
  <div class="list-group-item notice">
    01 Kuota 50 Pendaftar 50
    <button id="form_add:111">Ambil</button>
  </div>
  <div class="list-group-item notice">
    02 Kuota 50 Pendaftar 49
    <button id="form_add:222">Ambil</button>
  </div>
`;

assert.deepEqual(
  parseTargetCapacityFromHtml(html, {
    courseCode: "FK3057",
    sectionNumber: "02",
    label: "FK3057 / kelas 02",
  }),
  { quota: 50, applicants: 49, available: 1, buttonId: "form_add:222" },
);

assert.deepEqual(
  extractFullCourseCodes([
    "Kelas Penuh: DK3014, KU5010. Silakan hapus kelas tersebut.",
  ]),
  ["DK3014", "KU5010"],
);

console.log("Parser HTML dan pesan kelas penuh: OK");
