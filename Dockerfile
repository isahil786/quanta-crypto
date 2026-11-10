FROM node:20-alpine

WORKDIR /app

# Install all dependencies (needed for build: vite is a devDependency)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build frontend into dist/
COPY . .
RUN npm run build

# Runtime: server.ts (via tsx) serves API, WS, and the built UI from dist/
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["npm", "start"]
