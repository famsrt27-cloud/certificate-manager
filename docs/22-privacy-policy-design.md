# 22 — Privacy Policy Design Requirements

This is a technical privacy design document, not legal advice.

## Data categories

### Required
- display name
- certificate relationship
- project/training relationship
- certificate number
- issuance status/date
- PDF storage reference
- opaque public certificate identifier that contains no PII

### Optional
- external student reference if business requirements require it

### Prohibited by default
- home address
- precise location
- health information
- family information
- unrelated contact details
- date of birth unless explicitly required

## Public disclosure

Public verification must disclose only the minimum needed to prove certificate validity.

## Retention

Define retention periods by:
- participant data
- certificates
- audit logs
- verification events
- download events
- temporary files

Delete temporary processing files automatically.

Participant import source files and staged rows are temporary operational data with restricted admin access. Phase 3 deletes source objects immediately after validation staging or terminal validation failure, deletes staged rows immediately after successful import, and automatically cancels/removes awaiting-confirmation or terminal staged data after 168 hours by default. Deployments may shorten this validated retention setting; any Phase 8 production policy change must remain documented and bounded.

If `network_fingerprint` is enabled, it must be a keyed, rotating pseudonymous value rather than a raw IP address. Its purpose, rotation and short retention period must be documented. It must not be used to identify a recipient publicly.

## Data subject operations

If required by the organization/policy, support:
- correction
- restricted access
- deletion where legally/business permissible
- export where applicable

Because certificates may have archival/verification obligations, deletion policies must distinguish between operational participant data and certificate integrity records.

The opaque public certificate identifier is not an authentication secret, but it is not returned as a standalone public field. Public clients submit the complete signed token and receive only the minimal verification result.
