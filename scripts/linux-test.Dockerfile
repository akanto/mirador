# The Linux machine scripts/linux-test.sh runs Mirador's checks on: Bun, Node for the Playwright runner, opencode and
# Playwright's Chromium, as a non-root user because Claude Code refuses to skip permission prompts as root.
FROM ubuntu:24.04

ARG BUN_VERSION=1.4.0
ARG NODE_VERSION=22.13.1
ARG OPENCODE_VERSION=1.18.18
ARG PLAYWRIGHT_VERSION=1.63.0

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git unzip xz-utils && rm -rf /var/lib/apt/lists/*
RUN arch=$(dpkg --print-architecture | sed 's/amd64/x64/') \
 && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${arch}.tar.xz" | tar -xJ -C /usr/local --strip-components=1

USER ubuntu
WORKDIR /home/ubuntu
ENV PATH=/home/ubuntu/.bun/bin:/home/ubuntu/.opencode/bin:$PATH
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
 && curl -fsSL https://opencode.ai/install | bash -s -- --version "${OPENCODE_VERSION}" --no-modify-path \
 && mkdir -p .bun/install/cache

USER root
RUN /home/ubuntu/.bun/bin/bunx playwright@${PLAYWRIGHT_VERSION} install-deps chromium && rm -rf /var/lib/apt/lists/*

USER ubuntu
RUN bunx playwright@${PLAYWRIGHT_VERSION} install chromium
