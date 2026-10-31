# One small image: builds TypeScript, then runs the server which also serves the web UI.
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
COPY public ./public
COPY data/season-2027 ./data/season-2027
RUN npx tsc -p . && node --test dist/test/

FROM node:20-alpine
ENV NODE_ENV=production
RUN apk add --no-cache tzdata
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY public ./public
# Mascot logos only (~10 MB); the contact sheets stay out of the image.
COPY deliverables/logos/manifest.json ./deliverables/logos/
COPY deliverables/logos/teams ./deliverables/logos/teams
COPY deliverables/logos/cheer ./deliverables/logos/cheer
COPY data/season-2027 ./data/season-2027
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "dist/src/server.js"]
