import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" } });
const { buildObservedDecodeTpsPresentation } = await jiti.import("../lib/session-decode-tps-presentation.ts");
const { SessionDecodeTpsSection } = await jiti.import("./SessionDecodeTpsSection.tsx");
const { enLocale } = await jiti.import("../lib/i18n/messages/en.ts");
const { zhCNLocale } = await jiti.import("../lib/i18n/messages/zh-CN.ts");
const { zhTWLocale } = await jiti.import("../lib/i18n/messages/zh-TW.ts");
const productionSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const demoSource = await readFile(new URL("../demo/components/AppShell.tsx", import.meta.url), "utf8");

const messages = {
  "session.decodeTps": "Observed decode TPS",
  "session.decodeTpsCoverage": "Measured / tracked responses",
  "session.decodeTpsUnavailable": "Unavailable",
  "session.decodeTpsBreakdown": "Provider/model breakdown",
};
const translate = (key) => messages[key] ?? key;

function group(provider, modelId, tps, measuredResponses, trackedResponses = measuredResponses) {
  return {
    provider,
    modelId,
    tps,
    outputTokens: 100,
    elapsedMs: tps === null ? 0 : 100_000 / tps,
    measuredResponses,
    trackedResponses,
  };
}

test("builds observed TPS and coverage rows for a measurable single-model session", () => {
  const view = buildObservedDecodeTpsPresentation({
    tps: 50,
    outputTokens: 100,
    elapsedMs: 2000,
    measuredResponses: 1,
    trackedResponses: 1,
    groups: [group("openai", "gpt-test", 50, 1)],
  }, "en", translate);

  assert.deepEqual(view.rows, [
    { label: "Observed decode TPS", value: "50.0 t/s" },
    { label: "Measured / tracked responses", value: "1 / 1" },
  ]);
});

test("shows the session ratio and separate provider/model rows for mixed-model sessions", () => {
  const view = buildObservedDecodeTpsPresentation({
    tps: 60,
    outputTokens: 300,
    elapsedMs: 5000,
    measuredResponses: 2,
    trackedResponses: 3,
    groups: [
      group("openai", "gpt-fast", 50, 1),
      group("anthropic", "claude-fast", 70, 1, 2),
    ],
  }, "en", translate);

  assert.deepEqual(view.rows, [
    { label: "Observed decode TPS", value: "60.0 t/s" },
    { label: "Measured / tracked responses", value: "2 / 3" },
    { label: "Provider/model breakdown", value: "anthropic/claude-fast: 70.0 t/s · openai/gpt-fast: 50.0 t/s" },
  ]);
});

test("shows unavailable instead of zero when telemetry is absent or all responses are excluded", () => {
  const absent = buildObservedDecodeTpsPresentation(undefined, "en", translate);
  assert.deepEqual(absent.rows, [
    { label: "Observed decode TPS", value: "Unavailable" },
    { label: "Measured / tracked responses", value: "0 / 0" },
  ]);

  const excluded = buildObservedDecodeTpsPresentation({
    tps: null,
    outputTokens: 0,
    elapsedMs: 0,
    measuredResponses: 0,
    trackedResponses: 2,
    groups: [group("openai", "gpt-test", null, 0, 2)],
  }, "en", translate);
  assert.deepEqual(excluded.rows, [
    { label: "Observed decode TPS", value: "Unavailable" },
    { label: "Measured / tracked responses", value: "0 / 2" },
  ]);
});

test("renders measurable, mixed-model, and unavailable values in the session-details component", () => {
  const render = (summary) => renderToStaticMarkup(createElement(SessionDecodeTpsSection, {
    summary,
    locale: "en",
    translate,
  }));

  const measurable = render({
    tps: 50,
    outputTokens: 100,
    elapsedMs: 2000,
    measuredResponses: 1,
    trackedResponses: 1,
    groups: [group("openai", "gpt-test", 50, 1)],
  });
  assert.match(measurable, /Observed decode TPS/);
  assert.match(measurable, /50\.0 t\/s/);
  assert.match(measurable, /1 \/ 1/);
  assert.doesNotMatch(measurable, /Host-observed response interval/);

  const mixed = render({
    tps: 60,
    outputTokens: 300,
    elapsedMs: 5000,
    measuredResponses: 2,
    trackedResponses: 3,
    groups: [group("openai", "gpt-fast", 50, 1), group("anthropic", "claude-fast", 70, 1, 2)],
  });
  assert.match(mixed, /anthropic\/claude-fast: 70\.0 t\/s/);
  assert.match(mixed, /openai\/gpt-fast: 50\.0 t\/s/);

  const unavailable = render(undefined);
  assert.match(unavailable, /Unavailable/);
  assert.match(unavailable, /0 \/ 0/);
  assert.doesNotMatch(unavailable, /0\.0 t\/s/);
});

test("wires the same observed TPS component into production and demo session details", () => {
  for (const source of [productionSource, demoSource]) {
    assert.match(source, /<SessionDecodeTpsSection\s+summary=\{sessionStats\.observedDecodeTps\}/);
    assert.match(source, /locale=\{locale\}/);
    assert.match(source, /translate=\{translate\}/);
  }
});

test("provides localized labels for observed TPS", () => {
  const requiredKeys = [
    "session.decodeTpsSection",
    "session.decodeTps",
    "session.decodeTpsCoverage",
    "session.decodeTpsUnavailable",
    "session.decodeTpsBreakdown",
  ];
  for (const locale of [enLocale, zhCNLocale, zhTWLocale]) {
    for (const key of requiredKeys) {
      assert.ok(locale.messages[key]?.length > 0, `${locale.id} is missing ${key}`);
    }
  }
});
