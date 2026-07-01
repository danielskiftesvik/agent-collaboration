Add "CAD" to the `SUPPORTED_CURRENCIES` array in src/currencies.mjs. Do not change anything else in the file.

Then run: node --test test/currencies.test.mjs
Expected: all 4 tests pass.

When finished, return ONLY a JSON object and NOTHING else — no prose before or after it, no markdown code fence. Match this exact shape:
{"status":"completed" | "failed" | "blocked","summary":"<one line>","changed":true | false}
