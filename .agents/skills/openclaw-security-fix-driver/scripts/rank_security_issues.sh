#!/usr/bin/env bash
# Fetch open security issues from openclaw/openclaw, dedupe, and rank by
# importance per references/ranking.md. Emits a JSON array on stdout.
#
# Usage:
#   rank_security_issues.sh [--limit N] [--repo owner/name]
#
# Requires: gh (authenticated), jq

set -euo pipefail

LIMIT=100
REPO="openclaw/openclaw"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --limit) LIMIT="$2"; shift 2 ;;
    --repo)  REPO="$2";  shift 2 ;;
    -h|--help)
      sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Label variants we treat as "security-related". Keep this list broad on purpose
# — ranking handles deduping and disqualifiers.
LABELS=(
  "security"
  "type:security"
  "severity:critical"
  "severity:high"
  "severity:medium"
  "severity:low"
  "ghsa"
  "CVSS"
  "vuln"
)

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# gh issue list supports one --label per call; union via loop.
: > "$tmp/raw.ndjson"
for label in "${LABELS[@]}"; do
  gh issue list \
    --repo "$REPO" \
    --state open \
    --label "$label" \
    --limit "$LIMIT" \
    --json number,title,body,labels,url,createdAt,updatedAt,author \
    --jq '.[] | @json' >> "$tmp/raw.ndjson" 2>/dev/null || true
done

# Also pull body/title keyword hits the label query could miss.
gh search issues \
  --repo "$REPO" \
  --state open \
  --match title,body \
  --limit "$LIMIT" \
  --json number,title,body,labels,url,createdAt,updatedAt,author \
  -- "security OR GHSA OR CVSS OR vulnerability OR RCE OR \"auth bypass\"" \
  --jq '.[] | @json' >> "$tmp/raw.ndjson" 2>/dev/null || true

# Dedupe by number, then score. Scoring is intentionally simple and readable;
# the skill can refine per references/ranking.md before presenting.
jq -s '
  unique_by(.number)
  | map(
      . as $i
      | ($i.labels // []) as $labels
      | ($labels | map(.name) | join(" ")) as $labelstr
      | (
          if ($labelstr | test("severity:critical";"i")) then 9
          elif ($labelstr | test("severity:high";"i")) then 7
          elif ($labelstr | test("severity:medium";"i")) then 5
          elif ($labelstr | test("severity:low";"i")) then 3
          elif (($i.title + " " + ($i.body // "")) | test("RCE|auth bypass|privilege escalation|secret leak";"i")) then 8
          elif (($i.title + " " + ($i.body // "")) | test("DoS|info leak";"i")) then 5
          else 2
          end
        ) as $severity
      | (
          if (($i.body // "") | test("unauth|public (ingress|endpoint)";"i")) then 5
          elif (($i.body // "") | test("paired|operator token";"i")) then 4
          elif (($i.body // "") | test("LAN|loopback";"i")) then 3
          else 2
          end
        ) as $exploit
      | (
          if (($i.title + " " + ($i.body // "")) | test("gateway|all channels|core";"i")) then 5
          elif (($i.title + " " + ($i.body // "")) | test("whatsapp|telegram|slack|discord|imessage";"i")) then 4
          elif (($i.title + " " + ($i.body // "")) | test("matrix|signal|feishu";"i")) then 3
          else 2
          end
        ) as $blast
      | ((now - ($i.createdAt | fromdateiso8601)) / 86400) as $ageDays
      | (
          if $ageDays > 60 then 3
          elif $ageDays > 30 then 2
          elif $ageDays > 0  then 1
          else 0
          end
        ) as $recency
      | (
          if ($labelstr | test("auth|pairing|identity|signature|secret";"i")) then 5
          elif ($labelstr | test("gateway|protocol|trusted-proxy|webhook";"i")) then 4
          elif ($labelstr | test("sandbox|approval|policy";"i")) then 3
          elif ($labelstr | test("channel|outbound|reply";"i")) then 2
          elif ($labelstr | test("provider|usage";"i")) then 1
          else 0
          end
        ) as $surface
      | . + {
          score: {
            total:              ($severity + $exploit + $blast + $recency + $surface),
            severity:           $severity,
            exploitability:     $exploit,
            blastRadius:        $blast,
            recency:            $recency,
            surfaceSensitivity: $surface
          }
        }
    )
  | sort_by(-.score.total, -.score.surfaceSensitivity, -.score.severity, .createdAt)
  | .[:'"$LIMIT"']
' "$tmp/raw.ndjson"
