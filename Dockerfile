# Production image — multi-stage build, compiled JS only, non-root runtime.

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

RUN addgroup -S gateway && adduser -S gateway -G gateway
USER gateway

EXPOSE 3000
CMD ["node", "dist/index.js"]
