# 00 — Project Overview

## Product

Certificate Management & Public Verification Platform.

## Goal

สร้างระบบออกใบประกาศที่องค์กร/สถานศึกษาสามารถ:
- สร้างโครงการและการอบรม
- สร้างและจัดการ Template
- Import รายชื่อ
- Generate PDF แบบจำนวนมาก
- ออกเลขใบประกาศ
- ให้ผู้รับตรวจสอบ/ดาวน์โหลดโดยไม่ Login
- Revoke ใบประกาศ
- ตรวจสอบย้อนหลังผ่าน Audit Log

## Product principles

1. Public download without recipient account.
2. Privacy by default.
3. Minimum necessary data.
4. Verification token is not stored as plaintext in DB.
5. Token is stateless and signed.
6. Public tokens use a separate opaque public certificate identifier and never expose internal UUIDs.
7. Certificate status remains server-side for revocation.
8. Templates are versioned and immutable after publication.
9. PDF files remain private in object storage.
10. Security controls and organization scope are backend- and database-enforced.
11. AI agents must follow repository documentation before coding.

## Non-goals for MVP

- Social network
- Public student directory
- Public search by person name
- Storing unnecessary student PII
- Blockchain
- Mobile app
- Complex billing
- Multi-region deployment

These can be considered later.
