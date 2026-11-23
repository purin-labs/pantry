// The folders that Refactor 17 renames whole (Stage B, "The folders").
// scripts/refactor-17/rename-folder.mjs does each rename of this list, and
// scripts/refactor-17/move-module.mjs reads it: a plan names a file of the
// Worker by its path on the day of its move, and this list gives the place of
// that path now.
//
// A rename has:
//   from, to   the old and the new folder, from the root of the checkout
//   decided    the date of the decision
//   edits      the text edits of the files that name a root folder and
//              cannot read a path: a list of root names. An edit is done when
//              the file holds its replace text. Its find text is the replace
//              text of the last move plan that edited the same list, so that
//              the move script sees the plan edit as done.
export const FOLDER_RENAMES = [
  {
    from: "services/platform",
    to: "workers/platform",
    decided: "2026-11-23",
    edits: [
      {
        file: "scripts/lib/source-roots.mjs",
        why: "the lints that walk the product source read the new root folder",
        find: 'export const SOURCE_ROOTS = [\n  "apps",\n  "areas",\n  "foundation",\n  "packages",\n  "services",\n  "surfaces",\n];',
        replace:
          'export const SOURCE_ROOTS = [\n  "apps",\n  "areas",\n  "foundation",\n  "packages",\n  "services",\n  "surfaces",\n  "workers",\n];',
      },
      {
        file: ".jscpd.json",
        why: "the clone scan reads the new root folder",
        find: '"path": [\n    "apps",\n    "areas",\n    "foundation",\n    "packages",\n    "services",\n    "surfaces",\n    "crates"\n  ]',
        replace:
          '"path": [\n    "apps",\n    "areas",\n    "foundation",\n    "packages",\n    "services",\n    "surfaces",\n    "workers",\n    "crates"\n  ]',
      },
    ],
  },
];

/** True when `path` is the folder `folder` or a path in it. */
export function inFolder(path, folder) {
  return path === folder || path.startsWith(`${folder}/`);
}

/** The old place of a path: `path` with the old folder of its rename. */
export function formerPath(path) {
  for (const { from, to } of FOLDER_RENAMES) {
    if (inFolder(path, to)) return from + path.slice(to.length);
  }
  return path;
}

/** `path` with the new folder of each rename of the list, or `path`. */
export function renamedPath(path) {
  for (const { from, to } of FOLDER_RENAMES) {
    if (inFolder(path, from)) return to + path.slice(from.length);
  }
  return path;
}
