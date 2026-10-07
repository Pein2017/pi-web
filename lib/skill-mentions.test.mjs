import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { scanSkillMentions, getActiveSkillMention } = await jiti.import("./skill-mentions.ts");

const mentionRows = (text) => scanSkillMentions(text).map(({ name, start, end }) => ({
  name,
  token: text.slice(start, end),
  start,
  end,
}));

test("scans multiple loaded-name-shaped mentions in source order with JS offsets", () => {
  const text = "Use $beta, $alpha and $beta.";
  assert.deepEqual(mentionRows(text), [
    { name: "beta", token: "$beta", start: 4, end: 9 },
    { name: "alpha", token: "$alpha", start: 11, end: 17 },
    { name: "beta", token: "$beta", start: 22, end: 27 },
  ]);
});

test("accepts SDK-compatible numeric-leading names with a letter, but not numeric currency", () => {
  const text = "$20 costs $3d-tools and $2024a; $123 is currency.";
  assert.deepEqual(scanSkillMentions(text).map(({ name }) => name), ["3d-tools", "2024a"]);
});

test("leaves escaped and doubled dollars literal", () => {
  const text = String.raw`\$alpha $$beta $$$gamma $delta`;
  assert.deepEqual(scanSkillMentions(text).map(({ name }) => name), ["delta"]);
});

test("leaves inline code spans and fenced code blocks literal", () => {
  const text = [
    "Inline `$alpha` then $beta.",
    "~~~ts",
    "const x = `$gamma` and $delta;",
    "~~~",
    "Outside $epsilon.",
  ].join("\n");
  assert.deepEqual(scanSkillMentions(text).map(({ name }) => name), ["beta", "epsilon"]);
});

test("recognizes list- and quote-contained fences without hiding outside mentions or caret completion", () => {
  const text = [
    "- ```sh",
    "  echo $alpha",
    "  ```",
    "> ```ts",
    "> const value = $gamma",
    "> ```",
    "Use $beta",
  ].join("\n");

  assert.deepEqual(scanSkillMentions(text).map(({ name }) => name), ["beta"]);
  assert.equal(getActiveSkillMention(text, text.indexOf("$alpha") + "$alpha".length), null);
  assert.equal(getActiveSkillMention(text, text.indexOf("$gamma") + "$gamma".length), null);
  const betaStart = text.indexOf("$beta");
  assert.deepEqual(getActiveSkillMention(text, betaStart + "$beta".length), {
    query: "beta",
    start: betaStart,
    end: betaStart + "$beta".length,
  });
});

test("does not parse mentions embedded in identifiers, paths, or email-like text", () => {
  const text = "word$alpha dir/$beta C:\\tmp\\$gamma user@$delta /tmp/$epsilon or $zeta";
  assert.deepEqual(scanSkillMentions(text).map(({ name }) => name), ["zeta"]);
});

test("rejects invalid complete tokens instead of resolving a valid prefix", () => {
  const text = "$alpha_bad $alpha.foo $alpha--beta $alpha- $Alpha $" + "a".repeat(65) + " $valid";
  assert.deepEqual(scanSkillMentions(text).map(({ name }) => name), ["valid"]);
});

test("caret lookup returns prefix query and full token bounds when the caret is mid-token", () => {
  const text = "Start $al|pha after";
  const cursor = text.indexOf("|");
  const source = text.replace("|", "");
  const expectedStart = source.indexOf("$alpha");
  assert.deepEqual(getActiveSkillMention(source, cursor), {
    query: "al",
    start: expectedStart,
    end: expectedStart + "$alpha".length,
  });
});

test("allows empty-dollar completion only at an active, non-numeric skill position", () => {
  assert.deepEqual(getActiveSkillMention("Use $ here", 5), { query: "", start: 4, end: 5 });
  assert.equal(getActiveSkillMention("$20", 1), null);
  assert.equal(getActiveSkillMention("$20", 3), null);
  assert.deepEqual(getActiveSkillMention("$3d-tools", 2), { query: "3", start: 0, end: 9 });
});

test("caret lookup rejects code, escaped, embedded, and invalid full tokens", () => {
  const cases = [
    ["`$alpha`", 3],
    [String.raw`\$alpha`, 3],
    ["word$alpha", 7],
    ["dir/$alpha", 7],
    ["$alpha_bad", 6],
    ["$alpha--beta", 6],
  ];
  for (const [text, cursor] of cases) {
    assert.equal(getActiveSkillMention(text, cursor), null, `${JSON.stringify(text)} at ${cursor}`);
  }
});

test("caret completion does not interpret a dollar embedded in a fenced block", () => {
  const text = "```\n$alpha\n```";
  assert.equal(getActiveSkillMention(text, text.indexOf("$alpha") + 3), null);
});
