import StatsPageClient from "./StatsPageClient";
import { isAdminEmail } from "@/app/lib/adminAccess";
import { getCurrentUser } from "@/app/lib/auth";
import { loadReviewStats } from "@/app/lib/stats";

export default async function StatsPage() {
  const [currentUser, stats] = await Promise.all([
    getCurrentUser(),
    loadReviewStats(),
  ]);

  return (
    <StatsPageClient
      currentUser={currentUser}
      showAdmin={isAdminEmail(currentUser.email)}
      stats={stats}
    />
  );
}
