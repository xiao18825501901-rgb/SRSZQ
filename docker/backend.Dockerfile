# SRSZQ backend 镜像（Node 24）
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/package.json
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm install --workspaces --include-workspace-root --ignore-scripts || npm install --workspaces --include-workspace-root
COPY shared shared
COPY backend backend
WORKDIR /app/backend
ENV NODE_ENV=production
EXPOSE 8080 8081
CMD ["npx", "tsx", "src/server.ts"]
