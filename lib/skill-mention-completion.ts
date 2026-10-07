import { scanSkillMentions, type ActiveSkillMention } from "./skill-mentions";

/** The client-safe fields used from the session's existing slash-command catalog. */
export interface SkillSlashCommand {
  name: string;
  source: string;
  description?: string;
  sourceInfo?: { path?: string };
}

export interface SkillMentionSuggestion {
  /** UI-only identity for catalog entries; never inserted into the message. */
  identity: string;
  /** The name portion of `skill:<name>`, which is the only inserted value. */
  name: string;
  description: string;
}

export function getSkillMentionSuggestions(
  commands: readonly SkillSlashCommand[],
  query: string,
): SkillMentionSuggestion[] {
  const suggestions: SkillMentionSuggestion[] = [];
  for (const command of commands) {
    if (command.source !== "skill" || !command.name.startsWith("skill:")) continue;
    const name = command.name.slice("skill:".length);
    if (!name || !name.startsWith(query)) continue;
    const parsedName = scanSkillMentions(`$${name}`);
    if (parsedName.length !== 1 || parsedName[0].name !== name) continue;
    suggestions.push({
      identity: command.sourceInfo?.path ?? command.name,
      name,
      description: command.description ?? "",
    });
  }
  return suggestions;
}

/** Keep loaded dollar references out of Markdown's paired inline-math syntax.
 * Only presentation changes: raw session text, copying and editing stay intact.
 */
export function preserveSkillReferencesInMarkdown(text: string, skillNames: readonly string[] = []): string {
  const names = new Set([
    ...[...text.matchAll(/<skill name="([a-z0-9-]+)" location="/g)].map(match => match[1]),
    ...skillNames,
  ]);
  if (names.size === 0) return text;
  let rendered = text;
  for (const mention of scanSkillMentions(text).reverse()) {
    if (names.has(mention.name)) rendered = rendered.slice(0, mention.start) + "\\" + rendered.slice(mention.start);
  }
  return rendered;
}

export function completeSkillMention(
  text: string,
  mention: ActiveSkillMention,
  skillName: string,
): { value: string; cursor: number } {
  const insertion = `$${skillName}`;
  return {
    value: text.slice(0, mention.start) + insertion + text.slice(mention.end),
    cursor: mention.start + insertion.length,
  };
}
