import { listCourses } from "@/app/lib/courseStore";
import { LearnHydrator } from "./LearnHydrator";
import { LearnStaticView } from "./LearnStaticView";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function LearnPage() {
  const courses = await listCourses();

  return (
    <>
      <LearnStaticView initialCourses={courses.slice(0, 6)} />
      <LearnHydrator
        initialCourses={courses.slice(0, 6)}
        initialCoursesArePartial={courses.length > 6}
      />
    </>
  );
}
