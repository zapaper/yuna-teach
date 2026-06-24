"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import AdminNav from "@/components/AdminNav";

export default function AdminPage() {
  return (
    <Suspense>
      <AdminContent />
    </Suspense>
  );
}

function AdminContent() {
  const searchParams = useSearchParams();
  const userId = searchParams.get("userId") ?? "";
  const [allowed, setAllowed] = useState<boolean | null>(null);

  useEffect(() => {
    if (!userId) { setAllowed(false); return; }
    fetch(`/api/admin/check?userId=${userId}`)
      .then(r => setAllowed(r.ok))
      .catch(() => setAllowed(false));
  }, [userId]);

  if (allowed === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-slate-200 border-t-slate-500" />
      </div>
    );
  }

  if (!allowed) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <p className="text-slate-500 text-sm">Access denied.</p>
      </div>
    );
  }

  const tiles = [
    {
      icon: "flag",
      label: "Review Flagged Q&A",
      description: "View questions flagged by students, reply or clear flags.",
      href: `/flagged?userId=${userId}`,
      color: "bg-red-50 text-red-600",
    },
    {
      icon: "fact_check",
      label: "Vet Q&A (AI Audit)",
      description: "Review AI-flagged answer key issues one by one. Edit stem, options, answer.",
      href: `/admin/vet-qa?userId=${userId}`,
      color: "bg-purple-50 text-purple-600",
    },
    {
      icon: "upload_file",
      label: "Upload Exam Papers",
      description: "Upload a PDF exam paper and extract questions via AI.",
      href: `/exam/upload?userId=${userId}`,
      color: "bg-blue-50 text-blue-600",
    },
    {
      icon: "feedback",
      label: "User Feedback",
      description: "Read feedback submitted by parents and students.",
      href: `/admin/feedback?userId=${userId}`,
      color: "bg-amber-50 text-amber-600",
    },
    {
      icon: "library_books",
      label: "Manage Exam Papers",
      description: "View all master papers, toggle visibility, and delete.",
      href: `/admin/papers?userId=${userId}`,
      color: "bg-green-50 text-green-600",
    },
    {
      icon: "auto_awesome",
      label: "Generate Synthetic Qn",
      description: "Use AI to create variants of clean-extracted math MCQs.",
      href: `/admin/synthetic?userId=${userId}`,
      color: "bg-purple-50 text-purple-600",
    },
    {
      icon: "mail",
      label: "Beta Mailing List",
      description: "Registered users with email. Copy comma-separated or download CSV.",
      href: `/admin/emails?userId=${userId}`,
      color: "bg-sky-50 text-sky-600",
    },
    {
      icon: "insights",
      label: "Classify Difficulty",
      description: "AI rates clean-extracted questions 1–5. Runs in the background in batches of 5.",
      href: `/admin/classify-difficulty?userId=${userId}`,
      color: "bg-emerald-50 text-emerald-600",
    },
    {
      icon: "function",
      label: "Convert to LaTeX fraction",
      description: "Find Math MCQ stems / options with mixed-number ('4 5/6') patterns and convert to LaTeX one by one with admin approval.",
      href: `/admin/latex-fraction?userId=${userId}`,
      color: "bg-violet-50 text-violet-600",
    },
    {
      icon: "people",
      label: "Manage Users",
      description: "View all parent and student accounts. Delete accounts and inspect their links.",
      href: `/admin/users?userId=${userId}`,
      color: "bg-rose-50 text-rose-600",
    },
    {
      icon: "monitor_heart",
      label: "Marking Dashboard",
      description: "Live submission volume (last 24h hourly + last 7d daily) and marker health — failed marks, stuck in_progress, silent zero-mark anomalies. Click in to troubleshoot or re-mark.",
      href: `/admin/marking-dashboard?userId=${userId}`,
      color: "bg-blue-50 text-blue-600",
    },
    {
      icon: "list_alt",
      label: "Generate Answer Steps",
      description: "P4–P6 Math difficulty 4–5: AI rewrites answer keys as step-by-step working. Mismatches get flagged.",
      href: `/admin/answer-steps?userId=${userId}`,
      color: "bg-amber-50 text-amber-600",
    },
    {
      icon: "tips_and_updates",
      label: "Generate Explanation for MCQ",
      description: "P3–P6 Math + Science MCQ on master papers. Once a master is elaborated, every clone inherits the explanation. Test of 10, then continuous.",
      href: `/admin/elaborate-mcq?userId=${userId}`,
      color: "bg-indigo-50 text-indigo-600",
    },
    {
      icon: "refresh",
      label: "Regen Sci / Math MCQ with Diagrams",
      description: "Re-run gemini-3.1-pro-preview against every master Sci/Math MCQ with a diagram using the new prompt (sends full image + forces verbatim transcription of A/B/C/D statements). ~1,243 questions total, ~$8 full pass, or 173 letter-set only at ~$1.20.",
      href: `/admin/regen-mcq-diagrams?userId=${userId}`,
      color: "bg-violet-50 text-violet-600",
    },
    {
      icon: "rule",
      label: "Scan for Unclear Part-Answer Keys",
      description: "Master questions with sub-parts whose `answer` doesn't mention every (a)/(b)/(c) label — usually means the extractor missed a shared-block answer or the master answer is short. Batch of 30.",
      href: `/admin/answer-key-gaps?userId=${userId}`,
      color: "bg-rose-50 text-rose-600",
    },
    {
      icon: "fact_check",
      label: "Audit Answer Keys",
      description: "Re-extract answer-key pages with gemini-3.1-pro and diff against stored question.answer rows. Pick 1-3 papers; results stream in as cards with per-question status.",
      href: `/admin/audit-answer-keys?userId=${userId}`,
      color: "bg-violet-50 text-violet-600",
    },
    {
      icon: "format_align_left",
      label: "Key Format",
      description: "Standardise answer-key formatting on master questions — strip stray whitespace, fix capitalisation, and normalise the (a)/(b)/(c) sub-part separators so the marker can compare cleanly.",
      href: `/admin/answer-key-format?userId=${userId}`,
      color: "bg-slate-50 text-slate-600",
    },
    {
      icon: "table_view",
      label: "MCQ → Table",
      description: "Convert MCQ questions whose options are arranged in a table (multi-column compare grids) into the canonical transcribedOptionTable JSON shape so the quiz UI renders them correctly.",
      href: `/admin/convert-mcq-tables?userId=${userId}`,
      color: "bg-teal-50 text-teal-600",
    },
    {
      icon: "playlist_remove",
      label: "Legacy PSLE Topics",
      description: "Review questions on topics MOE removed from the 2025/2026 PSLE syllabus (Cells / Speed / Compass). Approve to re-tag and exclude from daily-quiz + focused-practice. Full papers keep them.",
      href: `/admin/legacy-topics?userId=${userId}`,
      color: "bg-amber-50 text-amber-600",
    },
    {
      icon: "image_search",
      label: "\"See Answer Image\" Sweep",
      description: "Questions whose stored answer is just a pointer to a diagram (so the AI marker has nothing to match against). Grouped by paper, drill in to add a written description on /edit.",
      href: `/admin/see-answer-image?userId=${userId}`,
      color: "bg-orange-50 text-orange-600",
    },
    {
      icon: "ink_eraser",
      label: "Remask CamScanner Watermarks",
      description: "Paint a white box over the bottom-right of every page + the top-left of page 1, across every master paper. Idempotent.",
      href: `/admin/remask-watermarks?userId=${userId}`,
      color: "bg-sky-50 text-sky-600",
    },
    {
      icon: "school",
      label: "Master Class (Workshop)",
      description: "Deep-dive modules on the highest-tested PSLE topics. Headline stats, key concepts, common mistakes, and 5 + 5 curated practice questions per topic.",
      href: `/admin/master-class?userId=${userId}`,
      color: "bg-emerald-50 text-emerald-600",
    },
    {
      icon: "edit_note",
      label: "Chinese Oral / Compo",
      description: "Upload PSLE Chinese PDFs for missing years. Gemini 3.1-pro auto-detects Paper 1 (作文) and Paper 3 (口试 / 听力) pages + answer keys and OCRs each section. Source for trend analysis.",
      href: `/admin/chinese-oral-compo?userId=${userId}`,
      color: "bg-fuchsia-50 text-fuchsia-600",
    },
    {
      icon: "edit_note",
      label: "English Oral / Compo",
      description: "Same as Chinese but for PSLE English: Paper 1 Writing (Situational + Continuous with 3 picture prompts), Paper 3 Listening MCQs, Paper 4 Oral. Source for trend analysis.",
      href: `/admin/english-oral-compo?userId=${userId}`,
      color: "bg-sky-50 text-sky-600",
    },
    {
      icon: "draw",
      label: "Compo (Chinese)",
      description: "Upload a scanned student Chinese composition. Gemini OCRs, flags wrong words (错别字 / 用词不当), scores against the PSLE 40-mark rubric (内容 20 / 词汇好句 10 / 句子结构 10), and recommends structural + language upgrades drawn from the 10-year model essay corpus.",
      href: `/admin/compo?userId=${userId}`,
      color: "bg-rose-50 text-rose-600",
    },
    {
      icon: "psychology",
      label: "Lumi Quiz (David)",
      description: "Generate a personalised Lumi-style Science quiz for David Lim using cross-cutting skill tags (evidence-then-conclusion, graph-trend-describe, etc.). Internal test only — not exposed to parents yet.",
      href: `/admin/lumi-quiz?userId=${userId}`,
      color: "bg-purple-50 text-purple-600",
    },
  ];

  return (
    <div className="min-h-screen bg-slate-50">
      <AdminNav userId={userId} />
      <div className="lg:ml-56 pb-24 lg:pb-0">
      {/* Header */}
      <div className="bg-white border-b border-slate-200 px-4 py-3">
        <h1 className="text-lg font-bold text-slate-800">Admin Panel</h1>
        <p className="text-xs text-slate-400">MarkForYou management tools</p>
      </div>

      {/* Tiles */}
      <div className="max-w-xl mx-auto px-4 py-6 space-y-3">
        {tiles.map(tile => (
          <Link
            key={tile.href}
            href={tile.href}
            className="flex items-center gap-4 bg-white rounded-2xl border border-slate-100 shadow-sm px-5 py-4 hover:border-slate-300 transition-colors"
          >
            <div className={`w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 ${tile.color}`}>
              <span className="material-symbols-outlined text-[24px]">{tile.icon}</span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-bold text-slate-800 text-sm">{tile.label}</p>
              <p className="text-xs text-slate-400 mt-0.5">{tile.description}</p>
            </div>
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              className="text-slate-300 flex-shrink-0">
              <path d="m9 18 6-6-6-6" />
            </svg>
          </Link>
        ))}
      </div>
      </div>
    </div>
  );
}
