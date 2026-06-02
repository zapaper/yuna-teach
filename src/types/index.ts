export type Language = "CHINESE" | "ENGLISH" | "JAPANESE" | "MALAY" | "TAMIL" | "KOREAN";
export type Role = "STUDENT" | "PARENT";

export interface User {
  id: string;
  // Immutable login username (set at signup, can't be changed).
  name: string;
  // Mutable display name. NULL means "fall back to `name`" — UI code
  // should use `displayName ?? name` (or the displayNameOf helper).
  displayName: string | null;
  email: string | null;
  role: Role;
  level: number | null;
  settings?: { avatar?: boolean; avatarType?: string; pvp?: boolean; crystalCurrency?: boolean; skipReviewPerfect?: boolean; printableFocusedPractice?: boolean; firstAssignDone?: boolean; studentQuizMode?: string; habitats?: boolean; habitatOverride?: boolean; bonusPoints?: number; bonusCrystals?: number; spentCrystals?: number; purchasedPets?: string[]; purchasedHabitats?: string[]; questionDifficulty?: "easier" | "adaptive" | "standard" | "hard" } | null;
  createdAt: string;
  emailVerified?: boolean;
  // "trialing" — within free trial window (trialEndsAt > now)
  // "trial_expired" — trial ended without conversion (read-only mode)
  // "active" — paid subscriber (Stripe or Apple)
  // "canceled" / "past_due" / "expired" — paid then lapsed
  // null/"free" — legacy signups before trial system
  subscriptionStatus?: string;
  trialEndsAt?: string | null; // ISO; null after conversion to paid
  paymentSource?: string | null; // "stripe" | "apple" | null
  linkedStudents: { id: string; name: string; displayName: string | null; level?: number | null; settings?: { avatar?: boolean; pvp?: boolean; crystalCurrency?: boolean; skipReviewPerfect?: boolean; printableFocusedPractice?: boolean; firstAssignDone?: boolean; studentQuizMode?: string; habitats?: boolean; habitatOverride?: boolean; questionDifficulty?: "easier" | "adaptive" | "standard" | "hard"; includeAiQuestions?: boolean; allowRevision?: boolean } | null }[];
  linkedParents: { id: string; name: string; displayName: string | null }[];
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
  scheduledFor: string | null;
  assignedToId: string | null;
  assignedToName: string | null;
  completedAt: string | null;
  markingStatus: string | null;
  extractionStatus: string | null;
  assignmentCount: number;
  lastAssignedByStudent?: Record<string, string>;
  score: number | null;
  totalMarks: string | null;
  // Sum of marksAvailable for questions the student marked
  // __SKIPPED__. Subtracted from totalMarks when computing the
  // displayed pct so a student isn't penalised for skipped
  // questions — matches the review page's effective denominator.
  skippedMarks?: number;
  paperType: string | null;
  examType: string | null;
  syllabusTagged: boolean;
  cleanExtracted: boolean;
  hasNormalExtractEnglish?: boolean;
  flaggedCount: number;
  unreleasedAssignmentCount: number;
  pendingReviewCount: number;
  instantFeedback: boolean;
  visible: boolean;
  sourceExamId: string | null;
  timeSpentSeconds: number;
  // True for compiled "revise work" papers (review or practice). Lets
  // the dashboard exclude them from the completed-paper count and the
  // average-score numerator.
  isRevision?: boolean;
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
  instantFeedback: boolean;
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
  skipPages?: number[]; // 1-based PDF pages hidden from student view
  passagePages?: number[]; // 1-based PDF pages (Booklet A comprehension passage) duplicated before open-ended section
  sectionOcrTexts?: Record<string, { ocrText: string; pageIndices: number[]; passagePageIndices?: number[]; passageOcrText?: string }>;
  vocabClozePassageImage?: string;
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
  // Synthetic questions store the AI-generated stem diagram here (the
  // scanned `imageData` is empty for them). The editor renderer falls
  // back to this when `imageData` is empty, so the admin can see the
  // diagram instead of a broken-image icon.
  diagramImageData?: string | null;
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
  transcribedStem: string | null;
  transcribedOptions: string[] | null;
  // AI-classified difficulty 1-5 on clean-extracted master questions.
  difficulty?: number | null;
  // Overrides `difficulty` in the admin UI once a question has ≥5 student
  // attempts (derived by the /api/exam/:id endpoint).
  empiricalDifficulty?: number | null;
  empiricalAttempts?: number;
}
