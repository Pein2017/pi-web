export interface SkillMention {
  name: string;
  /** Start of `$name`, inclusive, in JavaScript string (UTF-16) offsets. */
  start: number;
  /** End of the full token, exclusive, in JavaScript string (UTF-16) offsets. */
  end: number;
}

export interface ActiveSkillMention {
  /** The token prefix from after `$` through the caret. */
  query: string;
  /** Start of `$`, inclusive. */
  start: number;
  /** End of the whole token, including any suffix after the caret, exclusive. */
  end: number;
}

const MAX_SKILL_NAME_LENGTH = 64;
const CODE = 1;
const TOKEN_CHARACTER = /^[A-Za-z0-9_.-]$/;
const EMBEDDED_CHARACTER = /^[\p{L}\p{N}_./\\:@-]$/u;
const SKILL_NAME = /^(?=[a-z0-9-]{1,64}$)(?=.*[a-z])[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKILL_NAME_PREFIX = /^[a-z0-9-]*$/;

function isTokenCharacter(character: string | undefined): boolean {
  return character !== undefined && TOKEN_CHARACTER.test(character);
}

function isEmbeddedCharacter(character: string | undefined): boolean {
  return character !== undefined && EMBEDDED_CHARACTER.test(character);
}

function hasOddEscape(text: string, dollar: number): boolean {
  let slashes = 0;
  for (let index = dollar - 1; index >= 0 && text[index] === "\\"; index -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function isTrailingBoundary(text: string, end: number): boolean {
  const character = text[end];
  if (character !== ".") return !isEmbeddedCharacter(character);

  // A sentence-ending period/ellipsis is punctuation, while `.suffix` and
  // `./path` mean the dollar token is embedded in a filename/path.
  let afterDots = end;
  while (text[afterDots] === ".") afterDots += 1;
  const next = text[afterDots];
  return !/[A-Za-z0-9_]/.test(next ?? "") && next !== "/" && next !== "\\" && next !== ":" && next !== "@";
}

function isDollarBoundary(text: string, dollar: number, end: number): boolean {
  if (text[dollar - 1] === "$" || text[dollar + 1] === "$") return false;
  if (hasOddEscape(text, dollar)) return false;
  return !isEmbeddedCharacter(text[dollar - 1]) && isTrailingBoundary(text, end);
}

/** Strip the repeated blockquote markers that contain a fenced block. */
function stripBlockquotePrefixes(line: string): { content: string; depth: number } {
  let content = line;
  let depth = 0;
  for (;;) {
    const prefix = /^ {0,3}>[ \t]?/.exec(content);
    if (!prefix) break;
    content = content.slice(prefix[0].length);
    depth += 1;
  }
  return { content, depth };
}

function getFenceOpeningContent(line: string): { content: string; quoteDepth: number; listIndent: number } {
  const quote = stripBlockquotePrefixes(line);
  const listPrefix = /^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+/.exec(quote.content);
  return listPrefix
    ? { content: quote.content.slice(listPrefix[0].length), quoteDepth: quote.depth, listIndent: listPrefix[0].length }
    : { content: quote.content, quoteDepth: quote.depth, listIndent: 0 };
}

function stripFenceContainers(line: string, quoteDepth: number, listIndent: number): string | null {
  let content = line;
  for (let depth = 0; depth < quoteDepth; depth += 1) {
    const prefix = /^ {0,3}>[ \t]?/.exec(content);
    if (!prefix) return null;
    content = content.slice(prefix[0].length);
  }
  if (listIndent > 0) {
    const indentation = /^ */.exec(content)?.[0].length ?? 0;
    if (indentation < listIndent) return null;
    content = content.slice(listIndent);
  }
  return content;
}

/** Mark fenced and inline Markdown code without using lookbehind (Safari 16.2 client-safe). */
function markMarkdownCode(text: string): Uint8Array {
  const mask = new Uint8Array(text.length);
  let fenceCharacter: "`" | "~" | undefined;
  let fenceLength = 0;
  let fenceQuoteDepth = 0;
  let fenceListIndent = 0;

  for (let lineStart = 0; lineStart < text.length;) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    const contentEnd = lineEnd > lineStart && text[lineEnd - 1] === "\r" ? lineEnd - 1 : lineEnd;
    const line = text.slice(lineStart, contentEnd);
    const opening = getFenceOpeningContent(line);
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(opening.content);
    let markFenceLine = false;

    if (fenceCharacter) {
      markFenceLine = true;
      const closingContent = stripFenceContainers(line, fenceQuoteDepth, fenceListIndent);
      const closing = closingContent === null ? null : /^ {0,3}(`+|~+)[ \t]*$/.exec(closingContent);
      if (
        closing
        && closing[1][0] === fenceCharacter
        && closing[1].length >= fenceLength
      ) {
        fenceCharacter = undefined;
        fenceLength = 0;
        fenceQuoteDepth = 0;
        fenceListIndent = 0;
      }
    } else if (
      marker
      && !(marker[1][0] === "`" && marker[2].includes("`"))
    ) {
      fenceCharacter = marker[1][0] as "`" | "~";
      fenceLength = marker[1].length;
      fenceQuoteDepth = opening.quoteDepth;
      fenceListIndent = opening.listIndent;
      markFenceLine = true;
    }

    if (markFenceLine) mask.fill(CODE, lineStart, newline === -1 ? text.length : newline + 1);
    if (newline === -1) break;
    lineStart = newline + 1;
  }

  // Pair equal-length backtick runs. Runs inside a matched span are content,
  // not openers that may pair with text later in the message.
  const openRuns = new Map<number, number>();
  for (let index = 0; index < text.length;) {
    if (mask[index] === CODE || text[index] !== "`") {
      index += 1;
      continue;
    }

    const start = index;
    while (index < text.length && mask[index] !== CODE && text[index] === "`") index += 1;
    const length = index - start;
    const opening = openRuns.get(length);
    if (opening === undefined) {
      openRuns.set(length, start);
      continue;
    }

    mask.fill(CODE, opening, index);
    for (const [runLength, runStart] of openRuns) {
      if (runStart >= opening && runStart < index) openRuns.delete(runLength);
    }
  }

  return mask;
}

function tokenEnd(text: string, dollar: number): number {
  let end = dollar + 1;
  while (isTokenCharacter(text[end])) {
    if (text[end] === ".") {
      let afterDots = end;
      while (text[afterDots] === ".") afterDots += 1;
      if (!/[A-Za-z0-9_]/.test(text[afterDots] ?? "")) break;
      end = afterDots;
      continue;
    }
    end += 1;
  }
  return end;
}

function isValidSkillName(name: string): boolean {
  return name.length <= MAX_SKILL_NAME_LENGTH && SKILL_NAME.test(name);
}

function isValidSkillNamePrefix(name: string): boolean {
  return name.length <= MAX_SKILL_NAME_LENGTH
    && SKILL_NAME_PREFIX.test(name)
    && !name.startsWith("-")
    && !name.includes("--");
}

/**
 * Find complete inline skill references in ordinary text. Only lexical matches
 * are returned; callers must still resolve each name against the active session.
 */
export function scanSkillMentions(text: string): SkillMention[] {
  const codeMask = markMarkdownCode(text);
  const mentions: SkillMention[] = [];

  for (let dollar = 0; dollar < text.length; dollar += 1) {
    if (text[dollar] !== "$" || codeMask[dollar] === CODE) continue;
    const end = tokenEnd(text, dollar);
    const name = text.slice(dollar + 1, end);
    if (!isValidSkillName(name) || !isDollarBoundary(text, dollar, end)) continue;

    mentions.push({ name, start: dollar, end });
    dollar = end - 1;
  }

  return mentions;
}

/**
 * Find the skill token at the caret, returning its prefix query and full token
 * range so a completion can replace just that token without losing its suffix.
 */
export function getActiveSkillMention(text: string, cursor: number): ActiveSkillMention | null {
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > text.length) return null;

  let dollar = cursor - 1;
  while (dollar >= 0 && isTokenCharacter(text[dollar])) dollar -= 1;
  if (text[dollar] !== "$" || text[dollar] === undefined) return null;

  const end = tokenEnd(text, dollar);
  const fullName = text.slice(dollar + 1, end);
  const query = text.slice(dollar + 1, cursor);
  if (!isDollarBoundary(text, dollar, end)) return null;
  if (!isValidSkillNamePrefix(fullName) || !isValidSkillNamePrefix(query)) return null;
  if (fullName.length > 0 && !/[a-z]/.test(fullName)) return null;

  const codeMask = markMarkdownCode(text);
  if (codeMask[dollar] === CODE) return null;

  return { query, start: dollar, end };
}
