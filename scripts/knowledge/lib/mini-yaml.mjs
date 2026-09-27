// Minimal YAML reader for this repository's own knowledge files.
//
// Deliberately NOT a general YAML implementation. It supports exactly the subset the
// knowledge layer uses: nested mappings, block sequences of scalars, flow sequences
// `[a, b]`, flow mappings `{k: v}`, comments and blank lines.
//
// It throws on anything it does not understand, so a malformed knowledge file fails
// loudly instead of validating against a silently wrong parse.

function stripComment(line) {
  let out = '';
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      out += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) break;
    out += ch;
  }
  return out;
}

function scalar(raw) {
  const v = raw.trim();
  if (v === '' || v === '~' || v === 'null') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

// Splits "a, b, {c: d}, [e, f]" respecting one level of nesting and quotes.
function splitFlow(body) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (const ch of body) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '[' || ch === '{') depth += 1;
    if (ch === ']' || ch === '}') depth -= 1;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim() !== '') parts.push(cur);
  return parts.map((p) => p.trim());
}

function parseValue(raw) {
  const v = raw.trim();
  if (v.startsWith('[') && v.endsWith(']')) {
    const body = v.slice(1, -1).trim();
    return body === '' ? [] : splitFlow(body).map(parseValue);
  }
  if (v.startsWith('{') && v.endsWith('}')) {
    const body = v.slice(1, -1).trim();
    const obj = {};
    if (body === '') return obj;
    for (const part of splitFlow(body)) {
      const idx = part.indexOf(':');
      if (idx === -1) throw new Error(`flow mapping entry without ':' -> ${part}`);
      obj[parseValue(part.slice(0, idx))] = parseValue(part.slice(idx + 1));
    }
    return obj;
  }
  return scalar(v);
}

// Splits "key: value" on the first colon that ends a key.
function splitKey(text) {
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === ':' && (i === text.length - 1 || /\s/.test(text[i + 1]))) {
      return [text.slice(0, i).trim(), text.slice(i + 1).trim()];
    }
  }
  return null;
}

const BLOCK_SCALAR = /^([|>])([+-]?)$/;

/**
 * Whether every `[` and `{` outside a quoted string is closed on this line.
 *
 * Used to detect a flow sequence that continues onto the next line, which is ordinary YAML
 * and the natural way to write a long list of module responsibilities.
 */
function isBalanced(text) {
  let depth = 0;
  let quote = null;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[' || ch === '{') depth += 1;
    else if (ch === ']' || ch === '}') depth -= 1;
  }
  return depth === 0;
}

/**
 * Consumes a block scalar body (`key: >-` / `key: |`) starting at `start`.
 *
 * Block scalars carry the multi-line prose notes in the semantic maps, so comments are
 * NOT stripped inside them and blank lines are significant — a `#` in a sentence is text,
 * not a comment.
 */
function readBlockScalar(rawLines, start, parentIndent, style, chomp) {
  const body = [];
  let i = start;
  let blockIndent = null;

  while (i < rawLines.length) {
    const raw = rawLines[i];
    if (raw.trim() === '') {
      body.push('');
      i += 1;
      continue;
    }
    const indent = raw.length - raw.trimStart().length;
    if (indent <= parentIndent) break;
    blockIndent ??= indent;
    body.push(raw.slice(blockIndent));
    i += 1;
  }

  while (body.length > 0 && body[body.length - 1] === '') body.pop();

  // `>` folds each run of non-empty lines into one line; `|` keeps them as written.
  let text;
  if (style === '>') {
    const paragraphs = [];
    let current = [];
    for (const line of body) {
      if (line === '') {
        paragraphs.push(current.join(' '));
        current = [];
      } else {
        current.push(line.trim());
      }
    }
    paragraphs.push(current.join(' '));
    text = paragraphs.join('\n');
  } else {
    text = body.join('\n');
  }

  if (chomp !== '-') text += '\n';
  return [text, i];
}

export function parseYaml(source) {
  const rawLines = source.split(/\r?\n/);
  const lines = [];

  for (let n = 0; n < rawLines.length; n += 1) {
    const raw = rawLines[n];
    const line = stripComment(raw);
    if (line.trim() === '') continue;
    if (line.includes('\t')) throw new Error(`line ${n + 1}: tabs are not allowed in YAML`);

    const indent = line.length - line.trimStart().length;
    const text = line.trim();

    const kv = splitKey(text);
    const marker = kv ? BLOCK_SCALAR.exec(kv[1]) : null;
    if (marker) {
      const [value, next] = readBlockScalar(rawLines, n + 1, indent, marker[1], marker[2]);
      lines.push({ indent, text: `${kv[0]}: ${JSON.stringify(value)}`, n: n + 1 });
      n = next - 1;
      continue;
    }

    // A flow sequence or mapping may span lines: `key: [a, b,` continued below. Join the
    // continuation onto one logical line so the flow parser sees a balanced expression.
    if (!isBalanced(text)) {
      let joined = text;
      let m = n;
      while (m + 1 < rawLines.length && !isBalanced(joined)) {
        m += 1;
        joined += ` ${stripComment(rawLines[m]).trim()}`;
      }
      if (!isBalanced(joined)) {
        throw new Error(`line ${n + 1}: unclosed flow sequence or mapping`);
      }
      lines.push({ indent, text: joined, n: n + 1 });
      n = m;
      continue;
    }

    lines.push({ indent, text, n: n + 1 });
  }

  let i = 0;

  function parseBlock(indent) {
    if (i >= lines.length) return null;
    return lines[i].text.startsWith('- ') || lines[i].text === '-'
      ? parseSeq(indent)
      : parseMap(indent);
  }

  function parseSeq(indent) {
    const out = [];
    while (i < lines.length && lines[i].indent === indent) {
      const line = lines[i];
      if (!line.text.startsWith('- ')) break;
      const item = line.text.slice(2).trim();
      const kv = splitKey(item);
      if (kv && !item.startsWith('[') && !item.startsWith('{')) {
        throw new Error(`line ${line.n}: sequences of mappings are not supported here`);
      }
      out.push(parseValue(item));
      i += 1;
    }
    return out;
  }

  function parseMap(indent) {
    const out = {};
    while (i < lines.length && lines[i].indent === indent) {
      const line = lines[i];
      if (line.text.startsWith('- ')) break;
      const kv = splitKey(line.text);
      if (!kv) throw new Error(`line ${line.n}: expected "key: value" -> ${line.text}`);
      const [key, rest] = kv;
      i += 1;
      if (rest !== '') {
        out[key] = parseValue(rest);
        continue;
      }
      const next = lines[i];
      if (!next || next.indent <= indent) {
        out[key] = null;
        continue;
      }

      // `key:` with the flow value on the following, more-indented line:
      //   responsibilities:
      //     [one, two, three]
      if (next.text.startsWith('[') || next.text.startsWith('{')) {
        out[key] = parseValue(next.text);
        i += 1;
        continue;
      }

      out[key] = parseBlock(next.indent);
    }
    return out;
  }

  const root = lines.length === 0 ? {} : parseBlock(lines[0].indent);
  if (i !== lines.length) {
    throw new Error(`line ${lines[i].n}: unexpected indentation -> ${lines[i].text}`);
  }
  return root ?? {};
}

export function readYaml(fs, path) {
  try {
    return parseYaml(fs.readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`${path}: ${err.message}`);
  }
}
