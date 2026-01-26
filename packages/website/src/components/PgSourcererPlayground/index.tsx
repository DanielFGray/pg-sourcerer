import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { basicSetup } from "@codemirror/basic-setup";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { javascript } from "@codemirror/lang-javascript";
import { sql } from "@codemirror/lang-sql";
// import { syntaxHighlighting } from "@codemirror/language";
import { dracula } from "@uiw/codemirror-theme-dracula";
import { highlight, Pre, type HighlightedCode } from "codehike/code";

import { tokenTransitions } from "../annotations/token-transitions";
import { defaultConfigSource, defaultSchemaSql } from "./defaults";
import styles from "./styles.module.css";

interface GeneratedFile {
  path: string;
  content: string;
}

type RunStatus =
  | { state: "idle" }
  | { state: "running" }
  | { state: "done"; durationMs: number }
  | { state: "error"; message: string };

const detectLanguage = (path: string) => {
  if (path.endsWith(".ts") || path.endsWith(".tsx")) return "typescript";
  if (path.endsWith(".sql")) return "sql";
  return "text";
};

const basename = (value: string) => {
  const parts = value.split("/");
  return parts[parts.length - 1] ?? value;
};

const editorTheme = [dracula];

function CodeMirrorEditor({
  value,
  onChange,
  extensions,
  className,
}: {
  value: string;
  onChange: (nextValue: string) => void;
  extensions: readonly Extension[];
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!containerRef.current) return;

    const state = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        ...extensions,
        EditorView.updateListener.of(update => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;
    return () => view.destroy();
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (value === view.state.doc.toString()) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
    });
  }, [value]);

  return (
    <div
      ref={containerRef}
      className={[styles.editor, className].filter(Boolean).join(" ")}
    />
  );
}

