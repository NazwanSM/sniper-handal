const { chromium } = require("playwright");
const { PLAN_URL, SETTINGS, TARGETS } = require("./config");
const { playAlarm } = require("./lib/alarm");
const { inferPlanSubmissionState } = require("./lib/six-state");
const { formatSeconds } = require("./lib/time");
const log = require("./lib/logger");
const {
  escapeRegExp,
  extractFullCourseCodes,
  normalizeSectionNumber,
  parseTargetCapacityFromHtml,
  sanitizeTargetHtml,
} = require("./lib/six-html");

let context;
let planPage;
let editablePlan = false;
let pollRoundRateLimited = false;
let rateLimitDetails = null;
let nextPollRequestAt = 0;
let totalPollAttempts = 0;

(async () => {
  validateSettings();
  validateTargets();

  context = await chromium.launchPersistentContext(SETTINGS.profileDir, {
    headless: false,
    viewport: null,
  });

  // Form SIX bersifat server-rendered. Aset visual dan script eksternal tidak
  // diperlukan oleh tombol submit native, jadi blokir agar navigation transaksi
  // tidak menunggu resource yang tidak memengaruhi state KRS.
  await context.route("**/*", async (route) => {
    const resourceType = route.request().resourceType();
    if (
      ["image", "media", "font", "stylesheet", "script"].includes(
        resourceType,
      )
    ) {
      await route.abort();
      return;
    }
    await route.continue();
  });

  planPage = context.pages()[0] || (await context.newPage());
  await planPage.goto(PLAN_URL, {
    waitUntil: "domcontentloaded",
    timeout: SETTINGS.navigationTimeoutMs,
  });
  await mapWithConcurrency(
    TARGETS,
    (target) => replaceTargetPage(target),
    SETTINGS.maxParallelPageLoads,
  );

  log.banner({
    targetCount: TARGETS.length,
    globalInterval: formatSeconds(SETTINGS.pollRequestIntervalMs),
    estimatedTargetInterval: formatSeconds(
      SETTINGS.pollRequestIntervalMs * TARGETS.length,
    ),
  });
  log.targetList(TARGETS);

  await recoverUnsubmittedPlan();

  const pendingTargets = new Set();
  for (const target of TARGETS) {
    if (await isCourseInPlan(target.courseCode)) {
      log.info(`${target.label} sudah ada di Rencana Studi; target dilewati`);
    } else {
      pendingTargets.add(target);
    }
  }
  if (pendingTargets.size > 0) {
    log.info(
      `Monitoring dimulai | ${pendingTargets.size} target antre | estimasi tiap target ${formatSeconds(SETTINGS.pollRequestIntervalMs * pendingTargets.size)}`,
    );
    console.log("");
  }

  while (pendingTargets.size > 0) {
    const availableTargets = await getAvailableTargets([...pendingTargets]);
    if (availableTargets.length === 0) {
      if (pollRoundRateLimited) {
        const retryAfter = rateLimitDetails?.retryAfter
          ? ` Retry-After: ${rateLimitDetails.retryAfter}.`
          : "";
        throw new Error(
          `SIX membatasi IP (HTTP 429).${retryAfter} Polling dihentikan agar blokir tidak diperpanjang.`,
        );
      }
      continue;
    }

    // Polling dan transaksi sama-sama serial karena KRS akun adalah satu state
    // bersama. Riwayat percobaan menjaga semua target diperlakukan setara.
    const target = chooseFairTarget(availableTargets);
    target.originalTarget.lastAttemptAt = Date.now();
    target.originalTarget.registrationAttempts =
      (target.originalTarget.registrationAttempts || 0) + 1;
    log.seatFound({
      target,
      available: target.available,
      registrationAttempt: target.originalTarget.registrationAttempts,
    });
    playAlarm("seat");

    let result;
    try {
      result = await registerTarget(target);
    } catch (registrationError) {
      playAlarm("error");
      log.error(
        `Transaksi ${target.label} terganggu: ${log.summarizeError(registrationError)}`,
      );

      if (editablePlan) {
        log.warn("KRS Belum Kirim terdeteksi | memulai pemulihan otomatis");
        try {
          const recovery = await submitUntilConfirmed(null, Date.now());
          log.info("KRS berhasil dikirim kembali | monitoring dilanjutkan");
          console.log("");
          await reconcilePendingTargets(pendingTargets);
          for (const removedCode of recovery.removedCourseCodes) {
            const removedTarget = TARGETS.find(
              (candidate) => candidate.courseCode.toUpperCase() === removedCode,
            );
            if (removedTarget) pendingTargets.add(removedTarget);
          }
        } catch (recoveryError) {
          throw new Error(
            `Pemulihan otomatis gagal setelah ${registrationError.message}: ${recoveryError.message}`,
          );
        }
      }

      continue;
    }
    for (const removedCode of result.removedCourseCodes) {
      const removedTarget = TARGETS.find(
        (candidate) => candidate.courseCode.toUpperCase() === removedCode,
      );
      if (removedTarget) {
        pendingTargets.add(removedTarget);
      } else {
        log.warn(
          `${removedCode} sudah dihapus, tetapi tidak ada di TARGETS sehingga tidak dipantau ulang`,
        );
      }
    }

    if (result.targetSubmitted) {
      pendingTargets.delete(target.originalTarget);
      log.registrationSuccess(target);
    } else {
      log.warn(`${target.label} belum berhasil | dikembalikan ke antrean`);
      console.log("");
    }
  }

  log.success("Semua target berhasil diamankan");
  await context.close();
})().catch(async (error) => {
  console.log("");
  log.error(log.summarizeError(error));
  playAlarm("error");

  if (editablePlan) {
    log.warn("Mencoba pemulihan KRS terakhir sebelum berhenti");
    try {
      await submitUntilConfirmed(null, Date.now());
      log.info("KRS berhasil dikirim kembali");
    } catch (recoveryError) {
      log.error(
        `Pemulihan terakhir gagal: ${log.summarizeError(recoveryError)}`,
      );
      log.warn(
        "KRS mungkin masih Belum Kirim | segera periksa browser secara manual",
      );
    }
  }

  console.log("Tekan Enter untuk menutup browser.");
  await waitForEnter();
  await context?.close();
  process.exitCode = 1;
});

