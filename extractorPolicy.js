// Centralized URL validation and upstream error classification.
// This module deliberately has no dependencies so it can be tested without yt-dlp.
export const RATE_LIMIT_SECONDS = 30 * 60;
export const MAX_DURATION_SECONDS = 10 * 60;

export function normalizeYouTubeUrl(input) {
  if (typeof input !== "string" || input.length > 2048) return null;
  let parsed;
  try {
    parsed = new URL(input.trim());
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return null;
  const host = parsed.hostname.toLowerCase();
  let id = null;
  if (host === "youtu.be") {
    id = parsed.pathname.split("/")[1];
  } else if (["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"].includes(host)) {
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts[0] === "watch") id = parsed.searchParams.get("v");
    else if (["shorts", "embed", "live", "v"].includes(parts[0])) id = parts[1];
  }
  if (!id || !/^[a-zA-Z0-9_-]{11}$/.test(id)) return null;
  return { id, url: "https://www.youtube.com/watch?v=" + id };
}

export function classifyExtractorFailure(error) {
  const raw = String(error && error.message || error || "");
  if (/HTTP Error 429|Too Many Requests/i.test(raw)) {
    return { status: 503, code: "YOUTUBE_RATE_LIMITED",
      message: "YouTube is temporarily rate-limiting this server. Use Upload Audio to analyze a local file, or try again later.",
      retryAfter: RATE_LIMIT_SECONDS };
  }
  if (/does not pass filter|video too long|duration limit/i.test(raw)) {
    return { status: 413, code: "VIDEO_TOO_LONG",
      message: "This YouTube video exceeds the 10-minute extraction limit." };
  }
  if (/Sign in to confirm|not a bot|confirm you're not a bot/i.test(raw)) {
    return { status: 502, code: "YOUTUBE_BOT_CHECK",
      message: "YouTube requires verification of this server. You can upload an audio file instead." };
  }
  if (/HTTP Error 403|Forbidden/i.test(raw)) {
    return { status: 502, code: "YOUTUBE_FORBIDDEN",
      message: "YouTube has denied this server access to the video. You can upload an audio file instead." };
  }
  if (/Video unavailable|private video/i.test(raw)) {
    return { status: 422, code: "VIDEO_UNAVAILABLE",
      message: "This YouTube video is unavailable or private." };
  }
  if (/timed out|ETIMEDOUT/i.test(raw)) {
    return { status: 504, code: "EXTRACTION_TIMEOUT",
      message: "Audio extraction timed out. Please try again later or upload an audio file." };
  }
  return { status: 502, code: "YTDLP_FAILED",
    message: "Unable to extract this video. Check Render logs for details, or upload an audio file." };
}
