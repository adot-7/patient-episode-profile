FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY client ./client
COPY vite.config.js ./
ARG APP_BASE_PATH=/
ENV APP_BASE_PATH=${APP_BASE_PATH}
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3002 APP_BASE_PATH=/
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3002
CMD ["node", "server/index.js"]
