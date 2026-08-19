# Runtime platform architecture

## Goal

Windows and macOS share one Relay, Codex, Feishu, and persistence implementation.
Operating-system differences are capabilities of the runtime layer, not forks
of product behavior.

## Dependency rule

```text
root wrappers -> platform CLI/entrypoints -> runtime capabilities
                                        \-> shared product composition

app / relay / codex / feishu / persistence -> runtime/shared only
```

Stable product domains must not import `runtime/platform/macos` or a future
`runtime/platform/windows` implementation. Platform entrypoints may compose
shared product modules and platform capabilities.

## Shared runtime

- `fs-paths.mjs` owns Windows and POSIX path identity without leaking local
  paths into messages.
- `network-probes.mjs` owns loopback App Server URL validation and health
  probes.
- `private-state.mjs` owns private directories and atomic owner-only files.
- `node-version.mjs` owns the supported Node.js contract.
- `wait-until.mjs` owns bounded lifecycle polling.

## macOS capabilities

- `keychain-credential-store.mjs`: credential identity, secure prompt, and
  in-process secret retrieval.
- `launchd-service-manager.mjs`: LaunchAgent lifecycle, environment ownership,
  and plist generation.
- `desktop-runtime.mjs`: signed Bundle discovery, exact Desktop process
  identity, relay attachment, and loopback-only proxy inheritance.
- `process-inspector.mjs`: PID ownership and command verification.
- `installer.mjs`: dependency discovery, isolated runtime staging, LaunchAgent
  generation, and binding preservation.
- `health.mjs`: status and Doctor checks.
- `update.mjs`: fixed-tag preflight/update, private-state backup, same-version
  relay self-heal, and rollback.
- `foreground-update.mjs` plus `update-with-desktop-restart.sh`: target-tag
  extraction, visible Terminal handoff, user-driven Desktop exit, preserved
  network relaunch, and pre/post strict Doctor orchestration.
- `admin-cli.mjs`: thin command composition for stable shell wrappers.

## Compatibility

The repository-root shell and PowerShell commands remain the public operational
API. Installation copies the complete production `src/` tree plus root
compatibility launchers into the isolated runtime. Configuration, binding,
queue, attachment, ledger, outbox, Desktop relay, and credential identities are
preserved across platform refactoring and fixed-tag updates.

Architecture contract tests prevent stable domains from acquiring direct
operating-system dependencies and keep macOS implementation modules out of the
repository root.
