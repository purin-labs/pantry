# The container of the ChatGPT exit (Plan 75). Build context: the repository.
FROM node:24-alpine

WORKDIR /app
COPY services/platform/src/chatgpt-exit/forward.ts /app/forward.ts
COPY services/chatgpt-exit/server.mjs /app/server.mjs

USER node
EXPOSE 8080

CMD ["node", "/app/server.mjs"]
