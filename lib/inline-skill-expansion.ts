import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { stripFrontmatter } from "@earendil-works/pi-coding-agent";
import { scanSkillMentions } from "./skill-mentions";

export const MAX_INLINE_SKILL_COUNT = 16;
export const MAX_INLINE_SKILL_BYTES = 128 * 1024;
export const MAX_INLINE_SKILL_TOTAL_BYTES = 1024 * 1024;

/** The resource metadata provided by the active session's SDK skill catalog. */
export interface InlineSkillResource {
  name: string;
  filePath: string;
  baseDir: string;
  disableModelInvocation?: boolean;
}

/** Windows has no FIFOs, and does not define O_NONBLOCK. */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK || 0);

function readRegisteredSkill(
  skill: InlineSkillResource,
  maxBytes: number,
  aggregateLimited: boolean,
): { text: string; bytes: number } {
  let fd: number;
  try {
    fd = openSync(skill.filePath, OPEN_FLAGS);
  } catch {
    throw new Error(`Inline skill "$${skill.name}" could not be read (missing or inaccessible file).`);
  }

  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) {
      throw new Error(`Inline skill "$${skill.name}" could not be read (not a regular file).`);
    }
    if (stats.size > maxBytes) {
      throw new Error(aggregateLimited
        ? `Inline skill "$${skill.name}" exceeds the 1 MiB aggregate size limit.`
        : `Inline skill "$${skill.name}" exceeds the 128 KiB per-skill size limit.`);
    }

    // Read at most one byte past the applicable limit to refuse a file that grew
    // after fstat, rather than silently sending a partial skill body.
    const readLimit = maxBytes + 1;
    const chunks: Buffer[] = [];
    let length = 0;
    while (length < readLimit) {
      const chunk = Buffer.alloc(Math.min(readLimit - length, 64 * 1024));
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      chunks.push(chunk.subarray(0, read));
      length += read;
    }
    if (length > maxBytes) {
      throw new Error(aggregateLimited
        ? `Inline skill "$${skill.name}" exceeds the 1 MiB aggregate size limit.`
        : `Inline skill "$${skill.name}" exceeds the 128 KiB per-skill size limit.`);
    }

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, length));
    } catch {
      throw new Error(`Inline skill "$${skill.name}" is not valid UTF-8 text.`);
    }
    return { text, bytes: length };
  } finally {
    closeSync(fd);
  }
}

/**
 * Append real skill instructions selected by the original message's lexical
 * references. `skills` must be sampled from the active session loader for this
 * send. The function reads only those registered file paths and returns either
 * the whole request plus every selected wrapper, or throws before any result
 * can be submitted.
 *
 * Limits apply to the full SKILL.md files (including frontmatter), not just the
 * stripped body: 16 distinct resources, 128 KiB each and 1 MiB total.
 */
export function expandInlineSkillMentions(
  text: string,
  skills: readonly InlineSkillResource[],
): string {
  const mentions = scanSkillMentions(text);
  if (mentions.length === 0) return text;

  const catalog = new Map<string, InlineSkillResource>();
  for (const skill of skills) {
    if (!catalog.has(skill.name)) catalog.set(skill.name, skill);
  }

  const selected: InlineSkillResource[] = [];
  const selectedNames = new Set<string>();
  for (const mention of mentions) {
    const skill = catalog.get(mention.name);
    if (!skill || selectedNames.has(skill.name)) continue;
    selectedNames.add(skill.name);
    selected.push(skill);
  }
  if (selected.length === 0) return text;
  if (selected.length > MAX_INLINE_SKILL_COUNT) {
    throw new Error(`Inline skill expansion supports at most ${MAX_INLINE_SKILL_COUNT} distinct skills per message.`);
  }

  let totalBytes = 0;
  const blocks: string[] = [];
  for (const skill of selected) {
    if (typeof skill.filePath !== "string" || typeof skill.baseDir !== "string") {
      throw new Error(`Inline skill "$${skill.name}" has invalid registered resource metadata.`);
    }
    const remainingBytes = MAX_INLINE_SKILL_TOTAL_BYTES - totalBytes;
    const aggregateLimited = remainingBytes < MAX_INLINE_SKILL_BYTES;
    const maxBytes = Math.min(MAX_INLINE_SKILL_BYTES, remainingBytes);
    const loaded = readRegisteredSkill(skill, maxBytes, aggregateLimited);
    totalBytes += loaded.bytes;

    const body = stripFrontmatter(loaded.text).trim();
    // Match the official SDK's `/skill:name` wrapper and resource-base wording.
    blocks.push(
      `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`,
    );
  }

  return `${text}\n\n${blocks.join("\n\n")}`;
}
