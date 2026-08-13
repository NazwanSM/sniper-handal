const { chromium } = require("playwright");
const { SETTINGS } = require("./config");

(async () => {
  const context = await chromium.launchPersistentContext(SETTINGS.profileDir, {
    headless: false,
    viewport: null,
  });

  const page = context.pages()[0] || (await context.newPage());
  await page.goto("https://six.itb.ac.id", {
    waitUntil: "domcontentloaded",
    timeout: SETTINGS.navigationTimeoutMs,
  });

  console.log("\n==========================================");
  console.log(" SIX SESSION SETUP");
  console.log("==========================================\n");
  console.log("1. Login ke SIX secara manual di browser yang terbuka.");
  console.log("2. Pastikan halaman SIX dapat dibuka dengan normal.");
  console.log("3. Tutup browser ketika selesai; sesi tersimpan di six-profile/.\n");

  await new Promise((resolve) => context.once("close", resolve));
})().catch((error) => {
  console.error(`Gagal menyiapkan sesi SIX: ${error.message}`);
  process.exitCode = 1;
});
