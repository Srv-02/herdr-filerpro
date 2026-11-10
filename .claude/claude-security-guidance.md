# Security review scope for Filer Pro

Filer Pro is a herdr mod that runs as the logged-in user on that user's own computer and talks to the user's own SSH machines. Review findings against this threat model and do not report what it puts out of scope.

## Threat model

- One user per computer. The computer, the local file system and the user's home folder are trusted. Typical setup: a personal Mac or a private VM.
- The attacker controls **content**, not the machine: files, archives, PDFs, SVGs, Markdown, file names and folder names that come from the internet, from a repository, or from an SSH machine.
- SSH machines are reached with the user's own keys. Their file names and file contents are untrusted input; the connection and the remote shell are not an attacker.

## In scope (report these)

- Command or argument injection through file names, paths or content into `sh`, `ssh`, `scp`, `tar`, `unzip`, `osascript` or any other `exec` call.
- Path traversal from untrusted names: archive members with `..`, absolute paths or links that write outside the target folder (zip-slip), names with leading `-`, newlines or control characters.
- Content that executes or loads remote resources when previewed (SVG, HTML, Markdown, Mermaid, PDF).
- Data loss caused by untrusted content (overwriting or deleting files outside the folder the user chose).
- Secrets or personal data leaking into logs, toasts, shared values or network requests.

## Out of scope (do not report)

- Race conditions and TOCTOU between a check and a file operation (`[ -e ]` then `mv`, check-then-write, symlinks planted between two steps). They need a second local user or a hostile local process with write access to the user's own folders, which this threat model excludes.
- Timing attacks and side channels.
- Other local users or processes on the same computer, shared multi-user hosts, and a compromised local account.
- Denial of service by the user's own files (very large folders or archives); treat these as performance issues, not security findings.
- Hardening that only helps against an attacker who already runs code as the user.

When in doubt, a finding is in scope only if untrusted content alone, opened or extracted by the user, can trigger it.
