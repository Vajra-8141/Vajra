# The sidecar's own explorer, as a static page. It reads the node from the browser, at http://localhost:14337/rpc.
FROM oven/bun:1.2.23-alpine AS build
WORKDIR /usr/app
RUN apk add --no-cache g++ make python3 git py3-setuptools
COPY . .
RUN bun install --frozen-lockfile && cd packages/types && bun run build && cd ../devnet-ui && bunx vite build

FROM oven/bun:1.2.23-alpine
WORKDIR /srv
COPY --from=build /usr/app/packages/devnet-ui/dist .
RUN printf 'Bun.serve({port:8080,async fetch(r){const p=new URL(r.url).pathname;const f=Bun.file("/srv"+p);return new Response((await f.exists())&&p!=="/"?f:Bun.file("/srv/index.html"))}})' > /serve.js
CMD ["bun", "/serve.js"]
