#!/usr/bin/env node
// Regenerates the GENERATED half of the knowledge layer by scanning the repository.
//
// Writes only docs/knowledge/generated/*.yaml. Never touches semantic files.
// Deterministic: same tree in, same bytes out (sorted, no timestamps).
//
// Usage: node scripts/knowledge/generate.mjs [--quiet]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = path.join(ROOT, 'docs', 'knowledge', 'generated');
const QUIET = process.argv.includes('--quiet');

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next',
  'coverage', '.turbo', '.cache', '.pytest_cache', '.mypy_cache', 'docs', 'scripts',
  'ERD', 'ArchitectureDiagram', '.claude',
]);

const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.py', '.sql']);

const BANNER = [
  '# GENERATED FILE - DO NOT EDIT.',
  '# Produced by scripts/knowledge/generate.mjs (npm run knowledge:update).',
  '# Structural facts only. Business meaning lives in the semantic maps.',
  '',
];

function walk(dir, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') && entry.name !== '.github') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      walk(full, acc);
    } else if (entry.isFile()) {
      acc.push(full);
    }
  }
  return acc;
}

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

function q(value) {
  const s = String(value);
  return /^[A-Za-z0-9_@./:+-]+$/.test(s) ? s : JSON.stringify(s);
}

function emitList(items, indent = '  ') {
  return items.map((item) => `${indent}- ${q(item)}`);
}

// Empty collections are emitted inline (`key: []`) so the output stays valid YAML.
function section(key, items, indent = '  ') {
  return items.length === 0 ? [`${key}: []`] : [`${key}:`, ...emitList(items, indent)];
}

function mapSection(key, lines) {
  return lines.length === 0 ? [`${key}: {}`] : [`${key}:`, ...lines];
}

function write(name, lines) {
  const body = [...BANNER, ...lines, ''].join('\n');
  fs.writeFileSync(path.join(OUT_DIR, name), body, 'utf8');
  if (!QUIET) console.log(`  wrote docs/knowledge/generated/${name}`);
}

// ---------------------------------------------------------------- collection

fs.mkdirSync(OUT_DIR, { recursive: true });
const files = walk(ROOT).filter((f) => !rel(f).startsWith('docs/knowledge/generated'));
const codeFiles = files.filter((f) => CODE_EXT.has(path.extname(f)));
const read = (f) => fs.readFileSync(f, 'utf8');

// --- structure -------------------------------------------------------------

const topLevel = new Map();
for (const f of files) {
  const top = rel(f).split('/')[0];
  topLevel.set(top, (topLevel.get(top) ?? 0) + 1);
}

function dirsMatching(pattern) {
  // pattern is a fixed prefix whose final segment is '*'
  const base = path.join(ROOT, ...pattern.split('/').slice(0, -1));
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !IGNORED_DIRS.has(e.name))
    .map((e) => rel(path.join(base, e.name)))
    .sort();
}

const nodeModules = dirsMatching('apps/api/src/modules/*');
const nodeInfra = dirsMatching('apps/api/src/infra/*');
const workspaces = [...dirsMatching('apps/*'), ...dirsMatching('services/*'), ...dirsMatching('packages/*')];

const pythonPackages = [...new Set(
  files.filter((f) => path.basename(f) === '__init__.py').map((f) => rel(path.dirname(f))),
)].sort();

const tsEntrypoints = files
  .filter((f) => ['index.ts', 'main.ts', 'app.ts', 'server.ts', 'main.py'].includes(path.basename(f)))
  .map(rel).sort();

// --- cross-module imports --------------------------------------------------

const importEdges = new Map();
const moduleNames = nodeModules.map((m) => m.split('/').pop());
for (const f of codeFiles.filter((f) => /\.(ts|tsx|js|jsx|mjs)$/.test(f))) {
  const owner = moduleNames.find((m) => rel(f).includes(`/modules/${m}/`));
  if (!owner) continue;
  const src = read(f);
  for (const match of src.matchAll(/from\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]/g)) {
    const spec = match[1] ?? match[2];
    const hit = /(?:^|\/)modules\/([a-z0-9-]+)/.exec(spec);
    if (!hit || hit[1] === owner) continue;
    if (!importEdges.has(owner)) importEdges.set(owner, new Set());
    importEdges.get(owner).add(hit[1]);
  }
}

