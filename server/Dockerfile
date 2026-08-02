FROM node:22-slim AS build
WORKDIR /build/server
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/tsconfig.json ./
COPY server/src ./src
COPY lexicons /build/lexicons
RUN npm run build

FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /build/server/dist ./dist
COPY --from=build /build/lexicons /lexicons
RUN mkdir -p /run/at-adsb /tmp/at-adsb-atrx /data && chown node:node /run/at-adsb /tmp/at-adsb-atrx /data
EXPOSE 4100
USER node
ENTRYPOINT ["tini", "--", "node", "dist/cli.js"]
CMD ["run"]
