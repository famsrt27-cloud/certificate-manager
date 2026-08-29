"use client";

import { ParticipantManagement } from "../../../components/admin/participants/participant-management";
import { useAdminContext } from "../admin-context";

export default function ParticipantsPage() {
  const { membership, session } = useAdminContext();
  return <ParticipantManagement csrfToken={session.csrf_token} key={membership.id} membership={membership} />;
}
