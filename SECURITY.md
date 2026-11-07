# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 1.x | Yes |
| 0.x | No |

## Reporting a vulnerability

Use GitHub's **private vulnerability reporting** on the repository
(`Security` → `Report a vulnerability`). Please do not open a public issue for
an unfixed vulnerability.

Include the affected version, a minimal reproduction, and the impact. We aim to
acknowledge reports within a few days.

## Security model

- The plugin adds a `/prompt-enhance/*` JSON route to the local DSH Web server.
  It never creates a DSH session and never writes session events.
- Mutating requests require the per-process page token injected into the SPA
  index, a same-origin `Origin`, and `application/json`; request bodies are
  capped at 256 KiB.
- Workspace tools are read-only and confined to the target session's working
  directory. Secret/environment files and paths outside the workspace are
  rejected.
- The model receives the conversation digest and any files the user's session
  could already read. Do not use the plugin on a workspace containing secrets
  you are unwilling to send to the configured model provider.
- The plugin itself stores state in memory only; a host restart clears it.
