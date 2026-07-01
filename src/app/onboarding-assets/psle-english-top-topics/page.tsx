import { A4Sheet } from "../A4Sheet";

// PSLE English — Grammar rules pie charts (top half) + Reported
// Speech common traps cheat sheet (bottom half). Both PNGs are
// reused from the OneDrive shared-folder assets.

export default function EnglishTopTopics() {
  return (
    <A4Sheet
      title="PSLE Grammar Rules and Report Speech Tricks"
      subtitle="12 years of PSLE English Booklet A. Where do the marks come from?"
    >
      {/* Top half: pie charts. 100% width so text labels render as
          large as possible without needing to regenerate the PNG. */}
      <div style={{ marginTop: 4 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/onboarding-assets/english-grammar-pies.png"
          alt="Top Grammar Rules Tested in PSLE — Grammar MCQ + Grammar Cloze"
          style={{ width: "100%", height: "auto", display: "block" }}
        />
      </div>

      {/* Bottom half: Reported Speech cheat sheet. */}
      <div style={{ marginTop: 12 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/onboarding-assets/english-reported-speech.png"
          alt="Reported Speech Cheat Sheet: 5 common traps"
          style={{ width: "100%", height: "auto", display: "block" }}
        />
      </div>
    </A4Sheet>
  );
}
