# syntax=docker/dockerfile:1

# --- build ---
FROM node:22-alpine AS build

WORKDIR /app

# scripts/ must be present before npm ci: the postinstall hook runs
# scripts/copy-rnnoise.cjs.
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci

COPY . .
# public/ was just overwritten by COPY — regenerate the WASM glue files.
RUN node scripts/copy-rnnoise.cjs && npm run build

# --- run ---
FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
