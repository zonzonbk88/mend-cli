// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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
  /** Moves a move edit performed, in order: [old path, new path]. Restored when an edit fails. */
  readonly moves: [string, string][] = [];
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

/* ------------------------------------------------------------------ */
/* Lines of a file (SPEC.md section 3) and matching tiers (section 5)  */
/* ------------------------------------------------------------------ */

interface FileModel {
  lines: string[];
  br: string;
  fin: boolean;
}

function splitText(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', fin: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const fin = text.endsWith(br);
  const parts = text.split(br);
  if (fin) parts.pop();
  return { lines: parts, br, fin };
}

function joinText(m: FileModel): string {
  return m.lines.length === 0 ? '' : m.lines.join(m.br) + (m.fin ? m.br : '');
}

const trailWs = (s: string): string => s.replace(/[ \t]+$/, '');
const bothWs = (s: string): string => trailWs(s.replace(/^[ \t]+/, ''));
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

function tierEq(a: string, b: string, tier: number): boolean {
  return tier === 0 ? a === b : tier === 1 ? trailWs(a) === trailWs(b) : bothWs(a) === bothWs(b);
}

/** Positions i (from `from` on) where O matches lines[i..]; with eofOnly, only positions ending at the last line. */
function occurrences(lines: string[], O: string[], tier: number, from: number, eofOnly: boolean): number[] {
  const out: number[] = [];
  for (let i = Math.max(0, from); i + O.length <= lines.length; i += 1) {
    if (eofOnly && i + O.length !== lines.length) continue;
    let ok = true;
    for (let k = 0; k < O.length; k += 1) {
      if (!tierEq(lines[i + k]!, O[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface Found {
  tier: number;
  at: number[];
}

/** The first tier at which O occurs at least once, and its positions there; null when O occurs at no tier. */
function findO(lines: string[], O: string[], strict: boolean, from = 0, eofOnly = false): Found | null {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const at = occurrences(lines, O, tier, from, eofOnly);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** One line of a hunk or chunk body: a context line, a removed line or an added line. */
interface SegItem {
  kind: 'ctx' | 'del' | 'add';
  text: string;
  /** A `\` line followed this body line. */
  noeol?: boolean;
  /** This item came from an empty patch line (a unified body may drop trailing ones). */
  emptyLine?: boolean;
}

/**
 * The lines a matched hunk or chunk writes at `pos`: context lines are the file's own matched lines,
 * removed lines vanish, added lines are written as they are, re-indented at tier 2 (section 5).
 */
function buildSeg(items: SegItem[], fileLines: string[], pos: number, tier: number, O: string[]): string[] {
  const out: string[] = [];
  const F = O.length > 0 ? leadWs(fileLines[pos]!) : '';
  const P = O.length > 0 ? leadWs(O[0]!) : '';
  let oi = 0;
  for (const it of items) {
    if (it.kind === 'ctx') {
      out.push(fileLines[pos + oi]!);
      oi += 1;
    } else if (it.kind === 'del') {
      oi += 1;
    } else {
      let t = it.text;
      if (tier === 2 && t.trim() !== '' && t.startsWith(P)) t = F + t.slice(P.length);
      out.push(t);
    }
  }
  return out;
}

/** One added line under the tier rules, for formats whose new lines have no context lines of their own. */
function addedLine(t: string, tier: number, O: string[], fileLines: string[], pos: number): string {
  if (tier !== 2 || t.trim() === '') return t;
  const P = leadWs(O[0]!);
  return t.startsWith(P) ? leadWs(fileLines[pos]!) + t.slice(P.length) : t;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

interface Hunk {
  a: number;
  items: SegItem[];
}

interface Section {
  diffOld: string | null;
  diffNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

/** The path a `--- ` or `+++ ` line names: after the four characters, to the first tab, spaces removed, a/ b/ removed. */
function headerPath(raw: string): string {
  let p = raw.split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let sec: Section | null = null;
  let header = false;
  let i = 0;
  const newSection = (diffOld: string | null, diffNew: string | null): Section => {
    const s: Section = { diffOld, diffNew, pairOld: null, pairNew: null, renameFrom: null, renameTo: null, create: false, del: false, hunks: [] };
    sections.push(s);
    sec = s;
    header = true;
    return s;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const rest = line.slice('diff --git '.length);
      const sep = rest.startsWith('a/') ? rest.indexOf(' b/', 2) : -1;
      if (sep < 0) throw new Exit2(`error: parse ${i + 1}`);
      newSection(rest.slice(2, sep), rest.slice(sep + 3));
      i += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      const followed = (lines[i + 1] ?? '').startsWith('+++ ');
      if (sec !== null && header && sec.pairOld === null) {
        if (!followed) throw new Exit2(`error: parse ${i + 2}`);
        sec.pairOld = headerPath(line.slice(4));
        sec.pairNew = headerPath(lines[i + 1]!.slice(4));
        i += 2;
        continue;
      }
      if (followed) {
        const s = newSection(null, null);
        s.pairOld = headerPath(line.slice(4));
        s.pairNew = headerPath(lines[i + 1]!.slice(4));
        i += 2;
        continue;
      }
      if (sec !== null && header) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (sec === null) {
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }
    if (header) {
      if (line.startsWith('rename from ')) {
        sec.renameFrom = line.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        sec.renameTo = line.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        sec.create = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        sec.del = true;
        i += 1;
        continue;
      }
      if (!line.startsWith('@@')) {
        i += 1;
        continue;
      }
      header = false;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      i += 1;
      const items: SegItem[] = [];
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '') {
          items.push({ kind: 'ctx', text: '', emptyLine: true });
          i += 1;
          continue;
        }
        const c = b[0]!;
        if (c === ' ') items.push({ kind: 'ctx', text: b.slice(1) });
        else if (c === '-') items.push({ kind: 'del', text: b.slice(1) });
        else if (c === '+') items.push({ kind: 'add', text: b.slice(1) });
        else if (c === '\\') {
          if (items.length > 0) items[items.length - 1]!.noeol = true;
          i += 1;
          continue;
        } else break;
        i += 1;
      }
      while (items.length > 0 && items[items.length - 1]!.emptyLine === true) items.pop();
      sec.hunks.push({ a, items });
      continue;
    }
    i += 1;
  }
  return sections;
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.pairOld ?? sec.renameFrom ?? sec.diffOld ?? sec.pairNew ?? sec.renameTo ?? sec.diffNew;
    const newP = sec.pairNew ?? sec.renameTo ?? sec.diffNew ?? sec.pairOld ?? sec.renameFrom ?? sec.diffOld;
    if (oldP === null || newP === null) throw new Fail('missing', '');
    const isCreate = sec.create || oldP === '/dev/null';
    const isDelete = sec.del || newP === '/dev/null';
    if (oldP !== '/dev/null' && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== '/dev/null' && !safe(newP)) throw new Fail('unsafe', newP);
    if (isCreate) {
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const out: string[] = [];
      let lastNoeol = false;
      for (const h of sec.hunks) {
        for (const it of h.items) {
          if (it.kind === 'add') {
            out.push(it.text);
            lastNoeol = it.noeol === true;
          }
        }
      }
      tree.now.set(newP, out.length === 0 ? '' : out.join('\n') + (lastNoeol ? '' : '\n'));
      return;
    }
    if (isDelete) {
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    const src = tree.get(oldP);
    if (src === null) throw new Fail('missing', oldP);
    const isMove = newP !== oldP;
    if (isMove && tree.get(newP) !== null) throw new Fail('exists', newP);
    const model = splitText(src);
    let d = 0;
    for (const h of sec.hunks) {
      const O = h.items.filter((it) => it.kind !== 'add').map((it) => it.text);
      const nLen = h.items.filter((it) => it.kind !== 'del').length;
      if (O.length === 0) {
        const adds = h.items.filter((it) => it.kind === 'add');
        const at = Math.min(h.a + d, model.lines.length);
        const atEnd = at === model.lines.length;
        model.lines.splice(at, 0, ...adds.map((it) => it.text));
        if (atEnd && adds.length > 0) model.fin = adds[adds.length - 1]!.noeol !== true;
      } else {
        const f = findO(model.lines, O, strict);
        if (f === null) throw new Fail('no-match', oldP);
        const target = h.a - 1 + d;
        let pos = f.at[0]!;
        let best = Math.abs(pos - target);
        for (const cand of f.at) {
          const dd = Math.abs(cand - target);
          if (dd < best) {
            best = dd;
            pos = cand;
          }
        }
        const seg = buildSeg(h.items, model.lines, pos, f.tier, O);
        const touchesEnd = pos + O.length === model.lines.length;
        model.lines.splice(pos, O.length, ...seg);
        if (touchesEnd) {
          const lastCA = [...h.items].reverse().find((it) => it.kind !== 'del');
          model.fin = !(lastCA !== undefined && lastCA.noeol === true);
        }
      }
      d += nLen - O.length;
    }
    const text = joinText(model);
    if (isMove) {
      tree.now.set(oldP, null);
      tree.now.set(newP, text);
      tree.moves.push([oldP, newP]);
    } else {
      tree.now.set(oldP, text);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return parseUnified(lines).map((sec) => unifiedEdit(sec, strict));
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                            */
/* ------------------------------------------------------------------ */

function srEdit(p: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (oldLines.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const src = tree.get(p);
    if (src === null) throw new Fail('missing', p);
    const model = splitText(src);
    const f = findO(model.lines, oldLines, strict);
    if (f === null) throw new Fail('no-match', p);
    if (f.at.length > 1) throw new Fail('ambiguous', p);
    const pos = f.at[0]!;
    const seg = newLines.map((t) => addedLine(t, f.tier, oldLines, model.lines, pos));
    model.lines.splice(pos, oldLines.length, ...seg);
    tree.now.set(p, joinText(model));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const at = i;
    let p: string | null = null;
    for (let j = at - 1; j >= searchFrom; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      p = t;
      break;
    }
    if (p === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${at + 1}`);
      p = prevPath;
    }
    let mid = -1;
    let end = -1;
    for (let j = at + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        mid = j;
        break;
      }
    }
    if (mid >= 0) {
      for (let j = mid + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          end = j;
          break;
        }
      }
    }
    if (mid < 0 || end < 0) throw new Exit2(`error: parse ${at + 1}`);
    edits.push(srEdit(p, lines.slice(at + 1, mid), lines.slice(mid + 1, end), strict));
    prevPath = p;
    searchFrom = end + 1;
    i = end + 1;
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

interface Chunk {
  anchor: string | null;
  eof: boolean;
  items: SegItem[];
}

const ADD_HDR = '*** Add File: ';
const DEL_HDR = '*** Delete File: ';
const UPD_HDR = '*** Update File: ';
const MOVE_HDR = '*** Move to: ';

function v4aSectionKind(t: string): 'add' | 'delete' | 'update' | null {
  if (t.startsWith(ADD_HDR)) return 'add';
  if (t.startsWith(DEL_HDR)) return 'delete';
  if (t.startsWith(UPD_HDR)) return 'update';
  return null;
}

/** The first line at or after `from` equal to the anchor, at the first tier that has one; -1 when there is none. */
function findAnchor(lines: string[], anchor: string, strict: boolean, from: number): number {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    for (let i = from; i < lines.length; i += 1) {
      if (tierEq(lines[i]!, anchor, tier)) return i;
    }
  }
  return -1;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const firstNB = lines.findIndex((l) => !blank(l));
  if (firstNB < 0) throw new Exit2('error: parse 1');
  if (lines[firstNB]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${firstNB + 1}`);
  let lastNB = -1;
  for (let j = lines.length - 1; j >= 0; j -= 1) {
    if (!blank(lines[j]!)) {
      lastNB = j;
      break;
    }
  }
  if (lines[lastNB]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = firstNB + 1;
  while (i < lastNB) {
    const t = lines[i]!.trim();
    if (t === '') {
      i += 1;
      continue;
    }
    const kind = v4aSectionKind(t);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const hdr = kind === 'add' ? ADD_HDR : kind === 'delete' ? DEL_HDR : UPD_HDR;
    const path = t.slice(hdr.length).trim();
    const secLine = i + 1;
    i += 1;
    const content: { text: string; line: number }[] = [];
    while (i < lastNB) {
      if (v4aSectionKind(lines[i]!.trim()) !== null) break;
      content.push({ text: lines[i]!, line: i + 1 });
      i += 1;
    }
    while (content.length > 0 && blank(content[content.length - 1]!.text)) content.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const c of content) {
        if (c.text.startsWith('+')) fileLines.push(c.text.slice(1));
        else if (c.text === '') fileLines.push('');
        else throw new Exit2(`error: parse ${c.line}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
    } else if (kind === 'delete') {
      if (content.length > 0) throw new Exit2(`error: parse ${content[0]!.line}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      let moveTo: string | null = null;
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      content.forEach((c, ci) => {
        const tt = c.text.trim();
        if (ci === 0 && tt.startsWith(MOVE_HDR)) {
          moveTo = tt.slice(MOVE_HDR.length).trim();
          return;
        }
        if (c.text === '' || c.text[0] === ' ' || c.text[0] === '-' || c.text[0] === '+') {
          if (cur === null) {
            cur = { anchor: null, eof: false, items: [] };
            chunks.push(cur);
          }
          if (c.text === '') cur.items.push({ kind: 'ctx', text: '' });
          else cur.items.push({ kind: c.text[0] === ' ' ? 'ctx' : c.text[0] === '-' ? 'del' : 'add', text: c.text.slice(1) });
          return;
        }
        if (c.text.startsWith('@@')) {
          cur = { anchor: c.text.slice(2).trim() || null, eof: false, items: [] };
          chunks.push(cur);
          return;
        }
        if (tt === '*** End of File') {
          if (cur === null) {
            cur = { anchor: null, eof: true, items: [] };
            chunks.push(cur);
          } else cur.eof = true;
          cur = null;
          return;
        }
        throw new Exit2(`error: parse ${c.line}`);
      });
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${secLine}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        const src = tree.get(path);
        if (src === null) throw new Fail('missing', path);
        if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
        const model = splitText(src);
        let cursor = 0;
        for (const chunk of chunks) {
          if (chunk.anchor !== null) {
            const at = findAnchor(model.lines, chunk.anchor, strict, cursor);
            if (at < 0) throw new Fail('no-match', path);
            cursor = at + 1;
          }
          const O = chunk.items.filter((it) => it.kind !== 'add').map((it) => it.text);
          if (O.length > 0) {
            const f = findO(model.lines, O, strict, cursor, chunk.eof);
            if (f === null) throw new Fail('no-match', path);
            const pos = f.at[0]!;
            const seg = buildSeg(chunk.items, model.lines, pos, f.tier, O);
            model.lines.splice(pos, O.length, ...seg);
            cursor = pos + seg.length;
          } else {
            const adds = chunk.items.filter((it) => it.kind === 'add').map((it) => it.text);
            const at = chunk.eof ? model.lines.length : cursor;
            model.lines.splice(at, 0, ...adds);
            cursor = at + adds.length;
          }
        }
        const text = joinText(model);
        if (moveTo !== null) {
          tree.now.set(path, null);
          tree.now.set(moveTo, text);
          tree.moves.push([path, moveTo]);
        } else {
          tree.now.set(path, text);
        }
      });
    }
  }
  return edits;
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
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; text: string }[] = [];
  const movedFrom = new Set<string>();
  const movedTo = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && tree.now.get(o) === null && tree.original(n) === null && tree.now.get(n) !== null) {
      rows.push({ key: n, text: `R ${o} -> ${n}` });
      movedFrom.add(o);
      movedTo.add(n);
    }
  }
  for (const p of tree.now.keys()) {
    if (movedFrom.has(p) || movedTo.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
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
