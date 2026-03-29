FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm cache clean --force && npm install --production

COPY index.js ./

CMD ["node", "index.js"]
