# CAPI Survey Platform — QA Engineer Take-Home

This repo contains runnable automation (Playwright), test plans, and written answers for all 4 parts of the assessment.

| What | Where |
|---|---|
| API automation (Scenario A: duplicate local IDs, idempotency, burst load) | [`tests/api/sync-survey.spec.ts`](tests/api/sync-survey.spec.ts) |
| Mock sync backend used by the API tests | [`mock-server/server.js`](mock-server/server.js) |
| Web automation (Scenario B: skip logic, explicit and schema-generated) | [`tests/web/skip-logic.spec.ts`](tests/web/skip-logic.spec.ts) |
| Reference form renderer driven by the JSON schema | [`web-fixture/form.html`](web-fixture/form.html) |
| Schema contract checks (catch builder→app breakages) | [`tests/schema/schema-contract.spec.ts`](tests/schema/schema-contract.spec.ts) |
| Test case matrix (sync, Android, skip logic, schema, UX) | [`test-cases/test_cases.csv`](test-cases/test_cases.csv) |
| HFC engine test plan | [`test-cases/hfc_test_plan.md`](test-cases/hfc_test_plan.md) |
| Original and syntax-fixed schema | [`fixtures/`](fixtures/) |
| Output of a full test run (60 passed) | [`docs/test-run-output.txt`](docs/test-run-output.txt) |

---

