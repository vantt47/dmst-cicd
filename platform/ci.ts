// Kiểm tra (CI) một commit trong container Docker dùng một lần, chung cho mọi dự án. Bước kiểm tra lấy từ cấu hình dự án
// (projects.ts). Mã nạp vào container bằng `git archive` (không mount thư mục của PC), nên mã của nhánh bất kỳ không đọc
// được bí mật, khoá SSH, kubeconfig của PC. Gộp hai cách chạy cũ:
//   - stg-deploy/checks.ts: các nhóm chạy song song, bước `install` lần lượt (chung bộ nhớ đệm bun);
//   - dnso-stg/kiem-tra.ts: nhóm đầu (cài đặt) chạy trước, `retry`, CSDL kiểm thử chạy kèm (sidecar).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { run, type Log } from "./lib";

export type StepStatus = "pending" | "running" | "ok" | "warn" | "failed" | "skipped";
export type StepDef = { name: string; sh: string; dir?: string; allowFail?: boolean; install?: boolean; timeoutMin?: number; retry?: number };
export type GroupDef = { key: string; label: string; dir?: string; env?: Record<string, string>; steps: StepDef[] };
export type CiSpec = {
  name: string;               // tiền tố tên ảnh/container, vd. "stgci"
  dockerDir: string;          // thư mục chứa Dockerfile môi trường kiểm tra
  workdir: string;            // thư mục làm việc mặc định trong container
  cpus: number; memory: string;
  cache: string;              // volume bộ nhớ đệm, "tên:/đường/dẫn"
  groups: GroupDef[];
  firstGroupFirst?: boolean;  // nhóm đầu chạy xong mới chạy các nhóm còn lại (song song)
  sidecar?: { image: string; runArgs: string[]; cmd: string[]; memory: string }; // vd. Postgres dùng chung mạng với container kiểm tra
};

export type CheckRun = {
  id: string; project: string; sha: string; ref: string; subject: string; user: string; userId?: number | null;
  status: "queued" | "running" | "ok" | "failed";
  created: string; started?: string; ended?: string; error?: string;
  groups: { key: string; label: string; status: StepStatus; steps: { name: string; status: StepStatus; ms?: number }[] }[];
  auto?: boolean; superseded?: boolean; // auto: tự chạy khi có push; superseded: nhánh có commit mới trước khi tới lượt
  legacy?: boolean;                     // kết quả đọc từ trang cũ (bản xem trước)
};

export const newCheck = (spec: CiSpec, o: { id: string; project: string; sha: string; ref: string; subject: string; user: string; userId?: number | null }): CheckRun => ({
  ...o, status: "queued", created: new Date().toISOString(),
  groups: spec.groups.map((g) => ({ key: g.key, label: g.label, status: "pending", steps: g.steps.map((s) => ({ name: s.name, status: "pending" })) })),
});

const imageOf = (spec: CiSpec) => `${spec.name}:` + createHash("sha256").update(readFileSync(join(spec.dockerDir, "Dockerfile"))).digest("hex").slice(0, 12);

