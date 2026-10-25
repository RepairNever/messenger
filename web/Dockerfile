# syntax=docker/dockerfile:1

FROM nginx:1.30-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf

# The release archive is built on a development machine or in CI and committed.
# ADD automatically extracts the local tar.gz; no Node/npm tooling is needed.
RUN rm -rf /usr/share/nginx/html/*
ADD web_client.tar.gz /usr/share/nginx/html/
RUN test -s /usr/share/nginx/html/index.html \
    && find /usr/share/nginx/html -name .DS_Store -type f -delete

EXPOSE 80
