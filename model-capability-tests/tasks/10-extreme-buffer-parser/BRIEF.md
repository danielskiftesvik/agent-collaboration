Implement `CsvStreamParser` in `src/csv-parser.mjs` to satisfy its specifications and pass all tests in `test/csv-parser.test.mjs`. Currently, it throws "not implemented".

### Requirements:
1. **Streaming Input:** The parser consumes data incrementally via `push(chunk)`, where `chunk` is a `Uint8Array`.
2. **Event Emitting:** Register a row handler callback via `onRow(callback)`. Every time a complete CSV row is parsed, the callback must be called with an array of strings representing the row's fields.
3. **CSV Parsing Rules:**
   - Fields are separated by commas.
   - Rows are separated by newlines (`\n` or `\r\n`).
   - Fields enclosed in double quotes (`"`) can contain commas, newlines, or escaped double quotes (represented by a pair of double quotes `""`).
4. **Boundary Robustness:** Double quote escapes (`""`), newlines (`\r\n`), or multi-byte UTF-8 character boundaries can be split across arbitrary buffer boundaries. The parser must store the incomplete state and reconstruct them properly when the next chunk arrives.
5. **Flush:** When input terminates, `flush()` must be called to process any remaining uncommitted buffered data and emit the final row.

Do not edit the test file.

Then run: node --test test/csv-parser.test.mjs
Expected: all tests pass.

When finished, return ONLY a JSON object:
{"status":"completed" | "failed" | "blocked","summary":"<one line>","changed":true | false}
