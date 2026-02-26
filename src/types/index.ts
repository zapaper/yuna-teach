export type Language = "CHINESE" | "ENGLISH";

export interface SpellingTestSummary {
  id: string;
  title: string;
  subtitle: string | null;
  language: Language;
  wordCount: number;
  createdAt: string;
}

export interface SpellingTestDetail {
  id: string;
  title: string;
  subtitle: string | null;
  language: Language;
  imageUrl: string | null;
  createdAt: string;
  words: WordItem[];
}

export interface WordItem {
  id: string;
  text: string;
  orderIndex: number;
  enabled: boolean;
}

export interface ExtractedTest {
  title: string;
  subtitle: string;
  language: Language;
  words: { text: string; orderIndex: number }[];
}

export interface ExtractResult {
  tests: ExtractedTest[];
}
