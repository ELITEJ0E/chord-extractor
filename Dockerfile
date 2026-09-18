FROM node:20-slim

RUN apt-get update && apt-get install -y \
    ffmpeg \
    curl \
    ca-certificates \
    python3 \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/download/2025.06.30/yt-dlp \
       -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && yt-dlp --version \
    && rm -rf /var/lib/apt/lists/*


WORKDIR /app


COPY package*.json ./


RUN npm install --omit=dev


COPY . .


EXPOSE 8080


CMD ["node", "server.js"]
