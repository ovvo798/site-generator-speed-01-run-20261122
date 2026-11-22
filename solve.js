// Fast drop-in for makefun-site 1.0.0: same answers, less CPU.
// Strategy: templates are compiled once per case into JS functions (scope is a
// prototype chain of null-prototype frames, so a first-name lookup is one
// property read); Markdown lexing and rendering are fused into a single pass
// with chunked escaping instead of a regex per character; slugify/longDate
// results are cached per case; front matter is scanned without regexes.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const RESERVED = ['posts', 'tags', 'page'];

// ------------------------------------------------------------------ text

function pushEsc(out, s, a, b) {
  let start = a, i = a;
  while (i < b) {
    const c = s.charCodeAt(i);
    const e = c < 128 ? ESC_ENT[c] : undefined;
    if (e !== undefined) {
      if (i > start) out.push(s.slice(start, i));
      out.push(e);
      start = i + 1;
    }
    i++;
  }
  if (b > start) out.push(s.slice(start, b));
}
const ESC_ENT = new Array(128);
ESC_ENT[38] = '&amp;'; ESC_ENT[60] = '&lt;'; ESC_ENT[62] = '&gt;'; ESC_ENT[34] = '&quot;'; ESC_ENT[39] = '&#39;';

const ESC_RE = /[&<>"']/;
function esc(s) {
  if (!ESC_RE.test(s)) return s;
  const out = [];
  pushEsc(out, s, 0, s.length);
  return out.join('');
}

const ESCAPABLE = new Uint8Array(128);
for (const ch of '\\`*_[]()#+-.!>') ESCAPABLE[ch.charCodeAt(0)] = 1;
function escapable(ch) { const c = ch.charCodeAt(0); return c < 128 && ESCAPABLE[c] === 1; }

// ------------------------------------------------------------------ slug

function slugifyRaw(text) {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '', gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

function makeSlugify(cache) {
  return function slugify(text) {
    const hit = cache.get(text);
    if (hit !== undefined) return hit;
    let out;
    // ASCII is a fixed point of NFKD and holds no combining marks.
    let ascii = true;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 127) { ascii = false; break; }
    if (ascii) {
      out = '';
      let gap = false;
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        let keep = -1;
        if (c >= 65 && c <= 90) keep = c + 32;
        else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
        if (keep === -1) { gap = out.length > 0; continue; }
        if (gap) out += '-';
        gap = false;
        out += String.fromCharCode(keep);
      }
      out = out.slice(0, 64);
      if (out.endsWith('-')) out = out.replace(/-+$/, '');
      if (out === '') out = 'untitled';
    } else {
      out = slugifyRaw(text);
    }
    cache.set(text, out);
    return out;
  };
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

function makeLongDate(cache) {
  return function longDate(date) {
    const hit = cache.get(date);
    if (hit !== undefined) return hit;
    const y = date.slice(0, 4), m = Number(date.slice(5, 7)), d = Number(date.slice(8, 10));
    const out = `${d} ${MONTHS[m - 1]} ${y}`;
    cache.set(date, out);
    return out;
  };
}

// ------------------------------------------------------------------ front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isBlankLine(s) {
  for (let i = 0; i < s.length; i++) { const c = s[i]; if (c !== ' ' && c !== '\t') return false; }
  return true;
}

function stringOf(raw) {
  if (raw[0] === '"') {
    if (raw.length < 2 || raw[raw.length - 1] !== '"') return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw[0] === '[') return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw[4] === '-' && raw[7] === '-';
      if (ok) for (let i = 0; i < 10; i++) {
        if (i === 4 || i === 7) continue;
        const c = raw.charCodeAt(i);
        if (c < 48 || c > 57) { ok = false; break; }
      }
      const y = ok ? Number(raw.slice(0, 4)) : 0;
      const mo = ok ? Number(raw.slice(5, 7)) : 0;
      const d = ok ? Number(raw.slice(8, 10)) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw[0] !== '[' || raw[raw.length - 1] !== ']') return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let i = 0; i < t.length; i++) { const c = t[i]; if (c === '"' || c === '[' || c === ']') return { error: 'key "tags": an empty tag, or one holding " [ or ]' }; }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) { const c = raw.charCodeAt(i); if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' }; }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      let prevDash = true;
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (c === 45) { if (prevDash) return { error: 'key "slug": not a slug' }; prevDash = true; }
        else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
        else return { error: 'key "slug": not a slug' };
      }
      if (prevDash) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

