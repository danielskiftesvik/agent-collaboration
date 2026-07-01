There is a bug in src/clamp.mjs. Find it and fix it. Do not change the function's signature or add new functions.

Then run: node --test test/clamp.test.mjs
Expected: all 4 tests pass (currently 1 fails).

When finished, return ONLY a JSON object and NOTHING else — no prose before or after it, no markdown code fence. Match this exact shape:
{"status":"completed" | "failed" | "blocked","summary":"<one line>","changed":true | false}
