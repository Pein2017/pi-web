import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const {
  MAX_INLINE_SKILL_BYTES,
  MAX_INLINE_SKILL_COUNT,
  MAX_INLINE_SKILL_TOTAL_BYTES,
  expandInlineSkillMentions,
} = await jiti.import("./inline-skill-expansion.ts");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-web-inline-skill-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    skill(name, body, { baseDir = root, disabled = false } = {}) {
      const skillDir = join(root, "skills", name);
      mkdirSync(skillDir, { recursive: true });
      const filePath = join(skillDir, "SKILL.md");
      writeFileSync(filePath, `---\nname: ${name}\ndescription: ${name} description\n---\n${body}\n`);
      return { name, description: `${name} description`, filePath, baseDir, sourceInfo: {}, disableModelInvocation: disabled };
    },
  };
}

function count(text, needle) {
  return text.split(needle).length - 1;
}

test("appends each real skill wrapper once in first-appearance order and preserves the request", (t) => {
  const f = fixture(t);
  const alpha = f.skill("alpha", "ALPHA_BODY", { baseDir: join(f.root, "alpha-base"), disabled: true });
  const beta = f.skill("beta", "BETA_BODY");
  const request = "Use $beta, then $alpha and $beta again.";
  const expanded = expandInlineSkillMentions(request, [alpha, beta]);

  assert.ok(expanded.startsWith(`${request}\n\n`));
  assert.ok(expanded.indexOf('<skill name="beta"') < expanded.indexOf('<skill name="alpha"'));
  assert.equal(count(expanded, '<skill name="alpha"'), 1);
  assert.equal(count(expanded, '<skill name="beta"'), 1);
  assert.ok(expanded.includes(`location="${beta.filePath}"`));
  assert.ok(expanded.includes(`References are relative to ${alpha.baseDir}.`));
  assert.ok(expanded.includes("ALPHA_BODY"));
  assert.ok(expanded.includes("BETA_BODY"));
  assert.ok(!expanded.includes("description: alpha description"), "frontmatter is removed");
});

test("explicit-only loaded skills are eligible and generated body text is not rescanned", (t) => {
  const f = fixture(t);
  const alpha = f.skill("alpha", "ALPHA_BODY refers to $beta.", { disabled: true });
  const beta = f.skill("beta", "BETA_BODY");
  const expanded = expandInlineSkillMentions("Use $alpha.", [alpha, beta]);

  assert.equal(count(expanded, '<skill name="alpha"'), 1);
  assert.equal(count(expanded, '<skill name="beta"'), 0);
  assert.ok(expanded.includes("ALPHA_BODY refers to $beta."));
  assert.ok(!expanded.includes("BETA_BODY"));
});

test("unknown references remain literal and are not read", () => {
  assert.equal(expandInlineSkillMentions("Keep $missing literal.", []), "Keep $missing literal.");
});

test("checks distinct-skill and byte budgets before returning any expansion", (t) => {
  const f = fixture(t);
  assert.equal(MAX_INLINE_SKILL_COUNT, 16);
  assert.equal(MAX_INLINE_SKILL_BYTES, 128 * 1024);
  assert.equal(MAX_INLINE_SKILL_TOTAL_BYTES, 1024 * 1024);

  const tooMany = Array.from({ length: MAX_INLINE_SKILL_COUNT + 1 }, (_, index) => ` $skill-${index}`).join("");
  const absent = Array.from({ length: MAX_INLINE_SKILL_COUNT + 1 }, (_, index) => ({
    name: `skill-${index}`,
    filePath: join(f.root, `missing-${index}.md`),
    baseDir: f.root,
    disableModelInvocation: false,
  }));
  assert.throws(() => expandInlineSkillMentions(tooMany, absent), /at most 16 distinct skills/i);

  const large = f.skill("large", "x".repeat(MAX_INLINE_SKILL_BYTES + 1));
  assert.throws(() => expandInlineSkillMentions("Use $large", [large]), /128 KiB|131072/i);
});

test("refuses an aggregate above 1 MiB rather than truncating later skill bodies", (t) => {
  const f = fixture(t);
  const skills = Array.from({ length: 9 }, (_, index) => f.skill(`total-${index}`, "x".repeat(120 * 1024)));
  const request = skills.map((skill) => `$${skill.name}`).join(" ");
  assert.throws(() => expandInlineSkillMentions(request, skills), /1 MiB|1048576/i);
});

test("recognized unreadable, non-regular, and invalid UTF-8 skills fail atomically", (t) => {
  const f = fixture(t);
  const good = f.skill("good", "GOOD_BODY");
  const missing = { name: "missing", filePath: join(f.root, "missing.md"), baseDir: f.root, disableModelInvocation: false };
  assert.throws(() => expandInlineSkillMentions("$good then $missing", [good, missing]), /could not be read|not found/i);

  const directory = join(f.root, "not-a-file");
  mkdirSync(directory);
  const nonRegular = { name: "directory", filePath: directory, baseDir: f.root, disableModelInvocation: false };
  assert.throws(() => expandInlineSkillMentions("$good then $directory", [good, nonRegular]), /regular file/i);

  const invalidUtf8 = join(f.root, "invalid-utf8.md");
  writeFileSync(invalidUtf8, Buffer.from([0xc3, 0x28]));
  const invalid = { name: "invalid", filePath: invalidUtf8, baseDir: f.root, disableModelInvocation: false };
  assert.throws(() => expandInlineSkillMentions("$good then $invalid", [good, invalid]), /UTF-8/i);
});

test("does nothing when no loaded skill name matches a lexical mention", (t) => {
  const f = fixture(t);
  const alpha = f.skill("alpha", "ALPHA_BODY");
  assert.equal(expandInlineSkillMentions("$unknown and $alpha_bad", [alpha]), "$unknown and $alpha_bad");
});
