import { useEffect, useState } from "react";
import type { RunSkillResult, SkillView } from "../../../shared/plugin.js";
import { AiVisibilityView } from "./AiVisibilityView.js";

// "Skills" — the little helpers you can run. Each shows a plain-English card of
// exactly what it's allowed to do (the same permissions the app enforces), so you
// know before you press Run. Results are shown as plain text, never run as code.
// A skill that needs input (AI Visibility) opens its own dedicated view instead.
export function SkillsPage() {
  const [skills, setSkills] = useState<SkillView[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, RunSkillResult>>({});
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    void window.deskhand.plugins.list().then(setSkills);
  }, []);

  if (open === "ai-visibility") return <AiVisibilityView onBack={() => setOpen(null)} />;

  async function run(id: string) {
    setBusy(id);
    const res = await window.deskhand.plugins.run(id);
    setBusy(null);
    setResults((prev) => ({ ...prev, [id]: res }));
  }

  return (
    <section className="page">
      <header className="page-head">
        <h1>Skills</h1>
        <p>Little helpers you can run. Each one asks permission first — you&apos;ll always see what it can do.</p>
      </header>

      {skills === null ? (
        <p className="hint">Loading your skills…</p>
      ) : skills.length === 0 ? (
        <p className="hint">No skills yet — they&apos;re on the way.</p>
      ) : (
        <ul className="news-list">
          {skills.map((skill) => {
            const result = results[skill.id];
            return (
              <li key={skill.id} className="card">
                <h3>{skill.name}</h3>
                <p>{skill.description}</p>
                <ul className="hint">
                  {skill.permissions.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
                <div className="row">
                  {skill.id === "ai-visibility" ? (
                    <button className="primary" onClick={() => setOpen(skill.id)}>
                      Open
                    </button>
                  ) : (
                    <button className="primary" onClick={() => void run(skill.id)} disabled={busy !== null}>
                      {busy === skill.id ? "Running…" : "Run"}
                    </button>
                  )}
                </div>
                {skill.id !== "ai-visibility" && result && (
                  <div className="brain-reply">
                    <p className="who">{result.ok ? "It found" : "Hmm"}</p>
                    <p>{result.ok ? result.result : result.message}</p>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
