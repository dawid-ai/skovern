# Security policy

Skovern handles small businesses' email, files, and customer data. If you
find a vulnerability, please report it privately — do not open a public issue.

**Contact:** security reports via GitHub private vulnerability reporting on
this repository (Security tab → Report a vulnerability).

You'll get an acknowledgment within 72 hours. Confirmed reporters get
credited in release notes (or stay anonymous — your call) and founding-user
status with our thanks.

## Scope highlights

Most interesting to us: permission-layer bypasses (a skill/connector reaching
network or disk without user consent), secrets leaving the OS keychain,
prompt-injection paths that trigger outbound actions without approval,
plugin/MCP signature or revocation bypasses, and update-channel integrity.
