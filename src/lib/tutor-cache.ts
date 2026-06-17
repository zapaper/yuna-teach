// Bundled snapshot of unified-diagnosis runs for the workshop tutor
// page. Each cache file is JSON imported statically so it ends up in
// the bundle instead of relying on disk paths that Railway's
// standalone server doesn't copy.

import benjaminScience from "./tutor-cache/unified-diagnosis-benjamin-ong-science.gemini-cache.json";
import davidScience from "./tutor-cache/unified-diagnosis-david-lim-science.gemini-cache.json";
import ijScience from "./tutor-cache/unified-diagnosis-ij-science.gemini-cache.json";
import jeremiahScience from "./tutor-cache/unified-diagnosis-jeremiahsy-science.gemini-cache.json";
import kaiyangScience from "./tutor-cache/unified-diagnosis-kaiyangnggg-science.gemini-cache.json";
import markScience from "./tutor-cache/unified-diagnosis-mark-lim-science.gemini-cache.json";
import ruthieScience from "./tutor-cache/unified-diagnosis-ruthie-science.gemini-cache.json";
import markMath from "./tutor-cache/unified-diagnosis-mark-lim-math.gemini-cache.json";
import davidMath from "./tutor-cache/unified-diagnosis-david-lim-math.gemini-cache.json";
import emilyMath from "./tutor-cache/unified-diagnosis-emily-lim-math.gemini-cache.json";
import emilyEnglish from "./tutor-cache/unified-diagnosis-emily-lim-english.gemini-cache.json";
import kaiyangMath from "./tutor-cache/unified-diagnosis-kaiyangnggg-math.gemini-cache.json";
import benjaminMath from "./tutor-cache/unified-diagnosis-benjamin-ong-math.gemini-cache.json";
import hooperMath from "./tutor-cache/unified-diagnosis-hooper-math.gemini-cache.json";
import adrielEnglish from "./tutor-cache/unified-diagnosis-adriel-english.gemini-cache.json";
import allisonteoEnglish from "./tutor-cache/unified-diagnosis-allisonteo-english.gemini-cache.json";
import calebEnglish from "./tutor-cache/unified-diagnosis-caleb-english.gemini-cache.json";
import claraEnglish from "./tutor-cache/unified-diagnosis-clara-english.gemini-cache.json";
import davidEnglish from "./tutor-cache/unified-diagnosis-david-lim-english.gemini-cache.json";
import egEnglish from "./tutor-cache/unified-diagnosis-eg-english.gemini-cache.json";
import el44English from "./tutor-cache/unified-diagnosis-el44-english.gemini-cache.json";
import ijEnglish from "./tutor-cache/unified-diagnosis-ij-english.gemini-cache.json";
import jeron16English from "./tutor-cache/unified-diagnosis-jeron16-english.gemini-cache.json";
import kaiyangEnglish from "./tutor-cache/unified-diagnosis-kaiyangnggg-english.gemini-cache.json";
import mahdi12English from "./tutor-cache/unified-diagnosis-mahdi12-english.gemini-cache.json";
import markEnglish from "./tutor-cache/unified-diagnosis-mark-lim-english.gemini-cache.json";
// P5 Math caches
import amberMath from "./tutor-cache/unified-diagnosis-amberamberteo-math.gemini-cache.json";
import jayronMath from "./tutor-cache/unified-diagnosis-jayron-loh-yi-heng-students-edu-sg-math.gemini-cache.json";
import jeremiahMath from "./tutor-cache/unified-diagnosis-jeremiahsy-math.gemini-cache.json";
import jonTanMath from "./tutor-cache/unified-diagnosis-jon-tan-math.gemini-cache.json";
import tylerngMath from "./tutor-cache/unified-diagnosis-tylerng-math.gemini-cache.json";
// P5 English caches
import andreaEnglish from "./tutor-cache/unified-diagnosis-andrea-english.gemini-cache.json";
import angyunshanarielEnglish from "./tutor-cache/unified-diagnosis-angyunshanariel-english.gemini-cache.json";
import audreyEnglish from "./tutor-cache/unified-diagnosis-audrey-english.gemini-cache.json";
import naurahumairaEnglish from "./tutor-cache/unified-diagnosis-naurahumaira-english.gemini-cache.json";
import jeremiahEnglish from "./tutor-cache/unified-diagnosis-jeremiahsy-english.gemini-cache.json";
import jonTanEnglish from "./tutor-cache/unified-diagnosis-jon-tan-english.gemini-cache.json";
import joylynnEnglish from "./tutor-cache/unified-diagnosis-joylynn-english.gemini-cache.json";
import kaydenEnglish from "./tutor-cache/unified-diagnosis-kayden-english.gemini-cache.json";
import meryllEnglish from "./tutor-cache/unified-diagnosis-meryll-english.gemini-cache.json";
import natashatsaiEnglish from "./tutor-cache/unified-diagnosis-natashatsai-english.gemini-cache.json";
import rizqiEnglish from "./tutor-cache/unified-diagnosis-rizqi-english.gemini-cache.json";
import tylerngEnglish from "./tutor-cache/unified-diagnosis-tylerng-english.gemini-cache.json";
import umarmEnglish from "./tutor-cache/unified-diagnosis-umarm-english.gemini-cache.json";
import lohxy2014English from "./tutor-cache/unified-diagnosis-lohxy2014-english.gemini-cache.json";
import lohxy2014Math from "./tutor-cache/unified-diagnosis-lohxy2014-math.gemini-cache.json";
import saarah1English from "./tutor-cache/unified-diagnosis-saarah1-english.gemini-cache.json";
import shadowDemonEnglish from "./tutor-cache/unified-diagnosis-shadow-demon-english.gemini-cache.json";
import shayaneEnglish from "./tutor-cache/unified-diagnosis-shayane-english.gemini-cache.json";
import student66666English from "./tutor-cache/unified-diagnosis-student66666-english.gemini-cache.json";

