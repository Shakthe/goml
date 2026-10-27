# Build the frontend, then serve it from the same nginx that fronts the API.
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM nginx:1.27-alpine
COPY infra/nginx/nginx.conf /etc/nginx/nginx.conf
COPY infra/nginx/proxy_common.conf /etc/nginx/proxy_common.conf
COPY --from=web /web/dist /usr/share/nginx/html
