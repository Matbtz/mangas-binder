# node:sqlite is built in from Node 22.5+, so no native DB module to compile.
FROM node:22-alpine

WORKDIR /app

# Install production deps first for better layer caching.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src
COPY web ./web

ENV NODE_ENV=production \
    PORT=8787 \
    DB_PATH=/data/mangas-binder.db \
    STAGING_DIR=/data/staging \
    OUTPUT_DIR=/bindery

EXPOSE 8787
VOLUME ["/data", "/bindery"]

CMD ["node", "src/server/app.js"]
