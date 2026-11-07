# v1.0.0 audit

- **Project:** `dsh-prompt-enhance` (DSH Web plugin: host half + browser panel)
- **Audited baseline:** `0.2.0` (`test/digest.test.mjs` only, no git repository)
- **Target:** `1.0.0`
- **Date:** 2026-11-07
- **Scope:** all files under `lib/`, `test/`, `locale/`, `package.json`,
  `cordis.patch.yml`, the shipped README and the design document.

## Method

1. Read every source file and the 751-line v2 design record.
2. Ran the existing test command, JavaScript syntax checks and `npm audit`
   (the baseline had no lockfile, so the audit could not run before the fixes).
3. Exercised the real plugin in an isolated DSH Web instance on port 3099:
   `/enhance` → three questions → generated prompt → insert; verified the
   health endpoint and file-tool availability.
4. Re-ran the complete suite (60 tests), lint and build checks after the fixes.
5. Reviewed the public docs for host paths, credentials and placeholder text.

## Findings

| ID | Severity | Category | Location (baseline) | Issue | Fix | Status |
| --- | --- | --- | --- | --- | --- | --- |
| P0-01 | P0 | Security / auth | `lib/http.js:62-69,181-200` | The data plane trusted same-origin requests only; any local process (or a DNS-rebinding page whose Host matches) could start, cancel or read enhancement state and burn model tokens. The design required a page token but it was never implemented. | Generate a random per-process token, inject it into the SPA index with `webServer.tapIndex`, send it as `x-dsh-prompt-enhance-token`, and verify it for all `/state`, `/sessions` and POST requests. `lib/index.js`, `lib/http.js`, `lib/client.js`. | Fixed |
| P0-02 | P0 | Correctness / cost control | `lib/engine.js:326-403` | A model that kept calling `ask_questions` could loop forever; there was no per-run model-call, question-round or tool budget. `maxTokens` was fixed at 3000 while the schema allowed 60 000 characters. | Added `maxModelCalls`, `maxQuestionRounds`, `maxToolCalls`, configurable `maxTokens` and a one-shot larger-token retry. Question rounds are enforced server-side. `lib/engine.js`, `lib/config.js`. | Fixed |
| P0-03 | P0 | Concurrency / cancellation | `lib/engine.js:317-324`; `lib/http.js:76-84` | Cancelling while `resolveModel()` was in flight did nothing, and the detached `kick()` catch overwrote a cancelled run with `failed`. | Install the abort controller before model resolution, check terminal phases before and after each call, and make `kick()` ignore terminal runs. `lib/engine.js`, `lib/http.js`, `lib/runs.js`. | Fixed |
| P0-04 | P0 | Robustness / input validation | `lib/http.js:33-58,86-96` | A JSON body of `null`/an array/primitive caused `body.session` to throw and returned 500; an aborted request could leave `readJson` pending forever. | `readJson` settles on `error`/`close`, the handler rejects non-plain-object bodies with 400, and oversized bodies are drained so the 413 response can be written. `lib/http.js`. | Fixed |
| P0-05 | P0 | Privacy / release hygiene | `docs/prompt-enhance-v2-design.md` (multiple lines); `lib/digest.js:109-124` | The public design record contained host absolute paths, and the model-visible digest sent the absolute cwd. Generated prompts quoted it verbatim (observed in a real run). | Redacted host paths from the design document; the digest now exposes only the workspace basename (`workspace` and `cwd` fields). `lib/digest.js`, `docs/prompt-enhance-v2-design.md`. | Fixed |
| P1-01 | P1 | UI correctness | `lib/client.js:391-395` | Draft merging preserved the old prompt after "Regenerate", so the editor showed the previous result even when a new run completed. | Track the current `runId`: a new run resets the draft, the same run preserves edits. `lib/client.js`. | Fixed |
| P1-02 | P1 | UI robustness | `lib/client.js:430-434` | Polling swallowed every error except `NO_RUN`; a dead host left the panel in a skeleton forever with no retry. | Count consecutive failures, surface an error after three, stop polling, and expose Retry. `lib/client.js`. | Fixed |
| P1-03 | P1 | Correctness / limits | `lib/engine.js:8,256` | `maxTokens: 3000` could not produce the allowed 60 000-character prompt; long deliverables were truncated or failed. | Configurable `maxTokens` (default 6000) and a single boosted retry when the provider reports `max-tokens`. `lib/engine.js`, `lib/config.js`. | Fixed |
| P1-04 | P1 | Missing capability | repository-wide | The model had no way to inspect the target workspace, so prompts guessed at existing scripts, test runners and layout. The design listed this as P2. | Added `read_file`, `list_dir`, `grep` tools with canonical-path containment, size/entry/match caps, ignored build directories and secret-file rejection. `lib/tools.js`, `lib/engine.js`, `lib/index.js`. | Fixed |
| P1-05 | P1 | UI correctness | `lib/client.js:467-478` | Insert always reported success even when `/take` failed; copy failure used the "Insert failed" message. | Check the `/take` result, distinguish inserted vs. queued fallback, and add `hint.copyFailed`. `lib/client.js`. | Fixed |
| P1-06 | P1 | UI / design mismatch | `lib/client.js:246,292` | Recommended options were not sorted first, and multi-select questions did not preselect recommendations. | Stable sort by `recommended` and preselect all recommended options for multi-select. `lib/client.js`. | Fixed |
| P1-07 | P1 | State machine | `lib/http.js:162-175` | `/take` accepted a run in any phase that still had a prompt (e.g., after cancel). | Require `phase === 'ready' || 'inserted'`; return `NOT_READY` otherwise. `lib/http.js`. | Fixed |
| P1-08 | P1 | Lifecycle | `lib/runs.js:72-78,127-142` | Expired runs were deleted exactly at TTL, so the panel jumped from polling to 404 and could not display the "expired" reason. | Expired runs are retained for 60 seconds, their in-flight work is aborted, and the sweeper removes them afterwards. `lib/runs.js`. | Fixed |
| P1-09 | P1 | Memory / dead code | `lib/runs.js:59-68,127-142` | No global run cap; `peekSeed` was unused; replaced runs kept streaming without being marked cancelled. | Added an eight-run cap with oldest eviction, marked replaced runs cancelled, removed dead code. `lib/runs.js`. | Fixed |
| P1-10 | P1 | Quality gate | `test/digest.test.mjs` only | There were no tests for the HTTP route, engine loop, run store or tools, and no CI. | Added 60 tests (digest, config, engine, HTTP, runs, tools) and a GitHub Actions matrix. `test/*.test.mjs`, `.github/workflows/ci.yml`. | Fixed |
| P2-01 | P2 | UX | `lib/client.js` | No elapsed-time feedback while a call was running. | Added a one-second timer rendered in the busy card and footer. `lib/client.js`. | Fixed |
| P2-02 | P2 | i18n | `lib/client.js` | New failure codes had no Chinese/English strings; fallback text mixed languages. | Added translations for token, timeout, budget, tool and path errors. `lib/client.js`. | Fixed |
| P2-03 | P2 | Observability | `lib/index.js`, `lib/http.js` | No version/health surface and no run lifecycle logs. | Added `GET /prompt-enhance/health`, `lib/version.js`, and lifecycle logs at seed/start/question/deliver/fail. | Fixed |
| P2-04 | P2 | Validation | `lib/engine.js:159-193` | Custom answers were accepted when `allowCustom: false`; skipped answers could carry contradictory selections. | Reject disallowed custom text and normalize skipped answers to empty selections. `lib/engine.js`. | Fixed |
| P2-05 | P2 | Config robustness | `lib/index.js` (config passthrough) | Invalid numeric config values were used verbatim; a partial provider/model pair silently changed behavior. | `lib/config.js` clamps/reports every numeric value and drops incomplete model overrides. | Fixed |
| P2-06 | P2 | Observability | `lib/engine.js` | Token usage was discarded. | Accumulate `inputTokens`/`outputTokens` on the run for diagnostics; never display prompts or secrets in logs. | Fixed |
| P2-07 | P2 | Robustness | `lib/engine.js:337-340` | `max-tokens` failed immediately instead of retrying with a larger budget. | Retry once with a doubled (capped) token budget, then fail with a readable message. | Fixed |
| P2-08 | P2 | Documentation | `README.md`, `locale/*.json` | README described v2 and had no install, config, screenshots or limitations; locale meta still claimed "opens an independent session". | Rewrote README, added the config table, architecture, screenshots, limitations, CHANGELOG, LICENSE, CONTRIBUTING and SECURITY; corrected locale meta. | Fixed |
| P2-09 | P2 | Packaging | `package.json` | `private: true`, no repository/engines/keywords, no test/lint/build scripts, version 0.2.0. | Publishable metadata, scripts, version 1.0.0 and a lockfile. | Fixed |
| P2-10 | P2 | Robustness (accepted) | `lib/tools.js:grep` | A pathological regular expression can consume CPU on up to 2 MiB of text; JSON parsing has no nesting limit. | Capped pattern length (200), scan size (2 MiB), files (200), matches (100) and HTTP body (256 KiB). Documented as a local, single-user limitation. | Accepted (documented) |
| P2-11 | P2 | UX (accepted) | `lib/client.js` | The panel polls every 700 ms; there is no SSE token stream. | Accepted for v1: the panel shows stage text and elapsed time, and polling avoids a long-lived connection through gateways. Documented. | Accepted (documented) |
| P2-12 | P2 | Persistence (by design) | `lib/runs.js` | Runs and seeds are memory-only and disappear on host restart. | Deliberate: the plugin must not create or persist a DSH session. The panel shows an explicit expired message. Documented. | Accepted (documented) |
| P2-13 | P2 | Test depth (accepted) | `lib/client.js` | The browser bundle is checked by a VM registration test, not by a full DOM test; real UI behavior is covered by the isolated E2E run. | Accepted for v1; avoids adding a browser test dependency to a dependency-free plugin. Documented. | Accepted (documented) |

