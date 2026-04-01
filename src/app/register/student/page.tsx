"use client";

import { Suspense, useState, useRef, useCallback } from "react";
import { useSearchParams, useRouter } from "next/navigation";

export default function RegisterStudentPage() {
  return (
    <Suspense>
      <RegisterStudentContent />
    </Suspense>
  );
}

function RegisterStudentContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const parentId = searchParams.get("parentId");

  const [name, setName] = useState("");
  const [pw, setPw] = useState("");
  const [pwConfirm, setPwConfirm] = useState("");
  const [level, setLevel] = useState(4);
  const [error, setError] = useState("");
  const [registering, setRegistering] = useState(false);

  // Username availability
  const [nameAvailable, setNameAvailable] = useState<boolean | null>(null);
  const [checkingName, setCheckingName] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const checkName = useCallback((n: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!n.trim()) { setNameAvailable(null); return; }
    setCheckingName(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/users/check?name=${encodeURIComponent(n.trim())}`);
        const data = await res.json();
        setNameAvailable(data.available);
      } catch { setNameAvailable(null); }
      finally { setCheckingName(false); }
    }, 400);
  }, []);

  async function handleRegister() {
    setError("");
    if (!name.trim()) { setError("Name is required"); return; }
    if (!pw) { setError("Password is required"); return; }
    if (pw !== pwConfirm) { setError("Passwords don't match"); return; }
    if (nameAvailable === false) { setError("Username is taken"); return; }

    setRegistering(true);
    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          role: "STUDENT",
          password: pw,
          level,
          parentId: parentId || undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Registration failed");
        return;
      }
      const user = await res.json();
      // If opened from parent flow, go back to parent dashboard (which now has the linked student)
      if (parentId) {
        router.push(`/home/${parentId}`);
      } else {
        router.push(`/home/${user.id}`);
      }
    } catch {
      setError("Something went wrong");
    } finally {
      setRegistering(false);
    }
  }

  return (
    <div className="min-h-screen bg-white p-6">
      <div className="max-w-sm mx-auto pt-8">
        <h1 className="text-2xl font-bold text-slate-800 mb-2 text-center">
          Create Student Account
        </h1>
        <p className="text-sm text-slate-500 text-center mb-6">
          This account will be linked to your parent account automatically.
        </p>

        <div className="rounded-2xl border-2 border-slate-100 bg-white p-5 shadow-sm">
          {/* Username */}
          <div className="mb-4">
            <label className="block text-sm font-medium text-slate-600 mb-1">Username</label>
            <input
              type="text"
              value={name}
              onChange={(e) => { setName(e.target.value); checkName(e.target.value); }}
              placeholder="Choose a username"
              className="w-full px-4 py-2.5 rounded-xl border-2 border-slate-200 focus:border-primary-400 focus:outline-none"
            />
            {name.trim() ? (
              <p className={`text-xs mt-1 ${
                checkingName ? "text-slate-400" :
                nameAvailable === true ? "text-green-500" :
                nameAvailable === false ? "text-red-500" : "text-slate-400"
              }`}>
                {checkingName ? "Checking..." :
                 nameAvailable === true ? "Username available" :
                 nameAvailable === false ? "Username is taken" : ""}
              </p>
            ) : null}
          </div>

          {/* Password */}
          <div className="mb-4">
            <label className="block text-sm font-medium text-slate-600 mb-1">Password</label>
            <input
              type="password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              placeholder="Choose a password"
              className="w-full px-4 py-2.5 rounded-xl border-2 border-slate-200 focus:border-primary-400 focus:outline-none"
            />
          </div>

          {/* Confirm Password */}
          <div className="mb-4">
            <label className="block text-sm font-medium text-slate-600 mb-1">Confirm Password</label>
            <input
              type="password"
              value={pwConfirm}
              onChange={(e) => setPwConfirm(e.target.value)}
              placeholder="Re-enter password"
              className={`w-full px-4 py-2.5 rounded-xl border-2 focus:outline-none ${
                pwConfirm && pw !== pwConfirm
                  ? "border-red-300 focus:border-red-400"
                  : "border-slate-200 focus:border-primary-400"
              }`}
            />
            {pwConfirm && pw !== pwConfirm ? (
              <p className="text-xs text-red-500 mt-1">Passwords don&apos;t match</p>
            ) : null}
          </div>

          {/* Level */}
          <div className="mb-4">
            <label className="block text-sm font-medium text-slate-600 mb-1">Level</label>
            <div className="grid grid-cols-6 gap-1.5">
              {[1, 2, 3, 4, 5, 6].map((l) => (
                <button
                  key={l}
                  onClick={() => setLevel(l)}
                  className={`rounded-lg py-2 text-center text-sm font-semibold border-2 transition-colors ${
                    level === l
                      ? "border-primary-400 bg-primary-50 text-primary-700"
                      : "border-slate-200 text-slate-500 hover:border-slate-300"
                  }`}
                >
                  P{l}
                </button>
              ))}
            </div>
          </div>

          {error ? (
            <p className="text-sm text-red-500 mb-3">{error}</p>
          ) : null}

          <button
            onClick={handleRegister}
            disabled={registering || nameAvailable === false}
            className="w-full py-3 rounded-xl bg-primary-600 text-white font-semibold hover:bg-primary-700 transition-colors disabled:opacity-50"
          >
            {registering ? "Creating account..." : "Create Account"}
          </button>
        </div>
      </div>
    </div>
  );
}
