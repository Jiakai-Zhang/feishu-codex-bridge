# Architecture overview

## Current state

The repository grew from a Windows relay prototype into a Session-oriented bridge with persistent delivery, attachments, cards, Desktop recovery, and an experimental collaboration stack. Stable Session Relay and shared production modules live under domain-oriented `src/` directories, while Project Agent and multi-agent collaboration are physically isolated under `src/experimental/collaboration/`; their tests follow the same boundary under `tests/`. Root `session-relay.mjs`, `request-session-binding.mjs`, and `channel-bridge.mjs` files remain compatibility launchers for installed scripts and Skills.

The stable product is the personal Session Relay. Project Agent and multi-agent collaboration are experimental and are not part of the stable release contract.

## Target boundaries

The target architecture is domain-oriented:

```text
src/
  app/                         composition and process bootstrap
  relay/                       product policy and Session orchestration
  codex/                       Codex Desktop/App Server adapter
  feishu/                      Feishu transport, cards, media, docs, OAuth
  persistence/                 queue, bindings, settings, ledgers, outboxes
  runtime/                     process and platform integration
  experimental/
    collaboration/             Project Agent, team, knowledge, delegation

tests/
  unit/
  integration/
  e2e/
  fixtures/

scripts/
  dev/
  install/
  update/
  doctor/

config/
docs/
```

This is a destination, not permission to move files opportunistically. Each relocation should be isolated in a mechanical PR.

## Ownership model

### Relay domain

`relay/` owns product decisions: resolving a binding, interpreting a Bridge command, choosing queue versus steer, coordinating a Session turn, and deciding what must be persisted or delivered. It must not contain Feishu API details or Codex wire-format implementation.

### Codex adapter

`codex/` owns Codex Desktop/App Server discovery, requests, notifications, Session observation, execution, and Codex-specific media/input shapes. It must not render Feishu cards or choose Relay policy.

### Feishu adapter

`feishu/` owns inbound/outbound API calls, event decoding, cards, documents, feed groups, media transfer, and OAuth integration. It must not decide Session scheduling policy.

### Persistence

`persistence/` owns durable formats and atomic state transitions. Persisted schemas are compatibility surfaces. Callers should depend on narrow stores rather than issue scattered filesystem reads and writes.

### Experimental collaboration

`experimental/collaboration/` contains Project Agent, team routing, delegation, shared knowledge, and related protocols. Stable Relay code may expose explicit extension points, but experimental modules must not become implicit dependencies of the supported Session Relay.

### Application bootstrap

`app/` is the composition root. Its long-term job is to load configuration, construct adapters and stores, wire the Relay, and start or stop processes. Business logic should not accumulate there.

## Dependency direction

The intended direction is:

```text
app -> relay
app -> codex / feishu / persistence / runtime adapters
relay -> narrow ports and domain types
adapters -> their external systems
experimental collaboration -> explicit Relay extension points
```

Forbidden long-term dependencies include:

- `codex/` importing `feishu/`;
- `feishu/` importing `codex/`;
- adapters directly changing another adapter's durable state;
- stable Relay startup importing experimental collaboration by default;
- generic shared modules that hide domain ownership.

## Compatibility surfaces

Refactoring must preserve, or explicitly migrate, all of the following:

- installed release and root command entry points;
- `bridge.config.json` and documented defaults;
- queue, binding, settings, attachment, ledger, audit, and outbox state;
- Feishu commands, cards, messages, files, and mention behavior;
- Codex App Server request and notification handling;
- Desktop relay pointer and fail-open behavior;
- DPAPI-protected credentials and update rollback guarantees.

Architecture improvements are successful only when these contracts remain testable and understandable.