function parseFrontMatter(text) {
  const firstNL = text.indexOf('\n');
  const firstLine = firstNL === -1 ? text : text.slice(0, firstNL);
  if (firstLine !== '---') return { error: 'no front matter' };
  if (firstNL === -1) return { error: 'the front matter is not closed' };
  // Find the closing line.
  let closeStart = -1, closeEnd = -1;
  let scan = firstNL + 1;
  while (scan <= text.length) {
    const nl = text.indexOf('\n', scan);
    const end = nl === -1 ? text.length : nl;
    if (text.slice(scan, end) === '---') { closeStart = scan; closeEnd = end; break; }
    if (nl === -1) break;
    scan = nl + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let pos = firstNL + 1, lineIdx = 1;
  while (pos < closeStart) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? closeStart : Math.min(nl, closeStart);
    const line = text.slice(pos, end);
    if (!isBlankLine(line) && line[0] !== '#') {
      const colon = line.indexOf(':');
      let bad = false;
      if (colon === -1) bad = true;
      let key = '';
      if (!bad) {
        key = line.slice(0, colon);
        if (key.length === 0) bad = true;
        else for (let i = 0; i < key.length; i++) { const c = key.charCodeAt(i); if (!((c >= 97 && c <= 122) || c === 95)) { bad = true; break; } }
      }
      let raw = '';
      if (!bad) {
        const rest = line.slice(colon + 1);
        if (rest === '') raw = '';
        else if (rest[0] === ' ') raw = rest.slice(1);
        else bad = true;
      }
      if (bad) return { error: `line ${lineIdx + 1} is not "key: value"` };
      let e = raw.length;
      while (e > 0 && (raw[e - 1] === ' ' || raw[e - 1] === '\t')) e--;
      raw = raw.slice(0, e);
      if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    if (nl === -1 || nl >= closeStart) break;
    pos = nl + 1;
    lineIdx++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const body = closeEnd < text.length ? text.slice(closeEnd + 1) : '';
  return { data, body };
}

// ------------------------------------------------------------------ Markdown

const trimLine = (line) => {
  let a = 0, b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return line.slice(a, b);
};
function isBlank(s) { return isBlankLine(s); }

function fenceOpen(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return null;
  let i = 3, lang = '';
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) { lang += line[i]; i++; }
    else break;
  }
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  return i === line.length ? lang : null;
}
function fenceClose(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return false;
  for (let i = 3; i < line.length; i++) if (line[i] !== ' ' && line[i] !== '\t') return false;
  return true;
}
function headingOf(line) {
  let n = 0;
  while (n < line.length && line[n] === '#') n++;
  if (n === 0 || n > 6) return null;
  const c = line[n];
  if (c !== ' ' && c !== '\t') return null;
  const text = trimLine(line.slice(n + 1));
  if (text === '') return null;
  return { depth: n, text };
}
function isHr(line) {
  if (line[0] !== '-' && line[0] !== '*') return false;
  const ch = line[0];
  if (line[1] !== ch || line[2] !== ch) return false;
  for (let i = 3; i < line.length; i++) if (line[i] !== ' ' && line[i] !== '\t') return false;
  return true;
}
function endsParagraph(line) {
  return isBlank(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHr(line);
}
function bulletOf(line) {
  if ((line[0] === '-' || line[0] === '*') && line[1] === ' ') return line.slice(2);
  return null;
}
function orderedOf(line) {
  let i = 0;
  while (i < line.length && line[i] >= '0' && line[i] <= '9') i++;
  if (i === 0 || i > 9) return null;
  if (line[i] !== '.' || line[i + 1] !== ' ') return null;
  return { num: line.slice(0, i), text: line.slice(i + 2) };
}
function isContinued(line) {
  if (line[0] !== ' ' || line[1] !== ' ') return false;
  let i = 0;
  while (line[i] === ' ') i++;
  if (i < 2 || i >= line.length) return false;
  return !/\s/.test(line[i]);
}

// Inline: same semantics as the reference, chunked output. Bounds [a, b)
// thread through so nested strong/em/link text needs no slice.
function isEscapedPos(s, from, j) {
  let k = from;
  while (k < j) {
    if (s[k] === '\\' && k + 1 < s.length && escapable(s[k + 1])) k += 2;
    else k++;
  }
  return k > j;
}
function findUnescaped(s, what, from, end) {
  let j = s.indexOf(what, from);
  while (j !== -1 && j + what.length <= end) {
    if (!isEscapedPos(s, from, j)) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}
function findSingleStar(s, from, end) {
  let j = s.indexOf('*', from);
  while (j !== -1 && j < end) {
    if (isEscapedPos(s, from, j)) { j = s.indexOf('*', j + 1); continue; }
    if (j + 1 < end && s[j + 1] === '*') { j = s.indexOf('*', j + 2); continue; }
    return j;
  }
  return -1;
}

const INLINE_SPECIAL = /[\\`*[]/;
const SPECIAL_TBL = new Uint8Array(128);
SPECIAL_TBL[92] = 1; SPECIAL_TBL[96] = 1; SPECIAL_TBL[42] = 1; SPECIAL_TBL[91] = 1;

function inlineTo(s, a, b, link, out) {
  let i = a;
  while (i < b) {
    const c = s[i];
    if (c === '\\') {
      if (i + 1 < b && escapable(s[i + 1])) { pushEsc(out, s, i + 1, i + 2); i += 2; }
      else { out.push('\\'); i++; }
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < b && j > i + 1) { out.push('<code>'); pushEsc(out, s, i + 1, j); out.push('</code>'); i = j + 1; }
      else { out.push('`'); i++; }
      continue;
    }
    if (c === '*') {
      if (i + 1 < b && s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2, b);
        if (j > i + 2) { out.push('<strong>'); inlineTo(s, i + 2, j, link, out); out.push('</strong>'); i = j + 2; }
        else { out.push('**'); i += 2; }
        continue;
      }
      const j = findSingleStar(s, i + 1, b);
      if (j > i + 1) { out.push('<em>'); inlineTo(s, i + 1, j, link, out); out.push('</em>'); i = j + 1; }
      else { out.push('*'); i++; }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1, b);
      let m = -1;
      if (k !== -1 && k + 1 < b && s[k + 1] === '(') { const r = s.indexOf(')', k + 2); if (r !== -1 && r < b) m = r; }
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        const href = link(target);
        out.push('<a href="');
        pushEsc(out, href, 0, href.length);
        out.push('">');
        inlineTo(s, i + 1, k, link, out);
        out.push('</a>');
        i = m + 1;
        continue;
      }
      out.push('[');
      i++;
      continue;
    }
    let j = i;
    while (j < b) { const cc = s.charCodeAt(j); if (cc < 128 && SPECIAL_TBL[cc]) break; j++; }
    pushEsc(out, s, i, j);
    i = j;
  }
}