// ---------------------------------------------------------------------------
// Configuration validation
// ---------------------------------------------------------------------------

function validateSettings() {
  const positiveTimings = [
    "pollRequestIntervalMs",
    "requestTimeoutMs",
    "navigationTimeoutMs",
    "elementTimeoutMs",
    "htmlMountTimeoutMs",
  ];
  for (const key of positiveTimings) {
    if (!Number.isFinite(SETTINGS[key]) || SETTINGS[key] <= 0) {
      throw new Error(`SETTINGS.${key} harus berupa angka positif.`);
    }
  }

  if (
    !Number.isInteger(SETTINGS.maxParallelPageLoads) ||
    SETTINGS.maxParallelPageLoads < 1
  ) {
    throw new Error("SETTINGS.maxParallelPageLoads harus bilangan bulat positif.");
  }
}

function validateTargets() {
  if (TARGETS.length === 0) {
    throw new Error("TARGETS kosong.");
  }

  const targetKeys = new Set();
  for (const target of TARGETS) {
    if (
      !target.courseCode ||
      (!target.sectionNumber && !target.classId) ||
      !target.url
    ) {
      throw new Error(
        "Setiap target wajib memiliki courseCode, url, serta sectionNumber atau classId.",
      );
    }

    const selectorValue = target.sectionNumber
      ? `section:${normalizeSectionNumber(target.sectionNumber)}`
      : `button:${target.classId}`;
    const targetKey = `${target.courseCode.toUpperCase()}|${target.url}|${selectorValue}`;
    if (targetKeys.has(targetKey)) {
      throw new Error(`Target duplikat: ${target.label || target.courseCode}`);
    }
    targetKeys.add(targetKey);
  }
}

// ---------------------------------------------------------------------------
// Fair, rate-limit-aware polling
// ---------------------------------------------------------------------------

