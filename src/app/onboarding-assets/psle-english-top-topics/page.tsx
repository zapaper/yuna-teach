import { A4Sheet } from "../A4Sheet";

// PSLE English — Top Topics chart. Reuses the existing pie-chart
// asset (Grammar MCQ + Grammar Cloze donut pies from 12 years of
// PSLE English Booklet A). Nothing else on the page — chart only.

export default function EnglishTopTopics() {
  return (
    <A4Sheet
      title="PSLE English — Top Topics"
      subtitle="12 years of PSLE English Booklet A. Where do the marks come from?"
    >
      <div style={{ marginTop: 8 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/onboarding-assets/english-grammar-pies.png"
          alt="Top Grammar Rules Tested in PSLE — Grammar MCQ + Grammar Cloze"
          style={{ width: "100%", height: "auto", display: "block" }}
        />
      </div>
    </A4Sheet>
  );
}
