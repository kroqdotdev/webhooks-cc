# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| latest  | Yes       |

## Reporting a Vulnerability

Report security issues responsibly. Do not open public GitHub issues.

### How to Report

1. Use GitHub's private vulnerability reporting:
   - Go to **Security** → **Report a vulnerability**
   - Fill out the form
2. Or email the maintainers directly (see repository owner)

### What to Include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### Response Timeline

| Stage              | Time     |
| ------------------ | -------- |
| Acknowledgment     | 48 hours |
| Initial assessment | 1 week   |
| Critical fix       | 7 days   |
| High severity fix  | 30 days  |
| Medium/Low fix     | 90 days  |

### Safe Harbor

Security research conducted in good faith is authorized. We will not pursue legal action against researchers who:

- Avoid privacy violations, data destruction, and service interruption
- Test only accounts they own or have permission to access
- Demonstrate issues without exploitation beyond proof of concept
- Report promptly and allow time for fixes before disclosure

## Security Measures

- **Input validation** — All user inputs validated and sanitized
- **Authentication** — Token-based with expiration
- **Authorization** — Role-based access on all endpoints
- **Dependency scanning** — Dependabot and CodeQL
- **Secret management** — No secrets in repository
- **Encryption** — HTTPS only in production

## Deployment Checklist

1. Set strong, unique secrets (`CAPTURE_SHARED_SECRET`, `POLAR_WEBHOOK_SECRET`)
2. Use HTTPS for all endpoints
3. Keep dependencies updated
4. Apply security patches promptly
5. Store sensitive configuration in environment variables