async function getAvailableTargets(targets) {
  pollRoundRateLimited = false;
  rateLimitDetails = null;

  // Poll target yang paling lama belum dicek terlebih dahulu. Begitu satu slot
  // ditemukan, hentikan ronde agar transaksi dimulai tanpa menunggu target lain.
  const fairOrder = [...targets].sort(
    (left, right) => (left.lastPolledAt || 0) - (right.lastPolledAt || 0),
  );
  const capacities = [];
  for (const target of fairOrder) {
    await waitForPollRequestSlot();
    const capacity = await checkTargetAvailability(target);
    target.lastPolledAt = Date.now();

    if (capacity) capacities.push(capacity);
    if (capacity?.available > 0 || pollRoundRateLimited) break;
  }

  return capacities.filter((target) => target && target.available > 0);
}

async function waitForPollRequestSlot() {
  const remainingMs = nextPollRequestAt - Date.now();
  if (remainingMs > 0) {
    await planPage.waitForTimeout(remainingMs);
  }
  nextPollRequestAt = Date.now() + SETTINGS.pollRequestIntervalMs;
}

async function checkTargetAvailability(target) {
  let response;
  const startedAt = Date.now();
  const pollNumber = ++totalPollAttempts;
  target.pollAttempts = (target.pollAttempts || 0) + 1;

  try {
    response = await context.request.get(target.url, {
      headers: {
        "cache-control": "no-cache, no-store",
        pragma: "no-cache",
      },
      timeout: SETTINGS.requestTimeoutMs,
    });

    if (!response.ok()) {
      if (response.status() === 429) {
        registerRateLimit(response.headers());
        target.pollFailures = (target.pollFailures || 0) + 1;
        log.pollError({
          pollNumber,
          targetAttempt: target.pollAttempts,
          target,
          failureCount: target.pollFailures,
          durationMs: Date.now() - startedAt,
          message: "HTTP 429 - polling akan dihentikan",
          nextInterval: formatSeconds(SETTINGS.pollRequestIntervalMs),
        });
        return null;
      }
      throw new Error(`SIX mengembalikan HTTP ${response.status()}.`);
    }

    const html = await response.text();
    const capacity = parseTargetCapacityFromHtml(html, target);

    // Simpan dokumen terbaru. Saat slot muncul, HTML ini dipasang ke tab secara
    // lokal sehingga form Ambil/CSRF terbaru siap tanpa network reload lagi.
    target.latestHtml = html;
    target.latestHtmlAt = Date.now();
    target.pollFailures = 0;
    log.pollResult({
      pollNumber,
      targetAttempt: target.pollAttempts,
      target,
      applicants: capacity.applicants,
      quota: capacity.quota,
      available: capacity.available,
      durationMs: Date.now() - startedAt,
      httpStatus: response.status(),
      nextInterval: formatSeconds(SETTINGS.pollRequestIntervalMs),
    });
    return { ...target, ...capacity, originalTarget: target };
  } catch (error) {
    if (!isBrowserConnected()) {
      throw new Error("Browser SIX sudah ditutup; monitoring dihentikan.");
    }

    target.pollFailures = (target.pollFailures || 0) + 1;
    log.pollError({
      pollNumber,
      targetAttempt: target.pollAttempts,
      target,
      failureCount: target.pollFailures,
      durationMs: Date.now() - startedAt,
      message: log.summarizeError(error),
      nextInterval: formatSeconds(SETTINGS.pollRequestIntervalMs),
    });
    return null;
  } finally {
    await response?.dispose().catch(() => null);
  }
}

function registerRateLimit(headers) {
  pollRoundRateLimited = true;
  rateLimitDetails = {
    retryAfter: headers["retry-after"] || null,
    limit: headers["ratelimit-limit"] || headers["x-ratelimit-limit"] || null,
    remaining:
      headers["ratelimit-remaining"] || headers["x-ratelimit-remaining"] || null,
    reset: headers["ratelimit-reset"] || headers["x-ratelimit-reset"] || null,
  };
}

function chooseFairTarget(availableTargets) {
  return [...availableTargets].sort((left, right) => {
    const leftAttempt = left.originalTarget.lastAttemptAt || 0;
    const rightAttempt = right.originalTarget.lastAttemptAt || 0;
    return leftAttempt - rightAttempt;
  })[0];
}

// ---------------------------------------------------------------------------
// Target pages and registration
// ---------------------------------------------------------------------------

