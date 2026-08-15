## Summary

<!-- What changed and why? Keep the scope explicit. -->

## Change type

- [ ] Mechanical cleanup or file move only
- [ ] Behavior change
- [ ] Bug fix
- [ ] Documentation or repository governance
- [ ] Experimental collaboration feature

## Compatibility

Describe any effect on the following compatibility surfaces. Write `none` when there is no effect.

- Persisted JSON/state:
- `bridge.config.json` schema:
- Feishu commands or message behavior:
- Codex App Server integration:
- Install, update, doctor, or supervisor scripts:

## Validation

<!-- List exact commands and manual checks. -->

- [ ] `npm run check`
- [ ] Relevant Windows smoke test, when operational scripts changed
- [ ] Documentation updated for user-visible behavior

## Review checklist

- [ ] The PR does not mix mechanical relocation with semantic refactoring.
- [ ] No secret, token, account identifier, chat ID, task ID, local path, or runtime state is included.
- [ ] Stable Session Relay behavior and experimental collaboration behavior remain clearly separated.
- [ ] New production modules are not added to the repository root.