function inlineStr(s, link) {
  if (!INLINE_SPECIAL.test(s)) return esc(s);
  const out = [];
  inlineTo(s, 0, s.length, link, out);
  return out.join('');
}

function renderMarkdown(src, link, slugify) {
  const lines = src.split('\n');
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const L = lines.length;
  while (i < L) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const fenceLang = fenceOpen(line);
    if (fenceLang !== null) {
      const body = [];
      i++;
      while (i < L && !fenceClose(lines[i])) body.push(lines[i++]);
      i++;
      let html = '<pre><code';
      if (fenceLang !== '') html += ` class="language-${esc(fenceLang)}"`;
      html += '>';
      if (body.length) {
        const parts = [];
        for (const l of body) { pushEsc(parts, l, 0, l.length); parts.push('\n'); }
        html += parts.join('');
      }
      html += '</code></pre>';
      blocks.push(html + '\n');
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inlineStr(heading.text, link);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) { blocks.push('<hr>\n'); i++; continue; }
    if (line[0] === '>') {
      const body = [];
      while (i < L && lines[i][0] === '>') {
        const l = lines[i++];
        body.push(l[1] === ' ' ? l.slice(2) : l.slice(1));
      }
      const kept = [];
      for (const l of body) { const t = trimLine(l); if (t !== '') kept.push(t); }
      blocks.push((kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inlineStr(kept.join('\n'), link)}</p>\n</blockquote>`) + '\n');
      continue;
    }
    const bullet = bulletOf(line);
    const ordered = bullet === null ? orderedOf(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      let firstNum = 1;
      if (isOrdered) firstNum = Number(ordered.num);
      while (i < L) {
        if (isOrdered) {
          const m = orderedOf(lines[i]);
          if (m !== null) { items.push([trimLine(m.text)]); i++; continue; }
        } else {
          const m = bulletOf(lines[i]);
          if (m !== null) { items.push([trimLine(m)]); i++; continue; }
        }
        if (isContinued(lines[i])) { items[items.length - 1].push(trimLine(lines[i])); i++; }
        else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && firstNum !== 1 ? `<ol start="${firstNum}">` : `<${tag}>`;
      let html = `${open}\n`;
      for (const parts of items) html += `<li>${inlineStr(parts.join('\n'), link)}</li>\n`;
      html += `</${tag}>`;
      blocks.push(html + '\n');
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < L && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inlineStr(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>\n`);
  }
  return { html: blocks.length ? blocks.join('') : '', toc, excerpt: excerpt ?? '' };
}