async function replaceTargetPage(target) {
  if (!isBrowserConnected()) {
    throw new Error("Browser SIX sudah ditutup.");
  }

  const oldPage = target.page;
  target.page = null;
  if (oldPage && !oldPage.isClosed()) {
    await oldPage.close().catch(() => null);
  }

  const newPage = await context.newPage();
  try {
    await newPage.goto(target.url, {
      waitUntil: "domcontentloaded",
      timeout: SETTINGS.navigationTimeoutMs,
    });
    target.page = newPage;
  } catch (error) {
    await newPage.close().catch(() => null);
    throw error;
  }
}

function isBrowserConnected() {
  if (!context) return false;

  const browser = context.browser();
  if (browser) return browser.isConnected();

  // Fallback untuk context persistent pada versi Playwright yang tidak
  // mengekspos objek Browser secara langsung.
  try {
    context.pages();
    return true;
  } catch {
    return false;
  }
}

async function mapWithConcurrency(items, worker, concurrency) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

async function registerTarget(target) {
  const startedAt = Date.now();
  // Pastikan tab dan tombol target siap sebelum membuka kembali KRS. Tidak ada
  // navigation tambahan setelah Batal Kirim, sehingga race window tetap pendek.
  const addButton = await prepareTargetAddButton(target);
  await addButton.waitFor({
    state: "visible",
    timeout: SETTINGS.elementTimeoutMs,
  });

  await makePlanEditable(startedAt);
  await submitAndWait(target.page, addButton);

  const addMessages = await getAlertMessages(target.page);
  if (!addMessages.some((message) => target.addSuccessPattern.test(message))) {
    if (addMessages.some((message) => /kelas penuh/i.test(message))) {
      log.warn(
        `Slot ${target.label} hilang saat Ambil | mengamankan kembali KRS lama`,
      );
      const recovery = await submitUntilConfirmed(null, startedAt);
      return {
        targetSubmitted: false,
        removedCourseCodes: recovery.removedCourseCodes,
      };
    }

    log.warn(
      `Ambil ${target.label} tanpa flash konfirmasi | tetap lanjut Kirim dan verifikasi Rencana Studi`,
    );
  }

  logStep("Ambil", startedAt);

  const submission = await submitUntilConfirmed(target, startedAt);
  return {
    targetSubmitted: !submission.removedCourseCodes.includes(
      target.courseCode.toUpperCase(),
    ),
    removedCourseCodes: submission.removedCourseCodes,
  };
}

async function prepareTargetAddButton(target) {
  if (!target.page || target.page.isClosed()) {
    log.warn(`Tab ${target.label} tertutup | membuat tab pengganti`);
    await replaceTargetPage(target);
  }

  if (target.latestHtml) {
    await target.page.setContent(sanitizeTargetHtml(target.latestHtml), {
      waitUntil: "domcontentloaded",
      timeout: SETTINGS.htmlMountTimeoutMs,
    });
  }

  try {
    return await getTargetAddButton(target);
  } catch (firstError) {
    // Polling HTTP dapat melihat ID form yang lebih baru daripada DOM tab yang
    // sengaja tidak direload. Segarkan tab sekali sebelum menyimpulkan selector
    // salah; semuanya masih dilakukan sebelum Batal Kirim.
    log.info(`Menyegarkan tab ${target.label} sebelum registrasi`);
    await replaceTargetPage(target);
    try {
      return await getTargetAddButton(target);
    } catch (secondError) {
      throw new Error(
        `Tombol ${target.label} tidak valid setelah tab diperbarui: ${secondError.message} (sebelumnya: ${firstError.message})`,
      );
    }
  }
}

