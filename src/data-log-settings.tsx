import { useEffect, useMemo, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { AlertTriangle, Database, Download, Save, Trash2 } from "lucide-react";

export type AppSettings = {
  retentionMode: "bounded" | "forever";
  retentionDays: number;
  maxDetailedRuns: number;
  maxConcurrentCodexProcesses: number;
};

type RetentionPreview = {
  affectedRunIds: string[];
  affectedRuns: number;
  detailedBytes: number;
  settings: AppSettings;
};

type StorageInfo = {
  detailedBytes: number;
  databaseBytes: number;
  databasePath: string;
  dataDirectory: string;
};

const defaults: AppSettings = {
  retentionMode: "bounded",
  retentionDays: 30,
  maxDetailedRuns: 100,
  maxConcurrentCodexProcesses: 8,
};

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
};

export function DataLogSettings() {
  const desktop = isTauri();
  const [settings, setSettings] = useState<AppSettings>(defaults);
  const [saved, setSaved] = useState<AppSettings>(defaults);
  const [preview, setPreview] = useState<RetentionPreview | null>(null);
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const refresh = async () => {
    if (!desktop) return;
    const [next, info] = await Promise.all([
      invoke<AppSettings>("get_app_settings"),
      invoke<StorageInfo>("get_storage_info"),
    ]);
    setSettings(next);
    setSaved(next);
    setStorage(info);
    setPreview(await invoke("preview_retention", { settings: next }));
  };

  useEffect(() => {
    void refresh().catch((error) => setMessage(String(error)));
  }, [desktop]);

  useEffect(() => {
    if (!desktop) return;
    const timer = window.setTimeout(() => {
      void invoke<RetentionPreview>("preview_retention", { settings })
        .then(setPreview)
        .catch((error) => setMessage(String(error)));
    }, 180);
    return () => window.clearTimeout(timer);
  }, [desktop, settings]);

  const dirty = useMemo(
    () => JSON.stringify(settings) !== JSON.stringify(saved),
    [settings, saved],
  );

  const save = async () => {
    if (!desktop) return;
    setBusy(true);
    setMessage("");
    try {
      const nextPreview = await invoke<RetentionPreview>("preview_retention", {
        settings,
      });
      const confirmed =
        nextPreview.affectedRuns === 0 ||
        window.confirm(
          `This retention change will remove detailed logs for ${nextPreview.affectedRuns} unpinned run(s). Compact run summaries remain. Continue?`,
        );
      if (!confirmed) return;
      await invoke("save_app_settings", {
        settings,
        confirmCleanup: nextPreview.affectedRuns > 0,
      });
      setSaved(settings);
      setMessage("Settings saved.");
      await refresh();
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  };

  const cleanupNow = async () => {
    if (!desktop || !preview?.affectedRuns) return;
    if (
      !window.confirm(
        `Remove detailed logs for ${preview.affectedRuns} unpinned run(s)?`,
      )
    )
      return;
    setBusy(true);
    try {
      const count = await invoke<number>("cleanup_detailed_logs");
      setMessage(`Cleaned detailed logs for ${count} run(s).`);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const exportLogs = async () => {
    if (!desktop) return;
    const contents = await invoke<string>("export_detailed_logs");
    const url = URL.createObjectURL(
      new Blob([contents], { type: "application/json" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `codex-corp-logs-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const clearAll = async () => {
    if (!desktop) return;
    if (
      !window.confirm(
        "Delete every workflow, run, detailed log, approval, artifact record, and workspace? This cannot be undone.",
      )
    )
      return;
    if (
      !window.confirm("Final confirmation: clear all Codex Corp company data?")
    )
      return;
    await invoke("clear_all_company_data");
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("codex-corp")) localStorage.removeItem(key);
    }
    setMessage("All company data cleared. The workflow catalog is empty.");
    await refresh();
  };

  return (
    <div className="settings-block data-log-settings">
      <div className="settings-block-heading">
        <div>
          <h3>Data &amp; logs</h3>
          <p>
            Local-only run diagnostics, retention, and Codex process
            concurrency.
          </p>
        </div>
        <Database size={19} />
      </div>
      {!desktop && (
        <p className="settings-warn">
          Desktop app required to manage native data.
        </p>
      )}
      <div className="settings-form-grid">
        <label>
          Automatic cleanup
          <select
            value={settings.retentionMode}
            disabled={!desktop || busy}
            onChange={(event) =>
              setSettings((current) => ({
                ...current,
                retentionMode: event.target
                  .value as AppSettings["retentionMode"],
              }))
            }
          >
            <option value="bounded">Bounded retention</option>
            <option value="forever">Keep forever</option>
          </select>
        </label>
        <label>
          Retention days
          <input
            type="number"
            min={1}
            max={3650}
            disabled={!desktop || busy || settings.retentionMode === "forever"}
            value={settings.retentionDays}
            onChange={(event) =>
              setSettings((current) => ({
                ...current,
                retentionDays: Number(event.target.value),
              }))
            }
          />
        </label>
        <label>
          Detailed run limit
          <input
            type="number"
            min={10}
            max={10000}
            disabled={!desktop || busy || settings.retentionMode === "forever"}
            value={settings.maxDetailedRuns}
            onChange={(event) =>
              setSettings((current) => ({
                ...current,
                maxDetailedRuns: Number(event.target.value),
              }))
            }
          />
        </label>
        <label>
          Concurrent Codex processes
          <input
            type="number"
            min={1}
            max={16}
            disabled={!desktop || busy}
            value={settings.maxConcurrentCodexProcesses}
            onChange={(event) =>
              setSettings((current) => ({
                ...current,
                maxConcurrentCodexProcesses: Number(event.target.value),
              }))
            }
          />
        </label>
      </div>
      {settings.retentionMode === "forever" ? (
        <p className="settings-warn">
          <AlertTriangle size={14} />
          Keep forever disables automatic cleanup and may grow local storage
          without limit.
        </p>
      ) : (
        <p className="settings-helper">
          Detailed logs are kept only while they satisfy both limits: no older
          than {settings.retentionDays} days and among the newest{" "}
          {settings.maxDetailedRuns} unpinned runs.
        </p>
      )}
      <div className="storage-summary">
        <span>
          Detailed logs{" "}
          <b>
            {formatBytes(storage?.detailedBytes ?? preview?.detailedBytes ?? 0)}
          </b>
        </span>
        <span>
          Database <b>{formatBytes(storage?.databaseBytes ?? 0)}</b>
        </span>
        <span>
          Cleanup preview <b>{preview?.affectedRuns ?? 0} runs</b>
        </span>
      </div>
      {storage && (
        <p className="settings-path" title={storage.databasePath}>
          Stored locally in {storage.dataDirectory}
        </p>
      )}
      {message && <p className="settings-message">{message}</p>}
      <div className="settings-actions">
        <button
          type="button"
          className="primary"
          disabled={!desktop || busy || !dirty}
          onClick={() => void save()}
        >
          <Save size={14} />
          Save settings
        </button>
        <button
          type="button"
          disabled={!desktop || busy || !preview?.affectedRuns}
          onClick={() => void cleanupNow()}
        >
          <Trash2 size={14} />
          Clean up now
        </button>
        <button
          type="button"
          disabled={!desktop || busy}
          onClick={() => void exportLogs()}
        >
          <Download size={14} />
          Export logs
        </button>
        <button
          type="button"
          className="danger"
          disabled={!desktop || busy}
          onClick={() => void clearAll()}
        >
          <Trash2 size={14} />
          Clear all company data
        </button>
      </div>
    </div>
  );
}
