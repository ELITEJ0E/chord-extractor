import express from "express";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  MAX_DURATION_SECONDS,
  RATE_LIMIT_SECONDS,
  normalizeYouTubeUrl,
  classifyExtractorFailure,
} from "./extractorPolicy.js";

const app = express();
app.use(express.json({ limit: "4kb" }));

// A same-origin Vercel rewrite is used in production. Keep browser direct
// access possible for local development without reflecting arbitrary origins.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Expose-Headers", "X-Video-Title,X-Video-Artist,Retry-After");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// Instance-local disk cache. Render ephemeral storage is intentionally not
// treated as persistent. A cache hit avoids making any YouTube requests.
const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_CACHED_FILES = 4;
const MAX_MP3_BYTES = 30 * 1024 * 1024;
const MAX_ACTIVE_DOWNLOADS = 2;
const DOWNLOAD_TIMEOUT_MS = 120 * 1000;
const cache = new Map();
const inFlight = new Map();
let rateLimitedUntil = 0;

function removeFile(file) {
  try { fs.unlinkSync(file); } catch (err) {
    if (err?.code !== "ENOENT") console.warn("[cache] unlink failed:", err?.message);
  }
}

function removeJobFiles(prefix, except) {
  try {
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (name.startsWith(prefix) && path.join(os.tmpdir(), name) !== except) {
        removeFile(path.join(os.tmpdir(), name));
      }
    }
  } catch (err) { console.warn("[cache] cleanup notice:", err?.message); }
}

function pruneCache() {
  const now = Date.now();
  for (const [id, item] of cache) {
    if (item.expiresAt <= now || !fs.existsSync(item.file)) {
      cache.delete(id);
      removeFile(item.file);
    }
  }
  while (cache.size > MAX_CACHED_FILES) {
    const oldest = cache.keys().next().value;
    const entry = cache.get(oldest);
    cache.delete(oldest);
    removeFile(entry.file);
  }
}
setInterval(pruneCache, 60_000).unref();

function cookiesArgs() {
  if (!process.env.YOUTUBE_COOKIES?.trim()) return [];
  const file = path.join(os.tmpdir(), "joe-youtube-cookies.txt");
  fs.writeFileSync(file, process.env.YOUTUBE_COOKIES.replace(/\r\n/g, "\n"), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return ["--cookies", file];
}

function runDownloader(url, outputTemplate) {
  // Single yt-dlp invocation downloads audio AND prints metadata afterwards.
  // A pre-download duration filter avoids pulling videos over 10 minutes.
  const args = [
    "--no-config", "--no-playlist", "--no-simulate", "--no-progress",
    "--extract-audio", "--audio-format", "mp3", "--audio-quality", "5",
    "--match-filter", "duration <= " + MAX_DURATION_SECONDS,
    "--js-runtimes", "deno", "--remote-components", "ejs:npm",
    "--sleep-requests", "1",
    "--retries", "1", "--extractor-retries", "1",
    "--print", "after_move:%(title)j",
    "--print", "after_move:%(uploader)j",
    ...cookiesArgs(),
    "-o", outputTemplate, url,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ stdout, stderr });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("Extractor timed out"));
    }, DOWNLOAD_TIMEOUT_MS);
    child.stdout.on("data", chunk => {
      stdout = (stdout + chunk.toString()).slice(-65536);
    });
    child.stderr.on("data", chunk => {
      stderr = (stderr + chunk.toString()).slice(-32768);
    });
    child.once("error", finish);
    child.once("close", code => {
      if (code !== 0) return finish(new Error(stderr || "yt-dlp exited with status " + code));
      finish();
    });
  });
}

function parsedMetadata(stdout) {
  // yt-dlp --print after_move with the j conversion prints JSON strings.
  const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const parse = (line, fallback) => {
    try {
      const value = JSON.parse(line);
      return typeof value === "string" ? value : fallback;
    } catch { return fallback; }
  };
  return {
    title: parse(lines[0], "YouTube Track").slice(0, 200),
    artist: parse(lines[1], "").slice(0, 200),
  };
}

