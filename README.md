# SIX course watcher

This script uses a local Playwright browser profile so you log in to SIX
yourself. It does not need your password in the script.

## Install

Use Node.js 20 or newer, then run:

```bash
cd ~/fafo/sniper
npm install
npx playwright install chromium
```

If Chromium reports missing Linux packages:

```bash
npx playwright install-deps chromium
```

## Create the local SIX session

Run this once:

```bash
cd ~/fafo/sniper
node reference.js
```

When the Playwright Chromium window opens:

1. Log in to SIX manually.
2. Open the Rencana Studi page to confirm that you are logged in.
3. Close the browser normally.

Playwright will save the browser session in `six-profile/`. Future scripts
reuse it automatically.

Treat `six-profile/` like a password: it can contain authenticated cookies. Do
not commit, upload, copy, or share it. Each person must create their own local
profile by logging in with their own account. Do not run two scripts
simultaneously with the same profile.

## Configure targets

Edit `TARGETS` in `config.js`. To choose a specific class card,
use `sectionNumber`. This is the large class number shown by SIX, such as `01`
or `02`; it is not the number after `/kelas/` in the URL:

```js
const TARGETS = [
  {
    courseCode: "FK3057",
    sectionNumber: "02",
    label: "FK3057 / kelas 02",
    url: "https://six.itb.ac.id/app/.../kelas/COURSE_ID?fakultas=...&prodi=...",
    addSuccessPattern: /FK3057 berhasil ditambahkan/i,
  },
];
```

The script finds the card whose displayed number is exactly `02`, reads its
quota and applicants, and clicks only the `Ambil` button inside that card.
`classId` is still supported as an alternative when the HTML button ID is
already known. When both `sectionNumber` and `classId` are supplied, both must
point to the same button, which provides an additional safety check.

Add more objects to `TARGETS` to watch several courses. Read-only polling is
scheduled fairly, one request at a time, to protect the public IP from SIX rate
limits. Registration is deliberately serialized: SIX has one shared KRS state
per account, so parallel `Batal Kirim`/`Ambil`/`Kirim` operations can overwrite
one another.

## Run

Before running, close any other Playwright/Chromium window using `six-profile/`.

```bash
cd ~/fafo/sniper
node course-war.js
```

The script opens one KRS tab and one tab per target. It polls targets in a fair
rotation using authenticated HTTP document requests, without reloading or
rendering every target tab on every round. The HTML parser selects the exact
`sectionNumber` card before reading quota, applicants, and the latest `Ambil`
button ID. When a seat opens, the script stops polling immediately, verifies the
corresponding button in the browser, then executes `Batal Kirim -> Ambil ->
Kirim`. After a successful submission it continues watching the remaining
targets.

Some SIX responses do not include the usual success flash. If `Ambil` returns
without a success or full-class alert, the result is treated as ambiguous and
the script proceeds directly to `Kirim`; the target is then verified on the
submitted Rencana Studi. `Kirim` is accepted when either the success flash is
present, the submitted-state `Batal Kirim` control is visible, or SIX displays
the advisor-approval message while the editable `Kirim` control is absent.

Polling and KRS mutations are both serialized. Initial/recovery page loads are
limited to two at once and heavy
image/media/font/stylesheet/script requests are blocked because the required
SIX forms are server-rendered. Transaction navigation waits for the returned
HTML to reach `DOMContentLoaded`, ensuring the complete flash messages and new
form state have been parsed, but it does not wait for a complete asset load.
`Batal Kirim` is accepted only when either the success flash is present or the
new `Kirim` button proves that the plan is editable.
If an individual target tab is closed or its renderer detaches, the script
recreates that tab before registration; closing the entire browser stops
monitoring.

Polling sends at most one HTTP request every five seconds globally. With three
pending targets, each target is checked about once every fifteen seconds. The
request itself remains lightweight and the transaction starts immediately when
a seat is found. When SIX responds with HTTP 429, the result is treated as
unknown—not as a full class—and the circuit breaker stops all polling instead
of retrying automatically and potentially extending the IP block.

When a seat is detected, Windows plays a three-tone alarm before registration
continues. A lower two-tone alarm is used for transaction errors or a full class
during `Kirim`. The alarm runs in a separate process, so it does not delay the
registration sequence.

## Read-only rate-limit probe

`poll-probe.js` checks only the first active target in `config.js` and never
clicks `Batal Kirim`, `Ambil`, `Hapus`, or `Kirim`. By default it sends exactly
one request and prints the response time plus any standard rate-limit headers:

```bash
npm run probe
```

For a controlled longer test, use an interval of at least 30 seconds. The probe
stops immediately on the first HTTP 429:

```powershell
$env:PROBE_REQUESTS = "10"
$env:PROBE_INTERVAL_MS = "30000"
npm run probe
```

When a poll reports an available seat, its latest authenticated HTML is mounted
into the existing target tab locally. This refreshes the selected form and CSRF
data without another network page load or a second seat check. The script then
starts `Batal Kirim` immediately. When multiple targets are available, selection
uses round-robin attempt history rather than fixed array priority.

If a seat disappears during `Ambil`, the script re-submits the old plan and
returns to monitoring. If final `Kirim` reports `Kelas Penuh`, every reported
course is treated equally: it is removed from the draft, the remaining KRS is
submitted immediately, and every configured removed course is put back into
the monitoring queue. Configure every course that must be reacquired
in `TARGETS`; an unconfigured removed course cannot be monitored again. When
SIX exposes one checkbox per row and a unique shared Hapus button, multiple full
courses are removed in one batch request. Otherwise the script safely falls
back to sequential removal.

Automatic removal is fail-safe: the course row and removal control must each be
identified uniquely. If the SIX markup cannot be identified safely, the script
does not guess; it rings the terminal bell and leaves the browser open for
manual review.

On startup, an existing `Belum Kirim` plan is submitted before monitoring
continues. Targets already present in the plan are skipped.

An unexpected error during `Batal Kirim`/`Ambil`/`Kirim` no longer terminates
monitoring immediately. If the plan may be editable, the script first submits
or cleans and submits it automatically, reconciles the target queue with the
resulting plan, and only then continues polling. It stops for manual review only
when that recovery also fails.
