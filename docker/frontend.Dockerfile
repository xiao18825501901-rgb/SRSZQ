# SRSZQ frontend 镜像：构建 SPA → Nginx 托管并反代 /api 与 /ws
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/package.json
COPY frontend/package.json frontend/package.json
COPY backend/package.json backend/package.json
RUN npm install --workspaces --include-workspace-root --ignore-scripts || npm install --workspaces --include-workspace-root
COPY shared shared
COPY frontend frontend
ARG VITE_API_URL=http://localhost:8080
ARG VITE_WS_URL=ws://localhost:8081/ws
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_WS_URL=$VITE_WS_URL
RUN npm run build -w frontend

FROM nginx:alpine
COPY --from=build /app/frontend/dist /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
