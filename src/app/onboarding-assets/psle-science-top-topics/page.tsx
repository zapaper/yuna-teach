import { A4Sheet } from "../A4Sheet";

// PSLE Science — Top Topics chart. Reuses the existing bar-chart
// asset (Top 5 topics by share of total marks). Chart only.

export default function ScienceTopTopics() {
  return (
    <A4Sheet
      title="PSLE Science — Top Topics"
      subtitle="Top 5 topics by share of total PSLE Science marks."
    >
      <div style={{ marginTop: 8 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/onboarding-assets/science-top5.png"
          alt="PSLE Science top 5 topics by share of marks"
          style={{ width: "100%", height: "auto", display: "block" }}
        />
      </div>
    </A4Sheet>
  );
}
