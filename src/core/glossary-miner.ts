/**
 * Mine glossary candidates out of the codebase's own comments.
 *
 * The vocabulary gap — you say *"arriving"*, CoreLocation says `didEnterRegion`
 * — cannot be closed by ranking, because the word simply is not in the file.
 * But it is usually written down *somewhere*, by whoever explained the code to
 * the next reader:
 *
 *     /// A saved location for geofence notifications (arrive/depart).
 *
 * One line, both vocabularies. That is a dictionary entry someone already
 * wrote; it just was not in a form anything could use.
 *
 * **Mining is line-local on purpose.** Co-occurrence across a whole file is
 * noise: in one iOS app, six Swift files contain "arriv" and only one has anything to
 * do with geofencing — the rest are TV views, widgets and chat models. Pairing
 * words that share a *line* is precise; pairing words that share a *file*
 * invents relationships. That distinction is the difference between a glossary
 * that helps and one that drifts.
 *
 * Nothing here writes to the glossary. It proposes, with the evidence line
 * attached, and a human accepts.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Glossary } from '../glossary.js';

export interface Proposal {
  /** The human-vocabulary word, lowercased. */
  readonly term: string;
  /** Code-side identifiers seen on the same line as `term`. */
  readonly expands: string[];
  /** `file:line` this came from, so a human can check it. */
  readonly evidence: string;
  /** How many distinct lines supported this pairing. */
  readonly seen: number;
  /**
   * Pointwise mutual information — how much more often this pairing occurs
   * than chance predicts. A common symbol beside a common word scores near
   * zero; a surprising, meaningful association scores high.
   */
  readonly strength: number;
}

/**
 * Comment markers, in the order they must be tried. Deliberately not a parser:
 * a doc comment is where humans explain themselves in every language, and a
 * regex over comment lines is both language-agnostic and cheap.
 */
const COMMENT = /^\s*(?:\/\/\/?|\/\*+|\*|#|--|;;)\s*(.+)$/;

/** camelCase / PascalCase identifiers — the shape of a code symbol. */
const SYMBOL = /\b[a-z]+(?:[A-Z][a-z0-9]*)+\b|\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b/g;

/** Plain lowercase words — the shape of human vocabulary. */
const WORD = /\b[a-z][a-z-]{3,}\b/g;

/**
 * Words that co-occur with everything and therefore mean nothing as a bridge.
 * Kept deliberately short: over-filtering here silently discards real domain
 * vocabulary, and a bad proposal is cheap because a human sees it before it
 * lands.
 */
const NOISE = new Set([
  'this', 'that', 'with', 'from', 'when', 'then', 'than', 'they', 'them', 'their',
  'these', 'those', 'here', 'there', 'have', 'will', 'would', 'should', 'could',
  'been', 'being', 'into', 'onto', 'only', 'also', 'just', 'like', 'make', 'made',
  'need', 'want', 'used', 'using', 'note', 'todo', 'fixme', 'returns', 'return',
  'param', 'params', 'value', 'values', 'true', 'false', 'null', 'nil', 'else',
  'code', 'file', 'files', 'line', 'lines', 'call', 'calls', 'called', 'name',
  'names', 'type', 'types', 'case', 'cases', 'does', 'done', 'same', 'each',
  'both', 'more', 'most', 'some', 'must', 'above', 'below', 'because', 'which',
  'what', 'where', 'while', 'after', 'before', 'first', 'last', 'once', 'still',
]);

export interface MineOptions {
  /** Minimum distinct lines supporting a pairing before it is proposed. */
  readonly minSeen?: number;
  /** Cap on proposals returned, strongest association first. */
  readonly limit?: number;
  /** Cap on files read. Mining is a manual command, not the hot path. */
  readonly maxFiles?: number;
}

/** A declaration keyword followed by the name it introduces. */
const DECLARATION =
  /\b(?:func|class|struct|enum|protocol|extension|interface|type|def|fn|function|const|let|var|public|private|internal|static)\s+([A-Za-z_][A-Za-z0-9_]*)/;

/**
 * Scan the repo's comments and propose `word -> symbols` bridges.
 *
 * Two things separate a useful proposal from noise:
 *
 * **Doc comments are paired with what they document.** The best bridge in a
 * codebase usually looks like `/// A saved location for geofence notifications
 * (arrive/depart).` sitting directly above `struct SavedPlace`. The human words
 * and the symbol are on *different lines*, so pairing within a line alone finds
 * nothing at all — which is exactly what the first attempt did.
 *
 * **Association is scored, not counted.** Raw co-occurrence just resurfaces
 * whichever symbol is most common: a first pass on a real repo proposed
 * `every -> CloudKit`, `push -> CloudKit` and `record -> CloudKit`, because
 * CloudKit appears in hundreds of comments and co-occurs with everything. This
 * uses pointwise mutual information, which asks whether a pairing happens more
 * often than chance predicts — the same lesson as ranking by rarity instead of
 * by hit count.
 */
export function mineGlossary(
  rootDir: string,
  existing: Glossary = {},
  options: MineOptions = {},
): Proposal[] {
  const minSeen = options.minSeen ?? 2;
  const limit = options.limit ?? 40;

  const pairCount = new Map<string, { count: number; evidence: string }>();
  const wordCount = new Map<string, number>();
  const symbolCount = new Map<string, number>();
  let observations = 0;

  for (const obs of observationsIn(rootDir, options.maxFiles ?? 1500)) {
    observations++;
    for (const w of obs.words) wordCount.set(w, (wordCount.get(w) ?? 0) + 1);
    for (const sym of obs.symbols) symbolCount.set(sym, (symbolCount.get(sym) ?? 0) + 1);
    for (const w of obs.words) {
      for (const sym of obs.symbols) {
        const key = w + '\u0000' + sym;
        const cell = pairCount.get(key);
        if (cell) cell.count += 1;
        else pairCount.set(key, { count: 1, evidence: obs.file + ':' + obs.line });
      }
    }
  }
  if (observations === 0) return [];

  const byWord = new Map<string, { symbol: string; pmi: number; count: number; evidence: string }[]>();
  for (const [key, cell] of pairCount) {
    if (cell.count < minSeen) continue;
    const sep = key.indexOf('\u0000');
    const word = key.slice(0, sep);
    const symbol = key.slice(sep + 1);
    const pw = (wordCount.get(word) ?? 1) / observations;
    const ps = (symbolCount.get(symbol) ?? 1) / observations;
    const pws = cell.count / observations;
    const pmi = Math.log(pws / (pw * ps));
    if (pmi <= 0) continue; // no better than chance
    const row = byWord.get(word) ?? [];
    row.push({ symbol, pmi, count: cell.count, evidence: cell.evidence });
    byWord.set(word, row);
  }

  const proposals: Proposal[] = [];
  for (const [term, row] of byWord) {
    if (existing[term] && !existing[term].disabled) continue; // never override a human
    const strong = row.sort((a, b) => b.pmi - a.pmi).slice(0, 4);
    const best = strong[0];
    if (!best) continue;
    proposals.push({
      term,
      expands: strong.map((r) => r.symbol),
      evidence: best.evidence,
      seen: best.count,
      strength: Number(best.pmi.toFixed(2)),
    });
  }

  return proposals.sort((a, b) => b.strength - a.strength).slice(0, limit);
}

interface Observation {
  readonly file: string;
  readonly line: number;
  readonly words: string[];
  readonly symbols: string[];
}

/**
 * Walk each file's comments, attaching every doc comment to the declaration it
 * sits above as well as to any symbols named inside it.
 */
function* observationsIn(rootDir: string, maxFiles: number): Generator<Observation> {
  for (const rel of sourceFiles(rootDir).slice(0, maxFiles)) {
    let text: string;
    try {
      text = readFileSync(join(rootDir, rel), 'utf8');
    } catch {
      continue;
    }
    if (text.length > 600_000) continue;
    const lines = text.split('\n');

    let block: { words: Set<string>; line: number } | null = null;
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i] ?? '';
      const comment = COMMENT.exec(raw);

      if (comment && comment[1]) {
        const body = comment[1];
        const words = collectWords(body);
        const inline = [...new Set(body.match(SYMBOL) ?? [])];
        if (words.length > 0 && inline.length > 0 && words.length <= 8 && inline.length <= 6) {
          yield { file: rel, line: i + 1, words, symbols: inline };
        }
        if (!block) block = { words: new Set(words), line: i + 1 };
        else for (const w of words) block.words.add(w);
        continue;
      }

      // First non-comment line after a comment block: if it declares something,
      // the block was describing it. The highest-value pairing available.
      if (block) {
        const m = DECLARATION.exec(raw);
        if (m && m[1] && block.words.size > 0 && block.words.size <= 24) {
          yield { file: rel, line: block.line, words: [...block.words], symbols: [m[1]] };
        }
        block = null;
      }
    }
  }
}

