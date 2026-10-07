import { scanSkillMentions } from "./skill-mentions";

/** Display-only restoration for the exact envelope emitted by pi's `_expandSkillCommand`. */
const SKILL_EXPANSION_RE = /^<skill name="([^"\n]+)" location="([^"\n]+)">\nReferences are relative to [^\n]+\.\n\n([\s\S]*)\n<\/skill>(?:\n\n([\s\S]+))?$/;
const INLINE_SKILL_MARKER = "\n\n<skill name=\"";
const INLINE_SKILL_CLOSE = "\n</skill>";
const MAX_INLINE_SKILL_EXPANSIONS = 16;
const MAX_INLINE_SKILL_MARKERS_TO_INSPECT = 64;

export interface ParsedInlineSkillExpansion {
  name: string;
  location: string;
  baseDir: string;
  body: string;
}

export interface ParsedInlineSkillExpansions {
  prompt: string;
  skills: ParsedInlineSkillExpansion[];
}

interface SkillExpansionHeader {
  skill: ParsedInlineSkillExpansion;
  bodyStart: number;
  mentionIndex: number;
}

const INLINE_SKILL_HEADER_RE = /<skill name="([^"\n]+)" location="([^"\n]+)">\nReferences are relative to ([^\n]+)\.\n\n/y;

function isMarkdownTextOffset(text: string, offset: number): boolean {
  const probe = "$pi-web-skill-probe";
  const withProbe = `${text.slice(0, offset)}${probe} ${text.slice(offset)}`;
  return scanSkillMentions(withProbe).some(
    (mention) => mention.start === offset && mention.name === probe.slice(1),
  );
}

function readInlineSkillHeader(
  text: string,
  offset: number,
  mentionOrder: readonly string[],
  previousMentionIndex: number,
): SkillExpansionHeader | null {
  if (!isMarkdownTextOffset(text, offset)) return null;

  INLINE_SKILL_HEADER_RE.lastIndex = offset;
  const match = INLINE_SKILL_HEADER_RE.exec(text);
  if (!match) return null;

  const [, name, location, baseDir] = match;
  const mentionIndex = mentionOrder.indexOf(name);
  if (mentionIndex <= previousMentionIndex) return null;

  return {
    skill: { name, location, baseDir, body: "" },
    bodyStart: INLINE_SKILL_HEADER_RE.lastIndex,
    mentionIndex,
  };
}

function parseInlineSkillSuffix(
  text: string,
  headerOffset: number,
  mentionOrder: readonly string[],
  previousMentionIndex: number,
  depth: number,
): ParsedInlineSkillExpansion[][] {
  if (depth >= MAX_INLINE_SKILL_EXPANSIONS) return [];
  const header = readInlineSkillHeader(text, headerOffset, mentionOrder, previousMentionIndex);
  if (!header) return [];

  const splitPaths: ParsedInlineSkillExpansion[][] = [];
  let finalPath: ParsedInlineSkillExpansion[] | null = null;
  let sawFollowingEnvelopeMarker = false;
  for (
    let closeOffset = text.indexOf(INLINE_SKILL_CLOSE, header.bodyStart);
    closeOffset !== -1;
    closeOffset = text.indexOf(INLINE_SKILL_CLOSE, closeOffset + 1)
  ) {
    const afterClose = closeOffset + INLINE_SKILL_CLOSE.length;
    const skill = { ...header.skill, body: text.slice(header.bodyStart, closeOffset) };

    if (afterClose === text.length) {
      finalPath = [skill];
    } else if (text.startsWith(INLINE_SKILL_MARKER, afterClose)) {
      sawFollowingEnvelopeMarker = true;
      const suffixes = parseInlineSkillSuffix(
        text,
        afterClose + 2,
        mentionOrder,
        header.mentionIndex,
        depth + 1,
      );
      for (const suffix of suffixes) splitPaths.push([skill, ...suffix]);
      if (splitPaths.length > 1) return [];
    }
  }

  if (splitPaths.length > 0) return splitPaths;
  if (sawFollowingEnvelopeMarker) return [];
  return finalPath ? [finalPath] : [];
}

/**
 * Restore only a complete suffix of Web's official inline-skill envelopes.
 * Every block must match a lexical mention in the original prompt and follow
 * first-mention order. Ambiguous body examples, malformed wrappers and anything
 * other than one contiguous final suffix are left untouched.
 */
export function parseInlineSkillExpansions(text: string): ParsedInlineSkillExpansions | null {
  const candidates: ParsedInlineSkillExpansions[] = [];
  let markerOffset = text.indexOf(INLINE_SKILL_MARKER);
  let inspected = 0;

  while (markerOffset !== -1) {
    inspected += 1;
    if (inspected > MAX_INLINE_SKILL_MARKERS_TO_INSPECT) return null;

    const prompt = text.slice(0, markerOffset);
    if (prompt.endsWith(INLINE_SKILL_CLOSE)) {
      markerOffset = text.indexOf(INLINE_SKILL_MARKER, markerOffset + INLINE_SKILL_MARKER.length);
      continue;
    }

    const mentionOrder = [...new Set(scanSkillMentions(prompt).map(({ name }) => name))];
    if (mentionOrder.length > 0) {
      const paths = parseInlineSkillSuffix(text, markerOffset + 2, mentionOrder, -1, 0);
      for (const skills of paths) candidates.push({ prompt, skills });
      if (candidates.length > 1) return null;
    }

    markerOffset = text.indexOf(INLINE_SKILL_MARKER, markerOffset + INLINE_SKILL_MARKER.length);
  }

  return candidates.length === 1 ? candidates[0] : null;
}

/** Restore a complete SDK skill expansion to its compact command form. */
export function skillExpansionToCommand(text: string): string | null {
  const match = text.match(SKILL_EXPANSION_RE);
  if (!match) return null;

  const [, name, , , args] = match;
  return args ? `/skill:${name} ${args}` : `/skill:${name}`;
}
