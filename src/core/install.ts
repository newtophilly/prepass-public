/**
 * `prepass init` — register the hook without anyone hand-editing JSON.
 *
 * The pitch is "nothing to configure", and then the install instructions asked
 * you to paste four lines into a settings file. That is configuration, and it
 * is the risky kind: those files already hold other people's hooks and, in
 * Claude Code's case, a permission allowlist that would be painful to lose.
 *
 * So this merges rather than writes. It reads what is there, adds one entry if
 * it is missing, and leaves everything else untouched. Running it twice does
 * nothing the second time.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Which agent a registration targets. Both share the hook contract. */
export type Agent = 'claude' | 'codex';

export interface InstallTarget {
  readonly agent: Agent;
  /** Settings file, relative to the project root. */
  readonly file: string;
  readonly label: string;
}

export const TARGETS: readonly InstallTarget[] = [
  { agent: 'claude', file: '.claude/settings.json', label: 'Claude Code' },
  { agent: 'codex', file: '.codex/hooks.json', label: 'Codex CLI' },
];

/**
 * Where each agent looks for skills.
 *
 * Both read the same `SKILL.md` format, which is why one file serves both.
 * Installed per-project rather than globally so prepass never turns itself on
 * in a repository you did not ask it to.
 */
const SKILL_TARGETS: readonly { agent: Agent; file: string; label: string }[] = [
  { agent: 'claude', file: '.claude/skills/prepass/SKILL.md', label: 'Claude Code' },
  { agent: 'codex', file: '.codex/skills/prepass/SKILL.md', label: 'Codex CLI + desktop' },
];

export type SkillOutcome = 'installed' | 'already-present' | 'source-missing';

/**
 * Install the skill, which is the more portable half of this.
 *
 * A hook is the better mechanism where it exists: it fires before the agent can
 * decide anything, so the shortlist always arrives ahead of the search. But it
 * does not exist everywhere — the Codex desktop app reads hook config and even
 * records trust for it, then never runs it, and `codex exec` never emits the
 * prompt event at all.
 *
 * A skill reaches those surfaces. It is *pull* — the agent reads the
 * description and chooses — which sounds weaker and in practice was not: given
 * a symptom-shaped question in a large repository, Codex desktop reached for it
 * unprompted and used the result as a starting point rather than an answer,
 * which is exactly the intended behaviour.
 *
 * So: hook where supported, skill everywhere, both from one command.
 */
/**
 * The lowest common denominator: a few lines in the project's instructions file.
 *
 * prepass never speaks to a model, so the model is irrelevant to it — it is a
 * local program that ranks files. What varies is the *harness*: whether it can
 * run a shell command, and how you tell it to. Hooks and skills are the
 * structured answers, and they only exist in some products. Nearly every agent
 * reads an instructions file, so writing three lines there reaches Cursor,
 * Cline, Windsurf, Zed, Aider, Gemini CLI and anything else that can shell out.
 *
 * Appended, never overwritten: these files are hand-written project context and
 * clobbering one to install a convenience would be indefensible.
 */
export function installInstructions(rootDir: string, files = ['AGENTS.md', 'CLAUDE.md']):
  { file: string; outcome: 'appended' | 'already-present' | 'skipped-absent' }[] {
  const marker = '<!-- prepass -->';
  const block = [
    marker,
    '## Finding files',
    '',
    'Before searching this repository by hand, run:',
    '',
    '```bash',
    'prepass prompt "<the request, verbatim>"',
    '```',
    '',
    'It ranks the files most likely to be relevant in about 100ms, locally. Read the ones it',
    'names. They are ranked guesses, not an answer — if the top few do not fit, search normally.',
    marker,
    '',
  ].join('\n');

  return files.map((file) => {
    const path = join(rootDir, file);
    // Only add to a file the project already keeps; creating one uninvited puts
    // instructions in front of every future request without being asked.
    if (!existsSync(path)) return { file, outcome: 'skipped-absent' as const };
    const current = readFileSync(path, 'utf8');
    if (current.includes(marker)) return { file, outcome: 'already-present' as const };
    writeFileSync(path, current.trimEnd() + '\n\n' + block);
    return { file, outcome: 'appended' as const };
  });
}

export function installSkill(
  rootDir: string,
  only: readonly Agent[] = [],
): { label: string; outcome: SkillOutcome; path: string }[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = resolve(here, '..', '..', 'skills', 'prepass', 'SKILL.md');
  const wanted = only.length > 0 ? SKILL_TARGETS.filter((t) => only.includes(t.agent)) : SKILL_TARGETS;
  return wanted.map(({ file, label }) => {
    const path = join(rootDir, file);
    if (!existsSync(source)) return { label, outcome: 'source-missing' as const, path };
    if (existsSync(path)) return { label, outcome: 'already-present' as const, path };
    mkdirSync(dirname(path), { recursive: true });
    copyFileSync(source, path);
    return { label, outcome: 'installed' as const, path };
  });
}

export type InstallOutcome = 'added' | 'already-present' | 'unparsable';

export interface InstallResult {
  readonly target: InstallTarget;
  readonly outcome: InstallOutcome;
  readonly path: string;
  /** Set when the file could not be parsed and was therefore left alone. */
  readonly error?: string;
}

interface HookEntry {
  hooks?: { type?: string; command?: string }[];
  [k: string]: unknown;
}

/** Does this settings object already run us on prompt submit? */
function alreadyRegistered(settings: Record<string, unknown>, command: string): boolean {
  const hooks = settings.hooks as Record<string, unknown> | undefined;
  const list = hooks?.UserPromptSubmit;
  if (!Array.isArray(list)) return false;
  return list.some((entry: HookEntry) =>
    (entry?.hooks ?? []).some((h) => typeof h?.command === 'string' && h.command.includes(command)),
  );
}

/**
 * Add the hook to one settings file, preserving everything already in it.
 *
 * A file we cannot parse is reported rather than replaced — someone's
 * hand-written config with a trailing comma is still their config, and
 * overwriting it to install a convenience is a poor trade.
 */
export function registerIn(
  rootDir: string,
  target: InstallTarget,
  command = 'prepass hook',
): InstallResult {
  const path = join(rootDir, target.file);

  let settings: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        settings = parsed as Record<string, unknown>;
      }
    } catch (err) {
      return { target, path, outcome: 'unparsable', error: String(err) };
    }
  }

  if (alreadyRegistered(settings, 'prepass hook')) {
    return { target, path, outcome: 'already-present' };
  }

  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  const existing = Array.isArray(hooks.UserPromptSubmit) ? hooks.UserPromptSubmit : [];
  settings.hooks = {
    ...hooks,
    UserPromptSubmit: [...existing, { hooks: [{ type: 'command', command }] }],
  };

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
  return { target, path, outcome: 'added' };
}

/**
 * Whether this project is one prepass will actually help.
 *
 * Worth saying at install time rather than leaving someone to wonder why
 * nothing happens: below the threshold the hook deliberately stands aside,
 * because on a repo small enough to read there is no search to save and the
 * payload is measured overhead.
 */
export function sizeAdvice(candidates: number, minFiles: number): string | null {
  if (candidates >= minFiles) return null;
  return (
    `This project has ${candidates} candidate files, under the ${minFiles}-file threshold, ` +
    `so prepass will stand aside here and say so. That is deliberate: on a repo an agent can ` +
    `simply read, a shortlist is measured overhead (+27% on a 51-file project). Register it on ` +
    `something larger, or set curation.minFiles in .prepass.json to override.`
  );
}
