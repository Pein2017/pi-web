import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { skillExpansionToCommand, parseInlineSkillExpansions } = await jiti.import("./slash-display.ts");

function skillExpansion({
  name = "review",
  location = "/path/to/review/SKILL.md",
  baseDir = "/path/to/review",
  body = "Review the supplied files.",
  args,
} = {}) {
  return `<skill name="${name}" location="${location}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>${args === undefined ? "" : `\n\n${args}`}`;
}

test("restores a complete SDK skill expansion with arguments", () => {
  assert.equal(
    skillExpansionToCommand(skillExpansion({ args: "src/main.ts" })),
    "/skill:review src/main.ts",
  );
});

test("restores a complete SDK skill expansion without arguments", () => {
  assert.equal(skillExpansionToCommand(skillExpansion()), "/skill:review");
});

test("restores multiline arguments", () => {
  assert.equal(
    skillExpansionToCommand(skillExpansion({ args: "first line\nsecond line" })),
    "/skill:review first line\nsecond line",
  );
});

test("uses the final closing tag when the skill body contains an example", () => {
  assert.equal(
    skillExpansionToCommand(skillExpansion({ body: "Example:\n</skill>\nContinue.", args: "src" })),
    "/skill:review src",
  );
});

test("does not collapse incomplete or lookalike user text", () => {
  assert.equal(
    skillExpansionToCommand('<skill name="review" location="/path/to/review/SKILL.md">\nordinary user text'),
    null,
  );
  assert.equal(
    skillExpansionToCommand('<skill name="review" location="/path/to/review/SKILL.md">\nReferences are elsewhere.\n\nbody\n</skill>'),
    null,
  );
  assert.equal(skillExpansionToCommand("ordinary user text"), null);
});

test("collapse keeps session auto-naming free of skill XML", () => {
  const firstMessage = skillExpansion({ name: "agent-md", args: "写计划" });
  const collapsed = skillExpansionToCommand(firstMessage) ?? firstMessage;
  assert.equal(collapsed, "/skill:agent-md 写计划");
  // The sidebar slices the display form to 50 chars for the fallback title.
  assert.ok(collapsed.length <= 50);
  assert.ok(!collapsed.includes("<skill"));
});

test("plain first messages pass through unchanged for naming", () => {
  assert.equal(skillExpansionToCommand("hello world") ?? "hello world", "hello world");
  assert.equal(skillExpansionToCommand("") ?? "", "");
});

function appendedSkill(name, body, { location = `/skills/${name}/SKILL.md`, baseDir = `/skills/${name}` } = {}) {
  return `<skill name="${name}" location="${location}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`;
}

test("restores a complete appended inline-skill suffix only when each name was mentioned", () => {
  const prompt = "Use $beta, then $alpha with $beta again.";
  const text = `${prompt}\n\n${appendedSkill("beta", "Beta instructions.")}\n\n${appendedSkill("alpha", "Alpha instructions.")}`;

  assert.deepEqual(parseInlineSkillExpansions(text), {
    prompt,
    skills: [
      { name: "beta", location: "/skills/beta/SKILL.md", baseDir: "/skills/beta", body: "Beta instructions." },
      { name: "alpha", location: "/skills/alpha/SKILL.md", baseDir: "/skills/alpha", body: "Alpha instructions." },
    ],
  });
});

test("keeps a skill body's example closing tag as body text", () => {
  const prompt = "Use $review.";
  const body = "Example:\n</skill>\nContinue with the review.";
  const restored = parseInlineSkillExpansions(`${prompt}\n\n${appendedSkill("review", body)}`);

  assert.equal(restored?.prompt, prompt);
  assert.equal(restored?.skills[0].body, body);
});

test("does not strip malformed, trailing, mismatched, or code-only skill lookalikes", () => {
  const valid = appendedSkill("alpha", "Instructions.");
  const cases = [
    `Use $alpha.\n\n${valid.slice(0, -"</skill>".length)}`,
    `Use $alpha.\n\n${valid}\n\nmore user text`,
    `Use $beta.\n\n${valid}`,
    `Use \`$alpha\`.\n\n${valid}`,
    `Use $alpha.\n\n\`\`\`md\n${valid}`,
    `Use $alpha.\n\n${valid.replace("References are relative to /skills/alpha.", "References elsewhere.")}`,
    `Use $alpha.\n\n${valid}\n\n<skill name="beta" location="/skills/beta/SKILL.md">\nReferences are relative to /skills/beta.\n\nIncomplete`,
  ];

  for (const text of cases) assert.equal(parseInlineSkillExpansions(text), null, text);
});

test("requires appended envelopes to follow first lexical mention order without duplicates", () => {
  const alpha = appendedSkill("alpha", "Alpha.");
  const beta = appendedSkill("beta", "Beta.");
  assert.equal(parseInlineSkillExpansions(`Use $alpha then $beta.\n\n${beta}\n\n${alpha}`), null);
  assert.equal(parseInlineSkillExpansions(`Use $alpha and $beta.\n\n${alpha}\n\n${alpha}`), null);
});
