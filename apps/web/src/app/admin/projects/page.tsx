"use client";

import { AdminPageHeader } from "../../../components/admin/admin-page-header";
import { useAdminContext } from "../admin-context";
import { PhaseThreeDashboard } from "../phase-three-dashboard";

export default function ProjectsPage() {
  const { membership, session } = useAdminContext();
  return <><AdminPageHeader eyebrow="โครงสร้างการดำเนินงาน" title="โครงการ" description="สร้างและดูแลโครงการที่ใช้จัดกลุ่มการอบรมขององค์กร" />
    <PhaseThreeDashboard csrfToken={session.csrf_token} key={membership.id} membership={membership} view="projects" /></>;
}
