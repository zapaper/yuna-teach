"use client";

import { useEffect } from "react";
import { Capacitor } from "@capacitor/core";

// Tiny client-side guard: when the marketing landing page is loaded
// inside the iOS Capacitor shell (cold-app-launch lands on
// https://www.markforyou.com because of capacitor.config.ts → server.url),
// bounce straight to /login. The landing page is a public marketing
// page that doesn't make sense inside an app — the user has already
// "decided" to use MarkForYou by opening the app, so the long sales
// pitch only delays them from logging in.
//
// Pure client-side replace so SEO crawlers and desktop visitors keep
// seeing the landing page exactly as before. Uses replace() (not
// assign()) so the iOS back-stack doesn't acquire a "go back to the
// marketing page" step.
export default function NativeLandingBouncer() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!Capacitor.isNativePlatform()) return;
    window.location.replace("/login");
  }, []);
  return null;
}
