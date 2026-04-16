# Importance Ranking Rubric

The goal of the ranking step is a **deterministic, explainable** ordering of open security issues so reviewers can see why issue A is above issue B. Never present a score without the component breakdown.

## Score formula

`total = severity + exploitability + blast_radius + recency + surface_sensitivity`

Range: 0 – 28. Tie-break order: `surface_sensitivity`, then `severity`, then oldest `updatedAt`.

## Components

### 1. Severity (0 – 10)

Prefer explicit signals in this order:

1. CVSS score from the issue body or linked GHSA (use the `Base Score` as-is, rounded to int)
2. Repo labels: `severity:critical` = 9, `severity:high` = 7, `severity:medium` = 5, `severity:low` = 3
3. Keyword fallback on title/body: `RCE`, `auth bypass`, `privilege escalation`, `secret leak` → 8; `DoS`, `info leak` → 5; `hardening`, `defense in depth` → 2

### 2. Exploitability (0 – 5)

How easy is it to reach from an attacker's likely position?

| Score | Meaning |
| ----- | ------- |
| 5 | Unauthenticated remote (public ingress, no pairing) |
| 4 | Authenticated remote (paired device / operator token) |
| 3 | Local LAN with same-host pairing |
| 2 | Local same-user process boundary |
| 1 | Requires already-trusted plugin or operator-admin |
| 0 | Requires physical access or developer-only flag |

`CLAUDE.md` trust model is explicit that `ws://` on private LAN is allowed and **not** a vulnerability on its own. Passive LAN observation alone scores 0 here.

### 3. Blast radius (0 – 5)

How many users / channels / surfaces does the bug affect?

| Score | Meaning |
| ----- | ------- |
| 5 | All users on all channels (core gateway, auth, session, shared tool) |
| 4 | All users on one major channel (WhatsApp, Telegram, Slack, Discord, iMessage) |
| 3 | Most users on an optional channel (Matrix, Signal, Feishu, etc.) |
| 2 | One plugin / one provider |
| 1 | Opt-in feature, small cohort |
| 0 | Dev-only or test-only path |

### 4. Recency / age (0 – 3)

Older unpatched issues on shipped tags are worse, not better.

| Score | Meaning |
| ----- | ------- |
| 3 | Open > 60 days and present in latest shipped tag |
| 2 | Open 30 – 60 days and present in latest shipped tag |
| 1 | Open < 30 days and present in latest shipped tag |
| 0 | Only present on `main`, not in any shipped tag (still real, just lower campaign priority) |

Verify "present in latest shipped tag" with `git tag --sort=-creatordate | head -1` then `git show <tag>:<path>`.

### 5. Surface sensitivity (0 – 5)

Does the touched code sit on a security-critical surface?

| Score | Surface |
| ----- | ------- |
| 5 | Auth, pairing, device identity, signature verification, secret storage |
| 4 | Gateway ingress, protocol handshake, trusted-proxy, webhook HMAC |
| 3 | Sandboxing, command policy, approval handlers |
| 2 | Channel outbound (reply routing, recipient resolution) |
| 1 | Provider runtime (model auth forwarding, usage endpoints) |
| 0 | Docs, tests, developer tooling |

Cross-check `CODEOWNERS` for the touched path. Anything in a security-focused `CODEOWNERS` entry should not go below 3 here.

## Disqualifiers (score to 0, skip)

Even if a report scores high on paper, route to `$security-triage` and skip this campaign if any apply:

- Report is about `ws://` on private LAN pairing without a real trust-boundary bypass (explicitly out of scope per `CLAUDE.md`)
- Report is about prompt injection in user-owned workspace memory files (out of scope per `SECURITY.md`)
- Report's prerequisite is "attacker already has operator admin" (already-trusted)
- Duplicate of an existing open or fixed issue
- Fixed before the latest shipped tag (close as "fixed pre-release")

## Worked examples

### Example A — Unauthenticated webhook signature bypass

- CVSS 8.1 → severity 8
- Public ingress, no auth → exploitability 5
- All users on all webhook channels → blast radius 5
- Open 45 days, present in latest tag → recency 2
- Webhook HMAC is on gateway ingress → surface 4
- **Total: 24**

### Example B — Hardening: add CSRF token to an internal admin form

- `hardening` label → severity 2
- Local admin only → exploitability 1
- Opt-in admin UI → blast radius 1
- Open 15 days, only on `main` → recency 0
- Approval handler surface → surface 3
- **Total: 7**

### Example C — Prompt injection marker in a shared workspace memory file

- Keyword "injection" suggests 5, but `SECURITY.md` marks this class out of scope → disqualifier triggers, **total 0**, route to `$security-triage`.

## Presenting the rank to the user

Always show the top 10 in chat with this shape:

```
#1  issue 68123  total=24  sev=8 expl=5 blast=5 recency=2 surface=4
    Unauthenticated webhook signature bypass (src/webhooks/verify.ts)
    https://github.com/openclaw/openclaw/issues/68123
#2  ...
```

Full JSON goes into the ledger. Ranks never change mid-campaign unless the user asks to re-rank; new issues filed during the campaign are appended at the end of the queue.
