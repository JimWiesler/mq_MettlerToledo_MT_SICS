FROM node:14

# Create app directory
WORKDIR /usr/src/app

# Copy package.json and package-lock.json to workdir, then install package dependencies
COPY mt-sics/package*.json ./
RUN npm install

# Copy app file to working directory
COPY mt-sics/*.js ./

CMD ["node", "scale.js"]
