# Static analysis evaluation

## Decision

Adopt ESLint as the repository's first semantic static-analysis gate. Defer a
repository-wide checked-JSDoc or TypeScript migration until type boundaries can
be introduced module by module without weakening the signal with broad ignores.

## Baseline evidence

The Phase 6 baseline covered 123 tracked `.mjs` files and 21,755 lines.

| Candidate | Baseline | Decision |
| --- | --- | --- |
| ESLint recommended rules | 44 findings across 18 files | Adopt now. Forty-two findings were intentional empty catches or regular-expression escapes and are documented rule exceptions. The remaining findings exposed two missing collaboration dependencies and one unused binding, all fixed before enabling the gate. |
| TypeScript `checkJs` | 346 errors; no existing JSDoc type annotations | Defer whole-repository checking. Enabling it now would require a large migration or hundreds of suppressions, neither of which is a useful quality gate. |
| TypeScript source migration | 21,755 JavaScript lines plus Windows and SDK boundaries | Defer. It would combine toolchain, declaration, and runtime-boundary changes without evidence that a full conversion is safer than incremental contracts. |

## Enforced ESLint scope

`npm run lint` checks every tracked or untracked `.mjs` file outside
`node_modules`, and `npm run check` runs it between repository validation and
the Node test suite. The configuration uses the recommended semantic rules and
Node built-ins. It intentionally disables only:

- `no-empty`, because shutdown, rollback, and compatibility probes use bounded
  best-effort catches;
- `no-useless-escape` and `no-control-regex`, because Windows paths, wire
  formats, and input-sanitization expressions require those patterns.

The gate is not a formatting policy and does not reformat existing code.

## Incremental type path

If stronger type checking is pursued later:

1. start with narrow leaf boundaries such as the App Server connection and
   persisted store records;
2. add explicit JSDoc typedefs and `// @ts-check` one module at a time;
3. require zero suppressions in each newly checked module;
4. measure defects found and maintenance cost before considering TypeScript
   source conversion;
5. keep any type migration separate from behavioral or directory refactors.

Repository-wide checked JSDoc should be reconsidered only after the error count
is reduced by typed module contracts rather than `any` or blanket ignores.
