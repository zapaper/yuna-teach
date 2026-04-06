"use client";

import { useState } from "react";
import { ExamPaperDetail, ExamQuestionItem } from "@/types";

interface Props {
  paper: ExamPaperDetail;
  pageImages: string[];
  onSave: (questionId: string, data: Record<string, unknown>) => Promise<void>;
  saving: string | null;
}

// Group questions by syllabusTopic into sections
function groupBySection(questions: ExamQuestionItem[]) {
  const sections: Array<{ name: string; questions: ExamQuestionItem[] }> = [];
  const sectionMap = new Map<string, ExamQuestionItem[]>();
  const order: string[] = [];

  for (const q of questions) {
    const topic = q.syllabusTopic || "Other";
    if (!sectionMap.has(topic)) {
      sectionMap.set(topic, []);
      order.push(topic);
    }
    sectionMap.get(topic)!.push(q);
  }

  for (const name of order) {
    sections.push({ name, questions: sectionMap.get(name)! });
  }
  return sections;
}

export default function EnglishEditView({ paper, pageImages, onSave, saving }: Props) {
  const metadata = paper.metadata;
  const ocrTexts = metadata?.sectionOcrTexts ?? {};
  const sections = groupBySection(paper.questions);

  const [expandedSection, setExpandedSection] = useState<string | null>(sections[0]?.name ?? null);
  const [editingOcr, setEditingOcr] = useState<string | null>(null);
  const [ocrDrafts, setOcrDrafts] = useState<Record<string, string>>({});

  return (
    <div className="space-y-6">
      {sections.map(sec => {
        const isExpanded = expandedSection === sec.name;
        const ocrData = ocrTexts[sec.name];
        const sectionPageIndices = ocrData?.pageIndices ?? [];

        return (
          <div key={sec.name} className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
            {/* Section header */}
            <button
              onClick={() => setExpandedSection(isExpanded ? null : sec.name)}
              className="w-full flex items-center justify-between p-4 hover:bg-slate-50 transition-colors"
            >
              <div className="flex items-center gap-3">
                <SectionBadge name={sec.name} />
                <div className="text-left">
                  <h3 className="font-bold text-sm text-slate-800">{sec.name}</h3>
                  <p className="text-xs text-slate-400">{sec.questions.length} questions</p>
                </div>
              </div>
              <span className={`material-symbols-outlined text-slate-400 transition-transform ${isExpanded ? "rotate-180" : ""}`}>
                expand_more
              </span>
            </button>

            {isExpanded && (
              <div className="border-t border-slate-100">
                {/* Page images for this section */}
                {sectionPageIndices.length > 0 && (
                  <div className="p-4 bg-slate-50 border-b border-slate-100">
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-3">
                      Exam Pages (Page {sectionPageIndices.map(i => i + 1).join(", ")})
                    </p>
                    <div className="flex gap-3 overflow-x-auto pb-2">
                      {sectionPageIndices.map(pageIdx => (
                        pageImages[pageIdx] && (
                          <img
                            key={pageIdx}
                            src={pageImages[pageIdx]}
                            alt={`Page ${pageIdx + 1}`}
                            className="h-64 rounded-lg border border-slate-200 shadow-sm shrink-0"
                          />
                        )
                      ))}
                    </div>
                  </div>
                )}

                {/* OCR text */}
                {ocrData && (
                  <div className="p-4 border-b border-slate-100">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">OCR Text</p>
                      <button
                        onClick={() => {
                          if (editingOcr === sec.name) {
                            setEditingOcr(null);
                          } else {
                            setOcrDrafts(prev => ({ ...prev, [sec.name]: ocrData.ocrText }));
                            setEditingOcr(sec.name);
                          }
                        }}
                        className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                      >
                        {editingOcr === sec.name ? "Cancel" : "Edit"}
                      </button>
                    </div>
                    {editingOcr === sec.name ? (
                      <textarea
                        value={ocrDrafts[sec.name] ?? ocrData.ocrText}
                        onChange={e => setOcrDrafts(prev => ({ ...prev, [sec.name]: e.target.value }))}
                        rows={12}
                        className="w-full text-xs font-mono bg-white border border-slate-200 rounded-xl p-3 focus:outline-none focus:border-blue-400 resize-y"
                      />
                    ) : (
                      <pre className="text-xs font-mono text-slate-600 bg-white border border-slate-100 rounded-xl p-3 max-h-48 overflow-y-auto whitespace-pre-wrap">
                        {ocrData.ocrText}
                      </pre>
                    )}
                  </div>
                )}

                {/* Questions */}
                <div className="p-4">
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-3">
                    Questions & Answers
                  </p>
                  <div className="space-y-3">
                    {sec.questions.map(q => (
                      <QuestionRow
                        key={q.id}
                        question={q}
                        onSave={onSave}
                        saving={saving}
                      />
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SectionBadge({ name }: { name: string }) {
  const n = name.toLowerCase();
  let cls = "bg-slate-100 text-slate-600";
  if (n.includes("grammar mcq")) cls = "bg-blue-100 text-blue-700";
  else if (n.includes("vocabulary mcq")) cls = "bg-blue-100 text-blue-700";
  else if (n.includes("vocabulary cloze")) cls = "bg-sky-100 text-sky-700";
  else if (n.includes("visual text")) cls = "bg-cyan-100 text-cyan-700";
  else if (n.includes("grammar cloze")) cls = "bg-orange-100 text-orange-700";
  else if (n.includes("editing")) cls = "bg-yellow-100 text-yellow-700";
  else if (n.includes("comprehension cloze")) cls = "bg-green-100 text-green-700";
  else if (n.includes("synthesis")) cls = "bg-pink-100 text-pink-700";
  else if (n.includes("comprehension") && n.includes("open")) cls = "bg-purple-100 text-purple-700";
  return <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${cls}`}>{name}</span>;
}

function QuestionRow({
  question: q,
  onSave,
  saving,
}: {
  question: ExamQuestionItem;
  onSave: (questionId: string, data: Record<string, unknown>) => Promise<void>;
  saving: string | null;
}) {
  const [editAnswer, setEditAnswer] = useState(false);
  const [answerDraft, setAnswerDraft] = useState(q.answer ?? "");
  const [marksDraft, setMarksDraft] = useState(q.marksAvailable != null ? String(q.marksAvailable) : "");

  return (
    <div className="flex items-start gap-3 p-3 rounded-xl bg-slate-50 border border-slate-100">
      {/* Question number */}
      <span className="w-8 h-8 rounded-lg bg-white border border-slate-200 flex items-center justify-center text-xs font-bold text-slate-700 shrink-0">
        {q.questionNum}
      </span>

      <div className="flex-1 min-w-0">
        {/* Clean extracted question text */}
        {q.transcribedStem && (
          <p className="text-sm text-slate-700 mb-1 whitespace-pre-wrap">{q.transcribedStem}</p>
        )}
        {q.transcribedOptions && q.transcribedOptions.length > 0 && (
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 mb-2 ml-4">
            {q.transcribedOptions.map((opt, i) => (
              <span key={i} className="text-xs text-slate-600">
                <span className="font-bold text-slate-400">({i + 1})</span> {opt}
              </span>
            ))}
          </div>
        )}
        {/* Fallback: image if no text content */}
        {!q.transcribedStem && q.imageData && (
          <img
            src={q.imageData}
            alt={`Q${q.questionNum}`}
            className="max-h-16 rounded border border-slate-200 mb-2"
          />
        )}

        {/* Answer */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-bold text-slate-400 uppercase shrink-0">Ans:</span>
          {editAnswer ? (
            <input
              value={answerDraft}
              onChange={e => setAnswerDraft(e.target.value)}
              onBlur={() => {
                if (answerDraft !== (q.answer ?? "")) {
                  onSave(q.id, { answer: answerDraft || null });
                }
                setEditAnswer(false);
              }}
              onKeyDown={e => {
                if (e.key === "Enter") {
                  (e.target as HTMLInputElement).blur();
                }
              }}
              autoFocus
              className="flex-1 text-sm px-2 py-0.5 rounded border border-blue-300 focus:outline-none focus:border-blue-500 bg-white"
            />
          ) : (
            <span
              onClick={() => { setAnswerDraft(q.answer ?? ""); setEditAnswer(true); }}
              className="text-sm text-slate-700 cursor-pointer hover:text-blue-600 truncate"
            >
              {q.answer || <span className="text-slate-300 italic">no answer</span>}
            </span>
          )}
        </div>
      </div>

      {/* Marks */}
      <div className="shrink-0 flex items-center gap-1">
        <input
          value={marksDraft}
          onChange={e => setMarksDraft(e.target.value.replace(/\D/g, ""))}
          onBlur={() => {
            const val = marksDraft ? Number(marksDraft) : null;
            if (val !== q.marksAvailable) {
              onSave(q.id, { marksAvailable: val });
            }
          }}
          className="w-8 text-xs text-center px-1 py-0.5 rounded border border-slate-200 focus:outline-none focus:border-blue-400"
          placeholder="m"
        />
        <span className="text-[10px] text-slate-400">m</span>
      </div>

      {/* Saving indicator */}
      {saving === q.id && (
        <span className="animate-spin rounded-full h-4 w-4 border-2 border-blue-200 border-t-blue-500 shrink-0" />
      )}
    </div>
  );
}
