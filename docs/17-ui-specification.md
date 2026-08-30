# 17 — UI Specification

## Locked implementation

The web application uses Next.js with Tailwind CSS under `apps/web`. It consumes browser-safe Zod contracts from `@certificate-platform/contracts` and calls the canonical Fastify API. It must not access PostgreSQL, Redis, BullMQ, bcrypt, S3 credentials or signing keys directly.

## Admin layout

Phase 2 provides `/admin/login` and the authenticated `/admin` session/membership view. The login form submits only email and password to the canonical Fastify endpoint through same-origin `/api`; it shows a generic failure and never stores the session ID, password, role claims or permissions in browser storage. The authenticated view obtains its display data and CSRF token from `GET /api/admin/auth/session`, keeps the CSRF token in component memory, and supplies it only to state-changing requests such as logout.

```text
+-----------------------------------------------------------+
| Logo | Search | Notifications | Admin Menu                |
+---------+-------------------------------------------------+
| Sidebar | Dashboard                                      |
|         |                                                 |
| Dashboard| KPI Cards                                      |
| Projects | Recent Projects                                |
| Trainings| Generation Jobs                                |
| Templates| Security Alerts                                |
| Certificates                                            |
| Participants                                            |
| Security                                                  |
| Audit Logs                                                |
| Settings                                                  |
+---------+-------------------------------------------------+
```

## Public layout

Minimal page with:
- logo/organization identity
- certificate token field
- verify button
- security-friendly generic error
- certificate result
- download button

Do not show account/login UI to recipients.

The page may read a verification token from the URL fragment and immediately remove it from visible application state before submitting it in a POST body. Never place tokens in paths, query strings, analytics or client logs. Set `noindex`, `nofollow`, `noarchive`, `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.

## Certificate result

Show:
- status
- recipient display name
- program/training
- certificate number
- issue/completion date
- download

Do not show:
- internal IDs
- opaque public certificate identifier
- student ID unless explicitly approved
- email
- phone
- address

## Template Builder

Panels:
- Elements
- Properties
- Layers
- Assets
- Preview
- Version

Elements:
- Text
- Dynamic text
- Image
- QR
- Signature
- Line/shape

Properties:
- x/y
- width/height
- font
- weight
- size
- alignment
- color
- opacity

## Accessibility

- keyboard navigation
- visible focus
- semantic labels
- sufficient contrast
- screen-reader labels
- error messages associated with inputs

## Public search and QR entry

Opening `/verify` without a fragment defaults to “ค้นหาใบประกาศ” beside “ตรวจสอบด้วย QR”. Search provides a manual recipient input, database-backed optional project and training comboboxes, and an alternative exact certificate-number field. Training is searchable without a project; when a project is selected, it additionally filters training suggestions server-side. Project/training suggestions require typed input and selection; recipient names are never autocompleted. It prevents mixing search modes and explains “กรอกชื่อผู้รับพร้อมเลือกโครงการหรือการอบรม”. It shows no public catalog, totals, cursor, person URL or technical identifier. A valid QR fragment bypasses search and immediately runs canonical verification.

The public root `/` is a Thai-first recipient landing page with lightweight navigation to `/`, `/verify` and `/admin/login`; it contains no development-phase terminology. The admin dashboard includes the small “การค้นหาใบประกาศสาธารณะ” organization toggle for members with `organization:update`, plus a disclosure that results may show recipient name, project, training, certificate number and issue date.

Result cards show recipient, project, approved search-only training name, certificate number, issue date and “พร้อมใช้งาน”. Their download button holds the search-result token only in component memory, exchanges it in a POST body, and redeems the returned download token through the canonical PDF endpoint. Expiry asks the user to search again; other state changes use generic feedback and disable stale download state.
