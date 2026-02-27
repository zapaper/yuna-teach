"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function CreateUserPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [role, setRole] = useState<"STUDENT" | "PARENT">("STUDENT");
  const [level, setLevel] = useState(4);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    if (!name.trim()) return;

    setSaving(true);
    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          role,
          level: role === "STUDENT" ? level : null,
        }),
      });

      if (res.ok) {
        router.push("/");
      }
    } catch (err) {
      console.error("Failed to create user:", err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="p-6">
      <button
        onClick={() => router.push("/")}
        className="flex items-center gap-1 text-slate-500 mb-6 hover:text-slate-700"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m15 18-6-6 6-6" />
        </svg>
        Back
      </button>

      <h1 className="text-xl font-bold text-slate-800 mb-6">Add User</h1>

      {/* Name */}
      <div className="mb-6">
        <label className="block text-sm font-medium text-slate-600 mb-2">
          Name
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Enter name"
          className="w-full px-4 py-3 rounded-xl border-2 border-slate-200 text-lg focus:border-primary-400 focus:outline-none"
        />
      </div>

      {/* Role */}
      <div className="mb-6">
        <label className="block text-sm font-medium text-slate-600 mb-2">
          Role
        </label>
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => setRole("STUDENT")}
            className={`rounded-xl py-3 px-4 text-center font-semibold border-2 transition-colors ${
              role === "STUDENT"
                ? "border-primary-400 bg-primary-50 text-primary-700"
                : "border-slate-200 text-slate-500 hover:border-slate-300"
            }`}
          >
            Student
          </button>
          <button
            onClick={() => setRole("PARENT")}
            className={`rounded-xl py-3 px-4 text-center font-semibold border-2 transition-colors ${
              role === "PARENT"
                ? "border-accent-orange bg-orange-50 text-orange-700"
                : "border-slate-200 text-slate-500 hover:border-slate-300"
            }`}
          >
            Parent
          </button>
        </div>
      </div>

      {/* Level (students only) */}
      {role === "STUDENT" && (
        <div className="mb-8">
          <label className="block text-sm font-medium text-slate-600 mb-2">
            Level
          </label>
          <div className="grid grid-cols-3 gap-2">
            {[1, 2, 3, 4, 5, 6].map((l) => (
              <button
                key={l}
                onClick={() => setLevel(l)}
                className={`rounded-xl py-3 text-center font-semibold border-2 transition-colors ${
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
      )}

      {/* Save */}
      <button
        onClick={handleSave}
        disabled={!name.trim() || saving}
        className="w-full bg-primary-600 text-white rounded-2xl py-4 px-6 text-lg font-semibold shadow-lg active:scale-[0.98] transition-transform disabled:opacity-50"
      >
        {saving ? "Saving..." : "Save"}
      </button>
    </div>
  );
}