async function getTargetAddButton(target) {
  if (target.sectionNumber) {
    const wantedSection = normalizeSectionNumber(target.sectionNumber);
    const cards = target.page.locator(".list-group-item.notice");
    const matchingIndexes = [];

    for (let index = 0; index < (await cards.count()); index += 1) {
      const text = (await cards.nth(index).innerText()).trim();
      const displayedNumber = text.match(/^(\d{1,3})\b/)?.[1];
      if (
        displayedNumber &&
        normalizeSectionNumber(displayedNumber) === wantedSection
      ) {
        matchingIndexes.push(index);
      }
    }

    if (matchingIndexes.length !== 1) {
      throw new Error(
        `Kartu kelas ${target.sectionNumber} untuk ${target.courseCode} ditemukan ${matchingIndexes.length} kali. Periksa sectionNumber dan URL.`,
      );
    }

    const card = cards.nth(matchingIndexes[0]);
    let addButton = card.getByRole("button", { name: /^Ambil$/i });

    // `buttonId` berasal dari HTML polling terbaru. Memakainya di dalam kartu
    // section yang sudah cocok memastikan hasil HTTP dan tombol browser merujuk
    // kelas yang sama. `classId` tetap menjadi fallback konfigurasi manual.
    const verifiedButtonId = target.buttonId || target.classId;
    if (verifiedButtonId) {
      addButton = card.locator(
        `button[type="submit"][id="${verifiedButtonId}"]`,
      );
    }

    if ((await addButton.count()) !== 1) {
      throw new Error(
        `Tombol Ambil pada kartu kelas ${target.sectionNumber} untuk ${target.courseCode} ditemukan ${await addButton.count()} kali.`,
      );
    }

    return addButton;
  }

  const addButton = target.page.locator(
    `button[type="submit"][id="${target.classId}"]`,
  );
  if ((await addButton.count()) !== 1) {
    throw new Error(
      `Tombol Ambil id ${target.classId} untuk ${target.courseCode} ditemukan ${await addButton.count()} kali. Periksa classId dan URL.`,
    );
  }

  return addButton;
}

async function makePlanEditable(startedAt) {
  let krsForm = getKrsForm(planPage);
  let withdrawButton = krsForm.locator("#form_withdraw");
  let submitButton = krsForm.getByRole("button", { name: /^Kirim$/i });

  if (
    !(await withdrawButton.isVisible().catch(() => false)) &&
    !(await submitButton.isVisible().catch(() => false))
  ) {
    await planPage.reload({
      waitUntil: "domcontentloaded",
      timeout: SETTINGS.navigationTimeoutMs,
    });
    krsForm = getKrsForm(planPage);
    withdrawButton = krsForm.locator("#form_withdraw");
    submitButton = krsForm.getByRole("button", { name: /^Kirim$/i });
  }

  if (await withdrawButton.isVisible().catch(() => false)) {
    // Tandai sebelum klik: bila navigation terganggu sesudah request terkirim,
    // recovery tetap menganggap KRS mungkin sudah terbuka.
    editablePlan = true;
    await submitAndWait(planPage, withdrawButton);

    const messages = await getAlertMessages(planPage);
    const withdrawalConfirmed = messages.some((message) =>
      /rencana studi berhasil dibatalkan/i.test(message),
    );
    const sendButtonVisible = await getKrsForm(planPage)
      .getByRole("button", { name: /^Kirim$/i })
      .isVisible()
      .catch(() => false);
    if (!withdrawalConfirmed && !sendButtonVisible) {
      throw new Error(
        `Batal Kirim tidak dikonfirmasi SIX: ${messages.join(" | ") || "tidak ada alert"}`,
      );
    }
    if (!withdrawalConfirmed) {
      log.warn(
        "Flash Batal Kirim tidak ditemukan | state editable dikonfirmasi dari tombol Kirim",
      );
    }
    logStep("Batal Kirim", startedAt);
    return;
  }

  if (await submitButton.isVisible().catch(() => false)) {
    editablePlan = true;
    return;
  }

  throw new Error("Status Kirim KRS tidak dapat ditentukan.");
}

// ---------------------------------------------------------------------------
// KRS submission and full-course recovery
// ---------------------------------------------------------------------------

async function reconcilePendingTargets(pendingTargets) {
  const bodyText = await planPage.locator("body").innerText();
  for (const target of TARGETS) {
    const escapedCode = escapeRegExp(target.courseCode);
    if (new RegExp(`\\b${escapedCode}\\b`, "i").test(bodyText)) {
      pendingTargets.delete(target);
    } else {
      pendingTargets.add(target);
    }
  }
}

