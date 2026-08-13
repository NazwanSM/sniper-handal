const { chromium } = require("playwright");
const { SETTINGS, TARGETS } = require("./config");
const { parseTargetCapacityFromHtml } = require("./lib/six-html");
const { formatSeconds } = require("./lib/time");

const REQUEST_INTERVAL_MS = Number(process.env.PROBE_INTERVAL_MS || 30000);
const MAX_REQUESTS = Number(process.env.PROBE_REQUESTS || 1);
const PROBE_COURSE_CODE = String(
  process.env.PROBE_COURSE_CODE || TARGETS[0]?.courseCode || "",
).toUpperCase();
const TARGET = TARGETS.find(
  (candidate) => candidate.courseCode.toUpperCase() === PROBE_COURSE_CODE,
);

(async () => {
  validateConfiguration();

  const context = await chromium.launchPersistentContext(SETTINGS.profileDir, {
    headless: true,
  });

  try {
    console.log(
      `Read-only probe ${TARGET.courseCode} kelas ${TARGET.sectionNumber}: maksimal ${MAX_REQUESTS} request, interval ${formatSeconds(REQUEST_INTERVAL_MS)}.`,
    );

    for (let attempt = 1; attempt <= MAX_REQUESTS; attempt += 1) {
      const startedAt = Date.now();
      let response;

      try {
        response = await context.request.get(TARGET.url, {
          headers: {
            "cache-control": "no-cache, no-store",
            pragma: "no-cache",
          },
          timeout: SETTINGS.requestTimeoutMs,
        });

        const durationMs = Date.now() - startedAt;
        const headers = response.headers();
        console.log(
          `[${new Date().toLocaleTimeString("id-ID")}] #${attempt} HTTP ${response.status()} (${durationMs} ms)`,
        );
        printRateLimitHeaders(headers);

        if (response.status() === 429) {
          console.error(
            "HTTP 429 diterima. Probe berhenti pada request pertama yang dibatasi; tidak ada retry otomatis.",
          );
          break;
        }

        if (!response.ok()) {
          console.error(`Respons non-sukses; probe dihentikan.`);
          break;
        }

        const html = await response.text();
        const capacity = parseTargetCapacityFromHtml(html, TARGET);
        console.log(
          `${TARGET.courseCode} kelas ${TARGET.sectionNumber}: ${capacity.applicants}/${capacity.quota}, tersedia ${capacity.available}.`,
        );
      } finally {
        await response?.dispose().catch(() => null);
      }

      if (attempt < MAX_REQUESTS) {
        await new Promise((resolve) => setTimeout(resolve, REQUEST_INTERVAL_MS));
      }
    }
  } finally {
    await context.close();
  }
})().catch((error) => {
  console.error(`Probe gagal: ${error.message}`);
  process.exitCode = 1;
});

function validateConfiguration() {
  if (!TARGET) {
    throw new Error(
      `PROBE_COURSE_CODE ${PROBE_COURSE_CODE || "kosong"} tidak ditemukan di TARGETS aktif pada config.js.`,
    );
  }
  if (!Number.isFinite(REQUEST_INTERVAL_MS) || REQUEST_INTERVAL_MS < 10000) {
    throw new Error("PROBE_INTERVAL_MS minimal 10000 ms.");
  }
  if (!Number.isInteger(MAX_REQUESTS) || MAX_REQUESTS < 1 || MAX_REQUESTS > 20) {
    throw new Error("PROBE_REQUESTS harus bilangan bulat 1-20.");
  }
}

function printRateLimitHeaders(headers) {
  const relevantHeaders = [
    "retry-after",
    "ratelimit-limit",
    "ratelimit-remaining",
    "ratelimit-reset",
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
    "server",
  ];
  const found = relevantHeaders
    .filter((name) => headers[name] != null)
    .map((name) => `${name}=${headers[name]}`);
  console.log(found.length > 0 ? `Headers: ${found.join(", ")}` : "Headers rate-limit: tidak tersedia.");
}
