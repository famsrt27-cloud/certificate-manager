"use client";

import { useParams } from "next/navigation";

import { TemplateWorkspace } from "../../../../components/admin/templates/template-workspace";
import { useAdminContext } from "../../admin-context";

export default function TemplateWorkspacePage() {
  const params = useParams<{ templateId: string }>();
  const { membership, session } = useAdminContext();
  return <TemplateWorkspace csrfToken={session.csrf_token} key={`${membership.id}-${params.templateId}`} membership={membership} templateId={params.templateId} />;
}