// ------------------------------------------------------------------ templates

class TemplateError extends Error {}
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) { text += src.slice(i); break; }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// Lookup used by the interpreter fallback: first name via the prototype
// chain, later names via own properties.
function lookupInterp(scope, path) {
  let v = scope[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}
function renderInterp(nodes, scope, T, depth) {
  let out = '';
  for (const n of nodes) {
    if (n.kind === 'text') out += n.text;
    else if (n.kind === 'var') out += esc(textOf(lookupInterp(scope, n.path)));
    else if (n.kind === 'raw') out += textOf(lookupInterp(scope, n.path));
    else if (n.kind === 'if') {
      const branch = truthy(lookupInterp(scope, n.path)) !== n.not ? n.then : n.else;
      if (branch !== null) out += renderInterp(branch, scope, T, depth);
    } else if (n.kind === 'for') {
      const xs = lookupInterp(scope, n.path);
      if (Array.isArray(xs)) for (let k = 0; k < xs.length; k++) {
        const child = Object.create(scope);
        child[n.name] = xs[k];
        child.loop = { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length };
        out += renderInterp(n.body, child, T, depth);
      }
    } else if (n.kind === 'include') {
      const t = T[n.name];
      if (t !== undefined && depth < 8) out += t.fn(scope, depth + 1);
    }
  }
  return out;
}

// Compile a template AST to a function(scope, depth). T is the map of
// compiled templates (filled before any call); each entry is {fn}.
function compileTemplate(nodes, T) {
  const ctr = { n: 0 };
  const code = [];
  function emitLookup(path, sc, v) {
    code.push(`var ${v}=${sc}[${JSON.stringify(path[0])}];`);
    for (let k = 1; k < path.length; k++) {
      const p = JSON.stringify(path[k]);
      code.push(`if(${v}!==null&&typeof ${v}==='object'&&Object.hasOwn(${v},${p})){${v}=${v}[${p}];}else{${v}=undefined;}`);
    }
  }
  function gen(list, sc) {
    for (const n of list) {
      if (n.kind === 'text') { code.push(`o+=${JSON.stringify(n.text)};`); continue; }
      if (n.kind === 'var' || n.kind === 'raw') {
        const v = `_v${++ctr.n}`;
        emitLookup(n.path, sc, v);
        code.push(n.kind === 'var' ? `o+=esc(txt(${v}));` : `o+=txt(${v});`);
        continue;
      }
      if (n.kind === 'if') {
        const v = `_v${++ctr.n}`;
        emitLookup(n.path, sc, v);
        code.push(`if(truthy(${v})===${n.not ? 'false' : 'true'}){`);
        gen(n.then, sc);
        if (n.else !== null) { code.push('}else{'); gen(n.else, sc); }
        code.push('}');
        continue;
      }
      if (n.kind === 'for') {
        const xs = `_x${++ctr.n}`, k = `_k${++ctr.n}`, sc2 = `_s${++ctr.n}`;
        emitLookup(n.path, sc, xs);
        code.push(`if(Array.isArray(${xs})){for(var ${k}=0;${k}<${xs}.length;${k}++){var ${sc2}=Object.create(${sc});${sc2}[${JSON.stringify(n.name)}]=${xs}[${k}];${sc2}.loop={index:${k}+1,first:${k}===0,last:${k}===${xs}.length-1,length:${xs}.length};`);
        gen(n.body, sc2);
        code.push('}}');
        continue;
      }
      if (n.kind === 'include') {
        const f = `_f${++ctr.n}`;
        code.push(`if(depth<8){var ${f}=T[${JSON.stringify(n.name)}];if(${f}!==undefined){o+=${f}.fn(${sc},depth+1);}}`);
        continue;
      }
    }
  }
  gen(nodes, 'scope');
  const src = `return function(scope,depth){var o='';${code.join('')}return o;}`;
  try {
    const factory = new Function('T', 'esc', 'txt', 'truthy', src);
    return { fn: factory(T, esc, textOf, truthy), ast: nodes };
  } catch (e) {
    return null;
  }
}

// ------------------------------------------------------------------ build

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

function wordsOf(text) {
  let n = 0, inW = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws = c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 160 || c === 0x1680 ||
      (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
    if (ws) inW = false;
    else if (!inW) { inW = true; n++; }
  }
  return n;
}

function isScheme(t) {
  const c0 = t.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

export function run(input) {
  const slugCache = new Map();
  const slugify = makeSlugify(slugCache);
  const longCache = new Map();
  const longDate = makeLongDate(longCache);
  const report = [];
  const T = {};
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    let ast;
    try {
      ast = parseTemplate(name, input.templates[name]);
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
      continue;
    }
    const compiled = compileTemplate(ast, T);
    T[name] = compiled !== null ? compiled : { fn: (scope, depth) => renderInterp(ast, scope, T, depth), ast };
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    else statics.push({ path: f.path, content: f.content });
  }

  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) { report.push(`refused ${s.path}: ${fm.error}`); continue; }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    for (const d of RESERVED) if (d !== 'posts' && s.path.startsWith(`${d}/`)) { own = d; break; }
    if (own !== undefined) { report.push(`refused ${s.path}: ${own}/ is the generator's own`); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { report.push(`refused ${s.path}: a post needs a date`); continue; }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (T[layout] === undefined) { report.push(`refused ${s.path}: layout "${layout}" is no template that parses`); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push(`draft ${s.path}`); continue; }
    kept.push(s);
  }

  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) { set = new Set(dir === '' ? RESERVED : []); taken.set(dir, set); }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const resolveCache = new Map();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const srcPath = s.path;
    const link = (target) => {
      if (target[0] === '/' || target[0] === '#') return target;
      if (isScheme(target)) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      let path = null;
      if (rel !== '') {
        const key = dir + '\0' + rel;
        path = resolveCache.get(key);
        if (path === undefined) { path = resolvePath(dir, rel); resolveCache.set(key, path); }
      }
      if (path !== null) {
        const page = bySource.get(path);
        if (page !== undefined) return `${page.url}${frag}`;
        if (staticPaths.has(path)) return `${base}/${path}${frag}`;
      }
      broken.add(`broken-link ${srcPath} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link, slugify);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) { tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] }; bySlug.set(slug, tag); }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cards = new Map();
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  for (const p of posts) cards.set(p, cardOf(p));
  const pageObjs = new Map();
  for (const s of kept) {
    const c = s.post ? cards.get(s) : cardOf(s);
    pageObjs.set(s, {
      ...c,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    });
  }

  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  const render = (name, vars) => {
    const t = T[name];
    if (t === undefined) return null;
    const scope = Object.create(null);
    scope.site = site; scope.tags = allTags; scope.recent = recent;
    for (const k of Object.keys(vars)) scope[k] = vars[k];
    return t.fn(scope, 0);
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageObjs.get(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