async function submitUntilConfirmed(target, startedAt) {
  let attempt = 0;
  const removedCourseCodes = new Set();

  while (true) {
    attempt += 1;
    const submitButton = getKrsForm(planPage).getByRole("button", {
      name: /^Kirim$/i,
    });
    await submitButton.waitFor({
      state: "visible",
      timeout: SETTINGS.elementTimeoutMs,
    });
    await submitAndWait(planPage, submitButton);

    let messages = await getAlertMessages(planPage);
    const fullMessages = messages.filter((message) => /kelas penuh/i.test(message));

    // Pesan kelas penuh selalu menang atas indikator state lainnya. Pada state
    // editable, SIX tetap dapat merender elemen lama yang mirip tombol withdraw.
    if (fullMessages.length === 0) {
      let submissionState = await getPlanSubmissionState(messages);
      let successFlash = messages.some((message) =>
        /rencana studi berhasil disimpan/i.test(message),
      );

      // Hanya error path yang melakukan satu reload tambahan. Ini menangani
      // respons SIX yang tidak membawa flash maupun tombol lengkap tanpa
      // menambah latency pada jalur sukses normal.
      if (!successFlash && submissionState === "unknown") {
        await planPage.reload({
          waitUntil: "domcontentloaded",
          timeout: SETTINGS.navigationTimeoutMs,
        });
        messages = await getAlertMessages(planPage);
        submissionState = await getPlanSubmissionState(messages);
        successFlash = messages.some((message) =>
          /rencana studi berhasil disimpan/i.test(message),
        );
      }

      if (successFlash || submissionState === "submitted") {
        if (!successFlash) {
          log.warn(
            "Flash Kirim tidak ditemukan | state terkirim dikonfirmasi dari form/pesan perwalian",
          );
        }

        editablePlan = false;
        if (target) {
          const targetWasRemoved = removedCourseCodes.has(
            target.courseCode.toUpperCase(),
          );
          if (!targetWasRemoved) {
            await verifyTargetIsInSubmittedPlan(target);
          }
        }
        logStep(`Kirim (attempt ${attempt})`, startedAt);
        return { removedCourseCodes: [...removedCourseCodes] };
      }

      throw new Error(
        `Kirim tidak dikonfirmasi SIX (state: ${submissionState}): ${messages.join(" | ") || "tidak ada alert"}`,
      );
    }

    playAlarm("error");
    log.error(
      `Kirim ditolak | upaya kirim #${attempt} | ${fullMessages.join(" | ")}`,
    );

    const fullCourseCodes = extractFullCourseCodes(fullMessages);
    if (fullCourseCodes.length === 0) {
      throw new Error(
        "SIX melaporkan Kelas Penuh, tetapi kode mata kuliahnya tidak dapat dibaca. Penghapusan otomatis dibatalkan agar tidak salah sasaran.",
      );
    }

    const coursesToRemove = fullCourseCodes.filter(
      (courseCode) => !removedCourseCodes.has(courseCode),
    );
    if (coursesToRemove.length === 0) {
      throw new Error(
        `SIX masih melaporkan kelas yang sudah dihapus sebagai penuh: ${fullCourseCodes.join(", ")}.`,
      );
    }

    // Semua mata kuliah diperlakukan setara. Yang dilaporkan penuh dilepas dari
    // draft, KRS tersisa diamankan, lalu semuanya masuk kembali ke antrean.
    for (const courseCode of coursesToRemove) {
      log.warn(
        `Melepas ${courseCode} dari draft | akan dimasukkan kembali ke antrean`,
      );
    }
    await removeCoursesFromDraft(coursesToRemove);
    coursesToRemove.forEach((courseCode) => removedCourseCodes.add(courseCode));

    log.info(`Mengirim ulang KRS tersisa | upaya berikutnya #${attempt + 1}`);
  }
}

async function removeCoursesFromDraft(courseCodes) {
  if (courseCodes.length > 1 && (await canBatchRemoveCourses(courseCodes))) {
    const rows = await Promise.all(courseCodes.map(getUniqueCourseRow));
    for (const row of rows) {
      await row.locator('input[type="checkbox"]').check();
    }

    const batchRemoveControl = await getUniqueBatchRemoveControl(courseCodes);
    await submitAndWait(planPage, batchRemoveControl, { acceptDialog: true });

    for (const courseCode of courseCodes) {
      if ((await (await getCourseRows(courseCode)).count()) > 0) {
        throw new Error(`SIX belum menghapus ${courseCode} pada batch Hapus.`);
      }
      log.success(`${courseCode} berhasil dihapus dari draft (batch)`);
    }
    return;
  }

  for (const courseCode of courseCodes) {
    await removeCourseFromDraft(courseCode);
  }
}

