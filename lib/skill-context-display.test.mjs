import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { getSkillContextDisplay } = await jiti.import("./skill-context-display.ts");

const envelope = (name, body) => `<skill name="${name}" location="/skills/${name}/SKILL.md">\nReferences are relative to /skills/${name}.\n\n${body}\n</skill>`;

test("keeps raw short prompts unchanged and does not invent loaded-skill metadata", () => {
  const text = "Use $alpha in this request.";
  assert.deepEqual(getSkillContextDisplay(text), {
    prompt: text,
    skills: [],
    source: "raw",
  });
});

test("decodes a typed snapshot without replacing raw short user content", () => {
  const prompt = "Use $beta then $alpha.";
  const metadata = {
    version: 1,
    requestId: "request-123",
    skills: [
      { name: "beta", filePath: "/skills/beta/SKILL.md", baseDir: "/skills/beta", body: "Beta snapshot." },
      { name: "alpha", filePath: "/skills/alpha/SKILL.md", baseDir: "/skills/alpha", body: "Alpha snapshot." },
    ],
  };

  assert.deepEqual(getSkillContextDisplay(prompt, metadata), {
    prompt,
    skills: [
      { name: "beta", location: "/skills/beta/SKILL.md", baseDir: "/skills/beta", body: "Beta snapshot." },
      { name: "alpha", location: "/skills/alpha/SKILL.md", baseDir: "/skills/alpha", body: "Alpha snapshot." },
    ],
    source: "metadata",
  });
});

test("rejects invalid metadata and falls back to raw text without inventing references", () => {
  const prompt = "Use $alpha and $beta.";
  const validSkill = { name: "alpha", filePath: "/skills/alpha/SKILL.md", baseDir: "/skills/alpha", body: "Alpha." };
  const invalidSnapshots = [
    { version: 2, requestId: "request-1", skills: [validSkill] },
    { version: 1, requestId: "", skills: [validSkill] },
    { version: 1, requestId: "request-1", skills: [{ ...validSkill, body: 7 }] },
    { version: 1, requestId: "request-1", skills: [{ ...validSkill, name: "missing" }] },
    { version: 1, requestId: "request-1", skills: [
      { ...validSkill, name: "beta" },
      { ...validSkill, name: "alpha" },
    ] },
  ];

  for (const metadata of invalidSnapshots) {
    assert.deepEqual(getSkillContextDisplay(prompt, metadata), {
      prompt,
      skills: [],
      source: "raw",
    });
  }
});

test("exposes bodies only from validated legacy appended skill context", () => {
  const prompt = "Review this with $review.";
  const body = "Full instructions.";
  assert.deepEqual(getSkillContextDisplay(`${prompt}\n\n${envelope("review", body)}`), {
    prompt,
    skills: [{
      name: "review",
      location: "/skills/review/SKILL.md",
      baseDir: "/skills/review",
      body,
    }],
    source: "legacy-appended",
  });
});

test("leaves malformed or unmentioned skill-looking text in the raw prompt", () => {
  const text = `Ordinary text.\n\n${envelope("review", "Full instructions.")}`;
  assert.deepEqual(getSkillContextDisplay(text), {
    prompt: text,
    skills: [],
    source: "raw",
  });
});
