# Security policy

## Supported versions

BladeVault is released continuously. Security fixes land on `main` and ship in the next release;
older releases are not patched. Please update to the
[latest release](https://github.com/dedkola/bladevault/releases/latest) before reporting.

| Version        | Supported |
| -------------- | --------- |
| Latest release | Yes       |
| Older releases | No        |

## Reporting a vulnerability

**Do not open a public issue, discussion, or pull request for a vulnerability.**

Report it privately through GitHub:
[Security → Report a vulnerability](https://github.com/dedkola/bladevault/security/advisories/new).

Please include:

- the BladeVault version and how you run it (desktop app, Docker/Podman, Helm, or from source);
- the affected area (web UI, API route, MCP server over HTTP or stdio, CLI, desktop shell, backup
  or restore, scraping);
- steps to reproduce, or a proof of concept, and the impact you expect;
- whether the issue needs network access, a local account, or a non-default configuration.

You can expect an acknowledgement within a few days. Once the issue is confirmed, a fix is
prepared in a private advisory, released, and the advisory is published with credit to you
unless you prefer to stay anonymous.

## Scope notes

Some behaviour is documented and intentional, so it is not a vulnerability on its own:

- **App lock** is a simple access lock, not encryption. Its password is stored in plain text in
  the local SQLite database, and the collection itself is not encrypted.
- The **stdio MCP server** uses direct database access and no HTTP token; it trusts the local user
  who starts it.
- BladeVault is designed to run on a machine or network you control. Exposing a self-hosted
  instance to the public internet without your own authentication in front of it is not
  recommended.

Bypasses of the HTTP MCP bearer token, host, or origin checks, App lock bypasses over the network,
path traversal, code execution, or anything that lets one party read or change another's vault
are in scope.