async function canBatchRemoveCourses(courseCodes) {
  try {
    for (const courseCode of courseCodes) {
      const row = await getUniqueCourseRow(courseCode);
      if ((await row.locator('input[type="checkbox"]').count()) !== 1) {
        return false;
      }
    }

    await getUniqueBatchRemoveControl(courseCodes);
    return true;
  } catch {
    return false;
  }
}

async function getUniqueBatchRemoveControl(courseCodes) {
  const controls = getKrsForm(planPage).locator(
    'button, input[type="submit"], a[href], a[role="button"]',
  );
  const matchingIndexes = await controls.evaluateAll((elements, codes) => {
    const normalizedCodes = codes.map((code) => code.toUpperCase());
    return elements.flatMap((element, index) => {
      const signature = [
        element.id,
        element.getAttribute("name"),
        element.getAttribute("value"),
        element.textContent,
        element.getAttribute("title"),
        element.getAttribute("aria-label"),
        element.getAttribute("formaction"),
        element.getAttribute("href"),
        element.className,
        element.innerHTML,
      ]
        .filter(Boolean)
        .join(" ");
      if (!/hapus|delete|remove|drop|trash/i.test(signature)) return [];

      const row = element.closest("tr, .list-group-item, li");
      const rowText = (row?.innerText || "").toUpperCase();
      const belongsToCourseRow = normalizedCodes.some((code) =>
        rowText.includes(code),
      );
      return belongsToCourseRow ? [] : [index];
    });
  }, courseCodes);

  if (matchingIndexes.length !== 1) {
    throw new Error(
      `Tombol Hapus batch ditemukan ${matchingIndexes.length} kali.`,
    );
  }
  return controls.nth(matchingIndexes[0]);
}

async function removeCourseFromDraft(courseCode) {
  const courseRow = await getUniqueCourseRow(courseCode);
  const directRemoveControl = await getUniqueRemoveControl(courseRow, false);

  if (directRemoveControl) {
    await submitAndWait(planPage, directRemoveControl, { acceptDialog: true });
  } else {
    const selectors = courseRow.locator(
      'input[type="checkbox"], input[type="radio"]',
    );
    const selectorCount = await selectors.count();
    if (selectorCount !== 1) {
      throw new Error(
        `Baris ${courseCode} ditemukan, tetapi kontrol pemilihnya berjumlah ${selectorCount}. Penghapusan otomatis dibatalkan.`,
      );
    }

    await selectors.check();
    const formRemoveControl = await getUniqueRemoveControl(
      getKrsForm(planPage),
      true,
    );
    await submitAndWait(planPage, formRemoveControl, { acceptDialog: true });
  }

  const remainingRows = await getCourseRows(courseCode);
  if ((await remainingRows.count()) > 0) {
    const messages = await getAlertMessages(planPage);
    throw new Error(
      `SIX belum menghapus ${courseCode}: ${messages.join(" | ") || "tidak ada konfirmasi"}`,
    );
  }

  log.success(`${courseCode} berhasil dihapus dari draft`);
}

async function getUniqueCourseRow(courseCode) {
  const rows = await getCourseRows(courseCode);
  const count = await rows.count();

  if (count !== 1) {
    throw new Error(
      `Baris mata kuliah ${courseCode} ditemukan ${count} kali. Penghapusan otomatis dibatalkan agar tidak salah sasaran.`,
    );
  }

  return rows.first();
}

async function getCourseRows(courseCode) {
  const escapedCode = escapeRegExp(courseCode);
  const exactCode = new RegExp(`\\b${escapedCode}\\b`, "i");

  // Prioritaskan struktur paling spesifik supaya parent container yang juga
  // memuat kode yang sama tidak ikut dianggap sebagai baris mata kuliah.
  for (const selector of ["tr", ".list-group-item", ".card", "li"]) {
    const matches = planPage.locator(selector).filter({ hasText: exactCode });
    if ((await matches.count()) > 0) {
      return matches;
    }
  }

  return planPage.locator("tr").filter({ hasText: exactCode });
}

