<div align="center">

# 🛡️ MoodleShield

### Per-student forensic video watermarking and visible PDF protection for Moodle

**Self-hosted, open-source content protection for Moodle, over LTI 1.3.**
Every student gets the video as a **different mix of segments**, designed so a leak can be
traced back to its source.
No proprietary DRM, no per-view licensing, no shipping your videos to someone else's cloud.

[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A5%2022.11-339933?logo=node.js&logoColor=white)](.nvmrc)
[![LTI 1.3](https://img.shields.io/badge/LTI-1.3%20%2B%20Deep%20Linking-orange)](docs/moodle-setup.md)
[![Tests](https://img.shields.io/badge/tests-426-success)](docs/desarrollo.md#tests)
[![No frontend frameworks](https://img.shields.io/badge/frontend-0%20frameworks-lightgrey)](src/ui)
[![Self-hosted](https://img.shields.io/badge/self--hosted-Docker%20Compose-2496ED?logo=docker&logoColor=white)](infra/README.md)

[Español](README.md) · **English**

</div>

> [!WARNING]
> **Version 0.x — read this before deploying it to real students.** The video pipeline, the
> LTI integration and the library work and are tested. An
> [internal security audit](docs/auditoria-seguridad-contenido-y-plan.md) from August 2026
> found 16 findings, and two hardening passes closed most of them
> ([finding-by-finding detail](docs/README.md#auditoría-de-seguridad--7-de-agosto-de-2026)).
> What **still affects what this README promises**:
>
> - **`feature/seguridad-auditoria` is the security candidate for test.** Its unit,
>   integration, native-tooling and real-stack tests, lint, dependency audit and Compose
>   validation pass. Build the exact commit and complete the image CI and Moodle/browser
>   gates before promotion. See the
>   [current security review](docs/revision-seguridad-2026-08-10.md).
> - **Attribution cannot be promised yet.** The A/B pattern reader was broken and is now
>   fixed and tested, but the mark only lives in two corners of the frame: **cropping the
>   edges removes it**, and two students comparing copies can forge a third that points at
>   nobody (F-07). Use it to deter and to investigate; **not to sustain disciplinary
>   proceedings**.
> - **The development profile (`infra/local`) ships known secrets**, and they are now public
>   (F-01). It's fine for `localhost` development; **never** expose it to the internet.
>
> The real state, finding by finding, is in [`docs/README.md`](docs/README.md#estado-del-proyecto).
> This is documented on purpose: a security project that hides its own audit hasn't earned
> your trust.

> **Note on language.** The codebase, comments, error messages, UI and reference
> documentation are in **Spanish** — see [`docs/`](docs/). This file is the English entry
> point. Contributions in English are welcome; see [`CONTRIBUTING.md`](CONTRIBUTING.md).

---

## The problem

You upload your recorded lectures to Moodle. A week later they're circulating in a Telegram
group.

The usual answers don't work, or cost too much:

- **DRM (Widevine, FairPlay)** — expensive, vendor-locked, and it doesn't stop anyone from
  filming the screen with a phone.
- **"Private" YouTube or Vimeo** — a link is forwarded in two seconds.
- **Protected-video SaaS platforms** — they charge per view or per GB, and your lectures
  live in their cloud.
- **Doing nothing** — the most common option.

None of them answers the question that actually matters once it has happened: **who leaked it?**

## The answer: A/B forensic watermarking

MoodleShield transcodes each video **exactly once** into two encrypted HLS variants that
are imperceptibly different: variant `A` carries a near-invisible box in the bottom-right
corner, `B` in the bottom-left. Segment cut points are identical in both, which makes the
segments interchangeable.

When a student opens the activity, **their** playlist is generated: each segment points to
`A` or `B` following a pattern derived by HMAC from their identity. That pattern is the
signature.

```
Source video ──ffmpeg ×2 (once, at upload)──▶  A: ▓▓▓▓▓▓▓▓▓▓   mark bottom-right
                                               B: ░░░░░░░░░░   mark bottom-left

Ana  → A A B B B A A B A B  ─┐
Luis → B A A B A B B A A A   ├─ 2⁴¹ combinations in a 3-minute video
Marta→ A B B A A A B B A B  ─┘
```

If a pirated copy shows up, `tools/trace.mjs` reads the pattern back out of the pixels and
compares it against everyone who watched that video:

```text
Match     Hits       Student                             ID           1 in
----------------------------------------------------------------------------
  100.0%   41/41     Ana García Pérez                    12345678Z    2,199,023,255,552
   53.7%   22/41     Luis Martín Ruiz                    87654321X    5

Most likely source: Ana García Pérez (12345678Z) — 100.0% match.
```

> [!CAUTION]
> **Read that last part carefully.** The pipeline that produces the variants and the
> divergent playlists is built and tested, and the **reader** that interprets the pattern
> back out — which until August 2026 misclassified and could point at an innocent student —
> is now fixed and covered by tests, including an end-to-end one with real ffmpeg
> ([T13](docs/tasks/done/T13-trazado-forense.md)).
>
> What has **not** changed is where the mark lives: two boxes in the lower corners.
> Cropping the edges still removes it, collusion still works, and an audio-only extract
> carries no pattern at all. Closing that means marks distributed across the frame and
> collusion-resistant codes (Tardos): it is the single most valuable contribution anyone
> could make right now, and until then attribution cannot be promised.

**CPU cost per view: zero ffmpeg.** Playback is rewriting a text file (microseconds) and
serving static files with nginx. It makes no difference whether you have 10 students or
10,000.

> [!IMPORTANT]
> **This is not DRM and does not pretend to be.** MoodleShield does not prevent copying:
> it makes the copy **attributable**. That is a deliberate difference in approach, and in
> practice it deters more than a lock you can walk around with a phone camera.

---

## What's in the box

| | |
|---|---|
| 🎬 **Forensically watermarked video** | HLS + AES-128, two variants, per-student A/B pattern derived by HMAC |
| 👁️ **Identity overlay** | The student's ID floating over the video and the PDF — the part that deters phone recording |
| 📄 **Protected PDF** | Validated and normalised (JavaScript, actions and attachments stripped), served with access control and `Range` |
| 📥 **Sealed PDF download** | An official copy stamped with the student's identity on every page, encrypted with permissions locked |
| 🔌 **Native LTI 1.3** | No Moodle plugins, no patches. One admin registration and you're done |
| 🔗 **Deep Linking** | Teachers upload and insert material without leaving the course editor |
| 📁 **Teacher library** | A file explorer with nested folders, search, and an archive |
| 📦 **Whole-folder import** | Uploads a directory tree keeping its structure; hidden files are skipped and a repeated file lands as a **new revision**, not a duplicate |
| 🗂️ **Collections** | Several materials grouped into **a single Moodle activity** |
| ♻️ **Revisions** | Replace a file without changing the UUID Moodle has embedded; rollback included |
| 🏢 **Multi-tenant** | Multiple Moodle instances and teachers isolated by `platform_id` + `owner_sub` |
| 🪶 **Lightweight** | The web service sits at ~45 MB RSS. It fits on a NAS |
| 🔍 **Forensic tracing** | A CLI that matches the pattern against everyone who watched, and **refuses to conclude** when the sample is too weak. 🚧 The reader isn't reliable yet ([T13](docs/README.md#hoja-de-ruta)) |

## What it protects against, and what it doesn't

A security project that oversells itself is worse than no project at all. This table is
the contract:

| | Video | PDF |
|---|---|---|
| Per-student access control | ✅ | ✅ |
| HTTPS in transit | ✅ Required in production | ✅ Required in production |
| Format encryption | AES-128 HLS; the key reaches the authorised client and does not replace disk encryption | Removable download permissions; no application-level encryption at rest |
| Visible deterrent | ✅ Overlay | ✅ Overlay + stamped download |
| **Attributing a leak** | 🚧 **Works if the video arrives intact**: A/B pattern and reader are tested, but cropping the edges or collusion defeat it | ❌ **No** — the stamp is removable |
| Preventing the copy | ❌ Not DRM | ❌ Not DRM |

**Protects against:** forwarding an ordinary URL without credentials · downloading an
unsigned loose `.ts` · pulling an
entire variant to escape the trace · screen-recording and redistributing (the ID is
visible and the pattern is in the pixels) · deleting the overlay from the DOM (the pattern
is still there) · opening a material with another activity's token.

**Does not protect against:** theft of a bearer or ticket while it remains valid · cropping
the video edges, which removes the marks · collusion
(two students comparing copies to build a third) · capture itself.

The first two have known solutions — marks in multiple positions, Tardos codes — and are on
the [roadmap](docs/README.md#hoja-de-ruta).

---

## Alternatives, and how this differs

MoodleShield exists because the e-learning video protection market is full of pay-per-view
SaaS. If you need studio-certified DRM, or forensic attribution **in production today**,
buy a commercial product: that's mature there and it isn't here. If what you want is a
self-hosted, auditable foundation with no per-student cost to build that on, this is it.

| | **MoodleShield** | **VdoCipher** | **Kaltura / Panopto** | **Private Vimeo / YouTube** |
|---|---|---|---|---|
| Model | Self-hosted, AGPL-3.0 | Paid SaaS | SaaS / on-prem, licensed | SaaS |
| Where your videos live | **Your server** | Their cloud | Their cloud | Their cloud |
| Cost per view | **€0** | Per GB / plan | Per licence | Plan |
| Per-student forensic watermark | 🚧 **A/B in pixels; no crop or collusion resistance** | ✅ (dynamic, plan-dependent) | Product-dependent | ❌ |
| DRM (Widevine / FairPlay) | ❌ | ✅ | Product-dependent | Partial |
| Moodle integration | **Native LTI 1.3** | Plugin / embed | Plugin | Embed |
| Auditable source | ✅ **All of it** | ❌ | Partial | ❌ |
| Student data sent to a third party | **None** | Yes | Yes | Yes |

*Commercial products evolve; check this table against their documentation before deciding.
What is structural: MoodleShield cannot offer DRM (there is no free CDM) and they cannot
offer you that the video never leaves your machine.*

**On data protection.** Being self-hosted, neither the videos nor student identities leave
your infrastructure, which considerably simplifies the GDPR story: no transfer to third
parties, no processor to audit. The flip side is that you are the controller — including
for the view log (`view_event`) that makes tracing possible.

---

## Get started in 5 minutes

You need **Node ≥ 22** and **Docker**. `ffmpeg` is not required on the host if you use the
worker container.

```bash
git clone https://github.com/jamataran/moodleshield.git && cd moodleshield
npm ci

cp .env.example .env
./scripts/generate-secrets.sh --env .env

docker compose -f compose.dev.yml up -d      # Postgres only
npm run dev                                   # → http://localhost:3000
```

Check that it breathes:

```bash
curl -s localhost:3000/readyz     # {"status":"ready","version":"0.1.0"}
curl -s localhost:3000/lti/keys   # the tool's JWKS
open  http://localhost:3000       # the values you need to register it in Moodle
```

In another terminal, the transcoder (this one does need `ffmpeg` on the host):

```bash
npm run dev:worker
```

Prefer to install nothing? The full containerised stack, with nginx in front:
[`infra/local/README.md`](infra/local/README.md).

### See the A/B watermark working, without Moodle

Bring up the full stack and run the end-to-end walkthrough: it generates a test video,
uploads it, waits for transcoding and checks the five things that make this work.

```bash
cd infra/local && docker compose up -d --build && cd -
./scripts/demo-local.sh
```

It verifies that ffmpeg runs exactly twice, that two students get different A/B mixes, that
segments are encrypted, that nginx returns **403** for a segment that isn't in your pattern,
and that forensic tracing identifies the right student.

---

## Connecting to Moodle

This is done **once, by the site administrator**; after that every teacher can use the tool
with no configuration.

Moodle **requires HTTPS** for LTI 1.3 and does not accept self-signed certificates — not
even `localhost` in development. To test against a real Moodle from your laptop, use a
tunnel (Cloudflare Tunnel or Tailscale Funnel) — [`docs/https-tunel.md`](docs/https-tunel.md).

With the tool reachable over HTTPS, the short version is:

1. Moodle → *Site administration → Plugins → External tool → Configure a tool manually*,
   using the values the tool itself publishes at `https://YOUR-DOMAIN/lti/config`.
2. Save, **edit again** and tick *Supports Deep Linking* (Moodle only shows that option
   after the first save).
3. Note the `Client ID` and `Deployment ID` from the configuration details.
4. Register that Moodle in the console at `https://YOUR-DOMAIN/admin` and hit
   **Probar conexión** (test connection).

**All six steps with the exact values and a troubleshooting table ("90% of the time it's the
Redirection URI"): [`docs/moodle-setup.md`](docs/moodle-setup.md) (Spanish).**

---

## Architecture at a glance

```
┌─────────────┐
│   Moodle    │  LTI 1.3 Platform
└──────┬──────┘
       │ launch (signed id_token)
       ▼
┌──────────────────────────────────────────────────────────┐
│ nginx (proxy)                                            │
│   /media/**/seg_NNNN.ts  → static + secure_link          │
│   /media/**  (everything else) → 403                     │
│   /*                     → proxy to app:3000             │
└──────┬───────────────────────────────────────────────────┘
       ▼
┌──────────────────────┐        ┌────────────────────────┐
│ app  (Node, 512 MB)  │        │ worker (Node, 1.5 GB)  │
│  · LTI handshake     │        │  · Postgres queue      │
│  · library / upload  │        │  · ffmpeg ×2 per video │
│  · A/B playlist      │        │  · qpdf/gs for PDF     │
└──────┬───────────────┘        └───────────┬────────────┘
       └────────────┬───────────────────────┘
                    ▼
        ┌───────────────────────┐   ┌──────────────────────┐
        │ PostgreSQL 16         │   │ ${DATA_ROOT}/media   │
        └───────────────────────┘   └──────────────────────┘
```

**Stack**: Node 22 · Express 5 · PostgreSQL 16 · nginx · ffmpeg · `jose` for LTI ·
PDF.js and Ghostscript for PDF. **Zero frontend frameworks**: direct DOM. **No ORM**:
plain `pg`. Learner LTI launches use HMAC bearer tokens rather than cookies; the admin
console does use a `Secure`/`HttpOnly` cookie with CSRF protection.

Full detail — flows, data model, endpoint table, the security model layer by layer — in
[`docs/arquitectura.md`](docs/arquitectura.md) (Spanish).

---

## Documentation

All reference documentation is in Spanish.

| Document | What it covers |
|---|---|
| 🧭 [`docs/README.md`](docs/README.md) | **Documentation index, project status and roadmap** |
| 🏗️ [`docs/arquitectura.md`](docs/arquitectura.md) | Flows, data model, endpoints, security model |
| 🤔 [`docs/decisiones.md`](docs/decisiones.md) | ADR-001…024: why each decision, and how to reverse it |
| 💻 [`docs/desarrollo.md`](docs/desarrollo.md) | **Developer guide**: environment, tests, conventions, debugging |
| 🎓 [`docs/moodle-setup.md`](docs/moodle-setup.md) | Registering the tool in Moodle, in six steps, with troubleshooting |
| 🔐 [`docs/https-tunel.md`](docs/https-tunel.md) | Public HTTPS and tunnels for local development |
| 🚀 [`infra/README.md`](infra/README.md) | The three environments (local, test, prod) and the promotion flow |

---

## FAQ

<details>
<summary><b>Do I need to install a Moodle plugin?</b></summary>

No. MoodleShield is an LTI 1.3 external tool: you register it from site administration like
any other. Moodle's code is not modified and nothing is installed on its server.
</details>

<details>
<summary><b>How much CPU does it use per student?</b></summary>

None that scales with students. `ffmpeg` runs exactly **twice per video**, at upload, and
never again. Generating the personalised playlist is text rewriting plus URL signing:
microseconds. Segments are served by nginx with `sendfile`, never touching Node.
</details>

<details>
<summary><b>How much disk does it use?</b></summary>

Roughly **twice the re-encode**, since both variants are kept and the original is deleted.
At CRF 21 and 1080p the re-encode runs 1–2 GB/hour per variant. Against an 8 Mbps camera
original (3.6 GB/h) the result usually takes up **less** than the original; against an
already-compressed one, ≈ 2×. Raising `OUTPUT_CRF` to 23 saves ~30% with minimal visual loss.
</details>

<details>
<summary><b>Is the watermark visible?</b></summary>

Not at the default (`MARK_ALPHA=0.06`) — it's imperceptible. Raise it to `0.5` to see it in
a demo. What *is* visible, deliberately, is the overlay with the student's ID: that's the
deterrent layer. The A/B mark is the safety net for anyone who knows how to delete the
overlay from the DOM.
</details>

<details>
<summary><b>What if the student crops the video edges?</b></summary>

That removes the marks and tracing stops working. It's a real, known limitation. The fix —
marks in several frame positions — is on the roadmap. Same for collusion: two students
comparing copies can build a third that points at neither, and the answer there is Tardos
codes.
</details>

<details>
<summary><b>Can I use it with Canvas, Blackboard or another LMS?</b></summary>

In theory yes: the integration is standard LTI 1.3, with nothing Moodle-specific in the
handshake. In practice it has only been tested against Moodle, and details such as the
custom parameter carrying the student ID (`$Person.sourcedId`) or the lowercasing of
`custom` claims will need adjusting. If you try it on another LMS, open an issue — we're
interested.
</details>

<details>
<summary><b>Why isn't the PDF forensically watermarked?</b></summary>

Because the authorised document has to travel whole to the browser for PDF.js to render it.
Marking it properly would mean generating and storing a distinct copy per student, with the
processing cost and personal-data handling that implies. What you do get is access control,
a visible overlay, Ghostscript normalisation (JavaScript, actions and attachments stripped)
and an official download sealed with the student's identity. A PDF leak is **not
attributable**, and this project isn't going to claim otherwise.
</details>

<details>
<summary><b>Is it production-ready?</b></summary>

**The `feature/seguridad-auditoria` branch is approved as the test candidate.** The core —
LTI, A/B pipeline, playlists, signed delivery, library, PDF and revisions — and the audit's
technical controls are implemented and verified.

On that branch, the hardening the audit flagged is applied: the session token no longer
travels in the URL (F-02), logs carry no tokens (F-03), signed delivery is mandatory in production (F-04),
`pdfjs` is current (F-09), the CSP no longer needs `unsafe-inline` (F-13), purging a
revision no longer destroys the forensic evidence (F-14), sessions are revocable, upload
quotas and rate limits are enforced, and the worker runs without Internet access using a
least-privilege database role.

The branch is technically approved as a test candidate. It must be built into immutable
images, tested there and promoted before claiming production has those protections. The
**forensic promise** is still not closed — the
reader works, but cropping the edges removes the mark (F-07). **Cross-teacher isolation**
(F-05) is mandatory in production; every activity predating migration `014` must be
reinserted so Moodle stores its server-side placement. An older signed reference alone is
not sufficient. The finding-by-finding state is in
[`docs/README.md`](docs/README.md#auditoría-de-seguridad--7-de-agosto-de-2026).

The exact separation between production, branch and open work is in the
[`10 August security review`](docs/revision-seguridad-2026-08-10.md).

In practice: use it to impose order and deter, not to sustain disciplinary proceedings
against a student. And deploy it behind the reverse proxy with `MEDIA_DELIVERY=signed`,
never with the `infra/local` profile.
</details>

<details>
<summary><b>What licence is it? Can I use it in my academy?</b></summary>

AGPL-3.0-or-later. You may use, modify and deploy it, commercially included. The AGPL
condition is that if you offer the modified service over a network, you must publish your
changes.
</details>

---

## Contributing

Help is welcome, and there is clearly scoped work waiting.

1. **What's missing and what's broken**: [`docs/README.md`](docs/README.md#hoja-de-ruta) —
   every task has a card with scope, acceptance criteria and known traps.
2. **How to set up the environment and which conventions to follow**:
   [`docs/desarrollo.md`](docs/desarrollo.md).
3. **How to open a PR**: [`CONTRIBUTING.md`](CONTRIBUTING.md).

Good first topics: the player's browser matrix, the forensic trace reading algorithm (T13,
currently incorrect), and running the whole thing against a real Moodle.

Found a security flaw? Don't open a public issue: [`SECURITY.md`](SECURITY.md).

## Author and contact

Built and maintained by **José Antonio Matarán**.

[![Web](https://img.shields.io/badge/web-mataran.dev-000000?logo=firefox&logoColor=white)](https://mataran.dev)
[![LinkedIn](https://img.shields.io/badge/LinkedIn-jamataran-0A66C2?logo=linkedin&logoColor=white)](https://www.linkedin.com/in/jamataran/)
[![Email](https://img.shields.io/badge/email-jose%40mataran.dev-EA4335?logo=gmail&logoColor=white)](mailto:jose@mataran.dev)

- **Technical question or a bug?** An [issue](../../issues) is better: it stays there for
  the next person who wonders the same thing.
- **Want to deploy it at your institution, or need something the project doesn't do?**
  Reach out on [LinkedIn](https://www.linkedin.com/in/jamataran/) or at
  [jose@mataran.dev](mailto:jose@mataran.dev).

If the project is useful to you, a ⭐ helps other people find it.

## Licence

[AGPL-3.0-or-later](LICENSE).

---

<div align="center">
<sub>

**Keywords** · Moodle watermarking · forensic watermarking · e-learning video protection ·
LTI 1.3 · encrypted HLS AES-128 · self-hosted VdoCipher alternative · online course
anti-piracy · leak tracing · DRM alternative · Moodle PDF protection · per-student
watermark · secure self-hosted video

</sub>
</div>
