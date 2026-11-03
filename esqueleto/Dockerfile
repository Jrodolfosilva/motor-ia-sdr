# Imagem do motor + simulador. Build a partir da raiz do repo (precisa de kits/ para o seed):
#   docker compose build app
FROM node:22-bookworm-slim AS web
WORKDIR /app/esqueleto/web
COPY esqueleto/web/package.json esqueleto/web/package-lock.json ./
RUN npm ci
COPY esqueleto/web/ ./
RUN npm run build && npm run build:embed

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app/esqueleto
COPY esqueleto/package.json esqueleto/package-lock.json ./
# tsx roda o TypeScript direto (sem etapa de build do servidor)
RUN npm ci --include=dev
COPY esqueleto/tsconfig.json ./
COPY esqueleto/src ./src
COPY esqueleto/public ./public
COPY --from=web /app/esqueleto/web/dist ./web/dist
COPY --from=web /app/esqueleto/web/dist-embed ./web/dist-embed
# kit inicial: importado para o MongoDB só na 1ª subida
COPY kits /app/kits
EXPOSE 3000
CMD ["npx", "tsx", "src/server.ts"]
