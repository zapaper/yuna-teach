"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { User } from "@/types";

export default function UserSelectionPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchUsers() {
      try {
        const res = await fetch("/api/users");
        const data = await res.json();
        setUsers(data.users);
      } catch (err) {
        console.error("Failed to fetch users:", err);
      } finally {
        setLoading(false);
      }
    }
    fetchUsers();
  }, []);

  return (
    <div className="p-6 pb-24">
      <div className="text-center mb-8 pt-4">
        <h1 className="text-2xl font-bold text-slate-800">Yuna Teach</h1>
        <p className="text-slate-500 text-sm mt-1">Who is studying today?</p>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-4 border-primary-200 border-t-primary-500" />
        </div>
      ) : (
        <div className="space-y-3">
          {users.map((user) => (
            <Link
              key={user.id}
              href={`/home/${user.id}`}
              className="block rounded-2xl border-2 border-slate-100 bg-white p-5 shadow-sm transition-all active:scale-[0.98] hover:border-primary-200 hover:shadow-md"
            >
              <div className="flex items-center gap-4">
                <div
                  className={`w-12 h-12 rounded-full flex items-center justify-center text-xl font-bold text-white ${
                    user.role === "STUDENT"
                      ? "bg-primary-400"
                      : "bg-accent-orange"
                  }`}
                >
                  {user.name.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1">
                  <h3 className="font-semibold text-lg text-slate-800">
                    {user.name}
                  </h3>
                  <div className="flex items-center gap-2">
                    <span
                      className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                        user.role === "STUDENT"
                          ? "bg-primary-100 text-primary-700"
                          : "bg-orange-100 text-orange-700"
                      }`}
                    >
                      {user.role === "STUDENT" ? "Student" : "Parent"}
                    </span>
                    {user.role === "STUDENT" && user.level && (
                      <span className="text-xs text-slate-400">
                        Primary {user.level}
                      </span>
                    )}
                  </div>
                </div>
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
                  className="text-slate-300"
                >
                  <path d="m9 18 6-6-6-6" />
                </svg>
              </div>
            </Link>
          ))}
        </div>
      )}

      <Link
        href="/user/new"
        className="block w-full mt-6 bg-slate-100 text-slate-600 rounded-2xl py-4 px-6 text-lg font-semibold text-center hover:bg-slate-200 transition-colors"
      >
        + Add User
      </Link>
    </div>
  );
}
