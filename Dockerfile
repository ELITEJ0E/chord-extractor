FROM node:20-slim

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apt-get update -o Acquire::Retries=5 \
    && apt-get install -y --no-install-recommends ffmpeg python3 curl ca-certificates unzip \
    && rm -rf /var/lib/apt/lists/*

# Install Deno using a retryable, versioned release download rather than piping
# an installer script directly into a shell.
ARG DENO_VERSION=2.9.7
RUN set -eux; \
    curl --fail --location --retry 8 --retry-all-errors --retry-delay 3 \
      --connect-timeout 20 --max-time 240 \
      "https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/deno-x86_64-unknown-linux-gnu.zip" \
      -o /tmp/deno.zip; \
    unzip -q /tmp/deno.zip deno -d /usr/local/bin; \
    chmod 755 /usr/local/bin/deno; \
    rm -f /tmp/deno.zip; \
    deno --version

# A transient GitHub/CDN disconnect (curl exit 56) must not silently install
# a partial executable; fail and retry the transfer instead.
RUN set -eux; \
    curl --fail --location --retry 8 --retry-all-errors --retry-delay 3 \
      --connect-timeout 20 --max-time 240 \
      https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
      -o /usr/local/bin/yt-dlp; \
    chmod 755 /usr/local/bin/yt-dlp; \
    yt-dlp --version

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY . .
EXPOSE 8080
CMD ["node", "server.js"]
