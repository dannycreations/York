# Base
FROM node:16-alpine AS base

ENV NODE_ENV=development

RUN apk add --no-cache tini
ENTRYPOINT ["/sbin/tini", "--"]

RUN apk add --no-cache tzdata
ENV TZ=Asia/Jakarta

RUN mkdir /app && chown -R node:node /app
WORKDIR /app

RUN npm install -g pnpm@latest \
    npm cache clean --force

USER node

COPY --chown=node:node pnpm-lock.yaml ./
RUN pnpm fetch

COPY --chown=node:node package.json ./
RUN pnpm install -r --offline

# Development
FROM base AS development

COPY --chown=node:node tsconfig.json ./
COPY --chown=node:node src ./src

RUN pnpm run build

# Production
FROM base AS production

ENV NODE_ENV=production

COPY --chown=node:node --from=development /app/dist ./dist

RUN pnpm prune --prod

CMD ["node", "dist/main"]
