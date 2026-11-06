FROM node:24-slim
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter @vajra/wallet... --ignore-scripts
RUN pnpm --filter @vajra/wallet build
ENV NODE_ENV=production
CMD ["node", "apps/wallet/server.ts"]
