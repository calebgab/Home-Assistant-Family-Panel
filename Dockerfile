FROM node:18-alpine

WORKDIR /app

# Copy application files (config.json and data.json are excluded via .dockerignore
# so the live user files are never baked into the image)
COPY . .

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8080

ENTRYPOINT ["/entrypoint.sh"]