export default function PgSourcererPlayground() {
  const [schemaSql, setSchemaSql] = useState(defaultSchemaSql);
  const [configSource, setConfigSource] = useState(defaultConfigSource);
  const [runStatus, setRunStatus] = useState<RunStatus>({ state: "idle" });
  const [files, setFiles] = useState<GeneratedFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState<HighlightedCode | null>(null);
  const [modalEditor, setModalEditor] = useState<"schema" | "config" | null>(null);

  const workerRef = useRef<Worker | null>(null);
  const latestRequestId = useRef<string | null>(null);
  const initialRunRef = useRef(false);
  const skipDebounceRef = useRef(true);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;

    worker.onmessage = event => {
      const data = event.data as {
        type: "generated";
        requestId: string;
        ok: boolean;
        durationMs?: number;
        files?: GeneratedFile[];
        error?: string;
      };

      if (data.type !== "generated") return;
      if (latestRequestId.current && data.requestId !== latestRequestId.current) return;
      if (!data.ok || !data.files) {
        setRunStatus({ state: "error", message: data.error ?? "Generation failed" });
        return;
      }

      setFiles(data.files);
      setRunStatus({ state: "done", durationMs: data.durationMs ?? 0 });
    };

    return () => worker.terminate();
  }, []);

  const filePaths = useMemo(() => files.map(file => file.path).sort(), [files]);

  useEffect(() => {
    if (!selectedFile && filePaths.length > 0) {
      setSelectedFile(filePaths[0] ?? null);
    }
  }, [filePaths, selectedFile]);

  useEffect(() => {
    const file = files.find(candidate => candidate.path === selectedFile);
    if (!file) {
      setHighlighted(null);
      return;
    }

    let active = true;
    const lang = detectLanguage(file.path);
    void highlight({ value: file.content, lang, meta: file.path }, "dracula").then(code => {
      if (!active) return;
      setHighlighted(code);
    });

    return () => {
      active = false;
    };
  }, [files, selectedFile]);

  const runGeneration = useCallback(() => {
    const worker = workerRef.current;
    if (!worker) return;
    setRunStatus({ state: "running" });
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    latestRequestId.current = requestId;
    worker.postMessage({
      type: "generate",
      requestId,
      schemaSql,
      configSource,
    });
  }, [schemaSql, configSource]);

  useEffect(() => {
    if (initialRunRef.current) return;
    if (!workerRef.current) return;
    initialRunRef.current = true;
    runGeneration();
  }, [runGeneration]);

  useEffect(() => {
    if (skipDebounceRef.current) {
      skipDebounceRef.current = false;
      return;
    }
    if (!workerRef.current) return;
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      runGeneration();
    }, 450);
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [schemaSql, configSource, runGeneration]);

  const sqlExtensions = useMemo<Extension[]>(
    () => [...editorTheme, sql(), EditorView.lineWrapping],
    [],
  );
  const tsExtensions = useMemo<Extension[]>(
    () => [...editorTheme, javascript({ typescript: true }), EditorView.lineWrapping],
    [],
  );

  const selected = files.find(file => file.path === selectedFile);

  useEffect(() => {
    if (!modalEditor) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setModalEditor(null);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [modalEditor]);

  return (
    <section className={styles.container}>
      <header className={styles.header}>
        <div>
          <h2 className={styles.title}>Live Generation Playground</h2>
          <p className={styles.subtitle}>
            Edit the schema and config, run pg-sourcerer in the browser, and explore the generated output.
          </p>
        </div>
        <div className={styles.actions}>
          <button className={styles.button} onClick={runGeneration}>
            Generate
          </button>
          <div className={styles.status}>
            {runStatus.state === "running" && "Running..."}
            {runStatus.state === "done" && `Generated in ${runStatus.durationMs}ms`}
            {runStatus.state === "idle" && "Idle"}
            {runStatus.state === "error" && runStatus.message}
          </div>
        </div>
      </header>

      <div className={styles.grid}>
        <div className={styles.leftColumn}>
          <div className={styles.panel}>
            <div className={styles.panelHeader}>
              <span>SQL schema</span>
              <button className={styles.panelAction} onClick={() => setModalEditor("schema")}>
                Zoom
              </button>
            </div>
            <CodeMirrorEditor
              value={schemaSql}
              onChange={setSchemaSql}
              extensions={sqlExtensions}
            />
          </div>
          <div className={styles.panel}>
            <div className={styles.panelHeader}>
              <span>Config</span>
              <button className={styles.panelAction} onClick={() => setModalEditor("config")}>
                Zoom
              </button>
            </div>
            <CodeMirrorEditor value={configSource} onChange={setConfigSource} extensions={tsExtensions} />
          </div>
          <div className={styles.panelFooter}>Auto-runs on edit with debounce.</div>
        </div>

        <div className={styles.rightColumn}>
          <div className={styles.panel}>
            <div className={styles.tabs}>
              {filePaths.length === 0 && <div className={styles.emptyState}>No output yet.</div>}
              {filePaths.map(path => (
                <button
                  key={path}
                  className={path === selectedFile ? styles.tabActive : styles.tab}
                  onClick={() => setSelectedFile(path)}
                >
                  {basename(path)}
                </button>
              ))}
            </div>
            <div className={styles.outputPane}>
              {highlighted ? (
                <Pre
                  code={highlighted}
                  handlers={[tokenTransitions]}
                  className={styles.outputPre}
                  style={highlighted.style}
                />
              ) : (
                <div className={styles.emptyState}>Select a file to view output.</div>
              )}
            </div>
          </div>
        </div>
      </div>

      {modalEditor && (
        <div className={styles.modalOverlay} role="dialog" aria-modal="true">
          <div className={styles.modalContent}>
            <div className={styles.modalHeader}>
              <div className={styles.modalTitle}>
                {modalEditor === "schema" ? "SQL schema" : "Config"}
              </div>
              <button className={styles.modalClose} onClick={() => setModalEditor(null)}>
                Close
              </button>
            </div>
            <div className={styles.modalBody}>
              {modalEditor === "schema" ? (
                <CodeMirrorEditor
                  value={schemaSql}
                  onChange={setSchemaSql}
                  extensions={sqlExtensions}
                  className={styles.editorModal}
                />
              ) : (
                <CodeMirrorEditor
                  value={configSource}
                  onChange={setConfigSource}
                  extensions={tsExtensions}
                  className={styles.editorModal}
                />
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
