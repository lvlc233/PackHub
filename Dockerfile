# Hub 的部署镜像：只跑只读发布端，不装任何执行入口。
# 构建：docker build -t packhub-hub .
# 运行：docker run -p 8788:8788 -e PACKHUB_HUB_TOKEN=... packhub-hub
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile
# 镜像只跑只读端：去掉 vitest/typescript 这类只在开发时用的依赖
RUN pnpm prune --prod

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
EXPOSE 8788
# 对外监听必须带 PACKHUB_HUB_TOKEN，否则 hub 会拒绝启动（fail-closed）
CMD ["node", "--experimental-strip-types", "apps/local/src/bin.ts", "hub", ".", "--host", "0.0.0.0", "--port", "8788"]
