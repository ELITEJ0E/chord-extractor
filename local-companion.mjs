// Local-only YouTube audio extractor for videos you are permitted to download.
// Run: node local-companion.mjs (after npm install and installing yt-dlp/FFmpeg/Deno).
import express from "express";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const app = express();
app.use(express.json({ limit: "4kb" }));
const PORT = Number(process.env.LOCAL_EXTRACTOR_PORT) || 8787;
const ALLOWED_ORIGINS = new Set([
  "https://joe-guitar.vercel.app",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

app.use((req, res, next) => {
  const origin = req.get("origin");
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return res.status(403).json({ error: "Origin not allowed" });
  }
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Access-Control-Request-Private-Network");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  res.setHeader("Access-Control-Expose-Headers", "X-Video-Title,X-Video-Artist");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

function videoUrl(input) {
  if (typeof input !== "string") return null;
  try {
    const u = new URL(input);
    if (!["https:", "http:"].includes(u.protocol)) return null;
    const host = u.hostname.toLowerCase();
    let id = null;
    if (host === "youtu.be") id = u.pathname.slice(1).split("/")[0];
    else if (["youtube.com", "www.youtube.com", "m.youtube.com"].includes(host)) {
      id = u.pathname === "/watch" ? u.searchParams.get("v") : null;
    }
    if (!/^[A-Za-z0-9_-]{11}$/.test(id || "")) return null;
    return "https://www.youtube.com/watch?v=" + id;
  } catch { return null; }
}

function runYtDlp(url, filename) {
  const args = [
    "--no-playlist", "--no-progress",
    "--js-runtimes", "deno",
    "--extract-audio", "--audio-format", "mp3", "--audio-quality", "5",
    "--match-filter", "duration <= 600",
    "--print", "after_move:%(title)j",
    "--print", "after_move:%(uploader)j",
    "--output", filename + ".%(ext)s", url,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn("yt-dlp", args, { windowsHide: true });
    let stdout = "", stderr = "", settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      err ? reject(err) : resolve({ stdout, stderr });
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error("Audio extraction timed out"));
    }, 120000);
    child.stdout.on("data", b => { stdout = (stdout + b.toString()).slice(-16000); });
    child.stderr.on("data", b => { stderr = (stderr + b.toString()).slice(-16000); });
    child.once("error", finish);
    child.once("close", code => finish(code === 0 ? null : new Error(stderr || "yt-dlp exited " + code)));
  });
}

app.get("/", (_req, res) => res.json({ status: "ok", service: "joe-guitar-local-extractor" }));

let busy = false;
app.post("/extract", async (req, res) => {
  const url = videoUrl(req.body?.url);
  if (!url) return res.status(400).json({ error: "Valid YouTube watch URL required" });
  if (busy) return res.status(429).json({ error: "Local extractor is processing another song" });
  busy = true;
  const prefix = path.join(os.tmpdir(), "joe-local-" + crypto.randomBytes(8).toString("hex"));
  const mp3 = prefix + ".mp3";
  try {
    const { stdout } = await runYtDlp(url, prefix);
    if (!fs.existsSync(mp3)) throw new Error("MP3 missing after extraction");
    const lines = stdout.trim().split(/\r?\n/);
    const safeParse = (s, fallback) => {
      try {
        const value = JSON.parse(s);
        return typeof value === "string" ? value.slice(0, 200) : fallback;
      } catch { return fallback; }
    };
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("X-Video-Title", encodeURIComponent(safeParse(lines[0], "YouTube Track")));
    res.setHeader("X-Video-Artist", encodeURIComponent(safeParse(lines[1], "")));
    const stream = fs.createReadStream(mp3);
    stream.once("error", err => res.destroy(err));
    res.once("close", () => fs.rm(mp3, { force: true }, () => {}));
    stream.pipe(res);
  } catch (err) {
    console.error("[local-extractor]", err?.message);
    if (!res.headersSent) res.status(502).json({ error: String(err?.message || "Extraction failed").slice(-1000) });
    fs.rm(mp3, { force: true }, () => {});
  } finally {
    busy = false;
  }
});

// Bind to loopback exclusively; no other device on the network can connect.
app.listen(PORT, "127.0.0.1", () => {
  console.log("JOE Guitar local extractor: http://127.0.0.1:" + PORT);
});
