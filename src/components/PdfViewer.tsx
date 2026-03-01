"use client";

export default function PdfViewer({ pdfUrl }: { pdfUrl: string }) {
  return (
    <div className="rounded-xl overflow-hidden border border-slate-200 bg-slate-50">
      <iframe
        src={pdfUrl}
        className="w-full"
        style={{ height: "70vh" }}
        title="Exam paper PDF"
      />
      <div className="flex justify-end px-3 py-2 border-t border-slate-200">
        <a
          href={pdfUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-primary-600 hover:underline"
        >
          Open in new tab
        </a>
      </div>
    </div>
  );
}
