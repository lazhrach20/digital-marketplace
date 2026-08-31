FROM node:22-alpine AS builder

WORKDIR /app

COPY prisma ./prisma
COPY apps/api/package.json apps/api/tsconfig.json apps/api/nest-cli.json ./
COPY apps/api/src ./src

RUN npm install \
  && npx prisma generate --schema=./prisma/schema.prisma \
  && npm run build

FROM node:22-alpine AS runner

WORKDIR /app

COPY prisma ./prisma
COPY apps/api/package.json ./
RUN npm install --omit=dev \
  && npx prisma generate --schema=./prisma/schema.prisma

COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "dist/main.js"]
