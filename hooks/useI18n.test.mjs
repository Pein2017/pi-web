import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider, useI18n } = await jiti.import("./useI18n.tsx");

function Notice() {
  const { locale, t, supportedLocales } = useI18n();
  return React.createElement("p", {
    lang: locale,
    "data-locales": supportedLocales.map((plugin) => plugin.id).join(","),
  }, t("i18n.branchesLockedWhileRunning"));
}

function render(initialLocale) {
  return renderToStaticMarkup(React.createElement(
    I18nProvider,
    initialLocale === undefined ? null : { initialLocale },
    React.createElement(Notice),
  ));
}

test("production first render defaults to Simplified Chinese", () => {
  const html = render();
  assert.match(html, /lang="zh-CN"/);
  assert.match(html, />会话运行中，暂时无法切换分支<\/p>/);
  assert.match(html, /data-locales="en,zh-CN,zh-TW"/);
});

test("English fixtures explicitly select English without changing the production default", () => {
  const html = render("en");
  assert.match(html, /lang="en"/);
  assert.match(html, />Branches can&#x27;t be switched while the session is running<\/p>/);
  assert.match(render(), /lang="zh-CN"/);
});

test("an explicit Traditional Chinese first render keeps locale and translation aligned", () => {
  const html = render("zh-TW");
  assert.match(html, /lang="zh-TW"/);
  assert.match(html, />工作階段執行中，暫時無法切換分支<\/p>/);
});
