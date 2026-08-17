# 16 — User Flows

## Flow 0 — Admin authenticates

Next.js login form
→ Fastify login endpoint
→ Origin/rate-limit/Zod validation
→ bcrypt verification with byte-length guard
→ Rotate/create opaque Redis session
→ Set `__Host-admin_session` cookie
→ Return session-bound CSRF token and authorized memberships
→ State-changing requests send `X-CSRF-Token`

Logout validates session + CSRF, deletes the Redis session and expires the cookie.

## Flow A — Admin creates a project

Dashboard
→ Projects
→ Create Project
→ Enter name/slug
→ Validate
→ Save
→ Project detail

## Flow B — Create training

Project
→ Trainings
→ Create
→ Name/code/date
→ Save

## Flow C — Create template

Templates
→ New Template
→ Choose page size/orientation
→ Upload background/assets
→ Add fields
→ Preview
→ Save draft
→ Create version
→ Publish

## Flow D — Import participants

Training
→ Participants
→ Import
→ Upload CSV/XLSX
→ Parse
→ Validate
→ Preview errors
→ Confirm
→ Import job
→ Completed

Never generate certificates before import validation completes.

## Flow E — Generate certificates

Training
→ Certificates
→ Generate
→ Select template version
→ Select participants/all
→ Confirm
→ Queue job
→ Worker
→ PDF
→ Private storage
→ AVAILABLE

## Flow F — Public verification

Public `/verify#token=<signed-token>` or manual token entry
→ Browser removes token from visible application state and submits it by POST
→ Rate limit
→ Verify signature
→ Resolve opaque public certificate identifier
→ Check status
→ Display minimum data
→ Request short-lived download authorization by POST
→ Redeem authorization by POST
→ Recheck current status
→ Stream PDF from private storage

## Flow G — Revoke

Admin
→ Certificate
→ Revoke
→ Enter reason
→ Confirm
→ Update status
→ Audit log
→ Future verification returns revoked
→ New download authorization blocked
→ Existing unexpired download authorization also blocked at redemption

## Flow H — Replace template

Template
→ Create new version
→ Edit
→ Preview
→ Publish

Existing certificates continue to reference old version.
