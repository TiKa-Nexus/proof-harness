import fs from "node:fs";

export function snapshotSourceMutation(subject) {
  return fs.readFileSync(subject.file, "utf8");
}

export function applySourceMutation(id, subject, snapshot) {
  const { search, replacement } = subject;
  const first = snapshot.indexOf(search);
  if (first < 0) {
    throw new Error(
      `source mutation ${id} could not find its exact search text in ${subject.file}`,
    );
  }
  if (snapshot.indexOf(search, first + search.length) >= 0) {
    throw new Error(
      `source mutation ${id} matched more than once in ${subject.file}`,
    );
  }

  fs.writeFileSync(
    subject.file,
    `${snapshot.slice(0, first)}${replacement}${snapshot.slice(first + search.length)}`,
    "utf8",
  );
}

export function restoreSourceMutation(subject, snapshot) {
  fs.writeFileSync(subject.file, snapshot, "utf8");
  if (snapshotSourceMutation(subject) !== snapshot) {
    throw new Error(
      `source file ${subject.file} did not return to its exact original contents`,
    );
  }
}
