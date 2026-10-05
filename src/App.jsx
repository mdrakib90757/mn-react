import { useCallback, useEffect, useState } from "react";
import { Play, Square, Trash2, Radio, AlertCircle, AlertTriangle, X } from "lucide-react";
import { Topics, Transcript, Questions, Notes } from "./components.jsx";
import {
  USE_MOCK,
  startMockFeed,
  subscribeLive,
  checkBackendHealth,
  startRecording,
  stopRecording,
  requestMicPermission,
  updateLiveConfig,
} from "./feed.js";

const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const clock = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

export default function App() {
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [tab, setTab] = useState("transcript");
  const [language, setLanguage] = useState(() => load("language", "bn"));
  const [topics, setTopics] = useState(() => load("topics", ["Deadline", "Budget"]));
  const [data, setData] = useState({ transcript: [], questions: [], notes: [] });
  const [error, setError] = useState(null);
  const [warning, setWarning] = useState(null);

  useEffect(() => {
    try {
      localStorage.setItem("language", JSON.stringify(language));
    } catch {}
  }, [language]);

  useEffect(() => {
    try {
      localStorage.setItem("topics", JSON.stringify(topics));
    } catch {}
  }, [topics]);

  // Dynamically sync language and topics to active WebSocket session
  useEffect(() => {
    if (running) {
      updateLiveConfig({
        language,
        topics,
        questionKinds: ["Clarification", "Deep Dive", "Risk", "Action Item"],
      });
    }
  }, [language, topics, running]);

  const emit = useCallback((e) => {
    if (!e) return;

    if (e.type === "error" || e.type === "BACKEND_ERROR") {
      setError(e.error || e.message || "An unexpected error occurred.");
      return;
    }

    if (e.type === "warning" || e.type === "MIC_WARNING") {
      setWarning(e.warning || e.message);
      return;
    }

    if (e.type === "TAB_ENDED") {
      setWarning(e.warning || "Meeting tab was closed.");
      setRunning(false);
      return;
    }

    const key =
      e.type === "transcript"
        ? "transcript"
        : e.type === "note" || e.note
        ? "notes"
        : e.type === "question" || e.question
        ? "questions"
        : { transcript: "transcript", question: "questions", note: "notes" }[e.type];

    if (!key) return;
    setData((d) => ({
      ...d,
      [key]: [...(Array.isArray(d?.[key]) ? d[key] : []), e],
    }));
  }, []);

  useEffect(() => {
    const unsub = subscribeLive((e) => {
      if (e?.type === "TAB_ENDED") {
        setRunning(false);
      }
      emit(e);
    });
    return () => unsub();
  }, [emit]);

  useEffect(() => {
    if (!running) return;
    const offMock = USE_MOCK ? startMockFeed(emit) : () => {};
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => {
      offMock();
      clearInterval(t);
    };
  }, [running, emit]);

  const handleToggle = async () => {
    if (running) {
      await stopRecording();
      setRunning(false);
    } else {
      setError(null);
      setWarning(null);

      // 1. Fail-fast check for backend WebSocket server
      const isAlive = await checkBackendHealth("ws://localhost:8080", 1500);
      if (!isAlive) {
        setError("Backend server is not running! Run `node server.js` in terminal.");
        return;
      }

      // 2. Start tab + mic recording
      try {
        await startRecording({
          language,
          topics,
          questionKinds: ["Clarification", "Deep Dive", "Risk", "Action Item"],
        });
        setRunning(true);
      } catch (err) {
        setError(err.message || "Could not start recording. Please select a valid web tab.");
        setRunning(false);
      }
    }
  };

  const patchQ = (id, fn) => setData((d) => ({ ...d, questions: d.questions.map((q) => (q.id === id ? fn(q) : q)) }));
  const reset = () => { setData({ transcript: [], questions: [], notes: [] }); setElapsed(0); setError(null); setWarning(null); };

  const tabs = [
    { id: "transcript", label: "Transcript", n: data.transcript.length },
    { id: "questions", label: "Questions", n: data.questions.length },
    { id: "notes", label: "Notes", n: data.notes.length },
  ];

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <div className="brand-icon" aria-hidden="true">
            <Radio size={14} />
          </div>
          <div className="brand-text">
            <h1 className="brand-title">Meeting Notes</h1>
            <span className="brand-badge">AI</span>
          </div>
        </div>

        <div
          className={`status ${running ? "live" : "idle"}`}
          role="status"
          aria-live="polite"
        >
          {running ? (
            <div className="status-live-badge">
              <span className="equalizer" aria-hidden="true">
                <span className="eq-bar eq-1" />
                <span className="eq-bar eq-2" />
                <span className="eq-bar eq-3" />
              </span>
              <span className="status-label">Listening</span>
              <span className="status-dot-sep">·</span>
              <span className="status-clock">{clock(elapsed)}</span>
            </div>
          ) : (
            <div className="status-idle-badge">
              <span className="status-idle-dot" aria-hidden="true" />
              <span className="status-label">Idle</span>
            </div>
          )}
        </div>
      </header>

      {error && (
        <div className="alert-banner error" role="alert">
          <div className="alert-content">
            <AlertCircle size={14} className="alert-icon" />
            <span>{error}</span>
          </div>
          <button onClick={() => setError(null)} aria-label="Dismiss error" className="alert-close">
            <X size={13} />
          </button>
        </div>
      )}

      {warning && (
        <div className="alert-banner warning" role="status">
          <div className="alert-content">
            <AlertTriangle size={14} className="alert-icon" />
            <span>{warning}</span>
          </div>
          <div className="alert-actions">
            {warning.toLowerCase().includes("mic") && (
              <button onClick={requestMicPermission} className="alert-action-btn">
                Enable Mic
              </button>
            )}
            <button onClick={() => setWarning(null)} aria-label="Dismiss warning" className="alert-close">
              <X size={13} />
            </button>
          </div>
        </div>
      )}

      {/* Modern Language Selector Segmented Bar */}
      <div className="lang-selector-bar" role="group" aria-label="Language Mode">
        <button
          type="button"
          className={`lang-btn ${language === "bn" ? "active" : ""}`}
          onClick={() => setLanguage("bn")}
          title="Bengali (বাংলা)"
        >
          🇧🇩 Bengali
        </button>
        <button
          type="button"
          className={`lang-btn ${language === "en" ? "active" : ""}`}
          onClick={() => setLanguage("en")}
          title="English"
        >
          🇺🇸 English
        </button>
        <button
          type="button"
          className={`lang-btn ${language === "multi" ? "active" : ""}`}
          onClick={() => setLanguage("multi")}
          title="Auto / Mixed Language"
        >
          🌐 Mixed
        </button>
      </div>

      <Topics topics={topics} setTopics={setTopics} />

      <nav className="tabs" role="tablist" aria-label="Navigation Tabs">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`tab-btn ${tab === t.id ? "on" : ""}`}
            onClick={() => setTab(t.id)}
          >
            <span className="tab-label">{t.label}</span>
            {t.n > 0 && <span className="count">{t.n}</span>}
          </button>
        ))}
      </nav>

      <main className="main">
        {tab === "transcript" && <Transcript items={data.transcript} topics={topics} running={running} />}
        {tab === "questions" && (
          <Questions
            items={data.questions}
            onDismiss={(id) => setData((d) => ({ ...d, questions: d.questions.filter((q) => q.id !== id) }))}
            onPin={(id) => patchQ(id, (q) => ({ ...q, pinned: !q.pinned }))}
          />
        )}
        {tab === "notes" && <Notes items={data.notes} topics={topics} />}
      </main>

      <footer className="footer">
        <div className="bar">
          <button
            className={`go ${running ? "stop" : ""}`}
            onClick={handleToggle}
            aria-label={running ? "Stop Recording" : "Start Recording"}
          >
            {running ? <Square size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}
            <span>{running ? "Stop Recording" : "Start Recording"}</span>
          </button>
          <button
            className="icon-btn"
            onClick={reset}
            aria-label="Clear all records"
            title="Clear all records"
          >
            <Trash2 size={16} />
          </button>
        </div>
        <p className="consent">Ensure meeting participants are aware of active transcription.</p>
      </footer>
    </div>
  );
}
