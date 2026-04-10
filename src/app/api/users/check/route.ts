import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(request: NextRequest) {
  const name = request.nextUrl.searchParams.get("name");
  const email = request.nextUrl.searchParams.get("email");

  if (email) {
    const existing = await prisma.user.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
    });
    return NextResponse.json({ available: !existing });
  }

  if (!name) {
    return NextResponse.json({ available: false });
  }

  const existing = await prisma.user.findFirst({
    where: { name: { equals: name, mode: "insensitive" } },
  });

  return NextResponse.json({ available: !existing });
}
