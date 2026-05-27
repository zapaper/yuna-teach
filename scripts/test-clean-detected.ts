// Simulate cleanDetectedAnswer to verify the science filter works on
// the actual Q37 studentAnswer text.
const raw = `(a) Working: (no working shown)
Final answer: Drew two batteries in the provided dotted outlines. Drew a wire connecting the bottom of the switch to the top of the left battery.`;

let s = raw.trim();
s = s.replace(/^\s*working\s*:?\s*/i, "");
s = s
  .replace(/\*\*\s*Part\s*\(?[A-Za-z0-9]+\)?\s*\*\*\s*\n?/gi, "")
  .replace(/\*\*\s*(?:Transcription|Transcript|OCR|Detected)\s*\*\*\s*\n?/gi, "")
  .replace(/```[a-zA-Z0-9_-]*\n?/g, "")
  .replace(/\n{3,}/g, "\n\n")
  .trim();

let lines = s
  .split(/\r?\n|\s*\|\s*/)
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !/^\(?blank\)?$/i.test(line) && !/^no\s+answer$/i.test(line));

console.log("Before science filter:");
lines.forEach((l) => console.log("  -", JSON.stringify(l)));

const emptyWorkingRe = /^(?:\([a-z0-9]+\)\s*)?working\s*:?\s*\(?\s*(?:no\s+working(?:\s+shown)?|blank|empty|no\s+answer|nothing|none)\s*\)?\s*$/i;
lines = lines.filter((l) => !emptyWorkingRe.test(l));

console.log("After science filter:");
lines.forEach((l) => console.log("  -", JSON.stringify(l)));
