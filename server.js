import express from "express";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";

const app = express();
app.use(express.json());

const MAX_DURATION_SECONDS = 600; // 10 min cap

function runYtDlpJson(url) {
  return new Promise((resolve, reject) => {
    const proc = spawn("yt-dlp", ["-J", "--no-playlist", url]);
    let data = "";
    proc.stdout.on("data", (d) => (data += d));
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error("Could not read video metadata."));
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
  });
}

function runYtDlpDownload(url, outputTemplate) {
  return new Promise((resolve, reject) => {
    const proc = spawn("yt-dlp", [
      "-x", "--audio-format", "mp3", "--audio-quality", "5",
      "--no-playlist", "-o", outputTemplate, url,
    ]);
    proc.on("close", (code) => code === 0 ? resolve() : reject(new Error("Audio extraction failed.")));
  });
}

app.post("/extract", async (req, res) => {
  const { url } = req.body || {};
  if (!url || !/youtu\.?be/.test(url)) {
    return res.status(400).json({ error: "A valid YouTube URL is required." });
  }

  const jobId = crypto.randomBytes(8).toString("hex");
  const tmpDir = os.tmpdir();
  const outputTemplate = path.join(tmpDir, `${jobId}.%(ext)s`);
  const mp3Path = path.join(tmpDir, `${jobId}.mp3`);

  try {
    const meta = await runYtDlpJson(url);
    if (meta.duration > MAX_DURATION_SECONDS) {
      return res.status(413).json({ error: `Video is too long (limit ${MAX_DURATION_SECONDS / 60} min).` });
    }

    await runYtDlpDownload(url, outputTemplate);
    if (!fs.existsSync(mp3Path)) {
      return res.status(500).json({ error: "Audio extraction failed." });
    }

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("X-Video-Title", encodeURIComponent(meta.title || "YouTube Track"));
    res.setHeader("X-Video-Artist", encodeURIComponent(meta.uploader || ""));
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "X-Video-Title, X-Video-Artist");

    const stream = fs.createReadStream(mp3Path);
    stream.pipe(res);
    stream.on("close", () => fs.unlink(mp3Path, () => {}));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to extract audio.", message: err.message });
  }
});

app.options("/extract", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.status(200).end();
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Extractor listening on ${PORT}`));