import LearnPageClient from "../../LearnPageClient";

type LearnCoursePageProps = {
  params: Promise<{
    courseId: string;
  }>;
};

export default async function LearnCoursePage({
  params,
}: LearnCoursePageProps) {
  const { courseId } = await params;

  return <LearnPageClient initialCourseId={courseId} />;
}
