# 12 — Template Engine

## Locked implementation

Templates use a custom versioned JSON format. Zod is the canonical validator, and a custom data binder resolves an explicit allowlist of certificate fields. PDFKit consumes the validated/bound representation; qrcode produces QR image data for the QR element.

## Requirements

Templates must support:
- text
- images
- dynamic fields
- QR
- signatures
- alignment
- font
- color
- position
- size
- page dimensions

## Example definition

```json
{
  "page": {
    "width": 1123,
    "height": 794,
    "unit": "px"
  },
  "elements": [
    {
      "type": "text",
      "x": 561,
      "y": 330,
      "width": 800,
      "height": 80,
      "align": "center",
      "font": {
        "family": "Noto Sans Thai",
        "size": 42,
        "weight": 700
      },
      "binding": "recipient.display_name"
    },
    {
      "type": "text",
      "binding": "training.name"
    },
    {
      "type": "qr",
      "binding": "verification_url"
    },
    {
      "type": "image",
      "asset_id": "admin-visible-template-asset-uuid"
    }
  ]
}
```

## Security

The template definition is data, not executable code.

Do not allow arbitrary JavaScript execution.

The data binder must not use `eval`, `Function`, dynamic module loading or unrestricted property traversal. Binding names are matched against a versioned allowlist and resolved from a purpose-built rendering context containing minimum required fields.

Remote resource loading should be disabled or allowlisted during PDF rendering.

Template assets must be uploaded to private storage, validated and marked `ACTIVE` before they can be used for publishing. Definitions reference validated asset records; they must not contain arbitrary local paths, bucket paths or remote URLs.

## Versioning

Template versions follow `DRAFT → PUBLISHED → ARCHIVED`.

Every published template definition and its asset links are immutable. The PostgreSQL reference schema enforces this with status constraints and triggers. An archived published version remains immutable and its assets must remain available for historical rendering.

To change it:
- create new version
- preview
- publish
- new certificates reference new version

Existing certificates remain tied to their original version.

Publishing must be atomic: validate the definition, bindings, asset ownership and asset status, then set `PUBLISHED` and `published_at` in one transaction. A generation job accepts only a published version from the same organization.

## Deterministic rendering contract

- Validate and normalize page dimensions, positions, colors, font references and element ordering before rendering.
- Use approved bundled/private fonts and validated private assets only.
- Define stable z-order and text-layout behavior per template format version.
- The same template version, asset hashes, binding data and renderer revision must produce the same approved output behavior.
- Changing schema, binder or layout semantics requires a new supported template-format/renderer revision and must not mutate historical versions.