async function downloadAndCache(video) {
  const jobName = "joe-extract-" + crypto.randomBytes(12).toString("hex");
  const outputTemplate = path.join(os.tmpdir(), jobName + ".%(ext)s");
  const file = path.join(os.tmpdir(), jobName + ".mp3");
  let succeeded = false;
  try {
    const output = await runDownloader(video.url, outputTemplate);
    if (!fs.existsSync(file)) {
      if (/does not pass filter|match.filter|skipping/i.test(output.stderr)) {
        throw new Error("Video too long: does not pass filter");
      }
      throw new Error("Audio file missing after yt-dlp completed");
    }
    const size = fs.statSync(file).size;
    if (!size || size > MAX_MP3_BYTES) {
      const err = new Error("Extracted MP3 is missing or too large");
      err.fileTooLarge = true;
      throw err;
    }
    const entry = {
      file, size, ...parsedMetadata(output.stdout),
      expiresAt: Date.now() + CACHE_TTL_MS,
    };
    const prior = cache.get(video.id);
    if (prior) removeFile(prior.file);
    cache.delete(video.id);
    cache.set(video.id, entry);
    succeeded = true;
    pruneCache();
    return entry;
  } finally {
    removeJobFiles(jobName, succeeded ? file : null);
  }
}

function sendAudio(res, entry) {
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Content-Length", String(entry.size));
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Video-Title", encodeURIComponent(entry.title));
  res.setHeader("X-Video-Artist", encodeURIComponent(entry.artist));
  const stream = fs.createReadStream(entry.file);
  stream.once("error", err => {
    console.error("[extract] audio stream error:", err.message);
    if (!res.headersSent) res.status(500).json({ error: "Failed to read extracted audio", code: "AUDIO_STREAM_ERROR" });
    else res.destroy(err);
  });
  stream.pipe(res);
}

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "chord-extractor-backend",
    upstreamRateLimited: Date.now() < rateLimitedUntil,
  });
});

app.post("/extract", async (req, res) => {
  const video = normalizeYouTubeUrl(req.body?.url);
  if (!video) {
    return res.status(400).json({
      error: "A valid YouTube video URL is required.", code: "INVALID_URL",
    });
  }
  pruneCache();

  const cached = cache.get(video.id);
  if (cached) {
    // LRU: use the oldest cached file first for eviction.
    cache.delete(video.id);
    cache.set(video.id, cached);
    return sendAudio(res, cached);
  }

  if (Date.now() < rateLimitedUntil) {
    const seconds = Math.ceil((rateLimitedUntil - Date.now()) / 1000);
    res.setHeader("Retry-After", String(seconds));
    return res.status(503).json({
      error: "YouTube is temporarily rate-limiting this server. Upload an audio file instead, or retry later.",
      code: "YOUTUBE_RATE_LIMITED", stage: "cooldown", retryAfterSeconds: seconds,
    });
  }

  let job = inFlight.get(video.id);
  if (!job) {
    if (inFlight.size >= MAX_ACTIVE_DOWNLOADS) {
      res.setHeader("Retry-After", "10");
      return res.status(503).json({
        error: "The audio extractor is busy. Try again shortly or upload an audio file.",
        code: "EXTRACTOR_BUSY", retryAfterSeconds: 10,
      });
    }
    console.log("[extract] Processing video:", video.id);
    job = downloadAndCache(video);
    inFlight.set(video.id, job);
    // This completion handler handles both successes and failures without
    // creating an unhandled rejection from a .finally() promise.
    job.then(
      () => inFlight.delete(video.id),
      () => inFlight.delete(video.id),
    );
  }

  try {
    const entry = await job;
    return sendAudio(res, entry);
  } catch (err) {
    let failure = classifyExtractorFailure(err);
    if (err?.fileTooLarge) {
      failure = { status: 413, code: "AUDIO_TOO_LARGE",
        message: "Extracted audio exceeds the server's 30 MB size limit." };
    }
    if (failure.code === "YOUTUBE_RATE_LIMITED") {
      rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + RATE_LIMIT_SECONDS * 1000);
    }
    console.error("[extract]", { videoId: video.id, code: failure.code, detail: String(err?.message).slice(-2500) });
    if (failure.retryAfter) res.setHeader("Retry-After", String(failure.retryAfter));
    return res.status(failure.status).json({
      error: failure.message,
      code: failure.code,
      stage: "youtube_download",
      ...(failure.retryAfter ? { retryAfterSeconds: failure.retryAfter } : {}),
    });
  }
});

const PORT = Number(process.env.PORT) || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log("Extractor listening on " + PORT);
});
