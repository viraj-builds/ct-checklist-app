import { Results } from "@/components/audit/Results";

export default async function AuditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <Results id={id} />;
}
