import { parseInlineSkillExpansions, type ParsedInlineSkillExpansion } from "./slash-display";
import { scanSkillMentions } from "./skill-mentions";

const MAX_INLINE_SKILL_COUNT = 16;

export interface SkillContextDisplay {
  /** Text originally submitted by the user, before any legacy envelope suffix. */
  prompt: string;
  /** Validated inline-skill references from message metadata or legacy history. */
  skills: ParsedInlineSkillExpansion[];
  source: "raw" | "metadata" | "legacy-appended";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeInlineSkillContext(
  text: string,
  value: unknown,
): ParsedInlineSkillExpansion[] | null {
  if (!isRecord(value)
    || value.version !== 1
    || typeof value.requestId !== "string"
    || !value.requestId.trim()
    || !Array.isArray(value.skills)
    || value.skills.length > MAX_INLINE_SKILL_COUNT) {
    return null;
  }

  const mentionOrder = [...new Set(scanSkillMentions(text).map(({ name }) => name))];
  const skills: ParsedInlineSkillExpansion[] = [];
  let previousMentionIndex = -1;

  for (const valueSkill of value.skills) {
    if (!isRecord(valueSkill)
      || typeof valueSkill.name !== "string"
      || typeof valueSkill.filePath !== "string"
      || !valueSkill.filePath
      || typeof valueSkill.baseDir !== "string"
      || !valueSkill.baseDir
      || typeof valueSkill.body !== "string") {
      return null;
    }

    const mentionIndex = mentionOrder.indexOf(valueSkill.name);
    if (mentionIndex <= previousMentionIndex) return null;
    previousMentionIndex = mentionIndex;
    skills.push({
      name: valueSkill.name,
      location: valueSkill.filePath,
      baseDir: valueSkill.baseDir,
      body: valueSkill.body,
    });
  }

  return skills;
}

/**
 * Build the client display model without modifying stored session text or
 * loading any skill paths. Metadata is decoded read-only; legacy SDK envelopes
 * are restored only when their complete appended suffix validates.
 */
export function getSkillContextDisplay(text: string, metadata?: unknown): SkillContextDisplay {
  const snapshot = decodeInlineSkillContext(text, metadata);
  if (snapshot) return { prompt: text, skills: snapshot, source: "metadata" };

  const legacy = parseInlineSkillExpansions(text);
  return legacy
    ? { prompt: legacy.prompt, skills: legacy.skills, source: "legacy-appended" }
    : { prompt: text, skills: [], source: "raw" };
}
