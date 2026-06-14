import { AuthenticatedProviders } from "@/app/AuthenticatedProviders";
import StatsPageClient from "./StatsPageClient";

export default function StatsPage() {
  return (
    <AuthenticatedProviders>
      <StatsPageClient />
    </AuthenticatedProviders>
  );
}
