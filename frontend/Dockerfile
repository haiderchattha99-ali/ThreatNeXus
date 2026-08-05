# ThreatNeXus frontend — local development and demonstration image.
#
# Two stages: build the static bundle with Node, then serve it with nginx. The
# runtime image contains no Node, no source and no dependencies.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# VITE_ variables are INLINED into the bundle at build time, so only
# non-secret configuration may ever be passed here. A provider key must never
# appear as a VITE_ variable — CI checks the built bundle for exactly that.
ARG VITE_API_BASE_URL=http://localhost:5000/api
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN npm run build

FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
