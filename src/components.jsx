import { useEffect, useRef, useState } from "react";
import { Copy, Pin, X, Plus, Check, Radio, Sparkles, FileText, Quote } from "lucide-react";

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const fmt = (ts) => new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });

export function Highlight({ text, topics }) {
  if (!topics || !topics.length) return text;
  const valid = topics.filter((t) => t && t.trim());
  if (!valid.length) return text;
  const parts = text.split(new RegExp(`(${valid.map(esc).join("|")})`, "gi"));
  return parts.map((p, i) =>
    valid.some((t) => t.toLowerCase() === p.toLowerCase()) ? (
      <mark key={i} className="highlight-tag">{p}</mark>
    ) : (
      p
    )
  );
}

export function Topics({ topics, setTopics }) {
  const [val, setVal] = useState("");
  const inputRef = useRef(null);

  const add = () => {
    const v = val.trim();
    if (v && !topics.includes(v)) setTopics([...topics, v]);
    setVal("");
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      add();
    }
  };

  return (
    <section className="topics" aria-label="Tracked Topics">
      <div className="chips">
        {topics.map((t) => (
          <span className="chip" key={t}>
            <span className="chip-label">{t}</span>
            <button
              type="button"
              className="chip-remove"
              aria-label={`Remove topic ${t}`}
              title={`Remove ${t}`}
              onClick={() => setTopics(topics.filter((x) => x !== t))}
            >
              <X size={11} strokeWidth={2.5} />
            </button>
          </span>
        ))}
        <div className="chip-input-group">
          <input
            ref={inputRef}
            type="text"
            className="chip-input"
            value={val}
            onChange={(e) => setVal(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={topics.length ? "+ Add topic..." : "Track specific topics..."}
            aria-label="New topic"
          />
          {val.trim() && (
            <button
              type="button"
              className="chip-add-btn"
              aria-label="Add topic"
              title="Add topic"
              onClick={add}
            >
              <Plus size={12} strokeWidth={2.5} />
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function useStickyScroll(dep) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current?.parentElement?.parentElement;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) {
      el.scrollTop = el.scrollHeight;
    }
  }, [dep]);
  return ref;
}

export function Transcript({ items, topics, running }) {
  const end = useStickyScroll(items.length);
  if (!items.length) {
    return (
      <Empty
        icon={Radio}
        title="No Audio Captured Yet"
        body={running ? "Live speech will appear here in real-time." : "Navigate to your meeting/video tab and click “Start Recording” below."}
      />
    );
  }
  return (
    <ol className="transcript">
      {items.map((it) => (
        <li key={it.id} className="transcript-row">
          <div className="transcript-meta">
            <time dateTime={new Date(it.ts).toISOString()}>{fmt(it.ts)}</time>
          </div>
          <div className="transcript-body">
            <p className="transcript-text">
              <Highlight text={it.text} topics={topics} />
            </p>
          </div>
        </li>
      ))}
      <li ref={end} aria-hidden="true" className="scroll-anchor" />
    </ol>
  );
}

const TYPE_CONFIG = {
  "Clarification": { class: "t-clarify", label: "Clarification" },
  "স্পষ্টীকরণ": { class: "t-clarify", label: "Clarification" },
  "Deep Dive": { class: "t-deep", label: "Deep Dive" },
  "গভীরে": { class: "t-deep", label: "Deep Dive" },
  "Risk": { class: "t-risk", label: "Risk Analysis" },
  "ঝুঁকি": { class: "t-risk", label: "Risk Analysis" },
  "Action Item": { class: "t-action", label: "Action Item" },
  "অ্যাকশন": { class: "t-action", label: "Action Item" },
};

export function Questions({ items, onDismiss, onPin }) {
  const [copied, setCopied] = useState(null);
  if (!items.length) {
    return (
      <Empty
        icon={Sparkles}
        title="No Questions Yet"
        body="AI will suggest high-value clarification, risk, and action questions as discussion unfolds."
      />
    );
  }

  const copy = (q) => {
    navigator.clipboard.writeText(q.question);
    setCopied(q.id);
    setTimeout(() => setCopied(null), 1400);
  };

  const sorted = [...items].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.ts - a.ts);

  return (
    <ul className="cards">
      {sorted.map((q) => {
        const kind = q.kind || q.type || "Clarification";
        const typeMeta = TYPE_CONFIG[kind] || { class: "t-clarify", label: kind };
        const isCopied = copied === q.id;

        return (
          <li key={q.id} className={`card question-card ${typeMeta.class} ${q.pinned ? "pinned" : ""}`}>
            <div className="card-head">
              <span className="card-badge">
                <span className="badge-dot" aria-hidden="true" />
                <span className="badge-text">{typeMeta.label}</span>
              </span>
              <div className="card-head-meta">
                {q.pinned && (
                  <span className="pinned-indicator" title="Pinned Question">
                    <Pin size={11} fill="currentColor" />
                    <span>Pinned</span>
                  </span>
                )}
                <time dateTime={new Date(q.ts).toISOString()}>{fmt(q.ts)}</time>
              </div>
            </div>

            {/* Question is the hero element */}
            <h2 className="q-hero">{q.question}</h2>

            {/* Secondary speaker quote context */}
            {q.quote && (
              <blockquote className="quote-box">
                <Quote size={12} className="quote-icon" aria-hidden="true" />
                <div className="quote-content">
                  <span className="quote-label">Context:</span>
                  <span className="quote-text">“{q.quote}”</span>
                </div>
              </blockquote>
            )}

            <div className="actions">
              <button
                type="button"
                className={`btn-action ${isCopied ? "btn-success" : ""}`}
                onClick={() => copy(q)}
                aria-label={isCopied ? "Question copied" : "Copy question"}
              >
                {isCopied ? <Check size={13} strokeWidth={2.5} /> : <Copy size={13} />}
                <span>{isCopied ? "Copied" : "Copy"}</span>
              </button>

              <button
                type="button"
                className={`btn-action ${q.pinned ? "btn-pinned" : ""}`}
                onClick={() => onPin(q.id)}
                aria-pressed={!!q.pinned}
                aria-label={q.pinned ? "Unpin question" : "Pin question"}
              >
                <Pin size={13} fill={q.pinned ? "currentColor" : "none"} />
                <span>{q.pinned ? "Unpin" : "Pin"}</span>
              </button>

              <button
                type="button"
                className="btn-action btn-dismiss"
                onClick={() => onDismiss(q.id)}
                aria-label="Dismiss question"
              >
                <X size={13} />
                <span>Dismiss</span>
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function Notes({ items, topics }) {
  const [copied, setCopied] = useState(null);

  if (!items.length) {
    return (
      <Empty
        icon={FileText}
        title="No Notes Yet"
        body="Key decisions, takeaways, and tracked topics will be summarized here automatically."
      />
    );
  }

  const copy = (n) => {
    navigator.clipboard.writeText(n.note);
    setCopied(n.id);
    setTimeout(() => setCopied(null), 1400);
  };

  return (
    <ul className="cards">
      {[...items].reverse().map((n) => {
        const isCopied = copied === n.id;
        return (
          <li key={n.id} className="card note-card">
            <div className="card-head">
              <span className="card-badge note-badge">
                <span className="badge-dot" aria-hidden="true" />
                <span className="badge-text">Takeaway</span>
              </span>
              <div className="card-head-meta">
                <button
                  type="button"
                  className="note-copy-btn"
                  onClick={() => copy(n)}
                  title="Copy note"
                  aria-label="Copy note"
                >
                  {isCopied ? <Check size={12} strokeWidth={2.5} /> : <Copy size={12} />}
                </button>
                <time dateTime={new Date(n.ts).toISOString()}>{fmt(n.ts)}</time>
              </div>
            </div>
            <p className="note-body">
              <Highlight text={n.note} topics={topics} />
            </p>
          </li>
        );
      })}
    </ul>
  );
}

function Empty({ icon: Icon, title, body }) {
  return (
    <div className="empty" role="region" aria-label={title}>
      <div className="empty-icon-well" aria-hidden="true">
        {Icon ? <Icon size={22} strokeWidth={1.8} /> : <Sparkles size={22} />}
      </div>
      <strong className="empty-title">{title}</strong>
      <span className="empty-desc">{body}</span>
    </div>
  );
}
