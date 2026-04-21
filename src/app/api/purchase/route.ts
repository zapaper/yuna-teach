import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// Keep in sync with src/app/habitats/[userId]/page.tsx — the client only
// sends { type, id }; server is the source of truth on prices so a
// client-side edit can't change what's charged.
const PET_COST: Record<string, number> = {
  whitetiger: 10,
  boar: 10,
  pangolin: 10,
};
const HABITAT_COST: Record<string, number> = {
  fantasy: 30,
  garden: 30,
};

export async function POST(request: NextRequest) {
  const { userId, type, id } = (await request.json()) as {
    userId?: string;
    type?: "pet" | "habitat";
    id?: string;
  };
  if (!userId || !type || !id) {
    return NextResponse.json({ error: "userId, type, id required" }, { status: 400 });
  }
  const cost = type === "pet" ? PET_COST[id] : HABITAT_COST[id];
  if (!cost) return NextResponse.json({ error: "unknown item" }, { status: 400 });

  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { settings: true, examPapers: { select: { markingStatus: true } } },
    });
    if (!user) return { ok: false as const, error: "user not found" };

    const settings = ((user.settings ?? {}) as Record<string, unknown>);
    const purchasedKey = type === "pet" ? "purchasedPets" : "purchasedHabitats";
    const purchased = Array.isArray(settings[purchasedKey])
      ? (settings[purchasedKey] as string[])
      : [];

    // Idempotent: if already owned, return success without re-charging.
    if (purchased.includes(id)) {
      return { ok: true as const, alreadyOwned: true, settings };
    }

    const earned = user.examPapers.filter((p) => p.markingStatus === "released").length;
    const bonus = (settings.bonusCrystals as number | undefined) ?? 0;
    const spent = (settings.spentCrystals as number | undefined) ?? 0;
    const balance = earned + bonus - spent;
    if (balance < cost) {
      return { ok: false as const, error: "insufficient crystals", balance, cost };
    }

    const nextSettings: Record<string, unknown> = {
      ...settings,
      spentCrystals: spent + cost,
      [purchasedKey]: [...purchased, id],
    };
    await tx.user.update({
      where: { id: userId },
      data: { settings: nextSettings as unknown as import("@prisma/client").Prisma.InputJsonValue },
    });
    return { ok: true as const, alreadyOwned: false, settings: nextSettings, balance: balance - cost };
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error, balance: (result as { balance?: number }).balance, cost }, { status: 400 });
  }
  return NextResponse.json({ ok: true, alreadyOwned: result.alreadyOwned, balance: (result as { balance?: number }).balance });
}
