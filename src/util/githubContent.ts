// Shared GitHub repos.getContent plumbing — timeout wrapping and
// base64-content decoding used by both src/detectors/config.ts
// (.reviewgate.yml) and src/consistency/baseline.ts (sibling/diff file
// content). Extracted during a code-review pass: both modules had
// independently written the same getContent-shape-validate-decode logic,
// and config.ts's own getContent call had no timeout at all — a
// RESILIENCY-10 gap ("All external calls ... MUST have explicit timeouts
// configured") baseline.ts had already fixed for its own calls but not
// this one, even though checker.ts now calls loadConfig on the same
// consistency-check hot path.
//
// Deliberately NOT sharing error-handling policy: config.ts propagates
// non-404 errors (an operational failure like a rate limit is distinct
// from "no usable config" — BR-4), while baseline.ts's callers are always
// fail-open (BR-6/BR-7 — never surface an error to the reviewer). Each
// caller keeps its own try/catch around withTimeout/decodeFileContent;
// only the mechanical parts are shared here.

export interface OctokitLike {
  repos: {
    getContent(params: {
      owner: string;
      repo: string;
      path: string;
      ref?: string;
    }): Promise<{ data: unknown }>;
  };
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`external call exceeded ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

// Validates the getContent response shape (a single file, not a directory
// listing) and decodes its base64 content. Returns undefined — not a
// thrown error — for a wrong-shape response or a non-base64 encoding
// (e.g. GitHub's encoding: "none" for files it won't inline, like ones
// over 1MB): both are "not usable content," not an operational failure.
export function decodeFileContent(data: unknown): string | undefined {
  if (
    typeof data !== "object" ||
    data === null ||
    Array.isArray(data) ||
    typeof (data as { content?: unknown }).content !== "string"
  ) {
    return undefined;
  }
  const fileData = data as { content: string; encoding?: string };
  if (fileData.encoding !== undefined && fileData.encoding !== "base64") {
    return undefined;
  }
  return Buffer.from(fileData.content, "base64").toString("utf-8");
}
