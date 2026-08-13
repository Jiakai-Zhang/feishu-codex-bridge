# Repository instructions

## Install or deploy requests

When the user asks to install, deploy, set up, or onboard this repository on Windows:

1. Read `docs/INSTALL_AGENT.md` completely and follow it as the installation protocol.
2. Use the repository scripts instead of reproducing their behavior by hand.
3. Treat the Feishu App Secret, OAuth tokens, App ID, user/bot open IDs, chat IDs, Codex task IDs, and local configuration contents as private. Never print them into chat, logs, commits, command arguments, or documentation.
4. The App Secret may only be entered by the user through `setup-channel-secret.ps1`, which stores it with Windows DPAPI. Never request the plaintext in chat.
5. Stop for the user's action at browser authorization, CAPTCHA/MFA, administrator approval, Feishu app publication, secure secret entry, and the required full Codex Desktop restart. Do not report success before the matching verification passes.
6. Do not edit Codex global state files to simulate Project membership.
7. Do not create, publish, or change a Feishu application without the user's explicit approval of that external change.

For ordinary development, debugging, or review requests, follow the repository tests and preserve untracked local runtime/configuration files.
