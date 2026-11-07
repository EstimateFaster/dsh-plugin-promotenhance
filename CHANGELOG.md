# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-11-07

First production-ready release. The plugin is now hardened, observable, tested,
documented, and shipped with real screenshots.

### Added

- Read-only workspace tools for the enhancement model: `read_file`, `list_dir`
  and `grep`, confined to the target session's working directory. Secret and
  environment files are rejected.
- Configuration surface for `timeoutMs`, `maxTokens`, `maxQuestionRounds`,
  `maxModelCalls`, `maxToolCalls`, `maxRoughChars` and `fileTools`, in addition
  to the existing `provider` / `model` / `reasoningEffort` overrides.
- Per-run budgets for model calls, question rounds and tool calls, plus a
  one-shot larger `maxTokens` retry when a response is truncated.
- `GET /prompt-enhance/health` endpoint with plugin name, version, uptime and
  file-tool availability.
- Elapsed-time indicator in the panel while the model is collecting or
  drafting, and explicit error codes for timeout, budget, token and path
  failures.
- 60 unit/integration tests covering the digest, engine, HTTP route, run store
  and workspace tools, and a GitHub Actions CI workflow.
- `docs/audit.md`, `docs/release-notes-v1.0.0.md`, real screenshots,
  `CONTRIBUTING.md`, `SECURITY.md` and this changelog.

### Changed

- The digest exposed to the model now contains only the workspace *name*, not
  the host's absolute working-directory path. Generated prompts therefore do
  not leak machine-specific paths.
- Panel draft state is keyed by `runId`: a regenerate starts from a clean
  editor, while edits made during the current run are preserved.
- Recommended options are sorted first and preselected (including multi-select
  questions).
- Package metadata is publishable (`private: false`, repository, engines,
  keywords) and the version is `1.0.0`.

### Fixed

- Cancel and timeout now take effect even while the model is still being
  resolved, and a detached error can no longer overwrite a cancelled run.
- Malformed JSON bodies (`null`, arrays, primitives) no longer crash the route;
  oversized bodies return `413` without destroying the response socket.
- Expired runs remain visible for 60 seconds before sweeping, and the run table
  is bounded to eight entries.
- `/take` is rejected unless the run is `ready` or `inserted`.
- Insert/copy notices reflect the actual result, and the copy failure message
  no longer says "insert failed".
- Stale README and locale metadata were updated.

### Security

- The data plane now requires a random per-process page token delivered through
  the SPA index (`x-dsh-prompt-enhance-token`), in addition to the same-origin
  check, JSON content type and 256 KiB body cap.
- File tools perform canonical-path containment checks, reject traversal and
  symlink escapes, and refuse `.env`, credential, key and certificate files.
- Public documentation no longer contains host absolute paths.

### Breaking

- Custom clients of the internal `/prompt-enhance/*` endpoints must send the
  page token from the `<meta name="dsh-prompt-enhance-token">` tag. The
  first-party panel does this automatically.
- The model-visible digest renamed the absolute `cwd` value to a workspace
  basename (and added `workspace`). Prompt text that relied on the absolute
  path should use relative paths instead.

## [0.2.0] - 2026-11-06

Initial no-session implementation: `/enhance` command, in-memory run table,
structured digest, `ask_questions` / `deliver_prompt` tools, right-side panel,
and composer insertion.
