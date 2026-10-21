# syntax=docker/dockerfile:1

# ---- build ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build \
 && rm -f dist/config.json   # la config di dev non deve finire nell'immagine

# ---- runtime ----
FROM nginxinc/nginx-unprivileged:stable-alpine
USER root
# applica le patch di sicurezza dei pacchetti Alpine (libxml2, libpng, curl, openssl, zlib, busybox, ...)
RUN apk upgrade --no-cache \
 && rm -f /etc/nginx/conf.d/default.conf \
 && mkdir -p /etc/nginx/proxy.d \
 && chown -R nginx:nginx /etc/nginx/proxy.d
COPY nginx/default.conf /etc/nginx/conf.d/default.conf
COPY docker-entrypoint.d/35-proxy-config.sh   /docker-entrypoint.d/35-proxy-config.sh
COPY docker-entrypoint.d/40-runtime-config.sh /docker-entrypoint.d/40-runtime-config.sh
COPY docker-entrypoint.d/45-security-config.sh /docker-entrypoint.d/45-security-config.sh
COPY --from=build /app/dist /usr/share/nginx/html
RUN chmod +x /docker-entrypoint.d/35-proxy-config.sh /docker-entrypoint.d/40-runtime-config.sh /docker-entrypoint.d/45-security-config.sh \
 && chown -R nginx:nginx /usr/share/nginx/html
USER nginx

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
