FROM node:20-alpine

WORKDIR /app

# 仅先复制依赖清单，利用 Docker 层缓存
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# 复制应用代码
COPY src ./src
COPY public ./public

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/server.js"]
