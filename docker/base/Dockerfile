# Pinned to avoid upstream churn breaking rebuilds. Bump when testing a new
# OpenClaw release — the three already-deployed regions run 2026.4.15.
FROM ghcr.io/openclaw/openclaw:2026.4.15

USER root

# Runtime dependencies for the credential proxy and entrypoint script.
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl jq \
    && rm -rf /var/lib/apt/lists/*

# WeCom plugin — installed here (in the base) because the tarball is ~510MB
# and rarely changes; baking it in keeps the application image small and its
# build fast. Bump the base tag (e.g. openclaw-base:2025-04) when the plugin
# version advances.
USER node
RUN mkdir -p /home/node/.openclaw/extensions/wecom
COPY --chown=node:node wecom.tar.gz /tmp/wecom.tar.gz
RUN tar -xzf /tmp/wecom.tar.gz --strip-components=1 -C /home/node/.openclaw/extensions/wecom && \
    rm -f /tmp/wecom.tar.gz

# Drop package managers so installed images can't pull arbitrary packages.
USER root
RUN apt-get remove -y apt dpkg 2>/dev/null; rm -rf /var/lib/apt /var/cache/apt

USER node
