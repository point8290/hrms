#!/usr/bin/env node
// Validates the knowledge layer: internal consistency + drift against the real tree.
// Read-only. Exit code 1 on any error. Warnings do not fail the build.
//
// Usage: node scripts/knowledge/validate.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readYaml } from './lib/mini-yaml.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const K = path.join(ROOT, 'docs', 'knowledge');
const G = path.join(K, 'generated');

const errors = [];
const warnings = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

const load = (file) => readYaml(fs, path.join(K, file));
const loadGenerated = (file) => (fs.existsSync(path.join(G, file)) ? readYaml(fs, path.join(G, file)) : null);
const exists = (p) => fs.existsSync(path.join(ROOT, p));
const listOf = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

// ---------------------------------------------------------------- load

const REQUIRED = [
  'README.md', 'invariants.md', 'domain-map.yaml', 'codebase-map.yaml',
  'dependency-map.yaml', 'database-map.yaml', 'event-map.yaml',
  'api-map.yaml', 'integration-map.yaml',
];
for (const f of REQUIRED) {
  if (!fs.existsSync(path.join(K, f))) err(`missing knowledge file: docs/knowledge/${f}`);
}
if (errors.length) { report(); process.exit(1); }

const domainMap = load('domain-map.yaml');
const codebaseMap = load('codebase-map.yaml');
const dependencyMap = load('dependency-map.yaml');
const databaseMap = load('database-map.yaml');
const eventMap = load('event-map.yaml');
const apiMap = load('api-map.yaml');

const domains = Object.keys(domainMap.domains ?? {});
const modules = codebaseMap.modules ?? {};
const moduleNames = Object.keys(modules);
const knownDomain = (d) => domains.includes(d);

if (domains.length === 0) err('domain-map.yaml declares no domains');

// ---------------------------------------------------------------- 1. domain graph

for (const [name, d] of Object.entries(domainMap.domains ?? {})) {
  for (const dep of listOf(d.depends_on)) {
    if (!knownDomain(dep)) err(`domain-map: ${name}.depends_on -> unknown domain "${dep}"`);
  }
  if (!d.purpose) err(`domain-map: ${name} has no purpose`);
  if (d.depends_on && listOf(d.depends_on).includes(name)) err(`domain-map: ${name} depends on itself`);
}

const declaredCount = domainMap.meta?.domain_count;
if (declaredCount != null && Number(declaredCount) !== domains.length) {
  err(`domain-map: meta.domain_count=${declaredCount} but ${domains.length} domains are defined`);
}

// ---------------------------------------------------------------- 2. dependency map

for (const [name, entry] of Object.entries(dependencyMap.domains ?? {})) {
  if (!knownDomain(name)) err(`dependency-map: unknown domain "${name}"`);
  for (const dep of listOf(entry?.depends_on?.domains)) {
    if (!knownDomain(dep)) err(`dependency-map: ${name}.depends_on -> unknown domain "${dep}"`);
  }
  for (const imp of listOf(entry?.impacts)) {
    if (imp !== 'everything' && !knownDomain(imp)) err(`dependency-map: ${name}.impacts -> unknown domain "${imp}"`);
  }
}
for (const d of domains) {
  if (!(d in (dependencyMap.domains ?? {}))) err(`dependency-map: missing entry for domain "${d}"`);
}

// reverse-edge consistency: a -> depends_on b  implies  b -> impacts a
for (const [name, entry] of Object.entries(dependencyMap.domains ?? {})) {
  for (const dep of listOf(entry?.depends_on?.domains)) {
    const target = dependencyMap.domains?.[dep];
    if (!target) continue;
    const impacts = listOf(target.impacts);
    if (!impacts.includes(name) && !impacts.includes('everything')) {
      warn(`dependency-map: ${name} depends_on ${dep}, but ${dep}.impacts omits ${name}`);
    }
  }
}

// ---------------------------------------------------------------- 3. codebase map

const VALID_STATUS = new Set(['planned', 'implemented', 'partial']);
for (const [name, m] of Object.entries(modules)) {
  if (!VALID_STATUS.has(m.status)) err(`codebase-map: ${name} has invalid status "${m.status}"`);
  if (!m.path) { err(`codebase-map: ${name} has no path`); continue; }

  for (const d of listOf(m.domains)) {
    if (!knownDomain(d)) err(`codebase-map: ${name}.domains -> unknown domain "${d}"`);
  }
  for (const dep of listOf(m.dependencies)) {
    if (!moduleNames.includes(dep)) err(`codebase-map: ${name}.dependencies -> unknown module "${dep}"`);
  }

  const onDisk = exists(m.path);
  if (m.status === 'implemented' && !onDisk) {
    err(`codebase-map: ${name} is "implemented" but ${m.path} does not exist`);
  }
  if (m.status === 'planned' && onDisk) {
    err(`codebase-map: ${name} is "planned" but ${m.path} now exists - promote it to "implemented"`);
  }
  if (m.status === 'implemented' && m.tests && !exists(m.tests)) {
    warn(`codebase-map: ${name} tests path ${m.tests} does not exist`);
  }
}

// every domain should be owned by at least one module
const ownedDomains = new Set(Object.values(modules).flatMap((m) => listOf(m.domains)));
for (const d of domains) {
  if (!ownedDomains.has(d)) warn(`codebase-map: no module claims domain "${d}"`);
}

// ---------------------------------------------------------------- 4. database map

