ARG BASE_IMAGE
FROM ${BASE_IMAGE}

# BASE_IMAGE already contains: OpenClaw runtime + curl/jq + WeCom plugin.
# See docker/base/Dockerfile. Keep this Dockerfile lightweight so application
# rebuilds finish in seconds.

USER root

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Select which skill pack to bundle (general / sales / dev / ...).
ARG SKILL_GROUP=general
COPY skills/${SKILL_GROUP}/ /opt/openclaw-skills/

USER node

ENV NODE_ENV=production
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

ENTRYPOINT ["/entrypoint.sh"]
