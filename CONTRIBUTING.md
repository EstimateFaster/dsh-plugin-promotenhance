# Contributing

Thanks for improving `dsh-prompt-enhance`. This is a small, dependency-free DSH
plugin; the fastest contribution path is a focused patch plus a test.

## Setup

Requirements: Node.js >= 20 and a DSH checkout/profile for manual testing.

```sh
git clone https://github.com/EstimateFaster/dsh-plugin-promotenhance.git
cd dsh-plugin-promotenhance
npm run check
```

There are no runtime or development dependencies to install. `npm run check`
runs the linter, the offline build check and the test suite.

## What to run

```sh
npm test          # node:test unit + HTTP integration tests
npm run lint      # syntax, version, secret/path and screenshot checks
npm run build     # package metadata + client bundle registration check
npm run check     # all of the above
```

For a manual end-to-end run, install the plugin into a **throwaway** DSH profile
and use a scratch `DSH_HOME`; never point a test instance at a production home.
See the README's "Local development" section.

## Guidelines

- Keep the public behavior documented in the README and CHANGELOG.
- Add a regression test for every P0/P1 fix.
- Do not log prompts, answers, tokens, credentials or absolute host paths.
- Do not add a dependency when the Node.js standard library is sufficient.
- Keep the model-facing schema backward compatible within a major version.
- Use conventional commit messages (`feat:`, `fix:`, `docs:`, `test:`,
  `chore:`).
- By contributing you agree that your changes are licensed under the MIT
  License.

## Reporting security issues

Please use GitHub's private vulnerability reporting instead of a public issue.
See [SECURITY.md](SECURITY.md).
