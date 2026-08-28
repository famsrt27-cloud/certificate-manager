"use client";

import { ProjectManagement } from "../../../components/admin/projects/project-management";
import { useAdminContext } from "../admin-context";

export default function ProjectsPage() {
  const { membership, session } = useAdminContext();
  return <ProjectManagement csrfToken={session.csrf_token} key={membership.id} membership={membership} />;
}
