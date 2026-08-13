const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

const code = (value) => (useColor ? `\x1b[${value}m` : "");
const color = {
  reset: code(0),
  bold: code(1),
  dim: code(2),
  cyan: code(36),
  green: code(32),
  yellow: code(33),
  red: code(31),
  magenta: code(35),
};

function timestamp() {
  return new Date().toLocaleTimeString("id-ID");
}

function paint(value, tone) {
  return `${color[tone] || ""}${value}${color.reset}`;
}

function line(tag, message, tone = "cyan") {
  console.log(`${paint(`[${timestamp()}]`, "dim")} ${paint(`[${tag}]`, tone)} ${message}`);
}

function banner({ targetCount, globalInterval, estimatedTargetInterval }) {
  console.log(`\n${paint("============================================================", "cyan")}`);
  console.log(paint("                    SIX COURSE WAR", "bold"));
  console.log(`${paint("============================================================", "cyan")}\n`);
  console.log(`  Target aktif       : ${paint(targetCount, "bold")}`);
  console.log(`  Interval global    : ${paint(globalInterval, "yellow")}`);
  console.log(`  Estimasi per target: ${paint(estimatedTargetInterval, "yellow")}`);
  console.log("  Mode transaksi     : serial (state KRS aman)\n");
}

function targetList(targets) {
  console.log(paint("  TARGET MONITORING", "bold"));
  targets.forEach((target, index) => {
    console.log(
      `  ${String(index + 1).padStart(2, "0")}. ${paint(target.courseCode, "cyan")} | kelas ${target.sectionNumber || target.classId}`,
    );
  });
  console.log("");
}

function pollResult({
  pollNumber,
  targetAttempt,
  target,
  applicants,
  quota,
  available,
  durationMs,
  httpStatus,
  nextInterval,
}) {
  const isAvailable = available > 0;
  const status = isAvailable
    ? paint(`TERSEDIA ${available}`, "green")
    : paint("PENUH", "yellow");
  line(
    `POLL #${String(pollNumber).padStart(4, "0")}`,
    `${paint(target.label, "bold")} | upaya target #${targetAttempt} | terisi ${applicants}/${quota} | slot ${available} | HTTP ${httpStatus} | ${durationMs} ms | ${status} | berikutnya ${nextInterval}`,
    isAvailable ? "green" : "cyan",
  );
}

function pollError({
  pollNumber,
  targetAttempt,
  target,
  failureCount,
  durationMs,
  message,
  nextInterval,
}) {
  line(
    `POLL #${String(pollNumber).padStart(4, "0")}`,
    `${paint(target.label, "bold")} | upaya target #${targetAttempt} | gagal beruntun ${failureCount}x | ${durationMs} ms | ${message} | berikutnya ${nextInterval}`,
    "red",
  );
}

function seatFound({ target, available, registrationAttempt }) {
  console.log("");
  line(
    "SLOT DITEMUKAN",
    `${paint(target.label, "bold")} | ${available} slot | upaya registrasi #${registrationAttempt}`,
    "green",
  );
  line("TRANSAKSI", "Memulai Batal Kirim -> Ambil -> Kirim", "green");
}

function transactionStep(action, elapsedMs) {
  line("TRANSAKSI", `${action} dikonfirmasi | total waktu +${elapsedMs} ms`, "green");
}

function registrationSuccess(target) {
  line("BERHASIL", `${target.label} tersimpan dan KRS berhasil dikirim`, "green");
  console.log("");
}

function info(message) {
  line("INFO", message, "cyan");
}

function success(message) {
  line("BERHASIL", message, "green");
}

function warn(message) {
  line("PERINGATAN", message, "yellow");
}

function error(message) {
  line("ERROR", message, "red");
}

function summarizeError(error) {
  return String(error?.message || error || "error tidak diketahui")
    .split(/\r?\n/, 1)[0]
    .trim();
}

module.exports = {
  banner,
  error,
  info,
  pollError,
  pollResult,
  registrationSuccess,
  seatFound,
  summarizeError,
  success,
  targetList,
  transactionStep,
  warn,
};
