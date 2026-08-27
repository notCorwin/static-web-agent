import assert from "node:assert/strict";
import test from "node:test";
import { decodeTranscript, encodeTranscript } from "../dist/app/chat.js";

test("transcript round-trips messages and attachments through JSON", () => {
  const messages = [
    { role: "system", content: "You are helpful." },
    { role: "user", content: "Read this.", attachmentIds: ["a-1"] },
    { role: "assistant", content: "", reasoning: "hmm", toolCalls: [{ id: "c1", name: "demo.echo", arguments: { value: 1 } }] },
    { role: "tool", callId: "c1", name: "demo.echo", content: "{}", isError: true },
    { role: "assistant", content: "Done." },
  ];
  const data = new Uint8Array([0, 1, 2, 250, 255]);
  const encoded = encodeTranscript(messages, [{ id: "a-1", name: "f.bin", mediaType: "application/octet-stream", data }]);
  // The record must survive the StateStore's JSON-only constraint.
  const json = JSON.parse(JSON.stringify(encoded));
  const decoded = decodeTranscript(json);
  assert.ok(decoded);
  assert.deepEqual(decoded.messages, messages);
  assert.equal(decoded.attachments.length, 1);
  assert.deepEqual(Buffer.from(decoded.attachments[0].data), Buffer.from(data));
});

test("empty transcripts are not stored; corrupt input never crashes restore", () => {
  assert.equal(encodeTranscript([], []), undefined);
  assert.equal(decodeTranscript(undefined), undefined);
  assert.equal(decodeTranscript("junk"), undefined);
  assert.equal(decodeTranscript({ attachments: [] }), undefined);
  const partial = decodeTranscript({
    messages: [
      { role: "user", content: "keep" },
      { role: "nope" },
      { role: "assistant", content: 42 },
      { role: "assistant", content: "valid but attachments garbage follows" },
    ],
    attachments: [{ id: "x", name: "n", mediaType: "text/plain", dataBase64: "!!!not base64!!!" }],
  });
  assert.ok(partial);
  assert.deepEqual(partial.messages.map((message) => message.content), ["keep", "valid but attachments garbage follows"]);
  assert.deepEqual(partial.attachments, []);
});
