import { test } from "node:test";
import assert from "node:assert/strict";
import { SUPPORTED_CURRENCIES, isSupported } from "../src/currencies.mjs";

test("USD is supported", () => assert.equal(isSupported("USD"), true));
test("CAD is supported", () => assert.equal(isSupported("CAD"), true));
test("XXX is not supported", () => assert.equal(isSupported("XXX"), false));
test("list has exactly 5 currencies", () => assert.equal(SUPPORTED_CURRENCIES.length, 5));
