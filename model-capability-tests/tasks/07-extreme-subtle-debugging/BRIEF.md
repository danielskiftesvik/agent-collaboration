There is a bug in src/remove-in-place.mjs. It is not obviously wrong from reading it once — trace through what actually happens to the array indices when an element is removed mid-loop before concluding it's correct. Find the bug and fix it. Do not change the function's signature, and keep the fix to this one function (no rewriting it into a completely different approach if a small, targeted fix suffices — though a full rewrite that's correct is also acceptable).

Then run: node --test test/remove-in-place.test.mjs
Expected: all 5 tests pass (currently 2 fail).

When finished, return ONLY a JSON object and NOTHING else — no prose before or after it, no markdown code fence. Match this exact shape:
{"status":"completed" | "failed" | "blocked","summary":"<one line>","changed":true | false}