export async function runCheck(spec: CiSpec, c: CheckRun, d: { repo: string; log: Log; changed: () => void }) {
  const { log } = d;
  const must = async (cmd: string[], what: string, quiet = false) => {
    const r = await run(cmd, quiet ? { quiet: true } : { onLine: log });
    if (r.code !== 0) throw new Error(`${what} lỗi (mã ${r.code})${quiet ? ": " + r.out.trim().split("\n").slice(-3).join(" ") : ""}`);
  };
  const IMAGE = imageOf(spec);
  if ((await run(["docker", "image", "inspect", IMAGE], { quiet: true })).code !== 0) {
    log(`══ Build ảnh môi trường kiểm tra ${IMAGE} (lần đầu hoặc Dockerfile đổi)…`);
    await must(["docker", "build", "--progress=plain", "-t", IMAGE, spec.dockerDir], "Build ảnh kiểm tra");
  }
  const name = `${spec.name}-${c.id}`;
  const side = `${name}-side`;
  log(`══ Tạo container ${name} (${IMAGE}), nạp mã commit ${c.sha.slice(0, 7)}`);
  await must(["docker", "run", "-d", "--rm", "--name", name, "--cpus", String(spec.cpus), "--memory", spec.memory, "-v", spec.cache, IMAGE], "docker run", true);
  try {
    if (spec.sidecar) {
      await must(["docker", "run", "-d", "--rm", "--name", side, "--network", `container:${name}`, "--memory", spec.sidecar.memory,
        ...spec.sidecar.runArgs, spec.sidecar.image, ...spec.sidecar.cmd], "Chạy dịch vụ kèm", true);
    }
    // git archive (trên PC) | tar -x (trong container); rồi git init để các bước đọc trạng thái git chạy được
    const ga = Bun.spawn(["git", "-C", d.repo, "archive", "--format=tar", c.sha], { stdout: "pipe", stderr: "pipe" });
    const tx = Bun.spawn(["docker", "exec", "-i", name, "tar", "-x", "-C", "/w"], { stdin: ga.stdout, stdout: "pipe", stderr: "pipe" });
    const [gaCode, txCode] = await Promise.all([ga.exited, tx.exited]);
    if (gaCode || txCode) throw new Error(`Nạp mã vào container lỗi: ${(await new Response(ga.stderr).text()) + (await new Response(tx.stderr).text())}`.trim());
    await must(["docker", "exec", "-w", "/w", name, "sh", "-c", "git init -q && git add -A && git commit -q -m src"], "git init trong container", true);

    let installLock: Promise<unknown> = Promise.resolve();
    const runGroup = async (g: GroupDef, gs: CheckRun["groups"][number]) => {
      gs.status = "running"; d.changed();
      let failed = false, warned = false;
      for (const [i, s] of g.steps.entries()) {
        const st = gs.steps[i];
        if (failed) { st.status = "skipped"; continue; }
        const go = async () => {
          st.status = "running"; d.changed();
          const t0 = Date.now();
          const lg = (l: string) => log(`[${g.key}] ${l}`);
          let r = { code: 1, out: "" };
          for (let lan = 0; lan <= (s.retry ?? 0); lan++) {
            lg(`▶ ${s.name}${lan ? ` (thử lại lần ${lan})` : ""}`);
            const cmd = ["docker", "exec", "-w", s.dir ?? g.dir ?? spec.workdir];
            for (const [k, v] of Object.entries(g.env ?? {})) cmd.push("-e", `${k}=${v}`);
            cmd.push("-e", "CI=true", name, "timeout", String((s.timeoutMin ?? 20) * 60), "sh", "-c", s.sh);
            r = await run(cmd, { onLine: lg });
            if (r.code === 0) break;
          }
          st.ms = Date.now() - t0;
          if (r.code === 0) { st.status = "ok"; lg(`✔ ${s.name} (${Math.round(st.ms / 1000)} giây)`); }
          else if (s.allowFail) { st.status = "warn"; warned = true; lg(`⚠ ${s.name} lỗi (mã ${r.code}), không chặn`); }
          else { st.status = "failed"; failed = true; lg(`✘ ${s.name} lỗi (mã ${r.code}${r.code === 124 ? ", quá thời gian" : ""})`); }
          d.changed();
        };
        if (s.install) { const p = installLock.then(go); installLock = p.catch(() => {}); await p; }
        else await go();
      }
      gs.status = failed ? "failed" : warned ? "warn" : "ok"; d.changed();
    };
    const G = spec.groups;
    if (spec.firstGroupFirst) {
      await runGroup(G[0], c.groups[0]);
      if (c.groups[0].status === "failed") {
        for (const gs of c.groups.slice(1)) { gs.status = "skipped"; for (const s of gs.steps) s.status = "skipped"; }
      } else await Promise.all(G.slice(1).map((g, i) => runGroup(g, c.groups[i + 1])));
    } else await Promise.all(G.map((g, i) => runGroup(g, c.groups[i])));
    const bad = c.groups.filter((g) => g.status === "failed").map((g) => g.label);
    if (bad.length) throw new Error(`Kiểm tra không qua: ${bad.join(", ")}`);
  } finally {
    if (spec.sidecar) await run(["docker", "rm", "-f", side], { quiet: true });
    await run(["docker", "rm", "-f", name], { quiet: true });
  }
}
