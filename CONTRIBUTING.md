# Contributing

Feishu Codex Bridge is a Windows-first beta application. The repository currently contains a stable personal Session Relay and a retained experimental collaboration stack. Changes should make that boundary clearer rather than blur it.

## Product boundary

The supported product surface is the personal Session Relay described in `README.md` and `docs/SESSION_RELAY.md`. It includes Feishu transport, Codex Desktop/App Server integration, Session binding, queue/steer behavior, settings, attachments, streaming cards, persistent delivery, install/update tooling, and doctor checks.

Project Agent, team routing, knowledge, delegation, and multi-agent collaboration remain experimental. Experimental code may be maintained, tested, and improved, but it must not silently change the stable Session Relay contract.

## Before changing code

Read:

- `AGENTS.md` for repository safety rules;
- `docs/architecture/overview.md` for target boundaries;
- `docs/architecture/refactoring-plan.md` for the migration sequence;
- the relevant user or operations document for the feature being changed.

Do not use real App Secrets, OAuth tokens, open IDs, chat IDs, Codex task IDs, account data, absolute user paths, or local runtime files in tests, examples, logs, commits, issues, or pull requests.

## Change design

### Separate mechanical and semantic work

A file-move PR should contain moves, import-path updates, and the minimum test/configuration adjustments needed to keep behavior unchanged. Behavioral refactoring belongs in a later PR after the mechanical change has landed.

### Keep compatibility explicit

The following are compatibility surfaces, even when they are implemented as local files or internal messages:

- persisted queue, binding, settings, ledger, attachment, and outbox formats;
- `bridge.config.json` and its example schema;
- Feishu commands and reply behavior;
- Codex App Server request/notification shapes;
- install, update, doctor, supervisor, and Desktop relay behavior;
- DPAPI-protected credentials and existing runtime state.

Changes to these surfaces require tests, documentation, and an explicit migration or backward-compatible reader.

### Put code near its domain

Do not add new production `.mjs` files to the repository root. The existing flat layout is transitional. New structure should follow the target domains documented under `docs/architecture/` and should be introduced in a dedicated, reviewable migration PR.

Avoid generic dumping grounds such as `utils`, `helpers`, `common`, or `misc`. A helper belongs in the narrowest domain that owns its behavior.

## Validation

Install the locked dependencies and run the repository contract:

```powershell
npm ci
npm run check
```

`npm run check` validates tracked JavaScript/JSON files and runs the complete Node test suite. When operational PowerShell changes, also run the relevant smoke test or doctor command documented for that script. Include exact validation commands and results in the pull request.

## Pull requests

Keep PRs small enough to review as one idea. The PR description should explain:

- what changed and why;
- whether the change is mechanical, behavioral, operational, or experimental;
- effects on compatibility surfaces;
- exact automated and manual validation;
- any follow-up work intentionally left out.

Use the repository pull request template. A governance or relocation PR must not claim user-visible behavior changes unless it actually introduces and tests them.
