FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json yarn.lock ./
RUN corepack enable && yarn install --frozen-lockfile

FROM deps AS build
COPY . .
RUN yarn build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY package.json yarn.lock ./
RUN corepack enable \
    && yarn install --frozen-lockfile --production=true \
    && yarn cache clean

COPY --from=build /app/dist ./dist

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/app/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
