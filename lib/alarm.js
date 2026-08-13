const { spawn } = require("child_process");

let lastAlarmAt = 0;

function playAlarm(type = "seat") {
  const now = Date.now();
  if (now - lastAlarmAt < 1000) return;
  lastAlarmAt = now;

  process.stdout.write("\x07");

  const command =
    type === "seat"
      ? "[Console]::Beep(1400,220); [Console]::Beep(1800,220); [Console]::Beep(2200,350)"
      : "[Console]::Beep(700,350); [Console]::Beep(500,500)";

  const alarm = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", command],
    { detached: true, stdio: "ignore", windowsHide: true },
  );
  alarm.on("error", () => {
    // Terminal bell di atas tetap menjadi fallback jika PowerShell gagal.
  });
  alarm.unref();
}

module.exports = { playAlarm };
