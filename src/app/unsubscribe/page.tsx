"use client";

// Unsubscribe / email-preferences page. Reached via a signed token in
// the footer of every outbound non-transactional email. The token
// resolves to a userId server-side — no login required.
//
// Four radio choices that translate to a (marketing, progress,
// features) triplet:
//
//   1. "Keep me subscribed to everything"        → (true, true, true)
//   2. "Unsubscribe from marketing only"          → (false, true, true)
//   3. "Unsubscribe from marketing + new features" → (false, true, false)
//   4. "Unsubscribe from all communication"        → (false, false, false)
//
// Note that there's no "progress only, no marketing, no features" UI
// option even though the data model supports it — keeping the page
// simple. If we need finer-grained later we can add it without a
// schema change.

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

type Prefs = { marketing: boolean; progress: boolean; features: boolean };
type Tier = "all" | "no-marketing" | "no-marketing-or-features" | "none";

function tierFromPrefs(p: Prefs): Tier {
  if (p.marketing && p.progress && p.features) return "all";
  if (!p.marketing && p.progress && p.features) return "no-marketing";
  if (!p.marketing && p.progress && !p.features) return "no-marketing-or-features";
  if (!p.marketing && !p.progress && !p.features) return "none";
  // Anything else (e.g. legacy custom state) — show the closest match
  // and let the user re-pick.
  if (p.progress) return "no-marketing";
  return "none";
}

function prefsFromTier(t: Tier): Prefs {
  switch (t) {
    case "all":                       return { marketing: true,  progress: true,  features: true  };
    case "no-marketing":              return { marketing: false, progress: true,  features: true  };
    case "no-marketing-or-features":  return { marketing: false, progress: true,  features: false };
    case "none":                      return { marketing: false, progress: false, features: false };
  }
}

const OPTIONS: Array<{ id: Tier; title: string; sub: string }> = [
  { id: "all",
    title: "Keep me subscribed to everything",
    sub: "Progress updates for your child, product news, plus occasional tips and onboarding emails." },
  { id: "no-marketing",
    title: "Unsubscribe from marketing only",
    sub: "I&rsquo;ll still get my child&rsquo;s progress updates and new feature announcements." },
  { id: "no-marketing-or-features",
    title: "Unsubscribe from marketing and new features",
    sub: "I only want my child&rsquo;s progress updates." },
  { id: "none",
    title: "Unsubscribe from all communication, including progress reports on my child",
    sub: "Stops every non-essential email. Billing receipts and account-security notices still come through." },
];

function UnsubscribeContent() {
  const sp = useSearchParams();
  const token = sp.get("token") ?? "";

  const [tier, setTier] = useState<Tier | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) { setError("This unsubscribe link is missing its token. Try clicking it again from the email."); setLoading(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/email-prefs?token=${encodeURIComponent(token)}`);
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error((j as { error?: string }).error ?? `HTTP ${res.status}`);
        if (cancelled) return;
        setTier(tierFromPrefs((j as { prefs: Prefs }).prefs));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  const save = async () => {
    if (!tier) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/email-prefs?token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(prefsFromTier(tier)),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((j as { error?: string }).error ?? `HTTP ${res.status}`);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#f8f9ff] flex items-start justify-center px-4 py-12">
      <div className="w-full max-w-xl">
        <Link href="/" className="text-sm text-[#0040a0] hover:underline">← MarkForYou</Link>
        <h1 className="text-2xl font-extrabold text-[#001e40] mt-3">Email preferences</h1>
        <p className="text-sm text-[#43474f] mt-1">
          Pick how often you&rsquo;d like to hear from us. You can come back here any time to change your mind.
        </p>

        {loading && (
          <div className="mt-8 bg-white border border-slate-200 rounded-2xl p-6 text-sm text-[#43474f]">
            Loading…
          </div>
        )}

        {!loading && error && (
          <div className="mt-8 bg-red-50 border border-red-200 rounded-2xl p-4 text-sm text-red-700">
            {error}
          </div>
        )}

        {!loading && !error && tier && (
          <div className="mt-6 bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-3">
            {OPTIONS.map(opt => (
              <label
                key={opt.id}
                className={`block rounded-xl border p-4 cursor-pointer transition ${
                  tier === opt.id
                    ? "border-[#0040a0] bg-[#eff4ff]"
                    : "border-slate-200 hover:border-slate-300"
                }`}
              >
                <div className="flex items-start gap-3">
                  <input
                    type="radio"
                    name="tier"
                    checked={tier === opt.id}
                    onChange={() => { setTier(opt.id); setSaved(false); }}
                    className="mt-1 accent-[#0040a0]"
                  />
                  <div className="min-w-0">
                    <div className="font-semibold text-[#001e40]">{opt.title}</div>
                    <div
                      className="text-xs text-[#43474f] mt-0.5"
                      dangerouslySetInnerHTML={{ __html: opt.sub }}
                    />
                  </div>
                </div>
              </label>
            ))}

            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="w-full mt-2 px-4 py-2.5 rounded-xl text-sm font-bold bg-[#0040a0] text-white hover:bg-[#003080] disabled:opacity-60"
            >
              {saving ? "Saving…" : "Save preferences"}
            </button>

            {saved && (
              <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 text-center">
                ✓ Saved. You can close this tab.
              </div>
            )}
          </div>
        )}

        <p className="text-xs text-[#737780] mt-6">
          Billing receipts and account-security notices are essential to running your subscription and are sent regardless of these preferences.
        </p>
      </div>
    </div>
  );
}

export default function UnsubscribePage() {
  return (
    <Suspense>
      <UnsubscribeContent />
    </Suspense>
  );
}
