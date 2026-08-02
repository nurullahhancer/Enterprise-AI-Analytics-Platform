FROM node:22-trixie-slim AS native-build-base
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

FROM native-build-base AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM native-build-base AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html tsconfig.json vite.config.ts capacitor.config.ts ./
COPY public ./public
COPY src ./src
COPY server.ts ./server.ts
COPY server.test.ts ./server.test.ts
RUN npm run lint && npm run build

FROM build AS test
ENV NODE_ENV=test
CMD ["npm", "test"]

FROM node:22-trixie-slim AS runtime
ENV NODE_ENV=production \
    PORT=3010 \
    DB_PATH=data/reai.db
WORKDIR /app
RUN rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx \
    && mkdir -p /app/data \
    && chown node:node /app/data \
    && chmod 700 /app/data
COPY --chown=node:node package.json ./
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/server-dist ./server-dist
COPY --chmod=755 --chown=node:node docker-entrypoint.sh ./docker-entrypoint.sh
USER node
EXPOSE 3010
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3010/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["./docker-entrypoint.sh"]
