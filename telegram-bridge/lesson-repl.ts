import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createLessonSession } from "./lesson-session.js";

const lesson = process.argv[2] ?? "02-tapas-bar.md";
const { promptTutor, dispose } = await createLessonSession();

try {
  console.log(`Starting ${lesson}. Type /quit to stop.\n`);
  console.log(`Tutor> ${await promptTutor(`/skill:lesson Start the lesson from lessons/${lesson}.`)}`);

  const readline = createInterface({ input: stdin, output: stdout });
  try {
    while (true) {
      const student = (await readline.question("Student> ")).trim();
      if (student === "/quit") break;
      if (!student) continue;
      console.log(`Tutor> ${await promptTutor(student)}`);
    }
  } finally {
    readline.close();
  }
} finally {
  dispose();
}
