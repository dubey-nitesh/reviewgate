# reviewgate

GitHub App that flags AI-authored (or AI-assisted) PR diffs and instruments
real cycle-time/review metrics split by AI vs human authorship — closing the
gap between developers' perceived AI speedup and what's actually measured
(per the METR RCT finding this project is built to address).

## Features

- AI-authorship detection (commit trailers, PR template markers) with
  cycle-time and review-metrics capture
- Naming-convention / error-handling consistency checking against sibling
  files
- Configurable gate policy — complexity, PR size/risk, and test-coverage
  rules, with opt-in blocking
- Defect-escape-rate linkage — connects a later bug report back to the PR
  that introduced it
- A metrics dashboard (built-in page, plus optional Grafana)
- TypeScript/JavaScript and Python support, across both the consistency
  checker and gate policy

## GitHub App setup

Create the app manually at https://github.com/settings/apps/new (or your
org's equivalent) — there's no manifest-flow redirect server in this MVP,
so fill in the form directly:

- **Homepage URL**: anything (e.g. this repo's URL) — not otherwise used.
- **Webhook URL**: the public URL your deployment is reachable at, e.g.
  `https://your-host:3000/api/github/webhooks`. For local dev, use a
  https://smee.io channel URL here and run smee-client as a separate
  forwarder process — see "Running with Docker" below. Probot's default
  webhook path is `/api/github/webhooks`.
- **Webhook secret**: generate one (e.g. `openssl rand -hex 20`) and use the
  same value for both the GitHub App form and this app's `WEBHOOK_SECRET`.
- **Permissions** (derived directly from the Octokit calls this app makes —
  see `src/index.ts` and `src/detectors/config.ts` — double-check against
  GitHub's current API reference at setup time, since required permissions
  per endpoint can change):
  - **Contents: Read-only** — `repos.getContent` (reading `.reviewgate.yml`;
    also, when the consistency check or complexity gate rule is enabled,
    reading sibling-file/diff-file content for their respective checks)
  - **Pull requests: Read & write** — `pulls.get`/`listCommits`/`listReviews`/
    `listFiles`
  - **Checks: Read & write** — `checks.listForRef`/`create`/`update` (also
    used, read-only in practice, by the coverage gate rule to look up an
    existing CI check-run)
  - **Issues: Read & write** — `issues.listComments`/`createComment`/
    `updateComment` (GitHub's issue-comment endpoints, used here to post/
    update the sticky PR comment); the "Read" half is also what
    defect-escape linkage needs to receive `issues.opened` events and read
    issue bodies.
- **Subscribe to events**: `Pull request`, `Pull request review`, `Issues`
  (the last one is required for defect-escape linkage; omit it if you
  don't plan to enable `escapeLinkage`).
- **Where can this GitHub App be installed?**: your choice (a single org/repo
  is enough to start).

After creating the app, note its **App ID**, generate and download a
**private key** (`.pem` file), and install it on the target repo(s). Map
these to this app's config: `APP_ID`, `private-key.pem`, `WEBHOOK_SECRET` —
see "Running with Docker" below.

## `.reviewgate.yml` reference

Optional config file at the root of a target repo. All keys are optional;
a missing file, or any malformed value, fails closed to the defaults
shown below (never crashes or blocks the app).

```yaml
# AI-authorship detection
aiBranchPatterns:
  - "ai/*"
  - "copilot/*"
aiPrTemplateMarkers:
  - "AI-assisted"

# Naming-convention / error-handling consistency check
consistencyCheck:
  enabled: false    # default: off — opt in per repo
  scope: ai-only     # "ai-only" (default, reuses the authorship-detection
                      #   confidence above) | "all" (every PR, regardless
                      #   of AI-authorship confidence)

# Configurable gate policy
gatePolicy:
  enabled: false    # default: off — opt in per repo
  scope: all         # "all" (default — runs regardless of AI-authorship
                      #   confidence) | "ai-only" (restrict to the
                      #   authorship detector's definite/likely confidence,
                      #   like consistencyCheck's default — note the
                      #   inverted default vs. above)
  blocking: false    # default: off.
                      #
                      #   false (default): gate findings are INFORMATIONAL.
                      #     The check-run conclusion stays "neutral" (grey
                      #     circle in GitHub's UI). The bot comment lists
                      #     each finding but ends without a "blocked" line.
                      #
                      #   true: gate findings set the check-run conclusion
                      #     to "failure" (red cross in GitHub's UI). The bot
                      #     comment adds "This PR is blocked from merging
                      #     until the above gate rule(s) pass."
                      #     This is the ONLY way this app's check-run
                      #     conclusion can ever become "failure".
                      #
                      #   reviewgate does not configure branch protection for
                      #   you. To make blocking actually prevent merging, go
                      #   to Settings → Branches → require the
                      #   "reviewgate/ai-authorship" check as a required
                      #   status check on your target branch.
  complexity:
    enabled: true     # per-rule toggle — true by default once gatePolicy
                      #   itself is enabled (no need to enumerate all three
                      #   just to turn one on)
    threshold: 10     # flag any function whose McCabe cyclomatic complexity
                      #   STRICTLY EXCEEDS this value (> not >=).
                      #   10 means complexity of exactly 10 is not flagged; 11 is.
  sizeRisk:
    enabled: true
    linesThreshold: 500   # flag when additions + deletions across the whole PR
                          #   STRICTLY EXCEED this number (> not >=).
                          #   500 means a PR with exactly 500 lines is not flagged;
                          #   501 is. Set to 0 to flag any PR with at least 1 line.
    filesThreshold: 20    # flag when files changed STRICTLY EXCEED this number.
                          #   Either threshold alone is enough to flag; both must
                          #   be within their respective thresholds to pass.
  coverage:
    enabled: true
    minimumPercent: 80  # flag when the parsed coverage percentage is
                        #   STRICTLY BELOW this value (< not <=).
                        #   80 means exactly 80% passes; 79.9% flags.
    checkRunName: ~   # no default — set this to the exact name of a
                      #   check-run your own CI already posts with a
                      #   coverage percentage in its output (e.g. a
                      #   Codecov or Jest/nyc reporter's check). Unset ->
                      #   this rule silently never finds anything to
                      #   compare (not an error) — reviewgate never runs
                      #   your test suite itself to compute coverage.

# Defect-escape-rate linkage to GitHub Issues
escapeLinkage:
  enabled: false     # default: off — opt in per repo. Requires the
                      #   "Issues" webhook event subscribed in your
                      #   GitHub App settings (see "GitHub App setup"
                      #   above) — no new permission scope, just a new
                      #   event subscription.
  timeWindowDays: 14  # how far back the best-effort heuristic fallback
                      #   (E2) looks for a merged PR that might have
                      #   caused a newly-filed issue, when no "Fixes #N"
                      #   reference resolves one automatically.
```

`consistencyCheck` checks both TypeScript/JavaScript and Python files —
naming-convention consistency and error-handling narrowing (`catch`-clause
narrowing for TS/JS, bare/broad `except:` narrowing for Python), compared
against each changed file's sibling files **of the same language** in the
same directory — a Python file is never compared against TS/JS siblings,
or vice versa, even in a mixed-language directory. Findings appear as a
"Consistency" section in the same check-run/comment the authorship
detector already posts; never blocks merging, regardless of language.

**`scope: all` changes who gets a bot comment, not just what's checked**:
with the default `scope: ai-only`, a `confidence: none` (human-authored)
PR never gets a reviewgate comment at all. Under `scope: all`, a
consistency finding on a `confidence: none` PR *can* trigger a comment
that authorship detection alone would never have posted — worth knowing
before enabling `all` on a repo that doesn't want the bot commenting on
human-only PRs. `gatePolicy` defaults to `scope: all` already (the
inverse of `consistencyCheck`'s default), so this applies to it by
default, not just as an opt-in.

`gatePolicy` adds three independent gate rules (complexity, PR size/risk,
test-coverage delta) and, unlike the other checks, can set the check-run's
`conclusion` to `"failure"` — but **only** when you explicitly set
`gatePolicy.blocking: true`. With the default `blocking: false`, gate
findings render in a "Gate Policy" section of the bot comment (same style
as `consistencyCheck`'s findings) — informational only, check-run stays
`neutral`. Enabling `blocking: true` changes the check-run conclusion to
`failure` and appends "This PR is blocked from merging…" to the bot
comment, but **does not** prevent merging on its own — you still need to
add `reviewgate/ai-authorship` as a required status check in your branch
protection settings. Even with `blocking: true`, only `gatePolicy`'s own
findings can ever cause a `failure` conclusion — the authorship signal and
consistency findings remain permanently non-blocking, by design.

All three `gatePolicy` rules apply to Python files too: complexity and
size/risk work identically to TS/JS; the coverage rule
additionally recognizes `pytest-cov`/`coverage.py`'s own terminal-report
format (a `TOTAL ... NN%` row), not just the short-prose style
(`Coverage: NN%`) JS-ecosystem tools tend to use. No new config keys —
the same `consistencyCheck`/`gatePolicy` settings that already govern
TS/JS files govern Python files the moment they're present in a PR.

## Defect-escape linkage

When `escapeLinkage.enabled: true`, reviewgate tries to connect a later
bug report back to the PR that introduced it, using three tiered
mechanisms (highest precedence first):

1. **Manual** — an issue body containing an `Escape-Source: #123` trailer
   (mirrors the `Co-authored-by:` trailer convention used for
   authorship detection).
2. **Commit-linked** — a merged PR whose body/commits reference a
   GitHub-native closing keyword ("Fixes #N", "Closes #N", "Resolves
   #N") is traced back to whichever earlier PR introduced the fixed
   lines, via GitHub's blame API.
3. **Time-window heuristic** — best-effort: an issue mentioning a file
   path, filed within `timeWindowDays` of a PR that touched that file,
   is treated as a probable (not confirmed) escape.

These are never blended into one number — every reported escape-rate
figure (dashboard included) distinguishes confirmed (1-2) from heuristic
(3) counts. Historical backfill (PRs merged before this feature was
enabled) isn't supported — only PRs merged after `escapeLinkage` is
turned on are tracked.

## Metrics dashboard

Two views:

- **A lightweight custom page** at `/dashboard` on the app's own process
  (no extra service to run) — shows AI-vs-human PR counts, average
  cycle-time and review-comment-count, gate-policy block rate,
  consistency finding rate, and the confirmed/heuristic escape-rate
  split, aggregated across every repo the app is installed on (no
  per-repo breakdown currently).
- **Grafana**, provisioned via `docker-compose.yml`'s optional `grafana`
  service (see below) — a fuller ops-style view with time-series panels,
  reading the same Postgres tables directly.

**⚠️ No authentication in this version.** `/dashboard` and the Grafana
service are both unauthenticated by default — the same MVP posture
accepted for the webhook receiver itself. Do not expose either publicly
without adding your own access control (a reverse-proxy auth layer, an
IP allowlist, a VPN) in front of them.

## Running with Docker (self-hosted / local)

```bash
cp .env.example .env        # fill in POSTGRES_PASSWORD, APP_ID, WEBHOOK_SECRET
# place your GitHub App's downloaded private key at ./private-key.pem
docker compose up --build
```

This builds the app image, starts a Postgres 16 container with
`migrations/001_init.sql` applied automatically on first start, and runs the
Probot app against it (`DATABASE_SSL=false`, since `db` is a private
container on the compose network, not internet-facing TLS). The app listens
on `PORT` (default 3000) for GitHub webhook deliveries.

For local development against a real GitHub App without a public URL, use
[smee.io](https://smee.io) as a webhook proxy. Run smee-client as a
**separate process outside Docker** — the production image omits it:

```bash
# 1. Create a channel at https://smee.io/new — copy the URL it gives you.
# 2. Set that URL as the Webhook URL in your GitHub App settings.
# 3. In one terminal, start the forwarder (no install needed):
npx smee-client@latest -u https://smee.io/YOUR_CHANNEL \
                       -t http://localhost:3000/api/github/webhooks
# 4. In another terminal, start the stack as normal:
docker compose up
```

Do **not** set `WEBHOOK_PROXY_URL` in `.env` — that env var tells Probot
to start smee-client in-process, which requires it to be installed inside
the container. With Option A above, the forwarding happens outside Docker
and `WEBHOOK_PROXY_URL` is not needed.

This is a single-instance deployment: the app's duplicate-prevention
locking (`withLock` in `src/index.ts`) only serializes within one process,
so don't run multiple replicas of the `app` service without first replacing
that with a database-level lock — see the comment on `withLock` for detail.

### Optional: Grafana dashboard

`docker-compose.yml` includes an optional `grafana` service — nothing else
depends on it, so omit it (or just don't set `GRAFANA_ADMIN_PASSWORD`) if
you don't want it running. To enable it:

```bash
# in .env, set:
GRAFANA_ADMIN_PASSWORD=changeme   # required if you run the grafana service
GRAFANA_PORT=3001                 # optional, default 3001

docker compose up --build
```

Grafana provisions its own Postgres datasource and the
`grafana/provisioning/dashboards/reviewgate-metrics.json` dashboard
automatically on first start — no manual "Add data source" click-through.
Log in at `http://localhost:3001` with the `admin` / `GRAFANA_ADMIN_PASSWORD`
credentials. See the "No authentication" warning above before exposing this
port beyond your own machine.

## License

AGPL-3.0-only — see [LICENSE](LICENSE). Copyright (C) 2026 Nitesh Dubey.
