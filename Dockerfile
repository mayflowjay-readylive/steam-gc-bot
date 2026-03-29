FROM node:20-slim

WORKDIR /app

# Force rebuild: v3
COPY package.json ./
RUN npm install --production

COPY index.js ./

CMD ["node", "index.js"]