## Contents
1. [How to run](#1-how-to-run)
2. [Schema review: defects found in the reference files](#2-schema-review-defects-found-in-the-reference-files)
3. [Part 1: Hands-on inspection & automation](#3-part-1--hands-on-technical-inspection--automation) (Scenarios A, B, C)
4. [Part 2: Complex scenarios & edge cases](#4-part-2--complex-scenarios--edge-cases) (Scenarios D, E)
5. [Part 3: QA process & AI](#5-part-3--qa-process--ai-integration)
6. [Part 4: UI/UX & user-centric QA](#6-part-4--uiux--user-centric-qa)
7. [Assumptions](#7-assumptions)

---

## 1. How to run

**Requirements:** Node.js 18+ (LTS).

```bash
npm install
npx playwright install chromium
npm test              # all suites (starts the mock server automatically)
npm run test:api      # Scenario A only
npm run test:web      # Scenario B only
npm run test:schema   # schema contract checks
npm run report        # open the HTML report
```

**Expected result:** `60 passed`. Six schema tests show as `✘` but count as passed. They are marked `test.fail()` because they document real bugs in the sample schema (see section 2). When a bug is fixed, Playwright reports "unexpectedly passed", which reminds us to remove the marker.

**Against a real environment:** `BASE_URL=https://staging.example.com npm run test:api`. The mock server is then not started. The `/__reset` call is mock-only; against staging, every run uses unique device IDs instead.

**Why a mock server?** There is no real backend for this exercise. The mock (zero dependencies, about 200 lines) implements the contract I would *expect* from the real API, so the tests are runnable today and become the acceptance criteria for the real endpoint.

---

## 2. Schema review: defects found in the reference files

Reading the three reference documents side by side surfaced real defects. These are exactly the kind of builder→app breakages Scenario B describes, so I turned each one into an automated check.

| ID | Severity | Defect | Impact on the field app | Caught by |
|---|---|---|---|---|
| BUG-01 | **Critical** | `3.Sample Survey Schema.json` is **not valid JSON**: a comma is missing between the two objects in `formChecks[0].logic` (Wellbeing survey, q_3). | The app cannot parse the file, so **no survey loads at all**. | `schema-contract.spec.ts` |
| BUG-02 | High | HFC condition key is misspelled `questioID`. The app spec and builder doc use `attr`. | The engine cannot find the question; the rule silently never runs. | `schema-contract.spec.ts` |
| BUG-03 | High | `hfc_sleep_plausible` fires when `q_2 = "Yes"`, but `q_3` is only **visible** when `q_2 = "No"`. | **Dead rule.** Implausible sleep data is never checked. | `schema-contract.spec.ts` |
| BUG-04 | Medium | Survey 1 q_1 uses `questionHintText`; every other question uses `hintText`. | Hint silently missing for that question. | `schema-contract.spec.ts` |
| BUG-05 | Medium | `validationRules` is sometimes `[]` (array) and sometimes `{}` (object). | Type-unsafe parsing on Android (Gson/Moshi) leads to crashes or ignored rules. | `schema-contract.spec.ts` |
| BUG-06 | Medium | Builder doc defines form `id`, `version`, `language`, but the exported schema has none. | The app can't tell which schema version produced a submission, which makes regressions hard to trace. | `schema-contract.spec.ts` |
| BUG-07 | Medium | **Contract drift** between builder doc and schema: section `checklistGuide[]`/`items[]` vs `sectionChecklist`/`questions[]`; `hintText[]` (array) vs string; `validations[{type,value,message}]` vs `validationRules{type:range}`. | The builder and the app follow different contracts. This is the root cause of "new builder feature breaks the app". | Recommendation: shared JSON Schema (section 3, B.2) |
| BUG-08 | Low | Inconsistent HFC examples: the app spec uses `> 16` / "unusually high"; the schema uses `< 6` / "unusually low… sleeping standard" (unclear text); the brief uses `reask_and_flag`; `show_sup` is not in the app spec. | Ambiguous requirements for the engine. | Raised as a clarification question |

`fixtures/sample_survey_schema.fixed.json` fixes only BUG-01 and BUG-02, so the tests can run. Everything else is left as-is and reported, because changing product logic is not QA's decision.

---

## 3. Part 1: Hands-on technical inspection & automation

### Scenario A: Offline sync & data collision

#### A.1 API automation: how the tests protect against overwrites

**Root cause of the risk:** `School_1` is a **device-local** counter. If the server treats `localId` as a key, Pooja's upload overwrites Ankit's. The safe contract, which my tests enforce:

- The device generates a **`submissionId` (UUID)** when the survey is saved. The idempotency key is `deviceId + submissionId`.
- The server assigns its own **`serverId`** and returns it; the app maps `localId → serverId`.
- Same key and same content returns `200 duplicate` (a safe retry). Same key with *different* content returns `409` (never a silent overwrite).
- The same real-world school from two devices is **flagged for review** (`NEEDS_REVIEW`), not auto-merged. Two surveys of one school can both be valid (different students), so merging must be a human decision.

| Test | What it proves |
|---|---|
| Same localId from two devices → 2 records, each with its own answers | No overwrite (the core requirement) |
| Both devices sync **at the exact same moment** (`Promise.all`) | No race condition on insert |
| Same school ("Govt" vs "Govt.") flagged with `possibleDuplicateOf` | Duplicates surfaced, data not merged |
| Same device reuses `School_1` after reinstall | Counter reset doesn't overwrite old data |
| Identical retry after lost ack → `200`, same `serverId`, still 1 record | Idempotent retries (network drop after commit) |
| 5 identical retries in parallel → exactly one `201` | Idempotency holds under concurrency |
| Same submissionId with different content → `409`, original intact | Tampering/bug can't overwrite |
| Missing each required field / malformed JSON / bad date → `400` | Clean validation, never `500` |
| **50 devices at once** → no 5xx, `429` with `Retry-After`, client backs off with jitter, all 50 stored exactly once | Load shedding works and no data is lost in the 5 PM thundering herd |

**On the 50,000-user DDoS:** Playwright proves *correctness* under concurrency. *Capacity* needs a load tool. I would use **k6** against staging with a spike profile (0 → 50k virtual users in about 2 minutes, which matches "everyone reaches town at 5 PM"). Pass criteria: p95 latency within SLO, error rate < 1%, zero lost or duplicated records (verified by reconciling the server count with the sent count). On the app side I would check the fixes that prevent the herd in the first place: WorkManager **exponential backoff with jitter**, batching several surveys per request, uploading photos separately from survey JSON, and honouring `Retry-After`.

#### A.2 Testing background sync under poor network (e.g. drop at 99% of a photo upload)

**Setup:** a QA build flavour that is debuggable and trusts user CA certificates (`network_security_config`), pointed at staging, plus one real budget phone and one emulator.

| Tool | How I use it |
|---|---|
| **Toxiproxy** (most precise for "exactly 99%") | Put it between the app and staging. The `limit_data` toxic closes the connection after N bytes. Set N = 99% of the photo request size, so the drop is **deterministic and repeatable**, which is what a developer needs to fix it. |
| **Charles Proxy / Proxyman** | *Throttling* (2G/EDGE preset: high latency, ~50 kbps), *Breakpoints* on the **response** to simulate "server saved it but the phone never got the 201" (the most dangerous case, because the retry must not duplicate), *Rewrite/Map Local* to return 500/503/timeouts. |
| **Android emulator** | `adb emu network speed gsm`, `adb emu network delay gprs`, `adb emu gsm data off` |
| **ADB on real device** | `adb shell svc wifi disable`, `adb shell svc data disable`, `adb shell cmd connectivity airplane-mode enable` (Android 11+), scripted mid-upload |
| **Android Network Profiler / OkHttp logs** | See bytes sent, retries and request IDs: `adb logcat \| grep -E "WM-\|OkHttp"` |

**Cases I run:** drop at 0%, 50%, **99%**, and **100% with the ack lost**; flapping network (on/off every 10 s); Wi-Fi to mobile data switch mid-upload; captive portal (connected but no internet, very common in small towns); app killed mid-upload (`adb shell am force-stop <pkg>`); device reboot; Doze (`adb shell dumpsys deviceidle force-idle`); Data Saver on (`adb shell cmd netpolicy set restrict-background true`).

**What "pass" means for each case:**
1. The Room row stays `PENDING` and the photo file still exists with the **same checksum** (`adb exec-out run-as <pkg> sha256sum files/photos/x.jpg`). Local data must only be deleted after the server confirms.
2. The worker returns `RETRY` (`run_attempt_count` goes up in WorkManager's DB, see Scenario C).
3. After the network returns, the upload completes. With resumable/chunked upload it continues from the offset instead of restarting a 5 MB photo on 2G.
4. The server has **exactly one** survey and one photo, and the photo checksum matches the device.
5. The dashboard counter ("3 Pending Sync") is correct at every step.

### Scenario B: Dynamic form rendering & regression

#### B.1 Web automation: skip logic

[`tests/web/skip-logic.spec.ts`](tests/web/skip-logic.spec.ts) drives a form rendered **from the schema** (`web-fixture/form.html`), at a 360×740 budget-phone viewport.

- **Explicit test (from the brief):** "Do you have a hobby?" = Yes shows "What is your hobby?" (visible and editable). No keeps it hidden. Yes → type → No hides it **and clears the stale answer**, so withdrawn data is never submitted. Resetting to "-- Select --" hides it again.
- **Generated tests:** the spec reads the schema and creates **one test per `visibilityLogic` rule** (8 rules across 3 surveys). Each rule checks: hidden at start, visible on the matching value, hidden for *every other* option. When the builder adds a rule, coverage appears automatically with no new code.

The renderer uses stable `data-testid` hooks (`question-<id>`, `<id>`). Pointing the same tests at the real builder preview only needs `FORM_PATH` and the same test IDs.

#### B.2 Regression strategy for JSON-generated screens

The key insight: **in a schema-driven app, the schema is the code.** So I test the *contract* and the *engine* heavily, and the *rendered screens* lightly.

| Layer | What | How | When |
|---|---|---|---|
| 1. Schema contract | Every exported schema is valid against a **shared JSON Schema** owned by both the builder and app teams; lint rules (targets exist, no forward refs, values are real options, HFC rules reachable, required-but-hidden) | ajv + the checks in `tests/schema/` | On every builder PR **and** on every schema publish (blocks bad schemas before devices download them) |
| 2. Engine unit tests | Visibility, validation and HFC as **pure functions**: `evaluate(schema, answers) → visible/valid/flags` | Table-driven JUnit (app) / Jest (builder preview) | Every PR, seconds |
| 3. Golden corpus | A "kitchen-sink" schema with all 20 input types, every condition, chained skip logic, nested rosters, matrix modes, plus **real production schemas** (anonymised) | The same data-driven tests loop over the corpus | Every PR |
| 4. Compatibility matrix | **Old app + new schema** (must ignore unknown fields, show a safe fallback for unknown types, never crash) and **new app + old schema** | Instrumented tests on the last 2 released app versions | Before each builder release |
| 5. Rendering snapshots | One screenshot per input type × (English, Hindi, font scale 1.3) | Paparazzi/Roborazzi (no device needed) | Every PR; diffs reviewed |
| 6. E2E smoke | 3-5 critical journeys: fill → skip logic → HFC → save offline → sync | Espresso/Compose tests or Maestro on a real budget device | Nightly + release candidate |

**Automate:** layers 1-6. They are deterministic and repeated thousands of times.

**Keep manual / exploratory:**
- New input types in their first release (behaviour still changing)
- Real-device feel on 4 GB phones: scrolling a 30-member roster, memory, battery
- Readability in sunlight and with real field workers
- Translations (meaning, not just fit)
- Unusual combinations nobody thought to model (time-boxed exploratory sessions with charters such as "break roster + skip logic")
- Camera, GPS and audio on real hardware

### Scenario C: Offline sync & state management (WorkManager + Room)

**Important constraint:** a **release** APK is `debuggable=false`. On an unrooted device, `run-as`, Database Inspector and WorkManager diagnostics will not work. So step 0 is to get a testable build.

**Step 0: get a debuggable build of the same code (in order of preference)**
1. Ask for a `qa` build variant: release code and R8, but `debuggable true` and a network config trusting user CAs. This should be standard, and I would make it part of the CI pipeline.
2. If only the release APK exists (test use only, never distribute):
   ```bash
   apktool d app-release.apk -o app_src
   # in AndroidManifest.xml set android:debuggable="true"
   # add res/xml/network_security_config.xml trusting user certs
   apktool b app_src -o app-debuggable-unsigned.apk
   zipalign -p 4 app-debuggable-unsigned.apk app-debuggable.apk
   apksigner sign --ks qa.keystore app-debuggable.apk
   adb uninstall <pkg> && adb install app-debuggable.apk
   ```
   (The signature changes, so the original must be uninstalled. Play Integrity checks may fail, so tell the backend team.)
3. Fallback with no build change: `adb backup` only if `allowBackup=true`, and it is unreliable on Android 12+, so I don't depend on it.

**C.1 Extract and inspect the Room database before sync**
```bash
adb shell pm list packages | grep -i survey          # find the package name
adb shell run-as <pkg> ls databases/                  # e.g. survey.db, survey.db-wal, survey.db-shm

# Room uses WAL mode: recent writes may only be in the -wal file.
# Pull ALL three files (or force-stop the app first so WAL is checkpointed).
adb shell am force-stop <pkg>
adb exec-out run-as <pkg> cat databases/survey.db     > survey.db
adb exec-out run-as <pkg> cat databases/survey.db-wal > survey.db-wal
adb exec-out run-as <pkg> cat databases/survey.db-shm > survey.db-shm
# (Windows: run these in Git Bash or cmd, not PowerShell, which corrupts binary redirects)

sqlite3 survey.db
sqlite> .tables
sqlite> SELECT local_id, submission_id, survey_id, sync_status, created_at, answers_json
        FROM surveys ORDER BY created_at DESC LIMIT 5;
```
*Live alternative:* Android Studio → **App Inspection → Database Inspector** (live queries, no pulling).

**What I verify:** the row exists with `sync_status = PENDING`; every answer matches what was entered; answers for skip-logic-hidden questions are **not** stored; `submission_id` is a UUID; timestamps are in local time with timezone; photo paths point to files that exist (`adb shell run-as <pkg> ls -l files/photos/`); HFC flags are stored. I also check that the dashboard counter matches `SELECT COUNT(*) ... WHERE sync_status='PENDING'`.

**C.2 Force the WorkManager sync to run now**
```bash
# 1. Make sure constraints can be met (network on)
adb shell svc wifi enable

# 2. Find the JobScheduler job WorkManager created for the app
adb shell dumpsys jobscheduler | grep -A 25 "<pkg>"        # note the job id (#u0a123/42 → 42)

# 3. Run it immediately (-f forces it even if constraints are not satisfied)
adb shell cmd jobscheduler run -f <pkg> 42

# 4. Watch what WorkManager does
adb logcat -s WM-WorkerWrapper WM-Processor WM-GreedyScheduler

# 5. Debuggable builds: dump WorkManager's own view of all work (WorkManager 2.4+)
adb shell am broadcast -a "androidx.work.diagnostics.REQUEST_DIAGNOSTICS" -p "<pkg>"
```
For deeper checks, I pull WorkManager's internal DB the same way as in C.1 (`databases/androidx.work.workdb`) and query `SELECT id, state, run_attempt_count, last_enqueue_time FROM WorkSpec;` where state is 0=ENQUEUED, 1=RUNNING, 2=SUCCEEDED, 3=FAILED, 5=CANCELLED.

**C.3 Simulate a 500 and verify retry without data loss**
1. **Proxy setup:** install the Charles/Proxyman root certificate on the device (QA build trusts user CAs), then:
   ```bash
   adb shell settings put global http_proxy <laptop-ip>:8888
   # undo afterwards:  adb shell settings put global http_proxy :0
   ```
2. **Return 500:** Charles → *Tools → Rewrite* (Response Status → `500`) or *Map Local* to a canned error body on `POST /sync-survey`. Proxyman: *Scripting* or *Breakpoint → edit status*.
3. **Snapshot before:** pull the DB and save the row plus a hash of `answers_json` and the photo checksum.
4. **Trigger sync** (C.2) and observe:
   - logcat shows `Worker result RETRY` (not FAILURE or SUCCESS)
   - `WorkSpec.state` back to `ENQUEUED`, `run_attempt_count` incremented
   - the next attempt time follows the **backoff policy** (e.g. 30 s, 60 s, 120 s for exponential)
   - Room row is **still PENDING, byte-for-byte identical** (same hash), and the photo is still on disk
   - UI still shows "Pending Sync", not "Synced"
5. **Recover:** remove the rule, wait for or force the next run, then confirm the status becomes `SYNCED` and the server holds **exactly one** record.
6. **Related cases:** 500 *after* the server committed (Charles response breakpoint, then abort) must not duplicate. `400` must **not** retry forever (mark FAILED, show the user, keep the data). Timeout and 503 with `Retry-After`. Kill the app or reboot while in backoff; the work must survive.

---

## 4. Part 2: Complex scenarios & edge cases

### Scenario D: ANR/crash after 3-4 training videos on 4 GB phones

**Mindset:** "works on flagship, fails on budget after N repetitions" almost always means **accumulation** (a leak, a growing cache, or main-thread work that gets slower) combined with the low-RAM device's smaller heap and more aggressive low-memory killer. My job is to turn "it crashes sometimes" into "it crashes every time at step X, and here is the leaking object."

**1. Gather facts first**
- Play Console *Android vitals* / Crashlytics: is it an **ANR** (main thread blocked > 5 s) or a **crash** (`OutOfMemoryError`)? Which Android versions and models? These are different bugs.
- Compare heap limits, which often explain "works in office" immediately:
  ```bash
  adb shell getprop dalvik.vm.heapgrowthlimit   # e.g. 192m on budget vs 512m on flagship
  adb shell getprop ro.config.low_ram           # true on Android Go devices
  adb shell cat /proc/meminfo                   # total/free RAM
  adb shell df -h /data                          # free storage
  ```

**2. Reproduce on a matching environment**
- **Real device:** the same model the field team uses (best evidence).
- **Emulator:** AVD with RAM 3-4 GB, VM heap 128-192 MB, and a small `/data` partition (`emulator -avd Budget_API30 -memory 3072 -partition-size 2048`).
- **Make the device "field-like":**
  ```bash
  # Low storage: fill the disk, or lower the "low storage" threshold
  adb shell dd if=/dev/zero of=/sdcard/Download/fill.bin bs=1048576 count=20000
  adb shell settings put global sys_storage_threshold_percentage 30
  # Memory pressure
  adb shell am send-trim-memory <pkg> RUNNING_CRITICAL
  adb shell am memory-factor set CRITICAL                      # Android 13+
  # Developer options: background process limit = 1-2, "Don't keep activities"
  adb shell settings put global always_finish_activities 1
  # Open a few heavy apps (camera, maps, WhatsApp) in the background, as field workers do
  ```
- **Scripted repro loop:** play video 1 → quiz → video 2 → … and after **each** video record:
  ```bash
  adb shell dumpsys meminfo <pkg> | grep -E "TOTAL PSS|Java Heap|Native Heap|Graphics"
  adb shell run-as <pkg> du -sh cache files     # is a video cache filling storage?
  ```
  Repeat 5 times on budget and 5 on flagship to get a reproduction rate.

**3. Debug: find which hypothesis is true**

| Hypothesis | Evidence I look for | Tool |
|---|---|---|
| Video player not released (ExoPlayer/MediaCodec instance leaked per video) | PSS/Native/Graphics memory climbs about +100 MB per video and never drops; heap dump shows 4 player instances after 4 videos | Android Studio **Memory Profiler**, `adb shell am dumpheap <pkg> /data/local/tmp/h.hprof` → `adb pull` → `hprof-conv` → Eclipse MAT, **LeakCanary** in QA build |
| Activity/Fragment leak (listener holds the screen) | LeakCanary leak trace; `Activities` count in `dumpsys meminfo` grows | LeakCanary |
| Large bitmaps (thumbnails decoded at full resolution) | Big `byte[]`/Bitmap objects in heap dump | Memory Profiler |
| Main-thread I/O or video caching on a nearly full disk | ANR trace shows main thread in file I/O or `MediaCodec.release()` | `adb bugreport bugreport.zip` (contains `/data/anr/` traces), **Perfetto** system trace, `StrictMode` in QA build |
| Low-memory killer ending the app | `lowmemorykiller`/`lmkd` lines in log | `adb logcat -b main -b system -b crash`, `adb shell dumpsys activity exit-info <pkg>` (Android 11+) |

**4. Prove the root cause to the developer.** I give them an evidence pack, not an opinion:
- Exact repro steps with a rate ("5/5 on Redmi 9A, 4 GB, 1.2 GB free storage; 0/5 on Pixel 8")
- A **chart of memory after each video** (a sawtooth that never returns to baseline is the classic leak picture)
- The **heap dump / LeakCanary trace** naming the leaked object and the reference chain
- The **ANR trace** showing what the main thread was doing
- The `bugreport.zip`
- After the fix: the same chart going flat, and the same repro passing 5/5 on the budget device

That last step turns "I think it's fixed" into proof. The repro then becomes a regression test: a Macrobenchmark or instrumented test that plays N videos and asserts that memory returns to baseline.

### Scenario E: HFC engine test plan

Full plan with 27 cases: [`test-cases/hfc_test_plan.md`](test-cases/hfc_test_plan.md). Summary:

| ID | Type | Scenario | Input | Expected |
|---|---|---|---|---|
| HFC-01 | Positive | Age/Education rule fires | Age 12, College | Re-ask prompt with message; flag saved |
| HFC-02 | Positive | Sleep rule fires | Slept well = Yes, Hours 5 | Re-ask prompt; flag saved |
| HFC-03 | Positive | User corrects | Age changed to 19 | Prompt closes; no flag |
| HFC-04 | Positive | `reask_once` confirm | Same value re-entered | Accepted and flagged; **no 3rd prompt** |
| HFC-06 | Positive | `flag_silently` | Condition true | No prompt; flag synced |
| HFC-07 | Positive | `block` | Condition true | Can't proceed until corrected |
| HFC-09 | Negative | Adult in college | Age 20, College | No prompt |
| HFC-10 | Negative | Only one condition true (`all`) | Age 12, Primary | No prompt |
| HFC-11 | Negative | Slept badly | No, Hours 5 | No prompt |
| HFC-12 | Negative | Referenced question hidden by skip logic | Education skipped | Rule not evaluated; no crash |
| HFC-13 | Edge | Boundaries | Age 14/**15**/16; Hours 5.9/**6**/6.1 | Fires only for 14 and 5.9 |
| HFC-14 | Edge | String vs number | `val: "6"`, answer 10 | Numeric compare; `"10" < "6"` string bug must not happen |
| HFC-16 | **Loop** | `reask_and_flag`, user insists | Same value again and again | "Confirm and continue" → flag and move on; never endless |
| HFC-17 | **Loop** | Two rules re-ask each other | Q-A ↔ Q-B | Each prompts once per change; user can continue |
| HFC-18 | **Trap** | `block` that can't be satisfied | Trigger is read-only/hidden | Not trapped: rule skipped or escalated; draft can be saved and exited |
| HFC-19 | Edge | Earlier answer edited after confirm | Change Education | Flag removed / re-evaluated once |
| HFC-20 | Edge | App killed on prompt | `am force-stop`, reopen | State restored; no duplicate flag |
| HFC-22 | Edge | Roster | Member 3 invalid | Flag on member 3 only |
| HFC-23 | Negative | Malformed rule (like BUG-02) | Unknown op/key | Rule skipped and logged; form works |
| HFC-25 | Non-functional | Offline | Airplane mode | Evaluates on device; flags persisted and synced |

**Design principle tested throughout:** a Soft check must *slow the user down, never stop them*. Every prompt needs a way forward ("Confirm and continue"), and loops are bounded by "at most one prompt per rule per answer change". Most cases run as fast table-driven unit tests; only the loop/trap cases need real-device UI tests.

---

## 5. Part 3: QA process & AI integration

### 5.1 My first 30 days as the first QA engineer

**Principle:** add *safety nets*, not *gates staffed by me*. Developers keep shipping fast; the process catches the dangerous things automatically.

| Week | Focus | Concrete outcomes |
|---|---|---|
| **1: Listen & map** | Shadow devs, PM and field ops; read Play Console vitals, crash logs and support tickets; map how code goes from laptop to Play Store; list the top 10 product risks (data loss in sync, schema breakage, crashes on budget phones) | Risk map, current-state release diagram, quick-win list. No new process yet; build trust first |
| **2: Quick wins** | Introduce **Play Store tracks**: internal → closed (5-10 real field workers as pilot group) → **staged production** (10% → 50% → 100%). Set up a **staging backend** (prod-like config, anonymised data). Add a `qa` build variant. Write a 15-minute **smoke checklist**. Add a bug template (steps, device, build, logs) | No more direct-to-100% releases. A bad build reaches 10% of users, not all |
| **3: Lightweight criteria** | Agree on entry/exit criteria with the team (below). Add CI checks on PRs: unit tests, lint, **schema contract tests** | Agreed definition of "ready to test" and "ready to release" |
| **4: Automate the gates** | API tests (like this repo) and schema checks in CI; nightly E2E smoke on 1 budget device (Firebase Test Lab or a local device); Room **migration tests**; dashboard (crash-free rate, sync failure rate, escaped bugs); first retro | Repeatable release process; data to show improvement |

**Entry criteria (build is ready for QA):** CI green (unit + schema contract); built from the main branch to the internal track; short release note of changed areas and any **DB migration or schema version change**.

**Exit criteria (build is ready to release):** no open P0/P1; smoke checklist passed on a **budget device**; regression of changed areas passed; offline save → sync data-integrity check passed; Room migration from the previous version verified (no data loss for users with unsynced surveys); staged rollout gate: crash-free sessions ≥ 99.5% and no sync-failure spike before widening.

**How this avoids slowing the team:** testing happens on PR builds in parallel (Firebase App Distribution), not after "code complete". Risk-based depth (a text change gets a smoke test; a sync change gets the full data-integrity suite). Automated gates instead of manual sign-offs where possible. A documented **hotfix fast lane**. And I measure speed: if lead time goes up, the process gets adjusted.

### 5.2 How I use AI in QA

I use AI (ChatGPT, Claude, Copilot) as a fast assistant whose output I always review.

- **Test design:** I paste a spec section and ask for positive/negative/edge cases, then cut what's irrelevant and add domain cases it misses.
- **Test data:** I generate realistic and adversarial data (Hindi names, very long strings, emoji, Unicode digits, boundary numbers).
- **Code:** Copilot for Playwright/Espresso boilerplate, regex and SQL queries for Room inspection.
- **Debugging:** I summarise long logcat output or ANR traces to find the suspicious thread faster, then verify in the raw logs.
- **Reviewing specs:** I ask it to find contradictions between documents.

**Rule:** no real respondent data, credentials or confidential schemas go into public AI tools. Anonymise first or use the company-approved tool.

**Specific example: dynamic schemas (Scenario B).** Hand-writing tests for 20 input types × 7 conditions × rosters doesn't scale. I would give an AI the builder capability doc plus a sample schema and ask it to:
1. Write a **JSON Schema** (ajv) for the export contract, which becomes the layer-1 gate from B.2.
2. Generate a **"kitchen-sink" schema** covering every input type, every visibility condition, chained skip logic and nested rosters.
3. For each skip-logic rule, generate a **truth table** of answers → expected visible questions, which feeds the data-driven tests.
4. Generate **mutation schemas** (wrong key names, missing commas, forward references, values not in options) to prove the lint rules catch them.

Then a data-driven test loops over the AI-generated cases, exactly like the generated tests in `tests/web/skip-logic.spec.ts`. The AI writes the *cases*; the *runner* is small and reviewed by a human. Cross-checking the three reference docs this way is also how bugs like BUG-03 (a dead HFC rule) get spotted quickly.

### 5.3 What to automate vs not, and why these tools

**I automate when most of these are true:** it runs often (every PR or release); the feature is stable; the result is deterministic (clear pass/fail); failure is costly (data loss, crash, sync); manual checking is slow or error-prone (50 concurrent requests, 8 rules × all options).

**I don't automate (or not yet):** one-time checks; features still changing weekly; visual/UX judgement (sunlight, "is this understandable?"); exploratory testing; hardware-heavy flows (camera, GPS in the field). For these, a good checklist and a real device give more value per hour.

I follow the test pyramid: many fast **unit/contract** tests (engine logic, schema), a solid layer of **API** tests (sync correctness), and **few UI/E2E** tests (critical journeys only), because UI tests are the slowest and flakiest.

**Why Playwright for Part 1:**
- **One stack for API and web:** `request` context for `/sync-survey` and the browser for skip logic, so there is one language (TypeScript), one runner, one report.
- **Concurrency is easy:** `Promise.all` simulates Ankit and Pooja syncing at the same instant and 50-device bursts, which is awkward in Postman.
- **Data-driven tests:** tests are generated from the schema at runtime.
- **Reliability:** auto-waiting removes `sleep()` flakiness; **trace viewer** gives step-by-step replay of failures; `webServer` starts the mock automatically, so a reviewer runs everything with one command.
- **Why not Postman/RestAssured:** Postman is great for exploring an API, but harder to version-review, data-drive and run concurrently; RestAssured needs a Java/Maven setup for no extra benefit here.
- **For Android and load I'd add:** Espresso/Compose tests (live in the app repo with devs), **Maestro** for black-box flows on real budget devices, **k6** for the 50k-user load test.

---

## 6. Part 4: UI/UX & user-centric QA

### Evaluating the "Training Video Hub" beyond functional testing

I test it as **the field worker**, not as an engineer: a real budget phone, outdoors at midday, one hand, Hindi locale, 2G or offline, with a reader who struggles with long text. Functional ("video plays, Next works") is the minimum bar; the real question is **"can our user complete this screen without help?"**

### Issues and risks I would flag

| # | Issue | Why it fails our users | Suggested fix |
|---|---|---|---|
| 1 | **3 paragraphs of text** | Low-literacy users skip or can't read it; dense text in sunlight is even harder | 2-3 short bullets with icons; **audio narration** in the local language (a speaker button) |
| 2 | **"Next" at the very bottom of a scrolling page** | Users may never discover it and think they're stuck; on a 5" screen it's far below the fold | **Sticky, full-width primary button** fixed at the bottom, with an arrow icon, always visible |
| 3 | **Standard-sized button** | Small targets cause mis-taps (calloused/sweaty fingers, moving vehicles); close to the gesture bar | ≥ 48×48 dp (prefer 56 dp+), large spacing, away from screen edges |
| 4 | **Standard video player controls** | Tiny seek bar and icons; no local-language subtitles; no clear "downloaded / watch offline" state; streaming on 2G means endless buffering | Large play/pause, offline download indicator with size, subtitles or dubbing, resume position, low-bitrate option |
| 5 | **Low contrast / colour-only cues** | Grey-on-white text disappears in sunlight; colour-only meaning fails colour-blind users | Contrast ≥ 4.5:1 (text) and 3:1 (icons); colour **plus** icon **plus** word |
| 6 | **Rendering & memory risk** (links to Scenario D) | Video player plus long scroll view on a 4 GB phone causes jank and ANR; player kept alive after scrolling away; autoplay burns mobile data | Release the player on scroll/stop; no autoplay on mobile data; test with the profiler |
| 7 | **Text expansion & font scaling** | Hindi/Marathi text is longer; users set font scale 1.3+; text clips or overlaps | Flexible layouts; test at 1.3-1.5× and in every supported language |
| 8 | **Unclear completion state** | Is "Next" disabled until the video finishes? A greyed button looks identical in sunlight | Clear progress ("Video 2 of 3 ✓"), visible locked/unlocked states with icons |
| 9 | **Storage** | Downloaded videos fill a low-storage phone, then other features fail | Show space used; delete after the quiz is passed; warn before download |
| 10 | **Orientation / fullscreen** | Rotating to watch fullscreen restarts the video or loses position | Preserve state across configuration changes |

### How I test for these systematically

- **Heuristic checklist** based on WCAG 2.2 AA and Material accessibility guidelines, adapted for our users (text length, icon+label, target size, contrast, offline states). Every new screen goes through it, so the checks are repeatable rather than subjective.
- **Tools:**
  - **Accessibility Scanner** (Google) for touch target, contrast and label issues on device
  - Espresso `AccessibilityChecks.enable()` or Compose semantics checks in automated tests
  - **Layout Inspector** for dp sizes
  - Colour Contrast Analyser on screenshots
- **Simulate the field with ADB:**
  ```bash
  adb shell settings put system font_scale 1.3          # large fonts
  adb shell wm size 720x1280 && adb shell wm density 320 # small, low-res screen (reset: wm size reset / wm density reset)
  adb shell settings put secure accessibility_display_daltonizer_enabled 1   # colour-blind simulation
  adb shell settings put secure accessibility_display_daltonizer 11          # e.g. deuteranomaly
  ```
  Plus Hindi locale, Data Saver on, 2G throttling, and low storage (from Scenario D).
- **Sunlight test:** walk outside at noon with the budget phone at auto-brightness and screenshot what is unreadable.
- **Screenshot regression:** Paparazzi/Roborazzi snapshots per screen × language × font scale, so a fixed issue doesn't come back.
- **Real users:** a short usability session with 5 field workers (5 users find most usability problems). Measure task success, time and errors, and record (with consent) where they hesitate.

### Communicating "non-functional" bugs constructively

- **Evidence, not opinion.** "The button is 36 dp; the guideline is 48 dp" or "contrast is 2.8:1; minimum is 4.5:1" or a 10-second clip of a field worker scrolling past the button is hard to dismiss. "It looks small" is easy to dismiss.
- **Frame it as user impact.** "Ramesh couldn't find Next and gave up after 40 seconds; 3 of 5 users needed help" connects the bug to the business goal of trained, productive collectors.
- **Same format as functional bugs:** a `UX` label, severity (**UX-blocker**: user can't complete the task; **UX-major**: completes with difficulty; **UX-minor**: polish), annotated screenshot, device, standard referenced, and a **suggested fix**, not just the problem.
- **Bring design in early.** Review designs/Figma *before* development, share field recordings with designers, and agree on **UX acceptance criteria** in the Definition of Done (min 48 dp targets, contrast ratio, max text per screen, audio option). Then it's a shared standard, not QA's opinion.
- **Respect the team's time:** batch minor issues into one ticket per screen, prioritise with the PM, and acknowledge good fixes publicly.

---

## 7. Assumptions

- The real `/sync-survey` contract isn't specified, so the payload (`deviceId`, `submissionId`, `localId`, `entity`, `answers`, `collectedAt`) and responses (`201/200/409/400/429`) are my proposed contract, implemented in the mock and enforced by the tests.
- The Survey Builder web app wasn't provided, so `web-fixture/form.html` renders the provided schema using the documented `visibilityLogic` rules. The tests are written against stable `data-testid` hooks so they can be pointed at the real preview.
- Package names, DB names (`survey.db`), table names and job IDs in Scenario C are placeholders; the steps show how to discover the real ones.
- For BUG-03, I assume the intent was "flag kids who say they slept well but report under 6 hours", which needs `q_3` to be visible for both answers. That is a product decision to confirm, not something QA should change.
