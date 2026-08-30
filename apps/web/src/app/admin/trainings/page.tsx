"use client";

import { TrainingManagement } from "../../../components/admin/trainings/training-management";
import { useAdminContext } from "../admin-context";

export default function TrainingsPage() {
  const { membership, session } = useAdminContext();
  return <TrainingManagement csrfToken={session.csrf_token} key={membership.id} membership={membership} />;
}
