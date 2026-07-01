Create a new file src/lru-cache.mjs implementing a small LRU (Least Recently Used) cache as a class named `LRUCache`, exported as a named export.

Requirements:
- `new LRUCache(capacity)` — capacity is a positive integer; throws Error("capacity must be positive") if capacity <= 0.
- `.get(key)` — returns the value for key if present (marking it as most-recently-used), or `undefined` if absent.
- `.set(key, value)` — inserts or updates a key's value (marking it as most-recently-used). If inserting a NEW key would exceed capacity, evict the LEAST-recently-used key first.
- `.has(key)` — returns true/false without affecting recency order.
- `.size` — a getter returning the current number of entries.

Do not use any external dependencies — only built-in JS (e.g. Map is fine). Do not change the test file.

Then run: node --test test/lru-cache.test.mjs
Expected: all 8 tests pass.

When finished, return ONLY a JSON object and NOTHING else — no prose before or after it, no markdown code fence. Match this exact shape:
{"status":"completed" | "failed" | "blocked","summary":"<one line>","changed":true | false}
