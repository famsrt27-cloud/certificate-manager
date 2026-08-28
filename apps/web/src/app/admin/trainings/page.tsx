"use client";

import { AdminPageHeader } from "../../../components/admin/admin-page-header";
import { useAdminContext } from "../admin-context";
import { PhaseThreeDashboard } from "../phase-three-dashboard";

export default function TrainingsPage() {
  const { membership, session } = useAdminContext();
  return <><AdminPageHeader eyebrow="โครงสร้างการดำเนินงาน" title="การอบรม" description="จัดการรายการอบรมและเชื่อมโยงกับโครงการที่เกี่ยวข้อง" />
    <PhaseThreeDashboard csrfToken={session.csrf_token} key={membership.id} membership={membership} view="trainings" /></>;
}