const declaredSchemas = Object.keys(databaseMap.schemas ?? {});
for (const [table, t] of Object.entries(databaseMap.tables ?? {})) {
  if (!table.includes('.')) err(`database-map: "${table}" must be schema-qualified`);
  const schema = table.split('.')[0];
  if (!declaredSchemas.includes(schema)) err(`database-map: ${table} uses undeclared schema "${schema}"`);
  if (!knownDomain(t.domain)) err(`database-map: ${table}.domain -> unknown domain "${t.domain}"`);
  if (t.tenant_scoped === true && t.rls_required !== true) {
    err(`database-map: ${table} is tenant_scoped but not rls_required - violates invariants.md#multi-tenancy`);
  }
  for (const target of Object.values(t.relationships ?? {})) {
    if (typeof target === 'string' && target.includes('.') && !(target in (databaseMap.tables ?? {}))) {
      warn(`database-map: ${table} references undefined table "${target}"`);
    }
  }
}

// ---------------------------------------------------------------- 5. event map

for (const [name, e] of Object.entries(eventMap.events ?? {})) {
  for (const p of listOf(e.producer)) {
    if (!knownDomain(p)) err(`event-map: ${name}.producer -> unknown domain "${p}"`);
  }
  for (const c of listOf(e.consumers)) {
    if (!knownDomain(c)) err(`event-map: ${name}.consumers -> unknown domain "${c}"`);
  }
  if (!listOf(e.required_context).includes('tenant_id')) {
    err(`event-map: ${name} does not require tenant_id - violates invariants.md#events`);
  }
  if (!listOf(e.consumer_requirements).includes('idempotent')) {
    err(`event-map: ${name} consumers are not marked idempotent - SQS is at-least-once`);
  }
  for (const svc of [e.consumed_by_service, e.produced_by_service].filter(Boolean)) {
    if (!moduleNames.includes(svc)) err(`event-map: ${name} references unknown service "${svc}"`);
  }
}
if (!listOf(eventMap.envelope?.required).includes('tenant_id')) {
  err('event-map: envelope must require tenant_id');
}

// ---------------------------------------------------------------- 6. api map

for (const [name, a] of Object.entries(apiMap.apis ?? {})) {
  if (!knownDomain(name)) err(`api-map: "${name}" is not a domain in domain-map.yaml`);
  if (!['planned', 'implemented', 'partial'].includes(a.status)) {
    err(`api-map: ${name} has invalid status "${a.status}"`);
  }
  if (a.module && !moduleNames.includes(a.module)) {
    err(`api-map: ${name}.module -> unknown module "${a.module}"`);
  }
  if (a.base_path && !String(a.base_path).startsWith('/')) {
    err(`api-map: ${name}.base_path must start with "/"`);
  }
}

// ---------------------------------------------------------------- 7. drift vs generated

const index = loadGenerated('codebase-index.yaml');
const dbObjects = loadGenerated('db-objects.yaml');

if (!index) {
  warn('generated/codebase-index.yaml missing - run `npm run knowledge:update`');
} else {
  const implemented = Object.values(modules).some((m) => m.status === 'implemented');
  const present = index.meta?.implementation_present === true;
  if (present && !implemented) {
    warn('code exists on disk but no module is marked "implemented" in codebase-map.yaml');
  }
  if (!present && codebaseMap.meta?.implementation_state !== 'none') {
    warn('codebase-map declares an implementation state but no code files were found');
  }
  for (const dir of listOf(index.node_modules_dirs)) {
    const name = String(dir).split('/').pop();
    if (!Object.values(modules).some((m) => m.path === dir || m.path?.endsWith(`/${name}`))) {
      err(`undeclared module directory on disk: ${dir} - add it to codebase-map.yaml`);
    }
  }
}

if (dbObjects && Number(dbObjects.meta?.table_count ?? 0) > 0) {
  // map -> migrations. A table described in database-map.yaml that no migration creates is
  // a map describing a system that does not exist, which is worse than no map: it will be
  // trusted. Tables under `deliberately_not_built` are excluded by construction, since they
  // are not in `tables`.
  const built = new Set(Object.keys(dbObjects.tables ?? {}));
  for (const table of Object.keys(databaseMap.tables ?? {})) {
    if (!built.has(table)) {
      err(
        `database-map describes ${table}, but no migration creates it. `
        + 'Either add the migration or move it under deliberately_not_built with a reason.',
      );
    }
  }

  for (const [table, t] of Object.entries(dbObjects.tables ?? {})) {
    if (t.has_tenant_id === true && t.rls_enabled !== true && !t.rls_exempt_reason) {
      err(
        `migration drift: ${table} has tenant_id but no row-level security (${t.file}). `
        + 'Call app.enable_tenant_rls, or justify it with an "-- rls:exempt <reason>" comment above CREATE TABLE.',
      );
    }
    if (!(table in (databaseMap.tables ?? {}))) {
      warn(`table ${table} exists in migrations but is not described in database-map.yaml`);
    }
  }
}

// ---------------------------------------------------------------- report

function report() {
  for (const w of warnings) console.log(`WARN  ${w}`);
  for (const e of errors) console.log(`ERROR ${e}`);
  const counts = `${domains.length} domains, ${moduleNames.length} modules, `
    + `${Object.keys(databaseMap?.tables ?? {}).length} tables, `
    + `${Object.keys(eventMap?.events ?? {}).length} events`;
  console.log(errors.length === 0
    ? `knowledge:check PASS (${counts}${warnings.length ? `, ${warnings.length} warning(s)` : ''})`
    : `knowledge:check FAIL (${errors.length} error(s), ${warnings.length} warning(s))`);
}

report();
process.exit(errors.length === 0 ? 0 : 1);
