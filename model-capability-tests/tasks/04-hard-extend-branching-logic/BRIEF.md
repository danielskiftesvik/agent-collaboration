Add a new "bulk" tier to shippingTier in src/shipping.mjs: non-express orders with weight > 20 should return "bulk" instead of "large". Every existing tier's behavior (including express orders of any weight, which must still return "express") must be unchanged.

Then run: node --test test/shipping.test.mjs
Expected: all 6 tests pass (1 is new, for the bulk tier — the other 5 already pass and must keep passing).

When finished, return ONLY a JSON object and NOTHING else — no prose before or after it, no markdown code fence. Match this exact shape:
{"status":"completed" | "failed" | "blocked","summary":"<one line>","changed":true | false}
