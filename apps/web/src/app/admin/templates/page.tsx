"use client";

import { AdminPageHeader } from "../../../components/admin/admin-page-header";
import { useAdminContext } from "../admin-context";
import { TemplateManagement } from "../template-management";

export default function TemplatesPage() {
  const { membership, session } = useAdminContext();
  return <><AdminPageHeader eyebrow="รูปแบบเอกสาร" title="เทมเพลต" description="จัดการเทมเพลตแบบมีเวอร์ชันสำหรับการออกใบประกาศนียบัตรอย่างสม่ำเสมอ" />
    <TemplateManagement csrfToken={session.csrf_token} key={membership.id} membership={membership} /></>;
}
