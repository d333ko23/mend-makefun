// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`. Implements all of SPEC.md: sections 1 to 4 (command line, output,
// safe paths, format detection), 5 (three-tier line matching), 6 (unified diffs), 7 (SEARCH/REPLACE
// blocks), 8 (V4A patches), 9 (JSON edits) and 10 (order and atomicity).
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands
// over to runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Files and line matching (SPEC.md sections 3 and 5)
// ---------------------------------------------------------------------------

interface FileState {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function matchAt(file: string[], O: string[], pos: number, tier: number): boolean {
  if (pos < 0 || pos + O.length > file.length) return false;
  for (let k = 0; k < O.length; k++) {
    if (normLine(file[pos + k]!, tier) !== normLine(O[k]!, tier)) return false;
  }
  return true;
}

function occurrences(file: string[], O: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = from; i + O.length <= file.length; i++) {
    if (matchAt(file, O, i, tier)) out.push(i);
  }
  return out;
}

function tiers(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** First tier at which O occurs at least once at or after `from`, with all its positions. */
function findTier(file: string[], O: string[], from: number, strict: boolean): { tier: number; positions: number[] } | null {
  for (const t of tiers(strict)) {
    const pos = occurrences(file, O, t, from);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

interface NLine {
  text: string;
  /** Index into O when this is a context line (written as the file's own matched line), else null. */
  ctx: number | null;
}

/**
 * Build the replacement lines for a match of O at `pos` in `file` at `tier`: context lines are
 * the file's own matched lines; at tier 2 every other line is re-indented from P (leading
 * whitespace of O's first line) to F (leading whitespace of the file's first matched line).
 */
function applyMatch(file: string[], O: string[], N: NLine[], tier: number, pos: number): string[] {
  const out: string[] = [];
  const F = O.length > 0 ? leadingWs(file[pos]!) : '';
  const P = O.length > 0 ? leadingWs(O[0]!) : '';
  for (const nl of N) {
    if (nl.ctx !== null) {
      out.push(file[pos + nl.ctx]!);
      continue;
    }
    let t = nl.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(P)) t = F + t.slice(P.length);
    out.push(t);
  }
  return out;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  A: number;
  O: string[];
  N: NLine[];
  plus: string[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noeol: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  plusNoeol: boolean;
}

function parseHunkBody(A: number, body: string[]): Hunk {
  const O: string[] = [];
  const N: NLine[] = [];
  const plus: string[] = [];
  let lastCtxPlus = -1;
  let lastPlus = -1;
  for (let idx = 0; idx < body.length; idx++) {
    const l = body[idx]!;
    if (l.startsWith('\\')) continue;
    const k = l === '' ? ' ' : l[0]!;
    if (k === ' ') {
      const text = l === '' ? '' : l.slice(1);
      O.push(text);
      N.push({ text, ctx: O.length - 1 });
      lastCtxPlus = idx;
    } else if (k === '-') {
      O.push(l.slice(1));
    } else if (k === '+') {
      const text = l.slice(1);
      N.push({ text, ctx: null });
      plus.push(text);
      lastCtxPlus = idx;
      lastPlus = idx;
    }
  }
  const noeol = lastCtxPlus >= 0 && body[lastCtxPlus + 1] !== undefined && body[lastCtxPlus + 1]!.startsWith('\\');
  const plusNoeol = lastPlus >= 0 && body[lastPlus + 1] !== undefined && body[lastPlus + 1]!.startsWith('\\');
  return { A, O, N, plus, noeol, plusNoeol };
}

interface USection {
  gitOld: string | null;
  gitNew: string | null;
  hdrOld: string | null;
  hdrNew: string | null;
  renFrom: string | null;
  renTo: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

/** Path from a `--- ` / `+++ ` header line: text after the four characters, up to the first tab, trimmed. */
function headerPath(line: string): string {
  return line.slice(4).split('\t')[0]!.trim();
}

function stripAB(p: string): string | null {
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function parseUnified(lines: string[]): USection[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let inHeader = false;
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = { gitOld: m[1]!, gitNew: m[2]!, hdrOld: null, hdrNew: null, renFrom: null, renTo: null, newFile: false, delFile: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:\s|$)/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const A = parseInt(m[1]!, 10);
      const body: string[] = [];
      let j = i + 1;
      while (j < n) {
        const bl = lines[j]!;
        if (bl.startsWith('--- ') && j + 1 < n && lines[j + 1]!.startsWith('+++ ')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          body.push(bl);
          j++;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push(parseHunkBody(A, body));
      inHeader = false;
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) {
        if (!(i + 1 < n && lines[i + 1]!.startsWith('+++ '))) throw new Exit2(`error: parse ${i + 2}`);
        cur.hdrOld = stripAB(headerPath(line));
        cur.hdrNew = stripAB(headerPath(lines[i + 1]!));
        i += 2;
        continue;
      }
      if (line.startsWith('+++ ')) {
        cur.hdrNew = stripAB(headerPath(line));
        i++;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renFrom = line.slice(12).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renTo = line.slice(10).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.newFile = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.delFile = true;
        i++;
        continue;
      }
      // index, old mode, new mode, similarity index, dissimilarity index, Index: and any other line: ignored.
      i++;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < n && lines[i + 1]!.startsWith('+++ ')) {
      cur = { gitOld: null, gitNew: null, hdrOld: stripAB(headerPath(line)), hdrNew: stripAB(headerPath(lines[i + 1]!)), renFrom: null, renTo: null, newFile: false, delFile: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      i += 2;
      continue;
    }
    i++;
  }
  return sections;
}

/** Apply a section's hunks in order to `content` (section 6, "Applying hunks"). */
function applyHunks(content: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(content);
  let d = 0;
  for (const h of hunks) {
    if (h.O.length === 0) {
      let pos = h.A + d;
      if (pos < 0) pos = 0;
      if (pos > f.lines.length) pos = f.lines.length;
      const atEnd = pos === f.lines.length;
      const ins = h.N.map((x) => x.text);
      f.lines = [...f.lines.slice(0, pos), ...ins, ...f.lines.slice(pos)];
      if (atEnd) f.final = !h.noeol;
      d += h.N.length;
    } else {
      const found = findTier(f.lines, h.O, 0, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.A - 1 + d;
      let best = found.positions[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.positions) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const runsToEnd = best + h.O.length === f.lines.length;
      const rep = applyMatch(f.lines, h.O, h.N, found.tier, best);
      f.lines = [...f.lines.slice(0, best), ...rep, ...f.lines.slice(best + h.O.length)];
      if (runsToEnd) f.final = !h.noeol;
      d += h.N.length - h.O.length;
    }
  }
  return joinFile(f);
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return parseUnified(lines).map((sec) => {
    const oldP = sec.hdrOld ?? sec.renFrom ?? sec.gitOld;
    const newP = sec.hdrNew ?? sec.renTo ?? sec.gitNew;
    const isCreate = oldP === null || sec.newFile;
    const isDelete = !isCreate && (newP === null || sec.delFile);
    return (tree: Tree) => {
      if (isCreate) {
        if (newP === null) return;
        if (!safe(newP)) throw new Fail('unsafe', newP);
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const plusLines: string[] = [];
        let lastPlusNoeol = false;
        let anyPlus = false;
        for (const h of sec.hunks) {
          plusLines.push(...h.plus);
          if (h.plus.length > 0) {
            anyPlus = true;
            lastPlusNoeol = h.plusNoeol;
          }
        }
        tree.now.set(newP, !anyPlus ? '' : plusLines.join('\n') + (lastPlusNoeol ? '' : '\n'));
        return;
      }
      if (isDelete) {
        if (oldP === null) throw new Fail('missing', '');
        if (!safe(oldP)) throw new Fail('unsafe', oldP);
        if (tree.get(oldP) === null) throw new Fail('missing', oldP);
        tree.now.set(oldP, null);
        return;
      }
      if (oldP !== newP) {
        if (!safe(oldP!)) throw new Fail('unsafe', oldP!);
        if (!safe(newP!)) throw new Fail('unsafe', newP!);
        const content = tree.get(oldP!);
        if (content === null) throw new Fail('missing', oldP!);
        if (tree.get(newP!) !== null) throw new Fail('exists', newP!);
        const out = applyHunks(content, sec.hunks, strict, oldP!);
        tree.now.set(newP!, out);
        tree.now.set(oldP!, null);
        tree.moves.push([oldP!, newP!]);
        return;
      }
      if (!safe(oldP!)) throw new Fail('unsafe', oldP!);
      const content = tree.get(oldP!);
      if (content === null) throw new Fail('missing', oldP!);
      tree.now.set(oldP!, applyHunks(content, sec.hunks, strict, oldP!));
    };
  });
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    let eq = -1;
    for (let k = i + 1; k < n; k++) {
      const t = lines[k]!.trimEnd();
      if (t === '=======') {
        eq = k;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchLine}`);
    let rep = -1;
    for (let k = eq + 1; k < n; k++) {
      const t = lines[k]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree: Tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const content = tree.get(p);
      if (content === null) throw new Fail('missing', p);
      const f = splitFile(content);
      const found = findTier(f.lines, oldLines, 0, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.positions.length > 1) throw new Fail('ambiguous', p);
      const pos = found.positions[0]!;
      const repLines = applyMatch(f.lines, oldLines, newLines.map((t) => ({ text: t, ctx: null })), found.tier, pos);
      f.lines = [...f.lines.slice(0, pos), ...repLines, ...f.lines.slice(pos + oldLines.length)];
      tree.now.set(p, joinFile(f));
    });
    prevPath = p;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  O: string[];
  N: NLine[];
}

interface RawLine {
  text: string;
  num: number;
}

function v4aHeader(line: string): { kind: 'add' | 'delete' | 'update'; path: string } | null {
  if (line.startsWith('*** Add File: ')) return { kind: 'add', path: line.slice(14).trim() };
  if (line.startsWith('*** Delete File: ')) return { kind: 'delete', path: line.slice(17).trim() };
  if (line.startsWith('*** Update File: ')) return { kind: 'update', path: line.slice(17).trim() };
  return null;
}

function chunkFromBody(body: RawLine[]): VChunk {
  const O: string[] = [];
  const N: NLine[] = [];
  for (const l of body) {
    const t = l.text;
    if (t === '') {
      O.push('');
      N.push({ text: '', ctx: O.length - 1 });
    } else if (t[0] === ' ') {
      const x = t.slice(1);
      O.push(x);
      N.push({ text: x, ctx: O.length - 1 });
    } else if (t[0] === '-') {
      O.push(t.slice(1));
    } else if (t[0] === '+') {
      N.push({ text: t.slice(1), ctx: null });
    }
  }
  return { anchor: null, eof: false, O, N };
}

function parseVChunks(raw: RawLine[]): VChunk[] {
  const chunks: VChunk[] = [];
  let cur: { anchor: string | null; eof: boolean; body: RawLine[] } | null = null;
  const flush = (): void => {
    if (cur !== null) {
      const c = chunkFromBody(cur.body);
      c.anchor = cur.anchor;
      c.eof = cur.eof;
      chunks.push(c);
      cur = null;
    }
  };
  for (const l of raw) {
    if (l.text.startsWith('@@')) {
      flush();
      const a = l.text.slice(2).trim();
      cur = { anchor: a === '' ? null : a, eof: false, body: [] };
    } else if (l.text.trim() === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${l.num}`);
      cur.eof = true;
      flush();
    } else {
      if (cur === null) cur = { anchor: null, eof: false, body: [] };
      cur.body.push(l);
    }
  }
  flush();
  return chunks;
}

function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number {
  for (const t of tiers(strict)) {
    for (let i = from; i < lines.length; i++) {
      if (normLine(lines[i]!, t) === normLine(anchor, t)) return i;
    }
  }
  return -1;
}

function findChunk(lines: string[], O: string[], from: number, eof: boolean, strict: boolean): { tier: number; pos: number } | null {
  if (eof) {
    const pos = lines.length - O.length;
    if (pos < from) return null;
    for (const t of tiers(strict)) {
      if (matchAt(lines, O, pos, t)) return { tier: t, pos };
    }
    return null;
  }
  for (const t of tiers(strict)) {
    const ps = occurrences(lines, O, t, from);
    if (ps.length > 0) return { tier: t, pos: ps[0]! };
  }
  return null;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const end = last;
  let i = first + 1;
  while (true) {
    while (i < end && blank(lines[i]!)) i++;
    if (i >= end) break;
    const head = v4aHeader(lines[i]!);
    if (head === null) throw new Exit2(`error: parse ${i + 1}`);
    const headNum = i + 1;
    if (head.kind === 'add') {
      const raw: RawLine[] = [];
      let j = i + 1;
      while (j < end) {
        const l = lines[j]!;
        if (v4aHeader(l) !== null || l.trim() === '*** End Patch') break;
        if (l.startsWith('+') || blank(l)) {
          raw.push({ text: l, num: j + 1 });
          j++;
        } else throw new Exit2(`error: parse ${j + 1}`);
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      const fileLines = raw.map((r) => (r.text.startsWith('+') ? r.text.slice(1) : ''));
      const p = head.path;
      edits.push((tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
      i = j;
      continue;
    }
    if (head.kind === 'delete') {
      let j = i + 1;
      while (j < end && blank(lines[j]!)) j++;
      if (j < end) {
        const l = lines[j]!;
        if (v4aHeader(l) === null && l.trim() !== '*** End Patch') throw new Exit2(`error: parse ${j + 1}`);
      }
      const p = head.path;
      edits.push((tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      i = j;
      continue;
    }
    // update
    let moveTo: string | null = null;
    let k = i + 1;
    while (k < end && blank(lines[k]!)) k++;
    if (k < end && lines[k]!.startsWith('*** Move to: ')) {
      moveTo = lines[k]!.slice(13).trim();
      k++;
    }
    const raw: RawLine[] = [];
    let j = k;
    while (j < end) {
      const l = lines[j]!;
      if (v4aHeader(l) !== null || l.trim() === '*** End Patch') break;
      if (l.startsWith('@@') || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || blank(l) || l.trim() === '*** End of File') {
        raw.push({ text: l, num: j + 1 });
        j++;
      } else throw new Exit2(`error: parse ${j + 1}`);
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    const chunks = parseVChunks(raw);
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headNum}`);
    const p = head.path;
    const mv = moveTo;
    edits.push((tree: Tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (mv !== null && !safe(mv)) throw new Fail('unsafe', mv);
      const content = tree.get(p);
      if (content === null) throw new Fail('missing', p);
      if (mv !== null && tree.get(mv) !== null) throw new Fail('exists', mv);
      const f = splitFile(content);
      let cursor = 0;
      for (const ch of chunks) {
        if (ch.anchor !== null) {
          const idx = findAnchor(f.lines, ch.anchor, cursor, strict);
          if (idx === -1) throw new Fail('no-match', p);
          cursor = idx + 1;
        }
        if (ch.O.length === 0) {
          const pos = ch.eof ? f.lines.length : Math.min(cursor, f.lines.length);
          const ins = ch.N.map((x) => x.text);
          f.lines = [...f.lines.slice(0, pos), ...ins, ...f.lines.slice(pos)];
          cursor = pos + ins.length;
        } else {
          const found = findChunk(f.lines, ch.O, cursor, ch.eof, strict);
          if (found === null) throw new Fail('no-match', p);
          const rep = applyMatch(f.lines, ch.O, ch.N, found.tier, found.pos);
          f.lines = [...f.lines.slice(0, found.pos), ...rep, ...f.lines.slice(found.pos + ch.O.length)];
          cursor = found.pos + rep.length;
        }
      }
      const out = joinFile(f);
      if (mv !== null) {
        tree.now.set(mv, out);
        tree.now.set(p, null);
        tree.moves.push([p, mv]);
      } else {
        tree.now.set(p, out);
      }
    });
    i = j;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Running (SPEC.md sections 1, 2 and 10)
// ---------------------------------------------------------------------------

function byteCmp(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p));
  const added = new Set(changed.filter((p) => tree.original(p) === null));
  const deleted = new Set(changed.filter((p) => tree.now.get(p) === null));
  const moveMap = new Map<string, string>(tree.moves);
  const pairs: Array<[string, string]> = [];
  const usedAdded = new Set<string>();
  for (const d of [...deleted].sort(byteCmp)) {
    let cur = d;
    const seen = new Set<string>([d]);
    while (moveMap.has(cur)) {
      cur = moveMap.get(cur)!;
      if (seen.has(cur)) break;
      seen.add(cur);
      if (added.has(cur) && !usedAdded.has(cur)) {
        pairs.push([d, cur]);
        usedAdded.add(cur);
        break;
      }
    }
  }
  const paired = new Set<string>();
  for (const [o, nw] of pairs) {
    paired.add(o);
    paired.add(nw);
  }
  const rows: { key: string; text: string }[] = [];
  for (const [o, nw] of pairs) rows.push({ key: nw, text: `R ${o} -> ${nw}` });
  for (const p of changed) {
    if (paired.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteCmp(a.key, b.key));
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
