FROM node:22.23.4-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY scripts/check-node-runtime.mjs ./scripts/check-node-runtime.mjs
RUN node scripts/check-node-runtime.mjs

COPY package.json package-lock.json ./
RUN apk add --no-cache git ca-certificates && apk upgrade --no-cache ca-certificates && update-ca-certificates
RUN npm ci --omit=dev && npm cache clean --force
LABEL org.eawhub.runtime-security="2026-10-21"

COPY apps/server ./apps/server
COPY packages/shared ./packages/shared
COPY scripts/manage-server.mjs ./scripts/manage-server.mjs
RUN mkdir -p /data && chown -R node:node /app /data

USER node
EXPOSE 3210
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3210/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "apps/server/src/main.mjs", "--host", "0.0.0.0", "--port", "3210", "--data", "/data", "--auth", "required"]
