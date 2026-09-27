# Knowledge tooling

Keeps [`docs/knowledge/`](../../docs/knowledge/README.md) cheap to maintain and honest.

```bash
npm run knowledge:generate   # scan the repo -> docs/knowledge/generated/
npm run knowledge:check      # validate, read-only, exit 1 on error (use in CI)
npm run knowledge:update     # generate, then check
```

No dependencies. Plain Node (ESM, >= 18), stdlib only.

## generate.mjs

Scans the tree and rewrites **only** `docs/knowledge/generated/`. It never reads or
writes a semantic file, so regeneration cannot destroy hand-maintained meaning.
Output is sorted and timestamp-free, so unchanged code produces an unchanged diff.

| Output | Contains |
|---|---|
| `codebase-index.yaml` | top-level layout, workspaces, node module dirs, python packages, entrypoints, cross-module imports |
| `api-routes.yaml` | route registrations found in Express/Fastify/Nest/FastAPI code |
| `db-objects.yaml` | migrations, `CREATE SCHEMA`/`CREATE TABLE`, whether each table has `tenant_id` and RLS enabled |
| `events.yaml` | event-shaped PascalCase string literals and the files that mention them |

Detection is deterministic regex over source text — not an AST index, and deliberately
so. It is meant to answer "where does this live" cheaply, not to model the language.
Anything it cannot see deterministically belongs in a semantic map instead.

Ignored: `node_modules`, `.git`, `dist`, `build`, `coverage`, `.venv`, `__pycache__`,
`docs`, `scripts`, `ERD`, `ArchitectureDiagram`.

## validate.mjs

Read-only. Fails the build on:

- a knowledge file missing or unparseable
- a domain, module, table, event or API referencing something that does not exist
- `meta.domain_count` disagreeing with the actual domain count
- a module marked `implemented` whose path is missing
- a module marked `planned` whose path now exists — promote it
- a module directory on disk that no map entry claims
- a `tenant_scoped` table that is not `rls_required`
- a migration table with `tenant_id` but no `ENABLE ROW LEVEL SECURITY`
- an event without `tenant_id` in its required context, or without idempotent consumers

Warnings (do not fail): missing reverse dependency edges, unclaimed domains, tables in
migrations that the database map does not describe, missing generated output.

The last three checks are the ones that catch real drift once code exists: they compare
the semantic maps against migrations and directories rather than trusting the maps.

## lib/mini-yaml.mjs

A ~150-line reader for the YAML subset these files use (nested maps, block sequences of
scalars, flow `[a, b]` and `{k: v}`). It throws on anything else, so a malformed
knowledge file fails loudly instead of validating against a wrong parse. Avoids adding a
dependency for four config files. If the knowledge files ever need richer YAML, replace
this with a real parser rather than extending it.

## Before implementation exists

With no application code, the generated files are empty and `knowledge:check` passes with
warnings. That is the correct state — it is not a failure.

## Adding checks

Put a check here when it can be decided deterministically from the tree. Put it in
`docs/knowledge/invariants.md` when it needs human judgment. Do not encode business rules
in this script.
