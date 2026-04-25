FROM ghcr.io/puppeteer/puppeteer:22.6.2

USER root
WORKDIR /app

COPY package.json ./
RUN npm install

COPY bot.js ./

CMD ["node", "bot.js"]
