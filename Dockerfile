# Magnesium worker image.
# A headless Claude Code worker runs inside this container, scoped to a single
# task worktree that is bind-mounted at /work. There is no host keychain inside
# the container, so authentication is strictly ANTHROPIC_API_KEY (API billing).
FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Pin the Claude Code CLI version. Override at build time with
# --build-arg CLAUDE_CODE_VERSION=x.y.z
ARG CLAUDE_CODE_VERSION=2.1.177
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

WORKDIR /work

# The command (claude -p ...) is supplied by the dispatcher at run time.
ENTRYPOINT []
