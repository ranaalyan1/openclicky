# OpenClicky sandbox browser worker image.
# Build context is the REPO ROOT (the worker consumes @openclicky/core):
#   docker build -f sandbox/Dockerfile -t openclicky-sandbox .
FROM node:22-bookworm

WORKDIR /app

# Install deps first (cache-friendly), then build the workspaces.
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY core/package.json core/package.json
COPY cli/package.json cli/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/desktop/package.json apps/desktop/package.json
COPY sandbox/package.json sandbox/package.json
RUN npm install --no-audit --no-fund --workspace @openclicky/sandbox --workspace @openclicky/core \
 && npx playwright install --with-deps chromium

COPY core core
COPY sandbox sandbox
RUN npm run build -w @openclicky/core && npm run build -w @openclicky/sandbox

# Disposable by design: no host mounts, no host credentials.
CMD ["node", "sandbox/dist/src/main.js"]
