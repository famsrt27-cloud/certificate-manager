"use client";

import { AdminPageHeader } from "../../components/admin/admin-page-header";
import { AdminDashboard } from "../../components/admin/dashboard/admin-dashboard";
import { useAdminContext } from "./admin-context";

export default function AdminPage() {
  const { membership } = useAdminContext();
  return <><AdminPageHeader eyebrow="ศูนย์ควบคุมองค์กร" title="ภาพรวม" description="ติดตามความพร้อมของข้อมูลและงานสำคัญตลอดกระบวนการออกใบประกาศนียบัตร" />
    <AdminDashboard key={membership.id} membership={membership} /></>;
}