export type CachedReport = {
  patterns: Array<{ name: string; what: string; specific_examples: Array<{ questionRef: string; type?: "oeq" | "mcq"; whatWentWrong: string }>; strategic_advice: string; trigger_keywords: string[] }>;
  classification: Array<{ idx: number; patternIndex: number }>;
  // Optional — only present on caches written after the
  // assessment-history feature shipped. The runtime tutor.ts uses
  // these to compute the LumiSummary "since last check" delta.
  generatedAt?: string;
  wrongCounts?: { total: number; oeq: number; mcq: number };
  toplineSnapshot?: { avgPct: number; totalAwarded: number; totalAvailable: number; paperCount: number };
  previousAssessment?: {
    generatedAt: string;
    patternNames: string[];
    wrongCounts: { total: number; oeq: number; mcq: number } | null;
    toplineSnapshot: { avgPct: number; totalAwarded: number; totalAvailable: number; paperCount: number } | null;
  } | null;
};

// Key shape: `<safeName>:<subject>` lowercased, dashes for whitespace.
export const TUTOR_CACHE: Record<string, CachedReport> = {
  "benjamin-ong:science": benjaminScience as CachedReport,
  "david-lim:science":    davidScience as CachedReport,
  "ij:science":           ijScience as CachedReport,
  "jeremiahsy:science":   jeremiahScience as CachedReport,
  "kaiyangnggg:science":  kaiyangScience as CachedReport,
  "mark-lim:science":     markScience as CachedReport,
  "ruthie:science":       ruthieScience as CachedReport,
  "mark-lim:math":        markMath as CachedReport,
  "david-lim:math":       davidMath as CachedReport,
  "emily-lim:math":       emilyMath as CachedReport,
  "emily-lim:english":    emilyEnglish as CachedReport,
  "kaiyangnggg:math":     kaiyangMath as CachedReport,
  "benjamin-ong:math":    benjaminMath as CachedReport,
  "hooper:math":          hooperMath as CachedReport,
  "adriel:english":       adrielEnglish as CachedReport,
  "allisonteo:english":   allisonteoEnglish as CachedReport,
  "caleb:english":        calebEnglish as CachedReport,
  "clara:english":        claraEnglish as CachedReport,
  "david-lim:english":    davidEnglish as CachedReport,
  "eg:english":           egEnglish as CachedReport,
  "el44:english":         el44English as CachedReport,
  "ij:english":           ijEnglish as CachedReport,
  "jeron16:english":      jeron16English as CachedReport,
  "kaiyangnggg:english":  kaiyangEnglish as CachedReport,
  "lohxy2014:english":    lohxy2014English as CachedReport,
  "lohxy2014:math":       lohxy2014Math as CachedReport,
  "mahdi12:english":      mahdi12English as CachedReport,
  "mark-lim:english":     markEnglish as CachedReport,
  "saarah1:english":      saarah1English as CachedReport,
  "shadow-demon:english": shadowDemonEnglish as CachedReport,
  "shayane:english":      shayaneEnglish as CachedReport,
  "student66666:english": student66666English as CachedReport,
  // P5 Math
  "amberamberteo:math":                       amberMath as CachedReport,
  "jayron-loh-yi-heng-students-edu-sg:math":  jayronMath as CachedReport,
  "jeremiahsy:math":                          jeremiahMath as CachedReport,
  "jon-tan:math":                             jonTanMath as CachedReport,
  "tylerng:math":                             tylerngMath as CachedReport,
  // P5 English
  "andrea:english":          andreaEnglish as CachedReport,
  "angyunshanariel:english": angyunshanarielEnglish as CachedReport,
  "audrey:english":          audreyEnglish as CachedReport,
  "jeremiahsy:english":      jeremiahEnglish as CachedReport,
  "naurahumaira:english":    naurahumairaEnglish as CachedReport,
  "jon-tan:english":         jonTanEnglish as CachedReport,
  "joylynn:english":         joylynnEnglish as CachedReport,
  "kayden:english":          kaydenEnglish as CachedReport,
  "meryll:english":          meryllEnglish as CachedReport,
  "natashatsai:english":     natashatsaiEnglish as CachedReport,
  "rizqi:english":           rizqiEnglish as CachedReport,
  "tylerng:english":         tylerngEnglish as CachedReport,
  "umarm:english":           umarmEnglish as CachedReport,
};
