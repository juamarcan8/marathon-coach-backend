# Dockerfile
FROM node:18-alpine

# crear usuario no privilegiado opcional (mejor seguridad)
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# copiar package.json y package-lock para aprovechar cache
COPY package*.json ./

# instalar deps (en prod usa --only=production si lo deseas)
RUN npm install

# copiar el resto del código
COPY . .

# cambiar a usuario no-root (opcional)
USER appuser

ENV NODE_ENV=production
EXPOSE 4000

CMD ["node", "index.js"]
