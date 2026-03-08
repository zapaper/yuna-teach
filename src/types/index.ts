export type Language = "CHINESE" | "ENGLISH" | "JAPANESE";
export type Role = "STUDENT" | "PARENT";

export interface User {
  id: string;
  name: string;
  email: string | null;
  role: Role;
  level: number | null;
  createdAt: string;
  linkedStudents: { id: string; name: string }[];
  linkedParents: { id: string; name: string }[];
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
  completedAt: string | null;
  markingStatus: string | null;
  extractionStatus: string | null;
  assignmentCount: number;
  score: number | null;
  totalMarks: string | null;
  paperType: string | null;
  examType: string | null;
  syllabusTagged: boolean;
  flaggedCount: number;
  unreleasedAssignmentCount: number;
  pendingReviewCount: number;
}

export interface ExamCloneSummary {
  id: string;
  assignedToId: string;
  assignedToName: string | null;
  completedAt: string | null;
  score: number | null;
  markingStatus: string | null;
  feedbackSummary: string | null;
  timeSpentSeconds: number;
}

export interface ExamMetadata {
  papers: Array<{
    label: string;
    questionPrefix: string;
    questionsStartPage: number; // 1-based PDF page
    questionsStartY: number;
    expectedQuestions: number;
  }>;
  coverPages: number[];
  answerPages: number[]; // 1-based PDF page
  answersDetected: string[];
  questionsPerPage?: Array<{ page: number; questions: string[] }>;
  validationIssues?: string[];
}

export interface ExamPaperDetail {
  id: string;
  title: string;
  school: string | null;
  level: string | null;
  subject: string | null;
  year: string | null;
  semester: string | null;
  totalMarks: string | null;
  metadata: ExamMetadata | null;
  pdfPath: string | null;
  pageCount: number;
  createdAt: string;
  assignedToId: string | null;
  assignedToName: string | null;
  score: number | null;
  completedAt: string | null;
  timeSpentSeconds: number;
  markingStatus: string | null;
  extractionStatus: string | null;
  feedbackSummary: string | null;
  sourceExamId: string | null;
  paperType: string | null;
  examType: string | null;
  clones: ExamCloneSummary[];
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
  yStartPct: number | null;
  yEndPct: number | null;
  marksAwarded: number | null;
  marksAvailable: number | null;
  markingNotes: string | null;
  syllabusTopic: string | null;
  studentAnswer: string | null;
}
