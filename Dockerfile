FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3002
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
# Only the server's runtime dependencies; the client ships as static files.
RUN npm ci --omit=dev --workspace=server --include-workspace-root=false && npm cache clean --force
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/client/dist client/dist
USER node
EXPOSE 3002
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:${PORT}/api/health || exit 1
CMD ["node", "server/dist/src/index.js"]
