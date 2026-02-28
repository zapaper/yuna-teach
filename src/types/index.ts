export type Language = "CHINESE" | "ENGLISH";
export type Role = "STUDENT" | "PARENT";

export interface User {
  id: string;
  name: string;
  role: Role;
  level: number | null;
  createdAt: string;
}

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

export interface ExamPaperSummary {
  id: string;
  title: string;
  school: string | null;
  level: string | null;
  subject: string | null;
  questionCount: number;
  createdAt: string;
  assignedToId: string | null;
  assignedToName: string | null;
}

export interface ExamPaperDetail {
  id: string;
  title: string;
  school: string | null;
  level: string | null;
  subject: string | null;
  year: string | null;
  semester: string | null;
  pageCount: number;
  createdAt: string;
  questions: ExamQuestionItem[];
}

export interface ExamQuestionItem {
  id: string;
  questionNum: string;
  imageData: string;
  answer: string | null;
  answerImageData: string | null;
  pageIndex: number;
  orderIndex: number;
}
