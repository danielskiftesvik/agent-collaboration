import { test } from "node:test";
import assert from "node:assert/strict";
import { CsvStreamParser } from "../src/csv-parser.mjs";

const encoder = new TextEncoder();

test("parses basic CSV rows", () => {
  const parser = new CsvStreamParser();
  const rows = [];
  parser.onRow((row) => rows.push(row));

  parser.push(encoder.encode("a,b,c\nd,e,f\n"));
  parser.flush();

  assert.deepEqual(rows, [
    ["a", "b", "c"],
    ["d", "e", "f"]
  ]);
});

test("handles quoted fields containing commas and newlines", () => {
  const parser = new CsvStreamParser();
  const rows = [];
  parser.onRow((row) => rows.push(row));

  parser.push(encoder.encode('a,"b,c\nnext",d\n'));
  parser.flush();

  assert.deepEqual(rows, [
    ["a", "b,c\nnext", "d"]
  ]);
});

test("handles escaped quotes in quoted fields", () => {
  const parser = new CsvStreamParser();
  const rows = [];
  parser.onRow((row) => rows.push(row));

  parser.push(encoder.encode('a,"b""c",d\n'));
  parser.flush();

  assert.deepEqual(rows, [
    ["a", 'b"c', "d"]
  ]);
});

test("handles split boundaries correctly (newline, quotes, characters)", () => {
  const parser = new CsvStreamParser();
  const rows = [];
  parser.onRow((row) => rows.push(row));

  // Chunk 1 splits \r\n: ends on \r
  parser.push(encoder.encode("a,b,c\r"));
  // Chunk 2 starts with \n
  parser.push(encoder.encode("\nd,e,\"f"));
  // Chunk 3 splits the double quote escape sequence: ends on first " of ""
  parser.push(encoder.encode('""'));
  // Chunk 4 has the second " of "", followed by rest of field and newline
  parser.push(encoder.encode('g"\n'));
  
  // Chunk 5 splits a multi-byte UTF-8 character (emoji: ⚡ - 3 bytes: 0xE2 0x9A 0xA1)
  const emojiBytes = encoder.encode("⚡");
  const chunk5 = new Uint8Array([104, 44, emojiBytes[0]]); // 'h,' followed by byte 1
  const chunk6 = new Uint8Array([emojiBytes[1], emojiBytes[2], 10]); // byte 2, byte 3, followed by \n
  
  parser.push(chunk5);
  parser.push(chunk6);
  parser.flush();

  assert.deepEqual(rows, [
    ["a", "b", "c"],
    ["d", "e", 'f"g'],
    ["h", "⚡"]
  ]);
});

test("flushes trailing row without final newline", () => {
  const parser = new CsvStreamParser();
  const rows = [];
  parser.onRow((row) => rows.push(row));

  parser.push(encoder.encode("a,b,c"));
  parser.flush();

  assert.deepEqual(rows, [
    ["a", "b", "c"]
  ]);
});
