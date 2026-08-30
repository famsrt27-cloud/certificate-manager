"use client";

import { TemplateLibrary } from "../../../components/admin/templates/template-library";
import { useAdminContext } from "../admin-context";

export default function TemplatesPage() {
  const { membership, session } = useAdminContext();
  return <TemplateLibrary csrfToken={session.csrf_token} key={membership.id} membership={membership} />;
}
