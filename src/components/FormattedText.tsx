"use client";

// Renders text with **bold** markers as <strong> tags.
// Pass the same className you'd give a <p> (including whitespace-pre-line).
export default function FormattedText({ text, className }: { text: string; className?: string }) {
  const parts = text.split(/(\*\*[^*\n]+\*\*)/g);
  return (
    <p className={className}>
      {parts.map((part, i) =>
        part.startsWith("**") && part.endsWith("**")
          ? <strong key={i}>{part.slice(2, -2)}</strong>
          : part
      )}
    </p>
  );
}
