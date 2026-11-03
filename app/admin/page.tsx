import { notFound } from "next/navigation";
import { currentUser } from "@/lib/server/auth";
import { AdminDashboard } from "@/components/admin/AdminDashboard";

// Admin-only (ADMIN_EMAILS). Everyone else gets a plain 404.
export default async function AdminPage() {
  const user = await currentUser();
  if (!user?.isAdmin) notFound();
  return <AdminDashboard />;
}
