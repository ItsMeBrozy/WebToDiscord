# Use the official Node.js image
FROM node:20

# Create and change to the app directory
WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Expose the port (Hugging Face uses 7860 by default)
EXPOSE 7860

# Ensure the app uses port 7860 if provided by the environment
ENV PORT=7860

# Start the application
CMD [ "npm", "start" ]
