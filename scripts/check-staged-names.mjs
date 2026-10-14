// Lefthook restages fixed files with `git add --force -- <name>`, which Git
// expands as a glob: a staged `a[1].ts` would also sweep `a1.ts` into the commit.
const expanded = process.argv.slice(2).filter((file) => /[*?[\\]/.test(file));
if (expanded.length)
  throw new Error(
    `Rename before committing; Lefthook restages with glob pathspecs: ${expanded.join(", ")}`,
  );