## Result

- **P0:** 5 / 5 fixed with tests or real E2E evidence.
- **P1:** 10 / 10 fixed with tests or real E2E evidence.
- **P2:** 9 fixed; 4 explicitly accepted and documented in README limitations.
- **No** test was deleted, skipped or loosened to make the gate pass. The only
  test-file change was updating the digest expectation from an absolute cwd to
  the workspace basename (a deliberate privacy change).

## Verification

```text
$ npm test
ℹ tests 60
ℹ pass 60
ℹ fail 0
ℹ duration_ms ~0.4s

$ npm run lint
lint ok — 20 source files, 4 screenshots, v1.0.0

$ npm run build
build ok — dsh-prompt-enhance v1.0.0, 4 screenshots

$ npm audit --omit=dev
found 0 vulnerabilities
```

Real isolated DSH run (port 3099, `DSH_HOME` inside the repository workspace):

```text
GET /prompt-enhance/health
{"ok":true,"name":"dsh-prompt-enhance","version":"1.0.0","uptimeMs":7507,"fileTools":true}

/enhance 做一个本地记账小工具，用 JSON 文件存数据，要有命令行和测试
→ 3 questions (recommended options preselected)
→ Prompt ready, 6,201 chars in the editable result
→ Insert → composer contains the same text; phase becomes inserted
→ generated prompt contains no host absolute path
```

`npm audit` is run after `package-lock.json` is generated; the baseline had no
lockfile and therefore could not be audited.
