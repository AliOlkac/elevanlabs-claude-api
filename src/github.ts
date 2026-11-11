/**
 * Delivery to the private output repository through the Git Data API
 * (blobs -> tree -> commit -> ref), so a whole job lands in ONE commit.
 * Needs a fine-grained token limited to that single repository with "Contents: Read and write".
 */
import { MAX_COMMIT_BYTES, type Env } from "./env";
import { AppError, b64encode, redact, sleep } from "./util";

export interface TreeEntry {
  path: string;
  /** Blob SHA, or null to delete the path. */
  sha: string | null;
}

export interface Head {
  branch: string;
  commit: string;
  tree: string;
}

export class GitHub {
  private api: string;
  private repo: string;

  constructor(private env: Env) {
    if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) throw new AppError("not_configured", "GITHUB_TOKEN / GITHUB_REPO are not set on the server");
    if (!/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPO)) throw new AppError("not_configured", "GITHUB_REPO must look like owner/name");
    this.api = (env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
    this.repo = env.GITHUB_REPO;
  }

  private async call(method: string, path: string, body?: unknown, accept = "application/vnd.github+json"): Promise<Response> {
    let last: AppError | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await sleep(Math.min(1000 * 2 ** (attempt - 1), 8000));
      let res: Response;
      try {
        res = await fetch(`${this.api}/repos/${this.repo}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${this.env.GITHUB_TOKEN}`,
            accept,
            "user-agent": "ses-atolyesi",
            "x-github-api-version": "2022-11-28",
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch (e) {
        last = new AppError("github_error", `network error: ${redact(this.env, e instanceof Error ? e.message : String(e))}`);
        continue;
      }
      if (res.ok) return res;
      const text = await res.text().catch(() => "");
      let msg = text.slice(0, 300);
      try {
        msg = (JSON.parse(text) as any).message ?? msg;
      } catch {}
      const err = new AppError("github_error", redact(this.env, `HTTP ${res.status} on ${method} ${path.split("?")[0]}: ${msg}`), res.status);
      const rateLimited = res.status === 429 || (res.status === 403 && /rate limit|abuse/i.test(msg));
      if (res.status >= 500 || rateLimited) {
        last = err;
        const ra = Number(res.headers.get("retry-after"));
        if (ra > 0) await sleep(Math.min(ra * 1000, 15_000));
        continue;
      }
      throw err;
    }
    throw last ?? new AppError("github_error", "request failed");
  }

  /** Current branch head. An empty repository is initialised with a README first. */
  async head(): Promise<Head> {
    let branch = this.env.GITHUB_BRANCH;
    if (!branch) branch = ((await (await this.call("GET", "")).json()) as any).default_branch || "main";
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const ref = (await (await this.call("GET", `/git/ref/heads/${encodeURIComponent(branch!)}`)).json()) as any;
        const commit = (await (await this.call("GET", `/git/commits/${ref.object.sha}`)).json()) as any;
        return { branch: branch!, commit: ref.object.sha, tree: commit.tree.sha };
      } catch (e) {
        const empty = e instanceof AppError && (e.status === 409 || e.status === 404);
        if (!empty || attempt) throw e;
        await this.call("PUT", "/contents/README.md", {
          message: "init",
          content: b64encode(new TextEncoder().encode("# Ses çıktıları\n\nSes Atölyesi tarafından üretilen dosyalar.\n")),
          branch,
        });
      }
    }
    throw new AppError("github_error", "could not resolve branch head");
  }

  async createBlob(bytes: Uint8Array): Promise<string> {
    const r = (await (await this.call("POST", "/git/blobs", { content: b64encode(bytes), encoding: "base64" })).json()) as any;
    return r.sha;
  }

  /** File names currently inside a directory (empty when the directory does not exist). */
  async listDir(dir: string, ref: string): Promise<string[]> {
    try {
      const r = (await (await this.call("GET", `/contents/${encodePath(dir)}?ref=${encodeURIComponent(ref)}`)).json()) as any;
      return Array.isArray(r) ? r.filter((x) => x.type === "file").map((x) => x.path as string) : [];
    } catch (e) {
      if (e instanceof AppError && e.status === 404) return [];
      throw e;
    }
  }

  /** Creates one commit on top of the branch head and moves the branch. Retries when the branch moved meanwhile. */
  async commit(message: string, entries: TreeEntry[], head?: Head): Promise<{ sha: string; head: Head }> {
    let h = head ?? (await this.head());
    for (let attempt = 0; ; attempt++) {
      const tree = (await (
        await this.call("POST", "/git/trees", {
          base_tree: h.tree,
          tree: entries.map((e) => ({ path: e.path, mode: "100644", type: "blob", sha: e.sha })),
        })
      ).json()) as any;
      if (tree.sha === h.tree) return { sha: h.commit, head: h }; // identical content: nothing to commit
      const commit = (await (await this.call("POST", "/git/commits", { message, tree: tree.sha, parents: [h.commit] })).json()) as any;
      try {
        await this.call("PATCH", `/git/refs/heads/${encodeURIComponent(h.branch)}`, { sha: commit.sha, force: false });
        return { sha: commit.sha, head: { branch: h.branch, commit: commit.sha, tree: tree.sha } };
      } catch (e) {
        if (!(e instanceof AppError && e.status === 422) || attempt >= 3) throw e;
        h = await this.head(); // someone else pushed: rebuild on the new head
      }
    }
  }

  /** Convenience for small deliveries (sfx, music, previews): upload + single commit. */
  async commitFiles(message: string, files: { path: string; bytes: Uint8Array }[]): Promise<string> {
    const entries: TreeEntry[] = [];
    for (const f of files) entries.push({ path: f.path, sha: await this.createBlob(f.bytes) });
    return (await this.commit(message, entries)).sha;
  }

  async readFile(path: string): Promise<Uint8Array> {
    const clean = normalizeRepoPath(path);
    try {
      const res = await this.call("GET", `/contents/${encodePath(clean)}`, undefined, "application/vnd.github.raw+json");
      return new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      if (e instanceof AppError && e.status === 404) throw new AppError("not_found", `no such file in the output repository: ${clean}`);
      throw e;
    }
  }
}

function encodePath(p: string): string {
  return p.split("/").map(encodeURIComponent).join("/");
}

export function normalizeRepoPath(path: string): string {
  const clean = path.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!clean || clean.split("/").some((s) => s === "" || s === "." || s === "..")) throw new AppError("invalid_input", "github_path must be a relative path inside the output repository");
  return clean;
}

/** Splits files into groups whose total size stays under the per-commit limit (order preserved). */
export function groupBySize<T extends { bytes: number }>(files: T[], limit = MAX_COMMIT_BYTES): T[][] {
  const groups: T[][] = [];
  let cur: T[] = [];
  let size = 0;
  for (const f of files) {
    if (cur.length && size + f.bytes > limit) {
      groups.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(f);
    size += f.bytes;
  }
  if (cur.length) groups.push(cur);
  return groups;
}
