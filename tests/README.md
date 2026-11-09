# Writing tests that pass on Windows, macOS and Linux

`npm publish` runs the whole suite (`prepublishOnly`), so a test that only passes on one OS blocks a release.

- **Never hard-code absolute file paths** (`"/docs/a.md"`, `"C:\\x"`). On Windows `path.resolve("/docs/a.md")` is `C:\docs\a.md`.
  Build them from the temp folder: `path.join(tmp, "docs", "a.md")` (see `P()` in `tests/integration/v4.test.ts`).
- A fake disk keyed by path must **normalise keys** with `path.resolve` (see `PathMap`), so `a/../b` and `b` are the same file.
- URL paths (`"/blobs/x"`, `"/latest.json"`) are not file paths: those are fine.
- Compare paths with `path.relative` / `path.join`, never with `startsWith("/")` or a literal `/` separator.
- Don't rely on file modes, symlinks, case-sensitivity or line endings (`\r\n`) in assertions.
