import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Archive fixtures leave the top-level daily files available for other assertions.
export async function seedDistillationSources(root, topic) {
  const sources = ['1996-04-02', '1996-04-12', '1996-04-25'];
  const observations = ['Initial observation', 'Independent recurrence', 'Follow-up verification'];
  const sections = sources.map((day, i) => `### [${day}]\n\n${observations[i]} of ${topic}.\n`);
  const dir = path.join(root, 'daily');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, '1996-04.md'), sections.join('\n'));
  return { sources, sourceReason: `Initial observation, recurrence and verification of ${topic}.` };
}
