FROM mcr.microsoft.com/devcontainers/base:bookworm

# Native build tools for better-sqlite3.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

USER vscode

# Pre-create volume mount targets so they are owned by vscode, not root.
RUN mkdir -p /home/vscode/.claude /home/vscode/.config/gh

ENV PATH="/home/vscode/.local/bin:${PATH}"

# Install Claude Code using its native installer.
RUN curl -fsSL https://claude.ai/install.sh -o /tmp/install-claude.sh \
    && bash /tmp/install-claude.sh \
    && rm /tmp/install-claude.sh

RUN git config --global core.editor "code --wait"