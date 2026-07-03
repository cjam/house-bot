FROM oven/bun:1-slim

USER root

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

RUN mkdir -p /app/data

CMD ["bun", "src/index.ts"]