// --- api routes ------------------------------------------------------------

const routes = [];
const TS_ROUTE = /\b(?:router|app|api|server)\s*\.\s*(get|post|put|patch|delete|all)\s*\(\s*['"`]([^'"`]+)/g;
const NEST_ROUTE = /@(Get|Post|Put|Patch|Delete)\(\s*['"`]([^'"`]*)['"`]?\s*\)/g;
const PY_ROUTE = /@(?:router|app)\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)/g;

for (const f of codeFiles) {
  const ext = path.extname(f);
  const src = read(f);
  const found = [];
  if (ext === '.py') {
    for (const m of src.matchAll(PY_ROUTE)) found.push([m[1].toUpperCase(), m[2]]);
  } else if (ext !== '.sql') {
    for (const m of src.matchAll(TS_ROUTE)) found.push([m[1].toUpperCase(), m[2]]);
    for (const m of src.matchAll(NEST_ROUTE)) found.push([m[1].toUpperCase(), m[2] || '/']);
  }
  for (const [method, routePath] of found) routes.push({ method, path: routePath, file: rel(f) });
}
routes.sort((a, b) => `${a.path} ${a.method} ${a.file}`.localeCompare(`${b.path} ${b.method} ${b.file}`));

// --- database --------------------------------------------------------------

const migrations = files.filter((f) => /(^|\/)(migrations|migration)\//.test(rel(f)) && f.endsWith('.sql')).map(rel).sort();
const sqlFiles = files.filter((f) => f.endsWith('.sql'));
const schemas = new Set();
const tables = new Map(); // name -> {file, tenantId, rls}
// Exemptions declared by any migration, for a table created in any other migration.
const globalExemptions = new Map();

for (const f of sqlFiles) {
  const src = read(f);
  for (const m of src.matchAll(/CREATE\s+SCHEMA\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z0-9_."]+)/gi)) {
    schemas.add(m[1].replace(/"/g, ''));
  }
  // A table may opt out of the RLS requirement only with an explicit marker comment giving
  // a reason. Two forms, because applied migrations are immutable and an exemption is
  // sometimes recognised only after the table has already shipped:
  //
  //   -- rls:exempt <reason>                  immediately above CREATE TABLE
  //   -- rls:exempt <schema.table> <reason>   anywhere, including a later migration
  //
  // Either way the exemption and its justification are visible in the migration history.
  for (const m of src.matchAll(/--\s*rls:exempt\s+([a-z0-9_]+\.[a-z0-9_]+)\s+([^\n]+)/gi)) {
    globalExemptions.set(m[1], m[2].trim());
  }

  const exemptions = new Map();
  for (const m of src.matchAll(/--\s*rls:exempt\s+(?![a-z0-9_]+\.[a-z0-9_]+\s)([^\n]+)\n\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z0-9_."]+)/gi)) {
    exemptions.set(m[2].replace(/"/g, ''), m[1].trim());
  }

  for (const m of src.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z0-9_."]+)\s*\(([\s\S]*?)\n\s*\)\s*;/gi)) {
    const name = m[1].replace(/"/g, '');
    tables.set(name, {
      file: rel(f),
      tenantId: /\btenant_id\b/i.test(m[2]),
      rls: false,
      ...(exemptions.has(name) ? { rlsExempt: exemptions.get(name) } : {}),
    });
  }
  // RLS is enabled two ways in this schema: directly, or through the app.enable_tenant_rls
  // helper that also installs the standard tenant_isolation policy. Both count.
  const rlsPatterns = [
    /ALTER\s+TABLE\s+([a-z0-9_."]+)\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi,
    /app\.enable_tenant_rls\(\s*'([a-z0-9_."]+)'\s*\)/gi,
  ];
  for (const pattern of rlsPatterns) {
    for (const m of src.matchAll(pattern)) {
      const name = m[1].replace(/"/g, '');
      if (tables.has(name)) tables.get(name).rls = true;
      else tables.set(name, { file: rel(f), tenantId: true, rls: true });
    }
  }
}

for (const [name, reason] of globalExemptions) {
  const table = tables.get(name);
  if (table && !table.rlsExempt) table.rlsExempt = reason;
}

// A table created by one migration and dropped by a later one does not exist. Migrations are
// applied in filename order, so a DROP always wins over an earlier CREATE — and a generated
// map that lists a table nobody can query is worse than no map, because it will be believed.
for (const f of sqlFiles) {
  for (const m of read(f).matchAll(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-z0-9_."]+)/gi)) {
    tables.delete(m[1].replace(/"/g, ''));
  }
}

// --- events ----------------------------------------------------------------

// Verb suffixes an event name may end in. A heuristic, not the contract — the contract is
// packages/events/src/index.ts — but one that has to keep up with it, or the generated
// index quietly under-reports what the system emits.
const EVENT_SUFFIX = /^[A-Z][A-Za-z0-9]*(Created|Updated|Deleted|Recorded|Calculated|Applied|Approved|Rejected|Submitted|Finalized|Generated|Uploaded|Cancelled|Separated|Failed|Completed|Requested|Resubmitted|Activated|Escalated|Delegated|Revoked)$/;
const eventHits = new Map();
for (const f of codeFiles.filter((f) => path.extname(f) !== '.sql')) {
  for (const m of read(f).matchAll(/['"`]([A-Za-z0-9]+)['"`]/g)) {
    if (!EVENT_SUFFIX.test(m[1])) continue;
    if (!eventHits.has(m[1])) eventHits.set(m[1], new Set());
    eventHits.get(m[1]).add(rel(f));
  }
}

// ---------------------------------------------------------------- emission

if (!QUIET) console.log('knowledge:generate');

const codeCount = codeFiles.length;

write('codebase-index.yaml', [
  'meta:',
  '  type: generated',
  `  scanned_files: ${files.length}`,
  `  code_files: ${codeCount}`,
  `  implementation_present: ${codeCount > 0}`,
  '',
  ...mapSection('top_level', [...topLevel.entries()].sort().map(([k, v]) => `  ${q(k)}: ${v}`)),
  '',
  ...section('workspaces', workspaces),
  '',
  ...section('node_modules_dirs', nodeModules),
  '',
  ...section('node_infra_dirs', nodeInfra),
  '',
  ...section('python_packages', pythonPackages),
  '',
  ...section('entrypoints', tsEntrypoints),
  '',
  ...mapSection('cross_module_imports', [...importEdges.entries()].sort()
    .flatMap(([from, to]) => [`  ${q(from)}:`, ...emitList([...to].sort(), '    ')])),
]);

write('api-routes.yaml', [
  'meta:',
  '  type: generated',
  `  route_count: ${routes.length}`,
  '  detection: literal route registrations (express/fastify/nest/fastapi)',
  '',
  ...(routes.length === 0
    ? ['routes: []']
    : ['routes:', ...routes.map((r) => `  - ${q(`${r.method} ${r.path}`)}  # ${r.file}`)]),
]);

write('db-objects.yaml', [
  'meta:',
  '  type: generated',
  `  migration_count: ${migrations.length}`,
  `  table_count: ${tables.size}`,
  '',
  ...section('schemas', [...schemas].sort()),
  '',
  ...section('migrations', migrations),
  '',
  ...mapSection('tables', [...tables.entries()].sort().flatMap(([name, t]) => [
    `  ${q(name)}:`,
    `    file: ${q(t.file)}`,
    `    has_tenant_id: ${t.tenantId}`,
    `    rls_enabled: ${t.rls}`,
    ...(t.rlsExempt ? [`    rls_exempt_reason: ${q(t.rlsExempt)}`] : []),
  ])),
]);

write('events.yaml', [
  'meta:',
  '  type: generated',
  `  event_count: ${eventHits.size}`,
  '  detection: PascalCase event-shaped string literals in source',
  '',
  ...mapSection('events', [...eventHits.entries()].sort().flatMap(([name, where]) => [
    `  ${q(name)}:`,
    ...emitList([...where].sort(), '    '),
  ])),
]);

if (!QUIET) {
  console.log(codeCount === 0
    ? '  no application code found - generated indexes are empty (expected before implementation)'
    : `  indexed ${codeCount} code files, ${routes.length} routes, ${tables.size} tables, ${eventHits.size} events`);
}
