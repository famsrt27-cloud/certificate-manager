"use client";

import { CertificateWorkspace } from "../../../components/admin/certificates/certificate-workspace";
import { useAdminContext } from "../admin-context";

export default function CertificatesPage() {
  const { membership, session } = useAdminContext();
  return <CertificateWorkspace csrfToken={session.csrf_token} key={membership.id} membership={membership} />;
}
