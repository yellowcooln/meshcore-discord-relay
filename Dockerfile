FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src
COPY .env.example ./
COPY channels.example.json ./

ENV NODE_ENV=production

CMD ["node", "src/index.js"]
