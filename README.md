# JOE-Music YouTube audio extractor

Node/Express backend for [JOE-Music](https://github.com/ELITEJ0E/JOE-Music). Deploy as a **Docker web service on Render** (or another container runtime), not as a Cloudflare Worker. Cloudflare Workers cannot execute the yt-dlp, FFmpeg and Deno subprocesses used here.

## Endpoints

- GET / — backend health and whether the upstream has triggered a temporary cooldown.
- POST /extract — JSON request with `{"url":"https://www.youtube.com/watch?v=VIDEO_ID"}`. Returns MP3 audio with `X-Video-Title` and `X-Video-Artist` headers on success.
- Errors include `error`, `code`, and `stage`. HTTP 503 with `YOUTUBE_RATE_LIMITED` indicates that YouTube is restricting the server's network access.

## Reliability limits

- Each video is downloaded in **one yt-dlp invocation**, with a ten-minute duration filter.
- Repeat or simultaneous requests for the same video share the download; successful MP3 files are cached in temporary instance-local storage for up to an hour, limited to four videos.
- At most two different videos can download at once.
- After a detected upstream HTTP 429, uncached requests are paused for 30 minutes (the response includes `Retry-After`). Cache hits still work.
- Render's disk is ephemeral; caches and cooldowns reset on redeployment/restart.
- These changes reduce repeated YouTube requests but **cannot guarantee access** if YouTube blocks or rate-limits Render's IP. JOE-Music's upload-an-audio-file workflow is the fallback.

## Development

Run `npm install` then `npm start`. The Docker image includes yt-dlp, FFmpeg, and Deno. Run policy tests with `npm test`.

Optional: set `YOUTUBE_COOKIES` to a Netscape cookie-file value only if your use and permissions allow it. Never commit credentials to GitHub.

Set JOE-Music's Vercel rewrite to the URL of this backend; the frontend should call the same-origin path `/api/youtube/extract`.
