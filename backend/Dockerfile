# ThreatNeXus backend — local development and demonstration image.
#
# This is NOT a hardened production image and is not claimed to be: ThreatNeXus
# is a research prototype with no production deployment. It exists so
# `docker compose up` gives a reviewer the whole system without a Node install.

FROM node:22-bookworm-slim

# openssl is required by Prisma's query engine on slim images.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, so a source edit does not invalidate the install layer.
COPY package.json package-lock.json ./
RUN npm ci

# The Prisma client is generated from the schema, so the schema is copied before
# the rest of the source and generation happens in its own cached layer.
COPY prisma ./prisma
RUN npx prisma generate

COPY src ./src
COPY server.js ./

# Runs as the image's built-in unprivileged user rather than root.
USER node

EXPOSE 5000

# No secrets are baked in. DATABASE_URL, JWT_SECRET and CORS_ORIGIN come from
# the environment at run time; the application refuses to start without them.
CMD ["node", "server.js"]
