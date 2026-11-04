# Introspection image for MCP directory checks (Glama and similar).
#
# NOT a way to run oguri. ADR 0011 rejected containers as a distribution
# channel on purpose: the daemon needs the user's git credentials, SSH agent and
# home directory, and containerising it fights all three. This image exists so a
# directory can start the MCP server and read `tools/list` from it.
#
# oguri refuses to start unconfigured — a transport repository is not optional —
# so the entrypoint provisions a throwaway local one inside the container. The
# server that answers is real; the network it answers about is disposable.
#
# Self-contained on purpose: no COPY, so it builds from any context. A directory
# that builds it with the repository root as context gets the same image as one
# that builds it from this directory.

FROM node:24-alpine

# git 2.42+ for `worktree add --orphan`; alpine ships well past that.
RUN apk add --no-cache git

RUN npm install -g oguri

# `oguri init` publishes an agent card, which is a commit, which needs an author.
ENV GIT_AUTHOR_NAME="oguri introspection" \
    GIT_AUTHOR_EMAIL="introspection@oguri.invalid" \
    GIT_COMMITTER_NAME="oguri introspection" \
    GIT_COMMITTER_EMAIL="introspection@oguri.invalid" \
    OGURI_HOME="/home/oguri/.oguri" \
    NO_COLOR=1

RUN printf '%s\n' \
  '#!/bin/sh' \
  '# Start the MCP server, provisioning a throwaway network first if none exists.' \
  '# Mount a configured $OGURI_HOME to talk to a real network instead.' \
  'set -eu' \
  'if [ ! -f "${OGURI_HOME}/config.yaml" ]; then' \
  '  transport="/tmp/oguri-transport.git"' \
  '  git init --bare --quiet --initial-branch=main "$transport"' \
  '  # stdout is the JSON-RPC transport: setup chatter must never reach it.' \
  '  oguri init --repo "$transport" --network introspection --agent introspection-agent >&2' \
  '  oguri room create general --title "General" >&2' \
  'fi' \
  'exec oguri mcp' \
  > /usr/local/bin/entrypoint.sh \
  && chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
