// Kho git của từng dự án: một clone riêng trong WORK/projects/<id>/repo (chỉ fetch, log, archive, worktree), luôn
// core.autocrlf=false (git archive trên Windows mặc định ra CRLF, làm hỏng script .sh và kiểm thử).
import { existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { must, run, type Log } from "./lib";

export class Repo {
  dir: string;
  private ready: Promise<void> | null = null;
  private lastFetch = 0;
  private fetching: Promise<void> | null = null;
  constructor(public url: string, root: string, public ghRepo: string, private reference?: string) {
    this.dir = join(root, "repo");
  }
  git = (args: string[], o: { quiet?: boolean; onLine?: Log } = {}) => must(["git", "-C", this.dir, ...args], o);
  ensure(log?: Log) {
    this.ready ??= (async () => {
      if (existsSync(join(this.dir, ".git"))) { await this.git(["config", "core.autocrlf", "false"]); return; }
      mkdirSync(dirname(this.dir), { recursive: true });
      log?.(`Clone ${this.url} (lần đầu)…`);
      // Mượn đối tượng của clone sẵn có trên PC cho nhanh, rồi tách hẳn (--dissociate) để không phụ thuộc clone đó.
      const ref = this.reference && existsSync(this.reference) ? ["--reference-if-able", this.reference, "--dissociate"] : [];
      await must(["git", "-c", "core.autocrlf=false", "clone", "--no-checkout", ...ref, this.url, this.dir], { onLine: log });
      await this.git(["config", "core.autocrlf", "false"]);
    })().catch((e) => { this.ready = null; throw e; });
    return this.ready;
  }
  fetch(force = false): Promise<void> {
    if (this.fetching) return this.fetching.then(() => (force ? this.fetch(true) : undefined));
    if (!force && Date.now() - this.lastFetch < 30_000) return Promise.resolve();
    this.fetching = this.ensure().then(() => this.git(["fetch", "-q", "--prune", "origin"])).then(() => { this.lastFetch = Date.now(); }).finally(() => { this.fetching = null; });
    return this.fetching;
  }
  async resolveSha(rev: string | null) {
    if (!rev) return null;
    const r = await run(["git", "-C", this.dir, "rev-parse", "--verify", "-q", `${rev}^{commit}`], { quiet: true });
    return r.code === 0 ? r.out.trim() || null : null;
  }
  async subject(rev: string) {
    return (await run(["git", "-C", this.dir, "log", "-1", "--format=%s", rev], { quiet: true })).out.trim() || null;
  }
  // Nhánh hoặc commit -> sha đầy đủ theo origin
  async resolveRef(ref: string) {
    await this.fetch();
    const sha = await this.resolveSha(/^[0-9a-f]{7,40}$/.test(ref) ? ref : `origin/${ref}`);
    return sha ? { sha, subject: (await this.subject(sha)) ?? "" } : null;
  }
  async branches() {
    await this.fetch();
    const out = await this.git(["for-each-ref", "--sort=-committerdate", "--count=40", "--format=%(refname:short)%1f%(committerdate:iso-strict)%1f%(objectname:short)%1f%(subject)", "refs/remotes/origin"], { quiet: true });
    return out.trim().split("\n").filter(Boolean).map((l) => {
      const [ref, date, sha, subject] = l.split("\x1f");
      return { name: ref.replace(/^origin\//, ""), date, sha, subject };
    }).filter((b) => b.name !== "HEAD" && b.name !== "origin");
  }
  async heads() {
    const out = await this.git(["for-each-ref", "--format=%(refname:short)%1f%(objectname)%1f%(subject)", "refs/remotes/origin"], { quiet: true });
    const h: Record<string, { sha: string; subject: string }> = {};
    for (const l of out.trim().split("\n").filter(Boolean)) {
      const [ref, sha, subject] = l.split("\x1f");
      const name = ref.replace(/^origin\//, "");
      if (name !== "HEAD" && name !== "origin") h[name] = { sha, subject };
    }
    return h;
  }
  isAncestor = async (sha: string, rev: string) => (await run(["git", "-C", this.dir, "merge-base", "--is-ancestor", sha, rev], { quiet: true })).code === 0;
  commitUrl = (sha: string) => `https://github.com/${this.ghRepo}/commit/${sha}`;
}