function collectWords(text: string): string[] {
  const symbols = text.match(SYMBOL) ?? [];
  return [...new Set(text.toLowerCase().match(WORD) ?? [])].filter(
    (w) => !NOISE.has(w) && !symbols.some((s) => s.toLowerCase().includes(w)),
  );
}

/** Every text file ripgrep is willing to show us, honouring .gitignore. */
function sourceFiles(rootDir: string): string[] {
  try {
    const out = execFileSync('rg', ['--files', '--no-messages'], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 32 * 1024 * 1024,
      timeout: 15_000,
    });
    return out.split('\n').filter(Boolean).map((p) => p.replace(/^\.\//, ''));
  } catch {
    return [];
  }
}

/**
 * A prompt asking Claude to turn mined pairings into glossary entries.
 *
 * The hook already runs inside a Claude Code session, so the cheapest available
 * language model is the one the user is already talking to. Emitting a prompt
 * for them to paste — rather than calling an API — keeps the tool keyless,
 * which is its most valuable property.
 */
export function buildLearnPrompt(proposals: readonly Proposal[], rootDir: string): string {
  const rows = proposals
    .map((p) => `- "${p.term}" appears beside ${p.expands.join(', ')} (${p.evidence}, ${p.seen}x)`)
    .join('\n');
  return [
    `I'm building a glossary that maps the words I use when describing a problem`,
    `to the identifiers this codebase actually uses, so a keyword search can find`,
    `the right files. Project root: ${rootDir}`,
    ``,
    `These word/symbol pairings were mined from comment lines in the code:`,
    ``,
    rows,
    ``,
    `Please reply with ONLY a JSON object suitable for .prepass/glossary.json.`,
    `Keep a pairing only where the plain word is genuinely how a person would`,
    `describe what that identifier does — drop coincidences. Add obvious missing`,
    `synonyms from the framework's own vocabulary where you are confident.`,
    `Shape: { "word": { "expands": ["Symbol", "other"], "source": "observed" } }`,
  ].join('\n');
}
