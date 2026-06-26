import { test } from "node:test";
import assert from "node:assert/strict";

import { interpolate, loadTemplate } from "../core/prompts.mjs";

test("interpolate fills known {{PLACEHOLDERS}} and blanks unknown ones", () => {
  const tpl = "A={{ALPHA}} B={{BETA}} C={{GAMMA}}";
  const out = interpolate(tpl, { ALPHA: "1", BETA: "two" });
  assert.equal(out, "A=1 B=two C=");
});

test("interpolate leaves non-placeholder braces alone", () => {
  assert.equal(interpolate("{ x } {{Y}}", { Y: "y" }), "{ x } y");
});

test("loadTemplate reads a real template from prompts/", () => {
  const tpl = loadTemplate("adversarial-review");
  assert.match(tpl, /\{\{REVIEW_INPUT\}\}/);
  assert.match(tpl, /\{\{OUTPUT_CONTRACT\}\}/);
});
