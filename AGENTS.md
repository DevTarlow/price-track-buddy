# AGENTS.md — Price Track Buddy

A GNOME Shell extension (uuid `price-track-buddy@mossaistudio.com`) written in
plain gjs/ESM. No build step, no bundler, no runtime dependencies.

`README.md` owns what the extension does and how it is configured. This file
owns how work gets done in this repo.

## Development flow (task → verify → commit → stop)

Tarlow drives the loop. The agent takes one task end to end, then stops for
instructions — it does not decide on its own that a change should ship.

1. **Do the task** on `main`, small and focused. No branches and no PRs — one
   linear history.
2. **Verify what the change actually touches**, before committing (see
   Verification gates).
3. **Commit when the task is done — do not wait to be asked.** A finished,
   verified, coherent change is expected to be committed, not left sitting
   while the next task starts. Do not commit a half-finished change.
4. **Stop. Do not push.** Tarlow pushes, or says "push".

## Verification gates

Match the check to the surface. Do not default to the full suite plus a live
install for a change that only a unit test can reach.

| Change touches | Run before committing |
|---|---|
| any `.js` file | `node --check extension.js prefs.js lib/*.js` |
| logic in `lib/` (`peak`, `format`, `ledger`, `providers`) | `gjs -m test/run-tests.mjs` |
| `extension.js`, `prefs.js`, `lib/widget.js` (UI, polling, indicator) | the unit suite **and** a live install — see Live Shell checks |
| `schemas/*.gschema.xml` | re-run `./install.sh` so `gschemas.compiled` is regenerated, and commit both |
| `README.md` only | none — but keep it true |

```bash
node --check extension.js prefs.js lib/*.js   # syntax; parses as ESM
gjs -m test/run-tests.mjs                     # 50 unit/integration tests
```

Reading the test result:

- The suite is **free and safe on every change**. Its two network probes use
  deliberately bogus keys (`sk-ptb-bogus-test`, `sk-or-v1-ptb-bogus-test`) and
  only assert the 401 path. It never spends money and needs no API key.
- A machine with no network makes those two probes `WARN … skipping`. That is
  not a failure.
- Judge the run by its final line — `RESULT  N passed, M failed, K warned`.
- `dconf-CRITICAL … unable to create file '/run/user/…/dconf/user': Read-only
  file system` lines are sandbox noise, not a regression. The suite passes with
  them present.

## Live Shell checks

gjs cannot load GNOME Shell, so a change to rendering, the indicator menu, drag
behaviour, or preferences needs the extension actually running:

```bash
./install.sh                                        # copy into the user extension dir
# X11:     Alt+F2 → r
# Wayland: log out and back in (enabling does not apply live)
journalctl -f /usr/bin/gnome-shell                  # watch for JS errors
```

Under the agent sandbox the Shell cannot be reloaded and `dconf` is read-only,
so this step is usually Tarlow's. When a change needs it, say plainly what
changed, what was verified statically, and what he should look at on screen —
do not claim a live check that did not happen.

`install.sh` ships only `metadata.json`, `extension.js`, `prefs.js`,
`stylesheet.css`, `lib/*.js`, and the schema XML. **A new top-level file the
extension needs at runtime must be added to `install.sh`, or it will not be
installed.** `test/` and `package.json` are dev-only and are never shipped.

## Commit style

House style, matching the sibling repos (one logical change per commit):

```
type(scope): summary

What changed and why. Reference the concrete symptom when fixing a bug —
e.g. Clutter.TextEllipsizeMode not introspected in this mutter.

Verified: node --check extension.js prefs.js lib/*.js; gjs -m test/run-tests.mjs (50 passed)
```

- Types in use: `feat`, `fix`, `refactor`, `docs`, `chore`, `test`.
- Scope is optional but useful here: `widget`, `ledger`, `peak`, `prefs`,
  `providers`, `schema`.
- The summary states the change, not the process. The body carries what + why.
- The closing `Verified:` line names the checks **actually run**, not the
  checks that exist.
- Never rewrite a commit that is already pushed. A follow-up fix is its own
  commit.

## Push policy

**Never push.** Tarlow reviews the commit and then says "push"; push whatever
branch is checked out (`main`, tracking `origin/main`). Never force-push, never
rebase or `reset --hard` a pushed commit, without an explicit instruction in
that turn.

This repo has no CI and no deploy workflow, so a push only publishes the
source — but it is still his call, not the agent's.

If a push is explicitly requested, include a directly related fix-up from that
same task in that push rather than stranding it as a surprise extra commit, and
say plainly what was added.

## Repo facts worth not rediscovering

- **gjs, not Node.** Runtime code runs in GNOME Shell. No `fetch`, no npm
  packages, no bundler. HTTP goes through `lib/http.js` (libsoup3).
- `package.json` exists **only** so `node --check` parses the sources as ESM
  (`"type": "module"`). It has no dependencies and is not used at runtime.
- `lib/peak.js` was ported from DeepSeek Harness. Keep the billing-window
  semantics (Mon–Fri 09–12 and 14–18 Beijing, 0.5× otherwise) in sync if that
  source changes.
- **Secrets never enter the repo.** API keys live in dconf/GSettings (plaintext
  on disk, which the README warns about). The spend ledger lives in
  `~/.local/share/price-track-buddy/`. Neither belongs in a commit.
- `schemas/gschemas.compiled` **is committed**, matching
  `clipboard-history@mossaistudio.com`. Regenerate it with `./install.sh` or
  `glib-compile-schemas schemas/` when the schema XML changes.
- `README.md` documents user-visible behaviour and caveats; a change that
  alters either should update it in the same commit.
