import test from "node:test";
import assert from "node:assert/strict";
import { normalizeYouTubeUrl, classifyExtractorFailure, RATE_LIMIT_SECONDS } from "../extractorPolicy.js";

test("accepts normal watch links and normalized short and shorts links", () => {
  for (const url of [
    "https://youtube.com/watch?v=5mNwj616_Qc",
    "https://youtu.be/5mNwj616_Qc?t=10",
    "https://www.youtube.com/shorts/5mNwj616_Qc",
  ]) {
    assert.deepEqual(normalizeYouTubeUrl(url), {
      id: "5mNwj616_Qc", url: "https://www.youtube.com/watch?v=5mNwj616_Qc",
    });
  }
});

test("rejects arbitrary URLs, playlist-only URLs and malicious lookalike hosts", () => {
  for (const url of [
    "https://youtube.com.evil.org/watch?v=5mNwj616_Qc",
    "http://localhost:3000/secret?youtube.com/watch?v=5mNwj616_Qc",
    "file:///etc/passwd",
    "https://youtube.com/playlist?list=123",
    "https://youtube.com/watch?v=abc",
    123,
    null,
  ]) assert.equal(normalizeYouTubeUrl(url), null);
});

test("prioritizes upstream rate limits over later 403 errors", () => {
  const error = new Error("HTTP Error 429: Too Many Requests\nHTTP Error 403: Forbidden");
  const diagnostic = classifyExtractorFailure(error);
  assert.equal(diagnostic.code, "YOUTUBE_RATE_LIMITED");
  assert.equal(diagnostic.status, 503);
  assert.equal(diagnostic.retryAfter, RATE_LIMIT_SECONDS);
});

test("classifies duration, forbidden, and timeout failures", () => {
  assert.equal(classifyExtractorFailure("does not pass filter").status, 413);
  assert.equal(classifyExtractorFailure("HTTP Error 403: Forbidden").code, "YOUTUBE_FORBIDDEN");
  assert.equal(classifyExtractorFailure("Download timed out").code, "EXTRACTION_TIMEOUT");
});
