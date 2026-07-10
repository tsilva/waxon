import type { CourseMessageMetrics } from "@/app/lib/courseMessageMetrics";
import type { CourseToc as StoredCourseToc } from "@/app/lib/courseContent";
import type {
  CourseListCursor as StoredCourseListCursor,
  CourseListItem as StoredCourseListItem,
} from "@/app/lib/courseStore";
import type {
  CourseQuestionWidgetAnswerDetails,
  CourseToolCall,
} from "@/app/lib/courseQuestionWidget";
import type { UserProfileSummary } from "@/app/lib/userProfile";

export type CourseToc = StoredCourseToc;

export type CourseListItem = StoredCourseListItem;

export type Course = CourseListItem & {
  toc: CourseToc;
  chatMessages?: StoredCourseChatMessage[];
};

export type StoredCourseChatMessage = {
  id?: string;
  role: "assistant" | "user";
  content: string;
  toolCalls?: CourseToolCall[];
  metrics?: CourseMessageMetrics | null;
  evaluation?: StoredCourseChatEvaluation | null;
  widgetAnswer?: CourseQuestionWidgetAnswerDetails | null;
  createdAt?: number;
};

export type StoredCourseChatEvaluation = {
  questionId: string | null;
  question: string;
  correctAnswer: string | null;
  score: number;
  feedback: string;
};

export type UserProfile = UserProfileSummary;

export type LearnPageClientProps = {
  initialCourseId?: string;
  initialCoursesArePartial?: boolean;
  initialCourses?: CourseListItem[] | null;
  initialCurrentUser?: UserProfile | null;
  initialDueCount?: number | null;
  initialIsStartingNewCourse?: boolean;
  initialSelectedCourse?: Course | null;
};

export type CourseListCursor = StoredCourseListCursor;

export type CoursesPageResponse = {
  courses?: CourseListItem[];
  hasMore?: boolean;
  nextCursor?: CourseListCursor | null;
};
