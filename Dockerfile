FROM node:lts-alpine AS base
LABEL maintainer="Ahmad Ridho <ahmad.ridho@gmail.com>"

WORKDIR /app

RUN apk add --no-cache git libc6-compat tzdata
ENV TZ=Asia/Jakarta

RUN corepack enable && corepack prepare pnpm@latest --activate

FROM base AS deps

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS builder

COPY . .
RUN pnpm build

FROM base AS prod

COPY --from=builder /app/dist ./dist
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./

# Set default envs
ARG COMPANY_ID=TKDO
ARG AGENT_ID=01TKDO
ARG NODE_ENV=production
ARG PORT=3000
ARG TAGS=1.0.0-dev

ENV COMPANY_ID=${COMPANY_ID}
ENV AGENT_ID=${AGENT_ID}
ENV NODE_ENV=${NODE_ENV}
ENV PORT=${PORT}
ENV TAGS=${TAGS}

EXPOSE ${PORT}

ENTRYPOINT TAGS=${TAGS} COMPANY_ID=${COMPANY_ID} AGENT_ID=${AGENT_ID} \
  NODE_ENV=${NODE_ENV} PORT=${PORT} node dist/server.js