async function getUniqueRemoveControl(scope, required) {
  const controls = scope.locator(
    'button, input[type="submit"], a[href], a[role="button"]',
  );
  const matchingIndexes = await controls.evaluateAll((elements) =>
    elements.flatMap((element, index) => {
      const signature = [
        element.id,
        element.getAttribute("name"),
        element.getAttribute("value"),
        element.textContent,
        element.getAttribute("title"),
        element.getAttribute("aria-label"),
        element.getAttribute("formaction"),
        element.getAttribute("href"),
        element.className,
        element.innerHTML,
      ]
        .filter(Boolean)
        .join(" ");

      return /hapus|delete|remove|drop|trash/i.test(signature) ? [index] : [];
    }),
  );

  if (matchingIndexes.length === 1) {
    return controls.nth(matchingIndexes[0]);
  }

  if (matchingIndexes.length > 1 || required) {
    throw new Error(
      `Kontrol Hapus ditemukan ${matchingIndexes.length} kali. Penghapusan otomatis dibatalkan agar tidak salah sasaran.`,
    );
  }

  return null;
}

async function recoverUnsubmittedPlan() {
  const submitButton = getKrsForm(planPage).getByRole("button", {
    name: /^Kirim$/i,
  });

  if (!(await submitButton.isVisible().catch(() => false))) {
    return;
  }

  editablePlan = true;
  log.warn(
    "Ditemukan KRS Belum Kirim dari sesi sebelumnya | menyelesaikan Kirim dahulu",
  );
  await submitUntilConfirmed(null, Date.now());
  log.success("KRS lama sudah kembali berstatus Kirim");
  console.log("");
}

async function verifyTargetIsInSubmittedPlan(target) {
  if (!(await isCourseInPlan(target.courseCode))) {
    editablePlan = false;
    throw new Error(
      `KRS terkirim, tetapi ${target.courseCode} tidak ditemukan pada halaman Rencana Studi. Periksa manual.`,
    );
  }
}

async function isCourseInPlan(courseCode) {
  const bodyText = await planPage.locator("body").innerText();
  const escapedCode = escapeRegExp(courseCode);
  return new RegExp(`\\b${escapedCode}\\b`, "i").test(bodyText);
}

// ---------------------------------------------------------------------------
// Shared browser helpers
// ---------------------------------------------------------------------------

function getKrsForm(currentPage) {
  const planId = new URL(PLAN_URL).pathname.split("/").pop();
  return currentPage.locator(
    `form[action*="/registrasi/rencanastudi/aD/${planId}"]`,
  );
}

async function submitAndWait(
  currentPage,
  button,
  { acceptDialog = false } = {},
) {
  const dialogHandler = (dialog) => dialog.accept();
  if (acceptDialog) {
    currentPage.on("dialog", dialogHandler);
  }

  try {
    const [navigationResponse] = await Promise.all([
      currentPage.waitForNavigation({
        waitUntil: "domcontentloaded",
        timeout: SETTINGS.navigationTimeoutMs,
      }),
      button.click({ noWaitAfter: true }),
    ]);

    if (navigationResponse && !navigationResponse.ok()) {
      throw new Error(
        `SIX mengembalikan HTTP ${navigationResponse.status()} setelah submit.`,
      );
    }

    // DOMContentLoaded memastikan seluruh HTML respons—termasuk flash alert dan
    // form state baru—sudah diparse. Aset berat tetap diblokir sehingga kita
    // tidak menunggu load event penuh.
  } finally {
    if (acceptDialog) {
      currentPage.off("dialog", dialogHandler);
    }
  }
}

async function getAlertMessages(currentPage) {
  return (await currentPage.locator(".alert").allInnerTexts())
    .map((message) => message.trim())
    .filter(Boolean);
}

async function getPlanSubmissionState(messages) {
  const krsForm = getKrsForm(planPage);
  const [submitVisible, withdrawVisible] = await Promise.all([
    krsForm
      .getByRole("button", { name: /^Kirim$/i })
      .isVisible()
      .catch(() => false),
    krsForm
      .locator("#form_withdraw")
      .isVisible()
      .catch(() => false),
  ]);

  return inferPlanSubmissionState({
    messages,
    submitVisible,
    withdrawVisible,
  });
}

function logStep(action, startedAt) {
  log.transactionStep(action, Date.now() - startedAt);
}

function waitForEnter() {
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", resolve);
  });
}
