FROM node:20-slim

WORKDIR /app

ADD "https://worldtimeapi.org/api/timezone/Etc/UTC" /tmp/bustcache
COPY package.json ./
RUN npm install --production

COPY index.js ./

CMD ["node", "index.js"]
