# Life OS hub on Node.js: serves the API, GraphQL and the web app, with a SQLite file in /data.
FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @life-os/web build && pnpm --filter @life-os/hub-node build
# Production dependencies the bundle keeps external (native libSQL, Hono, Drizzle).
RUN pnpm --filter @life-os/hub-node deploy --prod --legacy /out

FROM node:22-slim
ENV NODE_ENV=production \
    PORT=8787 \
    DATABASE_URL=file:/data/life-os.db
WORKDIR /app/apps/hub-node
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /app/apps/hub-node/dist ./dist
COPY --from=build /app/apps/web/dist /app/apps/web/dist
COPY --from=build /app/packages/schema/migrations /app/packages/schema/migrations
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
