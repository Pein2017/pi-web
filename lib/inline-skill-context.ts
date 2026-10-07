import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionFactory, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  isInlineSkillContextSnapshot,
  type InlineSkillContextSnapshot,
  type InlineSkillSnapshot,
} from "./inline-skill-expansion";

export const INLINE_SKILL_CONTEXT_CUSTOM_TYPE = "pi-web:inline-skill-context";

function getInlineSkillContext(message: AgentMessage): InlineSkillContextSnapshot | undefined {
  if (message.role !== "user") return undefined;
  const webMetadata = (message as AgentMessage & { piWeb?: { inlineSkillContext?: unknown } }).piWeb;
  return isInlineSkillContextSnapshot(webMetadata?.inlineSkillContext)
    ? webMetadata.inlineSkillContext
    : undefined;
}

function stripPiWebMetadata(message: AgentMessage): AgentMessage {
  const providerMessage = { ...message } as AgentMessage & { piWeb?: unknown };
  delete providerMessage.piWeb;
  return providerMessage;
}

function renderSkill(snapshot: InlineSkillSnapshot): string {
  return `<skill name="${snapshot.name}" location="${snapshot.filePath}">\nReferences are relative to ${snapshot.baseDir}.\n\n${snapshot.body}\n</skill>`;
}

function createContextMessage(skill: InlineSkillSnapshot, timestamp: number): AgentMessage {
  return {
    role: "custom",
    customType: INLINE_SKILL_CONTEXT_CUSTOM_TYPE,
    content: renderSkill(skill),
    display: false,
    timestamp,
  } as AgentMessage;
}

function projectMessages(messages: readonly AgentMessage[]): AgentMessage[] {
  const projected: AgentMessage[] = [];
  for (const message of messages) {
    const context = getInlineSkillContext(message);
    projected.push(stripPiWebMetadata(message));
    if (!context) continue;
    for (const skill of context.skills) {
      projected.push(createContextMessage(skill, message.timestamp));
    }
  }
  return projected;
}

function projectMessagesInPlace(messages: AgentMessage[]): void {
  const projected = projectMessages(messages);
  messages.splice(0, messages.length, ...projected);
}

function projectTreeEntriesInPlace(entries: SessionEntry[]): void {
  const projected: SessionEntry[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") {
      projected.push({ ...entry } as SessionEntry);
      continue;
    }

    const message = entry.message;
    const context = getInlineSkillContext(message);
    projected.push({ ...entry, message: stripPiWebMetadata(message) } as SessionEntry);
    if (!context) continue;

    for (let index = 0; index < context.skills.length; index += 1) {
      const skill = context.skills[index];
      projected.push({
        type: "custom_message",
        id: `pi-web-inline-skill:${context.requestId}:${index}`,
        parentId: entry.id,
        timestamp: entry.timestamp,
        customType: INLINE_SKILL_CONTEXT_CUSTOM_TYPE,
        content: renderSkill(skill),
        display: false,
      });
    }
  }
  entries.splice(0, entries.length, ...projected);
}

const inlineSkillContextExtensionFactory: ExtensionFactory = (pi) => {
  pi.on("context", (event) => ({ messages: projectMessages(event.messages) }));
  pi.on("session_before_compact", (event) => {
    projectMessagesInPlace(event.preparation.messagesToSummarize);
    projectMessagesInPlace(event.preparation.turnPrefixMessages);
  });
  pi.on("session_before_tree", (event) => {
    if (event.preparation.userWantsSummary) {
      projectTreeEntriesInPlace(event.preparation.entriesToSummarize);
    }
  });
};

export function createInlineSkillContextExtension() {
  return {
    name: "pi-web-inline-skill-context",
    factory: inlineSkillContextExtensionFactory,
  };
}
