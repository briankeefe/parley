FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
COPY omp /bridge/omp
RUN echo '85d9daf3a05fc76e8cd425ae1904eb576af8d21cc85fcf4690742626e07ccfa4  /bridge/omp' | sha256sum -c -
COPY notes.mjs runner.mjs server.mjs errors.mjs /bridge/
USER 1000:1000
WORKDIR /tmp
CMD ["node", "/bridge/server.mjs"]
