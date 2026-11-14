# Build stage: install all dependencies and compile TypeScript to dist/
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Runtime stage: production dependencies, compiled output, and static UI
FROM node:22-slim AS runtime
ENV NODE_ENV=production PORT=8787
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY public ./public
USER node
EXPOSE 8787
CMD ["node", "dist/server.js"]
