FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN apk add --no-cache git
RUN npm ci --omit=dev && npm cache clean --force

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
