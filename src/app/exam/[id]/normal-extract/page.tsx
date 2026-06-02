// Legacy redirect. The English Normal Extract experience moved to
// /exam/[id]/english-edit (a language-isolated clone of the
// /edit page) — admins coming through old bookmarks or hashes from
// before commit afe646e3 land here, and we bounce them to the new
// route so they don't see the deprecated section-panel UX.

"use client";

import { use, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export default function NormalExtractRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const sp = useSearchParams();
  const userId = sp.get("userId") ?? "";
  useEffect(() => {
    router.replace(`/exam/${id}/english-edit${userId ? `?userId=${userId}` : ""}`);
  }, [id, userId, router]);
  return (
    <div className="max-w-3xl mx-auto p-6 text-sm text-slate-500">
      Redirecting to /english-edit…
    </div>
  );
}
