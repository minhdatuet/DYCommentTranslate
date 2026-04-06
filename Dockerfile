FROM mcr.microsoft.com/playwright:v1.59.1-noble

ENV NODE_ENV=production
ENV PLAYWRIGHT_HEADLESS=true
ENV PLAYWRIGHT_LAUNCH_TIMEOUT_MS=30000

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev
RUN apt-get update \
    && apt-get install -y --no-install-recommends fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

COPY . .

EXPOSE 3000

CMD ["node", "src/app.js"]
