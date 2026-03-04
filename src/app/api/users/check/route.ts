import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(request: NextRequest) {
  const name = request.nextUrl.searchParams.get("name");
  if (!name) {
    return NextResponse.json({ available: false });
  }

  const existing = await prisma.user.findFirst({
    where: { name: { equals: name, mode: "insensitive" }, role: "STUDENT" },
  });

  return NextResponse.json({ available: !existing });
}
