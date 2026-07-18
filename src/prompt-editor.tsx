/**
 * Shared prompt / long-text editor: write (syntax-highlighted), markdown preview,
 * and optional full-width modal for every node that edits prompts.
 */

import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { Eye, Maximize2, Pencil, X } from "lucide-react";
import {
  highlightMarkdownSource,
  renderMarkdownToHtml,
} from "./markdown-render";

export type PromptEditorMode = "write" | "preview";

export type PromptEditorProps = {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  helper?: ReactNode;
  /** Compact inspector height vs modal. */
  variant?: "inline" | "modal";
  className?: string;
  rows?: number;
  maxLength?: number;
  /** Hide expand when already inside the modal. */
  showExpand?: boolean;
  id?: string;
};

export function PromptEditor({
  label,
  value,
  onChange,
  placeholder,
  helper,
  variant = "inline",
  className = "",
  rows = 12,
  maxLength,
  showExpand = true,
  id,
}: PromptEditorProps) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  const [mode, setMode] = useState<PromptEditorMode>("write");
  const [expanded, setExpanded] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLPreElement>(null);

  const syncScroll = () => {
    const ta = taRef.current;
    const bg = backdropRef.current;
    if (ta && bg) {
      bg.scrollTop = ta.scrollTop;
      bg.scrollLeft = ta.scrollLeft;
    }
  };

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  return (
    <>
      {/* Keep a stable shell while expanded so layout doesn't jump; hide the
          editable surface so refs aren't shared with the modal. */}
      <div className={expanded ? "prompt-editor-shell is-expanded" : undefined}>
        {!expanded ? (
          <PromptEditorSurface
            fieldId={fieldId}
            label={label}
            value={value}
            onChange={onChange}
            placeholder={placeholder}
            helper={helper}
            variant={variant}
            className={className}
            rows={rows}
            maxLength={maxLength}
            mode={mode}
            setMode={setMode}
            showExpand={showExpand && variant === "inline"}
            onExpand={() => setExpanded(true)}
            taRef={taRef}
            backdropRef={backdropRef}
            onScroll={syncScroll}
          />
        ) : (
          <div className="prompt-editor prompt-editor-placeholder">
            <div className="prompt-editor-toolbar">
              <span className="prompt-editor-label">{label}</span>
              <span className="prompt-editor-open-badge">Open in wide editor…</span>
            </div>
          </div>
        )}
      </div>
      {expanded && (
        <div
          className="modal-backdrop prompt-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby={`${fieldId}-modal-title`}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setExpanded(false);
          }}
        >
          <div className="prompt-modal">
            <header className="prompt-modal-header">
              <div>
                <span>PROMPT EDITOR</span>
                <h2 id={`${fieldId}-modal-title`}>{label}</h2>
              </div>
              <button
                type="button"
                className="modal-close"
                onClick={() => setExpanded(false)}
                aria-label="Close prompt editor"
              >
                <X size={16} />
              </button>
            </header>
            <div className="prompt-modal-body">
              <PromptEditorSurface
                fieldId={`${fieldId}-modal`}
                label={label}
                value={value}
                onChange={onChange}
                placeholder={placeholder}
                helper={helper}
                variant="modal"
                rows={24}
                maxLength={maxLength}
                mode={mode}
                setMode={setMode}
                showExpand={false}
                taRef={taRef}
                backdropRef={backdropRef}
                onScroll={syncScroll}
              />
            </div>
            <footer className="prompt-modal-footer">
              <small>
                {value.length.toLocaleString()} characters
                {maxLength ? ` · max ${maxLength.toLocaleString()}` : ""}
                {" · "}
                Esc to close
              </small>
              <div className="prompt-modal-footer-actions">
                <button
                  type="button"
                  className="prompt-modal-close-btn"
                  onClick={() => setExpanded(false)}
                >
                  Close
                </button>
                <button
                  type="button"
                  className="primary"
                  onClick={() => setExpanded(false)}
                >
                  Done
                </button>
              </div>
            </footer>
          </div>
        </div>
      )}
    </>
  );
}

type SurfaceProps = {
  fieldId: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  helper?: ReactNode;
  variant: "inline" | "modal";
  className?: string;
  rows: number;
  maxLength?: number;
  mode: PromptEditorMode;
  setMode: (m: PromptEditorMode) => void;
  showExpand: boolean;
  onExpand?: () => void;
  taRef: RefObject<HTMLTextAreaElement | null>;
  backdropRef: RefObject<HTMLPreElement | null>;
  onScroll: () => void;
};

function PromptEditorSurface({
  fieldId,
  label,
  value,
  onChange,
  placeholder,
  helper,
  variant,
  className = "",
  rows,
  maxLength,
  mode,
  setMode,
  showExpand,
  onExpand,
  taRef,
  backdropRef,
  onScroll,
}: SurfaceProps) {
  const highlighted = highlightMarkdownSource(value);
  const previewHtml = renderMarkdownToHtml(value);

  return (
    <div
      className={`prompt-editor prompt-editor-${variant} ${className}`.trim()}
    >
      <div className="prompt-editor-toolbar">
        <span className="prompt-editor-label" id={`${fieldId}-label`}>
          {label}
        </span>
        <div className="prompt-editor-modes" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "write"}
            className={mode === "write" ? "active" : ""}
            onClick={() => setMode("write")}
          >
            <Pencil size={12} />
            Write
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "preview"}
            className={mode === "preview" ? "active" : ""}
            onClick={() => setMode("preview")}
          >
            <Eye size={12} />
            Preview
          </button>
        </div>
        {showExpand && onExpand && (
          <button
            type="button"
            className="prompt-editor-expand"
            onClick={onExpand}
            title="Open in wide editor"
            aria-label="Expand editor"
          >
            <Maximize2 size={13} />
            Expand
          </button>
        )}
      </div>

      {mode === "write" ? (
        <div className="prompt-editor-write-wrap">
          <pre
            ref={backdropRef}
            className="prompt-editor-highlight"
            aria-hidden
            dangerouslySetInnerHTML={{
              __html: highlighted || "&nbsp;",
            }}
          />
          <textarea
            ref={taRef}
            id={fieldId}
            className="prompt-editor-textarea"
            value={value}
            rows={rows}
            maxLength={maxLength}
            placeholder={placeholder}
            spellCheck={false}
            aria-labelledby={`${fieldId}-label`}
            onChange={(e) => onChange(e.target.value)}
            onScroll={onScroll}
          />
        </div>
      ) : (
        <div
          className="prompt-editor-preview md-preview"
          role="tabpanel"
          // Safe: renderMarkdownToHtml escapes all user content first.
          dangerouslySetInnerHTML={{ __html: previewHtml }}
        />
      )}

      {helper ? <div className="prompt-editor-helper">{helper}</div> : null}
      {maxLength != null && (
        <small className="field-counter prompt-editor-counter">
          {value.length}/{maxLength}
        </small>
      )}
    </div>
  );
}
